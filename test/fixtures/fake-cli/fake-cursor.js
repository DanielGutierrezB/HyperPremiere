#!/usr/bin/env node
'use strict';

// CLI de mentira que se hace pasar por `cursor-agent`, hermano de
// fake-claude.js. Existe para probar sin red ni tokens la red de abajo del
// proveedor de Cursor: los cierres raros en los que la generación ya está
// pagada y se pierde por no mirar los mensajes del agente.
//
// Qué contesta lo elige FAKE_MODE; la salida sale de una corrida REAL
// (fixtures/cursor-tools-partial.jsonl), retocada para cada caso.
//
// Y en FAKE_LOG deja el prompt EXACTO que recibió. Hace falta porque en Cursor
// el mensaje es todo lo que hay —no tiene canal de system prompt—, así que el
// único modo de afirmar que el contrato quedó al final es leer el texto entero
// tal como le llegó.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const modo = process.env.FAKE_MODE || 'stream';
const log = process.env.FAKE_LOG;
const fixtures = path.join(__dirname, '..');
const real = fs.readFileSync(path.join(fixtures, 'cursor-tools-partial.jsonl'), 'utf8');

/** Valor del flag `nombre`, o null si no vino. */
function flag(nombre) {
  const i = args.indexOf(nombre);
  return (i !== -1 && i + 1 < args.length) ? args[i + 1] : null;
}

function anotar(extra) {
  if (!log) return;
  const datos = Object.assign({
    args: args,
    modo: modo,
    cwd: process.cwd(),
    workspace: flag('--workspace'),
  }, extra);
  try { fs.writeFileSync(log, JSON.stringify(datos), 'utf8'); } catch (e) {}
}

function leerStdin() {
  return new Promise((resolve) => {
    let s = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', () => resolve(s));
  });
}

/** La corrida real SIN su evento de cierre. */
function sinCierre() {
  return real.split('\n').filter(Boolean)
    .filter((l) => l.indexOf('"type":"result"') === -1)
    .join('\n') + '\n';
}

async function main() {
  const stdin = await leerStdin();
  // El prompt por argumento va pegado a `-p` (el proveedor lo mete en la
  // posición 1); todo lo demás son flags o valores de flag.
  const posicional = (args[0] === '-p' && args[1] && args[1].charAt(0) !== '-') ? args[1] : null;
  anotar({
    stdinLen: stdin.length,
    stdinCompleto: stdin,
    promptPosicional: posicional,
  });

  if (modo === 'final-vacio') {
    // El cierre LLEGA, con sus tokens, pero con el resultado en blanco: el
    // agente dio otra vuelta y esa terminó sin texto. La respuesta está en los
    // mensajes de la vuelta anterior.
    process.stdout.write(sinCierre());
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: '',
      usage: { inputTokens: 33, outputTokens: 44, cacheReadTokens: 5, cacheWriteTokens: 6 },
    }) + '\n');
    return;
  }
  if (modo === 'basura') {
    // El cierre no es JSON (una traza, un banner del backend). Los mensajes del
    // agente están completos igual.
    process.stdout.write(sinCierre());
    process.stdout.write('panic: connection reset by peer\n');
    return;
  }
  if (modo === 'usage-real') {
    // El `usage` EXACTO que devolvió cursor-agent con el prompt más chico
    // posible ("Decí solamente: hola"): 2 tokens de entrada y 31.823 escritos a
    // caché, que es su propio contexto. Está acá para que se vea de una que
    // contar `inputTokens` es contar nada.
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: '<html>ok</html>',
      usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 31823 },
    }) + '\n');
    return;
  }
  if (modo === 'plano') {
    // Un cierre limpio, como el de `--output-format json`: sirve para los tests
    // que no miran el estado en vivo sino QUÉ PROMPT recibió el CLI.
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: '<html>plano</html>',
      usage: { inputTokens: 9, outputTokens: 8 },
    }) + '\n');
    return;
  }
  process.stdout.write(real);
}

main();
