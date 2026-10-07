// El proceso que EMPAQUETA y RENDERIZA con Remotion.
//
// Corre aparte del motor del panel, y no por prolijidad: `@remotion/renderer`
// levanta un Chrome, webpack y sus workers, y todo eso adentro del proceso Node
// que vive dentro de Premiere es pedir que un pico de memoria del render se
// lleve puesto el panel. Con un hijo, lo peor que puede pasar es que el hijo
// muera y el panel lo cuente.
//
// Es el mismo trato que el motor de HyperFrames, que también renderiza en un
// proceso aparte (su CLI). La diferencia es que acá el hijo es código nuestro,
// así que el protocolo con el padre lo elegimos: una línea de JSON por evento
// en stdout.
//
// Uso:  node remotion-worker.js <archivo-de-pedido.json>
//
// El pedido viaja por ARCHIVO y no por argv porque adentro va el código
// completo de la composición, que son decenas de KB: los límites de tamaño de
// la línea de comandos son bajos en Windows y esto es exactamente el caso donde
// se tocan.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { copiarImagenes } = require('./remotion-imagenes');

/** Una línea de JSON a stdout. El padre la lee y la traduce al panel. */
function decir(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Copia un directorio completo (el bundle es chico: JS + html). */
function copiarDir(origen, destino) {
  fs.mkdirSync(destino, { recursive: true });
  for (const e of fs.readdirSync(origen, { withFileTypes: true })) {
    const a = path.join(origen, e.name);
    const b = path.join(destino, e.name);
    if (e.isDirectory()) copiarDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

/** Huella del proyecto huésped: cambia cuando cambia el código que lo arma. */
function huellaDelHuesped(dirInstalacion, version) {
  const h = crypto.createHash('sha256');
  h.update(String(version));
  const src = path.join(dirInstalacion, 'src');
  for (const f of fs.readdirSync(src).sort()) {
    h.update(f);
    h.update(fs.readFileSync(path.join(src, f)));
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * El bundle de webpack, hecho UNA vez y reusado.
 *
 * Empaquetar tarda entre varios segundos y medio minuto. Hacerlo por clip sería
 * pagarlo veinte veces en una clase de veinte marcadores, siempre para producir
 * exactamente el mismo bundle: lo único que cambia entre un render y el
 * siguiente es el código del modelo, y eso viaja por `inputProps`.
 *
 * La llave del caché es la huella del proyecto huésped más la versión de
 * Remotion. Así, actualizar el panel (que cambia `src/`) o Remotion invalida el
 * caché solo, sin que nadie se acuerde de borrarlo a mano.
 */
async function bundleCacheado(dirInstalacion, version) {
  const huella = huellaDelHuesped(dirInstalacion, version);
  const destino = path.join(dirInstalacion, 'bundle-' + huella);
  const listo = path.join(destino, 'index.html');
  if (fs.existsSync(listo)) return destino;

  decir({ pct: 8, msg: 'Preparando el proyecto de Remotion (solo la primera vez)…' });
  const { bundle } = require(path.join(dirInstalacion, 'node_modules', '@remotion', 'bundler'));
  const salida = await bundle({
    entryPoint: path.join(dirInstalacion, 'src', 'index.ts'),
    outDir: destino,
    onProgress: (p) => {
      decir({ pct: 8 + Math.round((Number(p) || 0) * 0.3), msg: 'Empaquetando el proyecto… ' + Math.round(Number(p) || 0) + '%' });
    },
  });

  // Los bundles viejos (de otra versión del panel) quedan ocupando disco para
  // siempre si nadie los saca: se limpian acá, que es el único momento en que
  // se sabe cuál es el que vale.
  try {
    for (const e of fs.readdirSync(dirInstalacion)) {
      if (/^bundle-/.test(e) && e !== path.basename(destino)) {
        fs.rmSync(path.join(dirInstalacion, e), { recursive: true, force: true });
      }
    }
  } catch (e) { /* limpiar es opcional */ }

  return salida;
}

async function main() {
  const pedidoPath = process.argv[2];
  if (!pedidoPath) throw new Error('remotion-worker: falta la ruta del pedido');
  const pedido = JSON.parse(fs.readFileSync(pedidoPath, 'utf8'));

  const dir = pedido.dirInstalacion;
  const renderer = require(path.join(dir, 'node_modules', '@remotion', 'renderer'));

  const bundleDir = await bundleCacheado(dir, pedido.versionRemotion);

  // El servidor del render se sirve de una COPIA del bundle, no del bundle.
  // Las imágenes a incrustar se llaman igual en todos los marcadores
  // (`asset-01.png`), así que con los carriles de render en paralelo dos clips
  // distintos estarían escribiendo y leyendo el mismo archivo. Copiar el bundle
  // cuesta milisegundos y le da a cada render su propio `assets/`.
  const trabajo = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperpremiere-remotion-'));
  const serveDir = path.join(trabajo, 'serve');
  copiarDir(bundleDir, serveDir);

  // Debajo de `public/`, que es donde las busca `staticFile` (ver
  // remotion-imagenes.js: hasta la 1.8.0 se copiaban a la raíz y no salían).
  copiarImagenes(pedido.assetsDir, serveDir);

  const inputProps = {
    codigoJs: pedido.codigoJs,
    conFondo: !!pedido.conFondo,
    duracionEnCuadros: pedido.duracionEnCuadros,
  };

  decir({ pct: 45, msg: 'Leyendo la composición…' });
  const composicion = await renderer.selectComposition({
    serveUrl: serveDir,
    id: 'marcador',
    inputProps,
  });

  // Con fondo: H.264 opaco, igual que el otro motor (mismo CRF de lectura).
  // Sin fondo: ProRes 4444, que es el único perfil de ProRes que lleva alpha.
  // Los CUATRO ajustes del alpha van juntos y ninguno es opcional: con
  // `imageFormat: 'jpeg'` (el default) el canal se pierde ANTES de encodear y
  // el .mov sale con fondo negro, sin ningún error de por medio.
  const conFondo = !!pedido.conFondo;
  const opciones = conFondo
    ? { codec: 'h264', crf: 18 }
    : { codec: 'prores', proResProfile: '4444', imageFormat: 'png', pixelFormat: 'yuva444p10le' };

  decir({ pct: 50, msg: conFondo ? 'Renderizando video HD (con fondo)…' : 'Renderizando el video con alpha…' });
  await renderer.renderMedia(Object.assign({
    composition: composicion,
    serveUrl: serveDir,
    outputLocation: pedido.outPath,
    inputProps,
    concurrency: pedido.workers || null,
    onProgress: ({ progress, renderedFrames }) => {
      const pct = 55 + Math.round((Number(progress) || 0) * 35);
      decir({ pct: pct, msg: 'Renderizando fotograma ' + renderedFrames + '/' + composicion.durationInFrames + '…' });
    },
  }, opciones));

  try { fs.rmSync(trabajo, { recursive: true, force: true }); } catch (e) {}
  decir({ ok: true });
}

main().catch((e) => {
  decir({ error: (e && e.stack) || (e && e.message) || String(e) });
  process.exit(1);
});
