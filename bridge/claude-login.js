'use strict';

// Login de Claude en dos fases, robusto en CUALQUIER máquina (antes se corría
// `claude setup-token` con stdin cerrado: solo funcionaba si claude YA estaba
// autenticado, que emitía el token de una; en una máquina limpia el comando
// queda esperando que pegues el código de autorización → colgado/timeout).
//
// Flujo:
//   start()          → corre `claude setup-token` de forma INTERACTIVA (stdin
//                      abierto). Detecta la URL de autorización y la devuelve;
//                      el panel la abre en el navegador. Si claude ya estaba
//                      logueado y emite el token de una, devuelve el token.
//   submitCode(code) → escribe el código pegado por el usuario en el stdin del
//                      proceso vivo y espera el token sk-ant-oat…
//   cancel()         → mata el proceso pendiente.
//
// Devuelve el token (no lo guarda); el engine lo persiste en config.

const { spawn } = require('child_process');
const { killTree } = require('./exec');

const IS_WIN = process.platform === 'win32';
const TOKEN_RE = /sk-ant-oat[0-9]+-[A-Za-z0-9_-]+/;
const URL_RE = /(https?:\/\/[^\s'"]+)/;

let pending = null; // { child, buf }

function cancel() {
  if (pending && pending.child) {
    try { killTree(pending.child); } catch (e) {}
  }
  pending = null;
  return { ok: true };
}

// Fase 1: arranca el proceso y espera la URL (o el token si ya está logueado).
function start() {
  cancel(); // no dejar dos procesos vivos
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('claude', ['setup-token'], { stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WIN });
    } catch (e) {
      resolve({ ok: false, needCli: true, error: 'No se pudo ejecutar "claude": ' + ((e && e.message) || e) });
      return;
    }

    var buf = '';
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { killTree(child); } catch (e) {}
      resolve({ ok: false, error: 'Timeout esperando la URL de autorización de claude (60s). ¿Está instalado y actualizado el CLI?' });
    }, 60_000);

    function onData(chunk) {
      buf += String(chunk);
      if (settled) return;
      var tok = buf.match(TOKEN_RE);
      if (tok) { // ya estaba logueado: token directo
        settled = true; clearTimeout(timer);
        try { killTree(child); } catch (e) {}
        pending = null;
        resolve({ ok: true, done: true, token: tok[0] });
        return;
      }
      var url = buf.match(URL_RE);
      if (url) {
        settled = true; clearTimeout(timer);
        pending = { child: child, buf: buf };
        // Seguir acumulando la salida para la fase 2.
        child.stdout.on('data', function (d) { pending.buf += String(d); });
        child.stderr.on('data', function (d) { pending.buf += String(d); });
        resolve({ ok: true, url: url[1] });
      }
    }
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', function (e) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ ok: false, needCli: true, error: 'No se pudo ejecutar "claude": ' + ((e && e.message) || e) });
    });
    child.on('close', function () {
      if (settled) return;
      settled = true; clearTimeout(timer);
      var tok = buf.match(TOKEN_RE);
      if (tok) resolve({ ok: true, done: true, token: tok[0] });
      else resolve({ ok: false, error: 'claude terminó sin dar URL ni token. ' + buf.slice(-300) });
    });
  });
}

// Fase 2: envía el código pegado y espera el token.
function submitCode(code) {
  return new Promise((resolve) => {
    if (!pending || !pending.child) {
      resolve({ ok: false, error: 'No hay un login en curso. Tocá "Iniciar sesión" de nuevo.' });
      return;
    }
    var child = pending.child;
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { killTree(child); } catch (e) {}
      pending = null;
      resolve({ ok: false, error: 'Timeout esperando el token tras enviar el código (2 min).' });
    }, 120_000);

    function look() {
      if (settled) return;
      var tok = pending.buf.match(TOKEN_RE);
      if (tok) {
        settled = true; clearTimeout(timer);
        try { killTree(child); } catch (e) {}
        pending = null;
        resolve({ ok: true, token: tok[0] });
      }
    }
    child.stdout.on('data', look);
    child.stderr.on('data', look);
    child.on('close', function () {
      if (settled) return;
      look();
      if (settled) return;
      settled = true; clearTimeout(timer);
      var last = pending ? pending.buf.slice(-300) : '';
      pending = null;
      resolve({ ok: false, error: 'claude cerró sin devolver el token. ¿El código era correcto? ' + last });
    });

    try {
      child.stdin.write(String(code == null ? '' : code).trim() + '\n');
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error: 'No pude enviar el código: ' + ((e && e.message) || e) }); }
      return;
    }
    look();
  });
}

module.exports = { start, submitCode, cancel, TOKEN_RE };
