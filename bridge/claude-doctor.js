'use strict';

// ¿Dónde está `claude` en ESTA máquina y qué versión tiene?
//
// El login era una caja negra: si `claude setup-token` no decía nada, el editor
// veía "Timeout esperando la URL (60s)" y desde acá no había forma de saber si
// el CLI faltaba, si estaba pero mudo, o si era una versión que no conoce el
// comando. Con máquinas ajenas (el panel corre dentro de Premiere, en la
// computadora de otro) el diagnóstico TIENE que viajar en el mensaje de error:
// una captura de pantalla es todo lo que vamos a recibir.
//
// Nada de acá modifica el sistema: solo pregunta dónde está el binario
// (`where`/`which`) y qué versión dice ser (`claude --version`).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./exec');

const IS_WIN = process.platform === 'win32';

// Cuánto esperamos a cada pregunta. Son comandos que responden en menos de un
// segundo; el tope es para no colgar el login si el binario está roto.
const LOCATE_TIMEOUT_MS = 15_000;
const VERSION_TIMEOUT_MS = 20_000;

// Dónde deja el binario cada forma de instalar Claude Code. Se usan como
// respaldo cuando el PATH del panel no lo tiene: Premiere arranca con un
// entorno recortado y el editor sí lo ve desde su terminal.
function knownClaudePaths() {
  const home = os.homedir();
  if (!IS_WIN) {
    return [
      path.join(home, '.local', 'bin', 'claude'),      // instalador nativo (el actual)
      path.join(home, '.claude', 'local', 'claude'),   // instalación "local" del propio CLI
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    ];
  }
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return [
    path.join(home, '.local', 'bin', 'claude.exe'),    // instalador nativo (irm claude.ai/install.ps1)
    path.join(home, '.local', 'bin', 'claude.cmd'),
    path.join(appData, 'npm', 'claude.cmd'),           // npm install -g
    path.join(appData, 'npm', 'claude.exe'),
    path.join(localAppData, 'Microsoft', 'WindowsApps', 'claude.exe'), // winget
    path.join(home, '.claude', 'local', 'claude.cmd'),
  ];
}

function existe(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }
}

// Lo que cmd.exe sabe ejecutar por sí solo.
const EJECUTABLE_WIN = /\.(exe|cmd|bat|com)$/i;

// `where claude` en Windows puede devolver VARIAS cosas, y no todas son
// ejecutables: npm deja en la misma carpeta un `claude` sin extensión (script
// de shell, para Git Bash), un `claude.cmd` y un `claude.ps1`. Correr el
// primero de la lista a ciegas puede caer justo en el que cmd.exe no sabe
// ejecutar. Nos quedamos con el primero que SÍ pueda; si no hay ninguno,
// devolvemos null y el login vuelve a dejar que el shell resuelva por PATHEXT,
// que es lo que venía haciendo bien.
function elegirEnWindows(hits) {
  for (const h of hits) if (EJECUTABLE_WIN.test(h)) return h;
  return null;
}

/**
 * Busca el ejecutable. Devuelve siempre un objeto (nunca lanza):
 *   { path, source, all, finderBroke }
 * - path: ruta absoluta al ejecutable, o null si no apareció.
 * - source: 'PATH' | 'ruta conocida' | null.
 * - all: todas las copias que devolvió el PATH (en Windows es normal tener dos).
 * - finderBroke: true si ni `where`/`which` se pudo correr. Es importante NO
 *   confundirlo con "no está instalado": si el buscador falla no sabemos nada,
 *   y el login igual tiene que intentar con el nombre pelado.
 */
async function locate() {
  // Escotilla de emergencia: si en una máquina el binario está en un lugar que
  // no se nos ocurrió, se fuerza por variable de entorno (igual que
  // HYPERPREMIERE_WHISPER_BIN) sin tener que sacar una versión nueva.
  const forzado = String(process.env.HYPERPREMIERE_CLAUDE_BIN || '').trim();
  if (forzado) {
    return {
      path: forzado,
      source: 'variable HYPERPREMIERE_CLAUDE_BIN' + (existe(forzado) ? '' : ' — ¡y esa ruta no existe!'),
      all: [],
      finderBroke: false,
    };
  }
  const finder = IS_WIN ? 'where' : 'which';
  const r = await run(finder, ['claude'], { timeoutMs: LOCATE_TIMEOUT_MS, shell: IS_WIN });
  const hits = String(r.out || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (r.code === 0 && hits.length) {
    const elegido = IS_WIN ? elegirEnWindows(hits) : hits[0];
    if (elegido) return { path: elegido, source: 'PATH', all: hits, finderBroke: false };
    return { path: 'claude', source: 'PATH, resuelto por el shell', all: hits, finderBroke: false };
  }
  // code -1 = el buscador ni arrancó (PATH sin System32, permisos raros…).
  const finderBroke = r.code === -1;
  for (const p of knownClaudePaths()) {
    if (existe(p)) return { path: p, source: 'ruta conocida', all: [], finderBroke: finderBroke };
  }
  return { path: null, source: null, all: [], finderBroke: finderBroke };
}

/**
 * Qué versión dice ser. Devuelve { version, raw, ok, error } y nunca lanza.
 * Un fallo acá NO cancela el login: se anota en la ficha y se sigue. Que el
 * binario exista pero no conteste `--version` ya es, en sí, media respuesta.
 */
async function version(bin) {
  const r = await run(bin || 'claude', ['--version'], { timeoutMs: VERSION_TIMEOUT_MS, shell: IS_WIN });
  const raw = ((r.out || '') + ' ' + (r.err || '')).trim();
  const m = raw.match(/\d+\.\d+(?:\.\d+)?/);
  if (r.timedOut) return { version: '', raw: raw, ok: false, error: 'no contestó en ' + (VERSION_TIMEOUT_MS / 1000) + 's' };
  if (r.code === -1) return { version: '', raw: raw, ok: false, error: 'no se pudo ejecutar: ' + (r.err || '').trim() };
  if (!m) return { version: '', raw: raw, ok: false, error: 'contestó algo que no parece una versión: ' + raw.slice(0, 120) };
  return { version: m[0], raw: raw, ok: true, error: '' };
}

/**
 * Ficha de dos o tres renglones para pegar en CUALQUIER mensaje de error del
 * login. Es lo que queremos ver en la captura de pantalla del editor.
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

/**
 * El camino que SIEMPRE funciona: sacar el token a mano y pegarlo en el panel.
 * Vive acá porque lo necesitan los dos lados —el login, cuando el botón falla, y
 * el proveedor, cuando una generación se cae por falta de sesión— y tiene que
 * decir exactamente lo mismo en los dos.
 * @param {string} intro - cómo se encabeza la frase ("Qué hacer:", "Una vez instalado,"…)
 */
function tokenAMano(intro) {
  return intro + ' abrí una terminal (en Windows, PowerShell o CMD), corré\n' +
    '    claude setup-token\n' +
    'autorizá en el navegador y pegá el token (empieza con sk-ant-oat…) en el panel, en\n' +
    '"…o pegá el token directamente".';
}

/** Dónde buscamos cuando no aparece: para que el editor pueda mirar ahí. */
function dondeBusque() {
  return (IS_WIN ? 'where claude' : 'which claude') + ' y estas rutas:\n  ' +
    knownClaudePaths().join('\n  ');
}

/**
 * Diagnóstico completo, a pedido del panel (botón "Diagnóstico"). Devuelve
 * { ok, bin, source, version, report } — `report` es el texto para la captura.
 */
async function diagnose() {
  const found = await locate();
  const ver = found.path ? await version(found.path) : null;
  const lineas = ['Diagnóstico del CLI de Claude', ficha(found, ver)];
  if (!found.path) {
    lineas.push('Busqué con ' + dondeBusque());
    lineas.push(IS_WIN
      ? 'Instalalo en PowerShell con:  irm https://claude.ai/install.ps1 | iex   (después reiniciá Premiere)'
      : 'Instalalo con:  curl -fsSL https://claude.ai/install.sh | bash');
  }
  return {
    ok: Boolean(found.path && ver && ver.ok),
    bin: found.path || '',
    source: found.source || '',
    version: (ver && ver.version) || '',
    report: lineas.join('\n'),
  };
}

module.exports = {
  locate, version, ficha, dondeBusque, diagnose, knownClaudePaths, tokenAMano,
  // Expuesto para el test de Windows (que corre en mac: es lógica pura).
  _elegirEnWindows: elegirEnWindows,
};
