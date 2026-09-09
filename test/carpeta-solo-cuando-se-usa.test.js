'use strict';

// La carpeta `HyperPremiere/` aparece cuando se la USA, no cuando se abre el panel.
//
// El editor abrió un .prproj donde nunca había generado nada y ya tenía una
// carpeta `HyperPremiere/` al lado, con la subcarpeta de la secuencia adentro y
// vacía. No es cosmético: esa carpeta viaja con el proyecto —se la lleva el
// .prproj a las otras máquinas y al disco compartido— así que ensucia proyectos
// donde la herramienta ni se usó, y encima miente: parece que ahí hay algo.
//
// La causa era una sola clase de error repetida. `project-fs.js` tiene los dos
// helpers a propósito (`outputDirPath` arma la ruta, `ensureOutputDir` la crea),
// y varias LECTURAS pedían el que crea. La primera en dispararse era
// `loadTranscript`, que es de las primeras cosas que el panel pregunta al abrir
// una secuencia.
//
// Lo que se prueba acá son las dos mitades de la regla, y las dos hacen falta:
// abrir no crea nada, y la primera escritura de verdad crea todo lo que
// necesita. Sola, la primera se cumple borrando la creación en todos lados y
// rompiendo el primer uso.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq } = require('./harness');

const engine = require('../bridge/engine');

const SEQ = 'Clase 12 · Fotografía';
const SLUG = 'clase-12-fotografia';

// Un PNG de 1×1: una imagen de verdad, que es lo que pide el que la guarda.
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// El filesystem es de verdad a propósito: lo que se afirma es qué queda en el
// disco del editor, y un fs de mentira contestaría lo que le pidamos.

/** Un proyecto recién abierto: la carpeta con el .prproj y nada más. */
function proyectoLimpio() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-limpio-'));
  const projectPath = path.join(dir, 'Curso de IA.prproj');
  fs.writeFileSync(projectPath, 'no es un .prproj de verdad, alcanza para la ruta');
  return { dir, projectPath };
}

/** Todo lo que hay adentro de `dir`, en rutas relativas y ordenado. */
function contenido(dir) {
  const out = [];
  (function recorrer(actual, prefijo) {
    for (const nombre of fs.readdirSync(actual).sort()) {
      const p = path.join(actual, nombre);
      const esDir = fs.statSync(p).isDirectory();
      out.push(prefijo + nombre + (esDir ? '/' : ''));
      if (esDir) recorrer(p, prefijo + nombre + '/');
    }
  })(dir, '');
  return out;
}

/**
 * Todo lo que el panel le pide al motor al abrir un proyecto, en el orden en que
 * lo pide.
 *
 * La lista sale de los `hpCall`/`HPEngine.call` que corren sin que el editor
 * toque nada: hidratar el transcript de la secuencia (main.js), recargar la cola
 * y persistirla (queue.js), los dos niveles del estilo y sus referencias
 * (general-prompt.js, refs.js), lo generado que la pestaña Corrections lista
 * (corrections.js), y lo que la vista de la cola mira para ofrecer la limpieza
 * (queue-view.js). `saveQueue` con la cola vacía entra porque el panel la
 * escribe apenas arranca, y ése es el caso que ya tenía su guarda.
 */
function loQuePideElPanelAlAbrir(projectPath) {
  const conSecuencia = { projectPath: projectPath, sequenceName: SEQ };
  return [
    ['loadTranscript', function () { return engine.loadTranscript(conSecuencia); }],
    ['transcriptSummary', function () { return engine.transcriptSummary({ projectPath: projectPath, sequenceNames: [SEQ] }); }],
    ['loadGeneralPrompt', function () { return engine.loadGeneralPrompt(conSecuencia); }],
    ['loadReferences', function () { return engine.loadReferences(conSecuencia); }],
    ['loadQueue', function () { return engine.loadQueue({ projectPath: projectPath }); }],
    ['saveQueue (vacía)', function () { return engine.saveQueue({ projectPath: projectPath, jobs: [] }); }],
    ['listCorrections', function () { return engine.listCorrections(conSecuencia); }],
    ['listMarkerVersions', function () { return engine.listMarkerVersions(Object.assign({ markerSlug: 'Marcador 1' }, conSecuencia)); }],
    ['listOldVersions', function () { return engine.listOldVersions(conSecuencia); }],
    ['cleanupPreview', function () { return engine.cleanupPreview(conSecuencia); }],
    ['findRenderedVideo', function () { return engine.findRenderedVideo(Object.assign({ markerSlug: 'Marcador 1' }, conSecuencia)); }],
    ['readMarkerHtml', function () { return engine.readMarkerHtml(Object.assign({ markerSlug: 'Marcador 1', version: 1 }, conSecuencia)); }],
  ];
}

// ── La regla ─────────────────────────────────────────────────────────

test('abrir el panel sobre un proyecto limpio no crea ni un directorio', function () {
  const p = proyectoLimpio();
  for (const [nombre, llamar] of loQuePideElPanelAlAbrir(p.projectPath)) {
    llamar();
    eq(contenido(p.dir).join(' · '), 'Curso de IA.prproj',
      nombre + ' dejó algo en la carpeta del proyecto');
  }
});

test('y tampoco lo crea la secuencia siguiente: cambiar de clase no deja carpetas', function () {
  const p = proyectoLimpio();
  ['Clase 1', 'Clase 2 (copia)', 'Intro sin cortar'].forEach(function (seq) {
    engine.loadTranscript({ projectPath: p.projectPath, sequenceName: seq });
    engine.loadReferences({ projectPath: p.projectPath, sequenceName: seq });
    engine.listCorrections({ projectPath: p.projectPath, sequenceName: seq });
  });
  eq(contenido(p.dir).join(' · '), 'Curso de IA.prproj', 'quedaron carpetas de secuencias vacías');
});

// ── Cada lectura, con lo que contesta cuando no hay carpeta ──────────
//
// Que no cree nada no alcanza: tiene que seguir contestando lo MISMO que
// contestaba con la carpeta recién creada y vacía. Si una empezara a decir
// `ok:false` o a tirar, el arreglo se pagaría con un panel que se rompe al
// abrir un proyecto nuevo.

test('loadTranscript sin carpeta dice que no hay, no que falló', function () {
  const p = proyectoLimpio();
  const r = engine.loadTranscript({ projectPath: p.projectPath, sequenceName: SEQ });
  eq(r.ok, true, 'loadTranscript devolvió un error');
  eq(r.found, false, 'dijo que encontró un transcript que no existe');
});

test('listMarkerVersions sin carpeta devuelve la lista vacía', function () {
  const p = proyectoLimpio();
  const r = engine.listMarkerVersions({ projectPath: p.projectPath, sequenceName: SEQ, markerSlug: 'Marcador 1' });
  eq(r.ok, true, 'listMarkerVersions devolvió un error');
  eq(r.versions.length, 0, 'inventó versiones');
});

test('readMarkerHtml sin carpeta dice que no encontró esa versión', function () {
  const p = proyectoLimpio();
  const r = engine.readMarkerHtml({ projectPath: p.projectPath, sequenceName: SEQ, markerSlug: 'Marcador 1', version: 1 });
  eq(r.ok, false, 'dijo que abrió un HTML que no existe');
  eq(r.error, 'no se encontró la versión 1', 'cambió el motivo que ve el editor');
});

test('la limpieza de versiones viejas sin carpeta no tiene nada que borrar', function () {
  const p = proyectoLimpio();
  const lista = engine.listOldVersions({ projectPath: p.projectPath, sequenceName: SEQ });
  eq(lista.ok, true, 'listOldVersions devolvió un error');
  eq(lista.files.length, 0, 'inventó archivos que borrar');

  const previa = engine.cleanupPreview({ projectPath: p.projectPath, sequenceName: SEQ });
  eq(previa.ok, true, 'cleanupPreview devolvió un error');
  eq(previa.totalDeletes, 0, 'la vista previa ofrecía borrar algo');
});

test('listCorrections sin carpeta abre la pestaña vacía, sin error', function () {
  const p = proyectoLimpio();
  const r = engine.listCorrections({ projectPath: p.projectPath, sequenceName: SEQ });
  eq(r.ok, true, 'listCorrections devolvió un error');
  eq(r.markers.length, 0, 'inventó recursos generados');
  eq(r.sources.length, 0, 'inventó carpetas de origen');
});

test('los dos niveles del estilo sin carpeta vienen vacíos y sin archivo', function () {
  const p = proyectoLimpio();
  const r = engine.loadGeneralPrompt({ projectPath: p.projectPath, sequenceName: SEQ });
  eq(r.ok, true, 'loadGeneralPrompt devolvió un error');
  eq(r.projectText, '', 'inventó el estilo del curso');
  eq(r.sequenceText, '', 'inventó el estilo de la clase');
  eq(r.hasProjectFile, false, 'dijo que el proyecto ya decidió que no hay estilo');
});

test('las referencias sin carpeta son dos listas vacías', function () {
  const p = proyectoLimpio();
  const r = engine.loadReferences({ projectPath: p.projectPath, sequenceName: SEQ });
  eq(r.ok, true, 'loadReferences devolvió un error');
  eq(r.course.length, 0, 'inventó referencias del curso');
  eq(r.sequence.length, 0, 'inventó referencias de la clase');
});

test('re-renderizar sin nada generado avisa y no deja la carpeta hecha', async function () {
  const p = proyectoLimpio();
  let error = '';
  try {
    await engine.renderLatest({
      projectPath: p.projectPath, sequenceName: SEQ,
      markerSlug: 'Marcador 1', marker: { duration: 5 },
    });
  } catch (e) { error = (e && e.message) || String(e); }
  eq(error, 'No hay versiones (HTML) para re-renderizar de Marcador 1', 'cambió el aviso al editor');
  eq(contenido(p.dir).join(' · '), 'Curso de IA.prproj', 'dejó la carpeta hecha por un reintento imposible');
});

// ── Y la otra mitad: la primera escritura sí crea lo que necesita ────

test('guardar el transcript crea la carpeta de la secuencia', function () {
  const p = proyectoLimpio();
  const r = engine.saveTranscript({
    projectPath: p.projectPath, sequenceName: SEQ,
    segments: [{ start: 0, end: 2, text: 'hola' }],
  });
  eq(r.ok, true, 'no se pudo guardar el transcript: ' + r.error);
  eq(r.path, path.join(p.dir, 'HyperPremiere', SLUG, 'transcript.json'), 'quedó en otro lado');
  ok(fs.existsSync(r.path), 'el archivo no está en el disco');
  // Y la lectura que antes creaba la carpeta ahora la encuentra: la mitad de
  // arriba no se pagó con un transcript que se guarda y no se vuelve a leer.
  const leido = engine.loadTranscript({ projectPath: p.projectPath, sequenceName: SEQ });
  eq(leido.found, true, 'el transcript recién guardado no se volvió a leer');
  eq(leido.segments.length, 1, 'se leyó otra cosa');
});

test('capturar un cuadro crea la carpeta de la secuencia y su _capturas', function () {
  const p = proyectoLimpio();
  const tmpPng = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hp-cap-')), 'frame-1234.png');
  fs.writeFileSync(tmpPng, Buffer.from(IMG.split(',')[1], 'base64'));
  const r = engine.saveCapture({
    projectPath: p.projectPath, sequenceName: SEQ, markerSlug: 'Marcador 1', tmpPath: tmpPng,
  });
  eq(r.ok, true, 'no se pudo guardar la captura: ' + r.error);
  eq(path.dirname(r.savedPath), path.join(p.dir, 'HyperPremiere', SLUG, '_capturas'), 'quedó en otro lado');
  ok(fs.existsSync(r.savedPath), 'la captura no está en el disco');
});

test('agregar una referencia crea la carpeta de su nivel', function () {
  const p = proyectoLimpio();
  const curso = engine.addReference({
    projectPath: p.projectPath, scope: 'course', name: 'marca.png', dataUrl: IMG,
  });
  eq(curso.ok, true, 'no se pudo agregar la referencia del curso: ' + curso.error);
  eq(curso.dir, path.join(p.dir, 'HyperPremiere', '_referencias'), 'la del curso quedó en otro lado');

  const clase = engine.addReference({
    projectPath: p.projectPath, sequenceName: SEQ, scope: 'sequence', name: 'cuadro.png', dataUrl: IMG,
  });
  eq(clase.ok, true, 'no se pudo agregar la referencia de la clase: ' + clase.error);
  eq(clase.dir, path.join(p.dir, 'HyperPremiere', SLUG, '_referencias'), 'la de la clase quedó en otro lado');

  const leidas = engine.loadReferences({ projectPath: p.projectPath, sequenceName: SEQ });
  eq(leidas.course.length, 1, 'la del curso no se volvió a leer');
  eq(leidas.sequence.length, 1, 'la de la clase no se volvió a leer');
});

test('escribir el estilo crea la carpeta; vaciarlo no la crea', function () {
  const p = proyectoLimpio();
  const vacio = engine.saveGeneralPrompt({ projectPath: p.projectPath, scope: 'project', text: '' });
  eq(vacio.ok, true, 'vaciar el estilo devolvió un error');
  eq(contenido(p.dir).join(' · '), 'Curso de IA.prproj', 'vaciar el estilo creó la carpeta');

  const conTexto = engine.saveGeneralPrompt({
    projectPath: p.projectPath, scope: 'sequence', sequenceName: SEQ, text: 'tipografía Inter',
  });
  eq(conTexto.ok, true, 'no se pudo guardar el estilo de la clase: ' + conTexto.error);
  ok(fs.existsSync(path.join(p.dir, 'HyperPremiere', SLUG, 'prompt-secuencia.md')), 'el .md no está en el disco');
});

test('encolar un trabajo crea la carpeta con queue.json', function () {
  const p = proyectoLimpio();
  const r = engine.saveQueue({ projectPath: p.projectPath, jobs: [{ id: 'j1', kind: 'generate' }] });
  eq(r.ok, true, 'no se pudo guardar la cola: ' + r.error);
  ok(fs.existsSync(path.join(p.dir, 'HyperPremiere', 'queue.json')), 'queue.json no está en el disco');
  eq(engine.loadQueue({ projectPath: p.projectPath }).jobs.length, 1, 'la cola no se volvió a leer');
});

// Generar es el que más lejos llega —escribe el HTML y la ficha de la versión—
// y es el que no puede empezar pidiéndole a una carpeta que exista. Se corre el
// motor de verdad con el proveedor reemplazado: lo que importa acá no es qué
// contesta el modelo sino qué queda en el disco de un proyecto donde no había
// nada.
const COMPOSICION = '<!DOCTYPE html><html><body>' +
  '<div id="stage" data-composition-id="marcador-1" data-start="0" data-width="1920" ' +
  'data-height="1080" data-duration="6" data-fps="30"></div>' +
  '<script>const tl = gsap.timeline({ paused: true }); window.__timelines["marcador-1"] = tl;</script>' +
  '</body></html>';

const PROVEEDORES = ['claude-cli', 'cursor-cli', 'claude-api', 'openai-compat', 'ollama'];

/** Corre `fn` con los cinco proveedores reemplazados por uno que no llama a nadie. */
async function sinLlamarAlModelo(fn) {
  const previos = {};
  PROVEEDORES.forEach(function (id) {
    const ruta = require.resolve('../bridge/providers/' + id + '.js');
    previos[ruta] = require.cache[ruta];
    require.cache[ruta] = {
      exports: {
        generate: async function () {
          return { text: COMPOSICION, usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
      loaded: true, id: ruta, filename: ruta, paths: [], children: [],
    };
  });
  try {
    return await fn();
  } finally {
    Object.keys(previos).forEach(function (ruta) {
      if (previos[ruta]) require.cache[ruta] = previos[ruta];
      else delete require.cache[ruta];
    });
  }
}

test('generar sobre un proyecto donde no había nada escribe el HTML y la ficha', async function () {
  const p = proyectoLimpio();
  const prepared = await sinLlamarAlModelo(function () {
    return engine.prepareGenerate({
      projectPath: p.projectPath, sequenceName: SEQ,
      marker: { name: 'Marcador 1', start: 0, end: 6, duration: 6 },
      markerSlug: 'Marcador 1',
      instruction: 'un título que entra desde la izquierda',
      transcript: [], stills: [],
    }, function () {});
  });
  eq(prepared.ok, true, 'la generación no llegó al final');
  eq(prepared.baseDir, path.join(p.dir, 'HyperPremiere', SLUG), 'escribió en otra carpeta');
  ok(fs.existsSync(prepared.htmlPath), 'el HTML no quedó en el disco');
  ok(fs.existsSync(prepared.metaPath), 'la ficha de la versión no quedó en el disco');
  // Y lo que se acaba de escribir lo ve la lectura que ya no crea nada.
  eq(engine.listMarkerVersions({
    projectPath: p.projectPath, sequenceName: SEQ, markerSlug: 'Marcador 1',
  }).versions.length, 1, 'la versión recién generada no aparece en la lista');
});
