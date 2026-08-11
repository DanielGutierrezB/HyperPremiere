'use strict';

// Lo que se prueba acá es el traductor de la salida de los CLI de agente al
// texto que ve el editor en la barra ("razonando · …", "leyendo un archivo").
//
// Las fixtures NO son inventadas: son la salida real de `claude` 2.1.201 y de
// `cursor-agent` 2026.08.04 corriendo con los mismos flags que usa el motor
// (ver test/fixtures/README.md). Ese es el punto: el formato lo definen
// ellos y cambia sin avisar, así que la prueba tiene que ser contra lo que
// escupen de verdad.

const fs = require('fs');
const path = require('path');
const { test, ok, eq, has } = require('./harness');
const as = require('../bridge/providers/agent-stream');

const FIX = path.join(__dirname, 'fixtures');
function fixture(name) { return fs.readFileSync(path.join(FIX, name), 'utf8'); }

/**
 * Reproduce una salida capturada como si llegara del proceso y devuelve las
 * actividades que habría visto el panel. `chunk` parte el texto en pedazos de
 * ese tamaño: así se prueba que un evento cortado a la mitad (que es lo normal
 * en un pipe) no rompa nada.
 */
function replay(dialect, name, opts, chunk) {
  const txt = fixture(name);
  const acts = [];
  const r = as.createActivityReader(dialect, function (a) { acts.push(a); }, opts || {});
  const size = chunk || txt.length;
  for (let i = 0; i < txt.length; i += size) r.onData(txt.slice(i, i + size));
  return acts;
}

function phases(acts) { return acts.map(function (a) { return a.phase; }).join(' → '); }
function labels(acts) { return acts.map(function (a) { return a.label; }); }

// ── Claude ───────────────────────────────────────────────────────────

test('claude: una corrida con razonamiento cuenta arranque, pensamiento y escritura', function () {
  const acts = replay('claude', 'claude-thinking.jsonl', { partial: true });
  eq(acts[0].phase, 'start', 'el primer aviso es que el agente arrancó');
  eq(acts[0].label, 'el agente arrancó');
  ok(acts.some(function (a) { return a.phase === 'thinking'; }), 'hay fase de razonamiento');
  ok(acts.some(function (a) { return a.phase === 'writing'; }), 'hay fase de escritura');
  const conTokens = acts.filter(function (a) { return a.phase === 'thinking' && a.tokens > 0; });
  ok(conTokens.length > 0, 'el contador de tokens de pensamiento llega al panel');
  has(conTokens[0].label, 'razonando', 'la línea dice que está razonando');
  has(conTokens[0].label, 'tok', 'la línea muestra los tokens');
  const escribiendo = acts.filter(function (a) { return a.phase === 'writing' && a.chars > 0; });
  ok(escribiendo.length > 0, 'los caracteres escritos se van contando');
  has(escribiendo[0].label, 'escribiendo la composición');
});

test('claude: una herramienta se nombra en criollo', function () {
  const acts = replay('claude', 'claude-tool.jsonl', { partial: true });
  const tool = acts.filter(function (a) { return a.phase === 'tool'; });
  ok(tool.length > 0, 'el uso de una herramienta se informa');
  eq(tool[0].tool, 'read', 'el nombre de la herramienta se normaliza');
  eq(tool[0].label, 'leyendo un archivo');
});

test('claude: el resultado final del stream es el mismo objeto que con --output-format json', function () {
  const fin = as.finalResult(fixture('claude-thinking.jsonl'));
  ok(fin, 'aparece el evento de resultado');
  eq(fin.type, 'result');
  eq(fin.is_error, false);
  ok(typeof fin.result === 'string' && fin.result.length > 0, 'trae el texto de la respuesta');
  ok(fin.usage && typeof fin.usage.input_tokens === 'number', 'trae el uso de tokens');
  eq(typeof fin.total_cost_usd, 'number', 'trae el costo en dólares');
});

// ── Cursor ───────────────────────────────────────────────────────────

test('cursor: cada herramienta se informa con el archivo que tocó', function () {
  const acts = replay('cursor', 'cursor-tools-partial.jsonl', { partial: true });
  const tool = acts.filter(function (a) { return a.phase === 'tool'; });
  ok(tool.length >= 3, 'las tres herramientas de la corrida llegan al panel');
  eq(tool[0].label, 'buscando archivos · notas.txt');
  eq(tool[1].label, 'leyendo un archivo · notas.txt');
  has(tool[2].label, 'corriendo un comando');
  tool.forEach(function (a) {
    ok(a.detail.length <= 40, 'el detalle nunca pasa de 40 caracteres: ' + a.detail);
  });
});

test('cursor: la misma herramienta dos veces seguidas no se cuenta como una sola', function () {
  // Dos lecturas de archivos distintos son dos noticias; con la herramienta
  // fuera de la clave, la segunda quedaba tapada por el estrangulador.
  const acts = replay('cursor', 'cursor-tools-partial.jsonl', { partial: true });
  const detalles = acts.filter(function (a) { return a.phase === 'tool'; })
    .map(function (a) { return a.tool + '|' + a.detail; });
  eq(detalles.length, new Set(detalles).size, 'no se repiten y no se pisan');
});

test('cursor: sin parciales, la respuesta entera se cuenta una vez', function () {
  const acts = replay('cursor', 'cursor-plain.jsonl', {});
  const esc = acts.filter(function (a) { return a.phase === 'writing'; });
  ok(esc.length > 0, 'informa que está escribiendo');
  const fin = as.finalResult(fixture('cursor-plain.jsonl'));
  eq(esc[esc.length - 1].chars, fin.result.length, 'cuenta exactamente lo que respondió');
});

// ── Lo que sostiene todo: el resultado nunca se pierde ────────────────

test('el HTML se puede rescatar aunque falte el evento final, sin duplicarse', function () {
  // Es la red de abajo de una generación de tres minutos que YA se pagó. Con
  // los parciales de Cursor (que repiten la respuesta entera al final) el
  // rescate salía DOS VECES; tiene que salir igual al resultado oficial.
  ['claude-thinking.jsonl', 'claude-tool.jsonl', 'cursor-tools-partial.jsonl', 'cursor-plain.jsonl']
    .forEach(function (f) {
      const txt = fixture(f);
      eq(as.assistantText(txt), as.finalResult(txt).result, 'rescate idéntico al resultado en ' + f);
    });
});

test('la salida cortada en pedazos de 7 bytes se lee igual que entera', function () {
  [['claude', 'claude-thinking.jsonl', { partial: true }],
    ['claude', 'claude-tool.jsonl', { partial: true }],
    ['cursor', 'cursor-tools-partial.jsonl', { partial: true }],
    ['cursor', 'cursor-plain.jsonl', {}]].forEach(function (c) {
    const entera = labels(replay(c[0], c[1], c[2]));
    const cortada = labels(replay(c[0], c[1], c[2], 7));
    eq(cortada.join(' | '), entera.join(' | '), 'mismo resultado en ' + c[1]);
  });
});

test('la basura en el medio no voltea nada', function () {
  const acts = [];
  const r = as.createActivityReader('claude', function (a) { acts.push(a); }, { partial: true });
  r.onData('esto no es json\n');
  r.onData('{"type":"system","subtype":"init"}\n');
  r.onData('{ roto sin cerrar\n');
  r.onData('\n\n   \n');
  r.onData('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hola"}}}\n');
  r.onData('{"type":"loquesea_que_inventen_manana","cosa":1}\n');
  eq(phases(acts), 'start → writing', 'solo pasan los eventos que se entienden');
});

test('una línea gigante sin saltos no se acumula para siempre', function () {
  const r = as.createActivityReader('claude', function () {}, {});
  for (let i = 0; i < 30; i++) r.onData('x'.repeat(100_000));
  ok(true, 'no explota ni se queda sin memoria');
});

// ── Lo que ve el editor ──────────────────────────────────────────────

test('ninguna línea rompe el renglón del panel', function () {
  // El texto sale de un modelo: si trae saltos de línea o mide 3.000
  // caracteres, deforma la tarjeta de la cola.
  [['claude', 'claude-thinking.jsonl', { partial: true }],
    ['cursor', 'cursor-tools-partial.jsonl', { partial: true }]].forEach(function (c) {
    replay(c[0], c[1], c[2]).forEach(function (a) {
      eq(a.label.indexOf('\n'), -1, 'sin saltos de línea: ' + JSON.stringify(a.label));
      ok(a.label.length <= 180, 'línea de largo razonable (' + a.label.length + ')');
    });
  });
});

test('el razonamiento se muestra por el final y de a una línea', function () {
  const largo = 'palabra '.repeat(400) + 'ESTO ES LO ULTIMO QUE PENSO';
  const t = as.tail('  \n\t ' + largo.replace(/ /g, '\n'), 110);
  ok(t.length <= 111, 'entra en el renglón');
  eq(t.indexOf('\n'), -1, 'sin saltos');
  has(t, 'ULTIMO QUE PENSO', 'muestra la cola, que es lo que está pensando ahora');
});

test('un nombre de herramienta inventado no rompe la línea', function () {
  const raw = 'Herramienta' + 'X'.repeat(500) + 'ToolCall';
  const n = as.normalizeToolName(raw);
  ok(n.length <= 32, 'se recorta');
  has(as.describe({ phase: 'tool', tool: n }), 'usando ', 'igual se dice qué hace');
});

// ── Los interruptores de emergencia ──────────────────────────────────

test('se puede apagar el estado en vivo por variable de entorno', function () {
  const prev = process.env.HYPERPREMIERE_STREAM;
  ['0', 'false', 'no', 'off', 'OFF'].forEach(function (v) {
    process.env.HYPERPREMIERE_STREAM = v;
    ok(as.envDisabled('HYPERPREMIERE_STREAM'), 'apagado con "' + v + '"');
  });
  ['1', 'true', '', 'si'].forEach(function (v) {
    process.env.HYPERPREMIERE_STREAM = v;
    ok(!as.envDisabled('HYPERPREMIERE_STREAM'), 'encendido con "' + v + '"');
  });
  if (prev === undefined) delete process.env.HYPERPREMIERE_STREAM;
  else process.env.HYPERPREMIERE_STREAM = prev;
});

test('un CLI viejo que rechaza los flags se reconoce por su mensaje real', function () {
  // Los dos textos de abajo son los que devuelven hoy los CLI (verificado
  // corriéndolos): de eso depende que el motor reintente sin streaming en vez
  // de dejar al editor sin generación.
  ok(as.isUnsupportedFlag("error: unknown option '--include-partial-messages'"), 'claude/cursor: flag desconocido');
  ok(as.isUnsupportedFlag('Error: When using --print, --output-format=stream-json requires --verbose'), 'claude: falta --verbose');
  ok(!as.isUnsupportedFlag('Error: usage limit reached, resets at 5pm'), 'un límite de cuota NO es un flag viejo');
  ok(!as.isUnsupportedFlag(''), 'sin mensaje, no se asume nada');
});

test('sin quien mire, no se arma ningún lector', function () {
  eq(as.createActivityReader('claude', null, {}).onData, null, 'sin callback no hay lector');
  eq(as.createActivityReader('un-cli-que-no-conocemos', function () {}, {}).onData, null, 'dialecto desconocido');
});
