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
//              campo   Aplicar el ajuste   Regenerar desde cero
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
          // El selector se normaliza: los de varias líneas se escriben con un
          // salto por selector y se buscan acá con espacios.
          out.push({ selector: b.selector.replace(/\s+/g, ' '), cuerpo: cuerpo, dentroDeMedia: abiertos.length > 0 });
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

/**
 * Los px de una declaración de tamaño ("12px" → 12), resolviendo los tokens de
 * la retícula ("var(--sp-2)" → 4). Desde la v1.6.0 el espaciado del panel sale
 * de seis tokens y no de números sueltos, así que un lector que solo entienda
 * "12px" mediría `NaN` en media hoja.
 */
function px(valor) {
  let v = String(valor || '').trim();
  const token = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
  if (token) v = String(declaraciones(':root')[token[1]] || '').trim();
  const m = /^([\d.]+)px$/.exec(v);
  return m ? Number(m[1]) : NaN;
}

// Desde la 1.6.x la ronda de feedback ES el cuerpo de ficha compartido, así que
// las dos salidas viven en su PIE: el mismo contenedor y la misma regla que el
// pie de una ficha de marcador (`.hp-acciones`, que fija panel-ficha-marcador).
const ACCIONES = declaraciones('.hp-acciones');
const REFINAR = declaraciones('.hp-acciones .qbtn-react');
const DESDE_CERO = declaraciones('.qbtn-fresh');

// ── 1. Las dos, en el pie de la ficha ─────────────────────────────────

test('las dos salidas viven en el pie del cuerpo compartido', function () {
  // Tuvieron contenedor propio (`.qj-fb-actions`) con su propio reparto, y ahora
  // no hace falta: el pie de la ficha ya reparte en las dos puntas, que es la
  // regla que esta caja necesitaba —lo que se aprieta lejos de lo que descarta
  // trabajo hecho—. Un contenedor menos, y la misma jerarquía que en la ficha.
  eq(ACCIONES.display, 'flex', 'el pie de la ficha');
  eq(ACCIONES['justify-content'], 'space-between', 'reparte en las dos puntas');
  eq(ACCIONES['flex-wrap'], 'wrap-reverse',
    'y al envolver, lo destructivo queda arriba: sigue lejos del dedo');
  const viejas = REGLAS.filter(function (r) { return /qj-fb-actions/.test(r.selector); });
  eq(viejas.length, 0, 'sin reglas huérfanas del contenedor viejo: ' + viejas.map((r) => r.selector).join(' | '));
});

test('el campo ya no comparte renglón con nadie, así que nadie le come ancho', function () {
  // Éste era el problema de fondo, medido: "Regenerar desde cero" son 20
  // caracteres y pedía 147 px de los 278 de la fila, o sea que la etiqueta más
  // larga decidía el ancho del cuadro donde se escribe el feedback. Se arreglaba
  // con `flex: 1 1 100%` en cada botón; ahora se arregla por estructura, que es
  // mejor: el campo es el `.hp-campo-input` de la ficha y mide el 100 % de ella.
  eq(declaraciones('.hp-campo-input').width, '100%');
  const enLaFila = REGLAS.filter(function (r) {
    return !r.dentroDeMedia && /^\.qj-feedback\b/.test(r.selector);
  });
  eq(enLaFila.length, 0,
    'y la fila que los tenía al lado no existe más: ' + enLaFila.map((r) => r.selector).join(', '));
});

test('ninguno de los dos vuelve a los blindajes de la 1.4.50', function () {
  // `flex: none` y `min-width` son exactamente los parches que se sacaron cuando
  // se invirtió la regla global. Un botón con `min-width` propio y `nowrap` es un
  // botón que puede quedar más chico que su texto y pintarlo afuera.
  [['Refinar', REFINAR], ['desde cero', DESDE_CERO]].forEach(function (par) {
    eq(par[1]['min-width'], undefined, par[0] + ' no necesita un piso a mano');
    ok(par[1].flex !== 'none', par[0] + ' no se blinda con `flex: none`');
  });
});

// ── 2. La jerarquía entre los dos ─────────────────────────────────────

test('Refinar y el Regenerar de Corrections ya son LA MISMA regla', function () {
  // Es la misma acción en los dos lugares donde se da feedback —aplicá lo que
  // escribí sobre lo que ya existe— y hasta la 1.6.0 eran dos reglas de CSS que
  // se mantenían parecidas a mano (`.qj-fb-actions .qbtn-react` y
  // `.corr-actions .qbtn-react`, con el mismo cuerpo y el mismo peso escritos dos
  // veces). Ahora las dos filas usan el pie de la misma ficha, así que hay UNA
  // regla y la pregunta "¿siguen iguales?" no se puede contestar mal.
  const viejas = REGLAS.filter(function (r) {
    return /\.corr-actions|\.qj-fb-actions/.test(r.selector);
  });
  eq(viejas.length, 0, 'ninguna de las dos reglas viejas quedó: ' + viejas.map((r) => r.selector).join(' | '));
  eq(REFINAR['font-size'], '12px', 'el cuerpo de la acción de la ronda');
  eq(px(REFINAR['min-height']) >= 28, true, 'y su alto: ' + REFINAR['min-height']);
  eq(declaraciones('.qbtn-react, .queue-react').background, 'rgba(245, 180, 60, 0.10)',
    'con el relleno ámbar de la familia “rehacer”, que sale de `.qbtn-react`');
});

test('desde cero se ve más chico y más apagado que Refinar', function () {
  ok(px(DESDE_CERO['font-size']) < px(REFINAR['font-size']),
    'más chico: ' + DESDE_CERO['font-size'] + ' contra ' + REFINAR['font-size']);
  ok(px(DESDE_CERO.padding.split(/\s+/)[0]) < px(REFINAR.padding.split(/\s+/)[0]),
    'y más bajo: ' + DESDE_CERO.padding + ' contra ' + REFINAR.padding);
  eq(DESDE_CERO['font-weight'], undefined, 'sin peso propio: el que se destaca es el otro');
  eq(DESDE_CERO.background, undefined, 'y sin relleno, que es lo que hace mirar a Refinar');
});

test('desde cero es gris pero SE LEE: sale de los tres niveles, no de un apagón', function () {
  // Lo que este test protege es que "desde cero" se pueda leer. Cuando se
  // escribió decía textualmente "no se va a `--text-muted`", y tenía razón
  // entonces: el muted estaba en #5c6675, o sea entre 2.84:1 y 3.25:1 según la
  // superficie, y no pasaba AA en ninguna. En la v1.6.0 el muted ES el tercer
  // nivel de voz y mide 4.83:1 en el peor caso (medido con
  // `temas/estudiado/contrastes.js`), así que el motivo de esa prohibición
  // desapareció con el valor.
  // Lo que sigue valiendo, y es lo que se fija: el gris tiene que salir de los
  // TRES niveles del panel —no de un `opacity`, no de un color inventado— y al
  // pasar por encima se prende del todo. Lo que protege del clic errado sigue
  // siendo la confirmación (eso lo fija cola-mirar-y-rehacer.test.js).
  ok(['var(--text-secondary)', 'var(--text-muted)'].indexOf(DESDE_CERO.color) !== -1,
    'el gris sale de un nivel de voz del panel, no de cualquier lado: ' + DESDE_CERO.color);
  eq(DESDE_CERO.opacity, undefined,
    'y no se apaga con opacity, que desvanece el texto, el borde y el fondo juntos');
  const hover = declaraciones('.qbtn-fresh:hover');
  eq(hover.color, 'var(--text-primary)', 'y al pasar por encima se prende del todo');
});

test('los colores salen de las variables del panel, sin paleta nueva', function () {
  // El panel vive dentro de Premiere: un color inventado se ve como un injerto.
  // Se permite el ámbar en rgba porque es el de `--warn` con transparencia, que
  // es como lo escribe todo el resto de la familia "rehacer" en esta hoja.
  const cuerpos = [REFINAR, DESDE_CERO, declaraciones('.qbtn-fresh:hover'),
    declaraciones('.qbtn-react:hover')];
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
