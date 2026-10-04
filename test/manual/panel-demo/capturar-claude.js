#!/usr/bin/env node
'use strict';

// Las capturas del selector de Claude por el CLI en ⚙: modelo, ventana de
// contexto y nivel de pensamiento, como en Editor Pro.
//
//   node test/manual/panel-demo/abrir.js --no-open &
//   node test/manual/panel-demo/capturar-claude.js
//
// Deja los PNG en `capturas-1.8.0/` con prefijo `claude-`.
//
// El catálogo de la maqueta lo arma el módulo de VERDAD (bridge/claude-modelos.js)
// con la medición real de Claude Code 2.1.288, así que lo que se ve en estas
// fotos es lo que arma el motor. Lo que se viene a mirar es lo que un test no
// contesta: si los rótulos de familia se leen como rótulos y no como opciones,
// si lo deshabilitado se ve deshabilitado, y si los renglones de abajo entran
// a 320 px sin cortarse.
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
const SALIDA = arg('--salida', path.join(__dirname, 'capturas-1.8.0'));
const ALTO = Number(arg('--alto', 760));
const ANCHOS = arg('--anchos', '400,320').split(',').map(Number);

const TOMAS = [
  { n: 'elegido', que: 'lo que abre: Sonnet 5 fijo (lo guardado), su ventana medida y los renglones de abajo' },
  { n: 'modelos', desplegar: 'cfg-model', que: 'el desplegable: familias, el último de cada una con su versión, la retirada deshabilitada' },
  { n: 'ventana', modelo: 'claude-opus-4-6', desplegar: 'cfg-window', que: 'Opus 4.6: acá sí hay ventana para elegir (200k o 1M)' },
  { n: 'ventana-1m', modelo: 'claude-opus-4-6', ventana: '1m', que: 'con 1M elegido: el aviso de créditos extra' },
  { n: 'ultimo', modelo: 'opus', que: 'Opus 5.5 · último: 1M de serie, el desplegable de la ventana quieto' },
  { n: 'pensamiento', desplegar: 'cfg-effort', que: 'los seis niveles, con Predeterminado' },
  { n: 'sin-medir', escenario: '?e=claude-sin-medir', que: 'un CLI recién actualizado: ⚙ mide solo y lo va contando' },
  { n: 'verificado', verificar: true, que: 'después de Verificar: con qué contestó y con qué versión de Claude Code' },
];

/** Corre dentro de la página. */
const GUION = async function (g) {
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  document.getElementById('btn-config').click();
  await esperar(700);

  // Elegir por el desplegable de verdad: es el gesto del editor y es lo que
  // dispara el guardado y el repintado de los renglones de abajo.
  async function elegir(id, valor) {
    const raiz = document.getElementById(id);
    if (!raiz) throw new Error('no está el desplegable ' + id);
    raiz.querySelector('.hps-trigger').click();
    await esperar(250);
    const op = [].slice.call(raiz.querySelectorAll('.hps-option'))
      .filter((o) => o.getAttribute('data-value') === valor)[0];
    if (!op) throw new Error(id + ' no ofrece «' + valor + '»');
    op.click();
    await esperar(500);
  }

  if (g.modelo) await elegir('cfg-model', g.modelo);
  if (g.ventana) await elegir('cfg-window', g.ventana);
  if (g.verificar) {
    document.getElementById('btn-claude-verify').click();
    await esperar(2200);
  }
  if (g.desplegar) {
    document.getElementById(g.desplegar).querySelector('.hps-trigger').click();
    await esperar(350);
  }
  const ancla = g.verificar ? document.getElementById('login-status') : document.getElementById('cfg-model');
  ancla.scrollIntoView({ block: g.verificar ? 'center' : 'start' });
  await esperar(250);
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
      await page.goto(BASE + (t.escenario || ''), { waitUntil: 'networkidle2' });
      await new Promise((r) => setTimeout(r, 2500 + (t.esperaExtra || 0)));
      await page.evaluate(GUION, {
        modelo: t.modelo || '', ventana: t.ventana || '', desplegar: t.desplegar || '',
        verificar: !!t.verificar,
      });
      const f = path.join(SALIDA, 'claude-' + t.n + '-' + w + '.png');
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
