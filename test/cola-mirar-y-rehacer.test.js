'use strict';

// Tres cosas de la Cola que el editor pidió después de usarla en serio:
//
//   1. Clic en el nombre = ir a verlo al timeline, y nada más. Antes ese clic se
//      llevaba al panel entero a la pestaña Marcadores y recargaba la secuencia:
//      un viaje de ida por mirar un clip de cinco segundos.
//   2. "Regenerar desde cero" dentro de la caja de feedback, como en la tarjeta
//      del marcador. Había un solo botón que refinaba o rediseñaba según si el
//      cuadro tenía texto, y para lo segundo había que irse a Marcadores.
//   3. "Ver solo esta secuencia": la cola junta varias clases a propósito, pero
//      cuando estás sentado en una, lo de las otras es ruido.
//
// Se dibuja la cola de verdad (queue-view sobre un DOM de mentira) y se aprieta
// lo que apretaría el editor: lo que se prueba es el cableado.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');

function elemento(tag) {
  const el = {
    tagName: tag, children: [], listeners: {}, style: {}, className: '',
    textContent: '', value: '', title: '', type: '', rows: 0, checked: false, childNodes: [],
    appendChild: function (h) { this.children.push(h); this.childNodes.push(h); return h; },
    setAttribute: function (k, v) { this[k] = v; },
    getAttribute: function (k) { return this[k]; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    click: function () { (this.listeners.click || []).forEach(function (f) { f({ stopPropagation: function () {} }); }); },
    change: function () { (this.listeners.change || []).forEach(function (f) { f({}); }); },
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

/**
 * Dibuja la cola con `jobs`. `opts.secuenciaAbierta` es la que el panel cree
 * abierta (la del filtro); `opts.recordado` simula la preferencia guardada de
 * una sesión anterior.
 */
function dibujar(jobs, opts) {
  opts = opts || {};
  const nodos = {
    'queue-panel': elemento('div'),
    'view-queue': elemento('div'),
    'tab-queue-count': elemento('span'),
  };
  const guardado = {};
  if (opts.recordado) guardado['hyperpremiere::queue-only-current'] = '1';
  const espia = {
    timeline: [], aMarcadores: [], regenerados: [], desdeCero: [],
    salidas: [], confirmaciones: [], limpiados: [],
  };
  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Object: Object, Array: Array, isNaN: isNaN, parseInt: parseInt, Set: Set,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: function () { return 0; }, clearInterval: function () {},
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(guardado, k) ? guardado[k] : null; },
      setItem: function (k, v) { guardado[k] = String(v); },
    },
    HPLog: { log: function () {} },
    HPWidgets: {
      // El overlay de confirmación: se anota y se ejecuta el "sí" solo si el
      // test lo pide, que es como se distingue avisar de hacer.
      confirmOverlay: function (titulo, cuerpo, boton, onOk) {
        espia.confirmaciones.push({ titulo: titulo, boton: boton, aceptar: onOk });
      },
    },
    HPEngine: { call: function () { return Promise.resolve({ ok: true }); } },
    HPStills: {
      fbInit: function () {}, fbClear: function () {}, fbCollect: function () { return [0]; },
      createControl: function () { const el = elemento('div'); el.className = 'marker-stills'; return el; },
    },
    HPQueue: {
      jobs: function () { return jobs; },
      isPending: function (s) { return s === 'queued' || s === 'modeling' || s === 'ready' || s === 'running'; },
      isActive: function (s) { return s === 'modeling' || s === 'ready' || s === 'running'; },
      isPaused: function () { return false; },
      hasActive: function () { return false; },
      hasQueued: function () { return false; },
      isUpgradable: function () { return false; },
      needsPlacing: function () { return false; },
      regenerate: function (id, texto, idx) { espia.regenerados.push({ id: id, texto: texto, idx: idx }); },
      regenerateFresh: function (id) { espia.desdeCero.push(id); },
      timing: { calibrated: function () { return true; }, estimateSec: function () { return 0; } },
    },
    document: {
      createElement: elemento,
      createTextNode: function (t) { const n = elemento('#text'); n.textContent = t; return n; },
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
    goToJobMarker: function (job, abrirEditor) { espia.aMarcadores.push({ job: job, abrirEditor: abrirEditor }); },
    showJobInTimeline: function (job) { espia.timeline.push(job); },
    currentSequence: function () { return opts.secuenciaAbierta || ''; },
    setOutput: function (txt, esError) { espia.salidas.push({ txt: txt, esError: esError }); },
    preparingSequence: function () { return null; },
    sequenceContext: function () { return null; },
  });
  ctx.HPQueueView.render(jobs);
  return {
    ctx: ctx, panel: nodos['queue-panel'], espia: espia, guardado: guardado,
    render: function () { ctx.HPQueueView.render(jobs); },
  };
}

function terminado(extra) {
  return Object.assign({
    id: 'j1', status: 'done', kind: 'feedback', label: 'Marcador 1 (corrección)',
    seqName: 'Clase 23', projectPath: '/p/Clases.prproj', markerKey: 'Marcador 1',
    markerStart: 128.5, markerDuration: 8, version: 4, msg: 'Listo y colocado',
  }, extra);
}

function abrirFeedback(d) {
  const btn = d.panel.porTexto('✎ Feedback');
  ok(btn, 'el job terminado ofrece dar feedback');
  btn.click();
  return d.panel;
}

// ── 1. Clic en el nombre: al timeline y nada más ─────────────────────

test('el nombre lleva al timeline, sin arrastrar el panel a otra pestaña', function () {
  const d = dibujar([terminado()]);
  const nombre = d.panel.porTexto('Marcador 1 (corrección)');
  ok(nombre, 'el nombre está');
  nombre.click();

  eq(d.espia.timeline.length, 1, 'se fue a verlo al timeline');
  eq(d.espia.timeline[0].markerStart, 128.5, 'al segundo donde está el recurso');
  eq(d.espia.aMarcadores.length, 0, 'y NO se cambió de pestaña ni se recargó la secuencia');
  has(nombre.title, 'timeline', 'lo que promete el tooltip es lo que hace');
});

test('a Marcadores se sigue llegando por “Editar HTML”, que sí lo necesita', function () {
  const d = dibujar([terminado()]);
  d.panel.porTexto('✎ Editar HTML').click();
  eq(d.espia.aMarcadores.length, 1);
  eq(d.espia.aMarcadores[0].abrirEditor, true, 'y con el editor abierto');
  eq(d.espia.timeline.length, 0);
});

// ── 2. Refinar y regenerar desde cero, las dos ahí mismo ─────────────

test('la caja de feedback ofrece las dos salidas', function () {
  const d = dibujar([terminado()]);
  abrirFeedback(d);
  ok(d.panel.porTexto('↻ Refinar'), 'refinar sobre lo que hay');
  ok(d.panel.porTexto('⟲ Regenerar desde cero'), 'o tirarlo y rediseñar');
});

test('refinar manda el texto y las imágenes que quedaron activas', function () {
  const d = dibujar([terminado()]);
  abrirFeedback(d);
  d.panel.buscar('qj-fb-input').listeners.input[0]({ target: { value: 'subí el título' } });
  d.panel.porTexto('↻ Refinar').click();

  eq(d.espia.regenerados.length, 1);
  eq(d.espia.regenerados[0].texto, 'subí el título');
  eq(JSON.stringify(d.espia.regenerados[0].idx), '[0]', 'las que el editor dejó en 📤');
  eq(d.espia.desdeCero.length, 0);
});

test('refinar sin escribir nada avisa, en vez de rediseñar por su cuenta', function () {
  // Era lo que pasaba antes: el cuadro vacío y el mismo botón hacía una
  // regeneración total. El editor se enteraba al ver el resultado.
  const d = dibujar([terminado()]);
  abrirFeedback(d);
  d.panel.porTexto('↻ Refinar').click();

  eq(d.espia.regenerados.length, 0, 'no se encoló nada');
  eq(d.espia.desdeCero.length, 0);
  eq(d.espia.salidas.length, 1);
  has(d.espia.salidas[0].txt, 'Escribí qué ajustar');
  eq(d.espia.salidas[0].esError, true);
});

test('desde cero, con el cuadro vacío, va directo', function () {
  const d = dibujar([terminado()]);
  abrirFeedback(d);
  d.panel.porTexto('⟲ Regenerar desde cero').click();

  eq(d.espia.desdeCero.length, 1);
  eq(d.espia.desdeCero[0], 'j1');
  eq(d.espia.confirmaciones.length, 0, 'sin preguntas: no hay nada que perder');
  eq(d.espia.regenerados.length, 0, 'y no es un refinamiento disfrazado');
});

test('desde cero, con feedback escrito, pregunta antes de tirarlo', function () {
  const d = dibujar([terminado()]);
  abrirFeedback(d);
  d.panel.buscar('qj-fb-input').listeners.input[0]({ target: { value: 'el fondo tapa el texto' } });
  d.panel.porTexto('⟲ Regenerar desde cero').click();

  eq(d.espia.desdeCero.length, 0, 'todavía no hizo nada');
  eq(d.espia.confirmaciones.length, 1, 'avisa que ese texto no se va a usar');
  d.espia.confirmaciones[0].aceptar();
  eq(d.espia.desdeCero.length, 1, 'y recién ahí rediseña');
});

// ── 3. Ver solo esta secuencia ───────────────────────────────────────

function tresClases() {
  return [
    terminado({ id: 'j1', seqName: 'Clase 23', label: 'Marcador 1' }),
    terminado({ id: 'j2', seqName: 'Clase 24', label: 'Marcador 2' }),
    terminado({ id: 'j3', seqName: 'Clase 23', label: 'Marcador 3' }),
    terminado({ id: 'j4', seqName: 'Clase 25', label: 'Marcador 4' }),
  ];
}

test('el filtro solo se ofrece cuando hay algo de otras secuencias', function () {
  const solaClase = dibujar([terminado()], { secuenciaAbierta: 'Clase 23' });
  eq(solaClase.panel.buscar('queue-filter'), null, 'con una sola clase en la cola sería ruido');

  const varias = dibujar(tresClases(), { secuenciaAbierta: 'Clase 23' });
  ok(varias.panel.buscar('queue-filter'), 'con varias, aparece');
});

test('sin filtro se ve todo; con filtro, solo la secuencia abierta', function () {
  const d = dibujar(tresClases(), { secuenciaAbierta: 'Clase 23' });
  has(d.panel.texto(), 'Clase 24', 'de entrada están todas');

  const cb = d.panel.buscar('queue-filter').children[0];
  cb.checked = true; cb.change();

  const t = d.panel.texto();
  has(t, 'Clase 23');
  ok(t.indexOf('Clase 24') === -1, 'las otras clases no se dibujan');
  ok(t.indexOf('Clase 25') === -1);
  has(t, '2 marcador(es) de otras secuencias ocultos', 'y se dice cuántos quedaron afuera');
});

test('el filtro no toca la cola: los contadores siguen siendo de todo', function () {
  // Es lo que evita el susto de creer que se borraron los demás.
  const d = dibujar(tresClases().map(function (j, i) {
    return i ? j : Object.assign(j, { status: 'queued' });
  }), { secuenciaAbierta: 'Clase 23' });
  const cb = d.panel.buscar('queue-filter').children[0];
  cb.checked = true; cb.change();

  eq(d.ctx.HPQueue.jobs().length, 4, 'la cola sigue teniendo los cuatro');
  has(d.panel.texto(), 'en proceso/espera', 'y la cabecera cuenta sobre el total');
});

test('la preferencia se recuerda entre sesiones', function () {
  const d = dibujar(tresClases(), { secuenciaAbierta: 'Clase 23' });
  const cb = d.panel.buscar('queue-filter').children[0];
  cb.checked = true; cb.change();
  eq(d.guardado['hyperpremiere::queue-only-current'], '1', 'queda guardada');

  const otra = dibujar(tresClases(), { secuenciaAbierta: 'Clase 23', recordado: true });
  eq(otra.panel.buscar('queue-filter').children[0].checked, true, 'y vuelve marcada');
  ok(otra.panel.texto().indexOf('Clase 24') === -1, 'filtrando de una');
});

test('si no hay nada de la secuencia abierta, se dice en vez de quedar en blanco', function () {
  const d = dibujar(tresClases(), { secuenciaAbierta: 'Clase 99', recordado: true });
  const t = d.panel.texto();
  has(t, 'No hay nada de “Clase 99”');
  has(t, '4 marcador(es) de otras secuencias ocultos');
  ok(d.panel.buscar('queue-filter'), 'y el filtro sigue ahí para poder destildarlo');
});
