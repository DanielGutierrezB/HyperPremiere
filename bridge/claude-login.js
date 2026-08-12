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
//
// Todo lo que puede salir mal acá pasa en la máquina de OTRO (el panel corre
// dentro de Premiere, en la computadora del editor) y lo único que nos llega es
// una captura de pantalla. Por eso start() no tiene UN solo error: separa los
// modos de falla —no está instalado / está pero no dice nada / cerró con un
// error / la versión no conoce el comando— y mete en cada mensaje la ficha del
// binario (ruta y versión) más el próximo paso concreto.

const { spawn } = require('child_process');
const { killTree, quoteForShell } = require('./exec');
const doctor = require('./claude-doctor');

const IS_WIN = process.platform === 'win32';
const TOKEN_RE = /sk-ant-oat[0-9]+-[A-Za-z0-9_-]+/;
// La URL de autorización es de Claude, y solo esa sirve. Antes se tomaba
// CUALQUIER http(s) que apareciera en la salida, y varios errores del CLI traen
// un link adentro (el de Ink cuando no hay terminal de verdad apunta a GitHub):
// el panel abría esa página y pedía un código que nunca iba a existir. Una URL
// ajena ahora se ignora y termina citada en el diagnóstico, que es su lugar.
const URL_RE = /(https?:\/\/[^\s'"]*(?:claude\.(?:ai|com)|anthropic\.com)[^\s'"]*)/i;

const START_TIMEOUT_MS = 60_000;

// Un CLI viejo que no conoce `setup-token`: commander contesta esto y cierra.
const UNKNOWN_CMD_RE = /unknown command|unknown option|no such command|invalid command/i;
// cmd.exe cuando el ejecutable no está (en inglés y en español).
const NOT_RECOGNIZED_RE = /is not recognized as an internal or external command|no se reconoce como un comando/i;

// El camino de escape que SIEMPRE funciona, dicho igual en todos los errores.
// `yaLoTiene` false = todavía hay que instalar el CLI, así que no es un
// "mientras tanto": es el paso siguiente.
function salidaManual(yaLoTiene) {
  return (yaLoTiene ? 'Mientras tanto podés entrar igual: abrí' : 'Una vez instalado, abrí') +
    ' una terminal (en Windows, PowerShell o CMD), corré\n' +
    '    claude setup-token\n' +
    'autorizá en el navegador y pegá el token (empieza con sk-ant-oat…) acá abajo, en\n' +
    '"…o pegá el token directamente".';
}
const SALIDA_MANUAL = salidaManual(true);

let pending = null; // { child, buf }

function cancel() {
  if (pending && pending.child) {
    try { killTree(pending.child); } catch (e) {}
  }
  pending = null;
  return { ok: true };
}

/**
 * Fase 1: arranca el proceso y espera la URL (o el token si ya está logueado).
 *
 * Antes de gastar 60 segundos esperando, pregunta DÓNDE está el binario y QUÉ
 * versión es (dos comandos de lectura, menos de un segundo). Con eso: si no
 * está, se falla al instante y con nombre y apellido en vez de un timeout; y si
 * está, la ficha viaja dentro de cualquier error posterior.
 *
 * @param {object} [opts] - { timeoutMs } (los tests no esperan un minuto).
 */
async function start(opts) {
  cancel(); // no dejar dos procesos vivos
  const timeoutMs = (opts && opts.timeoutMs) || START_TIMEOUT_MS;

  const found = await doctor.locate();
  // finderBroke = ni `where`/`which` corrió: ahí no sabemos nada, así que se
  // intenta igual con el nombre pelado en vez de acusar de "no instalado".
  if (!found.path && !found.finderBroke) {
    return {
      ok: false,
      needCli: true,
      error: 'No encontré el CLI de Claude en esta máquina.\n' +
        doctor.ficha(found, null) + '\n' +
        'Busqué con ' + doctor.dondeBusque() + '\n' +
        (IS_WIN
          ? 'Qué hacer: instalalo desde PowerShell con  irm https://claude.ai/install.ps1 | iex\n' +
            'Si YA lo tenías instalado, cerrá Premiere del todo y volvé a abrirlo: el panel se queda con el PATH viejo.\n'
          : 'Qué hacer: instalalo con  curl -fsSL https://claude.ai/install.sh | bash\n') +
        salidaManual(false),
    };
  }

  const bin = found.path || 'claude';
  const ver = await doctor.version(bin);
  const ficha = doctor.ficha(found, ver);

  return new Promise((resolve) => {
    let child;
    try {
      // shell solo en Windows (hace falta para los shims .cmd/.ps1 de npm) y
      // ahí la ruta va entrecomillada: con shell, spawn no escapa nada y
      // "C:\Users\Juan Pérez\.local\bin\claude.exe" se partiría en dos.
      child = spawn(
        IS_WIN ? quoteForShell(bin) : bin,
        ['setup-token'],
        { stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WIN }
      );
    } catch (e) {
      resolve({
        ok: false,
        needCli: true,
        error: 'No se pudo ejecutar el CLI de Claude: ' + ((e && e.message) || e) + '\n' + ficha + '\n' + SALIDA_MANUAL,
      });
      return;
    }

    var buf = '';
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { killTree(child); } catch (e) {}
      const dijo = buf.trim();
      resolve({
        ok: false,
        error: 'El CLI de Claude arrancó, pero en ' + Math.round(timeoutMs / 1000) + 's no dijo nada: ' +
          'ni la URL de autorización ni el token.\n' + ficha + '\n' +
          'Lo que escribió: ' + (dijo ? '«' + dijo.slice(-300) + '»' : '(nada, ni una letra)') + '\n' +
          'Lo más probable es que `claude setup-token` necesite una terminal de verdad y desde el ' +
          'panel no la tenga.\n' + SALIDA_MANUAL,
      });
    }, timeoutMs);

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
      resolve({
        ok: false,
        needCli: true,
        error: 'No se pudo ejecutar el CLI de Claude: ' + ((e && e.message) || e) + '\n' + ficha + '\n' + SALIDA_MANUAL,
      });
    });
    child.on('close', function (code) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      var tok = buf.match(TOKEN_RE);
      if (tok) { resolve({ ok: true, done: true, token: tok[0] }); return; }
      resolve({ ok: false, needCli: NOT_RECOGNIZED_RE.test(buf), error: cerroMal(code, buf, ficha, ver) });
    });
  });
}

// El CLI cerró sin URL ni token: por qué, dicho con nombre propio. Son fallas
// distintas con arreglos distintos, y de lejos todas se parecían a "no anduvo".
function cerroMal(code, buf, ficha, ver) {
  const cola = buf.trim().slice(-300);
  const salida = cola ? '\nLo que escribió: «' + cola + '»' : '';
  const cierre = '\n' + ficha + salida + '\n' + SALIDA_MANUAL;

  if (UNKNOWN_CMD_RE.test(buf)) {
    return 'Tu CLI de Claude no conoce el comando `setup-token`' +
      (ver && ver.version ? ' (versión ' + ver.version + ')' : '') + ': es una versión vieja.\n' +
      'Qué hacer: actualizalo con  claude update  (o, si lo instalaste con npm,\n' +
      '  npm install -g @anthropic-ai/claude-code@latest ) y reiniciá Premiere.' + cierre;
  }
  if (NOT_RECOGNIZED_RE.test(buf)) {
    return 'Windows no reconoció el comando `claude` al intentar ejecutarlo.\n' +
      'Qué hacer: cerrá Premiere del todo y volvé a abrirlo (el panel se queda con el PATH viejo).\n' +
      'Si sigue igual, reinstalá el CLI desde PowerShell con  irm https://claude.ai/install.ps1 | iex' + cierre;
  }
  return 'El CLI de Claude cerró' + (code === null || code === undefined ? '' : ' con código ' + code) +
    ' sin dar la URL de autorización ni el token.' + cierre;
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
