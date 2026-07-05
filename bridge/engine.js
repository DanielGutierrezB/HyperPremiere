'use strict';

/**
 * Motor "todo en uno" de HyperPremiere.
 *
 * Contiene la orquestación (generar / feedback / derivar objetivo / config /
 * login) SIN servidor HTTP, para poder ejecutarse directamente DENTRO del panel
 * CEP (que tiene Node.js habilitado). Reusa los mismos módulos probados que el
 * puente: providers, prompt, render y store.
 *
 * Cada función devuelve una Promise y no depende de ningún proceso externo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getProvider, stripHtmlFence } = require('./providers');
const { buildUserPrompt } = require('./prompt/build-context');
const { buildObjectivePrompt } = require('./prompt/objective');
const { renderComposition } = require('./render/hyperframes');
const {
  slugify,
  ensureOutputDir,
  paths,
  versionFile,
  nextVersion,
  saveMeta,
  readMeta,
  saveStills,
  saveResources,
} = require('./store/project-fs');

const IS_WIN = process.platform === 'win32';

// CEP corre Node con un PATH mínimo (apps de GUI no heredan el shell).
// En mac/Linux prependemos las rutas típicas de claude/ffmpeg/node/git. En
// Windows el instalador ya deja esos binarios en el PATH del sistema, así que
// no tocamos nada (evita romper el PATH de Windows con separadores unix).
(function ensurePath() {
  if (IS_WIN) return;
  const home = os.homedir();
  const extra = ['/opt/homebrew/bin', path.join(home, '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const current = (process.env.PATH || '').split(':').filter(Boolean);
  const merged = [];
  for (const p of extra.concat(current)) if (p && merged.indexOf(p) === -1) merged.push(p);
  process.env.PATH = merged.join(':');
})();

const SYSTEM_PROMPT_PATH = path.join(__dirname, 'prompt', 'system.md');
const CONFIG_DIR = path.join(os.homedir(), '.hyperpremiere');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_PROVIDER = 'claude-cli';

// Modelo por defecto por proveedor. Vacío = el editor lo define (API compat / Ollama).
function defaultModelFor(provider) {
  return (provider === 'claude-cli' || provider === 'claude-api') ? 'claude-sonnet-5' : '';
}

// Lee la config CRUDA del disco y la normaliza a la forma v2 (por proveedor):
//   { provider, oauthToken, perProvider: { <name>: { model, apiKey, baseUrl } } }
// Migra el formato viejo plano (model/apiKey/baseUrl arriba) sin perder nada.
function loadRawConfig() {
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch (e) {}

  const raw = {
    provider: stored.provider && String(stored.provider).trim() ? stored.provider : DEFAULT_PROVIDER,
    oauthToken: stored.oauthToken || '',
    perProvider: (stored.perProvider && typeof stored.perProvider === 'object') ? stored.perProvider : {},
  };

  // Migración del formato viejo: campos planos → slot del proveedor activo.
  if (!stored.perProvider && (stored.model || stored.apiKey || stored.baseUrl)) {
    raw.perProvider[raw.provider] = {
      model: stored.model || defaultModelFor(raw.provider),
      apiKey: stored.apiKey || '',
      baseUrl: stored.baseUrl || '',
    };
  }
  return raw;
}

function saveRawConfig(raw) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2), 'utf8');
}

// Vista PLANA del proveedor activo (lo que consumen los providers): incluye
// model/apiKey/baseUrl del slot activo + oauthToken (compartido por Claude).
function loadConfig() {
  const raw = loadRawConfig();
  const slot = raw.perProvider[raw.provider] || {};
  const model = (slot.model && String(slot.model).trim()) ? slot.model : defaultModelFor(raw.provider);
  return {
    provider: raw.provider,
    model,
    apiKey: slot.apiKey || '',
    baseUrl: slot.baseUrl || '',
    oauthToken: raw.oauthToken || '',
    perProvider: raw.perProvider,
  };
}

// Guarda SOLO el slot del proveedor indicado (no toca los otros → cambiar de
// modelo/proveedor nunca borra las credenciales del anterior).
function saveConfig(patch) {
  patch = patch || {};
  const raw = loadRawConfig();
  const provider = (patch.provider && String(patch.provider).trim()) ? patch.provider : raw.provider;
  raw.provider = provider;
  const slot = Object.assign({ model: '', apiKey: '', baseUrl: '' }, raw.perProvider[provider] || {});

  if (patch.model !== undefined && patch.model !== null && String(patch.model).trim()) {
    slot.model = String(patch.model);
  }
  if (patch.apiKey !== undefined && patch.apiKey !== null) {
    const v = String(patch.apiKey);
    if (v && !v.startsWith('••••')) slot.apiKey = v; // no pisar con la máscara
  }
  if (patch.baseUrl !== undefined && patch.baseUrl !== null) {
    slot.baseUrl = String(patch.baseUrl);
  }
  raw.perProvider[provider] = slot;
  saveRawConfig(raw);
  return maskConfig(loadConfig());
}

function maskConfig(cfg) {
  return {
    provider: cfg.provider,
    model: cfg.model,
    baseUrl: cfg.baseUrl || '',
    apiKey: cfg.apiKey ? '••••' : '',
    hasSession: Boolean(cfg.oauthToken),
  };
}

function getConfig() {
  return maskConfig(loadConfig());
}

// Lista los modelos instalados en Ollama (GET <baseUrl>/api/tags).
// Devuelve { ok, models: [name, ...] } o { ok:false, error }.
async function listOllamaModels(baseUrl) {
  const base = String(baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  try {
    const res = await fetch(base + '/api/tags');
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status, models: [] };
    const data = await res.json();
    const models = (Array.isArray(data.models) ? data.models : [])
      .map((m) => (m && m.name) ? m.name : null)
      .filter(Boolean)
      // Los modelos de embeddings no generan texto: no sirven acá.
      .filter((name) => !/(embed|bge-|nomic)/i.test(name));
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), models: [] };
  }
}

// Etapa 1 (MODELO): arma el prompt, llama al modelo y escribe el HTML.
// NO renderiza. Devuelve un "prepared" que renderPrepared() consume después.
// Separar modelo/render permite solapar (generar el siguiente mientras renderiza el actual).
async function prepareGeneration(body, mode, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  const { projectPath, sequenceName, objective, transcript, marker, markerTranscript,
    instruction, stills, adjustment, previousHtml } = body || {};

  if (!marker || typeof marker !== 'object') throw new Error('Falta "marker"');
  const durationSec = Number(marker.duration) || 0;
  if (durationSec <= 0) throw new Error('marker.duration debe ser > 0');

  const markerSlug = String(body.markerSlug || '').trim() || slugify(marker.name);
  const stillsList = Array.isArray(stills) ? stills : [];
  const resourcesList = Array.isArray(body.resources) ? body.resources : [];

  // Acumulador de tokens de esta generación (puede haber 2 llamadas al modelo:
  // la principal + el reintento por contrato inválido).
  const usageAcc = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUsd: null, calls: 0,
  };
  function addUsage(u) {
    if (!u) return;
    usageAcc.inputTokens += Number(u.inputTokens) || 0;
    usageAcc.outputTokens += Number(u.outputTokens) || 0;
    usageAcc.cacheReadTokens += Number(u.cacheReadTokens) || 0;
    usageAcc.cacheCreationTokens += Number(u.cacheCreationTokens) || 0;
    if (typeof u.costUsd === 'number') usageAcc.costUsd = (usageAcc.costUsd || 0) + u.costUsd;
    usageAcc.calls += 1;
  }

  report({ pct: 5, msg: 'Armando el contexto…' });
  const systemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
  let userPrompt = buildUserPrompt({
    objective, transcriptSegments: transcript, marker, markerTranscript,
    instruction, stillsCount: stillsList.length,
  });

  // Config activa (necesitamos el modelo antes de armar los nombres de archivo).
  const config = loadConfig();
  // Fondo opcional: con fondo => mp4 opaco HD; sin fondo => mov con alpha.
  const withBackground = body.background === true;
  const videoExt = withBackground ? 'mp4' : 'mov';
  const baseDir = ensureOutputDir(projectPath, sequenceName);
  const version = nextVersion(baseDir, markerSlug);
  const outPaths = paths(baseDir, markerSlug, version, config.model, videoExt);

  // Modo "ajustar": toma como REFERENCIA la última versión ya generada.
  // Si el panel no mandó el HTML previo, lo leemos del disco (versión anterior).
  if (mode === 'adjust') {
    let prevHtml = String(previousHtml || '').trim();
    if (!prevHtml && version > 1) {
      try {
        const prevPath = versionFile(baseDir, markerSlug, version - 1, '.html');
        if (prevPath) prevHtml = fs.readFileSync(prevPath, 'utf8');
      } catch (e) {}
    }
    userPrompt += [
      '', '## Refinamiento sobre la versión previa',
      'Ya generaste una versión de este recurso (abajo). Tomala como REFERENCIA:',
      'mantené lo que funciona y aplicá la nueva instrucción del editor sobre esa base.',
      '', '### Nueva instrucción', (adjustment || instruction || '').trim() || '(sin detalle)',
      '', '### Versión previa (HTML)', '```html', prevHtml || '(no disponible)', '```',
      '', 'Devolvé SOLO el HTML completo de la versión refinada.',
    ].join('\n');
  }
  saveStills(outPaths.stillsDir, stillsList);

  // Recursos de referencia (PDFs, imágenes, docs) subidos por el editor: se
  // guardan al lado de la render y se referencian por ruta en el prompt para
  // que el agente (claude-cli) los lea con sus herramientas antes de componer.
  if (resourcesList.length) {
    const savedResPaths = saveResources(outPaths.resourcesDir, resourcesList);
    if (savedResPaths.length) {
      userPrompt += '\n\n## Recursos de referencia adjuntos (leelos desde disco antes de componer)\n' +
        'El editor subió estos archivos como referencia. Abrilos/leelos antes de diseñar la composición:\n' +
        savedResPaths.map((p) => '- ' + p).join('\n');
    }
  }

  // Fondo: si el marcador se genera CON fondo, instruir un fondo opaco de
  // pantalla completa (minimalista, con textura, temático y con buen contraste).
  if (withBackground) {
    userPrompt += '\n\n## Fondo (esta composición LLEVA FONDO — NO es transparente)\n' +
      '- Cubrí TODO el #stage (1920×1080) con un fondo OPACO de pantalla completa; sin zonas transparentes.\n' +
      '- Estilo MINIMALISTA con algo de TEXTURA sutil (grano fino, gradiente suave, patrón geométrico tenue o ruido leve). Nada recargado.\n' +
      '- La temática del fondo debe relacionarse con el OBJETIVO de la clase y el tema de este tramo del transcript (evocá el concepto, no lo hagas literal).\n' +
      '- CONTRASTE: lo que va al frente (texto/gráficos) debe leerse con claridad sobre el fondo. Asegurá suficiente diferencia de luminosidad; si hace falta, poné un velo/oscurecido detrás del texto.\n' +
      '- Paleta sobria y coherente; el fondo NO debe competir con la información del frente.';
  }

  // Continuidad: SOLO inyectar el HTML de otros marcadores si la instrucción
  // realmente pide continuar/retomar/mantener estilo (ahorra tokens y latencia;
  // antes se mandaba siempre, hasta 12k chars por generación).
  const contHint = ((instruction || '') + ' ' + (adjustment || '')).toLowerCase();
  const wantsContinuity = /(retom|continu|anterior|sigu|mism[oa]|coheren|igual que|como (el|la)|estilo|empalm|coincid|en línea con|misma línea)/.test(contHint);
  if (wantsContinuity) {
    const others = listOtherResources(baseDir, markerSlug);
    if (others.length) {
      userPrompt += '\n\n## Otros recursos ya generados en esta clase (referencia de continuidad y estilo)\n' +
        'Mantené coherencia con estos (tu instrucción pide continuar/retomar):\n' +
        others.map((o) => '### ' + o.slug + '\n```html\n' + o.html + '\n```').join('\n\n');
    }
  }

  const provider = getProvider(config.provider);
  const verbo = mode === 'regen' ? 'desde cero' : mode === 'adjust' ? '(refinando)' : '';
  const localHint = config.provider === 'ollama' ? ' — modelo local, puede tardar varios minutos' : '';
  report({ pct: 15, msg: 'Diseñando la animación con ' + config.model + ' ' + verbo + '…' + localHint });
  function isValidComposition(h) {
    return h && /data-composition-id/.test(h) && /data-duration\s*=\s*["']?\s*[0-9.]*[1-9]/.test(h) && /__timelines/.test(h);
  }

  let gen = await provider.generate({
    systemPrompt, userPrompt, images: stillsList, model: config.model, config,
  });
  addUsage(gen.usage);
  let html = stripHtmlFence(gen.text);

  // Reintento único si no cumple el contrato de HyperFrames (evita render fallido).
  if (!isValidComposition(html)) {
    report({ pct: 45, msg: 'Corrigiendo la estructura de la composición…' });
    const fixPrompt = userPrompt +
      '\n\n## IMPORTANTE: la estructura anterior era inválida\n' +
      'Devolvé el HTML COMPLETO siguiendo EXACTAMENTE la plantilla obligatoria. El <div id="stage"> ' +
      'DEBE tener data-composition-id, data-width="1920", data-height="1080", data-duration (número > 0 = duración del marcador) y data-fps="30". ' +
      'El script DEBE terminar con window.__timelines[COMP_ID] = tl; (COMP_ID igual a data-composition-id). Sin esto el render falla.';
    gen = await provider.generate({
      systemPrompt, userPrompt: fixPrompt, images: stillsList, model: config.model, config,
    });
    addUsage(gen.usage);
    html = stripHtmlFence(gen.text);
  }

  if (!html) throw new Error(`El proveedor "${config.provider}" devolvió respuesta vacía`);
  fs.writeFileSync(outPaths.html, html, 'utf8');
  report({
    pct: 55,
    msg: 'HTML listo · Tokens: ↑' + usageAcc.inputTokens + ' ↓' + usageAcc.outputTokens,
    usage: usageAcc,
  });

  // "prepared": todo lo que renderPrepared necesita para renderizar + guardar meta.
  return {
    ok: true, html, outMovPath: outPaths.mov, htmlPath: outPaths.html, metaPath: outPaths.meta,
    durationSec, videoExt, draft: body.draft === true, version, markerSlug, baseDir,
    usage: usageAcc, background: withBackground, instruction, marker,
    model: config.model, provider: config.provider, mode, adjustment,
  };
}

// Etapa 2 (RENDER): renderiza el HTML preparado y guarda la metadata.
async function renderPrepared(prepared, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  if (!prepared || !prepared.ok) throw new Error('renderPrepared: prepared inválido');
  report({ pct: 60, msg: prepared.background ? 'Renderizando video HD (con fondo)…' : 'Renderizando el video con alpha…' });
  await renderComposition({
    html: prepared.html, outMovPath: prepared.outMovPath, durationSec: prepared.durationSec,
    onProgress: report, format: prepared.videoExt, quality: prepared.draft ? 'draft' : 'high',
  });

  let history = [];
  if (prepared.version > 1) {
    const prevMetaPath = versionFile(prepared.baseDir, prepared.markerSlug, prepared.version - 1, '.meta.json');
    const prevMeta = prevMetaPath ? readMeta(prevMetaPath) : null;
    if (prevMeta) {
      history = Array.isArray(prevMeta.history) ? prevMeta.history.slice() : [];
      history.push({ version: prevMeta.version, instruction: prevMeta.instruction, createdAt: prevMeta.createdAt });
    }
  }
  saveMeta(prepared.metaPath, {
    instruction: prepared.instruction, marker: prepared.marker, version: prepared.version,
    model: prepared.model, provider: prepared.provider, mode: prepared.mode,
    adjustment: prepared.mode === 'adjust' ? prepared.adjustment : undefined,
    background: prepared.background, format: prepared.videoExt,
    createdAt: new Date(Date.now()).toISOString(), history,
  });

  return { ok: true, movPath: prepared.outMovPath, htmlPath: prepared.htmlPath, version: prepared.version, markerSlug: prepared.markerSlug, usage: prepared.usage, background: prepared.background };
}

// Atómico (modelo + render en una): compat / fallback sin pipeline.
async function runGeneration(body, mode, onProgress) {
  const prepared = await prepareGeneration(body, mode, onProgress);
  if (!prepared || !prepared.ok) return prepared;
  return renderPrepared(prepared, onProgress);
}

// Estimación aproximada de tokens de ENTRADA para un marcador, sin llamar al
// modelo. Sirve como semáforo previo a generar. Heurística: ~4 chars/token +
// costo fijo por imagen/recurso (los stills y PDFs pesan más que su texto).
function estimateTokens(body) {
  try {
    body = body || {};
    const marker = body.marker || {};
    const transcript = Array.isArray(body.transcript) ? body.transcript : [];
    const markerTranscript = Array.isArray(body.markerTranscript) ? body.markerTranscript : [];
    const stills = Array.isArray(body.stills) ? body.stills : [];
    const resources = Array.isArray(body.resources) ? body.resources : [];

    let systemPrompt = '';
    try { systemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8'); } catch (e) {}

    let userPrompt = '';
    try {
      userPrompt = buildUserPrompt({
        objective: body.objective || '',
        transcriptSegments: transcript,
        marker,
        markerTranscript,
        instruction: body.instruction || '',
        stillsCount: stills.length,
      });
    } catch (e) {
      userPrompt = String(body.objective || '') + ' ' + String(body.instruction || '');
    }

    const promptChars = systemPrompt.length + userPrompt.length;
    const inputTokensEst = Math.ceil(promptChars / 4) + stills.length * 1200 + resources.length * 1500;
    return {
      ok: true,
      inputTokensEst,
      breakdown: { promptChars, images: stills.length, resources: resources.length },
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), inputTokensEst: 0 };
  }
}

async function deriveObjective(body) {
  const transcriptText =
    typeof body.transcriptText === 'string' && body.transcriptText.trim()
      ? body.transcriptText
      : (Array.isArray(body.transcript) ? body.transcript : [])
          .map((s) => ((s && s.text) || '').trim()).filter(Boolean).join(' ');
  const { system, user } = buildObjectivePrompt(transcriptText);
  const config = loadConfig();
  const provider = getProvider(config.provider);
  const gen = await provider.generate({
    systemPrompt: system, userPrompt: user, images: [], model: config.model, config,
  });
  return { ok: true, objective: String((gen && gen.text) || '').trim(), usage: (gen && gen.usage) || null };
}

// Corre `claude setup-token`, abre el navegador, captura el token y lo guarda.
function loginClaude() {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['setup-token'], { stdio: ['ignore', 'pipe', 'pipe'], shell: IS_WIN });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('login: timeout (5 min)')); }, 300000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('no se pudo ejecutar claude: ' + e.message)); });
    child.on('close', () => {
      clearTimeout(timer);
      const m = (out + '\n' + err).match(/sk-ant-oat[0-9]+-[A-Za-z0-9_-]+/);
      if (!m) return reject(new Error('login: no se encontró el token en la salida'));
      const raw = loadRawConfig();
      raw.oauthToken = m[0];
      raw.provider = 'claude-cli';
      saveRawConfig(raw);
      resolve({ ok: true, provider: 'claude-cli' });
    });
  });
}

const REPO_ROOT = path.join(__dirname, '..');

// Junta el HTML de la última versión de los OTROS marcadores ya generados en
// esta clase, para dar continuidad (retomar/continuar lo hecho en otro marcador).
function listOtherResources(baseDir, currentSlug) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(baseDir); } catch (e) { return out; }
  const latest = {}; // slug -> {version, file}
  // Matchea "<slug> vN.html" y "<slug> vN [modelo].html".
  const re = /^(.*) v(\d+)(?:[\s.\-\[].*)?\.html$/;
  for (const name of entries) {
    const m = name.match(re);
    if (!m) continue;
    const slug = m[1], ver = parseInt(m[2], 10);
    if (slug === currentSlug) continue;
    if (!latest[slug] || ver > latest[slug].version) latest[slug] = { version: ver, file: name };
  }
  let budget = 6000; // tope total de chars para no inflar tokens
  for (const slug in latest) {
    if (budget <= 0) break;
    try {
      let html = fs.readFileSync(path.join(baseDir, latest[slug].file), 'utf8');
      if (html.length > 4000) html = html.slice(0, 4000) + '\n<!-- …(recortado)… -->';
      budget -= html.length;
      out.push({ slug: slug + ' v' + latest[slug].version, html: html });
    } catch (e) {}
  }
  return out;
}

// Lee un PNG (el frame capturado por host.jsx) y lo devuelve como dataURL.
// Borra el archivo temporal después. Lo hace Node (fiable), no la API de CEP.
function readStill(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, error: 'no existe el archivo: ' + filePath };
    }
    const b64 = fs.readFileSync(filePath).toString('base64');
    try { fs.unlinkSync(filePath); } catch (e) {}
    if (!b64) return { ok: false, error: 'el frame quedó vacío' };
    return { ok: true, dataUrl: 'data:image/png;base64,' + b64 };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function getVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'version.json'), 'utf8')).version || '0.0.0';
  } catch (e) { return '0.0.0'; }
}

// Corre un comando git dentro del repo. Devuelve { code, out, err } (nunca lanza).
function gitRun(args) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', REPO_ROOT].concat(args), { stdio: ['ignore', 'pipe', 'pipe'], shell: IS_WIN });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: -1, out, err: 'timeout' }); }, 90000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: (e && e.message) || String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

// Chequea GitHub SIN aplicar: compara la versión local con origin/main.
// Devuelve { ok, current, remote, behind, changed }.
async function checkUpdate() {
  const current = getVersion();
  const f = await gitRun(['fetch', 'origin', 'main']);
  if (f.code !== 0) return { ok: false, error: 'No se pudo consultar GitHub: ' + (f.err.trim() || 'fetch falló').slice(0, 200), current };
  const rv = await gitRun(['show', 'origin/main:version.json']);
  let remote = current;
  try { remote = JSON.parse(rv.out).version || remote; } catch (e) {}
  const cnt = await gitRun(['rev-list', '--count', 'HEAD..origin/main']);
  const behind = parseInt((cnt.out || '0').trim(), 10) || 0;
  return { ok: true, current, remote, behind, changed: behind > 0 };
}

// Actualiza el plugin comparando con GitHub y aplicando la versión remota.
// Usa reset --hard a origin/main → SIEMPRE queda igual a GitHub (soporta que el
// repo remoto haya sido reescrito por otro agente). Devuelve { ok, changed, version, previous, remoteVersion }.
async function selfUpdate() {
  const before = getVersion();
  const chk = await checkUpdate();
  if (!chk.ok) return { ok: false, error: chk.error };
  if (!chk.changed) return { ok: true, changed: false, version: before, remoteVersion: chk.remote };
  const r = await gitRun(['reset', '--hard', 'origin/main']);
  if (r.code !== 0) return { ok: false, error: 'No se pudo aplicar la actualización: ' + (r.err.trim() || 'reset falló').slice(0, 200) };
  return { ok: true, changed: true, version: getVersion(), previous: before, remoteVersion: chk.remote };
}

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Lista las versiones ya generadas de un marcador (escaneo del baseDir).
// Devuelve { ok, versions: [{ version, model }] } ordenado por versión.
function listMarkerVersions(body) {
  try {
    body = body || {};
    const markerSlug = String(body.markerSlug || '').trim();
    if (!markerSlug) return { ok: false, error: 'falta markerSlug', versions: [] };
    const baseDir = ensureOutputDir(body.projectPath, body.sequenceName);
    let entries = [];
    try { entries = fs.readdirSync(baseDir); } catch (e) {}
    const re = new RegExp('^' + escapeReg(markerSlug) + ' v(\\d+)(?: \\[(.+?)\\])?\\.html$');
    const out = [];
    for (const name of entries) {
      const m = name.match(re);
      if (m) out.push({ version: parseInt(m[1], 10), model: m[2] || '' });
    }
    out.sort((a, b) => a.version - b.version);
    return { ok: true, versions: out };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), versions: [] };
  }
}

// Lee el HTML de una versión concreta de un marcador.
function readMarkerHtml(body) {
  try {
    body = body || {};
    const markerSlug = String(body.markerSlug || '').trim();
    const version = parseInt(body.version, 10);
    if (!markerSlug || !version) return { ok: false, error: 'faltan markerSlug/version' };
    const baseDir = ensureOutputDir(body.projectPath, body.sequenceName);
    const p = versionFile(baseDir, markerSlug, version, '.html');
    if (!p) return { ok: false, error: 'no se encontró la versión ' + version };
    return { ok: true, html: fs.readFileSync(p, 'utf8'), version };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// Renderiza un HTML editado a mano por el editor como una NUEVA versión, SIN
// llamar al modelo. Se marca como [manual] en el nombre. Devuelve el .mov.
async function renderManualHtml(body, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  body = body || {};
  const { projectPath, sequenceName, marker } = body;
  if (!marker || typeof marker !== 'object') throw new Error('Falta "marker"');
  const durationSec = Number(marker.duration) || 0;
  if (durationSec <= 0) throw new Error('marker.duration debe ser > 0');
  const cleanHtml = String(body.html || '').trim();
  if (!cleanHtml) throw new Error('El HTML está vacío');
  const markerSlug = String(body.markerSlug || '').trim() || slugify(marker.name);

  const baseDir = ensureOutputDir(projectPath, sequenceName);
  const version = nextVersion(baseDir, markerSlug);
  const outPaths = paths(baseDir, markerSlug, version, 'manual');

  report({ pct: 20, msg: 'Guardando HTML editado…' });
  fs.writeFileSync(outPaths.html, cleanHtml, 'utf8');

  report({ pct: 40, msg: 'Renderizando el video con alpha…' });
  await renderComposition({ html: cleanHtml, outMovPath: outPaths.mov, durationSec, onProgress: report, quality: body.draft ? 'draft' : 'high' });

  let history = [];
  if (version > 1) {
    const prevMetaPath = versionFile(baseDir, markerSlug, version - 1, '.meta.json');
    const prevMeta = prevMetaPath ? readMeta(prevMetaPath) : null;
    if (prevMeta) {
      history = Array.isArray(prevMeta.history) ? prevMeta.history.slice() : [];
      history.push({ version: prevMeta.version, instruction: prevMeta.instruction, createdAt: prevMeta.createdAt });
    }
  }
  saveMeta(outPaths.meta, {
    instruction: '(edición manual)', marker, version, model: 'manual', provider: 'manual',
    mode: 'manual-edit', createdAt: new Date(Date.now()).toISOString(), history,
  });

  return { ok: true, movPath: outPaths.mov, htmlPath: outPaths.html, version, markerSlug };
}

// Re-renderiza la ÚLTIMA versión de un marcador en ALTA calidad, sin llamar al
// modelo (reusa el HTML ya generado). Crea una versión nueva tagueada [hq].
// Sirve para "Render HQ": previsualizás en borrador y luego pasás todo a HD.
async function renderVersionHQ(body, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  body = body || {};
  const markerSlug = String(body.markerSlug || '').trim();
  if (!markerSlug) throw new Error('renderVersionHQ: falta markerSlug');
  const marker = body.marker || {};
  const durationSec = Number(marker.duration) || 0;
  if (durationSec <= 0) throw new Error('renderVersionHQ: marker.duration debe ser > 0');

  const baseDir = ensureOutputDir(body.projectPath, body.sequenceName);
  const list = listMarkerVersions({ projectPath: body.projectPath, sequenceName: body.sequenceName, markerSlug });
  if (!list.ok || !list.versions.length) throw new Error('No hay versiones para ' + markerSlug);
  const latest = list.versions[list.versions.length - 1].version;
  const srcHtmlPath = versionFile(baseDir, markerSlug, latest, '.html');
  const html = srcHtmlPath ? fs.readFileSync(srcHtmlPath, 'utf8') : '';
  if (!html) throw new Error('No se encontró el HTML de la última versión (v' + latest + ')');

  const withBackground = body.background === true;
  const videoExt = withBackground ? 'mp4' : 'mov';
  const version = nextVersion(baseDir, markerSlug);
  const outPaths = paths(baseDir, markerSlug, version, 'hq', videoExt);

  report({ pct: 30, msg: 'Render HQ (alta calidad) de v' + latest + '…' });
  fs.writeFileSync(outPaths.html, html, 'utf8');
  await renderComposition({ html, outMovPath: outPaths.mov, durationSec, onProgress: report, format: videoExt, quality: 'high' });
  saveMeta(outPaths.meta, {
    instruction: '(render HQ de v' + latest + ')', marker, version, model: 'hq', provider: 'hq',
    mode: 'hq', background: withBackground, format: videoExt,
    createdAt: new Date(Date.now()).toISOString(), history: [],
  });
  return { ok: true, movPath: outPaths.mov, htmlPath: outPaths.html, version, markerSlug, background: withBackground };
}

// ── Persistencia de la cola por proyecto ────────────────────────────────
// Guardamos la cola (liviana) en "<dir .prproj>/HyperPremiere/queue.json" para
// que al reabrir el proyecto se recargue lo que había. Si el proyecto no está
// guardado, usa ~/HyperPremiere (igual que las renders).
function projectQueueRoot(projectPath) {
  return projectPath
    ? path.join(path.dirname(projectPath), 'HyperPremiere')
    : path.join(os.homedir(), 'HyperPremiere');
}
function saveQueue(body) {
  try {
    const root = projectQueueRoot(body && body.projectPath);
    const file = path.join(root, 'queue.json');
    const jobs = (body && Array.isArray(body.jobs)) ? body.jobs : [];
    // Cola vacía: NO crear la carpeta solo por abrir el panel. Si ya existía un
    // queue.json (p.ej. limpiaste la cola), lo actualizamos a vacío; si no, nada.
    if (!jobs.length) {
      if (fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: [] }, null, 2), 'utf8');
      return { ok: true, path: file, count: 0, created: false };
    }
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, jobs }, null, 2), 'utf8');
    return { ok: true, path: file, count: jobs.length };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}
function loadQueue(body) {
  try {
    const file = path.join(projectQueueRoot(body && body.projectPath), 'queue.json');
    if (!fs.existsSync(file)) return { ok: true, jobs: [] };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, jobs: Array.isArray(data.jobs) ? data.jobs : [] };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e), jobs: [] }; }
}

module.exports = {
  generate: (body, onProgress) => runGeneration(body, 'generate', onProgress),
  saveQueue,
  loadQueue,
  renderVersionHQ,
  feedback: (body, onProgress) => runGeneration(body, body && body.mode === 'adjust' ? 'adjust' : 'regen', onProgress),
  // Etapas separadas para el pipeline de la cola (solapar modelo/render):
  prepareGenerate: (body, onProgress) => prepareGeneration(body, 'generate', onProgress),
  prepareFeedback: (body, onProgress) => prepareGeneration(body, body && body.mode === 'adjust' ? 'adjust' : 'regen', onProgress),
  renderPrepared,
  estimateTokens,
  listMarkerVersions,
  readMarkerHtml,
  renderManualHtml,
  deriveObjective,
  getConfig,
  setConfig: saveConfig,
  listOllamaModels,
  loginClaude,
  getVersion,
  checkUpdate,
  selfUpdate,
  readStill,
};
