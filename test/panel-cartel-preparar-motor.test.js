'use strict';

// El cartel de "Preparar motor" desbordaba el panel a lo ancho.
//
// Es lo primero que ve el editor que abre la herramienta en una instalación
// limpia, y es justo el que más necesita apretar ese botón. Medido en la maqueta
// (test/manual/panel-demo, que usa el HTML y el CSS de verdad) a 360, 400, 440,
// 470, 520 y 600 px: el panel se iba 18 px de ancho en TODOS —el mismo desborde
// a cualquier ancho, porque no era el panel el que quedaba chico—.
//
// La causa: el `button { flex: 1; min-width: 0 }` global, que está para la barra
// de acciones —donde tres botones se reparten la fila en partes iguales—. En
// `#engine-prep .ep-row` el botón queda al lado de un texto largo, y con base 0
// y permiso para encogerse se le fue todo el espacio al texto: el botón terminó
// en 22 px de ancho con la etiqueta ("Preparar motor", 103 px) chorreando fuera
// del panel y scroll horizontal en toda la extensión.
//
// Lo que se probó a mano después del arreglo, a los mismos seis anchos:
// `document.documentElement.scrollWidth` igual a `clientWidth` (a 470 px sobra
// una franja de 5 px, pero es la etiqueta de versión del header, que es otro
// asunto), el botón en sus 105 px enteros y la fila bajándolo de línea a 360 px.
//
// ── Actualización: el blindaje del botón se fue, y está bien ──────────
//
// El arreglo de entonces fue `.ep-row > button { flex: 0 0 auto }`: un parche
// para ESTE cartel contra una regla global rota. Después resultó que el mismo
// global mordía en otros tres lugares, así que se lo invirtió de raíz —los
// botones ya no se dejan aplastar por default— y los veinticuatro parches
// sueltos se sacaron (ver panel-botones-flex.test.js, que fija la regla nueva y
// tiene los números del panel entero). Vuelto a
// medir con `medir-botones.js` sobre 15 vistas y seis anchos: sacar el blindaje
// de este cartel no cambió ni una de las 7578 mediciones de ancho de botón.
//
// Lo que sigue siendo propio del cartel, y lo que estos tests fijan, es la
// FILA: que envuelva y que el texto pida una base en px. Eso no lo resuelve
// ningún default, y es lo que decide si el botón baja de renglón o si el texto
// queda a cuatro palabras por línea.
//
// Lo que estos tests NO hacen: medir cajas. El DOM de mentira del repo no tiene
// motor de layout —no calcula anchos, no reparte flex, no envuelve nada—, así
// que un test que dijera "no desborda" acá estaría fingiendo. Lo que se fija es
// la regla de CSS. La medición de verdad se rehace con la maqueta.

const fs = require('fs');
const path = require('path');
const { test, ok, eq } = require('./harness');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'cep', 'css', 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'cep', 'index.html'), 'utf8');

/**
 * Reglas hoja de una hoja de estilo. Sin dependencias: saca los comentarios y
 * recorre contando llaves, así un `@keyframes` no pasa por selector y su
 * contenido no se confunde con declaraciones.
 */
function reglas(css) {
  const limpio = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const abiertos = [];
  let selDesde = 0;
  for (let i = 0; i < limpio.length; i++) {
    if (limpio[i] === '{') {
      abiertos.push({ selector: limpio.slice(selDesde, i).trim(), desde: i + 1 });
      selDesde = i + 1;
    } else if (limpio[i] === '}') {
      const b = abiertos.pop();
      if (b) {
        const cuerpo = limpio.slice(b.desde, i);
        // Un bloque con llaves adentro es un @media / @keyframes, no una regla.
        if (cuerpo.indexOf('{') === -1) out.push({ selector: b.selector, cuerpo: cuerpo });
      }
      selDesde = i + 1;
    }
  }
  return out;
}

const REGLAS = reglas(CSS);

/** Las declaraciones de todas las reglas con ese selector exacto, en orden. */
function declaraciones(selector) {
  const d = {};
  REGLAS.filter(function (r) { return r.selector === selector; }).forEach(function (r) {
    r.cuerpo.split(';').forEach(function (par) {
      const i = par.indexOf(':');
      if (i !== -1) d[par.slice(0, i).trim()] = par.slice(i + 1).trim();
    });
  });
  return d;
}

/** Qué `flex-shrink` deja una regla, venga por la abreviada o por la larga. */
function flexShrink(d) {
  if (d['flex-shrink'] !== undefined) return Number(d['flex-shrink']);
  if (d.flex === undefined) return undefined;
  if (d.flex === 'none') return 0;
  const p = d.flex.split(/\s+/);
  return p.length === 1 ? 1 : Number(p[1]); // `flex: 1` también deja encoger
}

/** Y qué base: es la que decide a qué ancho la fila envuelve. */
function flexBasis(d) {
  if (d['flex-basis'] !== undefined) return d['flex-basis'];
  if (d.flex === undefined) return undefined;
  if (d.flex === 'none') return 'auto';
  const p = d.flex.split(/\s+/);
  if (p.length === 3) return p[2];
  return /^[\d.]+$/.test(p[0]) ? '0%' : p[0];
}

test('el botón del cartel no se encoge (ahí se aplastaba a 22 px)', function () {
  // Ya no hace falta decirlo para este botón: lo dice el default de todos.
  // `flex: 0 1 auto` sin `min-width: 0` deja que el mínimo automático de flex
  // sea el min-content del botón, y como es `nowrap`, ese min-content es su
  // etiqueta entera. Ese es el piso que antes faltaba.
  const g = declaraciones('button');
  eq(flexBasis(g), 'auto', 'la base de cualquier botón es su propio ancho, no 0');
  eq(g['min-width'], undefined, 'y nadie le saca el piso automático: ahí estaba el bug');
  eq(declaraciones('.engine-prep .ep-row > button').flex, undefined,
    'y el parche propio del cartel se sacó: con el default arreglado no cambiaba nada');
});

test('el reparto de la barra de acciones NO alcanza a este botón', function () {
  // Lo que aplastaba al cartel era que el reparto de `.actions` estuviera
  // escrito sobre `button` pelado. Ahora está donde corresponde, y un selector
  // con clase no llega hasta acá.
  const reparto = REGLAS.filter(function (r) {
    return !r.dentroDeMedia && /flex/.test(r.cuerpo) && /^button$/.test(r.selector) && /flex:\s*1/.test(r.cuerpo);
  });
  eq(reparto.length, 0, 'ningún `button { flex: 1 }` global: es la regla que mordió cuatro veces');
  ok(REGLAS.some(function (r) { return r.selector === '.actions button' && /flex/.test(r.cuerpo); }),
    'el reparto vive en `.actions button`, que es la fila para la que se escribió');
});

test('la fila baja el botón de línea cuando no caben los dos', function () {
  // Los textos de este cartel los escribe el JS y cambian de largo (qué Whisper
  // falta, cuánto pesa, por qué acá no se puede), y la etiqueta del botón
  // también: "Instalar Whisper" pasa a "Reintentar instalación" tras un fallo.
  // Blindar el botón sin envolver la fila dejaría el texto a cuatro palabras por
  // línea en un panel angosto; envolviendo, el botón se va abajo entero.
  const d = declaraciones('.engine-prep .ep-row');
  eq(d['flex-wrap'], 'wrap', 'la fila del cartel tiene que envolver');
});

test('el texto del cartel reclama un ancho mínimo, que es lo que hace envolver', function () {
  // Con base `auto` la fila envolvería SIEMPRE (el texto pide su max-content) y
  // con base 0 no envolvería NUNCA. La base en px es la que pone el umbral: el
  // botón se va abajo recién cuando al texto no le quedan ni esos px.
  const d = declaraciones('.engine-prep .ep-text');
  const base = flexBasis(d);
  ok(/^\d+px$/.test(base), 'la base del texto va en px, no en auto ni en 0: ' + base);
  ok(parseInt(base, 10) >= 120, 'y tiene que dar para leer una línea, no dos palabras');
  eq(flexShrink(d), 1, 'el texto sí puede encogerse: es el que cede, no el botón');
});

test('las dos filas del cartel siguen siendo texto + botón, sin envoltorios', function () {
  // La fila es un contenedor flex de exactamente dos hijos, y de ahí sale todo
  // lo de arriba: el texto es el que cede (base 240 px) y el botón el que baja
  // de renglón. Meter un div en el medio deja al texto sin su base y el umbral
  // de envolver se lo lleva el envoltorio, que no tiene ninguna.
  const filas = HTML.match(/<div[^>]*class="ep-row"[^>]*>[\s\S]*?<\/div>/g) || [];
  eq(filas.length, 2, 'el cartel tiene dos filas: dependencias del motor y Whisper');
  filas.forEach(function (f) {
    ok(/<span[^>]*class="ep-text"/.test(f), 'la fila lleva su texto con class="ep-text"');
    eq((f.match(/<button/g) || []).length, 1, 'y un botón, hijo directo de la fila');
    ok(f.indexOf('<div', 1) === -1, 'sin envoltorio en el medio');
  });
});
