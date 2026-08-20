'use strict';

// La caja de feedback de la Cola, con el job de una secuencia que NO es la
// abierta. Es lo normal: se encolan varias clases, o se corrige algo generado en
// el corte anterior, y el editor está parado en otra secuencia.
//
// Lo que se rompía: en ese caso la caja cambiaba las imágenes por un cartel
// ("abrí su secuencia en la pestaña Marcadores"), o sea una ronda de feedback
// sin poder mandar la captura que explica el arreglo. Se dibuja la cola de
// verdad y se aprieta ✎ Feedback, porque lo que se quiere probar es el cableado.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');

function elemento(tag) {
  const el = {
    tagName: tag, children: [], listeners: {}, style: {}, className: '',
    textContent: '', value: '', title: '', type: '', rows: 0, childNodes: [],
    appendChild: function (h) { this.children.push(h); this.childNodes.push(h); return h; },
    setAttribute: function (k, v) { this[k] = v; },
    getAttribute: function (k) { return this[k]; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    click: function () { (this.listeners.click || []).forEach(function (f) { f({ stopPropagation: function () {} }); }); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    buscar: function (clase) {
      for (const h of this.children) {
        if (h.className === clase) return h;
        const hit = h.buscar && h.buscar(clase);
        if (hit) return hit;
      }
      return null;
    },
    /** Primer descendiente cuyo texto coincide (los botones se buscan así). */
    porTexto: function (texto) {
      for (const h of this.children) {
        if (String(h.textContent).indexOf(texto) >= 0) return h;
        const hit = h.porTexto && h.porTexto(texto);
        if (hit) return hit;
      }
      return null;
    },
    texto: function () {
      let t = String(this.textContent || '');
      for (const h of this.children) if (h.texto) t += ' ' + h.texto();
      return t;
    },
  };
  el.classList = {
    add: function (c) { el.className = (el.className ? el.className + ' ' : '') + c; },
    remove: function () {},
  };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return ''; },
    set: function () { el.children.length = 0; el.childNodes.length = 0; },
  });
  return el;
}

/** Dibuja la cola con un solo job y devuelve el panel y los espías. */
function dibujar(job) {
  const nodos = {
    'queue-panel': elemento('div'),
    'view-queue': elemento('div'),
    'tab-queue-count': elemento('span'),
  };
  const espia = { controles: [], regenerados: [] };
  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Object: Object, Array: Array, isNaN: isNaN, parseInt: parseInt, Set: Set,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: function () { return 0; }, clearInterval: function () {},
    HPLog: { log: function () {} },
    HPWidgets: { confirmOverlay: function () {} },
    HPEngine: { call: function () { return Promise.resolve({ ok: true }); } },
    HPStills: {
      fbInit: function () {},
      fbClear: function () {},
      fbCollect: function () { return [0]; },
      createControl: function (markerKey, opts) {
        espia.controles.push({ markerKey: markerKey, opts: opts });
        const el = elemento('div');
        el.className = 'marker-stills';
        return el;
      },
    },
    HPQueue: {
      jobs: function () { return [job]; },
      isPending: function (s) { return s === 'queued' || s === 'modeling' || s === 'ready' || s === 'running'; },
      isActive: function (s) { return s === 'modeling' || s === 'ready' || s === 'running'; },
      isPaused: function () { return false; },
      hasActive: function () { return false; },
      hasQueued: function () { return false; },
      isUpgradable: function () { return false; },
      needsPlacing: function () { return false; },
      regenerate: function (id, texto, idx) { espia.regenerados.push({ id: id, texto: texto, idx: idx }); },
      timing: { calibrated: function () { return true; }, estimateSec: function () { return 0; } },
    },
    document: {
      createElement: elemento,
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
    goToJobMarker: function () {},
    setOutput: function () {},
    preparingSequence: function () { return null; },
    sequenceContext: function () { return null; },
  });
  ctx.HPQueueView.render([job]);
  return { ctx: ctx, panel: nodos['queue-panel'], espia: espia, render: function () { ctx.HPQueueView.render([job]); } };
}

function terminado(extra) {
  return Object.assign({
    id: 'j1', status: 'done', kind: 'feedback', label: 'Marcador 2 (corrección)',
    seqName: 'Clase 14_02', projectPath: '/p/Clases.prproj', markerKey: 'Marcador 2',
    markerStart: 120, markerDuration: 8, version: 2, msg: 'Listo y colocado',
  }, extra);
}

/** Abre la caja de feedback como el editor: ✎ Feedback y se redibuja. */
function abrirFeedback(d) {
  const btn = d.panel.porTexto('✎ Feedback');
  ok(btn, 'el job terminado ofrece dar feedback');
  btn.click();
  return d.panel;
}

test('el feedback de un job de otra secuencia ofrece las imágenes igual', function () {
  const d = dibujar(terminado({ storeSeqName: 'Clase 14' }));
  abrirFeedback(d);

  ok(d.panel.buscar('marker-stills'), 'el control de imágenes está en la caja');
  const t = d.panel.texto();
  ok(t.indexOf('abrí su secuencia') < 0, 'y no el cartel que mandaba a otra pestaña');
  has(t, 'las imágenes se envían otra vez', 'con la aclaración de que viajan de nuevo');
});

test('las imágenes se leen de la secuencia del MARCADOR, no de la abierta', function () {
  // storeSeqName = donde nació el recurso (una corrección de un corte anterior).
  const d = dibujar(terminado({ storeSeqName: 'Clase 14' }));
  abrirFeedback(d);
  const c = d.espia.controles[0];
  eq(c.markerKey, 'Marcador 2');
  eq(c.opts.sequenceName, 'Clase 14');
  eq(c.opts.projectPath, '/p/Clases.prproj');
  eq(c.opts.fbJobId, 'j1', 'en modo feedback: cada miniatura decide si se reenvía');
});

test('sin storeSeqName, la secuencia del job es la del material', function () {
  const d = dibujar(terminado());
  abrirFeedback(d);
  eq(d.espia.controles[0].opts.sequenceName, 'Clase 14_02');
});

test('regenerar manda los índices de las imágenes que quedaron activas', function () {
  const d = dibujar(terminado({ storeSeqName: 'Clase 14' }));
  abrirFeedback(d);
  const ta = d.panel.buscar('qj-fb-input');
  ok(ta, 'hay dónde escribir el ajuste');
  ta.listeners.input[0]({ target: { value: 'subí el título' } });
  d.panel.porTexto('↻ Refinar').click();

  eq(d.espia.regenerados.length, 1);
  eq(d.espia.regenerados[0].texto, 'subí el título');
  eq(JSON.stringify(d.espia.regenerados[0].idx), '[0]', 'las que el editor dejó en 📤');
});
