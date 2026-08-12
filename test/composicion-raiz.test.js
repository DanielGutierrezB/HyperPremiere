'use strict';

// Encontrar el contenedor de la composición cuando el modelo no siguió la plantilla.
//
// Caso real: en una tanda de tres marcadores, dos salieron sin `<div id="stage">`.
// El reparador solo sabía buscar ese id exacto, así que se rindió; se gastó una
// llamada extra al modelo que tampoco cumplió; y después se mandó igual a
// renderizar. El render falló tres veces seguidas con "Composition has zero
// duration", que el propio CLI marca como permanente.
//
// `id="stage"` es una convención NUESTRA: lo que el motor mira es
// `data-composition-id`. Así que cuando la raíz es reconocible por otro lado, se
// adopta y no se gasta ni una llamada. Cuando hay dudas, NO se adivina: elegir
// mal la raíz no falla rápido, deja el diseño roto en pantalla.

const { test, ok, eq } = require('./harness');
const { inspectComposition, PROBLEM } = require('../bridge/composition');

function doc(cuerpo, script) {
  return '<!DOCTYPE html>\n<html><head><style>.a{color:red}</style></head><body>\n' +
    cuerpo + '\n' + (script ? '<script>' + script + '</script>' : '') + '\n</body></html>';
}

const TL = "const tl = gsap.timeline(); window.__timelines['x'] = tl;";

function revisar(html) {
  return inspectComposition(html, { durationSec: 12.5, markerSlug: 'marcador-3' });
}

test('la raíz marcada como manda el contrato se adopta, aunque no se llame "stage"', function () {
  // 5 de las composiciones que miré marcaban la raíz con data-composition-id y
  // le ponían otro id. Eso ya cumple el contrato del motor.
  const r = revisar(doc('<div id="main" data-composition-id="intro">hola</div>', TL));
  eq(r.problem, null, 'no debería mandar esto de vuelta al modelo');
  ok(/data-width="1920"/.test(r.html), 'le completa el esqueleto que falta');
});

test('sin ninguna marca, se adopta el único elemento que cuelga del body', function () {
  // Adoptar es seguro porque solo AGREGAMOS atributos: el layout no se toca.
  const r = revisar(doc('<div class="wrap"><h1>Hola</h1></div>', TL));
  eq(r.problem, null, 'con un solo candidato no hay ambigüedad');
  // El id sale de la clave que el script YA usa para registrar: inventar otro
  // dejaría el registro apuntando a una composición que no existe.
  ok(/data-composition-id="x"/.test(r.html), 'toma el id del registro para no romperlo');
  ok(/data-duration="12.5"/.test(r.html), 'y la duración real del marcador');
});

test('si no hay registro del que copiar el id, se usa el nombre del marcador', function () {
  const r = revisar(doc('<div class="wrap">animado por CSS</div>'));
  eq(r.problem, null, 'sin GSAP no falta registro');
  ok(/data-composition-id="marcador-3"/.test(r.html), 'el nombre del marcador es el respaldo');
});

test('con dos elementos sueltos en el body NO se adivina cuál es la composición', function () {
  const r = revisar(doc('<div class="fondo"></div><div class="contenido">Hola</div>', TL));
  eq(r.problem, PROBLEM.NO_STAGE, 'elegir mal la raíz deja el diseño roto, mejor preguntar');
});

test('el <div id="stage"> de la plantilla sigue teniendo prioridad', function () {
  // Si el modelo puso los dos, manda el nuestro: es el que dice el prompt.
  const r = revisar(doc('<div id="stage" data-composition-id="a"><div data-composition-id="b"></div></div>', TL));
  eq(r.problem, null, 'no es ambiguo: gana id="stage"');
  ok(/id="stage" data-composition-id="a"/.test(r.html), 'conserva el id del stage');
});

test('dos raíces marcadas con data-composition-id sí son ambiguas', function () {
  const r = revisar(doc('<div data-composition-id="a"></div><div data-composition-id="b"></div>', TL));
  eq(r.problem, PROBLEM.MANY_STAGES, 'no se sabe cuál es la composición');
});

test('el JavaScript no confunde al buscador de la raíz', function () {
  // Adentro de un <script>, un "<" es un menor-que. Contarlo como tag rompía la
  // cuenta de anidación y hacía ver elementos sueltos donde hay uno.
  const r = revisar(doc('<div class="wrap">x</div>', 'for (let i = 0; i < 10; i++) {} ' + TL));
  eq(r.problem, null, 'el for no debería contar como un elemento del body');
});

// ── Registrar la timeline (o no tener ninguna) ──────────────────────────────

test('una animación de puro CSS no necesita registrar nada', function () {
  // Antes se la mandaba de vuelta al modelo por "falta el registro", cuando en
  // realidad no hay timeline que registrar: al motor le alcanza data-duration.
  const r = revisar(doc('<div id="stage" class="anim">hola</div>'));
  eq(r.problem, null, 'sin GSAP no falta ningún registro');
  ok(/data-duration="12.5"/.test(r.html), 'lo que sí hace falta es la duración');
});

test('una timeline de GSAP sin registrar SÍ se manda de vuelta al modelo', function () {
  // Este es el caso peligroso: adivinar el nombre de la variable y errarle no
  // falla rápido, sale un video congelado.
  const r = revisar(doc('<div id="stage">hola</div>', 'const tl = gsap.timeline(); tl.to(".x", {x: 10});'));
  eq(r.problem, PROBLEM.NO_REGISTRATION, 'hay una timeline armada que el motor no va a encontrar');
});

test('la mención de GSAP en la auditoría del modelo no cuenta como código', function () {
  // El modelo cierra cada composición describiendo en prosa lo que hizo.
  const html = doc('<div id="stage">hola</div>') +
    '\n<!-- AUDIT: OK. Usé gsap.timeline() para la entrada. -->';
  eq(revisar(html).problem, null, 'un comentario no es una timeline');
});

test('una composición sana vuelve IDÉNTICA', function () {
  // El HTML se guarda en disco para que el editor lo pueda tocar a mano.
  const html = doc('<div id="stage" data-composition-id="x" data-start="0" data-width="1920"' +
    ' data-height="1080" data-fps="30" data-duration="12.5">hola</div>', TL);
  const r = revisar(html);
  eq(r.problem, null, 'está sana');
  eq(r.html, html, 'no se le toca ni un byte');
  eq(r.fixes.length, 0, 'y no dice haber arreglado nada');
});
