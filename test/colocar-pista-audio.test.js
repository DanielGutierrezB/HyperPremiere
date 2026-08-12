'use strict';

// Colocar un clip NO tiene que reacomodarle la secuencia al editor.
//
// El bug: cada vez que el panel colocaba una animación aparecía una pista de
// audio vacía al final ("Audio 4") y las pistas se corrían una posición. No lo
// hacía Premiere por su cuenta: lo pedíamos nosotros. Cuando la pista de video
// de arriba está ocupada, el host agrega una con QE, y la firma de QE es
// addTracks(numVideo, videoIndex, numAudio, audioChannelType, audioIndex) con
// numAudio = 1 POR DEFECTO. Al llamar addTracks(1, N) — sin los argumentos de
// audio — QE agregaba también una pista de audio que nadie usaba.
//
// Nuestras animaciones son ProRes 4444 con alpha y MUDAS, así que esa pista
// nunca tenía nada. Pero el panel tiene que poder colocar video + audio el día
// que una animación traiga sonido, así que la decisión no está cableada: el
// motor mira el archivo con ffprobe (mediaHasAudio) y le pasa el dato al host.
//
// Acá se prueba esa DECISIÓN sin abrir Premiere: un Premiere de mentira que
// respeta el default de QE (si no le pasás numAudio, agrega una pista de audio)
// y un CSInterface de mentira para el lado del panel.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const RAIZ = path.join(__dirname, '..', 'cep');

// ── Premiere de mentira ──────────────────────────────────────────────

/** Colección de clips como la ve ExtendScript: numItems + índices. */
function clips(rangos) {
  const col = (rangos || []).map(function (r) {
    return { start: { seconds: r[0] }, end: { seconds: r[1] } };
  });
  Object.defineProperty(col, 'numItems', { get: function () { return col.length; } });
  return col;
}

function pista(rangos) {
  return { clips: clips(rangos), colocados: [], overwriteClip: function (item, at) { this.colocados.push({ item: item, at: at }); } };
}

/** Lista de pistas como la ve ExtendScript: numTracks + índices. */
function pistas(lista) {
  const col = (lista || []).map(pista);
  Object.defineProperty(col, 'numTracks', { get: function () { return col.length; } });
  return col;
}

function bin(nombre) {
  const hijos = [];
  Object.defineProperty(hijos, 'numItems', { get: function () { return hijos.length; } });
  const b = {
    name: nombre,
    type: 2,
    children: hijos,
    createBin: function (n) { const nb = bin(n); hijos.push(nb); return nb; },
  };
  return b;
}

/**
 * Arma el host.jsx con un Premiere de mentira.
 *  opts.video / opts.audio: pistas de la secuencia, cada una con sus clips
 *                           ya puestos como pares [inicio, fin] en segundos.
 * Devuelve { host, seq, addTracks (lo que se le pidió a QE) }.
 */
function armarHost(opts) {
  opts = opts || {};
  const seq = {
    name: 'Clase 01',
    videoTracks: pistas(opts.video || [[]]),
    audioTracks: pistas(opts.audio || []),
  };
  const addTracks = [];
  const raiz = bin('root');

  function File(p) {
    this.fsName = p;
    this.name = String(p).split('/').pop();
    this.exists = true;
    this.length = 1000;
  }

  const ctx = {
    File: File,
    app: {
      project: {
        activeSequence: seq,
        rootItem: raiz,
        sequences: { numSequences: 1, 0: seq },
        importFiles: function (rutas, suprimir, destino) {
          const ruta = rutas[0];
          destino.children.push({
            name: String(ruta).split('/').pop(),
            type: 1,
            getMediaPath: function () { return ruta; },
            setColorLabel: function (c) { this.colorLabel = c; },
          });
        },
      },
      enableQE: function () {},
    },
    qe: {
      project: {
        getActiveSequence: function () {
          return {
            // El default de QE, que es justamente lo que nos mordió: los
            // argumentos de audio que no se pasan valen 1 pista en el índice 0.
            addTracks: function (numVideo, videoIndex, numAudio, audioChannelType, audioIndex) {
              if (numVideo === undefined) numVideo = 1;
              if (videoIndex === undefined) videoIndex = 0;
              if (numAudio === undefined) numAudio = 1;
              if (audioIndex === undefined) audioIndex = 0;
              addTracks.push({ numVideo: numVideo, videoIndex: videoIndex, numAudio: numAudio, audioIndex: audioIndex });
              for (let i = 0; i < numVideo; i++) seq.videoTracks.splice(videoIndex, 0, pista([]));
              for (let j = 0; j < numAudio; j++) seq.audioTracks.splice(audioIndex, 0, pista([]));
            },
          };
        },
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(RAIZ, 'jsx', 'host.jsx'), 'utf8'), ctx, { filename: 'host.jsx' });
  return { host: ctx, seq: seq, addTracks: addTracks };
}

/** Dónde cayó el clip: índice de la pista de video que lo recibió, o -1. */
function pistaConClip(seq) {
  for (let i = 0; i < seq.videoTracks.numTracks; i++) {
    if (seq.videoTracks[i].colocados.length) return i;
  }
  return -1;
}

// ── La decisión: pista de audio SOLO si el clip trae audio ───────────

test('animación muda con la pista de arriba ocupada: se agrega video, NUNCA audio', function () {
  // El caso exacto de Daniel: V5 ocupada donde va el marcador, A1/A2/A3 con
  // material. Antes salía de acá con una pista de audio vacía de regalo.
  const p = armarHost({ video: [[], [], [], [], [[0, 30]]], audio: [[[0, 30]], [[0, 30]], [[0, 30]]] });
  const r = p.host.hp_placeClipInSequence('/tmp/Marcador 1 v1.mov', 'Clase 01', 10, 5, 11, 0);

  eq(r, 'ok');
  eq(p.addTracks.length, 1, 'se le pidió una sola cosa a QE');
  eq(p.addTracks[0].numVideo, 1, 'la pista de video que hacía falta, sí');
  eq(p.addTracks[0].numAudio, 0, 'pistas de audio: cero, y explícito (si se omite, QE agrega una)');
  eq(p.seq.audioTracks.numTracks, 3, 'el editor sigue con sus A1/A2/A3, ni una más');
});

test('animación muda con lugar libre arriba: no se toca ninguna pista', function () {
  const p = armarHost({ video: [[], [[0, 30]], []], audio: [[[0, 30]]] });
  const r = p.host.hp_placeClipInSequence('/tmp/Marcador 2 v1.mov', 'Clase 01', 10, 5, 11, 0);

  eq(r, 'ok');
  eq(p.addTracks.length, 0, 'ni QE se enciende: había lugar donde siempre');
  eq(p.seq.audioTracks.numTracks, 1);
  eq(p.seq.videoTracks.numTracks, 3);
});

test('clip CON audio y todas las pistas de audio ocupadas: se agrega una, al final', function () {
  // La capacidad que Daniel quiere conservar para el día que una animación
  // traiga sonido. Va al final (audioIndex = las que ya hay) para que A1 y A2
  // sigan siendo A1 y A2: meterla arriba le renumeraría el trabajo.
  const p = armarHost({ video: [[], []], audio: [[[0, 30]], [[0, 30]]] });
  const r = p.host.hp_placeClipInSequence('/tmp/Marcador 3 v1.mov', 'Clase 01', 10, 5, 11, 1);

  eq(r, 'ok');
  eq(p.addTracks.length, 1);
  eq(p.addTracks[0].numAudio, 1, 'el clip suena: necesita dónde caer');
  eq(p.addTracks[0].audioIndex, 2, 'al final de las que había, no arriba de todo');
  eq(p.addTracks[0].numVideo, 0, 'la pista de video de arriba estaba libre: no se agrega ninguna');
  eq(p.seq.audioTracks.numTracks, 3);
});

test('clip CON audio pero con una pista de audio libre: tampoco se agrega nada', function () {
  // Agregar pistas "por las dudas" es la misma molestia que arreglamos: si el
  // sonido entra donde ya hay lugar, la secuencia queda igual que estaba.
  const p = armarHost({ video: [[], []], audio: [[[0, 5]], [[100, 130]]] });
  const r = p.host.hp_placeClipInSequence('/tmp/Marcador 4 v1.mov', 'Clase 01', 10, 5, 11, 1);

  eq(r, 'ok');
  eq(p.addTracks.length, 0, 'A2 estaba libre en ese tramo: alcanza');
  eq(p.seq.audioTracks.numTracks, 2);
});

test('sin el dato de audio se coloca como mudo (lo que no le mueve las pistas)', function () {
  // Si ffprobe no está o falla, el panel manda 0. Peor que colocar un clip sin
  // reservarle pista es reacomodarle la secuencia a alguien por las dudas: el
  // audio, si existiera, Premiere lo baja igual con el propio overwriteClip.
  const p = armarHost({ video: [[[0, 30]]], audio: [[[0, 30]]] });
  p.host.hp_placeClipInSequence('/tmp/Marcador 5 v1.mov', 'Clase 01', 10, 5, 11, undefined);

  eq(p.addTracks[0].numAudio, 0);
  eq(p.seq.audioTracks.numTracks, 1);
});

// ── Lo que NO tiene que cambiar ──────────────────────────────────────

test('el clip sigue cayendo en la pista de video de arriba', function () {
  // El editor cuenta con que su animación aparezca donde siempre. Con lugar
  // libre va a la de más arriba; si está ocupada, a la nueva que queda arriba.
  const libre = armarHost({ video: [[], [], []], audio: [[]] });
  libre.host.hp_placeClipInSequence('/tmp/Marcador 6 v1.mov', 'Clase 01', 10, 5, 11, 0);
  eq(pistaConClip(libre.seq), 2, 'V3, la de más arriba de las tres');

  const ocupada = armarHost({ video: [[], [], [[0, 30]]], audio: [[]] });
  ocupada.host.hp_placeClipInSequence('/tmp/Marcador 7 v1.mov', 'Clase 01', 10, 5, 11, 0);
  eq(ocupada.seq.videoTracks.numTracks, 4, 'se agregó V4');
  eq(pistaConClip(ocupada.seq), 3, 'y el clip cayó ahí, arriba de todo');
});

test('el clip que se coloca es el del archivo pedido, no "el último del bin"', function () {
  // Regresión del bug feo: con dos renders terminando juntos se colocaba el
  // video de OTRO marcador. Se identifica por ruta de medio, y así queda.
  const p = armarHost({ video: [[]], audio: [] });
  p.host.hp_placeClipInSequence('/tmp/Marcador 8 v1.mov', 'Clase 01', 10, 5, 11, 0);
  // Otro render deja su ítem en el mismo bin ANTES de que se coloque el nuestro.
  const binSeq = p.host.app.project.rootItem.children[0].children[0];
  binSeq.children.push({ name: 'Marcador 99 v1.mov', type: 1, getMediaPath: function () { return '/tmp/Marcador 99 v1.mov'; } });
  p.host.hp_placeClipInSequence('/tmp/Marcador 9 v1.mov', 'Clase 01', 40, 5, 11, 0);

  const puestos = p.seq.videoTracks[0].colocados;
  eq(puestos.length, 2);
  eq(puestos[1].item.getMediaPath(), '/tmp/Marcador 9 v1.mov', 'el nuestro, no el intruso');
});

// ── El lado del panel: qué se le manda al host ───────────────────────

/** Deja correr las promesas pendientes (la cola encadena varias). */
function vuelta() {
  return new Promise(function (r) { setImmediate(r); });
}

/** Carga cep/js/host-client.js con un CSInterface de mentira. */
function armarPanel() {
  const llamadas = [];
  const ctx = {
    Promise: Promise,
    llamadas: llamadas,
    SystemPath: { EXTENSION: 'ext' },
    CSInterface: function () {
      this.getSystemPath = function () { return '/ext'; };
      this.evalScript = function (expr, cb) { llamadas.push({ expr: expr, cb: cb }); };
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(RAIZ, 'js', 'host-client.js'), 'utf8'), ctx, { filename: 'host-client.js' });
  // La primera llamada es el $.evalFile de arranque: no cuenta.
  llamadas.length = 0;
  return ctx;
}

test('el panel le manda al host si el archivo trae audio (1) o no (0)', async function () {
  const mudo = armarPanel();
  mudo.HPHost.placeClip('/tmp/a.mov', 'Clase 01', 12, 5, 11, false, function () {});
  await vuelta();
  has(mudo.llamadas[0].expr, ', 0)', 'mudo → el host no reserva pista de audio');

  const sonoro = armarPanel();
  sonoro.HPHost.placeClip('/tmp/b.mov', 'Clase 01', 12, 5, 11, true, function () {});
  await vuelta();
  has(sonoro.llamadas[0].expr, 'hp_placeClipInSequence("/tmp/b.mov", "Clase 01", 12, 5, 11, 1)',
    'con audio → el host sí puede reservarla');
});

test('agregar el dato de audio no rompió la cola de una sola vía', async function () {
  // Las llamadas que MODIFICAN el proyecto van de a una: dos colocaciones a la
  // vez comparten bin y pistas, y así fue como una vez se colocó el clip
  // equivocado. Si esto se rompe, el bug vuelve.
  const panel = armarPanel();
  panel.HPHost.placeClip('/tmp/a.mov', 'Clase 01', 12, 5, 11, false, function () {});
  panel.HPHost.placeClip('/tmp/b.mov', 'Clase 01', 30, 5, 11, true, function () {});

  await vuelta();
  eq(panel.llamadas.length, 1, 'la segunda espera: no hay dos escrituras en vuelo');
  has(panel.llamadas[0].expr, '/tmp/a.mov');

  panel.llamadas[0].cb('ok');
  await vuelta();
  eq(panel.llamadas.length, 2, 'recién cuando volvió la primera arranca la segunda');
  has(panel.llamadas[1].expr, '/tmp/b.mov');
});

test('quién sabe si el archivo tiene audio: el motor, y en un solo lugar', function () {
  // ExtendScript no puede abrir un .mov, así que el dato lo resuelve el motor
  // con ffprobe y viaja ya masticado. Y lo hace con el hasAudioStream que ya
  // existía para la transcripción: si mañana cambia cómo se detecta el audio,
  // cambia en un solo archivo y las dos cosas siguen de acuerdo.
  const motor = require('../bridge/engine.js');
  const transcribe = require('../bridge/transcribe.js');
  ok(typeof motor.mediaHasAudio === 'function', 'el panel tiene a quién preguntarle');
  ok(typeof transcribe.hasAudioStream === 'function', 'y la respuesta sale de donde ya estaba');

  const fuentes = ['bridge/engine.js', 'bridge/transcribe.js', 'cep/jsx/host.jsx', 'cep/js/queue.js']
    .filter(function (f) { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8').indexOf('-select_streams') !== -1; });
  eq(fuentes.length, 1, 'una sola implementación de "¿esto tiene audio?" en todo el camino');
});
