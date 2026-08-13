// Contrato de composición de HyperFrames: qué exige el motor de captura, cómo
// completarlo sin volver a llamar al modelo, y cómo leer su auditoría.
//
// Por qué existe este módulo:
// Si la salida del modelo no cumplía el contrato, antes se pedía una composición
// NUEVA DESDE CERO. Eso costaba otra tanda completa de razonamiento (minutos, es
// el 86-91% del tiempo de un marcador) y encima devolvía un diseño DISTINTO, que
// ya no había pasado por la auditoría del primero: se perdía tiempo Y calidad.
//
// Pero lo que exige el contrato es ANDAMIAJE, no diseño: el id de la composición,
// su duración y el registro de la timeline. Eso se completa en código, con la
// misma salida visual y en microsegundos.
//
// Cómo, sin traer un parser de HTML (esto vive dentro del panel CEP y el HTML se
// guarda en disco para que el editor lo toque a mano, así que tiene que volver
// IGUAL si no hay nada que arreglar): se escanea el tag de apertura del #stage
// respetando comillas, se leen sus atributos CON SUS POSICIONES, y toda escritura
// es un splice por índice. Nada de armar expresiones regulares con nombres ni de
// String.replace — el HTML puede traer `$&` o `$1` en el CSS y en los textos, y
// como *reemplazo* esas secuencias son especiales y corromperían la salida.

'use strict';

// Valores del esqueleto obligatorio (ver bridge/prompt/system.md, "PLANTILLA
// OBLIGATORIA"). Todo el pipeline es 1080p30.
const SKELETON = {
  'data-start': '0',
  'data-width': '1920',
  'data-height': '1080',
  'data-fps': '30',
};

// Qué falta cuando no se puede completar en código. Códigos, no frases: el texto
// para el editor y para el prompt lo pone quien llama (engine.js), que es el
// dueño de esa redacción.
const PROBLEM = {
  NO_STAGE: 'no-stage',
  MANY_STAGES: 'many-stages',
  NO_REGISTRATION: 'no-timeline-registration',
  MANY_REGISTRATIONS: 'many-timeline-registrations',
  NO_DURATION: 'no-duration',
};

/**
 * Auditoría del propio modelo (ver system.md, "PLAN → CÓDIGO → AUDITORÍA"): si
 * declaró una falla concreta de diseño, devuelve qué falló para pedir UNA
 * corrección dirigida. null = auditoría OK o ausente.
 */
function auditFailure(html) {
  const m = String(html || '').match(/<!--\s*AUDIT:\s*FALLA:?\s*([\s\S]*?)-->/i);
  return m ? m[1].trim().slice(0, 400) : null;
}

/**
 * Predicado "esta posición es código, no un comentario".
 *
 * Hace falta porque el modelo cierra cada composición con su auditoría en un
 * `<!-- AUDIT: ... -->` donde DESCRIBE EN PROSA lo que hizo ("window.__timelines
 * [COMP_ID]=tl asignado", "timeline única…"). Contar eso como código real hacía
 * ver dos registros donde hay uno: 39 de las 69 composiciones ya generadas del
 * proyecto se habrían mandado de vuelta al modelo por nada.
 */
function outsideComments(html) {
  const re = /<!--[\s\S]*?-->/g;
  const ranges = [];
  let m;
  while ((m = re.exec(html))) ranges.push([m.index, m.index + m[0].length]);
  return function (index) {
    for (const r of ranges) if (index >= r[0] && index < r[1]) return false;
    return true;
  };
}

// Tags de apertura, respetando comillas: un '>' dentro del valor de un atributo
// no termina el tag (es justo lo que rompe el clásico [^>]*).
function scanOpenTags(html, isCode) {
  const re = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const tags = [];
  let m;
  while ((m = re.exec(html))) {
    if (!isCode(m.index)) continue;
    tags.push({ name: m[1].toLowerCase(), text: m[0], index: m.index });
  }
  return tags;
}

// Atributos de un tag con la POSICIÓN de cada valor dentro del texto del tag,
// para poder reescribirlos por índice. Se acepta valor con o sin comillas; ante
// duplicados gana el primero, igual que en el DOM.
function parseAttrs(tagText) {
  const re = /([a-zA-Z_:][\w:.\-]*)\s*=\s*(?:(["'])(.*?)\2|([^\s"'=<>`]+))/g;
  const attrs = new Map();
  let m;
  while ((m = re.exec(tagText))) {
    const quoted = m[3] !== undefined;
    const value = quoted ? m[3] : m[4];
    // El valor siempre termina al final del match (menos la comilla de cierre).
    const end = m.index + m[0].length - (quoted ? 1 : 0);
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, { value: value, start: end - value.length, end: end });
  }
  return attrs;
}

// Asignaciones simples `X = 'literal'` del script, para saber a qué APUNTA la
// clave del registro cuando es una variable (típicamente COMP_ID). Gana la
// primera, que es la declaración. Se escanea una vez en vez de armar una regex
// con el nombre de la variable.
function scanStringVars(html, isCode) {
  const re = /\b([A-Za-z_$][\w$]*)\s*=\s*["']([^"']*)["']/g;
  const vars = new Map();
  let m;
  while ((m = re.exec(html))) if (isCode(m.index) && !vars.has(m[1])) vars.set(m[1], m[2]);
  return vars;
}

// Elementos sin cierre: no abren nivel de anidación.
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/**
 * Elementos que cuelgan DIRECTAMENTE del `<body>`.
 *
 * Hay que contar la anidación: "el primer div del documento" puede ser un hijo
 * cualquiera. Y hay que saltear el contenido de `<script>`/`<style>`, donde un
 * `<` es un menor-que y no el principio de un tag.
 */
function topLevelElements(html, isCode) {
  const openBody = html.match(/<body[^>]*>/i);
  const start = openBody ? openBody.index + openBody[0].length : 0;
  const closeBody = html.toLowerCase().lastIndexOf('</body>');
  const end = closeBody === -1 ? html.length : closeBody;

  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  re.lastIndex = start;
  const out = [];
  let depth = 0;
  let m;
  while ((m = re.exec(html)) && m.index < end) {
    if (!isCode(m.index)) continue;
    const name = m[2].toLowerCase();
    const closing = m[1] === '/';
    if (!closing && (name === 'script' || name === 'style')) {
      const cierre = html.toLowerCase().indexOf('</' + name, m.index);
      re.lastIndex = cierre === -1 ? end : cierre;
      continue;
    }
    if (VOID_TAGS.has(name) || /\/\s*$/.test(m[3])) continue;
    if (closing) { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) out.push({ name: name, text: m[0], index: m.index });
    depth++;
  }
  return out;
}

/**
 * Cuál es el contenedor de la composición.
 *
 * Nuestra plantilla pide `<div id="stage">` y el modelo casi siempre la
 * respeta. Cuando no, rendirse sale caro: se gasta una llamada extra y, si esa
 * tampoco cumple, se manda a renderizar algo que no puede funcionar. Además
 * `id="stage"` es una convención NUESTRA — lo que el motor de render mira es
 * `data-composition-id`.
 *
 * Por eso se buscan tres cosas, en orden, y solo se adopta lo que no deja lugar
 * a dudas: elegir mal la raíz no falla rápido, deja el diseño roto en pantalla.
 * Adoptar es barato y seguro porque solo AGREGAMOS atributos: el layout no se
 * toca.
 */
function findStage(html, isCode) {
  const tags = scanOpenTags(html, isCode);

  const porId = tags.filter((t) => {
    const a = parseAttrs(t.text).get('id');
    return a && a.value === 'stage';
  });
  if (porId.length === 1) return { tag: porId[0] };
  if (porId.length > 1) return { problem: PROBLEM.MANY_STAGES };

  const porContrato = tags.filter((t) => parseAttrs(t.text).has('data-composition-id'));
  if (porContrato.length === 1) {
    return { tag: porContrato[0], adopted: 'la raíz venía marcada con data-composition-id en vez de id="stage"' };
  }
  if (porContrato.length > 1) return { problem: PROBLEM.MANY_STAGES };

  const raiz = topLevelElements(html, isCode);
  if (raiz.length === 1) {
    return { tag: raiz[0], adopted: 'se adoptó como contenedor el único elemento que cuelga del <body>' };
  }
  return { problem: PROBLEM.NO_STAGE };
}

// ¿Hay una timeline de GSAP que registrar? Si la composición anima con CSS o
// WAAPI no hay NADA que registrar: el motor saca la duración de data-duration y
// un `window.__timelines` vacío es correcto, no un defecto. Tratar los dos casos
// igual mandaba al modelo composiciones que estaban bien.
function hasGsapTimeline(html, isCode) {
  const re = /gsap\s*\.\s*timeline\s*\(/g;
  let m;
  while ((m = re.exec(html))) if (isCode(m.index)) return true;
  return false;
}

// Aplica ediciones {start, end, text} de atrás hacia adelante, así los índices de
// las anteriores siguen siendo válidos. Concatena porciones: ningún `$` se
// interpreta.
function applyEdits(text, edits) {
  return edits
    .slice()
    .sort((a, b) => b.start - a.start)
    .reduce((acc, e) => acc.slice(0, e.start) + e.text + acc.slice(e.end), text);
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Lee la composición, le completa el andamiaje que falte y dice si quedó lista.
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {number} [opts.durationSec] Duración real del marcador: la sabemos mejor
 *        que el modelo, así que si falta o vino en 0 se inyecta ésta.
 * @param {string} [opts.markerSlug] Nombre de respaldo para el id, si ni el stage
 *        ni el script traen uno.
 * @returns {{html: string, fixes: string[], problem: string|null}}
 *          `fixes` describe qué se completó (para el log).
 *          `problem` es un código de PROBLEM cuando NO se pudo completar; null si
 *          la composición está lista para renderizar.
 */
function inspectComposition(html, opts) {
  opts = opts || {};
  const out = String(html || '');
  const durationSec = Number(opts.durationSec || 0);

  const isCode = outsideComments(out);
  const hallazgo = findStage(out, isCode);
  if (!hallazgo.tag) return { html: out, fixes: [], problem: hallazgo.problem, duration: 0 };

  const stage = hallazgo.tag;
  const attrs = parseAttrs(stage.text);
  const fixes = [];
  const tagEdits = [];
  if (hallazgo.adopted) fixes.push(hallazgo.adopted);

  // Duración declarada por el modelo. Se lee acá arriba porque todas las
  // salidas la informan, incluidas las que cortan por un problema.
  const declared = parseFloat(attrs.has('data-duration') ? attrs.get('data-duration').value : '') || 0;

  // Escribe un atributo del stage: si ya está se reemplaza su valor en su lugar,
  // si no se encola para agregarlo antes del '>' de cierre (todos los agregados
  // entran en UNA sola inserción, para que queden en orden). Escribir el mismo
  // valor no genera edición: un HTML que ya cumple vuelve IDÉNTICO.
  const appended = [];
  function writeAttr(name, value) {
    const at = attrs.get(name);
    if (at) {
      if (at.value === value) return false;
      tagEdits.push({ start: at.start, end: at.end, text: value });
    } else {
      appended.push(name + '="' + value + '"');
    }
    return true;
  }

  // El registro de la timeline: window.__timelines[<clave>] = <algo>. La clave es
  // un identificador interno que nadie lee de afuera, así que si apunta al id
  // equivocado se puede reescribir como literal, sea un literal, sea COMP_ID, sea
  // una expresión que no sabemos resolver: eso último era el único caso que antes
  // obligaba a volver al modelo, y ahora se arregla acá.
  const regRe = /__timelines\s*\[\s*([^\]]+?)\s*\]\s*=/g;
  const regs = [];
  let rm;
  while ((rm = regRe.exec(out))) {
    if (!isCode(rm.index)) continue; // la auditoría del modelo lo menciona en prosa
    const keyText = rm[1];
    const keyStart = rm.index + rm[0].indexOf(keyText, '__timelines'.length);
    regs.push({ keyText: keyText, start: keyStart, end: keyStart + keyText.length });
  }
  if (regs.length > 1) {
    // Varios registros con un solo stage: no se sabe cuál es el de esta
    // composición, y elegir mal deja el video congelado.
    return { html: out, fixes: fixes, problem: PROBLEM.MANY_REGISTRATIONS, duration: declared };
  }
  if (!regs.length && hasGsapTimeline(out, isCode)) {
    // Hay una timeline armada pero sin registrar, y el registro no se inventa:
    // habría que adivinar el nombre de la variable Y que esté en el alcance
    // donde insertemos el código. Si erramos, el render no falla rápido — sale
    // un video congelado. Para esto sí se vuelve al modelo.
    return { html: out, fixes: fixes, problem: PROBLEM.NO_REGISTRATION, duration: declared };
  }

  // Sin registro y sin GSAP no falta nada: la composición anima con CSS o WAAPI
  // y al motor le alcanza con data-duration.
  const reg = regs[0] || null;

  // A qué id apunta hoy el registro: el literal si es literal, o el valor de la
  // variable si la podemos resolver. `undefined` = no resolvable (una expresión).
  const literalKey = reg ? (reg.keyText.match(/^["']([^"']*)["']$/) || [])[1] : undefined;
  const keyValue = !reg ? undefined
    : (literalKey !== undefined ? literalKey : scanStringVars(out, isCode).get(reg.keyText));

  // 1) Id de la composición. Manda el del stage (es lo que escanea el motor); si
  //    no tiene, se adopta el que ya usa el script para no romper su registro.
  const stageId = attrs.has('data-composition-id') ? attrs.get('data-composition-id').value : '';
  const id = stageId || keyValue || String(opts.markerSlug || '') || 'comp';
  if (writeAttr('data-composition-id', id)) fixes.push('data-composition-id="' + id + '"');

  // 2) Duración. La del marcador es la verdad; el modelo a veces la omite o pone 0.
  if (!(declared > 0) && durationSec > 0) {
    const dur = String(round2(durationSec));
    if (writeAttr('data-duration', dur)) fixes.push('data-duration="' + dur + '"');
  }

  // 3) Resto del esqueleto, con los valores que manda la plantilla.
  for (const name of Object.keys(SKELETON)) {
    if (!attrs.has(name) && writeAttr(name, SKELETON[name])) {
      fixes.push(name + '="' + SKELETON[name] + '"');
    }
  }

  // 4) El registro tiene que apuntar al MISMO id que el stage. Si no coinciden, el
  //    motor busca una timeline que no existe y el render sale CONGELADO: pasa
  //    cualquier chequeo de "existe __timelines" y es un video estático.
  //    Si ya apunta bien (el caso normal: COMP_ID con el valor correcto) no se
  //    toca nada — el HTML tiene que volver idéntico cuando está sano.
  const docEdits = [];
  if (reg && keyValue !== id) {
    docEdits.push({ start: reg.start, end: reg.end, text: "'" + id + "'" });
    fixes.push('el registro de la timeline apuntaba a ' +
      (keyValue === undefined ? reg.keyText + ' (no resolvible)' : '"' + keyValue + '"') +
      ' y el stage a "' + id + '": alineado');
  }

  if (appended.length) {
    const closeAt = stage.text.length - 1; // antes del '>' que cierra el tag
    tagEdits.push({ start: closeAt, end: closeAt, text: ' ' + appended.join(' ') });
  }

  // El tag se reescribe entero (con sus ediciones aplicadas) como una edición más
  // del documento, así todas las posiciones son del texto original.
  if (tagEdits.length) {
    docEdits.push({
      start: stage.index,
      end: stage.index + stage.text.length,
      text: applyEdits(stage.text, tagEdits),
    });
  }

  const repaired = docEdits.length ? applyEdits(out, docEdits) : out;

  // Con el registro presente y alineado, y el stage con su id, lo único que puede
  // faltar es la duración: y solo si el modelo no la puso Y a nosotros tampoco nos
  // pasaron la del marcador (los dos llamadores la validan antes, así que esto es
  // un cinturón).
  const finalDuration = declared > 0 ? declared : round2(durationSec);
  // `duration` sale también hacia afuera: es el único lugar del código que sabe
  // leer la duración declarada de una composición, y la pestaña Corrections la
  // necesita para los recursos viejos a los que les falta la ficha.
  return { html: repaired, fixes: fixes, problem: finalDuration > 0 ? null : PROBLEM.NO_DURATION, duration: finalDuration };
}

module.exports = { inspectComposition, auditFailure, PROBLEM };
