'use strict';

// ¿Dónde está `cursor-agent` en ESTA máquina y qué versión tiene?
//
// Hermano de claude-doctor.js, y existe por el mismo motivo: el panel corre
// dentro de Premiere, en la computadora de otro, y lo único que llega acá es
// una captura de pantalla. Si el diagnóstico no viaja adentro del mensaje de
// error, no hay diagnóstico.
//
// El caso que lo pidió es real. Un editor eligió Cursor y vio esto:
//
//     ✕ No pude hablar con Cursor. Revisá que esta máquina tenga el CLI
//       instalado y con sesión: … Detalle: spawn cursor-agent ENOENT
//
// "ENOENT" es el sistema diciendo "ese archivo no existe", pero el cartel lo
// mostraba al lado de dos comandos —instalar y loguearse— sin decidir cuál de
// los dos hacía falta. Eran dos problemas distintos con la misma cara.
//
// Nada de acá modifica el sistema: solo pregunta dónde está el binario
// (`where`/`which`) y qué versión dice ser (`cursor-agent --version`).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./exec');

const IS_WIN = process.platform === 'win32';

// Cuánto esperamos a cada pregunta. Son comandos que responden en menos de un
// segundo (medido: `--version` contesta en ~0,4 s); el tope es para que un
// binario roto no cuelgue el panel.
const LOCATE_TIMEOUT_MS = 15_000;
const VERSION_TIMEOUT_MS = 20_000;

// La línea que instala el CLI. Vive acá y no repetida en cada mensaje porque la
// dicen tres lugares distintos (la sesión, el diagnóstico y el proveedor cuando
// una generación se cae) y tienen que decir lo mismo.
const COMO_INSTALAR = IS_WIN
  ? 'irm https://cursor.com/install.ps1 | iex'
  : 'curl https://cursor.com/install -fsS | bash';

// Dónde deja el binario el instalador de Cursor. Se usan como respaldo cuando el
// PATH del panel no lo tiene: Premiere arranca con un entorno recortado y el
// editor sí lo ve desde su terminal.
//
// En mac el instalador deja en `~/.local/bin/cursor-agent` un enlace al
// ejecutable versionado de `~/.local/share/cursor-agent/versions/<v>/`. Ese
// `~/.local/bin` YA lo agrega ensurePath() en engine.js, así que en la práctica
// el PATH alcanza; esta lista es para la máquina donde no.
function knownCursorPaths() {
  const home = os.homedir();
  if (!IS_WIN) {
    return [
      path.join(home, '.local', 'bin', 'cursor-agent'),   // el instalador oficial
      '/opt/homebrew/bin/cursor-agent',
      '/usr/local/bin/cursor-agent',
    ];
  }
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return [
    path.join(home, '.local', 'bin', 'cursor-agent.exe'),
    path.join(home, '.local', 'bin', 'cursor-agent.cmd'),
    path.join(localAppData, 'Programs', 'cursor-agent', 'cursor-agent.exe'),
    path.join(appData, 'npm', 'cursor-agent.cmd'),
  ];
}

function existe(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }
}

// Lo que cmd.exe sabe ejecutar por sí solo. Mismo criterio que en claude-doctor:
// `where` puede devolver varias copias y no todas son ejecutables por el shell.
const EJECUTABLE_WIN = /\.(exe|cmd|bat|com)$/i;

function elegirEnWindows(hits) {
  for (const h of hits) if (EJECUTABLE_WIN.test(h)) return h;
  return null;
}

/**
 * Busca el ejecutable. Devuelve siempre un objeto (nunca lanza):
 *   { path, source, all, finderBroke }
 * - path: ruta absoluta al ejecutable, o null si no apareció.
 * - source: de dónde salió, para poder contarlo en la ficha.
 * - all: todas las copias que devolvió el PATH.
 * - finderBroke: true si ni `where`/`which` se pudo correr. NO es lo mismo que
 *   "no está instalado": si el buscador falla no sabemos nada, y hay que
 *   intentar igual con el nombre pelado.
 */
async function locate() {
  // Escotilla de emergencia, igual que HYPERPREMIERE_CLAUDE_BIN: si en una
  // máquina el binario está en un lugar que no se nos ocurrió, se fuerza por
  // variable de entorno sin tener que sacar una versión nueva del panel.
  const forzado = String(process.env.HYPERPREMIERE_CURSOR_BIN || '').trim();
  if (forzado) {
    return {
      path: forzado,
      source: 'variable HYPERPREMIERE_CURSOR_BIN' + (existe(forzado) ? '' : ' — ¡y esa ruta no existe!'),
      all: [],
      finderBroke: false,
    };
  }
  const finder = IS_WIN ? 'where' : 'which';
  const r = await run(finder, ['cursor-agent'], { timeoutMs: LOCATE_TIMEOUT_MS, shell: IS_WIN });
  const hits = String(r.out || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (r.code === 0 && hits.length) {
    const elegido = IS_WIN ? elegirEnWindows(hits) : hits[0];
    if (elegido) return { path: elegido, source: 'PATH', all: hits, finderBroke: false };
    return { path: 'cursor-agent', source: 'PATH, resuelto por el shell', all: hits, finderBroke: false };
  }
  // code -1 = el buscador ni arrancó (PATH sin System32, permisos raros…).
  const finderBroke = r.code === -1;
  for (const p of knownCursorPaths()) {
    if (existe(p)) return { path: p, source: 'ruta conocida', all: [], finderBroke: finderBroke };
  }
  return { path: null, source: null, all: [], finderBroke: finderBroke };
}

/**
 * Qué versión dice ser. Devuelve { version, raw, ok, error } y nunca lanza.
 *
 * El CLI de Cursor no numera como los demás: contesta con la FECHA de la
 * compilación y el commit (`2026.09.02-c22c1a3`), así que no se puede buscar un
 * `x.y.z`. Lo que sirve para comparar dos máquinas es esa cadena entera.
 */
async function version(bin) {
  const r = await run(bin || 'cursor-agent', ['--version'], { timeoutMs: VERSION_TIMEOUT_MS, shell: IS_WIN });
  const raw = ((r.out || '') + ' ' + (r.err || '')).trim();
  const m = raw.match(/\d{4}\.\d{2}\.\d{2}[\w.-]*|\d+\.\d+(?:\.\d+)?/);
  if (r.timedOut) return { version: '', raw: raw, ok: false, error: 'no contestó en ' + (VERSION_TIMEOUT_MS / 1000) + 's' };
  if (r.code === -1) return { version: '', raw: raw, ok: false, error: 'no se pudo ejecutar: ' + (r.err || '').trim() };
  if (!m) return { version: '', raw: raw, ok: false, error: 'contestó algo que no parece una versión: ' + raw.slice(0, 120) };
  return { version: m[0], raw: raw, ok: true, error: '' };
}

/**
 * Ficha de dos o tres renglones para pegar en CUALQUIER mensaje de error de
 * Cursor. Es lo que queremos ver en la captura de pantalla del editor.
 */
function ficha(found, ver) {
  const out = [];
  if (found && found.path) {
    out.push('• ejecutable: ' + found.path + (found.source ? ' (' + found.source + ')' : ''));
    if (found.all && found.all.length > 1) {
      out.push('• ojo, hay ' + found.all.length + ' copias en el PATH: ' + found.all.join(' · '));
    }
  } else {
    out.push('• ejecutable: NO LO ENCONTRÉ' + (found && found.finderBroke ? ' (y el buscador del sistema tampoco corrió)' : ''));
  }
  if (ver) {
    out.push('• versión: ' + (ver.ok ? ver.version : 'no la pude leer — ' + ver.error));
  }
  out.push('• sistema: ' + process.platform);
  return out.join('\n');
}

/** Cómo se instala, dicho igual en todos lados. */
function comoInstalar(intro) {
  return intro + ' abrí una terminal' + (IS_WIN ? ' (PowerShell)' : '') + ' y corré\n' +
    '    ' + COMO_INSTALAR + '\n' +
    'Después reiniciá Premiere, para que el panel vea el comando nuevo.';
}

/**
 * El camino corto cuando el CLI está pero no hay con qué autenticarse.
 *
 * Vive acá, y no repetido, porque lo dicen los dos lados —la detección de
 * sesión y el proveedor cuando una generación se cae— y tienen que decir
 * exactamente lo mismo.
 * @param {string} intro - cómo se encabeza la frase ("Qué hacer:", "O si no,…")
 */
function comoIniciarSesion(intro) {
  return intro + ' abrí una terminal' + (IS_WIN ? ' (PowerShell o CMD)' : '') + ' y corré\n' +
    '    cursor-agent login\n' +
    'Autorizá en el navegador y listo: el panel se da cuenta solo.\n' +
    'El otro camino es pegar una API key de Cursor (cursor.com → Dashboard →\n' +
    'Integrations → API Keys) en el campo "Token / API key" de acá arriba.';
}

/** Dónde buscamos cuando no aparece: para que el editor pueda mirar ahí. */
function dondeBusque() {
  return (IS_WIN ? 'where cursor-agent' : 'which cursor-agent') + ' y estas rutas:\n  ' +
    knownCursorPaths().join('\n  ');
}

/**
 * Diagnóstico completo, a pedido del panel (botón "Diagnóstico"). Devuelve
 * { ok, bin, source, version, sesion, report } — `report` es el texto para la
 * captura.
 *
 * Se le agrega la sesión, que en claude-doctor no está: acá el binario y la
 * credencial fallan por separado y con arreglos distintos (instalar contra
 * loguearse), así que una ficha que solo diga "el ejecutable está" contesta la
 * mitad de la pregunta. Y cuesta lo mismo: `cursor-agent status` tarda ~0,4 s.
 *
 * La sesión se pide por inyección para no importar cursor-session desde acá:
 * ese módulo ya importa éste, y una dependencia de ida y vuelta entre los dos
 * es exactamente el enredo que después nadie desarma.
 *
 * @param {function} [preguntarSesion] - async (bin) => { estado, resumen }
 */
async function diagnose(preguntarSesion) {
  const found = await locate();
  const ver = found.path ? await version(found.path) : null;
  const lineas = ['Diagnóstico del CLI de Cursor', ficha(found, ver)];

  let sesion = '';
  if (found.path && typeof preguntarSesion === 'function') {
    try {
      const s = await preguntarSesion(found.path);
      sesion = (s && s.estado) || '';
      lineas.push('• sesión: ' + ((s && s.resumen) || 'no la pude averiguar'));
    } catch (e) {
      lineas.push('• sesión: no la pude averiguar (' + ((e && e.message) || e) + ')');
    }
  }

  if (!found.path) {
    lineas.push('Busqué con ' + dondeBusque());
    lineas.push(comoInstalar('Qué hacer:'));
  } else if (sesion === 'sin-sesion') {
    lineas.push(comoIniciarSesion('Qué hacer:'));
  }
  return {
    ok: Boolean(found.path && ver && ver.ok && sesion !== 'sin-sesion'),
    bin: found.path || '',
    source: found.source || '',
    version: (ver && ver.version) || '',
    sesion: sesion,
    report: lineas.join('\n'),
  };
}

module.exports = {
  locate, version, ficha, dondeBusque, diagnose, knownCursorPaths,
  comoInstalar, comoIniciarSesion, COMO_INSTALAR,
  // Expuesto para el test de Windows (que corre en mac: es lógica pura).
  _elegirEnWindows: elegirEnWindows,
};
