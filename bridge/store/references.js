// Las REFERENCIAS de los dos niveles generales —capturas, logos, PDFs, docs—
// guardadas como ARCHIVOS al lado del .prproj, no como base64 en el localStorage
// de una máquina.
//
// Es la otra mitad del cambio que puso el estilo del curso en el proyecto. El
// texto ya viajaba; las imágenes no, y el bloque de arriba prometía con todas
// las letras "viaja con el .prproj". Un manual de marca arrastrado al panel se
// quedaba en la máquina que lo arrastró, y el compañero generaba sin verlo — el
// mismo modo de falla mudo del prompt general, un escalón más abajo.
//
// Y el peso lo hacía urgente aparte de incorrecto: un cuadro de 1920×1080 en
// base64 pesa ~1,5 MB, el panel reescribía la entrada ENTERA del localStorage en
// cada tecleo del campo de texto (+1,6 ms por setItem) y el localStorage de CEP
// tiene un techo que al pasarse falla EN SILENCIO. Un archivo no tiene techo, no
// se reescribe por tipear, y se puede abrir con el Finder.
//
// Dos carpetas, un nivel cada una, con la misma geometría que los dos .md:
//   <dir .prproj>/HyperPremiere/_referencias/                ← las del CURSO
//   <dir .prproj>/HyperPremiere/<secuencia>/_referencias/    ← las de ESA clase
//
// ── Por qué hay un manifiesto y no alcanza con listar la carpeta ─────
//
// De cada referencia hay que saber tres cosas que un archivo suelto no dice: en
// qué ORDEN va (el prompt las numera "imagen 1, imagen 2…" y el editor las
// nombra así en su instrucción), si es una imagen o un documento, y si está
// marcada "✓ usar" —o sea, si se INCRUSTA en el gráfico o solo se mira—. Nada de
// eso cabe en un nombre de archivo sin inventar una convención que después haya
// que defender.
//
// El manifiesto (`referencias.json`) lleva esas tres, y la carpeta manda sobre
// él en lo único que puede: un archivo que el manifiesto nombra y no está se
// reporta como faltante (disco desmontado, alguien lo borró a mano) y un archivo
// que está y el manifiesto no nombra se ADOPTA al final de la lista, como
// referencia. Eso último es a propósito: la carpeta viaja al lado del .prproj y
// alguien va a soltarle un PNG desde el Finder. Que no aparezca en el panel
// sería, otra vez, una carpeta que promete y no cumple.

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = '_referencias';
const MANIFEST = 'referencias.json';

// Qué extensiones se tratan como IMAGEN (las que el modelo puede mirar) y no
// como documento. Es la misma lista que sabe leer stillToDataUrl en engine.js.
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

/** El manifiesto no se muestra como referencia: es la contabilidad, no material. */
function esManifiesto(name) {
  return String(name).toLowerCase() === MANIFEST;
}

function esImagen(name, mediaType) {
  return IMAGE_EXT.test(String(name || '')) || /^image\//i.test(String(mediaType || ''));
}

function mimeDe(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
    '.csv': 'text/csv', '.json': 'application/json',
  };
  return map[ext] || '';
}

/**
 * Un nombre de archivo seguro y ÚNICO dentro de `dir`.
 *
 * Único porque dos capturas del programa del mismo día se llaman igual y la
 * segunda se comía a la primera sin que nada fallara: el panel mostraba dos
 * miniaturas y el disco tenía un archivo. Se desempata con un sufijo `-2`, que
 * es lo que hace cualquier carpeta de descargas.
 */
function nombreLibre(dir, name) {
  const limpio = String(name || '')
    .replace(/[\/\\:*?"<>|\x00-\x1f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'referencia';
  const ext = path.extname(limpio);
  const base = ext ? limpio.slice(0, -ext.length) : limpio;
  let intento = limpio;
  let n = 1;
  while (fs.existsSync(path.join(dir, intento))) {
    n += 1;
    intento = base + '-' + n + ext;
  }
  return intento;
}

/**
 * Dónde van las referencias de cada nivel. `sequenceName` vacío = las del curso.
 *
 * Se recibe `outputDirPath`/`projectRootPath` en vez de importarlos porque este
 * módulo lo carga project-fs, que es quien los define: al revés serían dos
 * requires circulares por una función de una línea.
 */
function makePaths(projectRootPath, outputDirPath) {
  return function referencesDirPath(projectPath, sequenceName) {
    const raiz = sequenceName
      ? outputDirPath(projectPath, sequenceName)
      : projectRootPath(projectPath);
    return path.join(raiz, DIR);
  };
}

/** El manifiesto tal cual está en el disco. [] si no hay o está corrupto. */
function leerManifiesto(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, MANIFEST), 'utf8');
    const data = JSON.parse(raw);
    const items = Array.isArray(data) ? data : (data && data.items);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function escribirManifiesto(dir, items) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, MANIFEST),
    JSON.stringify({ version: 1, items }, null, 2),
    'utf8'
  );
}

/**
 * Las referencias de UNA carpeta, en orden, con lo que hoy hay en el disco.
 *
 * `missing: true` es un archivo que el manifiesto nombra y no está. No se
 * saltea: el panel tiene que poder decir "esta referencia no la puedo leer" en
 * vez de dibujar una lista más corta sin explicación (el proyecto en un disco
 * externo desmontado es el caso, y el modelo diseñaría sin ella).
 */
function listar(dir) {
  let enDisco = [];
  try {
    enDisco = fs.readdirSync(dir).filter((f) => !esManifiesto(f));
  } catch {
    return [];
  }
  const vistos = {};
  const out = [];

  leerManifiesto(dir).forEach((it) => {
    const file = String((it && it.file) || '');
    if (!file || vistos[file]) return;
    vistos[file] = true;
    const abs = path.join(dir, file);
    let bytes = 0;
    let missing = false;
    try { bytes = fs.statSync(abs).size; } catch { missing = true; }
    const name = String((it && it.name) || file);
    const mediaType = String((it && it.mediaType) || mimeDe(file));
    out.push({
      file: abs,
      fileName: file,
      name,
      mediaType,
      kind: esImagen(file, mediaType) ? 'image' : 'doc',
      use: !!(it && it.use),
      bytes,
      missing,
    });
  });

  // Lo que alguien dejó en la carpeta a mano. Va al final y como referencia: no
  // se puede adivinar en qué orden lo quería ni si se incrusta, pero esconderlo
  // sería una carpeta que viaja con el proyecto y no se ve en el panel.
  enDisco.forEach((file) => {
    if (vistos[file]) return;
    const abs = path.join(dir, file);
    let bytes = 0;
    try { bytes = fs.statSync(abs).size; } catch { return; }
    const mediaType = mimeDe(file);
    out.push({
      file: abs, fileName: file, name: file, mediaType,
      kind: esImagen(file, mediaType) ? 'image' : 'doc',
      use: false, bytes, missing: false, adopted: true,
    });
  });

  return out;
}

/** El manifiesto que le corresponde a una lista ya resuelta. */
function aManifiesto(items) {
  return items.map((it) => ({
    file: it.fileName,
    name: it.name,
    mediaType: it.mediaType,
    use: !!it.use,
  }));
}

/**
 * Los DOS niveles de este contexto, cada uno por separado.
 *
 * Igual que loadGeneralPrompt: acá no se combina nada ni se elige un ganador.
 * Los dos viajan, y quien arma el pedido los pone en orden.
 *
 * Sin `sequenceName` la lista de la secuencia viene vacía y su ruta también: es
 * el panel sin secuencia abierta, donde ese bloque directamente no se ofrece.
 */
function makeLoad(referencesDirPath) {
  return function loadReferences(body) {
    body = body || {};
    try {
      const cursoDir = referencesDirPath(body.projectPath, '');
      const seqDir = body.sequenceName ? referencesDirPath(body.projectPath, body.sequenceName) : '';
      return {
        ok: true,
        course: listar(cursoDir),
        sequence: seqDir ? listar(seqDir) : [],
        paths: { course: cursoDir, sequence: seqDir },
      };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e), course: [], sequence: [] };
    }
  };
}

/** La carpeta del nivel que pide el cuerpo del pedido. '' si no se puede saber. */
function dirDe(referencesDirPath, body) {
  const scope = body.scope === 'sequence' ? 'sequence' : 'course';
  if (scope === 'sequence' && !body.sequenceName) return '';
  return referencesDirPath(body.projectPath, scope === 'sequence' ? body.sequenceName : '');
}

/**
 * Agrega una referencia al nivel que se pida, desde un data URL (lo que
 * arrastró el editor) o desde una RUTA que ya está en el disco (una captura del
 * programa, o la migración de lo que había en el localStorage).
 *
 * Devuelve la lista ENTERA del nivel, ya releída: el panel no tiene que
 * reconstruirla ni adivinar qué nombre le tocó al archivo cuando hubo que
 * desempatar.
 */
function makeAdd(referencesDirPath) {
  return function addReference(body) {
    body = body || {};
    const dir = dirDe(referencesDirPath, body);
    if (!dir) return { ok: false, error: 'para guardar una referencia de secuencia hace falta su nombre' };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const pedido = String(body.name || '').trim();
      const desde = String(body.path || '').replace(/^file:\/\//, '');
      let datos = null;
      let mimeDado = '';

      if (typeof body.dataUrl === 'string' && body.dataUrl) {
        const m = /^data:([^;,]*);base64,([\s\S]+)$/.exec(body.dataUrl);
        if (!m) return { ok: false, error: 'la referencia no vino en un formato que se pueda guardar' };
        datos = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
        if (!datos.length) return { ok: false, error: 'la referencia vino vacía' };
        mimeDado = m[1] || String(body.mediaType || '');
      } else if (desde) {
        if (!fs.existsSync(desde)) return { ok: false, error: 'no existe el archivo: ' + desde };
      } else {
        return { ok: false, error: 'no vino ni el contenido ni la ruta de la referencia' };
      }

      let nombre = pedido || (desde ? path.basename(desde) : 'referencia');
      const mediaType = String(body.mediaType || mimeDado || mimeDe(nombre) || '');
      // Sin extensión el modelo (y el Finder) no saben qué abrir.
      if (!/\.[a-z0-9]+$/i.test(nombre)) {
        const ext = path.extname(desde || '') || extDe(mediaType);
        if (ext) nombre += ext;
      }
      const file = nombreLibre(dir, nombre);
      const abs = path.join(dir, file);
      if (datos) fs.writeFileSync(abs, datos);
      else fs.copyFileSync(desde, abs);

      const items = listar(dir);
      // `listar` lo adoptó al final (todavía no está en el manifiesto): se lo
      // anota con el nombre y la etiqueta que pidió quien lo agregó.
      const nuevo = items.find((it) => it.fileName === file);
      if (nuevo) {
        nuevo.name = pedido || nombre;
        nuevo.mediaType = mediaType || nuevo.mediaType;
        nuevo.kind = esImagen(file, nuevo.mediaType) ? 'image' : 'doc';
        nuevo.use = !!body.use;
        delete nuevo.adopted;
      }
      escribirManifiesto(dir, aManifiesto(items));
      return { ok: true, path: abs, dir, items: listar(dir) };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  };
}

function extDe(mime) {
  const map = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md',
    'text/csv': '.csv', 'application/json': '.json',
  };
  return map[String(mime || '').toLowerCase()] || '';
}

/**
 * Saca una referencia de un nivel: se borra el archivo y se reescribe el
 * manifiesto.
 *
 * Se borra el archivo de verdad, y no solo el renglón del manifiesto, porque la
 * carpeta viaja con el .prproj: un archivo huérfano ahí adentro le aparece al
 * compañero en el Finder sin querer decir nada, y encima `listar` lo adoptaría
 * de vuelta en la próxima lectura — la referencia que el editor sacó volvería
 * sola, que es exactamente el modo de falla del prompt-general.md viejo.
 */
function makeRemove(referencesDirPath) {
  return function removeReference(body) {
    body = body || {};
    const dir = dirDe(referencesDirPath, body);
    if (!dir) return { ok: false, error: 'para quitar una referencia de secuencia hace falta su nombre' };
    try {
      const items = listar(dir);
      const i = parseInt(body.index, 10);
      if (isNaN(i) || i < 0 || i >= items.length) return { ok: true, items };
      const [fuera] = items.splice(i, 1);
      try { fs.unlinkSync(fuera.file); } catch { /* ya no estaba */ }
      escribirManifiesto(dir, aManifiesto(items));
      return { ok: true, items: listar(dir) };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  };
}

/** Marca una referencia como "✓ usar" (se incrusta) o como referencia a secas. */
function makeSetUse(referencesDirPath) {
  return function setReferenceUse(body) {
    body = body || {};
    const dir = dirDe(referencesDirPath, body);
    if (!dir) return { ok: false, error: 'para etiquetar una referencia de secuencia hace falta su nombre' };
    try {
      const items = listar(dir);
      const i = parseInt(body.index, 10);
      if (isNaN(i) || i < 0 || i >= items.length) return { ok: true, items };
      items[i].use = !!body.use;
      escribirManifiesto(dir, aManifiesto(items));
      return { ok: true, items: listar(dir) };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  };
}

module.exports = { makePaths, makeLoad, makeAdd, makeRemove, makeSetUse, DIR, MANIFEST };
