'use strict';

// NUNCA sobrescribir material del editor. Es la regla de oro del panel.
//
// El bug (Daniel lo reportó con captura): si NO estabas parado en la secuencia
// donde iba a caer la animación, el panel la colocaba encima del último clip y
// BORRABA el que estaba ahí. No es un cosmético: es trabajo perdido.
//
// Por qué pasaba: las pistas solo se pueden agregar con QE en la secuencia
// ACTIVA, así que el host tenía un `&& isActive` alrededor del addTracks. Con el
// editor mirando otra secuencia la pista NO se agregaba, la de destino seguía
// siendo la de más arriba —que estaba ocupada, que era justamente por lo que
// hacía falta una nueva— y overwriteClip pisaba lo que había. Venía de la
// v0.1.24, no fue una regresión de la 1.4.30.
//
// Y la secuencia inactiva es el caso NORMAL, no la excepción: mientras se
// renderiza, la persona se va a trabajar a otra parte.
//
// Acá se prueba con un Premiere de mentira FIEL en lo que importa: QE solo
// alcanza la secuencia ACTIVA (getActiveSequence) y cambiar de secuencia es
// app.project.openSequence. Si el host intentara agregar pistas sin activar, en
// este Premiere no pasaría nada — igual que en el de verdad.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const RAIZ = path.join(__dirname, '..', 'cep');

// ── Premiere de mentira, con DOS secuencias ──────────────────────────

/** Colección de clips como la ve ExtendScript: numItems + índices. */
function clips(rangos) {
  const col = (rangos || []).map(function (r) {
    return {
      start: { seconds: r[0] },
      end: { seconds: r[1] },
      // r[2] = ruta del medio, para los clips que son "del editor" o nuestros.
      projectItem: {
        name: r[2] ? String(r[2]).split('/').pop() : 'clip',
        getMediaPath: function () { return r[2] || ''; },
        setColorLabel: function (c) { this.colorLabel = c; },
      },
    };
  });
  Object.defineProperty(col, 'numItems', { get: function () { return col.length; } });
  return col;
}

function pista(rangos) {
  return {
    clips: clips(rangos),
    colocados: [],
    overwriteClip: function (item, at) { this.colocados.push({ item: item, at: at }); },
  };
}

function pistas(lista) {
  const col = (lista || []).map(pista);
  Object.defineProperty(col, 'numTracks', { get: function () { return col.length; } });
  return col;
}

function secuencia(nombre, id, video, audio) {
  return {
    name: nombre,
    sequenceID: id,
    videoTracks: pistas(video || [[]]),
    audioTracks: pistas(audio || []),
    playhead: [], // cada setPlayerPosition que reciba: tocárselo al editor es molesto
    setPlayerPosition: function (t) { this.playhead.push(t); },
  };
}

function bin(nombre) {
  const hijos = [];
  Object.defineProperty(hijos, 'numItems', { get: function () { return hijos.length; } });
  return {
    name: nombre,
    type: 2,
    children: hijos,
    createBin: function (n) { const nb = bin(n); hijos.push(nb); return nb; },
  };
}

/**
 * Premiere con la secuencia de DESTINO ("Clase 01") y la que está mirando el
 * editor ("Clase 02"). Por defecto la activa es la del editor, que es el caso
 * del bug.
 *
 *  opts.video / opts.audio             pistas de la secuencia de destino
 *  opts.videoEditor                    pistas de la secuencia del editor
 *  opts.destinoActiva                  el editor sí está parado en la de destino
 *  opts.qeMudo                         QE dice que sí y no agrega nada
 *  opts.qeRoto                         QE tira error
 *  opts.noPuedeActivar                 Premiere ignora el openSequence
 *  opts.pistaNuevaOcupada              la pista que agrega QE viene con material
 *                                      (imposible en la vida real: es para probar
 *                                      la red de seguridad sola)
 *
 * Devuelve { host, destino, editor, addTracks, vistas, activa() }.
 */
function armarPremiere(opts) {
  opts = opts || {};
  const destino = secuencia('Clase 01', 'seq-destino', opts.video || [[]], opts.audio || []);
  const editor = secuencia('Clase 02', 'seq-editor', opts.videoEditor || [[[0, 90]]], opts.audioEditor || [[[0, 90]]]);
  let activa = opts.destinoActiva ? destino : editor;
  const vistas = [];    // cada cambio de secuencia activa, en orden
  const addTracks = []; // qué se le pidió a QE, y sobre QUÉ secuencia cayó
  const raiz = bin('root');

  function File(p) {
    this.fsName = p;
    this.name = String(p).split('/').pop();
    this.exists = true;
    this.length = 1000;
  }

  // QE solo sabe de la secuencia que está al frente. Esa es la limitación que
  // originó el bug, así que el Premiere de mentira la respeta al pie de la letra.
  function qeDeLaActiva() {
    const suya = activa;
    return {
      addTracks: function (numVideo, videoIndex, numAudio, audioChannelType, audioIndex) {
        if (numVideo === undefined) numVideo = 1;
        if (videoIndex === undefined) videoIndex = 0;
        if (numAudio === undefined) numAudio = 1;  // el default de QE que nos mordió
        if (audioIndex === undefined) audioIndex = 0;
        addTracks.push({
          secuencia: suya.name, numVideo: numVideo, videoIndex: videoIndex,
          numAudio: numAudio, audioChannelType: audioChannelType, audioIndex: audioIndex,
        });
        if (opts.qeRoto) throw new Error('QE dijo: unknown error');
        if (opts.qeMudo) return; // acepta el pedido y no agrega nada
        const relleno = opts.pistaNuevaOcupada ? [[0, 1e6]] : [];
        for (let i = 0; i < numVideo; i++) suya.videoTracks.splice(videoIndex, 0, pista(relleno));
        for (let j = 0; j < numAudio; j++) suya.audioTracks.splice(audioIndex, 0, pista(relleno));
      },
    };
  }

  const ctx = {
    File: File,
    app: {
      project: {
        get activeSequence() { return activa; },
        rootItem: raiz,
        sequences: { numSequences: 2, 0: destino, 1: editor },
        openSequence: function (id) {
          if (opts.noPuedeActivar) return; // Premiere ignora el pedido
          const encontrada = [destino, editor].filter(function (s) { return s.sequenceID === id; })[0];
          if (!encontrada) return;
          activa = encontrada;
          vistas.push(activa.name);
        },
        importFiles: function (rutas, suprimir, bin) {
          const ruta = rutas[0];
          bin.children.push({
            name: String(ruta).split('/').pop(),
            type: 1,
            getMediaPath: function () { return ruta; },
            setColorLabel: function (c) { this.colorLabel = c; },
          });
        },
      },
      enableQE: function () {},
    },
    qe: { project: { getActiveSequence: qeDeLaActiva } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(RAIZ, 'jsx', 'host.jsx'), 'utf8'), ctx, { filename: 'host.jsx' });
  return {
    host: ctx, destino: destino, editor: editor,
    addTracks: addTracks, vistas: vistas,
    activa: function () { return activa.name; },
  };
}

/** Todo lo que se colocó en una secuencia: [{ pista, at }]. */
function colocado(seq) {
  const out = [];
  for (let i = 0; i < seq.videoTracks.numTracks; i++) {
    seq.videoTracks[i].colocados.forEach(function (c) { out.push({ pista: i, at: c.at }); });
  }
  return out;
}

// ── EL test que importa ──────────────────────────────────────────────

test('secuencia de destino INACTIVA y pista de arriba ocupada: JAMÁS se pisa el clip que estaba', function () {
  // El caso exacto de la captura: el editor está en "Clase 02" y en "Clase 01"
  // la V5 tiene material justo donde entra el marcador. Antes: overwriteClip
  // sobre la V5 y adiós al clip. Ahora: se agrega la V6 y el clip cae ahí.
  const p = armarPremiere({ video: [[], [], [], [], [[0, 30]]] });
  const ocupada = p.destino.videoTracks[4];
  const clipQueEstaba = ocupada.clips.numItems;

  const r = p.host.hp_placeClipInSequence('/tmp/Marcador 1 v1.mov', 'Clase 01', 10, 5, 11, 0);

  eq(r, 'ok');
  eq(ocupada.colocados.length, 0, 'sobre la pista ocupada NO se llamó a overwriteClip');
  eq(ocupada.clips.numItems, clipQueEstaba, 'el clip del editor sigue ahí');
  eq(p.destino.videoTracks.numTracks, 6, 'se agregó la V6');
  eq(colocado(p.destino).length, 1);
  eq(colocado(p.destino)[0].pista, 5, 'la animación cayó arriba de todo, donde el editor la espera');
  eq(colocado(p.editor).length, 0, 'y en la secuencia del editor no se colocó nada');
});

test('la pista se le pide a QE sobre la secuencia de DESTINO, no sobre la que mira el editor', function () {
  // El agujero, contado al revés: QE solo alcanza la secuencia activa. Si el host
  // no la activa, o le agrega la pista a la secuencia equivocada o no agrega
  // ninguna — y con la pista de arriba ocupada eso terminaba en overwriteClip.
  const p = armarPremiere({ video: [[], [[0, 30]]] });
  p.host.hp_placeClipInSequence('/tmp/Marcador 2 v1.mov', 'Clase 01', 10, 5, 11, 0);

  eq(p.addTracks.length, 1);
  eq(p.addTracks[0].secuencia, 'Clase 01', 'la pista fue a la secuencia de destino');
  eq(p.addTracks[0].numVideo, 1);
  eq(p.addTracks[0].numAudio, 0, 'y sin pista de audio de regalo (el default de QE es 1)');
  eq(p.editor.videoTracks.numTracks, 1, 'al editor no le apareció ninguna pista nueva');
  eq(p.editor.audioTracks.numTracks, 1);
});

test('si no se puede agregar la pista, la colocación FALLA y no toca nada', function () {
  // QE acepta el pedido y no agrega nada (o la versión de Premiere no lo soporta).
  // Antes de este arreglo, este era el camino que borraba el clip.
  const p = armarPremiere({ video: [[], [[0, 30]]], qeMudo: true });
  const ocupada = p.destino.videoTracks[1];

  const r = p.host.hp_placeClipInSequence('/tmp/Marcador 3 v1.mov', 'Clase 01', 10, 5, 11, 0);

  has(r, 'error:');
  has(r, 'NO coloqué la animación', 'el mensaje arranca diciendo lo importante');
  has(r, 'no pisar tu material');
  has(r, 'No se tocó ningún clip tuyo');
  has(r, 'bin HyperPremiere', 'y dice cómo resolverlo a mano: el video ya está importado');
  eq(ocupada.colocados.length, 0, 'ni un overwriteClip');
  eq(colocado(p.destino).length, 0, 'no se colocó nada en ninguna pista');
});

test('si QE explota, tampoco se pisa nada', function () {
  const p = armarPremiere({ video: [[], [[0, 30]]], qeRoto: true });
  const r = p.host.hp_placeClipInSequence('/tmp/Marcador 4 v1.mov', 'Clase 01', 10, 5, 11, 0);

  has(r, 'NO coloqué la animación');
  has(r, 'QE falló al agregar la pista', 'y el motivo técnico queda escrito');
  eq(colocado(p.destino).length, 0);
});

test('si Premiere no deja abrir la secuencia de destino, tampoco se pisa nada', function () {
  // Sin poder activarla no hay forma de agregar la pista. Antes se colocaba igual.
  const p = armarPremiere({ video: [[], [[0, 30]]], noPuedeActivar: true });
  const r = p.host.hp_placeClipInSequence('/tmp/Marcador 5 v1.mov', 'Clase 01', 10, 5, 11, 0);

  has(r, 'NO coloqué la animación');
  has(r, 'no pude abrirla para agregarle la pista');
  eq(colocado(p.destino).length, 0);
  eq(p.activa(), 'Clase 02', 'y el editor quedó donde estaba');
});

test('red de seguridad: overwriteClip solo sobre un tramo VERIFICADO libre', function () {
  // Situación imposible a propósito: QE agrega la pista y la pista viene con
  // material. Sirve para probar la última comprobación —la que corre justo antes
  // de escribir— sin depender de que el resto del razonamiento esté bien. Es la
  // red que tiene que existir aunque todo lo demás funcione perfecto.
  const p = armarPremiere({ video: [[], [[0, 30]]], pistaNuevaOcupada: true });
  const r = p.host.hp_placeClipInSequence('/tmp/Marcador 6 v1.mov', 'Clase 01', 10, 5, 11, 0);

  has(r, 'NO coloqué la animación');
  eq(colocado(p.destino).length, 0, 'no se escribió sobre ninguna pista');
});

// ── Lo intrusivo: entrar, hacer, y dejar todo como estaba ────────────

test('se pasa a la secuencia de destino y se vuelve a la del editor', function () {
  const p = armarPremiere({ video: [[], [[0, 30]]] });
  p.host.hp_placeClipInSequence('/tmp/Marcador 7 v1.mov', 'Clase 01', 10, 5, 11, 0);

  eq(p.vistas.join(' → '), 'Clase 01 → Clase 02', 'fue y volvió, en ese orden');
  eq(p.activa(), 'Clase 02', 'el editor termina donde estaba');
});

test('la vista vuelve incluso cuando agregar la pista falla', function () {
  // Dejarle otra secuencia al frente porque algo salió mal sería el segundo
  // problema del día. El volver va en un finally.
  const p = armarPremiere({ video: [[], [[0, 30]]], qeRoto: true });
  p.host.hp_placeClipInSequence('/tmp/Marcador 8 v1.mov', 'Clase 01', 10, 5, 11, 0);

  eq(p.activa(), 'Clase 02');
});

test('nunca se le mueve el playhead ni la selección al editor', function () {
  // Cambiarle la vista un instante es molesto; moverle el cursor de reproducción
  // es peor. openSequence pasa la secuencia al frente y nada más.
  const p = armarPremiere({ video: [[], [[0, 30]]] });
  p.host.hp_placeClipInSequence('/tmp/Marcador 9 v1.mov', 'Clase 01', 10, 5, 11, 0);

  eq(p.editor.playhead.length, 0, 'al editor no se le tocó el cursor');
  eq(p.destino.playhead.length, 0, 'ni el de la secuencia de destino');
});

test('si la pista de arriba está libre, NO se cambia de secuencia (cero saltos de vista)', function () {
  // Es el caso más común, y también el que se repite cuando varios renders
  // terminan seguidos: la primera colocación crea la pista nueva y las que vienen
  // ya encuentran lugar. Si acá se activara la secuencia, la vista del editor
  // estaría saltando todo el tiempo por nada.
  const p = armarPremiere({ video: [[], [], []] });
  const r = p.host.hp_placeClipInSequence('/tmp/Marcador 10 v1.mov', 'Clase 01', 10, 5, 11, 0);

  eq(r, 'ok');
  eq(p.vistas.length, 0, 'no se abrió ninguna secuencia');
  eq(p.addTracks.length, 0, 'ni se encendió QE');
  eq(p.activa(), 'Clase 02');
  eq(colocado(p.destino)[0].pista, 2, 'y el clip cayó en la de más arriba');
});

test('con la secuencia de destino ACTIVA se sigue comportando como siempre', function () {
  const p = armarPremiere({ video: [[], [[0, 30]]], destinoActiva: true });
  const r = p.host.hp_placeClipInSequence('/tmp/Marcador 11 v1.mov', 'Clase 01', 10, 5, 11, 0);

  eq(r, 'ok');
  eq(p.vistas.length, 0, 'ya estaba al frente: no se abre nada');
  eq(p.addTracks[0].secuencia, 'Clase 01');
  eq(colocado(p.destino)[0].pista, 2, 'V3, la nueva de arriba');
});

// ── Audio: el mismo criterio para el sonido del editor ───────────────

test('clip CON sonido en secuencia inactiva: la pista de audio se agrega al final', function () {
  // La capacidad que hay que conservar para el día que una animación traiga
  // sonido, ahora también cuando el editor está en otra secuencia.
  const p = armarPremiere({ video: [[], []], audio: [[[0, 30]], [[0, 30]]] });
  const r = p.host.hp_placeClipInSequence('/tmp/Marcador 12 v1.mov', 'Clase 01', 10, 5, 11, 1);

  eq(r, 'ok');
  eq(p.addTracks[0].secuencia, 'Clase 01');
  eq(p.addTracks[0].numAudio, 1);
  eq(p.addTracks[0].audioIndex, 2, 'al final de las que había: A1 y A2 siguen siendo A1 y A2');
  eq(p.addTracks[0].audioChannelType, 1, 'los cinco argumentos, siempre');
  eq(p.destino.audioTracks.numTracks, 3);
});

test('si no se pudo conseguir pista de audio para un clip con sonido, no se coloca', function () {
  // overwriteClip baja el audio del clip solo. Si no hay dónde, lo baja encima
  // del audio del editor, y eso es exactamente lo que no puede pasar.
  const p = armarPremiere({ video: [[], []], audio: [[[0, 30]]], qeMudo: true });
  const r = p.host.hp_placeClipInSequence('/tmp/Marcador 13 v1.mov', 'Clase 01', 10, 5, 11, 1);

  has(r, 'NO coloqué la animación');
  has(r, 'el video trae sonido');
  eq(colocado(p.destino).length, 0);
});

// ── El mismo agujero en otras operaciones: recolorear ────────────────

test('recolorear en HQ no le toca la etiqueta a un clip del editor', function () {
  // hp_recolorClipAt buscaba "el clip que arranca en este segundo", de arriba
  // hacia abajo. Alcanzaba con que el editor tuviera algo empezando ahí en una
  // pista más alta para que se llevara la etiqueta de color de nuestro HQ. No es
  // destructivo, pero es su proyecto: se identifica por ruta de medio, igual que
  // al colocar.
  const p = armarPremiere({ video: [[[10, 15, '/tmp/nuestro v2.mov']], [[10, 40, '/editor/camara-A.mov']]] });
  const delEditor = p.destino.videoTracks[1].clips[0].projectItem;
  const nuestro = p.destino.videoTracks[0].clips[0].projectItem;

  const r = p.host.hp_recolorClipAt('Clase 01', 10, 11, '/tmp/nuestro v2.mov');

  eq(r, 'ok');
  eq(nuestro.colorLabel, 11, 'el nuestro quedó magenta');
  eq(delEditor.colorLabel, undefined, 'y el del editor, intacto');
});

test('si nuestro clip no está, recolorear falla en vez de pintar el de al lado', function () {
  const p = armarPremiere({ video: [[[10, 40, '/editor/camara-A.mov']]] });
  const delEditor = p.destino.videoTracks[0].clips[0].projectItem;

  const r = p.host.hp_recolorClipAt('Clase 01', 10, 11, '/tmp/nuestro v2.mov');

  has(r, 'error:');
  has(r, 'nuestro v2.mov', 'dice qué archivo buscaba');
  eq(delEditor.colorLabel, undefined);
});

// ── El lado del panel ────────────────────────────────────────────────

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
  llamadas.length = 0; // la primera llamada es el $.evalFile de arranque
  return ctx;
}

test('el panel le manda al host la ruta del video al recolorear', async function () {
  const panel = armarPanel();
  panel.HPHost.recolorClip('Clase 01', 12, 11, '/tmp/marcador-3_v2.mov', function () {});
  await vuelta();
  has(panel.llamadas[0].expr,
    'hp_recolorClipAt("Clase 01", 12, 11, "/tmp/marcador-3_v2.mov")',
    'sin la ruta el host no puede saber cuál clip es el nuestro');
});

test('abrir una secuencia por necesidad nuestra no mueve el playhead', function () {
  // Transcribir abre la secuencia del panel para exportar SU audio y después
  // vuelve. Se hacía con openSequenceAndSeek(…, 0), que además le dejaba el
  // cursor en el segundo 0 de una secuencia que nadie había tocado.
  const panel = armarPanel();
  ok(typeof panel.HPHost.activateSequence === 'function', 'existe el "solo abrir"');
  panel.HPHost.activateSequence('Clase 01', function () {});
  has(panel.llamadas[0].expr, 'hp_activateSequence("Clase 01")');

  const main = fs.readFileSync(path.join(RAIZ, 'js', 'main.js'), 'utf8');
  eq(main.indexOf('openSequenceAndSeek(returnTo'), -1,
    'volver a la secuencia del editor no le mueve el cursor');
});
