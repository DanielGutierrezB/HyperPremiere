'use strict';

// El `button { flex: 1; min-width: 0 }` global: la regla que causó cuatro bugs.
//
// Estaba pensada para la barra de acciones —tres botones que se reparten la
// fila en partes iguales— pero se aplicaba a TODOS los botones del panel.
// `flex: 1` es base 0 y permiso para encogerse, y `min-width: 0` le saca al
// flex el piso automático, así que cualquier botón que cayera en otra fila
// nacía sin ancho propio y se dejaba aplastar por el vecino. Como los botones
// son `white-space: nowrap`, la etiqueta no se recortaba: se pintaba afuera de
// la caja, encima de lo que hubiera al lado.
//
// Se parchó cuatro veces caso por caso (el cartel "Preparar motor", la cabecera
// de Corrections, la etiqueta de versión del encabezado, y de paso un piso a
// mano de 120 px en la barra de acciones), y al contarlos había VEINTICUATRO
// blindajes sueltos contra una sola causa. Este cambio invierte el default: los
// botones valen su etiqueta, y el reparto se pide donde se lo quiere. Los 24 se
// sacaron y volver a medir no movió una sola medición de ancho.
//
// Medido en la maqueta (test/manual/panel-demo, que usa el HTML y el CSS de
// verdad) con `medir-botones.js`: 15 vistas —las tres pestañas, ⚙, la ayuda,
// los paneles desplegables y los ocho escenarios— por 320, 360, 400, 470, 600 y
// 900 px, comparando el ancho real de cada botón contra el que necesita su
// contenido. 7578 mediciones de botón:
//
//   ancho | contenido fuera de la caja ANTES | DESPUÉS
//   ------+----------------------------------+---------
//    320  |              174                 |   15
//    360  |              126                 |   15
//    400  |              141                 |    0
//    470  |              116                 |    0
//    600  |               14                 |    0
//    900  |                1                 |    0
//
// Cero empeoran. Los 15 que quedan a 320 y 360 son el mismo caso de siempre,
// idéntico antes y después: el desplegable de micrófono del encabezado en modo
// ícono pide 38 px y vive en 34 (`.hdr-mic { min-width: 34px }`), que es otro
// asunto y otra regla.
//
// Lo que estos tests NO hacen: medir cajas. El DOM de mentira del repo no tiene
// motor de layout —no reparte flex, no envuelve, no mide nada—, así que un test
// que dijera "no desborda" acá estaría fingiendo. Lo que se fija es la regla de
// CSS, igual que panel-cartel-preparar-motor.test.js y
// panel-encabezado-microfono.test.js. La medición se rehace con la maqueta.

const fs = require('fs');
const path = require('path');
const { test, ok, eq } = require('./harness');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'cep', 'css', 'style.css'), 'utf8');

/**
 * Reglas hoja de una hoja de estilo. Sin dependencias: saca los comentarios y
 * recorre contando llaves, así un `@media` no pasa por selector y su contenido
 * no se confunde con declaraciones.
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
        if (cuerpo.indexOf('{') === -1) {
          out.push({ selector: b.selector, cuerpo: cuerpo, dentroDeMedia: abiertos.length > 0 });
        }
      }
      selDesde = i + 1;
    }
  }
  return out;
}

const REGLAS = reglas(CSS);

/** Las declaraciones de las reglas de nivel raíz con ese selector exacto. */
function declaraciones(selector) {
  const d = {};
  REGLAS.filter((r) => r.selector === selector && !r.dentroDeMedia).forEach((r) => {
    r.cuerpo.split(';').forEach((par) => {
      const i = par.indexOf(':');
      if (i !== -1) d[par.slice(0, i).trim()] = par.slice(i + 1).trim();
    });
  });
  return d;
}

function flexGrow(d) {
  if (d['flex-grow'] !== undefined) return Number(d['flex-grow']);
  if (d.flex === undefined) return undefined;
  if (d.flex === 'none') return 0;
  const p = String(d.flex).split(/\s+/);
  return /^[\d.]+$/.test(p[0]) ? Number(p[0]) : 0;
}

function flexBasis(d) {
  if (d['flex-basis'] !== undefined) return d['flex-basis'];
  if (d.flex === undefined) return undefined;
  if (d.flex === 'none') return 'auto';
  const p = String(d.flex).split(/\s+/);
  if (p.length === 3) return p[2];
  return /^[\d.]+$/.test(p[0]) ? '0' : p[0];
}

// ── 1. El default: los botones valen su etiqueta ──────────────────────

test('el default de los botones no reparte nada: su base es su propio ancho', function () {
  // Es la mitad del arreglo. Con base 0 el botón arranca sin ancho y lo que
  // consiga se lo tiene que ganar creciendo; con base `auto` arranca midiendo
  // su etiqueta, que es lo que tiene que medir un botón.
  const d = declaraciones('button');
  eq(flexBasis(d), 'auto', 'la base de un botón es su contenido, no 0');
  eq(flexGrow(d), 0, 'y no crece: el que crece es el de la barra de acciones, y se lo dice ahí');
});

test('el global NO le saca a los botones el piso automático de flex', function () {
  // Es la otra mitad, y la que de verdad arregla el bug. `min-width: 0` en un
  // ítem flex significa "podés quedar más chico que tu contenido"; sin eso, el
  // mínimo automático es el min-content, y para un botón `nowrap` el min-content
  // es su etiqueta entera. Ese piso es lo que impide aplastarlo.
  const d = declaraciones('button');
  eq(d['min-width'], undefined,
    'el `min-width: 0` global es exactamente lo que dejaba pintar la etiqueta afuera de la caja');
});

test('los botones siguen sin partir la etiqueta en dos renglones', function () {
  // El piso automático vale lo que vale porque el contenido es `nowrap`: si la
  // etiqueta pudiera partirse, el min-content sería la palabra más larga y el
  // botón volvería a poder quedar más angosto que su texto.
  eq(declaraciones('button')['white-space'], 'nowrap');
});

// ── 2. El reparto, donde corresponde ──────────────────────────────────

test('el reparto en partes iguales vive SOLO en la barra de acciones', function () {
  const d = declaraciones('.actions button');
  eq(flexGrow(d), 1, 'los tres crecen para llenar la fila');
  eq(flexBasis(d), '0', 'y con base 0, que es lo que los hace exactamente iguales');
  const otros = REGLAS.filter((r) => !r.dentroDeMedia && /^button$/.test(r.selector) && flexGrow(declaraciones(r.selector)) > 0);
  eq(otros.length, 0, 'y ningún botón crece por default: eso era el bug');
});

test('el reparto tiene piso: nadie le pone un min-width a los botones de la barra', function () {
  // Acá hubo un `.actions button { min-width: 120px }`, un piso inventado a
  // mano para que el reparto no dejara los botones en nada. Con un piso fijo la
  // fila NO envuelve cuando debería: a 400 px los tres entraban en 121 px cada
  // uno y "Cargar marcadores" (148) y "Agregar listos a la cola" (166) pintaban
  // 27 y 45 px de etiqueta afuera. Sin él, el piso es el contenido de cada uno
  // y la fila los baja de renglón: medido a 400 px, 185 + 185 arriba y 376
  // abajo, con cero desborde.
  const d = declaraciones('.actions button');
  eq(d['min-width'], undefined, 'el piso tiene que ser el contenido, no un número elegido a ojo');
  eq(declaraciones('.actions')['flex-wrap'], 'wrap', 'y la fila tiene que poder envolver, o el piso no tiene a dónde ir');
});

test('en el panel mínimo las acciones se apilan, y eso sigue en su media query', function () {
  const limpio = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const bloques = limpio.match(/@media[^{]*\{[\s\S]*?\n\}/g) || [];
  const elDeLasAcciones = bloques.filter((b) => /\.actions button/.test(b))[0];
  ok(elDeLasAcciones, 'tiene que haber una media query que apile la barra de acciones');
  ok(/flex:\s*1 1 100%/.test(elDeLasAcciones), 'apiladas es cada una a lo ancho de la fila');
  const tope = /max-width:\s*(\d+)px/.exec(elDeLasAcciones);
  ok(tope && Number(tope[1]) >= 320 && Number(tope[1]) <= 480,
    'el corte cae entre el ancho mínimo del panel y el de arranque: ' + (tope && tope[1]));
});

// ── 3. Los parches que se fueron con la causa ─────────────────────────

test('los blindajes uno-por-uno contra el global no volvieron', function () {
  // El punto del cambio: si los parches siguen ahí, se movió complejidad en vez
  // de borrarla. Los 24 se sacaron y se volvió a medir: 0 de 7578 mediciones
  // cambiaron de ancho, o sea que ya no hacían nada. Acá se listan los que
  // tenían nombre propio en el bug; el resto están en el diff de la v1.4.50.
  //
  // Si alguna vez hace falta volver a poner uno, medí primero con
  // `test/manual/panel-demo/medir-botones.js` y dejá acá el número: un
  // `flex: none` puesto por las dudas es cómo empezó todo esto.
  const idos = [
    '.engine-prep .ep-row > button',
    '.corr-head .btn-primary',
    '.corr-fix .qbtn',
    '.corr-actions .qbtn',
    '.header-tools > *',
    '.btn-log',
    '.btn-mic-test',
    '.editor-row .btn-secondary',
    '.transcript-row button',
    '#btn-login-claude',
    '.tab',
    '.qbtn',
    '.queue-clear',
    '.queue-start',
    '.mic-btn',
    '.whisper-badge',
  ];
  idos.forEach(function (sel) {
    const d = declaraciones(sel);
    eq(d.flex, undefined, 'el blindaje de `' + sel + '` no hace falta desde que el default es no encogerse');
    eq(d['flex-shrink'], undefined, '`' + sel + '` tampoco por la propiedad larga');
  });
});

test('el único que conserva su `flex: none` es el botón cuadrado, y por otro motivo', function () {
  // `.icon-btn` no es un resto del global: tiene un `width` fijo de 26 px y una
  // sola letra adentro, así que su mínimo automático (~13 px) queda MUY por
  // debajo de su caja y sí se puede aplastar. Medido: sacándolo, en ⚙ a 320 px
  // el ✕ de cerrar y el ↻ del micrófono pasan de 26 a 13 px.
  const d = declaraciones('.icon-btn');
  eq(d.flex, 'none', 'este sí se blinda, y su comentario dice por qué');
  ok(/^\d+px$/.test(d.width), 'el motivo es que tiene ancho fijo: ' + d.width);
});
