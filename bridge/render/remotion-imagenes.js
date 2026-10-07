'use strict';

// DÓNDE TIENEN QUE ESTAR las imágenes que incrusta una composición de Remotion.
//
// El modelo las pide con `staticFile("assets/NOMBRE")` (ver `bloqueDeAssets` en
// motor-remotion.js), y `staticFile` no resuelve contra la raíz del servidor
// sino contra `window.remotion_staticBase`. En el bundle del render eso es
// "/public" —lo escribe @remotion/bundler en el index.html—, y en Studio, la
// carpeta `public/` del proyecto. O sea que en los dos casos van en
// `<raíz>/public/assets/`, y por eso la regla vive en un solo lugar.
//
// Hasta la 1.8.0 el render del panel las copiaba a `<raíz>/assets/`. Ningún
// render falló —`<Img>` no tira cuando no encuentra el archivo—: el logo que el
// editor había pedido incrustar simplemente no salía. Medido con una imagen
// roja de 200×120 en el centro del cuadro: el píxel del centro salía
// transparente; copiada acá, sale rojo.

const fs = require('fs');
const path = require('path');

function carpetaDeImagenes(raiz) {
  return path.join(raiz, 'public', 'assets');
}

/**
 * Deja en `<raiz>/public/assets/` exactamente las imágenes de `assetsDir`, y
 * devuelve cuántas copió.
 *
 * Vacía la carpeta antes de copiar. En el render no cambia nada (cada render
 * arma la suya), pero en Studio la carpeta es UNA para todos los marcadores y
 * todos llaman a sus imágenes igual (`asset-01.png`): lo que quedara del
 * marcador anterior se vería en éste, y con el render de Studio entraría a
 * Premiere.
 */
function copiarImagenes(assetsDir, raiz) {
  const destino = carpetaDeImagenes(raiz);
  fs.rmSync(destino, { recursive: true, force: true });
  fs.mkdirSync(destino, { recursive: true });
  if (!assetsDir || !fs.existsSync(assetsDir)) return 0;
  let n = 0;
  for (const nombre of fs.readdirSync(assetsDir)) {
    const origen = path.join(assetsDir, nombre);
    try {
      if (!fs.statSync(origen).isFile()) continue;
      fs.copyFileSync(origen, path.join(destino, nombre));
      n++;
    } catch (e) {
      // Una imagen que no se puede leer no frena a las otras.
    }
  }
  return n;
}

module.exports = { carpetaDeImagenes, copiarImagenes };
