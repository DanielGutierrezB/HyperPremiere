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
// fetch respaldado por el https nativo de Node (no el Chromium del panel CEP).
const { hpFetch } = require('./providers/http');
// Spawn de procesos externos (git, claude, npm, unzip): nunca lanza.
const { run } = require('./exec');
const { buildUserPrompt } = require('./prompt/build-context');
const { buildObjectivePrompt } = require('./prompt/objective');
const { renderComposition } = require('./render/hyperframes');
const {
  slugify,
  ensureOutputDir,
  paths,
  saveMeta,
  readMeta,
  saveStills,
  saveResources,
} = require('./store/project-fs');
// Nomenclatura versionada ("<slug> vN [modelo].ext"): parse/format canónicos.
const { versionFile, nextVersion, listVersions, groupBySlug } = require('./store/versions');

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

// Prueba REAL de las credenciales del proveedor activo. A diferencia del semáforo
// del panel (que solo mira si hay algo guardado), esto verifica de verdad:
//   - claude-api: llamada mínima (max_tokens:1) al endpoint → distingue key mala (401)
//     de modelo inexistente (404) de key OK (200).
//   - claude-cli: comprueba que haya sesión/token OAuth guardado.
// Devuelve { ok, error?, detail? } y nunca lanza.
async function testProvider() {
  const cfg = loadConfig();
  const provider = cfg.provider;
  try {
    if (provider === 'claude-cli') {
      if (!cfg.oauthToken) {
        return { ok: false, error: 'No hay sesión de Claude. Tocá "Iniciar sesión" para autorizar.' };
      }
      return { ok: true, detail: 'Sesión de Claude activa.' };
    }

    if (provider === 'claude-api') {
      const claudeApi = require('./providers/claude-api');
      const key = claudeApi.normalizeApiKey(cfg.apiKey);
      if (!key) return { ok: false, error: 'Falta la API key.' };
      if (/^sk-ant-oat/i.test(key)) {
        return { ok: false, error: 'Eso es un token de suscripción (sk-ant-oat…), no una API key. Cambiá el proveedor a "Claude (CLI / suscripción)" o pegá una API key real (sk-ant-api03-…).' };
      }

      const model = cfg.model || claudeApi.DEFAULT_MODEL;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      let res;
      try {
        res = await hpFetch(claudeApi.API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': claudeApi.API_VERSION,
          },
          body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) return { ok: true, detail: 'API key válida · modelo "' + model + '" OK.' };
      const raw = await res.text();
      if (res.status === 401) {
        return { ok: false, error: 'API key inválida (401). Revisá que sea correcta, de una cuenta activa y con saldo.' };
      }
      if (res.status === 404 || (res.status === 400 && /model/i.test(raw))) {
        return { ok: false, error: 'La API key es válida, pero el modelo "' + model + '" no existe en la API. Elegí otro modelo.' };
      }
      return { ok: false, error: 'HTTP ' + res.status + ': ' + raw.slice(0, 200) };
    }

    // openai-compat / ollama: no hacemos prueba profunda acá.
    return { ok: true, skipped: true, detail: 'Sin prueba automática para este proveedor.' };
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? 'timeout (15s) — ¿hay conexión?' : ((e && e.message) || String(e));
    return { ok: false, error: 'No se pudo probar: ' + msg };
  }
}

// Lista los modelos instalados en Ollama (GET <baseUrl>/api/tags).
// Devuelve { ok, models: [name, ...] } o { ok:false, error }.
async function listOllamaModels(baseUrl) {
  const base = String(baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  try {
    const res = await hpFetch(base + '/api/tags');
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
// Convierte un still (data URL o ruta a archivo) a data URL. Devuelve null si no
// se puede leer. Permite guardar capturas como ruta en el panel (sin base64 en
// localStorage) y aun así mandarlas al modelo como imagen.
function stillToDataUrl(s) {
  s = String(s || '');
  if (/^data:/i.test(s)) return s;
  const p = s.replace(/^file:\/\//, '');
  try {
    if (fs.existsSync(p)) {
      const ext = (path.extname(p).slice(1) || 'png').toLowerCase();
      const mt = ext === 'jpg' ? 'jpeg' : ext;
      return 'data:image/' + mt + ';base64,' + fs.readFileSync(p).toString('base64');
    }
  } catch (e) {}
  return null;
}

// Lee ancho×alto de un buffer PNG o JPEG sin dependencias (parseo de cabecera).
// Devuelve {w,h} o null.
function imageDims(buf) {
  try {
    if (!buf || buf.length < 24) return null;
    // PNG: firma 89 50 4E 47; IHDR → ancho en offset 16, alto en 20 (big-endian).
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // JPEG: firma FF D8; recorrer marcadores hasta un SOF (C0–CF salvo C4/C8/CC).
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        const len = buf.readUInt16BE(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
        }
        off += 2 + len;
      }
    }
  } catch (e) {}
  return null;
}

// Guarda las imágenes provistas como ARCHIVOS embebibles (asset-01.png, …) en
// `dir`; se copian al workDir/assets del render para que el HTML pueda
// referenciarlas con <img src="assets/asset-01.png">. Devuelve [{name, w, h}]
// (dimensiones cuando se pudieron leer) para informarle al modelo.
function saveAssets(dir, dataUrls) {
  const list = Array.isArray(dataUrls) ? dataUrls : [];
  // Limpiar SIEMPRE el dir (aunque no haya assets) para no arrastrar imágenes de
  // una generación anterior que ya no están marcadas "usar".
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  if (!list.length) return [];
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  list.forEach((du, i) => {
    const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(String(du || ''));
    if (!m) return;
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1].replace(/[^a-z0-9]/gi, '') || 'png';
    const name = 'asset-' + String(i + 1).padStart(2, '0') + '.' + ext;
    try {
      const buf = Buffer.from(m[2], 'base64');
      fs.writeFileSync(path.join(dir, name), buf);
      const d = imageDims(buf);
      out.push({ name, w: d ? d.w : null, h: d ? d.h : null });
    } catch (e) {}
  });
  return out;
}

async function prepareGeneration(body, mode, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  const { projectPath, sequenceName, objective, transcript, marker, markerTranscript,
    instruction, stills, adjustment, previousHtml } = body || {};

  if (!marker || typeof marker !== 'object') throw new Error('Falta "marker"');
  const durationSec = Number(marker.duration) || 0;
  if (durationSec <= 0) throw new Error('marker.duration debe ser > 0');

  const markerSlug = String(body.markerSlug || '').trim() || slugify(marker.name);
  // Los stills pueden venir como data URL (arrastrados) o como RUTA a archivo
  // (capturas guardadas en _capturas — así no revientan la cuota de localStorage).
  // Normalizamos todo a data URL para que providers/saveStills funcionen igual.
  const stillsList = (Array.isArray(stills) ? stills : []).map(stillToDataUrl).filter(Boolean);
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
  // Refinamiento (adjust): prompt lean — no reenviar el transcript completo (ya
  // tiene el HTML previo + el fragmento del marcador). Ahorra tokens en feedback.
  const leanPrompt = mode === 'adjust';
  let userPrompt = buildUserPrompt({
    objective, transcriptSegments: transcript, marker, markerTranscript,
    instruction, generalInstruction: body.generalInstruction, stillsCount: stillsList.length,
    lean: leanPrompt,
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

  // Imágenes provistas también disponibles como ARCHIVO para INCRUSTAR (logo/icono/
  // foto). Se guardan en <base>/_assets/<slug> y se copian al render; el modelo las
  // referencia con <img src="assets/asset-NN.ext"> si la instrucción pide usarlas.
  // Assets a INCRUSTAR = solo las imágenes que el editor marcó "usar" (body.assets),
  // normalizadas a data URL. Las demás stills quedan solo como referencia visual.
  const assetList = (Array.isArray(body.assets) ? body.assets : []).map(stillToDataUrl).filter(Boolean);
  const assetsDir = path.join(baseDir, '_assets', markerSlug);
  const assetInfos = saveAssets(assetsDir, assetList);
  if (assetInfos.length) {
    userPrompt += '\n\n## Imágenes provistas disponibles como ARCHIVO (para incrustar)\n' +
      'Las imágenes que ves también están disponibles como archivos en la carpeta assets/ del proyecto ' +
      '(con sus dimensiones reales en px — respetá el aspect ratio al usarlas):\n' +
      assetInfos.map((a) => '- assets/' + a.name + (a.w && a.h ? ' (' + a.w + '×' + a.h + ' px)' : '')).join('\n') +
      '\nSi la instrucción pide USAR o incluir una imagen provista (un logo, icono, foto o marca), ' +
      'INCRUSTALA tal cual con <img src="assets/NOMBRE"> (ruta relativa exacta) — NO la recrees ni dibujes una aproximación. ' +
      'Escalala manteniendo su proporción (usá las dimensiones de arriba) y ubicala según la instrucción. ' +
      'Si son solo referencia visual (por ej. un frame del video para leer composición/paleta), usalas como contexto y NO las incrustes.';
  }

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
    usage: usageAcc, background: withBackground, instruction, marker, assetsDir,
    model: config.model, provider: config.provider, mode, adjustment,
  };
}

// Historia acumulada de instrucciones: lee la meta de la versión anterior y
// devuelve su history + su propia entrada. [] para v1 o si no hay meta previa.
function buildHistory(baseDir, markerSlug, version) {
  if (!(version > 1)) return [];
  const prevMetaPath = versionFile(baseDir, markerSlug, version - 1, '.meta.json');
  const prevMeta = prevMetaPath ? readMeta(prevMetaPath) : null;
  if (!prevMeta) return [];
  const history = Array.isArray(prevMeta.history) ? prevMeta.history.slice() : [];
  history.push({ version: prevMeta.version, instruction: prevMeta.instruction, createdAt: prevMeta.createdAt });
  return history;
}

// Etapa 2 (RENDER): renderiza el HTML preparado y guarda la metadata.
async function renderPrepared(prepared, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  if (!prepared || !prepared.ok) throw new Error('renderPrepared: prepared inválido');
  report({ pct: 60, msg: prepared.background ? 'Renderizando video HD (con fondo)…' : 'Renderizando el video con alpha…' });
  await renderComposition({
    html: prepared.html, outMovPath: prepared.outMovPath, durationSec: prepared.durationSec,
    onProgress: report, format: prepared.videoExt, quality: prepared.draft ? 'draft' : 'high',
    assetsDir: prepared.assetsDir,
  });

  saveMeta(prepared.metaPath, {
    instruction: prepared.instruction, marker: prepared.marker, version: prepared.version,
    model: prepared.model, provider: prepared.provider, mode: prepared.mode,
    adjustment: prepared.mode === 'adjust' ? prepared.adjustment : undefined,
    background: prepared.background, format: prepared.videoExt,
    createdAt: new Date(Date.now()).toISOString(),
    history: buildHistory(prepared.baseDir, prepared.markerSlug, prepared.version),
  });

  return { ok: true, movPath: prepared.outMovPath, htmlPath: prepared.htmlPath, version: prepared.version, markerSlug: prepared.markerSlug, usage: prepared.usage, background: prepared.background };
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
        lean: body.mode === 'adjust',
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
async function loginClaude() {
  const r = await run('claude', ['setup-token'], { timeoutMs: 300_000, shell: IS_WIN });
  const m = (r.out + '\n' + r.err).match(/sk-ant-oat[0-9]+-[A-Za-z0-9_-]+/);
  if (!m) {
    if (r.code === -1 && r.err === 'timeout') throw new Error('login: timeout (5 min)');
    if (r.code === -1) throw new Error('no se pudo ejecutar claude: ' + r.err);
    throw new Error('login: no se encontró el token en la salida');
  }
  const raw = loadRawConfig();
  raw.oauthToken = m[0];
  raw.provider = 'claude-cli';
  saveRawConfig(raw);
  return { ok: true, provider: 'claude-cli' };
}

const REPO_ROOT = path.join(__dirname, '..');

// Junta el HTML de la última versión de los OTROS marcadores ya generados en
// esta clase, para dar continuidad (retomar/continuar lo hecho en otro marcador).
function listOtherResources(baseDir, currentSlug) {
  const bySlug = groupBySlug(baseDir, ['.html']);
  const out = [];
  let budget = 6000; // tope total de chars para no inflar tokens
  for (const slug of Object.keys(bySlug)) {
    if (slug === currentSlug) continue;
    if (budget <= 0) break;
    const latest = bySlug[slug][bySlug[slug].length - 1]; // orden ascendente → última
    try {
      let html = fs.readFileSync(path.join(baseDir, latest.name), 'utf8');
      if (html.length > 4000) html = html.slice(0, 4000) + '\n<!-- …(recortado)… -->';
      budget -= html.length;
      out.push({ slug: slug + ' v' + latest.version, html: html });
    } catch (e) {}
  }
  return out;
}

// Lee un PNG (el frame capturado por host.jsx) y lo devuelve como dataURL.
// Borra el archivo temporal después. Lo hace Node (fiable), no la API de CEP.
// Guarda una captura del programa en la carpeta de la secuencia (para tener todo
// el contexto en disco) y devuelve su dataUrl para usarla como still. Mueve el
// PNG temporal a "<seq>/_capturas/<marcador>-<stamp>.png".
function saveCapture(body) {
  try {
    body = body || {};
    const tmpPath = body.tmpPath;
    if (!tmpPath || !fs.existsSync(tmpPath)) return { ok: false, error: 'no existe la captura: ' + tmpPath };
    const baseDir = ensureOutputDir(body.projectPath, body.sequenceName);
    const capDir = path.join(baseDir, '_capturas');
    fs.mkdirSync(capDir, { recursive: true });
    const slug = String(body.markerSlug || 'general').replace(/[^a-zA-Z0-9._-]+/g, '-') || 'general';
    const stamp = (path.basename(tmpPath).match(/\d+/) || [String(Date.now())])[0];
    const dest = path.join(capDir, slug + '-' + stamp + '.png');
    fs.copyFileSync(tmpPath, dest);
    try { fs.unlinkSync(tmpPath); } catch (e) {}
    const b64 = fs.readFileSync(dest).toString('base64');
    if (!b64) return { ok: false, error: 'la captura quedó vacía' };
    return { ok: true, dataUrl: 'data:image/png;base64,' + b64, savedPath: dest };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

function getVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'version.json'), 'utf8')).version || '0.0.0';
  } catch (e) { return '0.0.0'; }
}

// Corre un comando git dentro del repo. Devuelve { code, out, err } (nunca lanza).
function gitRun(args) {
  return run('git', ['-C', REPO_ROOT].concat(args), { timeoutMs: 90_000, shell: IS_WIN });
}

// ── Auto-update INDEPENDIENTE DE GIT ────────────────────────────────────────
// El botón ⟳ debe funcionar para CUALQUIER instalación (ZXP empaquetado o dev
// con git), sin exigir git ni un checkout al usuario final. Estrategia:
//   - Instalación dev (hay .git en REPO_ROOT) → seguimos con git (fetch+reset).
//   - Instalación empaquetada (sin .git)      → bajamos el zip público de GitHub
//     y reemplazamos los archivos en su lugar, preservando bridge/node_modules
//     (410 MB, se instala una sola vez) y con respaldo para poder revertir.
const GH_OWNER = 'DanielGutierrezB';
const GH_REPO = 'HyperPremiere';
const GH_BRANCH = 'main';
const RAW_VERSION_URL = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/version.json`;
const ZIP_URL = `https://codeload.github.com/${GH_OWNER}/${GH_REPO}/zip/refs/heads/${GH_BRANCH}`;

function isGitRepo() {
  try { return fs.existsSync(path.join(REPO_ROOT, '.git')); } catch (e) { return false; }
}

// Compara "1.0.55" vs "1.0.54". >0 si a>b, <0 si a<b, 0 iguales.
function cmpVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Lee la versión remota desde el version.json crudo de GitHub (con cache-buster).
async function fetchRemoteVersion() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await hpFetch(RAW_VERSION_URL + '?t=' + Date.now(), { signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = JSON.parse(await res.text());
    return String(data.version || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

// Descarga el zip del branch a un archivo local.
async function downloadZip(destFile) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await hpFetch(ZIP_URL, { signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' al descargar el zip');
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('el zip vino vacío');
    fs.writeFileSync(destFile, buf);
  } finally {
    clearTimeout(timer);
  }
}

// Extrae el zip a destDir usando la herramienta nativa del SO (sin dependencias).
async function extractZip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = IS_WIN
    ? await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${destDir}' -Force`])
    : await run('unzip', ['-o', '-q', zipFile, '-d', destDir]);
  if (r.code !== 0) throw new Error('no se pudo descomprimir: ' + (r.err.trim() || ('código ' + r.code)).slice(0, 200));
}

// Filtro compartido: nunca copiamos node_modules, .git ni basura del SO.
function skipPathForCopy(p) {
  const n = String(p).replace(/\\/g, '/');
  return /\/node_modules(\/|$)/.test(n) || /\/\.git(\/|$)/.test(n) || /\/\.DS_Store$/.test(n);
}

// Aplica la actualización empaquetada: baja el zip, arma el árbol instalable
// (cep/* en la raíz + bridge/ + version.json) y lo escribe SOBRE REPO_ROOT.
// Preserva bridge/node_modules (no lo toca) y respalda el código para revertir
// si la escritura falla a mitad de camino.
async function applyPackagedUpdate() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-update-'));
  const zipFile = path.join(tmpBase, 'src.zip');
  const exDir = path.join(tmpBase, 'extract');
  const stage = path.join(tmpBase, 'stage');
  const backup = path.join(tmpBase, 'backup');
  try {
    await downloadZip(zipFile);
    await extractZip(zipFile, exDir);

    // El zip de un branch se extrae como "<repo>-<branch>/…": tomamos ese dir.
    const rootName = fs.readdirSync(exDir).find((n) => {
      try { return fs.statSync(path.join(exDir, n)).isDirectory(); } catch (e) { return false; }
    });
    if (!rootName) throw new Error('el zip no trajo contenido');
    const srcRoot = path.join(exDir, rootName);
    const srcCep = path.join(srcRoot, 'cep');
    const srcBridge = path.join(srcRoot, 'bridge');
    const srcVer = path.join(srcRoot, 'version.json');
    if (!fs.existsSync(path.join(srcCep, 'index.html')) ||
        !fs.existsSync(path.join(srcBridge, 'engine.js')) ||
        !fs.existsSync(srcVer)) {
      throw new Error('el zip no tiene la estructura esperada (cep/index.html + bridge/engine.js)');
    }

    // Árbol EMPAQUETADO en staging (igual que hace scripts/sign-zxp.js).
    fs.mkdirSync(stage, { recursive: true });
    fs.cpSync(srcCep, stage, { recursive: true, filter: (s) => !skipPathForCopy(s) });
    fs.cpSync(srcBridge, path.join(stage, 'bridge'), { recursive: true, filter: (s) => !skipPathForCopy(s) });
    fs.copyFileSync(srcVer, path.join(stage, 'version.json'));

    // Respaldo del código vivo (sin node_modules) por si la escritura falla.
    fs.cpSync(REPO_ROOT, backup, { recursive: true, filter: (s) => !skipPathForCopy(s) });

    // Escribir SOBRE la instalación viva. No tocamos bridge/node_modules
    // (el stage no lo contiene), así preservamos las deps ya instaladas.
    try {
      fs.cpSync(stage, REPO_ROOT, { recursive: true, force: true });
    } catch (e) {
      // Revertir con el respaldo.
      try { fs.cpSync(backup, REPO_ROOT, { recursive: true, force: true }); } catch (_) {}
      throw new Error('falló la escritura; restauré el respaldo: ' + ((e && e.message) || e));
    }
  } finally {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (e) {}
  }
}

// Chequea GitHub SIN aplicar. Devuelve { ok, current, remote, changed }.
async function checkUpdate() {
  const current = getVersion();
  if (isGitRepo()) {
    const f = await gitRun(['fetch', 'origin', 'main']);
    if (f.code !== 0) return { ok: false, error: 'No se pudo consultar GitHub: ' + (f.err.trim() || 'fetch falló').slice(0, 200), current };
    const rv = await gitRun(['show', 'origin/main:version.json']);
    let remote = current;
    try { remote = JSON.parse(rv.out).version || remote; } catch (e) {}
    const cnt = await gitRun(['rev-list', '--count', 'HEAD..origin/main']);
    const behind = parseInt((cnt.out || '0').trim(), 10) || 0;
    return { ok: true, current, remote, behind, changed: behind > 0 };
  }
  try {
    const remote = await fetchRemoteVersion();
    // Solo hacia ADELANTE: si lo local es igual o más nuevo que main, no hay
    // actualización (evita que ⟳ "baje" una instalación adelantada).
    return { ok: true, current, remote, changed: !!remote && cmpVersions(remote, current) > 0 };
  } catch (e) {
    return { ok: false, error: 'No se pudo consultar GitHub: ' + ((e && e.message) || e), current };
  }
}

// Actualiza el plugin a la versión remota. Instalación git → reset --hard;
// instalación empaquetada → descarga+reemplazo. Devuelve
// { ok, changed, version, previous, remoteVersion }.
async function selfUpdate() {
  const before = getVersion();

  if (isGitRepo()) {
    const chk = await checkUpdate();
    if (!chk.ok) return { ok: false, error: chk.error };
    if (!chk.changed) return { ok: true, changed: false, version: before, remoteVersion: chk.remote };
    const r = await gitRun(['reset', '--hard', 'origin/main']);
    if (r.code !== 0) return { ok: false, error: 'No se pudo aplicar la actualización: ' + (r.err.trim() || 'reset falló').slice(0, 200) };
    return { ok: true, changed: true, version: getVersion(), previous: before, remoteVersion: chk.remote };
  }

  // Instalación empaquetada (ZXP): descarga + reemplazo, sin git.
  let remote;
  try { remote = await fetchRemoteVersion(); }
  catch (e) { return { ok: false, error: 'No se pudo consultar GitHub: ' + ((e && e.message) || e) }; }
  if (!remote) return { ok: false, error: 'No se pudo leer la versión remota de GitHub.' };
  // Solo hacia adelante (igual que checkUpdate): nunca "bajar" de versión.
  if (cmpVersions(remote, before) <= 0) return { ok: true, changed: false, version: before, remoteVersion: remote };

  try {
    await applyPackagedUpdate();
    return { ok: true, changed: true, version: getVersion(), previous: before, remoteVersion: remote };
  } catch (e) {
    return { ok: false, error: 'No se pudo actualizar: ' + ((e && e.message) || e) };
  }
}

// Lista las versiones ya generadas de un marcador (escaneo del baseDir).
// Devuelve { ok, versions: [{ version, model }] } ordenado por versión.
function listMarkerVersions(body) {
  try {
    body = body || {};
    const markerSlug = String(body.markerSlug || '').trim();
    if (!markerSlug) return { ok: false, error: 'falta markerSlug', versions: [] };
    const baseDir = ensureOutputDir(body.projectPath, body.sequenceName);
    return { ok: true, versions: listVersions(baseDir, markerSlug, '.html') };
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
  await renderComposition({ html: cleanHtml, outMovPath: outPaths.mov, durationSec, onProgress: report, quality: body.draft ? 'draft' : 'high', assetsDir: path.join(baseDir, '_assets', markerSlug) });

  saveMeta(outPaths.meta, {
    instruction: '(edición manual)', marker, version, model: 'manual', provider: 'manual',
    mode: 'manual-edit', createdAt: new Date(Date.now()).toISOString(),
    history: buildHistory(baseDir, markerSlug, version),
  });

  return { ok: true, movPath: outPaths.mov, htmlPath: outPaths.html, version, markerSlug };
}

// Re-renderiza la ÚLTIMA versión de un marcador (HTML ya diseñado en disco) SIN
// volver a llamar a la IA. Dos modos:
//   hq=true  → "Render HQ": re-render en ALTA reemplazando EN SU LUGAR el video
//              existente (el que ya está en el timeline); no crea versión nueva
//              y el panel recolorea el clip a magenta. Falla si no hay video.
//   hq=false → "reintentar render": el modelo ya había terminado pero el render
//              falló. Respeta la calidad pedida (draft/alta) y, si el video no
//              llegó a escribirse, usa la ruta nueva de esa versión.
async function rerenderLatest(body, hq, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  body = body || {};
  const markerSlug = String(body.markerSlug || '').trim();
  if (!markerSlug) throw new Error('re-render: falta markerSlug');
  const durationSec = Number((body.marker || {}).duration) || 0;
  if (durationSec <= 0) throw new Error('re-render: marker.duration debe ser > 0');

  const baseDir = ensureOutputDir(body.projectPath, body.sequenceName);
  const versions = listVersions(baseDir, markerSlug, '.html');
  if (!versions.length) throw new Error('No hay versiones (HTML) para re-renderizar de ' + markerSlug);
  const latest = versions[versions.length - 1];
  const srcHtmlPath = versionFile(baseDir, markerSlug, latest.version, '.html');
  const html = srcHtmlPath ? fs.readFileSync(srcHtmlPath, 'utf8') : '';
  if (!html) throw new Error('No se encontró el HTML de la última versión (v' + latest.version + ')');

  const withBackground = body.background === true;
  const videoExt = withBackground ? 'mp4' : 'mov';
  // Video existente de esa versión, tolerando que la extensión haya cambiado.
  let movPath = versionFile(baseDir, markerSlug, latest.version, '.' + videoExt) ||
    versionFile(baseDir, markerSlug, latest.version, '.mov') ||
    versionFile(baseDir, markerSlug, latest.version, '.mp4');
  if (!movPath) {
    if (hq) throw new Error('No se encontró el archivo de video de v' + latest.version + ' para reemplazar');
    movPath = paths(baseDir, markerSlug, latest.version, latest.model || 'x', videoExt).mov;
  }

  const quality = (hq || !body.draft) ? 'high' : 'draft';
  report({
    pct: 30,
    msg: hq ? 'Render HQ (reemplazando v' + latest.version + ' en alta)…'
            : 'Re-render de v' + latest.version + ' (sin re-diseñar)…',
  });
  await renderComposition({ html, outMovPath: movPath, durationSec, onProgress: report, format: videoExt, quality, assetsDir: path.join(baseDir, '_assets', markerSlug) });
  const out = { ok: true, movPath, htmlPath: srcHtmlPath, version: latest.version, markerSlug, background: withBackground };
  if (hq) out.replaced = true;
  return out;
}

// Limpia VIDEOS de versiones viejas de una secuencia: por cada marcador deja
// solo el video (.mov/.mp4) de la ÚLTIMA versión y borra los anteriores.
// NO toca los .html (historial/editor) ni stills/recursos. Devuelve cuánto liberó.
// Agrupa los archivos de VIDEO por marcador con su versión: { slug: [{name,version,path,size}] }.
function groupMarkerVideos(baseDir) {
  const grouped = groupBySlug(baseDir, ['.mov', '.mp4']);
  const bySlug = {};
  Object.keys(grouped).forEach((slug) => {
    bySlug[slug] = grouped[slug].map((e) => {
      const full = path.join(baseDir, e.name);
      let size = 0; try { size = fs.statSync(full).size; } catch (err) {}
      return { name: e.name, version: e.version, path: full, size };
    });
  });
  return bySlug;
}

// Calcula los VIDEOS de versiones viejas (no-últimas) de una secuencia. SIN borrar.
function oldVersionVideos(projectPath, sequenceName) {
  const bySlug = groupMarkerVideos(ensureOutputDir(projectPath, sequenceName));
  const out = [];
  Object.keys(bySlug).forEach((slug) => {
    const list = bySlug[slug];
    let maxV = 0; list.forEach((x) => { if (x.version > maxV) maxV = x.version; });
    list.forEach((x) => { if (x.version < maxV) out.push({ name: x.name, path: x.path, size: x.size }); });
  });
  return out;
}

// Lista (sin borrar) los videos de versiones viejas → el panel primero saca esos
// ítems de la secuencia/proyecto en Premiere y RECIÉN después borra los archivos.
function listOldVersions(body) {
  try {
    body = body || {};
    return { ok: true, files: oldVersionVideos(body.projectPath, body.sequenceName) };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e), files: [] }; }
}

// Vista previa para la confirmación: por marcador, qué se BORRA y cuál se CONSERVA
// (la última versión). Devuelve grupos + totales. No borra nada.
function cleanupPreview(body) {
  try {
    body = body || {};
    const bySlug = groupMarkerVideos(ensureOutputDir(body.projectPath, body.sequenceName));
    const groups = []; let totalDeletes = 0, totalBytes = 0;
    Object.keys(bySlug).forEach((slug) => {
      const list = bySlug[slug].slice().sort((a, b) => a.version - b.version);
      let maxV = 0; list.forEach((x) => { if (x.version > maxV) maxV = x.version; });
      const keep = list.filter((x) => x.version === maxV)[0] || null;
      const deletes = list.filter((x) => x.version < maxV).map((x) => ({ name: x.name, version: x.version, size: x.size }));
      if (deletes.length) {
        deletes.forEach((d) => { totalDeletes++; totalBytes += d.size || 0; });
        groups.push({ slug, keep: keep ? { name: keep.name, version: keep.version } : null, deletes });
      }
    });
    return { ok: true, sequenceName: body.sequenceName, groups, totalDeletes, totalBytes };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e), groups: [] }; }
}

function cleanOldVersions(body) {
  try {
    body = body || {};
    const list = oldVersionVideos(body.projectPath, body.sequenceName);
    let deleted = 0, freed = 0; const names = [];
    list.forEach((x) => {
      try { fs.unlinkSync(x.path); deleted++; freed += x.size; names.push(x.name); } catch (e) {}
    });
    return { ok: true, deleted, freedBytes: freed, names };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

// ── Preparación del motor (autocontenido) ───────────────────────────────
// El ZXP trae el CÓDIGO del motor (bridge/) pero NO node_modules (410 MB,
// binarios nativos por plataforma). En la 1ª corrida de una instalación limpia
// instalamos las deps una sola vez con el npm del sistema, dentro de bridge/.
function engineDepsReady() {
  try {
    const bin = path.join(__dirname, 'node_modules', '.bin', IS_WIN ? 'hyperframes.cmd' : 'hyperframes');
    return fs.existsSync(bin);
  } catch (e) { return false; }
}
function engineStatus() {
  return { ok: true, depsReady: engineDepsReady(), bridgeDir: __dirname, platform: process.platform };
}
// Corre `npm install` en bridge/ (trae hyperframes + su Chromium). Reporta
// progreso por onProgress({ pct, msg }). Devuelve { ok } o { ok:false, error }.
// Poda onnxruntime-node (~258 MB): hyperframes SOLO lo import()-a dinámicamente
// dentro de "remove-background" (que HyperPremiere no usa) → el render nunca lo
// toca. NO tocamos sharp: aunque también es import() dinámico y guardado por
// try/catch, participa en rutas de captions/descripciones que podrían afectar el
// resultado; 16 MB no valen ese riesgo. Devuelve MB liberados.
function pruneUnusedEngineDeps() {
  const nm = path.join(__dirname, 'node_modules');
  const targets = ['onnxruntime-node'];
  let freed = 0; const removed = [];
  for (const t of targets) {
    const dir = path.join(nm, t);
    try {
      if (!fs.existsSync(dir)) continue;
      freed += dirSizeBytes(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(t);
    } catch (e) {}
  }
  return { ok: true, removed, freedBytes: freed };
}
function dirSizeBytes(dir) {
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      let st; try { st = fs.lstatSync(p); } catch (e) { continue; }
      if (st.isDirectory()) total += dirSizeBytes(p);
      else total += st.size;
    }
  } catch (e) {}
  return total;
}

async function prepareEngine(_arg, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  if (engineDepsReady()) return { ok: true, alreadyReady: true };
  report({ pct: 4, msg: 'Instalando el motor (una sola vez, puede tardar varios minutos)…' });
  let tail = '';
  // timeoutMs: 0 = sin tope — npm baja el Chromium de hyperframes y puede
  // tardar muchos minutos en conexiones lentas.
  const r = await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: __dirname, shell: IS_WIN, timeoutMs: 0,
    onData: (s) => {
      tail = (tail + s).slice(-2000);
      const line = s.split('\n').map((l) => l.trim()).filter(Boolean).pop();
      if (line) report({ msg: line.slice(0, 140) });
    },
  });
  if (r.code === -1) {
    return { ok: false, error: 'No se pudo ejecutar npm (¿Node instalado en el equipo?): ' + r.err };
  }
  if (r.code !== 0 || !engineDepsReady()) {
    return { ok: false, error: 'npm install terminó con código ' + r.code + '.\n' + tail.slice(-400) };
  }
  report({ pct: 92, msg: 'Podando dependencias que no se usan…' });
  const pr = pruneUnusedEngineDeps();
  report({ pct: 100, msg: 'Motor listo (liberados ' + (pr.freedBytes / 1048576).toFixed(0) + ' MB no usados).' });
  return { ok: true, pruned: pr };
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
  // Pipeline de la cola en 2 etapas (solapar modelo/render):
  prepareGenerate: (body, onProgress) => prepareGeneration(body, 'generate', onProgress),
  prepareFeedback: (body, onProgress) => prepareGeneration(body, body && body.mode === 'adjust' ? 'adjust' : 'regen', onProgress),
  renderPrepared,
  // Re-render de la última versión sin IA (Render HQ / reintento del render):
  renderVersionHQ: (body, onProgress) => rerenderLatest(body, true, onProgress),
  renderLatest: (body, onProgress) => rerenderLatest(body, false, onProgress),
  renderManualHtml,
  saveQueue,
  loadQueue,
  cleanOldVersions,
  listOldVersions,
  cleanupPreview,
  engineStatus,
  prepareEngine,
  estimateTokens,
  listMarkerVersions,
  readMarkerHtml,
  deriveObjective,
  getConfig,
  setConfig: saveConfig,
  testProvider,
  listOllamaModels,
  loginClaude,
  getVersion,
  checkUpdate,
  selfUpdate,
  saveCapture,
};
