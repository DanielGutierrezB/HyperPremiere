// Manejo del sistema de archivos para las salidas de HyperPremiere.
// Las renders viven en "<dir del .prproj>/HyperPremiere/<slug(sequenceName)>/".
// Y lo que es del proyecto entero —la cola, el prompt general del curso— un
// nivel más arriba, en "<dir del .prproj>/HyperPremiere/".

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Contrato de nombres versionados ("<slug> vN [modelo].ext"): vive en versions.js.
const { formatBase, listVersions } = require('./versions');
// Las referencias de los dos niveles generales (capturas, logos, PDFs) como
// archivos al lado del .prproj: su I/O y su manifiesto viven en references.js.
const referencias = require('./references');
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
 * cola y el prompt general del curso. Existía repartida en dos copias (acá y en
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

// ── La ficha de una versión (.meta.json) ─────────────────────────────
//
// Al lado de cada `<marcador> vN [modelo].html` hay un `.meta.json` con TODO lo
// que de esa versión no se puede reconstruir mirando el disco: en qué segundo
// de qué secuencia iba (el marcador de Premiere puede ya no existir cuando
// vuelvas de la revisión), qué se le pidió, con qué contexto se generó, cuánto
// tardó y qué hubo antes. La pestaña Corrections vive de este archivo.
//
// La forma está declarada UNA vez, acá, y no en cada uno de los cuatro lugares
// que la escriben. Mientras cada quien armaba su registro con su propio
// `Object.assign`, la forma del archivo persistido no estaba escrita en ningún
// lado: se deducía leyendo siete lugares, y "cuál preserva qué" eran cuatro
// decisiones sueltas que nadie podía comparar. Los que escriben ahora dicen QUÉ
// escriben; el CÓMO —el orden, qué se omite, qué se conserva— es de este módulo,
// que es el que ya era dueño de saveMeta/readMeta.

/**
 * El registro de una versión, con sus campos en el orden en que se leen.
 *
 * Un campo `undefined` no se escribe. Eso es lo que deja que un pedido diga con
 * una línea que un campo NO le corresponde —el render manual y `prompts`— en
 * vez de armar otro objeto a mano y que la omisión haya que notarla.
 */
function versionMetaRecord(campos) {
  const c = campos || {};
  const marker = (c.marker && typeof c.marker === 'object') ? c.marker : {};
  const rec = {
    // Dónde iba. Es lo que Corrections necesita para devolver el clip corregido
    // al mismo segundo y con la misma duración.
    sequenceName: String(c.sequenceName || ''),
    markerSlug: String(c.markerSlug || ''),
    markerName: String(c.markerName || marker.name || ''),
    markerGuid: String(c.markerGuid || marker.guid || ''),
    marker,
    // Qué versión es y con qué se hizo.
    version: c.version,
    model: c.model,
    provider: c.provider,
    mode: c.mode,
    // Qué se le pidió: el encargo del recurso, la corrección de esta ronda si la
    // hubo, y los tres niveles del contexto que viajaron al modelo.
    instruction: c.instruction,
    adjustment: c.adjustment,
    prompts: c.prompts,
    // Cómo salió el video (decide el formato de una corrección).
    background: c.background,
    format: c.format,
    // Cuándo, si quedó a medias, cuánto costó y qué hubo antes.
    createdAt: c.createdAt,
    pending: c.pending,
    timings: c.timings,
    history: c.history,
  };
  Object.keys(rec).forEach((k) => { if (rec[k] === undefined) delete rec[k]; });
  return rec;
}

/**
 * Escribe la ficha ENTERA: lo que no venga en `campos` deja de estar en el
 * archivo.
 *
 * Es lo que se quiere en los tres momentos que la escriben de punta a punta —la
 * que se anota antes de gastar la llamada al modelo, la que la reemplaza cuando
 * el render sale bien, y la del HTML editado a mano—: cada uno sabe todo lo que
 * hay que saber de esa versión, y un campo que sobreviviera de la escritura
 * anterior estaría hablando de otro intento. Por ejemplo `pending: true`, que se
 * pone al principio justamente para que su AUSENCIA signifique "llegó al final".
 */
function writeVersionMeta(metaPath, campos) {
  return saveMeta(metaPath, versionMetaRecord(campos));
}

/**
 * Escribe SOLO los campos que le pasan y conserva el resto de la ficha.
 *
 * Es para los retoques que no son una generación: hoy, anotar a mano el tramo de
 * un recurso viejo. Contestar dónde iba no puede llevarse puesto con qué
 * contexto se generó — la fila pasaría de "esto es lo que se mandó" a "esto es
 * una reconstrucción" por haber respondido una pregunta que no tiene que ver.
 */
function mergeVersionMeta(metaPath, campos) {
  const prev = readMeta(metaPath) || {};
  return saveMeta(metaPath, Object.assign({}, prev, versionMetaRecord(campos)));
}

/** El contenido de un archivo de texto, o null si no está (que no es lo mismo que vacío). */
function readTextFileOrNull(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// ── Prompt general del curso y prompt de secuencia ───────────────────
// El estilo del curso —marca, paleta, tipografía, tono— es del PROYECTO, no del
// localStorage de una máquina. Mientras vivió ahí, el segundo editor abría el
// mismo .prproj y generaba con el campo vacío: misma clase, mismo marcador,
// contexto distinto y animaciones peores, sin nada que se lo dijera.
//
// Dos archivos, un nivel cada uno:
//   <dir .prproj>/HyperPremiere/prompt-general.md               ← el del CURSO entero
//   <dir .prproj>/HyperPremiere/<secuencia>/prompt-secuencia.md ← el de ESA clase
//
// Los DOS viajan al modelo, y con la instrucción del marcador son los tres
// niveles del contexto que escribe el editor. El de la secuencia NO reemplaza
// al del curso: se le suma, y donde se contradigan manda el de la secuencia.
// Quién gana no se deduce acá ni lo elige el modelo: se le dice con todas las
// letras en el prompt (ver bridge/prompt/build-context.js).
//
// Es texto plano y no JSON a propósito: es prosa, y en un JSON las líneas se
// escaparían a "\n" — dejaría de ser un archivo que el editor puede abrir y
// arreglar a mano, que es medio punto de guardarlo al lado del proyecto.
const COURSE_PROMPT_FILE = 'prompt-general.md';
const SEQUENCE_PROMPT_FILE = 'prompt-secuencia.md';
// Cómo se llamaba el de la secuencia hasta la 1.4.51, cuando REEMPLAZABA al del
// curso: también `prompt-general.md`, adentro de la carpeta de la clase. Los
// proyectos que ya lo tienen siguen andando sin que nadie renombre nada: dentro
// de una carpeta de secuencia ese archivo siempre quiso decir "el de esta
// clase", que es exactamente el nivel nuevo. Se lee por el nombre viejo cuando
// no hay uno con el nuevo, y la primera vez que se guarda queda consolidado.
const SEQUENCE_PROMPT_FILE_LEGACY = 'prompt-general.md';

function generalPromptPaths(projectPath, sequenceName) {
  const seqDir = sequenceName ? outputDirPath(projectPath, sequenceName) : '';
  return {
    project: path.join(projectRootPath(projectPath), COURSE_PROMPT_FILE),
    sequence: seqDir ? path.join(seqDir, SEQUENCE_PROMPT_FILE) : '',
    sequenceLegacy: seqDir ? path.join(seqDir, SEQUENCE_PROMPT_FILE_LEGACY) : '',
  };
}

/** Borra un archivo si está. Nunca lanza: que no estuviera es el caso normal. */
function removeIfPresent(file) {
  if (!file) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

/**
 * Los dos niveles generales que le tocan a esta secuencia, cada uno por
 * separado.
 *
 * La respuesta es una sola para todos —el panel, el log y el prompt— porque la
 * pregunta que resolvió el bug es exactamente ésa: con qué contexto se generó.
 * Acá no se combina nada ni se elige un ganador: se devuelven los dos textos y
 * quien arma el pedido los manda juntos, con la precedencia escrita.
 */
function loadGeneralPrompt(body) {
  body = body || {};
  const vacio = { projectText: '', sequenceText: '', hasProjectFile: false, sequenceLegacy: false };
  try {
    const files = generalPromptPaths(body.projectPath, body.sequenceName);
    const projectRaw = readTextFileOrNull(files.project);
    let sequenceRaw = files.sequence ? readTextFileOrNull(files.sequence) : null;
    // El nombre viejo SOLO si no hay uno con el nuevo: el nuevo manda siempre,
    // así un proyecto a medio migrar no resucita un texto ya reemplazado.
    let sequenceLegacy = false;
    if (sequenceRaw == null && files.sequenceLegacy) {
      sequenceRaw = readTextFileOrNull(files.sequenceLegacy);
      sequenceLegacy = sequenceRaw != null;
    }
    return {
      ok: true,
      projectText: String(projectRaw == null ? '' : projectRaw).trim(),
      sequenceText: String(sequenceRaw == null ? '' : sequenceRaw).trim(),
      // Que el archivo del curso EXISTA aunque esté vacío es un dato: quiere
      // decir que el proyecto ya decidió que no hay estilo, y entonces no hay
      // nada que migrar desde el localStorage de una máquina.
      hasProjectFile: projectRaw != null,
      // El de esta clase todavía se llama como antes de la 1.5.0. Se lee igual;
      // se consolida solo, la próxima vez que se guarde.
      sequenceLegacy,
      paths: files,
    };
  } catch (e) {
    return Object.assign({ ok: false, error: (e && e.message) || String(e) }, vacio);
  }
}

/**
 * Escribe el prompt general del curso (`scope: 'project'`) o el de una
 * secuencia (`scope: 'sequence'`).
 *
 * Cada campo del panel escribe en su propio archivo y en ninguno más: vaciar el
 * de una clase la deja con el del curso y nada más, y no toca el del curso.
 *
 * Vaciar CUALQUIERA de los dos borra su archivo. El de la secuencia borra
 * además el del nombre viejo, porque si quedara, el texto que el editor acaba
 * de borrar volvería en la próxima lectura. El del curso se comportaba distinto
 * —dejaba un `prompt-general.md` de cero bytes— y esa asimetría no era gratis:
 * ese archivo vive en la raíz del proyecto, al lado del `.prproj`, así que viaja
 * a la máquina de los demás editores y aparece en su carpeta sin decir nada. Lo
 * que se pierde borrándolo es el matiz de "el proyecto DECIDIÓ que no hay
 * estilo" frente a "todavía nadie decidió", que solo lo miraba la migración del
 * localStorage (ver migrate() en cep/js/general-prompt.js): en una máquina que
 * nunca migró, vaciar el del curso deja que lo local suba en su lugar. Es un
 * caso angosto —hace falta un panel anterior a la 1.5.0 sobre un proyecto que
 * ya usó estos archivos—, se anuncia en el log cuando pasa y se deshace
 * vaciando el campo otra vez; basura que viaja con el proyecto, no.
 *
 * Vaciar tampoco crea la carpeta solo por eso: misma regla que la cola, abrir el
 * panel no deja carpetas por ahí.
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
      // `removed` es lo que el panel mira para dejar el campo vacío sin volver a
      // leer, y ahora lo contestan los dos niveles. `created: false` porque
      // después de esto NO hay archivo: es lo que la caché del panel anota como
      // "el proyecto no tiene el del curso".
      removeIfPresent(file);
      if (scope === 'sequence') removeIfPresent(files.sequenceLegacy);
      return { ok: true, path: file, scope, removed: true, created: false };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text ? text + '\n' : '', 'utf8');
    // Guardar con el nombre nuevo CONSOLIDA: el del viejo ya se leyó, y dejarlo
    // ahí sería un segundo archivo diciendo otra cosa.
    if (scope === 'sequence') removeIfPresent(files.sequenceLegacy);
    return { ok: true, path: file, scope };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// ── Referencias de los dos niveles generales ─────────────────────────
// La otra mitad de lo que el bloque "Estilo del curso" promete: si el texto
// viaja con el .prproj y las imágenes no, la caja miente en el mismo renglón
// donde dice "viaja con el .prproj". Dos carpetas, la misma geometría que los
// dos .md — la del curso arriba, la de la clase adentro de su carpeta. El I/O y
// el manifiesto están en references.js; acá se las ata a la convención de
// carpetas de este módulo, que es la única que sabe dónde vive cada nivel.
const referencesDirPath = referencias.makePaths(projectRootPath, outputDirPath);
const loadReferences = referencias.makeLoad(referencesDirPath);
const addReference = referencias.makeAdd(referencesDirPath);
const removeReference = referencias.makeRemove(referencesDirPath);
const setReferenceUse = referencias.makeSetUse(referencesDirPath);

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
 * Con qué nombre queda en disco un recurso adjunto.
 *
 * Vive acá y se exporta porque hay dos que necesitan la misma respuesta: el que
 * lo ESCRIBE (saveResources, abajo) y el que tiene que saber cómo va a viajar
 * SIN escribirlo (el estimado de tokens del motor). La extensión es justo lo que
 * decide si un documento se pega en el prompt —un `.md`, un `.txt`— o si solo
 * puede llegar por un agente que abra archivos, así que las dos respuestas
 * tienen que ser la misma antes y después de guardarlo. Un adjunto llamado
 * "notas" con media type text/markdown queda como `notas.md` en el disco: si el
 * estimado mirara el nombre pelado lo tomaría por binario y cobraría un fijo por
 * un documento que en realidad se pega entero.
 */
function resourceFileName(r, i) {
  const desde = r && typeof r.path === 'string' ? r.path.replace(/^file:\/\//, '') : '';
  const m = r && typeof r.dataUrl === 'string' ? /^data:([^;,]*);base64,/.exec(r.dataUrl) : null;
  const mime = (m && m[1]) || (r && r.mediaType) || '';
  let name = safeFileName((r && r.name) || (desde ? path.basename(desde) : ''));
  if (!name) name = `recurso-${String(i + 1).padStart(2, '0')}`;
  // Asegurar extensión: si el nombre no trae una, derivarla del media type.
  if (!/\.[a-z0-9]+$/i.test(name)) name += extForMime(mime);
  return name;
}

/**
 * Guarda recursos de referencia (PDFs, imágenes, docs) subidos por el editor al
 * lado de la render, para que la versión tenga en su carpeta lo que se le mandó.
 *
 * `resources` = [{ name, mediaType, dataUrl }] o [{ name, mediaType, path }].
 * Las dos formas conviven a propósito: lo que el editor arrastra a la tarjeta de
 * un marcador sigue siendo un data URL, y lo de los dos niveles generales ya es
 * un archivo en la carpeta del proyecto (ver references.js). Copiar el archivo
 * en vez de re-decodificarlo evita el viaje de ida y vuelta por base64 de un PDF
 * de varios MB, que era todo el punto de sacarlos del localStorage.
 *
 * Devuelve las rutas absolutas escritas. Best-effort: nunca lanza.
 */
function saveResources(resourcesDir, resources) {
  if (!Array.isArray(resources) || resources.length === 0) return [];
  fs.mkdirSync(resourcesDir, { recursive: true });
  const out = [];
  resources.forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    const desde = typeof r.path === 'string' ? r.path.replace(/^file:\/\//, '') : '';
    const m = typeof r.dataUrl === 'string' ? /^data:([^;,]*);base64,([\s\S]+)$/.exec(r.dataUrl) : null;
    if (!m && !desde) return;
    const filePath = path.join(resourcesDir, resourceFileName(r, i));
    try {
      if (m) fs.writeFileSync(filePath, Buffer.from(m[2].replace(/\s+/g, ''), 'base64'));
      else fs.copyFileSync(desde, filePath);
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
  writeVersionMeta,
  mergeVersionMeta,
  readTextFileOrNull,
  // El estilo del curso y el de la clase, que viajan con el .prproj en vez de
  // con la máquina que los escribió.
  generalPromptPaths,
  loadGeneralPrompt,
  saveGeneralPrompt,
  // Y sus referencias, que viajan por el mismo camino y por el mismo motivo.
  referencesDirPath,
  loadReferences,
  addReference,
  removeReference,
  setReferenceUse,
  lastCompositionHtml,
  saveStills,
  saveResources,
  resourceFileName,
};
