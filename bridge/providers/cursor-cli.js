'use strict';

/**
 * Proveedor: Cursor Agent CLI en modo headless (suscripción de Cursor).
 *
 * Invoca el binario `cursor-agent` con:
 *   cursor-agent -p <prompt> --output-format json --mode ask --trust
 *                --model <model> --workspace <dir temporal>
 *
 * Por qué existe: permite gastar la suscripción de Cursor en vez de la de
 * Claude cuando esa última llega al tope. Mismo contrato que los demás
 * proveedores, así que la cola y la generación interactiva lo usan sin cambios.
 *
 * Diferencias con el CLI de Claude que condicionan el diseño:
 * - NO tiene --append-system-prompt, así que el system prompt va incrustado al
 *   principio del prompt de usuario.
 * - El nivel de pensamiento no es un flag aparte: viene dentro del ID del
 *   modelo (claude-sonnet-5-thinking-high, -xhigh, -low…), así que el selector
 *   de esfuerzo del panel no aplica acá.
 * - En headless exige --trust. Para que eso sea inofensivo, el workspace que le
 *   damos es SIEMPRE un directorio temporal nuestro (nunca el proyecto del
 *   editor) y corre en --mode ask, que es de solo lectura: puede leer los
 *   stills que le dejamos ahí, pero no escribe archivos ni ejecuta comandos.
 * - El backend a veces responde "[unavailable]" de forma transitoria; ante eso
 *   se reintenta en vez de perder la generación.
 * - No informa costo en dólares (es suscripción), solo tokens.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stripHtmlFence, parseImageDataUrl, makeUsage,
  imageFileName, imagesAsFilesNote } = require('./index');
const { run } = require('../exec');

const DEFAULT_TIMEOUT_MS = 900_000; // 900s: los modelos con thinking se toman su tiempo
const DEFAULT_MODEL = 'claude-sonnet-5-thinking-high';
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 4000;

/**
 * Crea el directorio de trabajo temporal y deja ahí las imágenes de referencia.
 * Ese directorio es también el --workspace del agente: así lo que puede leer
 * queda acotado a lo que nosotros pusimos.
 * Devuelve { dir, names, cleanup } — cleanup borra todo y nunca lanza.
 */
function makeWorkspace(images) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperpremiere-cursor-'));
  const names = [];

  (Array.isArray(images) ? images : [])
    .map(parseImageDataUrl)
    .filter(Boolean)
    .forEach((img, i) => {
      const name = imageFileName(i + 1, img.mediaType);
      fs.writeFileSync(path.join(dir, name), Buffer.from(img.base64, 'base64'));
      names.push(name);
    });

  function cleanup() {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      // Best-effort: un temp dir huerfano no debe romper el flujo.
    }
  }

  return { dir, names, cleanup };
}

/** ¿El fallo es del tipo que conviene reintentar (capacidad momentánea)? */
function isTransient(text) {
  return /\[unavailable\]|rate.?limit|overloaded|temporarily|try again|ECONNRESET|ETIMEDOUT/i
    .test(String(text || ''));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mensaje accionable cuando el CLI no está o no hay sesión. */
function setupHint(bin) {
  return 'cursor-cli: no se pudo ejecutar "' + bin + '".' +
    '\nInstalalo con:  curl https://cursor.com/install -fsS | bash' +
    '\nY autenticá la máquina con:  cursor-agent login' +
    '\n(o poné la variable de entorno CURSOR_API_KEY).';
}

/**
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {string[]} [opts.images] - data URLs de stills
 * @param {string} opts.model
 * @param {object} [opts.config] - { timeoutMs?, cursorBinPath?, apiKey? }
 * @returns {Promise<{text:string, usage:object|null}>} HTML de la composicion
 */
async function generate({ systemPrompt, userPrompt, images, model, config }) {
  const cfg = config || {};
  if (!userPrompt || typeof userPrompt !== 'string') {
    throw new Error('cursor-cli: userPrompt es requerido');
  }

  const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
    ? cfg.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const bin = cfg.cursorBinPath || 'cursor-agent';
  const useModel = model || DEFAULT_MODEL;

  const ws = makeWorkspace(images);

  // Sin --append-system-prompt: el system prompt encabeza el prompt de usuario.
  // Las imágenes se nombran por RUTA ABSOLUTA aunque estén en el directorio de
  // trabajo: las herramientas de búsqueda del agente no indexan este temporal
  // (un glob de "imagen-1.png" vuelve vacío), así que con el nombre suelto se
  // pone a buscar, a veces se rinde y contesta que no encuentra la imagen en vez
  // de componer. Con la ruta entera abre y listo.
  const prompt = (systemPrompt
    ? (String(systemPrompt).trim() + '\n\n---\n\n' + userPrompt)
    : userPrompt) + imagesAsFilesNote(ws.names.map((n) => path.join(ws.dir, n)));

  // En Windows el prompt NO puede ir como argumento: con shell (que el shim
  // .cmd exige) la línea pasa por cmd.exe, que la corta a los 8191 caracteres,
  // y acá el prompt son decenas de miles. Por stdin no hay tope; el CLI lo lee
  // cuando -p viene sin texto.
  const viaStdin = cfg.promptViaStdin !== undefined
    ? !!cfg.promptViaStdin
    : process.platform === 'win32';
  const input = viaStdin ? prompt : undefined;

  const args = [
    '-p',
    '--output-format', 'json',
    '--mode', 'ask',   // solo lectura: que no escriba archivos ni corra comandos
    '--trust',         // headless lo exige; el workspace es nuestro temp, no el proyecto
    '--model', useModel,
    '--workspace', ws.dir,
  ];
  if (!viaStdin) args.splice(1, 0, prompt);

  try {
    const childEnv = Object.assign({}, process.env);
    if (cfg.apiKey) childEnv.CURSOR_API_KEY = cfg.apiKey;

    let lastErr = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const r = await run(bin, args, {
        timeoutMs, env: childEnv, cwd: ws.dir, input,
        shell: process.platform === 'win32',
      });

      if (r.timedOut) throw new Error(`cursor-cli: timeout tras ${timeoutMs}ms`);
      if (r.code === -1) throw new Error(setupHint(bin) + '\nDetalle: ' + r.err);

      const combined = (r.err || '') + '\n' + (r.out || '');
      if (r.code !== 0) {
        lastErr = r.err.trim() || r.out.trim() || '(sin salida)';
        if (isTransient(combined) && attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        if (/not logged in|unauthor|401|no api key/i.test(combined)) {
          throw new Error('cursor-cli: la máquina no tiene sesión de Cursor.' +
            '\nCorré:  cursor-agent login' +
            '\nDetalle: ' + lastErr.slice(0, 300));
        }
        throw new Error(`cursor-cli: salió con código ${r.code}. ${lastErr.slice(0, 400)}`);
      }

      // Con --output-format json, stdout es un objeto con .result y .usage.
      let parsed;
      try {
        parsed = JSON.parse(r.out);
      } catch (e) {
        throw new Error('cursor-cli: la salida no era JSON válido: ' + r.out.slice(0, 300));
      }

      if (parsed && parsed.is_error) {
        const detail = String(parsed.result || parsed.error || '').slice(0, 300);
        if (isTransient(detail) && attempt < MAX_ATTEMPTS) {
          lastErr = detail;
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        throw new Error('cursor-cli: el agente devolvió error: ' + detail);
      }

      const text = typeof parsed.result === 'string' ? parsed.result : '';
      const u = (parsed && parsed.usage) ? parsed.usage : {};
      const usage = makeUsage('cursor-cli', useModel, {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheCreationTokens: u.cacheWriteTokens,
        costUsd: null, // suscripción: no hay costo por llamada
      });

      const html = stripHtmlFence(text);
      if (!html) {
        if (attempt < MAX_ATTEMPTS) { lastErr = 'respuesta vacía'; await sleep(RETRY_DELAY_MS); continue; }
        throw new Error('cursor-cli: la respuesta vino vacía');
      }
      return { text: html, usage };
    }

    throw new Error('cursor-cli: falló tras ' + MAX_ATTEMPTS + ' intentos. Último error: ' + lastErr.slice(0, 300));
  } finally {
    ws.cleanup();
  }
}

// Cursor ofrece ~193 modelos: inusable en un desplegable, y la mayoría no sirve
// para diseñar animaciones. Se filtra con el mismo criterio que ya se aplica a
// Haiku en el proveedor de Claude: afuera lo que no da buenos diseños.
//
// Familias vigentes, en el orden en que conviene ofrecerlas.
const MODEL_FAMILIES = [
  'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5',
  'composer-2.5', 'cursor-grok-4.5', 'gpt-5.3-codex', 'kimi-k3', 'gemini-3.1-pro',
];

// Orden de los niveles de razonamiento dentro de cada familia.
const EFFORT_ORDER = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

function familyOf(id) {
  for (let i = 0; i < MODEL_FAMILIES.length; i++) {
    const f = MODEL_FAMILIES[i];
    if (id === f || id.indexOf(f + '-') === 0) return f;
  }
  return null;
}

function rankOf(id, family) {
  const rest = id.slice(family.length).replace(/^-/, '').replace(/^thinking-?/, '');
  const idx = EFFORT_ORDER.indexOf(rest);
  return idx === -1 ? EFFORT_ORDER.length : idx;
}

function isUsableModel(id) {
  // Variantes "-fast": pagan prioridad con más consumo. Como el objetivo de usar
  // Cursor es justamente estirar el cupo, no tiene sentido ofrecerlas.
  if (/-fast$/.test(id)) return false;
  // "-none" apaga el razonamiento: para diseñar una animación es la herramienta
  // equivocada. mini/nano/flash son la gama chica (el equivalente a Haiku).
  if (/-none$/.test(id)) return false;
  if (/-(mini|nano)\b|flash/.test(id)) return false;
  return familyOf(id) !== null;
}

function curateModels(models) {
  const auto = models.filter((m) => m.id === 'auto');
  const usable = models.filter((m) => isUsableModel(m.id));
  usable.sort((a, b) => {
    const fa = familyOf(a.id);
    const fb = familyOf(b.id);
    const d = MODEL_FAMILIES.indexOf(fa) - MODEL_FAMILIES.indexOf(fb);
    if (d !== 0) return d;
    return rankOf(a.id, fa) - rankOf(b.id, fb);
  });
  return auto.concat(usable);
}

/**
 * Modelos que la cuenta de Cursor tiene DE VERDAD (`cursor-agent --list-models`),
 * ya curados y ordenados.
 * Devuelve { ok, models: [{ id, name }] } y no lanza: si falla, el panel se
 * queda con su lista de respaldo.
 */
async function listModels(config) {
  const cfg = config || {};
  const bin = cfg.cursorBinPath || 'cursor-agent';
  try {
    const childEnv = Object.assign({}, process.env);
    if (cfg.apiKey) childEnv.CURSOR_API_KEY = cfg.apiKey;
    // 60s y no 30: el listado normalmente tarda ~1s pero se lo vio irse a 30s.
    const r = await run(bin, ['--list-models'], { timeoutMs: 60_000, env: childEnv, shell: process.platform === 'win32' });
    if (r.code !== 0) return { ok: false, error: (r.err || r.out || '').trim().slice(0, 300) };

    // Formato de cada línea: "<id> - <nombre para mostrar>".
    const models = [];
    String(r.out || '').split('\n').forEach((line) => {
      const m = line.match(/^\s*([a-z0-9][a-z0-9._-]*)\s+-\s+(.+?)\s*$/i);
      if (m) models.push({ id: m[1], name: m[2] });
    });
    if (!models.length) return { ok: false, error: 'no pude leer la lista de modelos' };
    const curated = curateModels(models);
    // Si el filtro no reconoce nada (Cursor renombró todo), es mejor mostrar la
    // lista completa que dejar el selector vacío.
    return { ok: true, models: curated.length > 1 ? curated : models };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

module.exports = { generate, listModels, DEFAULT_MODEL };
