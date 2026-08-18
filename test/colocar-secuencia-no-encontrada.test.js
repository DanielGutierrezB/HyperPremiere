'use strict';

// "Hizo el render pero no lo puso."
//
// El caso real (18/08, log del editor): [Marcador 3] pasó 3m 45s en el modelo,
// renderizó bien en 10,9s y el clip no entró. El motivo que dio el panel fue
// «no se encontró la secuencia "23_…_106595" (¿la cerraste?)» — y la secuencia
// estaba en el proyecto, abierta, con sus marcadores cargados un rato antes. Se
// verificó leyendo el .prproj: ahí está, la última de sesenta y pico.
//
// Lo que fallaba era la búsqueda: el try/catch envolvía TODO el bucle, así que
// una sola secuencia que no se dejara leer lo cortaba y las que venían después
// dejaban de existir. En silencio, y con un mensaje que mandaba a mirar si la
// habías cerrado.
//
// Se prueban las dos mitades del arreglo:
//   1. La búsqueda aguanta una secuencia ilegible y sigue, y cuando de verdad no
//      está, el mensaje dice QUÉ miró (cuántas, en qué proyecto, si está en otro
//      proyecto abierto, cuál es el nombre más parecido).
//   2. Un recurso renderizado que no pudo entrar ofrece "📌 Colocar": el render
//      ya se pagó y no puede costar otra generación entera.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep');

// ── 1. La búsqueda por nombre, con un Premiere de verdad de grande ──────────

/** Una secuencia. Con `ilegible`, leerle el nombre TIRA, como pasa en la vida real. */
function seq(nombre, id, ilegible) {
  const s = { sequenceID: id };
  if (ilegible) {
    Object.defineProperty(s, 'name', {
      get: function () { throw new Error('Sequence is no longer valid'); },
    });
  } else {
    s.name = nombre;
  }
  return s;
}

/** Colección como la ve ExtendScript: numSequences + índices. */
function coleccion(lista) {
  const col = { numSequences: lista.length };
  lista.forEach(function (s, i) { col[i] = s; });
  return col;
}

/**
 * Premiere con `nombres` en el proyecto del frente (un nombre que arranca con
 * "!" es una secuencia ilegible) y, si se pasa `otroProyecto`, un segundo
 * proyecto abierto con sus propias secuencias.
 */
function armar(nombres, opts) {
  opts = opts || {};
  const seqs = nombres.map(function (n, i) {
    return n.charAt(0) === '!' ? seq(n.slice(1), 'id-' + i, true) : seq(n, 'id-' + i);
  });
  const activa = opts.activa ? seqs[nombres.indexOf(opts.activa)] : null;
  const abiertas = [];

  const proyecto = {
    name: opts.nombreProyecto || 'Clases.prproj',
    activeSequence: activa,
    sequences: coleccion(seqs),
    openSequence: function (id) {
      for (let i = 0; i < seqs.length; i++) {
        let nm = '';
        try { nm = seqs[i].name; } catch (e) { nm = '(ilegible)'; }
        if (seqs[i].sequenceID === id) { proyecto.activeSequence = seqs[i]; abiertas.push(nm); }
      }
    },
  };

  const proyectos = [proyecto];
  if (opts.otroProyecto) {
    proyectos.push({
      name: opts.otroProyecto.nombre,
      sequences: coleccion(opts.otroProyecto.secuencias.map(function (n, i) { return seq(n, 'otro-' + i); })),
    });
  }

  const ctx = {
    app: {
      project: proyecto,
      projects: (function () {
        const c = { numProjects: proyectos.length };
        proyectos.forEach(function (p, i) { c[i] = p; });
        return c;
      })(),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(CEP, 'jsx', 'host.jsx'), 'utf8'), ctx, { filename: 'host.jsx' });
  return { host: ctx, seqs: seqs, abiertas: abiertas };
}

// Los nombres reales del proyecto del editor, con la clase del caso al final —
// que es lo que lo hacía tan fácil de perder— y una ilegible antes.
const CLASE = '23_2607_bi-deep-research-ai-1783646520_106595';
const PROYECTO_DEL_EDITOR = [
  '14_2607_bi-deep-research-ai-1783646520_105883',
  '!22_2607_bi-deep-research-ai-1783646520_106594',
  '23_2607_bi-deep-research-ai-1783646520_106595_Backup_Pre-Cut_2026-08-11_15-07',
  CLASE,
];

test('una secuencia ilegible en el medio NO borra del mapa a las que siguen', function () {
  const p = armar(PROYECTO_DEL_EDITOR);
  const encontrada = p.host.hp_findSequenceByName(CLASE);
  ok(encontrada, 'la clase del editor aparece, aunque una anterior no se deje leer');
  eq(encontrada.name, CLASE);
});

test('y el clip llega a colocarse: el caso del 18/08 termina distinto', function () {
  const p = armar(PROYECTO_DEL_EDITOR, { activa: PROYECTO_DEL_EDITOR[0] });
  eq(p.host.hp_activateSequence(CLASE), 'ok', 'se puede activar para trabajar sobre ella');
  eq(p.abiertas.length, 1);
  eq(p.abiertas[0], CLASE, 'y es LA de destino, no otra');
});

test('si la secuencia del frente no se deja leer, se busca en la lista igual', function () {
  // Premiere puede tener al frente una secuencia en un estado en el que leerle
  // el nombre tira. Antes eso salía como "EvalScript error", que no dice nada.
  const p = armar(['!La del frente', CLASE], { activa: '!La del frente' });
  eq(p.host.hp_activateSequence(CLASE), 'ok');
  eq(p.abiertas[0], CLASE);
});

test('cuando de verdad no está, el mensaje dice qué miró', function () {
  const p = armar(PROYECTO_DEL_EDITOR);
  const msg = p.host.hp_findSequenceByName('Clase que no existe') === null
    ? p.host.hp_seqNotFound('Clase que no existe') : 'la encontró (?)';
  has(msg, 'Clases.prproj', 'en qué proyecto buscó');
  has(msg, 'miré 3 secuencia(s)', 'cuántas pudo leer');
  has(msg, '1 no se dejaron leer', 'y que una no se dejó: es la pista de que la lista está incompleta');
});

test('si está en otro proyecto abierto, se dice eso y no se toca ese proyecto', function () {
  // Premiere puede tener varios proyectos abiertos y `app.project` es el del
  // frente. Pasarse de proyecto mientras la cola trabaja es normal, y el
  // mensaje viejo lo llamaba "¿la cerraste?".
  const p = armar(['Otra clase'], { otroProyecto: { nombre: 'Clases-2.prproj', secuencias: [CLASE] } });
  eq(p.host.hp_findSequenceByName(CLASE), null, 'no se coloca en un proyecto que el editor no está mirando');
  const msg = p.host.hp_seqNotFound(CLASE);
  has(msg, 'OTRO proyecto abierto', 'lo dice con todas las letras');
  has(msg, 'Clases-2.prproj', 'y con cuál');
});

test('si hay una parecida, se la nombra: casi siempre es un re-corte', function () {
  // El caso que el editor tiene en el disco: la clase y su re-corte "_01".
  const p = armar([CLASE + '_01']);
  eq(p.host.hp_findSequenceByName(CLASE), null);
  const msg = p.host.hp_seqNotFound(CLASE);
  has(msg, CLASE + '_01', 'la sospechosa, por el prefijo que comparten');
  has(msg, 'renombraste', 'y qué preguntarse');
});

test('un espacio de más no es otra secuencia, si no hay dudas', function () {
  const p = armar(['  ' + CLASE + ' ']);
  const s = p.host.hp_findSequenceByName(CLASE);
  ok(s, 'con una sola candidata "casi igual", es ella');
});

test('con DOS candidatas casi iguales no se adivina', function () {
  // Colocar en la equivocada es peor que no colocar: eso sí le mueve el material
  // al editor, y en la clase que no tocaba.
  const p = armar([CLASE + ' ', CLASE.toUpperCase()]);
  eq(p.host.hp_findSequenceByName(CLASE), null);
});

test('un nombre que no se parece a nada no se ofrece como parecido', function () {
  const p = armar(['Audio', 'BG', 'CAM']);
  eq(p.host.hp_findSequenceByName(CLASE), null);
  const msg = p.host.hp_seqNotFound(CLASE);
  ok(msg.indexOf('parecido') === -1, 'sin sospechosos inventados');
  has(msg, 'cerraste o la renombraste');
});

// ── 2. El render ya está pagado: colocarlo no puede costar otra generación ──

/**
 * La cola con un host que falla al colocar las primeras `fallas` veces.
 * `espia` cuenta lo que se le pidió a Premiere y al motor.
 */
function montarCola(opts) {
  opts = opts || {};
  let fallasRestantes = opts.fallas || 0;
  const espia = { colocados: [], llamadasMotor: [], guardado: null };
  const almacen = {};
  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Object: Object, Array: Array, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(almacen, k) ? almacen[k] : null; },
      setItem: function (k, v) { almacen[k] = String(v); },
    },
    HPLog: { log: function () {} },
    HPConfigUI: { isLocalProvider: function () { return false; }, modelName: function () { return 'modelo'; } },
    HPTranscript: { sliceForMarker: function () { return []; } },
    HPStore: {
      GENERAL_KEY: '__general__',
      getContext: function () { return { projectPath: '/p/Clases.prproj' }; },
      withContext: function (a, b, fn) { return fn(); },
      getTranscript: function () { return []; },
      getMarkerData: function () { return { stills: [], resources: [] }; },
      getMarkerAssets: function () { return []; },
      getTranscriptOffset: function () { return 0; },
      getObjective: function () { return 'objetivo'; },
      setMarkerGenerated: function () {},
      setMarkerTimings: function () {},
      addSessionUsage: function () {},
      totalInput: function (u) { return (u && u.inputTokens) || 0; },
    },
    HPHost: {
      placeClip: function (mov, seq, start, dur, color, hasAudio, cb) {
        espia.colocados.push({ mov: mov, seq: seq, color: color });
        if (fallasRestantes > 0) {
          fallasRestantes--;
          cb('error: no encontré la secuencia "' + seq + '" en el proyecto "Clases.prproj" (miré 61 secuencia(s))');
          return;
        }
        cb('ok');
      },
      recolorClip: function (seq, start, color, mov, cb) { cb('ok'); },
    },
    HPEngine: {
      call: function (m, arg) {
        espia.llamadasMotor.push(m);
        if (m === 'mediaHasAudio') return Promise.resolve({ ok: true, hasAudio: false });
        if (m === 'findRenderedVideo') {
          espia.buscadoEnDisco = arg;
          return Promise.resolve(opts.enDisco || { ok: false, error: 'no hay video' });
        }
        return Promise.resolve({ ok: true });
      },
      callProg: function (m, arg) {
        espia.llamadasMotor.push(m);
        if (m === 'saveQueue') { espia.guardado = arg; return Promise.resolve({ ok: true }); }
        if (m === 'loadQueue') return Promise.resolve({ ok: true, jobs: opts.colaGuardada || [] });
        if (m === 'prepareGenerate' || m === 'prepareFeedback') {
          return Promise.resolve({ ok: true, version: 3, usage: { inputTokens: 10, outputTokens: 20 } });
        }
        return Promise.resolve({ ok: true, version: 3, movPath: '/p/HyperPremiere/clase-23/Marcador 3 v3.mov' });
      },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  ['util.js', 'queue.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(CEP, 'js', f), 'utf8'), ctx, { filename: f });
  });
  return { ctx: ctx, espia: espia };
}

async function dejarCorrer() {
  for (let i = 0; i < 40; i++) await new Promise(function (r) { setTimeout(r, 0); });
}

function job(extra) {
  return Object.assign({
    kind: 'feedback',
    payload: { projectPath: '/p/Clases.prproj', sequenceName: CLASE, mode: 'adjust', markerSlug: 'Marcador 3' },
    seqName: CLASE, projectPath: '/p/Clases.prproj', markerKey: 'Marcador 3',
    label: 'Marcador 3', markerStart: 128.5, markerDuration: 7,
  }, extra);
}

test('el render que no pudo entrar queda listo para colocarse, con su motivo', async function () {
  const c = montarCola({ fallas: 1 });
  c.ctx.HPQueue.add(job());
  await dejarCorrer();

  const j = c.ctx.HPQueue.jobs()[0];
  eq(j.status, 'done', 'el recurso está hecho: el render salió bien');
  ok(j.notPlaced, 'pero marcado como NO colocado');
  eq(j._movPath, '/p/HyperPremiere/clase-23/Marcador 3 v3.mov', 'con el .mov que hay que colocar');
  has(j.msg, 'NO lo coloqué');
  has(j.msg, 'miré 61 secuencia(s)', 'y con el motivo que dio Premiere, no un "falló"');
});

test('colocarlo después no vuelve a llamar al modelo ni al render', async function () {
  const c = montarCola({ fallas: 1 });
  c.ctx.HPQueue.add(job());
  await dejarCorrer();
  const antes = c.espia.llamadasMotor.filter(function (m) {
    return m === 'prepareFeedback' || m === 'prepareGenerate' || m === 'renderPrepared';
  }).length;

  const r = await c.ctx.HPQueue.placeAgain(c.ctx.HPQueue.jobs()[0].id);
  await dejarCorrer();

  eq(r, 'ok');
  const j = c.ctx.HPQueue.jobs()[0];
  ok(!j.notPlaced, 'ya está colocado');
  has(j.msg, 'Colocado');
  eq(c.espia.colocados.length, 2, 'se le pidió a Premiere una segunda vez');
  eq(c.espia.colocados[1].mov, '/p/HyperPremiere/clase-23/Marcador 3 v3.mov', 'el MISMO archivo');
  const despues = c.espia.llamadasMotor.filter(function (m) {
    return m === 'prepareFeedback' || m === 'prepareGenerate' || m === 'renderPrepared';
  }).length;
  eq(despues, antes, 'ni una llamada más de IA o render: eso ya se pagó');
});

test('se coloca con el color que le correspondía, no con otro', async function () {
  // Una corrección va en amarillo para que se vea en un timeline lleno. Si al
  // recolocar saliera magenta, el editor perdería justo esa señal.
  const c = montarCola({ fallas: 1 });
  c.ctx.HPQueue.add(job({ correction: true }));
  await dejarCorrer();
  await c.ctx.HPQueue.placeAgain(c.ctx.HPQueue.jobs()[0].id);
  await dejarCorrer();

  eq(c.espia.colocados[0].color, 15, 'amarillo la primera vez');
  eq(c.espia.colocados[1].color, 15, 'y amarillo al recolocar');
});

test('si sigue sin entrar, se conserva el motivo y se puede reintentar', async function () {
  const c = montarCola({ fallas: 2 });
  c.ctx.HPQueue.add(job());
  await dejarCorrer();
  const msgAntes = c.ctx.HPQueue.jobs()[0].msg;

  const r = await c.ctx.HPQueue.placeAgain(c.ctx.HPQueue.jobs()[0].id);
  await dejarCorrer();

  ok(r !== 'ok');
  const j = c.ctx.HPQueue.jobs()[0];
  ok(j.notPlaced, 'sigue ofreciéndose: la causa puede estar en Premiere y arreglarse en un minuto');
  eq(j.msg, msgAntes, 'y el mensaje no se degrada a "Colocando…" para siempre');
});

test('el recurso que quedó afuera ANTES de este arreglo también se puede colocar', async function () {
  // El caso de verdad: el .mov de [Marcador 3] está en el disco desde el 18/08 y
  // el job que quedó en queue.json es de una versión del panel que no guardaba ni
  // la marca ni la ruta. Se reconoce por su mensaje y el archivo se busca en la
  // carpeta de la secuencia; si no, el único camino sería pagar otra generación.
  const viejo = job({
    id: 'j9', status: 'done', version: 3,
    msg: '⚠ Render OK pero NO lo coloqué (no se tocó tu timeline): error: no se encontró la secuencia',
  });
  const c = montarCola({
    colaGuardada: [viejo],
    enDisco: { ok: true, movPath: '/p/HyperPremiere/clase-23/Marcador 3 v3.mov', version: 3 },
  });
  c.ctx.HPQueue.restore('/p/Clases.prproj');
  await dejarCorrer();

  const j = c.ctx.HPQueue.jobs()[0];
  ok(!j.notPlaced, 'el job viejo no trae la marca…');
  ok(c.ctx.HPQueue.needsPlacing(j), '…y aun así se ofrece colocarlo, por lo que dice su mensaje');

  const r = await c.ctx.HPQueue.placeAgain(j.id);
  await dejarCorrer();
  eq(r, 'ok');
  eq(c.espia.buscadoEnDisco.markerSlug, 'Marcador 3', 'se buscó el video de ESE marcador');
  eq(c.espia.buscadoEnDisco.version, 3, 'y de esa versión');
  eq(c.espia.colocados[0].mov, '/p/HyperPremiere/clase-23/Marcador 3 v3.mov');
  ok(!c.ctx.HPQueue.needsPlacing(c.ctx.HPQueue.jobs()[0]), 'y ya no se ofrece: está colocado');
});

test('si el video ya no está en el disco, se dice y no se pierde el motivo', async function () {
  const c = montarCola({
    enDisco: { ok: false, error: 'no hay video' },
    colaGuardada: [job({
      id: 'j9', status: 'done', version: 3,
      msg: '⚠ Render OK pero NO lo coloqué (no se tocó tu timeline): error X',
    })],
  });
  c.ctx.HPQueue.restore('/p/Clases.prproj');
  await dejarCorrer();
  const msgAntes = c.ctx.HPQueue.jobs()[0].msg;

  const r = await c.ctx.HPQueue.placeAgain('j9');
  await dejarCorrer();

  has(r, 'no encontré el video');
  eq(c.espia.colocados.length, 0, 'no se le pide a Premiere colocar la nada');
  eq(c.ctx.HPQueue.jobs()[0].msg, msgAntes, 'y la fila no queda diciendo "Colocando…" para siempre');
});

test('la posibilidad de colocarlo sobrevive a cerrar el panel', async function () {
  // La causa típica —estabas en otro proyecto, la secuencia estaba cerrada— se
  // arregla reabriendo Premiere, y para entonces el panel ya se reinició. Si
  // esto no se guardara, el botón desaparecería justo cuando por fin funciona.
  const c = montarCola({ fallas: 1 });
  c.ctx.HPQueue.add(job());
  await dejarCorrer();
  await new Promise(function (r) { setTimeout(r, 1100); }); // el guardado va con debounce

  ok(c.espia.guardado, 'se guardó la cola');
  const guardado = c.espia.guardado.jobs[0];
  ok(guardado.notPlaced, 'con la marca');
  eq(guardado._movPath, '/p/HyperPremiere/clase-23/Marcador 3 v3.mov', 'y con el archivo');
  eq(guardado._placeColor, 11, 'y con el color que le tocaba');
});
