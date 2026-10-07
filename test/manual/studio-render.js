#!/usr/bin/env node
'use strict';

// EL BOTÓN «RENDER» DE REMOTION STUDIO, apretado de verdad, de punta a punta.
//
//   node test/manual/studio-render.js
//
// Necesita Remotion instalado (~/.hyperpremiere/remotion) y Chrome. No llama a
// ningún modelo. Hace lo mismo que el editor, salvo Premiere:
//
//   1. Un proyecto con dos marcadores de Remotion en disco. El primero incrusta
//      una imagen (un rectángulo rojo sobre fondo verde); el segundo es azul.
//   2. «Abrir Remotion» del primero, por el motor (previewComposition), con el
//      panel escuchando los renders (escucharRendersDeStudio).
//   3. En la interfaz de Studio, en un navegador headless: Render → Render video.
//   4. Que llegue el aviso, que la versión nueva esté en disco con su código, y
//      que el video tenga lo que se veía —el rojo de la imagen en el centro—.
//   5. Lo mismo con el segundo marcador, sin recargar la pestaña.
//
// El reemplazo en Premiere no está acá: lo prueba test/studio-a-premiere.test.js
// con el Premiere de mentira. Esto contesta lo que un test no puede: qué manda
// la interfaz de Studio de verdad y qué video sale.
//
// Deja capturas en /tmp/hp-studio-render/ y apaga Studio al terminar.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const puppeteer = require(path.join(RAIZ, 'bridge', 'node_modules', 'puppeteer-core'));
const engine = require(path.join(RAIZ, 'bridge', 'engine'));
const { writeVersionMeta, readMeta } = require(path.join(RAIZ, 'bridge', 'store', 'project-fs'));
const CHROME = process.env.HP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SALIDA = path.join(os.tmpdir(), 'hp-studio-render');

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

function tsx(fondo, conImagen) {
  return [
    "import React from 'react';",
    "import { AbsoluteFill, Img, staticFile } from 'remotion';",
    'export default function M() {',
    '  return (',
    "    <AbsoluteFill style={{ backgroundColor: '" + fondo + "', justifyContent: 'center', alignItems: 'center' }}>",
    conImagen ? "      <Img src={staticFile('assets/asset-01.png')} style={{ width: 400 }} />" : '',
    '    </AbsoluteFill>',
    '  );',
    '}',
  ].join('\n');
}

/** Un proyecto con dos marcadores de Remotion, como lo deja el panel. */
function armarProyecto() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-studio-proyecto-'));
  const projectPath = path.join(raiz, 'Clases.prproj');
  fs.writeFileSync(projectPath, 'x');
  const sequenceName = 'Clase de prueba';
  const dir = path.join(raiz, 'HyperPremiere', 'clase-de-prueba');
  fs.mkdirSync(dir, { recursive: true });
  const marcador = (slug, codigo, start) => {
    const base = slug + ' v1 [modelo]';
    fs.writeFileSync(path.join(dir, base + '.tsx'), codigo);
    fs.writeFileSync(path.join(dir, base + '.mov'), 'el render de antes');
    writeVersionMeta(path.join(dir, base + '.meta.json'), {
      sequenceName, markerSlug: slug, version: 1, model: 'modelo', engine: 'remotion',
      instruction: 'un rectángulo', marker: { name: slug, start: start, duration: 1 },
    });
  };
  marcador('Marcador 1', tsx('rgb(0,200,0)', true), 12);
  marcador('Marcador 2', tsx('rgb(0,0,220)', false), 30);
  const imgs = path.join(dir, '_assets', 'Marcador 1');
  fs.mkdirSync(imgs, { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=200x120', '-frames:v', '1', '-y',
    path.join(imgs, 'asset-01.png')]);
  return { projectPath, sequenceName, dir };
}

function colorDelCentro(video) {
  const png = path.join(SALIDA, 'cuadro.png');
  execFileSync('ffmpeg', ['-v', 'error', '-i', video, '-frames:v', '1', '-y', png]);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', 'crop=1:1:960:540', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  return Array.from(raw).join(',');
}

async function clicPorTexto(page, patron, ultimo) {
  return page.evaluate((src, ultimoDeTodos) => {
    const re = new RegExp(src, 'i');
    const bs = [...document.querySelectorAll('button')].filter((x) => re.test((x.textContent || '').trim()));
    const b = ultimoDeTodos ? bs[bs.length - 1] : bs[0];
    if (!b) return false;
    b.click();
    return true;
  }, patron.source, !!ultimo);
}

/** Render → Render video en la interfaz, y espera el aviso del motor. */
async function renderizar(page, avisos, foto) {
  const antes = avisos.length;
  await clicPorTexto(page, /^Render\b/);
  await esperar(2000);
  await page.screenshot({ path: path.join(SALIDA, foto + '-modal.png') });
  await clicPorTexto(page, /Render video/, true);
  const hasta = Date.now() + 120000;
  while (Date.now() < hasta && avisos.length === antes) await esperar(500);
  await page.screenshot({ path: path.join(SALIDA, foto + '-fin.png') });
  return avisos[antes] || null;
}

function contar(aviso, p, quiero) {
  if (!aviso) { console.log('  NO LLEGÓ EL AVISO: mirá las capturas.'); return false; }
  if (!aviso.ok) { console.log('  el aviso dice que falló:', aviso.error); return false; }
  const ficha = readMeta(aviso.archivo.replace(/\.(mov|mp4)$/, '.meta.json')) || {};
  const color = colorDelCentro(aviso.archivo);
  console.log('  versión:', aviso.etiqueta, '·', path.basename(aviso.archivo));
  console.log('  reemplazaría a:', aviso.anteriores.map((a) => path.basename(a)).join(', '));
  console.log('  ficha: motor', ficha.engine, '· modelo', ficha.model, '· tramo', JSON.stringify(ficha.marker));
  console.log('  centro del video:', color, '(quería ' + quiero + ')');
  return color === quiero;
}

(async () => {
  fs.mkdirSync(SALIDA, { recursive: true });
  const p = armarProyecto();
  const avisos = [];
  const abrir = async (slug) => {
    const r = await engine.previewComposition({
      projectPath: p.projectPath, sequenceName: p.sequenceName, markerSlug: slug, version: 1,
      marker: { name: slug, start: slug === 'Marcador 1' ? 12 : 30, duration: 1 }, background: false,
    });
    if (!r.ok) throw new Error('no abrió: ' + r.error);
    return r;
  };

  const r1 = await abrir('Marcador 1');
  console.log('Studio en', r1.url, '· mostrando', r1.etiqueta);
  // Lo que hace el panel después de abrir: quedarse escuchando los renders.
  engine.escucharRendersDeStudio({}, (ev) => { if (ev && ev.renderDeStudio) avisos.push(ev.renderDeStudio); });

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  let bien = true;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto(r1.url, { waitUntil: 'networkidle2' });
    await esperar(4000);
    await page.screenshot({ path: path.join(SALIDA, '1-studio.png') });

    console.log('\n1) Render en Studio con el Marcador 1 (verde, con la imagen roja en el centro):');
    bien = contar(await renderizar(page, avisos, '1'), p, '252,0,0,255') && bien;

    const r2 = await abrir('Marcador 2');
    console.log('\n2) Abrí el Marcador 2 (' + (r2.arrancado ? 'Studio nuevo' : 'mismo Studio') + ') y Render de nuevo:');
    await esperar(4000);
    await page.screenshot({ path: path.join(SALIDA, '2-otro-marcador.png') });
    bien = contar(await renderizar(page, avisos, '2'), p, '0,0,220,255') && bien;
  } finally {
    await browser.close();
  }
  engine.closePreview();
  console.log('\n' + (bien ? 'TODO BIEN' : 'ALGO NO DIO LO QUE TENÍA QUE DAR') + ' · capturas en ' + SALIDA);
  process.exit(bien ? 0 : 1);
})().catch((e) => {
  console.error('FALLÓ:', (e && e.stack) || e);
  try { engine.closePreview(); } catch (e2) { /* ya estaba cerrado */ }
  process.exit(1);
});
