#!/usr/bin/env node
'use strict';

// REMOTION STUDIO DE PUNTA A PUNTA: editar el archivo y apretar Render.
//
//   node test/manual/studio-render.js
//
// Necesita Remotion instalado (~/.hyperpremiere/remotion) y Chrome. No llama a
// ningún modelo. Hace lo mismo que el editor, salvo Premiere y abrir su editor
// de código (lo que haría «Abrir Remotion» con `abrirArchivo`):
//
//   1. Un proyecto con dos marcadores de Remotion en disco. El primero incrusta
//      una imagen (un rectángulo rojo sobre fondo verde); el segundo es azul y
//      NO importa React, como el ejemplo del contrato. Antes de Studio, el
//      primero se renderiza por el camino del PANEL: las dos raíces del
//      proyecto de Remotion comparten la composición, y tocar una para Studio
//      no puede romper el render de siempre.
//   2. Abrir el primero, por el motor (previewComposition), con el panel
//      escuchando los renders (escucharRendersDeStudio).
//   3. EDITAR su archivo: el fondo pasa de verde a amarillo. Studio lo tiene que
//      mostrar solo, sin recargar la pestaña.
//   4. En la interfaz de Studio, en un navegador headless: Render → Render video.
//      Que llegue el aviso, que la versión nueva guarde el código editado, y
//      que el video tenga lo que se veía: el rojo de la imagen en el centro y
//      el amarillo en el borde.
//   5. Lo mismo con el segundo marcador, en la misma pestaña.
//   6. Editar el primero sin renderizar y volver a abrirlo: lo editado sigue.
//
// El reemplazo en Premiere no está acá: lo prueba test/studio-a-premiere.test.js
// con el Premiere de mentira. Esto contesta lo que un test no puede: qué manda
// la interfaz de Studio de verdad y qué video sale.
//
// Deja capturas en $TMPDIR/hp-studio-render/, apaga Studio al terminar y borra
// los archivos de marcador que creó.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const puppeteer = require(path.join(RAIZ, 'bridge', 'node_modules', 'puppeteer-core'));
const engine = require(path.join(RAIZ, 'bridge', 'engine'));
const motores = require(path.join(RAIZ, 'bridge', 'render'));
const { writeVersionMeta, readMeta } = require(path.join(RAIZ, 'bridge', 'store', 'project-fs'));
const CHROME = process.env.HP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SALIDA = path.join(os.tmpdir(), 'hp-studio-render');

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

function tsx(fondo, conImagen, conReact) {
  return [
    conReact ? "import React from 'react';" : '',
    "import { AbsoluteFill, Img, staticFile } from 'remotion';",
    'export default function M() {',
    '  return (',
    "    <AbsoluteFill style={{ backgroundColor: '" + fondo + "', justifyContent: 'center', alignItems: 'center' }}>",
    conImagen ? "      <Img src={staticFile('assets/asset-01.png')} style={{ width: 400 }} />" : '',
    '    </AbsoluteFill>',
    '  );',
    '}',
  ].filter(Boolean).join('\n');
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
  marcador('Marcador 1', tsx('rgb(0,200,0)', true, true), 12);
  marcador('Marcador 2', tsx('rgb(0,0,220)', false, false), 30);
  const imgs = path.join(dir, '_assets', 'Marcador 1');
  fs.mkdirSync(imgs, { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=200x120', '-frames:v', '1', '-y',
    path.join(imgs, 'asset-01.png')]);
  return { projectPath, sequenceName, dir };
}

function colorEn(video, x, y) {
  const png = path.join(SALIDA, 'cuadro.png');
  execFileSync('ffmpeg', ['-v', 'error', '-i', video, '-frames:v', '1', '-y', png]);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', 'crop=1:1:' + x + ':' + y, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
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

/** ¿La pestaña de Studio está pintando un fondo de este color? Espera hasta 40 s. */
async function seVe(page, rgb) {
  const hasta = Date.now() + 40000;
  while (Date.now() < hasta) {
    const esta = await page.evaluate((c) => [...document.querySelectorAll('div')]
      .some((d) => getComputedStyle(d).backgroundColor === c), rgb);
    if (esta) return true;
    await esperar(500);
  }
  return false;
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

/** Dos colores "r,g,b,a" iguales salvo por lo que corre la conversión a ProRes. */
function parecido(a, b) {
  const x = a.split(',').map(Number);
  const y = b.split(',').map(Number);
  return x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) <= 4);
}

/** Lo que llegó del render: versión, ficha, código guardado y colores del video. */
function contar(aviso, quiero) {
  if (!aviso) { console.log('  NO LLEGÓ EL AVISO: mirá las capturas.'); return false; }
  if (!aviso.ok) { console.log('  el aviso dice que falló:', aviso.error); return false; }
  const ficha = readMeta(aviso.archivo.replace(/\.(mov|mp4)$/, '.meta.json')) || {};
  const codigo = fs.readFileSync(aviso.archivo.replace(/\.(mov|mp4)$/, '.tsx'), 'utf8');
  const centro = colorEn(aviso.archivo, 960, 540);
  const borde = colorEn(aviso.archivo, 20, 20);
  console.log('  versión:', aviso.etiqueta, '·', path.basename(aviso.archivo));
  console.log('  reemplazaría a:', aviso.anteriores.map((a) => path.basename(a)).join(', '));
  console.log('  ficha: motor', ficha.engine, '· modelo', ficha.model, '· tramo', JSON.stringify(ficha.marker));
  console.log('  el código guardado tiene', quiero.codigo + ':', codigo.indexOf(quiero.codigo) !== -1 ? 'sí' : 'NO');
  console.log('  centro del video:', centro, '(quería ' + quiero.centro + ') · borde:', borde, '(quería ' + quiero.borde + ')');
  return codigo.indexOf(quiero.codigo) !== -1 && parecido(centro, quiero.centro) && parecido(borde, quiero.borde);
}

function si(cond, texto) {
  console.log('  ' + (cond ? '✓' : '✗') + ' ' + texto);
  return !!cond;
}

(async () => {
  fs.mkdirSync(SALIDA, { recursive: true });
  const p = armarProyecto();
  let bien = true;

  console.log('0) El render del panel (la raíz de siempre, Root.tsx) con el Marcador 1:');
  const delPanel = path.join(SALIDA, 'render-del-panel.mov');
  await motores.motor('remotion').renderizar({
    code: fs.readFileSync(path.join(p.dir, 'Marcador 1 v1 [modelo].tsx'), 'utf8'),
    outPath: delPanel, durationSec: 1, format: 'mov',
    assetsDir: path.join(p.dir, '_assets', 'Marcador 1'),
  });
  const c0 = colorEn(delPanel, 960, 540);
  const b0 = colorEn(delPanel, 20, 20);
  bien = si(parecido(c0, '255,0,0,255') && parecido(b0, '0,200,0,255'),
    'sale con la imagen en el centro (' + c0 + ') y el fondo verde en el borde (' + b0 + ')') && bien;
  console.log('');

  const avisos = [];
  // Como «Abrir Remotion»: la última versión del marcador, preguntada al disco.
  const abrir = async (slug) => {
    const vs = engine.listMarkerVersions({ projectPath: p.projectPath, sequenceName: p.sequenceName, markerSlug: slug });
    const r = await engine.previewComposition({
      projectPath: p.projectPath, sequenceName: p.sequenceName, markerSlug: slug,
      version: vs.versions[vs.versions.length - 1].version,
      marker: { name: slug, start: slug === 'Marcador 1' ? 12 : 30, duration: 1 }, background: false,
    });
    if (!r.ok) throw new Error('no abrió: ' + r.error);
    return r;
  };

  const r1 = await abrir('Marcador 1');
  console.log('Studio en', r1.url, '· mostrando', r1.etiqueta);
  console.log('  archivo:', r1.archivo, '(' + r1.accion + ')');
  // Lo que hace el panel después de abrir: quedarse escuchando los renders.
  engine.escucharRendersDeStudio({}, (ev) => { if (ev && ev.renderDeStudio) avisos.push(ev.renderDeStudio); });

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto(r1.url, { waitUntil: 'networkidle2' });
    bien = si(await seVe(page, 'rgb(0, 200, 0)'), 'Studio muestra el Marcador 1 desde su archivo (verde)') && bien;
    await page.screenshot({ path: path.join(SALIDA, '1-studio.png') });

    console.log('\n1) Edito el archivo del Marcador 1: el fondo pasa a amarillo.');
    const t0 = Date.now();
    fs.writeFileSync(r1.archivo, fs.readFileSync(r1.archivo, 'utf8').replace('rgb(0,200,0)', 'rgb(255,200,0)'));
    const cambio = await seVe(page, 'rgb(255, 200, 0)');
    bien = si(cambio, 'Studio se actualizó solo, sin recargar la pestaña (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)') && bien;
    await page.screenshot({ path: path.join(SALIDA, '1-editado.png') });

    console.log('   Render en Studio:');
    bien = contar(await renderizar(page, avisos, '1'), {
      codigo: 'rgb(255,200,0)', centro: '255,0,0,255', borde: '255,200,0,255',
    }) && bien;

    const r2 = await abrir('Marcador 2');
    console.log('\n2) Abrí el Marcador 2 (' + (r2.arrancado ? 'Studio nuevo' : 'mismo Studio') + ', sin `import React`):');
    bien = si(await seVe(page, 'rgb(0, 0, 220)'), 'Studio muestra el Marcador 2 (azul) en la misma pestaña') && bien;
    await page.screenshot({ path: path.join(SALIDA, '2-otro-marcador.png') });
    bien = contar(await renderizar(page, avisos, '2'), {
      codigo: 'rgb(0,0,220)', centro: '0,0,220,255', borde: '0,0,220,255',
    }) && bien;

    console.log('\n3) Edito el Marcador 1 sin renderizar y lo vuelvo a abrir:');
    fs.writeFileSync(r1.archivo, fs.readFileSync(r1.archivo, 'utf8').replace('rgb(255,200,0)', 'rgb(150,0,200)'));
    const r3 = await abrir('Marcador 1');
    bien = si(r3.accion === 'conservado', 'el panel dice que siguen los cambios sin renderizar (' + r3.accion + ')') && bien;
    bien = si(fs.readFileSync(r1.archivo, 'utf8').indexOf('rgb(150,0,200)') !== -1, 'el archivo tiene lo editado') && bien;
    bien = si(await seVe(page, 'rgb(150, 0, 200)'), 'y Studio lo muestra (violeta)') && bien;
    await page.screenshot({ path: path.join(SALIDA, '3-vuelta.png') });
  } finally {
    await browser.close();
  }
  engine.closePreview();
  // Los archivos de marcador de este proyecto de prueba no le sirven a nadie, y
  // el puntero no puede quedar señalando una carpeta que ya no está.
  const carpetaDePrueba = path.dirname(r1.archivo);
  fs.rmSync(carpetaDePrueba, { recursive: true, force: true });
  const abierto = path.join(path.dirname(carpetaDePrueba), 'abierto.ts');
  if (fs.existsSync(abierto) && fs.readFileSync(abierto, 'utf8').indexOf(path.basename(carpetaDePrueba)) !== -1) {
    fs.rmSync(abierto);
  }
  console.log('\n' + (bien ? 'TODO BIEN' : 'ALGO NO DIO LO QUE TENÍA QUE DAR') + ' · capturas en ' + SALIDA);
  process.exit(bien ? 0 : 1);
})().catch((e) => {
  console.error('FALLÓ:', (e && e.stack) || e);
  try { engine.closePreview(); } catch (e2) { /* ya estaba cerrado */ }
  process.exit(1);
});
