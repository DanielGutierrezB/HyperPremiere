'use strict';

// Transcripción LOCAL de la secuencia con Whisper (sin nube, sin tokens).
//
// El panel manda la ruta del MEDIO original del clip principal de la
// secuencia (host.jsx la saca del projectItem); acá:
//   1. ffmpeg extrae el audio a WAV mono 16 kHz (lo que Whisper espera;
//      si ffmpeg no está, se le pasa el medio original directo a Whisper).
//   2. Se corre el Whisper que haya instalado en la máquina — `whisper`
//      (openai-whisper, el CLI clásico) o `mlx_whisper` (Apple Silicon) —
//      con el modelo large-v3 y SIN --language: Whisper detecta el idioma
//      solo, que es lo que sirve para clases que mezclan español e inglés.
//   3. Se lee el JSON de salida ({ segments: [{start, end, text}] }, el
//      mismo formato que ya parsea el panel) y se guarda una copia en la
//      carpeta de la secuencia (transcript-whisper.json) como respaldo.
//
// Los tiempos del resultado son del MEDIO original: el panel los alinea al
// timeline con el desfase del clip (inPoint - start), igual que un
// transcript importado.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { run, killTree } = require('./exec');
const { ensureOutputDir } = require('./store/project-fs');
// Registro del Whisper que instaló el propio panel (carpeta propia, ruta
// absoluta): se prefiere al PATH, que dentro de Premiere es un entorno mínimo.
const { readInstalled } = require('./store/whisper-home');

const IS_WIN = process.platform === 'win32';

// Modelo por defecto, según lo que la máquina puede sostener.
//
// En Mac (mlx, GPU de Apple Silicon) large-v3 corre rápido y es el más preciso.
// Fuera de Mac casi siempre se transcribe en CPU, y ahí large-v3 va a un RTF de
// ~2,5: una clase de una hora tarda dos horas y media, o sea que no se usa.
// large-v3-turbo tiene 809M de parámetros contra 1550M y va ~4× más rápido; en
// español la diferencia medida es de 0,4 puntos de WER (2,9% → 3,3%), que para
// un transcript que sirve de CONTEXTO —no de subtítulo en pantalla— no se nota.
// Lo único que turbo no sabe hacer es traducir, y acá nunca se traduce.
const DEFAULT_WHISPER_MODEL = process.platform === 'darwin' ? 'large-v3' : 'large-v3-turbo';
const WHISPER_MODEL = process.env.HYPERPREMIERE_WHISPER_MODEL || DEFAULT_WHISPER_MODEL;
// Watchdog de INACTIVIDAD de whisper: si pasa este lapso sin NINGUNA salida,
// está colgado y se mata (la carga del modelo y la transcripción imprimen
// algo con regularidad; 15 min mudo no es normal).
const WHISPER_IDLE_MS = Number(process.env.HYPERPREMIERE_WHISPER_IDLE_MS) || 900_000;

// Proceso en curso (ffmpeg o whisper) para poder CANCELAR desde el panel.
let currentChild = null;
let cancelled = false;

/** Cancela la transcripción en curso (mata el proceso activo y sus hijos). */
function cancelTranscription() {
  cancelled = true;
  if (currentChild) {
    killTree(currentChild);
    return { ok: true, cancelled: true };
  }
  return { ok: true, cancelled: false };
}

// Herramientas soportadas, ordenadas por VELOCIDAD (rápidas primero). El CLI
// clásico `whisper` (openai) corre en CPU y con large-v3 es LENTO (varios
// minutos por clase); los otros son mucho más rápidos con la misma calidad:
//   - mlx_whisper: GPU de Apple Silicon (Metal/MLX) — el más rápido en Mac M.
//   - faster-whisper-xxl: el ejecutable standalone de Purfview. Es la mejor
//     opción en Windows y por lejos la más fácil de instalar: no necesita
//     Python ni que el editor pelee con cuBLAS/cuDNN (trae las librerías
//     adentro), detecta CUDA solo y baja el modelo solo. Se descomprime y anda.
//   - whisper-ctranslate2: el mismo motor (faster-whisper) pero por pip — ~4×
//     en CPU, multiplataforma; flags compatibles con openai-whisper.
//   - whisper: openai, CPU puro — último recurso (lo que la mayoría ya tiene).
// `fast:true` marca los backends acelerados (para el indicador del panel).
// Se puede forzar uno con HYPERPREMIERE_WHISPER_BIN=<nombre>.
const TOOLS = [
  { bin: 'mlx_whisper', style: 'mlx', fast: true },
  { bin: 'faster-whisper-xxl', style: 'fwxxl', fast: true },
  { bin: 'whisper-ctranslate2', style: 'ct2', fast: true },
  { bin: 'whisper', style: 'openai', fast: false },
];

// De dónde se baja el standalone que recomendamos fuera de Mac.
const FWXXL_URL = 'https://github.com/Purfview/whisper-standalone-win/releases';

// mlx_whisper no entiende alias tipo "large-v3": mapear a su repo de HF.
const MLX_MODELS = {
  'large-v3': 'mlx-community/whisper-large-v3-mlx',
  'large-v3-turbo': 'mlx-community/whisper-large-v3-turbo',
  'medium': 'mlx-community/whisper-medium-mlx',
  'small': 'mlx-community/whisper-small-mlx',
};

// Resuelve la RUTA ABSOLUTA de un comando, o null. Clave: las apps de GUI (como
// Premiere/CEP) corren con un PATH mínimo que NO incluye los bin de Python del
// usuario (pyenv, conda, ~/Library/Python/*/bin), así que un `which` con el PATH
// del proceso no encuentra mlx_whisper aunque esté instalado. Por eso:
//   1) probamos el PATH del proceso (rápido, cubre lo instalado en dirs comunes);
//   2) si falla, preguntamos al SHELL DE LOGIN del usuario (`zsh -lic 'command
//      -v <bin>'`), que sí carga su PATH real (pyenv/conda/.zshrc).
// Devolvemos la ruta absoluta y luego ejecutamos ESA ruta (así no importa que el
// PATH de nuestro proceso no tenga el directorio).
async function which(bin) {
  if (IS_WIN) {
    const r = await run('where', [bin], { timeoutMs: 10_000, shell: true });
    return r.code === 0 && r.out.trim() ? r.out.trim().split(/\r?\n/)[0].trim() : null;
  }
  var r = await run('which', [bin], { timeoutMs: 8_000 });
  if (r.code === 0 && r.out.trim()) return r.out.trim().split('\n')[0].trim();
  // Shell de login: toma el PATH real del usuario (pyenv, conda, ~/.zshrc…).
  const shell = process.env.SHELL || '/bin/zsh';
  r = await run(shell, ['-lic', 'command -v ' + bin + ' 2>/dev/null'], { timeoutMs: 15_000 });
  if (r.code === 0) {
    const line = (r.out.trim().split('\n').pop() || '').trim();
    if (line && line.charAt(0) === '/' ) return line; // ruta absoluta válida
  }
  return null;
}

// El que instaló el panel en su propia carpeta, si sigue estando. Va PRIMERO
// (antes que el PATH) porque es el único del que sabemos la ruta exacta: el
// PATH del proceso de Premiere no es el del editor. `managed` lo marca para
// poder decirlo en el panel ("instalado por HyperPremiere").
function managedWhisper() {
  const rec = readInstalled();
  if (!rec) return null;
  const known = TOOLS.filter((t) => t.bin === rec.bin)[0];
  return Object.assign({ style: 'openai', fast: false }, known || {}, {
    bin: rec.bin, path: rec.path, managed: true,
  });
}

// Detecta qué Whisper hay instalado (el más rápido disponible), respetando el
// override HYPERPREMIERE_WHISPER_BIN. Devuelve { bin, style, fast, path } o
// null. `path` = ruta absoluta a ejecutar (puede diferir de `bin`).
async function detectWhisper() {
  const forced = (process.env.HYPERPREMIERE_WHISPER_BIN || '').trim();
  if (forced) {
    const known = TOOLS.filter((t) => t.bin === forced)[0];
    const mine = managedWhisper();
    if (mine && mine.bin === forced) return mine;
    const p = await which(forced);
    if (p) return Object.assign({ style: 'openai', fast: false }, known || {}, { bin: forced, path: p });
    return null;
  }
  const mine = managedWhisper();
  if (mine) return mine;
  for (const t of TOOLS) {
    const p = await which(t.bin);
    if (p) return Object.assign({}, t, { path: p });
  }
  return null;
}

// ¿Hay un backend RÁPIDO instalado (aunque no sea el elegido)? Para recomendar.
async function hasFastBackend() {
  for (const t of TOOLS) {
    if (t.fast && (await which(t.bin))) return t.bin;
  }
  return null;
}

// Duración del medio en segundos vía ffprobe (para % de progreso). 0 = no se pudo.
async function mediaDurationSec(mediaPath) {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mediaPath], { timeoutMs: 30_000 });
  const d = parseFloat(r.out);
  return (r.code === 0 && isFinite(d) && d > 0) ? d : 0;
}

// ¿El medio tiene alguna pista de audio? true/false, o null si no se pudo saber
// (sin ffprobe). Un clip de video sin audio o un gráfico dan false: whisper
// correría media hora para devolver cero segmentos.
async function hasAudioStream(mediaPath) {
  const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', mediaPath], { timeoutMs: 30_000 });
  if (r.code !== 0) return null;
  return r.out.trim().length > 0;
}

// Volumen del audio en dB vía el filtro volumedetect de ffmpeg (escribe las
// estadísticas en stderr). Devuelve { mean, max } o null si no se pudo medir.
// El silencio digital puro da -91 dB; una clase hablada anda por -30/-15 dB.
async function audioLevelDb(wavPath) {
  const r = await run('ffmpeg', ['-i', wavPath, '-af', 'volumedetect', '-f', 'null', '-'], { timeoutMs: 300_000, idleTimeoutMs: 120_000 });
  const all = String(r.err || '') + String(r.out || '');
  const mean = all.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
  const max = all.match(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/);
  if (!mean && !max) return null;
  return {
    mean: mean ? parseFloat(mean[1]) : null,
    max: max ? parseFloat(max[1]) : null,
  };
}

// Por debajo de esto no hay nada que transcribir (silencio o ruido inaudible).
const SILENT_MAX_DB = -50;

// La secuencia suele terminar DESPUÉS de la narración (los overlays del plugin,
// un cierre, un fundido), así que el .wav trae una cola muda. Whisper no se
// queda callado ahí: alucina, y encima alimentado por su salida anterior entra
// en bucle repitiendo la última frase durante minutos. Cortar esa cola antes de
// transcribir evita el problema en el origen y ahorra el tiempo de procesarla.
// Solo se recorta el FINAL: los tiempos del resto no se mueven.
const TAIL_MIN_SEC = 20;   // colas más cortas no valen la pena
const TAIL_MARGIN_SEC = 1; // margen para no comerse la última palabra

/**
 * Segundo en que arranca el silencio FINAL del wav, o null si no hay cola muda.
 * Usa el silencedetect de ffmpeg y se queda con el último tramo de silencio que
 * no vuelve a cerrarse (es decir, el que llega hasta el final del archivo).
 */
async function trailingSilenceStart(wavPath, durationSec) {
  const r = await run('ffmpeg', ['-i', wavPath, '-af',
    'silencedetect=noise=' + SILENT_MAX_DB + 'dB:d=' + TAIL_MIN_SEC, '-f', 'null', '-'],
    { timeoutMs: 600_000, idleTimeoutMs: 120_000 });
  const all = String(r.err || '') + String(r.out || '');
  // ffmpeg cierra el último silencio con un silence_end en el fin del archivo,
  // así que "silencio sin cerrar" no sirve para reconocer la cola: hay que ver
  // si el ÚLTIMO tramo de silencio llega hasta el final del audio.
  const re = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g;
  let lastStart = null;
  let lastEnd = null;
  let m;
  while ((m = re.exec(all)) !== null) {
    const v = parseFloat(m[2]);
    if (m[1] === 'start') { lastStart = v; lastEnd = null; } else { lastEnd = v; }
  }
  if (lastStart === null || !isFinite(lastStart) || lastStart <= 0) return null;
  // Si cerró antes del final, ese silencio es del medio (una pausa larga), no la
  // cola: recortar ahí se comería narración posterior.
  if (lastEnd !== null && durationSec > 0 && lastEnd < (durationSec - 1)) return null;
  if (durationSec > 0 && (durationSec - lastStart) < TAIL_MIN_SEC) return null;
  return lastStart;
}

// "[mm:ss.mmm --> …]" o "[hh:mm:ss.mmm --> …]" de la salida en vivo de
// Whisper → segundos del último timestamp visto (para la barra de progreso).
function lastTimestampSec(chunk) {
  let last = null;
  const re = /\[(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*-->/g;
  let m;
  while ((m = re.exec(chunk)) !== null) {
    last = (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
  }
  return last;
}

// RED DE SEGURIDAD: reconstruye los segmentos desde la salida VERBOSE de
// Whisper ("[00:00.000 --> 00:07.320]  texto…"). Todas las variantes del CLI
// (openai, mlx, whisper.cpp) imprimen este formato aunque difieran en cómo
// escriben archivos — si el JSON de salida no aparece, esto salva la corrida.
function segmentsFromVerbose(output) {
  const out = [];
  const re = /\[(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*-->\s*(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\]\s*(.+)/g;
  let m;
  while ((m = re.exec(String(output || ''))) !== null) {
    const start = (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
    const end = (m[4] ? parseInt(m[4], 10) * 3600 : 0) + parseInt(m[5], 10) * 60 + parseFloat(m[6]);
    const text = m[7].trim();
    if (text) out.push({ start, end, text });
  }
  return out;
}

// "Detected language: Spanish" de la salida de Whisper (best-effort).
function languageFromVerbose(output) {
  const m = String(output || '').match(/Detected language:\s*([A-Za-zÁ-úñ]+)/i);
  return m ? m[1] : '';
}

// Args del CLI según la herramienta. SIN --language: detección automática.
// Args del CLI por variante. El proceso se corre con cwd = outDir, así que la
// salida cae ahí aunque no pasemos flag de directorio (más portable entre
// variantes). mlx_whisper usa flags con guion (--output-dir/--output-format) y
// NO tiene --verbose; openai/ct2 usan guion bajo y sí soportan --verbose.
// Cuando Whisper se queda sin voz que transcribir (silencio, música, el final
// de la clase) puede entrar en BUCLE: repite la última frase decenas de veces en
// tramos exactos de 2 s. Pasa porque por defecto se alimenta de su propia salida
// anterior como prompt, y una vez que arranca a repetir se retroalimenta.
// Apagar ese "condition on previous text" corta el espiral de raíz.
// Los flags cambian de estilo por variante: mlx usa guion, openai/ct2 guion bajo.
function antiLoopArgs(tool) {
  return tool.style === 'mlx'
    ? ['--condition-on-previous-text', 'False']
    : ['--condition_on_previous_text', 'False'];
}

function whisperArgs(tool, inputPath, outDir, opts) {
  const extra = (opts && opts.noAntiLoop) ? [] : antiLoopArgs(tool);
  if (tool.style === 'mlx') {
    const model = MLX_MODELS[WHISPER_MODEL] || WHISPER_MODEL;
    return [inputPath, '--model', model, '--output-dir', outDir, '--output-format', 'json'].concat(extra);
  }
  if (tool.style === 'fwxxl') {
    // Ejecutable standalone de Purfview. Mismo motor y mismos flags que ct2,
    // más dos que solo tiene él y que acá son obligatorios:
    //   --print_progress: por defecto manda el avance a la BARRA DE TÍTULO de
    //     la consola, no a stdout. Sin esto nuestro watchdog no ve salida y a
    //     los 15 minutos mata una transcripción que iba perfecta.
    //   --beep_off: al terminar hace sonar un beep. Adentro de Premiere, no.
    return [inputPath, '--model', WHISPER_MODEL, '--output_dir', outDir, '--output_format', 'json',
      '--compute_type', 'int8', '--verbose', 'True', '--print_progress', '--beep_off'].concat(extra);
  }
  if (tool.style === 'ct2') {
    // whisper-ctranslate2 (faster-whisper): flags estilo openai + int8 en CPU
    // (rápido y buena calidad). Detecta idioma solo si no se pasa --language.
    return [inputPath, '--model', WHISPER_MODEL, '--output_dir', outDir, '--output_format', 'json',
      '--compute_type', 'int8', '--verbose', 'True'].concat(extra);
  }
  // openai-whisper (flags con guion bajo).
  return [inputPath, '--model', WHISPER_MODEL, '--output_dir', outDir, '--output_format', 'json',
    '--verbose', 'True'].concat(extra);
}

// ¿Falló porque el CLI instalado no conoce los flags anti-bucle? En ese caso
// conviene reintentar sin ellos antes que perder la transcripción entera.
function isUnknownFlagError(out) {
  return /unrecognized arguments|no such option|unknown option|invalid choice/i.test(String(out || ''));
}

// La limpieza de bucles vive en el módulo de transcripts porque la necesitan los
// dos lados: acá al transcribir y el panel al importar un JSON. Ese archivo se
// autodetecta navegador/Node, así que desde Node se puede requerir.
// OJO con la ruta: en el repo es cep/js/transcript.js, pero en el ZXP instalado
// el contenido de cep/ queda en la RAÍZ, al lado de bridge/ (o sea ../js/...).
// Hay que probar las dos o el motor no carga en la extensión empaquetada.
function loadTranscriptLib() {
  const candidates = ['../cep/js/transcript.js', '../js/transcript.js'];
  for (const rel of candidates) {
    try {
      return require(rel).HPTranscript;
    } catch (e) {
      // Solo seguimos si es "no está ahí"; un error real del módulo debe salir.
      if (!e || e.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }
  return null;
}

const transcriptLib = loadTranscriptLib();
// Si el layout cambiara y no se encontrara, es preferible transcribir sin la red
// de limpieza que dejar el motor entero sin cargar.
const stripRepetitionLoops = (transcriptLib && transcriptLib.stripRepetitionLoops)
  || function (segments) {
    return { segments: Array.isArray(segments) ? segments : [], removed: 0, loops: [] };
  };

/**
 * Transcribe el medio con el Whisper local y devuelve
 * { ok, segments, language, tool, savedPath } o { ok:false, error }.
 * body = { mediaPath, projectPath, sequenceName }
 */
async function transcribeMedia(body, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  body = body || {};
  const mediaPath = String(body.mediaPath || '');
  if (!mediaPath || !fs.existsSync(mediaPath)) {
    return { ok: false, error: 'No encuentro el medio del clip: ' + (mediaPath || '(vacío)') };
  }
  // Nombrar la fuente en los errores es la diferencia entre "no funcionó" y
  // "está mudo lo que le diste". `alreadyPrepared` = el .wav que Premiere
  // exportó de la secuencia entera (la fuente normal); si no, un medio suelto.
  const clipName = String(body.clipName || '');
  const clipLabel = clipName ? ' “' + clipName + '”' : '';
  const isSeqAudio = Boolean(body.alreadyPrepared);
  const sourceLabel = isSeqAudio ? ('la secuencia' + clipLabel) : ('el clip' + clipLabel);
  const whatToDo = isSeqAudio
    ? '\nQué hacer: revisá que las pistas de audio de la secuencia no estén silenciadas (M) ni en volumen 0,' +
      ' y que la narración esté dentro de la secuencia. O cargá el transcript con "Cargar JSON".'
    : '\nQué hacer: asegurate de que ese medio tenga la narración, o cargá el transcript con "Cargar JSON".';

  const tool = await detectWhisper();
  if (!tool) {
    return {
      ok: false,
      error: 'No tenés Whisper instalado. Usá el botón “Instalar Whisper” del panel (lo baja e instala solo),' +
        ' o cargá el transcript con “Cargar JSON”.\nA mano: ' + (process.platform === 'darwin'
          ? '`pip install mlx-whisper` (Apple Silicon) o `pip install whisper-ctranslate2`.'
          : 'bajá Faster-Whisper-XXL de ' + FWXXL_URL + ' y descomprimilo (es un ejecutable suelto,' +
            ' no hace falta Python). Alternativa: `pip install whisper-ctranslate2`.'),
    };
  }

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-whisper-'));
  cancelled = false;
  let heartbeat = null;
  try {
    // 1) Audio mono 16 kHz. Si el medio YA viene así (el .wav que exportó
    //    Premiere de la secuencia), se usa tal cual: ffmpeg no aporta nada y
    //    re-codificar una clase larga es puro tiempo perdido.
    let input = path.join(tmpBase, 'audio.wav');
    let extracted = true;
    let ff = { code: 0 };
    if (body.alreadyPrepared) {
      input = mediaPath;
      report({ pct: 5, msg: 'Audio de la secuencia listo (mono 16 kHz) — no hace falta convertirlo.' });
    } else {
      report({ pct: 5, msg: 'Extrayendo el audio de la secuencia (ffmpeg)…' });
      ff = await run('ffmpeg', ['-y', '-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', input], {
        timeoutMs: 900_000, idleTimeoutMs: 120_000,
        onSpawn: (child) => { currentChild = child; },
      });
      currentChild = null;
    }
    if (cancelled) return { ok: false, cancelled: true, error: 'Transcripción cancelada.' };
    if (ff.code !== 0) {
      // Sin ffmpeg (o falló): Whisper puede leer el medio directo con su propio ffmpeg.
      extracted = false;
      input = mediaPath;
      report({ pct: 8, msg: 'ffmpeg no pudo extraer el audio — le paso el medio directo a whisper…' });
      // Distinguir "no hay ffmpeg" de "este clip no tiene audio": si el medio no
      // tiene pista de audio, whisper va a correr para nada. Cortamos acá con el
      // motivo real en vez de fallar 20 minutos después sin segmentos.
      if (await hasAudioStream(mediaPath) === false) {
        return {
          ok: false,
          error: 'Lo que se va a transcribir (' + sourceLabel + ') NO TIENE PISTA DE AUDIO' +
            ' (es video mudo, un gráfico o una imagen), así que no hay nada que transcribir.' +
            '\nMedio: ' + mediaPath + whatToDo,
        };
      }
    }

    // Nivel del audio extraído: si está en silencio, whisper devolvería cero
    // segmentos tras correr un buen rato. Es barato medirlo y ahorra la espera.
    let level = null;
    if (extracted) {
      report({ pct: 9, msg: 'Revisando que el audio tenga sonido…' });
      level = await audioLevelDb(input);
      if (cancelled) return { ok: false, cancelled: true, error: 'Transcripción cancelada.' };
      if (level && level.max !== null && level.max <= SILENT_MAX_DB) {
        return {
          ok: false,
          error: 'El audio de ' + sourceLabel + ' está EN SILENCIO' +
            ' (pico ' + level.max + ' dB, medio ' + (level.mean === null ? '?' : level.mean) + ' dB):' +
            ' no hay voz que transcribir.' +
            '\nMedio: ' + mediaPath + whatToDo,
        };
      }
    }

    let durationSec = await mediaDurationSec(input);

    // 1b) Cortar la cola muda del final (si hay). Solo el final, así que los
    //     tiempos del transcript siguen alineados al timeline.
    if (extracted && durationSec > TAIL_MIN_SEC) {
      const tailAt = await trailingSilenceStart(input, durationSec);
      if (cancelled) return { ok: false, cancelled: true, error: 'Transcripción cancelada.' };
      if (tailAt !== null) {
        const cutAt = Math.min(durationSec, tailAt + TAIL_MARGIN_SEC);
        const trimmed = path.join(tmpBase, 'trimmed.wav');
        const cut = await run('ffmpeg', ['-y', '-i', input, '-t', String(cutAt), '-c', 'copy', trimmed],
          { timeoutMs: 600_000, idleTimeoutMs: 120_000, onSpawn: (child) => { currentChild = child; } });
        currentChild = null;
        if (cut.code === 0 && fs.existsSync(trimmed) && fs.statSync(trimmed).size > 0) {
          const saved = Math.round(durationSec - cutAt);
          report({
            pct: 9,
            msg: 'La secuencia termina con ' + saved + 's sin narración: los recorto para que Whisper no alucine ahí.',
          });
          input = trimmed;
          durationSec = cutAt;
        }
      }
    }

    // 2) Whisper local, idioma automático. Sin tope TOTAL (una clase larga en
    //    CPU tarda lo que tarda) pero con watchdog de INACTIVIDAD: si queda
    //    mudo demasiado tiempo, está colgado y se mata con diagnóstico.
    report({ pct: 10, msg: 'Arrancando ' + tool.bin + ' (' + WHISPER_MODEL + ', idioma automático)… la primera vez puede bajar el modelo (~3 GB).' });
    let lastOutputAt = Date.now();
    let sawOutput = false;
    // Latido: si whisper está callado (cargando/bajando el modelo), avisar con
    // regularidad que sigue vivo — antes esto se veía como "se quedó ahí".
    // El intervalo se deriva del watchdog para que siempre alcance a latir.
    const heartbeatMs = Math.max(300, Math.min(10_000, Math.floor(WHISPER_IDLE_MS / 4)));
    heartbeat = setInterval(() => {
      const idleMs = Date.now() - lastOutputAt;
      if (idleMs >= heartbeatMs) {
        report({
          msg: tool.bin + ' sin salida hace ' + Math.round(idleMs / 1000) + 's — ' +
            (sawOutput ? 'sigue procesando…' : 'cargando o bajando el modelo ' + WHISPER_MODEL + '…') +
            ' (se corta solo tras ' + Math.round(WHISPER_IDLE_MS / 60000) + ' min mudo)',
        });
      }
    }, heartbeatMs);
    // Ejecutamos por RUTA ABSOLUTA (tool.path) para que no importe que el PATH
    // de nuestro proceso no tenga el dir de Python del usuario. cwd = outDir:
    // la salida cae ahí sin depender de flags de directorio.
    const runOpts = {
      timeoutMs: 0,
      idleTimeoutMs: WHISPER_IDLE_MS,
      cwd: tmpBase,
      shell: IS_WIN,
      onSpawn: (child) => { currentChild = child; },
      onData: (s) => {
        lastOutputAt = Date.now();
        sawOutput = true;
        const ts = lastTimestampSec(s);
        if (ts !== null && durationSec > 0) {
          const pct = 10 + Math.min(88, Math.round((ts / durationSec) * 88));
          report({ pct, msg: 'Transcribiendo… ' + Math.round(ts) + 's / ' + Math.round(durationSec) + 's' });
        }
      },
    };
    let argOpts = {};
    let r = await run(tool.path || tool.bin, whisperArgs(tool, input, tmpBase, argOpts), runOpts);
    // Si esta variante del CLI no conoce el flag anti-bucle, mejor reintentar sin
    // él que tirar a la basura la transcripción de una clase entera.
    if (!cancelled && r.code !== 0 && isUnknownFlagError(r.err + '\n' + r.out)) {
      report({ pct: 10, msg: 'Tu variante de ' + tool.bin + ' no acepta el flag anti-repetición — reintento sin él…' });
      argOpts = { noAntiLoop: true };
      lastOutputAt = Date.now();
      r = await run(tool.path || tool.bin, whisperArgs(tool, input, tmpBase, argOpts), runOpts);
    }
    currentChild = null;
    clearInterval(heartbeat); heartbeat = null;
    const cmdLine = (tool.path || tool.bin) + ' ' + whisperArgs(tool, input, tmpBase, argOpts).join(' ');
    if (cancelled) return { ok: false, cancelled: true, error: 'Transcripción cancelada.' };
    if (r.idle) {
      return {
        ok: false,
        error: tool.bin + ' quedó COLGADO (' + Math.round(WHISPER_IDLE_MS / 60000) + ' min sin ninguna salida) y lo maté.' +
          '\nComando: ' + cmdLine +
          '\nSalida hasta ahí: ' + ((r.out + '\n' + r.err).trim().slice(-500) || '(nada — ni siquiera arrancó a imprimir)') +
          '\nPistas: corré ese comando a mano en una terminal para ver qué pasa; si es la primera vez, la descarga del modelo necesita conexión.',
      };
    }
    if (r.code !== 0) {
      return { ok: false, error: tool.bin + ' terminó con código ' + r.code + '.\nComando: ' + cmdLine + '\nSalida: ' + (r.err || r.out).slice(-500) };
    }

    // 3) Leer el JSON que escribió Whisper (un .json en el dir de salida). Si la
    //    variante instalada no escribió el archivo (pasa con algunos CLIs),
    //    reconstruimos los segmentos desde su salida verbose — misma info.
    let segments = [];
    let language = '';
    const jsonName = fs.readdirSync(tmpBase).find((n) => n.toLowerCase().endsWith('.json'));
    if (jsonName) {
      const data = JSON.parse(fs.readFileSync(path.join(tmpBase, jsonName), 'utf8'));
      segments = (Array.isArray(data.segments) ? data.segments : [])
        .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() }))
        .filter((s) => s.text);
      language = data.language || '';
    }
    if (!segments.length) {
      segments = segmentsFromVerbose(r.out + '\n' + r.err);
      language = language || languageFromVerbose(r.out + '\n' + r.err);
    }
    if (!segments.length) {
      // Llegar acá con el JSON escrito significa que whisper corrió bien y
      // NO ENCONTRÓ VOZ; sin JSON, que la variante del CLI no escribió nada.
      // Son problemas distintos y antes se reportaban con el mismo texto.
      const detectedLang = languageFromVerbose(r.out + '\n' + r.err);
      const levelTxt = level
        ? ' (audio: pico ' + level.max + ' dB, medio ' + level.mean + ' dB)'
        : '';
      const cause = jsonName
        ? tool.bin + ' corrió bien pero NO ENCONTRÓ VOZ en el audio del clip' + clipLabel + levelTxt +
          '.\nSi el clip tiene música o ruido pero nadie habla, es esperable.' +
          (detectedLang ? ' Idioma detectado: ' + detectedLang + '.' : '')
        : tool.bin + ' terminó sin escribir el JSON ni imprimir segmentos: probablemente la variante' +
          ' instalada del CLI no soporta estos flags.';
      return {
        ok: false,
        error: cause +
          '\nMedio: ' + mediaPath +
          '\nComando: ' + cmdLine +
          '\nArchivos en la salida: ' + fs.readdirSync(tmpBase).join(', ') +
          '\nSalida: ' + (r.out + '\n' + r.err).slice(-500),
      };
    }

    // 4) Sacar los bucles de repetición ANTES de guardar y de devolver, así el
    //    respaldo también queda limpio y ningún prompt se come la frase repetida.
    const cleaned = stripRepetitionLoops(segments);
    if (cleaned.removed > 0) {
      const worst = cleaned.loops.slice().sort((a, b) => b.count - a.count)[0];
      report({
        pct: 96,
        msg: 'Limpié ' + cleaned.removed + ' repeticiones alucinadas por Whisper' +
          (worst ? ' (la peor: ' + worst.count + '× desde ' + Math.round(worst.start) + 's)' : '') + '.',
      });
      segments = cleaned.segments;
    }

    // 5) Guardado en la carpeta de la secuencia. No es un "respaldo": es LA copia
    //    persistente que el panel vuelve a cargar al reabrir Premiere, con el
    //    nombre canónico (transcript.json) que también usa el import de JSON.
    //    Los tiempos son de la secuencia, así que el desfase queda en 0.
    let savedPath = '';
    try {
      const baseDir = ensureOutputDir(body.projectPath, body.sequenceName);
      savedPath = path.join(baseDir, 'transcript.json');
      fs.writeFileSync(savedPath, JSON.stringify({
        sequenceName: String(body.sequenceName || ''),
        language, model: WHISPER_MODEL, tool: tool.bin,
        // Apuntar al .wav temporal (ya borrado) no sirve de nada: dejamos la
        // fuente real, que es la secuencia.
        source: isSeqAudio ? ('audio de la secuencia' + clipLabel) : mediaPath,
        // Viene del audio de la secuencia, así que ya está alineado al timeline.
        offset: 0,
        savedAt: new Date().toISOString(),
        loopsRemoved: cleaned.removed, loops: cleaned.loops,
        segments,
      }, null, 2), 'utf8');
    } catch (e) {}

    report({ pct: 100, msg: '✓ Transcripción lista (' + segments.length + ' segmentos).' });
    return {
      ok: true, segments, language, tool: tool.bin, savedPath,
      loopsRemoved: cleaned.removed, loops: cleaned.loops,
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    currentChild = null;
    if (heartbeat) clearInterval(heartbeat);
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (e) {}
    // El .wav de la secuencia se borra SIEMPRE (también si falló o se canceló):
    // una clase entera en WAV son cientos de MB y no queremos dejarlos ahí.
    if (body.deleteAfter && mediaPath) {
      try { fs.rmSync(path.dirname(mediaPath), { recursive: true, force: true }); } catch (e) {}
    }
  }
}

/**
 * Estado del Whisper local para el indicador del panel.
 * Devuelve { ok, available, tool, model, fast, recommend }:
 *   fast      → el backend elegido es acelerado (mlx / ctranslate2).
 *   recommend → sugerencia de instalar uno rápido cuando el elegido es lento
 *               (openai `whisper` en CPU), acorde a la plataforma.
 */
async function whisperStatus() {
  const tool = await detectWhisper();
  const out = {
    ok: true, available: !!tool, tool: tool ? tool.bin : '', path: tool ? (tool.path || '') : '',
    model: WHISPER_MODEL, fast: !!(tool && tool.fast),
    // Lo instaló el propio panel en su carpeta (no depende del PATH del equipo).
    managed: !!(tool && tool.managed),
    recommend: '',
  };
  if (tool && !tool.fast) {
    out.recommend = (process.platform === 'darwin')
      ? 'Tenés el whisper de openai (CPU, lento). En Apple Silicon, `pip install mlx-whisper` es varias veces más rápido con la misma calidad.'
      : 'Tenés el whisper de openai (CPU, lento). Bajá Faster-Whisper-XXL (' + FWXXL_URL + '): es un ejecutable, no necesita Python, usa la GPU si hay NVIDIA y va varias veces más rápido con la misma calidad.';
  } else if (!tool) {
    // Este texto es el camino A MANO: el panel lo muestra cuando la instalación
    // automática no aplica (o falla). Con el botón disponible, gana el botón.
    out.recommend = (process.platform === 'darwin')
      ? 'A mano: `pip install mlx-whisper` (rápido en Apple Silicon) o `pip install whisper-ctranslate2`.'
      : 'A mano: bajá Faster-Whisper-XXL (' + FWXXL_URL + ') y descomprimilo — es un ejecutable suelto, sin Python. Alternativa por pip: `pip install whisper-ctranslate2`.';
  }
  return out;
}

module.exports = {
  transcribeMedia, detectWhisper, cancelTranscription, whisperStatus,
  stripRepetitionLoops, trailingSilenceStart,
  // El instalador necesita el catálogo (estilo/flags de cada herramienta) y el
  // modelo elegido para la prueba final. Son el mismo contrato: si acá se
  // agrega una herramienta, el instalador la puede dejar lista sin copiar nada.
  TOOLS, FWXXL_URL,
  // Expuestos para el test de Windows (qué modelo y qué flags según plataforma).
  _whisperArgs: whisperArgs,
  _model: () => WHISPER_MODEL,
};
