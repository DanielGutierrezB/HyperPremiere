'use strict';

// LAS TRES PESTAÑAS SON LA MISMA LISTA, y ahora se dibujan igual.
//
// Lo que pidió el editor, textual: "Tenemos 3 pestañas, «Marcadores», «Cola» y
// «Corrections». Las 3 tienen como el mismo tipo de información pero
// interacciones distintas. La que más me gusta visualmente es la de
// «Marcadores»; hagamos que sea la misma estética. Solo que se adapte a esas
// otras informaciones de cada una."
//
// Las tres son listas de lo mismo —un marcador con su estado y sus acciones—
// dibujadas hasta la 1.6.0 con tres gramáticas distintas. Y la peor parte no era
// que fueran distintas: era que la MISMA barra de la izquierda quería decir dos
// cosas según la pestaña (en Marcadores, «esta ficha está abierta»; en la Cola,
// el ESTADO del trabajo). Este archivo fija las tres cosas que pasaron a ser una
// promesa:
//
//   1. LA GUARDA DICE EL ESTADO, en las tres. Un canal, un significado.
//   2. EL ESTADO NO ES SÓLO COLOR: al lado de la guarda va la palabra, y la
//      escribe un solo lugar para las dos pestañas que muestran el mismo trabajo.
//   3. EL CUERPO ES UNO: las tres piden lo mismo con el mismo `HPPromptCard`.
//
// Y la cuarta, que es la que no se puede perder: la Cola se tiene que poder
// BARRER con la vista. Eso es su función principal y lo que la fila nueva no
// puede costar.
//
// Lo que este archivo NO hace es medir cajas: el DOM de mentira del repo no
// tiene motor de layout. El desborde y los solapes se miden con la maqueta
// (`test/manual/panel-demo/medir-botones.js`), el contraste real con
// `temas/estudiado/auditar.js` y lo que hacen los chips de mención en un navegador
// de verdad con `medir-chips.js`.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const RAIZ = path.join(__dirname, '..');
const CEP = path.join(RAIZ, 'cep', 'js');
const HTML = fs.readFileSync(path.join(RAIZ, 'cep', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(RAIZ, 'cep', 'css', 'style.css'), 'utf8');
const MAIN = fs.readFileSync(path.join(CEP, 'main.js'), 'utf8');
const COLA = fs.readFileSync(path.join(CEP, 'queue-view.js'), 'utf8');
const CORR = fs.readFileSync(path.join(CEP, 'corrections.js'), 'utf8');
const CARD = fs.readFileSync(path.join(CEP, 'prompt-card.js'), 'utf8');
const VISTA = fs.readFileSync(path.join(CEP, 'general-view.js'), 'utf8');

// ── Leer el CSS ───────────────────────────────────────────────────────

function reglas(css) {
  const limpio = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const abiertos = [];
  let selDesde = 0;
  for (let i = 0; i < limpio.length; i++) {
    if (limpio[i] === '{') {
      abiertos.push({ selector: limpio.slice(selDesde, i).trim(), desde: i + 1, prof: abiertos.length });
      selDesde = i + 1;
    } else if (limpio[i] === '}') {
      const b = abiertos.pop();
      if (b) {
        const cuerpo = limpio.slice(b.desde, i);
        if (cuerpo.indexOf('{') === -1) {
          out.push({ selector: b.selector.replace(/\s+/g, ' '), cuerpo: cuerpo, dentroDeMedia: b.prof > 0 });
        }
      }
      selDesde = i + 1;
    }
  }
  return out;
}
const REGLAS = reglas(CSS);

function declaraciones(selector) {
  const d = {};
  REGLAS.filter((r) => r.selector === selector && !r.dentroDeMedia).forEach((r) => {
    r.cuerpo.split(';').forEach((par) => {
      const i = par.indexOf(':');
      if (i !== -1) d[par.slice(0, i).trim()] = par.slice(i + 1).trim();
    });
  });
  return d;
}

// ── El DOM de mentira, para dibujar la Cola de verdad ─────────────────

function elemento(tag) {
  const el = {
    tagName: tag, children: [], listeners: {}, style: {}, className: '',
    textContent: '', value: '', title: '', type: '', rows: 0, checked: false, open: false,
    childNodes: [],
    // El padre se anota al colgar: sin él no se puede SUBIR, y sin subir no hay
    // burbujeo ni `<details>` que se despliegue. Ver `click`.
    appendChild: function (h) { if (h) h.padre = this; this.children.push(h); this.childNodes.push(h); return h; },
    setAttribute: function (k, v) { this[k] = v; },
    getAttribute: function (k) { return this[k]; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    emitir: function (ev) { (this.listeners[ev] || []).forEach(function (f) { f({ stopPropagation: function () {}, preventDefault: function () {} }); }); },
    /**
     * Un clic como el del navegador: BURBUJEA y, si nadie lo frena, despliega el
     * `<details>` cuyo `<summary>` se apretó.
     *
     * Las dos mitades hacen falta y las dos se aprendieron de un bug real. Un
     * clic que no sube no puede probar que apretar el hueco del encabezado abre
     * la tarjeta —el manejador está en un hijo—, y un clic que sube pero no
     * despliega no puede probar lo contrario: que ir al timeline NO la abra. Con
     * el `click` viejo, que sólo llamaba a los manejadores del propio elemento,
     * las dos cosas pasaban por vacío: la mutación que sacaba el
     * `preventDefault` sobrevivía porque no había nada que se abriera.
     */
    click: function () {
      let frenado = false;
      let corta = false;
      const ev = {
        target: this,
        preventDefault: function () { frenado = true; },
        stopPropagation: function () { corta = true; },
      };
      let n = this;
      while (n) {
        (n.listeners.click || []).forEach(function (f) { f(ev); });
        if (corta) break;
        n = n.padre;
      }
      if (frenado) return;
      // El despliegue nativo: el `<summary>` que se apretó (él mismo o un
      // ancestro) abre o cierra a su `<details>`, y ése avisa con `toggle`.
      let s = this;
      while (s && s.tagName !== 'summary') s = s.padre;
      const det = s && s.padre;
      if (det && det.tagName === 'details') {
        det.open = !det.open;
        (det.listeners.toggle || []).forEach(function (f) { f({}); });
      }
    },
    change: function () { (this.listeners.change || []).forEach(function (f) { f({}); }); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    buscar: function (clase) {
      for (const h of this.children) {
        if (String(h.className || '').split(' ').indexOf(clase) !== -1) return h;
        const hit = h.buscar && h.buscar(clase);
        if (hit) return hit;
      }
      return null;
    },
    buscarTodos: function (clase) {
      let out = [];
      for (const h of this.children) {
        if (String(h.className || '').split(' ').indexOf(clase) !== -1) out.push(h);
        if (h.buscarTodos) out = out.concat(h.buscarTodos(clase));
      }
      return out;
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
    add: function (c) {
      if (String(el.className || '').split(' ').indexOf(c) === -1) {
        el.className = (el.className ? el.className + ' ' : '') + c;
      }
    },
    remove: function () {},
  };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return ''; },
    set: function () { el.children.length = 0; el.childNodes.length = 0; },
  });
  return el;
}

/** Dibuja la Cola con `jobs` y devuelve el panel. */
function dibujarCola(jobs) {
  const nodos = {
    'queue-panel': elemento('div'),
    'view-queue': elemento('div'),
    'tab-queue-count': elemento('span'),
  };
  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Object: Object, Array: Array, isNaN: isNaN, parseInt: parseInt, Set: Set,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: function () { return 0; }, clearInterval: function () {},
    localStorage: { getItem: function () { return null; }, setItem: function () {} },
    HPLog: { log: function () {} },
    HPWidgets: { confirmOverlay: function () {} },
    HPEngine: { call: function () { return Promise.resolve({ ok: true }); } },
    HPStore: {
      getContext: function () { return { projectPath: '/p/Clases.prproj', sequenceName: 'Clase 23' }; },
      getSessionUsage: function () { return null; },
      // La entrada completa de un uso, con su caché: es la cuenta que hace el
      // contador de sesión y la que el encabezado muestra como plata gastada.
      totalInput: function (u) {
        return (u.totalInputTokens || 0) ||
          ((u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheCreationTokens || 0));
      },
    },
    HPConfigUI: { isLocalProvider: function () { return false; } },
    HPStills: {
      fbInit: function () {}, fbClear: function () {}, fbCollect: function () { return []; },
      crearTira: function () {
        const el = elemento('div'); el.className = 'hp-tira-propia';
        return { el: el, estado: elemento('div'), refrescar: function () {}, cuantasImagenes: function () { return 0; } };
      },
      inventario: function () { return []; },
      capturar: function () {}, ingerir: function () {},
    },
    HPQueue: {
      jobs: function () { return jobs; },
      isPending: function (s) { return s === 'queued' || s === 'modeling' || s === 'ready' || s === 'running'; },
      isActive: function (s) { return s === 'modeling' || s === 'ready' || s === 'running'; },
      isPaused: function () { return false; },
      hasActive: function () { return false; },
      hasQueued: function () { return false; },
      // Igual que la de verdad: terminado y con el clip afuera del timeline.
      needsPlacing: function (j) {
        return j.status === 'done' && (!!j.notPlaced || /NO lo coloqu/.test(String(j.msg || '')));
      },
      moveJob: function () {}, remove: function () {}, retry: function () {},
      reactivate: function () {}, cancelJob: function () {}, placeAgain: function () {},
      regenerate: function () {}, regenerateFresh: function () {},
      payloadForEstimate: function (j) { return Promise.resolve(j.payload || {}); },
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
  for (const f of ['util.js', 'iconos.js', 'menciones.js', 'campo.js', 'prompt-card.js', 'queue-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  ctx.HPQueueView.init({
    goToJobMarker: function () {}, showJobInTimeline: function () {},
    currentSequence: function () { return 'Clase 23'; },
    setOutput: function () {},
    preparingSequence: function () { return null; },
    sequenceContext: function () { return null; },
  });
  ctx.HPQueueView.render(jobs);
  return { ctx: ctx, panel: nodos['queue-panel'] };
}

function job(extra) {
  return Object.assign({
    id: 'j1', status: 'queued', kind: 'generate', label: 'Marcador 1 · Intro',
    seqName: 'Clase 23', projectPath: '/p/Clases.prproj', markerKey: 'Marcador 1',
    markerStart: 12.4, markerDuration: 6.5, msg: 'En cola…',
  }, extra);
}

/** Los siete estados de un trabajo, como los ve la Cola de verdad. */
function losSiete() {
  return [
    job({ id: 'a', status: 'queued', msg: 'En cola…' }),
    job({ id: 'b', status: 'ready', msg: 'En espera de render… · IA 1m 20s' }),
    job({ id: 'c', status: 'modeling', msg: 'Diseñando la animación con claude-sonnet-5…', pct: 34, startedAt: Date.now() }),
    job({ id: 'd', status: 'running', msg: 'Renderizando… 412 de 604 fotogramas', pct: 71, startedAt: Date.now() }),
    job({ id: 'e', status: 'done', version: 3, msg: '✓ Listo y colocado (v3) · 4m 12s' }),
    job({ id: 'f', status: 'done', version: 1, notPlaced: true, msg: '⚠ Render OK pero NO lo coloqué (no se tocó tu timeline)' }),
    job({ id: 'g', status: 'error', msg: 'Error: la composición volvió sin duración' }),
    job({ id: 'h', status: 'waiting', msg: '⏳ Sin tokens / límite alcanzado' }),
  ];
}

// ── 1. La guarda izquierda dice EL ESTADO, en las tres ────────────────

test('hay UNA tarjeta y UNA guarda, y la guarda es la del estado', function () {
  // El corazón de la decisión. La guarda de `.hp-tarjeta` es el borde izquierdo y
  // lo único que la pinta son las cinco clases de estado: si alguna otra regla lo
  // tocara, la barra volvería a querer decir dos cosas.
  const tarjeta = declaraciones('.hp-tarjeta');
  eq(tarjeta['border-left'], '3px solid var(--hairline)', 'la guarda, neutra por defecto');
  const pintan = REGLAS.filter(function (r) {
    return !r.dentroDeMedia && /border-left-color/.test(r.cuerpo);
  }).map(function (r) { return r.selector; });
  pintan.forEach(function (sel) {
    ok(/^\.hp-tarjeta\.es-/.test(sel) || /\.transcript-slice/.test(sel),
      'sólo las clases de estado pintan la guarda, y ' + sel + ' no es una');
  });
  // Y son cinco: tres tonos semánticos más dos neutros.
  ['es-quieto', 'es-listo', 'es-atencion', 'es-falla', 'es-andando'].forEach(function (c) {
    ok(declaraciones('.hp-tarjeta.' + c)['border-left-color'], c + ' pinta la guarda');
  });
});

test('la tarjeta abierta ya no se marca con la guarda, y se marca igual', function () {
  // Lo que se pierde con la decisión, y con qué se paga: la ficha de marcador
  // abierta usaba la guarda. Ahora usa el RECUADRO, con el mismo token y el mismo
  // 3.37:1 que pide 1.4.11 — más el chevron girado y el cuerpo desplegado, que
  // son forma y no color.
  const abierta = declaraciones('.hp-tarjeta[open], .hp-tarjeta.is-selected');
  eq(abierta['border-left-color'], undefined, 'no toca la guarda: ésa es del estado');
  ['border-top-color', 'border-right-color', 'border-bottom-color'].forEach(function (p) {
    eq(abierta[p], 'var(--border-field)', p + ' se enciende a 3.37:1');
  });
  has(CSS, '.hp-tarjeta[open] > .hp-sumario::before { transform: rotate(90deg); }',
    'y el chevron gira, que es el canal que no es color');
});

test('las tres pestañas dibujan la misma tarjeta y el mismo encabezado', function () {
  has(MAIN, 'card.className = "marker-card hp-tarjeta"', 'la ficha de un marcador');
  has(MAIN, 'summary.className = "marker-summary hp-sumario"');
  has(COLA, 'row.className = "queue-job hp-tarjeta " + estado.clase', 'la fila de un trabajo');
  has(COLA, 'line.className = "qj-line hp-sumario"');
  has(CORR, 'row.className = "corr-row hp-tarjeta "', 'la fila de una corrección');
  has(CORR, 'line.className = "corr-line hp-sumario"');
  // Y las tres listas se separan igual.
  has(HTML, 'class="markers hp-lista"');
  has(HTML, 'class="corr-list hp-lista"');
  has(COLA, 'lista.className = "hp-lista queue-lista"');
});

test('Corrections usa la guarda para lo que YA usaba: lo que hay que atender', function () {
  // Esta pestaña ya tenía una guarda ámbar de 3 px para «no sé dónde iba este
  // recurso», o sea que ya la usaba como estado. Se extiende, no se invierte: una
  // fila con su tramo y su contexto guardado está quieta, y una a la que le falta
  // algo pide atención.
  has(CORR, '(m.start == null ? "es-atencion is-unknown" : (m.prompts ? "es-quieto" : "es-atencion"))');
  const viejas = REGLAS.filter(function (r) { return /^\.corr-row\.is-unknown$/.test(r.selector); });
  eq(viejas.length, 0, 'y la regla vieja que la dibujaba por su cuenta se fue');
});

// ── 2. El estado NO es sólo color ─────────────────────────────────────

/**
 * HPUtil y HPQueue de verdad, en el mismo contexto.
 *
 * Los dos juntos y no HPUtil solo, porque desde la 1.6.0 `estadoDeTrabajo` le
 * pregunta a HPQueue si el estado está activo o pendiente: HPQueue es la que se
 * declara dueña única del vocabulario de estados, y lo que esto tiene que poder
 * comprobar es justamente que la respuesta sale de ahí y no de una segunda lista.
 * Con un HPQueue de mentira el test pasaría igual con las dos listas separadas,
 * que es el bug.
 */
function vocabulario() {
  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Object: Object, Array: Array, isNaN: isNaN, parseInt: parseInt, Promise: Promise,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    localStorage: { getItem: function () { return null; }, setItem: function () {} },
    HPLog: { log: function () {} },
    HPStore: { getContext: function () { return { projectPath: '', sequenceName: '' }; } },
    HPEngine: { call: function () { return Promise.resolve({ ok: true }); } },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  ['util.js', 'queue.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  });
  return ctx;
}

test('el estado se dice en palabras, y las escribe un solo lugar', function () {
  const U = vocabulario().HPUtil;
  const casos = [
    ['queued', false, 'es-quieto', 'en cola'],
    ['ready', false, 'es-quieto', 'por rendir'],
    ['modeling', false, 'es-andando', 'diseñando'],
    ['running', false, 'es-andando', 'rindiendo'],
    ['done', false, 'es-listo', 'listo'],
    ['done', true, 'es-atencion', 'sin colocar'],
    ['error', false, 'es-falla', 'falló'],
    ['waiting', false, 'es-atencion', 'sin cupo'],
  ];
  const palabras = {};
  casos.forEach(function (c) {
    const e = U.estadoDeTrabajo(c[0], c[1]);
    eq(e.clase, c[2], c[0] + (c[1] ? ' sin colocar' : '') + ': la clase de la guarda');
    eq(e.palabra, c[3], c[0] + ': la palabra');
    ok(e.titulo && e.titulo.length > 20, c[0] + ': y un tooltip que lo explica');
    ok(!palabras[e.palabra], 'ninguna palabra se usa para dos estados: ' + e.palabra);
    palabras[e.palabra] = true;
  });
  // Ocho situaciones, ocho palabras, CINCO colores: lo que cambia de color es qué
  // pide el estado, no en qué etapa del pipeline está.
  eq(Object.keys(palabras).length, 8);
  eq(new Set(casos.map(function (c) { return c[2]; })).size, 5);
});

test('las preguntas que dirigen el DIBUJO salen del mismo lugar que la palabra', function () {
  // La primera versión de `estadoDeTrabajo` centralizó la palabra y el color y
  // dejó afuera lo que dirige el dibujo: ¿la fila se abre?, ¿el detalle va arriba
  // o abajo?, ¿el reloj cuenta o dice cuánto tardó?, ¿la plata va en el
  // encabezado?, ¿los botones de la ficha quedan apagados? Eran veintiséis
  // interrogaciones sueltas en literales de string, con `status === "done"`
  // preguntado seis veces bajo cuatro nombres distintos.
  //
  // Lo que este test cuida no es el tamaño de la función: es que las dos mitades
  // del vocabulario no puedan separarse. Ya se habían separado —la ficha del
  // marcador se escribía su propia lista de estados activos— y separarse no rompe
  // nada a la vista: las dos pestañas siguen dibujando, cada una con su lista.
  const ctx = vocabulario();
  const U = ctx.HPUtil;
  const Q = ctx.HPQueue;
  ['queued', 'modeling', 'ready', 'running', 'done', 'error', 'waiting'].forEach(function (s) {
    const e = U.estadoDeTrabajo(s, false);
    eq(e.activo, Q.isActive(s), s + ': `activo` es el de HPQueue y no otro');
    eq(e.pendiente, Q.isPending(s), s + ': `pendiente` es el de HPQueue y no otro');
    eq(e.terminado, s === 'done', s + ': `terminado`');
  });
  // Y un trabajo terminado sin colocar sigue estando TERMINADO: lo que le falta es
  // el clip en el timeline, no la generación. Si `terminado` dijera que no, el
  // detalle de esa fila volvería al encabezado y la plata se dibujaría dos veces.
  const sinColocar = U.estadoDeTrabajo('done', true);
  eq(sinColocar.terminado, true, 'terminado sin colocar sigue siendo terminado');
  eq(sinColocar.palabra, 'sin colocar', 'y se dice distinto, que es lo que cambia');
  // Que las respuestas coincidan no alcanza, y esto lo pagó una mutación: una
  // segunda lista escrita con los estados de HOY contesta igual que la de HPQueue
  // y el panel se dibuja idéntico. Lo que queda es una copia esperando que alguien
  // agregue un estado al pipeline y se olvide de este archivo. Así que además se
  // mira de DÓNDE sale la respuesta.
  const util = fs.readFileSync(path.join(CEP, 'util.js'), 'utf8');
  has(util, 'e.activo = HPQueue.isActive(status);', 'la respuesta sale de HPQueue');
  has(util, 'e.pendiente = HPQueue.isPending(status);', 'las dos');
  ok(!/status === "modeling"[\s\S]{0,60}status === "ready"/.test(util),
    'y util.js no se escribe la lista de estados activos por su cuenta');
  // Las dos vistas leen el campo y ninguna se arma su propia lista.
  [['la Cola', COLA], ['la ficha del marcador', MAIN]].forEach(function (par) {
    ok(par[1].indexOf('HPQueue.isActive(') === -1, par[0] + ' no le pregunta aparte a HPQueue');
    ok(!/status === "modeling"[\s\S]{0,40}status === "ready"/.test(par[1]),
      par[0] + ' no se escribe la lista de estados activos a mano');
  });
  has(COLA, 'var puedeAbrir = estado.terminado &&', 'la Cola calcula «se abre» una vez');
  ok(COLA.indexOf('alCuerpo') === -1, 'y «el detalle va al cuerpo» dejó de ser una variable aparte');
  has(MAIN, 'if (est.pendiente) {', 'y la ficha del marcador lee el campo');
});

test('un trabajo terminado SIN COLOCAR ya no se pinta de «todo bien»', function () {
  // Estaba escrito en el CSS como una limitación: «un trabajo terminado puede
  // haber terminado BIEN o terminado SIN COLOCAR, y las dos filas llevan la misma
  // clase […] el CSS no puede distinguirlas». Ahora sí: la distinción la hace
  // `needsPlacing`, que es la misma que decide si ofrecer «Colocar».
  const d = dibujarCola([job({ status: 'done', notPlaced: true, msg: '⚠ Render OK pero NO lo coloqué' })]);
  const fila = d.panel.buscar('queue-job');
  has(fila.className, 'es-atencion', 'la guarda en ámbar, no en verde');
  eq(fila.buscar('hp-estado').textContent, 'sin colocar');
  ok(d.panel.porTexto('Colocar'), 'y el botón que lo arregla sigue ahí');
});

test('el título vuelve a ser el nombre y nada más', function () {
  // Llevaba pegado adelante un glifo de estado (✓ ✎ ▶ ◔ • ⏳ ⚠) además del color
  // del propio título. O sea el estado dicho dos veces justo en el único lugar
  // donde estorba: el nombre es lo que se lee para saber DE QUÉ trabajo es la
  // fila.
  const d = dibujarCola(losSiete());
  // Con `texto()` y no con `textContent`: desde que el nombre lleva adentro el
  // `<span>` de las palabras (ver más abajo), el `textContent` de la caja está
  // vacío y este test pasaba por vacío en vez de por correcto.
  d.panel.buscarTodos('qj-title').forEach(function (t) {
    ok(/^Marcador 1 · Intro/.test(t.texto().trim()), 'el título arranca con el nombre: ' + t.texto());
  });
  // Y el CSS ya no tiene siete reglas para devolverle el color al título.
  const porEstado = REGLAS.filter(function (r) {
    return !r.dentroDeMedia && /\.is-(done|error|running|modeling|queued|ready|waiting) \.qj-title/.test(r.selector);
  });
  eq(porEstado.length, 0, 'sin las siete contra-reglas de antes');
});

test('cada estado trae su palabra en la pastilla, y la pastilla es información', function () {
  const d = dibujarCola(losSiete());
  const palabras = d.panel.buscarTodos('hp-estado').map(function (p) { return p.textContent; });
  eq(palabras.join(' | '),
    'en cola | por rendir | diseñando | rindiendo | listo | sin colocar | falló | sin cupo',
    'las ocho, en el orden de la lista');
  d.panel.buscarTodos('hp-estado').forEach(function (p) {
    ok(p.title && p.title.length > 20, 'con su tooltip: ' + p.textContent);
  });
  // Forma de pastilla = información, no acción. Es lo que la separa de la familia
  // "rehacer", que comparte el ámbar y tiene forma de botón.
  eq(declaraciones('.hp-estado')['border-radius'], '999px');
});

// ── 3. La fila se sigue pudiendo BARRER ───────────────────────────────

test('la columna del estado queda alineada, también en las filas que no se abren', function () {
  // Es la mitad de por qué esta pestaña funciona: Material, «leading elements
  // should always be aligned». Sólo los trabajos terminados tienen ronda de
  // feedback, así que sólo ellos son `<details>`; si el chevron ocupara lugar
  // nada más que en ésos, el nombre de las otras filas arrancaría 13 px más a la
  // izquierda y la columna dejaría de estar alineada.
  const d = dibujarCola(losSiete());
  const filas = d.panel.buscarTodos('queue-job');
  eq(filas.length, 8);
  const abren = filas.filter(function (f) { return f.tagName === 'details'; });
  eq(abren.length, 2, 'sólo los dos terminados, que son los que pueden recibir feedback');
  filas.forEach(function (f) {
    const cab = f.buscar('hp-sumario');
    const puedeAbrir = f.tagName === 'details';
    eq(String(cab.className).indexOf('sin-abrir') !== -1, !puedeAbrir,
      'la columna del chevron se reserva igual');
  });
  eq(declaraciones('.hp-sumario::before').width, '9px', 'y tiene ancho fijo');
  eq(declaraciones('.hp-sumario.sin-abrir::before').content, '""', 'vacío, pero ocupando');
});

test('el mensaje que no dice más que la pastilla no se dibuja', function () {
  // «En cola…» al lado de una pastilla que dice «en cola» son 19 px por fila para
  // repetir la palabra que está tres centímetros a la izquierda, y en una cola de
  // diez trabajos en espera eso es un tercio de la pantalla.
  const d = dibujarCola([
    job({ id: 'a', status: 'queued', msg: 'En cola…' }),
    job({ id: 'b', status: 'queued', msg: 'Reencolado, esperando turno…' }),
  ]);
  const filas = d.panel.buscarTodos('queue-job');
  eq(filas[0].buscar('qj-msg'), null, 'el mensaje por defecto no se dibuja');
  ok(filas[1].buscar('qj-msg'), 'y el que sí dice algo, sí');
  has(filas[1].buscar('qj-msg').textContent, 'Reencolado');
});

test('el PROGRESO se lee con la fila plegada; el DETALLE del terminado, no', function () {
  // Un `<details>` esconde todo lo que va después de su resumen, así que dónde
  // vive cada cosa decide qué se puede leer sin abrir. Y la respuesta no es la
  // misma para un trabajo que avanza que para uno que ya terminó:
  //
  //  · El que AVANZA tiene que decir en qué anda sin que nadie lo abra, o la cola
  //    parece colgada. Mensaje, barra, actividad y cronómetro: al encabezado.
  //  · El que TERMINÓ no: su detalle sólo se lee cuando uno va a mirar ESE
  //    recurso. Lo pidió el editor —"los que ya están listos, que mejor esté
  //    replegado como los que están en cola; si despliego, ahí sí que me salga la
  //    información completa"— y el motivo es que la fila terminada medía 53 px
  //    contra 31, o sea que lo ya resuelto se comía la pantalla de lo que falta.
  const d = dibujarCola([job({
    status: 'done', version: 3, _totalMs: 252000, _modelMs: 185000, _renderMs: 67000,
    msg: '✓ Listo y colocado (v3) · 128.412↑ 6.104↓ · 4m 12s (IA 3m 05s · render 1m 07s)'
  })]);
  const fila = d.panel.buscar('queue-job');
  eq(fila.tagName, 'details', 'la fila se pliega');
  const cab = fila.buscar('hp-sumario');

  eq(cab.buscar('qj-msg'), null, 'el detalle NO está en el encabezado');
  const cuerpo = fila.buscar('qj-detalle');
  ok(cuerpo, 'está en el cuerpo, que existe aunque la ronda de feedback esté cerrada');
  has(cuerpo.buscar('qj-msg').textContent, '128.412↑');
  has(cuerpo.buscar('qj-msg').textContent, 'IA 3m 05s');

  // Lo único del detalle que se queda arriba es el TIEMPO, que es lo que pidió el
  // editor y lo que se compara entre marcadores al barrer la lista.
  ok(cab.buscar('qj-clock'), 'el tiempo sí queda en el encabezado');
  ok(/\d/.test(cab.buscar('qj-clock').texto()), 'y dice un número: ' + cab.buscar('qj-clock').texto());
  // Y arriba queda Feedback, que es lo que se aprieta barriendo; los otros dos
  // bajaron con el detalle.
  has(cab.buscar('qj-ctrls').texto(), 'Feedback');
  eq(cab.texto().indexOf('Limpiar previas'), -1, 'Limpiar previas se fue al cuerpo');
  eq(cab.texto().indexOf('Editar HTML'), -1, 'y Editar HTML también');
  has(cuerpo.texto(), 'Limpiar previas');
  has(cuerpo.texto(), 'Editar HTML');

  // Y el tiempo sigue apareciendo en un trabajo que viene de un `queue.json`
  // viejo, que guardaba las etapas y no el total. Sin el respaldo, esos trabajos
  // se quedaban sin tiempo justo después de que el tiempo pasó a ser lo único que
  // el encabezado muestra, y sólo se notaba al reiniciar el panel.
  const viejo = dibujarCola([job({ status: 'done', version: 2, _modelMs: 120000, _renderMs: 40000, msg: '✓ Listo (v2)' })]);
  const reloj = viejo.panel.buscar('hp-sumario').buscar('qj-clock');
  ok(reloj && /\d/.test(reloj.texto()), 'el que no guardó el total lo compone con las etapas');

  // El que AVANZA, al revés: todo arriba.
  const corriendo = dibujarCola([job({ status: 'running', pct: 71, startedAt: Date.now(), msg: 'Renderizando…' })]);
  const cab2 = corriendo.panel.buscar('hp-sumario');
  ok(cab2.buscar('qj-msg'), 'el mensaje del que corre vive en el encabezado');
  ok(cab2.buscar('hp-bar'), 'la barra de progreso también');
  ok(cab2.buscar('qj-act'), 'y la línea de qué está haciendo');
  ok(cab2.buscar('qj-clock'), 'y el cronómetro, al lado del nombre');
  eq(corriendo.panel.buscar('qj-detalle'), null, 'y no se le arma cuerpo de detalle');
});

test('lo que se aprieta con la fila plegada está en el encabezado', function () {
  // Es la diferencia honesta con la ficha de un marcador, que tiene sus acciones
  // en el pie: reintentar el que falló, colocar el que no entró y reordenar los
  // que esperan se aprietan mirando la lista, sin abrir nada.
  const d = dibujarCola(losSiete());
  const filas = d.panel.buscarTodos('queue-job');
  const conAcciones = filas.filter(function (f) { return !!f.buscar('hp-sumario').buscar('qj-ctrls'); });
  eq(conAcciones.length, 8, 'las ocho filas ofrecen algo sin desplegarse');
  // Y el botón que abre la ronda no la abre DOS veces: vive adentro del
  // `<summary>`, así que su clic también plegaría la tarjeta por su cuenta.
  has(COLA, 'if (e.preventDefault) e.preventDefault();');
});

test('el nombre del clip terminado lleva al timeline sin abrir la ronda', function () {
  const espia = [];
  const d = dibujarCola([job({ status: 'done', version: 3, msg: 'Listo' })]);
  d.ctx.HPQueueView.init({
    goToJobMarker: function () {}, showJobInTimeline: function (j) { espia.push(j); },
    currentSequence: function () { return 'Clase 23'; },
    setOutput: function () {}, preparingSequence: function () { return null; },
    sequenceContext: function () { return null; },
  });
  d.ctx.HPQueueView.render([job({ status: 'done', version: 3, msg: 'Listo' })]);
  // Sobre las PALABRAS, que es donde vive el clic desde que la caja elástica dejó
  // de escucharlo.
  const fila = d.panel.buscar('queue-job');
  const abiertaAntes = !!fila.open;
  d.panel.buscar('hp-nombre-txt').click();
  eq(espia.length, 1, 'se fue al timeline');
  // Y la tarjeta quedó como estaba: el nombre vive adentro del `<summary>`, así
  // que sin frenar el evento, ir a mirar el clip abriría o cerraría la ronda de
  // feedback de paso. Se mide el efecto y no la llamada a `preventDefault`,
  // porque lo que no se puede romper es esto, no cómo se consigue.
  eq(!!fila.open, abiertaAntes, 'ir al timeline no despliega ni pliega la tarjeta');
});

// El bug que lo motivó, reportado así: "me toca dar clic en el botón de la
// izquierda para desplegarlo, debería desplegarse al hacer clic en la card como
// en el resto de la interfaz".
//
// El nombre es elástico para poder recortar con tres puntos, así que se lleva
// todo el hueco del encabezado; con el `preventDefault` en la caja, el clic en
// ese vacío no desplegaba la tarjeta y ADEMÁS movía el cursor de Premiere sin que
// nada lo insinuara. Lo que se fija: la caja no escucha, las palabras sí.
test('el hueco del encabezado despliega la tarjeta, y NO se va al timeline', function () {
  const espia = [];
  const d = dibujarCola([job({ status: 'done', version: 3, msg: 'Listo' })]);
  d.ctx.HPQueueView.init({
    goToJobMarker: function () {}, showJobInTimeline: function (j) { espia.push(j); },
    currentSequence: function () { return 'Clase 23'; },
    setOutput: function () {}, preparingSequence: function () { return null; },
    sequenceContext: function () { return null; },
  });
  d.ctx.HPQueueView.render([job({ status: 'done', version: 3, msg: 'Listo' })]);

  const caja = d.panel.buscar('qj-title');
  ok(caja, 'la caja del nombre está');
  const palabras = caja.buscar('hp-nombre-txt');
  ok(palabras, 'adentro están las palabras, que son las que llevan');

  // Lo que importa es el EFECTO: apretar la caja elástica —que es el hueco vacío
  // del encabezado— tiene que desplegar la tarjeta y no irse a ningún lado.
  const fila = d.panel.buscar('queue-job');
  eq(!!fila.open, false, 'arranca plegada');
  caja.click();
  eq(!!fila.open, true, 'el hueco del encabezado la despliega');
  eq(espia.length, 0, 'y NO movió el cursor de Premiere');
  caja.click();
  eq(!!fila.open, false, 'y la vuelve a plegar');
});

test('en Corrections es el mismo arreglo, porque era el mismo bug', function () {
  // Las dos pestañas tenían el manejador en la caja elástica. Se arregló en el
  // lugar compartido (`HPUtil.nombreQueLleva`), así que lo que se fija es que las
  // dos lo usen: con una copia a mano en cualquiera de las dos, el bug vuelve en
  // esa mitad nada más y nadie lo mira.
  [['la Cola', COLA], ['Corrections', CORR]].forEach(function (par) {
    has(par[1], 'HPUtil.nombreQueLleva(');
    eq((par[1].match(/hp-nombre["'\s]/g) || []).length, 0,
      par[0] + ' no se arma el nombre a mano: lo pide al lugar compartido');
  });
});

// ── 4. El cuerpo es UNO ───────────────────────────────────────────────

test('las tres pestañas le piden el cuerpo a HPPromptCard, y una sola vez cada una', function () {
  const vista = fs.readFileSync(path.join(CEP, 'general-view.js'), 'utf8');
  [['la ficha del marcador', MAIN], ['la ronda de la Cola', COLA],
    ['la fila de Corrections', CORR], ['los dos bloques de estilo', vista]].forEach(function (par) {
    eq((par[1].match(/HPPromptCard\.montar\(/g) || []).length, 1,
      par[0] + ' monta el cuerpo compartido, y en un solo lugar');
  });
});

test('la ronda de la Cola y la fila de Corrections son el mismo cuerpo con otras acciones', function () {
  // Lo que cambia entre las cuatro fichas es el pie, y nada más. Acá está escrito
  // cuál es el de cada una: si alguna vuelve a armarse un layout propio, este test
  // deja de encontrar su `acciones`.
  has(MAIN, 'acciones: { izquierda: [regenBtn], derecha: [queueBtn, genBtn] }');
  has(COLA, 'acciones: { izquierda: [fresh], derecha: [go] }');
  has(CORR, 'acciones: { izquierda: [], derecha: [stageBtn, fixBtn] }');
  // Y el parámetro del pedido —sobre qué versión se rediseña— va en la BARRA DE
  // CONTROLES, que es donde la ficha de un marcador pone su «Con fondo»: no es una
  // acción. En el pie quedaba debajo de los dos botones que lo usan, porque el pie
  // envuelve al revés para dejar lo destructivo arriba.
  has(CORR, 'controles: [selRoot]');
  has(MAIN, 'controles: [bgRow]');
  // Y `controles` es AHORA lo propio de cada una y nada más. El 📸 y el clip los
  // pone la ficha, que los arma con el resto de la barra de referencias a partir
  // de `stills` (ver `cablearStills` en cep/js/prompt-card.js): los escribían las
  // tres, idénticos carácter por carácter, títulos largos incluidos.
  has(CARD, 'controles: [capturarBtn].concat(clip)', 'el 📸 y el clip los pone la ficha');
  has(CARD, 'botonIcono("capturar"', 'con el botón de icono compartido');
  has(CARD, 'canonizar: function (texto) { return HPMenciones.canonizar(texto, inventario()); }',
    'y la canonización del ✨ sale del mismo lugar');
  [['la ficha del marcador', MAIN], ['la Cola', COLA], ['Corrections', CORR]].forEach(function (par) {
    has(par[1], 'stills: { clave:', par[0] + ' le pide la barra de referencias a la ficha');
    ok(par[1].indexOf('botonIcono("capturar"') === -1, par[0] + ' no se arma el 📸 a mano');
    ok(par[1].indexOf('botonIcono("adjuntar"') === -1, par[0] + ' ni el clip');
    ok(par[1].indexOf('HPMenciones.canonizar(') === -1, par[0] + ' ni la canonización');
  });
});

test('lo que se puede adjuntar está escrito en UN solo lugar', function () {
  // Es la lista de formatos del selector de archivos, y estuvo cuatro veces: una
  // por pestaña que dibuja un clip. Este es el modo de falla que la copia paga, y
  // es silencioso: el día que entre `.rtf`, el que se olvide de un archivo no
  // rompe nada visible —esa pestaña simplemente no deja adjuntar un formato que
  // las otras tres sí, sin error, sin log y sin nada que lo note—.
  //
  // El dueño de verdad es el MOTOR (el mapa de extensiones de
  // bridge/store/references.js decide qué se puede ingerir, y bridge/engine.js
  // qué se pega en el prompt en vez de viajar como imagen). Esto es su reflejo
  // del lado del panel, y es un reflejo porque leerlo del bridge pide el `require`
  // de engine-client.js. Lo que se fija acá es que el reflejo sea UNO.
  const conAccept = fs.readdirSync(CEP)
    .filter(function (f) { return /\.js$/.test(f); })
    .filter(function (f) { return /\.accept\s*=/.test(fs.readFileSync(path.join(CEP, f), 'utf8')); });
  eq(conAccept.join(' '), 'prompt-card.js',
    'un solo archivo del panel escribe el `accept` del selector: ' + conAccept.join(' '));
  has(CARD, 'var FORMATOS = "image/*,application/pdf,.pdf,.txt,.md,.csv,.json,.doc,.docx"');
  has(CARD, 'input.accept = FORMATOS;', 'y el único clip que existe lo lee de ahí');
  // Y las CUATRO fichas le piden el clip a ese lugar, incluidos los dos bloques de
  // estilo, que son los que menos se parecen a las otras tres (su material es de
  // HPRefs y no de HPStills) y aun así comparten esto.
  has(VISTA, 'HPPromptCard.adjuntar(', 'los dos bloques de estilo piden el clip compartido');
  [['la ficha del marcador', MAIN], ['la Cola', COLA], ['Corrections', CORR],
    ['los dos bloques de estilo', VISTA]].forEach(function (par) {
    ok(par[1].indexOf('type = "file"') === -1, par[0] + ' no se arma el selector de archivos');
  });
  // Los nueve formatos, nombrados uno por uno: que la lista esté en un solo lugar
  // no sirve si ese lugar se queda corto.
  ['image/*', 'application/pdf', '.pdf', '.txt', '.md', '.csv', '.json', '.doc', '.docx']
    .forEach(function (f) {
      const linea = CARD.match(/var FORMATOS = "([^"]*)"/);
      ok(linea && linea[1].split(',').indexOf(f) !== -1, 'la lista ofrece ' + f);
    });
});

test('el inventario de referencias lo contesta un solo lugar para las tres', function () {
  // Es lo que mira el chip del campo (su número, su estado y la miniatura del
  // hover), el aviso de la mención colgada y la canonización del ✨. Vive en
  // HPStills porque ahí vive el material del marcador y porque ese módulo ya sabía
  // leer el de OTRA secuencia, que es justo lo que la Cola y Corrections
  // necesitan.
  const stills = fs.readFileSync(path.join(CEP, 'stills.js'), 'utf8');
  has(stills, 'function inventario(markerKey, opts)');
  has(stills, 'inv.push({ scope: "marker"');
  has(stills, 'inv.push(deReferencia(par[0], it));');
  // Y la fila de una referencia de los dos niveles generales la arma la MISMA
  // función, aunque la lista sea de HPRefs: si cada vista armara la suya, el chip
  // de un bloque de estilo podría numerar distinto que el de la ficha de un
  // marcador sobre la misma referencia.
  has(stills, 'function deReferencia(scope, it)');
  has(fs.readFileSync(path.join(CEP, 'general-view.js'), 'utf8'), 'HPStills.deReferencia(refScope, it)',
    'los dos bloques de estilo la usan también');
  // Y las tres fichas de marcador lo PIDEN en un solo lugar: la ficha se lo
  // pregunta a HPStills con la clave y la secuencia que le dice `stills`. Antes lo
  // pedía cada pestaña, con tres llamadas distintas a la misma función, que es la
  // forma en que una de las tres se queda atrás sin que nada falle.
  has(CARD, 'function inventario() { return HPStills.inventario(clave, hoja()); }',
    'la ficha lo pide una vez, con la clave y la secuencia de cada una');
  [['la ficha del marcador', MAIN], ['la Cola', COLA], ['Corrections', CORR]].forEach(function (par) {
    ok(par[1].indexOf('HPStills.inventario(') === -1, par[0] + ' no lo pide por su cuenta');
    ok(par[1].indexOf('inventario: ') === -1, par[0] + ' ni le pasa uno propio a la ficha');
  });
  // Los dos bloques de estilo SÍ pasan el suyo, y eso está bien: lo que pueden
  // nombrar es sólo su nivel (ver `inventarioDe` en cep/js/general-view.js).
  has(VISTA, 'inventario: function () { return inventarioDe(n.refScope); }',
    'los dos bloques de estilo pasan el suyo, que es deliberadamente otro');
  eq((MAIN.match(/HPRefs\.state\(/g) || []).length, 0,
    'main ya no concatena las tres listas por su cuenta');
});

test('las dos que dan feedback ganan los chips de mención, que ya viajaban', function () {
  // El motor traduce las menciones del campo `adjustment` igual que las de
  // `instruction` (CAMPOS_CON_MENCIONES, bridge/engine.js), así que un
  // `@[curso/logo.svg]` escrito en la caja de feedback YA viajaba traducido y el
  // panel no lo pintaba ni avisaba si quedaba colgado.
  const engine = fs.readFileSync(path.join(RAIZ, 'bridge', 'engine.js'), 'utf8');
  has(engine, "const CAMPOS_CON_MENCIONES = ['instruction', 'adjustment'");
  const d = dibujarCola([job({ status: 'done', version: 3, msg: 'Listo' })]);
  d.panel.porTexto('Feedback').click();
  ok(d.panel.buscar('hp-campo-input'), 'el campo que pinta las menciones como chips');
  ok(d.panel.buscar('hp-aviso'), 'y el renglón que avisa');
  ok(d.panel.buscar('hp-tira-propia'), 'con la tira de referencias del marcador');
});

test('los cinco campos de prompt se dibujan con los MISMOS valores', function () {
  // Los cinco son el mismo campo (`.hp-campo-input`, el `contenteditable` con
  // chips), así que el tamaño y el interlineado los pone una sola regla. La
  // cicatriz que esto cuida es de cuando había un ESPEJO detrás: el campo de una
  // corrección se dibujaba en 12 px / 1.45 y su espejo en 13 / 1.5 —un
  // `.corr-row textarea` de la sección 6 le ganaba por especificidad— y las dos
  // cajas cortaban las líneas en otro lado. El espejo se fue con los chips, y lo
  // que sigue valiendo es que ningún selector de etiqueta le gane al del campo.
  const campo = declaraciones('.hp-campo-input');
  eq(campo['font-size'], '13px');
  eq(campo['line-height'], '1.5');
  const campos = declaraciones('#general-instruction, #general-sequence-instruction, #objective, ' +
    '.marker-instruction, .corr-level-input, .corr-input, .qj-fb-input');
  eq(campos['font-size'], campo['font-size'], 'el mismo cuerpo');
  eq(campos['line-height'], campo['line-height'], 'y el mismo interlineado');
  const conEtiqueta = REGLAS.filter(function (r) {
    return /(font-size|line-height)/.test(r.cuerpo) &&
      /\.(corr-row|queue-job|marker-card|hp-ficha|hp-tarjeta)\s+(textarea|input)\b/.test(r.selector);
  });
  eq(conEtiqueta.length, 0,
    'ninguna fila de lista le pone tamaño a su campo por la etiqueta (eso le gana a ' +
    '`.hp-campo-input` por especificidad): ' + conEtiqueta.map((r) => r.selector).join(' | '));
});

test('los dos campos de feedback arrancan en TRES renglones', function () {
  // El de la Cola medía 34 px —un renglón y medio— y el de una corrección dos, y
  // los dos son donde se escribe qué está mal, que son una o tres frases. Tres
  // renglones enteros a 13 px / 1.5 son 58.5 de texto + 10 de padding + 2 de
  // borde = 72, el mismo cálculo que los dos bloques de estilo. El alto se paga
  // una sola vez: hay una ronda abierta a la vez y una fila de corrección abierta
  // a la vez.
  eq(declaraciones('.qj-fb-input, .corr-input')['min-height'], '72px');
  eq(declaraciones('#general-instruction, #general-sequence-instruction')['min-height'], '72px',
    'el mismo alto que los dos bloques de estilo, que es el mismo cálculo');
});

test('Corrections abre de a una, como la lista de marcadores', function () {
  // Abierta, la fila mide ~490 px (es la más cargada del panel): con dos abiertas
  // no se ve una lista, se ve un formulario largo. Es el mismo acordeón que
  // main.js le pone a las fichas de marcador.
  has(CORR, 'row.addEventListener("toggle", function () {');
  has(CORR, 'listEl.querySelectorAll("details.corr-row")');
  has(CORR, 'if (todas[i] !== row) todas[i].open = false;');
});

test('el cuerpo de la ficha tiene un lugar para lo que se lee ANTES de escribir', function () {
  // Es lo único que la fila de Corrections agrega al cuerpo compartido: el encargo
  // con el que nació el recurso y el contexto que recibió esa versión. Va arriba
  // del campo porque es lo que se consulta antes de decir qué está mal.
  const card = fs.readFileSync(path.join(CEP, 'prompt-card.js'), 'utf8');
  has(card, '(opts.antes || []).forEach');
  const antes = card.indexOf('(opts.antes || []).forEach');
  ok(antes < card.indexOf('caja.appendChild(tira)'), 'y va antes que la tira');
  has(CORR, 'antes: antes');
  has(CORR, 'antes.push(prompts.el)');
  const montar = MAIN.slice(MAIN.indexOf('ficha = HPPromptCard.montar({'));
  ok(montar.slice(0, montar.indexOf('});')).indexOf('antes:') === -1,
    'la ficha del marcador no lo usa: abre con su tira de referencias');
});
