'use strict';

// El login de Claude falla en la máquina de OTRO (el panel corre dentro de
// Premiere, en la computadora del editor) y de allá solo nos llega una captura
// de pantalla. Así que lo que se prueba acá no es "andar": es que CADA modo de
// falla se explique solo, con la ruta del binario, su versión y el próximo paso.
//
// Los escenarios se actúan con un `claude` de mentira puesto en el PATH
// (fixtures/fake-cli/fake-claude-login.js), sin red ni tokens de verdad.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq, has } = require('./harness');
const login = require('../bridge/claude-login');
const doctor = require('../bridge/claude-doctor');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-claude-login.js');
// El CLI de mentira es un script con shebang: en Windows no corre así.
const saltarEnWindows = process.platform === 'win32';

/** Un ejecutable llamado `claude` que en realidad es el fixture. */
function crearShim(nombreDir) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-login-'));
  const dir = path.join(base, nombreDir || 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, 'claude');
  fs.writeFileSync(shim, '#!/bin/sh\nexec "' + process.execPath + '" "' + FIXTURE + '" "$@"\n');
  fs.chmodSync(shim, 0o755);
  return { dir: dir, shim: shim };
}

const ENV_TOCADAS = ['PATH', 'HOME', 'FAKE_LOGIN_MODE', 'FAKE_LOGIN_DELAY_MS', 'HYPERPREMIERE_CLAUDE_BIN'];

/**
 * Corre `fn` con el CLI de mentira en el PATH.
 *
 * El HOME se muda a una carpeta vacía a propósito: si no, las "rutas conocidas"
 * del diagnóstico encuentran el claude REAL de esta máquina y el test dejaría de
 * probar lo que dice probar.
 */
async function conFake(modo, fn, opts) {
  const previo = {};
  for (const k of ENV_TOCADAS) previo[k] = process.env[k];
  const homeVacio = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-home-'));
  const sinCli = Boolean(opts && opts.sinCli);
  const shim = sinCli ? null : crearShim(opts && opts.nombreDir);
  try {
    process.env.HOME = homeVacio;
    process.env.PATH = (shim ? shim.dir + ':' : '') + '/usr/bin:/bin';
    process.env.FAKE_LOGIN_MODE = modo || 'url';
    if (opts && opts.demoraMs) process.env.FAKE_LOGIN_DELAY_MS = String(opts.demoraMs);
    delete process.env.HYPERPREMIERE_CLAUDE_BIN;
    if (opts && opts.forzarBin) process.env.HYPERPREMIERE_CLAUDE_BIN = opts.forzarBin;
    return await fn(shim);
  } finally {
    for (const k of ENV_TOCADAS) {
      if (previo[k] === undefined) delete process.env[k];
      else process.env[k] = previo[k];
    }
    login.cancel();
  }
}

test('si no hay CLI, lo dice al instante en vez de esperar un minuto', async function () {
  if (saltarEnWindows) return console.log('      (se saltea en Windows: el CLI de mentira es un script con shebang)');
  const t0 = Date.now();
  const r = await conFake(null, function () { return login.start({ timeoutMs: 60000 }); }, { sinCli: true });
  eq(r.ok, false, 'falla');
  ok(Date.now() - t0 < 20000, 'sin quedarse esperando el timeout del login');
  ok(r.needCli, 'y avisa que el problema es el CLI, no la sesión');
  has(r.error, 'No encontré el CLI de Claude', 'con el modo de falla dicho por su nombre');
  has(r.error, 'NO LO ENCONTRÉ', 'la ficha dice que el ejecutable no apareció');
  has(r.error, 'claude setup-token', 'y queda a mano la salida de pegar el token');
});

test('si el CLI está pero no dice nada, el timeout cuenta qué encontró', async function () {
  if (saltarEnWindows) return;
  const r = await conFake('muda', function () { return login.start({ timeoutMs: 1500 }); });
  eq(r.ok, false, 'falla');
  has(r.error, 'arrancó, pero en 2s no dijo nada', 'el modo de falla es "está pero es muda"');
  has(r.error, '/claude', 'con la ruta exacta del ejecutable que arrancó');
  has(r.error, 'versión: 9.9.9', 'y la versión que dice tener');
  has(r.error, '(nada, ni una letra)', 'diciendo también que no escribió NADA');
  has(r.error, 'terminal de verdad', 'con la sospecha más probable escrita');
});

test('un CLI viejo manda a actualizar, no a mirar el PATH', async function () {
  if (saltarEnWindows) return;
  const r = await conFake('viejo', function () { return login.start({ timeoutMs: 10000 }); });
  eq(r.ok, false, 'falla');
  has(r.error, 'no conoce el comando `setup-token`', 'nombra la causa real');
  has(r.error, 'claude update', 'y el próximo paso es actualizar');
  has(r.error, 'versión: 9.9.9', 'la ficha viaja igual');
});

test('la URL de autorización llega aunque el CLI tarde, y el código devuelve el token', async function () {
  if (saltarEnWindows) return;
  // Las dos fases van dentro del mismo conFake: al salir se cancela el proceso
  // pendiente, que es justo el que la fase 2 necesita vivo.
  const { r, r2 } = await conFake('url', async function () {
    const r = await login.start({ timeoutMs: 8000 });
    return { r: r, r2: r.ok ? await login.submitCode('codigo-de-prueba') : null };
  }, { demoraMs: 400 });
  eq(r.ok, true, 'el login arranca');
  has(r.url, 'https://claude.ai/oauth/authorize', 'con la URL de autorización de Claude');
  eq(r2.ok, true, 'y el código pegado devuelve el token');
  has(r2.token, 'sk-ant-oat01-', 'que es un token de suscripción');
});

test('si ya había sesión, el token sale de una', async function () {
  if (saltarEnWindows) return;
  const r = await conFake('token', function () { return login.start({ timeoutMs: 8000 }); });
  eq(r.ok, true, 'no hay nada que autorizar');
  eq(r.done, true, 'el login termina en un paso');
  has(r.token, 'sk-ant-oat01-', 'con el token servido');
});

test('un link ajeno dentro de un error no se confunde con la autorización', async function () {
  if (saltarEnWindows) return;
  // El error de "no hay terminal de verdad" trae un link a GitHub adentro. Con
  // el criterio viejo (cualquier http) el panel abría ESA página y pedía un
  // código que no existe: el editor quedaba dando vueltas en el lugar equivocado.
  const r = await conFake('ink', function () { return login.start({ timeoutMs: 8000 }); });
  eq(r.ok, false, 'eso no es un login');
  ok(!r.url, 'y no se devuelve ninguna URL para abrir');
  has(r.error, 'github.com', 'el link ajeno termina citado en el diagnóstico, que es su lugar');
  has(r.error, 'Raw mode is not supported', 'con el error textual del CLI, para poder buscarlo');
});

test('una ruta con espacios no rompe el login', async function () {
  if (saltarEnWindows) return;
  // "C:\Users\Juan Pérez\..." es lo normal en Windows y es donde se parten los
  // comandos mal escapados.
  const r = await conFake('token', function () { return login.start({ timeoutMs: 8000 }); }, { nombreDir: 'car peta con espacios' });
  eq(r.ok, true, 'el ejecutable se lanza igual');
  has(r.token, 'sk-ant-oat01-', 'y devuelve el token');
});

test('el diagnóstico a pedido dice ruta y versión sin tener que fallar antes', async function () {
  if (saltarEnWindows) return;
  const r = await conFake('url', function () { return doctor.diagnose(); });
  eq(r.ok, true, 'encontró un CLI que contesta');
  has(r.report, 'Diagnóstico del CLI de Claude', 'con un título reconocible en una captura');
  has(r.report, r.bin, 'la ruta del ejecutable');
  has(r.report, 'versión: 9.9.9', 'y su versión');
});

test('sin CLI, el diagnóstico dice dónde buscó y cómo instalarlo', async function () {
  if (saltarEnWindows) return;
  const r = await conFake(null, function () { return doctor.diagnose(); }, { sinCli: true });
  eq(r.ok, false, 'no hay CLI');
  has(r.report, 'Busqué con', 'dice dónde miró');
  has(r.report, 'claude.ai/install', 'y cómo instalarlo en esta plataforma');
});

test('en Windows se elige la copia que cmd.exe sabe ejecutar', function () {
  // npm deja tres archivos juntos y `where` los lista a todos: el primero es un
  // script de shell sin extensión (para Git Bash) que cmd.exe no puede correr.
  const npm = ['C:\\Users\\ed\\AppData\\Roaming\\npm\\claude',
    'C:\\Users\\ed\\AppData\\Roaming\\npm\\claude.cmd',
    'C:\\Users\\ed\\AppData\\Roaming\\npm\\claude.ps1'];
  has(doctor._elegirEnWindows(npm), 'claude.cmd', 'se saltea el que no es ejecutable');
  has(doctor._elegirEnWindows(['C:\\Users\\ed\\.local\\bin\\claude.exe']), '.exe', 'el instalador nativo entra derecho');
  eq(doctor._elegirEnWindows(['C:\\algo\\claude']), null, 'si no hay ninguno ejecutable, que lo resuelva el shell');
});

test('se puede forzar la ruta del CLI por variable de entorno', async function () {
  if (saltarEnWindows) return;
  // La escotilla para una máquina donde el binario está en un lugar que no se
  // nos ocurrió: no hace falta sacar una versión nueva del panel.
  const suelto = crearShim('afuera-del-path');
  const r = await conFake('token', function () { return login.start({ timeoutMs: 8000 }); },
    { sinCli: true, forzarBin: suelto.shim });
  eq(r.ok, true, 'el login usa el binario forzado');
  has(r.token, 'sk-ant-oat01-', 'y devuelve el token');
});
