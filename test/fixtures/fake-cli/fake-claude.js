#!/usr/bin/env node
'use strict';

// CLI de mentira que se hace pasar por `claude` para probar sin red ni tokens
// los caminos que en la vida real aparecen una vez cada mil: un CLI viejo que
// no conoce los flags nuevos, un stream que se corta antes del final, y el
// prompt entrando por stdin (lo que se usa en Windows).
//
// Qué hace lo elige FAKE_MODE; en FAKE_LOG deja lo que recibió, para poder
// afirmar que el prompt viajó por donde tenía que viajar.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const modo = process.env.FAKE_MODE || 'stream';
const log = process.env.FAKE_LOG;
const fixtures = path.join(__dirname, '..');

function anotar(extra) {
  if (!log) return;
  const datos = Object.assign({ args: args, modo: modo }, extra);
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

const streaming = args.indexOf('stream-json') !== -1;

async function main() {
  const stdin = await leerStdin();
  anotar({ stdinLen: stdin.length, stdin: stdin.slice(0, 200) });

  if (modo === 'viejo' && streaming) {
    // Exactamente lo que contesta un CLI que no conoce el flag (verificado).
    process.stderr.write("error: unknown option '--include-partial-messages'\n");
    process.exit(1);
  }

  if (modo === 'viejo') {
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: '<html>viejo</html>',
      usage: { input_tokens: 5, output_tokens: 7 },
      total_cost_usd: 0.01,
    }) + '\n');
    return;
  }

  // Los modos de stream reproducen una salida REAL capturada del CLI.
  const real = fs.readFileSync(path.join(fixtures, 'claude-thinking.jsonl'), 'utf8');
  if (modo === 'sin-final') {
    // Se corta antes del evento de resultado: queda el rescate por los mensajes.
    const lineas = real.split('\n').filter(Boolean)
      .filter((l) => l.indexOf('"type":"result"') === -1);
    process.stdout.write(lineas.join('\n') + '\n');
    return;
  }
  if (modo === 'final-vacio') {
    // El evento final LLEGA, con sus tokens, pero sin texto. Visto una vez en
    // pruebas reales: el agente dio una segunda vuelta y esa terminó sin
    // respuesta, con la composición ya escrita en la vuelta anterior. Es
    // distinto de 'sin-final' (ahí no hay evento) y hay que rescatar igual,
    // pero SIN perder el conteo de tokens, que en este caso sí vino.
    const lineas = real.split('\n').filter(Boolean)
      .filter((l) => l.indexOf('"type":"result"') === -1);
    process.stdout.write(lineas.join('\n') + '\n');
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: '',
      usage: { input_tokens: 33, output_tokens: 44 },
      total_cost_usd: 0.05,
    }) + '\n');
    return;
  }
  if (modo === 'mudo') {
    // Ni resultado ni mensajes: el modelo no dejó una sola línea. Acá no hay
    // nada que rescatar y el motor tiene que DECIRLO, no quedarse callado.
    const lineas = real.split('\n').filter(Boolean)
      .filter((l) => l.indexOf('"type":"result"') === -1 && l.indexOf('"type":"assistant"') === -1);
    process.stdout.write(lineas.join('\n') + '\n');
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: '',
      usage: { input_tokens: 33, output_tokens: 0 },
      total_cost_usd: 0.01,
    }) + '\n');
    return;
  }
  if (modo === 'stdin') {
    // Devuelve por dónde entró el prompt, para poder afirmarlo desde el test.
    process.stdout.write(real.split('\n').filter(Boolean).slice(0, -1).join('\n') + '\n');
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: 'STDIN:' + stdin.length + ' ARGS:' + args.filter((a) => a.length > 200).length,
      usage: { input_tokens: 11, output_tokens: 22 },
      total_cost_usd: 0.02,
    }) + '\n');
    return;
  }
  process.stdout.write(real);
}

main();
