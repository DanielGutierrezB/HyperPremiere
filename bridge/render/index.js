// La puerta de los motores: cargarlos y devolver el registro.
//
// Existe para que haya UN solo `require` que despierte a los dos. El registro
// (`motores.js`) es un mapa vacío hasta que alguien carga los módulos que se
// anotan en él, y si cada consumidor tuviera que acordarse de requerir los dos,
// el día que entre el tercero habría que encontrarlos a todos. Con esto, el que
// quiere un motor pide `require('./render')` y ya están todos.

'use strict';

const motores = require('./motores');

// El orden en que se cargan es el orden en que se ofrecen en ⚙.
require('./motor-hyperframes');
require('./motor-remotion');

module.exports = motores;
