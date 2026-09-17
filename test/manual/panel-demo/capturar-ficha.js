#!/usr/bin/env node
'use strict';

// Las capturas del interior de la FICHA, para poder mirar lo que los tests no
// pueden: cómo queda.
//
//   node test/manual/panel-demo/abrir.js --no-open &
//   node test/manual/panel-demo/capturar-ficha.js
//
// Deja los PNG en `capturas-1.6.0/` con prefijo `ficha-`. El ANTES de esta etapa
// son los `v160-marcadores-*.png` que ya están en esa carpeta: los sacó la etapa
// 1 desde su propio estado, que es exactamente el estado previo a esto. No se
// pueden volver a sacar (la etapa 1 nunca se commiteó), así que se usan esos.
//
// Y no es una foto decorativa: es lo único que puede decir si una tira de
// referencias envuelve bien, si el aviso de una mención colgada se lee, y si el
// micrófono verde se distingue del rojo. Lo que sí se mide con número está en
// `medir-botones.js` (desborde y solapes) y en `temas/estudiado/auditar.js`
// (contraste real sobre el DOM).
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
const SALIDA = arg('--salida', path.join(__dirname, 'capturas-1.6.0'));
const ALTO = Number(arg('--alto', 700));
const ANCHOS = arg('--anchos', '400,320').split(',').map(Number);

/**
 * Las tomas. `escenario` es el `?e=` de la maqueta y `guion` corre DENTRO de la
 * página: abre lo que haya que abrir y espera.
 *
 * Los marcadores se eligen por su número y no por su posición: los de la maqueta
 * tienen huecos (el 4, el 6 y el 7 se borraron) porque la numeración es por guid.
 */
const TOMAS = [
  {
    n: 'cerrada', que: 'la lista con todas las fichas plegadas',
    guion: { abrir: null },
  },
  {
    n: 'abierta', que: 'una ficha abierta sin ninguna mención escrita',
    guion: { abrir: 'Marcador 11' },
  },
  // Las tres de menciones bajan el CAMPO al final: las menciones están al pie de la
  // instrucción y con el campo arriba quedan abajo del borde. Es la foto que dice si
  // los chips se leen dentro de la frase y si el número se distingue del texto de
  // alrededor. Lo que un chip hace —que diga el número correcto, que se borre
  // entero, que el hover muestre la miniatura— se mide con número en
  // `medir-chips.js`; acá se mira si se lee.
  {
    n: 'menciones', que: 'tres chips de mención: uno propio, uno del curso y uno de la clase',
    guion: { abrir: 'Marcador 1', campoAlFinal: true, traer: '.hp-campo' },
  },
  {
    n: 'colgada', que: 'un chip de una referencia que el disco no tiene: en ámbar y con el nombre',
    guion: { abrir: 'Marcador 5', campoAlFinal: true, traer: '.hp-campo' },
  },
  {
    n: 'documento', que: 'un chip de documento (@Documento_1), de un PDF del curso',
    guion: { abrir: 'Marcador 8', campoAlFinal: true, traer: '.hp-campo' },
  },
  // Las dos del doble clic, que son lo que el editor pidió después de probarlo: el
  // chip abierto como un campo de texto de verdad, y el número que no existe en rojo
  // en vez de deshacerse.
  {
    n: 'numero-editando', que: 'el doble clic abre un campo de texto adentro del chip',
    guion: {
      abrir: 'Marcador 1',
      texto: 'Copiá la disposición de @[marcador/logo-nova.png] y los colores de @[curso/manual-de-marca-nova.png].',
      editarChip: 2,
      traer: '.hp-campo',
    },
  },
  {
    n: 'numero-invalido', que: 'un número que no apunta a nada: en rojo, con el número que se escribió',
    guion: {
      abrir: 'Marcador 1',
      texto: 'Copiá la disposición de @[marcador/logo-nova.png] y los colores de @[Imagen_7].',
      traer: '.hp-campo',
    },
  },
  // El menú del `@`: las dos fotos que dicen si se lee. Una con todo y otra
  // filtrada, que es el estado en el que de verdad se usa (se teclean dos o tres
  // letras y se aprieta Enter).
  {
    n: 'arroba', que: 'el menú del `@` con las referencias agrupadas por ámbito',
    guion: { abrir: 'Marcador 1', arroba: 'Copiá la disposición de @' },
  },
  {
    n: 'arroba-filtrado', que: 'el mismo menú, filtrado por lo que se teclea',
    guion: { abrir: 'Marcador 1', arroba: 'Copiá la disposición de @man' },
  },
  {
    n: 'estilo', que: 'los dos bloques de estilo, con la misma gramática y sin pie de acciones',
    guion: { estilo: true },
  },
  // Las tres del micrófono traen la BARRA a la vista y no el campo: el estado que
  // hay que mirar es el del botón, y en un marcador con seis referencias la barra
  // queda abajo del borde del viewport de 700.
  {
    n: 'mic-listo', que: 'el micrófono en verde: se puede dictar y no está escuchando',
    guion: { abrir: 'Marcador 1', traer: '.hp-controles' },
  },
  {
    n: 'mic-escuchando', que: 'el micrófono en rojo, con el cuadrado de parar',
    guion: { abrir: 'Marcador 1', dictar: true, traer: '.hp-controles' },
  },
  {
    n: 'mic-apagado', escenario: '?e=sin-dictado',
    que: 'donde no se puede dictar: gris, NO verde, y el ✨ prendido igual',
    guion: { abrir: 'Marcador 1', traer: '.hp-controles' },
  },
];

/** Corre dentro de la página. */
const GUION = async function (g) {
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const fichas = [].slice.call(document.querySelectorAll('details.marker-card'));
  fichas.forEach((d) => { d.open = false; });
  ['general-section', 'general-sequence-section', 'context-section'].forEach((id) => {
    const e = document.getElementById(id);
    if (e) e.open = !!g.estilo && id !== 'context-section';
  });
  if (g.abrir) {
    const cual = fichas.filter((d) => (d.textContent || '').indexOf(g.abrir) === 0)[0];
    if (!cual) throw new Error('no encontré la ficha de ' + g.abrir);
    cual.open = true;
    cual.scrollIntoView({ block: 'start' });
    await esperar(500);
    if (g.dictar) {
      // El 🎙 de ESA ficha, que es el primer `.mic-btn` de su barra de controles.
      const mic = cual.querySelector('.hp-controles .mic-btn');
      if (!mic) throw new Error('la ficha de ' + g.abrir + ' no tiene micrófono');
      mic.click();
      // El doble del motor manda `fase: "escuchando"` unos cientos de ms después.
      await esperar(2500);
    }
    if (g.campoAlFinal) {
      const campo = cual.querySelector('.hp-campo-input');
      if (!campo) throw new Error('la ficha de ' + g.abrir + ' no tiene campo');
      campo.scrollTop = campo.scrollHeight;
      campo.dispatchEvent(new Event('scroll'));
      await esperar(200);
    }
    if (g.traer) {
      const t = cual.querySelector(g.traer);
      if (!t) throw new Error('no encontré ' + g.traer + ' en la ficha de ' + g.abrir);
      t.scrollIntoView({ block: 'center' });
      await esperar(300);
    }
    if (g.texto) {
      const campo = cual.querySelector('.hp-campo-input');
      if (!campo) throw new Error('la ficha de ' + g.abrir + ' no tiene campo');
      campo.value = g.texto;
      campo.dispatchEvent(new Event('input', { bubbles: true }));
      await esperar(300);
    }
    if (g.editarChip) {
      // El doble clic sobre un chip, que abre su `<input>`. Se dispara el evento en
      // vez de hacer dos clics con el mouse porque acá se saca una foto: lo que el
      // teclado de verdad hace con ese input se mide en `medir-chips.js`.
      const chip = cual.querySelectorAll('.hp-chip')[g.editarChip - 1];
      if (!chip) throw new Error('la ficha de ' + g.abrir + ' no tiene un chip ' + g.editarChip);
      chip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await esperar(300);
      if (!cual.querySelector('.hp-chip.is-editando input')) {
        throw new Error('el doble clic no abrió el campo de texto del chip');
      }
    }
    if (g.arroba) {
      // El menú del `@`, abierto por el mismo camino que lo abre el editor: el
      // valor, el cursor y el `input`. No se teclea con el teclado porque acá se
      // saca una foto, no se mide: lo que el teclado de verdad hace con el Enter y
      // con las flechas se mide en `medir-chips.js`.
      const campo = cual.querySelector('.hp-campo-input');
      if (!campo) throw new Error('la ficha de ' + g.abrir + ' no tiene campo');
      campo.value = g.arroba;
      campo.focus();
      campo.setSelectionRange(g.arroba.length, g.arroba.length);
      campo.dispatchEvent(new Event('input', { bubbles: true }));
      await esperar(400);
      if (!document.querySelector('.hp-arroba[data-hidden="false"]')) {
        throw new Error('el menú del `@` no se abrió con «' + g.arroba + '»');
      }
    }
  }
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
        // El favicon que el servidor de la maqueta no tiene no es un panel roto. Y
        // la URL viene en `location()`, no en el texto: el mensaje del 404 es
        // genérico ("Failed to load resource…") y filtrarlo por texto no filtra nada.
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
      // La maqueta aprieta "Cargar marcadores" sola unos segundos después de
      // cargar (en Premiere lo toca el editor); antes de eso no hay fichas.
      await new Promise((r) => setTimeout(r, 4500));
      await page.evaluate(GUION, t.guion);
      const f = path.join(SALIDA, 'ficha-' + t.n + '-' + w + '.png');
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
