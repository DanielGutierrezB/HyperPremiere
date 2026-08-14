// Manejo del sistema de archivos para las salidas de HyperPremiere.
// Las renders viven en "<dir del .prproj>/HyperPremiere/<slug(sequenceName)>/".

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Contrato de nombres versionados ("<slug> vN [modelo].ext"): vive en versions.js.
const { formatBase, listVersions } = require('./versions');
// Qué es una composición y qué no: el contrato vive en composition.js.
const { inspectComposition, PROBLEM } = require('../composition');

/**
 * Convierte un nombre arbitrario en un slug seguro para el filesystem.
 */
function slugify(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quitar acentos (marcas combinantes tras NFD)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'sin-nombre';
}

/**
 * Dónde VA la carpeta de salida de una secuencia, sin crearla. Para consultas de
 * solo lectura (¿ya tiene transcript?), que no deben dejar carpetas vacías.
 * Si projectPath está vacío (proyecto sin guardar), usa ~/HyperPremiere.
 */
function outputDirPath(projectPath, sequenceName) {
  const root = projectPath
    ? path.join(path.dirname(projectPath), 'HyperPremiere')
    : path.join(os.homedir(), 'HyperPremiere');
  return path.join(root, slugify(sequenceName));
}

/**
 * Crea (si hace falta) y devuelve la carpeta de salida al lado del .prproj.
 */
function ensureOutputDir(projectPath, sequenceName) {
  const dir = outputDirPath(projectPath, sequenceName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Rutas de los artefactos de una render. `model` es opcional; si se pasa, queda
 * al final del nombre para saber con qué modelo se generó el recurso.
 */
function paths(baseDir, markerSlug, version, model, ext) {
  const base = formatBase(markerSlug, version || 1, model);
  const videoExt = (ext === 'mp4') ? 'mp4' : 'mov';
  return {
    // `mov` = ruta del video de salida (mov con alpha, o mp4 opaco si ext='mp4').
    mov: path.join(baseDir, `${base}.${videoExt}`),
    html: path.join(baseDir, `${base}.html`),
    meta: path.join(baseDir, `${base}.meta.json`),
    stillsDir: path.join(baseDir, `${base}-stills`),
    resourcesDir: path.join(baseDir, `${base}-resources`),
  };
}

/** Extensión de archivo según media type (para recursos sin extensión propia). */
function extForMime(mime) {
  const map = {
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'text/csv': '.csv',
    'application/json': '.json',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  };
  return map[String(mime || '').toLowerCase()] || '';
}

/** Convierte un nombre de archivo arbitrario en algo seguro para el filesystem. */
function safeFileName(name) {
  // \x00-\x1f: antes eran bytes de control LITERALES en el fuente (hacían que
  // git tratara el archivo como binario); escapados el comportamiento es igual.
  return String(name || '')
    .replace(/[\/\\:*?"<>|\x00-\x1f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
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
 * El HTML de la última versión de `markerSlug` anterior a `version` que sea UNA
 * COMPOSICIÓN DE VERDAD. '' si no hay ninguna.
 *
 * Camina para atrás en vez de leer version-1 y confiar. Hace falta porque en el
 * disco puede haber quedado un .html que no es una composición: hubo un día en
 * que el modelo contestó EN PROSA tres rondas seguidas y esa prosa se guardó
 * como la versión nueva (la historia entera está en compose.js). Leer eso como
 * "la versión previa" es peor que no tener referencia — al modelo se le termina
 * pidiendo mejorar un texto de disculpa, y contesta algo sin que nada falle.
 * Salteándolas, la corrección vuelve sobre el último diseño real.
 */
function lastCompositionHtml(baseDir, markerSlug, version) {
  const previas = listVersions(baseDir, markerSlug, '.html')
    .filter((v) => v.version < Number(version))
    .reverse();
  for (const v of previas) {
    try {
      const html = fs.readFileSync(path.join(baseDir, v.name), 'utf8');
      if (inspectComposition(html, {}).problem !== PROBLEM.NOT_HTML) return html;
    } catch {
      // Archivo ilegible: seguimos con la versión anterior.
    }
  }
  return '';
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

/**
 * Guarda recursos de referencia (PDFs, imágenes, docs) subidos por el editor.
 * `resources` = [{ name, dataUrl, mediaType }]. dataUrl = "data:<mime>;base64,<...>".
 * Devuelve las rutas absolutas escritas. Best-effort: nunca lanza.
 */
function saveResources(resourcesDir, resources) {
  if (!Array.isArray(resources) || resources.length === 0) return [];
  fs.mkdirSync(resourcesDir, { recursive: true });
  const out = [];
  resources.forEach((r, i) => {
    if (!r || typeof r.dataUrl !== 'string') return;
    const m = /^data:([^;,]*);base64,([\s\S]+)$/.exec(r.dataUrl);
    if (!m) return;
    const mime = m[1] || r.mediaType || '';
    let name = safeFileName(r.name);
    if (!name) name = `recurso-${String(i + 1).padStart(2, '0')}`;
    // Asegurar extensión: si el nombre no trae una, derivarla del media type.
    if (!/\.[a-z0-9]+$/i.test(name)) name += extForMime(mime);
    const filePath = path.join(resourcesDir, name);
    try {
      fs.writeFileSync(filePath, Buffer.from(m[2].replace(/\s+/g, ''), 'base64'));
      out.push(filePath);
    } catch {
      // best-effort: seguimos con los demás recursos
    }
  });
  return out;
}

module.exports = {
  slugify,
  ensureOutputDir,
  outputDirPath,
  paths,
  saveMeta,
  readMeta,
  lastCompositionHtml,
  saveStills,
  saveResources,
};
