'use strict';

// Los OCHO caminos que arman un pedido, y qué recibe el modelo por cada uno.
//
//   node test/manual/ocho-caminos.js [--out archivo.md]
//
// Hermano de `prompt-tres-niveles.js`, `referencias-al-modelo.js` y
// `menciones-al-modelo.js`, con la misma forma y por el mismo motivo. Aquéllos
// contestan "¿llegan los tres niveles?", "¿llegan las referencias?" y "¿se
// traducen las menciones?" por UN camino. Éste contesta la otra mitad: los tres
// niveles, sus referencias y sus menciones tienen que llegar por TODOS los
// caminos que el panel ofrece, y son ocho. Un camino que se quedó atrás no falla:
// sale un recurso sin la marca y se descubre viendo el video.
//
// De punta a punta quiere decir: un proyecto de verdad en un temporal con sus dos
// carpetas `_referencias`, el PANEL de verdad montado como lo carga el navegador
// (HPStore + HPGeneral + HPRefs + HPMenciones + HPPromptCard + HPQueue +
// HPQueueView + HPCorrections), la cola releyendo el disco al momento de generar,
// y el MOTOR de verdad armando el pedido con su system.md y su build-context. Lo
// único falso es el proveedor, que anota lo que le habrían mandado en vez de
// llamar al modelo.
//
// Los ocho, y de dónde salen (confirmados con `rg`, no supuestos):
//
//   1. Generación normal desde la ficha del marcador.
//      cep/js/main.js → enqueueMarkerGeneration(m, "generate") → kind "generate"
//      → engine.prepareGenerate.
//   2. Reintento de un job de la cola.
//      cep/js/queue.js → retry(id) → rehydratePayload → ensureGeneralPrompt /
//      ensureRefs, que releen el DISCO por cada job.
//   3. ↻ Aplicar el ajuste, en la caja de feedback de la Cola (prompt lean).
//      cep/js/queue-view.js:541 → HPQueue.regenerate(id, texto, sendIdx) → mode
//      "adjust" → engine.prepareFeedback con lean = true.
//   4. ⟲ Regenerar desde cero.
//      cep/js/queue-view.js:567 → HPQueue.regenerateFresh(id) → mode "regen".
//   5. Corrections: sin ajuste local, con ajuste local, y el caso CRUZADO (un
//      recurso de otro corte: viajan los prompts y las referencias de la
//      secuencia de ORIGEN, no de la abierta).
//      cep/js/corrections.js:216 → mode "adjust" + promptOverride + storeSeqName.
//   6. Render manual de HTML. cep/js/corrections.js:277 → kind
//      "renderManualHtml" → engine.renderManualHtml. NO llama al modelo: se
//      comprueba que no mande nada Y que su ficha no diga lo contrario.
//   7. La derivación del objetivo de la clase. engine.deriveObjective.
//   8. El estimador de tokens, en la ficha (main.js:1873) y en la Cola
//      (queue-view.js:405 → HPQueue.payloadForEstimate → estimateTokens),
//      comparado contra lo que de verdad viajó.
//
// Y las MENCIONES por los tres lugares donde ahora existen —la ficha, la caja de
// feedback de la Cola y la fila de Corrections— con sus casos borde: la colgada,
// la que el disco no tiene, el documento, la instrucción vieja en texto plano
// que no se toca, y el reordenamiento.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

// La config del modelo vive en ~/.hyperpremiere y este script la escribe, así que
// HOME va a un temporal ANTES de cargar el motor. Sin esto, correr esto le
// cambiaría el proveedor al panel del editor.
const CASA = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-home-'));
process.env.HOME = CASA;
process.env.USERPROFILE = CASA;

const engine = require('../../bridge/engine.js');

const RAIZ = path.join(__dirname, '..', '..');
const CEP = path.join(RAIZ, 'cep', 'js');
const RUTA_PROVEEDOR = path.join(RAIZ, 'bridge', 'providers', 'ollama.js');

// La de ORIGEN (donde nació el recurso) y la ABIERTA (el corte nuevo). Que sean
// dos es lo que hace verificable el caso cruzado del camino 5.
const SEQ = 'Clase 12 · Automatizaciones';
const SEQ_ABIERTA = 'Clase 12 · Automatizaciones_02';

const CURSO =
  'Marca ACADEMIA NOVA. Tipografía Söhne para títulos, Inter para cuerpo.\n' +
  'Paleta azul institucional: fondo #0b1b3a, acento #2f6fd0, texto hueso #efeadf.\n' +
  'Todo entra por la derecha; nunca tapar la cara del profe.';
const SECUENCIA =
  'Esta clase va en BLANCO Y NEGRO: es el módulo de fotografía y el color pelea con los ejemplos.';
// El del corte NUEVO, que NO tiene que viajar en el caso cruzado.
const SECUENCIA_DEL_CORTE_NUEVO =
  'ESTE TEXTO NO TIENE QUE VIAJAR EN NINGÚN PEDIDO DE ESTE SCRIPT: es del corte nuevo.';

const OBJETIVO = 'Que el estudiante reconozca los tres componentes de una automatización.';

const COMPOSICION = '<!DOCTYPE html><html><body>' +
  '<div id="stage" data-composition-id="marcador-1" data-start="0" data-width="1920" ' +
  'data-height="1080" data-duration="6" data-fps="30"></div>' +
  '<script>const tl = gsap.timeline({ paused: true }); window.__timelines["marcador-1"] = tl;</script>' +
  '</body></html>';

/** Un PNG mínimo pero válido, para que el motor lo trate como imagen de verdad. */
const PNG_1PX = 'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const TRANSCRIPT = [
  { start: 0, end: 10, text: 'Arrancamos con la idea de automatización.' },
  { start: 10, end: 16, text: 'Toda automatización tiene los mismos tres componentes.' },
  { start: 16, end: 30, text: 'Y ahora los vemos de a uno con un ejemplo.' },
];
const TRAMO = [{ start: 10, end: 16, text: 'Toda automatización tiene los mismos tres componentes.' }];

// ── El proveedor falso ──────────────────────────────────────────────
//
// Anota TODO lo que se le pidió, en orden, para poder decir además "por este
// camino no se llamó al modelo" (camino 6) sin tener que creerle a nadie.

const pedidos = [];
let fallarLaProxima = false;

function proveedorEspia() {
  const mod = {
    exports: {
      generate: async function (arg) {
        pedidos.push(arg);
        if (fallarLaProxima) {
          fallarLaProxima = false;
          throw new Error('el modelo se cayó (simulado para el camino 2)');
        }
        // La derivación del objetivo (camino 7) no pide una composición sino una
        // frase; devolver el HTML ahí dejaría el reporte diciendo que el objetivo
        // de la clase es un `<!DOCTYPE html>`.
        const texto = /OBJETIVO pedagógico/.test(String(arg.systemPrompt || ''))
          ? 'Que el estudiante reconozca los tres componentes de una automatización y sepa nombrarlos.'
          : COMPOSICION;
        return { text: texto, usage: { inputTokens: 1, outputTokens: 1, totalInputTokens: 1 } };
      },
      complete: async function (arg) {
        pedidos.push(arg);
        return { text: '', usage: {} };
      },
    },
    loaded: true, id: RUTA_PROVEEDOR, filename: RUTA_PROVEEDOR, paths: [], children: [],
  };
  require.cache[RUTA_PROVEEDOR] = mod;
}

/**
 * Espera a que aparezca un pedido nuevo y lo devuelve.
 *
 * La espera es larga a propósito: el camino 6 renderiza de verdad (un minuto
 * largo) y la cola es serial, así que un job que entre detrás espera todo eso.
 */
async function esperarPedido(desde, qué) {
  for (let i = 0; i < 6000 && pedidos.length <= desde; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (pedidos.length <= desde) throw new Error('el pedido de «' + qué + '» nunca llegó al proveedor');
  return pedidos[desde];
}

/** Deja correr las promesas encadenadas de la cola, sin esperar ningún pedido. */
async function dejarCorrer(vueltas) {
  for (let i = 0; i < (vueltas || 80); i++) await new Promise((r) => setTimeout(r, 5));
}

// ── Un DOM mínimo, lo que los módulos del panel le piden ─────────────

function elemento(tag) {
  const el = {
    tagName: tag, children: [], listeners: {}, style: {}, className: '',
    textContent: '', value: '', title: '', type: '', rows: 0, checked: false,
    disabled: false, childNodes: [], selectionStart: 0, selectionEnd: 0,
    scrollTop: 0, scrollLeft: 0, scrollHeight: 0, clientWidth: 0, offsetWidth: 0,
    appendChild: function (h) { this.children.push(h); this.childNodes.push(h); return h; },
    insertBefore: function (h) { this.children.unshift(h); this.childNodes.unshift(h); return h; },
    removeChild: function (h) {
      const i = this.children.indexOf(h);
      if (i !== -1) { this.children.splice(i, 1); this.childNodes.splice(i, 1); }
      return h;
    },
    remove: function () {},
    setAttribute: function (k, v) { this[k] = v; },
    getAttribute: function (k) { return this[k]; },
    removeAttribute: function (k) { delete this[k]; },
    hasAttribute: function (k) { return this[k] !== undefined; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    removeEventListener: function () {},
    click: function () {
      (this.listeners.click || []).forEach(function (f) {
        f({ stopPropagation: function () {}, preventDefault: function () {} });
      });
    },
    emitir: function (ev) {
      (this.listeners[ev] || []).forEach(function (f) {
        f({ stopPropagation: function () {}, preventDefault: function () {}, target: el });
      });
    },
    focus: function () {}, blur: function () {}, select: function () {},
    setSelectionRange: function (a, b) { this.selectionStart = a; this.selectionEnd = b; },
    getBoundingClientRect: function () { return { width: 0, height: 0, top: 0, left: 0 }; },
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
    porPrefijo: function (prefijo) {
      for (const h of this.children) {
        if (String(h.className || '').indexOf(prefijo) === 0) return h;
        const hit = h.porPrefijo && h.porPrefijo(prefijo);
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
    add: function (c) { if (String(el.className).split(' ').indexOf(c) === -1) el.className = (el.className ? el.className + ' ' : '') + c; },
    remove: function (c) { el.className = String(el.className).split(' ').filter((x) => x && x !== c).join(' '); },
    contains: function (c) { return String(el.className).split(' ').indexOf(c) !== -1; },
    toggle: function () {},
  };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return ''; },
    set: function () { el.children.length = 0; el.childNodes.length = 0; },
  });
  return el;
}

/** El panel, con TODOS los módulos de verdad y el motor de verdad detrás. */
function montarPanel(proyecto, notas) {
  const almacen = {};
  const nodos = {
    // Lo que pide la vista de la Cola…
    'queue-panel': elemento('div'),
    'view-queue': elemento('div'),
    'tab-queue-count': elemento('span'),
    // …y lo que pide la pestaña de correcciones.
    'corr-list': elemento('div'),
    'corr-status': elemento('span'),
    'corr-picker': elemento('div'),
    'btn-load-corrections': elemento('button'),
  };
  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Object: Object, Array: Array, Set: Set, isNaN: isNaN, parseInt: parseInt,
    parseFloat: parseFloat, encodeURIComponent: encodeURIComponent,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: function () { return 0; }, clearInterval: function () {},
    requestAnimationFrame: function (f) { return setTimeout(f, 0); },
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(almacen, k) ? almacen[k] : null; },
      setItem: function (k, v) { almacen[k] = String(v); },
      removeItem: function (k) { delete almacen[k]; },
    },
    HPLog: { log: function (m, n) { notas.push((n ? '[' + n + '] ' : '') + m); } },
    HPConfigUI: { isLocalProvider: function () { return true; }, modelName: function () { return 'falso'; } },
    HPTranscript: { sliceForMarker: function () { return TRAMO; } },
    HPHost: {
      placeClip: function (mov, seq, s, d, c, a, cb) { cb('ok'); },
      purgeClipsByPath: function () {},
      openSequenceAndSeek: function () {},
    },
    // Sin dictado: lo que se está midiendo es el prompt, y `micOpcional` ya
    // contesta null cuando HPDictado no está (es su contrato, y tiene su test).
    HPEngine: {
      call: function (m, arg) {
        if (typeof engine[m] === 'function') {
          try { return Promise.resolve(engine[m](arg)); } catch (e) { return Promise.reject(e); }
        }
        if (m === 'loadTranscript') return Promise.resolve({ ok: true, found: false });
        if (m === 'mediaHasAudio') return Promise.resolve({ ok: true, hasAudio: false });
        return Promise.resolve({ ok: true });
      },
      callProg: function (m, arg, onP) {
        if (m === 'prepareGenerate' || m === 'prepareFeedback') {
          const fn = m === 'prepareGenerate' ? engine.prepareGenerate : engine.prepareFeedback;
          return fn(arg, function (p) {
            if (p && p.note) notas.push(p.note);
            if (onP) onP(p);
          });
        }
        if (m === 'renderManualHtml') {
          return engine.renderManualHtml(arg, function (p) {
            if (p && p.note) notas.push(p.note);
            if (onP) onP(p);
          }).then(function (r) {
            // El render de verdad necesita el binario de hyperframes y no aporta
            // nada a esta pregunta; lo que importa del camino 6 es lo que el
            // motor hizo ANTES de renderizar (la ficha) y que no llamó a nadie.
            return r && r.ok ? r : { ok: true, movPath: '/tmp/x.mov', version: r && r.version };
          }).catch(function () { return { ok: true, movPath: '/tmp/x.mov' }; });
        }
        if (m === 'renderPrepared') return Promise.resolve({ ok: true, movPath: '/tmp/x.mov', version: 1 });
        return Promise.resolve({ ok: true });
      },
    },
    HPStills: {
      fbInit: function () {}, fbClear: function () {}, fbCollect: function () { return null; },
      capturar: function () {}, ingerir: function () {},
      createControl: function () { return elemento('div'); },
      crearTira: function () {
        const el = elemento('div'); el.className = 'hp-tira-propia';
        return {
          el: el, estado: elemento('div'),
          refrescar: function () {}, cuantasImagenes: function () { return 0; },
        };
      },
      // El inventario de lo mencionable. Es el del PANEL (el resaltado y el ✨),
      // no el del pedido: el que decide el número que viaja es el motor.
      inventario: function () { return []; },
    },
    HPWidgets: {
      select: function (root) {
        const api = { value: null, onChange: null, setOptions: function (l, s) { api.value = s; } };
        root.select = api;
        return api;
      },
      makeCodeEditor: function () {
        let v = '';
        return { el: elemento('div'), getValue: function () { return v; }, setValue: function (x) { v = String(x || ''); } };
      },
      // Se anota y NO se acepta solo: apretar "Regenerar desde cero" pregunta, y
      // la diferencia entre avisar y hacer es justo lo que hay que poder ver.
      confirmOverlay: function (titulo, armarCuerpo, boton, onOk) {
        const body = elemento('div');
        if (armarCuerpo) armarCuerpo(body);
        ctx.__confirmaciones.push({ titulo: titulo, boton: boton, aceptar: onOk });
      },
    },
    HPGeneralView: { refresh: function () {} },
  };
  ctx.__nodos = nodos;
  ctx.__confirmaciones = [];
  ctx.document = {
    createElement: elemento,
    createTextNode: function (t) { const n = elemento('#text'); n.textContent = t; return n; },
    getElementById: function (id) { return nodos[id] || null; },
    body: elemento('body'),
    addEventListener: function () {},
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  // `campo.js` va ANTES de `prompt-card.js`, que es el que lo usa para montar el
  // campo con chips. Se sumó cuando el campo dejó de ser un `<textarea>`: sin él,
  // `HPPromptCard.montar` corta con `HPCampo is not defined` y este arnés no
  // llega a medir los tres caminos que escriben en un campo (3, 4 y 5).
  for (const f of ['util.js', 'iconos.js', 'store.js', 'general-prompt.js', 'refs.js',
    'menciones.js', 'campo.js', 'prompt-card.js', 'queue.js', 'queue-view.js',
    'corrections-contexto.js', 'corrections.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  ctx.HPQueueView.init({
    goToJobMarker: function () {}, showJobInTimeline: function () {},
    currentSequence: function () { return SEQ_ABIERTA; },
    setOutput: function () {},
    preparingSequence: function () { return null; },
    sequenceContext: function () { return null; },
  });
  ctx.HPCorrections.init({
    context: function () { return { projectPath: proyecto, sequenceName: SEQ_ABIERTA }; },
    refreshContext: function (cb) { cb(); },
  });
  ctx.HPStore.setContext(proyecto, SEQ);
  return ctx;
}

// ── Leer pedazos del prompt ──────────────────────────────────────────

/** Una sección `## X` del user prompt, entera. */
function seccion(userPrompt, titulo) {
  const up = String(userPrompt || '');
  const desde = up.indexOf('## ' + titulo);
  if (desde === -1) return null;
  const hasta = up.indexOf('\n\n## ', desde + 5);
  return up.slice(desde, hasta === -1 ? undefined : hasta).trim();
}

function tiene(userPrompt, titulo) { return seccion(userPrompt, titulo) !== null; }

/** El payload que armaría la ficha del marcador, con las funciones del panel. */
function payloadDeLaFicha(ctx, proyecto, slug, mode) {
  const gen = ctx.HPRefs.forModel(proyecto, SEQ);
  const md = ctx.HPStore.getMarkerData(slug);
  const g = ctx.HPGeneral.state(proyecto, SEQ);
  const p = {
    projectPath: proyecto, sequenceName: SEQ, mode: mode || 'generate',
    markerSlug: slug, instruction: md.instruction || '',
    objective: ctx.HPStore.getObjective() || OBJETIVO,
    transcript: TRANSCRIPT, markerTranscript: TRAMO,
    marker: { name: slug, start: 10, end: 16, duration: 6 },
    generalInstruction: g.projectText, sequenceInstruction: g.sequenceText,
    stills: (md.stills || []).concat(gen.images),
    stillRefs: ctx.HPStore.getMarkerStillRefs(slug).concat(gen.refs),
    assets: ctx.HPStore.getMarkerAssets(slug).concat(gen.assets),
    resources: ctx.HPStore.getMarkerDocs(slug).concat(gen.docs),
    background: !!md.background,
  };
  if (mode === 'adjust') p.adjustment = md.instruction || '';
  return p;
}

function jobDeLaFicha(ctx, proyecto, slug, mode) {
  return {
    kind: mode === 'generate' ? 'generate' : 'feedback',
    payload: payloadDeLaFicha(ctx, proyecto, slug, mode),
    seqName: SEQ, projectPath: proyecto, markerKey: slug,
    label: slug, markerStart: 10, markerDuration: 6,
  };
}

// ── El reporte ───────────────────────────────────────────────────────

const P = [];
const B = (s) => P.push(s == null ? '' : String(s));
const CHECKS = [];
function check(nombre, cond, detalle) {
  CHECKS.push({ nombre: nombre, ok: !!cond, detalle: detalle || '' });
}
function bloque(titulo, texto) {
  B(titulo);
  B('');
  B('```');
  B(texto == null ? '(no está)' : texto);
  B('```');
  B('');
}

async function main() {
  const salidaIdx = process.argv.indexOf('--out');
  const salida = salidaIdx !== -1 ? process.argv[salidaIdx + 1] : '';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-ocho-caminos-'));
  const proyecto = path.join(dir, 'Curso de automatizaciones.prproj');

  // ── El proyecto: los dos textos y las referencias de los dos niveles ──
  engine.saveGeneralPrompt({ projectPath: proyecto, text: CURSO, scope: 'project' });
  engine.saveGeneralPrompt({ projectPath: proyecto, sequenceName: SEQ, text: SECUENCIA, scope: 'sequence' });
  // El corte NUEVO tiene el suyo, distinto, para que el caso cruzado se pueda ver.
  engine.saveGeneralPrompt({
    projectPath: proyecto, sequenceName: SEQ_ABIERTA, text: SECUENCIA_DEL_CORTE_NUEVO, scope: 'sequence',
  });
  const rutas = engine.loadGeneralPrompt({ projectPath: proyecto, sequenceName: SEQ }).paths;

  function agregar(scope, name, dataUrl, use) {
    const r = engine.addReference({
      projectPath: proyecto, sequenceName: scope === 'sequence' ? SEQ : '',
      scope: scope, name: name, dataUrl: dataUrl, use: !!use,
    });
    if (!r.ok) throw new Error(r.error);
    return r;
  }
  const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 manual de marca', 'utf8').toString('base64');
  agregar('course', 'manual-de-marca-nova.png', PNG_1PX, false);
  agregar('course', 'logo-canal.png', PNG_1PX, true);
  agregar('course', 'paleta-institucional.png', PNG_1PX, false);
  agregar('course', 'Guia_de_estilo_NOVA_v4.pdf', PDF, false);
  agregar('sequence', 'captura-programa-00-03-41.png', PNG_1PX, false);
  const rutasRefs = engine.loadReferences({ projectPath: proyecto, sequenceName: SEQ }).paths;

  proveedorEspia();
  engine.setConfig({ provider: 'ollama', model: 'falso' });

  const notas = [];
  const ctx = montarPanel(proyecto, notas);
  const S = ctx.HPStore;
  S.setObjective(OBJETIVO);
  S.addMarkerStill('Marcador 1', PNG_1PX, 'boceto-3-bloques.png');

  // La instrucción con las CUATRO clases de mención de una vez: una del marcador,
  // una del curso, una de la clase, un DOCUMENTO (que no recibe número) y una
  // COLGADA (una referencia que ya no está en la lista).
  const INSTRUCCION = 'Tres bloques que aparecen de a uno. Copiá la disposición de ' +
    '@[marcador/boceto-3-bloques.png], la tipografía de @[curso/manual-de-marca-nova.png] y el ' +
    'encuadre de @[clase/captura-programa-00-03-41.png]. Incrustá @[curso/logo-canal.png] abajo. ' +
    'Respetá @[curso/Guia_de_estilo_NOVA_v4.pdf] y el celeste de @[curso/paleta-modulo-3.png].';
  S.setMarkerInstruction('Marcador 1', INSTRUCCION);

  B('# Los ocho caminos que arman un pedido');
  B('');
  B('Generado por `node test/manual/ocho-caminos.js`. Proyecto de verdad en un temporal,');
  B('panel de verdad (HPStore + HPGeneral + HPRefs + HPMenciones + HPPromptCard + HPQueue +');
  B('HPQueueView + HPCorrections), motor de verdad; el único doble es el proveedor, que anota');
  B('lo que le habrían mandado en vez de llamar al modelo.');
  B('');
  bloque('## El material del pedido', [
    'proyecto      ' + proyecto,
    'secuencia de ORIGEN   ' + SEQ,
    'secuencia ABIERTA     ' + SEQ_ABIERTA + '   (el corte nuevo)',
    '',
    rutas.project + '   ← prompt del curso',
    rutas.sequence + '   ← prompt de esta clase',
    '',
    '_referencias/ del CURSO:',
  ].concat(fs.readdirSync(rutasRefs.course).sort().map((f) => '  ' + f))
    .concat(['', '_referencias/ de la CLASE:'])
    .concat(fs.readdirSync(rutasRefs.sequence).sort().map((f) => '  ' + f))
    .concat(['', 'del MARCADOR (localStorage de esta máquina):'])
    .concat(S.getMarkerStillNames('Marcador 1').map((n) => '  ' + n))
    .join('\n'));

  // ═══ Camino 1: generación normal desde la ficha ═══════════════════
  const n0 = pedidos.length;
  ctx.HPQueue.add(jobDeLaFicha(ctx, proyecto, 'Marcador 1', 'generate'));
  const uno = await esperarPedido(n0, 'camino 1');
  await dejarCorrer();

  B('## Camino 1 — Generación normal desde la ficha del marcador');
  B('');
  B('`cep/js/main.js` → `enqueueMarkerGeneration(m, "generate")` → `kind: "generate"` →');
  B('`engine.prepareGenerate`.');
  B('');
  bloque('Lo que el editor escribió en el campo:', INSTRUCCION);
  bloque('Los tres niveles, como llegaron:', [
    seccion(uno.userPrompt, 'Prompt general del curso (aplica a TODAS las clases)'),
    '',
    seccion(uno.userPrompt, 'Prompt de esta secuencia (aplica a TODOS los marcadores de esta clase)'),
    '',
    seccion(uno.userPrompt, 'Instrucción del editor (específica de este marcador)'),
  ].join('\n'));
  bloque('Y el contrato de numeración, que es lo que le da sentido a esos números:',
    seccion(uno.userPrompt, 'Imágenes de referencia'));
  bloque('El objetivo:', seccion(uno.userPrompt, 'Objetivo de la clase'));
  B('Con ' + (uno.images || []).length + ' imagen(es) adjuntas.');
  B('');
  bloque('Lo que quedó en el ⬇ Log antes de gastar la llamada:',
    notas.filter((n) => /prompt general|menci|referencia/i.test(n)).join('\n') || '(nada)');

  const insUno = seccion(uno.userPrompt, 'Instrucción del editor (específica de este marcador)');
  check('camino 1 · el prompt del CURSO viaja', String(uno.userPrompt).indexOf('Paleta azul institucional') !== -1);
  check('camino 1 · el de la CLASE viaja y dice quién manda',
    String(uno.userPrompt).indexOf('BLANCO Y NEGRO') !== -1 &&
    String(uno.userPrompt).indexOf('MANDA ESTO') !== -1);
  check('camino 1 · la instrucción del marcador viaja', insUno.indexOf('Tres bloques') !== -1);
  check('camino 1 · el del corte NUEVO no se cuela', String(uno.userPrompt).indexOf('NO TIENE QUE VIAJAR') === -1);
  check('camino 1 · ninguna mención llega sin traducir', insUno.indexOf('@[') === -1, insUno);
  check('camino 1 · la del marcador es la imagen 1', /disposición de imagen 1/.test(insUno), insUno);
  check('camino 1 · la del curso es la imagen 2', /tipografía de imagen 2/.test(insUno), insUno);
  check('camino 1 · la de la clase es la imagen 5 (después de las tres del curso)',
    /encuadre de imagen 5/.test(insUno), insUno);
  check('camino 1 · una ✓ usar dice además su archivo de assets',
    /imagen 3 \(el archivo assets\//.test(insUno), insUno);
  check('camino 1 · un DOCUMENTO no recibe número: se nombra como documento',
    /el documento «Guia_de_estilo_NOVA_v4\.pdf»/.test(insUno), insUno);
  check('camino 1 · la mención COLGADA se dice y no le presta el número a otra',
    insUno.indexOf('paleta-modulo-3.png» (referencia que ya no está adjunta') !== -1, insUno);
  check('camino 1 · el transcript completo viaja (no es lean)',
    tiene(uno.userPrompt, 'Transcript completo de la clase (contexto general)'));

  // ═══ Camino 8a: el estimado de la FICHA contra lo que viajó ═══════
  // Se mide acá, con el pedido del camino 1 todavía fresco, porque lo que se está
  // comparando es el estimado de ESE cuerpo contra ESE prompt.
  const estFicha = engine.estimateTokens(payloadDeLaFicha(ctx, proyecto, 'Marcador 1', 'generate'));
  const charsReales = String(uno.systemPrompt || '').length + String(uno.userPrompt || '').length;

  // ═══ Camino 2: reintento de un job de la cola ═════════════════════
  //
  // El reintento tiene que RELEER el disco: si el editor corrigió el estilo
  // porque las animaciones salían mal, reintentar tiene que salir con el
  // arreglado. Así que se cae el modelo, se arregla el archivo del proyecto Y se
  // agrega una referencia nueva, y recién ahí se reintenta.
  const CURSO_ARREGLADO = CURSO + '\nY NADA de degradés: en el proyector se ven sucios.';
  const n2a = pedidos.length;
  fallarLaProxima = true;
  ctx.HPQueue.add(jobDeLaFicha(ctx, proyecto, 'Marcador 2', 'generate'));
  S.setMarkerInstruction('Marcador 2', 'Un cartel con el dato del 68% en grande.');
  await esperarPedido(n2a, 'camino 2 (el que se cae)');
  await dejarCorrer(120);

  const jobCaido = ctx.HPQueue.jobs().filter((j) => j.markerKey === 'Marcador 2')[0];
  const estadoTrasCaer = jobCaido && jobCaido.status;

  engine.saveGeneralPrompt({ projectPath: proyecto, text: CURSO_ARREGLADO, scope: 'project' });
  agregar('sequence', 'captura-nueva-del-arreglo.png', PNG_1PX, false);

  const n2b = pedidos.length;
  ctx.HPQueue.retry(jobCaido.id);
  const dos = await esperarPedido(n2b, 'camino 2 (el reintento)');
  await dejarCorrer();

  B('## Camino 2 — Reintento de un job de la cola');
  B('');
  B('`cep/js/queue.js` → `retry(id)` → `rehydratePayload` → `ensureGeneralPrompt` /');
  B('`ensureRefs`, que releen el DISCO por cada job. El job se cayó en el modelo, el');
  B('editor arregló el prompt del curso en el archivo del proyecto y agregó una');
  B('referencia; el reintento tiene que salir con las dos cosas nuevas.');
  B('');
  B('Estado del job después de caerse: `' + estadoTrasCaer + '`.');
  B('');
  // El intento que se cayó también llegó al proveedor, así que la comparación es
  // entre el MISMO job antes y después de que el editor tocara el disco. No hay
  // forma más directa de mostrar que el reintento releyó.
  const dosAntes = pedidos[n2a];

  bloque('El prompt del curso ANTES (el intento que se cayó):',
    seccion(dosAntes.userPrompt, 'Prompt general del curso (aplica a TODAS las clases)'));
  bloque('Y DESPUÉS, en el reintento:',
    seccion(dos.userPrompt, 'Prompt general del curso (aplica a TODAS las clases)'));
  B('Imágenes adjuntas: **' + (dosAntes.images || []).length + '** en el intento que se cayó, ' +
    '**' + (dos.images || []).length + '** en el reintento. La referencia que el editor agregó');
  B('entre los dos entró sin tocar el job.');
  B('');

  check('camino 2 · el job cayó en error (y no se dio por bueno)', estadoTrasCaer === 'error',
    'estado: ' + estadoTrasCaer);
  check('camino 2 · el intento que se cayó NO tenía el arreglo (la línea de base)',
    String(dosAntes.userPrompt).indexOf('NADA de degradés') === -1);
  check('camino 2 · el reintento releyó el prompt del curso del disco',
    String(dos.userPrompt).indexOf('NADA de degradés') !== -1);
  check('camino 2 · y también las referencias: viaja una imagen más que antes',
    (dos.images || []).length === (dosAntes.images || []).length + 1,
    'antes: ' + (dosAntes.images || []).length + ' · reintento: ' + (dos.images || []).length);
  check('camino 2 · el de la CLASE sigue viajando', String(dos.userPrompt).indexOf('BLANCO Y NEGRO') !== -1);

  // ═══ Camino 3: ↻ Aplicar el ajuste, desde la caja de feedback ═════
  //
  // Se dibuja la Cola de VERDAD y se aprieta el botón: el camino entero, no
  // HPQueue.regenerate a mano.
  const hecho = ctx.HPQueue.jobs().filter((j) => j.markerKey === 'Marcador 1')[0];
  hecho.status = 'done';
  hecho.version = 1;
  ctx.HPQueueView.render(ctx.HPQueue.jobs());
  const panel = ctx.__nodos['queue-panel'];
  const btnFeedback = panel.porTexto('Feedback');
  if (!btnFeedback) throw new Error('la Cola no ofrece dar feedback en el job terminado');
  btnFeedback.click();

  const campoFb = panel.buscar('qj-fb-input') || panel.buscar('hp-campo');
  if (!campoFb) throw new Error('la caja de feedback no dibujó su campo');
  // Con una MENCIÓN adentro: es uno de los tres lugares donde ahora existen.
  const AJUSTE = 'El bloque del medio tapa la cara del profe: subilo y hacelo más chico. ' +
    'El celeste sacalo de @[curso/paleta-institucional.png].';
  campoFb.value = AJUSTE;
  campoFb.emitir('input');

  const btnAplicar = panel.porTexto('Aplicar el ajuste');
  if (!btnAplicar) throw new Error('la caja de feedback no tiene el botón de aplicar');
  const n3 = pedidos.length;
  btnAplicar.click();
  const tres = await esperarPedido(n3, 'camino 3');
  await dejarCorrer();

  B('## Camino 3 — ↻ Aplicar el ajuste, en la caja de feedback de la Cola (prompt *lean*)');
  B('');
  B('`cep/js/queue-view.js:541` → `HPQueue.regenerate(id, texto, sendIdx)` → `mode:');
  B('"adjust"` → `engine.prepareFeedback` con `lean = true`. Se dibujó la Cola de verdad y');
  B('se apretó el botón; el texto se escribió en el campo real de la caja.');
  B('');
  bloque('Lo que el editor escribió en la caja:', AJUSTE);
  bloque('La sección del refinamiento, como llegó:',
    (function () {
      const up = String(tres.userPrompt || '');
      const d = up.indexOf('## Refinamiento sobre la versión previa');
      if (d === -1) return null;
      const h = up.indexOf('### Versión previa (HTML)', d);
      return up.slice(d, h === -1 ? undefined : h).trim();
    })());
  bloque('Los dos niveles del estilo, que también viajan al refinar:', [
    seccion(tres.userPrompt, 'Prompt general del curso (aplica a TODAS las clases)'),
    '',
    seccion(tres.userPrompt, 'Prompt de esta secuencia (aplica a TODOS los marcadores de esta clase)'),
  ].join('\n'));
  bloque('Y el fragmento del marcador, que viaja SIEMPRE:',
    seccion(tres.userPrompt, 'Fragmento del marcador "Marcador 1"'));
  B('Secciones del prompt *lean*: **sin** «Transcript completo de la clase», **con**');
  B('«Fragmento del marcador». Es la optimización, y es lo único que cambia.');
  B('');

  const refin3 = String(tres.userPrompt).slice(String(tres.userPrompt).indexOf('### Nueva instrucción'));
  check('camino 3 · es lean: NO reenvía el transcript completo de la clase',
    !tiene(tres.userPrompt, 'Transcript completo de la clase (contexto general)'));
  check('camino 3 · pero el fragmento del marcador SÍ viaja',
    tiene(tres.userPrompt, 'Fragmento del marcador "Marcador 1"'));
  check('camino 3 · los dos niveles del estilo viajan al refinar',
    String(tres.userPrompt).indexOf('Paleta azul institucional') !== -1 &&
    String(tres.userPrompt).indexOf('BLANCO Y NEGRO') !== -1);
  check('camino 3 · el ajuste llega como nueva instrucción', refin3.indexOf('tapa la cara del profe') !== -1);
  check('camino 3 · la mención escrita en la CAJA DE FEEDBACK se traduce',
    refin3.indexOf('@[') === -1 && /celeste sacalo de imagen \d/.test(refin3), refin3.slice(0, 300));
  check('camino 3 · y las imágenes viajan igual que al generar', (tres.images || []).length > 0,
    (tres.images || []).length + ' imagen(es)');

  // ═══ Camino 8b: el estimado de la COLA contra lo que viajó ════════
  const jobFb = ctx.HPQueue.jobs().filter((j) => j.markerKey === 'Marcador 1')[0];
  const cuerpoCola = await ctx.HPQueue.payloadForEstimate(jobFb);
  const estCola = engine.estimateTokens(cuerpoCola);
  const charsReales3 = String(tres.systemPrompt || '').length + String(tres.userPrompt || '').length;

  // ═══ Camino 4: ⟲ Regenerar desde cero ════════════════════════════
  const hecho4 = ctx.HPQueue.jobs().filter((j) => j.markerKey === 'Marcador 1')[0];
  hecho4.status = 'done';
  hecho4.version = 2;
  ctx.__confirmaciones.length = 0;
  ctx.HPQueueView.render(ctx.HPQueue.jobs());
  const panel4 = ctx.__nodos['queue-panel'];
  panel4.porTexto('Feedback').click();
  const btnDesdeCero = panel4.porTexto('Regenerar desde cero');
  if (!btnDesdeCero) throw new Error('la caja de feedback no tiene el botón de desde cero');
  btnDesdeCero.click();
  const confirmacion = ctx.__confirmaciones[0];
  if (!confirmacion) throw new Error('"Regenerar desde cero" no preguntó: tiene que confirmar');
  const n4 = pedidos.length;
  confirmacion.aceptar();
  const cuatro = await esperarPedido(n4, 'camino 4');
  await dejarCorrer();

  B('## Camino 4 — ⟲ Regenerar desde cero');
  B('');
  B('`cep/js/queue-view.js:567` → confirmación → `HPQueue.regenerateFresh(id)` → `mode:');
  B('"regen"`. Nada del pasado viaja: ni la versión previa, ni el ajuste de la ronda');
  B('anterior, ni la selección de imágenes de esa ronda.');
  B('');
  B('Antes de hacer nada preguntó: **«' + confirmacion.titulo + '»** (botón «' +
    confirmacion.boton + '»). Se aceptó a mano.');
  B('');
  bloque('Los tres niveles, como llegaron:', [
    seccion(cuatro.userPrompt, 'Prompt general del curso (aplica a TODAS las clases)'),
    '',
    seccion(cuatro.userPrompt, 'Prompt de esta secuencia (aplica a TODOS los marcadores de esta clase)'),
    '',
    seccion(cuatro.userPrompt, 'Instrucción del editor (específica de este marcador)'),
  ].join('\n'));
  B('Secciones: **con** «Transcript completo de la clase» (no es lean) y **sin**');
  B('«Refinamiento sobre la versión previa».');
  B('');

  const insCuatro = seccion(cuatro.userPrompt, 'Instrucción del editor (específica de este marcador)');
  check('camino 4 · vuelve el transcript completo (desde cero no es lean)',
    tiene(cuatro.userPrompt, 'Transcript completo de la clase (contexto general)'));
  check('camino 4 · no arrastra el refinamiento de la ronda anterior',
    String(cuatro.userPrompt).indexOf('Refinamiento sobre la versión previa') === -1);
  check('camino 4 · no arrastra el ajuste de la ronda anterior',
    String(cuatro.userPrompt).indexOf('tapa la cara del profe') === -1);
  check('camino 4 · los tres niveles viajan',
    String(cuatro.userPrompt).indexOf('Paleta azul institucional') !== -1 &&
    String(cuatro.userPrompt).indexOf('BLANCO Y NEGRO') !== -1 &&
    insCuatro.indexOf('Tres bloques') !== -1);
  check('camino 4 · y las menciones de la instrucción siguen traducidas',
    insCuatro.indexOf('@[') === -1 && /disposición de imagen 1/.test(insCuatro), insCuatro);

  // ═══ Camino 5: Corrections ═══════════════════════════════════════
  //
  // El recurso nació en SEQ y el editor está parado en SEQ_ABIERTA: es el caso
  // CRUZADO, y tienen que viajar los prompts y las referencias de la de ORIGEN.
  // La pestaña se carga de verdad y se aprieta el botón de la fila.
  ctx.__nodos['btn-load-corrections'].click();
  for (let i = 0; i < 200 && !ctx.__nodos['corr-list'].children.length; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const filas = ctx.__nodos['corr-list'].children.filter(
    (c) => String(c.className).indexOf('corr-row') === 0);
  if (!filas.length) throw new Error('la pestaña de correcciones no dibujó ninguna fila');
  const fila = filas[0];

  const campoCorr = fila.buscar('corr-input') || fila.porPrefijo('hp-campo');
  if (!campoCorr) throw new Error('la fila no dibujó su campo de corrección');
  const CORRECCION = 'El título entra muy rápido: dale medio segundo más. ' +
    'Y el azul tomalo de @[curso/manual-de-marca-nova.png].';
  campoCorr.value = CORRECCION;
  campoCorr.emitir('input');

  const btnCorr = fila.porPrefijo('qbtn qbtn-react');
  if (!btnCorr) throw new Error('la fila no tiene el botón de regenerar');
  const n5a = pedidos.length;
  btnCorr.click();
  const cincoA = await esperarPedido(n5a, 'camino 5a (Corrections sin ajuste local)');
  await dejarCorrer();

  // Y ahora CON ajuste local de los prompts: se edita el panel de "lo que recibió
  // este marcador" y se manda de nuevo.
  const panelPrompts = fila.buscar('corr-prompts');
  let niveles = [];
  let etiquetaAntes = '';
  let etiquetaDespues = '';
  const CURSO_AJUSTADO = CURSO_ARREGLADO + '\nPARA ESTA CORRECCIÓN: sin glow y sin degradés.';
  const SEQ_AJUSTADA = SECUENCIA + '\nY PARA ESTA CORRECCIÓN: los carteles ocupan media pantalla.';
  let cincoB = null;
  if (panelPrompts) {
    const tag = panelPrompts.porPrefijo('corr-prompts-tag');
    etiquetaAntes = tag ? String(tag.textContent) : '';
    niveles = panelPrompts.buscarTodos('corr-level');
    function ajustar(i, texto) {
      const campo = niveles[i] && niveles[i].buscar('corr-level-input');
      if (!campo) return;
      campo.value = texto;
      campo.emitir('input');
    }
    ajustar(0, CURSO_AJUSTADO);
    ajustar(1, SEQ_AJUSTADA);
    etiquetaDespues = tag ? String(tag.textContent) : '';
    campoCorr.value = CORRECCION;
    campoCorr.emitir('input');
    const n5b = pedidos.length;
    btnCorr.click();
    cincoB = await esperarPedido(n5b, 'camino 5b (Corrections con ajuste local)');
    await dejarCorrer();
  }

  B('## Camino 5 — Corrections, con y sin ajuste local, y el caso CRUZADO');
  B('');
  B('`cep/js/corrections.js:216` → `mode: "adjust"` + `promptOverride` + `storeSeqName`.');
  B('El recurso nació en **' + SEQ + '** y el panel está parado en **' + SEQ_ABIERTA + '**:');
  B('tienen que viajar los prompts y las referencias de la de ORIGEN.');
  B('');
  bloque('Lo que el editor escribió en la fila:', CORRECCION);
  bloque('### 5a · Sin ajuste local — los dos niveles, como llegaron:', [
    seccion(cincoA.userPrompt, 'Prompt general del curso (aplica a TODAS las clases)'),
    '',
    seccion(cincoA.userPrompt, 'Prompt de esta secuencia (aplica a TODOS los marcadores de esta clase)'),
  ].join('\n'));
  bloque('Y la corrección, traducida:',
    (function () {
      const up = String(cincoA.userPrompt || '');
      const d = up.indexOf('### Nueva instrucción');
      if (d === -1) return null;
      const h = up.indexOf('### Versión previa (HTML)', d);
      return up.slice(d, h === -1 ? undefined : h).trim();
    })());
  B('Con ' + (cincoA.images || []).length + ' imagen(es): las del CURSO y las de la secuencia');
  B('de ORIGEN, no las del corte abierto.');
  B('');

  const refin5a = String(cincoA.userPrompt).slice(String(cincoA.userPrompt).indexOf('### Nueva instrucción'));
  check('camino 5a · viaja el prompt del curso',
    String(cincoA.userPrompt).indexOf('Paleta azul institucional') !== -1);
  check('camino 5a · viaja el prompt de la secuencia de ORIGEN',
    String(cincoA.userPrompt).indexOf('BLANCO Y NEGRO') !== -1);
  check('camino 5 · CRUZADO: NO viaja el prompt del corte abierto',
    String(cincoA.userPrompt).indexOf('NO TIENE QUE VIAJAR') === -1);
  check('camino 5a · la mención escrita en la FILA de Corrections se traduce',
    refin5a.indexOf('@[') === -1 && /azul tomalo de imagen \d/.test(refin5a), refin5a.slice(0, 300));
  check('camino 5a · es lean (es un refinado)',
    !tiene(cincoA.userPrompt, 'Transcript completo de la clase (contexto general)'));

  if (cincoB) {
    B('### 5b · Con los prompts ajustados a mano para esta corrección');
    B('');
    B('El renglón plegado de la fila pasa de dato a ajuste:');
    B('');
    B('```');
    B('antes:   ' + etiquetaAntes);
    B('después: ' + etiquetaDespues);
    B('```');
    B('');
    bloque('Los dos niveles, como llegaron con el ajuste:', [
      seccion(cincoB.userPrompt, 'Prompt general del curso (aplica a TODAS las clases)'),
      '',
      seccion(cincoB.userPrompt, 'Prompt de esta secuencia (aplica a TODOS los marcadores de esta clase)'),
    ].join('\n'));
    bloque('Y lo que el motor anotó en el ⬇ Log:',
      notas.filter((n) => /ajustado a mano/i.test(n)).slice(-2).join('\n') || '(nada)');

    const cursoEnDisco = fs.readFileSync(rutas.project, 'utf8').trim();
    const seqEnDisco = fs.readFileSync(rutas.sequence, 'utf8').trim();
    check('camino 5b · el ajuste del CURSO llegó al prompt',
      String(cincoB.userPrompt).indexOf('sin glow y sin degradés') !== -1);
    check('camino 5b · el ajuste de la SECUENCIA llegó al prompt',
      String(cincoB.userPrompt).indexOf('ocupan media pantalla') !== -1);
    check('camino 5b · y el log lo dice', notas.some((n) => /ajustado a mano/i.test(n)));
    check('camino 5b · los archivos del proyecto NO se tocaron',
      cursoEnDisco === CURSO_ARREGLADO.trim() && seqEnDisco === SECUENCIA.trim(),
      'curso: ' + JSON.stringify(cursoEnDisco.slice(-40)) + ' · clase: ' + JSON.stringify(seqEnDisco.slice(-40)));
  } else {
    B('### 5b · Con los prompts ajustados a mano');
    B('');
    B('**No se pudo ejercitar**: la fila no dibujó el panel de «lo que recibió este');
    B('marcador».');
    B('');
    check('camino 5b · la fila dibuja el panel de lo que recibió el marcador', false);
  }

  // ═══ Camino 6: render manual de HTML ═════════════════════════════
  const antesDeRender = pedidos.length;
  const HTML_A_MANO = COMPOSICION.replace('</body>',
    '<div class="editado-a-mano">esto lo escribió el editor, no el modelo</div></body>');
  const jobManual = {
    kind: 'renderManualHtml',
    payload: {
      projectPath: proyecto, sequenceName: SEQ,
      marker: { name: 'Marcador 1', start: 10, end: 16, duration: 6 },
      markerSlug: 'Marcador 1', html: HTML_A_MANO, background: false,
    },
    seqName: SEQ, projectPath: proyecto, markerKey: 'Marcador 1',
    label: 'Marcador 1 (HTML a mano)', markerStart: 10, markerDuration: 6,
  };
  // Se encola el job, y no se aprieta el botón de la fila: el editor de HTML de
  // Corrections se apoya en `HPWidgets.makeCodeEditor` (Prism), que acá es un
  // doble, así que apretarlo probaría el doble. El job es exactamente el que arma
  // corrections.js:277 — mismo `kind`, mismo payload— y de ahí en adelante el
  // camino es el de verdad: la cola, el motor y el render.
  ctx.HPQueue.add(jobManual);
  // Éste es el único camino que RENDERIZA de verdad (la ficha se escribe cuando
  // el render sale bien), así que se lo espera a que termine en vez de dejar
  // correr un rato: la cola es serial y lo que venga detrás se queda esperando.
  const idManual = (ctx.HPQueue.jobs().filter((j) => j.kind === 'renderManualHtml')[0] || {}).id;
  for (let i = 0; i < 2400; i++) {
    const j = ctx.HPQueue.jobs().filter((x) => x.id === idManual)[0];
    if (!j || j.status === 'done' || j.status === 'error' || j.status === 'placed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await dejarCorrer(60);
  const pedidosDespuesDeRender = pedidos.length;

  // La carpeta de esta secuencia: es la que contiene a `_referencias`.
  const dirSeq = path.dirname(
    engine.loadReferences({ projectPath: proyecto, sequenceName: SEQ }).paths.sequence);
  const fichas = fs.existsSync(dirSeq)
    ? fs.readdirSync(dirSeq).filter((f) => /\.meta\.json$/.test(f)).sort()
    : [];
  const fichaManual = fichas
    .map((f) => ({ f: f, j: JSON.parse(fs.readFileSync(path.join(dirSeq, f), 'utf8')) }))
    .filter((x) => /manual/i.test(String(x.j.mode || '')))
    .slice(-1)[0] || null;

  B('## Camino 6 — Render manual de HTML (no llama al modelo)');
  B('');
  B('`cep/js/corrections.js:277` → `kind: "renderManualHtml"` → `engine.renderManualHtml`.');
  B('Es el único de los ocho que RENDERIZA de verdad acá: la ficha se escribe cuando el');
  B('render sale bien, así que sin render no habría ficha que mirar.');
  B('');
  B('Pedidos al proveedor antes: **' + antesDeRender + '** · después: **' +
    pedidosDespuesDeRender + '**.');
  B('');
  bloque('La ficha que escribió (`' + (fichaManual ? fichaManual.f : '?') + '`), en lo que dice del modelo:',
    fichaManual
      ? JSON.stringify({
        mode: fichaManual.j.mode, model: fichaManual.j.model, provider: fichaManual.j.provider,
        instruction: fichaManual.j.instruction, prompts: fichaManual.j.prompts,
        usage: fichaManual.j.usage, timings: fichaManual.j.timings,
      }, null, 2)
      : null);
  B('Las fichas de la carpeta, para ver la de este render al lado de las otras:');
  B('');
  B('```');
  fichas.forEach((f) => B('  ' + f));
  B('```');
  B('');

  check('camino 6 · NO llamó al modelo', pedidosDespuesDeRender === antesDeRender,
    antesDeRender + ' → ' + pedidosDespuesDeRender);
  check('camino 6 · dejó una ficha del render manual', !!fichaManual,
    'fichas en la carpeta: ' + fichas.join(', '));
  if (fichaManual) {
    // La ficha no puede quedar muda —quien la lea tiene que saber de dónde salió
    // ese clip— y tampoco puede atribuirle a un modelo un diseño que escribió el
    // editor. Dice `manual` en los tres campos, y eso es lo correcto.
    check('camino 6 · la ficha dice MANUAL donde iría el modelo, no un modelo',
      fichaManual.j.model === 'manual' && fichaManual.j.provider === 'manual' &&
      fichaManual.j.mode === 'manual-edit',
      JSON.stringify({ model: fichaManual.j.model, provider: fichaManual.j.provider, mode: fichaManual.j.mode }));
    check('camino 6 · y NO se atribuye prompts que nadie mandó',
      fichaManual.j.prompts === undefined || fichaManual.j.prompts === null,
      JSON.stringify(fichaManual.j.prompts));
    check('camino 6 · ni tokens, ni tiempo de modelo',
      !fichaManual.j.usage && fichaManual.j.timings && fichaManual.j.timings.modelMs === 0,
      JSON.stringify({ usage: fichaManual.j.usage, timings: fichaManual.j.timings }));
    check('camino 6 · pero SÍ hereda el encargo del recurso (no lo borra)',
      String(fichaManual.j.instruction || '').indexOf('Tres bloques') !== -1,
      JSON.stringify(String(fichaManual.j.instruction || '').slice(0, 80)));
  }

  // ═══ Camino 7: la derivación del objetivo de la clase ════════════
  const n7 = pedidos.length;
  const derivado = await engine.deriveObjective({ transcript: TRANSCRIPT });
  const siete = await esperarPedido(n7, 'camino 7');

  B('## Camino 7 — La derivación del objetivo de la clase');
  B('');
  B('`engine.deriveObjective`. Es su propio prompt: no lleva los tres niveles del');
  B('estilo ni referencias, porque lo único que tiene que contestar es qué se enseña en');
  B('esta clase. Lo que importa acá es que NO arrastre nada de lo otro (sería pagar');
  B('tokens de estilo para derivar una frase) y que le llegue el transcript.');
  B('');
  bloque('System prompt:', siete.systemPrompt);
  bloque('User prompt:', siete.userPrompt);
  B('Devolvió: `' + JSON.stringify(derivado.objective) + '`.');
  B('');

  check('camino 7 · el transcript le llega',
    String(siete.userPrompt).indexOf('tres componentes') !== -1);
  check('camino 7 · no arrastra los prompts del estilo',
    String(siete.userPrompt).indexOf('Paleta azul institucional') === -1 &&
    String(siete.userPrompt).indexOf('BLANCO Y NEGRO') === -1);
  check('camino 7 · no manda imágenes', !(siete.images || []).length);

  // ═══ Camino 8: el estimador de tokens ═══════════════════════════
  const desvioFicha = Math.abs(estFicha.breakdown.promptChars - charsReales) / charsReales;
  const desvioCola = Math.abs(estCola.breakdown.promptChars - charsReales3) / charsReales3;

  B('## Camino 8 — El estimador de tokens, en la ficha y en la Cola');
  B('');
  B('`cep/js/main.js:1873` → `estimateTokens(buildMarkerPayload(...))` (la ficha) y');
  B('`cep/js/queue-view.js:405` → `HPQueue.payloadForEstimate(job)` → `estimateTokens`');
  B('(la Cola). Se comparan contra los caracteres que DE VERDAD viajaron en los caminos');
  B('1 y 3, que es el número que el estimador promete.');
  B('');
  bloque('La ficha, contra el pedido del camino 1:', [
    'estimado   promptChars = ' + estFicha.breakdown.promptChars +
      '   imágenes = ' + estFicha.breakdown.images +
      '   documentos = ' + estFicha.breakdown.resources,
    'real       promptChars = ' + charsReales +
      '   imágenes = ' + (uno.images || []).length,
    'desvío     ' + (desvioFicha * 100).toFixed(2) + ' %',
    '',
    'inputTokensEst = ' + estFicha.inputTokensEst,
    '',
    'menciones que el estimador dice haber traducido:',
    JSON.stringify(estFicha.menciones, null, 2),
  ].join('\n'));
  bloque('La Cola, contra el pedido del camino 3 (el refinado lean):', [
    'estimado   promptChars = ' + estCola.breakdown.promptChars +
      '   imágenes = ' + estCola.breakdown.images,
    'real       promptChars = ' + charsReales3 +
      '   imágenes = ' + (tres.images || []).length,
    'desvío     ' + (desvioCola * 100).toFixed(2) + ' %',
    '',
    'inputTokensEst = ' + estCola.inputTokensEst,
  ].join('\n'));
  B('El estimado de un refinado queda CORTO a propósito y se sabe por qué: el HTML de la');
  B('versión previa se le suma al prompt recién al generar (el panel no lo tiene en el');
  B('payload), y eso está escrito en `estimateTokens`. Lo que no puede pasar es que quede');
  B('corto por los NIVELES del estilo o por las menciones, que es lo que se mide acá.');
  B('');

  check('camino 8 · la ficha estima con los dos niveles del estilo puestos',
    estFicha.breakdown.promptChars >= charsReales - 40 && estFicha.breakdown.promptChars <= charsReales + 40,
    'estimado ' + estFicha.breakdown.promptChars + ' vs real ' + charsReales);
  check('camino 8 · la ficha cuenta las imágenes que viajan',
    estFicha.breakdown.images === (uno.images || []).length,
    estFicha.breakdown.images + ' vs ' + (uno.images || []).length);
  check('camino 8 · la ficha traduce las menciones para estimar',
    (estFicha.menciones.traducidas || []).length >= 4,
    JSON.stringify(estFicha.menciones.traducidas));
  check('camino 8 · y dice los problemas de las que no pudo',
    (estFicha.menciones.problemas || []).length >= 1,
    JSON.stringify(estFicha.menciones.problemas));
  check('camino 8 · la Cola estima el refinado sin el HTML previo, y no por menos',
    estCola.breakdown.promptChars <= charsReales3 &&
    estCola.breakdown.promptChars >= charsReales3 * 0.4,
    'estimado ' + estCola.breakdown.promptChars + ' vs real ' + charsReales3);
  check('camino 8 · la Cola cuenta las imágenes del refinado',
    estCola.breakdown.images === (tres.images || []).length,
    estCola.breakdown.images + ' vs ' + (tres.images || []).length);

  // ═══ Las menciones por los tres lugares, y el reordenamiento ═════
  //
  // Los casos borde que faltan: la instrucción vieja en texto plano (que NO se
  // toca) y el reordenamiento (agregar una imagen ADELANTE corre los números y la
  // mención sigue apuntando a la misma imagen).
  const VIEJA = 'Un checklist de cinco puntos. Los tildes como en la imagen 2.';
  S.setMarkerInstruction('Marcador 5', VIEJA);
  const n9 = pedidos.length;
  ctx.HPQueue.add(jobDeLaFicha(ctx, proyecto, 'Marcador 5', 'generate'));
  const plana = await esperarPedido(n9, 'texto plano');
  await dejarCorrer();

  S.setMarkerInstruction('Marcador 6',
    'La tipografía de @[curso/manual-de-marca-nova.png] y el encuadre de ' +
    '@[clase/captura-programa-00-03-41.png].');
  const n10 = pedidos.length;
  ctx.HPQueue.add(jobDeLaFicha(ctx, proyecto, 'Marcador 6', 'generate'));
  const antesDeReordenar = await esperarPedido(n10, 'antes de reordenar');
  await dejarCorrer();

  S.addMarkerStill('Marcador 6', PNG_1PX, 'captura-que-se-cuela-primera.png');
  const n11 = pedidos.length;
  ctx.HPQueue.add(jobDeLaFicha(ctx, proyecto, 'Marcador 6', 'generate'));
  const despuesDeReordenar = await esperarPedido(n11, 'después de reordenar');
  await dejarCorrer();

  const insPlana = seccion(plana.userPrompt, 'Instrucción del editor (específica de este marcador)');
  const insAntes = seccion(antesDeReordenar.userPrompt, 'Instrucción del editor (específica de este marcador)');
  const insDespues = seccion(despuesDeReordenar.userPrompt, 'Instrucción del editor (específica de este marcador)');

  B('## Las menciones, por los tres lugares donde existen');
  B('');
  B('Los tres campos que hoy llevan menciones son la **ficha del marcador**, la **caja de');
  B('feedback de la Cola** y la **fila de Corrections**. Los tres se ejercitaron arriba');
  B('escribiendo en el campo real de cada uno:');
  B('');
  B('- ficha → camino 1 y camino 4');
  B('- caja de feedback de la Cola → camino 3');
  B('- fila de Corrections → camino 5a');
  B('');
  B('Y los casos borde:');
  B('');
  bloque('La mención COLGADA (la referencia ya no está en la lista) y el DOCUMENTO,\nlos dos en la instrucción del camino 1:', insUno);
  bloque('Una instrucción vieja, con «imagen 2» en texto plano: viaja INTACTA', insPlana);
  bloque('Reordenar — la MISMA instrucción, antes y después de agregarle una imagen\nal marcador (no se tocó una coma):',
    'antes:   ' + insAntes + '\n\ndespués: ' + insDespues);

  check('menciones · la instrucción vieja en texto plano no se toca',
    insPlana.indexOf('como en la imagen 2') !== -1, insPlana);
  check('menciones · reordenar corre los números y la mención sigue en su imagen',
    /tipografía de imagen 1/.test(insAntes) && /tipografía de imagen 2/.test(insDespues),
    'antes: ' + insAntes + ' · después: ' + insDespues);
  check('menciones · y la de la clase también se corre',
    /encuadre de imagen 4/.test(insAntes) && /encuadre de imagen 5/.test(insDespues),
    'antes: ' + insAntes + ' · después: ' + insDespues);

  // La que el disco no tiene: se borra el archivo y se relee.
  fs.unlinkSync(path.join(rutasRefs.course, 'paleta-institucional.png'));
  S.setMarkerInstruction('Marcador 7',
    'El embudo en cuatro escalones, con los colores de @[curso/paleta-institucional.png].');
  await ctx.HPRefs.load(proyecto, SEQ);
  const n12 = pedidos.length;
  ctx.HPQueue.add(jobDeLaFicha(ctx, proyecto, 'Marcador 7', 'generate'));
  const sinDisco = await esperarPedido(n12, 'la que el disco no tiene');
  await dejarCorrer();
  const insSinDisco = seccion(sinDisco.userPrompt, 'Instrucción del editor (específica de este marcador)');

  bloque('La que el manifiesto nombra y el disco NO tiene (disco externo desmontado):', insSinDisco);
  bloque('Y el aviso que salió al log antes de gastar la llamada:',
    notas.filter((n) => /no se pudieron leer del disco|menci/i.test(n)).slice(-3).join('\n') || '(nada)');

  check('menciones · la que el disco no tiene no recibe número, y se dice',
    insSinDisco.indexOf('no se pudo leer del disco') !== -1, insSinDisco);
  check('menciones · y el aviso de siempre sobre las que no se leyeron sigue saliendo',
    notas.some((n) => /NO se pudieron leer del disco/i.test(n)));

  // ── El veredicto ───────────────────────────────────────────────────
  B('## Comprobaciones');
  B('');
  CHECKS.forEach((c) => {
    B((c.ok ? '- ✅ ' : '- ❌ ') + c.nombre + (c.ok || !c.detalle ? '' : '\n      ↳ ' + c.detalle));
  });
  B('');
  const fallaron = CHECKS.filter((c) => !c.ok);
  B(fallaron.length
    ? '**' + fallaron.length + ' de ' + CHECKS.length + ' comprobación(es) en rojo.**'
    : '**Las ' + CHECKS.length + ' en verde.**');
  B('');

  const texto = P.join('\n') + '\n';
  if (salida) {
    fs.writeFileSync(salida, texto, 'utf8');
    console.log('Escrito en ' + salida);
    console.log(fallaron.length
      ? fallaron.length + '/' + CHECKS.length + ' en rojo: ' + fallaron.map((c) => c.nombre).join(' · ')
      : CHECKS.length + '/' + CHECKS.length + ' en verde');
  } else {
    console.log(texto);
  }
  if (fallaron.length) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(String((e && e.stack) || e));
  process.exitCode = 1;
});
