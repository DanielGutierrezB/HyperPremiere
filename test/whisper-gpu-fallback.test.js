'use strict';

// La transcripción cuando la GPU no puede.
//
// Caso real de un editor con Windows y una RTX 50xx: el audio se exportaba
// bien, el modelo cargaba, y recién ahí Faster-Whisper-XXL abortaba con
// "cuBLAS failed with status CUBLAS_STATUS_NOT_SUPPORTED". Esas placas no
// multiplican en int8 y nosotros pedíamos int8 fijo, pensando en CPU; pero la
// herramienta agarra la GPU sola si la encuentra. Resultado: la máquina más
// potente era la única que no podía transcribir.
//
// Los flags en sí se prueban en whisper-args.test.js. Acá se prueba la CORRIDA:
// que ante ese error se rehaga en CPU y el editor termine con su transcript.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { test, ok, eq } = require('./harness');

// Todo lo que transcribe.js ejecuta afuera pasa por run(), así que con
// reemplazar esa función se puede simular la máquina entera (whisper, ffmpeg,
// ffprobe, nvidia-smi). Como transcribe.js la toma por destructuring al
// cargarse, hay que parchear exec ANTES de requerirlo, y por eso se limpia el
// cache de los dos módulos.
function cargarTranscribeCon(runFalso) {
  const execPath = require.resolve('../bridge/exec');
  const transPath = require.resolve('../bridge/transcribe');
  delete require.cache[execPath];
  delete require.cache[transPath];
  const exec = require('../bridge/exec');
  const runReal = exec.run;
  exec.run = runFalso;
  const transcribe = require('../bridge/transcribe');
  return {
    transcribe,
    restaurar: function () {
      exec.run = runReal;
      delete require.cache[execPath];
      delete require.cache[transPath];
    },
  };
}

const BIN = '/fake/bin/faster-whisper-xxl';

// El traceback tal cual lo mandó el editor, incluido que vino por stdout con
// stderr vacío (por eso el mensaje original decía "stderr: (vacío)").
const ERROR_RTX50 = [
  'Traceback (most recent call last):',
  '  File "D:\\whisper-fast-XXL\\__main__.py", line 2324, in <module>',
  '  File "faster_whisper\\transcribe.py", line 1719, in encode',
  'RuntimeError: cuBLAS failed with status CUBLAS_STATUS_NOT_SUPPORTED',
].join('\n');

/**
 * Máquina de mentira. `resultados(args)` decide qué hace el whisper falso en
 * cada llamada; el resto de los comandos responden como una máquina sana.
 */
function maquina(opts) {
  const llamadasWhisper = [];
  const vistos = [];
  async function runFalso(cmd, args, runOpts) {
    args = args || [];
    const linea = String(cmd) + ' ' + args.join(' ');
    vistos.push(linea);

    if (cmd === 'which' || cmd === 'where') return { code: 0, out: BIN, err: '' };

    if (cmd === 'nvidia-smi') {
      return opts.gpu
        ? { code: 0, out: 'GPU 0: NVIDIA GeForce RTX 5080 (UUID: GPU-1a2b3c)', err: '' }
        : { code: -1, out: '', err: 'spawn nvidia-smi ENOENT' };
    }

    if (cmd === 'ffprobe') return { code: 0, out: '120\n', err: '' };

    if (cmd === 'ffmpeg') {
      // volumedetect informa por stderr; con estos niveles el audio "tiene voz".
      if (linea.indexOf('volumedetect') !== -1) {
        return { code: 0, out: '', err: 'mean_volume: -22.0 dB\nmax_volume: -4.0 dB' };
      }
      return { code: 0, out: '', err: '' }; // silencedetect: sin cola muda
    }

    if (cmd === BIN) {
      llamadasWhisper.push(args);
      const enCpu = args.indexOf('--device') !== -1 && args[args.indexOf('--device') + 1] === 'cpu';
      const falla = enCpu ? opts.fallaEnCpu : opts.fallaEnGpu;
      if (falla) return { code: 1, out: ERROR_RTX50, err: '' };
      // Whisper deja el JSON en su directorio de trabajo: ahí lo busca el motor.
      fs.writeFileSync(path.join(runOpts.cwd, 'audio.json'), JSON.stringify({
        language: 'es',
        segments: [{ start: 0, end: 2.5, text: 'Hola, esto es la clase.' }],
      }));
      return { code: 0, out: '', err: '' };
    }

    return { code: 0, out: '', err: '' };
  }
  return { runFalso: runFalso, llamadasWhisper: llamadasWhisper, vistos: vistos };
}

// Un wav de mentira: solo tiene que existir, porque ffmpeg está simulado.
function audioDeMentira() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-test-audio-'));
  const wav = path.join(dir, 'sequence.wav');
  fs.writeFileSync(wav, 'no es un wav de verdad');
  return { wav: wav, proyecto: dir };
}

/**
 * Transcribe `veces` secuencias con UNA sola carga del motor, como pasa cuando
 * el editor encola varias clases seguidas. Devuelve el resultado de la última.
 */
async function transcribirCon(m, veces) {
  const previo = process.env.HYPERPREMIERE_WHISPER_BIN;
  process.env.HYPERPREMIERE_WHISPER_BIN = 'faster-whisper-xxl';
  const cargado = cargarTranscribeCon(m.runFalso);
  const audio = audioDeMentira();
  try {
    let r = null;
    for (let i = 0; i < (veces || 1); i++) {
      r = await cargado.transcribe.transcribeMedia({
        mediaPath: audio.wav,
        projectPath: path.join(audio.proyecto, 'proyecto.prproj'),
        sequenceName: 'clase-' + (14 + i),
        clipName: 'clase-' + (14 + i),
        alreadyPrepared: true, // el wav ya viene mono 16 kHz, como lo exporta Premiere
      });
    }
    return r;
  } finally {
    cargado.restaurar();
    if (previo === undefined) delete process.env.HYPERPREMIERE_WHISPER_BIN;
    else process.env.HYPERPREMIERE_WHISPER_BIN = previo;
    try { fs.rmSync(audio.proyecto, { recursive: true, force: true }); } catch (e) {}
  }
}

function valorDe(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

test('la RTX 50xx rechaza la corrida y el editor igual termina con su transcript', async function () {
  const m = maquina({ gpu: true, fallaEnGpu: true, fallaEnCpu: false });
  const r = await transcribirCon(m);

  ok(r.ok, 'la transcripción debería salir bien tras reintentar: ' + (r.error || ''));
  eq(r.segments.length, 1, 'tendría que traer el segmento del JSON');
  eq(r.language, 'es', 'y el idioma detectado');
});

test('primero prueba en la placa y solo después baja a CPU (no al revés)', async function () {
  // El orden importa: bajar a CPU de entrada le sacaría la GPU a todo el mundo.
  const m = maquina({ gpu: true, fallaEnGpu: true, fallaEnCpu: false });
  await transcribirCon(m);

  eq(m.llamadasWhisper.length, 2, 'debería haber exactamente dos intentos');
  eq(valorDe(m.llamadasWhisper[0], '--compute_type'), 'float16', 'el primer intento va a la GPU');
  eq(valorDe(m.llamadasWhisper[1], '--device'), 'cpu', 'el segundo se hace en CPU');
  eq(valorDe(m.llamadasWhisper[1], '--compute_type'), 'int8', 'en CPU conviene int8');
});

test('sin placa NVIDIA no se reintenta nada: va derecho a CPU y basta', async function () {
  const m = maquina({ gpu: false, fallaEnGpu: false, fallaEnCpu: false });
  const r = await transcribirCon(m);

  ok(r.ok, 'debería transcribir sin problemas');
  eq(m.llamadasWhisper.length, 1, 'una sola corrida: no hay GPU que pueda fallar');
  eq(valorDe(m.llamadasWhisper[0], '--compute_type'), 'int8', 'sin GPU va int8');
});

test('si también falla en CPU se corta ahí, con el motivo y sin reintentar de nuevo', async function () {
  // Sin tope, un error que se repite dejaría al editor esperando para siempre.
  const m = maquina({ gpu: true, fallaEnGpu: true, fallaEnCpu: true });
  const r = await transcribirCon(m);

  ok(!r.ok, 'no puede dar por buena una corrida que falló');
  eq(m.llamadasWhisper.length, 2, 'dos intentos y se planta');
  ok(/cuBLAS/i.test(r.error), 'el error tiene que decir qué pasó realmente:\n' + r.error);
});

test('a la placa se le pregunta una vez por sesión, no en cada clase de la cola', async function () {
  // Tres clases seguidas: la placa no va a aparecer ni desaparecer entre una y
  // otra, así que preguntar de nuevo es un proceso al pedo cada vez.
  const m = maquina({ gpu: true, fallaEnGpu: true, fallaEnCpu: false });
  await transcribirCon(m, 3);

  eq(m.llamadasWhisper.length, 6, 'tres clases, dos intentos cada una');
  const consultas = m.vistos.filter(function (l) { return l.indexOf('nvidia-smi') === 0; });
  eq(consultas.length, 1, 'se preguntó ' + consultas.length + ' veces por la misma placa');
});
