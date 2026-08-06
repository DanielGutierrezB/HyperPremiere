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
// la duración y el registro de la timeline. Eso casi siempre se completa en
// código, con la misma salida visual y en microsegundos. Solo se vuelve al modelo
// cuando falta algo que no se puede inferir sin riesgo (ver repairComposition).

'use strict';

// El <div id="stage"> puede abarcar varias líneas: [^>] incluye saltos.
const STAGE_RE = /<div\b[^>]*\bid\s*=\s*["']stage["'][^>]*>/i;

// Valores del esqueleto obligatorio (ver bridge/prompt/system.md, "PLANTILLA
// OBLIGATORIA"). Todo el pipeline es 1080p30.
const SKELETON = [
  ['data-start', '0'],
  ['data-width', '1920'],
  ['data-height', '1080'],
  ['data-fps', '30'],
];

/**
 * ¿Cumple el mínimo que necesita el motor para renderizar con animación?
 * Ojo: esto NO detecta que el id del stage y el del registro no coincidan; de eso
 * se encarga repairComposition, porque pasa el chequeo y renderiza CONGELADO.
 */
function isValidComposition(html) {
  const h = String(html || '');
  return Boolean(html) &&
    /data-composition-id/.test(h) &&
    /data-duration\s*=\s*["']?\s*[0-9.]*[1-9]/.test(h) &&
    /__timelines/.test(h);
}

/**
 * Auditoría del propio modelo (ver system.md, "PLAN → CÓDIGO → AUDITORÍA"): si
 * declaró una falla concreta de diseño, devuelve qué falló para pedir UNA
 * corrección dirigida. null = auditoría OK o ausente.
 */
function auditFailure(html) {
  const m = String(html || '').match(/<!--\s*AUDIT:\s*FALLA:?\s*([\s\S]*?)-->/i);
  return m ? m[1].trim().slice(0, 400) : null;
}

function attrOf(tag, name) {
  const m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i'));
  return m ? m[1] : null;
}

function setAttr(tag, name, value) {
  const re = new RegExp('(\\b' + name + '\\s*=\\s*["\'])([^"\']*)(["\'])', 'i');
  if (re.test(tag)) return tag.replace(re, '$1' + value + '$3');
  return tag.replace(/\s*\/?>$/, ' ' + name + '="' + value + '">');
}

// Reemplazo por índice, no por String.replace: el HTML puede traer `$&` o `$1`
// en el CSS o en el texto, y como *reemplazo* esas secuencias son especiales y
// corromperían la salida.
function spliceAt(text, index, oldLength, replacement) {
  return text.slice(0, index) + replacement + text.slice(index + oldLength);
}

// El id que ya usa el script, para no inventar uno distinto del que el diseño
// registra. Primero COMP_ID, después la clave literal del registro.
function idFromScript(html) {
  let m = html.match(/\bCOMP_ID\s*=\s*["']([^"']+)["']/);
  if (m) return m[1];
  m = html.match(/__timelines\s*\[\s*["']([^"']+)["']\s*\]/);
  return m ? m[1] : null;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Completa el andamiaje que falte, dejando el diseño intacto.
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {number} [opts.durationSec] Duración real del marcador: la sabemos mejor
 *        que el modelo, así que si falta o vino en 0 se inyecta ésta.
 * @returns {{html: string, fixes: string[], valid: boolean, blocked: string|null}}
 *          `fixes` describe qué se completó (para el log).
 *          `blocked` explica por qué NO se pudo completar, si sigue inválida.
 */
function repairComposition(html, opts) {
  const fixes = [];
  let out = String(html || '');
  const durationSec = Number((opts && opts.durationSec) || 0);

  const stageMatches = out.match(/\bid\s*=\s*["']stage["']/gi) || [];
  if (stageMatches.length !== 1) {
    // Sin stage único no se puede saber qué reparar (o es una composición con
    // sub-composiciones, que no es lo que generamos): mejor no tocar nada.
    return {
      html: out,
      fixes: fixes,
      valid: isValidComposition(out),
      blocked: stageMatches.length ? 'hay ' + stageMatches.length + ' elementos con id="stage"' : 'no encontré el <div id="stage">',
    };
  }

  const stage = out.match(STAGE_RE);
  if (!stage) {
    return { html: out, fixes: fixes, valid: isValidComposition(out), blocked: 'no pude leer la etiqueta del <div id="stage">' };
  }

  let tag = stage[0];
  const before = tag;

  // 1) Id de la composición. El del stage manda (es lo que escanea el motor); si
  //    no tiene, se adopta el que ya usa el script para no romper su registro.
  let id = attrOf(tag, 'data-composition-id');
  const scriptId = idFromScript(out);
  if (!id) {
    id = scriptId || 'comp';
    tag = setAttr(tag, 'data-composition-id', id);
    fixes.push('data-composition-id="' + id + '"');
  }

  // 2) Duración. La del marcador es la verdad; el modelo a veces la omite o pone 0.
  const declared = parseFloat(attrOf(tag, 'data-duration'));
  if (!(declared > 0) && durationSec > 0) {
    tag = setAttr(tag, 'data-duration', String(round2(durationSec)));
    fixes.push('data-duration="' + round2(durationSec) + '"');
  }

  // 3) Resto del esqueleto, con los valores que manda la plantilla.
  for (const pair of SKELETON) {
    if (attrOf(tag, pair[0]) === null) {
      tag = setAttr(tag, pair[0], pair[1]);
      fixes.push(pair[0] + '="' + pair[1] + '"');
    }
  }

  if (tag !== before) out = spliceAt(out, stage.index, before.length, tag);

  // 4) El registro de la timeline tiene que usar el MISMO id que el stage. Si no
  //    coinciden, el motor busca una timeline que no existe y el render sale
  //    CONGELADO: pasa la validación pero es un video estático. Alinearlo salva
  //    un marcador entero (minutos de modelo + el render completo).
  const reg = out.match(/__timelines\s*\[\s*([^\]]+?)\s*\]\s*=/);
  if (reg) {
    const key = reg[1].trim();
    const literal = key.match(/^["']([^"']+)["']$/);
    if (literal) {
      if (literal[1] !== id) {
        const at = reg.index + reg[0].indexOf(literal[0]);
        out = spliceAt(out, at, literal[0].length, "'" + id + "'");
        fixes.push('el registro apuntaba a "' + literal[1] + '" y el stage a "' + id + '": alineado');
      }
    } else if (/^COMP_ID$/.test(key) && scriptId && scriptId !== id) {
      // Registra con la variable: se alinea el literal de COMP_ID.
      const decl = out.match(/(\bCOMP_ID\s*=\s*["'])([^"']+)(["'])/);
      if (decl) {
        const at = decl.index + decl[1].length;
        out = spliceAt(out, at, decl[2].length, id);
        fixes.push('COMP_ID era "' + scriptId + '" y el stage "' + id + '": alineado');
      }
    }
    // Cualquier otra variable no se puede resolver sin ejecutar el script: se
    // deja como está (tocarla a ciegas es peor que dejarla).
  }

  const valid = isValidComposition(out);
  let blocked = null;
  if (!valid) {
    // Lo único que queda sin reparar acá es la ausencia TOTAL del registro. No se
    // completa a ciegas: habría que adivinar el nombre de la variable de la
    // timeline Y que esté en el alcance donde insertemos el código. Si nos
    // equivocamos, el render no falla rápido — sale un video roto. Para este caso
    // se vuelve al modelo, pero pidiéndole un arreglo dirigido sobre SU html.
    blocked = /__timelines/.test(out)
      ? 'el contrato sigue incompleto'
      : 'la composición no registra su timeline en window.__timelines';
  }
  return { html: out, fixes: fixes, valid: valid, blocked: blocked };
}

module.exports = { isValidComposition, repairComposition, auditFailure, STAGE_RE };
