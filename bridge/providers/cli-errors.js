'use strict';

// Qué falló DE VERDAD cuando un CLI de agente cierra mal, dicho para un editor
// de video.
//
// El motivo casi nunca está donde uno lo busca. Los CLIs de agente (claude,
// cursor-agent) corren con `--output-format json` / `stream-json`: cuando algo
// sale mal escriben el error en STDOUT, adentro del JSON, y dejan stderr vacío.
// Un mensaje que solo mira stderr termina diciendo "stderr: (vacío)" y tira a
// la basura la única explicación que llegó — que es exactamente lo que le pasó
// a un editor en Windows con "salió con código 1" y nada más.
//
// Acá viven las dos mitades de arreglar eso:
//   legible(texto)  — saca la frase humana de adentro del JSON (o de las N
//                     líneas del stream-json, quedándose con la última que dice
//                     algo), para no escupirle un bloque crudo al editor.
//   causa(texto)    — le pone nombre al modo de falla ('sesion', 'cuota',
//                     'modelo', 'permisos') para que el proveedor pueda decir el
//                     próximo paso concreto en vez de un código de salida pelado.
//
// No sabe nada de Claude ni de Cursor: el texto que ve el editor lo arma cada
// proveedor, que es el que conoce su comando de login y su selector de modelos.

// Tope de lo que se cita. Alcanza para la frase del CLI y no convierte el
// cartel del panel en un volcado de log.
const MAX = 400;

function recortar(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, MAX);
}

/**
 * La frase legible de UN objeto del CLI. Los errores viajan en cuatro formas
 * distintas según quién los emita (el CLI, la API de Anthropic, el backend de
 * Cursor), así que se prueban todas antes de rendirse.
 * @param {object} obj
 * @returns {string} '' si el objeto no dice nada aprovechable
 */
function mensaje(obj) {
  if (!obj || typeof obj !== 'object') return '';

  const e = obj.error;
  if (typeof e === 'string' && e.trim()) return recortar(e);
  if (e && typeof e === 'object') {
    if (typeof e.message === 'string' && e.message.trim()) return recortar(e.message);
    if (typeof e.type === 'string' && e.type.trim()) return recortar(e.type);
  }
  if (typeof obj.message === 'string' && obj.message.trim()) return recortar(obj.message);
  // `result` es el campo del cierre: con is_error trae el motivo (y sin él, la
  // respuesta del modelo — por eso esto solo se usa en caminos de falla).
  if (typeof obj.result === 'string' && obj.result.trim()) return recortar(obj.result);
  // Último recurso: a veces el CLI solo etiqueta el modo de falla.
  if (obj.is_error && typeof obj.subtype === 'string' && obj.subtype.trim()) {
    return recortar(obj.subtype.replace(/_/g, ' '));
  }
  return '';
}

/** Todos los objetos JSON que hay en el texto (uno entero, o uno por línea). */
function objetos(texto) {
  const t = String(texto || '').trim();
  if (!t) return [];

  try {
    const o = JSON.parse(t);
    if (o && typeof o === 'object') return [o];
  } catch (e) {
    // No era un JSON entero: puede ser stream-json (una línea por evento).
  }

  const salida = [];
  t.split('\n').forEach((linea) => {
    const s = linea.trim();
    if (!s || s.charAt(0) !== '{') return;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') salida.push(o);
    } catch (e) {
      // Una línea cortada a la mitad no vale la pena; hay más.
    }
  });
  return salida;
}

/**
 * El motivo, en castellano de humano, de lo que sea que haya escrito el CLI.
 * Con stream-json se queda con el ÚLTIMO objeto que dice algo: los primeros son
 * el arranque y las herramientas, el que explica el final es el de más abajo.
 * @param {string} texto
 * @returns {string}
 */
function legible(texto) {
  const t = String(texto || '').trim();
  if (!t) return '';

  const objs = objetos(t);
  for (let i = objs.length - 1; i >= 0; i--) {
    const m = mensaje(objs[i]);
    if (m) return m;
  }

  // No era JSON (o el JSON no dijo nada): quedan las líneas que un humano puede
  // leer. Si tampoco hay, se cita el crudo antes que quedarse mudo.
  const sueltas = t.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l.charAt(0) !== '{')
    .join(' ');
  return recortar(sueltas || t);
}

/**
 * Las ETIQUETAS del fallo: los campos cortos con que el CLI y la API le ponen
 * nombre al modo de error ("not_found_error", "error_during_execution").
 *
 * Van aparte de la frase porque sirven para clasificar, no para mostrar — y
 * porque son la única parte del stdout que se puede leer sin arrastrar lo que
 * escribió el modelo, que con el estado en vivo está en el mismo flujo.
 * @param {string} texto
 * @returns {string}
 */
function etiquetas(texto) {
  return objetos(texto)
    .map((o) => {
      const e = o && o.error;
      const tipo = (e && typeof e === 'object' && typeof e.type === 'string') ? e.type : '';
      const sub = (o && o.is_error && typeof o.subtype === 'string') ? o.subtype : '';
      return [tipo, sub].filter(Boolean).join(' ');
    })
    .filter(Boolean)
    .join(' ');
}

/**
 * Lo que dejó dicho un proceso terminado, mire donde mire.
 * stderr primero (es donde va el error cuando el programa se porta bien) y
 * stdout después (que es donde lo escriben estos CLIs cuando salen en JSON).
 * @param {{out?:string, err?:string}} r - lo que devuelve run() de exec.js
 * @returns {string}
 */
function deProceso(r) {
  return legible((r && r.err) || '') || legible((r && r.out) || '');
}

// Modos de falla que merecen un mensaje propio: son los que tienen un próximo
// paso distinto. El orden importa — un 401 es falta de sesión, no cuota.
const MODOS = [
  ['sesion', /invalid api ?key|please run \/login|not logged ?in|unauthoriz|unauthenticat|\b401\b|authentication_error|oauth[^\n]{0,20}(expired|invalid|missing)|token[^\n]{0,20}expired|api key not found|missing api key|no api key|credentials? (not found|missing)|run `?claude (setup-token|login)/i],
  ['cuota', /usage limit reached|rate.?limit|\b429\b|quota|credit balance is too low|insufficient (credits?|balance|quota)|too many requests/i],
  ['modelo', /model[^\n]{0,40}(not found|does not exist|not exist|unknown|invalid|unsupported|no such)|(unknown|invalid|unrecognized|unsupported)[^\n]{0,20}model|not_found_error/i],
  ['permisos', /permission denied|\bEACCES\b|\bEPERM\b|operation not permitted|access is denied|acceso denegado|permiso denegado/i],
];

/**
 * Nombre del modo de falla, o '' si no lo reconocemos.
 * Se lo alimenta con TODO lo que escribió el proceso (stderr + stdout crudos):
 * la pista puede estar en cualquiera de los dos.
 * @param {string} texto
 * @returns {'sesion'|'cuota'|'modelo'|'permisos'|''}
 */
function causa(texto) {
  const t = String(texto || '');
  if (!t.trim()) return '';
  for (const [nombre, re] of MODOS) {
    if (re.test(t)) return nombre;
  }
  return '';
}

module.exports = { legible, mensaje, etiquetas, deProceso, causa };
