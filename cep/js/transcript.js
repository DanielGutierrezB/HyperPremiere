/**
 * transcript.js — Parser flexible de transcripts para HyperPremiere.
 *
 * Expone window.HPTranscript con:
 *   - parse(raw)                 -> { segments: [{start, end, text, speaker}], meta: {count, duration} }
 *   - timecodeToSeconds(str, fps) -> Number (segundos) o NaN
 *   - sliceByRange(segments, startSec, endSec) -> segmentos que se solapan con el rango
 *
 * Supuestos documentados:
 *   - FPS por defecto: 30 (para timecodes "hh:mm:ss:ff"). Se puede pasar otro fps.
 *   - Heurística de milisegundos: si un tiempo numérico es > 100000 se asume que
 *     viene en milisegundos y se divide por 1000. Razón: 100000 segundos son ~27.7
 *     horas, una duración improbable para un clip; 100000 ms son solo 100 s, un
 *     valor muy común. La heurística se aplica de forma consistente a todo el
 *     transcript: si CUALQUIER tiempo supera el umbral, se asume que TODOS los
 *     tiempos vienen en ms (para no mezclar unidades dentro del mismo archivo).
 *   - Entradas inválidas (null, JSON roto, formas desconocidas) devuelven
 *     { segments: [], meta: { count: 0, duration: 0 } } sin lanzar excepciones.
 */
(function (global) {
  'use strict';

  var DEFAULT_FPS = 30;
  // Umbral para la heurística segundos vs milisegundos (ver cabecera).
  var MS_THRESHOLD = 100000;

  // Claves donde puede vivir el array de segmentos dentro de un objeto contenedor.
  var CONTAINER_KEYS = ['segments', 'transcript', 'results', 'data'];
  // Campos alternativos de texto, en orden de preferencia.
  var TEXT_KEYS = ['text', 'content', 'transcript', 'value', 'sentence'];
  // Campos alternativos de speaker, en orden de preferencia.
  var SPEAKER_KEYS = ['speaker', 'speaker_label', 'spk'];

  function isFiniteNumber(n) {
    return typeof n === 'number' && isFinite(n);
  }

  /**
   * Convierte un timecode string a segundos. Devuelve NaN si no se reconoce.
   * Formatos soportados:
   *   "hh:mm:ss:ff"   -> frames interpretados con fps (por defecto 30)
   *   "hh:mm:ss.mmm"  -> milisegundos decimales
   *   "hh:mm:ss,mmm"  -> variante estilo SRT
   *   "mm:ss" / "mm:ss.mmm"
   *   "ss" / "ss.mmm" (un solo número en string)
   */
  function timecodeToSeconds(str, fps) {
    if (typeof str === 'number') return isFinite(str) ? str : NaN;
    if (typeof str !== 'string') return NaN;
    fps = isFiniteNumber(fps) && fps > 0 ? fps : DEFAULT_FPS;

    var s = str.trim();
    if (!s) return NaN;
    // Normalizar coma decimal (formato SRT "00:00:01,500") a punto.
    s = s.replace(',', '.');

    var parts = s.split(':');
    var i, n;
    for (i = 0; i < parts.length; i++) {
      if (parts[i] === '' || isNaN(Number(parts[i]))) return NaN;
    }

    if (parts.length === 4) {
      // hh:mm:ss:ff — el último campo son frames.
      var h = Number(parts[0]), m = Number(parts[1]), sec = Number(parts[2]), f = Number(parts[3]);
      return h * 3600 + m * 60 + sec + f / fps;
    }
    if (parts.length === 3) {
      // hh:mm:ss(.mmm)
      return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
    }
    if (parts.length === 2) {
      // mm:ss(.mmm)
      return Number(parts[0]) * 60 + Number(parts[1]);
    }
    if (parts.length === 1) {
      n = Number(parts[0]);
      return isFinite(n) ? n : NaN;
    }
    return NaN;
  }

  /**
   * Extrae un valor de tiempo crudo de un segmento probando claves comunes.
   * Devuelve Number (segundos, sin aplicar aún la heurística ms) o NaN.
   */
  function rawTime(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v === undefined || v === null) continue;
      if (isFiniteNumber(v)) return v;
      if (typeof v === 'string') {
        var t = timecodeToSeconds(v);
        if (!isNaN(t)) return t;
      }
    }
    return NaN;
  }

  function pickText(obj) {
    for (var i = 0; i < TEXT_KEYS.length; i++) {
      var v = obj[TEXT_KEYS[i]];
      if (typeof v === 'string' && v.length) return v;
    }
    return '';
  }

  function pickSpeaker(obj) {
    for (var i = 0; i < SPEAKER_KEYS.length; i++) {
      var v = obj[SPEAKER_KEYS[i]];
      if (typeof v === 'string' && v.length) return v;
      if (isFiniteNumber(v)) return String(v);
    }
    return '';
  }

  /**
   * Localiza el array de segmentos dentro de la entrada:
   * array directo, o { segments|transcript|results|data: [...] }.
   */
  function findSegmentArray(raw) {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') {
      for (var i = 0; i < CONTAINER_KEYS.length; i++) {
        var v = raw[CONTAINER_KEYS[i]];
        if (Array.isArray(v)) return v;
      }
      // Formato "solo words" en la raíz: { words: [...] } sin array de segmentos.
      if (Array.isArray(raw.words)) return [raw];
    }
    return null;
  }

  /**
   * Normaliza un ítem crudo a { start, end, text, speaker } con tiempos aún
   * en la unidad original (la heurística ms se aplica después, globalmente).
   * Devuelve null si el ítem no es utilizable.
   */
  function normalizeItem(item) {
    if (!item || typeof item !== 'object') return null;

    var start = rawTime(item, ['start', 'start_time', 'startTime', 'begin', 'from', 'ts']);
    var end = rawTime(item, ['end', 'end_time', 'endTime', 'stop', 'to']);
    var text = pickText(item);
    var speaker = pickSpeaker(item);

    // Formato con words: [{word, start, end}] — construir texto y tiempos
    // a partir de las palabras cuando falten a nivel de segmento.
    if (Array.isArray(item.words) && item.words.length) {
      var wordsText = [];
      var wStart = NaN, wEnd = NaN;
      for (var i = 0; i < item.words.length; i++) {
        var w = item.words[i];
        if (!w || typeof w !== 'object') continue;
        var token = typeof w.word === 'string' ? w.word : (typeof w.text === 'string' ? w.text : '');
        if (token) wordsText.push(token);
        var ws = rawTime(w, ['start', 'start_time', 'startTime']);
        var we = rawTime(w, ['end', 'end_time', 'endTime']);
        if (!isNaN(ws) && (isNaN(wStart) || ws < wStart)) wStart = ws;
        if (!isNaN(we) && (isNaN(wEnd) || we > wEnd)) wEnd = we;
      }
      if (!text && wordsText.length) text = wordsText.join(' ');
      if (isNaN(start)) start = wStart;
      if (isNaN(end)) end = wEnd;
    }

    if (!text) return null;
    if (isNaN(start)) start = 0;
    if (isNaN(end) || end < start) end = start;

    return { start: start, end: end, text: text, speaker: speaker };
  }

  /**
   * parse(raw): acepta objeto ya parseado o string JSON.
   * Siempre devuelve { segments, meta: {count, duration} }; nunca lanza.
   */
  function parse(raw) {
    var empty = { segments: [], meta: { count: 0, duration: 0 } };
    try {
      if (typeof raw === 'string') {
        try {
          raw = JSON.parse(raw);
        } catch (e) {
          return empty;
        }
      }

      var arr = findSegmentArray(raw);
      if (!arr) return empty;

      var segments = [];
      var maxTime = 0;
      var anyOverThreshold = false;
      var i, seg;

      for (i = 0; i < arr.length; i++) {
        seg = normalizeItem(arr[i]);
        if (!seg) continue;
        segments.push(seg);
        if (seg.start > MS_THRESHOLD || seg.end > MS_THRESHOLD) anyOverThreshold = true;
      }

      // Heurística ms: si algún tiempo supera el umbral, se asume que TODO el
      // transcript viene en milisegundos y se convierte de forma consistente.
      if (anyOverThreshold) {
        for (i = 0; i < segments.length; i++) {
          segments[i].start = segments[i].start / 1000;
          segments[i].end = segments[i].end / 1000;
        }
      }

      // Orden cronológico por start para que sliceByRange y la UI sean estables.
      segments.sort(function (a, b) { return a.start - b.start; });

      for (i = 0; i < segments.length; i++) {
        if (segments[i].end > maxTime) maxTime = segments[i].end;
      }

      return {
        segments: segments,
        meta: { count: segments.length, duration: maxTime }
      };
    } catch (e) {
      return empty;
    }
  }

  /**
   * sliceByRange(segments, startSec, endSec): segmentos que se SOLAPAN con
   * [startSec, endSec] — útil para mostrar el fragmento asociado a un marcador.
   * Solape: seg.start < endSec && seg.end > startSec (los que solo tocan el
   * borde exacto quedan fuera, salvo segmentos puntuales start === end dentro
   * del rango).
   */
  function sliceByRange(segments, startSec, endSec) {
    if (!Array.isArray(segments)) return [];
    if (!isFiniteNumber(startSec)) startSec = 0;
    if (!isFiniteNumber(endSec)) endSec = Infinity;
    if (endSec < startSec) { var tmp = startSec; startSec = endSec; endSec = tmp; }

    var out = [];
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (!s || !isFiniteNumber(s.start) || !isFiniteNumber(s.end)) continue;
      var overlaps = s.start < endSec && s.end > startSec;
      // Segmentos puntuales (start === end) dentro del rango también cuentan.
      var pointInside = s.start === s.end && s.start >= startSec && s.start <= endSec;
      if (overlaps || pointInside) out.push(s);
    }
    return out;
  }

  global.HPTranscript = {
    parse: parse,
    timecodeToSeconds: timecodeToSeconds,
    sliceByRange: sliceByRange
  };
})(typeof window !== 'undefined' ? window : this);
