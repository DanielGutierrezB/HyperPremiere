#!/usr/bin/env node
'use strict';

// CLI de mentira que se hace pasar por `claude` PARA `auth status`. Lo que
// contesta está copiado de la salida real del CLI 2.1.201 en esta máquina:
//
//   $ claude auth status
//   { "loggedIn": false, "authMethod": "none", "apiProvider": "firstParty" }
//
//   $ CLAUDE_CODE_OAUTH_TOKEN=… claude auth status
//   { "loggedIn": true, "authMethod": "oauth_token", "apiProvider": "firstParty" }
//
// Lo IMPORTANTE que reproduce es que la respuesta depende del ENTORNO: un token
// en `CLAUDE_CODE_OAUTH_TOKEN` alcanza para que conteste que sí, aunque la
// máquina no tenga ninguna sesión guardada. De eso vive el arreglo — el panel
// pregunta con el mismo entorno con el que va a generar, así que la respuesta
// es la de la corrida de verdad y no una conjetura sobre ella.
//
// Qué sesión "tiene guardada" la máquina lo elige FAKE_AUTH_SESSION:
//   none      — ninguna (default).
//   claude.ai — la del editor que corrió `claude auth login` en su terminal.
//               Es EL caso del bug: genera perfecto y el panel decía que no.
//
// Y los casos patológicos, con FAKE_AUTH_MODE:
//   viejo   — una versión anterior a `claude auth status`.
//   basura  — contesta algo que no es JSON.
//   muda    — no contesta nunca (para el timeout).

const modo = process.env.FAKE_AUTH_MODE || '';
const sesion = process.env.FAKE_AUTH_SESSION || 'none';
const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write('9.9.9 (Claude Code)\n');
  process.exit(0);
}

if (args[0] !== 'auth' || args[1] !== 'status') {
  process.stderr.write("error: unknown command '" + (args[0] || '') + "'\n");
  process.exit(1);
}

if (modo === 'viejo') {
  process.stderr.write("error: unknown command 'auth'\n");
  process.exit(1);
}

if (modo === 'basura') {
  process.stdout.write('Claude Code is starting up, please wait…\n');
  process.exit(0);
}

if (modo === 'muda') {
  setInterval(function () {}, 1000);
  return;
}

// El orden es el del CLI de verdad: lo que venga por el entorno gana sobre lo
// que haya guardado la máquina.
let r;
if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  r = { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' };
} else if (process.env.ANTHROPIC_API_KEY) {
  r = { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' };
} else if (sesion === 'claude.ai') {
  r = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'editor@ejemplo.com' };
} else {
  r = { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' };
}
process.stdout.write(JSON.stringify(r, null, 2) + '\n');
process.exit(0);
