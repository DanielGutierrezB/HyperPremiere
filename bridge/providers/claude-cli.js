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
 * - Si quien llama pasa `onActivity`, se usa `--output-format stream-json` para
 *   ir contando qué hace el modelo mientras trabaja. El resultado se sigue
 *   leyendo del stdout COMPLETO al terminar (el último evento es el mismo
 *   objeto que devolvía `--output-format json`), así que el streaming no puede
 *   romper ni el HTML ni el conteo de tokens: solo agrega el cartel.
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
const agentStream = require('./agent-stream');

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
 * @param {function} [opts.onActivity] - se lo llama con lo que el modelo está
 *   haciendo mientras trabaja (ver agent-stream.js). Si no viene, el CLI corre
 *   con el formato de salida de siempre y no cambia nada.
 * @returns {Promise<string>} HTML de la composicion
 */
async function generate({ systemPrompt, userPrompt, images, model, config, onActivity }) {
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

  // Cómo viaja el prompt. En mac/Linux va como argumento, que es lo probado en
  // producción. En Windows NO PUEDE: con shell (obligatorio para el shim .cmd)
  // la línea entera pasa por cmd.exe, que la corta a los 8191 caracteres — y
  // solo el system prompt ya son 12.500. Ahí el prompt entra por STDIN, que el
  // CLI acepta cuando -p viene sin texto, y el system prompt se antepone al de
  // usuario (lo mismo que hace el proveedor de Cursor).
  const viaStdin = cfg.promptViaStdin !== undefined
    ? !!cfg.promptViaStdin
    : process.platform === 'win32';
  const input = viaStdin
    ? (systemPrompt ? (String(systemPrompt).trim() + '\n\n---\n\n' + prompt) : prompt)
    : undefined;

  // ¿Contamos en vivo lo que el modelo va haciendo? Solo si hay alguien
  // mirando. Sin esto la barra decía "Diseñando la animación…" y no se movía
  // por minutos, y no había forma de distinguir un modelo pensando de uno
  // colgado.
  const live = typeof onActivity === 'function' &&
    !agentStream.envDisabled('HYPERPREMIERE_STREAM');
  // El TEXTO del razonamiento es un flag aparte. Sin él el latido igual existe:
  // el CLI manda su propio contador de tokens de pensamiento.
  const partial = !agentStream.envDisabled('HYPERPREMIERE_STREAM_THINKING');

  // Formato de salida. `stream-json` escribe una línea JSON por evento y el
  // ÚLTIMO es EL MISMO objeto que devuelve `--output-format json` (result,
  // usage y total_cost_usd — verificado contra los dos formatos): mirar el
  // proceso en vivo no cambia ni el HTML que sale ni los tokens que se cuentan.
  // En print mode, stream-json EXIGE --verbose.
  function buildArgs(streaming) {
    const args = streaming
      ? ['-p', '--output-format', 'stream-json', '--verbose']
      : ['-p', '--output-format', 'json'];
    if (streaming && partial) args.push('--include-partial-messages');
    if (model) args.push('--model', model);
    // Nivel de pensamiento. Diseñar una animación es trabajo de razonamiento, así
    // que es la palanca de calidad. Un valor desconocido el CLI solo lo advierte
    // y sigue con el default, no rompe la generación.
    if (cfg.effort) args.push('--effort', String(cfg.effort));
    if (!viaStdin) {
      args.splice(1, 0, prompt); // "-p <prompt>"
      if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
    }
    return args;
  }

  try {
    // Token OAuth de suscripción: desde config (botón "Iniciar sesión") o del entorno.
    const childEnv = Object.assign({}, process.env);
    var oauth = cfg.oauthToken || cfg.apiKey || process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauth) childEnv.CLAUDE_CODE_OAUTH_TOKEN = oauth;

    function attempt(streaming) {
      const reader = streaming
        ? agentStream.createActivityReader('claude', onActivity, { partial })
        : { onData: null };
      // shell solo en Windows (shim .cmd); en mac/Linux args por array sin shell.
      return run(bin, buildArgs(streaming), {
        timeoutMs, env: childEnv, input, shell: process.platform === 'win32',
        onData: reader.onData || undefined,
      });
    }

    let streaming = live;
    let r = await attempt(streaming);
    // Un CLI más viejo que estos flags los rechaza al instante, antes de gastar
    // un token. Ahí se reintenta sin streaming: nadie se queda sin generar por
    // un cartelito, y el reintento no cuesta nada porque el primero no llegó a
    // llamar al modelo.
    if (streaming && r.code !== 0 && !r.timedOut &&
        agentStream.isUnsupportedFlag((r.err || '') + '\n' + (r.out || ''))) {
      streaming = false;
      r = await attempt(false);
    }
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

    // Los dos formatos terminan en el MISMO objeto, así que de acá para abajo
    // no hay dos caminos que mantener.
    let parsed = streaming ? agentStream.finalResult(stdout) : null;
    if (!parsed) {
      try { parsed = JSON.parse(stdout); } catch (e) { parsed = null; }
    }

    let text = '';
    let usage = null;
    if (parsed) {
      if (parsed.is_error) {
        throw new Error('claude-cli: is_error en la respuesta: ' + String(parsed.result || parsed.error || '').slice(0, 300));
      }
      text = typeof parsed.result === 'string' ? parsed.result : '';
      const u = parsed.usage || {};
      usage = makeUsage('claude-cli', model, {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens,
        cacheCreationTokens: u.cache_creation_input_tokens,
        costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
      });
    } else if (streaming) {
      // Salió por stream pero no llegó el evento final. Antes de tirar una
      // generación que ya se pagó, se rearma la respuesta con los mensajes del
      // asistente; lo que se pierde es el conteo de tokens, no el diseño.
      text = agentStream.assistantText(stdout);
      if (!text) throw new Error('claude-cli: la salida en stream no trajo ni resultado ni respuesta');
    } else {
      text = stdout; // CLI viejo sin --output-format json
    }

    const html = stripHtmlFence(text);
    if (!html) throw new Error('claude-cli: la respuesta del CLI vino vacia');
    return { text: html, usage };
  } finally {
    cleanup();
  }
}

module.exports = { generate };
