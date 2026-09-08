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
        if (m === 'loadTranscript') return Promise.resolve({ ok: true, found: false });
        if (m === 'mediaHasAudio') return Promise.resolve({ ok: true, hasAudio: false });
        return Promise.resolve({ ok: true });
      },
      callProg: function (m, arg, onP) {
        if (m === 'prepareGenerate') {
          // Las notas del motor son la otra evidencia: ahí se anota qué niveles
          // entraron, que es la línea que se mira en el ⬇ Log del editor.
          return engine.prepareGenerate(arg, function (p) {
            if (p && p.note) notas.push(p.note);
            if (onP) onP(p);
          });
        }
        // El render no aporta nada a esta pregunta y necesita el binario.
        if (m === 'renderPrepared') return Promise.resolve({ ok: true, movPath: '/tmp/x.mov', version: 1 });
        return Promise.resolve({ ok: true });
      },
    },
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'store.js', 'general-prompt.js', 'queue.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  ctx.HPStore.setContext(proyecto, 'Clase 12 · Fotografía');
  return ctx;
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
