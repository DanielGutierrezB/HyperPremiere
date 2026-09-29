'use strict';

// `--motor <id>` para los arneses de prompt.
//
// Los cuatro arneses que verifican QUÉ recibe el modelo —los tres niveles del
// contexto, las referencias, las menciones y los ocho caminos— tienen que poder
// correr con los dos motores. No porque el contexto cambie (no cambia: el
// objetivo, el transcript y la instrucción del editor son los mismos), sino
// porque el pedido se ARMA distinto: el contrato, el bloque de assets y el
// system prompt los escribe el motor, y un camino que se quedara atrás no
// falla, sale un recurso sin la marca y se descubre viendo el video.
//
// Vive en un archivo suyo y no copiado cuatro veces porque la decisión es una:
// qué motor eligió quien corre esto, y qué hacer si nombró uno que no existe.
// Con cuatro copias, la quinta vez que se agregue un motor tres arneses lo
// ignoran en silencio.

const motores = require('../../bridge/render');

/**
 * El motor que se pidió por línea de comandos.
 *
 * Sin `--motor`, el de siempre: los arneses se corrían así antes de que hubiera
 * dos y tienen que seguir contestando lo mismo cuando nadie elige nada.
 *
 * Un id que no existe CORTA en vez de caer al de siempre. Es al revés que en el
 * panel, y a propósito: allá un id raro viene de un disco viejo y lo importante
 * es que el editor pueda trabajar; acá lo escribió una persona hace dos
 * segundos, y darle silenciosamente la medición del otro motor es peor que no
 * darle ninguna.
 */
function motorElegido(argv) {
  const args = argv || process.argv;
  const i = args.indexOf('--motor');
  if (i === -1) return motores.motor(motores.PREDETERMINADO);
  const id = String(args[i + 1] || '').trim().toLowerCase();
  if (!motores.existe(id)) {
    console.error('No conozco el motor "' + id + '". Los que hay: ' + motores.ids().join(', '));
    process.exit(1);
  }
  return motores.motor(id);
}

module.exports = { motorElegido };
