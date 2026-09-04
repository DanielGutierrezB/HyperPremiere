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
  // `main.js` es el que tiene los otros tres enganches (la tarjeta de cada
  // marcador, las Indicaciones generales y el prompt general), y montarlo pide
  // el panel entero: header, pestañas, config, host de Premiere. Levantar todo
  // eso para probar una guarda de una línea sería un test más frágil que lo que
  // protege. Así que acá se fija la regla sobre el texto: el ÚNICO lugar donde
  // se puede nombrar `HPDictado.attachMic` es adentro de `micOpcional`, que es
  // la función que pregunta antes.
  //
  // Es de segunda: comprueba la forma, no el comportamiento. Se deja igual
  // porque es lo que atrapa el error de verdad —volver a escribir
  // `caja.appendChild(HPDictado.attachMic(ta).el)` de un tirón— en el archivo
  // donde más caro sale.
  ['main.js', 'queue-view.js', 'corrections.js'].forEach(function (f) {
    const src = fs.readFileSync(path.join(CEP, f), 'utf8');
    const guarda = src.match(/\n  function micOpcional\(ta, opts\) \{\n[\s\S]*?\n  \}\n/);
    ok(guarda, f + ': tiene que tener la guarda micOpcional');
    has(guarda[0], 'typeof HPDictado === "undefined"',
      f + ': la guarda tiene que contemplar que la global NO EXISTA. Preguntar por ' +
      '`!HPDictado` a secas tira ReferenceError, que es el mismo agujero por otra puerta.');
    has(guarda[0], 'catch', f + ': y que attachMic reviente por dentro tampoco puede tumbar el campo');

    // Fuera de la guarda no se puede nombrar. Se le saca el cuerpo al texto y se
    // cuenta lo que queda: si quedó algo, alguien volvió a colgar el micrófono
    // de un tirón.
    const afuera = src.replace(guarda[0], '\n');
    eq((afuera.match(/HPDictado\.attachMic/g) || []).length, 0,
      f + ': colgar el micrófono sin preguntar es lo que dejó 44 tests en rojo y, en una ' +
      'máquina sin Whisper, al editor sin campo donde escribir.');
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

/**
 * Cuelga un micrófono de verdad de un campo con regla, adentro de un `<details>`
 * plegado (que es como está una tarjeta de marcador que no se abrió).
 */
function montarDictado(altoPanel) {
  const ta = campoConRegla();
  const tarjeta = elemento('details');
  tarjeta.open = false;
  tarjeta.appendChild(ta);

  let avisarProgreso = null;
  let terminarDictado = null;
  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, Object: Object, String: String,
    Number: Number, Array: Array, Promise: Promise, parseInt: parseInt,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: function () { return 0; }, clearInterval: function () {},
    innerHeight: altoPanel,
    HPLog: { log: function () {} },
    HPStore: { addDictadoUsage: function () {} },
    HPEngine: {
      call: function (metodo) {
        if (metodo === 'dictadoEstado') return Promise.resolve({ ok: true, disponible: true, refinador: 'Claude Haiku' });
        if (metodo === 'dictadoRefinar') {
          return Promise.resolve({ ok: true, texto: 'Título desde la izquierda, con fade.', refinador: 'Claude Haiku', ms: 900 });
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
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(CEP, 'dictado.js'), 'utf8'), ctx, { filename: 'dictado.js' });
  const w = ctx.HPDictado.attachMic(ta, { id: 'marcador:1' });
  tarjeta.appendChild(w.el);
  return {
    ta: ta, tarjeta: tarjeta, bar: w.el, boton: w.boton,
    /** Espera a que el botón sepa que en esta máquina se puede dictar. */
    listo: function () { return new Promise(function (r) { setTimeout(r, 0); }); },
    /** Lo que manda el motor al pasar de etapa (ver el sobre en engine-client.js). */
    avisar: function (sobre) { avisarProgreso(sobre); },
    /** Un refresco del texto en vivo: el motor manda el buffer ENTERO otra vez. */
    hablar: function (texto) { avisarProgreso({ dictado: { id: 'marcador:1', texto: texto } }); },
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
