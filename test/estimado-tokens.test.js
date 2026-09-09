'use strict';

// El semáforo de tokens: que estime EL PEDIDO QUE SE VA A MANDAR.
//
// Hay dos lugares donde el panel dice cuántos tokens de entrada cuesta un
// marcador —la tarjeta, antes de apretar Generar, y el pie de la Cola, para todo
// lo pendiente— y los dos se armaban su propio cuerpo a mano. La tarjeta mandaba
// el objetivo, el guion, la instrucción y las imágenes DEL MARCADOR, y dejaba
// afuera los dos prompts generales, sus imágenes, el ajuste de una corrección y
// el modo (refinar manda un prompt lean y cuenta distinto). Medido con un prompt
// de curso de 7 kB y dos imágenes de marca: la tarjeta decía ≈4.875 tokens y se
// mandaban ≈9.207. La Cola tenía el mismo agujero por otra puerta: estimaba el
// payload de un job TODAVÍA EN COLA, que no pasó por la rehidratación y no tiene
// ni el material ni los niveles del estilo.
//
// El motor los contaba bien (estimateTokens en engine.js); el que no se los
// pasaba era el que llamaba. Así que lo que se prueba acá no es un número: es
// que el cuerpo que se estima sea el mismo que viaja. Un test que fijara "9.207"
// se rompería el día que cambie el prompt del sistema sin decir nada útil.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const engine = require('../bridge/engine.js');
const CEP = path.join(__dirname, '..', 'cep', 'js');

// Un prompt de curso del tamaño de uno real (~7 kB): es donde el agujero se
// notaba, porque lo que faltaba era justamente esto.
const CURSO = ('Marca ACADEMIA NOVA. Paleta azul institucional #0b1b3a. ' +
  'Tipografía Söhne para títulos, Inter para cuerpo. Nunca tapar la cara del profe. ').repeat(50);
const SECUENCIA = 'Esta clase va en BLANCO Y NEGRO: el color pelea con los ejemplos de fotografía.';
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function proyectoNuevo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-estimado-'));
  return path.join(dir, 'Curso de IA.prproj');
}

/**
 * El TEXTO REAL de una función de main.js. main.js no se puede montar sin un DOM
 * entero, así que en vez de reescribir lo que hace se le saca el cuerpo tal cual
 * y se corre acá, contra los módulos de verdad: lo que se ejecuta es el código
 * de producción, letra por letra. Sirve para cualquier nivel de anidamiento
 * (`updateEstimate` vive adentro de la tarjeta).
 */
function funcionDeMain(nombre) {
  const src = fs.readFileSync(path.join(CEP, 'main.js'), 'utf8');
  const m = new RegExp('\\n(\\s*)function ' + nombre + '\\(').exec(src);
  if (!m) throw new Error('no encontré ' + nombre + ' en main.js');
  const cierre = '\n' + m[1] + '}\n';
  const fin = src.indexOf(cierre, m.index);
  if (fin === -1) throw new Error('no encontré el final de ' + nombre);
  return src.slice(m.index + 1, fin + cierre.length);
}

/**
 * El panel de verdad (los módulos que carga index.html) con el motor de verdad
 * detrás, sobre un proyecto en un tmpdir. Lo único de mentira es la llamada al
 * modelo, que anota el payload que le llegó en vez de contestar.
 */
function montarPanel(proyecto, seqName) {
  const espia = { preparados: [], estimados: [] };
  const almacen = {};
  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Object: Object, Array: Array, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(almacen, k) ? almacen[k] : null; },
      setItem: function (k, v) { almacen[k] = String(v); },
      removeItem: function (k) { delete almacen[k]; },
    },
    HPLog: { log: function () {} },
    HPConfigUI: { isLocalProvider: function () { return false; }, modelName: function () { return 'falso'; } },
    HPTranscript: { sliceForMarker: function (segs) { return segs || []; } },
    HPHost: { placeClip: function (mov, seq, s, d, c, a, cb) { cb('ok'); } },
    HPStore: null, // lo define store.js
    HPEngine: {
      call: function (m, arg) {
        if (m === 'loadGeneralPrompt') return Promise.resolve(engine.loadGeneralPrompt(arg));
        if (m === 'saveGeneralPrompt') return Promise.resolve(engine.saveGeneralPrompt(arg));
        // Las referencias de los dos niveles generales viven en archivos del
        // proyecto, así que acá va el motor de verdad: si viajan como rutas, lo
        // que el estimado cuenta tiene que ser lo que el motor va a leer.
        if (m === 'loadReferences') return Promise.resolve(engine.loadReferences(arg));
        if (m === 'addReference') return Promise.resolve(engine.addReference(arg));
        if (m === 'estimateTokens') {
          espia.estimados.push(arg);
          return Promise.resolve(engine.estimateTokens(arg));
        }
        if (m === 'loadTranscript') return Promise.resolve({ ok: true, found: false });
        if (m === 'mediaHasAudio') return Promise.resolve({ ok: true, hasAudio: false });
        return Promise.resolve({ ok: true });
      },
      callProg: function (m, arg) {
        if (m === 'prepareGenerate' || m === 'prepareFeedback') {
          espia.preparados.push(arg);
          return Promise.resolve({ ok: true, version: 1, usage: { inputTokens: 1, outputTokens: 1 } });
        }
        return Promise.resolve({ ok: true, version: 1, movPath: '/p/x.mov' });
      },
    },
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'store.js', 'general-prompt.js', 'refs.js', 'queue.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  ctx.HPStore.setContext(proyecto, seqName);

  // Los pedazos de main.js que arman el pedido y el estimado, con su texto
  // original. `estimate` y `hpCall` son lo que la tarjeta les da alrededor.
  vm.runInContext(
    'var GEN_KEY = HPStore.GENERAL_KEY;\n' +
    'var currentProjectPath = ' + JSON.stringify(proyecto) + ';\n' +
    'var currentSequenceName = ' + JSON.stringify(seqName) + ';\n' +
    'var hpCall = HPEngine.call;\n' +
    'var estimate = { textContent: "" };\n' +
    'var marker = null;\n' +
    'function modoDeGeneracion() { return HPStore.getMarkerData(markerKeyFor(marker)).generated ? "adjust" : "generate"; }\n' +
    funcionDeMain('markerKeyFor') + '\n' +
    funcionDeMain('buildMarkerPayload') + '\n' +
    funcionDeMain('enqueueMarkerGeneration') + '\n' +
    funcionDeMain('updateEstimate') + '\n' +
    'this.enqueueMarkerGeneration = enqueueMarkerGeneration;\n' +
    'this.updateEstimate = updateEstimate;\n' +
    'this.laTarjeta = { verMarcador: function (m) { marker = m; }, texto: function () { return estimate.textContent; } };',
    ctx, { filename: 'main.js (extracto)' });

  return { ctx: ctx, espia: espia };
}

/**
 * Un marcador con su instrucción, su imagen, y una referencia general de cada
 * nivel: una del CURSO (al lado del .prproj) y una de ESTA CLASE (en la carpeta
 * de la secuencia). Son tres imágenes, en tres alcances distintos, y las tres
 * viajan en el mismo pedido.
 */
async function marcadorConTodo(ctx, proyecto) {
  ctx.HPStore.setObjective('Reconocer los tres componentes de la exposición.');
  ctx.HPStore.setTranscript([{ start: 10, end: 16, text: 'Los tres componentes.' }]);
  const marker = { name: 'M1', start: 10, duration: 6, guid: 'g-1', index: 0 };
  const clave = 'Marcador ' + ctx.HPStore.assignMarkerNumber('g-1');
  ctx.HPStore.setMarkerInstruction(clave, 'Un cartel con los tres componentes.');
  ctx.HPStore.addMarkerStill(clave, IMG);                       // del marcador
  engine.addReference({ projectPath: proyecto, scope: 'course', name: 'marca.png', dataUrl: IMG });
  engine.addReference({
    projectPath: proyecto, sequenceName: 'Clase 12', scope: 'sequence',
    name: 'cuadro-clase.png', dataUrl: IMG,
  });
  await ctx.HPRefs.load(proyecto, 'Clase 12');
  return { marker: marker, clave: clave };
}

async function dejarCorrer() {
  for (let i = 0; i < 40; i++) await new Promise(function (r) { setTimeout(r, 0); });
}

// ── La tarjeta del marcador ──────────────────────────────────────────

test('la tarjeta estima EXACTAMENTE el cuerpo que se encola', async function () {
  // La forma de que no se vuelvan a separar: son la misma función
  // (buildMarkerPayload) y este test lo mira desde afuera, comparando los dos
  // cuerpos campo por campo.
  const proyecto = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: proyecto, text: CURSO, scope: 'project' });
  engine.saveGeneralPrompt({ projectPath: proyecto, sequenceName: 'Clase 12', text: SECUENCIA, scope: 'sequence' });

  const p = montarPanel(proyecto, 'Clase 12');
  await p.ctx.HPGeneral.load(proyecto, 'Clase 12');
  const { marker } = await marcadorConTodo(p.ctx, proyecto);

  p.ctx.laTarjeta.verMarcador(marker);
  p.ctx.updateEstimate();
  await dejarCorrer();
  p.ctx.enqueueMarkerGeneration(marker, 'generate', true);

  eq(p.espia.estimados.length, 1, 'la tarjeta estimó una vez');
  const estimado = p.espia.estimados[0];
  const encolado = p.ctx.HPQueue.jobs()[0].payload;
  eq(JSON.stringify(estimado), JSON.stringify(encolado),
    'el cuerpo estimado y el que se encola son el mismo pedido');
});

test('el estimado de la tarjeta cuenta los dos prompts generales y sus imágenes', async function () {
  const proyecto = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: proyecto, text: CURSO, scope: 'project' });
  engine.saveGeneralPrompt({ projectPath: proyecto, sequenceName: 'Clase 12', text: SECUENCIA, scope: 'sequence' });

  const p = montarPanel(proyecto, 'Clase 12');
  await p.ctx.HPGeneral.load(proyecto, 'Clase 12');
  const { marker } = await marcadorConTodo(p.ctx, proyecto);
  p.ctx.laTarjeta.verMarcador(marker);
  p.ctx.updateEstimate();
  await dejarCorrer();

  const est = engine.estimateTokens(p.espia.estimados[0]);
  ok(est.breakdown.promptChars > CURSO.length + SECUENCIA.length,
    'el texto de los dos niveles está adentro de lo que se cuenta');
  eq(est.breakdown.images, 3, 'las 3 imágenes que viajan: 1 del marcador + 1 del curso + 1 de la clase');
});

test('el número se mueve con lo que de verdad va a viajar', async function () {
  // Sin fijar ningún total: lo que se compara es CUÁNTO cambia el estimado
  // cuando cambia el prompt del curso, contra el tamaño de ese texto. Así el
  // test sigue diciendo algo el día que cambie el prompt del sistema.
  const proyecto = proyectoNuevo();
  const p = montarPanel(proyecto, 'Clase 12');
  await p.ctx.HPGeneral.load(proyecto, 'Clase 12');
  const { marker } = await marcadorConTodo(p.ctx, proyecto);
  p.ctx.laTarjeta.verMarcador(marker);

  p.ctx.updateEstimate();
  await dejarCorrer();
  const sinEstilo = engine.estimateTokens(p.espia.estimados[0]);

  await p.ctx.HPGeneral.save(proyecto, 'Clase 12', CURSO, 'project');
  p.ctx.updateEstimate();
  await dejarCorrer();
  const conEstilo = engine.estimateTokens(p.espia.estimados[1]);

  const crecio = conEstilo.breakdown.promptChars - sinEstilo.breakdown.promptChars;
  ok(crecio >= CURSO.length,
    'el prompt del curso entró entero en la cuenta (creció ' + crecio + ' de ' + CURSO.length + ')');
  ok(crecio < CURSO.length + 500, 'y no se contó dos veces');
});

test('refinar se estima como refinar, que cuenta distinto', async function () {
  // El prompt del refinado es lean (no repite todo el contexto). Estimar
  // siempre "generar" es decir un número de otro pedido.
  const proyecto = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: proyecto, text: CURSO, scope: 'project' });
  const p = montarPanel(proyecto, 'Clase 12');
  await p.ctx.HPGeneral.load(proyecto, 'Clase 12');
  const { marker, clave } = await marcadorConTodo(p.ctx, proyecto);
  p.ctx.laTarjeta.verMarcador(marker);

  p.ctx.updateEstimate();
  await dejarCorrer();
  eq(p.espia.estimados[0].mode, 'generate', 'la primera vez se genera de cero');

  p.ctx.HPStore.setMarkerGenerated(clave, true); // ya tiene una versión
  p.ctx.updateEstimate();
  await dejarCorrer();
  eq(p.espia.estimados[1].mode, 'adjust', 'y desde ahí el botón refina');
  ok(engine.estimateTokens(p.espia.estimados[1]).breakdown.promptChars <
    engine.estimateTokens(p.espia.estimados[0]).breakdown.promptChars,
    'el pedido del refinado es más chico, y el estimado lo dice');
});

// ── El pie de la Cola ────────────────────────────────────────────────

test('lo que la Cola estima de un job en espera es lo que ese job va a mandar', async function () {
  // Una corrección recién encolada: su payload no tiene ningún nivel de
  // contexto ni las imágenes (los resuelve la cola justo antes de llamar al
  // modelo). Estimarlo así era estimar otro pedido, y el número se corregía solo
  // cuando el job arrancaba —o sea, cuando ya no servía para decidir.
  const proyecto = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: proyecto, text: CURSO, scope: 'project' });
  engine.saveGeneralPrompt({ projectPath: proyecto, sequenceName: 'Clase 12', text: SECUENCIA, scope: 'sequence' });

  const p = montarPanel(proyecto, 'Clase 12');
  const { clave } = await marcadorConTodo(p.ctx, proyecto);
  p.ctx.HPQueue.addStaged({
    kind: 'feedback',
    payload: {
      projectPath: proyecto, sequenceName: 'Clase 12', mode: 'adjust',
      markerSlug: clave, instruction: 'Un cartel.', adjustment: 'subí el título',
      previousHtml: '<html></html>',
    },
    seqName: 'Clase 12', projectPath: proyecto, markerKey: clave,
    label: clave + ' (corrección)', markerStart: 10, markerDuration: 6, correction: true,
  });

  const job = p.ctx.HPQueue.jobs()[0];
  const cuerpo = await p.ctx.HPQueue.payloadForEstimate(job);
  const estimado = engine.estimateTokens(cuerpo);

  p.ctx.HPQueue.start();
  await dejarCorrer();
  const viajo = engine.estimateTokens(p.espia.preparados[0]);

  eq(estimado.breakdown.promptChars, viajo.breakdown.promptChars,
    'el prompt estimado y el que se mandó miden lo mismo');
  eq(estimado.breakdown.images, viajo.breakdown.images, 'y las imágenes son las mismas');
  ok(estimado.breakdown.promptChars > CURSO.length, 'con los dos niveles del estilo adentro');
});

test('estimar no le deja nada escrito al job que sigue en cola', async function () {
  // El estimado se dibuja mientras el editor mira la cola; lo que ese job mande
  // se resuelve recién cuando le toca el turno, con el material de ese momento.
  const proyecto = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: proyecto, text: CURSO, scope: 'project' });
  const p = montarPanel(proyecto, 'Clase 12');
  const { clave } = await marcadorConTodo(p.ctx, proyecto);
  p.ctx.HPQueue.addStaged({
    kind: 'generate',
    payload: { projectPath: proyecto, sequenceName: 'Clase 12', mode: 'generate', markerSlug: clave },
    seqName: 'Clase 12', projectPath: proyecto, markerKey: clave,
    label: clave, markerStart: 10, markerDuration: 6,
  });
  const job = p.ctx.HPQueue.jobs()[0];
  const antes = JSON.stringify(job.payload);

  const cuerpo = await p.ctx.HPQueue.payloadForEstimate(job);

  ok(cuerpo.generalInstruction, 'el cuerpo estimado sí tiene el estilo del curso');
  eq(JSON.stringify(job.payload), antes, 'y el job quedó como estaba');
});

// ── El cableado de la vista ──────────────────────────────────────────

test('la vista de la Cola le pide el cuerpo a la cola, no manda el payload crudo', async function () {
  // Es lo único que la vista tiene que hacer bien acá: el que sabe cómo va a
  // viajar un job es la cola (ver payloadForEstimate en queue.js).
  const jobs = [{
    id: 'j1', status: 'queued', kind: 'generate', label: 'Marcador 1',
    seqName: 'Clase 12', projectPath: '/p/x.prproj', markerKey: 'Marcador 1',
    markerStart: 10, markerDuration: 6,
    payload: { markerSlug: 'Marcador 1', crudo: true },
  }];
  const visto = [];
  const nodos = {
    'queue-panel': nodo('div'), 'view-queue': nodo('div'), 'tab-queue-count': nodo('span'),
  };
  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Object: Object, Array: Array, isNaN: isNaN, parseInt: parseInt, Set: Set,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: function () { return 0; }, clearInterval: function () {},
    localStorage: { getItem: function () { return null; }, setItem: function () {} },
    HPLog: { log: function () {} },
    HPWidgets: { confirmOverlay: function () {} },
    HPStills: { fbInit: function () {}, fbClear: function () {}, fbCollect: function () { return []; },
      createControl: function () { return nodo('div'); } },
    HPEngine: {
      call: function (m, body) {
        if (m === 'estimateTokens') visto.push(body);
        return Promise.resolve({ ok: true, inputTokensEst: 10, breakdown: {} });
      },
    },
    HPQueue: {
      jobs: function () { return jobs; },
      isPending: function (s) { return s === 'queued'; },
      isActive: function () { return false; },
      isPaused: function () { return false; },
      hasActive: function () { return false; },
      hasQueued: function () { return true; },
      needsPlacing: function () { return false; },
      // Lo que la cola contesta: el payload YA resuelto.
      payloadForEstimate: function (j) {
        return Promise.resolve({ markerSlug: j.payload.markerSlug, resuelto: true });
      },
      timing: { calibrated: function () { return true; }, estimateSec: function () { return 0; } },
    },
    document: {
      createElement: nodo,
      createTextNode: function (t) { const n = nodo('#text'); n.textContent = t; return n; },
      getElementById: function (id) { return nodos[id] || null; },
    },
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'queue-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  ctx.HPQueueView.init({
    goToJobMarker: function () {}, showJobInTimeline: function () {},
    currentSequence: function () { return 'Clase 12'; }, setOutput: function () {},
    preparingSequence: function () { return null; }, sequenceContext: function () { return null; },
  });
  ctx.HPQueueView.render(jobs);
  await dejarCorrer(); // el cuerpo se lo pide a la cola, y eso es una promesa

  eq(visto.length, 1, 'se estimó el job pendiente');
  eq(visto[0].resuelto, true, 'con el cuerpo que contestó la cola');
  eq(visto[0].crudo, undefined, 'y no con el payload como está guardado en la cola');
});

// ── El estimado contra el prompt que DE VERDAD se manda ──────────────
//
// Los tests de arriba fijan que el cuerpo que se estima sea el que viaja. Estos
// van un escalón más abajo, que es donde quedaban los dos agujeros: con el
// cuerpo correcto, el motor multiplicaba el largo de dos arrays por un fijo
// —1.200 por imagen y 1.500 por documento— sin mirar si esa imagen está en el
// disco ni cómo viaja ese documento. Medido: con una referencia borrada cobraba
// 3 imágenes y viajaban 2 (2.064 tokens de más), y con un `.md` de marca de
// 26.600 caracteres decía 5.131 cuando se mandaban 8.679 (41% corto).
//
// Así que acá no se compara contra ningún número escrito a mano: se arma el
// pedido, se corre el MOTOR de verdad, y se mide el prompt que el proveedor tuvo
// en la mano.

const COMPOSICION = '<!DOCTYPE html><html><body>' +
  '<div id="stage" data-composition-id="marcador-1" data-start="0" data-width="1920" ' +
  'data-height="1080" data-duration="6" data-fps="30"></div>' +
  '<script>const tl = gsap.timeline({ paused: true }); window.__timelines["marcador-1"] = tl;</script>' +
  '</body></html>';

const PROVEEDORES = ['claude-cli', 'cursor-cli', 'claude-api', 'openai-compat', 'ollama'];

/**
 * Corre `fn` con el proveedor de este equipo reemplazado por uno que anota lo
 * que le pasaron y no llama a nadie.
 *
 * Se cambian los CINCO y no el que dice la config a propósito: así el test mide
 * lo mismo en cualquier máquina, sin tocarle la configuración al editor. Y lo
 * que se afirma es una IGUALDAD entre el estimado y lo que viajó, que vale para
 * el proveedor que sea —justamente porque el estimado ahora le pregunta al mismo
 * lugar que la generación—.
 */
async function loQueViaja(body) {
  const visto = {};
  const previos = {};
  PROVEEDORES.forEach(function (id) {
    const ruta = require.resolve('../bridge/providers/' + id + '.js');
    previos[ruta] = require.cache[ruta];
    require.cache[ruta] = {
      exports: {
        generate: async function (arg) {
          if (!visto.arg) visto.arg = arg;
          return { text: COMPOSICION, usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
      loaded: true, id: ruta, filename: ruta, paths: [], children: [],
    };
  });
  try {
    await engine.prepareGenerate(body, function () {});
  } finally {
    Object.keys(previos).forEach(function (ruta) {
      if (previos[ruta]) require.cache[ruta] = previos[ruta];
      else delete require.cache[ruta];
    });
  }
  if (!visto.arg) throw new Error('el pedido nunca llegó al proveedor');
  return visto.arg;
}

const SYSTEM_CHARS = fs.readFileSync(
  path.join(__dirname, '..', 'bridge', 'prompt', 'system.md'), 'utf8').length;

/** Los caracteres de prompt que de verdad recibió el proveedor. */
function charsQueViajaron(arg) {
  return SYSTEM_CHARS + String(arg.userPrompt || '').length;
}

/**
 * El panel montado con su marcador, listo para pedir estimados. Se monta UNA vez
 * por proyecto porque `marcadorConTodo` agrega referencias: llamarlo dos veces
 * sobre el mismo proyecto las duplicaría.
 */
async function panelConMarcador(proyecto) {
  const p = montarPanel(proyecto, 'Clase 12');
  await p.ctx.HPGeneral.load(proyecto, 'Clase 12');
  const { marker } = await marcadorConTodo(p.ctx, proyecto);
  p.ctx.laTarjeta.verMarcador(marker);
  return p;
}

/** El cuerpo que la tarjeta manda a estimar, con lo que el disco diga AHORA. */
async function cuerpoDeLaTarjeta(p, proyecto) {
  await p.ctx.HPRefs.load(proyecto, 'Clase 12');
  p.ctx.updateEstimate();
  await dejarCorrer();
  return p.espia.estimados[p.espia.estimados.length - 1];
}

test('un documento de texto se cuenta por lo que se pega, no por un fijo', async function () {
  // Un manual de marca en `.md` se pega ENTERO en el prompt (hasta 20.000
  // caracteres, DOC_TEXTO_MAX). Cobrarle 1.500 fijos es decir el mismo número
  // para eso que para un PDF, y es la misma forma del bug que la 1.5.1 mató en
  // los prompts generales: un fijo donde había que mirar el contenido.
  const proyecto = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: proyecto, text: CURSO, scope: 'project' });
  const manual = 'Regla de marca número uno, dos y tres. '.repeat(700); // 26.600 chars
  engine.addReference({
    projectPath: proyecto, scope: 'course', name: 'manual-entero.md',
    dataUrl: 'data:text/markdown;base64,' + Buffer.from(manual, 'utf8').toString('base64'),
  });

  const body = await cuerpoDeLaTarjeta(await panelConMarcador(proyecto), proyecto);
  const est = engine.estimateTokens(body);
  const viajo = await loQueViaja(body);

  eq(est.breakdown.promptChars, charsQueViajaron(viajo),
    'el estimado mide el prompt que se mandó, carácter por carácter');
  has(viajo.userPrompt, 'manual-entero.md', 'y el .md se pegó de verdad');
  eq(est.breakdown.docsPasted, 1, 'contado como documento pegado');
  eq(est.breakdown.docsAsFiles, 0, 'y no como archivo para abrir');
});

test('una referencia que el disco no tiene no se cobra: no viaja', async function () {
  // El manifiesto la sigue nombrando y el panel la dibuja desde su caché, así
  // que el editor la ve; el modelo, no. Es el proyecto en un disco externo
  // desmontado, y ya hay un WARN al lado diciendo exactamente eso: el semáforo
  // cobraba 1.200 tokens por lo mismo que el aviso decía que falta.
  const proyecto = proyectoNuevo();
  const p = await panelConMarcador(proyecto);
  eq(engine.estimateTokens(await cuerpoDeLaTarjeta(p, proyecto)).breakdown.images, 3,
    'con todo en su lugar, las tres');

  // Alguien la borró del Finder, o el disco del proyecto no está montado.
  const enDisco = engine.loadReferences({ projectPath: proyecto, sequenceName: 'Clase 12' });
  fs.unlinkSync(enDisco.course[0].file);

  const cuerpo = await cuerpoDeLaTarjeta(p, proyecto);
  const est = engine.estimateTokens(cuerpo);
  const viajo = await loQueViaja(cuerpo);

  eq(est.breakdown.images, (viajo.images || []).length,
    'se cuentan las que viajaron, no las que el manifiesto nombra');
  eq(est.breakdown.imagesMissing, 1, 'y queda dicho que una se quedó afuera');
  eq(est.breakdown.promptChars, charsQueViajaron(viajo),
    'el prompt tampoco la numera: "imagen 3" no existe en este pedido');
});

test('un PDF se cuenta por si le llega a ESTE proveedor', async function () {
  // Con `claude-cli` o `cursor-cli` el PDF viaja (lo abre el agente) y cuesta;
  // con las otras tres puertas no viaja de ninguna forma y cuesta cero. Cobrar
  // 1.500 igual es cobrar por algo que el propio motor avisa que no llega.
  const proyecto = proyectoNuevo();
  engine.addReference({
    projectPath: proyecto, scope: 'course', name: 'Guia.pdf', mediaType: 'application/pdf',
    dataUrl: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 falso').toString('base64'),
  });
  const body = await cuerpoDeLaTarjeta(await panelConMarcador(proyecto), proyecto);

  const conCli = engine.estimateTokens(Object.assign({}, body, { provider: 'claude-cli' }));
  const porHttp = engine.estimateTokens(Object.assign({}, body, { provider: 'ollama' }));

  eq(conCli.breakdown.docsAsFiles, 1, 'el agente lo abre, así que cuesta');
  eq(porHttp.breakdown.docsAsFiles, 0);
  eq(porHttp.breakdown.docsNotTraveling, 1, 'por HTTP no viaja de ninguna forma');
  ok(conCli.inputTokensEst > porHttp.inputTokensEst,
    'y el número lo dice: ' + conCli.inputTokensEst + ' contra ' + porHttp.inputTokensEst);
  eq(porHttp.breakdown.promptChars, conCli.breakdown.promptChars,
    'el prompt es el mismo: la diferencia es lo que el modelo va a abrir, no lo que se escribe');
});

test('el bloque de las imágenes a INCRUSTAR también se cuenta', async function () {
  // `prepareGeneration` le agrega al prompt una sección de ~710 caracteres
  // nombrando los archivos de assets/ — y se la agrega DESPUÉS de armar el
  // cuerpo, que es por donde se le escapaba al estimado.
  const proyecto = proyectoNuevo();
  engine.addReference({
    projectPath: proyecto, scope: 'course', name: 'logo.png', dataUrl: IMG, use: true,
  });
  const body = await cuerpoDeLaTarjeta(await panelConMarcador(proyecto), proyecto);
  const est = engine.estimateTokens(body);
  const viajo = await loQueViaja(body);

  has(viajo.userPrompt, '## Imágenes provistas disponibles como ARCHIVO',
    'el bloque está en el prompt que se mandó');
  const falta = charsQueViajaron(viajo) - est.breakdown.promptChars;
  ok(falta >= 0 && falta < 60,
    'y el estimado lo cuenta salvo las dimensiones en px, que no se leen (faltan ' + falta + ')');
});

test('un marcador CON FONDO cuesta más, y el estimado lo sabe', async function () {
  const proyecto = proyectoNuevo();
  const body = await cuerpoDeLaTarjeta(await panelConMarcador(proyecto), proyecto);
  const sinFondo = engine.estimateTokens(Object.assign({}, body, { background: false }));
  const conFondo = engine.estimateTokens(Object.assign({}, body, { background: true }));
  ok(conFondo.breakdown.promptChars > sinFondo.breakdown.promptChars,
    'el bloque del fondo son otros ~800 caracteres de pedido');

  const viajo = await loQueViaja(Object.assign({}, body, { background: true }));
  eq(conFondo.breakdown.promptChars, charsQueViajaron(viajo));
});

/** Un nodo de mentira, lo mínimo que queue-view le pide al DOM. */
function nodo(tag) {
  const el = {
    tagName: tag, children: [], listeners: {}, style: {}, className: '',
    textContent: '', value: '', title: '', type: '', rows: 0, checked: false, childNodes: [],
    appendChild: function (h) { this.children.push(h); this.childNodes.push(h); return h; },
    setAttribute: function (k, v) { this[k] = v; },
    getAttribute: function (k) { return this[k]; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
  };
  el.classList = { add: function (c) { el.className = (el.className ? el.className + ' ' : '') + c; }, remove: function () {} };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return ''; },
    set: function () { el.children.length = 0; el.childNodes.length = 0; },
  });
  return el;
}
