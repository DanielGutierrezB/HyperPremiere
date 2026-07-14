'use strict';

// run(cmd, args, opts) — corre un proceso externo y SIEMPRE resuelve
// { code, out, err } (nunca rechaza). code -1 = no se pudo lanzar el proceso
// o venció el timeout (en ese caso err === 'timeout').
//
// Es la implementación ÚNICA del patrón "spawn + acumular stdout/stderr +
// timer + kill" que antes estaba repetido cuatro veces (gitRun y runCmd en
// engine.js, el login de Claude y el proveedor claude-cli), cada copia con
// sus propios bugs potenciales de settled/clearTimeout.
//
// opts:
//   timeoutMs  — tope total; 0 = sin timeout (ej. npm install, que baja un
//                Chromium y puede tardar muchos minutos). Default 120000.
//   cwd, env, shell — passthrough a spawn.
//   onData(str) — callback por chunk (stdout y stderr) para reportar progreso.

const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 120_000;

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
      });
    } catch (e) {
      resolve({ code: -1, out: '', err: (e && e.message) || String(e) });
      return;
    }

    let out = '';
    let err = '';
    let settled = false;
    let timer = null;
    function finish(res) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) {}
        finish({ code: -1, out, err: 'timeout' });
      }, timeoutMs);
    }

    child.stdout.on('data', (c) => { out += c; if (opts.onData) opts.onData(String(c)); });
    child.stderr.on('data', (c) => { err += c; if (opts.onData) opts.onData(String(c)); });
    child.on('error', (e) => finish({ code: -1, out, err: (e && e.message) || String(e) }));
    child.on('close', (code) => finish({ code, out, err }));
  });
}

module.exports = { run };
