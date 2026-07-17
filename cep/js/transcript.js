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
 *   - Heurística de unidades (consistente para TODO el archivo, no se mezclan):
 *       > 1e10   → ticks de Premiere (254016000000 por segundo; formatos
 *                  exportados de Premiere traen los tiempos así) — se divide
 *                  por TICKS_PER_SECOND.
 *       > 100000 → milisegundos (100000 s serían ~27.7 h, improbable; 100000 ms
 *                  son solo 100 s, un valor muy común) — se divide por 1000.
 *     Si CUALQUIER tiempo supera un umbral, se asume esa unidad para TODOS.
 *   - Entradas inválidas (null, JSON roto, formas desconocidas) devuelven
 *     { segments: [], meta: { count: 0, duration: 0 } } sin lanzar excepciones.
 */
(function (global) {
  'use strict';

  var DEFAULT_FPS = 30;
  // Umbrales para la heurística de unidades (ver cabecera).
  var MS_THRESHOLD = 100000;      // > esto: milisegundos
  var TICKS_THRESHOLD = 1e10;     // > esto: ticks de Premiere
  var TICKS_PER_SECOND = 254016000000;

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

  /**
   * Fin de un ítem con tiempos: end explícito, o start + duration (formatos
   * como el transcript exportado de Premiere traen duración en vez de fin —
   * sin esto, cada segmento quedaba con duración CERO y el recorte por
   * marcador perdía todo segmento que empezara antes del marcador).
   */
  function rawEnd(obj, startSec) {
    var end = rawTime(obj, ['end', 'end_time', 'endTime', 'stop', 'to']);
    if (!isNaN(end)) return end;
    var dur = rawTime(obj, ['duration', 'dur']);
    if (!isNaN(dur) && !isNaN(startSec)) return startSec + dur;
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
    var end = rawEnd(item, start);
    var text = pickText(item);
    var speaker = pickSpeaker(item);

    // Formato con words: [{word|text, start, end|duration}] — construir texto
    // y tiempos a partir de las palabras cuando falten a nivel de segmento.
    if (Array.isArray(item.words) && item.words.length) {
      var wordsText = [];
      var wStart = NaN, wEnd = NaN;
      for (var i = 0; i < item.words.length; i++) {
        var w = item.words[i];
        if (!w || typeof w !== 'object') continue;
        var token = typeof w.word === 'string' ? w.word : (typeof w.text === 'string' ? w.text : '');
        if (token) wordsText.push(token);
        var ws = rawTime(w, ['start', 'start_time', 'startTime']);
        var we = rawEnd(w, ws);
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
   * Divide un segmento con words TEMPORIZADAS en ORACIONES (cortando donde
   * eos=true), con el tiempo real de cada oración. Los exports de Premiere
   * traen bloques de 20-30s sin texto propio: como blob, un marcador de 10s
   * arrastraría párrafos enteros; por oración, el recorte cae exacto.
   * Devuelve [] si el formato no aplica (sin words o sin timing por palabra)
   * — en ese caso el caller usa normalizeItem (blob), como siempre.
   */
  function explodeSentences(item) {
    if (!item || typeof item !== 'object') return [];
    if (pickText(item)) return []; // el segmento ya trae su texto (ej. Whisper): respetarlo
    if (!Array.isArray(item.words) || !item.words.length) return [];
    var speaker = pickSpeaker(item);

    var out = [];
    var cur = { words: [], start: NaN, end: NaN };
    function close() {
      if (!cur.words.length) return;
      var s = isNaN(cur.start) ? NaN : cur.start;
      var e = isNaN(cur.end) ? s : cur.end;
      out.push({ start: s, end: e, text: cur.words.join(' '), speaker: speaker });
      cur = { words: [], start: NaN, end: NaN };
    }
    for (var i = 0; i < item.words.length; i++) {
      var w = item.words[i];
      if (!w || typeof w !== 'object') continue;
      var token = typeof w.word === 'string' ? w.word : (typeof w.text === 'string' ? w.text : '');
      if (!token) continue;
      var ws = rawTime(w, ['start', 'start_time', 'startTime']);
      var we = rawEnd(w, ws);
      if (isNaN(cur.start) && !isNaN(ws)) cur.start = ws;
      if (!isNaN(we)) cur.end = isNaN(cur.end) ? we : Math.max(cur.end, we);
      else if (!isNaN(ws)) cur.end = isNaN(cur.end) ? ws : Math.max(cur.end, ws);
      cur.words.push(token);
      if (w.eos === true) close();
    }
    close();

    // Sin timing utilizable por palabra el resultado sería inservible
    // (todas las oraciones sin tiempos): que decida normalizeItem.
    for (var k = 0; k < out.length; k++) {
      if (isNaN(out[k].start)) return [];
      if (isNaN(out[k].end) || out[k].end < out[k].start) out[k].end = out[k].start;
    }
    return out;
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
      var maxRaw = 0;
      var i, j, seg;

      for (i = 0; i < arr.length; i++) {
        // Preferir la división por ORACIONES cuando hay words temporizadas
        // (exports de Premiere: bloques de 20-30s sin texto propio).
        var sentences = explodeSentences(arr[i]);
        var items = sentences.length ? sentences : (function () {
          var one = normalizeItem(arr[i]);
          return one ? [one] : [];
        })();
        for (j = 0; j < items.length; j++) {
          seg = items[j];
          segments.push(seg);
          if (seg.start > maxRaw) maxRaw = seg.start;
          if (seg.end > maxRaw) maxRaw = seg.end;
        }
      }

      // Heurística de unidades: si algún tiempo supera un umbral, se asume esa
      // unidad para TODO el transcript (ticks de Premiere > ms > segundos).
      var divisor = maxRaw > TICKS_THRESHOLD ? TICKS_PER_SECOND
        : maxRaw > MS_THRESHOLD ? 1000
        : 1;
      if (divisor !== 1) {
        for (i = 0; i < segments.length; i++) {
          segments[i].start = segments[i].start / divisor;
          segments[i].end = segments[i].end / divisor;
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

  /**
   * sliceForMarker(segments, startSec, endSec, offsetSec): fragmento del
   * transcript para un marcador, corrigiendo el DESFASE entre la base de
   * tiempo del transcript y la del timeline.
   *
   * El transcript suele venir del video ORIGINAL; si el editor recortó el
   * inicio o corrió el clip en la secuencia, todo queda desplazado una
   * constante: tiempoTranscript = tiempoSecuencia + offsetSec (positivo si
   * se recortó el inicio; negativo si se agregó una intro).
   *
   * Se recorta en el rango DESPLAZADO y se devuelven los segmentos REBASADOS
   * a tiempo de secuencia, así los consumidores (timecodes relativos al
   * marcador en el prompt) siguen operando en una sola base de tiempo.
   */
  function sliceForMarker(segments, startSec, endSec, offsetSec) {
    offsetSec = isFiniteNumber(offsetSec) ? offsetSec : 0;
    var out = sliceByRange(segments, startSec + offsetSec, endSec + offsetSec);
    if (!offsetSec) return out;
    var rebased = [];
    for (var i = 0; i < out.length; i++) {
      rebased.push({
        start: out[i].start - offsetSec,
        end: out[i].end - offsetSec,
        text: out[i].text,
        speaker: out[i].speaker
      });
    }
    return rebased;
  }

  /**
   * calibrateUnits(segments, referenceDurationSec): valida y corrige las
   * UNIDADES de tiempo de un transcript contra una duración de referencia
   * REAL (la de la secuencia). Es la defensa contra formatos que traen los
   * tiempos en otra unidad (p.ej. FRAMES): un error de unidad es
   * multiplicativo y NINGÚN desfase constante lo corrige.
   *
   * ratio = duraciónTranscript / duraciónReferencia:
   *   ~1        → segundos, todo bien (match true)
   *   ~24/25/30 → frames a ese fps → se divide (match true, label)
   *   ~1000     → milisegundos    → se divide (match true, label)
   *   otro      → no se toca, match false (el caller avisa fuerte)
   *
   * Sin referencia (0/NaN) devuelve los segmentos intactos con match null.
   * Muta los tiempos de los segmentos recibidos y devuelve
   * { segments, factor, label, match }.
   */
  function calibrateUnits(segments, referenceDurationSec) {
    var out = { segments: segments, factor: 1, label: null, match: null };
    if (!Array.isArray(segments) || !segments.length) return out;
    if (!isFiniteNumber(referenceDurationSec) || referenceDurationSec <= 0) return out;

    var maxEnd = 0;
    for (var i = 0; i < segments.length; i++) {
      if (segments[i] && segments[i].end > maxEnd) maxEnd = segments[i].end;
    }
    if (maxEnd <= 0) return out;

    var ratio = maxEnd / referenceDurationSec;
    // Segundos: el transcript puede terminar algo antes que la secuencia
    // (outro sin voz) o apenas después (redondeos) — banda generosa.
    if (ratio >= 0.5 && ratio <= 1.5) {
      out.match = (ratio >= 0.7 && ratio <= 1.3);
      return out;
    }

    var CANDIDATES = [
      { f: 23.976, label: "frames (23.976 fps)" },
      { f: 24, label: "frames (24 fps)" },
      { f: 25, label: "frames (25 fps)" },
      { f: 29.97, label: "frames (29.97 fps)" },
      { f: 30, label: "frames (30 fps)" },
      { f: 50, label: "frames (50 fps)" },
      { f: 59.94, label: "frames (59.94 fps)" },
      { f: 60, label: "frames (60 fps)" },
      { f: 1000, label: "milisegundos" }
    ];
    var best = null;
    for (i = 0; i < CANDIDATES.length; i++) {
      var q = ratio / CANDIDATES[i].f;
      if (q >= 0.7 && q <= 1.3) {
        var d = Math.abs(q - 1);
        if (!best || d < best.d) best = { c: CANDIDATES[i], d: d };
      }
    }
    if (!best) {
      out.match = false; // unidades irreconocibles: no tocar, que el caller avise
      return out;
    }
    for (i = 0; i < segments.length; i++) {
      segments[i].start = segments[i].start / best.c.f;
      segments[i].end = segments[i].end / best.c.f;
    }
    out.factor = best.c.f;
    out.label = best.c.label;
    out.match = true;
    return out;
  }

  global.HPTranscript = {
    parse: parse,
    timecodeToSeconds: timecodeToSeconds,
    sliceByRange: sliceByRange,
    sliceForMarker: sliceForMarker,
    calibrateUnits: calibrateUnits
  };
})(typeof window !== 'undefined' ? window : this);
