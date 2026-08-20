'use strict';

// Ignorar los marcadores que Frame.io deja al volver de revisión.
//
// El editor manda la clase a revisar, le devuelven comentarios en Frame.io y al
// importarlos cada comentario entra a la secuencia como un marcador más. Sin
// filtro, la herramienta los toma por trabajo y arma una tarjeta por comentario.
//
// El riesgo grande no es la tarjeta de más: es la NUMERACIÓN. Los archivos ya
// generados se llaman "Marcador N vX", así que si un comentario se cuela y
// corre los números, las instrucciones y los videos de un marcador terminan
// atados a otro. Por eso la mitad de estos tests miran los números, no el filtro.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, deepEq } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');

/** Carga los módulos del panel (JS de navegador, sin módulos) con un localStorage de mentira. */
function cargarPanel() {
  const guardado = {};
  const ctx = {
    console: console,
    Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Object: Object, Array: Array, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(guardado, k) ? guardado[k] : null; },
      setItem: function (k, v) { guardado[k] = String(v); },
      removeItem: function (k) { delete guardado[k]; },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'store.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

const panel = cargarPanel();
const U = panel.HPUtil;

/** Marcador como lo entrega hp_getMarkers(). */
function marcador(index, name, guid, comment) {
  return {
    index: index, guid: guid || '', name: name, comment: comment || '',
    start: index * 10, duration: 5, end: index * 10 + 5,
  };
}

// Los DOS comentarios de Frame.io tal como estaban guardados en el .prproj de
// un editor (2607_bi-deep-research-ai, 18/08). Se fueron a buscar ahí porque el
// filtro por nombre no atrapaba ninguno y no se entendía por qué: el nombre del
// marcador es QUIÉN comentó, y de Frame.io no dice nada. La marca está al final
// del comentario.
const REAL_1 = {
  name: 'Cande',
  comment: 'Texto listado:\n- Abrir navegador\n- Descargar archivos\n- Ejecutar código\n' +
    '- Crear documentos\n- Manipular interfaces\n\n' +
    'Frame.io Comment ID: bba94422-efc7-4389-afbd-23a4cb72f65a',
};
const REAL_2 = {
  name: 'Candela',
  comment: '¿No convendría que primero mencione el tipo de error "entremos" y ahí sí veamos la ' +
    'descripción de lo que implica cada uno?\n\n' +
    'Frame.io Comment ID: 37029c8b-202a-4212-998a-60b349082ce6',
};

// ── El caso real, con los datos reales ───────────────────────────────

test('reconoce los comentarios REALES de Frame.io, que no nombran a Frame.io en el nombre', function () {
  // La regresión de la v1.4.32: se filtraba por nombre ("Frame.io:") y ninguno
  // de estos dos lo tiene, así que el editor seguía viendo una tarjeta por
  // comentario de la revisión.
  ok(U.isFrameIoMarker(REAL_1), 'el comentario de "Cande"');
  ok(U.isFrameIoMarker(REAL_2), 'el de "Candela"');
  eq(/frame\.io\s*:/i.test(REAL_1.name), false, 'y se confirma: por el nombre no había con qué');
});

test('la marca se reconoce escrita de cualquier forma', function () {
  ok(U.isFrameIoMarker({ comment: 'nota\n\nFrame.io Comment ID: abc' }), 'como viene');
  ok(U.isFrameIoMarker({ comment: 'frameio comment id: abc' }), 'sin punto y en minúscula');
  ok(U.isFrameIoMarker({ comment: 'Frame.io  Comment  ID : abc' }), 'con espacios de más');
  ok(U.isFrameIoMarker({ name: 'Frame.io Comment ID: abc' }), 'y si algún día la mueven al nombre');
});

test('un marcador de animación que MENCIONA Frame.io es trabajo, no un comentario', function () {
  // El riesgo del filtro nuevo: mira el comentario, y el comentario del marcador
  // es justo donde el editor escribe la instrucción. Solo el sello con "Comment
  // ID" descarta; nombrar a Frame.io al pasar, no.
  eq(U.isFrameIoMarker({ name: 'Gráfico', comment: 'esto lo pidieron por Frame.io: subir el contraste' }), false);
  eq(U.isFrameIoMarker({ name: 'Intro', comment: 'ver el comentario de Cande en frame.io' }), false);
  eq(U.isFrameIoMarker({ name: 'Cierre', comment: 'ID del comentario: 123' }), false);
  eq(U.isFrameIoMarker({ name: 'Barras', comment: '' }), false);
});

// ── Reconocer el marcador ────────────────────────────────────────────

test('reconoce el comentario de Frame.io como venga escrito', function () {
  ok(U.isFrameIoMarker({ name: 'Frame.io: Corregir el color del título' }), 'el caso real');
  ok(U.isFrameIoMarker({ name: 'frame.io: en minúscula' }), 'sin mayúsculas');
  ok(U.isFrameIoMarker({ name: 'FRAME.IO: gritando' }), 'todo en mayúsculas');
  ok(U.isFrameIoMarker({ name: '  Frame.io: con espacios adelante' }), 'con espacios adelante');
  ok(U.isFrameIoMarker({ name: 'Frame.io : separado' }), 'con espacio antes de los dos puntos');
  ok(U.isFrameIoMarker({ name: 'Comentario de Frame.io: al medio' }), 'aunque no arranque el nombre');
});

test('no se lleva puesto un marcador del editor que se parezca', function () {
  // Estos son marcadores de animación de verdad: si el filtro los descarta,
  // el editor pierde trabajo sin enterarse.
  eq(U.isFrameIoMarker({ name: 'Frames por segundo' }), false);
  eq(U.isFrameIoMarker({ name: 'Frame final' }), false);
  eq(U.isFrameIoMarker({ name: 'Frame.io' }), false, 'sin los dos puntos no alcanza');
  eq(U.isFrameIoMarker({ name: 'Intro de la clase' }), false);
  eq(U.isFrameIoMarker({ name: '' }), false, 'un marcador sin nombre es del editor');
  eq(U.isFrameIoMarker(null), false, 'y un marcador que no llegó no rompe nada');
});

// ── Sacarlos de la lista ─────────────────────────────────────────────

test('saca los de Frame.io y deja los de animación en su orden', function () {
  const r = U.withoutFrameIoMarkers([
    marcador(0, 'Intro'),
    marcador(1, 'Frame.io: subir el volumen acá'),
    marcador(2, 'Gráfico de barras'),
    marcador(3, 'Frame.io: falta el logo'),
  ]);
  eq(r.ignored, 2, 'contó los dos comentarios');
  deepEq(r.markers.map(function (m) { return m.name; }), ['Intro', 'Gráfico de barras']);
});

test('no toca la lista que llegó de Premiere', function () {
  // Se copia cada marcador porque el `index` se reescribe: mutar el original
  // dejaría al resto del panel leyendo números ya pisados.
  const original = [marcador(0, 'Intro'), marcador(1, 'Frame.io: nota')];
  const r = U.withoutFrameIoMarkers(original);
  eq(original.length, 2, 'la lista original queda entera');
  eq(original[0].index, 0);
  eq(r.markers[0].start, 0, 'el marcador que sobrevive conserva sus tiempos');
  eq(r.markers[0].duration, 5);
});

test('reindexa los que quedan, sin huecos', function () {
  // `index` es el respaldo de la numeración cuando Premiere no expone el guid.
  // Si quedara con los huecos de los descartados, los marcadores se numerarían
  // salteado: 1, 3, 4…
  const r = U.withoutFrameIoMarkers([
    marcador(0, 'Frame.io: comentario'),
    marcador(1, 'Intro'),
    marcador(2, 'Frame.io: otro'),
    marcador(3, 'Cierre'),
  ]);
  deepEq(r.markers.map(function (m) { return m.index; }), [0, 1]);
});

test('una secuencia sin comentarios pasa igual, y una vacía no rompe', function () {
  const r = U.withoutFrameIoMarkers([marcador(0, 'Intro'), marcador(1, 'Cierre')]);
  eq(r.ignored, 0);
  eq(r.markers.length, 2);
  deepEq(U.withoutFrameIoMarkers([]), { markers: [], ignored: 0, ignoredMarkers: [] });
  deepEq(U.withoutFrameIoMarkers(null), { markers: [], ignored: 0, ignoredMarkers: [] });
});

test('la clase que volvió de revisión queda limpia', function () {
  // Cómo se ve de verdad: dos animaciones del editor y los dos comentarios de la
  // revisión, intercalados por tiempo.
  const r = U.withoutFrameIoMarkers([
    marcador(0, 'Intro'),
    marcador(1, REAL_1.name, 'g-fio-1', REAL_1.comment),
    marcador(2, 'Gráfico de barras'),
    marcador(3, REAL_2.name, 'g-fio-2', REAL_2.comment),
  ]);
  eq(r.ignored, 2);
  deepEq(r.markers.map(function (m) { return m.name; }), ['Intro', 'Gráfico de barras']);
  deepEq(r.markers.map(function (m) { return m.index; }), [0, 1], 'y sin huecos en la numeración');
});

test('el log dice CUÁLES se ignoraron, con nombre y minuto', function () {
  // Es la red por si el filtro se pasa de listo: un marcador de animación que
  // desaparezca tiene que poder verse en el log, no adivinarse.
  const r = U.withoutFrameIoMarkers([
    marcador(0, 'Intro'),
    marcador(15, REAL_1.name, 'g-fio-1', REAL_1.comment),
    marcador(20, REAL_2.name, 'g-fio-2', REAL_2.comment),
  ]);
  const linea = U.describeIgnored(r.ignoredMarkers);
  ok(linea.indexOf('Cande') !== -1, 'quién comentó');
  ok(linea.indexOf('2:30') !== -1, 'y en qué minuto: 150s');
  ok(linea.indexOf('Candela') !== -1);
});

test('con una revisión entera encima, la lista del log no se desborda', function () {
  const muchos = [];
  for (let i = 0; i < 12; i++) muchos.push(marcador(i, 'Revisor ' + i, 'g-' + i, REAL_1.comment));
  const r = U.withoutFrameIoMarkers(muchos);
  eq(r.ignored, 12);
  const linea = U.describeIgnored(r.ignoredMarkers);
  ok(linea.indexOf('y 6 más') !== -1, 'se nombran los primeros y se cuenta el resto');
});

// ── Lo que de verdad importa: la numeración ──────────────────────────

test('los marcadores que ya tenían número no se mueven cuando aparece Frame.io', function () {
  // El escenario real: generaste la clase, mandaste a revisar, volvieron los
  // comentarios. "Marcador 2" tiene que seguir siendo el mismo marcador, o los
  // archivos "Marcador 2 v3.mov" quedan colgados de otra animación.
  const S = panel.HPStore;
  S.setContext('/proyectos/clase.prproj', 'Clase 14');

  const antes = [marcador(0, 'Intro', 'g-intro'), marcador(1, 'Gráfico', 'g-graf'), marcador(2, 'Cierre', 'g-cierre')];
  S.seedMarkerNumbers(antes.map(function (m) { return m.guid; }));
  eq(S.assignMarkerNumber('g-graf'), 2, 'antes de la revisión, el gráfico es el 2');

  // Vuelve de Frame.io: los comentarios se intercalan por tiempo.
  const despues = U.withoutFrameIoMarkers([
    marcador(0, 'Frame.io: el título tapa la cara', 'g-fio-1'),
    marcador(1, 'Intro', 'g-intro'),
    marcador(2, 'Frame.io: falta fuente del dato', 'g-fio-2'),
    marcador(3, 'Gráfico', 'g-graf'),
    marcador(4, 'Cierre', 'g-cierre'),
  ]);

  eq(despues.ignored, 2);
  eq(S.assignMarkerNumber('g-intro'), 1);
  eq(S.assignMarkerNumber('g-graf'), 2, 'el gráfico sigue siendo el 2');
  eq(S.assignMarkerNumber('g-cierre'), 3);
});

test('sin filtro, esos mismos comentarios se habrían quedado con los números', function () {
  // La contraprueba del test anterior: así se veía el bug. Secuencia nueva
  // (registro vacío), que es cuando la numeración se siembra por posición.
  const S = panel.HPStore;
  S.setContext('/proyectos/clase.prproj', 'Clase 15 sin filtro');
  S.seedMarkerNumbers(['g-fio-1', 'g-intro', 'g-fio-2', 'g-graf']);
  eq(S.assignMarkerNumber('g-graf'), 4, 'el gráfico se comió dos números de comentarios');

  S.setContext('/proyectos/clase.prproj', 'Clase 15 con filtro');
  const limpio = U.withoutFrameIoMarkers([
    marcador(0, 'Frame.io: nota', 'g-fio-1'),
    marcador(1, 'Intro', 'g-intro'),
    marcador(2, 'Frame.io: otra', 'g-fio-2'),
    marcador(3, 'Gráfico', 'g-graf'),
  ]);
  S.seedMarkerNumbers(limpio.markers.map(function (m) { return m.guid; }));
  eq(S.assignMarkerNumber('g-graf'), 2, 'con el filtro, el gráfico es el 2 como corresponde');
});

test('en un Premiere sin guid, la numeración sale del index ya reindexado', function () {
  // Premiere viejo no expone `guid` y el panel cae al `index + 1`. Es el caso
  // donde un reindexado mal hecho se nota al toque.
  const limpio = U.withoutFrameIoMarkers([
    marcador(0, 'Frame.io: comentario'),
    marcador(1, 'Intro'),
    marcador(2, 'Frame.io: otro'),
    marcador(3, 'Gráfico'),
  ]);
  // markerKeyFor sin guid hace exactamente esto:
  const numeros = limpio.markers.map(function (m) { return (m.index || 0) + 1; });
  deepEq(numeros, [1, 2], 'Intro=1 y Gráfico=2, no 2 y 4');
});
