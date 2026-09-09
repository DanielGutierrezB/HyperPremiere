'use strict';

// v1.5.1 — los dos botones de la caja de feedback de la Cola, debajo del campo.
//
// Estaban al costado, uno por columna, estirados al alto del cuadro de texto. Se
// veía desbalanceado y, sobre todo, el ancho lo decidía la etiqueta más larga:
// "Regenerar desde cero" pedía 147 px de los 278 que tiene la fila con el panel
// en 320, así que el cuadro donde se escribe el feedback quedaba en 57 px. Con
// el panel en 400, en 137. Y el editor ese cuadro lo alarga a ocho renglones,
// porque es donde escribe tres frases de lo que hay que arreglar.
//
// Medido en la maqueta (`test/manual/panel-demo/medir-botones.js` y una corrida
// puntual sobre la caja), a 320 y 400 px:
//
//              campo   ↻ Aplicar el ajuste   ⟲ Regenerar desde cero
//   antes 320    57    61 (pide 62)       147 (pide 148)
//   antes 400   137    61 (pide 62)       147 (pide 148)
//   después 320 278   278 (pide 87)       278 (pide 142)
//   después 400 358   358 (pide 87)       358 (pide 142)
//
// Cero solapes y cero desborde de documento en los dos anchos, antes y después.
// La única medición con contenido afuera de su caja en la vista de la Cola es el
// desplegable de micrófono del encabezado a 320 px (pide 38, vive en 34), que ya
// estaba y es otra regla (`.hdr-mic { min-width: 34px }`).
//
// La jerarquía es a propósito y va en un solo sentido: Refinar es la salida de
// todos los días y no destruye nada, así que se lleva el ámbar de la familia
// "rehacer" y el cuerpo grande; "Regenerar desde cero" descarta el diseño
// anterior, así que se ve chico y gris. Lo que PROTEGE del clic errado sigue
// siendo la confirmación (eso lo fija cola-mirar-y-rehacer.test.js), no el
// color: un botón apagado igual se aprieta.
//
// Lo que estos tests NO hacen: medir cajas. El DOM de mentira del repo no tiene
// motor de layout —no reparte flex, no envuelve, no mide nada—, así que un test
// que dijera "no desborda" acá estaría fingiendo. Se fijan las reglas de CSS,
// igual que panel-botones-flex.test.js y panel-cartel-preparar-motor.test.js. La
// medición se rehace con la maqueta.

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

/** Los px de una declaración de tamaño ("12px" → 12). */
function px(valor) {
  const m = /^([\d.]+)px$/.exec(String(valor || '').trim());
  return m ? Number(m[1]) : NaN;
}

const ACCIONES = declaraciones('.qj-fb-actions');
const REFINAR = declaraciones('.qj-fb-actions .qbtn-react');
const DESDE_CERO = declaraciones('.qj-fb-actions .qbtn-fresh');

// ── 1. Los dos, a lo ancho y debajo del campo ─────────────────────────

test('las acciones tienen contenedor propio, y es el que reparte', function () {
  // El reparto se pide acá y no en los botones: el default del panel es que un
  // botón valga su etiqueta (panel-botones-flex.test.js), y acá hace falta lo
  // contrario. Que la regla viva en mi contenedor es lo que evita el `flex`
  // suelto por las dudas, que es cómo empezó el lío de la 1.4.50.
  eq(ACCIONES.display, 'flex', 'la fila de las dos salidas');
  eq(ACCIONES['flex-wrap'], 'wrap', 'y tiene que poder envolver, o el 100% no tiene a dónde ir');
  ok(px(ACCIONES.gap) > 0, 'con aire entre los dos: ' + ACCIONES.gap);
  ok(px(ACCIONES['margin-top']) > 0, 'y separadas del campo');
});

test('cada botón se lleva el renglón entero: nadie decide el ancho del otro', function () {
  // `1 1 100%` con `wrap` es "uno por renglón, a lo ancho" sin un número elegido
  // a ojo. Es lo que saca del medio el problema de fondo: que "Regenerar desde
  // cero" son 20 caracteres y antes eso le comía el ancho al cuadro de texto.
  eq(REFINAR.flex, '1 1 100%', 'Refinar, a lo ancho');
  eq(DESDE_CERO.flex, '1 1 100%', 'y desde cero también: los dos son largos');
});

test('ninguno de los dos vuelve a los blindajes de la 1.4.50', function () {
  // `flex: none` y `min-width` son exactamente los parches que se sacaron cuando
  // se invirtió la regla global. Un botón con `min-width` propio y `nowrap` es un
  // botón que puede quedar más chico que su texto y pintarlo afuera.
  [['Refinar', REFINAR], ['desde cero', DESDE_CERO]].forEach(function (par) {
    eq(par[1]['min-width'], undefined, par[0] + ' no necesita un piso a mano: su renglón es entero');
    ok(par[1].flex !== 'none', par[0] + ' no se blinda con `flex: none`');
  });
});

test('la fila del campo ya no estira ningún botón al alto del cuadro', function () {
  // Era `align-self: stretch` en los dos, que es lo que los hacía columnas
  // altas. Si vuelve, vuelve el desbalance de la captura.
  const enLaFila = REGLAS.filter(function (r) {
    return !r.dentroDeMedia && /^\.qj-feedback\s+\.qbtn/.test(r.selector);
  });
  eq(enLaFila.length, 0,
    'la fila del campo no tiene que estilar botones: ' + enLaFila.map((r) => r.selector).join(', '));
  eq(declaraciones('.qj-fb-input').flex, '1', 'y el campo se lleva la fila entera');
});

// ── 2. La jerarquía entre los dos ─────────────────────────────────────

test('Refinar se ve como la acción, con el mismo trato que en Corrections', function () {
  // Es la MISMA acción en los dos lugares donde se da feedback —aplicá lo que
  // escribí sobre lo que ya existe—, así que se ve igual. Si alguna vez cambia
  // una, este test pide que se cambien las dos o que se explique la diferencia.
  const enCorrecciones = declaraciones('.corr-actions .qbtn-react');
  eq(REFINAR['font-size'], enCorrecciones['font-size'], 'mismo cuerpo que “↻ Regenerar”');
  eq(REFINAR['font-weight'], enCorrecciones['font-weight'], 'y mismo peso');
  eq(REFINAR.background, enCorrecciones.background, 'y el mismo relleno ámbar de la familia “rehacer”');
});

test('desde cero se ve más chico y más apagado que Refinar', function () {
  ok(px(DESDE_CERO['font-size']) < px(REFINAR['font-size']),
    'más chico: ' + DESDE_CERO['font-size'] + ' contra ' + REFINAR['font-size']);
  ok(px(DESDE_CERO.padding.split(/\s+/)[0]) < px(REFINAR.padding.split(/\s+/)[0]),
    'y más bajo: ' + DESDE_CERO.padding + ' contra ' + REFINAR.padding);
  eq(DESDE_CERO['font-weight'], undefined, 'sin peso propio: el que se destaca es el otro');
  eq(DESDE_CERO.background, undefined, 'y sin relleno, que es lo que hace mirar a Refinar');
});

test('desde cero es gris pero se lee: no se va a `--text-muted`', function () {
  // Hay una observación registrada de que lo apagado en este panel se pasa de
  // apagado. Es una acción de verdad, con su tooltip y su confirmación: tiene
  // que poder leerse. `--text-muted` es para las notas al pie.
  eq(DESDE_CERO.color, 'var(--text-secondary)');
  const hover = declaraciones('.qj-fb-actions .qbtn-fresh:hover');
  eq(hover.color, 'var(--text-primary)', 'y al pasar por encima se prende del todo');
});

test('los colores salen de las variables del panel, sin paleta nueva', function () {
  // El panel vive dentro de Premiere: un color inventado se ve como un injerto.
  // Se permite el ámbar en rgba porque es el de `--warn` con transparencia, que
  // es como lo escribe todo el resto de la familia "rehacer" en esta hoja.
  const cuerpos = [REFINAR, DESDE_CERO, declaraciones('.qj-fb-actions .qbtn-fresh:hover'),
    declaraciones('.qj-fb-actions .qbtn-react:hover')];
  cuerpos.forEach(function (d) {
    Object.keys(d).forEach(function (prop) {
      if (!/color|background/.test(prop)) return;
      const v = d[prop];
      ok(/var\(--|rgba\(251, 191, 36|rgba\(255, 255, 255/.test(v),
        prop + ': ' + v + ' — tiene que salir de una variable del panel');
      ok(!/#[0-9a-f]{3,6}/i.test(v), prop + ': ' + v + ' — sin hex suelto');
    });
  });
});
