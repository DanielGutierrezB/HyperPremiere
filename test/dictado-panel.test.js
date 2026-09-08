'use strict';

// El dictado del lado del panel, y sobre todo LA REGLA QUE LO CONTIENE:
//
//   el dictado es un agregado al campo de prompt, nunca un requisito.
//
// Esa regla se escribió con sangre. La primera versión de este trabajo colgaba
// el micrófono con `caja.appendChild(HPDictado.attachMic(ta).el)` sin
// preguntar si el módulo estaba, y en cuanto no estaba —que es lo que pasa en
// el DOM de los tests— la excepción se comía el render ENTERO: no desaparecía
// el micrófono, desaparecía la pestaña de correcciones y la caja de feedback de
// la cola. Cuarenta y cuatro tests en rojo por un botón opcional.
//
// Y no es un problema de los tests. El módulo falta de verdad en tres
// situaciones que ya conocemos: en Windows (donde el botón va deshabilitado por
// decisión tomada), en una máquina sin Whisper instalado, y si `js/dictado.js`
// no llega a evaluarse por lo que sea. En los tres casos el editor tiene que
// poder escribir su instrucción a mano y generar igual.
//
// Por eso la mitad de este archivo dibuja las vistas SIN dictado y comprueba
// que funcionan enteras. Es la parte que no se puede sacar.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');

// ── DOM de mentira, el mismo de las otras suites del panel ───────────

function elemento(tag) {
  const el = {
    tagName: tag, children: [], listeners: {}, style: {}, className: '',
    textContent: '', value: '', title: '', type: '', rows: 0, checked: false,
    disabled: false, placeholder: '', spellcheck: false, childNodes: [],
    appendChild: function (h) { this.children.push(h); this.childNodes.push(h); h.parentNode = this; return h; },
    insertBefore: function (h) { this.children.push(h); this.childNodes.push(h); h.parentNode = this; return h; },
    setAttribute: function (k, v) { this[k] = v; },
    getAttribute: function (k) { return this[k] === undefined ? null : this[k]; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    click: function () {
      (this.listeners.click || []).forEach(function (f) {
        f({ stopPropagation: function () {}, preventDefault: function () {} });
      });
    },
    // El evento lleva `target`: la caja de la cola no se lee con `.value`, se
    // lee del borrador que llena el handler de `input`. Escribir sin disparar
    // el evento probaría un camino que el editor no recorre nunca.
    escribir: function (texto) {
      this.value = texto;
      const self = this;
      (this.listeners.input || []).forEach(function (f) { f({ target: self }); });
    },
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
    porTag: function (t) {
      let out = [];
      for (const h of this.children) {
        if (h.tagName === t) out.push(h);
        if (h.porTag) out = out.concat(h.porTag(t));
      }
      return out;
    },
    // El dictado sube el campo (y su micrófono) al viewport al arrancar. No se
    // puede comprobar que "quedó visible" —esto no dibuja nada—, pero sí que se
    // pidió, que es lo que alguien puede borrar sin querer.
    scrollIntoView: function () { this.traido = (this.traido || 0) + 1; },
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
  el.classList = { add: function (c) { el.className = (el.className ? el.className + ' ' : '') + c; }, remove: function () {} };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return ''; },
    set: function () { el.children.length = 0; el.childNodes.length = 0; },
  });
  return el;
}

/**
 * El primer descendiente que tenga esa clase ENTRE las suyas.
 *
 * `buscar` compara el className completo, y no alcanza para la barra del
 * micrófono: sus nodos se repintan con clases de estado pegadas
 * (`mic-state is-warn`, `mic-btn is-busy`), que es justo lo que hay que mirar.
 */
function porClase(raiz, clase) {
  for (const h of raiz.children) {
    if (String(h.className).split(/\s+/).indexOf(clase) !== -1) return h;
    const hit = porClase(h, clase);
    if (hit) return hit;
  }
  return null;
}

/**
 * El emoji del ✨ y su palabra, que viven en dos `<span>` y no en el
 * `textContent` del botón.
 *
 * Están separados porque la palabra se esconde con CSS en el panel angosto, y
 * CSS no puede esconder media palabra de un nodo de texto. Los tests preguntan
 * por cada uno donde antes preguntaban por el botón entero.
 */
function icono(btn) { const e = porClase(btn, 'mic-refine-ico'); return e ? String(e.textContent) : null; }
function palabra(btn) { const e = porClase(btn, 'mic-refine-txt'); return e ? String(e.textContent) : null; }

/** Un HPDictado de mentira que cuelga una barra reconocible. */
function dictadoDeMentira(espia) {
  return {
    attachMic: function (ta, opts) {
      espia.enganchados.push((opts && opts.id) || '?');
      const bar = elemento('div');
      bar.className = 'mic-bar';
      const btn = elemento('button');
      btn.className = 'mic-btn';
      bar.appendChild(btn);
      return { el: bar };
    },
  };
}

// ── 1. La cola: la caja de feedback SIN dictado ──────────────────────

/** Dibuja la cola con un job terminado. `dictado` puede ser null (no está). */
function dibujarCola(dictado, espia) {
  const nodos = {
    'queue-panel': elemento('div'), 'view-queue': elemento('div'), 'tab-queue-count': elemento('span'),
  };
  const guardado = {};
  const jobs = [{
    id: 'j1', status: 'done', kind: 'feedback', label: 'Marcador 1',
    seqName: 'Clase 23', projectPath: '/p/Clases.prproj', markerKey: 'Marcador 1',
    markerStart: 128.5, markerDuration: 8, version: 4, msg: 'Listo y colocado',
  }];
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
    HPWidgets: { confirmOverlay: function () {} },
    HPEngine: { call: function () { return Promise.resolve({ ok: true }); } },
    HPStills: {
      fbInit: function () {}, fbClear: function () {}, fbCollect: function () { return []; },
      createControl: function () { const e = elemento('div'); e.className = 'marker-stills'; return e; },
    },
    HPQueue: {
      jobs: function () { return jobs; },
      isPending: function (s) { return s === 'queued' || s === 'modeling' || s === 'ready' || s === 'running'; },
      isActive: function (s) { return s === 'modeling' || s === 'ready' || s === 'running'; },
      isPaused: function () { return false; }, hasActive: function () { return false; },
      hasQueued: function () { return false; },
      needsPlacing: function () { return false; },
      regenerate: function (id, texto, idx) { espia.regenerados.push({ id: id, texto: texto, idx: idx }); },
      regenerateFresh: function () {},
      timing: { calibrated: function () { return true; }, estimateSec: function () { return 0; } },
    },
    document: {
      createElement: elemento,
      createTextNode: function (t) { const n = elemento('#text'); n.textContent = t; return n; },
      getElementById: function (id) { return nodos[id] || null; },
    },
  };
  // Acá está el punto del test: si `dictado` es null, HPDictado NO se define en
  // el contexto. No es que valga undefined: la variable global no existe, que es
  // exactamente lo que pasa en un panel donde el <script> no cargó.
  if (dictado) ctx.HPDictado = dictado;
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'queue-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  ctx.HPQueueView.init({
    goToJobMarker: function () {}, showJobInTimeline: function () {},
    currentSequence: function () { return 'Clase 23'; },
    setOutput: function () {}, preparingSequence: function () { return null; },
    sequenceContext: function () { return null; },
  });
  ctx.HPQueueView.render(jobs);
  return { ctx: ctx, panel: nodos['queue-panel'] };
}

test('sin dictado, la caja de feedback de la cola se dibuja y funciona', function () {
  const espia = { regenerados: [] };
  const d = dibujarCola(null, espia);

  const btn = d.panel.porTexto('✎ Feedback');
  ok(btn, 'el job terminado sigue ofreciendo feedback: el micrófono no se lleva puesta la cola');
  btn.click();

  const caja = d.panel.buscar('qj-fb-input');
  ok(caja, 'y la caja de texto está');
  ok(!d.panel.buscar('mic-bar'), 'sin micrófono, claro');

  // Lo que importa no es que la caja exista: es que ESCRIBIR Y MANDAR ande.
  caja.escribir('el título tapa la cara, subilo');
  const refinar = d.panel.porTexto('↻ Refinar');
  ok(refinar, 'el botón de refinar está');
  refinar.click();
  eq(espia.regenerados.length, 1, 'el feedback se mandó');
  eq(espia.regenerados[0].texto, 'el título tapa la cara, subilo',
    'con el texto escrito a mano, que es todo lo que el editor necesita');
});

test('con dictado, la caja de feedback suma el micrófono sin perder nada', function () {
  const espia = { regenerados: [], enganchados: [] };
  const d = dibujarCola(dictadoDeMentira(espia), espia);
  d.panel.porTexto('✎ Feedback').click();

  ok(d.panel.buscar('mic-bar'), 'ahora sí está el micrófono');
  eq(espia.enganchados[0], 'cola:j1', 'colgado del job, que es como el motor sabe cuál dictado es cuál');

  const caja = d.panel.buscar('qj-fb-input');
  caja.escribir('subí el título');
  d.panel.porTexto('↻ Refinar').click();
  eq(espia.regenerados[0].texto, 'subí el título', 'y mandar sigue andando igual');
});

// ── 2. Correcciones: la fila SIN dictado ─────────────────────────────

/** Carga la pestaña de correcciones y devuelve la primera fila. */
async function dibujarCorreccion(dictado, espia) {
  const nodos = {
    'corr-list': elemento('div'), 'corr-status': elemento('div'),
    'btn-load-corrections': elemento('button'), 'corr-source-picker': elemento('div'),
  };
  const m = {
    slug: 'Marcador 3', latestVersion: 4, model: 'claude-sonnet-5',
    versions: [{ version: 4, model: 'claude-sonnet-5', hasVideo: true }],
    start: 128.5, duration: 7, timeSource: 'ficha',
    markerName: 'Gráfico de barras', markerGuid: 'g-3',
    instruction: 'un gráfico de barras', history: [], background: false,
  };
  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Object: Object, Array: Array, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
    HPLog: { log: function () {} },
    HPWidgets: { makeCodeEditor: function () { const e = elemento('div'); return { el: e, getValue: function () { return ''; }, setValue: function () {} }; } },
    HPHost: { openSequenceAndSeek: function () {} },
    HPStills: {
      fbInit: function () {}, fbClear: function () {}, fbCollect: function () { return []; },
      createControl: function () { const e = elemento('div'); e.className = 'marker-stills'; return e; },
    },
    HPQueue: {
      add: function (job) { espia.encolados.push(job); },
      addStaged: function (job) { espia.encolados.push(job); },
    },
    HPStore: {
      GENERAL_KEY: '__general__',
      withContext: function (p, s, fn) { return fn(); },
      getObjective: function () { return ''; },
      getTranscript: function () { return []; },
      setTranscript: function () {}, setTranscriptOffset: function () {},
      getMarkerData: function () { return {}; },
    },
    HPEngine: {
      call: function (metodo, arg) {
        if (metodo === 'listCorrections') {
          return Promise.resolve({
            ok: true, markers: [m], baseDir: '/p/HyperPremiere/clase-14',
            sequenceName: 'Clase 14', sourceSequenceName: 'Clase 14',
            folderSlug: 'clase-14', guessed: false,
            sources: [{ slug: 'clase-14', sequenceName: 'Clase 14', count: 1 }],
          });
        }
        if (metodo === 'readMarkerHtml') return Promise.resolve({ ok: true, html: '<div id="stage"></div>', version: arg.version });
        if (metodo === 'loadTranscript') return Promise.resolve({ ok: true, found: false });
        return Promise.resolve({ ok: true });
      },
    },
    document: { createElement: elemento, getElementById: function (id) { return nodos[id] || null; } },
  };
  if (dictado) ctx.HPDictado = dictado;
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'corrections.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  ctx.HPCorrections.init({
    context: function () { return { projectPath: '/p/Clases.prproj', sequenceName: 'Clase 14' }; },
    refreshContext: function (cb) { cb(); },
  });
  nodos['btn-load-corrections'].click();
  await new Promise(function (r) { setTimeout(r, 0); });
  const filas = nodos['corr-list'].children.filter(function (c) {
    return String(c.className).indexOf('corr-row') === 0;
  });
  return { ctx: ctx, fila: filas[0], lista: nodos['corr-list'] };
}

test('sin dictado, la fila de correcciones se dibuja y encola', async function () {
  const espia = { encolados: [] };
  const { fila } = await dibujarCorreccion(null, espia);

  ok(fila, 'la fila existe: sin esto la pestaña entera queda vacía y no se sabe por qué');
  ok(!fila.buscar('mic-bar'));

  const cajas = fila.porTag('textarea');
  ok(cajas.length, 'con su caja para escribir qué corregir');
  cajas[0].value = 'el título tapa la cara';

  const enviar = fila.porTexto('↻ Regenerar');
  ok(enviar, 'y su botón');
  enviar.click();
  await new Promise(function (r) { setTimeout(r, 0); }); // lee el HTML de la versión antes de encolar
  eq(espia.encolados.length, 1, 'la corrección se encoló escribiéndola a mano');
  has(espia.encolados[0].payload.adjustment, 'el título tapa la cara',
    'y llegó con lo que se escribió, no vacía');
});

test('con dictado, la fila de correcciones suma el micrófono sin perder nada', async function () {
  const espia = { encolados: [], enganchados: [] };
  const { fila } = await dibujarCorreccion(dictadoDeMentira(espia), espia);
  ok(fila.buscar('mic-bar'), 'el micrófono está');
  eq(espia.enganchados[0], 'correccion:Marcador 3');
  fila.porTag('textarea')[0].value = 'subí el título';
  fila.porTexto('↻ Regenerar').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(espia.encolados.length, 1, 'y encolar sigue andando');
});

// ── 3. Un dictado que revienta tampoco se lleva el campo ─────────────

test('si el micrófono explota al colgarse, el campo se dibuja igual', function () {
  // No es paranoia: `attachMic` le pregunta al motor si se puede dictar, y ese
  // motor puede no estar (panel a medio arrancar, engine-client que no cargó).
  // El editor pierde el botón, que es opcional; no puede perder la caja.
  const espia = { regenerados: [] };
  const d = dibujarCola({
    attachMic: function () { throw new Error('HPEngine no está definido'); },
  }, espia);
  d.panel.porTexto('✎ Feedback').click();
  const caja = d.panel.buscar('qj-fb-input');
  ok(caja, 'la caja está');
  ok(!d.panel.buscar('mic-bar'), 'y el micrófono simplemente no aparece');
  caja.escribir('corregí el color');
  d.panel.porTexto('↻ Refinar').click();
  eq(espia.regenerados[0].texto, 'corregí el color');
});

test('un HPDictado a medio cargar se trata como ausente', function () {
  const espia = { regenerados: [] };
  // Un objeto sin `attachMic`: si se lo llamara igual, sería un TypeError
  // adentro del render, o sea el mismo agujero por otra puerta.
  const d = dibujarCola({}, espia);
  d.panel.porTexto('✎ Feedback').click();
  ok(d.panel.buscar('qj-fb-input'));
});

// ── 4. La regla, también donde no se puede montar el DOM ─────────────

test('ningún campo de prompt llama al micrófono sin la guarda', function () {
  // Los cuatro enganches viven en vistas que, para montarse, piden el panel
  // entero: header, pestañas, config, host de Premiere. Levantar todo eso para
  // probar una guarda de una línea sería un test más frágil que lo que protege.
  // Así que acá se fija la regla sobre el texto: en TODO `cep/js/` el único
  // lugar donde se puede nombrar `HPDictado.attachMic` es la guarda de
  // `util.js`, que pregunta antes. (En `dictado.js` no aplica: ahí se define.)
  //
  // Es de segunda: comprueba la forma, no el comportamiento. Se deja porque es
  // lo que atrapa el error de verdad —volver a escribir
  // `caja.appendChild(HPDictado.attachMic(ta).el)` de un tirón— y ese error, en
  // una máquina sin Whisper, deja al editor sin campo donde escribir.
  const util = fs.readFileSync(path.join(CEP, 'util.js'), 'utf8');
  const guarda = util.match(/\n  function micOpcional\(ta, opts\) \{\n[\s\S]*?\n  \}\n/);
  ok(guarda, 'util.js: tiene que tener la guarda micOpcional');
  has(guarda[0], 'typeof HPDictado === "undefined"',
    'la guarda tiene que contemplar que la global NO EXISTA. Preguntar por ' +
    '`!HPDictado` a secas tira ReferenceError, que es el mismo agujero por otra puerta.');
  has(guarda[0], 'catch', 'y que attachMic reviente por dentro tampoco puede tumbar el campo');
  eq((util.replace(guarda[0], '\n').match(/HPDictado\.attachMic/g) || []).length, 0,
    'util.js: fuera de la guarda tampoco se nombra');

  // Y ninguna vista lo nombra por su cuenta: todas pasan por HPUtil.micOpcional.
  fs.readdirSync(CEP).filter(function (f) {
    return /\.js$/.test(f) && f !== 'dictado.js' && f !== 'util.js';
  }).forEach(function (f) {
    const src = fs.readFileSync(path.join(CEP, f), 'utf8');
    eq((src.match(/HPDictado\.attachMic/g) || []).length, 0,
      f + ': colgar el micrófono sin preguntar es lo que dejó 44 tests en rojo y, en una ' +
      'máquina sin Whisper, al editor sin campo donde escribir. Usá HPUtil.micOpcional.');
  });
});

// ── 5. La lógica pura del widget ─────────────────────────────────────

/** Carga dictado.js solo (no necesita DOM: lo que se prueba son funciones). */
function cargarDictado() {
  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, Object: Object, String: String,
    Number: Number, Array: Array, Promise: Promise,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: function () { return 0; }, clearInterval: function () {},
    HPLog: { log: function () {} },
    HPEngine: { call: function () { return Promise.resolve({ ok: true, disponible: true }); } },
    HPStore: { addDictadoUsage: function () {} },
    document: { createElement: elemento },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(CEP, 'dictado.js'), 'utf8'), ctx, { filename: 'dictado.js' });
  return ctx.HPDictado;
}

test('volver al dictado crudo devuelve EXACTAMENTE lo dictado', function () {
  const D = cargarDictado();
  // Con el campo vacío, "el dictado crudo" no puede traer una línea de más ni
  // un espacio: es lo que el editor va a comparar contra lo que refinó el
  // modelo, y si no coincide, la vuelta atrás no sirve para lo que se pensó.
  eq(D._textoSinRefinar('', 'que el título entre desde la izquierda'),
    'que el título entre desde la izquierda');
  eq(D._textoSinRefinar(null, '  que entre con un fade  '), 'que entre con un fade');
});

test('lo que el editor ya tenía escrito queda arriba y no se pisa', function () {
  const D = cargarDictado();
  eq(D._textoSinRefinar('título en azul', 'y el logo abajo a la derecha'),
    'título en azul\ny el logo abajo a la derecha');
  eq(D._textoEnVivo('título en azul', 'y el logo'), 'título en azul\ny el logo',
    'mientras habla también: lo suyo intacto arriba, el dictado abajo');
});

test('sin dictar nada, el campo queda como estaba', function () {
  const D = cargarDictado();
  eq(D._textoSinRefinar('lo que ya estaba', ''), 'lo que ya estaba');
  eq(D._textoSinRefinar('', ''), '');
});

test('en Windows el botón se VE, apagado y diciendo por qué', function () {
  const D = cargarDictado();
  const p = D._pintarBoton('no-disponible', {
    motivo: 'El dictado por voz todavía es solo para Mac.',
  });
  ok(p.apagado, 'no se puede apretar');
  has(p.titulo, 'solo para Mac', 'y el motivo está a la vista');
  eq(p.texto, '🎙', 'el ícono sigue siendo el micrófono: esconderlo dejaría al editor ' +
    'sin saber que la función existe');
  has(p.clase, 'is-off');
});

test('el botón avisa ANTES si falta bajar el modelo', function () {
  const D = cargarDictado();
  // La primera vez son ~480 MB. Un botón que se queda mudo un minuto parece
  // colgado, y el editor lo aprieta de nuevo o cierra el panel.
  const p = D._pintarBoton('preparando', { faltaBajarModelo: true });
  has(p.titulo, 'MB');
  has(p.titulo, 'una sola vez', 'para que sepa que no va a pasar siempre');
});

test('sin refinador el botón lo dice de entrada, no después de dictar', function () {
  const D = cargarDictado();
  const p = D._pintarBoton('listo', { sinRefinador: 'Ollama local: no está corriendo' });
  has(p.titulo, 'queda como lo dictaste');
  has(p.titulo, 'no está corriendo');
  ok(!p.apagado, 'pero se puede dictar igual: el texto crudo ya sirve');
});

test('mientras escucha, la línea avisa que el texto va atrás', function () {
  const D = cargarDictado();
  const l = D._lineaDeEstado({ fase: 'escuchando', segundos: 12 });
  has(l.texto, '12 s');
  has(l.texto, 'unos segundos atrás',
    'la captura entrega a ~90% de tiempo real: decirlo evita el "se colgó"');
  has(l.texto, 'se pone al día');
});

test('al terminar se dice con qué se refinó y cuánto tardó', function () {
  const D = cargarDictado();
  const l = D._lineaDeEstado({ fase: 'refinado', refinador: 'Claude Haiku (CLI de Claude)', ms: 5800 });
  has(l.texto, 'Claude Haiku', 'cuando un editor diga "el dictado me sale raro", es el primer dato');
  has(l.texto, '5.8 s');
  has(l.clase, 'is-ok');
});

test('si no se pudo refinar, se avisa en amarillo y no en rojo', function () {
  const D = cargarDictado();
  // El dictado ESTÁ en el campo: no es un error, es un resultado peor. Pintarlo
  // de rojo diría que hay que rehacerlo, y no hay que rehacer nada.
  const l = D._lineaDeEstado({ fase: 'sin-refinar', aviso: 'Ollama local falló.' });
  has(l.clase, 'is-warn');
  has(l.texto, 'Ollama local falló.');
});

// ── 6. El campo que crece mientras se dicta ──────────────────────────
//
// Para poder ir leyendo lo que se dice, el campo se agranda con el texto. El
// problema es lo que hay JUSTO DEBAJO: el botón para parar. Un campo que crece
// sin freno lo empuja fuera de la vista y deja al editor dictando sin poder
// frenar, que es peor que no tener la función. De ahí que el tope esté atado al
// alto del panel y no sea un número de píxeles: el panel abre en 400×600 pero se
// redimensiona (mínimo 320×400, máximo 2200×2200 según el manifest), y en un
// panel bajito un tope generoso se lo come entero.

/** El alto de un campo con `contenido` px de texto, en un panel de `panel` px. */
function medir(D, contenido, panel, minimo) {
  return D._altoDelCampo({ contenido: contenido, altoPanel: panel, minimo: minimo === undefined ? 44 : minimo });
}

test('el campo crece con lo que se va dictando', function () {
  const D = cargarDictado();
  eq(medir(D, 44, 600).alto, 44, 'con una línea queda como estaba');
  eq(medir(D, 120, 600).alto, 120, 'con tres, mide tres');
  eq(medir(D, 210, 600).alto, 210);
  ok(!medir(D, 210, 600).scroll, 'y hasta ahí sin scroll: entra entero, se lee todo de un vistazo');
});

test('el campo deja de crecer en el tope, y ahí sí aparece el scroll', function () {
  const D = cargarDictado();
  const r = medir(D, 4000, 600);
  eq(r.alto, 270, 'en el panel de arranque (600 de alto) el tope son 270 px');
  eq(r.alto, r.tope, 'de ahí no pasa por más que se siga hablando');
  ok(r.scroll, 'lo que no entra se ve con scroll: estirar el campo sería empujar el botón afuera');
});

test('en un panel bajito el tope se achica con él', function () {
  const D = cargarDictado();
  // Lo mismo dictado, en los dos altos que importan: el mínimo del manifest y el
  // de arranque. Si el tope fuera un número fijo de píxeles, el de 400 quedaría
  // con el campo ocupando media pantalla y el botón abajo de todo.
  eq(medir(D, 4000, 400).tope, 180, 'panel en su alto mínimo');
  eq(medir(D, 4000, 600).tope, 270, 'panel recién abierto');
  eq(medir(D, 4000, 900).tope, 320, 'panel grande: acá manda el techo duro');
  ok(medir(D, 4000, 400).alto < medir(D, 4000, 600).alto,
    'el mismo dictado tiene que ocupar menos en el panel más bajo');
});

test('en un panel enorme el campo tampoco se vuelve una pared de texto', function () {
  const D = cargarDictado();
  // 45% de 2200 son 990 px de campo. No se lee mejor: solo deja el ■ de parar a
  // un metro del renglón que se está mirando.
  eq(medir(D, 9000, 2200).alto, 320);
});

test('con el panel en su alto mínimo y el campo lleno, el botón sigue entrando', function () {
  const D = cargarDictado();
  // El caso feo, con nombre y apellido: 400 px de alto (lo más chico que deja el
  // manifest) y un dictado largo. La barra del micrófono mide unos 40 px, y con
  // la línea de estado en dos renglones —que es lo que pasa en el panel
  // acoplado, que es angosto— se va a unos 55. Se exige que sobren 90 largos.
  const r = medir(D, 5000, 400, 54);
  eq(r.alto, 180);
  ok(400 - r.alto >= 90, 'quedan ' + (400 - r.alto) + ' px para la barra del micrófono y el aire');
});

test('el botón para parar entra debajo del campo a CUALQUIER alto de panel', function () {
  const D = cargarDictado();
  // El invariante que sostiene todo lo demás. Se barre el rango entero que
  // permite el manifest, porque el panel se redimensiona con el mouse y no hay
  // ningún alto "elegido" que se pueda privilegiar.
  for (let panel = 400; panel <= 2200; panel += 20) {
    for (const contenido of [0, 30, 44, 260, 1200, 20000]) {
      const r = medir(D, contenido, panel, 54);
      ok(panel - r.alto >= 90,
        'panel de ' + panel + ' con ' + contenido + ' px de texto: el campo se quedó con ' +
        r.alto + ' px y dejó solo ' + (panel - r.alto) + ' para el botón');
    }
  }
});

test('al parar, el campo vuelve al alto de lo que quedó escrito', function () {
  const D = cargarDictado();
  // Refinar casi siempre ACORTA (el crudo trae muletillas y repeticiones), así
  // que el campo tiene que poder achicarse igual que creció. Pero no por debajo
  // del alto que tenía en reposo: eso sería devolverle al editor un campo más
  // chico que el que abrió.
  eq(medir(D, 20, 600).alto, 44, 'quedó una línea → el alto de siempre');
  eq(medir(D, 130, 600).alto, 130, 'quedó un párrafo → se lee entero, sin tener que estirarlo a mano');
  const largo = medir(D, 900, 600);
  eq(largo.alto, 270, 'quedó un texto largo → hasta el tope');
  ok(largo.scroll, 'y con scroll, que es lo que evita que se coma el panel');
});

test('el tope nunca queda por debajo de cero ni con datos raros', function () {
  const D = cargarDictado();
  // `altoPanel` sale de `window.innerHeight`, y en un panel a medio abrir puede
  // llegar en 0. Devolver un alto negativo pondría `height: -40px` en el campo.
  ok(D._altoDelCampo({}).alto >= 0);
  ok(medir(D, 500, 0).alto >= 0);
  ok(medir(D, 500, 50).alto >= 0, 'ni siquiera con un panel más bajo que la propia barra');
});

// ── 7. El crecimiento, cableado al dictado de verdad ─────────────────
//
// Lo de arriba prueba la cuenta. Esto prueba que la cuenta esté ENCHUFADA: que
// el campo se acomode en cada refresco, que se despliegue lo que lo tapa y que
// el final quede a la vista.
//
// Con una advertencia honesta: el DOM de mentira de este repo NO tiene motor de
// layout. No mide cajas, no envuelve texto y no calcula scroll. Así que acá se
// le pone al campo una REGLA DE MENTIRA —`scrollHeight` sale de contar
// renglones a 18 px, no de medir nada— y lo que se comprueba es el CABLEADO, no
// el dibujo: que se llame a acomodar en cada refresco, que se pida el final
// después de reescribir el texto entero y que el alto salga de `altoDelCampo`.
// Que el campo se vea bien se midió a mano en la maqueta (test/manual/panel-demo,
// que usa el HTML y el CSS de verdad), como en panel-cartel-preparar-motor.

/**
 * Un textarea con regla de mentira: renglones de 18 px envolviendo a 40
 * caracteres, 44 px en reposo y 2 px de borde.
 *
 * Lo único que la regla copia FIEL del navegador es la relación entre las tres
 * medidas: `clientHeight` sigue al alto que se le puso, y `scrollHeight` nunca
 * baja de `clientHeight`. Parece un detalle y es la razón de que haya que poner
 * `height:auto` antes de medir: sin eso el campo puede crecer pero no achicarse,
 * porque el alto viejo le pone piso a la medición del texto nuevo.
 */
function campoConRegla() {
  const ta = elemento('textarea');
  ta.scrollTop = 0;
  Object.defineProperty(ta, 'altoDelTexto', {
    get: function () {
      const renglones = String(ta.value || '').split('\n').reduce(function (n, l) {
        return n + Math.max(1, Math.ceil(l.length / 40));
      }, 0);
      return 8 + 18 * renglones;
    },
  });
  Object.defineProperty(ta, 'clientHeight', {
    get: function () { return (parseInt(String(ta.style.height || ''), 10) || 44) - 2; },
  });
  Object.defineProperty(ta, 'offsetHeight', { get: function () { return ta.clientHeight + 2; } });
  Object.defineProperty(ta, 'scrollHeight', {
    get: function () { return Math.max(ta.altoDelTexto, ta.clientHeight); },
  });
  return ta;
}

/** El alto que el widget le dejó puesto al campo, en píxeles. */
function altoPuesto(ta) { return parseInt(String(ta.style.height || '0'), 10) || 0; }

/** El refinado que devuelve el motor de mentira si no se le pide otra cosa. */
const REFINADO = { ok: true, texto: 'Título desde la izquierda, con fade.', refinador: 'Claude Haiku', ms: 900 };

/**
 * Cuelga un micrófono de verdad de un campo con regla, adentro de un `<details>`
 * plegado (que es como está una tarjeta de marcador que no se abrió).
 *
 * `o.estado` reemplaza lo que contesta `dictadoEstado` —que es lo que separa "se
 * puede dictar" de "se puede refinar"—, y `o.refinar(arg)` reemplaza lo que
 * contesta `dictadoRefinar`. `HPStore` es el DE VERDAD, con un localStorage en
 * memoria: el contador de la sesión es parte de lo que hay que probar y un espía
 * no diría si el gasto cayó en el bolsillo correcto.
 */
function montarDictado(altoPanel, o) {
  o = o || {};
  const estado = Object.assign(
    { ok: true, disponible: true, puedeRefinar: true, refinador: 'Claude Haiku' },
    o.estado || {}
  );
  const ta = campoConRegla();
  const tarjeta = elemento('details');
  tarjeta.open = false;
  tarjeta.appendChild(ta);

  let avisarProgreso = null;
  let terminarDictado = null;
  const pedidos = [];   // cada `dictadoRefinar` que salió del panel
  const logs = [];      // lo que se escribió en el ⬇ Log
  const disco = {};
  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, Object: Object, String: String,
    Number: Number, Array: Array, Promise: Promise, parseInt: parseInt,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: function () { return 0; }, clearInterval: function () {},
    innerHeight: altoPanel,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(disco, k) ? disco[k] : null; },
      setItem: function (k, v) { disco[k] = String(v); },
      removeItem: function (k) { delete disco[k]; },
    },
    HPLog: { log: function (msg, nivel) { logs.push({ msg: String(msg), nivel: nivel || 'INFO' }); } },
    HPEngine: {
      call: function (metodo, arg) {
        if (metodo === 'dictadoEstado') {
          return o.estadoFalla ? Promise.reject(new Error(o.estadoFalla)) : Promise.resolve(estado);
        }
        if (metodo === 'dictadoRefinar') {
          pedidos.push(arg);
          return Promise.resolve(o.refinar ? o.refinar(arg) : REFINADO);
        }
        return Promise.resolve({ ok: true });
      },
      callProg: function (metodo, arg, onProg) {
        avisarProgreso = onProg;
        return new Promise(function (r) { terminarDictado = r; });
      },
    },
    document: { createElement: elemento },
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'store.js', 'dictado.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  const escrito = [];
  const w = ctx.HPDictado.attachMic(ta, {
    id: 'marcador:1',
    onChange: function (texto) { escrito.push(texto); },
  });
  tarjeta.appendChild(w.el);
  return {
    ctx: ctx, ta: ta, tarjeta: tarjeta, bar: w.el, boton: w.boton, refinar: w.botonRefinar,
    pedidos: pedidos, logs: logs, escrito: escrito,
    /** Espera a que el botón sepa que en esta máquina se puede dictar. */
    listo: function () { return new Promise(function (r) { setTimeout(r, 0); }); },
    /** Lo que manda el motor al pasar de etapa (ver el sobre en engine-client.js). */
    avisar: function (sobre) { avisarProgreso(sobre); },
    /** Un refresco del texto en vivo: el motor manda el buffer ENTERO otra vez. */
    hablar: function (texto) { avisarProgreso({ dictado: { id: 'marcador:1', texto: texto } }); },
    /** El editor tecleando: pone el valor Y dispara el evento, como el navegador. */
    teclear: function (texto) { ta.escribir(texto); },
    /** Lo que dice la línea de estado de la barra. */
    linea: function () { return porClase(w.el, 'mic-state'); },
    /** El botón de volver atrás (oculto mientras `data-hidden` sea "true"). */
    volver: function () { return porClase(w.el, 'mic-undo'); },
    /** Deja correr la promesa del refinado. */
    esperar: function () { return new Promise(function (r) { setTimeout(r, 0); }); },
    /**
     * Un SEGUNDO campo con su barra, en el mismo módulo. Hace falta para probar
     * las guardas de "uno a la vez": son variables del módulo, y montar otro
     * contexto daría dos módulos que no se conocen entre sí.
     */
    otroCampo: function (idOtro) {
      const otra = campoConRegla();
      const w2 = ctx.HPDictado.attachMic(otra, { id: idOtro || 'marcador:2' });
      return {
        ta: otra, bar: w2.el, boton: w2.boton, refinar: w2.botonRefinar,
        teclear: function (t) { otra.escribir(t); },
        linea: function () { return porClase(w2.el, 'mic-state'); },
      };
    },
    /** El editor tocó ■: vuelve el crudo y arranca el refinado. */
    parar: function (crudo) {
      terminarDictado({ ok: true, crudo: crudo });
      return new Promise(function (r) { setTimeout(r, 0); });
    },
  };
}

/** Un dictado de `n` frases, para llenar el campo. */
function parrafo(n) {
  const frases = [];
  for (let i = 0; i < n; i++) frases.push('que el título ' + i + ' entre desde la izquierda con un fade');
  return frases.join(', ');
}

test('al arrancar el dictado, la tarjeta plegada se abre y el campo se trae a la vista', async function () {
  const m = montarDictado(600);
  await m.listo();
  eq(m.tarjeta.open, false, 'la tarjeta arranca plegada, como cualquier marcador que no se abrió');
  m.boton.click();
  ok(m.tarjeta.open, 'y se despliega sola: adentro de un <details> cerrado el editor dicta a ciegas');
  ok(m.ta.traido >= 1, 'el campo se sube al viewport');
  ok(m.bar.traido >= 1, 'y la barra del micrófono también, que es donde está el ■ para parar');
});

test('el botón pasa a ■ porque el motor dice la FASE, no por lo que diga el mensaje', async function () {
  const m = montarDictado(600);
  await m.listo();
  m.boton.click();
  eq(m.boton.textContent, '…', 'mientras prepara no se puede parar todavía');

  // El mensaje viene en otro idioma, o reescrito, o vacío: da igual. Lo que
  // manda es `fase`. Deducirlo del texto —lo que se hacía, con un regex sobre
  // la palabra "Escuchando"— dejaba el botón en "…" en cuanto alguien tocaba
  // esa frase, y con el botón en "…" el editor NO PUEDE frenar el micrófono.
  m.avisar({ fase: 'escuchando', msg: 'Listening on «MacBook Pro Microphone»…' });
  eq(m.boton.textContent, '■', 'con la fase alcanza');
  ok(!m.boton.disabled, 'y se puede apretar: es lo único que corta el micrófono');
});

test('el aviso de que se cortó por el tope llega al editor', function () {
  const m = montarDictado(600);
  return m.listo().then(function () {
    m.boton.click();
    m.avisar({ fase: 'escuchando', msg: 'Escuchando…' });
    m.avisar({ fase: 'cortando', msg: 'Corté a los 300 s: es el tope de un dictado. Mandá esto y seguí en otro.' });
    has(m.bar.buscar('mic-state').textContent, 'tope de un dictado',
      'un dictado que se corta solo y no dice por qué parece que se colgó');
  });
});

test('el campo crece en cada refresco y deja el FINAL a la vista', async function () {
  const m = montarDictado(600);
  await m.listo();
  m.boton.click();

  m.hablar('que el título entre desde la izquierda');
  const chico = altoPuesto(m.ta);
  ok(chico >= 44, 'el campo ya tiene un alto puesto: ' + chico);

  // Reescribir el valor deja el campo mirando el principio: es exactamente lo
  // que pasa en el navegador, y por eso hay que volver a bajarlo CADA vez.
  m.ta.scrollTop = 0;
  m.hablar(parrafo(4));
  const grande = altoPuesto(m.ta);
  ok(grande > chico, 'creció con lo dictado: ' + chico + ' → ' + grande + ' px');
  eq(m.ta.scrollTop, m.ta.scrollHeight,
    'y volvió al final: el motor retranscribe el buffer entero en cada refresco, ' +
    'así que "estar abajo" no se conserva solo, hay que rehacerlo');
});

test('con el panel en su alto mínimo el campo se planta en el tope y pone scroll', async function () {
  const m = montarDictado(400);
  await m.listo();
  m.boton.click();
  m.hablar(parrafo(60));
  eq(altoPuesto(m.ta), 180, 'el tope de un panel de 400 de alto');
  eq(m.ta.style.overflowY, 'auto', 'y de ahí en más se lee con scroll');
  m.hablar(parrafo(200));
  eq(altoPuesto(m.ta), 180, 'seguir hablando no lo agranda ni un píxel más');
  eq(m.ta.scrollTop, m.ta.scrollHeight, 'con el final siempre a la vista');
});

test('al terminar, el campo se achica a lo que dejó el refinador', async function () {
  const m = montarDictado(600);
  await m.listo();
  m.boton.click();
  m.hablar(parrafo(40));
  eq(altoPuesto(m.ta), 270, 'mientras se dictaba estaba en el tope');

  await m.parar(parrafo(40));
  await new Promise(function (r) { setTimeout(r, 0); }); // el refinado devuelve una sola frase
  ok(altoPuesto(m.ta) < 270, 'con el texto refinado el campo ya no necesita el tope: ' + altoPuesto(m.ta));
  eq(altoPuesto(m.ta), 44, 'una frase entra en el alto de siempre, y ahí vuelve');
  eq(m.ta.style.overflowY, '', 'y se le devuelve el scroll normal, para el que siga escribiendo a mano');
});

// ── 8. El gasto del dictado, contado aparte ──────────────────────────

/** El panel con localStorage de mentira, para el contador. */
function cargarContador() {
  const disco = {};
  const ctx = {
    console: console, JSON: JSON, Math: Math, Date: Date, Object: Object, Number: Number, String: String,
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

test('el refinado del dictado NO se mezcla con lo que gastan las animaciones', function () {
  const { HPStore } = cargarContador();
  HPStore.addSessionUsage({ inputTokens: 4, outputTokens: 9252, cacheCreationTokens: 49316, costUsd: 0.42 });
  HPStore.addDictadoUsage({ inputTokens: 180, outputTokens: 40, costUsd: 0.0004 });
  HPStore.addDictadoUsage({ inputTokens: 200, outputTokens: 55, costUsd: 0.0005 });

  const u = HPStore.getSessionUsage();
  eq(u.generations, 1, 'dos refinados no son dos generaciones');
  eq(u.inputTokens, 4, 'y sus tokens no entran en los de las animaciones: ' +
    'un refinado son cientos de tokens y una generación decenas de miles, ' +
    'mezclarlos hace que el promedio por generación deje de querer decir nada');
  eq(u.dictado.refinados, 2);
  eq(u.dictado.inputTokens, 380);
  eq(Number(u.dictado.costUsd.toFixed(4)), 0.0009);
});

test('el gasto del dictado se lee en la línea de la sesión, con su nombre', function () {
  const { HPUtil } = cargarContador();
  const v = HPUtil.sessionUsage({
    inputTokens: 900, outputTokens: 234168, cacheReadTokens: 1200000, cacheCreationTokens: 800000,
    costUsd: 15.369, costGenerations: 12, generations: 164,
    dictado: { inputTokens: 1800, outputTokens: 400, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.004, costRefinados: 9, refinados: 9 },
  });
  has(v.line, '164 generaciones');
  has(v.line, 'dictado: 9 refinados', 'identificado aparte, que es lo que se pidió');
  has(v.detail, 'no entra en los números de arriba',
    'sin esto, alguien suma mal y cree que sus animaciones salieron más caras');
});

test('un refinador local no informa costo, y eso se dice en vez de mostrar $0', function () {
  const { HPUtil } = cargarContador();
  const v = HPUtil.sessionUsage({
    generations: 0,
    dictado: { inputTokens: 300, outputTokens: 60, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, costRefinados: 0, refinados: 3 },
  });
  has(v.detail, 'sin costo informado');
  has(v.detail, 'refinador local', 'que es la razón de verdad: Ollama es gratis');
});

test('se puede dictar sin haber generado nada, y ese gasto no se pierde', function () {
  const { HPUtil } = cargarContador();
  const v = HPUtil.sessionUsage({
    generations: 0,
    dictado: { inputTokens: 300, outputTokens: 60, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.001, costRefinados: 1, refinados: 1 },
  });
  has(v.line, 'dictado: 1 refinado', 'decir "sin generaciones todavía" y esconderlo sería perderlo');
  ok(v.line.indexOf('sin generaciones') === -1);
});

test('sin dictar nada, el contador no habla del dictado', function () {
  const { HPUtil } = cargarContador();
  eq(HPUtil.sessionUsage({ generations: 0 }).line, 'sin generaciones todavía');
  const v = HPUtil.sessionUsage({
    inputTokens: 10, outputTokens: 20, cacheCreationTokens: 100,
    costUsd: 2, costGenerations: 4, generations: 4,
  });
  ok(v.line.indexOf('dictado') === -1, 'una fila vacía en el contador es ruido');
});

test('un contador guardado antes del dictado no revienta ni ensucia', function () {
  const panel = cargarContador();
  panel.localStorage.setItem('hyperpremiere::session-usage',
    JSON.stringify({ inputTokens: 75256, outputTokens: 2341682, costUsd: 15.369, generations: 164 }));
  const u = panel.HPStore.getSessionUsage();
  eq(u.dictado.refinados, 0, 'el bolsillo nuevo arranca en cero, no en NaN');
  panel.HPStore.addDictadoUsage({ inputTokens: 100, outputTokens: 20 });
  eq(panel.HPStore.getSessionUsage().dictado.refinados, 1);
  eq(panel.HPStore.getSessionUsage().generations, 164, 'y lo que estaba se conserva');
});

test('reiniciar el contador también limpia lo del dictado', function () {
  const { HPStore } = cargarContador();
  HPStore.addDictadoUsage({ inputTokens: 100, outputTokens: 20, costUsd: 0.01 });
  HPStore.resetSessionUsage();
  eq(HPStore.getSessionUsage().dictado.refinados, 0);
  eq(HPStore.getSessionUsage().dictado.costUsd, 0);
});

// ── 9. El ✨: refinar lo que se escribió a mano ──────────────────────
//
// El mismo refinado del dictado, sobre un texto que puso una persona. De ahí
// salen las dos reglas que no comparte con el micrófono:
//
//   1. si falla, el campo NO SE TOCA. En el dictado se puede pisar el campo con
//      el crudo, porque el crudo es lo que acababa de entrar; un párrafo que
//      alguien tecleó no se pisa con nada.
//   2. el "↩" devuelve su texto TAL CUAL, carácter por carácter: es lo que el
//      editor va a comparar contra lo que le devolvió el modelo, y "casi igual"
//      no sirve para comparar.
//
// Y una regla que sí es del panel entero: refinar no necesita micrófono, ni
// ffmpeg, ni Whisper, ni ser una Mac. Necesita un refinador. Por eso hay dos
// disponibilidades separadas y no una, y por eso el test que más importa de esta
// sección es el que monta el widget en una máquina DONDE NO SE PUEDE DICTAR.

// ── 9.1 Las decisiones puras ─────────────────────────────────────────

test('el ✨ contesta primero por lo que no depende del editor', function () {
  const D = cargarDictado();
  // El orden de las preguntas es el orden en que importan: si no hay refinador,
  // da igual qué haya escrito; si está refinando, da igual que además esté
  // dictando. Un orden distinto muestra el motivo equivocado en el tooltip, que
  // es lo único que el editor tiene para saber por qué el botón está gris.
  eq(D._estadoDeRefinar({ averiguando: true, puedeRefinar: true, texto: 'algo' }), 'averiguando');
  eq(D._estadoDeRefinar({ puedeRefinar: false, texto: 'algo' }), 'sin-refinador');
  eq(D._estadoDeRefinar({ puedeRefinar: true, texto: 'algo', refinando: true, dictando: true }), 'refinando');
  eq(D._estadoDeRefinar({ puedeRefinar: true, texto: 'algo', dictando: true }), 'dictando');
  eq(D._estadoDeRefinar({ puedeRefinar: true, texto: 'algo', ocupado: true }), 'ocupado');
  eq(D._estadoDeRefinar({ puedeRefinar: true, texto: '  \n  ' }), 'vacio',
    'espacios y renglones en blanco no son un pedido: refinar aire cuesta plata');
  eq(D._estadoDeRefinar({ puedeRefinar: true, texto: 'algo', yaRefinado: true }), 'ya-refinado');
  eq(D._estadoDeRefinar({ puedeRefinar: true, texto: 'algo' }), 'listo');
});

test('el ✨ apagado siempre dice qué lo apagó', function () {
  const D = cargarDictado();
  // Un botón gris sin explicación se aprieta tres veces y después se reporta
  // como roto. Y no se esconde en ningún estado: que la función exista y no esté
  // disponible es información; que no esté es un misterio.
  ['sin-refinador', 'dictando', 'ocupado', 'vacio', 'ya-refinado'].forEach(function (e) {
    const p = D._pintarRefinar(e, { refinador: 'Claude Haiku', sinRefinador: 'Ollama local: no está corriendo' });
    ok(p.apagado, e + ': tiene que estar apagado');
    eq(p.texto, '✨', e + ': el ícono se queda');
    ok(p.titulo.length > 40, e + ': el tooltip tiene que explicar, no rotular');
  });
});

test('el volver atrás se llama distinto según de dónde salió el texto', function () {
  const D = cargarDictado();
  eq(D._etiquetaDeVolver('escrito', false).texto, '↩ texto original',
    '"↩ dictado crudo" sobre un párrafo tecleado nombra un dictado que no hubo');
  eq(D._etiquetaDeVolver('dictado', false).texto, '↩ dictado crudo');
  eq(D._etiquetaDeVolver('escrito', true).texto, '↪ volver al refinado');
  eq(D._etiquetaDeVolver('dictado', true).texto, '↪ volver al refinado',
    'para ir al refinado da igual de dónde venía: es el mismo texto');
});

// ── 9.2 El ciclo, cableado ───────────────────────────────────────────

test('el ✨ refina lo que el editor escribió a mano', async function () {
  const m = montarDictado(600);
  await m.listo();
  const suyo = 'que el titulo vaya arriba a la izquierda y entre con un fade cortito';
  m.teclear(suyo);
  ok(!m.refinar.disabled, 'con texto escrito y nada pasando, se puede refinar');

  m.refinar.click();
  await m.esperar();
  eq(m.ta.value, REFINADO.texto, 'el refinado queda en el campo');
  eq(m.escrito[m.escrito.length - 1], REFINADO.texto,
    'y se avisa para que el que llamó lo persista, como cualquier cambio del campo');
  has(m.linea().textContent, 'Claude Haiku');
  has(m.linea().textContent, '0.9 s');
});

test('el refinado a mano se le pide al motor como ESCRITO, no como dictado', async function () {
  const m = montarDictado(600);
  await m.listo();
  const suyo = '  el fondo transparente y el logo un poco más chico  ';
  m.teclear(suyo);
  m.refinar.click();
  await m.esperar();

  eq(m.pedidos.length, 1, 'un solo pedido, y al mismo handler que el del dictado');
  eq(m.pedidos[0].origen, 'escrito',
    'decirle al modelo que un texto tecleado lo transcribió Whisper lo manda a arreglar ' +
    'una puntuación que ya estaba bien');
  eq(m.pedidos[0].crudo, suyo, 'y va entero, sin recortarle nada');
  ok(!m.pedidos[0].previo, 'no hay "lo que ya estaba": lo que ya estaba ES lo que se refina');
});

test('el ↩ devuelve lo escrito a mano carácter por carácter', async function () {
  const m = montarDictado(600);
  await m.listo();
  // Con espacios de más y un renglón en blanco a propósito: eso es lo que el
  // editor escribió, y si le vuelve recortado la vuelta atrás no sirve para lo
  // que se pensó (comparar su texto contra el del modelo).
  const suyo = '  que el título tape menos la cara,\n\n  y el logo un poco más chico  ';
  m.teclear(suyo);
  m.refinar.click();
  await m.esperar();
  eq(m.ta.value, REFINADO.texto);

  const volver = m.volver();
  eq(volver.getAttribute('data-hidden'), 'false', 'el volver atrás queda a la vista');
  eq(volver.textContent, '↩ texto original');
  volver.click();
  eq(m.ta.value, suyo, 'exactamente lo que había: los dos espacios del principio y el renglón vacío');
  eq(m.escrito[m.escrito.length - 1], suyo, 'y también se persiste así');
  eq(volver.textContent, '↪ volver al refinado');
  ok(!m.refinar.disabled, 'volver al original vuelve a habilitar el ✨');

  volver.click();
  eq(m.ta.value, REFINADO.texto);
  ok(m.refinar.disabled, 'y volver al refinado lo apaga otra vez, sin guardar ningún estado nuevo');
});

test('un refinado que falla no le toca una coma al texto del editor', async function () {
  // Con espacios de más adrede: "no se toca" es no se toca. La tentación de
  // copiar lo que hace el dictado —volver a escribir el crudo en el campo— pasa
  // el texto por `trim` y le come al editor su sangría.
  const suyo = '  que el título tape menos la cara,\n  y el logo quede un poco más chico  ';
  const m = montarDictado(600, {
    refinar: function () {
      return {
        ok: false, texto: suyo.trim(), crudo: suyo.trim(), refinador: 'Ollama local · llama3:latest', ms: 3400,
        aviso: 'No se pudo refinar lo que escribiste (tu texto quedó como estaba): el refinado quedó ' +
          'en 4 palabras contra 13 escritas: se comió parte del pedido (Ollama local · llama3:latest).',
      };
    },
  });
  await m.listo();
  m.teclear(suyo);
  m.refinar.click();
  await m.esperar();

  eq(m.ta.value, suyo, 'perderle un párrafo que escribió a mano es mucho peor que no refinarlo');
  eq(m.escrito.length, 0, 'ni se avisó un cambio que no hubo: nada que persistir');
  has(m.linea().textContent, 'se comió parte del pedido', 'y el motivo se lee');
  has(m.linea().className, 'is-warn', 'en ámbar y no en rojo: no hay nada que rehacer, el texto está');
  eq(m.volver().getAttribute('data-hidden'), 'true', 'no se ofrece volver a un original que nunca se pisó');
  ok(!m.refinar.disabled, 'y se puede reintentar');
});

test('si el motor se cae en el medio, el texto tampoco se toca', async function () {
  const suyo = 'el fondo tiene que quedar transparente';
  const m = montarDictado(600, {
    refinar: function () { return Promise.reject(new Error('el motor no contestó')); },
  });
  await m.listo();
  m.teclear(suyo);
  m.refinar.click();
  await m.esperar();
  eq(m.ta.value, suyo);
  has(m.linea().textContent, 'el motor no contestó');
  has(m.linea().textContent, 'quedó como estaba', 'decirlo es la mitad del arreglo');
});

// ── 9.3 Cuándo se puede apretar, y cuándo no ─────────────────────────

test('con el campo vacío el ✨ está apagado: no hay nada que refinar', async function () {
  const m = montarDictado(600);
  await m.listo();
  ok(m.refinar.disabled);
  has(m.refinar.title, 'no hay nada que refinar');
  m.teclear('   \n  ');
  ok(m.refinar.disabled, 'ni con espacios y saltos de línea');
  m.teclear('subí el título');
  ok(!m.refinar.disabled);
});

test('mientras dicta, el ✨ está apagado: el dictado ya refina solo al parar', async function () {
  const m = montarDictado(600);
  await m.listo();
  m.teclear('el título tapa la cara');
  ok(!m.refinar.disabled);

  m.boton.click();
  ok(m.refinar.disabled, 'apenas arranca el dictado, no');
  has(m.refinar.title, 'se refina solo', 'y dice por qué no hace falta');
  m.avisar({ fase: 'escuchando', msg: 'Escuchando…' });
  ok(m.refinar.disabled, 'y mientras escucha, tampoco');
});

test('después de refinar, el ✨ se apaga hasta que el texto cambie', async function () {
  const m = montarDictado(600);
  await m.listo();
  m.teclear('que el titulo vaya arriba y entre con un fade cortito');
  m.refinar.click();
  await m.esperar();

  ok(m.refinar.disabled, 'refinar lo refinado gasta tokens para empeorar el texto');
  has(m.refinar.title, 'Ya está refinado');
  has(m.refinar.title, 'cambiá algo', 'con la salida a la vista');

  m.teclear(REFINADO.texto + ' Y el logo abajo a la derecha.');
  ok(!m.refinar.disabled, 'en cuanto sigue escribiendo, se prende de nuevo');
});

test('mientras refina, el botón se apaga y no manda un segundo pedido', async function () {
  let soltar = null;
  const m = montarDictado(600, { refinar: function () { return new Promise(function (r) { soltar = r; }); } });
  await m.listo();
  m.teclear('el título tapa la cara, subilo un poco');
  m.refinar.click();

  eq(icono(m.refinar), '…', 'el refinado tarda de medio segundo a varios: hay que ver que trabaja');
  eq(palabra(m.refinar), 'Refinar',
    'y la palabra no se conjuga: un "Refinando" le cambiaría el ancho al botón en medio del ' +
    'refinado y le movería de lugar a la línea de estado, que es justo lo que hay que leer');
  ok(m.refinar.disabled);
  has(m.refinar.className, 'is-busy');
  has(m.linea().textContent, 'Refinando con Claude Haiku');
  // El 🎙 también queda tomado, pero NO se pone en "…": dos "…" idénticos al
  // lado del otro no dicen cuál de los dos está trabajando.
  eq(m.boton.textContent, '🎙');
  ok(m.boton.disabled);
  has(m.boton.title, 'Esperá', 'y dice que espere, no que está pasando algo con el micrófono');

  m.refinar.click(); // un doble clic, o un Enter sobre el botón recién apagado
  eq(m.pedidos.length, 1, 'no se paga dos veces el mismo refinado');

  soltar(REFINADO);
  await m.esperar();
  eq(m.ta.value, REFINADO.texto);
  eq(icono(m.refinar), '✨', 'y el botón vuelve');
});

test('en todo el panel se refina de a uno, como hay un solo micrófono', async function () {
  let soltar = null;
  const m = montarDictado(600, { refinar: function () { return new Promise(function (r) { soltar = r; }); } });
  await m.listo();
  const otro = m.otroCampo('marcador:2');
  await m.esperar();

  m.teclear('el título tapa la cara');
  m.refinar.click();
  eq(m.pedidos.length, 1);

  otro.teclear('el logo se pierde con el fondo claro');
  ok(otro.refinar.disabled, 'el segundo campo ni ofrece el botón mientras el primero refina');
  has(otro.refinar.title, 'otro campo');
  otro.refinar.click();
  eq(m.pedidos.length, 1, 'y apretándolo igual no arranca encima del primero');
  has(otro.linea().textContent, 'de a uno', 'con el motivo, que es lo que evita el "no hace nada"');

  soltar(REFINADO);
  await m.esperar();
  otro.teclear('el logo se pierde con el fondo claro');
  ok(!otro.refinar.disabled, 'cuando el primero termina, el segundo se puede refinar');
});

test('si el refinado del dictado falla, el ✨ queda disponible para reintentar', async function () {
  const crudo = 'que el titulo entre desde la izquierda con un fade cortito';
  const m = montarDictado(600, {
    refinar: function () {
      return { ok: false, texto: crudo, crudo: crudo, refinador: 'Ollama local', ms: 900,
        aviso: 'Quedó el dictado sin refinar: Ollama local falló (HTTP 500).' };
    },
  });
  await m.listo();
  m.boton.click();
  m.avisar({ fase: 'escuchando', msg: 'Escuchando…' });
  await m.parar(crudo);
  await m.esperar();

  eq(m.ta.value, crudo, 'el dictado crudo queda en el campo: sirve igual');
  ok(!m.refinar.disabled,
    'y el ✨ queda disponible. Si el crudo se guardara como "el refinado", el botón lo leería ' +
    'como "ya está refinado" y se apagaría justo cuando reintentar a mano es lo único que queda');
});

test('el que termina de refinar no le suelta la guarda al otro campo', async function () {
  // El camino angosto y real: se refina a mano en un campo y se arranca un
  // dictado en OTRO —que no se puede bloquear, porque no necesita el refinador
  // hasta que para—. Al parar, los dos están refinando; si la guarda fuera un id
  // solo, el primero que termine soltaría la del otro y un tercer campo podría
  // arrancar un refinado encima del que sigue andando.
  const soltar = {};
  const m = montarDictado(600, {
    refinar: function (arg) {
      return new Promise(function (r) { soltar[arg.origen === 'escrito' ? 'mano' : 'dictado'] = r; });
    },
  });
  await m.listo();
  const dictando = m.otroCampo('marcador:2');
  const tercero = m.otroCampo('marcador:3');
  await m.esperar();

  m.teclear('el título tapa la cara');
  m.refinar.click();

  // El segundo campo dicta y para: `avisar` y `parar` hablan con el último que
  // llamó al motor, o sea con éste.
  dictando.boton.click();
  m.avisar({ fase: 'escuchando', msg: 'Escuchando…' });
  await m.parar('que el logo quede abajo a la derecha');

  soltar.mano(REFINADO);
  await m.esperar();
  tercero.teclear('el fondo tiene que quedar transparente');
  ok(tercero.refinar.disabled,
    'el dictado del segundo campo sigue refinando: la guarda no la puede soltar el primero');

  soltar.dictado(REFINADO);
  await m.esperar();
  tercero.teclear('el fondo tiene que quedar transparente');
  ok(!tercero.refinar.disabled, 'cuando el que la tomó la suelta, sí');
});

test('el refinado del dictado toma la misma guarda que el ✨', async function () {
  // Los dos llaman al mismo refinador —el mismo CLI, o el mismo modelo local—,
  // así que dos encimados es el doble de espera para los dos.
  let soltar = null;
  const m = montarDictado(600, { refinar: function () { return new Promise(function (r) { soltar = r; }); } });
  await m.listo();
  const otro = m.otroCampo('marcador:2');
  await m.esperar();

  m.boton.click();
  m.avisar({ fase: 'escuchando', msg: 'Escuchando…' });
  await m.parar('que el título entre desde la izquierda');

  otro.teclear('el logo se pierde con el fondo claro');
  ok(otro.refinar.disabled, 'mientras el dictado refina, el ✨ del otro campo espera');
  soltar(REFINADO);
  await m.esperar();
  otro.teclear('el logo se pierde con el fondo claro');
  ok(!otro.refinar.disabled);
});

// ── 9.4 El punto de todo esto: refinar no necesita micrófono ─────────

test('donde NO se puede dictar pero SÍ refinar, el ✨ está y anda', async function () {
  // Windows, una Mac sin ffmpeg, cualquiera sin el Whisper de Apple Silicon.
  // Son justo las máquinas del editor que escribe todo a mano PORQUE no puede
  // dictar, o sea el que más necesita este botón. Colgarlo de `disponible` —la
  // respuesta de "¿se puede dictar?"— era esconderlo exactamente ahí.
  const m = montarDictado(600, {
    estado: {
      disponible: false,
      motivo: 'El dictado por voz todavía es solo para Mac. La captura usa avfoundation, que es el ' +
        'sistema de audio de macOS, y el equivalente en Windows (dshow) no está probado.',
      puedeRefinar: true,
      refinador: 'Ollama local · llama3.2:3b',
    },
  });
  await m.listo();

  ok(m.boton.disabled, 'el 🎙 está apagado');
  has(m.boton.title, 'solo para Mac', 'y dice por qué');

  ok(porClase(m.bar, 'mic-refine'),
    'y el ✨ está EN LA BARRA, al lado del 🎙: colgarlo de "¿se puede dictar?" lo escondía ' +
    'justo en las máquinas de quien escribe todo a mano');
  m.teclear('que el lower third entre desde el borde izquierdo y se vaya con un fade');
  ok(!m.refinar.disabled, 'y el ✨ está PRENDIDO: refinar es una llamada de texto a texto');
  has(m.refinar.title, 'No necesita micrófono ni Whisper');
  has(m.refinar.title, 'llama3.2:3b', 'con qué se va a refinar, que es lo primero que se pregunta');

  m.refinar.click();
  await m.esperar();
  eq(m.ta.value, REFINADO.texto,
    'y refina de verdad, que es lo único que le importa a quien escribe todo a mano');
});

test('sin ningún refinador el ✨ se ve, apagado y diciendo qué falta', async function () {
  // El motivo lo arma el motor y ya viene ordenado: primero el proveedor que el
  // editor eligió en ⚙ —el único que le conviene arreglar— y después el
  // respaldo (ver porQueNoHayRefinador en bridge/dictado-refinar.js).
  const m = montarDictado(600, {
    estado: {
      puedeRefinar: false, refinador: '',
      sinRefinador: 'El proveedor que elegiste (Cursor (Claude Sonnet)) no puede: el CLI de Cursor ' +
        'está pero sin sesión (corré `cursor-agent login`). Tampoco pudo el respaldo (Claude Haiku ' +
        '(API de Anthropic): no hay API key de Anthropic configurada en ⚙ · Ollama local: no está ' +
        'corriendo en esta máquina)',
    },
  });
  await m.listo();
  m.teclear('que el título entre con un fade');
  ok(m.refinar.disabled);
  eq(icono(m.refinar), '✨', 'esconderlo dejaría al editor sin saber que la función existe');
  eq(palabra(m.refinar), 'Refinar', 'y apagado sigue diciendo qué es: un botón gris sin nombre ni ' +
    'motivo es el que se reporta como roto');
  has(m.refinar.className, 'is-off');
  has(m.refinar.title, 'cursor-agent login', 'el próximo paso del proveedor que SÍ eligió');
  has(m.refinar.title, 'no está corriendo', 'y el resto del motivo, uno por uno');
  has(m.refinar.title, 'API key');
  ok(m.refinar.title.indexOf('se prende') === -1,
    'la lista de "instalá Claude o Ollama" se sacó: con la regla nueva refina el proveedor ' +
    'elegido, y mandar a instalar otra cosa a quien ya eligió uno es mandarlo a trabajar para nosotros');

  ok(!m.boton.disabled, 'dictar sigue andando: un dictado sin refinar deja el texto crudo, y sirve');
});

test('si el motor no contesta si se puede refinar, el ✨ no promete lo que no sabe', async function () {
  // Sin motor no hay refinado posible, así que acá "no sé" sí es "no hay": es al
  // revés que con el desplegable de micrófono del encabezado, donde no saber no
  // puede esconder un control que quizás funcione.
  const m = montarDictado(600, { estadoFalla: 'HPEngine no está definido' });
  await m.listo();
  m.teclear('que el título entre con un fade');
  ok(m.refinar.disabled, 'sin motor no hay a quién pedirle el refinado');
  has(m.refinar.title, 'no está disponible');
  ok(m.boton.disabled, 'y dictar tampoco');
});

// ── 9.5 El gasto y el log ────────────────────────────────────────────

test('el gasto del refinado a mano cae en el bolsillo del dictado, no en el de las animaciones', async function () {
  const m = montarDictado(600, {
    refinar: function () {
      return Object.assign({}, REFINADO, {
        usage: { inputTokens: 210, outputTokens: 48, cacheReadTokens: 12000, costUsd: 0.0005 },
      });
    },
  });
  await m.listo();
  m.teclear('que el titulo vaya arriba a la izquierda y entre con un fade cortito');
  m.refinar.click();
  await m.esperar();

  const u = m.ctx.HPStore.getSessionUsage();
  eq(u.dictado.refinados, 1, 'refinar a mano es el mismo tipo de gasto que refinar un dictado');
  eq(u.dictado.inputTokens, 210);
  eq(u.generations, 0, 'y no es una generación');
  eq(u.inputTokens, 0,
    'un refinado son cientos de tokens y una generación decenas de miles: mezclarlos hace que el ' +
    'promedio por generación deje de querer decir nada');
});

test('el log dice con qué se refinó y cuánto tardó', async function () {
  const m = montarDictado(600, {
    refinar: function () {
      return { ok: true, texto: 'El título arriba, con un fade corto.', refinador: 'Ollama local · llama3.2:3b', ms: 3480 };
    },
  });
  await m.listo();
  m.teclear('que el titulo vaya arriba con un fade');
  m.refinar.click();
  await m.esperar();

  const escrito = m.logs.map(function (l) { return l.msg; }).join('\n');
  has(escrito, 'Refinado a mano', 'distinguido del dictado: son dos caminos y se diagnostican distinto');
  has(escrito, 'llama3.2:3b', 'cuando alguien diga "el refinado me sale raro", es el primer dato');
  has(escrito, '3.48 s');
});

// ── 9.6 La palabra del botón ─────────────────────────────────────────
//
// El ✨ dice "Refinar" cuando el panel da el ancho, y queda en el emoji solo
// cuando está angosto. El 🎙 no lo necesita —un micrófono ya nombra la acción—;
// unas estrellitas no nombran ninguna, así que sin la palabra el botón se
// aprende apretándolo.
//
// Quién la esconde es CSS, no el widget, y eso es la mitad de lo que hay que
// fijar acá: el JS escribe la palabra UNA vez y no vuelve a tocarla, así que no
// hay un segundo lugar donde el botón pueda quedarse sin nombre.
//
// Lo que estos tests NO hacen: medir cajas. El DOM de mentira no tiene motor de
// layout, así que la regla se fija leyendo el CSS de verdad, igual que
// panel-botones-flex.test.js y panel-cartel-preparar-motor.test.js. La medición
// se rehizo en la maqueta (test/manual/panel-demo): 320 a 800 px de a 2 px, los
// cinco campos que llevan la barra, con la barra dictando y con la barra después
// de un refinado. Cero desborde y cero contenido fuera de caja: la palabra ENTRA
// hasta en el panel mínimo. Lo que cuesta es alto —46 px menos para la línea de
// estado, que envuelve— y por eso el corte está donde el panel ya se queda sin
// lugar para las palabras de adorno.

const CSS = fs.readFileSync(path.join(__dirname, '..', 'cep', 'css', 'style.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** El bloque `@media` que esconde la palabra, o null. */
function mediaDeLaPalabra() {
  return (CSS.match(/@media[^{]*\{[\s\S]*?\n\}/g) || [])
    .filter(function (b) { return /\.mic-refine-txt/.test(b); })[0] || null;
}

test('la palabra vive en su propio nodo, que es lo que deja esconderla con CSS', async function () {
  const m = montarDictado(600);
  await m.listo();
  eq(palabra(m.refinar), 'Refinar', 'el botón dice qué hace');
  eq(icono(m.refinar), '✨', 'con el emoji al lado, en otro nodo');
  // Si el emoji y la palabra compartieran el `textContent` del botón, esconder
  // una sola sería imposible: no hay selector para media frase.
  eq(String(m.refinar.textContent), '', 'y el botón no escribe texto suyo: son sus dos hijos');
});

test('la palabra sobrevive a todos los repintados del botón', async function () {
  // El repintado escribe el emoji, y ahí es donde un `refBtn.textContent = …`
  // de un tirón le borra el nombre al botón para siempre. No es teórico: es
  // exactamente lo que hacía este widget antes de que la palabra existiera.
  let soltar = null;
  const m = montarDictado(600, { refinar: function () { return new Promise(function (r) { soltar = r; }); } });
  await m.listo();
  eq(palabra(m.refinar), 'Refinar');
  m.teclear('que el título entre desde la izquierda');   // repinta por tecleo
  eq(palabra(m.refinar), 'Refinar');
  m.refinar.click();                                      // repinta a "…"
  eq(palabra(m.refinar), 'Refinar');
  soltar(REFINADO);
  await m.esperar();                                      // y de vuelta a ✨
  eq(palabra(m.refinar), 'Refinar');
  m.boton.click();                                        // y con un dictado andando
  eq(palabra(m.refinar), 'Refinar');
});

test('la decisión pura sigue siendo solo el emoji: la palabra no es un estado', function () {
  const D = cargarDictado();
  // Si `pintarRefinar` devolviera "✨ Refinar" o "Refinando", la palabra
  // volvería a estar en el `textContent` del botón y CSS no podría sacarla; y
  // de paso el botón cambiaría de ancho en medio del refinado.
  ['averiguando', 'sin-refinador', 'refinando', 'dictando', 'ocupado', 'vacio', 'ya-refinado', 'listo']
    .forEach(function (e) {
      const p = D._pintarRefinar(e, { refinador: 'Claude Haiku' });
      ok(p.texto === '✨' || p.texto === '…', e + ': el emoji y nada más, es «' + p.texto + '»');
      // Y con la palabra en el botón, el tooltip tiene que aportar algo más que
      // repetirla: qué va a hacer, con qué, o por qué está apagado. El único que
      // puede ser corto es el de "refinando", que no explica nada: informa que
      // está trabajando y con qué, que es lo mismo que muestra el "…".
      if (e !== 'refinando') ok(p.titulo.length > 45, e + ': el tooltip explica, no rotula: «' + p.titulo + '»');
    });
});

test('la palabra se esconde con una media query, no con JS', function () {
  const bloque = mediaDeLaPalabra();
  ok(bloque, 'tiene que haber un @media que esconda `.mic-refine-txt`');
  ok(/display:\s*none/.test(bloque), 'esconderla es sacarla del layout, no dejarla transparente');
  // `@container` sería lo natural (la barra vive adentro de cinco cajas de
  // anchos distintos) y NO se puede: el panel corre en CEF 99 y `@container`
  // llegó en Chrome 105. Sirve la media query porque en CEP el panel ES el
  // viewport, igual que en la que apila la barra de acciones.
  eq((CSS.match(/@container/g) || []).length, 0,
    'nada de @container: el panel es Chromium 99 y la regla no existiría');
  const js = fs.readFileSync(path.join(CEP, 'dictado.js'), 'utf8');
  eq((js.match(/mic-refine-txt[\s\S]{0,80}(display|hidden)/g) || []).length, 0,
    'el widget no decide cuándo se ve la palabra: si lo hiciera, habría dos reglas para lo mismo');
});

test('el corte deja la palabra puesta en el panel recién abierto', function () {
  // El número medido, y el que importa: el panel abre en 400 px y va de 320 a
  // 2200. Un corte de 400 o más deja sin palabra justo el ancho con el que
  // Premiere lo abre, que es donde el botón se tiene que poder leer; uno por
  // debajo de 320 es no tener corte.
  const tope = /max-width:\s*(\d+)px/.exec(mediaDeLaPalabra());
  ok(tope, 'el corte tiene que ser por ancho máximo: la palabra se va en el panel ANGOSTO');
  const px = Number(tope[1]);
  ok(px >= 320, 'por debajo del panel mínimo (320) la regla no se activa nunca: ' + px);
  ok(px < 400, 'el panel abre en 400 y ahí la palabra tiene que estar: ' + px);
});

test('la palabra no le agrega ni un blindaje ni un ancho al botón', function () {
  // La 1.4.50 sacó veinticuatro `flex` sueltos puestos por las dudas. Un
  // `min-width` o un `flex: none` acá sería el veinticinco, y encima sobre el
  // botón que acaba de cambiar de tamaño: lo que tiene que decidir su ancho es
  // su contenido, como el de todos los demás.
  const reglas = CSS.match(/\.mic-refine[^{]*\{[^}]*\}/g) || [];
  reglas.forEach(function (r) {
    ok(!/flex\s*:/.test(r), 'sin flex propio: ' + r.trim());
    ok(!/min-width\s*:/.test(r), 'sin ancho a mano: ' + r.trim());
    ok(!/\bwidth\s*:/.test(r), 'sin ancho a mano: ' + r.trim());
  });
});

test('el 🎙 se queda sin palabra, y eso es a propósito', async function () {
  // No es un olvido: un micrófono ya nombra la acción, y ponerle la palabra a
  // los dos le suma otros 46 px a la barra en el panel angosto sin agregar
  // nada. Lo que el 🎙 tiene para decir —qué micrófono va a abrir, o qué le
  // falta a esta máquina— no entra en una palabra y ya está en su tooltip.
  const m = montarDictado(600);
  await m.listo();
  eq(m.boton.children.length, 0, 'el 🎙 es su emoji y nada más');
  eq(String(m.boton.textContent), '🎙');
  ok(m.boton.title.length > 40, 'y lo suyo lo sigue diciendo el tooltip');
});

test('un refinado a mano que falla también queda escrito en el log', async function () {
  const m = montarDictado(600, {
    refinar: function () { return { ok: false, texto: 'x', refinador: 'Ollama local', ms: 900, aviso: 'el refinador contestó en vez de refinar (Ollama local).' }; },
  });
  await m.listo();
  m.teclear('que el titulo vaya arriba con un fade');
  m.refinar.click();
  await m.esperar();

  const malos = m.logs.filter(function (l) { return l.nivel === 'WARN'; });
  eq(malos.length, 1, 'un refinado que no salió es lo que hay que poder leer después en el ⬇ Log');
  has(malos[0].msg, 'contestó en vez de refinar');
});
