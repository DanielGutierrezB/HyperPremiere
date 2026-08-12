'use strict';

// Que no se renderice lo que ya sabemos que no puede salir bien.
//
// Un caso real (Marcador 13, log del 12/08): el modelo devolvió una composición
// sin el andamiaje que el motor de captura necesita —sin duración declarada, sin
// timeline registrada—. Se mandó igual a renderizar, y el CLI cortó con
// "Composition has zero duration ... this is permanent". La escalera de intentos
// reaccionó a eso como si fuera un problema de máquina: bajó la GPU a software,
// bajó los workers, reintentó. Tres veces el mismo error. Un minuto tirado y, al
// final, un mensaje que le hablaba al editor de `browser-gpu=software`, o sea de
// una placa de video que nunca tuvo nada que ver.
//
// Son dos arreglos distintos y acá se prueban los dos:
//   1. compose corta antes del render cuando la composición no es renderizable.
//   2. si igual llegara un error de contenido al render, no se reintenta.

const { test, ok, eq, has } = require('./harness');
const { composeAnimation } = require('../bridge/compose');
const { esErrorDeComposicion, argsDeRender, correrEscalera } = require('../bridge/render/hyperframes');

/** La composición más chica que pasa el contrato. */
function htmlBueno(id) {
  return '<html><body><div id="stage" data-composition-id="' + id + '" data-start="0" ' +
    'data-width="1920" data-height="1080" data-duration="3.00" data-fps="30"></div>' +
    '<script>const tl=gsap.timeline();window.__timelines["' + id + '"]=tl;</script></body></html>';
}

/**
 * Una composición que el reparador NO puede arreglar solo: dos elementos sueltos
 * colgando del body, así que no hay forma de saber cuál es el contenedor. Es la
 * clase de cosa que solo se resuelve volviendo al modelo.
 */
const HTML_SIN_ARREGLO =
  '<html><body><div class="fondo"></div><div class="texto">Hola</div>' +
  '<script>const tl=gsap.timeline();tl.to(".texto",{x:100});</script></body></html>';

/** Proveedor de mentira: contesta lo que se le diga, y cuenta cuántas veces. */
function proveedorQueDevuelve(respuestas) {
  const estado = { llamadas: 0 };
  return {
    llamadas: function () { return estado.llamadas; },
    generate: async function () {
      const i = Math.min(estado.llamadas, respuestas.length - 1);
      estado.llamadas++;
      return { text: respuestas[i], usage: { inputTokens: 10, outputTokens: 20 } };
    },
  };
}

function correr(provider, report) {
  return composeAnimation({
    provider: provider,
    config: { model: 'modelo-de-prueba', provider: 'test' },
    systemPrompt: 'sistema', userPrompt: 'usuario', images: [],
    durationSec: 3, markerSlug: 'marcador-13',
    report: report || function () {},
  });
}

// --- 1. Cortar antes de gastar el render -------------------------------------

test('una composición que no se puede renderizar no llega al render', async function () {
  const p = proveedorQueDevuelve([HTML_SIN_ARREGLO]);
  let error = null;
  try {
    await correr(p);
  } catch (e) {
    error = e;
  }
  ok(error, 'compose corta en vez de devolver algo que va a fallar abajo');
  ok(error.noRenderizable, 'y lo marca como tal, para que arriba se distinga de un error cualquiera');
});

test('el motivo se entiende sin abrir el código, y dice qué hacer', async function () {
  let error = null;
  try {
    await correr(proveedorQueDevuelve([HTML_SIN_ARREGLO]));
  } catch (e) { error = e; }
  has(error.message, 'no quedó renderizable', 'arranca por lo que pasó');
  has(error.message, 'video congelado', 'explica por qué no se intenta igual');
  has(error.message, 'Renderizar HTML', 'y deja una salida a mano');
  ok(!/GPU|placa|worker/i.test(error.message),
    'y NO menciona hardware: el problema es la composición, no la máquina');
});

test('el HTML se conserva aunque no se pueda renderizar: ya se pagó', async function () {
  let error = null;
  try {
    await correr(proveedorQueDevuelve([HTML_SIN_ARREGLO]));
  } catch (e) { error = e; }
  ok(error.html && error.html.length > 0, 'el diseño viaja en el error para poder guardarlo');
  has(error.html, 'gsap.timeline', 'entero, no un pedazo');
  ok(error.usage && error.usage.inputTokens > 0,
    'y los tokens también: el recurso costó, aunque no haya video');
});

test('antes de rendirse se le da al modelo su oportunidad de arreglarlo', async function () {
  const p = proveedorQueDevuelve([HTML_SIN_ARREGLO]);
  try { await correr(p); } catch (e) {}
  eq(p.llamadas(), 2, 'se lo llama de nuevo con la estructura a corregir, y ahí sí se corta');
});

test('si el reintento SÍ arregla la estructura, la generación sigue normal', async function () {
  const p = proveedorQueDevuelve([HTML_SIN_ARREGLO, htmlBueno('marcador-13')]);
  const r = await correr(p);
  ok(r.html.indexOf('data-duration') > 0, 'vuelve la composición buena');
  ok(!r.problem, 'sin problema pendiente');
});

test('una composición sana no se frena por nada de esto', async function () {
  const r = await correr(proveedorQueDevuelve([htmlBueno('marcador-13')]));
  ok(r.html.indexOf('id="stage"') > 0, 'pasa derecho');
  eq(r.usage.inputTokens, 10, 'con su conteo');
});

// --- 2. Si igual llega un error de contenido, no reintentar -------------------

test('el error que dio el caso real se reconoce como de composición', function () {
  ok(esErrorDeComposicion(
    'Error: Composition has zero duration (0 frames). Check data-duration. this is permanent'
  ), 'es exactamente el texto del log del editor');
});

test('los avisos de "permanente" del CLI también cuentan', function () {
  ok(esErrorDeComposicion('render failed: this is permanent, retrying will not help'));
  ok(esErrorDeComposicion('root_missing_composition_id'));
  ok(esErrorDeComposicion('missing `data-composition-id` on root element'));
});

test('un crash o un cuelgue NO se confunden con un problema de composición', function () {
  // Estos sí se arreglan cambiando la configuración: para ellos existe la escalera.
  ok(!esErrorDeComposicion('hyperframes: sin actividad por 300s (watchdog 300s) — parece colgado'));
  ok(!esErrorDeComposicion('Target closed / Chromium crashed'));
  ok(!esErrorDeComposicion('RangeError: Set maximum size exceeded'));
  ok(!esErrorDeComposicion('hyperframes salió con código 1\nstderr:\nffmpeg not found'));
  ok(!esErrorDeComposicion(''), 'y un error vacío tampoco: ante la duda, se reintenta');
});

// --- 3. La escalera: cuándo reintentar y cuándo no ----------------------------

const ESCALERA = [
  { gpu: 'hardware', workers: 3, lowMemory: false },
  { gpu: 'hardware', workers: 1, lowMemory: true },
  { gpu: 'software', workers: 1, lowMemory: true },
];

/** Corre la escalera con un render de mentira y junta lo que quedó en el log. */
async function bajarEscalera(correr) {
  const intentos = [];
  const log = [];
  const r = await correrEscalera({
    attempts: ESCALERA,
    correr: async function (a) { intentos.push(a); return correr(a, intentos.length); },
    trace: function (t, level) { log.push({ text: t, level: level }); },
    report: function () {},
    etiqueta: 'mov/high',
    limpiarSalida: function () {},
  });
  return {
    intentos: intentos, log: log, err: r.err, exito: r.exito,
    texto: log.map(function (l) { return l.text; }).join('\n'),
  };
}

test('un error de composición corta la escalera en el primer intento', async function () {
  const r = await bajarEscalera(function () {
    throw new Error('Composition has zero duration (0 frames)... this is permanent');
  });
  eq(r.intentos.length, 1,
    'los otros dos escalones darían el mismo error: reintentarlos es tirar un minuto');
  ok(r.err, 'y el render igual falla, no se hace el distraído');
});

test('al cortar, el log dice que el problema NO es la máquina', async function () {
  const r = await bajarEscalera(function () {
    throw new Error('Composition has zero duration. this is permanent');
  });
  has(r.texto, 'no está en el hardware',
    'el editor tiene que poder descartar la placa de video sin preguntarle a nadie');
  ok(!/bajo a browser-gpu/.test(r.texto), 'y no queda escrito que se bajó a software, porque no se bajó');
  eq(r.log[r.log.length - 1].level, 'ERROR', 'entra en el log como error, no como aviso perdido');
});

test('un crash SÍ baja al escalón siguiente: para eso está la escalera', async function () {
  const r = await bajarEscalera(function (a, n) {
    if (n === 1) throw new Error('[Parallel] Capture failed: Worker 2 crashed');
    return null;
  });
  eq(r.intentos.length, 2, 'reintentó');
  eq(r.intentos[1].workers, 1, 'con menos workers, que es lo que arregla ese crash');
  eq(r.err, null, 'y el segundo salió: el editor tiene su video');
  eq(r.exito.escalon, 1, 'quedando dicho que salió por el camino de rescate');
});

test('el tiempo del modo de rescate no se confunde con el del reparto normal', async function () {
  // Lo que aprende la máquina sale del PRIMER escalón. Si un crash obligó a
  // bajar, ese tiempo mide el crash y el reintento, no con qué reparto conviene
  // renderizar: anotarlo sería aprender de un accidente.
  const bien = await bajarEscalera(function () { return null; });
  eq(bien.exito.escalon, 0, 'un render normal sí sirve para medir');
  const rescatado = await bajarEscalera(function (a, n) {
    if (n === 1) throw new Error('Target closed');
    return null;
  });
  ok(rescatado.exito.escalon > 0, 'uno rescatado queda marcado como tal');
});

test('si crashea siempre, se agotan los escalones y vuelve el último error', async function () {
  const r = await bajarEscalera(function () { throw new Error('Target closed'); });
  eq(r.intentos.length, 3, 'bajó hasta el modo más estable antes de rendirse');
  ok(r.err, 'y avisa');
  has(r.texto, 'Render FALLÓ tras 3 intento(s)', 'diciendo cuántas veces se intentó');
});

test('cuando sale a la primera no se reintenta nada', async function () {
  const r = await bajarEscalera(function () { return null; });
  eq(r.intentos.length, 1);
  eq(r.err, null);
  eq(r.exito.escalon, 0);
  has(r.texto, 'Render OK', 'y queda anotado con qué configuración salió');
});

// --- 4. Los argumentos del CLI son los mismos midiendo que renderizando -------

test('el perfil de 1 worker pide captura por pantalla, no chunks', function () {
  const a = argsDeRender({
    baseArgs: [], workDir: '/tmp/x', outPath: '/tmp/y.mov',
    format: 'mov', quality: 'high', workers: 1, lowMemory: true,
  });
  ok(a.includes('--low-memory-mode'), 'va el modo que resultó más rápido');
  ok(!a.includes('--target-chunk-frames'), 'y no el reparto en pedazos, que es del otro perfil');
  eq(a[a.indexOf('--workers') + 1], '1');
});

test('el perfil paralelo acota el chunk para no reventar el Buffer de Node', function () {
  const a = argsDeRender({
    baseArgs: [], workDir: '/tmp/x', outPath: '/tmp/y.mov',
    format: 'mov', quality: 'high', workers: 3, lowMemory: false,
  });
  eq(a[a.indexOf('--target-chunk-frames') + 1], '300',
    'sin esto, un marcador de 33s se cae con "Set maximum size exceeded"');
  ok(!a.includes('--low-memory-mode'));
});

test('el .mov con alpha nunca pide encode por hardware; el .mp4 sí', function () {
  const mov = argsDeRender({
    baseArgs: [], workDir: '/tmp/x', outPath: '/tmp/y.mov',
    format: 'mov', quality: 'high', workers: 1, lowMemory: true,
  });
  ok(!mov.includes('--gpu'), 'ProRes 4444 encodea por software: --gpu no haría nada');
  const mp4 = argsDeRender({
    baseArgs: [], workDir: '/tmp/x', outPath: '/tmp/y.mp4',
    format: 'mp4', quality: 'high', workers: 1, lowMemory: true,
  });
  ok(mp4.includes('--gpu'), 'H.264 sí usa el motor de media dedicado');
  eq(mp4[mp4.indexOf('--crf') + 1], '18', 'y en alta, calidad de lectura');
});
