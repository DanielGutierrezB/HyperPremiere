// CON QUÉ NODE se lanzan los procesos hijos de Remotion.
//
// ── El error que este módulo existe para no repetir ──────────────────
//
// `process.execPath` es "el ejecutable de Node que está corriendo esto". En una
// terminal —o en los tests, o en los arneses de test/manual— eso es un `node` de
// verdad, y es exactamente el binario que uno quiere para lanzar un hijo.
// Adentro de Premiere NO: CEP no corre `node`, corre un Chromium
// (CEPHtmlEngine) con Node EMBEBIDO, así que `execPath` apunta a un binario de
// Adobe. En el bundle de Premiere no hay ningún `node` que encontrar. Es el
// mismo motivo por el que `child_process.fork()` tampoco funciona en un panel de
// CEP, y es una de esas cosas que anda perfecto en toda la mesa de trabajo y
// falla solo en el único lugar donde el panel corre de verdad.
//
// Lo peor no es que falle, es CÓMO falla. El binario existe y tiene permiso de
// ejecución, así que `spawn` no protesta: el proceso arranca, no sabe qué hacer
// con el script que le pasamos y se muere en el mismo segundo sin escribir una
// línea en stdout ni en stderr. Lo que le llegó al editor fue:
//
//     Remotion falló (código 255)
//     (sin salida)
//
// Un mensaje que acusa a Remotion —la única pieza que no tenía nada que ver— y
// que no se puede seguir a ningún lado. El modelo, la validación y el compilador
// habían andado bien; lo único roto era el primer argumento del spawn.
//
// ── Por eso acá se PRUEBA, no se adivina ─────────────────────────────
//
// A cada candidato se le pregunta su versión y se usa el primero que contesta
// como Node. Es la misma regla que `remotion-instalar.js` aplica con el
// navegador: en un camino donde la falla es silenciosa, confiar en que el paso
// anterior salió bien es justamente el error.
//
// ── Por qué el PATH no alcanza solo ──────────────────────────────────
//
// `engine.js` ya le agrega Homebrew y compañía al PATH del panel, y con eso un
// `node` pelado se resuelve en la mayoría de las máquinas. Pero nvm, fnm y volta
// no dejan nada en esos directorios: su `node` aparece recién cuando el shell de
// LOGIN lee el perfil del usuario. Es el mismo problema que `transcribe.js`
// tiene con los Python de pyenv/conda, y se resuelve igual — si el PATH no lo
// tiene, se le pregunta al shell de login.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { run } = require('../exec');

const IS_WIN = process.platform === 'win32';

// Remotion 4 pide Node 18. Cortar acá y decirlo con estas palabras es mejor que
// dejarlo pasar: con un Node más viejo el fallo aparece como un error de
// sintaxis en el medio de una dependencia, que no le dice nada a nadie.
const VERSION_MINIMA = 18;

// Preguntarle la versión a un binario es instantáneo cuando es Node. El tope
// corto es para el caso contrario: si el candidato resulta ser una aplicación de
// interfaz, se queda viva esperando y sin esto la espera sería de dos minutos.
const PREGUNTA_MS = 8000;

/** Rutas donde cada forma de instalar Node deja su ejecutable. */
function rutasConocidas() {
  const home = os.homedir();
  if (IS_WIN) {
    const programas = process.env.ProgramFiles || 'C:\\Program Files';
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(programas, 'nodejs', 'node.exe'),
      path.join(local, 'Volta', 'bin', 'node.exe'),
      path.join(home, 'AppData', 'Roaming', 'nvm', 'node.exe'),
    ];
  }
  // nvm y fnm no están en esta lista a propósito: sus rutas llevan el número de
  // versión adentro, así que escribirlas acá es elegir una versión a mano y
  // quedar desactualizado en cuanto el editor actualice. A esos los encuentra el
  // shell de login, que es el que sabe cuál eligió.
  return [
    '/opt/homebrew/bin/node',            // mac, Apple Silicon
    '/usr/local/bin/node',               // mac Intel, y el instalador oficial
    '/usr/bin/node',                     // linux por paquete del sistema
    path.join(home, '.volta', 'bin', 'node'),
    path.join(home, '.local', 'bin', 'node'),
  ];
}

function existe(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }
}

/**
 * La versión MAYOR que dice tener este binario, o 0 si no contestó como Node.
 *
 * Se le pide por `-p` en vez de `--version` porque así se verifican dos cosas de
 * una: que el binario sea Node, y que pueda ejecutar código.
 */
async function versionMayorDe(bin) {
  const r = await run(bin, ['-p', 'process.versions.node'], { timeoutMs: PREGUNTA_MS });
  if (r.code !== 0) return 0;
  const m = /^(\d+)\./.exec(String(r.out).trim());
  return m ? parseInt(m[1], 10) : 0;
}

/** Las líneas útiles de un `which`/`where`. */
function lineas(txt) {
  return String(txt || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

function mensajeDeQueNoHay(buscados, viejos) {
  const comoInstalar = IS_WIN
    ? 'Qué hacer: instalá Node desde https://nodejs.org (la versión LTS).'
    : 'Qué hacer: instalá Node con  brew install node  (o desde https://nodejs.org, la versión LTS).';
  return 'Para renderizar con Remotion hace falta Node instalado en esta máquina, y no lo encontré.\n' +
    'Premiere corre el panel con un Node embebido que no sirve para lanzar procesos, así que tiene que haber uno aparte. ' +
    'El otro motor (HyperFrames) no lo necesita y sigue andando igual.\n' +
    (viejos.length
      ? 'Encontré Node pero es demasiado viejo: ' + viejos.join(' · ') +
        '. Remotion pide ' + VERSION_MINIMA + ' o más nuevo.\n'
      : '') +
    comoInstalar + '\n' +
    'Si YA lo tenés instalado: cerrá Premiere del todo y volvé a abrirlo (el panel se queda con el PATH viejo), ' +
    'o apuntámelo con la variable de entorno HYPERPREMIERE_NODE.\n' +
    'Busqué en: ' + (buscados.join(' · ') || '(ningún candidato)');
}

/**
 * Busca el Node con el que se van a lanzar los hijos.
 *
 * Devuelve `{ path, source, major }`, o tira con el mensaje de arriba. El orden
 * va de lo más barato y explícito a lo más caro: el shell de login tarda casi un
 * segundo y solo hace falta cuando los dos pasos anteriores no encontraron nada.
 */
async function buscar() {
  const vistos = new Set();
  const buscados = [];
  const viejos = [];

  async function probar(bin, deDonde) {
    if (!bin) return null;
    const ruta = String(bin);
    if (vistos.has(ruta)) return null;
    vistos.add(ruta);
    buscados.push(ruta + ' (' + deDonde + ')');
    const mayor = await versionMayorDe(ruta);
    if (!mayor) return null;
    if (mayor < VERSION_MINIMA) {
      viejos.push(ruta + ' es Node ' + mayor);
      return null;
    }
    return { path: ruta, source: deDonde, major: mayor };
  }

  // 1. La escotilla explícita, igual que HYPERPREMIERE_CURSOR_BIN para el CLI de
  //    Cursor: la usan los tests y el editor que tiene su Node en un lugar que
  //    no se le ocurriría a nadie.
  let hit = await probar(process.env.HYPERPREMIERE_NODE, 'HYPERPREMIERE_NODE');
  if (hit) return hit;

  // 2. El Node que está corriendo esto, SOLO si de verdad se llama node.
  //
  //    El filtro por nombre no es una optimización, es lo que evita el daño:
  //    adentro de Premiere este candidato es un binario de Adobe, y "probarlo"
  //    sería lanzar una segunda instancia de la aplicación. Se midió con el
  //    ejecutable de Premiere: no se cae ni contesta, se queda viva y hay que
  //    matarla. Preguntarle la versión a algo que no se llama node es un riesgo
  //    sin ninguna recompensa.
  if (/^node(\.exe)?$/i.test(path.basename(process.execPath || ''))) {
    hit = await probar(process.execPath, 'el Node que corre el panel');
    if (hit) return hit;
  }

  // 3. El PATH, que engine.js ya completó con Homebrew y compañía.
  const finder = await run(IS_WIN ? 'where' : 'which', ['node'], { timeoutMs: 10_000, shell: IS_WIN });
  for (const p of lineas(finder.out)) {
    hit = await probar(p, 'PATH');
    if (hit) return hit;
  }

  // 4. El shell de LOGIN, que es el único que ve los Node de nvm/fnm/volta.
  if (!IS_WIN) {
    const shell = process.env.SHELL || '/bin/zsh';
    const r = await run(shell, ['-lic', 'command -v node 2>/dev/null'], { timeoutMs: 15_000 });
    for (const p of lineas(r.out)) {
      hit = await probar(p, 'shell de login');
      if (hit) return hit;
    }
  }

  // 5. Las rutas conocidas. Van últimas porque son las que adivinan.
  for (const p of rutasConocidas()) {
    if (!existe(p)) continue;
    hit = await probar(p, 'ruta conocida');
    if (hit) return hit;
  }

  throw new Error(mensajeDeQueNoHay(buscados, viejos));
}

// Se cachea la PROMESA y no el resultado: con cuatro carriles de render
// arrancando juntos, cachear el resultado dejaría a los cuatro buscando en
// paralelo —incluido el shell de login de cada uno— antes de que el primero
// terminara de escribir la respuesta.
let pendiente = null;

/**
 * La ruta del Node con el que lanzar un hijo. Una sola búsqueda por proceso.
 *
 * Si no encuentra nada NO se cachea el error: el editor puede instalar Node y
 * tocar "Reintentar" sin cerrar Premiere, y ahí tiene que volver a buscar.
 */
function nodeBin() {
  if (!pendiente) {
    pendiente = buscar().catch((e) => { pendiente = null; throw e; });
  }
  return pendiente.then((hit) => hit.path);
}

module.exports = {
  nodeBin,
  VERSION_MINIMA,
  // Para los tests: la búsqueda completa (con de dónde salió, que es lo que se
  // quiere afirmar) y el olvido del caché, que si no se arrastra entre tests.
  _buscar: buscar,
  _rutasConocidas: rutasConocidas,
  _olvidar: function () { pendiente = null; },
};
