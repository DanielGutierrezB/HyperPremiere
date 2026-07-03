// Servidor HTTP local del puente HyperPremiere.
//
// Recibe el contexto que junta el panel CEP (objetivo, transcript, marcador,
// instrucción, stills), arma el prompt, llama al proveedor de modelo
// configurado y renderiza la composición HTML resultante a un .mov con alpha.
//
// Corre solo en loopback (127.0.0.1); el puerto se puede cambiar con HP_PORT.

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getProvider, stripHtmlFence } = require('./providers');
const { buildUserPrompt } = require('./prompt/build-context');
const { buildObjectivePrompt } = require('./prompt/objective');
const { renderComposition } = require('./render/hyperframes');
const {
  ensureOutputDir,
  paths,
  nextVersion,
  saveMeta,
  readMeta,
  saveStills,
  slugify,
} = require('./store/project-fs');

const HOST = '127.0.0.1';
const PORT = Number(process.env.HP_PORT) || 7867;

// Los stills viajan como data URLs base64 dentro del JSON, así que el body
// puede ser grande. Límite generoso pero acotado para no comer la RAM.
const MAX_BODY_BYTES = 256 * 1024 * 1024;

const SYSTEM_PROMPT_PATH = path.join(__dirname, 'prompt', 'system.md');

// ---------------------------------------------------------------------------
// Configuración del proveedor (~/.hyperpremiere/config.json)
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.join(os.homedir(), '.hyperpremiere');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// El modelo por defecto es solo un punto de partida: el usuario elige el
// modelo runtime desde el panel (POST /config).
const DEFAULT_CONFIG = {
  provider: 'claude-cli',
  model: 'claude-opus-4-8',
  apiKey: '',
  baseUrl: '',
};

function loadConfig() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {
    // sin archivo o corrupto: arrancamos con defaults
  }
  return { ...DEFAULT_CONFIG, ...stored };
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Copia de la config apta para devolver por HTTP: nunca expone la apiKey
 * completa, solo una máscara con los últimos 4 caracteres.
 */
function maskConfig(config) {
  const masked = { ...config };
  const key = String(config.apiKey || '');
  masked.apiKey = key ? `••••${key.slice(-4)}` : '';
  return masked;
}

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Lee y parsea el body JSON de un request. Rechaza si excede MAX_BODY_BYTES
 * o si no es JSON válido.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Body demasiado grande (límite ${MAX_BODY_BYTES} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Body JSON inválido: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Generación (compartida entre /generate y /feedback)
// ---------------------------------------------------------------------------

/**
 * Flujo completo: prompt -> proveedor -> HTML -> render -> meta.
 *
 * @param {object} body  Payload del request (ver endpoints).
 * @param {object} opts
 * @param {'generate'|'adjust'|'regen'} opts.mode
 * @returns {{ movPath, htmlPath, version, markerSlug }}
 */
async function runGeneration(body, { mode }) {
  const {
    projectPath,
    sequenceName,
    objective,
    transcript,
    marker,
    markerTranscript,
    instruction,
    stills,
    adjustment,
    previousHtml,
  } = body || {};

  if (!marker || typeof marker !== 'object') {
    throw new Error('Falta "marker" en el body');
  }
  const durationSec = Number(marker.duration) || 0;
  if (durationSec <= 0) {
    throw new Error('marker.duration debe ser un número > 0');
  }

  const markerSlug = String(body.markerSlug || '').trim() || slugify(marker.name);
  const stillsList = Array.isArray(stills) ? stills : [];

  // Prompts
  const systemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
  let userPrompt = buildUserPrompt({
    objective,
    transcriptSegments: transcript,
    marker,
    markerTranscript,
    instruction,
    stillsCount: stillsList.length,
  });

  // En modo "adjust" el pedido es un diff incremental: se adjunta el HTML
  // previo y se pide modificar SOLO lo indicado. En "regen" se genera de cero.
  if (mode === 'adjust') {
    userPrompt += [
      '',
      '## Ajuste sobre una versión previa',
      'Ya existe una composición generada. NO la rehagas desde cero: partí del',
      'HTML previo y aplicá únicamente el ajuste pedido, conservando todo lo demás.',
      '',
      '### Ajuste pedido',
      (adjustment || '').trim() || '(sin detalle de ajuste)',
      '',
      '### HTML previo',
      '```html',
      String(previousHtml || '').trim() || '(no se recibió el HTML previo)',
      '```',
      '',
      'Devolvé SOLO el HTML completo de la composición ajustada.',
    ].join('\n');
  }

  // Filesystem de salida
  const baseDir = ensureOutputDir(projectPath, sequenceName);
  const version = nextVersion(baseDir, markerSlug);
  const outPaths = paths(baseDir, markerSlug, version);

  saveStills(outPaths.stillsDir, stillsList);

  // Proveedor de modelo
  const config = loadConfig();
  const provider = getProvider(config.provider);
  const rawResponse = await provider.generate({
    systemPrompt,
    userPrompt,
    images: stillsList,
    model: config.model,
    config,
  });

  // stripHtmlFence es idempotente: red de seguridad por si el proveedor
  // devolvió el HTML envuelto en fences de markdown.
  const html = stripHtmlFence(rawResponse);
  if (!html) {
    throw new Error(`El proveedor "${config.provider}" devolvió una respuesta vacía`);
  }
  fs.writeFileSync(outPaths.html, html, 'utf8');

  // Render a ProRes 4444 con alpha
  await renderComposition({
    html,
    outMovPath: outPaths.mov,
    durationSec,
  });

  // Metadata: arrastramos la historia de la versión anterior (si existe)
  // y le agregamos la entrada de esta generación.
  let history = [];
  if (version > 1) {
    const prevMeta = readMeta(paths(baseDir, markerSlug, version - 1).meta);
    if (prevMeta) {
      history = Array.isArray(prevMeta.history) ? prevMeta.history.slice() : [];
      history.push({
        version: prevMeta.version,
        instruction: prevMeta.instruction,
        createdAt: prevMeta.createdAt,
      });
    }
  }

  saveMeta(outPaths.meta, {
    instruction,
    marker,
    version,
    model: config.model,
    provider: config.provider,
    mode,
    adjustment: mode === 'adjust' ? adjustment : undefined,
    createdAt: new Date(Date.now()).toISOString(),
    history,
  });

  return {
    movPath: outPaths.mov,
    htmlPath: outPaths.html,
    version,
    markerSlug,
  };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

async function handleHealth(req, res) {
  const config = loadConfig();
  sendJson(res, 200, { ok: true, provider: config.provider, model: config.model });
}

async function handleGetConfig(req, res) {
  sendJson(res, 200, maskConfig(loadConfig()));
}

async function handlePostConfig(req, res) {
  const body = await readJsonBody(req);
  const current = loadConfig();

  // Merge superficial: solo pisamos las claves conocidas que vengan definidas.
  const next = { ...current };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (body[key] !== undefined && body[key] !== null) {
      const val = String(body[key]);
      // provider y model son obligatorios: no permitir que un vacío los pise.
      if ((key === 'model' || key === 'provider') && !val.trim()) continue;
      next[key] = val;
    }
  }
  // Red de seguridad: si el modelo quedó vacío, usar el default.
  if (!next.model || !String(next.model).trim()) next.model = DEFAULT_CONFIG.model;
  // Una apiKey enmascarada reenviada por el panel no debe pisar la real.
  if (typeof next.apiKey === 'string' && next.apiKey.startsWith('••••')) {
    next.apiKey = current.apiKey;
  }

  saveConfig(next);
  sendJson(res, 200, maskConfig(next));
}

async function handleGenerate(req, res) {
  const body = await readJsonBody(req);
  const result = await runGeneration(body, { mode: 'generate' });
  sendJson(res, 200, { ok: true, ...result });
}

async function handleFeedback(req, res) {
  const body = await readJsonBody(req);
  const mode = body.mode === 'adjust' ? 'adjust' : 'regen';
  const result = await runGeneration(body, { mode });
  sendJson(res, 200, { ok: true, ...result });
}

async function handleDeriveObjective(req, res) {
  try {
    const body = await readJsonBody(req);

    // Acepta el transcript como texto plano o como lista de segmentos.
    const transcriptText =
      typeof body.transcriptText === 'string' && body.transcriptText.trim()
        ? body.transcriptText
        : (Array.isArray(body.transcript) ? body.transcript : [])
            .map((seg) => ((seg && seg.text) || '').trim())
            .filter(Boolean)
            .join(' ');

    const { system, user } = buildObjectivePrompt(transcriptText);

    const config = loadConfig();
    const provider = getProvider(config.provider);
    const rawResponse = await provider.generate({
      systemPrompt: system,
      userPrompt: user,
      images: [],
      model: config.model,
      config,
    });

    sendJson(res, 200, { ok: true, objective: String(rawResponse || '').trim() });
  } catch (err) {
    const message = (err && err.message) || String(err);
    sendJson(res, 500, { ok: false, error: message });
  }
}

// Inicia sesión en Claude corriendo `claude setup-token`. Abre el navegador para
// que el usuario autorice; captura el token sk-ant-oat... y lo guarda en config.
// Así el usuario no tiene que pegar ningún token a mano.
async function handleLoginClaude(req, res) {
  try {
    const { spawn } = require('child_process');
    const token = await new Promise((resolve, reject) => {
      const child = spawn('claude', ['setup-token'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('login: timeout (5 min). ¿Completaste la autorización en el navegador?'));
      }, 300_000);
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      child.on('error', (e) => { clearTimeout(timer); reject(new Error('no se pudo ejecutar claude: ' + e.message)); });
      child.on('close', () => {
        clearTimeout(timer);
        const m = (out + '\n' + err).match(/sk-ant-oat[0-9]+-[A-Za-z0-9_-]+/);
        if (m) resolve(m[0]);
        else reject(new Error('login: no se encontró el token en la salida. ' + (err.trim() || out.trim()).slice(0, 300)));
      });
    });

    const config = loadConfig();
    config.oauthToken = token;
    config.provider = 'claude-cli';
    saveConfig(config);
    sendJson(res, 200, { ok: true, provider: 'claude-cli' });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: (err && err.message) || String(err) });
  }
}

// ---------------------------------------------------------------------------
// Router + servidor
// ---------------------------------------------------------------------------

const ROUTES = {
  'GET /health': handleHealth,
  'GET /config': handleGetConfig,
  'POST /config': handlePostConfig,
  'POST /generate': handleGenerate,
  'POST /feedback': handleFeedback,
  'POST /derive-objective': handleDeriveObjective,
  'POST /login-claude': handleLoginClaude,
};

const server = http.createServer(async (req, res) => {
  applyCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const pathname = (req.url || '/').split('?')[0];
  const handler = ROUTES[`${req.method} ${pathname}`];

  if (!handler) {
    sendJson(res, 404, { ok: false, error: `Ruta desconocida: ${req.method} ${pathname}` });
    return;
  }

  try {
    await handler(req, res);
  } catch (err) {
    const message = (err && err.message) || String(err);
    console.error(`[hyperpremiere] ${req.method} ${pathname} falló:`, message);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: message });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[hyperpremiere] puente escuchando en http://${HOST}:${PORT}`);
});
