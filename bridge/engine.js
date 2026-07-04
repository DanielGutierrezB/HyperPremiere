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

// CEP corre Node con un PATH mínimo (apps de GUI en macOS no heredan el shell).
// Prepend de las rutas donde viven claude, ffmpeg, node y demás, para que los
// spawn (claude, hyperframes→ffmpeg) los encuentren dentro de Premiere.
(function ensurePath() {
  const extra = ['/opt/homebrew/bin', path.join(os.homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
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

async function runGeneration(body, mode, onProgress) {
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
  const baseDir = ensureOutputDir(projectPath, sequenceName);
  const version = nextVersion(baseDir, markerSlug);
  const outPaths = paths(baseDir, markerSlug, version, config.model);

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

  // Continuidad: exponer los otros recursos ya generados en la clase, por si la
  // instrucción pide continuar/retomar otro marcador.
  const others = listOtherResources(baseDir, markerSlug);
  if (others.length) {
    userPrompt += '\n\n## Otros recursos ya generados en esta clase (referencia de continuidad y estilo)\n' +
      'Si tu instrucción pide continuar, retomar o mantener coherencia con otro marcador, usá estos como base:\n' +
      others.map((o) => '### ' + o.slug + '\n```html\n' + o.html + '\n```').join('\n\n');
  }

  const provider = getProvider(config.provider);
  const verbo = mode === 'regen' ? 'desde cero' : mode === 'adjust' ? '(refinando)' : '';
  report({ pct: 15, msg: 'Diseñando la animación con ' + config.model + ' ' + verbo + '…' });
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

  report({ pct: 55, msg: 'Renderizando el video con alpha…' });
  await renderComposition({ html, outMovPath: outPaths.mov, durationSec, onProgress: report });
  report({
    pct: 96,
    msg: 'Tokens: ↑' + usageAcc.inputTokens + ' ↓' + usageAcc.outputTokens +
      (typeof usageAcc.costUsd === 'number' ? ' · $' + usageAcc.costUsd.toFixed(4) : ''),
    usage: usageAcc,
  });

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
    instruction, marker, version, model: config.model, provider: config.provider,
    mode, adjustment: mode === 'adjust' ? adjustment : undefined,
    createdAt: new Date(Date.now()).toISOString(), history,
  });

  return { ok: true, movPath: outPaths.mov, htmlPath: outPaths.html, version, markerSlug, usage: usageAcc };
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
    const child = spawn('claude', ['setup-token'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  let budget = 12000; // tope total de chars para no inflar tokens
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

// Actualiza el plugin: git pull --ff-only de la última versión publicada.
// Devuelve { ok, version, changed, log }. Tras esto, el panel se recarga.
function selfUpdate() {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const before = getVersion();
    const child = spawn('git', ['-C', REPO_ROOT, 'pull', '--ff-only', 'origin', 'main'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('update: timeout')); }, 60000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('no se pudo ejecutar git: ' + e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error((err.trim() || out.trim() || 'git pull falló').slice(0, 300)));
      const after = getVersion();
      resolve({ ok: true, version: after, changed: after !== before || !/Already up to date/i.test(out), log: (out + err).trim().slice(0, 300) });
    });
  });
}

module.exports = {
  generate: (body, onProgress) => runGeneration(body, 'generate', onProgress),
  feedback: (body, onProgress) => runGeneration(body, body && body.mode === 'adjust' ? 'adjust' : 'regen', onProgress),
  estimateTokens,
  deriveObjective,
  getConfig,
  setConfig: saveConfig,
  listOllamaModels,
  loginClaude,
  getVersion,
  selfUpdate,
  readStill,
};
