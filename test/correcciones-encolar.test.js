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
  const espia = {
    encolados: [], leidos: [], guardados: [], listados: [], saltos: [],
    controles: [], fbAbiertos: [], fbCerrados: [], transcriptsPedidos: [],
    // Por cada encolado, si la cola arranca sola o queda esperando "Iniciar cola".
    modos: [],
  };

  // El estado del panel es POR SECUENCIA: el mismo marcador tiene un objetivo y
  // un transcript distintos según de qué corte se lea. Es justo lo que decide si
  // una corrección leída de otro corte sale con contexto o a ciegas.
  const almacen = opts.almacen || {};
  let seqActual = null;
  function espacio(seq) {
    const k = seq || '';
    return (almacen[k] = almacen[k] || {});
  }

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
        /** Elegir una opción como lo haría el editor: cambia y avisa. */
        api.elegir = function (v) { api.value = String(v); if (api.onChange) api.onChange(api.value); };
        root.select = api;
        return api;
      },
      makeCodeEditor: function () {
        const el = elemento('div');
        let valor = '';
        return {
          el: el,
          getValue: function () { return valor; },
          setValue: function (v) { valor = String(v == null ? '' : v); },
        };
      },
    },
    HPHost: {
      openSequenceAndSeek: function (seq, segundos, cb) {
        espia.saltos.push({ seq: seq, segundos: segundos });
        if (cb) cb('ok');
      },
    },
    // El control de imágenes de verdad tiene su propio test; acá interesa que la
    // fila lo monte y sobre QUÉ secuencia, que es lo que decide si el modelo ve
    // las imágenes del recurso o ninguna.
    HPStills: {
      fbInit: function (id) { espia.fbAbiertos.push(id); },
      fbClear: function (id) { espia.fbCerrados.push(id); },
      fbCollect: function () { return opts.reenviar || []; },
      createControl: function (markerKey, o) {
        espia.controles.push({ markerKey: markerKey, opts: o });
        const el = elemento('div');
        el.className = 'marker-stills';
        return el;
      },
    },
    HPQueue: {
      add: function (job) { espia.encolados.push(job); espia.modos.push('arranca'); },
      addStaged: function (job) { espia.encolados.push(job); espia.modos.push('espera'); },
    },
    HPStore: {
      GENERAL_KEY: '__general__',
      withContext: function (projectPath, sequenceName, fn) {
        const antes = seqActual;
        seqActual = sequenceName;
        try { return fn(); } finally { seqActual = antes; }
      },
      getObjective: function () { return espacio(seqActual).objective || ''; },
      getTranscript: function () { return espacio(seqActual).transcript || []; },
      setTranscript: function (segs) { espacio(seqActual).transcript = segs; },
      setTranscriptOffset: function (n) { espacio(seqActual).offset = n; },
      getMarkerData: function (key) { return espacio(seqActual)[key] || {}; },
    },
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
        if (metodo === 'loadTranscript') {
          espia.transcriptsPedidos.push(arg);
          return Promise.resolve(opts.transcriptEnDisco ||
            { ok: true, found: false });
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

  return { ctx: ctx, nodos: nodos, espia: espia, almacen: almacen };
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

/**
 * El botón grande de la fila. Es el mismo de una ronda de feedback en la Cola
 * (`qbtn-react`), no un botón más de la barra: se busca por su clase para que
 * el test falle si deja de serlo.
 */
function regenerar(fila) {
  const b = fila.buscar('qbtn qbtn-react');
  if (!b) throw new Error('la fila no tiene el botón grande de regenerar');
  eq(b.textContent, '↻ Regenerar', 'y dice lo mismo que en la Cola');
  b.click();
  return b;
}

/** El otro botón de la fila: manda lo mismo, pero sin arrancar la cola. */
function enviarACola(fila) {
  const b = fila.buscar('qbtn qbtn-stage');
  if (!b) throw new Error('la fila no ofrece enviar a la cola');
  eq(b.textContent, '＋ Enviar a la cola', 'con el mismo nombre que en Marcadores');
  b.click();
  return b;
}

/** El botón de la fila que todavía no sabe dónde iba el recurso. */
function guardarTramo(fila) {
  const b = fila.buscar('qbtn');
  if (!b) throw new Error('la fila no ofrece guardar el tramo');
  b.click();
  return b;
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
  regenerar(fila);
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
  eq(p.espia.modos[0], 'arranca', 'Regenerar es "hacelo ya"');
});

// ── Juntar las correcciones y largarlas después ──────────────────────
// Revisar la clase entera es ir fila por fila escribiendo qué está mal. Si cada
// una arrancara al escribirla, la primera se estaría procesando mientras todavía
// se está revisando el resto, y el editor no puede reordenar ni cambiar de idea.

test('enviar a la cola deja la corrección en espera, sin arrancar', async function () {
  const { p, fila } = await cargarFila(recurso());
  fila.porTag('textarea')[0].value = 'el título tapa la cara, subilo';
  enviarACola(fila);
  await new Promise(function (r) { setTimeout(r, 0); });

  eq(p.espia.encolados.length, 1, 'la corrección está en la cola');
  eq(p.espia.modos[0], 'espera', 'pero la cola no arranca sola');
  has(fila.buscar('corr-state is-ok').textContent, 'Iniciar cola',
    'y la fila dice cómo se larga');
});

test('en espera o ya mismo, el job que se manda es el mismo', async function () {
  // La única diferencia tiene que ser cuándo arranca. Si el camino "en espera"
  // armara un payload distinto, el resultado dependería del botón que tocaste.
  const ya = await cargarFila(recurso());
  ya.fila.porTag('textarea')[0].value = 'subí el título';
  regenerar(ya.fila);
  await new Promise(function (r) { setTimeout(r, 0); });

  const luego = await cargarFila(recurso());
  luego.fila.porTag('textarea')[0].value = 'subí el título';
  enviarACola(luego.fila);
  await new Promise(function (r) { setTimeout(r, 0); });

  eq(JSON.stringify(luego.p.espia.encolados[0]), JSON.stringify(ya.p.espia.encolados[0]),
    'mismo job, mismo contexto');
});

test('sin instrucción tampoco se encola en espera', async function () {
  const { p, fila } = await cargarFila(recurso());
  enviarACola(fila);
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(p.espia.encolados.length, 0);
  has(fila.buscar('corr-state is-error').textContent, 'Escribí qué hay que corregir');
});

test('varias filas se pueden dejar juntas antes de largar la cola', async function () {
  const { p, filas } = await cargarFila(recurso(), {
    listado: { markers: [recurso(), recurso({ slug: 'Marcador 8', start: 333, duration: 60 })] },
  });
  filas[0].porTag('textarea')[0].value = 'subí el título';
  enviarACola(filas[0]);
  filas[1].porTag('textarea')[0].value = 'el dato no se lee';
  enviarACola(filas[1]);
  await new Promise(function (r) { setTimeout(r, 0); });

  eq(p.espia.encolados.length, 2);
  eq(p.espia.modos.join(), 'espera,espera', 'ninguna arrancó por su cuenta');
  eq(p.espia.encolados[0].markerKey, 'Marcador 3');
  eq(p.espia.encolados[1].markerKey, 'Marcador 8');
});

// ── El contexto que viaja con la corrección ──────────────────────────
// Una corrección es la última llamada de una cadena, pero para el modelo es la
// PRIMERA: no recuerda nada. Todo lo que no viaje en este job, no existe.

test('el encargo original viaja junto a la corrección, no en su lugar', async function () {
  // Son dos secciones distintas del prompt: "qué es este recurso" y "qué hay que
  // cambiarle". Mandando la corrección en las dos, el modelo rediseñaba creyendo
  // que el encargo entero era "subí el título" — y la ficha nueva se quedaba con
  // eso, así que el encargo se perdía para la corrección siguiente.
  const { p, fila } = await cargarFila(recurso({ instruction: 'un gráfico de barras con las ventas por trimestre' }));
  fila.porTag('textarea')[0].value = 'el título tapa la cara, subilo';
  regenerar(fila);
  await new Promise(function (r) { setTimeout(r, 0); });

  const pl = p.espia.encolados[0].payload;
  eq(pl.instruction, 'un gráfico de barras con las ventas por trimestre', 'el encargo con el que nació');
  eq(pl.adjustment, 'el título tapa la cara, subilo', 'y la corrección, aparte');
});

test('sin encargo guardado, la corrección hace de encargo', async function () {
  // Recursos viejos, de antes de que la ficha guardara la instrucción: es
  // preferible un encargo pobre a mandar el hueco.
  const { p, fila } = await cargarFila(recurso({ instruction: '' }));
  fila.porTag('textarea')[0].value = 'poné el logo arriba';
  regenerar(fila);
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(p.espia.encolados[0].payload.instruction, 'poné el logo arriba');
});

test('la fila muestra qué se le había pedido a ese recurso', async function () {
  const { fila } = await cargarFila(recurso({ instruction: 'un gráfico de barras' }));
  has(fila.buscar('corr-brief').textContent, 'un gráfico de barras',
    'al mes nadie se acuerda del encargo, y es lo que el modelo va a recibir');
});

test('el objetivo de la clase y las indicaciones generales viajan', async function () {
  const { p, fila } = await cargarFila(recurso(), { almacen: {
    'Clase 14': { objective: 'enseñar deep research', __general__: { instruction: 'tipografía Inter, azul de marca' } },
  } });
  fila.porTag('textarea')[0].value = 'corregir';
  regenerar(fila);
  await new Promise(function (r) { setTimeout(r, 0); });

  const pl = p.espia.encolados[0].payload;
  eq(pl.objective, 'enseñar deep research');
  eq(pl.generalInstruction, 'tipografía Inter, azul de marca');
});

test('leyendo de otro corte, el marco de la clase sale del corte ABIERTO si allá no está', async function () {
  // El corte viejo puede no haberse abierto nunca en esta máquina: su objetivo y
  // su prompt general no están guardados acá. Es la misma clase, así que se
  // toman de la secuencia abierta antes que mandar "(sin objetivo declarado)".
  const { p, fila } = await cargarCruzada(null, { almacen: {
    'Clase 14': { objective: 'enseñar deep research', __general__: { instruction: 'azul de marca' } },
    'Clase 14 v1': {},
  } });
  fila.porTag('textarea')[0].value = 'corregir';
  regenerar(fila);
  await new Promise(function (r) { setTimeout(r, 0); });

  const pl = p.espia.encolados[0].payload;
  eq(pl.objective, 'enseñar deep research');
  eq(pl.generalInstruction, 'azul de marca');
});

test('lo que SÍ está guardado en el corte viejo gana sobre lo del abierto', async function () {
  const { p, fila } = await cargarCruzada(null, { almacen: {
    'Clase 14': { objective: 'objetivo del corte nuevo' },
    'Clase 14 v1': { objective: 'el objetivo con el que se generó' },
  } });
  fila.porTag('textarea')[0].value = 'corregir';
  regenerar(fila);
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(p.espia.encolados[0].payload.objective, 'el objetivo con el que se generó');
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
  regenerar(fila);
  await new Promise(function (r) { setTimeout(r, 0); });

  eq(p.espia.leidos[0].version, 3, 'leyó la v3');
  has(p.espia.encolados[0].payload.previousHtml, 'v3', 'y es la v3 la que viaja como referencia');
});

test('con una sola versión no se pregunta cuál, y se usa la última', async function () {
  const { p, fila } = await cargarFila(recurso({
    latestVersion: 1, versions: [{ version: 1, model: 'x', hasVideo: true }],
  }));
  fila.porTag('textarea')[0].value = 'corregir';
  regenerar(fila);
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(p.espia.leidos[0].version, 1);
});

test('con fondo se conserva el fondo', async function () {
  const { p, fila } = await cargarFila(recurso({ background: true }));
  fila.porTag('textarea')[0].value = 'corregir';
  regenerar(fila);
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(p.espia.encolados[0].payload.background, true, 'un clip opaco no se vuelve transparente al corregirlo');
});

test('sin instrucción no se gasta una llamada', async function () {
  const { p, fila } = await cargarFila(recurso());
  regenerar(fila);
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(p.espia.encolados.length, 0, 'no encoló nada');
  has(fila.buscar('corr-state is-error').textContent, 'Escribí qué hay que corregir');
});

test('si el HTML de esa versión no se puede leer, se dice y no se encola', async function () {
  const { p, fila } = await cargarFila(recurso(), { htmlFalla: true });
  fila.porTag('textarea')[0].value = 'corregir';
  regenerar(fila);
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(p.espia.encolados.length, 0, 'mejor no encolar que encolar sin referencia');
  has(fila.buscar('corr-state is-error').textContent, 'No pude encolarla');
});

// ── El HTML que la pestaña ya encontró ───────────────────────────────
// No se pide pegarlo: acaba de listar todas las versiones y sabe leerlas del
// disco. Sirve para mirar qué tiene el recurso antes de escribir la corrección,
// y para retocarlo a mano sin gastar una llamada al modelo.

/** Abre el bloque del HTML de una fila, como haría el clic en el resumen. */
async function abrirHtml(fila) {
  const caja = fila.children.filter(function (c) { return c.className === 'corr-html'; })[0];
  caja.open = true;
  (caja.listeners.toggle || []).forEach(function (f) { f(); });
  await new Promise(function (r) { setTimeout(r, 0); });
  return caja;
}

test('al abrir el HTML se carga el de la versión elegida, sin pedirlo', async function () {
  const { p, fila } = await cargarFila(recurso());
  const caja = await abrirHtml(fila);
  has(caja.children[0].textContent, 'v4', 'el resumen dice qué versión va a mostrar');
  eq(p.espia.leidos[0].version, 4, 'y la trae del disco');
  eq(p.espia.leidos[0].markerSlug, 'Marcador 3');
});

test('cambiar de versión con el HTML abierto trae ESA versión', async function () {
  // Si no, se renderizaría el HTML de una versión con el número de otra.
  const { p, fila } = await cargarFila(recurso());
  await abrirHtml(fila);
  const picker = fila.buscar('corr-actions').children[0].select;
  picker.elegir('3');
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(p.espia.leidos[1].version, 3);
});

test('el HTML no se vuelve a leer si ya está cargado', async function () {
  const { p, fila } = await cargarFila(recurso());
  const caja = await abrirHtml(fila);
  await abrirHtml(fila);
  eq(p.espia.leidos.length, 1, 'una sola lectura: cerrar y abrir no pierde lo editado');
  ok(caja, 'la caja sigue ahí');
});

test('el HTML editado se renderiza en el mismo tramo, también como corrección', async function () {
  const { p, fila } = await cargarFila(recurso());
  await abrirHtml(fila);
  fila.porTag('button').filter(function (b) { return b.textContent === 'Renderizar y colocar'; })[0].click();

  const j = p.espia.encolados[0];
  eq(j.kind, 'renderManualHtml');
  eq(j.markerStart, 128.5);
  eq(j.markerDuration, 7);
  eq(j.correction, true);
  has(j.payload.html, 'v4', 'sale el HTML de la versión que se estaba viendo');
});

test('el HTML editado a mano respeta si el recurso llevaba fondo', async function () {
  // El fondo decide el formato del video (mp4 opaco / mov con alpha). Sin este
  // dato, retocar a mano un recurso opaco lo devolvía en otro formato.
  const { p, fila } = await cargarFila(recurso({ background: true }));
  await abrirHtml(fila);
  fila.porTag('button').filter(function (b) { return b.textContent === 'Renderizar y colocar'; })[0].click();
  eq(p.espia.encolados[0].payload.background, true);
});

test('si el HTML de esa versión no se puede leer, se dice al abrirlo', async function () {
  const { p, fila } = await cargarFila(recurso(), { htmlFalla: true });
  await abrirHtml(fila);
  has(fila.buscar('corr-state is-error').textContent, 'No pude leer el HTML');
  eq(p.espia.encolados.length, 0);
});

// ── Ir al punto del timeline ─────────────────────────────────────────

test('el nombre del marcador lleva el cursor de Premiere a ese punto', async function () {
  const { p, fila } = await cargarFila(recurso());
  const nombre = fila.buscar('corr-name is-link');
  ok(nombre, 'el nombre es clickeable');
  nombre.click();
  eq(p.espia.saltos.length, 1);
  eq(p.espia.saltos[0].seq, 'Clase 14', 'la secuencia que el editor tiene abierta');
  eq(p.espia.saltos[0].segundos, 128.5);
});

test('leyendo de otro corte, el nombre lleva a la secuencia ABIERTA', async function () {
  // Es donde va a caer el clip; el corte viejo puede ni estar abierto.
  const { p, fila } = await cargarCruzada();
  fila.buscar('corr-name is-link').click();
  eq(p.espia.saltos[0].seq, 'Clase 14', 'la abierta, no la de origen');
  eq(p.espia.saltos[0].segundos, 128.5);
});

test('sin el tramo, el nombre no es un enlace a ninguna parte', async function () {
  const { p, fila } = await cargarFila(recurso({ start: null, duration: null, timeSource: '' }));
  eq(fila.buscar('corr-name is-link'), null);
  eq(p.espia.saltos.length, 0);
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
  guardarTramo(fila);
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
function cargarCruzada(extra, opts) {
  return cargarFila(recurso(extra), Object.assign({}, opts, { listado: {
    sourceSequenceName: 'Clase 14 v1', folderSlug: 'clase-14-v1', guessed: true,
    baseDir: '/p/HyperPremiere/clase-14-v1',
    sources: [
      { slug: 'clase-14-v1', sequenceName: 'Clase 14 v1', count: 5 },
      { slug: 'clase-14', sequenceName: 'Clase 14', count: 0 },
    ],
  } }));
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
  regenerar(fila);
  await new Promise(function (r) { setTimeout(r, 0); });

  const j = p.espia.encolados[0];
  eq(j.payload.sequenceName, 'Clase 14 v1', 'el recurso se escribe donde vive su historia');
  eq(j.seqName, 'Clase 14', 'pero el clip va a la secuencia abierta');
  eq(j.storeSeqName, 'Clase 14 v1', 'y las imágenes de referencia salen del corte viejo');
  eq(p.espia.leidos[0].sequenceName, 'Clase 14 v1', 'el HTML previo también se lee de allá');
});

test('el segundo no se pregunta nunca: cae donde nació, aunque sea de otro corte', async function () {
  // Se probó pidiéndolo escrito y editable, y es un cálculo que el editor no
  // tiene por qué hacer: el clip llega a una pista nueva arriba de todo, así que
  // si el corte se movió, se arrastra. Un campo menos y ningún tramo del guion
  // en riesgo (ese sale de markerStart, el mismo número).
  const { p, fila } = await cargarCruzada();
  eq(fila.buscar('corr-second'), null, 'no hay campo de segundo');
  fila.porTag('textarea')[0].value = 'subí el título';
  regenerar(fila);
  await new Promise(function (r) { setTimeout(r, 0); });

  const j = p.espia.encolados[0];
  eq(j.markerStart, 128.5, 'el segundo donde se generó');
  eq(j.markerDuration, 7, 'la duración no se toca');
  eq(j.placeStart, undefined, 'y nada que pueda separarse de él');
});

test('estando en su propia secuencia no se avisa nada', async function () {
  const { p } = await cargarFila(recurso());
  eq(p.nodos['corr-list'].children[0].className.indexOf('corr-cross'), -1, 'sin aviso');
});

// ── Una corrección es una ronda de feedback ──────────────────────────
// Mismo material que en la Cola: mandar imágenes nuevas, decidir cuáles viajan
// y marcar qué se incrusta. Sin eso, corregir "usá el logo que te mandé" es
// pedirle al modelo algo que no puede ver.

test('la fila monta el control de imágenes del marcador', async function () {
  const { p, fila } = await cargarFila(recurso());
  ok(fila.buscar('marker-stills'), 'las imágenes están en la fila, no en otra pestaña');
  const c = p.espia.controles[0];
  eq(c.markerKey, 'Marcador 3');
  eq(c.opts.sequenceName, 'Clase 14', 'la secuencia del recurso');
  ok(c.opts.fbJobId, 'en modo feedback: cada miniatura decide si se reenvía');
  has(fila.buscar('qj-fb-hint').textContent, 'viajan otra vez en cada corrección');
});

test('las imágenes se leen de la secuencia de ORIGEN, no de la abierta', async function () {
  // Es el punto entero: las imágenes de referencia de ese marcador están
  // guardadas contra el corte donde nació. Leyendo la secuencia abierta, el
  // marcador aparecería sin imágenes y la corrección sería un rediseño a ciegas.
  const { p } = await cargarCruzada();
  eq(p.espia.controles[0].opts.sequenceName, 'Clase 14 v1');
  eq(p.espia.controles[0].opts.projectPath, '/p/Clases.prproj');
});

test('qué imágenes viajan sale del 📤 de cada miniatura', async function () {
  const { p, fila } = await cargarFila(recurso(), { reenviar: [0, 2] });
  fila.porTag('textarea')[0].value = 'corregir';
  regenerar(fila);
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(JSON.stringify(p.espia.encolados[0].payload.stillsSend), '[0,2]');
  eq(p.espia.fbCerrados.length, 1, 'y la próxima ronda arranca con todas activas');
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
  guardarTramo(fila);
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(p.espia.guardados[0].sequenceName, 'Clase 14 v1');
});

// ── Qué hace la cola con esa corrección ──────────────────────────────

/** Monta la cola de verdad con un motor y un Premiere de mentira. */
function montarCola(opts) {
  opts = opts || {};
  const espia = { colocados: [], recoloreados: [], guardado: null, preparados: [], transcriptsPedidos: [] };
  const almacen = {};
  // El transcript es POR SECUENCIA, igual que en el panel: es lo que decide si
  // una corrección de otro corte encuentra su guion o se queda sin él.
  const porSecuencia = opts.porSecuencia || {};
  let seqActual = null;
  function espacio(seq) {
    const k = seq || '';
    return (porSecuencia[k] = porSecuencia[k] || {});
  }
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
    HPTranscript: {
      sliceForMarker: function (segs, desde, hasta) {
        return (segs || []).filter(function (s) { return s.end > desde && s.start < hasta; });
      },
    },
    HPStore: {
      GENERAL_KEY: '__general__',
      getContext: function () { return { projectPath: '/p/Clases.prproj' }; },
      withContext: function (a, b, fn) {
        const antes = seqActual;
        seqActual = b;
        try { return fn(); } finally { seqActual = antes; }
      },
      getTranscript: function () { return espacio(seqActual).transcript || []; },
      setTranscript: function (segs) { espacio(seqActual).transcript = segs; },
      setTranscriptOffset: function (n) { espacio(seqActual).offset = n; },
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
      call: function (m, arg) {
        if (m === 'mediaHasAudio') return Promise.resolve({ ok: true, hasAudio: false });
        if (m === 'loadTranscript') {
          espia.transcriptsPedidos.push(arg);
          return Promise.resolve(opts.transcriptEnDisco || { ok: true, found: false });
        }
        return Promise.resolve({ ok: true });
      },
      callProg: function (metodo, arg) {
        if (metodo === 'saveQueue') { espia.guardado = arg; return Promise.resolve({ ok: true }); }
        if (metodo === 'prepareFeedback' || metodo === 'prepareGenerate') {
          espia.preparados.push(arg);
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
  return { ctx: ctx, espia: espia, porSecuencia: porSecuencia };
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

// ── El tramo del guion, en la corrección y en su feedback ────────────
// Es lo único que le dice al modelo QUÉ se está diciendo mientras el recurso
// está en pantalla, y CUÁNDO: sin eso la animación deja de acompañar. Viaja en
// toda llamada, también al refinar (ahí el transcript completo de la clase no
// va, pero el fragmento del marcador sí).

/** Un guion de la clase, con una línea justo en el tramo del recurso. */
const GUION = [
  { start: 10, end: 20, text: 'esto es de otro momento' },
  { start: 128, end: 135, text: 'y acá vemos las ventas por trimestre' },
];

test('la corrección manda el fragmento del guion de su tramo', async function () {
  const c = montarCola({ porSecuencia: { 'Clase 14': { transcript: GUION } } });
  c.ctx.HPQueue.add(jobBase({ correction: true }));
  await dejarCorrer();

  const frag = c.espia.preparados[0].markerTranscript;
  eq(frag.length, 1, 'solo lo que se dice mientras el recurso está en pantalla');
  eq(frag[0].text, 'y acá vemos las ventas por trimestre');
});

test('corrigiendo de otro corte, el guion sale del corte donde NACIÓ el recurso', async function () {
  // El tramo (128.5s) es el del corte viejo: recortarlo del guion de la
  // secuencia abierta daría un pedazo de otra parte de la clase.
  const c = montarCola({ porSecuencia: {
    'Clase 14': { transcript: [{ start: 128, end: 135, text: 'en el corte nuevo acá se habla de otra cosa' }] },
    'Clase 14 v1': { transcript: GUION },
  } });
  c.ctx.HPQueue.add(jobBase({ correction: true, storeSeqName: 'Clase 14 v1' }));
  await dejarCorrer();
  eq(c.espia.preparados[0].markerTranscript[0].text, 'y acá vemos las ventas por trimestre');
});

test('si ese corte no está en el panel, el guion se trae de su carpeta', async function () {
  // Pasa con un job restaurado en otra sesión, o corrigiendo un corte que nunca
  // se abrió en esta máquina. Está en el disco: no hay por qué corregir a ciegas.
  const c = montarCola({
    porSecuencia: { 'Clase 14 v1': {} },
    transcriptEnDisco: { ok: true, found: true, segments: GUION, offset: 0 },
  });
  c.ctx.HPQueue.add(jobBase({ correction: true, storeSeqName: 'Clase 14 v1' }));
  await dejarCorrer();

  eq(c.espia.transcriptsPedidos[0].sequenceName, 'Clase 14 v1', 'se pide el del corte de origen');
  eq(c.espia.preparados[0].markerTranscript[0].text, 'y acá vemos las ventas por trimestre');
  eq(c.porSecuencia['Clase 14 v1'].transcript.length, 2, 'y queda en el panel, contra ESE corte');
});

test('sin transcript en ningún lado, se genera igual: no se frena la corrección', async function () {
  // Ese corte puede ya no existir en el proyecto. Corregir con el HTML previo y
  // el encargo es peor que con el guion, pero muchísimo mejor que no poder.
  const c = montarCola({ porSecuencia: { 'Clase 14 v1': {} } });
  c.ctx.HPQueue.add(jobBase({ correction: true, storeSeqName: 'Clase 14 v1' }));
  await dejarCorrer();
  eq(c.espia.preparados.length, 1, 'se llamó al modelo igual');
  eq(c.espia.colocados.length, 1, 'y el clip llegó al timeline');
});

test('el que ya tiene el guion no va al disco a buscarlo', async function () {
  const c = montarCola({ porSecuencia: { 'Clase 14': { transcript: GUION } } });
  c.ctx.HPQueue.add(jobBase());
  await dejarCorrer();
  eq(c.espia.transcriptsPedidos.length, 0);
});

test('la segunda ronda de feedback también lleva el fragmento', async function () {
  const c = montarCola({ porSecuencia: { 'Clase 14': { transcript: GUION } } });
  c.ctx.HPQueue.add(jobBase({ correction: true }));
  await dejarCorrer();

  c.ctx.HPQueue.regenerate(c.ctx.HPQueue.jobs()[0].id, 'ahora corré el subtítulo');
  await dejarCorrer();
  eq(c.espia.preparados[1].markerTranscript[0].text, 'y acá vemos las ventas por trimestre');
});

test('rehidratar completa, pero no vacía lo que el job ya traía', async function () {
  // El corte donde nació el recurso puede no tener estado en este panel (nunca
  // se abrió en esta máquina). Ahí el transcript sale de otro lado, y pisarlo
  // con la lista vacía dejaba al modelo sin el guion del tramo.
  const c = montarCola();
  const tramo = [{ start: 128, end: 135, text: 'y acá vemos las ventas' }];
  c.ctx.HPQueue.add(jobBase({ payload: {
    projectPath: '/p/Clases.prproj', sequenceName: 'Clase 14 v1', mode: 'adjust',
    markerSlug: 'Marcador 3', markerTranscript: tramo,
  } }));
  await dejarCorrer();

  eq(c.espia.preparados[0].markerTranscript.length, 1, 'el fragmento del marcador sigue viajando');
});

test('la segunda ronda de feedback refina la versión NUEVA, no la que se eligió al principio', async function () {
  // Una corrección lleva pegado el HTML de la versión que el editor eligió. Si
  // ese HTML se queda en el job, apretar Regenerar en la Cola vuelve a refinar
  // aquella y tira la versión que se acaba de ver, sin decir nada.
  const c = montarCola();
  c.ctx.HPQueue.add(jobBase({ correction: true, payload: {
    projectPath: '/p/Clases.prproj', sequenceName: 'Clase 14', mode: 'adjust',
    markerSlug: 'Marcador 3', previousHtml: '<div id="stage">v3</div>',
  } }));
  await dejarCorrer();
  eq(c.espia.preparados[0].previousHtml, '<div id="stage">v3</div>', 'la primera sí va sobre la elegida');

  c.ctx.HPQueue.regenerate(c.ctx.HPQueue.jobs()[0].id, 'ahora corré el subtítulo');
  await dejarCorrer();

  eq(c.espia.preparados[1].previousHtml, undefined, 'la segunda parte de la última en disco');
  eq(c.espia.preparados[1].adjustment, 'ahora corré el subtítulo');
});

test('las imágenes a incrustar no se escriben en el archivo de la cola', async function () {
  // Son base64: guardarlas hacía un queue.json de megas por un dato que se
  // vuelve a leer del marcador antes de correr.
  const c = montarCola();
  c.ctx.HPQueue.add(jobBase({ payload: {
    projectPath: '/p/Clases.prproj', sequenceName: 'Clase 14', mode: 'adjust',
    markerSlug: 'Marcador 3', assets: ['data:image/png;base64,AAAA'],
  } }));
  await dejarCorrer();
  await new Promise(function (r) { setTimeout(r, 1200); });

  const j = c.espia.guardado.jobs.filter(function (x) { return x.markerKey === 'Marcador 3'; })[0];
  eq(j.payload.assets, undefined);
});
