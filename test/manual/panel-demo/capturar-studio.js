#!/usr/bin/env node
'use strict';

// «Abrir Remotion» en la ficha de un marcador hecho con Remotion.
//
//   node test/manual/panel-demo/abrir.js --no-open &
//   node test/manual/panel-demo/capturar-studio.js
//
// Deja los PNG en `capturas-1.9.0/` con prefijo `studio-`. Lo que se viene a
// mirar es lo que un test no contesta: que el botón esté A LA VISTA en la fila
// de acciones —el problema era que vivía plegado adentro de "Avanzado"—, que a
// 320 px la fila no se rompa, y que el renglón de estado diga qué va a pasar
// con el Render de Studio.
//
// Si la página tira un error de JS, esto FALLA en vez de sacar una foto de un
// panel roto.

const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..', '..', '..');
const puppeteer = require(path.join(RAIZ, 'bridge', 'node_modules', 'puppeteer-core'));
const CHROME = process.env.HP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(n, d) { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; }

const BASE = arg('--base', 'http://localhost:4599/');
const SALIDA = arg('--salida', path.join(__dirname, 'capturas-1.9.0'));
const ALTO = Number(arg('--alto', 760));
const ANCHOS = arg('--anchos', '400,320').split(',').map(Number);
const FICHA = 'Intro / placa de título';

const TOMAS = [
  { n: 'ficha', escenario: '?e=remotion', que: 'la ficha de un marcador de Remotion: «Abrir Remotion» en la fila de acciones' },
  { n: 'abierto', escenario: '?e=remotion', abrir: true, que: 'después de apretarlo: qué va a pasar con el Render de Studio' },
  { n: 'hyperframes', escenario: '', que: 'un marcador de HyperFrames: el botón no aparece' },
];

/** Corre dentro de la página. */
const GUION = async function (g) {
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const fichas = [].slice.call(document.querySelectorAll('details.marker-card'));
  const suya = fichas.filter((d) => (d.textContent || '').indexOf(g.ficha) !== -1)[0];
  if (!suya) throw new Error('no encontré la ficha de ' + g.ficha);
  fichas.forEach((d) => { d.open = false; });
  suya.open = true;
  await esperar(900);
  const boton = [].slice.call(suya.querySelectorAll('button'))
    .filter((b) => (b.textContent || '').trim() === 'Abrir Remotion')[0];
  const visible = !!boton && boton.style.display !== 'none';
  if (g.abrir) {
    if (!visible) throw new Error('la ficha no muestra «Abrir Remotion»');
    boton.click();
    await esperar(900);
  }
  const pie = suya.querySelector('.hp-acciones') || suya;
  pie.scrollIntoView({ block: 'center' });
  await esperar(300);
  return visible;
};

(async function () {
  fs.mkdirSync(SALIDA, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--hide-scrollbars'] });
  const errores = [];
  for (const t of TOMAS) {
    for (const w of ANCHOS) {
      const page = await browser.newPage();
      page.on('pageerror', (e) => errores.push(t.n + '@' + w + ': ' + e.message));
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const url = (m.location() && m.location().url) || '';
        if (url.indexOf('favicon') !== -1) return;
        errores.push(t.n + '@' + w + ' (console): ' + m.text() + (url ? ' · ' + url : ''));
      });
      await page.setViewport({ width: w, height: ALTO, deviceScaleFactor: 2 });
      await page.goto(BASE + t.escenario, { waitUntil: 'networkidle2' });
      await new Promise((r) => setTimeout(r, 5000));
      const visible = await page.evaluate(GUION, { ficha: FICHA, abrir: !!t.abrir });
      const f = path.join(SALIDA, 'studio-' + t.n + '-' + w + '.png');
      await page.screenshot({ path: f });
      console.log('· ' + path.basename(f) + '  ' + t.que + '  [botón ' + (visible ? 'visible' : 'oculto') + ']');
      await page.close();
    }
  }
  await browser.close();
  if (errores.length) {
    console.log('\nLA PÁGINA TIRÓ ERRORES — las fotos no valen:');
    errores.forEach((e) => console.log('  ' + e));
    process.exit(1);
  }
  console.log('\nSin errores de JS en ninguna toma.');
  process.exit(0);
})();
