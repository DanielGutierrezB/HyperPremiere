'use strict';

// Reconstruir lo ya generado mirando el disco (listCorrections).
//
// La pestaña Corrections existe porque volver a abrir los marcadores no siempre
// es posible: el editor manda la clase a revisar y cuando vuelve, los
// marcadores pueden estar borrados, movidos o mezclados con los comentarios de
// Frame.io. Así que la única fuente confiable es la carpeta de la secuencia.
//
// Lo que más importa acá es el TRAMO (en qué segundo entraba y cuánto duraba):
// sin eso la corrección no puede volver a su lugar. Se busca en tres fuentes de
// peor en peor, y los tests recorren esa cascada entera.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq, deepEq } = require('./harness');

const engine = require('../bridge/engine');

/** Carpeta de proyecto descartable, con la estructura real que arma el motor. */
function armarProyecto(nombreSecuencia) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-corr-'));
  const proyecto = path.join(raiz, 'Clases.prproj');
  fs.writeFileSync(proyecto, 'x');
  const slug = String(nombreSecuencia).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const dir = path.join(raiz, 'HyperPremiere', slug);
  fs.mkdirSync(dir, { recursive: true });

  return {
    projectPath: proyecto,
    sequenceName: nombreSecuencia,
    dir,
    raiz,
    /** Escribe los archivos de una versión, como los deja una generación real. */
    version: function (slugMarcador, v, opts) {
      opts = opts || {};
      const base = slugMarcador + ' v' + v + (opts.model ? ' [' + opts.model + ']' : '');
      fs.writeFileSync(path.join(dir, base + '.html'), opts.html || '<div id="stage" data-duration="5"></div>');
      if (opts.video !== false) fs.writeFileSync(path.join(dir, base + '.mov'), 'video');
      if (opts.meta !== false) {
        fs.writeFileSync(path.join(dir, base + '.meta.json'), JSON.stringify(Object.assign({
          version: v, model: opts.model || '', instruction: opts.instruction || '',
          sequenceName: nombreSecuencia, markerSlug: slugMarcador,
          markerName: opts.markerName || '', markerGuid: opts.guid || '',
          marker: opts.marker,
        }, opts.metaExtra || {})));
      }
    },
    cola: function (jobs) {
      fs.writeFileSync(path.join(raiz, 'HyperPremiere', 'queue.json'),
        JSON.stringify({ version: 1, jobs }));
    },
    listar: function () {
      return engine.listCorrections({ projectPath: proyecto, sequenceName: nombreSecuencia });
    },
  };
}

test('agrupa por marcador y se queda con la última versión', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { model: 'claude-sonnet-5', marker: { name: 'Intro', start: 10, duration: 5 } });
  p.version('Marcador 1', 2, { model: 'claude-opus-5', marker: { name: 'Intro', start: 10, duration: 5 } });
  p.version('Marcador 3', 1, { model: 'claude-sonnet-5', marker: { name: 'Gráfico', start: 90, duration: 8 } });

  const r = p.listar();
  ok(r.ok, 'contestó bien');
  eq(r.markers.length, 2, 'dos marcadores, no tres archivos');
  eq(r.markers[0].slug, 'Marcador 1');
  eq(r.markers[0].latestVersion, 2, 'la última es la que se corrige por defecto');
  eq(r.markers[0].model, 'claude-opus-5', 'y el modelo es el de ESA versión');
  eq(r.markers[0].versions.length, 2, 'pero las anteriores siguen disponibles para elegir');
});

test('trae el tramo del timeline, que es para lo que existe la pestaña', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { marker: { name: 'Intro', start: 12.5, duration: 6 }, markerName: 'Intro', guid: 'g-1' });

  const m = p.listar().markers[0];
  eq(m.start, 12.5, 'el segundo donde entraba');
  eq(m.duration, 6, 'y cuánto duraba');
  eq(m.timeSource, 'ficha');
  eq(m.markerName, 'Intro');
  eq(m.markerGuid, 'g-1', 'el guid viaja por si el marcador todavía existe');
});

test('los marcadores salen en orden de número, no alfabético', function () {
  // "Marcador 10" antes que "Marcador 2" es exactamente lo que hace ordenar por
  // texto, y deja la lista ilegible en una clase larga.
  const p = armarProyecto('Clase 14');
  [1, 2, 10, 11].forEach(function (n) {
    p.version('Marcador ' + n, 1, { marker: { name: 'x', start: n, duration: 3 } });
  });
  deepEq(p.listar().markers.map(function (m) { return m.slug; }),
    ['Marcador 1', 'Marcador 2', 'Marcador 10', 'Marcador 11']);
});

test('dice qué versiones tienen video y cuáles solo HTML', function () {
  // Un render que se cortó deja el HTML sin el .mov. La fila tiene que poder
  // decirlo en vez de ofrecer corregir algo que nunca llegó al timeline.
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 } });
  p.version('Marcador 1', 2, { marker: { name: 'x', start: 1, duration: 3 }, video: false });

  const vs = p.listar().markers[0].versions;
  eq(vs[0].hasVideo, true);
  eq(vs[1].hasVideo, false, 'esa se quedó sin render');
});

// ── La cascada cuando falta la ficha ─────────────────────────────────

test('sin ficha, el tramo se recupera de la cola del proyecto', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { meta: false });
  p.cola([{ markerKey: 'Marcador 1', seqName: 'Clase 14', markerStart: 33, markerDuration: 7 }]);

  const m = p.listar().markers[0];
  eq(m.start, 33);
  eq(m.duration, 7);
  eq(m.timeSource, 'cola');
});

test('no se toma el tramo de un trabajo de OTRA secuencia', function () {
  // Mismo "Marcador 1" en dos clases del mismo proyecto: agarrar el de la otra
  // pondría el clip corregido en un segundo que no le corresponde.
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { meta: false, html: '<div id="stage"></div>' });
  p.cola([{ markerKey: 'Marcador 1', seqName: 'Clase 09', markerStart: 999, markerDuration: 7 }]);

  const m = p.listar().markers[0];
  eq(m.start, null, 'mejor no saber que saber mal');
  eq(m.timeSource, '');
});

test('sin ficha ni cola, el HTML da la duración pero no dónde iba', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { meta: false, html: '<div id="stage" data-composition-id="m1" data-duration="9"></div>' });

  const m = p.listar().markers[0];
  eq(m.duration, 9, 'la duración está declarada en la composición');
  eq(m.start, null, 'la posición no: eso vivía en el marcador');
  eq(m.timeSource, 'html');
});

test('cuando no hay ninguna fuente, se dice y no se inventa', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { meta: false, html: '<div id="stage"></div>' });

  const m = p.listar().markers[0];
  eq(m.start, null);
  eq(m.duration, null);
  eq(m.timeSource, '', 'la fila va a pedir el tramo a mano');
});

test('una ficha vieja sin tramo no tapa a una nueva que sí lo tiene', function () {
  // Al corregir, la versión más nueva es la que manda; pero si esa se generó
  // antes de que la ficha guardara la posición, hay que seguir bajando.
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { marker: { name: 'Intro', start: 40, duration: 4 } });
  p.version('Marcador 1', 2, { marker: undefined });

  const m = p.listar().markers[0];
  eq(m.start, 40, 'lo sacó de la v1');
  eq(m.latestVersion, 2, 'pero la corrección sigue yendo sobre la v2');
});

test('con fondo o sin fondo se conserva, para no cambiar de opaco a transparente', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 }, metaExtra: { background: true } });
  p.version('Marcador 2', 1, { marker: { name: 'x', start: 9, duration: 3 } });

  const ms = p.listar().markers;
  eq(ms[0].background, true);
  eq(ms[1].background, false);
});

// ── Anotar el tramo a mano ───────────────────────────────────────────

test('el tramo escrito a mano queda en la ficha y no se vuelve a preguntar', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { meta: false, html: '<div id="stage"></div>' });
  eq(p.listar().markers[0].start, null, 'antes no se sabía');

  const r = engine.saveCorrectionPosition({
    projectPath: p.projectPath, sequenceName: p.sequenceName,
    markerSlug: 'Marcador 1', start: 55, duration: 4,
  });
  ok(r.ok, 'se guardó');

  const m = p.listar().markers[0];
  eq(m.start, 55);
  eq(m.duration, 4);
  eq(m.timeSource, 'ficha', 'ahora sale de la ficha como cualquier otro');
});

test('anotar el tramo no borra lo que la ficha ya tenía', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { instruction: 'un gráfico de barras', model: 'claude-sonnet-5', marker: undefined });

  engine.saveCorrectionPosition({
    projectPath: p.projectPath, sequenceName: p.sequenceName,
    markerSlug: 'Marcador 1', start: 8, duration: 5,
  });
  const m = p.listar().markers[0];
  eq(m.start, 8);
  eq(m.instruction, 'un gráfico de barras', 'la instrucción original sigue ahí');
});

test('un tramo imposible se rechaza en vez de guardarse', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { meta: false });
  const base = { projectPath: p.projectPath, sequenceName: p.sequenceName, markerSlug: 'Marcador 1' };

  eq(engine.saveCorrectionPosition(Object.assign({ start: 5, duration: 0 }, base)).ok, false, 'duración cero');
  eq(engine.saveCorrectionPosition(Object.assign({ start: -3, duration: 5 }, base)).ok, false, 'entra antes de empezar');
  eq(engine.saveCorrectionPosition({ projectPath: p.projectPath, sequenceName: p.sequenceName, start: 1, duration: 2 }).ok,
    false, 'sin marcador');
});

// ── Bordes ───────────────────────────────────────────────────────────

test('una secuencia sin nada generado contesta vacío, sin crear la carpeta', function () {
  // Abrir la pestaña no puede dejar carpetas nuevas al lado del proyecto del
  // editor: es una consulta de solo lectura.
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-corr-'));
  const proyecto = path.join(raiz, 'Clases.prproj');
  fs.writeFileSync(proyecto, 'x');

  const r = engine.listCorrections({ projectPath: proyecto, sequenceName: 'Clase nueva' });
  ok(r.ok);
  eq(r.markers.length, 0);
  eq(fs.existsSync(path.join(raiz, 'HyperPremiere')), false, 'no dejó rastro');
});

test('los archivos que no siguen la nomenclatura se ignoran', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 } });
  fs.writeFileSync(path.join(p.dir, 'transcript.json'), '{}');
  fs.writeFileSync(path.join(p.dir, 'notas del editor.html'), '<p>ojo</p>');

  eq(p.listar().markers.length, 1, 'solo lo versionado por la herramienta');
});

test('una ficha corrupta no tumba el listado', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 } });
  fs.writeFileSync(path.join(p.dir, 'Marcador 1 v1.meta.json'), '{ esto no es json');

  const r = p.listar();
  ok(r.ok, 'sigue contestando');
  eq(r.markers[0].start, null, 'sin la ficha, el tramo se pide a mano');
});
