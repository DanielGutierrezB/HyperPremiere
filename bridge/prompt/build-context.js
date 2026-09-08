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
//   generalInstruction: string,                    // prompt general del CURSO (todas las clases)
//   sequenceInstruction: string,                   // prompt de ESTA secuencia
//   instruction: string,                           // qué pidió el editor para este recurso
//   stillsCount: number                            // stills que van como imágenes aparte
// }
//
// Los tres últimos son los TRES NIVELES de lo que escribe el editor, del más
// general al más específico: el prompt general del curso, el de la secuencia y
// la instrucción del marcador. Los tres viajan juntos y se cumplen a la vez.
// Donde se contradigan manda el más específico, y eso va DICHO en el prompt (ver
// styleBlocks): el caso real es un curso que pide "paleta azul institucional" y
// una clase que va en blanco y negro. Dejárselo a criterio del modelo era la
// mitad del problema — sale bien o sale mal y nadie sabe por qué.

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

/**
 * Qué niveles generales trae este pedido, normalizados y por separado.
 *
 * `unknown` es la compatibilidad con los jobs encolados por un panel anterior a
 * la 1.5.0: mandaban UN solo texto ya resuelto —el del curso o el de la clase,
 * el que ganaba— y su origen aparte. Cuando ese origen dice que era de la clase,
 * se respeta; sin origen no se puede saber a qué nivel corresponde y se dice que
 * no se sabe. Inventarle un nivel sería mentir en el único dato por el que se
 * mira el log de una generación.
 */
function generalPromptLevels(ctx) {
  ctx = ctx || {};
  const solo = String(ctx.generalInstruction || '').trim();
  const sequence = String(ctx.sequenceInstruction || '').trim();
  // El panel de la 1.5.0 en adelante manda SIEMPRE los dos campos, vacíos
  // incluidos; que falte el de la secuencia es lo que delata a un job viejo.
  const viejo = ctx.sequenceInstruction === undefined;
  if (viejo && solo && ctx.generalSource === 'sequence') {
    return { course: '', sequence: solo, unknown: false };
  }
  return { course: solo, sequence, unknown: viejo && !!solo && !ctx.generalSource };
}

/**
 * Los bloques de los dos niveles generales, con la precedencia escrita.
 *
 * La línea de precedencia solo aparece cuando los dos existen: sin nada arriba
 * que contradecir, "esto le gana a aquello" es ruido que se paga en tokens en
 * cada generación.
 */
function styleBlocks(levels) {
  const parts = [];
  if (levels.course) {
    parts.push('\n## Prompt general del curso (aplica a TODAS las clases)');
    parts.push('Estilo, marca, tono y reglas del curso entero. Es la BASE de todo lo que sigue.');
    parts.push(levels.course);
  }
  if (levels.sequence) {
    parts.push('\n## Prompt de esta secuencia (aplica a TODOS los marcadores de esta clase)');
    parts.push(levels.course
      ? 'Lo propio de ESTA clase, sobre la base del curso. PRECEDENCIA: donde esto CONTRADIGA al ' +
        'prompt general del curso, MANDA ESTO. (Si el curso dice "paleta azul institucional" y acá ' +
        'dice "esta clase va en blanco y negro", va en blanco y negro.) Lo que no se contradiga, se suma.'
      : 'Estilo, marca, tono y reglas comunes a todos los marcadores de esta clase.');
    parts.push(levels.sequence);
  }
  return parts;
}

/**
 * Cómo se nombra el prompt general en el ⬇ Log de una generación.
 *
 * El "no" se escribe igual que siempre a propósito: es el texto por el que se
 * buscó en el log del editor para descubrir todo esto, y los logs viejos se
 * siguen pudiendo comparar contra los nuevos. Lo que cambió es que ahora puede
 * haber DOS niveles viajando, así que la etiqueta dice cuáles fueron y no cuál
 * ganó: decir "sí" —o nombrar uno solo— dejaría el mismo agujero un escalón más
 * arriba.
 */
function generalPromptLabel(ctx) {
  const levels = generalPromptLevels(ctx);
  if (levels.unknown) return 'sí (origen desconocido)';
  if (levels.course && levels.sequence) {
    return 'del curso + de esta secuencia (si se contradicen, manda la secuencia)';
  }
  if (levels.sequence) return 'solo de esta secuencia';
  if (levels.course) return 'del curso';
  return 'no';
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
    stillsCount,
    lean, // refinamiento: omitir el transcript completo de la clase (ahorro de tokens)
  } = ctx || {};

  const levels = generalPromptLevels(ctx);

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

  styleBlocks(levels).forEach((p) => parts.push(p));

  parts.push('\n## Instrucción del editor (específica de este marcador)');
  // Es el tercer nivel y el más específico. Decirlo solo cuando hay algo arriba
  // a lo que ganarle: sin prompts generales, "manda ésta" no le gana a nada.
  if (levels.course || levels.sequence) {
    parts.push('Es el nivel MÁS específico de los tres: donde contradiga a los prompts de arriba, MANDA ÉSTA.');
  }
  parts.push((instruction || '').trim() || '(sin instrucción específica: proponé el recurso que mejor refuerce el objetivo)');

  parts.push('\n## Duración objetivo');
  parts.push(
    `La composición debe durar ${duration.toFixed(2)} s (declarala en data-duration del #stage y ` +
      'que la timeline cubra exactamente ese rango).'
  );

  // Acá NO se dice cómo llegan las imágenes (adjuntas al mensaje o como archivos
  // en disco): eso lo sabe el proveedor y lo agrega él. Cuando este texto lo
  // afirmaba, con los proveedores de línea de comandos le mentía al modelo: le
  // hablaba de adjuntos que no existían mientras los archivos estaban ahí al lado.
  if (stills > 0) {
    parts.push('\n## Imágenes de referencia');
    parts.push(
      `Con este pedido van ${stills} imagen(es) de referencia, NUMERADAS de 1 a ${stills} en ese orden: ` +
        'cuando la instrucción del editor dice "imagen 1", es exactamente esa. ' +
        'Miralas antes de diseñar — de ahí salen la composición del cuadro, la paleta y las zonas ' +
        'libres donde el gráfico no tapa lo que importa ' +
        '(salvo las marcadas para incrustar, ver la sección de assets).'
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

module.exports = { buildUserPrompt, generalPromptLevels, generalPromptLabel };
