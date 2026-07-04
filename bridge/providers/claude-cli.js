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

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stripHtmlFence, parseImageDataUrl, makeUsage } = require('./index');

const DEFAULT_TIMEOUT_MS = 600_000; // 600s (el CLI lee stills con herramientas y se demora)

/** Extension de archivo segun media type; png como fallback razonable. */
function extForMediaType(mediaType) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  };
  return map[mediaType] || '.png';
}

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
      const file = path.join(dir, `still-${i + 1}${extForMediaType(img.mediaType)}`);
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

  // Si hay stills, se referencian por ruta en el prompt (ver TODO arriba).
  let prompt = userPrompt;
  if (imagePaths.length > 0) {
    prompt +=
      '\n\nStills de referencia (leelos desde disco antes de componer):\n' +
      imagePaths.map((p) => `- ${p}`).join('\n');
  }

  // --output-format json => stdout es un objeto JSON con .result (texto) y
  // .usage (tokens) + .total_cost_usd. Así podemos contar el gasto real.
  const args = ['-p', prompt, '--output-format', 'json'];
  if (model) args.push('--model', model);
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);

  try {
    // Token OAuth de suscripción: desde config (botón "Iniciar sesión") o del entorno.
    const childEnv = Object.assign({}, process.env);
    var oauth = cfg.oauthToken || cfg.apiKey || process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauth) childEnv.CLAUDE_CODE_OAUTH_TOKEN = oauth;

    const stdout = await new Promise((resolve, reject) => {
      // shell: false (default) + args por array => sin interpretacion de shell.
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });

      let out = '';
      let err = '';
      let settled = false;

      const timer = setTimeout(() => {
        finish(new Error(`claude-cli: timeout tras ${timeoutMs}ms`));
        child.kill('SIGKILL');
      }, timeoutMs);

      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      }

      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });

      // 'error' cubre binario inexistente / sin permisos.
      child.on('error', (e) => {
        finish(new Error(`claude-cli: no se pudo ejecutar "${bin}": ${e.message}`));
      });

      child.on('close', (code) => {
        if (code !== 0) {
          finish(new Error(
            `claude-cli: salio con codigo ${code}. stderr: ${err.trim() || '(vacio)'}`
          ));
        } else {
          finish(null, out);
        }
      });
    });

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
