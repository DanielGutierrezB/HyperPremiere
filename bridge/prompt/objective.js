'use strict';

// Arma el prompt para derivar el OBJETIVO pedagógico de la clase a partir del
// transcript completo. Devuelve { system, user } listos para mandar al
// proveedor configurado (sin imágenes).

// Límite blando del transcript en el prompt: suficiente contexto para inferir
// el objetivo sin inflar el request.
const TRANSCRIPT_CHAR_LIMIT = 8000;

function buildObjectivePrompt(transcriptText) {
  const full = String(transcriptText || '').trim();

  let transcript = full;
  if (full.length > TRANSCRIPT_CHAR_LIMIT) {
    transcript =
      full.slice(0, TRANSCRIPT_CHAR_LIMIT) +
      `\n[... transcript recortado: se omiten ${full.length - TRANSCRIPT_CHAR_LIMIT} caracteres del total ...]`;
  }

  const system =
    'Sos un asistente que resume el OBJETIVO pedagógico de una clase en 1-2 frases claras, en español neutro, sin preámbulos.';

  const user = [
    'Leé el siguiente transcript de una clase y devolvé SOLO el objetivo de',
    'aprendizaje de la clase: qué debe lograr o entender el estudiante al',
    'terminarla. Respondé en 1-2 frases, sin comillas y sin anteponer "Objetivo:".',
    '',
    '## Transcript',
    transcript || '(sin transcript)',
  ].join('\n');

  return { system, user };
}

module.exports = { buildObjectivePrompt };
