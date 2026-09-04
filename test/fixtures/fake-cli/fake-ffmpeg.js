#!/usr/bin/env node
'use strict';

// ffmpeg de mentira, para el micrófono del dictado.
//
// Se lo pone en HYPERPREMIERE_FFMPEG y el motor lo lanza con los mismos
// argumentos que al de verdad. Contesta las tres cosas que el dictado le pide a
// ffmpeg, con la forma real de cada una:
//   -version            → una línea de versión, código 0.
//   -list_devices true  → la lista de dispositivos por STDERR (así la escribe el
//                         de verdad) y código 251, que es con lo que sale el real
//                         aunque la lista haya salido bien.
//   captura             → PCM s16le por stdout, en trozos de 100 ms a tiempo
//                         real, hasta que lo matan. Lo que suena depende del modo.
//
// FAKE_FFMPEG_LOG: archivo donde deja una línea JSON con los argv de cada
//   invocación. Comparar esa línea con los argumentos que arma el motor ES el
//   test de que la prueba de micrófono usa el mismo comando que el dictado.
// FAKE_FFMPEG_LISTA: fixture a imprimir con -list_devices (por defecto, la
//   salida real de esta máquina).
// FAKE_FFMPEG_MODO (captura):
//   'voz'         (por defecto) una onda a RMS ≈ 0,08: habla, como se midió.
//   'floja'       la misma onda a RMS ≈ 0,006: el ruido de una sala callada.
//   'ceros'       muestras, todas en cero exacto: lo que entrega un dispositivo
//                 virtual, o un micrófono con el permiso negado.
//   'nada'        ni una muestra, y el proceso sigue vivo: el iPhone por
//                 Continuidad con el teléfono lejos, medido acá.
//   'no-abre'     el error real de un índice que ya no existe.
//   'sin-permiso' el error de entrada/salida a secas, sin más detalle.
//   'ruido-cmio'  como 'voz', pero antes escupe por stderr la línea que deja el
//                 plugin de EOS Webcam Utility en cada arranque de ffmpeg.

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const modo = process.env.FAKE_FFMPEG_MODO || 'voz';

if (process.env.FAKE_FFMPEG_LOG) {
  try { fs.appendFileSync(process.env.FAKE_FFMPEG_LOG, JSON.stringify(argv) + '\n'); } catch (e) {}
}

const RUIDO_CMIO = '2026-09-03 20:34:42.309 ffmpeg[17737:129621] CMIOMS: EOSWebcamUtilityMain \n';

if (argv.indexOf('-version') !== -1) {
  process.stdout.write('ffmpeg version 9.0.1-falso Copyright (c) 2000-2026 the FFmpeg developers\n');
  process.exit(0);
}

if (argv.indexOf('-list_devices') !== -1) {
  const fixture = process.env.FAKE_FFMPEG_LISTA ||
    path.join(__dirname, '..', 'avfoundation-list-devices.txt');
  process.stderr.write(fs.readFileSync(fixture, 'utf8'));
  process.exit(251);
}

// Captura.
const entrada = argv[argv.indexOf('-i') + 1] || '';

if (modo === 'no-abre') {
  process.stderr.write(RUIDO_CMIO +
    '[AVFoundation indev @ 0xb60c1c140] Invalid audio device index\n' +
    '[in#0 @ 0xb60c1c000] Error opening input: Input/output error\n' +
    'Error opening input file ' + entrada + '.\n' +
    'Error opening input files: Input/output error\n');
  process.exit(251);
}
if (modo === 'sin-permiso') {
  process.stderr.write('[in#0 @ 0xb60c1c000] Error opening input: Input/output error\n' +
    'Error opening input file ' + entrada + '.\n');
  process.exit(251);
}
if (modo === 'ruido-cmio') process.stderr.write(RUIDO_CMIO);

const RATE = 16000;
const MUESTRAS_POR_TROZO = RATE / 10; // 100 ms
let fase = 0;

function trozo() {
  const buf = Buffer.alloc(MUESTRAS_POR_TROZO * 2);
  if (modo === 'ceros') return buf;
  // RMS de una senoidal = amplitud / √2. Para RMS 0,08 la amplitud es ~0,113.
  const amplitud = (modo === 'floja' ? 0.006 : 0.08) * Math.SQRT2;
  for (let i = 0; i < MUESTRAS_POR_TROZO; i++) {
    buf.writeInt16LE(Math.round(Math.sin(fase) * amplitud * 32767), i * 2);
    fase += 2 * Math.PI * 440 / RATE;
  }
  return buf;
}

if (modo !== 'nada') {
  setInterval(() => { try { process.stdout.write(trozo()); } catch (e) { process.exit(0); } }, 100);
} else {
  setInterval(() => {}, 1000); // vivo y mudo
}
process.on('SIGTERM', () => process.exit(0));
