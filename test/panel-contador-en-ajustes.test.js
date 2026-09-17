'use strict';

// El contador de la sesión se fue adentro de ⚙, y arriba quedó el monto.
//
// Era una franja fija del cromo del panel: 40.5 px a lo ancho, con un renglón
// de 10.5 px que decía "↑0 ↓0 · …", para el dato que menos se mira de todo el
// panel (el acumulado de la sesión). Medido con `auditar.js` a 400×700, el
// cromo fijo —encabezado + acciones + esa franja + pestañas— se llevaba 232.5
// px, el 33.2 % del panel, antes de que empezara el contenido.
//
// Desde la v1.6.0 el detalle entero (entrada, caché, salida, costo,
// generaciones, el desglose y el botón de reiniciar) vive en el diálogo de ⚙, y
// en el encabezado queda SÓLO EL MONTO —el "$15.37"— como dato mínimo, para no
// perder el aviso de que estás gastando.
//
// El cálculo NO se tocó: sigue siendo HPUtil.sessionUsage, con sus trampas
// documentadas y probadas en contador-uso.test.js. Lo que estos tests fijan es
// dónde se escribe cada pedazo, que el monto del encabezado no pueda separarse
// del que dice ⚙, y que el encabezado no crezca por él.
//
// Lo que estos tests NO hacen: medir cajas. El DOM de mentira del repo no tiene
// motor de layout, así que se fija la regla de CSS y la estructura del HTML,
// igual que panel-botones-flex.test.js. La medición se rehace con la maqueta
// (`medir-encabezado.js`, `auditar.js`).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const RAIZ = path.join(__dirname, '..');
const CEP = path.join(RAIZ, 'cep', 'js');
const HTML = fs.readFileSync(path.join(RAIZ, 'cep', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(RAIZ, 'cep', 'css', 'style.css'), 'utf8');

/** El trozo de HTML de un overlay/elemento por id, para preguntar qué hay adentro. */
function bloque(desde, hasta) {
  const i = HTML.indexOf(desde);
  ok(i !== -1, 'el HTML tiene «' + desde + '»');
  const j = HTML.indexOf(hasta, i);
  ok(j !== -1, 'y después «' + hasta + '»');
  return HTML.slice(i, j);
}

/** Reglas hoja de la hoja de estilos (mismo lector que los otros tests). */
function reglas(css) {
  const limpio = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const abiertos = [];
  let selDesde = 0;
  for (let i = 0; i < limpio.length; i++) {
    if (limpio[i] === '{') {
      abiertos.push({ selector: limpio.slice(selDesde, i).trim(), desde: i + 1, prof: abiertos.length });
      selDesde = i + 1;
    } else if (limpio[i] === '}') {
      const b = abiertos.pop();
      if (b) {
        const cuerpo = limpio.slice(b.desde, i);
        if (cuerpo.indexOf('{') === -1) {
          out.push({ selector: b.selector.replace(/\s+/g, ' '), cuerpo: cuerpo, dentroDeMedia: b.prof > 0 });
        }
      }
      selDesde = i + 1;
    }
  }
  return out;
}
const REGLAS = reglas(CSS);

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

// ── 1. Dónde quedó cada pedazo ────────────────────────────────────────

test('el detalle entero vive adentro del diálogo de ⚙', function () {
  const config = bloque('<div id="config-overlay"', '<!-- Vista de Cola');
  has(config, 'id="session-usage"', 'el renglón del acumulado');
  has(config, 'id="su-value"', 'el valor');
  has(config, 'id="su-detail"', 'y el desglose, que antes era un tooltip');
  has(config, 'id="su-reset"', 'con su reiniciar');
});

test('el encabezado NO tiene nada más que el monto', function () {
  const header = /<header class="panel-header">([\s\S]*?)<\/header>/.exec(HTML);
  ok(header, 'el encabezado tiene que existir');
  has(header[1], 'id="hdr-usage"', 'el monto, y nada más');
  ['id="session-usage"', 'id="su-value"', 'id="su-detail"', 'id="su-reset"'].forEach(function (id) {
    eq(header[1].indexOf(id), -1, 'esto se fue a ⚙: ' + id);
  });
});

test('la franja del contador no existe más en el cromo del panel', function () {
  // Era hermana de las pestañas, entre el cartel del motor y la barra de
  // pestañas. Si volviera ahí, volverían los 40.5 px fijos.
  const cuerpo = bloque('<div id="batch-status"', '<main id="view-markers"');
  eq(cuerpo.indexOf('session-usage'), -1, 'entre el cartel del motor y las pestañas no va ningún contador');
});

test('el monto es hermano de la insignia, no del grupo de herramientas', function () {
  // `.header-tools` es `flex-wrap: nowrap` y adentro el único con permiso para
  // ceder es el micrófono (panel-encabezado-microfono.test.js). Meter una
  // pastilla más adentro del grupo le come ancho al desplegable del micrófono en
  // el panel angosto; afuera, viaja con la insignia, que es lo que es: un
  // estado, no una herramienta.
  const header = /<header class="panel-header">([\s\S]*?)<\/header>/.exec(HTML)[1];
  const iChip = header.indexOf('id="hdr-status"');
  const iMonto = header.indexOf('id="hdr-usage"');
  const iTools = header.indexOf('class="header-tools"');
  ok(iChip < iMonto && iMonto < iTools, 'el monto va entre la insignia y el grupo, o sea afuera del grupo');
});

test('el monto arranca escondido y no ocupa lugar cuando no hay costo', function () {
  // Con Cursor (suscripción) no hay costo informado nunca. Una pastilla vacía
  // en el encabezado sería ancho gastado en nada, y a 320 px el encabezado no
  // tiene ancho para regalar.
  const header = /<header class="panel-header">([\s\S]*?)<\/header>/.exec(HTML)[1];
  const tag = /<span id="hdr-usage"([^>]*)>/.exec(header);
  ok(tag, 'el monto tiene que estar en el encabezado');
  has(tag[1], 'data-hidden="true"', 'escondido hasta que haya un costo que mostrar');
  eq(declaraciones('.hdr-usage[data-hidden="true"]').display, 'none',
    'y esconderlo es sacarlo del layout, no dejarlo transparente');
});

test('el monto no puede hacer crecer la fila del encabezado', function () {
  // La insignia de estado es la referencia: si el monto midiera más de alto,
  // la fila crecería y el encabezado entero con ella.
  const monto = declaraciones('.hdr-usage');
  const chip = declaraciones('.hdr-chip');
  eq(monto['min-height'], chip['min-height'], 'mismo alto mínimo que la insignia: ' + monto['min-height']);
  eq(monto['white-space'], 'nowrap', 'y no envuelve: "$15.37" en dos renglones sería una fila de más');
});

// ── 2. El comportamiento, con el código de producción ─────────────────

/**
 * El TEXTO REAL de una función de main.js. main.js no se puede montar sin un
 * DOM entero, así que en vez de reescribir lo que hace se le saca el cuerpo tal
 * cual y se corre acá: lo que se ejecuta es el código de producción, letra por
 * letra. (Mismo recurso que estimado-tokens.test.js.)
 */
function funcionDeMain(nombre) {
  const src = fs.readFileSync(path.join(CEP, 'main.js'), 'utf8');
  const m = new RegExp('\\n([ \\t]*)function ' + nombre + '\\(').exec(src);
  if (!m) throw new Error('no encontré ' + nombre + ' en main.js');
  const cierre = '\n' + m[1] + '}\n';
  const fin = src.indexOf(cierre, m.index);
  if (fin === -1) throw new Error('no encontré el final de ' + nombre);
  return src.slice(m.index + 1, fin + cierre.length);
}

function nodoFalso() {
  return {
    textContent: '',
    atributos: {},
    setAttribute: function (k, v) { this.atributos[k] = String(v); },
    getAttribute: function (k) { return this.atributos[k] === undefined ? null : this.atributos[k]; },
  };
}

/** `updateSessionUsageBar` de verdad, con HPUtil de verdad y nodos de mentira. */
function montar(usage) {
  const nodos = {
    'su-value': nodoFalso(),
    'su-detail': nodoFalso(),
    'su-reset': nodoFalso(),
    'hdr-usage': nodoFalso(),
  };
  const ctx = {
    console: console, Math: Math, JSON: JSON, String: String, Number: Number,
    Object: Object, Array: Array, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
    Date: Date, setTimeout: setTimeout, clearTimeout: clearTimeout,
    document: { getElementById: function (id) { return nodos[id] || null; } },
    HPStore: { getSessionUsage: function () { return usage; } },
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(CEP, 'util.js'), 'utf8'), ctx, { filename: 'util.js' });
  vm.runInContext(
    'var suValue = document.getElementById("su-value");\n' +
    'var suDetail = document.getElementById("su-detail");\n' +
    'var suReset = document.getElementById("su-reset");\n' +
    'var hdrUsage = document.getElementById("hdr-usage");\n' +
    funcionDeMain('updateSessionUsageBar') + '\n' +
    'this.pintar = updateSessionUsageBar;',
    ctx, { filename: 'main.js (extracto)' });
  ctx.pintar();
  return nodos;
}

const SESION = {
  generations: 164, inputTokens: 4, cacheReadTokens: 84015, cacheCreationTokens: 49316,
  outputTokens: 2341682, costUsd: 15.37, costGenerations: 12,
};

test('el desglose va escrito en ⚙, no escondido en un tooltip', function () {
  // En un diálogo que abriste para mirar el gasto, esconder el desglose detrás
  // de un hover es una vuelta de más — y encima los tooltips de este panel los
  // dibuja el propio panel (CEF no pinta los `title` nativos).
  const n = montar(SESION);
  has(n['su-detail'].textContent, 'Entrada:', 'el desglose, escrito');
  has(n['su-detail'].textContent, 'leídos de caché', 'con las tres partes de la entrada');
  has(n['su-detail'].textContent, 'Por generación:', 'y el promedio por generación');
  ok(n['su-detail'].textContent.indexOf('\n') !== -1, 'en varios renglones, como lo arma HPUtil');
});

test('el renglón corto de ⚙ dice todo lo que decía la franja', function () {
  const n = montar(SESION);
  const linea = n['su-value'].textContent;
  has(linea, 'tokens de entrada');
  has(linea, 'de caché');
  has(linea, 'de salida');
  has(linea, '$15.37');
  has(linea, '164 generaciones');
});

test('en el encabezado queda el monto y NADA más', function () {
  const n = montar(SESION);
  eq(n['hdr-usage'].textContent, '$15.37', 'el monto pelado');
  eq(n['hdr-usage'].getAttribute('data-hidden'), 'false', 'y visible, porque hay costo');
  has(n['hdr-usage'].getAttribute('title'), 'El detalle está en ⚙',
    'con el tooltip que dice dónde está el resto: el monto sin contexto no se explica solo');
});

test('el monto del encabezado NO puede separarse del que dice ⚙', function () {
  // Son dos lugares que muestran el mismo número, que es exactamente cómo se
  // llega a que uno quede viejo. Salen los dos de HPUtil.sessionUsage y con el
  // mismo formato, así que el de arriba tiene que ser un trozo del de abajo.
  [SESION, { generations: 3, inputTokens: 10, outputTokens: 20, costUsd: 0.5, costGenerations: 3 }]
    .forEach(function (u) {
      const n = montar(u);
      has(n['su-value'].textContent, n['hdr-usage'].textContent,
        'el monto de arriba tiene que aparecer igual en el renglón de ⚙');
    });
});

test('sin costo informado el monto no se dibuja', function () {
  // Cursor va por suscripción y no informa costo; la API de Anthropic tampoco lo
  // devuelve. Mostrar "$0.00" ahí sería afirmar que la sesión salió gratis.
  const n = montar({ generations: 20, inputTokens: 100, cacheReadTokens: 900, outputTokens: 5000 });
  eq(n['hdr-usage'].textContent, '', 'sin monto');
  eq(n['hdr-usage'].getAttribute('data-hidden'), 'true', 'y escondido');
  has(n['su-value'].textContent, '20 generaciones', 'pero el renglón de ⚙ sigue contando todo');
});

test('sin generaciones todavía, ⚙ lo dice y el encabezado queda limpio', function () {
  const n = montar(null);
  eq(n['su-value'].textContent, 'sin generaciones todavía');
  eq(n['hdr-usage'].getAttribute('data-hidden'), 'true');
});

test('el cálculo no se tocó: el monto sale de la misma función que la línea', function () {
  // Lo que se movió es dónde se muestra. Si alguna vez el monto se calculara
  // aparte —un `toFixed` suelto en main.js, por ejemplo— podrían decir cosas
  // distintas, que es el bug que este test existe para que no vuelva.
  const src = fs.readFileSync(path.join(CEP, 'main.js'), 'utf8');
  const fn = funcionDeMain('updateSessionUsageBar');
  has(fn, 'HPUtil.sessionUsage(HPStore.getSessionUsage())', 'una sola fuente para los tres pedazos');
  eq(/costUsd/.test(fn), false, 'main.js no vuelve a formatear ningún número del contador');
  ok(src.indexOf('HPStore.onUsageChange(updateSessionUsageBar)') !== -1,
    'y se sigue repintando solo cuando el acumulado cambia, desde donde sea');
});
