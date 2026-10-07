'use strict';

// EL BOTÓN «RENDER» DE REMOTION STUDIO REEMPLAZA EL CLIP EN PREMIERE.
//
// El pedido: abrir en Remotion lo que se generó con Remotion, y que cada render
// hecho desde la interfaz de Studio reemplace el clip de ese marcador en la
// secuencia. El circuito tiene cuatro tramos y acá se prueba cada uno sin
// levantar Studio ni Premiere:
//
//   1. Las imágenes que incrusta la composición van donde Remotion las busca
//      (`public/assets/`). Hasta la 1.8.0 iban a otro lado y no salían.
//   2. La sesión de Studio: de lo que avisa `/events`, qué render es nuevo, a
//      qué marcador pertenece, y que se guarde UNA vez.
//   3. El render se guarda como versión nueva del marcador, con su código.
//   4. En Premiere se reemplaza el archivo del clip que ya estaba puesto, y si
//      no hay ninguno, se coloca como una generación.
//
// Lo que solo se puede ver con la interfaz de verdad —que el botón Render manda
// las props con el marcador adentro, y que el video sale con ESA composición—
// lo mide test/manual/studio-render.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, deepEq, has } = require('./harness');

const imagenes = require('../bridge/render/remotion-imagenes');
const studio = require('../bridge/render/remotion-studio');
const instalar = require('../bridge/render/remotion-instalar');
const versiones = require('../bridge/versiones');
const { writeVersionMeta, readMeta } = require('../bridge/store/project-fs');

function carpeta(prefijo) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefijo || 'hp-studio-'));
}

// ── 1. Las imágenes ───────────────────────────────────────────────────

test('las imágenes van a public/assets, que es donde las busca staticFile', function () {
  // El bundle declara `remotion_staticBase = "/public"`: `staticFile("assets/x")`
  // pide `/public/assets/x`. En la raíz, el logo no salía y nada fallaba.
  const de = carpeta();
  fs.writeFileSync(path.join(de, 'asset-01.png'), 'png');
  fs.writeFileSync(path.join(de, 'asset-02.jpg'), 'jpg');
  const raiz = carpeta();
  eq(imagenes.copiarImagenes(de, raiz), 2);
  ok(fs.existsSync(path.join(raiz, 'public', 'assets', 'asset-01.png')));
  ok(!fs.existsSync(path.join(raiz, 'assets')), 'en la raíz no tiene que quedar nada');
});

test('las del marcador anterior se van: en Studio la carpeta es una para todos', function () {
  const raiz = carpeta();
  const a = carpeta();
  fs.writeFileSync(path.join(a, 'asset-01.png'), 'logo de A');
  fs.writeFileSync(path.join(a, 'asset-02.png'), 'foto de A');
  imagenes.copiarImagenes(a, raiz);
  const b = carpeta();
  fs.writeFileSync(path.join(b, 'asset-01.png'), 'logo de B');
  imagenes.copiarImagenes(b, raiz);
  deepEq(fs.readdirSync(path.join(raiz, 'public', 'assets')), ['asset-01.png']);
  eq(fs.readFileSync(path.join(raiz, 'public', 'assets', 'asset-01.png'), 'utf8'), 'logo de B',
    'todos los marcadores llaman a su imagen asset-01.png: la de A se vería en B');
});

test('un marcador sin imágenes deja la carpeta vacía, pero la deja', function () {
  // Studio sirve `public/` solo si existe al arrancar.
  const raiz = carpeta();
  eq(imagenes.copiarImagenes('', raiz), 0);
  ok(fs.existsSync(path.join(raiz, 'public', 'assets')));
});

// ── 2. El huésped de la instalación, al día ──────────────────────────

test('el huésped instalado se pone al día con el que trae el panel', function () {
  // Se copiaba solo al instalar: un cambio en bridge/remotion-host/ no les
  // llegaba nunca a quienes ya tenían Remotion. Es lo que hace que el arreglo
  // del botón Render (Root.tsx) llegue con la actualización del panel.
  const dir = carpeta();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'Root.tsx'), 'el de antes');
  fs.writeFileSync(path.join(dir, 'src', 'Viejo.tsx'), 'de una versión anterior');
  ok(instalar.sincronizarHuesped(dir) > 0);
  const fuente = path.join(__dirname, '..', 'bridge', 'remotion-host');
  eq(fs.readFileSync(path.join(dir, 'src', 'Root.tsx'), 'utf8'),
    fs.readFileSync(path.join(fuente, 'src', 'Root.tsx'), 'utf8'));
  ok(!fs.existsSync(path.join(dir, 'src', 'Viejo.tsx')), 'un archivo que el panel ya no trae no se sigue empaquetando');
  ok(fs.existsSync(path.join(dir, 'remotion.config.ts')));
  eq(instalar.sincronizarHuesped(dir), 0, 'la segunda vez no hay nada que tocar: Studio recargaría por nada');
});

// ── 3. Lo que avisa Studio por /events ───────────────────────────────

function trabajo(id, estado, destino, extra) {
  return Object.assign({
    id: id, type: 'video', status: estado, outName: 'out/marcador.mov', codec: 'prores',
    serializedInputPropsWithCustomSchema: JSON.stringify({ codigoJs: 'x', destino: destino }),
  }, extra || {});
}

test('el stream de /events se lee aunque llegue cortado en cualquier lado', function () {
  const a = studio._leerEventos('data: {"type":"init"}\n\ndata: {"type":"render-qu');
  deepEq(a.eventos, [{ type: 'init' }]);
  const b = studio._leerEventos(a.resto + 'eue-updated","queue":[]}\n\n');
  deepEq(b.eventos, [{ type: 'render-queue-updated', queue: [] }]);
  eq(b.resto, '');
  eq(studio._leerEventos('data: no es json\n\n').eventos.length, 0);
});

test('cada render sabe a qué marcador pertenece por sus props', function () {
  eq(studio._destinoDelTrabajo(trabajo('1', 'done', 'abc123')), 'abc123');
  eq(studio._destinoDelTrabajo({ serializedInputPropsWithCustomSchema: '{"codigoJs":""}' }), '',
    'un render de las props por defecto no es de ningún marcador');
  eq(studio._destinoDelTrabajo({ serializedInputPropsWithCustomSchema: 'roto' }), '');
});

test('un render terminado se procesa UNA vez, aunque Studio lo repita en cada aviso', function () {
  // Studio manda la cola entera en cada cambio: el terminado sigue apareciendo.
  const s = studio._sesionNueva({});
  eq(studio._alCambiarLaCola(s, [trabajo('1', 'running', 'a')]).length, 0);
  ok(s.enCurso['1'] === 'a', 'mientras renderiza, se sabe de qué marcador es');
  eq(studio._alCambiarLaCola(s, [trabajo('1', 'done', 'a')]).length, 1);
  eq(studio._alCambiarLaCola(s, [trabajo('1', 'done', 'a'), trabajo('2', 'idle', 'a')]).length, 0);
  eq(Object.keys(s.enCurso).join(','), '2');
  eq(studio._alCambiarLaCola(s, [trabajo('3', 'done', 'a', { type: 'still' })]).length, 0,
    'una imagen fija no tiene clip que reemplazar');
});

test('un render terminado se guarda con el destino de SUS props, de a uno', async function () {
  const s = studio._sesionNueva({ dir: '/instalacion' });
  s.destinos.verde = { etiqueta: 'Marcador 1 v2', markerSlug: 'Marcador 1' };
  const guardados = [];
  s.alTerminar = function (r) { guardados.push(r); return { etiqueta: 'Marcador 1 v3' }; };
  const avisos = [];
  s.escucha = function (a) { avisos.push(a); };
  await studio._procesar(s, trabajo('1', 'done', 'verde'));
  eq(guardados.length, 1);
  eq(guardados[0].archivo, path.resolve('/instalacion', 'out/marcador.mov'));
  eq(guardados[0].destino.markerSlug, 'Marcador 1');
  deepEq(avisos, [{ ok: true, etiqueta: 'Marcador 1 v3' }]);
});

test('un render que no salió de un marcador del panel no va a Premiere', async function () {
  // Por ejemplo, el de las props por defecto: adivinarle un clip sería pisar el de otro.
  const s = studio._sesionNueva({ dir: '/instalacion' });
  let llamado = false;
  s.alTerminar = function () { llamado = true; return {}; };
  const avisos = [];
  s.escucha = function (a) { avisos.push(a); };
  await studio._procesar(s, trabajo('1', 'done', 'nadie-lo-abrio'));
  eq(llamado, false);
  eq(avisos[0].ok, false);
  has(avisos[0].error, 'no lo pongo en Premiere');
});

test('un render que falló en Studio se avisa con el motivo de Studio', async function () {
  const s = studio._sesionNueva({ dir: '/x' });
  s.destinos.d = { etiqueta: 'Marcador 2 v1' };
  const avisos = [];
  s.escucha = function (a) { avisos.push(a); };
  await studio._procesar(s, trabajo('1', 'failed', 'd', { error: { message: 'La composición no exporta un componente' } }));
  eq(avisos[0].ok, false);
  has(avisos[0].error, 'La composición no exporta un componente');
  eq(avisos[0].etiqueta, 'Marcador 2 v1');
});

/** Una sesión "viva" sin Studio: un hijo que nunca terminó. */
function conSesionViva(fn) {
  const antes = studio._caja.sesion;
  const s = studio._sesionNueva({ hijo: { exitCode: null, killed: false, pid: null, kill: function () {} }, dir: '/x' });
  studio._caja.sesion = s;
  return Promise.resolve().then(function () { return fn(s); }).finally(function () { studio._caja.sesion = antes; });
}

test('lo que terminó antes de que el panel escuche no se pierde', async function () {
  await conSesionViva(async function (s) {
    s.destinos.d = { etiqueta: 'M v1' };
    s.alTerminar = function () { return { etiqueta: 'M v2' }; };
    await studio._procesar(s, trabajo('1', 'done', 'd'));
    const recibidos = [];
    studio.escuchar(function (a) { recibidos.push(a); });
    deepEq(recibidos, [{ ok: true, etiqueta: 'M v2' }]);
  });
});

test('hay UN solo oyente: suscribirse de nuevo suelta al anterior', async function () {
  // Dos oyentes serían dos reemplazos en Premiere por cada render.
  await conSesionViva(async function (s) {
    const primero = [];
    const fin = studio.escuchar(function (a) { primero.push(a); });
    const segundo = [];
    studio.escuchar(function (a) { segundo.push(a); });
    deepEq(await fin, { ok: true, terminado: 'otro oyente tomó su lugar' });
    s.destinos.d = { etiqueta: 'M v1' };
    s.alTerminar = function () { return { etiqueta: 'M v2' }; };
    await studio._procesar(s, trabajo('1', 'done', 'd'));
    eq(primero.length, 0);
    eq(segundo.length, 1);
  });
});

test('no se cambia de marcador mientras Studio renderiza otro', function () {
  // Las imágenes de los dos irían a la misma carpeta, y el render saldría con las del nuevo.
  const s = studio._sesionNueva({});
  const a = { projectPath: '/p', sequenceName: 'Clase', markerSlug: 'Marcador 1', etiqueta: 'Marcador 1 v2' };
  const b = { projectPath: '/p', sequenceName: 'Clase', markerSlug: 'Marcador 2', etiqueta: 'Marcador 2 v1' };
  s.destinos.da = a;
  studio._alCambiarLaCola(s, [trabajo('1', 'running', 'da')]);
  eq(studio._otroRenderizando(s, b), a);
  eq(studio._otroRenderizando(s, Object.assign({}, a, { version: 3 })), null, 'el mismo marcador sí');
  studio._alCambiarLaCola(s, [trabajo('1', 'done', 'da')]);
  eq(studio._otroRenderizando(s, b), null, 'cuando terminó, ya se puede');
});

// ── 4. El render se guarda como versión ──────────────────────────────

function proyecto() {
  const raiz = carpeta('hp-studio-proy-');
  const projectPath = path.join(raiz, 'Clases.prproj');
  fs.writeFileSync(projectPath, 'x');
  const dir = path.join(raiz, 'HyperPremiere', 'clase-3');
  fs.mkdirSync(dir, { recursive: true });
  return {
    projectPath: projectPath, sequenceName: 'Clase 3', dir: dir,
    version: function (slug, v, engine, ext, extra) {
      const base = slug + ' v' + v + ' [modelo]';
      fs.writeFileSync(path.join(dir, base + (engine === 'remotion' ? '.tsx' : '.html')), 'código v' + v);
      fs.writeFileSync(path.join(dir, base + '.' + (ext || 'mov')), 'video v' + v);
      writeVersionMeta(path.join(dir, base + '.meta.json'), Object.assign({
        sequenceName: 'Clase 3', markerSlug: slug, version: v, model: 'modelo',
        engine: engine, instruction: 'un lower third con el nombre',
        marker: { name: slug, start: 12, duration: 4 },
      }, extra || {}));
    },
  };
}

function renderDeStudio(p, quien) {
  const salida = carpeta();
  const archivo = path.join(salida, quien || 'marcador.mov');
  fs.writeFileSync(archivo, 'video de Studio');
  return archivo;
}

function destinoDe(p, extra) {
  return Object.assign({
    projectPath: p.projectPath, sequenceName: p.sequenceName, markerSlug: 'Marcador 1', version: 2,
    etiqueta: 'Marcador 1 v2', marker: { name: 'Marcador 1', start: 12, duration: 4 },
    background: false, code: 'export default function M() { return null; }',
  }, extra || {});
}

test('un render de Studio entra como versión nueva, con el código que se renderizó', function () {
  const p = proyecto();
  p.version('Marcador 1', 1, 'remotion');
  p.version('Marcador 1', 2, 'remotion');
  const r = versiones.guardarRenderDeStudio({ archivo: renderDeStudio(p), destino: destinoDe(p) });
  eq(r.version, 3);
  eq(r.etiqueta, 'Marcador 1 v3');
  eq(path.basename(r.archivo), 'Marcador 1 v3 [studio].mov');
  eq(fs.readFileSync(r.archivo, 'utf8'), 'video de Studio');
  eq(fs.readFileSync(path.join(p.dir, 'Marcador 1 v3 [studio].tsx'), 'utf8'),
    'export default function M() { return null; }',
    'la próxima corrección tiene que partir de lo que de verdad está en la secuencia');
  const ficha = readMeta(path.join(p.dir, 'Marcador 1 v3 [studio].meta.json'));
  eq(ficha.engine, 'remotion');
  eq(ficha.model, 'studio');
  eq(ficha.instruction, 'un lower third con el nombre', 'el encargo se hereda');
  eq(ficha.marker.start, 12, 'con el tramo: es lo que necesita Corrections');
});

test('devuelve las versiones anteriores de la más nueva a la más vieja', function () {
  // Premiere reemplaza la más nueva que encuentre puesta.
  const p = proyecto();
  p.version('Marcador 1', 1, 'remotion');
  p.version('Marcador 1', 2, 'remotion', 'mp4');
  const r = versiones.guardarRenderDeStudio({ archivo: renderDeStudio(p), destino: destinoDe(p) });
  deepEq(r.anteriores.map((a) => path.basename(a)), ['Marcador 1 v2 [modelo].mp4', 'Marcador 1 v1 [modelo].mov']);
});

test('dos renders seguidos son dos versiones, y el segundo encuentra al primero', function () {
  const p = proyecto();
  p.version('Marcador 1', 1, 'remotion');
  versiones.guardarRenderDeStudio({ archivo: renderDeStudio(p), destino: destinoDe(p) });
  const r = versiones.guardarRenderDeStudio({ archivo: renderDeStudio(p), destino: destinoDe(p) });
  eq(r.version, 3);
  eq(path.basename(r.anteriores[0]), 'Marcador 1 v2 [studio].mov',
    'después del primero, el clip de la secuencia ya apunta a la v2');
});

test('un formato que Premiere no va a poder usar se rechaza con qué hacer', function () {
  const p = proyecto();
  p.version('Marcador 1', 1, 'remotion');
  let msg = '';
  try { versiones.guardarRenderDeStudio({ archivo: renderDeStudio(p, 'marcador.webm'), destino: destinoDe(p) }); } catch (e) { msg = e.message; }
  has(msg, 'ProRes (.mov)');
  eq(fs.readdirSync(p.dir).filter((f) => /v2/.test(f)).length, 0, 'y no deja una versión a medias');
});

test('si Studio no dejó el archivo, se dice dónde se buscó', function () {
  const p = proyecto();
  let msg = '';
  try { versiones.guardarRenderDeStudio({ archivo: '/no/esta/marcador.mov', destino: destinoDe(p) }); } catch (e) { msg = e.message; }
  has(msg, '/no/esta/marcador.mov');
});

test('la lista de versiones dice con qué motor se hizo cada una', function () {
  // Es lo que decide si la ficha muestra «Abrir Remotion».
  const p = proyecto();
  p.version('Marcador 1', 1, undefined);
  p.version('Marcador 1', 2, 'remotion');
  const r = versiones.listMarkerVersions({ projectPath: p.projectPath, sequenceName: p.sequenceName, markerSlug: 'Marcador 1' });
  deepEq(r.versions.map((v) => v.version + ':' + v.engine), ['1:hyperframes', '2:remotion'],
    'una ficha sin motor es de HyperFrames, como en todo el panel');
});

// ── 5. En Premiere: reemplazar el archivo del clip puesto ────────────

function coleccion(lista, cuenta) {
  Object.defineProperty(lista, cuenta, { get: function () { return lista.length; } });
  return lista;
}

/**
 * Premiere de mentira. `items` = [{ name, path, bin? }]; cada ítem tiene un
 * clip en la secuencia en el segundo `start`. `niega` = rutas cuyo ítem no deja
 * cambiar el archivo.
 */
function premiere(items, niega) {
  const bins = {};
  const raiz = { name: 'root', type: 2, children: coleccion([], 'numItems') };
  function binDe(nombre) {
    if (!nombre) return raiz;
    if (!bins[nombre]) {
      bins[nombre] = { name: nombre, type: 2, children: coleccion([], 'numItems') };
      raiz.children.push(bins[nombre]);
    }
    return bins[nombre];
  }
  const clips = coleccion([], 'numItems');
  const objetos = items.map(function (a) {
    let ruta = a.path;
    const item = {
      name: a.name, type: 1,
      getMediaPath: function () { return ruta; },
      canChangeMediaPath: function () { return (niega || []).indexOf(a.path) === -1; },
      changeMediaPath: function (p) { ruta = p; return true; },
    };
    binDe(a.bin).children.push(item);
    const clip = { name: a.name, projectItem: item, start: a.start || 0 };
    clips.push(clip);
    return { item: item, clip: clip };
  });
  const seq = { name: 'Clase 3', videoTracks: coleccion([{ clips: clips }], 'numTracks') };
  const sequences = { numSequences: 1, 0: seq };
  function File(p) { this.fsName = p; this.name = String(p).split('/').pop(); this.exists = true; }
  const ctx = { File: File, app: { project: { rootItem: raiz, sequences: sequences, activeSequence: seq } } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'cep', 'jsx', 'host.jsx'), 'utf8'), ctx, { filename: 'host.jsx' });
  return { host: ctx, objetos: objetos };
}

const DIR = '/p/HyperPremiere/clase-3/';

test('el render nuevo reemplaza el archivo del clip, que queda en su lugar', function () {
  const pp = premiere([{ name: 'Marcador 1 v2 [modelo]', path: DIR + 'Marcador 1 v2 [modelo].mov', bin: 'HyperPremiere', start: 12 }]);
  const r = pp.host.hp_relinkMedia(DIR + 'Marcador 1 v2 [modelo].mov\n' + DIR + 'Marcador 1 v1 [modelo].mov',
    DIR + 'Marcador 1 v3 [studio].mov');
  eq(r, 'ok|1|' + DIR + 'Marcador 1 v2 [modelo].mov');
  const o = pp.objetos[0];
  eq(o.item.getMediaPath(), DIR + 'Marcador 1 v3 [studio].mov');
  eq(o.clip.start, 12, 'mismo clip, mismo segundo: no se coloca otro arriba');
  eq(o.item.name, 'Marcador 1 v3 [studio]');
  eq(o.clip.name, 'Marcador 1 v3 [studio]', 'el clip no puede seguir diciendo v2 mostrando la v3');
});

test('si la más nueva no está puesta, reemplaza la que sí', function () {
  const pp = premiere([{ name: 'Marcador 1 v1 [modelo]', path: DIR + 'Marcador 1 v1 [modelo].mov' }]);
  const r = pp.host.hp_relinkMedia(DIR + 'Marcador 1 v2 [modelo].mov\n' + DIR + 'Marcador 1 v1 [modelo].mov',
    DIR + 'Marcador 1 v3 [studio].mov');
  eq(r.indexOf('ok|1|'), 0);
  eq(pp.objetos[0].item.getMediaPath(), DIR + 'Marcador 1 v3 [studio].mov');
});

test('busca por ARCHIVO y no por nombre: el Marcador 1 de otra clase no se toca', function () {
  const otra = '/p/HyperPremiere/clase-9/Marcador 1 v2 [modelo].mov';
  const pp = premiere([{ name: 'Marcador 1 v2 [modelo]', path: otra }]);
  eq(pp.host.hp_relinkMedia(DIR + 'Marcador 1 v2 [modelo].mov', DIR + 'Marcador 1 v3 [studio].mov'), 'nada');
  eq(pp.objetos[0].item.getMediaPath(), otra);
});

test('sin ninguna versión en el proyecto contesta "nada", para que el panel lo coloque', function () {
  const pp = premiere([]);
  eq(pp.host.hp_relinkMedia(DIR + 'Marcador 1 v2 [modelo].mov', DIR + 'Marcador 1 v3 [studio].mov'), 'nada');
});

test('si Premiere no deja cambiar el archivo, se dice, no se finge', function () {
  const v2 = DIR + 'Marcador 1 v2 [modelo].mov';
  const pp = premiere([{ name: 'Marcador 1 v2 [modelo]', path: v2 }], [v2]);
  has(pp.host.hp_relinkMedia(v2, DIR + 'Marcador 1 v3 [studio].mov'), 'error: Premiere no dejó');
  eq(pp.objetos[0].item.getMediaPath(), v2);
});

// ── 6. El panel ───────────────────────────────────────────────────────

/** HPStudioRenders con un host y un motor de mentira. */
function panel(respuestas) {
  const llamadas = [];
  let prog = null;
  const ctx = {
    console: console, Promise: Promise,
    HPLog: { log: function () {} },
    HPUtil: { formatTime: function (s) { return '00:' + (s < 10 ? '0' : '') + s; } },
    HPHost: {
      relinkMedia: function (viejos, nuevo, cb) {
        llamadas.push({ que: 'relink', viejos: viejos, nuevo: nuevo });
        setTimeout(function () { cb(respuestas.relink.shift()); }, 5);
      },
      placeClip: function (mov, seq, start, dur, color, audio, cb) {
        llamadas.push({ que: 'place', mov: mov, seq: seq, start: start, dur: dur });
        setTimeout(function () { cb(respuestas.place || 'ok'); }, 5);
      },
    },
    HPEngine: {
      call: function () { return Promise.resolve({ ok: true, hasAudio: false }); },
      callProg: function (metodo, body, p) {
        llamadas.push({ que: 'escuchar' });
        prog = p;
        return new Promise(function () {});
      },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'cep', 'js', 'studio-renders.js'), 'utf8'), ctx);
  return { api: ctx.HPStudioRenders, llamadas: llamadas, avisar: function (a) { prog({ renderDeStudio: a }); } };
}

function esperar(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

const AVISO = {
  ok: true, etiqueta: 'Marcador 1 v3', markerSlug: 'Marcador 1', sequenceName: 'Clase 3',
  archivo: DIR + 'Marcador 1 v3 [studio].mov', anteriores: [DIR + 'Marcador 1 v2 [modelo].mov'],
  marker: { start: 12, duration: 4 },
};

test('un render de Studio reemplaza el clip puesto, y no coloca otro', async function () {
  const p = panel({ relink: ['ok|1|' + DIR + 'Marcador 1 v2 [modelo].mov'] });
  const resultados = [];
  p.api.escuchar({ alTerminar: function (r) { resultados.push(r); } });
  p.avisar(AVISO);
  await esperar(40);
  eq(p.llamadas.filter((l) => l.que === 'relink').length, 1);
  deepEq(p.llamadas[1].viejos, AVISO.anteriores);
  eq(p.llamadas.filter((l) => l.que === 'place').length, 0);
  eq(resultados[0].ok, true);
  eq(resultados[0].como, 'reemplazado');
});

test('si no había clip puesto, entra como una generación, en el segundo del marcador', async function () {
  const p = panel({ relink: ['nada'] });
  const resultados = [];
  p.api.escuchar({ alTerminar: function (r) { resultados.push(r); } });
  p.avisar(AVISO);
  await esperar(40);
  const place = p.llamadas.filter((l) => l.que === 'place')[0];
  ok(place, 'tenía que colocarlo');
  eq(place.start, 12);
  eq(place.dur, 4);
  eq(place.seq, 'Clase 3');
  eq(resultados[0].como, 'colocado');
});

test('un render que falló se cuenta, y no toca Premiere', async function () {
  const p = panel({ relink: [] });
  const resultados = [];
  p.api.escuchar({ alTerminar: function (r) { resultados.push(r); } });
  p.avisar({ ok: false, etiqueta: 'Marcador 1 v2', error: 'El render de Studio falló: sin memoria' });
  await esperar(20);
  eq(p.llamadas.filter((l) => l.que !== 'escuchar').length, 0);
  eq(resultados[0].ok, false);
  has(resultados[0].texto, 'sin memoria');
});

test('escuchar dos veces es una sola suscripción', function () {
  const p = panel({ relink: [] });
  p.api.escuchar({});
  p.api.escuchar({});
  eq(p.llamadas.filter((l) => l.que === 'escuchar').length, 1, 'dos serían dos reemplazos por render');
});

test('los renders se aplican de a uno: el segundo encuentra el clip ya cambiado', async function () {
  const p = panel({ relink: ['ok|1|a', 'ok|1|b'] });
  p.api.escuchar({});
  p.avisar(AVISO);
  p.avisar(Object.assign({}, AVISO, { etiqueta: 'Marcador 1 v4', archivo: DIR + 'Marcador 1 v4 [studio].mov' }));
  await esperar(3);
  eq(p.llamadas.filter((l) => l.que === 'relink').length, 1, 'el segundo espera al primero');
  await esperar(40);
  eq(p.llamadas.filter((l) => l.que === 'relink').length, 2);
});

test('abierto desde una corrección de otro corte, se coloca en el abierto', async function () {
  // Las versiones están en el corte de origen (`sequenceName`), y una
  // corrección coloca en el que el editor está mirando: lo mismo para el render
  // de Studio, si no hay clip que reemplazar.
  const p = panel({ relink: ['nada'] });
  p.api.escuchar({});
  p.avisar(Object.assign({}, AVISO, { colocarEn: 'Clase 3_02' }));
  await esperar(40);
  eq(p.llamadas.filter((l) => l.que === 'place')[0].seq, 'Clase 3_02');
});

test('quién pinta el resultado queda configurado sin suscribirse', async function () {
  // Lo deja puesto main.js al arrancar: a Studio se lo abre desde tres listas, y
  // la que abre solo pide `escuchar()`.
  const p = panel({ relink: ['ok|1|a'] });
  const resultados = [];
  p.api.configurar({ alTerminar: function (r) { resultados.push(r); } });
  eq(p.llamadas.filter((l) => l.que === 'escuchar').length, 0, 'configurar no se suscribe a nada');
  p.api.escuchar();
  p.avisar(AVISO);
  await esperar(40);
  eq(resultados.length, 1, 'el render se cuenta a quien quedó configurado');
});
