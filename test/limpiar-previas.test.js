'use strict';

// "🧹 Limpiar previas": dejar solo la versión aprobada de UN recurso, sacando las
// anteriores del disco Y de las secuencias donde estén.
//
// Es lo que se hace al cerrar una clase: quedaste conforme con la v5 y las
// cuatro anteriores son cientos de MB que además Premiere sigue mostrando en el
// proyecto. Tres cosas tienen que salir bien o el arreglo es peor que el
// problema: (1) no tocar los OTROS marcadores, que pueden estar a medio revisar;
// (2) sacar los clips de Premiere ANTES de borrar los archivos, o el editor se
// come el cartel de "Link Media"; (3) identificar los clips por RUTA y no por
// nombre, porque cada clase tiene su "Marcador 1 v1 [modelo].mov".

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const engine = require('../bridge/engine');
const CEP = path.join(__dirname, '..', 'cep', 'js');

// ── Motor: qué se borra del disco ────────────────────────────────────

/** Proyecto descartable con la estructura real que arma el motor. */
function armarProyecto(seqName) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-clean-'));
  const proyecto = path.join(raiz, 'Clases.prproj');
  fs.writeFileSync(proyecto, 'x');
  const dir = path.join(raiz, 'HyperPremiere', String(seqName).toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  return {
    projectPath: proyecto, sequenceName: seqName, dir: dir,
    /** Una versión completa en disco: video + html + ficha. */
    version: function (slug, v, bytes) {
      const base = slug + ' v' + v + ' [claude-sonnet-5]';
      fs.writeFileSync(path.join(dir, base + '.mov'), Buffer.alloc(bytes || 1024));
      fs.writeFileSync(path.join(dir, base + '.html'), '<div id="stage"></div>');
      fs.writeFileSync(path.join(dir, base + '.meta.json'), JSON.stringify({ version: v }));
      return this;
    },
    hay: function (nombre) { return fs.existsSync(path.join(dir, nombre)); },
    cuerpo: function (extra) {
      return Object.assign({ projectPath: proyecto, sequenceName: seqName }, extra || {});
    },
  };
}

test('la vista previa de un solo recurso no cuenta los demás', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1).version('Marcador 1', 2).version('Marcador 1', 3);
  p.version('Marcador 2', 1).version('Marcador 2', 2);

  const solo = engine.cleanupPreview(p.cuerpo({ markerSlug: 'Marcador 1' }));
  eq(solo.totalDeletes, 2, 'las dos previas del Marcador 1');
  eq(solo.groups.length, 1, 'y nada del Marcador 2, que quizá todavía no está aprobado');
  eq(solo.groups[0].keep.version, 3, 'se conserva la última');

  const todo = engine.cleanupPreview(p.cuerpo());
  eq(todo.totalDeletes, 3, 'sin marcador, sigue siendo la limpieza de toda la secuencia');
});

test('borra las previas de ese recurso y no toca las de otro', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1).version('Marcador 1', 2);
  p.version('Marcador 2', 1).version('Marcador 2', 2);

  const r = engine.cleanOldVersions(p.cuerpo({ markerSlug: 'Marcador 1' }));
  eq(r.ok, true);
  eq(r.deleted, 1);
  ok(!p.hay('Marcador 1 v1 [claude-sonnet-5].mov'), 'se fue la previa');
  ok(p.hay('Marcador 1 v2 [claude-sonnet-5].mov'), 'quedó la aprobada');
  ok(p.hay('Marcador 2 v1 [claude-sonnet-5].mov'), 'el otro marcador sigue intacto');
});

test('los HTMLs y las fichas se conservan: ahí vive la historia', function () {
  // La pestaña Corrections vuelve sobre una versión vieja leyendo su HTML, y son
  // kilobytes. El peso que se quiere sacar del proyecto está en los videos.
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1).version('Marcador 1', 2);
  engine.cleanOldVersions(p.cuerpo({ markerSlug: 'Marcador 1' }));
  ok(p.hay('Marcador 1 v1 [claude-sonnet-5].html'), 'el HTML de la previa sigue ahí');
  ok(p.hay('Marcador 1 v1 [claude-sonnet-5].meta.json'), 'y su ficha');
});

test('lo que se lista para sacar de Premiere son RUTAS, no nombres', function () {
  // El panel se las pasa al host tal cual: por nombre se limpiaba de una clase
  // lo que estaba aprobado en otra (todas tienen su "Marcador 1 v1 …").
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1).version('Marcador 1', 2);
  const r = engine.listOldVersions(p.cuerpo({ markerSlug: 'Marcador 1' }));
  eq(r.files.length, 1);
  eq(r.files[0].path, path.join(p.dir, 'Marcador 1 v1 [claude-sonnet-5].mov'));
});

test('sin versiones previas no hay nada que borrar', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1);
  eq(engine.cleanupPreview(p.cuerpo({ markerSlug: 'Marcador 1' })).totalDeletes, 0);
  eq(engine.cleanOldVersions(p.cuerpo({ markerSlug: 'Marcador 1' })).deleted, 0);
  ok(p.hay('Marcador 1 v1 [claude-sonnet-5].mov'));
});

// ── Host: a quién saca de Premiere ───────────────────────────────────

/** Colección como la ve ExtendScript: numItems + índices. */
function coleccion(lista, cuenta) {
  Object.defineProperty(lista, cuenta, { get: function () { return lista.length; } });
  return lista;
}

/**
 * Premiere de mentira con secuencias y bin raíz. `clases` es
 * { nombreSecuencia: [ { name, path } ] } — cada entrada, un clip en su pista de
 * video con su ítem en el proyecto.
 */
function armarPremiere(clases) {
  const raiz = { name: 'root', type: 2, children: coleccion([], 'numItems'), padre: null };
  raiz.createBin = function (n) {
    const b = { name: n, type: 2, children: coleccion([], 'numItems'), padre: raiz };
    b.deleteBin = function () { raiz.children.splice(raiz.children.indexOf(b), 1); };
    raiz.children.push(b);
    return b;
  };

  const seqs = [];
  Object.keys(clases).forEach(function (nombre) {
    const clips = coleccion([], 'numItems');
    const pista = { clips: clips };
    clases[nombre].forEach(function (a) {
      const item = {
        name: a.name, type: 1, padre: raiz,
        getMediaPath: function () { return a.path; },
      };
      item.moveBin = function (destino) {
        item.padre.children.splice(item.padre.children.indexOf(item), 1);
        destino.children.push(item);
        item.padre = destino;
      };
      raiz.children.push(item);
      const clip = { name: a.name, projectItem: item };
      clip.remove = function () { clips.splice(clips.indexOf(clip), 1); };
      clips.push(clip);
    });
    seqs.push({ name: nombre, videoTracks: coleccion([pista], 'numTracks'), audioTracks: coleccion([], 'numTracks') });
  });

  const sequences = { numSequences: seqs.length };
  seqs.forEach(function (s, i) { sequences[i] = s; });

  function File(p) { this.fsName = p; this.name = String(p).split('/').pop(); }
  const ctx = { File: File, app: { project: { rootItem: raiz, sequences: sequences, activeSequence: seqs[0] } } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'cep', 'jsx', 'host.jsx'), 'utf8'), ctx, { filename: 'host.jsx' });
  return {
    host: ctx, raiz: raiz,
    /** Nombres de los clips que quedaron en la secuencia. */
    clipsDe: function (nombre) {
      const s = seqs.filter(function (x) { return x.name === nombre; })[0];
      return s.videoTracks[0].clips.map(function (c) { return c.name; });
    },
    itemsDelProyecto: function () { return raiz.children.map(function (c) { return c.name; }); },
  };
}

// Todas las clases tienen su "Marcador 1": los nombres de archivo se repiten
// entre secuencias y solo la ruta dice de cuál es.
const MISMO_NOMBRE = 'Marcador 1 v1 [claude-sonnet-5].mov';
const EN_CLASE_14 = '/p/HyperPremiere/clase-14/' + MISMO_NOMBRE;
const EN_CLASE_23 = '/p/HyperPremiere/clase-23/' + MISMO_NOMBRE;

test('saca el clip de la versión vieja y su ítem del proyecto', function () {
  const p = armarPremiere({ 'Clase 14': [{ name: MISMO_NOMBRE, path: EN_CLASE_14 }] });
  const r = p.host.hp_purgeClipsByPath(EN_CLASE_14);
  eq(r, 'ok|1|1');
  eq(p.clipsDe('Clase 14').length, 0, 'se fue del timeline');
  eq(p.itemsDelProyecto().length, 0, 'y del proyecto, así no queda el ítem roto');
});

test('el homónimo de OTRA clase no se toca', function () {
  // Acá estaba el peligro de limpiar por nombre: se llevaba de otra clase un clip
  // ya aprobado, y como su archivo no se borraba, desaparecía sin ninguna señal.
  const p = armarPremiere({
    'Clase 14': [{ name: MISMO_NOMBRE, path: EN_CLASE_14 }],
    'Clase 23': [{ name: MISMO_NOMBRE, path: EN_CLASE_23 }],
  });
  p.host.hp_purgeClipsByPath(EN_CLASE_14);
  eq(p.clipsDe('Clase 14').length, 0, 'la que se limpia queda limpia');
  eq(p.clipsDe('Clase 23').length, 1, 'la otra clase sigue con su clip');
  eq(p.itemsDelProyecto().length, 1, 'y con su ítem en el proyecto');
});

test('varias versiones a la vez, cada una por su ruta', function () {
  const v1 = '/p/HyperPremiere/clase-14/Marcador 1 v1 [m].mov';
  const v2 = '/p/HyperPremiere/clase-14/Marcador 1 v2 [m].mov';
  const v3 = '/p/HyperPremiere/clase-14/Marcador 1 v3 [m].mov';
  const p = armarPremiere({ 'Clase 14': [
    { name: 'Marcador 1 v1 [m].mov', path: v1 },
    { name: 'Marcador 1 v2 [m].mov', path: v2 },
    { name: 'Marcador 1 v3 [m].mov', path: v3 },
  ] });
  const r = p.host.hp_purgeClipsByPath(v1 + '\n' + v2);
  eq(r, 'ok|2|2');
  eq(p.clipsDe('Clase 14').join(), 'Marcador 1 v3 [m].mov', 'queda solo la aprobada');
});

test('Windows escribe la unidad como quiere: la ruta se compara sin caja', function () {
  const enDisco = 'C:\\Users\\Edu\\Clases\\HyperPremiere\\clase-14\\Marcador 1 v1 [m].mov';
  const p = armarPremiere({ 'Clase 14': [{ name: 'Marcador 1 v1 [m].mov', path: enDisco }] });
  eq(p.host.hp_purgeClipsByPath(enDisco.replace('C:', 'c:')), 'ok|1|1');
});

test('sin rutas no se lleva nada por delante', function () {
  const p = armarPremiere({ 'Clase 14': [{ name: MISMO_NOMBRE, path: EN_CLASE_14 }] });
  eq(p.host.hp_purgeClipsByPath(''), 'ok|0|0');
  eq(p.clipsDe('Clase 14').length, 1);
});

// ── Panel: el botón de la fila terminada ─────────────────────────────

function elemento(tag) {
  const el = {
    tagName: tag, children: [], childNodes: [], listeners: {}, style: {}, className: '',
    textContent: '', value: '', title: '', type: '',
    appendChild: function (h) { this.children.push(h); this.childNodes.push(h); return h; },
    setAttribute: function (k, v) { this[k] = v; },
    getAttribute: function (k) { return this[k]; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    click: function () { (this.listeners.click || []).forEach(function (f) { f({ stopPropagation: function () {} }); }); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    /** Primer descendiente cuyo texto contiene `texto`. */
    porTexto: function (texto) {
      for (const h of this.children) {
        if (String(h.textContent).indexOf(texto) >= 0) return h;
        const hit = h.porTexto && h.porTexto(texto);
        if (hit) return hit;
      }
      return null;
    },
  };
  el.classList = { add: function (c) { el.className = (el.className ? el.className + ' ' : '') + c; }, remove: function () {} };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return ''; },
    set: function () { el.children.length = 0; el.childNodes.length = 0; },
  });
  return el;
}

/** Dibuja la cola con un job terminado y espía motor, host y confirmación. */
function dibujar(job, opts) {
  opts = opts || {};
  const nodos = {
    'queue-panel': elemento('div'),
    'view-queue': elemento('div'),
    'tab-queue-count': elemento('span'),
  };
  const espia = { llamadas: [], purgados: [], salidas: [], confirmaciones: [] };
  const previa = opts.previa || {
    ok: true, sequenceName: 'Clase 14 v1', totalDeletes: 2, totalBytes: 2 * 1048576,
    groups: [{ slug: 'Marcador 3', keep: { name: 'Marcador 3 v3.mov', version: 3 },
      deletes: [{ name: 'Marcador 3 v1.mov', version: 1, size: 1048576 },
        { name: 'Marcador 3 v2.mov', version: 2, size: 1048576 }] }],
  };
  const viejos = opts.viejos !== undefined ? opts.viejos
    : [{ name: 'Marcador 3 v1.mov', path: '/p/HyperPremiere/clase-14-v1/Marcador 3 v1.mov', size: 1048576 },
      { name: 'Marcador 3 v2.mov', path: '/p/HyperPremiere/clase-14-v1/Marcador 3 v2.mov', size: 1048576 }];

  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Object: Object, Array: Array, isNaN: isNaN, parseInt: parseInt, Set: Set,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: function () { return 0; }, clearInterval: function () {},
    HPLog: { log: function () {} },
    HPWidgets: {
      // La confirmación de verdad dibuja el detalle; acá se guarda y se acepta a mano.
      confirmOverlay: function (titulo, dibuja, textoBoton, alAceptar) {
        const body = elemento('div');
        dibuja(body);
        espia.confirmaciones.push({ titulo: titulo, boton: textoBoton, body: body, aceptar: alAceptar });
      },
    },
    HPHost: {
      purgeClipsByPath: function (rutas, cb) { espia.purgados.push(rutas); cb('ok|2|2'); },
    },
    HPEngine: {
      call: function (metodo, arg) {
        espia.llamadas.push({ metodo: metodo, arg: arg });
        if (metodo === 'cleanupPreview') return Promise.resolve(previa);
        if (metodo === 'listOldVersions') return Promise.resolve({ ok: true, files: viejos });
        if (metodo === 'cleanOldVersions') return Promise.resolve({ ok: true, deleted: viejos.length, freedBytes: 2097152 });
        return Promise.resolve({ ok: true });
      },
    },
    HPStills: { fbInit: function () {}, fbClear: function () {}, fbCollect: function () { return []; },
      createControl: function () { return elemento('div'); } },
    HPStore: { getContext: function () { return { projectPath: '/p/Clases.prproj', sequenceName: 'Clase 14' }; },
      getSessionUsage: function () { return null; } },
    HPConfigUI: { isLocalProvider: function () { return false; } },
    HPQueue: {
      jobs: function () { return [job]; },
      isPending: function () { return false; },
      isActive: function () { return false; },
      isPaused: function () { return false; },
      hasActive: function () { return false; },
      hasQueued: function () { return false; },
      isUpgradable: function () { return false; },
      needsPlacing: function () { return false; },
      timing: { calibrated: function () { return true; }, estimateSec: function () { return 0; } },
    },
    document: {
      createElement: elemento,
      createTextNode: function (t) { const n = elemento('#text'); n.textContent = t; return n; },
      getElementById: function (id) { return nodos[id] || null; },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'queue-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  ctx.HPQueueView.init({
    goToJobMarker: function () {},
    setOutput: function (t, err) { espia.salidas.push({ texto: t, error: err }); },
    preparingSequence: function () { return null; },
    sequenceContext: function () { return null; },
  });
  ctx.HPQueueView.render([job]);
  return { panel: nodos['queue-panel'], espia: espia };
}

function jobTerminado(extra) {
  return Object.assign({
    id: 'j1', kind: 'feedback', status: 'done', label: 'Marcador 3', msg: '✓ Listo y colocado',
    seqName: 'Clase 14', projectPath: '/p/Clases.prproj', markerKey: 'Marcador 3',
    markerStart: 128.5, markerDuration: 7, version: 3, payload: {},
  }, extra);
}

/** El botón de limpiar previas de la fila (null si no se ofrece). */
function botonLimpiar(panel) {
  return panel.porTexto('Limpiar previas');
}

test('un job terminado ofrece limpiar sus versiones previas', function () {
  const d = dibujar(jobTerminado());
  ok(botonLimpiar(d.panel), 'el botón está en la fila del job');
});

test('en una v1 no se ofrece: no hay nada anterior', function () {
  const d = dibujar(jobTerminado({ version: 1 }));
  eq(botonLimpiar(d.panel), null);
});

test('si no se sabe la versión, se ofrece igual', function () {
  // Un job que quedó de otra sesión no la trae; la confirmación va a decir qué
  // hay, que es mejor que esconder el botón por no saber.
  const d = dibujar(jobTerminado({ version: undefined }));
  ok(botonLimpiar(d.panel));
});

test('pregunta por ESE recurso y en la secuencia donde nació', async function () {
  // En una corrección los archivos viven en la carpeta del corte viejo, no en la
  // secuencia que el editor tiene abierta.
  const d = dibujar(jobTerminado({ storeSeqName: 'Clase 14 v1' }));
  botonLimpiar(d.panel).click();
  await new Promise(function (r) { setTimeout(r, 0); });

  const q = d.espia.llamadas.filter(function (l) { return l.metodo === 'cleanupPreview'; });
  eq(q.length, 1, 'una sola consulta: la del recurso');
  eq(q[0].arg.markerSlug, 'Marcador 3');
  eq(q[0].arg.sequenceName, 'Clase 14 v1');
  eq(d.espia.purgados.length, 0, 'todavía no tocó nada: primero pregunta');
});

test('recién al aceptar saca los clips de Premiere y después borra', async function () {
  const d = dibujar(jobTerminado({ storeSeqName: 'Clase 14 v1' }));
  botonLimpiar(d.panel).click();
  await new Promise(function (r) { setTimeout(r, 0); });

  const c = d.espia.confirmaciones[0];
  has(c.titulo, 'Marcador 3', 'la pregunta dice de qué recurso es');
  has(c.boton, '2', 'y cuántos videos se van');
  c.aceptar();
  await new Promise(function (r) { setTimeout(r, 0); });

  eq(d.espia.purgados.length, 1, 'se sacaron de Premiere');
  eq(d.espia.purgados[0].length, 2);
  has(d.espia.purgados[0][0], '/HyperPremiere/clase-14-v1/', 'por RUTA completa, que es la identidad del clip');
  const borrado = d.espia.llamadas.filter(function (l) { return l.metodo === 'cleanOldVersions'; });
  eq(borrado.length, 1, 'y recién ahí se borra del disco');
  eq(borrado[0].arg.markerSlug, 'Marcador 3', 'solo las de este recurso');
});

test('el orden es Premiere primero, disco después', async function () {
  // Al revés, Premiere se queda con clips apuntando a archivos que ya no están y
  // el editor abre el proyecto con el cartel de "Link Media".
  const d = dibujar(jobTerminado());
  botonLimpiar(d.panel).click();
  await new Promise(function (r) { setTimeout(r, 0); });
  d.espia.confirmaciones[0].aceptar();
  await new Promise(function (r) { setTimeout(r, 0); });

  const orden = d.espia.llamadas.map(function (l) { return l.metodo; });
  const iListar = orden.indexOf('listOldVersions');
  const iBorrar = orden.indexOf('cleanOldVersions');
  ok(iListar >= 0 && iBorrar > iListar, 'primero se listan, después se borran');
  ok(d.espia.purgados.length === 1, 'y la purga pasó en el medio');
});

test('sin versiones previas lo dice y no abre ninguna confirmación', async function () {
  const d = dibujar(jobTerminado(), { previa: { ok: true, totalDeletes: 0, totalBytes: 0, groups: [] } });
  botonLimpiar(d.panel).click();
  await new Promise(function (r) { setTimeout(r, 0); });

  eq(d.espia.confirmaciones.length, 0, 'no se pregunta por nada');
  has(d.espia.salidas[0].texto, 'no tiene versiones anteriores');
  eq(d.espia.salidas[0].error, false, 'no es un error: es que ya estaba limpio');
});

test('la confirmación aclara que los HTMLs quedan', async function () {
  const d = dibujar(jobTerminado());
  botonLimpiar(d.panel).click();
  await new Promise(function (r) { setTimeout(r, 0); });
  let txt = '';
  const junta = function (n) { txt += ' ' + n.textContent; n.children.forEach(junta); };
  junta(d.espia.confirmaciones[0].body);
  has(txt, 'HTMLs', 'se dice qué NO se borra');
  has(txt, 'Marcador 3 v1.mov', 'y se lista archivo por archivo qué sí');
});
