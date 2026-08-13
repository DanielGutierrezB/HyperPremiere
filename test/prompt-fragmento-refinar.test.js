'use strict';

// Qué del guion llega al modelo cuando se REFINA (feedback y correcciones).
//
// Refinar usa prompt "lean": el transcript completo de la clase NO se reenvía,
// porque el modelo ya tiene el diseño previo y reenviarlo entero son miles de
// tokens por ronda. Lo que NUNCA puede caerse en ese ahorro es el FRAGMENTO DEL
// MARCADOR: es lo único que dice qué se está diciendo mientras el recurso está
// en pantalla y en qué segundo de la animación pasa cada cosa. Sin él, refinar
// "el título entra tarde" es pedirle que ajuste tiempos a ciegas.

const { test, ok, eq, has } = require('./harness');
const { buildUserPrompt } = require('../bridge/prompt/build-context');

const CLASE = [
  { start: 5, end: 12, text: 'arrancamos con la introducción del curso' },
  { start: 128, end: 132, text: 'y acá vemos las ventas por trimestre' },
  { start: 132, end: 136, text: 'fijate el salto del último' },
  { start: 300, end: 310, text: 'esto ya es el cierre' },
];

const MARCADOR = { name: 'Gráfico de barras', start: 128.5, duration: 7 };
/** El tramo del marcador, como lo recorta el panel antes de mandarlo. */
const FRAGMENTO = [CLASE[1], CLASE[2]];

function refinar(extra) {
  return buildUserPrompt(Object.assign({
    objective: 'enseñar a leer un reporte de ventas',
    transcriptSegments: CLASE,
    marker: MARCADOR,
    markerTranscript: FRAGMENTO,
    instruction: 'un gráfico de barras con las ventas',
    lean: true, // refinamiento
  }, extra));
}

test('refinando, el fragmento del marcador viaja igual', function () {
  const p = refinar();
  has(p, 'Fragmento del marcador');
  has(p, 'y acá vemos las ventas por trimestre');
  has(p, 'fijate el salto del último', 'las dos líneas del tramo, no solo la primera');
});

test('refinando, el transcript COMPLETO de la clase no viaja', function () {
  // Es el ahorro que justifica el prompt lean.
  const p = refinar();
  eq(p.indexOf('Transcript completo de la clase'), -1);
  eq(p.indexOf('esto ya es el cierre'), -1, 'nada de fuera del tramo');
});

test('los tiempos del fragmento son RELATIVOS al arranque del recurso', function () {
  // El modelo compone una timeline que empieza en 0: si le llegaran los segundos
  // del timeline de Premiere (128.5), timaría todo 128 segundos tarde.
  const p = refinar();
  eq(p.indexOf('128'), -1, 'ningún segundo del timeline de la clase');
  has(p, 't=0', 'se le dice que t=0 es el arranque de la composición');
});

test('sin fragmento se dice que no hay, no se calla', function () {
  // Pasa corrigiendo un recurso cuyo corte ya no tiene transcript en ninguna
  // parte. El prompt tiene que dejarlo explícito: el modelo compone sin guion,
  // pero no creyendo que el tramo era mudo... ni inventando que lo tiene.
  const p = refinar({ markerTranscript: [] });
  has(p, 'Fragmento del marcador', 'la sección sigue estando');
  ok(/\(sin (transcript|texto|diálogo)[^)]*\)/i.test(p), 'y dice que ahí no hay guion');
});

test('generando de cero sí va la clase entera, que es la diferencia', function () {
  const p = refinar({ lean: false });
  has(p, 'Transcript completo de la clase');
  has(p, 'Fragmento del marcador', 'y el fragmento también, en los dos modos');
});
