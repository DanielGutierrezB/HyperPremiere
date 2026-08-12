'use strict';

// Los flags con los que se invoca cada variante de Whisper.
//
// Existe por un caso real: en Windows, Faster-Whisper-XXL abortaba con
// "--print_progress doesn't work with --verbose=True" y la transcripción moría
// después de haber exportado el audio. Le mandábamos las dos banderas juntas.
// Las combinaciones de flags no se pueden deducir leyendo el código: cada CLI
// tiene las suyas y solo se aprenden cuando fallan, así que se fijan acá.

const { test, ok } = require('./harness');
const t = require('../bridge/transcribe');

function argsDe(style) {
  const tool = t.TOOLS.find((x) => x.style === style);
  if (!tool) throw new Error('no existe la variante ' + style);
  return t._whisperArgs(tool, '/tmp/audio.wav', '/tmp/salida');
}

function tiene(args, flag) { return args.indexOf(flag) !== -1; }

test('faster-whisper-xxl NO manda --verbose: aborta si va con --print_progress', function () {
  const args = argsDe('fwxxl');
  ok(!tiene(args, '--verbose'), 'no debe ir --verbose junto a --print_progress');
});

test('faster-whisper-xxl sí manda --print_progress: sin eso el watchdog mata la corrida', function () {
  // El avance va por defecto a la barra de título de la consola, no a stdout.
  ok(tiene(argsDe('fwxxl'), '--print_progress'), 'falta --print_progress');
});

test('faster-whisper-xxl pide el JSON: de ahí salen los segmentos y el idioma', function () {
  // Sin --verbose, el JSON es la ÚNICA fuente: si se cae este flag, no queda nada que leer.
  const args = argsDe('fwxxl');
  const i = args.indexOf('--output_format');
  ok(i !== -1 && args[i + 1] === 'json', 'falta --output_format json');
});

test('faster-whisper-xxl silencia el beep del final', function () {
  ok(tiene(argsDe('fwxxl'), '--beep_off'), 'falta --beep_off (suena adentro de Premiere)');
});

test('las variantes que sí lo soportan conservan --verbose como respaldo', function () {
  // ct2 y openai no tienen --print_progress, así que no hay conflicto y la
  // salida verbose es la red por si el CLI no escribe el JSON.
  ['ct2', 'openai'].forEach(function (style) {
    const args = argsDe(style);
    ok(tiene(args, '--verbose'), style + ' debería mandar --verbose');
    ok(!tiene(args, '--print_progress'), style + ' no tiene --print_progress');
  });
});

test('mlx_whisper no manda --verbose, que no lo soporta', function () {
  ok(!tiene(argsDe('mlx'), '--verbose'), 'mlx_whisper no entiende --verbose');
});
