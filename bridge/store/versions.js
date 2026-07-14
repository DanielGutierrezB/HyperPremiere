'use strict';

// Dueño ÚNICO del esquema de nombres de los archivos versionados por marcador:
//
//   "<slug> vN<sufijo>"           →  "Marcador 1 v2.html"
//   "<slug> vN [modelo]<sufijo>"  →  "Marcador 1 v2 [claude-sonnet-5].mov"
//
// donde <sufijo> es una extensión (".html", ".mov", ".meta.json") o un sufijo
// de carpeta ("-stills", "-resources"). El [modelo] es opcional y puede cambiar
// entre versiones del mismo marcador, por eso las búsquedas matchean por
// slug+versión+sufijo SIN depender del modelo.
//
// Este contrato antes estaba re-derivado con regexes distintas en cinco lugares
// (engine y project-fs); cualquier cambio de nomenclatura rompía en silencio.
// Todo parse/format de estos nombres debe pasar por acá.

const fs = require('fs');
const path = require('path');

// "<slug> vN" + " [modelo]" opcional + sufijo opcional (empieza con ".", "-" o
// espacio, para no confundir "v2" con el prefijo de "v20").
const NAME_RE = /^(.+) v(\d+)(?: \[([^\]]*)\])?([\s.\-].*)?$/;

/**
 * Parsea un nombre de archivo/carpeta versionado.
 * Devuelve { slug, version, model, suffix } o null si no sigue el esquema.
 */
function parseName(name) {
  const m = String(name || '').match(NAME_RE);
  if (!m) return null;
  return { slug: m[1], version: parseInt(m[2], 10), model: m[3] || '', suffix: m[4] || '' };
}

/** Modelo saneado para meterlo en un nombre de archivo ("qwen3-vl:30b" → "qwen3-vl-30b"). */
function safeModel(model) {
  return String(model || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Nombre base de los archivos de una versión: "<slug> vN" + " [modelo]" si se
 * pasa el modelo. Ej: "Marcador 1 v2 [claude-sonnet-5]".
 */
function formatBase(markerSlug, version, model) {
  const base = `${markerSlug} v${version || 1}`;
  const m = safeModel(model);
  return m ? `${base} [${m}]` : base;
}

/** Entradas del directorio; [] si no existe o no se puede leer. */
function listEntries(baseDir) {
  try { return fs.readdirSync(baseDir); } catch (e) { return []; }
}

/**
 * Ruta absoluta del archivo de una versión concreta con el sufijo dado,
 * sin depender del modelo en el nombre. Devuelve null si no existe.
 */
function versionFile(baseDir, markerSlug, version, suffix) {
  const want = Number(version);
  for (const name of listEntries(baseDir)) {
    const p = parseName(name);
    if (p && p.slug === markerSlug && p.version === want && p.suffix === suffix) {
      return path.join(baseDir, name);
    }
  }
  return null;
}

/**
 * Siguiente número de versión para un marcador, según los archivos existentes
 * (cuenta cualquier artefacto: .html, .mov, -stills, …). 1 si no hay ninguno.
 */
function nextVersion(baseDir, markerSlug) {
  let max = 0;
  for (const name of listEntries(baseDir)) {
    const p = parseName(name);
    if (p && p.slug === markerSlug && p.version > max) max = p.version;
  }
  return max + 1;
}

/**
 * Versiones existentes de un marcador con el sufijo dado, orden ascendente.
 * Devuelve [{ version, model, name }].
 */
function listVersions(baseDir, markerSlug, suffix) {
  const out = [];
  for (const name of listEntries(baseDir)) {
    const p = parseName(name);
    if (p && p.slug === markerSlug && p.suffix === suffix) {
      out.push({ version: p.version, model: p.model, name });
    }
  }
  out.sort((a, b) => a.version - b.version);
  return out;
}

/**
 * Todas las entradas versionadas del directorio cuyo sufijo esté en `suffixes`,
 * agrupadas por slug y ordenadas por versión ascendente dentro de cada grupo.
 * Devuelve { <slug>: [{ version, model, name }] }.
 */
function groupBySlug(baseDir, suffixes) {
  const bySlug = {};
  for (const name of listEntries(baseDir)) {
    const p = parseName(name);
    if (!p || suffixes.indexOf(p.suffix) === -1) continue;
    (bySlug[p.slug] = bySlug[p.slug] || []).push({ version: p.version, model: p.model, name });
  }
  Object.keys(bySlug).forEach((slug) => {
    bySlug[slug].sort((a, b) => a.version - b.version);
  });
  return bySlug;
}

module.exports = {
  parseName,
  formatBase,
  versionFile,
  nextVersion,
  listVersions,
  groupBySlug,
};
