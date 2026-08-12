'use strict';

// Un render de VERDAD, con el aprendizaje del reparto adentro.
//
// Los tests corren con el CLI de mentira: prueban las decisiones, no que
// hyperframes efectivamente escriba un .mov. Esto último se comprueba acá, a
// mano, cuando se toca el render.   node test/manual/render-real.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-render-real-home-'));
process.env.HOME = tmpHome; // que aprenda en un HOME aparte, sin pisar el real

const { renderComposition, renderLanes, pickRenderProfile } = require('../../bridge/render/hyperframes');
const perfilStore = require('../../bridge/store/render-profile');

const HTML = `<!DOCTYPE html><html><head><style>
  body{margin:0;background:transparent}
  #stage{position:relative;width:1920px;height:1080px}
  .b{position:absolute;top:400px;left:200px;width:300px;height:300px;border-radius:40px;
     background:linear-gradient(135deg,#1E90FF,#A020F0);animation:m 4s linear forwards}
  @keyframes m{from{transform:translateX(0)}to{transform:translateX(1000px)}}
</style></head><body>
<div id="stage" data-composition-id="prueba-real" data-start="0" data-duration="4"
     data-width="1920" data-height="1080" data-fps="30"><div class="b"></div></div>
</body></html>`;

(async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-render-real-'));
  // Dos renders seguidos: el primero con el reparto de siempre y el segundo con
  // el otro candidato, que es exactamente cómo alterna mientras aprende.
  for (const n of [1, 2]) {
    const perfil = pickRenderProfile();
    const out = path.join(dir, 'Marcador ' + n + ' v1 [prueba].mov'); // con espacios y corchetes, como los de verdad
    const t0 = Date.now();
    await renderComposition({
      html: HTML, outMovPath: out, durationSec: 4,
      onProgress: function (p) { if (p.note) console.log('    nota: ' + p.note); },
    });
    const st = fs.statSync(out);
    console.log('  render ' + n + ': ' + perfil.workers + ' worker(s), low-memory=' + perfil.lowMemory +
      ' → ' + ((Date.now() - t0) / 1000).toFixed(1) + 's, ' + (st.size / 1024 / 1024).toFixed(1) + ' MB');
  }

  const datos = perfilStore.leerCrudo();
  console.log('\n  lo que aprendió hasta ahora: ' + JSON.stringify(datos && datos.muestras));
  console.log('  ya eligió: ' + ((datos && datos.elegido) || 'todavía no, sigue juntando'));
  console.log('  carriles que abre la cola: ' + renderLanes());

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
})().catch(function (e) {
  console.error('\n  FALLÓ: ' + e.message);
  process.exitCode = 1;
});
