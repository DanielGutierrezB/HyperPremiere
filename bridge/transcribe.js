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

const IS_WIN = process.platform === 'win32';

// Modelo por defecto; se puede cambiar por máquina sin tocar código.
const WHISPER_MODEL = process.env.HYPERPREMIERE_WHISPER_MODEL || 'large-v3';
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
// minutos por clase); los otros dos son mucho más rápidos con la misma calidad:
//   - mlx_whisper: GPU de Apple Silicon (Metal/MLX) — el más rápido en Mac M.
//   - whisper-ctranslate2: faster-whisper (CTranslate2, int8) — ~4× en CPU,
//     multiplataforma; flags compatibles con openai-whisper.
//   - whisper: openai, CPU puro — último recurso (lo que la mayoría ya tiene).
// `fast:true` marca los backends acelerados (para el indicador del panel).
// Se puede forzar uno con HYPERPREMIERE_WHISPER_BIN=<nombre>.
const TOOLS = [
  { bin: 'mlx_whisper', style: 'mlx', fast: true },
  { bin: 'whisper-ctranslate2', style: 'ct2', fast: true },
  { bin: 'whisper', style: 'openai', fast: false },
];

// mlx_whisper no entiende alias tipo "large-v3": mapear a su repo de HF.
const MLX_MODELS = {
  'large-v3': 'mlx-community/whisper-large-v3-mlx',
  'large-v3-turbo': 'mlx-community/whisper-large-v3-turbo',
  'medium': 'mlx-community/whisper-medium-mlx',
  'small': 'mlx-community/whisper-small-mlx',
};

async function which(bin) {
  const r = await run(IS_WIN ? 'where' : 'which', [bin], { timeoutMs: 10_000, shell: IS_WIN });
  return r.code === 0 && r.out.trim() ? r.out.trim().split('\n')[0] : null;
}

// Detecta qué Whisper hay instalado (el más rápido disponible), respetando el
// override HYPERPREMIERE_WHISPER_BIN. Devuelve { bin, style, fast } o null.
async function detectWhisper() {
  const forced = (process.env.HYPERPREMIERE_WHISPER_BIN || '').trim();
  if (forced) {
    const known = TOOLS.filter((t) => t.bin === forced)[0];
    if (await which(forced)) return known || { bin: forced, style: 'openai', fast: false };
    return null;
  }
  for (const t of TOOLS) {
    if (await which(t.bin)) return t;
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
function whisperArgs(tool, inputPath, outDir) {
  if (tool.style === 'mlx') {
    const model = MLX_MODELS[WHISPER_MODEL] || WHISPER_MODEL;
    return [inputPath, '--model', model, '--output-dir', outDir, '--output-format', 'json', '--verbose', 'True'];
  }
  if (tool.style === 'ct2') {
    // whisper-ctranslate2 (faster-whisper): flags estilo openai + int8 en CPU
    // (rápido y buena calidad). Detecta idioma solo si no se pasa --language.
    return [inputPath, '--model', WHISPER_MODEL, '--output_dir', outDir, '--output_format', 'json',
      '--compute_type', 'int8', '--verbose', 'True'];
  }
  // openai-whisper (flags con guion bajo).
  return [inputPath, '--model', WHISPER_MODEL, '--output_dir', outDir, '--output_format', 'json', '--verbose', 'True'];
}

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

  const tool = await detectWhisper();
  if (!tool) {
    return {
      ok: false,
      error: 'No encontré Whisper en el PATH. Instalá el CLI clásico (pip install openai-whisper) ' +
        'o mlx-whisper en Apple Silicon (pip install mlx-whisper) y reintentá.',
    };
  }

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-whisper-'));
  cancelled = false;
  let heartbeat = null;
  try {
    // 1) Audio mono 16 kHz (más rápido y estable que darle el video entero).
    report({ pct: 5, msg: 'Extrayendo el audio de la secuencia (ffmpeg)…' });
    let input = path.join(tmpBase, 'audio.wav');
    const ff = await run('ffmpeg', ['-y', '-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', input], {
      timeoutMs: 900_000, idleTimeoutMs: 120_000,
      onSpawn: (child) => { currentChild = child; },
    });
    currentChild = null;
    if (cancelled) return { ok: false, cancelled: true, error: 'Transcripción cancelada.' };
    if (ff.code !== 0) {
      // Sin ffmpeg (o falló): Whisper puede leer el medio directo con su propio ffmpeg.
      input = mediaPath;
      report({ pct: 8, msg: 'ffmpeg no pudo extraer el audio — le paso el medio directo a whisper…' });
    }

    const durationSec = await mediaDurationSec(input);

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
    const r = await run(tool.bin, whisperArgs(tool, input, tmpBase), {
      timeoutMs: 0,
      idleTimeoutMs: WHISPER_IDLE_MS,
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
    });
    currentChild = null;
    clearInterval(heartbeat); heartbeat = null;
    const cmdLine = tool.bin + ' ' + whisperArgs(tool, input, tmpBase).join(' ');
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
      return {
        ok: false,
        error: tool.bin + ' terminó pero no escribió el JSON ni imprimió segmentos (¿el clip tiene audio? ¿es la variante correcta del CLI?).' +
          '\nComando: ' + cmdLine +
          '\nArchivos en la salida: ' + fs.readdirSync(tmpBase).join(', ') +
          '\nSalida: ' + (r.out + '\n' + r.err).slice(-500),
      };
    }

    // 4) Respaldo en la carpeta de la secuencia (mismo formato que se importa).
    let savedPath = '';
    try {
      const baseDir = ensureOutputDir(body.projectPath, body.sequenceName);
      savedPath = path.join(baseDir, 'transcript-whisper.json');
      fs.writeFileSync(savedPath, JSON.stringify({
        language, model: WHISPER_MODEL, tool: tool.bin,
        mediaPath: mediaPath, createdAt: new Date().toISOString(), segments,
      }, null, 2), 'utf8');
    } catch (e) {}

    report({ pct: 100, msg: '✓ Transcripción lista (' + segments.length + ' segmentos).' });
    return { ok: true, segments, language, tool: tool.bin, savedPath };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    currentChild = null;
    if (heartbeat) clearInterval(heartbeat);
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (e) {}
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
  const out = { ok: true, available: !!tool, tool: tool ? tool.bin : '', model: WHISPER_MODEL, fast: !!(tool && tool.fast), recommend: '' };
  if (tool && !tool.fast) {
    out.recommend = (process.platform === 'darwin')
      ? 'Tenés el whisper de openai (CPU, lento). En Apple Silicon, `pip install mlx-whisper` es varias veces más rápido con la misma calidad.'
      : 'Tenés el whisper de openai (CPU, lento). `pip install whisper-ctranslate2` (faster-whisper) es ~4× más rápido con la misma calidad.';
  } else if (!tool) {
    out.recommend = (process.platform === 'darwin')
      ? 'Instalá uno local: `pip install mlx-whisper` (rápido en Apple Silicon) o `pip install openai-whisper`.'
      : 'Instalá uno local: `pip install whisper-ctranslate2` (rápido) o `pip install openai-whisper`.';
  }
  return out;
}

module.exports = { transcribeMedia, detectWhisper, cancelTranscription, whisperStatus };
