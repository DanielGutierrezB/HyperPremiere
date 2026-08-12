'use strict';

// El rescate de la composición: qué pasa cuando el CLI cierra sin entregar el
// resultado y una generación de minutos, YA PAGADA, está a punto de tirarse.
//
// Son dos cierres distintos y no conviene confundirlos:
//   - `sin-final`: no llegó ningún evento de cierre (se prueba en
//     provider-fallback.test.js, junto a los demás caminos raros del CLI).
//   - `final-vacio`: el cierre SÍ llegó, con sus tokens, pero con el resultado
//     en blanco. Visto en una corrida real: el agente dio una segunda vuelta y
//     esa terminó sin texto, con la composición ya escrita en la primera.
//
// En los dos el diseño se rescata de los mensajes del modelo. La diferencia que
// importa para el editor es la plata: con `final-vacio` el conteo de tokens
// llegó igual y NO se puede perder, así que el total del recurso sigue siendo
// el de verdad. Y el rescate nunca es silencioso: viaja como aviso y compose.js
// lo deja escrito en el log como nota WARN, sin frenar nada.

const path = require('path');
const { test, ok, eq, has } = require('./harness');
const claude = require('../bridge/providers/claude-cli');
const cursor = require('../bridge/providers/cursor-cli');
const { composeAnimation } = require('../bridge/compose');

const FAKE_CLAUDE = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-claude.js');
const FAKE_CURSOR = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-cursor.js');

// Los CLI de mentira son scripts con shebang: en Windows no se ejecutan así.
const saltarEnWindows = process.platform === 'win32';

/** Corre un proveedor contra su CLI de mentira en el modo pedido. */
async function correr(proveedor, modo) {
  const prev = process.env.FAKE_MODE;
  process.env.FAKE_MODE = modo;
  try {
    return await proveedor.generate({
      systemPrompt: 'sistema',
      userPrompt: 'diseñá algo',
      images: [],
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

test('claude: con el resultado en blanco, la composición se rescata entera', async function () {
  if (saltarEnWindows) return console.log('      (se saltea en Windows: el CLI de mentira es un script con shebang)');
  const normal = await correr(claude, 'stream');
  const rescatada = await correr(claude, 'final-vacio');
  ok(rescatada.text.length > 0, 'algo volvió');
  eq(rescatada.text, normal.text,
    'y es EXACTAMENTE lo que habría llegado si el cierre hubiera traído el resultado');
});

test('claude: el rescate no se come los tokens que el cierre sí trajo', async function () {
  if (saltarEnWindows) return;
  // Esta es la diferencia con "el stream se cortó": acá el CLI alcanzó a
  // cerrar, y su cierre trae lo que costó la llamada. Perderlo sería cobrarle
  // al editor un recurso que su total no muestra.
  const { usage } = await correr(claude, 'final-vacio');
  ok(usage, 'el conteo no se pierde por haber tenido que rescatar el texto');
  eq(usage.inputTokens, 33, 'los tokens de entrada son los que dijo el CLI');
  eq(usage.outputTokens, 44, 'y los de salida también');
  eq(usage.costUsd, 0.05, 'con su costo');
});

test('claude: el rescate queda avisado, y el aviso no miente sobre los tokens', async function () {
  if (saltarEnWindows) return;
  const conCierre = await correr(claude, 'final-vacio');
  has(conCierre.warning, 'se rescató', 'el proveedor devuelve el aviso');
  has(conCierre.warning, 'conteo de tokens de esta llamada llegó igual',
    'y aclara que el conteo está completo, porque acá lo está');

  const sinCierre = await correr(claude, 'sin-final');
  has(sinCierre.warning, 'se pierde es el conteo de tokens',
    'sin cierre, el mismo aviso dice lo contrario: ahí sí falta el conteo');
  eq(sinCierre.usage, null, 'y efectivamente no hay conteo que informar');
});

test('claude: sin nada que rescatar, lo dice en vez de quedarse callado', async function () {
  if (saltarEnWindows) return;
  let error = null;
  try {
    await correr(claude, 'mudo');
  } catch (e) {
    error = e;
  }
  ok(error, 'no devuelve una composición vacía como si nada');
  has(error.message, 'sin ninguna respuesta del modelo',
    'y el motivo se entiende sin abrir el código');
});

test('cursor: el mismo cierre en blanco también se rescata, con su conteo', async function () {
  if (saltarEnWindows) return;
  const normal = await correr(cursor, 'stream');
  const rescatada = await correr(cursor, 'final-vacio');
  eq(rescatada.text, normal.text, 'vuelve lo mismo que por el camino normal');
  eq(rescatada.usage.inputTokens, 33, 'con los tokens del cierre');
  eq(rescatada.usage.outputTokens, 44);
  has(rescatada.warning, 'conteo de tokens de esta llamada llegó igual', 'y avisado igual que en Claude');
});

test('cursor: si el cierre ni siquiera es JSON, se rescata y se avisa', async function () {
  if (saltarEnWindows) return;
  const r = await correr(cursor, 'basura');
  ok(r.text.length > 0, 'los mensajes del agente alcanzan para no perder el diseño');
  has(r.warning, 'se pierde es el conteo de tokens',
    'acá no hay cierre del que sacar los tokens, y el aviso lo dice');
});

// --- Del proveedor al log del editor -----------------------------------------

/** La composición más chica que pasa el contrato (ver composition.js). */
function html(id) {
  return '<html><body><div id="stage" data-composition-id="' + id + '" data-start="0" ' +
    'data-width="1920" data-height="1080" data-duration="3.00" data-fps="30"></div>' +
    '<script>const tl=1;window.__timelines["' + id + '"]=tl;</script></body></html>';
}

/** Proveedor de mentira que contesta bien, con o sin aviso de rescate. */
function proveedorConAviso(warning) {
  return {
    generate: async function () {
      return { text: html('x'), usage: { inputTokens: 33, outputTokens: 44 }, warning: warning };
    },
  };
}

function correrCompose(provider, report) {
  return composeAnimation({
    provider: provider,
    config: { model: 'modelo-de-prueba', provider: 'test' },
    systemPrompt: 'sistema', userPrompt: 'usuario', images: [],
    durationSec: 3, markerSlug: 'marcador-1', report: report,
  });
}

test('el aviso del proveedor termina en el log como nota WARN, sin frenar nada', async function () {
  const sobres = [];
  const r = await correrCompose(proveedorConAviso('la composición se rescató'), function (p) { sobres.push(p); });
  const avisos = sobres.filter(function (p) { return p.note === 'la composición se rescató'; });
  eq(avisos.length, 1, 'el aviso se reporta una vez');
  eq(avisos[0].level, 'WARN', 'como advertencia: hay que poder encontrarlo en el log');
  ok(r.html.indexOf('id="stage"') > 0, 'y la generación sigue su curso, que es el punto');
  eq(r.usage.inputTokens, 33, 'con los tokens rescatados sumados al total del recurso');
});

test('sin aviso no se inventa ninguna advertencia', async function () {
  const sobres = [];
  await correrCompose(proveedorConAviso(''), function (p) { sobres.push(p); });
  ok(!sobres.some(function (p) { return p.level === 'WARN'; }),
    'una generación normal no deja el log lleno de advertencias');
});
