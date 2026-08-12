#!/usr/bin/env node
'use strict';

// CLI de mentira que se hace pasar por `claude` PARA EL LOGIN. No tenemos la
// máquina Windows donde el login falla, así que los modos de falla se actúan
// acá: cada uno reproduce una cosa que ese CLI puede hacer en la vida real.
//
// Qué hace lo elige FAKE_LOGIN_MODE:
//   muda     — arranca y no escribe una letra (el timeout de 60s del editor).
//   url      — escribe la URL de autorización (con demora) y espera el código.
//   token    — ya estaba logueado: escupe el token y cierra.
//   viejo    — una versión que no conoce `setup-token`: error y cierra.
//   ink      — el error de "no hay terminal de verdad", que trae un link ajeno
//              adentro: el panel NO tiene que confundirlo con la autorización.
//   sin-version — el binario existe pero ni `--version` contesta bien.

const modo = process.env.FAKE_LOGIN_MODE || 'url';
const demoraMs = Number(process.env.FAKE_LOGIN_DELAY_MS || 250);
const args = process.argv.slice(2);

const TOKEN = 'sk-ant-oat01-FALSO' + 'abcdefghijklmnopqrstuvwxyz0123456789';
const URL_AUTH = 'https://claude.ai/oauth/authorize?code=true&client_id=falso';

if (args[0] === '--version') {
  if (modo === 'sin-version') { process.stderr.write('boom\n'); process.exit(1); }
  process.stdout.write('9.9.9 (Claude Code)\n');
  process.exit(0);
}

if (args[0] !== 'setup-token') {
  process.stderr.write("error: unknown command '" + (args[0] || '') + "'\n");
  process.exit(1);
}

if (modo === 'viejo') {
  process.stderr.write("error: unknown command 'setup-token'\n");
  process.exit(1);
}

if (modo === 'token') {
  process.stdout.write('Ya tenías sesión. Tu token:\n' + TOKEN + '\n');
  process.exit(0);
}

if (modo === 'ink') {
  process.stderr.write(
    'Error: Raw mode is not supported on the current process.stdin, which Ink uses as input stream by default.\n' +
    'Read about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported\n');
  process.exit(1);
}

if (modo === 'muda') {
  // Viva y callada: es el caso que hoy termina en el timeout genérico.
  process.stdin.resume();
  setInterval(function () {}, 1000);
  return;
}

// modo 'url': el camino feliz. La URL llega con demora (el CLI tarda en
// arrancar) y recién después de pegar el código aparece el token.
setTimeout(function () {
  process.stdout.write('Abrí esta URL para autorizar:\n' + URL_AUTH + '\n\nPegá el código: ');
}, demoraMs);

let entrada = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (c) {
  entrada += c;
  if (entrada.indexOf('\n') === -1) return;
  if (entrada.trim() === 'codigo-malo') {
    process.stderr.write('Invalid code\n');
    process.exit(1);
  }
  process.stdout.write('\n' + TOKEN + '\n');
  process.exit(0);
});
