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

// Lo que contesta `cursor-agent --list-models`: una línea "<id> - <nombre>".
// La muestra es de una cuenta real, recortada, y a propósito trae de todo: las
// variantes "-fast" (pagan prioridad con más consumo), la "-none" (sin
// razonamiento), la gama chica y los niveles de pensamiento metidos en el ID.
// Todo eso es lo que el motor tiene que separar para que el panel muestre dos
// desplegables entendibles.
const LISTA_MODELOS = [
  'auto - Auto',
  'claude-sonnet-5 - Claude Sonnet 5',
  'claude-sonnet-5-thinking-none - Claude Sonnet 5 No Thinking',
  'claude-sonnet-5-thinking-high - Claude Sonnet 5 1M Thinking',
  'claude-sonnet-5-thinking-xhigh - Claude Sonnet 5 1M Extra High Thinking',
  'claude-sonnet-5-thinking-high-fast - Claude Sonnet 5 1M Thinking (Fast)',
  'claude-opus-5-thinking-high - Claude Opus 5 Thinking',
  'composer-2.5 - Composer 2.5',
  'gemini-3.1-flash - Gemini 3.1 Flash',
].join('\n');

async function main() {
  if (args.indexOf('--list-models') !== -1) {
    process.stdout.write(LISTA_MODELOS + '\n');
    return;
  }

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
  if (modo === 'texto-con-fence') {
    // Texto a secas, envuelto en un fence de markdown. Es lo que distingue
    // `complete` de `generate`: el primero devuelve lo que escribió el modelo
    // tal cual y el segundo le saca el fence. Refinar un dictado usa `complete`,
    // porque una instrucción de diseño no es una composición y pasarla por el
    // desenvolver-HTML es una poda esperando a que alguien mencione un bloque
    // de código.
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: '```html\nEl título entra con un fade.\n```',
      usage: { inputTokens: 2, outputTokens: 9 },
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
