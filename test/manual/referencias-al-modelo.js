'use strict';

// Qué referencias recibe DE VERDAD el modelo, ahora que viven en archivos del
// proyecto y son de DOS niveles.
//
//   node test/manual/referencias-al-modelo.js [--out archivo.md]
//
// Es el hermano de prompt-tres-niveles.js, con la misma forma y por el mismo
// motivo: los tests fijan el contrato pieza por pieza, y esto contesta la
// pregunta que se hace mirando un recurso que salió mal —¿le llegó el manual de
// marca del curso, o solo lo de la clase?—. Se contesta armando un pedido de
// punta a punta y volcando lo que el último eslabón antes de la nube tenía en la
// mano.
//
// De punta a punta quiere decir: un proyecto de verdad en un temporal con sus
// dos carpetas `_referencias`, el PANEL de verdad montado como lo carga el
// navegador (HPStore + HPGeneral + HPRefs + HPQueue), la cola releyendo el disco
// al momento de generar, y el MOTOR de verdad armando el pedido. Lo único falso
// es el proveedor: en vez de llamar al modelo, anota lo que le habrían mandado.
//
// Se corre DOS veces con el mismo proyecto y distinto proveedor, porque el
// transporte de los documentos no es el mismo para los cinco: con `ollama` (que
// no abre archivos) el PDF no llega y hay que ver el aviso; con `claude-cli` sí,
// y hay que ver la carpeta declarada.

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

const SEQ = 'Clase 12 · Fotografía';

const CURSO =
  'Marca ACADEMIA NOVA. Paleta azul institucional, todo entra por la derecha.';
const SECUENCIA =
  'Esta clase va en BLANCO Y NEGRO: el color pelea con los ejemplos de fotografía.';
const MARCADOR = 'Un cartel con los tres componentes, que aparezcan de a uno.';

const COMPOSICION = '<!DOCTYPE html><html><body>' +
  '<div id="stage" data-composition-id="marcador-1" data-start="0" data-width="1920" ' +
  'data-height="1080" data-duration="6" data-fps="30"></div>' +
  '<script>const tl = gsap.timeline({ paused: true }); window.__timelines["marcador-1"] = tl;</script>' +
  '</body></html>';

/** Un PNG mínimo pero válido, para que el motor lo trate como imagen de verdad. */
const PNG_1PX = 'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** El proveedor falso: no llama a nadie y se queda con lo que le pasaron. */
function proveedorEspia(id, anotar) {
  const ruta = path.join(RAIZ, 'bridge', 'providers', id + '.js');
  require.cache[ruta] = {
    exports: {
      generate: async function (arg) {
        anotar(arg);
        return { text: COMPOSICION, usage: { inputTokens: 1, outputTokens: 1, totalInputTokens: 1 } };
      },
      complete: async function (arg) { anotar(arg); return { text: '', usage: {} }; },
    },
    loaded: true, id: ruta, filename: ruta, paths: [], children: [],
  };
}

// ── Un DOM mínimo, solo para poder montar los módulos del panel ──────

function elemento(tag) {
  return {
    tagName: tag, children: [], listeners: {}, style: {},
    className: '', textContent: '', value: '', title: '',
    appendChild: function (h) { this.children.push(h); return h; },
    setAttribute: function () {},
    addEventListener: function () {},
  };
}

/** El panel, con los módulos de verdad y el motor de verdad detrás. */
function montarPanel(proyecto) {
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
        if (typeof engine[m] === 'function') return Promise.resolve(engine[m](arg));
        if (m === 'loadTranscript') return Promise.resolve({ ok: true, found: false });
        if (m === 'mediaHasAudio') return Promise.resolve({ ok: true, hasAudio: false });
        return Promise.resolve({ ok: true });
      },
      callProg: function (m, arg, onP) {
        if (m === 'prepareGenerate' || m === 'prepareFeedback') {
          const fn = m === 'prepareGenerate' ? engine.prepareGenerate : engine.prepareFeedback;
          return fn(arg, function (p) {
            if (p && p.note) ctx.__notas.push(p.note);
            if (onP) onP(p);
          });
        }
        // El render no aporta nada a esta pregunta y necesita el binario.
        if (m === 'renderPrepared') return Promise.resolve({ ok: true, movPath: '/tmp/x.mov', version: 1 });
        return Promise.resolve({ ok: true });
      },
    },
    HPStills: { fbInit: function () {}, fbClear: function () {}, fbCollect: function () { return []; } },
  };
  ctx.__notas = [];
  ctx.document = { createElement: elemento, getElementById: function () { return null; } };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'store.js', 'general-prompt.js', 'refs.js', 'queue.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  ctx.HPStore.setContext(proyecto, SEQ);
  return ctx;
}

/** Encola un marcador y espera a que el pedido llegue al proveedor falso. */
async function pedir(ctx, proyecto, visto) {
  ctx.HPQueue.add({
    kind: 'generate',
    payload: {
      projectPath: proyecto, sequenceName: SEQ, mode: 'generate',
      markerSlug: 'Marcador 1', instruction: MARCADOR,
      objective: 'Que el estudiante reconozca los tres componentes.',
      marker: { name: 'Marcador 1', start: 10, end: 16, duration: 6 },
      markerTranscript: [], transcript: [],
    },
    seqName: SEQ, projectPath: proyecto, markerKey: 'Marcador 1',
    label: 'Marcador 1', markerStart: 10, markerDuration: 6,
  });
  for (let i = 0; i < 400 && !visto.arg; i++) await new Promise((r) => setTimeout(r, 25));
  if (!visto.arg) throw new Error('el pedido nunca llegó al proveedor');
  return visto.arg;
}

/** La ruta relativa al proyecto, que es lo legible en un reporte. */
function corta(p, dir) {
  return String(p || '').split(dir + path.sep).join('').split('\\').join('/');
}

async function main() {
  const salidaIdx = process.argv.indexOf('--out');
  const salida = salidaIdx !== -1 ? process.argv[salidaIdx + 1] : '';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-refs-modelo-'));
  const proyecto = path.join(dir, 'Curso de IA.prproj');

  // 1. Los dos textos y las referencias de los DOS niveles, escritas como las
  //    escribe el panel: el editor arrastra, el motor guarda el archivo.
  engine.saveGeneralPrompt({ projectPath: proyecto, text: CURSO, scope: 'project' });
  engine.saveGeneralPrompt({ projectPath: proyecto, sequenceName: SEQ, text: SECUENCIA, scope: 'sequence' });

  function agregar(scope, name, dataUrl, use) {
    const r = engine.addReference({
      projectPath: proyecto, sequenceName: scope === 'sequence' ? SEQ : '',
      scope: scope, name: name, dataUrl: dataUrl, use: !!use,
    });
    if (!r.ok) throw new Error(r.error);
  }
  const md = (s) => 'data:text/markdown;base64,' + Buffer.from(s, 'utf8').toString('base64');
  const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 manual de marca', 'utf8').toString('base64');

  agregar('course', 'manual-de-marca-nova.png', PNG_1PX, false);
  agregar('course', 'logo-canal.png', PNG_1PX, true);
  agregar('course', 'Guia_de_estilo_NOVA.pdf', pdf, false);
  agregar('course', 'tipografias.md', md('Títulos: Söhne 72/80. Cuerpo: Inter 32/44.'), false);
  agregar('sequence', 'referencia-blanco-y-negro.jpg', PNG_1PX, false);
  agregar('sequence', 'captura-programa-00-03-41.png', PNG_1PX, false);

  const rutas = engine.loadReferences({ projectPath: proyecto, sequenceName: SEQ }).paths;

  // 2. Primera corrida: un proveedor que NO abre archivos.
  const vistoOllama = {};
  proveedorEspia('ollama', function (arg) { if (!vistoOllama.arg) vistoOllama.arg = arg; });
  engine.setConfig({ provider: 'ollama', model: 'falso' });
  const ctxA = montarPanel(proyecto);
  const conOllama = await pedir(ctxA, proyecto, vistoOllama);

  // 3. Segunda corrida: uno que SÍ los abre. Mismo proyecto, mismas referencias.
  const vistoClaude = {};
  proveedorEspia('claude-cli', function (arg) { if (!vistoClaude.arg) vistoClaude.arg = arg; });
  engine.setConfig({ provider: 'claude-cli', model: 'falso' });
  const ctxB = montarPanel(proyecto);
  const conClaude = await pedir(ctxB, proyecto, vistoClaude);

  // ── El reporte ──────────────────────────────────────────────────────
  const partes = [];
  partes.push('# Las referencias que recibe el modelo, de los dos niveles');
  partes.push('');
  partes.push('Generado por `node test/manual/referencias-al-modelo.js`. Proyecto de verdad en un');
  partes.push('temporal, panel de verdad, motor de verdad; el único doble es el proveedor.');
  partes.push('');
  partes.push('## Las dos carpetas del proyecto');
  partes.push('');
  partes.push('```');
  partes.push(corta(rutas.course, dir) + '/');
  fs.readdirSync(rutas.course).sort().forEach((f) => partes.push('  ' + f));
  partes.push(corta(rutas.sequence, dir) + '/');
  fs.readdirSync(rutas.sequence).sort().forEach((f) => partes.push('  ' + f));
  partes.push('```');
  partes.push('');
  partes.push('El `referencias.json` del curso, que es lo que un archivo suelto no puede decir:');
  partes.push('');
  partes.push('```json');
  partes.push(fs.readFileSync(path.join(rutas.course, 'referencias.json'), 'utf8').trim());
  partes.push('```');
  partes.push('');
  partes.push('## Lo que el motor le dijo al log');
  partes.push('');
  partes.push('```');
  partes.push(ctxA.__notas.filter((n) => n.indexOf('Entra al modelo') !== -1)[0] || '(nada)');
  partes.push('```');
  partes.push('');
  partes.push('## Las imágenes que le llegaron al proveedor');
  partes.push('');
  partes.push('Primero las del **curso** y después las de **esta clase**, en el orden del');
  partes.push('manifiesto. Es el mismo orden en que van los dos textos, y es el que el editor');
  partes.push('usa cuando escribe "imagen 2" en su instrucción.');
  partes.push('');
  partes.push('```');
  (conOllama.images || []).forEach((img, i) => {
    partes.push('imagen ' + (i + 1) + ': ' + String(img).slice(0, 34) + '…  (' +
      String(img).length + ' caracteres)');
  });
  partes.push('```');
  partes.push('');
  partes.push('Llegan como **data URL** porque ése es el contrato de `generate`, y el motor las');
  partes.push('lee del disco al momento de llamar. Los dos CLI de agente no las mandan así:');
  partes.push('reciben la misma lista y la vuelven a archivos, que es el viaje que se ahorra el');
  partes.push('día que se les pase la ruta directo.');
  partes.push('');
  partes.push('## Y los documentos');
  partes.push('');
  partes.push('### Con `ollama` (no abre archivos)');
  partes.push('');
  partes.push('El `.md` **se pega en el prompt**:');
  partes.push('');
  partes.push('```');
  const up = String(conOllama.userPrompt || '');
  const desde = up.indexOf('## Documentación de referencia');
  const hasta = desde === -1 ? -1 : up.indexOf('\n\n## ', desde + 5);
  partes.push(desde === -1 ? '(no está)'
    : up.slice(desde, hasta === -1 ? undefined : hasta).trim());
  partes.push('```');
  partes.push('');
  partes.push('El PDF **no llega**, y se dice antes de gastar la llamada:');
  partes.push('');
  partes.push('```');
  partes.push(ctxA.__notas.filter((n) => /pdf|documento/i.test(n)).join('\n') || '(nada)');
  partes.push('```');
  partes.push('');
  partes.push('### Con `claude-cli` (sí los abre)');
  partes.push('');
  partes.push('El PDF viaja como archivo, con su carpeta declarada:');
  partes.push('');
  partes.push('```json');
  partes.push(JSON.stringify({
    docFiles: ((conClaude.config && conClaude.config.docFiles) || []).map((p) => corta(p, dir)),
    readDirs: ((conClaude.config && conClaude.config.readDirs) || []).map((p) => corta(p, dir)),
  }, null, 2));
  partes.push('```');
  partes.push('');
  partes.push('## Comprobaciones');
  partes.push('');
  const imgs = (conOllama.images || []).length;
  const docs = ((conClaude.config && conClaude.config.docFiles) || []).length;
  // La marcada "✓ usar" no se nombra por su archivo: el motor la copia a
  // `assets/` con un nombre estable y el prompt le dice al modelo que la
  // incruste desde ahí. Que aparezca esa sección es que llegó.
  const incrusta = String(conOllama.userPrompt || '').indexOf('<img src="assets/') !== -1;
  [
    ['llegaron las 4 imágenes (2 del curso + 2 de la clase)', imgs === 4],
    ['la marcada ✓ usar viaja como recurso a incrustar', incrusta],
    ['el .md del curso se pegó en el prompt', desde !== -1],
    ['el PDF del curso le llegó a claude-cli como archivo', docs === 1],
    ['el PDF se usa donde está, sin copiarlo a la carpeta de la versión',
      !((conClaude.config && conClaude.config.docFiles) || [])
        .some((p) => p.indexOf('_recursos') !== -1)],
  ].forEach(function (c) {
    partes.push((c[1] ? '- ✅ ' : '- ❌ ') + c[0]);
  });

  const salidaTexto = partes.join('\n') + '\n';
  if (salida) {
    fs.writeFileSync(salida, salidaTexto, 'utf8');
    console.log('Escrito en ' + salida);
  } else {
    console.log(salidaTexto);
  }
}

main().catch(function (e) {
  console.error(String((e && e.stack) || e));
  process.exitCode = 1;
});
