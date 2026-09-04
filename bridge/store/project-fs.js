// Manejo del sistema de archivos para las salidas de HyperPremiere.
// Las renders viven en "<dir del .prproj>/HyperPremiere/<slug(sequenceName)>/".
// Y lo que es del proyecto entero —la cola, la base del prompt general— un
// nivel más arriba, en "<dir del .prproj>/HyperPremiere/".

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
 * La carpeta del PROYECTO: "<dir del .prproj>/HyperPremiere". Es el único nivel
 * que NO es de una secuencia, y ahí va lo que vale para el proyecto entero: la
 * cola y la base del prompt general. Existía repartida en dos copias (acá y en
 * engine.js, para queue.json); vive en un solo lugar porque ahora hay más de un
 * archivo que depende de dar la misma carpeta.
 * Si projectPath está vacío (proyecto sin guardar), usa ~/HyperPremiere.
 */
function projectRootPath(projectPath) {
  return projectPath
    ? path.join(path.dirname(projectPath), 'HyperPremiere')
    : path.join(os.homedir(), 'HyperPremiere');
}

/**
 * Dónde VA la carpeta de salida de una secuencia, sin crearla. Para consultas de
 * solo lectura (¿ya tiene transcript?), que no deben dejar carpetas vacías.
 */
function outputDirPath(projectPath, sequenceName) {
  return path.join(projectRootPath(projectPath), slugify(sequenceName));
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

/** El contenido de un archivo de texto, o null si no está (que no es lo mismo que vacío). */
function readTextFileOrNull(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// ── Prompt general: la base del proyecto y el que la pisa ────────────
// El estilo del curso —marca, paleta, tipografía, tono— es del PROYECTO, no del
// localStorage de una máquina. Mientras vivió ahí, el segundo editor abría el
// mismo .prproj y generaba con el campo vacío: misma clase, mismo marcador,
// contexto distinto y animaciones peores, sin nada que se lo dijera.
//
// Dos archivos, misma forma que el resto:
//   <dir .prproj>/HyperPremiere/prompt-general.md            ← la base, del proyecto
//   <dir .prproj>/HyperPremiere/<secuencia>/prompt-general.md ← el propio de esa clase
//
// Es texto plano y no JSON a propósito: es prosa, y en un JSON las líneas se
// escaparían a "\n" — dejaría de ser un archivo que el editor puede abrir y
// arreglar a mano, que es medio punto de guardarlo al lado del proyecto.
const GENERAL_PROMPT_FILE = 'prompt-general.md';

function generalPromptPaths(projectPath, sequenceName) {
  return {
    project: path.join(projectRootPath(projectPath), GENERAL_PROMPT_FILE),
    sequence: sequenceName
      ? path.join(outputDirPath(projectPath, sequenceName), GENERAL_PROMPT_FILE)
      : '',
  };
}

/**
 * Qué prompt general le toca a esta secuencia y DE DÓNDE sale.
 *
 * La respuesta es una sola para todos —el panel, el log y el prompt— porque la
 * pregunta que resolvió el bug es exactamente ésa: con qué contexto se generó.
 * `source`: 'sequence' (la secuencia pisa la base), 'project' o 'none'.
 *
 * El propio de una secuencia REEMPLAZA a la base, no se le suma: dos textos
 * pegados que pueden contradecirse ("tipografía Inter" + "tipografía Roboto")
 * dejan al modelo eligiendo, que es la clase de contexto turbio que esto vino
 * a sacar. Se ve entero lo que viaja, y no hay precedencia que deducir.
 */
function loadGeneralPrompt(body) {
  body = body || {};
  const vacio = { text: '', source: 'none', projectText: '', sequenceText: '', hasProjectFile: false };
  try {
    const files = generalPromptPaths(body.projectPath, body.sequenceName);
    const projectRaw = readTextFileOrNull(files.project);
    const sequenceRaw = files.sequence ? readTextFileOrNull(files.sequence) : null;
    const projectText = String(projectRaw == null ? '' : projectRaw).trim();
    const sequenceText = String(sequenceRaw == null ? '' : sequenceRaw).trim();
    return {
      ok: true,
      text: sequenceText || projectText,
      source: sequenceText ? 'sequence' : (projectText ? 'project' : 'none'),
      projectText,
      sequenceText,
      // Que el archivo EXISTA aunque esté vacío es un dato: quiere decir que el
      // proyecto ya decidió que no hay base, y entonces no hay nada que migrar.
      hasProjectFile: projectRaw != null,
      paths: files,
    };
  } catch (e) {
    return Object.assign({ ok: false, error: (e && e.message) || String(e) }, vacio);
  }
}

/**
 * Escribe la base del proyecto (`scope: 'project'`) o el propio de una secuencia
 * (`scope: 'sequence'`).
 *
 * Vaciar el de una secuencia ES volver a la base: se borra el archivo, así el
 * disco no queda diciendo "esta clase tiene el suyo" con nada adentro. Vaciar la
 * base se anota, pero no se crea la carpeta solo por eso — misma regla que la
 * cola: abrir el panel no deja carpetas por ahí.
 */
function saveGeneralPrompt(body) {
  body = body || {};
  const text = String(body.text == null ? '' : body.text).trim();
  const scope = body.scope === 'sequence' ? 'sequence' : 'project';
  try {
    const files = generalPromptPaths(body.projectPath, body.sequenceName);
    const file = scope === 'sequence' ? files.sequence : files.project;
    if (!file) return { ok: false, error: 'para guardar el prompt de una secuencia hace falta su nombre' };
    if (!text) {
      if (scope === 'sequence') {
        try { fs.unlinkSync(file); } catch { /* no estaba: ya está en la base */ }
        return { ok: true, path: file, scope, removed: true };
      }
      if (!fs.existsSync(file)) return { ok: true, path: file, scope, created: false };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text ? text + '\n' : '', 'utf8');
    return { ok: true, path: file, scope };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
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
  projectRootPath,
  paths,
  saveMeta,
  readMeta,
  readTextFileOrNull,
  // El estilo del curso, que viaja con el .prproj en vez de con la máquina.
  generalPromptPaths,
  loadGeneralPrompt,
  saveGeneralPrompt,
  lastCompositionHtml,
  saveStills,
  saveResources,
};
