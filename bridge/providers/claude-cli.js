'use strict';

/**
 * Proveedor: Claude Code CLI en modo headless.
 *
 * Invoca el binario `claude` con:
 *   claude -p <userPrompt> --model <model> --append-system-prompt <systemPrompt>
 *
 * Notas:
 * - spawn SIN shell y con args por array: el prompt y el system prompt pueden
 *   contener comillas, backticks, etc., y asi no hay riesgo de inyeccion.
 * - stdout completo es la respuesta del modelo.
 * - exit code != 0 => rechaza con Error que incluye stderr.
 *
 * TODO(imagenes): el CLI de claude en modo headless (-p) no acepta imagenes
 * inline de forma sencilla. Como workaround, los stills se guardan en archivos
 * temporales y se mencionan por ruta absoluta dentro del prompt para que el
 * agente los lea con sus propias herramientas. Cuando el CLI soporte adjuntar
 * imagenes directamente en headless, migrar a ese mecanismo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stripHtmlFence, parseImageDataUrl, makeUsage,
  imageFileName, imagesAsFilesNote } = require('./index');
const { run } = require('../exec');

const DEFAULT_TIMEOUT_MS = 600_000; // 600s (el CLI lee stills con herramientas y se demora)

/**
 * Guarda los data URLs como archivos temporales.
 * Devuelve { paths, cleanup } — cleanup borra todo y nunca lanza.
 */
function writeTempImages(images) {
  const paths = [];
  let dir = null;

  const valid = (Array.isArray(images) ? images : [])
    .map(parseImageDataUrl)
    .filter(Boolean);

  if (valid.length > 0) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperpremiere-stills-'));
    valid.forEach((img, i) => {
      const file = path.join(dir, imageFileName(i + 1, img.mediaType));
      fs.writeFileSync(file, Buffer.from(img.base64, 'base64'));
      paths.push(file);
    });
  }

  function cleanup() {
    if (!dir) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      // Best-effort: un temp file huerfano no debe romper el flujo.
    }
  }

  return { paths, cleanup };
}

/**
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {string[]} [opts.images] - data URLs de stills
 * @param {string} opts.model
 * @param {object} [opts.config] - { timeoutMs?, binPath? }
 * @returns {Promise<string>} HTML de la composicion
 */
async function generate({ systemPrompt, userPrompt, images, model, config }) {
  const cfg = config || {};
  if (!userPrompt || typeof userPrompt !== 'string') {
    throw new Error('claude-cli: userPrompt es requerido');
  }

  const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
    ? cfg.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const bin = cfg.binPath || 'claude';

  const { paths: imagePaths, cleanup } = writeTempImages(images);

  // Las imágenes se referencian por ruta absoluta (ver TODO arriba): acá el
  // directorio de trabajo no es el nuestro, así que el nombre suelto no alcanza.
  const prompt = userPrompt + imagesAsFilesNote(imagePaths);

  // --output-format json => stdout es un objeto JSON con .result (texto) y
  // .usage (tokens) + .total_cost_usd. Así podemos contar el gasto real.
  const args = ['-p', '--output-format', 'json'];
  if (model) args.push('--model', model);
  // Nivel de pensamiento. Diseñar una animación es trabajo de razonamiento, así
  // que es la palanca de calidad. Un valor desconocido el CLI solo lo advierte
  // y sigue con el default, no rompe la generación.
  if (cfg.effort) args.push('--effort', String(cfg.effort));

  // Cómo viaja el prompt. En mac/Linux va como argumento, que es lo probado en
  // producción. En Windows NO PUEDE: con shell (obligatorio para el shim .cmd)
  // la línea entera pasa por cmd.exe, que la corta a los 8191 caracteres — y
  // solo el system prompt ya son 12.500. Ahí el prompt entra por STDIN, que el
  // CLI acepta cuando -p viene sin texto, y el system prompt se antepone al de
  // usuario (lo mismo que hace el proveedor de Cursor).
  const viaStdin = cfg.promptViaStdin !== undefined
    ? !!cfg.promptViaStdin
    : process.platform === 'win32';
  let input;
  if (viaStdin) {
    input = systemPrompt ? (String(systemPrompt).trim() + '\n\n---\n\n' + prompt) : prompt;
  } else {
    args.splice(1, 0, prompt); // "-p <prompt>"
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  }

  try {
    // Token OAuth de suscripción: desde config (botón "Iniciar sesión") o del entorno.
    const childEnv = Object.assign({}, process.env);
    var oauth = cfg.oauthToken || cfg.apiKey || process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauth) childEnv.CLAUDE_CODE_OAUTH_TOKEN = oauth;

    // shell solo en Windows (shim .cmd); en mac/Linux args por array sin shell.
    const r = await run(bin, args, {
      timeoutMs, env: childEnv, input, shell: process.platform === 'win32',
    });
    if (r.timedOut) {
      throw new Error(`claude-cli: timeout tras ${timeoutMs}ms`);
    }
    if (r.code === -1) {
      // Cubre binario inexistente / sin permisos.
      throw new Error(`claude-cli: no se pudo ejecutar "${bin}": ${r.err}`);
    }
    if (r.code !== 0) {
      throw new Error(`claude-cli: salio con codigo ${r.code}. stderr: ${r.err.trim() || '(vacio)'}`);
    }
    const stdout = r.out;

    // Con --output-format json, stdout es un objeto JSON. Fallback: si un CLI
    // viejo devolvió texto crudo, lo tratamos como HTML sin usage.
    let text = '';
    let usage = null;
    try {
      const parsed = JSON.parse(stdout);
      if (parsed && parsed.is_error) {
        throw new Error('claude-cli: is_error en la respuesta: ' + String(parsed.result || parsed.error || '').slice(0, 300));
      }
      text = typeof parsed.result === 'string' ? parsed.result : '';
      const u = parsed && parsed.usage ? parsed.usage : {};
      usage = makeUsage('claude-cli', model, {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens,
        cacheCreationTokens: u.cache_creation_input_tokens,
        costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
      });
    } catch (e) {
      if (e instanceof SyntaxError) {
        text = stdout; // CLI viejo sin --output-format json
        usage = null;
      } else {
        throw e;
      }
    }

    const html = stripHtmlFence(text);
    if (!html) throw new Error('claude-cli: la respuesta del CLI vino vacia');
    return { text: html, usage };
  } finally {
    cleanup();
  }
}

module.exports = { generate };
