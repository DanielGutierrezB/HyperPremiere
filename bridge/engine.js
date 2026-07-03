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
const DEFAULT_CONFIG = { provider: 'claude-cli', model: 'claude-opus-4-8', apiKey: '', baseUrl: '', oauthToken: '' };

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

async function runGeneration(body, mode) {
  const { projectPath, sequenceName, objective, transcript, marker, markerTranscript,
    instruction, stills, adjustment, previousHtml } = body || {};

  if (!marker || typeof marker !== 'object') throw new Error('Falta "marker"');
  const durationSec = Number(marker.duration) || 0;
  if (durationSec <= 0) throw new Error('marker.duration debe ser > 0');

  const markerSlug = String(body.markerSlug || '').trim() || slugify(marker.name);
  const stillsList = Array.isArray(stills) ? stills : [];

  const systemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
  let userPrompt = buildUserPrompt({
    objective, transcriptSegments: transcript, marker, markerTranscript,
    instruction, stillsCount: stillsList.length,
  });

  if (mode === 'adjust') {
    userPrompt += [
      '', '## Ajuste sobre una versión previa',
      'Partí del HTML previo y aplicá SOLO el ajuste pedido, conservando lo demás.',
      '', '### Ajuste pedido', (adjustment || '').trim() || '(sin detalle)',
      '', '### HTML previo', '```html', String(previousHtml || '').trim() || '(no recibido)', '```',
      '', 'Devolvé SOLO el HTML completo ajustado.',
    ].join('\n');
  }

  const baseDir = ensureOutputDir(projectPath, sequenceName);
  const version = nextVersion(baseDir, markerSlug);
  const outPaths = paths(baseDir, markerSlug, version);
  saveStills(outPaths.stillsDir, stillsList);

  const config = loadConfig();
  const provider = getProvider(config.provider);
  const rawResponse = await provider.generate({
    systemPrompt, userPrompt, images: stillsList, model: config.model, config,
  });

  const html = stripHtmlFence(rawResponse);
  if (!html) throw new Error(`El proveedor "${config.provider}" devolvió respuesta vacía`);
  fs.writeFileSync(outPaths.html, html, 'utf8');

  await renderComposition({ html, outMovPath: outPaths.mov, durationSec });

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

module.exports = {
  generate: (body) => runGeneration(body, 'generate'),
  feedback: (body) => runGeneration(body, body && body.mode === 'adjust' ? 'adjust' : 'regen'),
  deriveObjective,
  getConfig,
  setConfig: saveConfig,
  loginClaude,
};
