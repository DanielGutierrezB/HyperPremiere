#!/usr/bin/env node
'use strict';

// CLI de mentira que se hace pasar por `cursor-agent`, hermano de
// fake-claude.js. Existe para probar sin red ni tokens la red de abajo del
// proveedor de Cursor: los cierres raros en los que la generación ya está
// pagada y se pierde por no mirar los mensajes del agente.
//
// Qué contesta lo elige FAKE_MODE; la salida sale de una corrida REAL
// (fixtures/cursor-tools-partial.jsonl), retocada para cada caso.

const fs = require('fs');
const path = require('path');

const modo = process.env.FAKE_MODE || 'stream';
const fixtures = path.join(__dirname, '..');
const real = fs.readFileSync(path.join(fixtures, 'cursor-tools-partial.jsonl'), 'utf8');

/** La corrida real SIN su evento de cierre. */
function sinCierre() {
  return real.split('\n').filter(Boolean)
    .filter((l) => l.indexOf('"type":"result"') === -1)
    .join('\n') + '\n';
}

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
} else if (modo === 'basura') {
  // El cierre no es JSON (una traza, un banner del backend). Los mensajes del
  // agente están completos igual.
  process.stdout.write(sinCierre());
  process.stdout.write('panic: connection reset by peer\n');
} else {
  process.stdout.write(real);
}
