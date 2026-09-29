#!/usr/bin/env node
'use strict';

// Las capturas de la fila «Motor de animación» en ⚙, en sus tres estados.
//
//   node test/manual/panel-demo/abrir.js --no-open &
//   node test/manual/panel-demo/capturar-motor.js
//
// Deja los PNG en `capturas-1.7.0/` con prefijo `motor-`.
//
// ── Por qué tres fotos y no una ──────────────────────────────────────
//
// Porque son tres cosas que se arreglan distinto y por lo tanto tienen que
// LEERSE distinto, y eso es exactamente lo que un test no puede contestar:
//
//   listo          El motor elegido y usable. Debajo, la condición de la
//                  licencia gratuita de Remotion, que es el único dato que hay
//                  que saber antes de elegirlo.
//   sin-instalar   Lo que va a ver la mayoría la primera vez. Se ofrece igual
//                  —esconderlo dejaría al editor sin manera de descubrir que
//                  existe— con un «— sin instalar» en la opción misma y su
//                  botón al lado.
//   a-medias       Remotion está y su navegador no (el bug de Node 26). Es un
//                  cartel aparte a propósito: decir solo «no está instalado»
//                  manda a reinstalar 400 MB cuando lo que falta son 137 de
//                  Chrome.
//
// Y una cuarta, `instalando`, que es la única que dice si la barra de progreso y
// el mensaje largo entran en la fila sin desbordarla.
//
// Si la página tira un error de JS, esto FALLA en vez de sacar una foto de un
// panel roto — que es exactamente la foto que uno mira y da por buena.

const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..', '..', '..');
const puppeteer = require(path.join(RAIZ, 'bridge', 'node_modules', 'puppeteer-core'));
const CHROME = process.env.HP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(n, d) { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; }

const BASE = arg('--base', 'http://localhost:4599/');
const SALIDA = arg('--salida', path.join(__dirname, 'capturas-1.7.0'));
const ALTO = Number(arg('--alto', 700));
// Los dos anchos de siempre: 400 es el panel acoplado normal y 320 el mínimo en
// el que el editor lo deja cuando quiere ver el timeline. La fila tiene un
// desplegable y un botón en la misma línea, así que 320 es donde se rompería.
const ANCHOS = arg('--anchos', '400,320').split(',').map(Number);

const TOMAS = [
  {
    n: 'hyperframes', escenario: '',
    que: 'el de siempre elegido: el estado en el que abre cualquier panel de hoy',
  },
  {
    n: 'listo', escenario: '?e=remotion',
    que: 'Remotion elegido y usable, con la condición de su licencia debajo',
  },
  {
    n: 'sin-instalar', escenario: '?e=remotion-sin-instalar', elegir: 'remotion',
    que: 'elegido pero sin instalar: el motivo y su botón al lado',
  },
  {
    n: 'a-medias', escenario: '?e=remotion-a-medias',
    que: 'instalado pero sin su navegador: el motivo dice QUÉ falta',
  },
  {
    n: 'desplegado', escenario: '?e=remotion-sin-instalar', desplegar: true,
    que: 'el desplegable abierto: las dos opciones, una con su aviso',
  },
  {
    n: 'instalando', escenario: '?e=remotion-sin-instalar', elegir: 'remotion', instalar: true,
    que: 'la barra y el mensaje del instalador, que es donde la fila desbordaría',
  },
  // El editor de código: son dos gramáticas de Prism y dos juegos de colores, y
  // si algo no se lee se ve acá y no en un test.
  {
    n: 'editor-html', escenario: '', ficha: 'Intro / placa de título',
    que: 'el editor resaltando HTML, que es el de siempre',
  },
  {
    n: 'editor-tsx', escenario: '?e=remotion', ficha: 'Intro / placa de título',
    que: 'el mismo editor resaltando TSX: otro componente de Prism',
  },
  // Y los dos finales de "Vista previa": el motor que puede y el que no. El
  // segundo es el que importa mirar, porque es un párrafo de motivo dentro de
  // una línea de estado y tiene que leerse.
  {
    n: 'vista-previa', escenario: '?e=remotion', ficha: 'Intro / placa de título', previa: true,
    que: 'la vista previa abierta: el panel dice que la ventana está afuera',
  },
  {
    n: 'vista-previa-no', escenario: '', ficha: 'Intro / placa de título', previa: true,
    que: 'HyperFrames no puede, y el motivo se lee entero en la línea de estado',
  },
];

/** Corre dentro de la página. */
const GUION = async function (g) {
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  // Acotado a UN nodo y no a todo el documento: cada ficha de marcador tiene su
  // propio "Abrir" y su propia "Vista previa", así que buscar en el documento
  // apretaba el de otra ficha y la foto salía con el editor vacío.
  const conTexto = (raiz, t) => [].slice.call(raiz.querySelectorAll('button'))
    .filter((b) => (b.textContent || '').trim() === t);

  // Las tomas del editor de código y de la vista previa no son de ⚙: viven en la
  // ficha de un marcador, adentro de "Avanzado".
  if (g.ficha) {
    const fichas = [].slice.call(document.querySelectorAll('details.marker-card'));
    const suya = fichas.filter((d) => (d.textContent || '').indexOf(g.ficha) !== -1)[0];
    if (!suya) throw new Error('no encontré la ficha de ' + g.ficha);
    fichas.forEach((d) => { d.open = false; });
    suya.open = true;
    await esperar(700);
    [].slice.call(suya.querySelectorAll('details')).forEach((d) => { d.open = true; });
    await esperar(700);
    const abrir = conTexto(suya, 'Abrir')[0];
    if (!abrir) throw new Error('la ficha no ofrece "Abrir" en el editor de código');
    abrir.click();
    await esperar(1500);
    const puesto = suya.querySelector('.code-input');
    if (!puesto || !puesto.value.trim()) throw new Error('"Abrir" no cargó el código en el editor');
    if (g.previa) {
      const b = conTexto(suya, 'Vista previa')[0];
      if (!b) throw new Error('la ficha no ofrece "Vista previa"');
      b.click();
      await esperar(1500);
      // Se trae a la vista la LÍNEA DE ESTADO, que es donde aparece el motivo
      // cuando el motor no puede: con el editor arriba queda abajo del borde.
      const est = suya.querySelector('.html-editor-body .marker-status');
      if (est) est.scrollIntoView({ block: 'center' });
    } else {
      const ed = suya.querySelector('.code-edit');
      if (ed) ed.scrollIntoView({ block: 'center' });
    }
    await esperar(400);
    return;
  }

  document.getElementById('btn-config').click();
  await esperar(600);

  const fila = document.getElementById('row-engine');
  if (!fila) throw new Error('⚙ no dibujó la fila del motor de animación');
  const abrir = () => fila.querySelector('.hps-trigger').click();

  // Elegir se hace por el desplegable de verdad y no seteando un valor: es el
  // gesto del editor, y es lo que dispara el guardado y el repintado de la
  // línea de estado — que es justo lo que estas fotos vienen a mirar.
  if (g.elegir) {
    abrir();
    await esperar(300);
    const opcion = [].slice.call(fila.querySelectorAll('.hps-option'))
      .filter((o) => o.getAttribute('data-value') === g.elegir)[0];
    if (!opcion) throw new Error('el desplegable no ofrece «' + g.elegir + '»');
    opcion.click();
    await esperar(500);
  }

  if (g.instalar) {
    const b = document.getElementById('btn-install-engine');
    if (!b || b.getAttribute('data-hidden') === 'true') {
      throw new Error('el botón de instalar no está a la vista');
    }
    b.click();
    // A mitad de la instalación, no al final: lo que hay que mirar es la barra
    // y el mensaje largo conviviendo con el desplegable.
    await esperar(1400);
  } else if (g.desplegar) {
    abrir();
    await esperar(400);
  }

  fila.scrollIntoView({ block: 'center' });
  await esperar(300);
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
      // Las tomas de una ficha necesitan que la maqueta ya haya cargado los
      // marcadores: los aprieta sola unos segundos después de abrir (en Premiere
      // lo toca el editor). Las de ⚙ no esperan eso.
      await new Promise((r) => setTimeout(r, t.ficha ? 5000 : 2500));
      await page.evaluate(GUION, {
        elegir: t.elegir || '', instalar: !!t.instalar, desplegar: !!t.desplegar,
        ficha: t.ficha || '', previa: !!t.previa,
      });
      const f = path.join(SALIDA, 'motor-' + t.n + '-' + w + '.png');
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
