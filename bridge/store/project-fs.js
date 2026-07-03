// Manejo del sistema de archivos para las salidas de HyperPremiere.
// Las renders viven en "<dir del .prproj>/HyperPremiere/<slug(sequenceName)>/".

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Convierte un nombre arbitrario en un slug seguro para el filesystem.
 */
function slugify(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quitar acentos (marcas combinantes tras NFD)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'sin-nombre';
}

/**
 * Crea (si hace falta) y devuelve la carpeta de salida al lado del .prproj.
 * Si projectPath está vacío (proyecto sin guardar), usa ~/HyperPremiere.
 */
function ensureOutputDir(projectPath, sequenceName) {
  const root = projectPath
    ? path.join(path.dirname(projectPath), 'HyperPremiere')
    : path.join(os.homedir(), 'HyperPremiere');
  const dir = path.join(root, slugify(sequenceName));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Nombre base de los archivos de un marcador: "<slug>" o "<slug>-vN" si version > 1.
 */
function baseName(markerSlug, version) {
  return version > 1 ? `${markerSlug}-v${version}` : markerSlug;
}

/**
 * Rutas de los artefactos de una render.
 */
function paths(baseDir, markerSlug, version) {
  const base = baseName(markerSlug, version || 1);
  return {
    mov: path.join(baseDir, `${base}.mov`),
    html: path.join(baseDir, `${base}.html`),
    meta: path.join(baseDir, `${base}.meta.json`),
    stillsDir: path.join(baseDir, `${base}-stills`),
  };
}

/**
 * Guarda metadata como JSON. Best-effort: nunca lanza.
 */
function saveMeta(metaPath, obj) {
  try {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Lee metadata JSON. Devuelve null si no existe o está corrupta.
 */
function readMeta(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Siguiente número de versión para un marcador, según los archivos existentes.
 * Devuelve 1 si no hay ninguno.
 */
function nextVersion(baseDir, markerSlug) {
  let entries;
  try {
    entries = fs.readdirSync(baseDir);
  } catch {
    return 1;
  }
  let max = 0;
  const versioned = new RegExp(`^${escapeRegExp(markerSlug)}-v(\\d+)\\.`);
  const plain = new RegExp(`^${escapeRegExp(markerSlug)}\\.`);
  for (const name of entries) {
    const m = name.match(versioned);
    if (m) {
      max = Math.max(max, parseInt(m[1], 10));
    } else if (plain.test(name)) {
      max = Math.max(max, 1);
    }
  }
  return max + 1;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Guarda dataURLs (imágenes) en stillsDir. Devuelve las rutas escritas.
 */
function saveStills(stillsDir, dataUrls) {
  if (!Array.isArray(dataUrls) || dataUrls.length === 0) return [];
  fs.mkdirSync(stillsDir, { recursive: true });
  const out = [];
  dataUrls.forEach((dataUrl, i) => {
    const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(String(dataUrl || ''));
    if (!m) return;
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1].replace(/[^a-z0-9]/gi, '');
    const filePath = path.join(stillsDir, `still-${String(i + 1).padStart(2, '0')}.${ext}`);
    try {
      fs.writeFileSync(filePath, Buffer.from(m[2], 'base64'));
      out.push(filePath);
    } catch {
      // best-effort: seguimos con los demás stills
    }
  });
  return out;
}

module.exports = {
  slugify,
  ensureOutputDir,
  paths,
  saveMeta,
  readMeta,
  nextVersion,
  saveStills,
};
