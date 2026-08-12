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
 * - exit code != 0 => rechaza con un Error que dice POR QUÉ. El motivo puede
 *   venir por stderr o por stdout: corriendo con --output-format json el CLI
 *   escribe sus errores en stdout, adentro del JSON, y deja stderr vacío (ver
 *   errorDeSalida más abajo).
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
const cliErrors = require('./cli-errors');
const doctor = require('../claude-doctor');

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
 * El mensaje que ve el editor cuando la corrida se cae.
 *
 * Antes decía "salio con codigo 1. stderr: (vacio)" y ahí terminaba: miraba
 * SOLO stderr y descartaba stdout, que es justo donde el CLI escribe el motivo
 * cuando corre con --output-format json. El motivo llegaba y lo tirábamos.
 *
 * Ahora se mira todo lo que escribió, se saca la frase de adentro del JSON (que
 * el editor no puede leer crudo) y, si el modo de falla es de los conocidos, se
 * dice con nombre propio y con el próximo paso.
 *
 * @param {string} generico - la cabecera para cuando no reconocemos la causa
 * @param {{out?:string, err?:string}} r - lo que devolvió run()
 * @param {string} bin
 * @param {string} model
 * @returns {string}
 */
function errorDeSalida(generico, r, bin, model) {
  const detalle = cliErrors.deProceso(r);
  const dijo = detalle
    ? '\nLo que dijo el CLI: ' + detalle
    : '\nEl CLI no escribió nada, ni por stdout ni por stderr.';
  // Para ponerle nombre a la falla se miran stderr, la FRASE ya extraída y las
  // etiquetas del CLI — no el stdout entero: con el estado en vivo ahí adentro
  // está también todo lo que escribió el modelo, y una composición que hable de
  // "permisos" no tiene por qué disfrazarse de un problema de permisos.
  const pistas = String((r && r.err) || '') + '\n' + detalle +
    '\n' + cliErrors.etiquetas((r && r.out) || '');

  switch (cliErrors.causa(pistas)) {
    case 'sesion':
      // La hipótesis número uno cuando esto pasa en la máquina de otro: el CLI
      // está y corre, pero nunca terminó de loguearse, así que falla en el acto.
      return 'claude-cli: esta máquina no tiene sesión de Claude. El CLI arrancó, no encontró\n' +
        'con qué autenticarse y cerró en el acto.\n' +
        doctor.tokenAMano('Qué hacer:') + dijo;
    case 'cuota':
      return 'claude-cli: tu cuenta de Claude se quedó sin cupo (o te frenó el límite de uso).\n' +
        'Qué hacer: esperá a que se renueve, o cambiá de proveedor en Configuración\n' +
        '(Cursor, o la API de Anthropic) para seguir generando mientras tanto.' + dijo;
    case 'modelo':
      return 'claude-cli: el CLI no reconoce el modelo "' + (model || 'sin especificar') + '".\n' +
        'Qué hacer: elegí otro modelo en Configuración — el nombre puede haber cambiado\n' +
        'o no estar habilitado para tu cuenta.' + dijo;
    case 'permisos':
      return 'claude-cli: el sistema no lo dejó hacer lo que necesitaba (permisos).\n' +
        'Qué hacer: revisá que "' + bin + '" tenga permiso de ejecución y que el antivirus\n' +
        'no lo esté bloqueando.' + dijo;
    default:
      return generico + dijo;
  }
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
      throw new Error(`claude-cli: no se pudo ejecutar "${bin}": ` +
        (cliErrors.deProceso(r) || 'el sistema no dijo por qué'));
    }
    if (r.code !== 0) {
      throw new Error(errorDeSalida(`claude-cli: salió con código ${r.code}.`, r, bin, model));
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
    let warning = '';
    if (parsed) {
      if (parsed.is_error) {
        // El CLI también puede cerrar con código 0 y el error adentro del JSON.
        // Para el editor es el mismo problema, así que lleva el mismo trato: la
        // frase legible y, si la reconocemos, la causa con su próximo paso.
        throw new Error(errorDeSalida('claude-cli: el CLI devolvió un error.',
          { err: '', out: JSON.stringify(parsed) }, bin, model));
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
    } else if (!streaming) {
      text = stdout; // CLI viejo sin --output-format json
    }

    // Red de abajo, que SOLO existe con el stream: el CLI puede cerrar con el
    // resultado vacío cuando la corrida dio más de una vuelta y la última
    // terminó sin texto (visto una vez en pruebas, con la composición ya
    // escrita en una vuelta anterior). Con `--output-format json` eso perdía
    // una generación entera ya pagada, porque no quedaba nada que mirar; acá
    // los mensajes del asistente están todos y se puede rescatar el diseño.
    if (!text.trim() && streaming) {
      text = agentStream.assistantText(stdout);
      if (!text.trim()) throw new Error('claude-cli: el CLI terminó sin ninguna respuesta del modelo');
      // Con `usage` cargado el cierre SÍ llegó (vino vacío, pero con sus
      // tokens): no es lo mismo que quedarse sin ningún cierre, y el aviso lo
      // distingue para que el conteo del recurso no quede bajo sospecha.
      warning = agentStream.rescueWarning(!!usage);
    }

    const html = stripHtmlFence(text);
    if (!html) throw new Error('claude-cli: la respuesta del CLI vino vacia');
    return { text: html, usage, warning };
  } finally {
    cleanup();
  }
}

module.exports = { generate };
