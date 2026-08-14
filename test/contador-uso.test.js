'use strict';

// El contador de la sesión: que cuente lo que de verdad se consumió.
//
// Venía mostrando una fracción. El editor tenía en pantalla "75.256 tokens de
// entrada · 2.341.682 de salida · 164 generaciones": 459 de entrada por
// generación, cuando cada una manda un objetivo, un guion, instrucciones e
// imágenes. La entrada no estaba mal calculada, estaba mal LEÍDA: en los CLI de
// agente `inputTokens` es solo el pedazo que no estaba cacheado, y el prompt
// entero viaja por los campos de caché. Se comprobó con la llamada más chica que
// se puede hacer, un prompt de veinte caracteres a cursor-agent:
//
//   { inputTokens: 2, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 31823 }
//
// Así que se prueba la cadena entera, porque el número se puede perder en
// cualquier eslabón: el mapeo de cada CLI (donde un rename de campo lo pone en
// cero sin que nada falle), la suma de las hasta tres llamadas de un recurso, el
// acumulado del panel, y el texto que se lee.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');
const { makeUsage } = require('../bridge/providers');
const { composeAnimation } = require('../bridge/compose');
const claude = require('../bridge/providers/claude-cli');
const cursor = require('../bridge/providers/cursor-cli');

const CEP = path.join(__dirname, '..', 'cep', 'js');
const FAKE_CLAUDE = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-claude.js');
const FAKE_CURSOR = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-cursor.js');

// Los CLI de mentira son scripts con shebang: en Windows no arrancan solos.
const saltarEnWindows = process.platform === 'win32';

/** Corre un proveedor contra su CLI de mentira en el modo pedido. */
async function correr(proveedor, modo) {
  const prev = process.env.FAKE_MODE;
  process.env.FAKE_MODE = modo;
  try {
    return await proveedor.generate({
      systemPrompt: 'sistema', userPrompt: 'diseñá algo', images: [],
      model: 'modelo-de-prueba',
      config: {
        binPath: FAKE_CLAUDE, cursorBinPath: FAKE_CURSOR,
        timeoutMs: 30000, promptViaStdin: false,
      },
      onActivity: function () {},
    });
  } finally {
    if (prev === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = prev;
  }
}

/** El panel, evaluado como lo carga el navegador, con un localStorage de mentira. */
function cargarPanel() {
  const disco = {};
  const ctx = {
    console: console, JSON: JSON, Math: Math, Date: Date,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(disco, k) ? disco[k] : null; },
      setItem: function (k, v) { disco[k] = String(v); },
      removeItem: function (k) { delete disco[k]; },
    },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    HPLog: { log: function () {} },
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  ['util.js', 'store.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  });
  return ctx;
}

// --- 1. El mapeo de cada proveedor -------------------------------------------

test('la entrada es lo suelto MÁS la caché, no solo lo suelto', function () {
  const u = makeUsage('x', 'm', {
    inputTokens: 4, outputTokens: 9252,
    cacheReadTokens: 84015, cacheCreationTokens: 49316,
  });
  eq(u.totalInputTokens, 133335, 'los tres campos se suman: es todo lo que entró al modelo');
  eq(u.inputTokens, 4, 'y el suelto sigue disponible aparte');
  eq(u.cacheReadTokens, 84015);
  eq(u.cacheCreationTokens, 49316);
});

test('cursor: los 31.823 tokens de su contexto no se pierden por el camino', async function () {
  if (saltarEnWindows) return console.log('      (se saltea en Windows: el CLI de mentira es un script con shebang)');
  // El caso que destapó todo. El CLI los manda en `cacheWriteTokens` —otro
  // nombre que el de la API de Anthropic— y si ese mapeo se rompe, el contador
  // marca 2 y nada falla.
  const { usage } = await correr(cursor, 'usage-real');
  eq(usage.inputTokens, 2, 'lo que el CLI llama entrada es una miseria');
  eq(usage.cacheCreationTokens, 31823, 'la entrada de verdad viene por cacheWriteTokens');
  eq(usage.totalInputTokens, 31825, 'y el total la incluye');
});

test('claude: la caché leída y la escrita también cuentan como entrada', async function () {
  if (saltarEnWindows) return;
  const { usage } = await correr(claude, 'usage-real');
  eq(usage.totalInputTokens, 4 + 84015 + 49316, 'los tres campos del CLI');
  eq(usage.costUsd, 0.42, 'y el costo que informa se conserva');
});

test('cursor no informa costo: queda en null, no en cero', async function () {
  if (saltarEnWindows) return;
  const { usage } = await correr(cursor, 'usage-real');
  eq(usage.costUsd, null,
    'va por suscripción; poner 0 lo haría pasar por "medido y gratis" en el promedio');
});

// --- 2. Un recurso son hasta tres llamadas -----------------------------------

test('las llamadas de un mismo recurso suman su entrada completa', async function () {
  const usos = [
    { inputTokens: 2, outputTokens: 100, cacheReadTokens: 10, cacheCreationTokens: 30000, totalInputTokens: 30012 },
    { inputTokens: 3, outputTokens: 200, cacheReadTokens: 40000, cacheCreationTokens: 5, totalInputTokens: 40008 },
  ];
  let i = 0;
  const r = await composeAnimation({
    userPrompt: 'x', systemPrompt: 's', images: [], durationSec: 5, markerSlug: 'm1',
    config: { model: 'modelo-de-prueba', provider: 'falso' },
    provider: {
      generate: async function () {
        const u = usos[i++];
        // La primera vuelta se olvida de registrar la timeline: eso no lo puede
        // arreglar el reparador, así que fuerza la llamada de estructura.
        return { text: i === 1 ? SIN_REGISTRO : COMPOSICION, usage: u };
      },
    },
  });
  eq(r.usage.calls, 2, 'hubo dos llamadas');
  eq(r.usage.totalInputTokens, 70020, 'y la entrada del recurso es la de las dos');
  eq(r.usage.outputTokens, 300);
});

test('si un proveedor no manda el total, se recompone de sus partes', async function () {
  // Un proveedor viejo (o uno nuevo que se olvide) no puede dejar el contador en
  // cero: los tres campos alcanzan para sacarlo.
  const r = await composeAnimation({
    userPrompt: 'x', systemPrompt: 's', images: [], durationSec: 5, markerSlug: 'm1',
    config: { model: 'modelo-de-prueba', provider: 'falso' },
    provider: {
      generate: async function () {
        return {
          text: COMPOSICION,
          usage: { inputTokens: 7, outputTokens: 9, cacheReadTokens: 100, cacheCreationTokens: 200 },
        };
      },
    },
  });
  eq(r.usage.totalInputTokens, 307);
});

// --- 3. El acumulado del panel -----------------------------------------------

test('el panel acumula la caché, no solo el suelto', function () {
  const { HPStore } = cargarPanel();
  HPStore.addSessionUsage({ inputTokens: 2, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 31823 });
  HPStore.addSessionUsage({ inputTokens: 4, outputTokens: 9252, cacheReadTokens: 84015, cacheCreationTokens: 49316 });
  const u = HPStore.getSessionUsage();
  eq(u.generations, 2);
  eq(u.cacheCreationTokens, 81139, 'la caché escrita se guarda (antes se tiraba)');
  eq(u.cacheReadTokens, 84015);
  eq(u.inputTokens, 6);
  eq(HPStore.totalInput(u), 165160, 'y el total sale de los tres');
});

test('el costo se lleva con cuántas generaciones lo informaron', function () {
  const { HPStore } = cargarPanel();
  // Dos de Claude, que informa costo, y una de Cursor, que no.
  HPStore.addSessionUsage({ inputTokens: 1, outputTokens: 10, cacheCreationTokens: 1000, costUsd: 0.40 });
  HPStore.addSessionUsage({ inputTokens: 1, outputTokens: 10, cacheCreationTokens: 1000, costUsd: 0.60 });
  HPStore.addSessionUsage({ inputTokens: 2, outputTokens: 20, cacheCreationTokens: 30000, costUsd: null });
  const u = HPStore.getSessionUsage();
  eq(u.generations, 3, 'las tres generaron');
  eq(u.costGenerations, 2, 'pero solo dos dijeron cuánto costaron');
  eq(Number(u.costUsd.toFixed(2)), 1.00);
  eq(u.costInputTokens, 2002,
    'y con SU entrada, para que el promedio no se diluya con la de las que no cobran');
});

test('un acumulado guardado por una versión anterior no revienta ni ensucia', function () {
  const panel = cargarPanel();
  // Lo que quedó en el disco del editor antes de este arreglo: sin los campos
  // nuevos. Tiene que seguir sumando desde ahí, no empezar de cero ni dar NaN.
  panel.localStorage.setItem('hyperpremiere::session-usage',
    JSON.stringify({ inputTokens: 75256, outputTokens: 2341682, cacheReadTokens: 0, costUsd: 15.369, generations: 164 }));
  const u = panel.HPStore.getSessionUsage();
  eq(u.cacheCreationTokens, 0, 'los que no estaban arrancan en cero');
  eq(u.costGenerations, 0);
  eq(u.generations, 164, 'y lo que estaba se conserva');
  panel.HPStore.addSessionUsage({ inputTokens: 1, outputTokens: 1, cacheCreationTokens: 500 });
  eq(panel.HPStore.getSessionUsage().cacheCreationTokens, 500, 'y sigue sumando desde ahí');
});

test('el acumulado que viene de antes queda MARCADO, y se sigue marcando', function () {
  const panel = cargarPanel();
  panel.localStorage.setItem('hyperpremiere::session-usage',
    JSON.stringify({ inputTokens: 75256, outputTokens: 2341682, costUsd: 15.369, generations: 164 }));
  ok(panel.HPStore.getSessionUsage().legacyMix,
    'lo de antes se contó a medias y eso no se puede reparar hacia atrás: hay que avisarlo');
  panel.HPStore.addSessionUsage({ inputTokens: 2, outputTokens: 9, cacheCreationTokens: 30000 });
  ok(panel.HPStore.getSessionUsage().legacyMix,
    'sumarle una generación bien contada no arregla las 164 viejas: el aviso queda');
  panel.HPStore.resetSessionUsage();
  ok(!panel.HPStore.getSessionUsage().legacyMix, 'reiniciando sí: de ahí en adelante todo se cuenta igual');
});

test('un contador arrancado de cero no se marca como mezclado', function () {
  const { HPStore } = cargarPanel();
  HPStore.addSessionUsage({ inputTokens: 2, outputTokens: 9, cacheCreationTokens: 30000 });
  ok(!HPStore.getSessionUsage().legacyMix);
});

test('con dólares pero sin saber de cuántas, no se inventa un "en 0 de 164"', function () {
  const { HPUtil } = cargarPanel();
  // Es exactamente el acumulado viejo del editor apenas actualiza.
  const v = HPUtil.sessionUsage({
    inputTokens: 75256, outputTokens: 2341682, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUsd: 15.369, costGenerations: 0, generations: 164, legacyMix: true,
  });
  has(v.line, '$15.37 ·', 'el costo va solo');
  ok(v.line.indexOf('en 0 de') === -1, 'sin repartos inventados');
  has(v.detail, 'se contaba a medias', 'y el detalle explica por qué el total queda corto');
  has(v.detail, 'reiniciar', 'con la salida');
});

test('reiniciar deja el contador en cero', function () {
  const { HPStore } = cargarPanel();
  HPStore.addSessionUsage({ inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, costUsd: 1 });
  HPStore.resetSessionUsage();
  const u = HPStore.getSessionUsage();
  eq(u.generations, 0);
  eq(u.costUsd, 0);
  eq(u.cacheCreationTokens, 0);
});

// --- 4. Lo que se lee --------------------------------------------------------

test('la línea de la sesión muestra la entrada completa', function () {
  const { HPUtil } = cargarPanel();
  // La sesión del editor con los números bien contados: la entrada real de esas
  // 164 generaciones no eran 75 mil tokens sino millones.
  const v = HPUtil.sessionUsage({
    inputTokens: 900, outputTokens: 2341682, cacheReadTokens: 12000000, cacheCreationTokens: 8000000,
    costUsd: 15.369, costGenerations: 12, generations: 164,
  });
  has(v.line, '20M tokens de entrada', 'la entrada, completa y compacta');
  has(v.line, '(20M de caché)', 'y cuánto de eso es caché, que es lo que lo explica');
  has(v.line, '2,3M de salida');
  has(v.line, '164 generaciones');
});

test('el costo dice sobre cuántas generaciones se juntó', function () {
  const { HPUtil } = cargarPanel();
  const v = HPUtil.sessionUsage({
    inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 100,
    costUsd: 15.369, costGenerations: 12, generations: 164,
  });
  has(v.line, '$15.37 en 12 de 164',
    'sin eso, $15 se lee como el costo de las 164 cuando cubre 12');
  has(v.detail, 'Cursor va por suscripción', 'y el detalle dice por qué las otras no informan');
  has(v.detail, '$1.28 cada una', 'con el promedio de las que sí');
});

test('si todas informaron costo, no se aclara nada', function () {
  const { HPUtil } = cargarPanel();
  const v = HPUtil.sessionUsage({
    inputTokens: 10, outputTokens: 20, cacheCreationTokens: 100,
    costUsd: 2, costGenerations: 4, generations: 4,
  });
  has(v.line, '$2.00 ·', 'el costo va solo: no hay nada que aclarar');
  ok(v.line.indexOf('de 4 ·') === -1, 'sin el "en N de M"');
});

test('el detalle desarma la entrada en sus tres partes', function () {
  const { HPUtil } = cargarPanel();
  const v = HPUtil.sessionUsage({
    inputTokens: 6, outputTokens: 9256, cacheReadTokens: 84015, cacheCreationTokens: 81139,
    costUsd: 0, costGenerations: 0, generations: 2,
  });
  has(v.detail, '6 sin cachear');
  has(v.detail, '84.015 leídos de caché');
  has(v.detail, '81.139 escritos a caché');
  has(v.detail, 'Casi toda la entrada es caché',
    'el aviso que evita el "¿por qué es diez veces mi prompt?"');
  has(v.detail, 'Por generación', 'y el promedio, que es lo que se compara entre clases');
});

test('sin generaciones no se inventan números', function () {
  const { HPUtil } = cargarPanel();
  eq(HPUtil.sessionUsage({ generations: 0 }).line, 'sin generaciones todavía');
  eq(HPUtil.sessionUsage(null).line, 'sin generaciones todavía');
});

test('los millones se escriben cortos: no hay lugar para 3.412.905', function () {
  const { HPUtil } = cargarPanel();
  eq(HPUtil.fmtTokens(3412905), '3,4M');
  eq(HPUtil.fmtTokens(20341682), '20M');
  eq(HPUtil.fmtTokens(31823), '32k', 'los miles siguen como estaban');
  eq(HPUtil.fmtTokens(2), '2');
});

// Una composición que cumple el contrato, para las pruebas de la escalera.
const COMPOSICION = '<!DOCTYPE html><html><body>' +
  '<div id="stage" data-composition-id="comp" data-start="0" data-width="1920" ' +
  'data-height="1080" data-duration="5" data-fps="30"></div>' +
  '<script>const tl = gsap.timeline({ paused: true }); window.__timelines["comp"] = tl;</script>' +
  '</body></html>';

// La misma, sin la línea que registra la timeline: el reparador no la puede
// inventar, así que dispara la llamada extra de estructura.
const SIN_REGISTRO = '<!DOCTYPE html><html><body>' +
  '<div id="stage" data-composition-id="comp" data-duration="5"></div>' +
  '<script>const tl = gsap.timeline({ paused: true });</script>' +
  '</body></html>';
