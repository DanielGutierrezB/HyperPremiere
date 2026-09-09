'use strict';

// Qué texto recibe DE VERDAD el modelo con los tres niveles puestos.
//
//   node test/manual/prompt-tres-niveles.js [--out archivo.md]
//
// Los tests fijan el contrato pieza por pieza; esto es la otra pregunta, la que
// se hace mirando el resultado de un recurso: ¿llegaron los tres, en este orden,
// y dice quién manda cuando se contradicen? Se contesta armando un pedido de
// punta a punta y volcando el prompt exacto.
//
// De punta a punta quiere decir: un proyecto de verdad en un temporal con sus
// dos archivos, el PANEL de verdad montado como lo carga el navegador (HPStore +
// HPGeneral + HPQueue), la cola releyendo el disco al momento de generar, y el
// MOTOR de verdad armando el pedido con su system.md y su build-context. Lo
// único falso es el proveedor: en vez de llamar al modelo, anota lo que le
// habría mandado. Es el último eslabón antes de la nube, así que lo que se
// imprime acá es literalmente lo que se paga.
//
// Escenario, el real del README: el curso pide paleta azul institucional y esta
// clase va en blanco y negro.
//
// Y después la segunda pregunta, la de la pestaña de correcciones: si el editor
// abre ese recurso, ve el contexto con el que se generó y lo AJUSTA a mano para
// esa corrección, ¿llega el ajuste al modelo? Es el punto donde esto se puede
// volver decorativo, porque la cola relee los prompts del disco justo antes de
// generar. Así que la segunda parte va de punta a punta también, y con la pestaña
// de verdad montada: se lista el recurso desde el disco (con lo que su ficha
// guardó), se editan los tres campos, se aprieta ↻ Regenerar y se vuelca el
// prompt que salió. Al final se comprueba que los archivos del proyecto siguen
// diciendo lo mismo que antes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

// La config del modelo vive en ~/.hyperpremiere y este script la escribe (para
// apuntar al proveedor falso), así que HOME va a un temporal ANTES de cargar el
// motor, que la resuelve al requerirse. Sin esto, correr esto le cambiaría el
// proveedor al panel del editor.
const CASA = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-home-'));
process.env.HOME = CASA;
process.env.USERPROFILE = CASA;

const engine = require('../../bridge/engine.js');

const RAIZ = path.join(__dirname, '..', '..');
const CEP = path.join(RAIZ, 'cep', 'js');
// Lo que require() le va a pedir cuando el proveedor activo sea 'ollama'.
const RUTA_PROVEEDOR = path.join(RAIZ, 'bridge', 'providers', 'ollama.js');

const CURSO =
  'Marca ACADEMIA NOVA. Tipografía Söhne para títulos, Inter para cuerpo.\n' +
  'Paleta azul institucional: fondo #0b1b3a, acento #2f6fd0, texto hueso #efeadf.\n' +
  'Todo entra por la derecha; nunca tapar la cara del profe (izquierda, mitad inferior).';

const SECUENCIA =
  'Esta clase va en BLANCO Y NEGRO: es el módulo de fotografía y el color pelea con los ejemplos.\n' +
  'El logo va arriba a la izquierda en esta clase, no abajo a la derecha.';

const MARCADOR = 'Un cartel con los tres componentes, que aparezcan de a uno cuando los nombra.';

// Una composición que cumple el contrato: el proveedor falso tiene que devolver
// algo renderizable o la escalera de compose.js reintenta y no se llega al final.
const COMPOSICION = '<!DOCTYPE html><html><body>' +
  '<div id="stage" data-composition-id="marcador-1" data-start="0" data-width="1920" ' +
  'data-height="1080" data-duration="6" data-fps="30"></div>' +
  '<script>const tl = gsap.timeline({ paused: true }); window.__timelines["marcador-1"] = tl;</script>' +
  '</body></html>';

/** El proveedor falso: no llama a nadie y se queda con lo que le pasaron. */
function proveedorEspia(anotar) {
  const mod = {
    exports: {
      generate: async function (arg) {
        anotar(arg);
        return { text: COMPOSICION, usage: { inputTokens: 1, outputTokens: 1, totalInputTokens: 1 } };
      },
      complete: async function (arg) { anotar(arg); return { text: '', usage: {} }; },
    },
    loaded: true,
    id: RUTA_PROVEEDOR,
    filename: RUTA_PROVEEDOR,
    paths: [],
    children: [],
  };
  require.cache[RUTA_PROVEEDOR] = mod;
}

// Lo que el editor escribe encima, en la fila de correcciones, para ESE pedido.
const CURSO_AJUSTADO = CURSO +
  '\nPara este cartel: NADA de degradés ni de glow, que en el proyector se ven sucios.';
const SECUENCIA_AJUSTADA = SECUENCIA +
  '\nY en este módulo los carteles ocupan media pantalla, no el ancho completo.';
const OBJETIVO_AJUSTADO = 'Que el estudiante pueda NOMBRAR los tres componentes sin mirar la pantalla.';

// ── Un DOM mínimo, para poder montar la pestaña de verdad ────────────
// Es la única forma de que el ajuste salga del mismo lugar del que sale cuando lo
// hace el editor: un textarea que se edita y un botón que se aprieta.

function elemento(tag) {
  const el = {
    tagName: tag, children: [], listeners: {}, style: {},
    className: '', textContent: '', value: '', title: '',
    appendChild: function (h) { this.children.push(h); return h; },
    setAttribute: function (k, v) { this[k] = v; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    emitir: function (ev) { (this.listeners[ev] || []).forEach(function (f) { f(); }); },
    click: function () { this.emitir('click'); },
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
  };
  Object.defineProperty(el, 'innerHTML', { get: function () { return ''; }, set: function () { el.children.length = 0; } });
  return el;
}

/** El panel, con los módulos de verdad y el motor de verdad detrás. */
function montarPanel(proyecto, notas) {
  const almacen = {};
  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Object: Object, Array: Array, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(almacen, k) ? almacen[k] : null; },
      setItem: function (k, v) { almacen[k] = String(v); },
      removeItem: function (k) { delete almacen[k]; },
    },
    HPLog: { log: function () {} },
    HPConfigUI: { isLocalProvider: function () { return true; }, modelName: function () { return 'falso'; } },
    HPTranscript: { sliceForMarker: function (segs) { return segs || []; } },
    HPHost: { placeClip: function (mov, seq, s, d, c, a, cb) { cb('ok'); } },
    HPEngine: {
      call: function (m, arg) {
        if (m === 'loadGeneralPrompt') return Promise.resolve(engine.loadGeneralPrompt(arg));
        if (m === 'saveGeneralPrompt') return Promise.resolve(engine.saveGeneralPrompt(arg));
        if (m === 'listCorrections') return Promise.resolve(engine.listCorrections(arg));
        if (m === 'readMarkerHtml') return Promise.resolve(engine.readMarkerHtml(arg));
        if (m === 'loadTranscript') return Promise.resolve({ ok: true, found: false });
        if (m === 'mediaHasAudio') return Promise.resolve({ ok: true, hasAudio: false });
        return Promise.resolve({ ok: true });
      },
      callProg: function (m, arg, onP) {
        if (m === 'prepareGenerate' || m === 'prepareFeedback') {
          // Las notas del motor son la otra evidencia: ahí se anota qué niveles
          // entraron, que es la línea que se mira en el ⬇ Log del editor.
          const fn = m === 'prepareGenerate' ? engine.prepareGenerate : engine.prepareFeedback;
          return fn(arg, function (p) {
            if (p && p.note) notas.push(p.note);
            if (onP) onP(p);
          });
        }
        // El render no aporta nada a esta pregunta y necesita el binario.
        if (m === 'renderPrepared') return Promise.resolve({ ok: true, movPath: '/tmp/x.mov', version: 1 });
        return Promise.resolve({ ok: true });
      },
    },
    // Lo que la pestaña de correcciones necesita del panel, reducido a lo que
    // hace falta para dibujar una fila y apretarle el botón.
    HPStills: {
      fbInit: function () {}, fbClear: function () {}, fbCollect: function () { return []; },
      createControl: function () { return elemento('div'); },
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
      // Este script no aprieta el guardado explícito: si algo lo llamara, es un
      // bug y tiene que reventar acá, no escribir el archivo del curso.
      confirmOverlay: function () { throw new Error('acá NO se guarda nada en el proyecto'); },
    },
  };
  ctx.document = {
    createElement: elemento,
    getElementById: function (id) { return ctx.__nodos[id] || null; },
  };
  ctx.__nodos = {
    'corr-list': elemento('div'), 'corr-status': elemento('span'),
    'corr-picker': elemento('div'), 'btn-load-corrections': elemento('button'),
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'store.js', 'general-prompt.js', 'queue.js', 'corrections-contexto.js', 'corrections.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  ctx.HPStore.setContext(proyecto, 'Clase 12 · Fotografía');
  ctx.HPCorrections.init({
    context: function () { return { projectPath: proyecto, sequenceName: 'Clase 12 · Fotografía' }; },
    refreshContext: function (cb) { cb(); },
  });
  return ctx;
}

/** El primer descendiente cuya clase arranca con ese prefijo. */
function porClase(nodo, prefijo) {
  for (const h of nodo.children || []) {
    if (String(h.className).indexOf(prefijo) === 0) return h;
    const hit = porClase(h, prefijo);
    if (hit) return hit;
  }
  return null;
}

async function main() {
  const salidaIdx = process.argv.indexOf('--out');
  const salida = salidaIdx !== -1 ? process.argv[salidaIdx + 1] : '';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-tres-niveles-'));
  const proyecto = path.join(dir, 'Curso de IA.prproj');

  // 1. Los dos archivos, escritos como los escribe el panel.
  engine.saveGeneralPrompt({ projectPath: proyecto, text: CURSO, scope: 'project' });
  engine.saveGeneralPrompt({
    projectPath: proyecto, sequenceName: 'Clase 12 · Fotografía', text: SECUENCIA, scope: 'sequence',
  });
  const rutas = engine.loadGeneralPrompt({
    projectPath: proyecto, sequenceName: 'Clase 12 · Fotografía',
  }).paths;

  // 2. El proveedor falso y la config que lo elige.
  let visto = null;
  proveedorEspia(function (arg) { if (!visto) visto = arg; });
  engine.setConfig({ provider: 'ollama', model: 'falso' });

  // 3. El panel encola un marcador y la cola relee el disco antes de generar.
  const notas = [];
  const ctx = montarPanel(proyecto, notas);
  ctx.HPQueue.add({
    kind: 'generate',
    payload: {
      projectPath: proyecto, sequenceName: 'Clase 12 · Fotografía', mode: 'generate',
      markerSlug: 'Marcador 1', instruction: MARCADOR,
      objective: 'Que el estudiante reconozca los tres componentes de una automatización.',
      marker: { name: 'Marcador 1', start: 10, end: 16, duration: 6 },
      markerTranscript: [{ start: 10, end: 16, text: 'Toda automatización tiene los mismos tres componentes.' }],
      transcript: [{ start: 10, end: 16, text: 'Toda automatización tiene los mismos tres componentes.' }],
    },
    seqName: 'Clase 12 · Fotografía', projectPath: proyecto, markerKey: 'Marcador 1',
    label: 'Marcador 1', markerStart: 10, markerDuration: 6,
  });
  for (let i = 0; i < 400 && !visto; i++) await new Promise((r) => setTimeout(r, 25));
  if (!visto) throw new Error('el pedido nunca llegó al proveedor');

  // 4. La segunda mitad: el recurso ya existe en el disco y su ficha guardó con
  // qué contexto se generó. Se abre en la pestaña de correcciones, se ajustan los
  // tres niveles a mano y se manda. Lo que se está probando es que el ajuste
  // sobreviva a la relectura del disco que hace la cola.
  const fichaCruda = fs.readFileSync(
    path.join(path.dirname(proyecto), 'HyperPremiere', 'clase-12-fotografia', 'Marcador 1 v1 [falso].meta.json'), 'utf8');
  const ficha = JSON.parse(fichaCruda);

  let vistoCorr = null;
  proveedorEspia(function (arg) { if (visto) vistoCorr = vistoCorr || arg; else visto = arg; });

  ctx.__nodos['btn-load-corrections'].click();
  for (let i = 0; i < 100 && !ctx.__nodos['corr-list'].children.length; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const fila = ctx.__nodos['corr-list'].children.filter(
    (c) => String(c.className).indexOf('corr-row') === 0)[0];
  if (!fila) throw new Error('la pestaña de correcciones no dibujó la fila');

  const panel = fila.buscar('corr-prompts');
  if (!panel) throw new Error('la fila no muestra con qué contexto se generó');
  const etiqueta = porClase(panel, 'corr-prompts-tag').textContent;
  const niveles = panel.buscarTodos('corr-level');
  const leido = niveles.map((w) => ({
    rotulo: w.buscar('corr-level-label').textContent,
    valor: w.buscar('corr-level-input').value,
  }));

  // Editar como el editor: se cambia el texto y se avisa.
  function ajustar(i, texto) {
    const campo = niveles[i].buscar('corr-level-input');
    campo.value = texto;
    campo.emitir('input');
  }
  ajustar(0, CURSO_AJUSTADO);
  ajustar(1, SECUENCIA_AJUSTADA);
  ajustar(2, OBJETIVO_AJUSTADO);
  const etiquetaAjustada = porClase(panel, 'corr-prompts-tag').textContent;

  fila.buscar('corr-input').value = 'el cartel tapa la cara del profe, subilo y hacelo más chico';
  const botón = fila.buscar('qbtn qbtn-react');
  if (!botón) throw new Error('la fila no tiene el botón de regenerar');
  botón.click();

  for (let i = 0; i < 400 && !vistoCorr; i++) await new Promise((r) => setTimeout(r, 25));
  if (!vistoCorr) throw new Error('la corrección nunca llegó al proveedor');

  // 5. Y los archivos del proyecto, como quedaron. Es la mitad del contrato.
  const cursoEnDisco = fs.readFileSync(rutas.project, 'utf8');
  const secuenciaEnDisco = fs.readFileSync(rutas.sequence, 'utf8');

  const partes = [];
  partes.push('# El prompt que recibe el modelo, con los tres niveles puestos');
  partes.push('');
  partes.push('Generado por `node test/manual/prompt-tres-niveles.js`. Proyecto de verdad en un');
  partes.push('temporal, panel de verdad, motor de verdad; el único doble es el proveedor.');
  partes.push('');
  partes.push('## Los archivos del proyecto');
  partes.push('');
  partes.push('```');
  partes.push(rutas.project + '   ← Prompt general (curso)');
  partes.push(rutas.sequence + '   ← Prompt de secuencia');
  partes.push('```');
  partes.push('');
  partes.push('## Lo que el motor le dijo al log');
  partes.push('');
  partes.push('```');
  partes.push(notas.filter((n) => n.indexOf('prompt general') !== -1).join('\n') || '(nada)');
  partes.push('```');
  partes.push('');
  partes.push('## System prompt (el pedazo de los tres niveles)');
  partes.push('');
  partes.push('```');
  const sys = String(visto.systemPrompt || '');
  const desde = sys.indexOf('# Lo que pide el editor');
  partes.push(desde === -1 ? '(no está)' : sys.slice(desde, sys.indexOf('\n# ', desde + 5)).trim());
  partes.push('```');
  partes.push('');
  partes.push('## User prompt completo');
  partes.push('');
  partes.push('```');
  partes.push(String(visto.userPrompt || ''));
  partes.push('```');

  // ── Segunda parte: la corrección con los tres niveles ajustados ────
  partes.push('');
  partes.push('# Lo mismo, corrigiendo con los tres niveles ajustados a mano');
  partes.push('');
  partes.push('El recurso de arriba, abierto en la pestaña de correcciones. La ficha guardó con');
  partes.push('qué contexto se generó, así que lo que la fila muestra es un dato y no una');
  partes.push('reconstrucción — el renglón plegado lo dice:');
  partes.push('');
  partes.push('```');
  partes.push('Lo que recibió este marcador ' + etiqueta);
  partes.push('```');
  partes.push('');
  partes.push('## Lo que la ficha había guardado (`.meta.json`)');
  partes.push('');
  partes.push('```json');
  partes.push(JSON.stringify({ instruction: ficha.instruction, prompts: ficha.prompts }, null, 2));
  partes.push('```');
  partes.push('');
  partes.push('## Los cuatro campos, como los abrió la fila');
  partes.push('');
  leido.forEach(function (n) {
    partes.push('- **' + n.rotulo + '** → ' + JSON.stringify(n.valor.slice(0, 90) + (n.valor.length > 90 ? '…' : '')));
  });
  partes.push('');
  partes.push('Se editan los tres primeros y el renglón cambia de dato a ajuste:');
  partes.push('');
  partes.push('```');
  partes.push('Lo que recibió este marcador ' + etiquetaAjustada);
  partes.push('```');
  partes.push('');
  partes.push('## Lo que el motor le dijo al log de la corrección');
  partes.push('');
  partes.push('```');
  partes.push(notas.filter((n) => n.indexOf('prompt general') !== -1).slice(-1).join('\n') || '(nada)');
  partes.push('```');
  partes.push('');
  partes.push('## User prompt de la corrección (con los ajustes aplicados)');
  partes.push('');
  partes.push('```');
  partes.push(String(vistoCorr.userPrompt || ''));
  partes.push('```');
  partes.push('');
  partes.push('## Y los archivos del proyecto, después de todo eso');
  partes.push('');
  partes.push('Sin tocar: el ajuste valió para ese pedido y para ninguno más.');
  partes.push('');
  partes.push('```');
  partes.push('$ cat ' + rutas.project);
  partes.push(cursoEnDisco.trim());
  partes.push('');
  partes.push('$ cat ' + rutas.sequence);
  partes.push(secuenciaEnDisco.trim());
  partes.push('```');
  partes.push('');
  partes.push(cursoEnDisco.trim() === CURSO.trim() && secuenciaEnDisco.trim() === SECUENCIA.trim()
    ? '✅ Los dos archivos dicen exactamente lo que decían antes de la corrección.'
    : '❌ ALGUIEN ESCRIBIÓ LOS ARCHIVOS DEL PROYECTO: es la regresión que este diseño evita.');
  const texto = partes.join('\n') + '\n';

  if (salida) {
    fs.writeFileSync(salida, texto, 'utf8');
    console.log('Escrito en ' + salida);
  } else {
    console.log(texto);
  }
}

main().catch(function (e) {
  console.error(String((e && e.stack) || e));
  process.exitCode = 1;
});
