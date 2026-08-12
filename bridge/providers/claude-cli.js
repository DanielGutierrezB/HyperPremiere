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
 *
 * Y como esos archivos NO están en el directorio de trabajo del CLI, hay que
 * declararle la carpeta con --add-dir: sin eso el CLI contesta "ask" a la
 * lectura ("Path is outside allowed working directories") y en headless no hay
 * a quién preguntarle, así que la deniega y el modelo diseña sin ver el cuadro.
 * Ver `dirsPermitidos`.
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
 * Devuelve { paths, dir, cleanup } — cleanup borra todo y nunca lanza.
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

  return { paths, dir, cleanup };
}

/**
 * Deja el system prompt en un archivo temporal.
 *
 * Por qué un archivo y no el texto: en Windows el prompt de usuario viaja por
 * stdin (cmd.exe corta la línea de comandos a 8191 caracteres) y stdin es UNO
 * SOLO, así que ahí no entra también el system prompt sin dejar de ser un
 * system prompt. Con `--append-system-prompt-file` lo que viaja por la línea de
 * comandos es la RUTA —un puñado de bytes— y el CLI lee el texto del disco.
 *
 * Devuelve { file, cleanup } — cleanup borra todo y nunca lanza.
 */
function writeTempSystemPrompt(systemPrompt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperpremiere-sys-'));
  const file = path.join(dir, 'system-prompt.md');
  fs.writeFileSync(file, systemPrompt, 'utf8');
  return {
    file,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {
        // Best-effort: un temp file huerfano no debe romper el flujo.
      }
    },
  };
}

/**
 * Carpetas que el CLI tiene que poder leer sin preguntar.
 *
 * El prompt le dice al modelo "abrí tal archivo" con la ruta absoluta, pero el
 * permiso no viene con la ruta: el CLI solo lee de entrada dentro de sus
 * "allowed working directories", que salen del directorio de trabajo del
 * proceso más lo que se declare con --add-dir. Nosotros nunca fijamos el
 * directorio de trabajo: el CLI hereda el de Premiere, que no es el mismo en
 * las dos plataformas. En mac ese directorio es la raíz y el temporal
 * (/var/folders/...) cuelga de ahí, así que la lectura salía bien de casualidad;
 * en Windows el temporal está en C:\Users\...\AppData\Local\Temp y el proyecto
 * puede estar en otra unidad entera (E:\), y no cuelgan de ningún lado.
 *
 * Se filtra lo que no es una carpeta que existe (el disco del proyecto puede
 * estar desmontado). Comprobado contra el CLI: una ruta inexistente la ignora
 * en silencio, pero una que existe y NO es carpeta le hace escribir "X is not a
 * directory" por stderr — y stderr es justo lo que el panel le muestra al editor
 * cuando algo falla. No vale la pena ensuciarlo con un aviso nuestro.
 *
 * @param {string[]} dirs
 * @returns {string[]} sin repetidos y sin las que no son carpetas existentes
 */
function dirsPermitidos(dirs) {
  const out = [];
  (Array.isArray(dirs) ? dirs : []).forEach((d) => {
    if (!d || typeof d !== 'string') return;
    if (out.indexOf(d) !== -1) return;
    try { if (!fs.statSync(d).isDirectory()) return; } catch (_) { return; }
    out.push(d);
  });
  return out;
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

  const { paths: imagePaths, dir: imagesDir, cleanup } = writeTempImages(images);

  // Las imágenes se referencian por ruta absoluta (ver TODO arriba): acá el
  // directorio de trabajo no es el nuestro, así que el nombre suelto no alcanza.
  const prompt = userPrompt + imagesAsFilesNote(imagePaths);

  // El texto del system prompt es el MISMO en las dos plataformas, hasta el
  // último byte: se recorta una sola vez acá y de ahí sale para los dos caminos.
  const system = String(systemPrompt || '').trim();

  // Carpetas cuyo contenido el prompt manda abrir: el temporal de las imágenes
  // de referencia, más lo que agregue quien llama (los recursos que subió el
  // editor viven al lado de la render, en el disco del proyecto).
  const addDirs = dirsPermitidos([imagesDir].concat(cfg.readDirs || []));

  // Cómo viaja el prompt. En mac/Linux va como argumento, que es lo probado en
  // producción. En Windows NO PUEDE: con shell (obligatorio para el shim .cmd)
  // la línea entera pasa por cmd.exe, que la corta a los 8191 caracteres — y
  // solo el system prompt ya son 12.500. Ahí el prompt de USUARIO entra por
  // STDIN, que el CLI acepta cuando -p viene sin texto.
  const viaStdin = cfg.promptViaStdin !== undefined
    ? !!cfg.promptViaStdin
    : process.platform === 'win32';

  // El system prompt NO se mete en stdin junto al de usuario. Eso se hacía
  // antes y era la diferencia grande entre plataformas: en mac viajaba por
  // --append-system-prompt (system prompt de verdad) y en Windows terminaba
  // siendo el arranque de un mensaje de usuario de decenas de miles de
  // caracteres, con un "---" en el medio. Las instrucciones seguían estando,
  // pero no donde se obedecen: en la máquina Windows del editor, dos de tres
  // marcadores volvieron sin el `<div id="stage">` que la plantilla obligatoria
  // exige, contra 21 de 21 cumpliendo en mac. Ahora va a un archivo temporal y
  // por la línea de comandos viaja solo la ruta, que sí entra en el tope.
  const sysFile = (viaStdin && system) ? writeTempSystemPrompt(system) : null;

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
  //
  // `viejo` es el plan B para un CLI anterior a --append-system-prompt-file
  // (existe desde claude 2.1.x) o a --add-dir: se arma la llamada como antes,
  // con el system prompt pegado al mensaje de usuario. Es peor, pero genera.
  function buildArgs(streaming, viejo) {
    const args = streaming
      ? ['-p', '--output-format', 'stream-json', '--verbose']
      : ['-p', '--output-format', 'json'];
    if (streaming && partial) args.push('--include-partial-messages');
    if (model) args.push('--model', model);
    // Nivel de pensamiento. Diseñar una animación es trabajo de razonamiento, así
    // que es la palanca de calidad. Un valor desconocido el CLI solo lo advierte
    // y sigue con el default, no rompe la generación.
    if (cfg.effort) args.push('--effort', String(cfg.effort));
    // OJO con el orden: --add-dir es VARIÁDICO ("--add-dir <directories...>"),
    // así que se come todo lo que le siga hasta el próximo flag. Comprobado
    // contra el CLI: `--add-dir /tmp hola` se traga "hola" y el CLI corta con
    // "Input must be provided...". Por eso el prompt de usuario va SIEMPRE
    // pegado a -p (posición 1), antes que cualquier --add-dir.
    if (!viejo) addDirs.forEach((d) => args.push('--add-dir', d));
    if (!viaStdin) {
      args.splice(1, 0, prompt); // "-p <prompt>"
      if (system) args.push('--append-system-prompt', system);
    } else if (sysFile && !viejo) {
      args.push('--append-system-prompt-file', sysFile.file);
    }
    return args;
  }

  /** Lo que se le escribe por STDIN en cada variante de llamada. */
  function buildInput(viejo) {
    if (!viaStdin) return undefined;
    if (sysFile && !viejo) return prompt;
    return system ? (system + '\n\n---\n\n' + prompt) : prompt;
  }

  try {
    // Token OAuth de suscripción: desde config (botón "Iniciar sesión") o del entorno.
    const childEnv = Object.assign({}, process.env);
    var oauth = cfg.oauthToken || cfg.apiKey || process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauth) childEnv.CLAUDE_CODE_OAUTH_TOKEN = oauth;

    function attempt(streaming, viejo) {
      const reader = streaming
        ? agentStream.createActivityReader('claude', onActivity, { partial })
        : { onData: null };
      // shell solo en Windows (shim .cmd); en mac/Linux args por array sin shell.
      return run(bin, buildArgs(streaming, viejo), {
        timeoutMs, env: childEnv, input: buildInput(viejo),
        shell: process.platform === 'win32',
        onData: reader.onData || undefined,
      });
    }

    // Un CLI más viejo que alguno de estos flags lo rechaza al instante, antes
    // de gastar un token: se reintenta sin él. Nadie se queda sin generar por un
    // cartelito, y el reintento no cuesta nada porque el primero ni llegó a
    // llamar al modelo. Se prueba primero apagando el estado en vivo (lo más
    // barato de perder) y después volviendo a la forma vieja de mandar el
    // system prompt.
    function rechazoDeFlag(res) {
      return res.code !== 0 && !res.timedOut &&
        agentStream.isUnsupportedFlag((res.err || '') + '\n' + (res.out || ''));
    }

    let streaming = live;
    let viejo = false;
    let r = await attempt(streaming, viejo);
    if (streaming && rechazoDeFlag(r)) {
      streaming = false;
      r = await attempt(streaming, viejo);
    }
    if (!viejo && rechazoDeFlag(r)) {
      viejo = true;
      r = await attempt(streaming, viejo);
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

    // Permisos que el CLI pidió y nadie le pudo dar. En headless no hay a quién
    // preguntarle, así que una lectura denegada no falla: sale igual, con el
    // modelo diseñando sin haber visto la imagen de referencia o el documento
    // que el editor subió a propósito. Es el modo de falla más mudo que tiene
    // esto, y la única forma de que se note es decirlo.
    const negados = (parsed && Array.isArray(parsed.permission_denials))
      ? parsed.permission_denials : [];
    if (negados.length) {
      const que = negados
        .map((d) => (d && (d.tool_name || d.tool)) || 'una herramienta')
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(', ');
      warning = (warning ? warning + '\n' : '') +
        'OJO: el CLI necesitó permiso para usar ' + que + ' (' + negados.length +
        ' vez/veces) y no lo tuvo, así que el modelo diseñó sin eso. Suele ser una ' +
        'imagen de referencia o un recurso que quedó fuera de las carpetas que el CLI puede leer.';
    }

    const html = stripHtmlFence(text);
    if (!html) throw new Error('claude-cli: la respuesta del CLI vino vacia');
    return { text: html, usage, warning };
  } finally {
    cleanup();
    if (sysFile) sysFile.cleanup();
  }
}

module.exports = { generate };
