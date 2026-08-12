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

function argsDe(style, opts) {
  const tool = t.TOOLS.find((x) => x.style === style);
  if (!tool) throw new Error('no existe la variante ' + style);
  return t._whisperArgs(tool, '/tmp/audio.wav', '/tmp/salida', opts);
}

function tiene(args, flag) { return args.indexOf(flag) !== -1; }

// El valor que sigue a un flag, o null si el flag no está.
function valorDe(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

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

// ── La precisión (int8 / float16 / CPU) ─────────────────────────────────────
// El otro caso real: en una máquina con RTX 50xx, Faster-Whisper-XXL elegía la
// GPU solo y reventaba con "cuBLAS failed with status CUBLAS_STATUS_NOT_SUPPORTED",
// porque esas placas no multiplican en int8 y nosotros lo pedíamos fijo. El
// flag pensado para CPU hacía fallar justo a las máquinas más rápidas.

['fwxxl', 'ct2'].forEach(function (style) {
  test(style + ': con GPU pide float16, NUNCA int8 (int8 mata a las RTX 50xx)', function () {
    const args = argsDe(style, { gpu: true });
    ok(valorDe(args, '--compute_type') === 'float16', 'debería pedir float16, pide ' + valorDe(args, '--compute_type'));
    ok(!tiene(args, 'int8'), 'no debe quedar ningún int8 suelto');
  });

  test(style + ': sin GPU pide int8, que en CPU es varias veces más rápido', function () {
    const args = argsDe(style, { gpu: false });
    ok(valorDe(args, '--compute_type') === 'int8', 'sin placa conviene int8');
    // Sin --device, la herramienta usa CPU igual: no hay a qué otra cosa recurrir.
    ok(!tiene(args, '--device'), 'no hace falta forzar el dispositivo si no hay GPU');
  });

  test(style + ': el reintento en CPU fuerza el dispositivo, no alcanza con la precisión', function () {
    // Si solo cambiáramos la precisión, la herramienta volvería a elegir la GPU
    // que acaba de fallar. Hay que sacarla de la ecuación.
    const args = argsDe(style, { gpu: true, cpuOnly: true });
    ok(valorDe(args, '--device') === 'cpu', 'falta --device cpu en el reintento');
    ok(valorDe(args, '--compute_type') === 'int8', 'en CPU va int8');
  });

  test(style + ': la precisión no se come los flags propios de la variante', function () {
    // Armamos los args concatenando listas: un error de orden acá borra
    // --print_progress (y el watchdog mata la corrida) o el anti-bucle.
    const args = argsDe(style, { gpu: true });
    ok(tiene(args, '--condition_on_previous_text'), 'se perdió el flag anti-bucle');
    ok(valorDe(args, '--output_format') === 'json', 'se perdió el JSON');
    ok(tiene(args, style === 'fwxxl' ? '--print_progress' : '--verbose'), 'se perdió el flag propio de ' + style);
  });
});

test('el error de la RTX 50xx del editor se reconoce como problema de GPU', function () {
  // Copiado tal cual del log que mandó el editor con Windows.
  const real = [
    'RuntimeError: cuBLAS failed with status CUBLAS_STATUS_NOT_SUPPORTED',
    "[PYI-51512:ERROR] Failed to execute script '__main__' due to unhandled exception!",
  ].join('\n');
  ok(t._isCudaError(real), 'sin esto no hay reintento y la transcripción se pierde');
});

test('otros líos de GPU también mandan el reintento a CPU', function () {
  ['Library cublas64_12.dll is not found', 'cuDNN failed to initialize',
   'CUDA failed with error out of memory', 'no kernel image is available for execution on the device',
  ].forEach(function (msg) {
    ok(t._isCudaError(msg), 'debería reconocerse como problema de GPU: ' + msg);
  });
});

test('un error común NO se confunde con la GPU: reintentar en CPU no lo arreglaría', function () {
  ['unrecognized arguments: --condition_on_previous_text',
   'No such file or directory: sequence.wav',
   'MemoryError',
  ].forEach(function (msg) {
    ok(!t._isCudaError(msg), 'no es un problema de GPU: ' + msg);
  });
});
