'use strict';

/**
 * Proveedor: Cursor Agent CLI en modo headless (suscripción de Cursor).
 *
 * Invoca el binario `cursor-agent` con:
 *   cursor-agent -p <prompt> --output-format json --trust
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
 *   editor), y no se le pasa --force/--yolo, así que cualquier herramienta que
 *   necesite permiso queda denegada (en headless no hay a quién preguntarle).
 * - Va SIN --mode. Los dos modos que ofrece el CLI son de solo lectura y los dos
 *   son para otra cosa: `ask` es "Q&A para explicaciones y preguntas" y `plan`
 *   es "analizar y proponer planes, sin editar". Corrimos meses en `ask` —
 *   parecía la opción prudente— hasta que el modelo se plantó en medio de una
 *   clase: "I'm in Ask mode, which is for answering questions… I can't author a
 *   final production deliverable. Please switch to Agent mode". Contestó eso EN
 *   PROSA tres rondas seguidas, y como esa prosa se guardaba como la versión
 *   nueva, la ronda siguiente la mandaba de vuelta como "versión previa" y el
 *   daño se propagaba. Componer una animación ES el entregable, así que el modo
 *   que corresponde es el normal. Se puede volver a forzar con `cursorMode`
 *   ('ask' | 'plan'), que es como se mide (test/manual/cursor-contrato.js
 *   --modo ask). OJO con lo que este cambio NO prueba: medidos 4 contra 4, los
 *   dos modos dieron composiciones impecables y ninguna negativa. Sacar `ask`
 *   quita el motivo que el propio modelo dio, pero la negativa no se reproduce a
 *   pedido, así que lo que protege al editor es la red de compose.js: que la
 *   prosa se reconozca y NO se guarde como versión.
 * - El backend a veces responde "[unavailable]" de forma transitoria; ante eso
 *   se reintenta en vez de perder la generación.
 * - No informa costo en dólares (es suscripción), solo tokens de entrada y salida
 *   (la entrada, casi toda por los campos de caché: ver makeUsage).
 * - Si quien llama pasa `onActivity`, se usa `--output-format stream-json` (más
 *   `--stream-partial-output`): el CLI va contando qué herramienta usa y va
 *   mandando la respuesta a pedazos. El resultado se sigue leyendo del stdout
 *   completo al terminar, así que el estado en vivo no toca ni el HTML ni los
 *   tokens.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stripHtmlFence, parseImageDataUrl, makeUsage,
  imageFileName, imagesAsFilesNote, contractReminder } = require('./index');
const { run } = require('../exec');
const agentStream = require('./agent-stream');
const cliErrors = require('./cli-errors');
const cursorSession = require('../cursor-session');

const DEFAULT_TIMEOUT_MS = 900_000; // 900s: los modelos con thinking se toman su tiempo
const DEFAULT_MODEL = 'claude-sonnet-5-thinking-high';

// El modelo para las tareas CORTAS de texto (hoy: refinar un dictado), que no
// son diseñar y no tienen por qué pagar como si lo fueran. Es el lugar de Haiku
// en el proveedor de Claude — Cursor no ofrece ningún Haiku, así que el análogo
// hay que elegirlo midiendo.
//
// Y midiendo sale al revés de lo que uno pondría de memoria. Refinando el mismo
// dictado de 40 palabras, dos vueltas cada uno
// (test/manual/cursor-refinado.js):
//
//   modelo                        latencia    entrada  salida  caché lee/escribe
//   claude-sonnet-5                5,7-7,1 s        2      69   17641 / 9478
//   claude-sonnet-5-thinking-high  5,6-6,6 s        2      69   17641 / 9478
//   composer-2.5                   6,8-8,9 s     8647  231-447   7990 / 0
//   cursor-grok-4.6-low            7,5-9,6 s  8102-10281 181-348 7424 / 0
//
// Composer es el modelo propio de Cursor y el que uno elegiría por "chico y
// rápido", y sin embargo es el más lento y el que más caro sale: Cursor le
// CACHEA el contexto del agente a los modelos de Anthropic y a los suyos no,
// así que por Composer el prompt entero viaja fresco (8.647 tokens) en cada
// llamada mientras que por Sonnet viajan 2. Los cuatro pasan el control de
// tamaño y los cuatro refinan bien; la diferencia es de precio y de segundos.
//
// Entre los dos Sonnet, la medición es un empate, así que decide el criterio:
// va el que NO razona. Reordenar dos frases no es una tarea de razonamiento, y
// que hoy salga igual de barato no es motivo para pedirlo.
//
// OJO con lo que esto NO arregla: refinar por Cursor sigue teniendo un piso de
// ~6 s y ~9.500 tokens escritos a caché, contra los ~2 s de Haiku por la API de
// Anthropic. Elegir bien adentro de Cursor no lo vuelve barato; por eso Cursor
// se usa cuando el editor lo eligió y no como respaldo (ver dictado-refinar.js).
const MODELO_CORTO = process.env.HYPERPREMIERE_CURSOR_MODELO_CORTO || 'claude-sonnet-5';
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

/**
 * Mensaje accionable cuando el CLI no está, no hay sesión, o falló por otra
 * cosa. Los tres casos tienen tres próximos pasos distintos, así que se le
 * pregunta a la máquina antes de escribir (ver cursor-session.mensajeDeFalla).
 * Antes esto era un texto fijo con los dos comandos juntos y el editor tenía
 * que adivinar cuál de los dos le tocaba.
 */
async function setupHint(cfg, detalle) {
  return 'cursor-cli: ' + await cursorSession.mensajeDeFalla(cfg, detalle);
}

/**
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {string[]} [opts.images] - data URLs de stills
 * @param {string} opts.model
 * @param {object} [opts.config] - { timeoutMs?, apiKey?, cursorBinPath? }.
 *   `cursorBinPath` es el override explícito de la ruta del binario: lo usan
 *   los tests para apuntar al CLI de mentira y el diagnóstico para preguntarle
 *   a la copia que ya encontró. En una corrida normal no viene, y la ruta la
 *   resuelve cursor-session.binDe con el doctor.
 * @param {function} [opts.onActivity] - se lo llama con lo que el agente está
 *   haciendo mientras trabaja (ver agent-stream.js). Sin él, formato de salida
 *   de siempre.
 * @returns {Promise<{text:string, usage:object|null, warning?:string}>} lo que
 *   escribió el modelo, CRUDO. `generate` es esto más quitarle el fence.
 */
async function complete({ systemPrompt, userPrompt, images, model, config, onActivity }) {
  const cfg = config || {};
  if (!userPrompt || typeof userPrompt !== 'string') {
    throw new Error('cursor-cli: userPrompt es requerido');
  }

  const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
    ? cfg.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  // La ruta la resuelve cursor-session (override explícito → PATH → rutas
  // conocidas → escotilla por variable de entorno), no un nombre pelado que el
  // PATH recortado de Premiere puede no saber resolver.
  const bin = await cursorSession.binDe(cfg);
  const useModel = model || DEFAULT_MODEL;

  const ws = makeWorkspace(images);

  // Cómo se arma el mensaje, que acá es TODO lo que hay.
  //
  // `cursor-agent` no tiene canal de system prompt (su --help no ofrece
  // ninguno), así que las instrucciones del sistema tienen que viajar adentro
  // del mensaje de usuario. Eso no se puede evitar; lo que sí se puede es
  // ordenarlo para que el contrato pese:
  //
  //   1. El system prompt, con un título que diga qué es. Antes lo separaba un
  //      `---` pelado, que en markdown es una línea decorativa: no marcaba que
  //      ahí terminaba el manual y empezaba el laburo.
  //      El título DESCRIBE el contenido; no reclama autoridad. La primera
  //      versión decía "INSTRUCCIONES DEL SISTEMA (mandan sobre todo lo demás)"
  //      y el modelo se plantó: contestó que "el mensaje incluye un bloque que
  //      se presenta como instrucciones del sistema dentro del propio pedido
  //      del usuario" y que no iba a darle prioridad sobre su configuración
  //      real. Tiene razón — un mensaje de usuario que se declara sistema es
  //      exactamente la forma de una inyección, y los modelos están entrenados
  //      para desconfiar de eso. Se perdió la generación entera.
  //   2. El pedido concreto del editor.
  //   3. Dónde están las imágenes.
  //   4. ÚLTIMO, y solo si se pide: el andamiaje repetido corto y tajante (ver
  //      contractReminder). Va apagado por defecto porque se midió y no cambia
  //      nada; el detalle de la medición está en ese comentario.
  //
  // Las imágenes se nombran por RUTA ABSOLUTA aunque estén en el directorio de
  // trabajo: las herramientas de búsqueda del agente no indexan este temporal
  // (un glob de "imagen-1.png" vuelve vacío), así que con el nombre suelto se
  // pone a buscar, a veces se rinde y contesta que no encuentra la imagen en vez
  // de componer. Con la ruta entera abre y listo.
  const system = String(systemPrompt || '').trim();
  const prompt = (system
      ? '# CÓMO SE COMPONE EN ESTE PROYECTO\n\n' + system +
        '\n\n---\n\n# EL PEDIDO\n\n'
      : '') +
    userPrompt +
    imagesAsFilesNote(ws.names.map((n) => path.join(ws.dir, n))) +
    // Apagado salvo que se pida: no mejora nada y cuesta. Se prende con
    // `contractTail: true` para volver a medirlo cuando cambie el modelo por
    // defecto o cuando engine.js empiece a agregar secciones mucho más largas
    // después del contrato (test/manual/cursor-contrato.js).
    (cfg.contractTail ? contractReminder() : '');

  // En Windows el prompt NO puede ir como argumento: con shell (que el shim
  // .cmd exige) la línea pasa por cmd.exe, que la corta a los 8191 caracteres,
  // y acá el prompt son decenas de miles. Por stdin no hay tope; el CLI lo lee
  // cuando -p viene sin texto.
  const viaStdin = cfg.promptViaStdin !== undefined
    ? !!cfg.promptViaStdin
    : process.platform === 'win32';
  const input = viaStdin ? prompt : undefined;

  // ¿Contamos en vivo lo que el agente va haciendo? Con stream-json, Cursor
  // avisa cada herramienta que usa (leer una imagen, buscar un archivo) y, con
  // --stream-partial-output, va mandando la respuesta a pedazos mientras la
  // escribe. Y el último evento es el MISMO objeto que devuelve
  // `--output-format json`, con su `usage` — el conteo de tokens no cambia.
  const live = typeof onActivity === 'function' &&
    !agentStream.envDisabled('HYPERPREMIERE_STREAM');
  // Ver el texto salir es un flag aparte, igual que en Claude: sin él quedan
  // las herramientas, que ya alcanzan para saber que sigue vivo.
  const partial = !agentStream.envDisabled('HYPERPREMIERE_STREAM_THINKING');

  // Modo del agente. Vacío = el normal, el único en el que el modelo acepta
  // producir el entregable (ver la cabecera). 'ask'/'plan' quedan para medir.
  const modo = String(cfg.cursorMode || '').trim().toLowerCase();

  function buildArgs(streaming) {
    const args = [
      '-p',
      '--output-format', streaming ? 'stream-json' : 'json',
      '--trust',         // headless lo exige; el workspace es nuestro temp, no el proyecto
      '--model', useModel,
      '--workspace', ws.dir,
    ];
    if (modo === 'ask' || modo === 'plan') args.push('--mode', modo);
    if (streaming && partial) args.push('--stream-partial-output');
    if (!viaStdin) args.splice(1, 0, prompt);
    return args;
  }

  try {
    // El MISMO entorno con el que el panel pregunta si hay sesión. Que lo arme
    // una sola función es lo que impide que la detección y la generación
    // opinen distinto (ver cursor-session.envParaCursor).
    const childEnv = cursorSession.envParaCursor(cfg);

    let streaming = live;
    let lastErr = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const reader = streaming
        ? agentStream.createActivityReader('cursor', onActivity, { partial: partial })
        : { onData: null };
      const r = await run(bin, buildArgs(streaming), {
        timeoutMs, env: childEnv, cwd: ws.dir, input,
        shell: process.platform === 'win32',
        onData: reader.onData || undefined,
      });

      if (r.timedOut) throw new Error(`cursor-cli: timeout tras ${timeoutMs}ms`);
      // Acá cae el ENOENT de la captura del editor: el proceso ni arrancó.
      if (r.code === -1) throw new Error(await setupHint(cfg, cliErrors.deProceso(r)));

      const combined = (r.err || '') + '\n' + (r.out || '');
      // Un CLI más viejo que stream-json lo rechaza al instante, sin gastar un
      // token: se apaga el estado en vivo y se reintenta. No consume intento:
      // el modelo nunca llegó a correr.
      if (streaming && r.code !== 0 && agentStream.isUnsupportedFlag(combined)) {
        streaming = false;
        attempt--;
        continue;
      }
      if (r.code !== 0) {
        // Mirar los dos flujos ya estaba bien; lo que faltaba era que, cuando lo
        // que llega es el JSON del CLI, se cite la frase y no el bloque crudo.
        lastErr = cliErrors.deProceso(r) || '(sin salida)';
        if (isTransient(combined) && attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        // "Authentication required", 401, "not logged in": el CLI corrió y
        // rebotó por credencial. Se le pregunta a la máquina en vez de suponer
        // — puede ser que falte la sesión, o que la key pegada en el panel ya
        // no sirva, y son dos frases distintas.
        if (/not logged in|unauthor|authentication required|401|no api key/i.test(combined)) {
          throw new Error(await setupHint(cfg, lastErr));
        }
        throw new Error(`cursor-cli: salió con código ${r.code}. ${lastErr.slice(0, 400)}`);
      }

      // Con json, stdout es UN objeto; con stream-json, una línea por evento y
      // el último es ese mismo objeto (.result y .usage). Un solo camino de acá
      // para abajo.
      let parsed = streaming ? agentStream.finalResult(r.out) : null;
      let warning = '';
      if (!parsed) {
        try {
          parsed = JSON.parse(r.out);
        } catch (e) {
          // Con stream, antes de perder una generación ya pagada se rearma la
          // respuesta con los mensajes del agente (se pierden los tokens, no el HTML).
          const salvado = streaming ? agentStream.assistantText(r.out) : '';
          if (!salvado) throw new Error('cursor-cli: la salida no era JSON válido: ' + r.out.slice(0, 300));
          parsed = { result: salvado, usage: null };
          warning = agentStream.rescueWarning(false);
        }
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

      let text = typeof parsed.result === 'string' ? parsed.result : '';
      // Misma red que en claude-cli: si el resultado viene vacío pero el agente
      // sí contestó, se rescata de sus mensajes antes de perder la generación.
      if (!text.trim() && streaming) {
        text = agentStream.assistantText(r.out);
        if (text.trim()) warning = agentStream.rescueWarning(!!parsed.usage);
      }
      const u = (parsed && parsed.usage) ? parsed.usage : {};
      const usage = makeUsage('cursor-cli', useModel, {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheCreationTokens: u.cacheWriteTokens,
        costUsd: null, // suscripción: no hay costo por llamada
      });

      if (!text.trim()) {
        if (attempt < MAX_ATTEMPTS) { lastErr = 'respuesta vacía'; await sleep(RETRY_DELAY_MS); continue; }
        throw new Error('cursor-cli: la respuesta vino vacía');
      }

      // ¿Miró las imágenes de referencia? Mismo control que en claude-cli y por
      // el mismo motivo: el prompt las manda abrir, el agente puede saltearse
      // la lectura y la composición sale igual de presentable. Solo se puede
      // comprobar con el stream, que es de donde salen las herramientas que usó.
      if (ws.names.length && streaming) {
        const faltan = agentStream.filesMissing(ws.names, agentStream.filesRead(r.out));
        if (faltan.length) {
          warning = (warning ? warning + '\n' : '') +
            'OJO: el agente ' + (faltan.length === ws.names.length
              ? 'NO abrió ' + (ws.names.length === 1 ? 'la imagen de referencia'
                : 'ninguna de las ' + ws.names.length + ' imágenes de referencia')
              : 'abrió solo ' + (ws.names.length - faltan.length) + ' de las ' + ws.names.length +
                ' imágenes de referencia (le faltó: ' + faltan.join(', ') + ')') +
            ', así que diseñó sin verla' + (ws.names.length === 1 ? '' : 's') +
            '. Qué hacer: volvé a generar.';
        }
      }

      return { text: text, usage, warning };
    }

    throw new Error('cursor-cli: falló tras ' + MAX_ATTEMPTS + ' intentos. Último error: ' + lastErr.slice(0, 300));
  } finally {
    ws.cleanup();
  }
}

/**
 * La composición, ya sin el fence de markdown. Es `complete` más eso y nada
 * más, igual que en los otros proveedores.
 *
 * Estaban fundidos en una sola función porque a Cursor nadie le pedía texto
 * crudo: el refinador del dictado lo excluía por caro. Desde que el refinado
 * usa el proveedor que el editor eligió (ver bridge/dictado-refinar.js), sí se
 * lo pide, y partirlo es lo que evita que el refinado herede el desenvolver-
 * HTML —que sobre una instrucción de diseño no hace nada, hasta el día que la
 * instrucción mencione un bloque de código y se la coma—.
 *
 * @param {object} opts - los mismos de `complete`
 * @returns {Promise<{text:string, usage:object|null, warning?:string}>}
 */
async function generate(opts) {
  const r = await complete(opts);
  const html = stripHtmlFence(r.text);
  if (!html) throw new Error('cursor-cli: la respuesta vino vacía');
  return Object.assign({}, r, { text: html });
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

/**
 * El nivel de razonamiento que trae el ID, si trae alguno.
 * 'claude-sonnet-5-thinking-xhigh' → 'xhigh' · 'composer-2.5' → ''
 *
 * Sale de acá y no del panel porque acá está la tabla de familias, y porque el
 * panel lo necesita para ofrecer el nivel como un desplegable aparte —igual que
 * con Claude— en vez de esconderlo dentro del nombre del modelo.
 */
function effortOf(id, family) {
  const rest = id.slice(family.length).replace(/^-/, '').replace(/^thinking-?/, '');
  return EFFORT_ORDER.indexOf(rest) === -1 ? '' : rest;
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
  // Cada modelo sale con su familia y su nivel ya separados: el panel los
  // agrupa para mostrar "modelo" y "pensamiento" en dos desplegables, como en
  // Claude, en vez de una lista de IDs donde el nivel había que adivinarlo.
  return auto.concat(usable).map((m) => {
    const fam = familyOf(m.id);
    return Object.assign({}, m, {
      family: fam || m.id,
      effort: fam ? effortOf(m.id, fam) : '',
    });
  });
}

/**
 * Modelos que la cuenta de Cursor tiene DE VERDAD (`cursor-agent --list-models`),
 * ya curados y ordenados.
 * Devuelve { ok, models: [{ id, name, family, effort }] } y no lanza: si falla,
 * el panel se queda con su lista de respaldo.
 */
async function listModels(config) {
  const cfg = config || {};
  try {
    const bin = await cursorSession.binDe(cfg);
    const childEnv = cursorSession.envParaCursor(cfg);
    // 60s y no 30: el listado normalmente tarda ~1s pero se lo vio irse a 30s.
    const r = await run(bin, ['--list-models'], { timeoutMs: 60_000, env: childEnv, shell: process.platform === 'win32' });
    // `r.err || r.out` se comía el stdout cuando stderr traía apenas un salto de
    // línea (es "verdadero"): se miran los dos ya recortados.
    if (r.code !== 0) return { ok: false, error: cliErrors.deProceso(r).slice(0, 300) };

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

module.exports = { generate, complete, listModels, DEFAULT_MODEL, MODELO_CORTO };
