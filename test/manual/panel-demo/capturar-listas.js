#!/usr/bin/env node
'use strict';

// Las capturas de las DOS listas que no son la de marcadores: la Cola y
// Corrections. Es la foto del antes y el después de la etapa 3, que es la que
// unificó la gramática de las tres pestañas.
//
//   node test/manual/panel-demo/abrir.js --no-open &
//   node test/manual/panel-demo/capturar-listas.js --prefijo antes
//   …se cambia el código…
//   node test/manual/panel-demo/capturar-listas.js --prefijo despues
//
// Deja los PNG en `capturas-1.6.0/` con el prefijo que se le pase. El `--prefijo`
// es obligatorio a propósito: un nombre por defecto haría que la segunda corrida
// pise la primera, y entonces no hay antes contra qué comparar.
//
// EL VIEWPORT ES ALTO (1500 px por defecto) y no los 700 de la maqueta, y no es
// por gusto: la cola de `datos.js` tiene los siete estados a la vez —terminado,
// diseñando, renderizando, terminado sin colocar, fallado, esperando tokens y en
// cola— y la pregunta de esta etapa es justamente si se pueden BARRER de un
// vistazo. Con 700 px entran tres, o sea que la foto no muestra lo que hay que
// mirar. El ancho sí es el de verdad (400 y 320), que es lo que decide si algo
// envuelve.
//
// Y falla si la página tira un error de JS, igual que `capturar-ficha.js`: una
// foto de un panel roto es justo la que uno mira y da por buena.

const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..', '..', '..');
const puppeteer = require(path.join(RAIZ, 'bridge', 'node_modules', 'puppeteer-core'));
const CHROME = process.env.HP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(n, d) { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; }

const BASE = arg('--base', 'http://localhost:4599/');
const SALIDA = arg('--salida', path.join(__dirname, 'capturas-1.6.0'));
const ALTO = Number(arg('--alto', 1500));
const ANCHOS = arg('--anchos', '400,320').split(',').map(Number);
const PREFIJO = arg('--prefijo', '');

if (!PREFIJO) {
  console.error('Falta --prefijo (antes | despues): si no, la segunda corrida pisa la primera.');
  process.exit(1);
}

const TOMAS = [
  { n: 'cola', que: 'la cola con los siete estados a la vez', guion: { pestana: 'tab-queue' } },
  {
    n: 'cola-feedback', que: 'la ronda de feedback de un trabajo terminado, abierta',
    guion: { pestana: 'tab-queue', abrirFeedback: true },
  },
  { n: 'corrections', que: 'las filas de lo ya generado, leídas del disco', guion: { pestana: 'tab-corrections' } },
  {
    n: 'corrections-abierta', que: 'una fila de corrección con su contexto y su HTML desplegados',
    guion: { pestana: 'tab-corrections', abrirFila: true },
  },
];

/** Corre dentro de la página. */
const GUION = async function (g) {
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const conTexto = (t) => [].slice.call(document.querySelectorAll('button, .qbtn'))
    .filter((b) => (b.textContent || '').indexOf(t) !== -1);
  const tab = document.getElementById(g.pestana);
  if (!tab) throw new Error('no encontré la pestaña ' + g.pestana);
  tab.click();
  await esperar(1500);
  if (g.abrirFeedback) {
    const b = conTexto('Feedback')[0];
    if (!b) throw new Error('ningún trabajo terminado ofrece feedback');
    b.click();
    await esperar(900);
  }
  if (g.abrirFila) {
    const fila = document.querySelector('details.corr-row');
    if (!fila) throw new Error('Corrections no dibujó ninguna fila plegable');
    // La fila PRIMERO: desde la 1.6.x es ella el `<details>`, así que abrir
    // sólo los de adentro dejaba todo escondido y la foto salía de la lista
    // plegada. Y después «Avanzado» y el contexto, que son los de adentro.
    fila.open = true;
    await esperar(500);
    [].slice.call(fila.querySelectorAll('details')).forEach((d) => { d.open = true; });
    await esperar(900);
    fila.scrollIntoView({ block: 'start' });
    await esperar(300);
  }
  window.scrollTo(0, 0);
  await esperar(400);
};

(async function () {
  fs.mkdirSync(SALIDA, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--hide-scrollbars'],
  });
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
      page.on('response', (r) => {
        if (r.status() >= 400 && r.url().indexOf('favicon') === -1) {
          errores.push(t.n + '@' + w + ': ' + r.status() + ' ' + r.url());
        }
      });
      await page.setViewport({ width: w, height: ALTO, deviceScaleFactor: 2 });
      await page.goto(BASE, { waitUntil: 'networkidle2' });
      // La maqueta aprieta "Cargar marcadores" sola unos segundos después de
      // cargar (en Premiere lo toca el editor); antes de eso no hay nada.
      await new Promise((r) => setTimeout(r, 4500));
      await page.evaluate(GUION, t.guion);
      const f = path.join(SALIDA, PREFIJO + '-' + t.n + '-' + w + '.png');
      await page.screenshot({ path: f });
      console.log('· ' + path.basename(f) + '  ' + t.que);
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
