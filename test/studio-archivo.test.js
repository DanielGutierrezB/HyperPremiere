'use strict';

// EN STUDIO SE EDITA EL ARCHIVO DE REMOTION, EL DE VERDAD.
//
// El pedido: «Me abre remotion, pero lo que abro no es editable, debería ser el
// archivo de remotion como tal, así lo edito como quiera». Studio mostraba la
// animación desde un texto en sus props; ahora corre el `.tsx` del marcador,
// que el editor abre en su editor. Acá se prueba sin levantar Studio:
//
//   1. Dónde vive el archivo de cada marcador, y que se llame como el marcador.
//   2. Que abrir un marcador no pise lo que el editor escribió y no renderizó.
//   3. Cuál de los archivos muestra Studio.
//   4. Que el render guarde el código que tenía el archivo AL ARRANCAR.
//   5. Que el archivo se abra con el editor del sistema, y solo desde la ficha.
//
// Que Studio de verdad recargue al guardar y que el render salga con el cambio
// lo mide test/manual/studio-render.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq, deepEq, has } = require('./harness');

const editables = require('../bridge/render/remotion-editables');
const studio = require('../bridge/render/remotion-studio');
const instalar = require('../bridge/render/remotion-instalar');
const versiones = require('../bridge/versiones');
const motores = require('../bridge/render/motores');
const abrir = require('../bridge/abrir-archivo');
const { writeVersionMeta } = require('../bridge/store/project-fs');

const HUESPED = path.join(__dirname, '..', 'bridge', 'remotion-host');

function carpeta(prefijo) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefijo || 'hp-editable-'));
}

const MARCADOR = { projectPath: '/proyectos/Curso.prproj', sequenceName: 'Clase 3', markerSlug: 'Marcador 1' };

function pedido(version, codigo, extra) {
  return Object.assign({}, MARCADOR, { version: version, codigo: codigo }, extra || {});
}

// ── 1. Dónde vive ─────────────────────────────────────────────────────

test('el archivo de un marcador se llama como el marcador, en la carpeta de su secuencia', function () {
  const raiz = carpeta();
  const archivo = editables.rutaDelArchivo(raiz, MARCADOR);
  eq(path.basename(archivo), 'Marcador 1.tsx', 'es lo que el editor ve en la pestaña de su editor');
  eq(path.dirname(path.dirname(archivo)), path.join(raiz, 'marcadores'));
  ok(/^Clase 3 - [0-9a-f]{6}$/.test(path.basename(path.dirname(archivo))), path.basename(path.dirname(archivo)));
});

test('la misma "Clase 3" de dos proyectos no comparte archivo', function () {
  // Cada curso tiene su "Clase 3" con su "Marcador 1": abrir el de un proyecto
  // no puede mostrar —ni respaldar— lo que el editor escribió en el del otro.
  const raiz = carpeta();
  const a = editables.rutaDelArchivo(raiz, MARCADOR);
  const b = editables.rutaDelArchivo(raiz, Object.assign({}, MARCADOR, { projectPath: '/otro/Curso.prproj' }));
  ok(a !== b);
  eq(path.basename(a), path.basename(b), 'el nombre del archivo es el mismo; lo que cambia es la carpeta');
});

test('un nombre que Windows o webpack no aceptan se limpia', function () {
  // `#` y `?` cortan una ruta de import; `:` y `"` no los acepta Windows; un
  // punto al final, tampoco.
  const raiz = carpeta();
  const archivo = editables.rutaDelArchivo(raiz, {
    projectPath: 'p', sequenceName: 'Clase: "uno"', markerSlug: 'Gráfico #1? del 50%.',
  });
  const nombre = path.basename(archivo, '.tsx');
  ok(!/[#?%:"]/.test(nombre) && !/\.$/.test(nombre), nombre);
  has(nombre, 'Gráfico', 'lo que sí se puede escribir queda como estaba');
  ok(!/[:"]/.test(path.basename(path.dirname(archivo))));
  eq(path.basename(editables.rutaDelArchivo(raiz, { sequenceName: 's', markerSlug: 'CON' })), 'CON_.tsx',
    'un nombre reservado de Windows no se puede crear');
});

test('el huésped se pone al día sin tocar los archivos de los marcadores', function () {
  // sincronizarHuesped borra lo que sobra en src/; lo del editor vive afuera.
  const dir = carpeta();
  const archivo = editables.preparar(dir, pedido(1, 'lo que escribió el editor')).archivo;
  instalar.sincronizarHuesped(dir);
  eq(fs.readFileSync(archivo, 'utf8'), 'lo que escribió el editor');
  ok(fs.existsSync(path.join(dir, 'src', 'studio.ts')), 'y llega la entrada de Studio');
});

test('el tsconfig del huésped incluye los marcadores, para que el editor encuentre los tipos', function () {
  const cfg = JSON.parse(fs.readFileSync(path.join(HUESPED, 'tsconfig.json'), 'utf8'));
  ok(cfg.include.indexOf('marcadores') !== -1, 'sin esto, el editor de código no sabe qué es `remotion`');
  eq(cfg.compilerOptions.strict, false,
    'sin tipos de React instalados, el modo estricto marca como error cada etiqueta de JSX');
});

// ── 2. No perder lo que el editor escribió ────────────────────────────

test('la primera vez se escribe el código de la versión', function () {
  const raiz = carpeta();
  const r = editables.preparar(raiz, pedido(2, 'código de la v2'));
  eq(r.accion, 'nuevo');
  eq(fs.readFileSync(r.archivo, 'utf8'), 'código de la v2');
});

test('una versión más nueva reemplaza un archivo que nadie tocó, sin respaldo', function () {
  const raiz = carpeta();
  editables.preparar(raiz, pedido(2, 'código de la v2'));
  const r = editables.preparar(raiz, pedido(3, 'código de la v3'));
  eq(r.accion, 'actualizado');
  eq(fs.readFileSync(r.archivo, 'utf8'), 'código de la v3');
  ok(!fs.existsSync(path.join(path.dirname(r.archivo), 'respaldos')), 'no había nada que respaldar');
});

test('volver a abrir la misma versión deja lo que el editor escribió', function () {
  // Es volver a Studio a seguir editando: pisarlo con la versión sería borrarle
  // el trabajo al editor sin avisar.
  const raiz = carpeta();
  const archivo = editables.preparar(raiz, pedido(2, 'código de la v2')).archivo;
  fs.writeFileSync(archivo, 'la v2 con el título más grande');
  const r = editables.preparar(raiz, pedido(2, 'código de la v2'));
  eq(r.accion, 'conservado');
  eq(r.base, 2);
  eq(fs.readFileSync(archivo, 'utf8'), 'la v2 con el título más grande');
});

test('abrir una versión más nueva guarda antes lo que el editor no renderizó', function () {
  const raiz = carpeta();
  const archivo = editables.preparar(raiz, pedido(2, 'código de la v2')).archivo;
  fs.writeFileSync(archivo, 'la v2 con el título más grande');
  const r = editables.preparar(raiz, pedido(3, 'código de la v3'), new Date(2026, 9, 7, 16, 5, 9));
  eq(r.accion, 'respaldado');
  eq(fs.readFileSync(archivo, 'utf8'), 'código de la v3');
  eq(path.basename(r.respaldo), 'Marcador 1 (sin renderizar, 2026-10-07 16.05.09).tsx');
  eq(fs.readFileSync(r.respaldo, 'utf8'), 'la v2 con el título más grande');
});

test('dos respaldos en el mismo segundo no se pisan', function () {
  const raiz = carpeta();
  const ahora = new Date(2026, 9, 7, 16, 5, 9);
  const archivo = editables.preparar(raiz, pedido(1, 'v1')).archivo;
  fs.writeFileSync(archivo, 'cambio A');
  const a = editables.preparar(raiz, pedido(2, 'v2'), ahora).respaldo;
  fs.writeFileSync(archivo, 'cambio B');
  const b = editables.preparar(raiz, pedido(3, 'v3'), ahora).respaldo;
  ok(a !== b);
  eq(fs.readFileSync(a, 'utf8'), 'cambio A');
  eq(fs.readFileSync(b, 'utf8'), 'cambio B');
});

test('lo que manda el editor del panel gana, pero lo del archivo queda respaldado', function () {
  const raiz = carpeta();
  const archivo = editables.preparar(raiz, pedido(2, 'código de la v2')).archivo;
  fs.writeFileSync(archivo, 'editado en el editor de código');
  const r = editables.preparar(raiz, pedido(2, 'editado en el panel', { explicito: true }));
  eq(r.accion, 'respaldado');
  eq(fs.readFileSync(archivo, 'utf8'), 'editado en el panel');
  eq(fs.readFileSync(r.respaldo, 'utf8'), 'editado en el editor de código');
});

test('un archivo que no se sabe de dónde salió también se respalda', function () {
  // Sin anotación (se borró, o lo puso alguien a mano) no hay cómo saber si
  // tiene trabajo adentro: lo único seguro es no perderlo.
  const raiz = carpeta();
  const archivo = editables.rutaDelArchivo(raiz, MARCADOR);
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.writeFileSync(archivo, 'de origen desconocido');
  const r = editables.preparar(raiz, pedido(1, 'código de la v1'));
  eq(r.accion, 'respaldado');
  eq(fs.readFileSync(r.respaldo, 'utf8'), 'de origen desconocido');
});

test('después de un render de Studio, lo que tenía el archivo ya no cuenta como sin renderizar', function () {
  const raiz = carpeta();
  const archivo = editables.preparar(raiz, pedido(2, 'código de la v2')).archivo;
  fs.writeFileSync(archivo, 'la v2 editada');
  editables.alGuardarVersion(raiz, archivo, 3, 'la v2 editada');
  // La v3 es exactamente lo que tenía el archivo: abrirla no respalda nada.
  eq(editables.preparar(raiz, pedido(3, 'la v2 editada')).accion, 'igual');
  // Y si el editor sigue escribiendo, eso es "sin renderizar" sobre la v3.
  fs.writeFileSync(archivo, 'la v3 con otro cambio');
  eq(editables.preparar(raiz, pedido(3, 'la v2 editada')).accion, 'conservado');
  const r = editables.preparar(raiz, pedido(4, 'código de la v4'));
  eq(r.accion, 'respaldado');
  eq(fs.readFileSync(r.respaldo, 'utf8'), 'la v3 con otro cambio');
});

// ── 3. Cuál muestra Studio ────────────────────────────────────────────

test('Studio muestra el archivo al que apunta marcadores/abierto.ts', function () {
  const raiz = carpeta();
  const archivo = editables.preparar(raiz, pedido(1, 'v1')).archivo;
  ok(editables.apuntar(raiz, archivo));
  const abierto = path.join(raiz, 'marcadores', 'abierto.ts');
  const ruta = './' + path.basename(path.dirname(archivo)) + '/Marcador 1';
  has(fs.readFileSync(abierto, 'utf8'), 'export {default} from ' + JSON.stringify(ruta) + ';',
    'ruta relativa, con barras de las de import y sin extensión');
  eq(editables.apuntar(raiz, archivo), false, 'apuntar al mismo no reescribe: webpack recompilaría por nada');
});

test('lo editado en un marcador que Studio no mostraba se ve al volver a él', function () {
  // Webpack vigila solo el archivo que Studio muestra, y lee con una caché que
  // vacía únicamente para lo que el vigilante vio cambiar: sin vaciarla para
  // `marcadores/`, Studio mostraba lo de antes (medido con el Studio de verdad,
  // test/manual/studio-render.js). Lo que se puede mirar acá es que la config
  // de Studio lo haga en cada recompilación.
  const cfg = fs.readFileSync(path.join(HUESPED, 'remotion.config.ts'), 'utf8');
  has(cfg, "const MARCADORES = path.join(process.cwd(), 'marcadores');");
  has(cfg, 'compiler.hooks.watchRun.tap(');
  has(cfg, 'cache.purge(MARCADORES)');
});

test('la raíz de Studio muestra ese archivo, y React está antes de que cargue', function () {
  // El código del modelo no importa React (el render del panel se lo pasa), y
  // en Studio el JSX se compila a `React.createElement`: si `react-global` no
  // se evalúa ANTES que el archivo del marcador, la primera etiqueta tira.
  const raiz = fs.readFileSync(path.join(HUESPED, 'src', 'RaizStudio.tsx'), 'utf8');
  has(raiz, "import Animacion from '../marcadores/abierto';");
  const entrada = fs.readFileSync(path.join(HUESPED, 'src', 'studio.ts'), 'utf8');
  const imports = entrada.split('\n').filter((l) => /^import /.test(l));
  eq(imports[0], "import './react-global';", 'el primer import de la entrada de Studio');
  has(fs.readFileSync(path.join(__dirname, '..', 'bridge', 'render', 'remotion-studio.js'), 'utf8'),
    "path.join('src', 'studio.ts')", 'Studio arranca con su entrada, no con la del render del panel');
});

// ── 4. El render guarda lo que tenía el archivo al arrancar ───────────

function trabajo(id, estado, destino) {
  return {
    id: id, type: 'video', status: estado, outName: 'out/marcador.mov', codec: 'prores',
    serializedInputPropsWithCustomSchema: JSON.stringify({ destino: destino }),
  };
}

test('el render guarda el código del archivo cuando arrancó, no el de después', async function () {
  const raiz = carpeta();
  const archivo = editables.preparar(raiz, pedido(2, 'v2')).archivo;
  const s = studio._sesionNueva({ dir: raiz });
  s.destinos.d = Object.assign({ etiqueta: 'Marcador 1 v2', archivo: archivo }, MARCADOR);
  const guardados = [];
  s.alTerminar = function (r) { guardados.push(r); return { version: 3, etiqueta: 'Marcador 1 v3' }; };
  fs.writeFileSync(archivo, 'lo que se renderizó');
  studio._alCambiarLaCola(s, [trabajo('1', 'running', 'd')]);
  fs.writeFileSync(archivo, 'lo que el editor siguió escribiendo');
  const terminados = studio._alCambiarLaCola(s, [trabajo('1', 'done', 'd')]);
  await studio._procesar(s, terminados[0]);
  eq(guardados[0].codigo, 'lo que se renderizó');
  // Lo que siguió escribiendo es "sin renderizar" sobre la v3 que acaba de salir.
  eq(editables.preparar(raiz, pedido(3, 'lo que se renderizó')).accion, 'conservado');
});

test('si el render terminó sin que se lo viera arrancar, se guarda lo que tiene el archivo', async function () {
  const raiz = carpeta();
  const archivo = editables.preparar(raiz, pedido(2, 'v2')).archivo;
  const s = studio._sesionNueva({ dir: raiz });
  s.destinos.d = Object.assign({ etiqueta: 'Marcador 1 v2', archivo: archivo }, MARCADOR);
  let codigo = null;
  s.alTerminar = function (r) { codigo = r.codigo; return { version: 3 }; };
  fs.writeFileSync(archivo, 'editado');
  await studio._procesar(s, studio._alCambiarLaCola(s, [trabajo('1', 'done', 'd')])[0]);
  eq(codigo, 'editado');
});

test('la versión de Studio se escribe con el código del archivo', function () {
  const raiz = carpeta();
  const projectPath = path.join(raiz, 'Curso.prproj');
  fs.writeFileSync(projectPath, 'x');
  const video = path.join(carpeta(), 'marcador.mov');
  fs.writeFileSync(video, 'un video');
  const destino = {
    projectPath: projectPath, sequenceName: 'Clase 3', markerSlug: 'Marcador 1', version: 2,
    marker: { name: 'Marcador 1', start: 12, duration: 4 }, code: 'lo que se mostró al abrir',
  };
  const r = versiones.guardarRenderDeStudio({ archivo: video, destino: destino, codigo: 'lo del archivo' });
  eq(fs.readFileSync(r.archivo.replace(/\.mov$/, '.tsx'), 'utf8'), 'lo del archivo');
  const sin = versiones.guardarRenderDeStudio({ archivo: video, destino: destino });
  eq(fs.readFileSync(sin.archivo.replace(/\.mov$/, '.tsx'), 'utf8'), 'lo que se mostró al abrir',
    'sin archivo que leer, el código con que se abrió');
});

// ── 5. Abrirlo en el editor ───────────────────────────────────────────

function registrador(fallan) {
  const visto = [];
  return {
    visto: visto,
    correr: function (cmd, args, cualquierSalida) {
      visto.push([cmd].concat(args).join(' ') + (cualquierSalida ? ' (cualquier salida)' : ''));
      return fallan && fallan.indexOf(cmd + ' ' + args[0]) !== -1
        ? Promise.reject(new Error('no hay aplicación')) : Promise.resolve();
    },
  };
}

test('en macOS se abre con la aplicación de los .tsx', async function () {
  const reg = registrador();
  const r = await abrir.abrirArchivo('/m/Marcador 1.tsx', { plataforma: 'darwin', correr: reg.correr });
  ok(r.ok);
  deepEq(reg.visto, ['open /m/Marcador 1.tsx']);
});

test('en macOS sin editor de código, con el editor de texto', async function () {
  const reg = registrador(['open /m/Marcador 1.tsx']);
  const r = await abrir.abrirArchivo('/m/Marcador 1.tsx', { plataforma: 'darwin', correr: reg.correr });
  ok(r.ok);
  eq(r.con, 'el editor de texto');
  deepEq(reg.visto, ['open /m/Marcador 1.tsx', 'open -t /m/Marcador 1.tsx']);
});

test('en Windows, con el Explorador, que sale con 1 aunque lo haya abierto', async function () {
  const reg = registrador();
  const r = await abrir.abrirArchivo('C:\\m\\Marcador 1.tsx', { plataforma: 'win32', correr: reg.correr });
  ok(r.ok);
  deepEq(reg.visto, ['explorer.exe C:\\m\\Marcador 1.tsx (cualquier salida)']);
});

test('no poder abrirlo no tira: se dice por qué', async function () {
  const reg = registrador(['open /m/x.tsx', 'open -t']);
  const r = await abrir.abrirArchivo('/m/x.tsx', { plataforma: 'darwin', correr: reg.correr });
  eq(r.ok, false);
  has(r.error, 'no hay aplicación');
});

/** Un motor con vista previa desde un archivo, que anota lo que le piden. */
function motorDeJuguete() {
  const pedidos = [];
  motores.registrar({
    id: 'juguete-archivo', nombre: 'Juguete', lenguaje: motores.motor('remotion').lenguaje,
    vistaPrevia: function (o) {
      pedidos.push(o);
      return Promise.resolve({ url: 'http://localhost:1/', arrancado: true, etiqueta: o.etiqueta,
        archivo: '/marcadores/Clase 3 - abc123/Marcador 1.tsx', accion: 'nuevo' });
    },
  });
  return pedidos;
}

function proyectoCon(codigo) {
  const raiz = carpeta();
  const projectPath = path.join(raiz, 'Curso.prproj');
  fs.writeFileSync(projectPath, 'x');
  const dir = path.join(raiz, 'HyperPremiere', 'clase-3');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Marcador 1 v1 [modelo].tsx'), codigo);
  writeVersionMeta(path.join(dir, 'Marcador 1 v1 [modelo].meta.json'), {
    sequenceName: 'Clase 3', markerSlug: 'Marcador 1', version: 1, model: 'modelo',
    engine: 'juguete-archivo', marker: { name: 'Marcador 1', start: 12, duration: 4 },
  });
  return { projectPath: projectPath, sequenceName: 'Clase 3', markerSlug: 'Marcador 1', version: 1 };
}

async function conAbrirDeMentira(fn) {
  const previo = abrir.abrirArchivo;
  const abiertos = [];
  abrir.abrirArchivo = function (archivo) { abiertos.push(archivo); return Promise.resolve({ ok: true }); };
  try {
    await fn(abiertos);
  } finally {
    abrir.abrirArchivo = previo;
    motores._olvidar('juguete-archivo');
  }
}

test('«Abrir Remotion» abre el archivo en el editor; la vista previa del editor del panel, no', async function () {
  await conAbrirDeMentira(async function (abiertos) {
    motorDeJuguete();
    const p = proyectoCon('export default () => null;');
    const r = await versiones.previewComposition(Object.assign({ abrirArchivo: true }, p));
    ok(r.ok, r.error);
    deepEq(abiertos, ['/marcadores/Clase 3 - abc123/Marcador 1.tsx']);
    deepEq(r.editor, { ok: true }, 'y el panel se entera de si pudo');
    await versiones.previewComposition(p);
    eq(abiertos.length, 1, 'el editor del panel ya tiene el código delante');
  });
});

test('el código del editor del panel solo gana si de verdad lo cambiaron', async function () {
  // El editor del panel manda lo que tiene siempre, aunque sea la versión tal
  // cual se abrió. Si contara como pedido explícito, mirarla desde ahí le
  // respaldaría y pisaría al editor lo que escribió en su editor de código.
  await conAbrirDeMentira(async function () {
    const pedidos = motorDeJuguete();
    const p = proyectoCon('export default () => null;');
    await versiones.previewComposition(Object.assign({ code: 'export default () => null;' }, p));
    eq(pedidos[0].explicito, false, 'la versión tal cual');
    await versiones.previewComposition(Object.assign({ code: 'export default () => <div />;' }, p));
    eq(pedidos[1].explicito, true, 'cambiada en el editor del panel');
    await versiones.previewComposition(p);
    eq(pedidos[2].explicito, false, 'sin código del panel, la versión de disco');
  });
});
