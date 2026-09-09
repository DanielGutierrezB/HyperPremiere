#!/usr/bin/env node
'use strict';

// Mide TODOS los botones del panel, a mano, sobre la maqueta.
//
// Hermano de `medir-encabezado.js`, pero para el panel entero: las tres
// pestañas, ⚙, la ayuda, los paneles que se despliegan (feedback, editor de
// HTML, diagnóstico, el medidor del micrófono) y los escenarios raros. Existe
// porque el `button { flex: … }` global decide el ancho de cada botón del panel
// y "a ojo" no alcanza: un botón que quedó en 79 px con una etiqueta de 102 px
// se ve como un botón, solo que con el texto pintado afuera de su caja.
//
// Para cada botón visible compara su ancho REAL contra el que necesita su
// contenido. El ancho necesario NO se estima: se clona el botón como hermano
// suyo —así los selectores por descendencia y por hijo siguen aplicando— con
// `width: max-content` y se lo mide. Además busca pares de hermanos flex que se
// superpongan y el desborde horizontal del documento.
//
// Dos precisiones que costaron sangre y sin las cuales el número miente:
//
//   · `scrollWidth` NO sirve de criterio acá. Los botones son `inline-flex` con
//     `justify-content: center`, así que el texto que no entra se sale por los
//     DOS lados, y `scrollWidth` solo cuenta el desborde de la derecha. Medido:
//     585 botones con el contenido afuera, de los cuales `scrollWidth` delataba
//     310. Por eso el criterio es max-content contra ancho real.
//
//   · Lo que recorta con ellipsis NO chorrea. Un `.hps-trigger` con el nombre
//     de un micrófono pide 322 px y vive en 99: eso es un nombre recortado, no
//     texto pintado sobre el vecino. Para separarlos, al clonar se le congela
//     el ancho actual a todo descendiente que recorte, y así el "necesita" que
//     se compara es el del contenido que NO se puede recortar.
//
// Los tests del repo NO miden cajas (el DOM de mentira no tiene motor de
// layout): fijan las reglas de CSS. La medición se rehace acá.
//
// Levantá la maqueta primero (`node test/manual/panel-demo/abrir.js --no-open`).
//
//   node test/manual/panel-demo/medir-botones.js
//   node test/manual/panel-demo/medir-botones.js --json /tmp/antes.json
//   node test/manual/panel-demo/medir-botones.js --anchos 320,400 --vistas marcadores,cola
//   node test/manual/panel-demo/medir-botones.js --capturas /tmp/antes
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

const BASE = arg('--base', 'http://localhost:4599/');
const ANCHOS = String(arg('--anchos', '320,360,400,470,600,900')).split(',').map(Number);
const JSON_OUT = arg('--json', '');
const CAPS = arg('--capturas', '');

// ── Las vistas ────────────────────────────────────────────────────────
//
// Cada una es un estado del panel que no se puede ver a la vez que otro. El
// `abrir` corre DENTRO de la página: despliega lo que haga falta y devuelve.

// `esperar` es un selector que TIENE que estar visible cuando la vista quedó
// bien abierta. No es decoración: la maqueta aprieta "Cargar marcadores" sola
// unos segundos después de cargar, y ese redibujo se comía el clic en la
// pestaña —la medición de la cola terminaba midiendo, otra vez, la de
// marcadores—. Con esto, si la vista no quedó abierta se reintenta, y si ni
// así, la corrida falla en vez de mentir.
const VISTAS = [
  { nombre: 'marcadores', escenario: '', abrir: 'todoAbierto', esperar: '.marker-card[open]' },
  { nombre: 'prompts-generales', escenario: '', abrir: 'promptsGenerales', esperar: '#general-section[open] #general-instruction, #general-sequence-section[open] #general-sequence-instruction' },
  { nombre: 'sin-secuencia', escenario: '?e=sin-secuencia', abrir: 'promptsGenerales', esperar: '#general-section[open] #general-instruction' },
  { nombre: 'cola', escenario: '', abrir: 'cola', esperar: '.qbtn-fresh' },
  { nombre: 'cola-editor', escenario: '', abrir: 'colaEditor', esperar: '.code-edit' },
  { nombre: 'corrections', escenario: '', abrir: 'corrections', esperar: '.corr-row' },
  // El contexto de cada fila desplegado, y con un nivel ajustado a mano para que
  // aparezca el botón de guardarlo en el proyecto. Es su propia vista porque ese
  // botón no existe hasta que hay algo que guardar, así que en `corrections` no
  // se mide nunca — y es el único botón nuevo de la fila.
  { nombre: 'corrections-contexto', escenario: '', abrir: 'correctionsContexto', esperar: '.corr-level-save' },
  { nombre: 'config', escenario: '', abrir: 'config', esperar: '#btn-save-config' },
  { nombre: 'ayuda', escenario: '', abrir: 'ayuda', esperar: '#btn-help-close' },
  { nombre: 'mic-medidor', escenario: '', abrir: 'micMedidor', esperar: '.mic-meter, .mic-medidor, #mic-status' },
  { nombre: 'vacio', escenario: '?e=vacio', abrir: 'todoAbierto', esperar: '' },
  { nombre: 'preparar', escenario: '?e=preparar', abrir: 'todoAbierto', esperar: '#btn-prepare-engine' },
  { nombre: 'whisper', escenario: '?e=whisper', abrir: 'todoAbierto', esperar: '#btn-install-whisper' },
  { nombre: 'conflicto', escenario: '?e=conflicto', abrir: 'todoAbierto', esperar: '.general-conflict-actions button' },
  // El cartel de la migración de las REFERENCIAS. Va aparte del de arriba —que
  // es el del texto— porque sus tres botones viven adentro del bloque de la
  // secuencia, debajo del renglón más largo del panel, y son tres en un renglón:
  // es el candidato obvio a desbordar a 320 px.
  { nombre: 'refs-conflicto', escenario: '?e=refs-conflicto', abrir: 'promptsGenerales', esperar: '#general-refs-conflict .general-conflict-actions button' },
  { nombre: 'mic-perdido', escenario: '?e=mic-perdido', abrir: 'config', esperar: '#btn-save-config' },
  { nombre: 'mic-mudo', escenario: '?e=mic-mudo', abrir: 'micMedidor', esperar: '#mic-status' },
  { nombre: 'sin-medir', escenario: '?e=sin-medir', abrir: 'config', esperar: '#btn-save-config' },
  { nombre: 'api-key', escenario: '?e=api-key', abrir: 'config', esperar: '#btn-save-config' },
  // Los cuatro estados de Cursor en ⚙. Van a la medición y no solo a las
  // capturas porque la fila de Cursor suma un botón de Diagnóstico al lado de
  // una línea de estado, y esa fila es exactamente la forma que en la 1.4.50
  // hacía falta apuntalar con parches de botón aplastado. Si vuelve a
  // desbordar a 320 px, que se entere esta corrida y no un editor.
  { nombre: 'cursor', escenario: '?e=cursor', abrir: 'config', esperar: '#btn-save-config' },
  { nombre: 'cursor-sin-sesion', escenario: '?e=cursor-sin-sesion', abrir: 'config', esperar: '#btn-save-config' },
  { nombre: 'cursor-sin-cli', escenario: '?e=cursor-sin-cli', abrir: 'config', esperar: '#btn-save-config' },
  { nombre: 'cursor-sin-cupo', escenario: '?e=cursor-sin-cupo', abrir: 'config', esperar: '#btn-save-config' },
];

const SOLO = arg('--vistas', '');
const ELEGIDAS = SOLO ? VISTAS.filter((v) => SOLO.split(',').indexOf(v.nombre) !== -1) : VISTAS;

// ── Lo que corre dentro de la página ──────────────────────────────────

/**
 * Despliega todo lo que se pueda desplegar de la vista pedida.
 *
 * Es `async` a propósito: cambiar de pestaña redibuja, y los controles que hay
 * que apretar después (los paneles de feedback de cada job) todavía no existen
 * en el mismo tick. Sin las esperas del medio, la cola se medía a medio armar.
 */
const ABRIR = async function (modo) {
  const respirar = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function abrirDetalles() {
    [].slice.call(document.querySelectorAll('details')).forEach(function (d) { d.open = true; });
  }
  function apretar(id) { const e = document.getElementById(id); if (e) e.click(); return !!e; }

  if (modo === 'todoAbierto') {
    abrirDetalles();
  } else if (modo === 'promptsGenerales') {
    // Los dos bloques de estilo no se pueden medir con `todoAbierto`: main.js
    // tiene un acordeón, y abrir la tarjeta de un marcador los PLIEGA a los dos
    // para darle la pantalla al marcador. Así que se cierran las tarjetas y se
    // abren éstos, que es la única forma de verlos con sus dos campos, sus dos
    // micrófonos y los dos renglones de qué viaja. Son dos y están lejos —el del
    // curso arriba, el de la clase adentro del área de marcadores—, así que la
    // foto de esta vista es la que muestra si el panel entero desborda con los
    // dos desplegados a la vez.
    [].slice.call(document.querySelectorAll('details.marker-card')).forEach(function (d) { d.open = false; });
    ['general-section', 'general-sequence-section'].forEach(function (id) {
      const gen = document.getElementById(id);
      if (gen) gen.open = true;
    });
    await respirar(400);
  } else if (modo === 'cola' || modo === 'colaEditor') {
    apretar('tab-queue');
    await respirar(1200);
    // La cola tiene UN panel desplegado a la vez en todo el tablero: abrir el
    // editor de HTML de un job cierra el feedback de cualquier otro. Por eso
    // son dos vistas y no una — `.qj-feedback` (campo + dos botones que no
    // pueden encogerse) y `.editor-row` (desplegable + botón) no se pueden
    // medir en la misma foto.
    const conTexto = function (t) {
      return [].slice.call(document.querySelectorAll('.qbtn'))
        .filter(function (b) { return (b.textContent || '').indexOf(t) !== -1; });
    };
    const objetivo = conTexto(modo === 'cola' ? 'Feedback' : 'Editar HTML')[0];
    if (objetivo) objetivo.click();
    await respirar(800);
    abrirDetalles();
  } else if (modo === 'corrections') {
    apretar('tab-corrections');
    await respirar(1200);
  } else if (modo === 'correctionsContexto') {
    apretar('tab-corrections');
    await respirar(1400);
    abrirDetalles();
    await respirar(300);
    // Tipear de verdad en el campo del curso de la primera fila: el botón de
    // guardarlo en el proyecto se crea al primer cambio, no antes.
    const campo = document.querySelector('.corr-level .corr-level-input');
    if (campo) {
      campo.value = campo.value + '\nY para este cartel: nada de degradés.';
      campo.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await respirar(300);
  } else if (modo === 'config') {
    apretar('btn-config');
    await respirar(600);
    abrirDetalles();
  } else if (modo === 'ayuda') {
    apretar('btn-help');
    await respirar(400);
  } else if (modo === 'micMedidor') {
    apretar('btn-config');
    await respirar(600);
    abrirDetalles();
    apretar('btn-mic-test');
    await respirar(900);
  }
  return true;
};

/**
 * La medición. Devuelve un registro por botón visible con su ancho real y el
 * que necesita su contenido, más los solapes entre hermanos flex.
 */
const MEDIR = function () {
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }

  function recorta(el) {
    const s = getComputedStyle(el);
    return s.overflowX !== 'visible' || s.textOverflow === 'ellipsis';
  }

  /**
   * El ancho que el botón necesita para su contenido. Se clona como HERMANO
   * suyo para que los selectores por descendencia (`.actions button`) y por
   * hijo (`.ep-row > button`) sigan aplicando, se lo saca del flujo y se lo
   * deja pedir su `max-content`.
   *
   * `congelarRecortes` es la diferencia entre "el contenido no entra" y "el
   * contenido se pinta afuera": a los descendientes que recortan se les fija el
   * ancho que tienen ahora, porque ese contenido no va a salirse de ningún lado
   * por más que le falte lugar.
   */
  function necesita(el, congelarRecortes) {
    const c = el.cloneNode(true);
    c.setAttribute('data-medicion', '1');
    c.style.cssText += ';position:absolute!important;left:-99999px!important;top:0!important;' +
      'visibility:hidden!important;pointer-events:none!important;width:max-content!important;' +
      'max-width:none!important;min-width:0!important;flex:none!important;';
    if (congelarRecortes) {
      const orig = [].slice.call(el.querySelectorAll('*'));
      const copia = [].slice.call(c.querySelectorAll('*'));
      orig.forEach(function (o, i) {
        if (!copia[i] || !recorta(o)) return;
        const px = o.getBoundingClientRect().width;
        copia[i].style.cssText += ';width:' + px + 'px!important;flex:0 0 ' + px + 'px!important;';
      });
    }
    el.parentNode.appendChild(c);
    const w = Math.ceil(c.getBoundingClientRect().width);
    c.parentNode.removeChild(c);
    return w;
  }

  function clave(el) {
    if (el.id) return '#' + el.id;
    const cls = (el.getAttribute('class') || '').split(' ').filter(Boolean).slice(0, 2).join('.');
    return (cls ? '.' + cls : el.tagName.toLowerCase()) + '«' + (el.textContent || '').trim().slice(0, 24) + '»';
  }

  const botones = [].slice.call(document.querySelectorAll('button')).filter(visible);
  const conteo = {};
  const filas = botones.map(function (b) {
    const k = clave(b);
    conteo[k] = (conteo[k] || 0) + 1;
    const r = b.getBoundingClientRect();
    const real = Math.round(r.width);
    const nec = necesita(b, true);
    return {
      clave: k + (conteo[k] > 1 ? '#' + conteo[k] : ''),
      texto: (b.textContent || '').trim().slice(0, 34),
      x: Math.round(r.x), y: Math.round(r.y), w: real, h: Math.round(r.height),
      necesita: nec,
      // Lo que pide el contenido entero, recorte o no: sirve para ver a qué
      // ancho el botón deja de recortar, no para decir si está roto.
      necesitaCrudo: necesita(b, false),
      // Lo que se pinta afuera de la caja. Es el bug, medido.
      chorrea: Math.max(0, nec - real),
      scrollW: b.scrollWidth, clientW: b.clientWidth,
    };
  });

  // Solapes: en flex las cajas no se pisan solas, pero un `position` mal puesto
  // o un margen negativo sí las pisa. Se comparan hermanos de un mismo
  // contenedor flex, que es donde tendría sentido que pasara.
  const solapes = [];
  [].slice.call(document.querySelectorAll('*')).forEach(function (cont) {
    const d = getComputedStyle(cont).display;
    if (d !== 'flex' && d !== 'inline-flex') return;
    const hijos = [].slice.call(cont.children).filter(visible).filter(function (h) {
      const p = getComputedStyle(h).position;
      return p === 'static' || p === 'relative';
    });
    for (let i = 0; i < hijos.length; i++) {
      for (let j = i + 1; j < hijos.length; j++) {
        const a = hijos[i].getBoundingClientRect(), b = hijos[j].getBoundingClientRect();
        const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (dx > 1 && dy > 1) solapes.push({ a: clave(hijos[i]), b: clave(hijos[j]), px: Math.round(dx) });
      }
    }
  });

  const de = document.documentElement;
  return {
    doc: { scrollW: de.scrollWidth, clientW: de.clientWidth, desborde: de.scrollWidth - de.clientWidth },
    botones: filas,
    solapes: solapes,
  };
};

// ── El recorrido ──────────────────────────────────────────────────────

(async function () {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--force-device-scale-factor=2', '--hide-scrollbars'],
  });
  const salida = {};
  let totalBotones = 0, totalChorrean = 0, totalSolapes = 0, totalDesborde = 0;

  for (const vista of ELEGIDAS) {
    salida[vista.nombre] = {};
    for (const w of ANCHOS) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: 600, deviceScaleFactor: 2 });
      await page.goto(BASE + vista.escenario, { waitUntil: 'networkidle2' });
      // La maqueta aprieta "Cargar marcadores" sola y el motor falso tarda.
      await new Promise((r) => setTimeout(r, 4000));
      await page.evaluate(ABRIR, vista.abrir);
      await new Promise((r) => setTimeout(r, 900));
      if (vista.esperar) {
        const hay = () => page.evaluate(function (sel) {
          return [].slice.call(document.querySelectorAll(sel)).some(function (e) {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
        }, vista.esperar);
        for (let intento = 0; intento < 3 && !(await hay()); intento++) {
          await page.evaluate(ABRIR, vista.abrir);
          await new Promise((r) => setTimeout(r, 1200));
        }
        if (!(await hay())) {
          throw new Error('la vista «' + vista.nombre + '» a ' + w + ' px no llegó a abrirse: ' +
            'no aparece «' + vista.esperar + '». Sin esto la medición diría otra cosa de la que dice medir.');
        }
      }
      const m = await page.evaluate(MEDIR);
      salida[vista.nombre][w] = m;

      const malos = m.botones.filter(function (b) { return b.chorrea > 1; });
      totalBotones += m.botones.length;
      totalChorrean += malos.length;
      totalSolapes += m.solapes.length;
      if (m.doc.desborde > 0) totalDesborde++;

      console.log('── ' + vista.nombre.padEnd(12) + ' ' + String(w).padStart(4) + 'px  ' +
        'botones=' + String(m.botones.length).padStart(3) +
        '  chorrean=' + String(malos.length).padStart(2) +
        '  solapes=' + m.solapes.length +
        '  desborde-doc=' + m.doc.desborde);
      malos.forEach(function (b) {
        console.log('     ✗ ' + b.clave.slice(0, 42).padEnd(42) + ' w=' + String(b.w).padStart(4) +
          ' necesita=' + String(b.necesita).padStart(4) + '  (+' + b.chorrea + ')');
      });
      m.solapes.forEach(function (s) {
        console.log('     ⚠ solape ' + s.a.slice(0, 30) + ' × ' + s.b.slice(0, 30) + ' (' + s.px + 'px)');
      });

      if (CAPS) {
        fs.mkdirSync(CAPS, { recursive: true });
        await page.screenshot({ path: path.join(CAPS, vista.nombre + '-' + w + '.png') });
      }
      await page.close();
    }
  }

  console.log('\n═══ TOTAL ' + '═'.repeat(40));
  console.log('  mediciones de botón : ' + totalBotones);
  console.log('  botones que chorrean: ' + totalChorrean);
  console.log('  solapes             : ' + totalSolapes);
  console.log('  vistas con desborde : ' + totalDesborde);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(salida, null, 1));
    console.log('  json                : ' + JSON_OUT);
  }
  await browser.close();
})().catch(function (e) { console.error(e); process.exit(1); });
