'use strict';

/**
 * Lector de la salida "stream-json" de los CLI de agente (claude, cursor-agent).
 *
 * Existe porque el editor mira una barra que decía "Diseñando la animación…" y
 * no cambiaba en tres minutos: no había forma de saber si el modelo avanzaba, si
 * se colgó o qué estaba haciendo. Los dos CLI pueden contarlo mientras trabajan
 * (`--output-format stream-json`, una línea JSON por evento) y este módulo
 * traduce esos dos dialectos distintos a UN vocabulario de ACTIVIDAD.
 *
 * Dos decisiones que valen por todo el diseño:
 *
 * 1. El stream es SOLO para el estado en vivo. El resultado (el HTML, los
 *    tokens, el costo) se sigue leyendo del stdout completo cuando el proceso
 *    termina. Así, si el streaming se rompe —un evento nuevo, una línea
 *    cortada, un CLI que cambió el formato— se pierde el cartelito, nunca la
 *    generación.
 *
 * 2. Los avisos se ESTRANGULAN. Los deltas de razonamiento llegan de a cientos
 *    por segundo y cada uno terminaría redibujando la cola del panel. Se manda
 *    uno cada MIN_INTERVAL_MS, salvo los cambios de fase, que van al instante
 *    (pasar de "razonando" a "escribiendo la composición" es la información).
 *
 * Actividad normalizada:
 *   { phase: 'start'|'thinking'|'tool'|'writing', text, tokens, chars, tool }
 * y `describe()` la convierte en la línea que ve el editor.
 */

// Los deltas llegan a ráfagas; esto es lo que el ojo necesita para leer.
const MIN_INTERVAL_MS = 700;

// Cuánto texto de razonamiento se muestra. Es una tira de una línea en un panel
// angosto: más que esto no entra y no se lee.
const TAIL_CHARS = 110;

// Qué está haciendo el agente cuando usa una herramienta. Las dos familias de
// CLI nombran distinto lo mismo (Claude: "Read"; Cursor: "readToolCall"), así
// que la clave es el nombre ya normalizado.
const TOOL_TEXT = {
  read: 'leyendo un archivo',
  glob: 'buscando archivos',
  grep: 'buscando en el texto',
  ls: 'mirando la carpeta',
  list: 'mirando la carpeta',
  listdir: 'mirando la carpeta',
  bash: 'corriendo un comando',
  terminal: 'corriendo un comando',
  shell: 'corriendo un comando',
  codebasesearch: 'buscando en el código',
  write: 'escribiendo un archivo',
  edit: 'editando un archivo',
  webfetch: 'consultando una página',
  websearch: 'buscando en la web',
  task: 'delegando en un subagente',
  todowrite: 'ordenando sus tareas',
};

/** Nombre de herramienta comparable entre los dos CLI. */
function normalizeToolName(raw) {
  return String(raw || '')
    .replace(/ToolCall$/, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase()
    // Un nombre inventado por un CLI futuro no puede empujar la línea del panel.
    .slice(0, 32);
}

/** Miles con punto, que es como se leen los números en el panel. */
function nf(n) {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * Última parte de un texto largo, en una línea. Se muestra la cola y no el
 * principio porque lo que importa es en qué anda AHORA, no cómo empezó.
 */
function tail(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  let cut = flat.slice(flat.length - max);
  // No arrancar a mitad de una palabra si el corte cae cerca de un espacio.
  const sp = cut.indexOf(' ');
  if (sp > 0 && sp < 24) cut = cut.slice(sp + 1);
  return '…' + cut;
}

/**
 * La línea que ve el editor. Vive acá, al lado del parseo, porque las dos
 * mitades cambian juntas: un evento nuevo del CLI no sirve de nada si nadie
 * sabe cómo nombrarlo.
 */
function describe(a) {
  if (!a) return '';
  switch (a.phase) {
    case 'start':
      return 'el agente arrancó';
    case 'thinking': {
      const cuenta = a.tokens > 0 ? ' (' + nf(a.tokens) + ' tok)' : '';
      return a.text ? ('razonando' + cuenta + ' · ' + a.text) : ('razonando' + cuenta + '…');
    }
    case 'tool': {
      const qué = TOOL_TEXT[a.tool] || ('usando ' + (a.tool || 'una herramienta'));
      return qué + (a.detail ? ' · ' + a.detail : '');
    }
    case 'writing':
      return a.chars > 0
        ? ('escribiendo la composición · ' + nf(a.chars) + ' caracteres')
        : 'escribiendo la composición…';
    default:
      return '';
  }
}

/**
 * Traduce UN evento del CLI de Claude. Devuelve el parche a aplicar sobre el
 * estado, o null si el evento no dice nada que mostrar.
 *
 * Formato: `--output-format stream-json --verbose`, y con
 * `--include-partial-messages` aparecen además los `stream_event` con el texto
 * del razonamiento y de la respuesta a medida que se generan. Sin ese flag el
 * heartbeat igual existe: los `system/thinking_tokens` van contando.
 */
function readClaudeEvent(o, st) {
  if (!o || typeof o !== 'object') return null;

  if (o.type === 'system' && o.subtype === 'init') return { phase: 'start' };

  if (o.type === 'system' && o.subtype === 'thinking_tokens') {
    st.tokens = Number(o.estimated_tokens) || st.tokens;
    return { phase: 'thinking' };
  }

  if (o.type === 'stream_event' && o.event) {
    const ev = o.event;
    if (ev.type === 'content_block_start' && ev.content_block) {
      if (ev.content_block.type === 'tool_use') {
        return { phase: 'tool', tool: normalizeToolName(ev.content_block.name) };
      }
      if (ev.content_block.type === 'thinking') return { phase: 'thinking' };
      if (ev.content_block.type === 'text') return { phase: 'writing' };
      return null;
    }
    if (ev.type === 'content_block_delta' && ev.delta) {
      if (ev.delta.type === 'thinking_delta') {
        st.thinking += String(ev.delta.thinking || '');
        return { phase: 'thinking' };
      }
      if (ev.delta.type === 'text_delta') {
        st.chars += String(ev.delta.text || '').length;
        return { phase: 'writing' };
      }
      return null; // signature_delta y demás: ruido criptográfico
    }
    return null;
  }

  // Mensaje completo del asistente. Con --include-partial-messages es la
  // repetición de lo que ya vimos por deltas; sin él, es la ÚNICA noticia.
  if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
    let patch = null;
    o.message.content.forEach((b) => {
      if (!b) return;
      if (b.type === 'tool_use') patch = { phase: 'tool', tool: normalizeToolName(b.name) };
      else if (b.type === 'text' && typeof b.text === 'string') {
        if (!st.partial) st.chars += b.text.length;
        patch = { phase: 'writing' };
      } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
        if (!st.partial) st.thinking = b.thinking;
        patch = { phase: 'thinking' };
      }
    });
    return patch;
  }

  return null;
}

/**
 * Junta un pedazo de respuesta con lo que ya había.
 *
 * Con `--stream-partial-output`, Cursor manda la respuesta en pedazos y al
 * final la manda ENTERA otra vez. Sumando a ciegas, la respuesta rearmada
 * salía DUPLICADA (y el contador de caracteres, al doble). Un mensaje que
 * EMPIEZA con lo que ya teníamos es esa repetición final —o el único mensaje,
 * cuando no hay parciales— y se adopta en vez de sumarse.
 */
function mergeAnswer(acc, text) {
  if (!text) return acc;
  if (text.length >= acc.length && text.indexOf(acc) === 0) return text;
  return acc + text;
}

function addAnswer(st, text) {
  st.answer = mergeAnswer(st.answer, text);
  st.chars = st.answer.length;
}

/**
 * Traduce UN evento del CLI de Cursor (`--output-format stream-json`).
 *
 * Lo que sí manda mientras trabaja: `tool_call` por cada herramienta (leer un
 * archivo, buscar, correr un comando) y, con `--stream-partial-output`, la
 * respuesta en pedazos a medida que se escribe. Lo que NO manda: contador de
 * tokens de razonamiento. Los eventos `thinking` están contemplados porque el
 * formato los define, pero el CLI probado (2026.08) no los emitió ni con un
 * modelo con thinking: el estado en vivo de Cursor se apoya en las
 * herramientas y en el texto que va saliendo.
 */
function readCursorEvent(o, st) {
  if (!o || typeof o !== 'object') return null;

  if (o.type === 'system' && o.subtype === 'init') return { phase: 'start' };

  // El eco de NUESTRO propio prompt: no es novedad de nadie.
  if (o.type === 'user') return null;

  if (o.type === 'thinking') {
    if (o.subtype === 'delta') {
      st.thinking += String(o.text || '');
      return { phase: 'thinking' };
    }
    return { phase: 'thinking' }; // 'completed' y demás: seguimos en razonamiento
  }

  if (o.type === 'tool_call') {
    // El nombre de la herramienta es la CLAVE del objeto, no un campo:
    // { tool_call: { readToolCall: { args: {...} } } }.
    const tc = o.tool_call || {};
    const key = Object.keys(tc).find((k) => /ToolCall$/.test(k));
    if (!key) return null;
    if (o.subtype === 'completed') return null; // el "started" ya lo contó
    const args = (tc[key] && tc[key].args) || {};
    // Cada herramienta nombra distinto su argumento principal (`path` al leer,
    // `globPattern` al buscar, `command` en la terminal): se muestra el primero
    // que haya, que es de lo que trata la llamada.
    const raw = args.path || args.file || args.globPattern || args.pattern ||
      args.query || args.command || '';
    let detail = String(raw).replace(/\s+/g, ' ').trim();
    // Una ruta se muestra por su nombre de archivo (la ruta entera no entra);
    // un comando va tal cual, recortado.
    if (detail && detail.indexOf(' ') === -1) detail = detail.split(/[\\/]/).pop();
    return {
      phase: 'tool',
      tool: normalizeToolName(key),
      detail: detail.slice(0, 40),
    };
  }

  if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
    o.message.content.forEach((b) => {
      if (b && b.type === 'text' && typeof b.text === 'string') addAnswer(st, b.text);
    });
    return { phase: 'writing' };
  }

  return null;
}

const DIALECTS = { claude: readClaudeEvent, cursor: readCursorEvent };

/**
 * Arma el lector de actividad de un proceso.
 *
 * @param {'claude'|'cursor'} dialect
 * @param {function} onActivity  Recibe { phase, text, tokens, chars, tool, detail }.
 * @param {object} [opts] - { partial } true si el CLI va a mandar deltas de texto
 *   (cambia solo cómo se cuentan los caracteres, para no contarlos dos veces).
 * @returns {{ onData: function(string) }} `onData` se le pasa tal cual a run().
 */
function createActivityReader(dialect, onActivity, opts) {
  const readEvent = DIALECTS[dialect];
  if (typeof onActivity !== 'function' || !readEvent) return { onData: null };

  const st = { thinking: '', answer: '', tokens: 0, chars: 0, partial: !!(opts && opts.partial) };
  let buf = '';
  let lastKey = '';
  let lastAt = 0;

  // Qué se estaría mostrando con este parche. Sirve para decidir si es NOTICIA
  // (va al instante) o refresco (espera la ventana). Incluye si la fase ya tiene
  // contenido porque toda fase arranca vacía: el primer aviso de "razonando"
  // llega antes que la primera palabra, y sin esto una etapa corta se mostraba
  // siempre en blanco. La herramienta va en la clave para que una seguidilla de
  // lecturas se cuente de a una y no como "sigue leyendo".
  function keyOf(patch) {
    if (patch.phase === 'tool') return 'tool|' + patch.tool + '|' + (patch.detail || '');
    // El contador de tokens y el texto son dos noticias distintas y pueden
    // llegar en cualquier orden: si contaran como una sola, el primero en
    // aparecer le tapaba la ventana al otro.
    if (patch.phase === 'thinking') return 'thinking|' + (st.thinking ? 'T' : '') + (st.tokens ? 'N' : '');
    if (patch.phase === 'writing') return 'writing|' + (st.chars ? '1' : '0');
    return patch.phase;
  }

  function push(patch) {
    const now = Date.now();
    const key = keyOf(patch);
    if (key === lastKey && (now - lastAt) < MIN_INTERVAL_MS) return;
    lastKey = key;
    lastAt = now;
    // El texto de razonamiento se muestra solo mientras se razona: dejarlo
    // colgado bajo "escribiendo la composición" sería mentir sobre qué mira.
    const act = {
      phase: patch.phase,
      tool: patch.tool || '',
      detail: patch.detail || '',
      tokens: st.tokens,
      chars: st.chars,
      text: patch.phase === 'thinking' ? tail(st.thinking, TAIL_CHARS) : '',
    };
    act.label = describe(act);
    try { onActivity(act); } catch (e) { /* la UI no puede voltear la generación */ }
  }

  function onData(chunk) {
    buf += String(chunk || '');
    // Solo se procesan líneas COMPLETAS; el resto espera al próximo chunk.
    const lines = buf.split('\n');
    buf = lines.pop();
    // Un stream que se va de las manos (un CLI que escupe una línea gigante sin
    // saltos) no puede hacer crecer este buffer para siempre.
    if (buf.length > 1_000_000) buf = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.charAt(0) !== '{') continue; // stderr y ruido varios
      let o;
      try { o = JSON.parse(line); } catch (e) { continue; }
      let patch;
      try { patch = readEvent(o, st); } catch (e) { patch = null; }
      if (patch) push(patch);
    }
  }

  return { onData: onData };
}

/**
 * Saca el evento final de una salida stream-json completa.
 *
 * Es el mismo objeto que devuelve `--output-format json` (lo verificamos con
 * los dos CLI: trae `result`, `usage`, `is_error` y, en Claude,
 * `total_cost_usd`), así que quien lo consume no cambia una línea de su
 * parseo. Se busca DESDE EL FINAL porque el resultado es el último evento y
 * antes hay cientos.
 *
 * @returns {object|null} null si no hay ninguno (CLI viejo sin stream-json).
 */
function finalResult(stdout) {
  const lines = String(stdout || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line.charAt(0) !== '{') continue;
    let o;
    try { o = JSON.parse(line); } catch (e) { continue; }
    if (o && o.type === 'result') return o;
  }
  return null;
}

/**
 * Rearma la respuesta juntando los mensajes del asistente.
 *
 * Es la red de abajo: si el evento final no aparece (una línea cortada, un CLI
 * que cambió el formato), la alternativa sería tirar una generación de tres
 * minutos que YA se pagó. El texto se recupera; los tokens no, y quien llama
 * decide si eso vale.
 *
 * Los pedazos se juntan con la misma regla que en vivo (ver mergeAnswer): sin
 * ella, con los parciales de Cursor —que repiten la respuesta entera al final—
 * el HTML rescatado salía dos veces.
 */
function assistantText(stdout) {
  let acc = '';
  String(stdout || '').split('\n').forEach((line) => {
    const s = line.trim();
    if (!s || s.charAt(0) !== '{') return;
    let o;
    try { o = JSON.parse(s); } catch (e) { return; }
    if (!o || o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) return;
    o.message.content.forEach((b) => {
      if (b && b.type === 'text' && typeof b.text === 'string') acc = mergeAnswer(acc, b.text);
    });
  });
  return acc;
}

/**
 * Interruptores por variable de entorno.
 *
 * El estado en vivo es una mejora de la INTERFAZ: no puede ser la razón por la
 * que una máquina deje de generar. Si en algún equipo molesta (un CLI que se
 * comporta distinto, una salida gigante), se apaga sin tocar código ni esperar
 * una versión nueva:
 *   HYPERPREMIERE_STREAM=0           → sin estado en vivo (vuelve a --output-format json)
 *   HYPERPREMIERE_STREAM_THINKING=0  → con estado en vivo, pero sin el texto del razonamiento
 */
function envDisabled(name) {
  return /^(0|false|no|off)$/i.test(String(process.env[name] || '').trim());
}

/**
 * ¿El CLI rechazó un flag que le pasamos? Ese fallo es instantáneo y no gasta
 * un token, así que se puede reintentar sin el streaming en vez de dejar al
 * editor sin generación porque su CLI es más viejo que estos flags.
 */
function isUnsupportedFlag(text) {
  return /unknown option|unknown argument|unrecognized option|invalid option|requires --verbose/i
    .test(String(text || ''));
}

module.exports = {
  createActivityReader, finalResult, assistantText, isUnsupportedFlag, envDisabled, describe,
  normalizeToolName, tail, nf, MIN_INTERVAL_MS,
};
