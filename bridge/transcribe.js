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

const { run } = require('./exec');
const { ensureOutputDir } = require('./store/project-fs');

const IS_WIN = process.platform === 'win32';

// Modelo por defecto; se puede cambiar por máquina sin tocar código.
const WHISPER_MODEL = process.env.HYPERPREMIERE_WHISPER_MODEL || 'large-v3';

// Herramientas soportadas, en orden de preferencia. `whisper` primero: es el
// CLI que ya tiene el modelo descargado si "tenés whisper large-v3".
// mlx_whisper usa la GPU de Apple Silicon pero baja SU propio modelo la
// primera vez. (whisper.cpp queda fuera: exige la ruta del .bin del modelo.)
const TOOLS = [
  { bin: 'whisper', style: 'openai' },
  { bin: 'mlx_whisper', style: 'mlx' },
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

// Detecta qué Whisper hay instalado. Devuelve { bin, style } o null.
async function detectWhisper() {
  for (const t of TOOLS) {
    if (await which(t.bin)) return t;
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
  try {
    // 1) Audio mono 16 kHz (más rápido y estable que darle el video entero).
    report({ pct: 5, msg: 'Extrayendo el audio de la secuencia…' });
    let input = path.join(tmpBase, 'audio.wav');
    const ff = await run('ffmpeg', ['-y', '-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', input], { timeoutMs: 900_000 });
    if (ff.code !== 0) {
      // Sin ffmpeg (o falló): Whisper puede leer el medio directo con su propio ffmpeg.
      input = mediaPath;
    }

    const durationSec = await mediaDurationSec(input);

    // 2) Whisper local, idioma automático. Sin tope de tiempo: large-v3 en CPU
    //    puede tardar bastante con una clase larga; el progreso se ve en vivo.
    report({ pct: 10, msg: 'Transcribiendo con ' + tool.bin + ' (' + WHISPER_MODEL + ', idioma automático)…' });
    const r = await run(tool.bin, whisperArgs(tool, input, tmpBase), {
      timeoutMs: 0,
      shell: IS_WIN,
      onData: (s) => {
        const ts = lastTimestampSec(s);
        if (ts !== null && durationSec > 0) {
          const pct = 10 + Math.min(88, Math.round((ts / durationSec) * 88));
          report({ pct, msg: 'Transcribiendo… ' + Math.round(ts) + 's / ' + Math.round(durationSec) + 's' });
        }
      },
    });
    const cmdLine = tool.bin + ' ' + whisperArgs(tool, input, tmpBase).join(' ');
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
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports = { transcribeMedia, detectWhisper };
