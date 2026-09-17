#!/usr/bin/env node
'use strict';

// ¿Está el código como debe, o quedó una mutación puesta?
//
//   node test/manual/mutaciones-verificar.js
//
// Para cada mutación de `mutaciones-render.js` comprueba que su `de` —el texto
// ORIGINAL— siga estando en su archivo, y avisa fuerte si lo que está es el `a`,
// que es la señal de que una corrida quedó a medio camino (se cortó entre
// escribir la mutación y restaurar el archivo).
//
// Existe porque el corredor de mutaciones restaura en un `finally`, y un
// `finally` no corre si al proceso lo matan: cortar una corrida de trescientas
// mutaciones —tarda unas tres horas— es algo que se hace, y después hay que poder
// contestar «¿el repo está limpio?» sin leer trescientos diffs.
//
// Un `de` que no está y un `a` que tampoco es otra cosa y no es un problema: es
// una mutación vieja que ya no aplica porque el código cambió. Se cuenta aparte,
// que es la lista de las que hay que actualizar.

const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..', '..');
const fuente = fs.readFileSync(path.join(__dirname, 'mutaciones-render.js'), 'utf8');

// El array se lee del propio archivo: el corredor no exporta nada (es un script),
// y requerirlo lo haría CORRER, que es lo último que se quiere de una
// herramienta que contesta si el árbol está limpio.
const desde = fuente.indexOf('const MUTACIONES = [');
const hasta = fuente.indexOf('\n];', desde);
if (desde === -1 || hasta === -1) {
  console.error('No encontré el array MUTACIONES en mutaciones-render.js');
  process.exit(2);
}
// eslint-disable-next-line no-eval
const MUTACIONES = eval(fuente.slice(desde + 'const MUTACIONES = '.length, hasta + 2));

let puestas = 0;
let viejas = 0;
const cache = {};
MUTACIONES.forEach(function (m) {
  const p = path.join(raiz, m.archivo);
  if (!cache[p]) cache[p] = fs.readFileSync(p, 'utf8');
  const txt = cache[p];
  if (txt.indexOf(m.de) !== -1) return;
  // El `a` se busca PEGADO A UN SALTO DE LÍNEA, y no en cualquier lado. Sin eso,
  // una mutación vieja cuyo `a` es un pedazo de una línea que todavía existe con
  // otra sangría se cuenta como "puesta": pasó con una de `prompt-card.js`, cuyo
  // `a` era la misma línea con dos espacios menos. Y una restauración hecha sobre
  // ese diagnóstico ROMPE el archivo, que es exactamente lo contrario de lo que
  // esta herramienta viene a hacer.
  if (txt.indexOf('\n' + m.a) !== -1) {
    puestas++;
    console.log('  !!!  MUTACIÓN PUESTA en ' + m.archivo + ': «' + m.nombre + '»');
    console.log('       Restaurala antes de seguir (el `de` de esa mutación es el original).');
  } else {
    viejas++;
    console.log('  ??   ya no aplica: «' + m.nombre + '» (' + m.archivo + ')');
  }
});

console.log('\n' + MUTACIONES.length + ' mutaciones · ' + puestas + ' puestas en el código · ' +
  viejas + ' que ya no aplican');
process.exitCode = puestas ? 1 : 0;
