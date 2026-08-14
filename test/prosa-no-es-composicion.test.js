'use strict';

// Cuando el modelo contesta en PROSA en vez de componer.
//
// El caso real (Marcador 1, log del 14/08, tres rondas seguidas): el CLI de
// Cursor corría en `--mode ask` —un modo de solo lectura pensado para preguntas
// y respuestas— y en medio de una clase el modelo se plantó:
//
//   "I'm in Ask mode, which is for answering questions and providing guidance —
//    I can't generate or hand off a final production deliverable… please switch
//    to Agent mode"
//
// Eso disparó tres problemas en cadena, y los tres se prueban acá:
//
//   1. El motor leyó esa prosa como una composición mal armada y contestó "no
//      encuentro el contenedor `<div id=stage>`". Cierto y completamente
//      engañoso: no había composición ninguna.
//   2. Gastó la llamada extra de estructura mandándole su propia negativa como
//      "tu versión a corregir". El modelo se volvió a negar. Tres veces.
//   3. Lo peor: la prosa quedó guardada como el HTML de la versión nueva, así
//      que la ronda siguiente la leyó como "la versión previa" y le pidió
//      mejorar un texto de disculpa. El propio modelo lo vio: "the 'versión
//      previa' block does not actually contain the prior HTML (it contains an
//      earlier refusal message instead)".
//
// El arreglo de fondo es el modo (cursor-cli.js va sin --mode: componer ES el
// entregable), y esto es la red para cuando un modelo se plante igual.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq, has } = require('./harness');
const { inspectComposition, PROBLEM } = require('../bridge/composition');
const { composeAnimation } = require('../bridge/compose');
const { lastCompositionHtml } = require('../bridge/store/project-fs');
const cursor = require('../bridge/providers/cursor-cli');
const engine = require('../bridge/engine');

const FAKE_CURSOR = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-cursor.js');

// Los CLI de mentira son scripts con shebang: en Windows no arrancan solos.
const saltarEnWindows = process.platform === 'win32';

// La negativa TAL CUAL la devolvió el modelo, guardada del disco del editor.
const NEGATIVA = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'cursor-negativa-ask.txt'), 'utf8');

/** La composición más chica que pasa el contrato. */
function htmlBueno(id) {
  return '<html><body><div id="stage" data-composition-id="' + id + '" data-start="0" ' +
    'data-width="1920" data-height="1080" data-duration="3.00" data-fps="30"></div>' +
    '<script>const tl=gsap.timeline();window.__timelines["' + id + '"]=tl;</script></body></html>';
}

/** HTML de verdad que el reparador no puede arreglar: dos raíces posibles. */
const HTML_SIN_ARREGLO =
  '<html><body><div class="fondo"></div><div class="texto">Hola</div>' +
  '<script>const tl=gsap.timeline();tl.to(".texto",{x:100});</script></body></html>';

function mirar(texto) {
  return inspectComposition(texto, { durationSec: 3, markerSlug: 'marcador-1' });
}

// --- 1. Distinguir "no hay composición" de "la composición está mal" ---------

test('la negativa del editor se reconoce como "esto no es HTML"', function () {
  eq(mirar(NEGATIVA).problem, PROBLEM.NOT_HTML,
    'es prosa: no le falta andamiaje, no hay nada que arreglar');
});

test('una respuesta vacía también', function () {
  eq(mirar('').problem, PROBLEM.NOT_HTML);
  eq(mirar('   \n  ').problem, PROBLEM.NOT_HTML);
});

test('prosa que NOMBRA un tag al pasar sigue siendo prosa', function () {
  // Si esto se colara como composición, el reparador le adoptaría ese div como
  // raíz, le completaría los data-* y saldría un video de 8 segundos en negro:
  // el final peor, porque no falla, se descubre mirándolo.
  const texto = 'No puedo hacerlo. Te falta el `<div id="stage">` con su data-duration.';
  eq(mirar(texto).problem, PROBLEM.NOT_HTML);
});

test('una composición sana pasa derecho, como siempre', function () {
  const r = mirar(htmlBueno('marcador-1'));
  eq(r.problem, null);
  eq(r.duration, 3);
});

test('una composición ROTA sigue dando su propio problema, no "no es HTML"', function () {
  // La diferencia importa: a esta sí vale la pena mandarle la llamada de
  // estructura, y su HTML sí se guarda.
  eq(mirar(HTML_SIN_ARREGLO).problem, PROBLEM.NO_STAGE);
});

test('un fragmento de composición sin <html> igual cuenta como HTML', function () {
  // Algunos modelos devuelven solo el bloque, sin documento alrededor. Eso es
  // una composición incompleta (se repara), no una negativa.
  const frag = '<div id="stage" data-composition-id="m1"><h1>Hola</h1><p>texto</p></div>';
  ok(mirar(frag).problem !== PROBLEM.NOT_HTML, 'tiene tags de sobra para ser HTML');
});

test('una composición de UNA sola etiqueta también', function () {
  // Las hay en disco: el panel lee la duración declarada de composiciones así
  // para saber cuánto duraba un recurso viejo (ver correcciones-listar). Con un
  // umbral de "tres etiquetas" quedaban clasificadas como prosa.
  const r = mirar('<div id="stage" data-composition-id="m1" data-duration="9"></div>');
  ok(r.problem !== PROBLEM.NOT_HTML, 'arranca con un tag: es HTML, aunque sea mínimo');
  eq(r.duration, 9, 'y su duración se sigue leyendo');
});

test('un modelo que se disculpa ANTES de mandar el HTML no se descarta', function () {
  const texto = 'Perdón por la demora, acá va la composición:\n' + htmlBueno('marcador-1');
  eq(mirar(texto).problem, null, 'el HTML está: la introducción no lo invalida');
});

// --- 2. La política: cortar rápido y no guardar nada -------------------------

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

function correr(provider) {
  return composeAnimation({
    provider: provider,
    config: { model: 'modelo-de-prueba', provider: 'cursor-cli' },
    systemPrompt: 'sistema', userPrompt: 'usuario', images: [],
    durationSec: 3, markerSlug: 'marcador-1',
    report: function () {},
  });
}

async function elErrorDe(provider) {
  try {
    await correr(provider);
  } catch (e) {
    return e;
  }
  return null;
}

test('ante una negativa no se gasta la llamada de estructura', async function () {
  const p = proveedorQueDevuelve([NEGATIVA]);
  await elErrorDe(p);
  eq(p.llamadas(), 1,
    'mandarle su propia negativa a "corregir" es tirar veinte segundos y una tanda de tokens');
});

test('la negativa NO viaja como HTML: así no queda guardada como versión', async function () {
  const e = await elErrorDe(proveedorQueDevuelve([NEGATIVA]));
  ok(e, 'la generación falla');
  // engine.js guarda el HTML del error cuando viene con `noRenderizable`. Que
  // acá no venga es lo que corta la cadena: sin archivo, la próxima corrección
  // lee como "versión previa" la última composición DE VERDAD.
  ok(!e.html, 'el error no trae HTML para guardar');
  ok(!(e.noRenderizable && e.html), 'que es la condición exacta con la que engine.js escribe el archivo');
  ok(e.sinComposicion, 'y queda marcado como "acá no hubo composición"');
});

test('el mensaje dice qué pasó, con las palabras del modelo', async function () {
  const e = await elErrorDe(proveedorQueDevuelve([NEGATIVA]));
  has(e.message, 'contestó en prosa', 'el editor no tiene que adivinar');
  has(e.message, 'Ask mode', 'con la explicación del propio modelo, que es la que sirve');
  has(e.message, 'Reintentar', 'y qué hacer ahora');
  ok(!/id="stage"/.test(e.message),
    'y NO habla del contenedor: ese diagnóstico era el que mandaba a buscar donde no había nada');
});

test('los tokens gastados se cuentan igual: la llamada se pagó', async function () {
  const e = await elErrorDe(proveedorQueDevuelve([NEGATIVA]));
  eq(e.usage.inputTokens, 10);
  eq(e.usage.calls, 1);
});

test('una respuesta vacía se nombra como vacía, no como prosa', async function () {
  const e = await elErrorDe(proveedorQueDevuelve(['']));
  has(e.message, 'respuesta vacía');
  has(e.message, 'cursor-cli', 'diciendo qué proveedor fue');
});

test('si la negativa llega en la llamada de estructura, se conserva el diseño pago', async function () {
  // Primera llamada: composición rota pero real. Segunda: negativa. Lo que no
  // puede pasar es perder la primera, que es lo único que el editor puede
  // arreglar a mano.
  const e = await elErrorDe(proveedorQueDevuelve([HTML_SIN_ARREGLO, NEGATIVA]));
  has(e.message, 'no quedó renderizable', 'el problema que se reporta es el de la composición real');
  has(e.html, 'gsap.timeline', 'y es ESA la que se guarda, no la negativa');
});

test('si la negativa llega corrigiendo la auditoría, la versión buena sobrevive', async function () {
  const conFalla = htmlBueno('marcador-1') + '<!-- AUDIT: FALLA: el título se pisa con el subtítulo -->';
  const r = await correr(proveedorQueDevuelve([conFalla, NEGATIVA]));
  has(r.html, 'AUDIT: FALLA', 'vuelve la composición del primer intento');
  ok(!r.problem, 'y se renderiza: tiene una falla de diseño anotada, pero es una composición');
});

// --- 3. Que una negativa vieja no siga haciendo daño desde el disco ----------

/** Carpeta de secuencia con las versiones que se le pidan. */
function carpetaCon(versiones) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-prosa-'));
  versiones.forEach(function (html, i) {
    fs.writeFileSync(path.join(dir, 'marcador-1 v' + (i + 1) + ' [modelo].html'), html, 'utf8');
  });
  return dir;
}

test('la referencia para corregir saltea las versiones que son prosa', function () {
  // El caso del editor: v3 fue el último diseño real y v4, v5 y v6 quedaron
  // guardadas como negativas. Corregir sobre v6 es pedirle al modelo que mejore
  // un texto de disculpa.
  const dir = carpetaCon([htmlBueno('v1'), htmlBueno('v2'), htmlBueno('v3'), NEGATIVA, NEGATIVA, NEGATIVA]);
  const html = lastCompositionHtml(dir, 'marcador-1', 7);
  has(html, 'data-composition-id="v3"', 'vuelve el último diseño de verdad');
});

test('sin prosa de por medio, es simplemente la versión anterior', function () {
  const dir = carpetaCon([htmlBueno('v1'), htmlBueno('v2')]);
  has(lastCompositionHtml(dir, 'marcador-1', 3), 'data-composition-id="v2"');
});

test('si TODAS las previas son prosa, se corrige sin referencia', function () {
  const dir = carpetaCon([NEGATIVA, NEGATIVA]);
  eq(lastCompositionHtml(dir, 'marcador-1', 3), '',
    'mejor sin referencia que con una falsa: el prompt dice "(no disponible)"');
});

test('no se mira hacia adelante: la referencia es una versión ANTERIOR', function () {
  const dir = carpetaCon([htmlBueno('v1'), htmlBueno('v2'), htmlBueno('v3')]);
  has(lastCompositionHtml(dir, 'marcador-1', 3), 'data-composition-id="v2"',
    'para la v3 la referencia es la v2, no la v3 misma');
});

test('renderizar a mano un texto pegado no arranca un render que saldría en negro', async function () {
  let error = null;
  try {
    await engine.renderManualHtml({
      marker: { name: 'Marcador 1', duration: 5 },
      html: 'Perdón, no puedo hacer eso. Cambiá a Agent mode.',
    });
  } catch (e) { error = e; }
  ok(error, 'corta antes de renderizar');
  has(error.message, 'no es una composición HTML');
  has(error.message, 'Pegá el HTML completo', 'y dice qué se esperaba');
});

// --- 4. El arreglo de fondo: en qué modo corre el CLI de Cursor ---------------

/** Corre el proveedor contra el CLI de mentira y devuelve los args que recibió. */
async function argsDeCursor(config) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hp-modo-')), 'recibido.json');
  const prev = { modo: process.env.FAKE_MODE, log: process.env.FAKE_LOG };
  process.env.FAKE_MODE = 'plano';
  process.env.FAKE_LOG = log;
  try {
    await cursor.generate({
      systemPrompt: 'sistema', userPrompt: 'componé esto', images: [],
      model: 'modelo-de-prueba',
      config: Object.assign({ cursorBinPath: FAKE_CURSOR, timeoutMs: 30000, promptViaStdin: true }, config || {}),
    });
  } finally {
    if (prev.modo === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = prev.modo;
    if (prev.log === undefined) delete process.env.FAKE_LOG; else process.env.FAKE_LOG = prev.log;
  }
  return JSON.parse(fs.readFileSync(log, 'utf8')).args;
}

if (!saltarEnWindows) {
  test('el CLI de Cursor NO se invoca en un modo de solo lectura', async function () {
    const args = await argsDeCursor();
    eq(args.indexOf('--mode'), -1,
      'los dos modos que ofrece (ask y plan) son para preguntar y para planear; ' +
      'componer una animación es producir el entregable');
  });

  test('el aislamiento no depende del modo: workspace temporal y nada de --force', async function () {
    const args = await argsDeCursor();
    ok(args.includes('--trust'), 'headless lo exige');
    const ws = args[args.indexOf('--workspace') + 1];
    ok(ws && ws.indexOf('hyperpremiere-cursor-') !== -1,
      'y lo que puede leer es un temporal nuestro, nunca el proyecto del editor');
    ok(!args.includes('--force') && !args.includes('--yolo'),
      'sin permisos abiertos: lo que necesite aprobación queda denegado');
  });

  test('el modo se puede forzar, que es como se mide contra el CLI de verdad', async function () {
    const args = await argsDeCursor({ cursorMode: 'ask' });
    eq(args[args.indexOf('--mode') + 1], 'ask',
      'test/manual/cursor-contrato.js --modo ask reproduce la corrida que se negó');
  });
}
