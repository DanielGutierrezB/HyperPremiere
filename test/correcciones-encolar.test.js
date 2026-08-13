'use strict';

// Corregir un recurso ya enviado: qué se encola y dónde termina el clip.
//
// Lo que el editor necesita que salga bien es concreto: la corrección tiene que
// rediseñar SOBRE la versión que él eligió (no sobre otra), volver al MISMO
// segundo con la MISMA duración, y llegar en amarillo para poder distinguirla
// de un vistazo entre los clips que ya estaban en el timeline.
//
// El panel es JS de navegador sin módulos, así que se evalúa en un contexto de
// mentira. Son dos montajes distintos a propósito: uno para la pestaña (qué
// job arma) y otro para la cola de verdad (qué le pide a Premiere).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');

// ── DOM mínimo ───────────────────────────────────────────────────────
// Solo lo que corrections.js usa. Alcanza para apretar los botones de verdad,
// que es lo que hace que el test valga: prueba el cableado, no una copia.

function elemento(tag) {
  const el = {
    tagName: tag, children: [], listeners: {}, style: {},
    className: '', textContent: '', value: '', title: '',
    appendChild: function (hijo) { this.children.push(hijo); return hijo; },
    setAttribute: function (k, v) { this[k] = v; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    /** Dispara un evento como si el editor hubiera hecho clic. */
    click: function () { (this.listeners.click || []).forEach(function (f) { f(); }); },
    /** Busca en profundidad por clase, para encontrar controles sin ids. */
    buscar: function (clase) {
      for (const h of this.children) {
        if (h.className === clase) return h;
        const hit = h.buscar && h.buscar(clase);
        if (hit) return hit;
      }
      return null;
    },
    buscarTodos: function (clase) {
      let out = [];
      for (const h of this.children) {
        if (h.className === clase) out.push(h);
        if (h.buscarTodos) out = out.concat(h.buscarTodos(clase));
      }
      return out;
    },
    /** Los <textarea> y <button> se encuentran por etiqueta. */
    porTag: function (tag) {
      let out = [];
      for (const h of this.children) {
        if (h.tagName === tag) out.push(h);
        if (h.porTag) out = out.concat(h.porTag(tag));
      }
      return out;
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return ''; },
    set: function () { el.children.length = 0; },
  });
  return el;
}

/** Monta la pestaña Corrections con un motor y una cola de mentira. */
function montarPestana(opts) {
  opts = opts || {};
  const nodos = {
    'corr-list': elemento('div'),
    'corr-status': elemento('span'),
    'corr-picker': elemento('div'),
    'btn-load-corrections': elemento('button'),
  };
  const espia = { encolados: [], leidos: [], guardados: [], listados: [] };

  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Object: Object, Array: Array, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
    Promise: Promise, setTimeout: setTimeout,
    HPLog: { log: function () {} },
    HPWidgets: {
      // El desplegable propio del panel, reducido a lo que se le pide acá.
      select: function (root) {
        const api = { value: null, onChange: null };
        api.setOptions = function (list, sel) { api.opciones = list; api.value = sel; };
        root.select = api;
        return api;
      },
    },
    HPQueue: { add: function (job) { espia.encolados.push(job); } },
    HPEngine: {
      call: function (metodo, arg) {
        if (metodo === 'listCorrections') {
          espia.listados.push(arg);
          const base = opts.listado || { ok: true, markers: [], sources: [] };
          return Promise.resolve(base);
        }
        if (metodo === 'readMarkerHtml') {
          espia.leidos.push(arg);
          if (opts.htmlFalla) return Promise.resolve({ ok: false, error: 'no existe' });
          return Promise.resolve({ ok: true, html: '<div id="stage">v' + arg.version + '</div>', version: arg.version });
        }
        if (metodo === 'saveCorrectionPosition') {
          espia.guardados.push(arg);
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve({ ok: false, error: 'método inesperado: ' + metodo });
      },
    },
    document: {
      createElement: elemento,
      getElementById: function (id) { return nodos[id] || null; },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'corrections.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }

  const contexto = opts.contexto || { projectPath: '/p/Clases.prproj', sequenceName: 'Clase 14' };
  ctx.HPCorrections.init({
    context: function () { return contexto; },
    refreshContext: function (cb) { cb(); },
    draft: function () { return !!opts.draft; },
  });

  return { ctx: ctx, nodos: nodos, espia: espia };
}

/** Una fila como la devuelve listCorrections. */
function recurso(extra) {
  return Object.assign({
    slug: 'Marcador 3', latestVersion: 4, model: 'claude-sonnet-5',
    versions: [
      { version: 3, model: 'claude-sonnet-5', hasVideo: true },
      { version: 4, model: 'claude-sonnet-5', hasVideo: true },
    ],
    start: 128.5, duration: 7, timeSource: 'ficha',
    markerName: 'Gráfico de barras', markerGuid: 'g-3',
    instruction: 'un gráfico de barras', history: [], background: false,
  }, extra);
}

/** Carga la pestaña y devuelve la primera fila dibujada. */
async function cargarFila(m, opts) {
  opts = opts || {};
  const listado = Object.assign({
    ok: true, markers: [m], baseDir: '/p/HyperPremiere/clase-14',
    sequenceName: 'Clase 14', sourceSequenceName: 'Clase 14',
    folderSlug: 'clase-14', guessed: false,
    sources: [{ slug: 'clase-14', sequenceName: 'Clase 14', count: 1 }],
  }, opts.listado || {});
  const p = montarPestana(Object.assign({}, opts, { listado }));
  p.nodos['btn-load-corrections'].click();
  await new Promise(function (r) { setTimeout(r, 0); });
  // Con el aviso de "esto viene de otro corte" la primera cría no es la fila.
  const filas = p.nodos['corr-list'].children.filter(function (c) {
    return String(c.className).indexOf('corr-row') === 0;
  });
  return { p: p, fila: filas[0], filas: filas };
}

// ── Acortar nombres sin perder lo que distingue ──────────────────────

test('acortar por el medio conserva los dos extremos', function () {
  const p = montarPestana({});
  const corto = p.ctx.HPUtil.shortenMiddle;
  eq(corto('Clase 14', 34), 'Clase 14', 'lo que entra no se toca');
  const largo = '01_2607_bi-deep-research-ai-1783646520_105875_02';
  const r = corto(largo, 30);
  eq(r.length, 30, 'entra en el ancho pedido');
  eq(r.indexOf('01_2607'), 0, 'el principio dice de qué clase es');
  ok(/_105875_02$/.test(r), 'y el final, de qué corte');
  // Dos cortes de la misma clase tienen que seguir viéndose distintos: es lo
  // único que decide si el editor corrige el archivo correcto.
  ok(corto(largo, 30) !== corto('01_2607_bi-deep-research-ai-1783646520_105875', 30), 'siguen siendo distinguibles');
  eq(corto('', 30), '', 'un nombre vacío no rompe');
});

// ── Qué job arma la pestaña ──────────────────────────────────────────

test('corregir encola un refinamiento con el tramo original', async function () {
  const { p, fila } = await cargarFila(recurso());
  fila.porTag('textarea')[0].value = 'el título tapa la cara, subilo';
  fila.buscar('qbtn').click();
  await new Promise(function (r) { setTimeout(r, 0); });

  eq(p.espia.encolados.length, 1, 'un job');
  const j = p.espia.encolados[0];
  eq(j.kind, 'feedback');
  eq(j.payload.mode, 'adjust', 'refina sobre lo que había, no rediseña de cero');
  eq(j.markerKey, 'Marcador 3', 'el slug del disco es la clave del marcador');
  eq(j.markerStart, 128.5, 'vuelve al mismo segundo');
  eq(j.markerDuration, 7, 'y con la misma duración');
  eq(j.payload.marker.start, 128.5);
  eq(j.payload.marker.duration, 7);
  eq(j.payload.marker.guid, 'g-3');
  eq(j.payload.adjustment, 'el título tapa la cara, subilo');
  eq(j.correction, true, 'marcado como corrección: es lo que lo pinta de amarillo');
});

test('el HTML previo viaja explícito, de la versión que se eligió', async function () {
  // El motor por defecto lee la versión ANTERIOR a la que va a escribir. Acá se
  // corrige la versión que el editor elija, así que si no se manda a mano, una
  // corrección sobre la v3 saldría rediseñando la v3... contra la v3.
  const { p, fila } = await cargarFila(recurso());
  const picker = fila.children.find(function (c) { return c.className === 'corr-actions'; }).children[0].select;
  ok(picker, 'con dos versiones, la fila deja elegir cuál corregir');
  picker.value = '3';

  fila.porTag('textarea')[0].value = 'cambiá el color';
  fila.buscar('qbtn').click();
  await new Promise(function (r) { setTimeout(r, 0); });

  eq(p.espia.leidos[0].version, 3, 'leyó la v3');
  has(p.espia.encolados[0].payload.previousHtml, 'v3', 'y es la v3 la que viaja como referencia');
});

test('con una sola versión no se pregunta cuál, y se usa la última', async function () {
  const { p, fila } = await cargarFila(recurso({
    latestVersion: 1, versions: [{ version: 1, model: 'x', hasVideo: true }],
  }));
  fila.porTag('textarea')[0].value = 'corregir';
  fila.buscar('qbtn').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(p.espia.leidos[0].version, 1);
});

test('con fondo se conserva el fondo', async function () {
  const { p, fila } = await cargarFila(recurso({ background: true }));
  fila.porTag('textarea')[0].value = 'corregir';
  fila.buscar('qbtn').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(p.espia.encolados[0].payload.background, true, 'un clip opaco no se vuelve transparente al corregirlo');
});

test('sin instrucción no se gasta una llamada', async function () {
  const { p, fila } = await cargarFila(recurso());
  fila.buscar('qbtn').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(p.espia.encolados.length, 0, 'no encoló nada');
  has(fila.buscar('corr-state is-error').textContent, 'Escribí qué hay que corregir');
});

test('si el HTML de esa versión no se puede leer, se dice y no se encola', async function () {
  const { p, fila } = await cargarFila(recurso(), { htmlFalla: true });
  fila.porTag('textarea')[0].value = 'corregir';
  fila.buscar('qbtn').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(p.espia.encolados.length, 0, 'mejor no encolar que encolar sin referencia');
  has(fila.buscar('corr-state is-error').textContent, 'No pude encolarla');
});

test('un HTML pegado se renderiza en el mismo tramo, también como corrección', async function () {
  const { p, fila } = await cargarFila(recurso());
  const codigo = fila.porTag('textarea')[1];
  codigo.value = '<div id="stage" data-duration="7">traído de afuera</div>';
  fila.porTag('button').filter(function (b) { return b.textContent === 'Renderizar y colocar'; })[0].click();

  const j = p.espia.encolados[0];
  eq(j.kind, 'renderManualHtml');
  eq(j.markerStart, 128.5);
  eq(j.markerDuration, 7);
  eq(j.correction, true);
  has(j.payload.html, 'traído de afuera');
});

// ── Cuando falta el tramo ────────────────────────────────────────────

test('sin el tramo no se ofrece corregir: primero se pregunta dónde iba', async function () {
  const { fila } = await cargarFila(recurso({ start: null, duration: null, timeSource: '' }));
  eq(fila.className, 'corr-row is-unknown');
  has(fila.buscar('corr-warn').textContent, 'No encontré dónde iba');
  eq(fila.porTag('textarea').length, 0, 'ni caja de instrucción: colocar a ciegas es peor que no colocar');
});

test('el tramo escrito a mano se guarda en la ficha', async function () {
  const { p, fila } = await cargarFila(recurso({ start: null, duration: 9, timeSource: 'html' }));
  const campos = fila.porTag('input');
  eq(campos[1].value, '9', 'la duración que sí se sabía viene puesta');
  campos[0].value = '55';
  fila.buscar('qbtn').click();
  await new Promise(function (r) { setTimeout(r, 0); });

  eq(p.espia.guardados[0].start, 55);
  eq(p.espia.guardados[0].duration, 9);
  eq(p.espia.guardados[0].markerSlug, 'Marcador 3');
});

test('un proyecto sin nada generado lo dice en vez de quedar en blanco', async function () {
  const p = montarPestana({ listado: { ok: true, markers: [], sources: [], baseDir: '/p' } });
  p.nodos['btn-load-corrections'].click();
  await new Promise(function (r) { setTimeout(r, 0); });
  has(p.nodos['corr-list'].children[0].textContent, 'todavía no tiene recursos generados');
});

test('con carpetas disponibles, el vacío invita a elegir en vez de dar por cerrado', async function () {
  const p = montarPestana({ listado: {
    ok: true, markers: [], folderSlug: '', sourceSequenceName: '',
    sources: [{ slug: 'clase-09', sequenceName: 'Clase 09', count: 3 }, { slug: 'clase-10', sequenceName: 'Clase 10', count: 2 }],
  } });
  p.nodos['btn-load-corrections'].click();
  await new Promise(function (r) { setTimeout(r, 0); });
  has(p.nodos['corr-list'].children[0].textContent, 'Elegí de qué secuencia leer');
});

// ── La clase volvió re-cortada, con otro nombre ──────────────────────
// El bug que reportó el editor: parado en "Clase 14_02" la pestaña decía que no
// había nada generado, y los recursos estaban en la carpeta de "Clase 14".

/** Fila leída de otro corte: el editor está en `Clase 14`, los archivos en `Clase 14 v1`. */
function cargarCruzada(extra) {
  return cargarFila(recurso(extra), { listado: {
    sourceSequenceName: 'Clase 14 v1', folderSlug: 'clase-14-v1', guessed: true,
    baseDir: '/p/HyperPremiere/clase-14-v1',
    sources: [
      { slug: 'clase-14-v1', sequenceName: 'Clase 14 v1', count: 5 },
      { slug: 'clase-14', sequenceName: 'Clase 14', count: 0 },
    ],
  } });
}

test('leyendo de otro corte, se avisa de dónde salió y a dónde va', async function () {
  const { p } = await cargarCruzada();
  const aviso = p.nodos['corr-list'].children[0];
  eq(aviso.className, 'corr-cross', 'el aviso va ARRIBA de la lista, antes de apretar nada');
  const filas = aviso.buscarTodos('corr-cross-val');
  eq(filas[0].title, 'Clase 14 v1', 'de dónde se lee');
  eq(filas[1].title, 'Clase 14', 'y a dónde se coloca');
});

test('los dos nombres del aviso se recortan a lo que los diferencia', async function () {
  // Uno al lado del otro, dos nombres de 45 caracteres que solo cambian en el
  // sufijo no se leen: hay que comparar letra por letra para ver si son distintos.
  const viejo = '01_2607_bi-deep-research-ai-1783646520_105875';
  const { p } = await cargarFila(recurso(), {
    contexto: { projectPath: '/p/x.prproj', sequenceName: viejo + '_02' },
    listado: {
      sourceSequenceName: viejo, folderSlug: 'v1', guessed: true,
      sequenceName: viejo + '_02',
      sources: [{ slug: 'v1', sequenceName: viejo, count: 5 }],
    },
  });
  const filas = p.nodos['corr-list'].children[0].buscarTodos('corr-cross-val');
  eq(filas[0].textContent, '…_105875', 'lo compartido se cae');
  eq(filas[1].textContent, '…_105875_02', 'y queda a la vista lo que cambia');
  eq(filas[0].title, viejo, 'el nombre entero sigue disponible al pasar el mouse');
});

test('si se lee de OTRA clase, los nombres van completos: ahí el prefijo es el dato', async function () {
  const { p } = await cargarFila(recurso(), {
    contexto: { projectPath: '/p/x.prproj', sequenceName: 'Clase 23' },
    listado: {
      sourceSequenceName: 'Clase 14', folderSlug: 'clase-14', guessed: false,
      sequenceName: 'Clase 23',
      sources: [{ slug: 'clase-14', sequenceName: 'Clase 14', count: 5 }],
    },
  });
  const filas = p.nodos['corr-list'].children[0].buscarTodos('corr-cross-val');
  eq(filas[0].textContent, 'Clase 14');
  eq(filas[1].textContent, 'Clase 23');
});

test('un nombre de secuencia largo se acorta por el MEDIO, no por el final', async function () {
  // Los cortes de una clase se diferencian en el sufijo ("_105875" vs
  // "_105875_02"): cortando por el final se ven idénticos y el editor no puede
  // saber cuál está corrigiendo.
  const largo = '01_2607_bi-deep-research-ai-1783646520_105875_02';
  const { p } = await cargarFila(recurso(), { listado: {
    sourceSequenceName: largo, folderSlug: 'x', guessed: false,
    sources: [{ slug: 'x', sequenceName: largo, count: 5 }, { slug: 'y', sequenceName: 'otra', count: 1 }],
  } });
  const etiqueta = p.nodos['corr-picker'].children.filter(function (c) { return !!c.select; })[0].select.opciones[0].label;
  has(etiqueta, '01_2607', 'se ve de qué clase es');
  has(etiqueta, '_105875_02', 'y de qué corte');
});

test('la corrección se genera en la carpeta de origen y se coloca en la secuencia abierta', async function () {
  // Son dos secuencias distintas a propósito: la historia de versiones tiene que
  // seguir siendo una (v5 después de la v4, en su carpeta) y el clip tiene que
  // caer en el timeline que el editor está mirando.
  const { p, fila } = await cargarCruzada();
  fila.porTag('textarea')[0].value = 'subí el título';
  fila.buscar('qbtn').click();
  await new Promise(function (r) { setTimeout(r, 0); });

  const j = p.espia.encolados[0];
  eq(j.payload.sequenceName, 'Clase 14 v1', 'el recurso se escribe donde vive su historia');
  eq(j.seqName, 'Clase 14', 'pero el clip va a la secuencia abierta');
  eq(j.storeSeqName, 'Clase 14 v1', 'y las imágenes de referencia salen del corte viejo');
  eq(p.espia.leidos[0].sequenceName, 'Clase 14 v1', 'el HTML previo también se lee de allá');
});

test('el segundo donde colocar se puede corregir, y no arrastra al del transcript', async function () {
  // Si la clase se volvió a cortar, el segundo guardado ya no sirve. Cambiarlo NO
  // puede mover el tramo del guion que el modelo lee: eso lo manda markerStart.
  const { p, fila } = await cargarCruzada();
  const campo = fila.buscar('corr-second');
  ok(campo, 'la fila ofrece el segundo, escrito y editable');
  eq(campo.value, '128.5', 'viene con el del corte donde se generó');
  campo.value = '96.2';

  fila.porTag('textarea')[0].value = 'subí el título';
  fila.buscar('qbtn').click();
  await new Promise(function (r) { setTimeout(r, 0); });

  const j = p.espia.encolados[0];
  eq(j.placeStart, 96.2, 'se coloca donde dijo el editor');
  eq(j.markerStart, 128.5, 'y el tramo del transcript sigue siendo el de origen');
  eq(j.markerDuration, 7, 'la duración no se toca');
});

test('un segundo inválido no encola nada', async function () {
  const { p, fila } = await cargarCruzada();
  fila.buscar('corr-second').value = '-4';
  fila.porTag('textarea')[0].value = 'corregir';
  fila.buscar('qbtn').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(p.espia.encolados.length, 0);
  has(fila.buscar('corr-state is-error').textContent, 'no es válido');
});

test('estando en su propia secuencia no se pregunta el segundo ni se avisa nada', async function () {
  const { p, fila } = await cargarFila(recurso());
  eq(fila.buscar('corr-second'), null, 'un control que no decide nada no va');
  eq(p.nodos['corr-list'].children[0].className.indexOf('corr-cross'), -1, 'y sin aviso');
});

test('el desplegable aparece con varias carpetas y recarga la elegida', async function () {
  const { p } = await cargarCruzada();
  const host = p.nodos['corr-picker'].children.filter(function (c) { return !!c.select; })[0];
  ok(host, 'hay desplegable cuando hay de dónde elegir');
  eq(host.select.value, 'clase-14-v1', 'marcado en la carpeta que se está leyendo');

  host.select.onChange('clase-14');
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(p.espia.listados[1].folderSlug, 'clase-14', 'y al cambiarlo se relee esa');
});

test('con una sola carpeta no hay desplegable', async function () {
  const { p } = await cargarFila(recurso());
  eq(p.nodos['corr-picker'].children.length, 0, 'nada que elegir, nada que dibujar');
});

test('el tramo escrito a mano se guarda en la carpeta de origen, no en la abierta', async function () {
  const { p, fila } = await cargarCruzada({ start: null, duration: null, timeSource: '' });
  const campos = fila.porTag('input');
  campos[0].value = '30';
  campos[1].value = '5';
  fila.buscar('qbtn').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(p.espia.guardados[0].sequenceName, 'Clase 14 v1');
});

// ── Qué hace la cola con esa corrección ──────────────────────────────

/** Monta la cola de verdad con un motor y un Premiere de mentira. */
function montarCola() {
  const espia = { colocados: [], recoloreados: [], guardado: null };
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
    HPConfigUI: { isLocalProvider: function () { return false; }, modelName: function () { return 'claude-sonnet-5'; } },
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
    },
    HPHost: {
      placeClip: function (mov, seq, start, dur, color, hasAudio, cb) {
        espia.colocados.push({ mov: mov, seq: seq, start: start, dur: dur, color: color, hasAudio: hasAudio });
        cb('ok');
      },
      recolorClip: function (seq, start, color, mov, cb) {
        espia.recoloreados.push({ seq: seq, start: start, color: color });
        cb('ok');
      },
    },
    HPEngine: {
      call: function (m) {
        if (m === 'mediaHasAudio') return Promise.resolve({ ok: true, hasAudio: false });
        return Promise.resolve({ ok: true });
      },
      callProg: function (metodo, arg) {
        if (metodo === 'saveQueue') { espia.guardado = arg; return Promise.resolve({ ok: true }); }
        if (metodo === 'prepareFeedback' || metodo === 'prepareGenerate') {
          return Promise.resolve({ ok: true, version: 5, usage: { inputTokens: 10, outputTokens: 20 } });
        }
        return Promise.resolve({ ok: true, version: 5, movPath: '/p/HyperPremiere/clase-14/Marcador 3 v5.mov' });
      },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'queue.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  return { ctx: ctx, espia: espia };
}

/** Deja correr las promesas encadenadas de la cola. */
async function dejarCorrer() {
  for (let i = 0; i < 40; i++) await new Promise(function (r) { setTimeout(r, 0); });
}

function jobBase(extra) {
  return Object.assign({
    kind: 'feedback',
    payload: { projectPath: '/p/Clases.prproj', sequenceName: 'Clase 14', mode: 'adjust', markerSlug: 'Marcador 3' },
    seqName: 'Clase 14', projectPath: '/p/Clases.prproj', markerKey: 'Marcador 3',
    label: 'Marcador 3', markerStart: 128.5, markerDuration: 7,
  }, extra);
}

test('la corrección se coloca en AMARILLO, en su segundo original', async function () {
  const c = montarCola();
  c.ctx.HPQueue.add(jobBase({ correction: true }));
  await dejarCorrer();

  eq(c.espia.colocados.length, 1, 'se colocó');
  eq(c.espia.colocados[0].color, 15, 'amarillo (índice del menú Etiqueta de Premiere)');
  eq(c.espia.colocados[0].start, 128.5, 'en el mismo segundo del que salió');
  eq(c.espia.colocados[0].dur, 7);
});

test('una generación normal sigue saliendo magenta', async function () {
  // La contraprueba: el amarillo tiene que distinguir, y si todo saliera
  // amarillo no distinguiría nada.
  const c = montarCola();
  c.ctx.HPQueue.add(jobBase());
  await dejarCorrer();
  eq(c.espia.colocados[0].color, 11, 'magenta, como siempre');
});

test('un borrador con fondo sigue saliendo café, salvo que sea corrección', async function () {
  const c = montarCola();
  c.ctx.HPQueue.add(jobBase({ payload: { mode: 'adjust', draft: true, background: true } }));
  await dejarCorrer();
  eq(c.espia.colocados[0].color, 14, 'café: es un borrador mejorable con Render HQ');

  const c2 = montarCola();
  c2.ctx.HPQueue.add(jobBase({ correction: true, payload: { mode: 'adjust', draft: true, background: true } }));
  await dejarCorrer();
  eq(c2.espia.colocados[0].color, 15, 'siendo corrección, manda el amarillo');
});

test('si el panel se reinicia a mitad, la corrección sigue siendo corrección', async function () {
  // La cola se guarda liviana en queue.json. Si la marca no viajara, al
  // reanudar el clip volvería magenta y se perdería de vista cuál se rehizo.
  const c = montarCola();
  c.ctx.HPQueue.add(jobBase({ correction: true }));
  await dejarCorrer();
  // La cola junta las escrituras en una ventana de un segundo, así que acá hay
  // que esperar de verdad: es el único test que mira el archivo.
  await new Promise(function (r) { setTimeout(r, 1200); });

  ok(c.espia.guardado, 'la cola se persistió');
  const j = c.espia.guardado.jobs.filter(function (x) { return x.markerKey === 'Marcador 3'; })[0];
  eq(j.correction, true, 'la marca sobrevive al archivo');
});
