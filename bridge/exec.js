'use strict';

// run(cmd, args, opts) — corre un proceso externo y SIEMPRE resuelve
// { code, out, err, timedOut } (nunca rechaza). code -1 = no se pudo lanzar
// el proceso o venció el timeout (timedOut: true).
//
// Es la implementación ÚNICA del patrón "spawn + acumular stdout/stderr +
// timer + kill" que antes estaba repetido cuatro veces (gitRun y runCmd en
// engine.js, el login de Claude y el proveedor claude-cli), cada copia con
// sus propios bugs potenciales de settled/clearTimeout.
//
// opts:
//   timeoutMs  — tope total; 0 = sin timeout (ej. npm install, que baja un
//                Chromium y puede tardar muchos minutos). Default 120000.
//   idleTimeoutMs — watchdog de INACTIVIDAD: mata el proceso si pasa este
//                lapso sin NINGUNA salida (para procesos sin tope total que
//                pueden colgarse, ej. whisper). 0/ausente = sin watchdog.
//   cwd, env, shell — passthrough a spawn.
//   onData(str) — callback por chunk (stdout y stderr) para reportar progreso.
//   onSpawn(child) — acceso al proceso hijo (para poder cancelarlo desde afuera).

const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const DEFAULT_TIMEOUT_MS = 120_000;

// Mata el proceso Y SUS HIJOS. child.kill() solo mata al proceso raíz: sus
// subprocesos (whisper lanza workers de python; npm lanza de todo) quedan
// huérfanos consumiendo CPU y reteniendo los pipes. En POSIX se lanza el
// proceso como líder de grupo (detached) y se mata el grupo entero (-pid);
// en Windows, taskkill /T recorre el árbol.
function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL'); // grupo entero
    }
  } catch (e) {
    try { child.kill('SIGKILL'); } catch (e2) {}
  }
}

function run(cmd, args, opts) {
  opts = opts || {};
  const timeoutMs = (opts.timeoutMs === 0) ? 0 : (opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: opts.cwd,
        env: opts.env,
        shell: !!opts.shell,
        // Líder de grupo en POSIX → killTree puede matar el árbol entero.
        detached: !IS_WIN,
      });
    } catch (e) {
      resolve({ code: -1, out: '', err: (e && e.message) || String(e) });
      return;
    }

    if (opts.onSpawn) { try { opts.onSpawn(child); } catch (e) {} }

    let out = '';
    let err = '';
    let settled = false;
    let timer = null;
    let idleTimer = null;
    function finish(res) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idleTimer);
      resolve(res);
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(child);
        // Se preserva la salida capturada (diagnóstico); timedOut marca la causa.
        finish({ code: -1, out, err, timedOut: true });
      }, timeoutMs);
    }
    const idleMs = opts.idleTimeoutMs || 0;
    function armIdle() {
      if (!idleMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        killTree(child);
        finish({ code: -1, out, err, timedOut: true, idle: true });
      }, idleMs);
    }
    armIdle();

    child.stdout.on('data', (c) => { out += c; armIdle(); if (opts.onData) opts.onData(String(c)); });
    child.stderr.on('data', (c) => { err += c; armIdle(); if (opts.onData) opts.onData(String(c)); });
    child.on('error', (e) => finish({ code: -1, out, err: (e && e.message) || String(e) }));
    child.on('close', (code) => finish({ code, out, err }));
  });
}

module.exports = { run, killTree };
