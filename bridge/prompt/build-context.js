'use strict';

// Construye el prompt de usuario (un solo request bien armado) a partir del
// contexto que junta el panel: objetivo de la clase, transcript completo,
// marcador activo con su fragmento de transcript, instrucción del editor y
// cantidad de stills adjuntos.
//
// ctx = {
//   objective: string,
//   transcriptSegments: [{ start, end, text }],   // transcript completo de la clase
//   marker: { name, start, end, duration },        // tiempos en segundos (absolutos de secuencia)
//   markerTranscript: [{ start, end, text }],      // segmentos que caen dentro del marcador
//   instruction: string,                           // qué pidió el editor para este recurso
//   stillsCount: number                            // stills que van como imágenes aparte
// }

// Límite blando para el resumen del transcript completo: mantiene el request
// dentro de un tamaño razonable sin perder el hilo de la clase.
const TRANSCRIPT_CHAR_LIMIT = 6000;

// Formatea segundos como M:SS.d para timecodes legibles en el prompt.
function formatTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
}

// Concatena el transcript completo en un solo bloque de texto; si excede el
// límite, recorta y lo deja explícito para que el modelo sepa que es parcial.
function summarizeTranscript(segments) {
  const full = (segments || [])
    .map((seg) => (seg.text || '').trim())
    .filter(Boolean)
    .join(' ');

  if (full.length <= TRANSCRIPT_CHAR_LIMIT) return full;

  return (
    full.slice(0, TRANSCRIPT_CHAR_LIMIT) +
    `\n[... transcript recortado: se omiten ${full.length - TRANSCRIPT_CHAR_LIMIT} caracteres del total ...]`
  );
}

// Renderiza el fragmento del marcador línea por línea con timecodes RELATIVOS
// al inicio del marcador, que es el eje de tiempo de la composición (t=0 es
// donde arranca el recurso en pantalla).
function formatMarkerTranscript(markerTranscript, markerStart) {
  const lines = (markerTranscript || [])
    .map((seg) => {
      const relStart = (Number(seg.start) || 0) - markerStart;
      const relEnd = (Number(seg.end) || 0) - markerStart;
      const text = (seg.text || '').trim();
      if (!text) return null;
      return `[${formatTime(relStart)} - ${formatTime(relEnd)}] ${text}`;
    })
    .filter(Boolean);

  return lines.length ? lines.join('\n') : '(sin transcript dentro del marcador)';
}

// Arma el prompt de usuario completo. Devuelve un string listo para enviar
// como único mensaje de usuario junto con los stills adjuntos como imágenes.
function buildUserPrompt(ctx) {
  const {
    objective,
    transcriptSegments,
    marker,
    markerTranscript,
    instruction,
    generalInstruction,
    stillsCount,
    lean, // refinamiento: omitir el transcript completo de la clase (ahorro de tokens)
  } = ctx || {};

  const markerStart = Number(marker && marker.start) || 0;
  const duration = Number(marker && marker.duration) || 0;
  const stills = Number(stillsCount) || 0;

  const parts = [];

  parts.push('## Objetivo de la clase');
  parts.push((objective || '').trim() || '(sin objetivo declarado)');

  // En refinamiento (lean) NO reenviamos el transcript completo de la clase: el
  // modelo ya tiene el diseño previo (HTML) y el fragmento del marcador; reenviar
  // toda la clase otra vez es desperdicio de tokens.
  if (!lean) {
    parts.push('\n## Transcript completo de la clase (contexto general)');
    parts.push(summarizeTranscript(transcriptSegments) || '(sin transcript)');
  }

  parts.push(`\n## Fragmento del marcador "${(marker && marker.name) || 'sin nombre'}"`);
  parts.push(
    'Timecodes relativos al inicio del recurso (t=0 = arranque de la composición). ' +
      'Timá las apariciones de la composición a estas líneas:'
  );
  parts.push(formatMarkerTranscript(markerTranscript, markerStart));

  const generalTxt = (generalInstruction || '').trim();
  if (generalTxt) {
    parts.push('\n## Indicaciones generales (aplican a TODOS los recursos de esta clase)');
    parts.push('Estilo, marca, tono y reglas comunes a todos los marcadores. Respetalas siempre, y sobre esta base aplicá la instrucción específica de abajo:');
    parts.push(generalTxt);
  }

  parts.push('\n## Instrucción del editor (específica de este marcador)');
  parts.push((instruction || '').trim() || '(sin instrucción específica: proponé el recurso que mejor refuerce el objetivo)');

  parts.push('\n## Duración objetivo');
  parts.push(
    `La composición debe durar ${duration.toFixed(2)} s (declarala en data-duration del #stage y ` +
      'que la timeline cubra exactamente ese rango).'
  );

  if (stills > 0) {
    parts.push('\n## Imágenes de referencia adjuntas');
    parts.push(
      `Se adjuntan ${stills} imagen(es) de referencia, como imágenes aparte de este mensaje. ` +
        'Están NUMERADAS en el orden en que se envían: la 1ª es "imagen 1", la 2ª "imagen 2", etc. ' +
        'Si la instrucción del editor menciona "imagen 1", "imagen 2", etc., se refiere EXACTAMENTE a ese orden. ' +
        'Usalas para leer composición/paleta/zonas libres y ubicar los gráficos sin tapar lo importante ' +
        '(salvo que estén marcadas para incrustar, ver sección de assets).'
    );
  }

  // Recordatorio del contrato (reduce reintentos por HTML inválido).
  parts.push('\n## Contrato obligatorio (verificá antes de responder)');
  parts.push(
    '- El <div id="stage"> DEBE tener: data-composition-id, data-width="1920", data-height="1080", ' +
      'data-duration (número > 0 = duración en segundos) y data-fps="30".\n' +
      '- El script DEBE terminar con window.__timelines[COMP_ID] = tl; (COMP_ID = data-composition-id).\n' +
      '- Sin esos tres (data-composition-id, data-duration > 0, __timelines) el render falla.'
  );

  parts.push('\nDevolvé SOLO el HTML completo de la composición.');

  return parts.join('\n');
}

module.exports = { buildUserPrompt };
