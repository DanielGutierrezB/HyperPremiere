'use strict';

// Lo que sobrevive al ⟳ del panel: las referencias a procesos que están
// CORRIENDO.
//
// El problema, tal como pasa
// --------------------------
// El motor corre adentro del panel, y `cep/js/engine-client.js` borra la caché
// de `require` de todo `bridge/` en cada recarga y vuelve a requerir. Pero el
// proceso de Node NO se reinicia con `location.reload()`: sigue siendo el mismo.
// Entonces, con un dictado en curso al tocar ⟳:
//
//   - la instancia VIEJA del módulo se queda con su bucle, su ffmpeg con el
//     micrófono abierto y su Whisper transcribiendo cada segundo y medio.
//     Nadie puede pararla, porque el panel nuevo tiene otra instancia con todas
//     sus variables en null. Corta sola a los cinco minutos, le devuelve el
//     resultado a nadie y recién ahí suelta los ~500 MB del modelo.
//   - la instancia NUEVA cree que no hay nada abierto, así que el editor puede
//     dictar otra vez y levantar un SEGUNDO Whisper y un segundo ffmpeg sobre
//     el mismo micrófono.
//
// O sea que "hay un solo micrófono" —la invariante que sostiene el dictado y
// que el selector de ⚙ refuerza con su exclusión mutua entre prueba y dictado—
// valía por instancia de módulo, no por proceso. Y una invariante que se puede
// duplicar recargando la ventana no es una invariante.
//
// El arreglo
// ----------
// Las referencias vivas cuelgan de `process`, que es lo único que de verdad dura
// lo que dura el micrófono abierto. Cada módulo pide su caja con `adoptar()` al
// cargarse y, si encuentra una anterior, la BAJA antes de seguir: para cuando la
// instancia nueva existe, la vieja no tiene nada corriendo.
//
// Por qué acá y no un `dispose()` que llame el panel antes de borrar la caché
// (la otra forma de arreglarlo): esto no depende de que nadie llame a nada. El
// panel puede recargarse, puede reventar a mitad de la carga, o puede requerir
// el motor por otra ruta candidata — y la cuenta sigue dando uno. Lo que se
// arregla es la invariante, no el camino por el que se rompía esta vez.
//
// Lo que NO va acá: las cachés. Que `sondearMaquina` o la elección de refinador
// se vuelvan a calcular después de un ⟳ es correcto — ⟳ es exactamente cuando el
// editor pudo haber instalado Whisper o cambiado la config. Acá van los procesos
// y nada más.

const CAJA = '__hpVivos';

/**
 * La caja de estado vivo de un módulo, bajando la de la instancia anterior.
 *
 * @param {string} clave - quién la pide ('dictado', 'transcribe'…)
 * @param {object} [inicial] - los campos de la caja, todos en su valor de reposo
 * @returns {object} la caja nueva. Ponerle un `bajarTodo(porQue)` es lo que hace
 *   que la instancia SIGUIENTE la pueda apagar; una caja sin eso no se baja.
 */
function adoptar(clave, inicial) {
  const caja = process[CAJA] || (process[CAJA] = {});
  const previo = caja[clave];
  if (previo && typeof previo.bajarTodo === 'function') {
    // Nunca lanza: si bajar lo viejo falla, lo que NO puede pasar es que además
    // se caiga la carga del módulo nuevo y el panel se quede sin motor.
    try { previo.bajarTodo('el panel se recargó y este módulo quedó huérfano'); } catch (e) {}
  }
  const nueva = inicial || {};
  caja[clave] = nueva;
  return nueva;
}

/** La caja de todos, para los tests. En producción nadie la mira. */
function _cajas() { return process[CAJA] || {}; }

module.exports = { adoptar, _cajas };
