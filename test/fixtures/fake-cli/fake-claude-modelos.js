#!/usr/bin/env node
'use strict';

// CLI de mentira para el selector de modelos de Claude. Contesta lo que usa la
// medición —`--version`, `update` y una llamada mínima por modelo— y cada
// llamada vuelve con el `modelUsage` que diga la tabla, que es de donde la
// medición saca quién contestó y con qué ventana.
//
// Y, como el binario de verdad, lleva ESCRITAS en su código las opciones de su
// menú /model: bridge/claude-medir.js las lee de este mismo archivo, así que el
// escaneo del binario se prueba de punta a punta.
//
//   FAKE_ESTADO  archivo con la versión instalada (la cambia `update`)
//   FAKE_ULTIMA  la versión que deja `update`
//   FAKE_UPDATE  'falla' → `update` sale con error y no cambia nada
//   FAKE_TABLA   JSON { pedido: { id, ventana, salida } | { error } }
//   FAKE_LOG     archivo donde se agrega una línea JSON por llamada
//   FAKE_VIEJO   '1' → rechaza --tools y --no-session-persistence, como un CLI viejo
//   FAKE_DEMORA  ms que tarda cada llamada (para ver cuántas corren a la vez)

// El menú, copiado del binario de Claude Code 2.1.288:
// {value:!id()?BS().opus48:"claude-opus-4-8",label:"Opus 4.8",description:"Opus 4.8 \xB7 Legacy",descriptionForModel:"Opus 4.8 - previous Opus version"}
// {value:BS().opus41,label:"Opus 4.1",description:"Opus 4.1 \xB7 Legacy",descriptionForModel:"Opus 4.1 - legacy version"}
// {value:!id()?BS().opus46:"claude-opus-4-6",label:"Opus 4.6",description:"Opus 4.6 \xB7 Legacy",descriptionForModel:"Opus 4.6 - previous Opus version"}

const fs = require('fs');

const args = process.argv.slice(2);

function flag(nombre) {
  const i = args.indexOf(nombre);
  return (i !== -1 && i + 1 < args.length) ? args[i + 1] : null;
}

function version() {
  try { return fs.readFileSync(process.env.FAKE_ESTADO, 'utf8').trim(); } catch (e) { return '2.1.288'; }
}

function anotar(datos) {
  if (!process.env.FAKE_LOG) return;
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(datos) + '\n');
}

if (args[0] === '--version') {
  process.stdout.write(version() + ' (Claude Code)\n');
  process.exit(0);
}

if (args[0] === 'update') {
  anotar({ comando: 'update', desde: version() });
  if (process.env.FAKE_UPDATE === 'falla') {
    process.stderr.write('Error: no se pudo bajar la versión nueva\n');
    process.exit(1);
  }
  if (process.env.FAKE_ULTIMA) fs.writeFileSync(process.env.FAKE_ESTADO, process.env.FAKE_ULTIMA);
  process.stdout.write('Successfully updated\n');
  process.exit(0);
}

if (args[0] === '-p') {
  if (process.env.FAKE_VIEJO === '1' && (args.indexOf('--tools') !== -1 || args.indexOf('--no-session-persistence') !== -1)) {
    anotar({ comando: 'rechazo', args: args });
    process.stderr.write("error: unknown option '--no-session-persistence'\n");
    process.exit(1);
  }
  const pedido = flag('--model') || 'default';
  const fila = JSON.parse(process.env.FAKE_TABLA || '{}')[pedido];
  const inicio = Date.now();
  setTimeout(function () {
    anotar({
      comando: 'pedido', pedido: pedido, args: args, inicio: inicio, fin: Date.now(),
      token: process.env.CLAUDE_CODE_OAUTH_TOKEN || '', cwd: process.cwd(),
    });
    if (!fila || fila.error) {
      process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: (fila && fila.error) || 'model not found: ' + pedido }));
      process.exit(1);
    }
    const uso = {};
    uso[fila.id] = { inputTokens: 2, outputTokens: 3, contextWindow: fila.ventana, maxOutputTokens: fila.salida || 64000 };
    process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'ok', modelUsage: uso }));
    process.exit(0);
  }, Number(process.env.FAKE_DEMORA || 0));
} else if (args[0] !== '--version' && args[0] !== 'update') {
  process.stderr.write('fake-claude-modelos: no sé qué hacer con ' + JSON.stringify(args) + '\n');
  process.exit(2);
}
