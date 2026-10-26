#!/usr/bin/env node
'use strict';

// ¿LLEGAN LAS DOS FUENTES AL VIDEO, y salen IGUAL con los dos motores?
//
//   node test/manual/tipografia-render.js
//
// Bricolage Grotesque y Plus Jakarta Sans no viajan con el panel: se bajan de
// Google Fonts al renderizar, con el mismo pedido en los dos motores (ver
// bridge/remotion-host/src/fuentes.js). Si una no llega, el render NO falla:
// sale con la fuente de reemplazo del navegador, y se descubre mirando el video.
// Así que esto renderiza con cada motor tres renglones con el MISMO texto, el
// mismo tamaño y el mismo peso:
//
//   1. en Bricolage Grotesque,
//   2. en Plus Jakarta Sans,
//   3. en una fuente que no existe, o sea la de reemplazo.
//
// y compara los píxeles. Si el 1 o el 2 salen iguales al 3, esa fuente no
// llegó; el 1 tiene que salir distinto del 2. Y cada renglón tiene que medir lo
// mismo de ancho en los dos motores: con `@remotion/google-fonts`, el titular
// en Bricolage salía más ancho en Remotion, porque esa versión no trae el eje de
// tamaño óptico que lo cierra en tamaños grandes.
//
// Necesita red, ffmpeg y, para Remotion, la instalación (~/.hyperpremiere/remotion).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const motores = require(path.join(RAIZ, 'bridge', 'render'));
const { renderComposition } = require(path.join(RAIZ, 'bridge', 'render', 'hyperframes'));
const { CSS_FUENTES } = require(path.join(RAIZ, 'bridge', 'remotion-host', 'src', 'fuentes'));

const SALIDA = path.join(os.tmpdir(), 'hp-tipografia-render');
const TEXTO = 'Agua grande 0123';
// Dónde arranca cada renglón (px desde arriba) y cuánto mide la franja que se mira.
const RENGLONES = [120, 440, 760];
const ALTO = 200;
const FAMILIAS = ["'Bricolage Grotesque', sans-serif", "'Plus Jakarta Sans', sans-serif", "'NoExisteEstaFuente', sans-serif"];

// Como lo escribe el modelo: sin importar ninguna fuente.
const REMOTION = [
  "import {AbsoluteFill} from 'remotion';",
  'const linea = (top, fontFamily) => ({position: "absolute", left: 120, top, fontFamily, fontSize: 120,',
  '  fontWeight: 700, color: "#fff", whiteSpace: "nowrap", lineHeight: 1});',
  'export default function M() {',
  '  return (',
  '    <AbsoluteFill style={{backgroundColor: "#000"}}>',
].concat(RENGLONES.map((top, i) => '      <div style={linea(' + top + ', ' + JSON.stringify(FAMILIAS[i]) + ')}>' + TEXTO + '</div>'))
  .concat(['    </AbsoluteFill>', '  );', '}']).join('\n');

const HYPERFRAMES = [
  '<!DOCTYPE html>',
  '<html lang="es"><head><meta charset="UTF-8">',
  '<link href="' + CSS_FUENTES + '" rel="stylesheet">',
  '<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>',
  '<style>',
  '  *{margin:0;padding:0;box-sizing:border-box}',
  '  html,body{width:1920px;height:1080px;overflow:hidden;background:#000}',
  '  #stage{position:relative;width:1920px;height:1080px;overflow:hidden;background:#000}',
  '  .l{position:absolute;left:120px;font-size:120px;font-weight:700;color:#fff;white-space:nowrap;line-height:1}',
  '</style></head><body>',
  '<div id="stage" data-composition-id="comp" data-start="0" data-width="1920" data-height="1080" data-duration="1" data-fps="30">',
].concat(RENGLONES.map((top, i) => '  <div class="l" style="top:' + top + 'px;font-family:' + FAMILIAS[i].replace(/"/g, '') + '">' + TEXTO + '</div>'))
  .concat([
    '</div>',
    '<script>',
    "  var COMP_ID = 'comp';",
    '  var tl = gsap.timeline({ paused: true });',
    '  tl.to({}, { duration: 1 }, 0);',
    '  window.__timelines = window.__timelines || {};',
    '  window.__timelines[COMP_ID] = tl;',
    '</script>',
    '</body></html>',
  ]).join('\n');

const ANCHO_FRANJA = 1700;

/** La franja de un renglón, en RGBA crudo, del cuadro del medio del video. */
function franja(video, top) {
  return execFileSync('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', video, '-frames:v', '1',
    '-vf', 'crop=' + ANCHO_FRANJA + ':' + ALTO + ':100:' + (top - 20), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
  { maxBuffer: 64 * 1024 * 1024 });
}

/** Qué porcentaje de los píxeles cambia entre dos franjas (con margen para el ruido de la compresión). */
function distintos(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 60) n++;
  }
  return (100 * n) / (a.length / 4);
}

/** De qué columna a qué columna hay tinta: cuánto mide el renglón de ancho, en px. */
function ancho(f) {
  let desde = Infinity;
  let hasta = -1;
  for (let i = 0; i < f.length; i += 4) {
    if (f[i] <= 128) continue;
    const x = (i / 4) % ANCHO_FRANJA;
    if (x < desde) desde = x;
    if (x > hasta) hasta = x;
  }
  return hasta < 0 ? 0 : hasta - desde + 1;
}

function informar(nombre, video) {
  const [bri, jak, reem] = RENGLONES.map((top) => franja(video, top));
  const d1 = distintos(bri, reem);
  const d2 = distintos(jak, reem);
  const d3 = distintos(bri, jak);
  const anchos = [bri, jak, reem].map(ancho);
  console.log('  ' + nombre + ': Bricolage vs reemplazo ' + d1.toFixed(1) + '% · Jakarta vs reemplazo ' + d2.toFixed(1) +
    '% · Bricolage vs Jakarta ' + d3.toFixed(1) + '%');
  console.log('  anchos: Bricolage ' + anchos[0] + ' px · Jakarta ' + anchos[1] + ' px · reemplazo ' + anchos[2] + ' px');
  const llego = (d) => d > 2;
  const bien = anchos[2] > 0 && llego(d1) && llego(d2) && llego(d3);
  console.log('  ' + (bien ? '✓ las dos fuentes llegaron al video' :
    '✗ ' + [!anchos[2] && 'el renglón de reemplazo salió vacío', !llego(d1) && 'Bricolage salió como la de reemplazo',
      !llego(d2) && 'Jakarta salió como la de reemplazo', !llego(d3) && 'Bricolage y Jakarta salieron iguales']
      .filter(Boolean).join(' · ')));
  return { bien: bien, anchos: anchos };
}

(async () => {
  fs.mkdirSync(SALIDA, { recursive: true });

  console.log('1) Remotion (el render del panel):');
  const remo = path.join(SALIDA, 'remotion.mp4');
  await motores.motor('remotion').renderizar({ code: REMOTION, outPath: remo, durationSec: 1, format: 'mp4' });
  const r = informar('Remotion', remo);

  console.log('\n2) HyperFrames:');
  const hf = path.join(SALIDA, 'hyperframes.mp4');
  await renderComposition({ html: HYPERFRAMES, outMovPath: hf, durationSec: 1, format: 'mp4' });
  const h = informar('HyperFrames', hf);

  console.log('\n3) ¿Salen iguales con los dos motores?');
  let iguales = true;
  ['Bricolage', 'Jakarta'].forEach((nombre, i) => {
    const dif = Math.abs(r.anchos[i] - h.anchos[i]);
    const ok = dif <= 6;
    iguales = iguales && ok;
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + nombre + ': ' + r.anchos[i] + ' px en Remotion, ' + h.anchos[i] +
      ' px en HyperFrames (' + dif + ' px de diferencia)');
  });

  for (const [nombre, video] of [['remotion', remo], ['hyperframes', hf]]) {
    execFileSync('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', video, '-frames:v', '1', '-y', path.join(SALIDA, nombre + '.png')]);
  }
  const bien = r.bien && h.bien && iguales;
  console.log('\n' + (bien ? 'TODO BIEN' : 'ALGO NO DIO LO QUE TENÍA QUE DAR') + ' · cuadros en ' + SALIDA);
  process.exit(bien ? 0 : 1);
})().catch((e) => {
  console.error('FALLÓ:', (e && e.stack) || e);
  process.exit(1);
});
