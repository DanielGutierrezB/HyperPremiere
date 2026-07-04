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
  nextVersion,
  saveMeta,
  readMeta,
  saveStills,
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
const DEFAULT_CONFIG = { provider: 'claude-cli', model: 'claude-sonnet-5', apiKey: '', baseUrl: '', oauthToken: '' };

function loadConfig() {
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch (e) {}
  const cfg = Object.assign({}, DEFAULT_CONFIG, stored);
  if (!cfg.model || !String(cfg.model).trim()) cfg.model = DEFAULT_CONFIG.model;
  if (!cfg.provider || !String(cfg.provider).trim()) cfg.provider = DEFAULT_CONFIG.provider;
  return cfg;
}

function saveConfig(patch) {
  const cfg = loadConfig();
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (patch[key] === undefined || patch[key] === null) continue;
    const val = String(patch[key]);
    if ((key === 'model' || key === 'provider') && !val.trim()) continue;
    if (key === 'apiKey' && val.startsWith('••••')) continue; // enmascarada
    cfg[key] = val;
  }
  if (!cfg.model || !String(cfg.model).trim()) cfg.model = DEFAULT_CONFIG.model;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return maskConfig(cfg);
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

async function runGeneration(body, mode, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  const { projectPath, sequenceName, objective, transcript, marker, markerTranscript,
    instruction, stills, adjustment, previousHtml } = body || {};

  if (!marker || typeof marker !== 'object') throw new Error('Falta "marker"');
  const durationSec = Number(marker.duration) || 0;
  if (durationSec <= 0) throw new Error('marker.duration debe ser > 0');

  const markerSlug = String(body.markerSlug || '').trim() || slugify(marker.name);
  const stillsList = Array.isArray(stills) ? stills : [];

  report({ pct: 5, msg: 'Armando el contexto…' });
  const systemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
  let userPrompt = buildUserPrompt({
    objective, transcriptSegments: transcript, marker, markerTranscript,
    instruction, stillsCount: stillsList.length,
  });

  const baseDir = ensureOutputDir(projectPath, sequenceName);
  const version = nextVersion(baseDir, markerSlug);
  const outPaths = paths(baseDir, markerSlug, version);

  // Modo "ajustar": toma como REFERENCIA la última versión ya generada.
  // Si el panel no mandó el HTML previo, lo leemos del disco (versión anterior).
  if (mode === 'adjust') {
    let prevHtml = String(previousHtml || '').trim();
    if (!prevHtml && version > 1) {
      try { prevHtml = fs.readFileSync(paths(baseDir, markerSlug, version - 1).html, 'utf8'); } catch (e) {}
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

  const config = loadConfig();
  const provider = getProvider(config.provider);
  const verbo = mode === 'regen' ? 'desde cero' : mode === 'adjust' ? '(refinando)' : '';
  report({ pct: 15, msg: 'Diseñando la animación con ' + config.model + ' ' + verbo + '…' });
  const rawResponse = await provider.generate({
    systemPrompt, userPrompt, images: stillsList, model: config.model, config,
  });

  const html = stripHtmlFence(rawResponse);
  if (!html) throw new Error(`El proveedor "${config.provider}" devolvió respuesta vacía`);
  fs.writeFileSync(outPaths.html, html, 'utf8');

  report({ pct: 55, msg: 'Renderizando el video con alpha…' });
  await renderComposition({ html, outMovPath: outPaths.mov, durationSec, onProgress: report });
  report({ pct: 96, msg: 'Guardando archivos…' });

  let history = [];
  if (version > 1) {
    const prevMeta = readMeta(paths(baseDir, markerSlug, version - 1).meta);
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

  return { ok: true, movPath: outPaths.mov, htmlPath: outPaths.html, version, markerSlug };
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
  const raw = await provider.generate({
    systemPrompt: system, userPrompt: user, images: [], model: config.model, config,
  });
  return { ok: true, objective: String(raw || '').trim() };
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
      const cfg = loadConfig();
      cfg.oauthToken = m[0];
      cfg.provider = 'claude-cli';
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
      resolve({ ok: true, provider: 'claude-cli' });
    });
  });
}

const REPO_ROOT = path.join(__dirname, '..');

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
  deriveObjective,
  getConfig,
  setConfig: saveConfig,
  loginClaude,
  getVersion,
  selfUpdate,
  readStill,
};
