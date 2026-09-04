#!/usr/bin/env node
'use strict';

// Mide el encabezado del panel, a mano, sobre la maqueta.
//
// El encabezado se solapaba consigo mismo en un panel angosto y "a ojo" no
// alcanza para decir si se arregló: dos cajas que se tocan 6 px se ven bien en
// una captura. Esto compara los `getBoundingClientRect` de TODAS las hojas del
// encabezado, par por par, y dice cuáles se superponen y cuánto. Es lo que hay
// que volver a correr cuando se toca `.panel-header`, porque los tests del repo
// fijan las reglas de CSS pero NO miden cajas: el DOM de mentira no tiene motor
// de layout.
//
// Levantá la maqueta primero (`node test/manual/panel-demo/abrir.js --no-open`).
//
//   node test/manual/panel-demo/medir-encabezado.js
//   node test/manual/panel-demo/medir-encabezado.js --capturas /tmp/antes
//   node test/manual/panel-demo/medir-encabezado.js --url "http://localhost:4599/?e=sin-dictado"
//   node test/manual/panel-demo/medir-encabezado.js --anchos 320,400 --abrir-mic
//
// Usa el Chrome del sistema por CDP con el puppeteer-core que ya trae `bridge/`
// (no baja nada). Si no tenés Chrome en /Applications, pasá HP_CHROME.

const path = require('path');
const fs = require('fs');
const puppeteer = require(path.join(__dirname, '..', '..', '..', 'bridge', 'node_modules', 'puppeteer-core'));

const CHROME = process.env.HP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(nombre, def) {
  const i = process.argv.indexOf(nombre);
  return i === -1 ? def : process.argv[i + 1];
}

const URL_BASE = arg('--url', 'http://localhost:4599/');
const ANCHOS = String(arg('--anchos', '320,360,400,470,600,900')).split(',').map(Number);
const CAPS = arg('--capturas', '');
const ABRIR_MIC = process.argv.indexOf('--abrir-mic') !== -1;

const MEDIR = function () {
  const head = document.querySelector('.panel-header');
  if (!head) return { error: 'sin encabezado' };
  // Las hojas del encabezado: lo que de verdad dibuja texto y se puede montar
  // encima de otro. Un contenedor solapa a su hijo por definición, así que se
  // comparan solo hojas.
  const hojas = [];
  (function recorrer(el) {
    for (const h of el.children) {
      if (h.tagName === 'svg' || h.tagName === 'SVG') { hojas.push(h); continue; }
      const esHoja = h.children.length === 0 || h.tagName === 'BUTTON' || h.classList.contains('hps-trigger');
      if (esHoja) hojas.push(h); else recorrer(h);
    }
  })(head);

  function ficha(el) {
    const r = el.getBoundingClientRect();
    // En SVG `className` es un objeto, no una cadena: hay que ir por el atributo.
    const clase = el.getAttribute('class') || '';
    return {
      id: el.id || clase.split(' ')[0] || el.tagName.toLowerCase(),
      texto: (el.textContent || '').trim().slice(0, 28),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      cortado: el.scrollWidth > el.clientWidth + 1,
      scrollW: el.scrollWidth, clientW: el.clientWidth,
      // El texto que NO cabe en la caja: es el que se monta encima del vecino.
      desbordaTexto: el.scrollWidth - el.clientWidth,
    };
  }

  const cajas = hojas.filter((h) => h.getBoundingClientRect().width > 0).map(ficha);
  const solapes = [];
  for (let i = 0; i < cajas.length; i++) {
    for (let j = i + 1; j < cajas.length; j++) {
      const a = cajas[i], b = cajas[j];
      const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (dx > 1 && dy > 1) solapes.push({ a: a.id, b: b.id, px: Math.round(dx) });
    }
  }
  const de = document.documentElement;
  return {
    doc: { scrollW: de.scrollWidth, clientW: de.clientWidth, desborde: de.scrollWidth - de.clientWidth },
    head: { scrollW: head.scrollWidth, clientW: head.clientWidth, desborde: head.scrollWidth - head.clientWidth, alto: Math.round(head.getBoundingClientRect().height) },
    version: (function () {
      const v = document.getElementById('version-label');
      if (!v) return null;
      const r = v.getBoundingClientRect();
      return { w: Math.round(r.width), scrollW: v.scrollWidth, clientW: v.clientWidth, cortado: v.scrollWidth > v.clientWidth + 1, texto: v.textContent };
    })(),
    cajas, solapes,
  };
};

(async function () {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--force-device-scale-factor=2', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.goto(URL_BASE, { waitUntil: 'networkidle2' });
  // La maqueta aprieta "Cargar marcadores" sola y el motor falso tarda.
  await new Promise((r) => setTimeout(r, 2500));

  const salida = {};
  for (const w of ANCHOS) {
    await page.setViewport({ width: w, height: 600, deviceScaleFactor: 2 });
    await new Promise((r) => setTimeout(r, 700));
    if (ABRIR_MIC) {
      await page.evaluate(function () {
        const t = document.querySelector('#hdr-mic .hps-trigger');
        if (t) t.click();
      });
      await new Promise((r) => setTimeout(r, 400));
    }
    const m = await page.evaluate(MEDIR);
    salida[w] = m;
    console.log('\n═══ ' + w + ' px ' + '═'.repeat(30));
    console.log('  doc  scrollW=' + m.doc.scrollW + ' clientW=' + m.doc.clientW + '  desborde=' + m.doc.desborde);
    console.log('  head scrollW=' + m.head.scrollW + ' clientW=' + m.head.clientW + '  desborde=' + m.head.desborde + '  alto=' + m.head.alto);
    if (m.version) console.log('  version-label w=' + m.version.w + ' scrollW=' + m.version.scrollW + ' clientW=' + m.version.clientW + (m.version.cortado ? '  ← CORTADO' : '  ok'));
    m.cajas.forEach(function (c) {
      console.log('    ' + String(c.id).padEnd(16) + ' x=' + String(c.x).padStart(4) + ' y=' + String(c.y).padStart(3) + ' w=' + String(c.w).padStart(4) + ' h=' + String(c.h).padStart(3) +
        (c.cortado ? '  texto se sale ' + c.desbordaTexto + 'px' : '') + '   «' + c.texto + '»');
    });
    if (m.solapes.length) {
      console.log('  ⚠ SOLAPES: ' + m.solapes.map(function (s) { return s.a + ' × ' + s.b + ' (' + s.px + 'px)'; }).join(', '));
    } else {
      console.log('  ✓ sin solapes');
    }
    if (CAPS) {
      fs.mkdirSync(CAPS, { recursive: true });
      const head = await page.$('.panel-header');
      await head.screenshot({ path: path.join(CAPS, 'encabezado-' + w + '.png') });
      if (ABRIR_MIC) await page.screenshot({ path: path.join(CAPS, 'panel-' + w + '.png') });
    }
  }
  if (CAPS) fs.writeFileSync(path.join(CAPS, 'medidas.json'), JSON.stringify(salida, null, 2));
  await browser.close();
})().catch(function (e) { console.error(e); process.exit(1); });
