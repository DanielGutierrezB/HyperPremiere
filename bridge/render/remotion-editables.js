'use strict';

// EL ARCHIVO DE REMOTION, de verdad: el que el editor abre y edita.
//
// ── Qué resuelve ─────────────────────────────────────────────────────
//
// Studio mostraba la animación desde un texto metido en sus props: no había
// archivo que abrir, y lo que se abría —el envoltorio del proyecto— no era la
// animación. El editor lo pidió así: "debería ser el archivo de remotion como
// tal, así lo edito como quiera". Ahora cada marcador que se abre en Studio
// tiene su `.tsx` en `marcadores/<secuencia>/<marcador>.tsx`, Studio corre ESE
// archivo (ver remotion-host/src/RaizStudio.tsx), lo que se guarda ahí se ve al
// momento, y el botón Render de Studio guarda como versión lo que haya en él.
//
// ── Por qué adentro de la instalación y no al lado de las versiones ──
//
// Un `.tsx` suelto en la carpeta del proyecto de Premiere no encuentra sus
// imports: webpack resuelve `react` y `remotion` por alias, pero el resto
// (`@remotion/transitions`, las fuentes) lo busca subiendo carpetas desde el
// archivo, y ahí no hay `node_modules`. El editor de código tampoco: sin
// `tsconfig` ni tipos cerca, lo pinta entero de rojo. Adentro de la
// instalación (`~/.hyperpremiere/remotion/marcadores/`) andan las dos cosas.
// Por lo mismo el tsconfig del huésped incluye `marcadores/` y no es estricto:
// no hay tipos de React instalados, y en modo estricto el editor marcaría como
// error cada etiqueta de JSX de un código que compila bien.
//
// Y fuera de `src/`, que no es un detalle: el render del panel arma la huella
// de su bundle con los archivos de `src/` (ver remotion-worker.js). Con los
// marcadores ahí, cada edición obligaría a re-empaquetar.
//
// ── No perder lo que el editor escribió ─────────────────────────────
//
// El archivo es UNO por marcador y lo escriben dos: el panel, con el código de
// una versión, y el editor. Para que lo primero no pise lo segundo se anota,
// por archivo, de qué versión salió y la firma de lo último que escribió el
// panel. Si el contenido ya no tiene esa firma, alguien lo editó, y entonces:
//
//   - abrir la MISMA versión de la que salió lo deja como está: es volver a
//     Studio a seguir editando;
//   - abrir OTRA (hay una más nueva, o el código viene del editor del panel)
//     guarda primero lo editado en `respaldos/`, y recién ahí lo reemplaza.
//
// Un render de Studio cuenta como escrito por el panel (ver `alGuardarVersion`):
// lo que había en el archivo ya es una versión, así que no hay nada que
// respaldar.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ESTADO = '.estado.json';
const ABIERTO = 'abierto.ts';

function carpeta(raiz) {
  return path.join(raiz, 'marcadores');
}

function firma(texto) {
  return crypto.createHash('sha1').update(String(texto)).digest('hex');
}

/**
 * Un nombre que sirva de archivo en los dos sistemas y de ruta de import.
 *
 * Saca lo que Windows no acepta, y además lo que webpack lee como otra cosa
 * en una ruta: `?` y `#` la cortan, `!` separa loaders, `%` se decodifica.
 */
function limpio(nombre, siVacio) {
  let s = String(nombre || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*#!%\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 60) s = s.slice(0, 60).trim();
  // Windows no deja que un nombre termine en punto o en espacio.
  s = s.replace(/[. ]+$/, '');
  if (!s) s = siVacio;
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s += '_';
  return s;
}

/**
 * Dónde vive el archivo de un marcador.
 *
 * Dos proyectos pueden tener cada uno su "Clase 3" con su "Marcador 1": el
 * pedazo de firma es del proyecto y la secuencia, y es lo que los separa. El
 * nombre del archivo queda limpio a propósito, porque es lo que el editor ve en
 * la pestaña de su editor.
 */
function rutaDelArchivo(raiz, m) {
  const h = firma(String(m.projectPath || '') + '\n' + String(m.sequenceName || '')).slice(0, 6);
  const secuencia = limpio(m.sequenceName, 'secuencia') + ' - ' + h;
  return path.join(carpeta(raiz), secuencia, limpio(m.markerSlug, 'marcador') + '.tsx');
}

function clave(raiz, archivo) {
  return path.relative(carpeta(raiz), archivo).split(path.sep).join('/');
}

function leerEstado(raiz) {
  try {
    return JSON.parse(fs.readFileSync(path.join(carpeta(raiz), ESTADO), 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

function guardarEstado(raiz, estado) {
  fs.mkdirSync(carpeta(raiz), { recursive: true });
  fs.writeFileSync(path.join(carpeta(raiz), ESTADO), JSON.stringify(estado, null, 2), 'utf8');
}

/** El contenido del archivo, o null si no existe. */
function leer(archivo) {
  try {
    return fs.readFileSync(archivo, 'utf8');
  } catch (e) {
    return null;
  }
}

function sello(ahora) {
  const d = ahora || new Date();
  const dos = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + dos(d.getMonth() + 1) + '-' + dos(d.getDate()) + ' ' +
    dos(d.getHours()) + '.' + dos(d.getMinutes()) + '.' + dos(d.getSeconds());
}

function respaldar(archivo, contenido, ahora) {
  const dir = path.join(path.dirname(archivo), 'respaldos');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(archivo, '.tsx') + ' (sin renderizar, ' + sello(ahora) + ')';
  let destino = path.join(dir, base + '.tsx');
  for (let n = 2; fs.existsSync(destino); n++) destino = path.join(dir, base + ' ' + n + '.tsx');
  fs.writeFileSync(destino, contenido, 'utf8');
  return destino;
}

/**
 * Deja el archivo de un marcador listo para que Studio lo muestre, sin perder
 * lo que el editor le haya escrito (ver la cabecera).
 *
 * `pedido` = `{ projectPath, sequenceName, markerSlug, version, codigo,
 * explicito }`. `explicito` = el código lo mandó el editor del panel a
 * propósito, así que gana aunque el archivo tenga cambios de la misma versión.
 *
 * Devuelve `{ archivo, accion, respaldo, base }`, con `accion` una de:
 * `nuevo`, `igual`, `actualizado` (no tenía cambios del editor),
 * `conservado` (los tenía, sobre esta misma versión, y quedan) o `respaldado`
 * (los tenía sobre otra, y quedaron en `respaldo`).
 */
function preparar(raiz, pedido, ahora) {
  const archivo = rutaDelArchivo(raiz, pedido);
  const codigo = String(pedido.codigo || '');
  const version = Number(pedido.version) || 0;
  const estado = leerEstado(raiz);
  const k = clave(raiz, archivo);
  const anotado = estado[k] || null;
  const actual = leer(archivo);

  let accion;
  if (actual === null) accion = 'nuevo';
  else if (actual === codigo) accion = 'igual';
  else if (anotado && firma(actual) === anotado.firma) accion = 'actualizado';
  else if (!pedido.explicito && anotado && anotado.base === version) accion = 'conservado';
  else accion = 'respaldado';

  if (accion === 'conservado') return { archivo, accion, respaldo: '', base: anotado.base };

  // Sin anotación y con algo adentro también se respalda: no se sabe de dónde
  // salió, y lo único seguro con algo que no se sabe de dónde salió es no
  // perderlo.
  const respaldo = accion === 'respaldado' ? respaldar(archivo, actual, ahora) : '';
  if (accion !== 'igual') {
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo, codigo, 'utf8');
  }
  estado[k] = {
    projectPath: pedido.projectPath || '', sequenceName: pedido.sequenceName || '',
    markerSlug: pedido.markerSlug || '', base: version, firma: firma(codigo),
  };
  guardarEstado(raiz, estado);
  return { archivo, accion, respaldo, base: version };
}

/**
 * Hace que Studio muestre este archivo: reescribe `marcadores/abierto.ts`, que
 * es lo que importa RaizStudio.tsx. Solo si cambia —reescribirlo igual haría
 * recompilar a webpack por nada—. Devuelve si cambió.
 *
 * Lo que el editor le haya cambiado a este archivo mientras Studio mostraba
 * otro no lo vio el vigilante de webpack; que igual se vea al volver lo
 * resuelve remotion.config.ts.
 */
function apuntar(raiz, archivo) {
  const ruta = './' + clave(raiz, archivo).replace(/\.tsx$/, '');
  const texto =
    '// Lo escribe el panel: es el marcador que Studio está mostrando ahora.\n' +
    '// No lo edites; el que se edita es el archivo que importa.\n' +
    'export {default} from ' + JSON.stringify(ruta) + ';\n';
  const donde = path.join(carpeta(raiz), ABIERTO);
  if (leer(donde) === texto) return false;
  fs.mkdirSync(carpeta(raiz), { recursive: true });
  fs.writeFileSync(donde, texto, 'utf8');
  return true;
}

/**
 * Un render de Studio quedó guardado como `version` con este `codigo`: desde
 * ahí, el archivo sale de esa versión y no tiene nada sin renderizar (salvo lo
 * que el editor siga escribiendo después).
 */
function alGuardarVersion(raiz, archivo, version, codigo) {
  const estado = leerEstado(raiz);
  const k = clave(raiz, archivo);
  estado[k] = Object.assign({}, estado[k] || {}, { base: Number(version) || 0, firma: firma(codigo) });
  guardarEstado(raiz, estado);
}

module.exports = { carpeta, rutaDelArchivo, preparar, apuntar, alGuardarVersion, leer };
