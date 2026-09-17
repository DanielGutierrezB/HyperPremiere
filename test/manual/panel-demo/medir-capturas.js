#!/usr/bin/env node
'use strict';

// ¿Cuánto mide la lista, en las capturas que ya están?
//
//   node test/manual/panel-demo/medir-capturas.js antes-cola-400 despues-cola-400
//
// Existe por un motivo puntual y honesto: el antes de la etapa 3 no se puede
// volver a medir con `auditar.js` porque ese código no está en ningún commit —
// las tres etapas de la 1.6.0 se hicieron sobre el árbol sucio—. Lo único que
// queda del antes son las capturas, y una captura sí se puede medir: se abre el
// PNG en un `<canvas>` y se busca la ÚLTIMA fila de píxeles que no es el fondo
// del panel, que es donde termina el contenido.
//
// El número que da es "cuánto ocupa todo lo que la pestaña dibuja", con los
// mismos datos falsos y el mismo ancho en las dos fotos. No reemplaza a
// `auditar.js` (que mide fila por fila sobre el DOM): sirve para comparar dos
// estados cuando uno de los dos ya no existe.

const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..', '..', '..');
const puppeteer = require(path.join(RAIZ, 'bridge', 'node_modules', 'puppeteer-core'));
const CHROME = process.env.HP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DIR = path.join(__dirname, 'capturas-1.6.0');

const nombres = process.argv.slice(2);
if (!nombres.length) {
  console.error('Pasá los nombres de las capturas (sin .png), ej: antes-cola-400 despues-cola-400');
  process.exit(1);
}

/** Corre dentro de la página: el alto útil del PNG, en px de CSS. */
const MEDIR = function (o) {
  return new Promise(function (resolve, reject) {
    const img = new Image();
    img.onerror = function () { reject(new Error('no pude abrir la imagen')); };
    img.onload = function () {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      // El fondo del panel es `--bg-base` (#0f1115). Se admite cualquier píxel a
      // menos de 6 de distancia en los tres canales: el PNG está a escala 2 y el
      // antialias del texto deja bordes intermedios.
      const esFondo = function (i) {
        return Math.abs(d[i] - 15) < 7 && Math.abs(d[i + 1] - 17) < 7 && Math.abs(d[i + 2] - 21) < 7;
      };
      // La franja de abajo (la línea de estado del panel y el sello de la maqueta)
      // no es parte de la lista: se recorta un 12 % del alto.
      const hasta = Math.floor(c.height * 0.88);
      let ultima = 0;
      for (let y = 0; y < hasta; y++) {
        let pintados = 0;
        for (let x = 0; x < c.width; x++) {
          if (!esFondo((y * c.width + x) * 4)) pintados++;
        }
        // Una fila cuenta como "contenido" si tiene algo más que un par de
        // píxeles sueltos: así el borde del scroll o un artefacto no la salvan.
        if (pintados > c.width * 0.04) ultima = y;
      }
      resolve({ alto: c.height, escala: img.width / o.ancho, contenidoHasta: ultima });
    };
    img.src = o.src;
  });
};

(async function () {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.goto('about:blank');
  for (const n of nombres) {
    const f = path.join(DIR, n + '.png');
    if (!fs.existsSync(f)) { console.log('  ??   ' + n + ': no está'); continue; }
    const ancho = Number((n.match(/-(\d+)$/) || [])[1]) || 400;
    const src = 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
    const r = await page.evaluate(MEDIR, { src: src, ancho: ancho });
    console.log('  ' + n.padEnd(34) + ' contenido hasta ' +
      String(Math.round(r.contenidoHasta / r.escala)).padStart(5) + ' px de CSS' +
      '  (imagen ' + r.alto + ' px a escala ' + r.escala + ')');
  }
  await browser.close();
})().catch(function (e) { console.error(e); process.exit(1); });
