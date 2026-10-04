'use strict';

// CON QUÉ NODE lanza el panel los procesos de Remotion.
//
// Esto es la prueba de un fallo REAL, y de los caros: el motor de Remotion se
// escribió, se auditó y se verificó entero —1405 tests, 386 mutaciones, renders
// de verdad con alfa comprobado por ffprobe— y el primer render que se pidió
// desde Premiere murió así:
//
//     Remotion falló (código 255)
//     (sin salida)
//
// El motivo: los tres procesos hijos de Remotion se lanzaban con
// `process.execPath`. En una terminal eso ES un node —por eso ninguna de las
// verificaciones lo tocó— pero adentro de Premiere es un binario de Adobe: CEP
// no corre `node`, corre un Chromium con Node embebido. El binario existe y se
// puede ejecutar, así que `spawn` no protesta: arranca, no entiende el script y
// se muere callado.
//
// La lección para los tests es la que se prueba acá: NO alcanza con "corre bien
// cuando lo corro yo". Estos tests SIMULAN el entorno del panel escribiéndole a
// `process.execPath` un ejecutable que no es node, que es la única diferencia
// entre la mesa de trabajo y el único lugar donde el panel corre de verdad.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { test, ok, eq, has } = require('./harness');

const nodeBin = require('../bridge/render/node-bin');
const motores = require('../bridge/render');
const instalacion = require('../bridge/render/remotion-instalar');

const WORKER = path.join(__dirname, '..', 'bridge', 'render', 'remotion-worker.js');

function carpeta() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hp-nodebin-'));
}

/**
 * Un ejecutable de mentira con el nombre que se le pida.
 *
 * Contesta la versión que se le diga —así se puede hacer pasar por un node de
 * cualquier edad— y deja una MARCA en el disco cada vez que lo ejecutan. La
 * marca es lo que permite afirmar que a un candidato NI SE LO PROBÓ, que es más
 * fuerte que afirmar que no se lo eligió.
 */
function ejecutableFalso(dir, nombre, versionQueDice) {
  const bin = path.join(dir, nombre);
  const marca = path.join(dir, nombre + '.lo-ejecutaron');
  fs.writeFileSync(bin,
    '#!/bin/sh\n' +
    'touch "' + marca + '"\n' +
    'echo "' + versionQueDice + '"\n', 'utf8');
  fs.chmodSync(bin, 0o755);
  return { bin: bin, loEjecutaron: () => fs.existsSync(marca) };
}

/**
 * Corre `fn` pudiendo ensuciar `process.execPath`, el entorno y el caché.
 *
 * Los tres son estado del PROCESO y la suite entera comparte uno: sin devolver
 * las cosas como estaban, el próximo test hereda un panel que cree estar dentro
 * de Premiere.
 */
async function conEntornoDelPanel(fn) {
  const execPathReal = process.execPath;
  const escotillaReal = process.env.HYPERPREMIERE_NODE;
  try {
    return await fn();
  } finally {
    process.execPath = execPathReal;
    if (escotillaReal === undefined) delete process.env.HYPERPREMIERE_NODE;
    else process.env.HYPERPREMIERE_NODE = escotillaReal;
    nodeBin._olvidar();
  }
}

/** Lo que dejó dicho un proceso: `{ code, out, err }`. */
function correr(bin, args) {
  return new Promise((resolve) => {
    const hijo = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    hijo.stdout.on('data', (d) => { out += d; });
    hijo.stderr.on('data', (d) => { err += d; });
    hijo.on('error', (e) => resolve({ code: -1, out: out, err: String(e.message) }));
    hijo.on('close', (code) => resolve({ code: code, out: out, err: err }));
  });
}

// ── 1. El fallo del editor, simulado ────────────────────────────────

test('adentro de Premiere NO se usa process.execPath, que ahí no es node', async function () {
  await conEntornoDelPanel(async function () {
    const dir = carpeta();
    // El nombre importa: es el del ejecutable que CEP le pone a `execPath`.
    // Y contesta una versión buena a propósito — si el código lo probara, lo
    // aceptaría, y estaríamos de vuelta en el render de 255.
    const cep = ejecutableFalso(dir, 'CEPHtmlEngine', '26.8.2');
    process.execPath = cep.bin;
    nodeBin._olvidar();

    const elegido = await nodeBin.nodeBin();

    ok(elegido !== cep.bin, 'eligió el binario de CEP como si fuera node');
    ok(!cep.loEjecutaron(),
      'ejecutó el binario de CEP para preguntarle la versión: a un candidato que no se ' +
      'llama node no hay que lanzarlo (el ejecutable de Premiere se queda vivo)');
  });
});

test('lo que se elige adentro de Premiere puede correr el worker del render', async function () {
  await conEntornoDelPanel(async function () {
    const dir = carpeta();
    process.execPath = ejecutableFalso(dir, 'CEPHtmlEngine', '26.8.2').bin;
    nodeBin._olvidar();

    // La prueba que el fallo del editor no tuvo: lanzar el worker DE VERDAD con
    // el binario resuelto. Sin argumentos se queja por su protocolo —una línea
    // de JSON en stdout— y eso es exactamente lo que no pasó en Premiere, donde
    // el hijo salió 255 sin escribir un byte. No necesita que Remotion esté
    // instalado: el worker se queja antes de requerirlo.
    const r = await correr(await nodeBin.nodeBin(), [WORKER]);

    eq(r.code, 1, 'el worker no terminó como termina cuando le falta el pedido');
    has(r.out, '"error"', 'el worker no dijo lo suyo por stdout');
    has(r.out, 'falta la ruta del pedido', 'el error no es el que corresponde');
  });
});

// ── 1 bis. El mismo fallo, pero entrando por donde entró ────────────

/**
 * Una instalación de Remotion de mentira, con lo mínimo para llegar al spawn.
 *
 * `renderizar` necesita dos cosas del disco antes de lanzar el hijo: que el
 * estado diga "instalado" y que Babel esté ahí para compilar. Nada más. El
 * worker sí va a fallar —no hay ningún `@remotion/renderer` que requerir— y eso
 * es justo lo que se quiere: un hijo que FALLA pero que HABLA es la prueba de
 * que se lanzó un node de verdad. El Remotion completo son 400 MB y su prueba
 * vive en test/manual/motores-comparar.js.
 */
function instalacionDeMentira() {
  const dir = carpeta();
  const babel = path.join(dir, 'node_modules', '@babel', 'standalone');
  fs.mkdirSync(babel, { recursive: true });
  fs.writeFileSync(path.join(babel, 'package.json'), '{"name":"@babel/standalone","main":"index.js"}', 'utf8');
  fs.writeFileSync(path.join(babel, 'index.js'),
    'module.exports = { transform: function (code) { return { code: code }; } };\n', 'utf8');
  return dir;
}

test('el render del motor lanza un node de verdad, no el ejecutable de CEP', async function () {
  await conEntornoDelPanel(async function () {
    const dir = instalacionDeMentira();
    process.execPath = ejecutableFalso(carpeta(), 'CEPHtmlEngine', '26.8.2').bin;
    nodeBin._olvidar();

    const estadoReal = instalacion.estado;
    instalacion.estado = () => ({ instalado: true, motivo: '', dir: dir });
    let mensaje = '';
    try {
      await motores.motor('remotion').renderizar({
        code: 'module.exports.default = function () { return null; };',
        outPath: path.join(dir, 'salida.mov'),
        durationSec: 1,
        format: 'mov',
      });
      mensaje = '(no falló, y tenía que fallar: no hay renderer)';
    } catch (e) {
      mensaje = String(e.message);
    } finally {
      instalacion.estado = estadoReal;
    }

    // Que el hijo se queje de lo SUYO significa que corrió nuestro worker. Con
    // `process.execPath` acá —el bug— lo que se lanzaba era el binario de Adobe
    // y el mensaje era el de la otra afirmación: un código de salida y nada más.
    has(mensaje, 'Cannot find module', 'el worker no llegó a correr');
    has(mensaje, '@remotion', 'el worker no falló por donde tenía que fallar');
    ok(mensaje.indexOf('no escribió nada') === -1,
      'el hijo salió mudo, que es la firma de haber lanzado algo que no es node:\n      ' + mensaje);
  });
});

// ── 2. Qué se acepta como node y qué no ─────────────────────────────

test('un node demasiado viejo para Remotion no se acepta', async function () {
  await conEntornoDelPanel(async function () {
    const dir = carpeta();
    // Node 17: ejecuta, contesta y es un node de verdad. Lo único que tiene de
    // malo es la edad, y por eso se descarta acá y no adentro de una dependencia.
    const viejo = ejecutableFalso(dir, 'node', '17.9.1');
    process.env.HYPERPREMIERE_NODE = viejo.bin;
    nodeBin._olvidar();

    const elegido = await nodeBin.nodeBin();

    ok(viejo.loEjecutaron(), 'no le preguntó la versión, así que no la está mirando');
    ok(elegido !== viejo.bin, 'aceptó un Node 17, que Remotion no soporta');
  });
});

test('la escotilla HYPERPREMIERE_NODE gana cuando apunta a un node usable', async function () {
  await conEntornoDelPanel(async function () {
    const dir = carpeta();
    // Un envoltorio del node real: es node para todo efecto práctico, pero está
    // en un lugar donde ni el PATH ni las rutas conocidas lo encontrarían. Es el
    // caso del editor que tiene su Node en una carpeta propia.
    const shim = path.join(dir, 'mi-node');
    fs.writeFileSync(shim, '#!/bin/sh\nexec "' + process.execPath + '" "$@"\n', 'utf8');
    fs.chmodSync(shim, 0o755);
    process.env.HYPERPREMIERE_NODE = shim;
    nodeBin._olvidar();

    const hit = await nodeBin._buscar();

    eq(hit.path, shim, 'no usó el node que se le señaló');
    eq(hit.source, 'HYPERPREMIERE_NODE', 'lo encontró por otro camino');
  });
});

// ── 3. Una sola búsqueda por proceso ────────────────────────────────

test('la búsqueda se hace una vez y se reusa', async function () {
  await conEntornoDelPanel(async function () {
    const primero = await nodeBin.nodeBin();

    // Se le cambia el mundo por debajo: si volviera a buscar, con este
    // `execPath` la respuesta tendría que cambiar. Que NO cambie es la prueba de
    // que la respuesta quedó guardada, que es lo que evita que cuatro carriles
    // de render se pongan a preguntarle al shell de login cada uno lo suyo.
    const dir = carpeta();
    process.execPath = ejecutableFalso(dir, 'CEPHtmlEngine', '26.8.2').bin;
    eq(await nodeBin.nodeBin(), primero, 'volvió a buscar en vez de reusar');

    // Y `_olvidar` tiene que soltarla de verdad, o los tests de acá arriba no
    // estarían probando lo que creen.
    nodeBin._olvidar();
    const segundo = await nodeBin.nodeBin();
    ok(segundo && segundo !== process.execPath, 'después de olvidar no volvió a buscar bien');
  });
});

test('los cuatro carriles de render comparten una sola búsqueda', async function () {
  await conEntornoDelPanel(async function () {
    nodeBin._olvidar();
    // Arrancan JUNTOS, como cuando la cola larga cuatro renders de una: tienen
    // que terminar todos con la misma respuesta.
    const todos = await Promise.all([0, 1, 2, 3].map(() => nodeBin.nodeBin()));
    todos.forEach((p) => eq(p, todos[0], 'dos carriles resolvieron node distinto'));
    ok(todos[0], 'no resolvió ninguno');
  });
});
