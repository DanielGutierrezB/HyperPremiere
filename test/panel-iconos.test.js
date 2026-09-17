'use strict';

// LOS ICONOS: SVG de trazo en vez de emojis tipeados en el JS.
//
// El editor lo pidió así: "Que tengan logos hechos en SVG con líneas minimalistas
// pero claros", y con un requisito concreto — que los dos de "rehacer" (↻ y ⟲)
// dejen de ser el mismo glifo.
//
// Los emojis traían tres problemas que no son de gusto: los dibuja la fuente del
// sistema (así que el panel se ve distinto en cada máquina), no heredan el color
// del texto (un 🎙 no se puede poner en rojo mientras escucha, que es justo lo
// otro que se pidió) y cada uno tiene su propio alto de caja, así que la fila de
// controles quedaba desalineada por dentro.
//
// Lo que se fija acá es lo que se puede fijar sin ojos: que cada concepto tenga
// UN dibujo, que dos acciones distintas no compartan dibujo, que el SVG herede el
// color, y que donde había un emoji en el JS ahora haya un icono.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const RAIZ = path.join(__dirname, '..');
const CEP = path.join(RAIZ, 'cep', 'js');
const CSS = fs.readFileSync(path.join(RAIZ, 'cep', 'css', 'style.css'), 'utf8');

/** HPIconos con un `document` mínimo: alcanza para lo que hace. */
function cargar() {
  const nodos = [];
  const ctx = {
    console: console, String: String, Object: Object,
    document: {
      createElement: function (tag) {
        const el = {
          tagName: tag, className: '', innerHTML: '', textContent: '', attrs: {},
          children: [],
          appendChild: function (h) { this.children.push(h); return h; },
          setAttribute: function (k, v) { this.attrs[k] = v; },
          getAttribute: function (k) { return this.attrs[k]; },
        };
        nodos.push(el);
        return el;
      },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(CEP, 'iconos.js'), 'utf8'), ctx, { filename: 'iconos.js' });
  return ctx.HPIconos;
}

const I = cargar();

// ── 1. El juego de dibujos ───────────────────────────────────────────

test('todos los iconos están dibujados en la misma caja de 24×24', function () {
  // Es lo que hace que se vean de la misma familia al lado del otro: un dibujo en
  // otra caja se ve más chico o más grande sin que se pueda arreglar con CSS.
  I.nombres().forEach(function (n) {
    has(I.markup(n), 'viewBox="0 0 24 24"', n);
  });
});

test('ninguno lleva color propio: heredan el del texto', function () {
  // Es la mitad del pedido. `fill` y `stroke` los pone `.hp-ico svg` con
  // `currentColor`, así que el rojo del micrófono escuchando o el gris del botón
  // apagado salen del estado del botón y no de una segunda regla que haya que
  // mantener al día.
  I.nombres().forEach(function (n) {
    const m = I.markup(n);
    ok(!/(?:^|[^-])fill="(?!none)/.test(m), n + ': sin relleno propio');
    ok(m.indexOf('stroke="') === -1, n + ': sin trazo propio');
    ok(!/#[0-9a-f]{3,6}/i.test(m), n + ': sin color literal');
  });
  const d = CSS.slice(CSS.indexOf('.hp-ico svg {'));
  has(d.slice(0, 220), 'stroke: currentColor');
  has(d.slice(0, 220), 'fill: none');
});

test('un icono que no existe devuelve vacío y no rompe nada', function () {
  eq(I.markup('no-existe'), '');
  eq(I.markup(''), '');
});

test('el icono queda ESCRITO en el DOM, para poder fijarlo por test', function () {
  // El `<svg>` se pega con `innerHTML` (`createElement("svg")` no crea un SVG:
  // crea un elemento HTML desconocido que el navegador no dibuja), y eso lo vuelve
  // invisible para el DOM de mentira de los tests, que no parsea. Sin `data-icono`,
  // "el botón pasa al cuadrado de parar cuando el motor dice que está escuchando"
  // no se podría probar — y es justo el estado que el editor pidió que se vea.
  const el = I.el('microfono');
  eq(el.getAttribute('data-icono'), 'microfono');
  eq(el.className, 'hp-ico');
  I.poner(el, 'parar');
  eq(el.getAttribute('data-icono'), 'parar', 'y se actualiza al cambiar de estado');
});

// ── 2. Los dos de "rehacer" no son el mismo dibujo ───────────────────

test('«aplicar el ajuste» y «desde cero» son dos dibujos distintos', function () {
  // Era el pedido textual. ↻ y ⟲ son los dos una flecha en círculo, para las dos
  // acciones más opuestas de la caja: una sigue el diseño anterior y la otra lo
  // tira. A 12 px no se distinguen.
  const a = I.markup('ajustar');
  const b = I.markup('desdeCero');
  ok(a !== b, 'no comparten dibujo');
  // Y no es que uno sea el otro dado vuelta, que a 12 px es lo mismo: son dos
  // objetos distintos. El de ajustar son rieles con perilla (calibrar algo que ya
  // existe) y el de desde cero es un lazo que vuelve al principio.
  ok(a.indexOf('circle') === -1 && a.indexOf('a8') === -1 && a.indexOf('a8.8') === -1,
    'ajustar no dibuja ningún arco');
  has(b, 'a8.8', 'y desde cero sí: es el lazo');
});

test('deshacer es un TERCER dibujo, y no cualquiera de los dos anteriores', function () {
  // "Volver al texto original" no es rehacer nada: es deshacer. Tres acciones, tres
  // dibujos.
  const v = I.markup('volver');
  ok(v !== I.markup('ajustar') && v !== I.markup('desdeCero'));
});

test('un concepto, un dibujo: no hay dos nombres con el mismo trazo', function () {
  const vistos = {};
  I.nombres().forEach(function (n) {
    const m = I.markup(n);
    ok(!vistos[m], n + ' comparte dibujo con ' + vistos[m] + ': si hacen cosas distintas, no pueden');
    vistos[m] = n;
  });
});

// ── 3. Cómo se cuelgan ───────────────────────────────────────────────

test('el icono de un botón no le cambia el texto', function () {
  // Es lo que deja que el editor siga encontrando el botón por su etiqueta (y los
  // tests en el DOM de mentira): el `<svg>` no aporta texto, así que
  // `boton.textContent` sigue siendo la etiqueta y nada más.
  const btn = I.el('quitar'); // cualquier nodo con appendChild
  btn.textContent = 'Regenerar desde cero';
  I.enBoton(btn, 'desdeCero');
  eq(btn.textContent, 'Regenerar desde cero');
  eq(btn.children.length, 1, 'y le queda un solo hijo: el icono');
});

test('el cuadrado de PARAR es la única forma rellena, y lo dice el CSS', function () {
  // A trazo se lee como un contenedor vacío y no como un botón de detener.
  has(I.markup('parar'), 'class="solido"');
  has(CSS, '.hp-ico svg .solido { fill: currentColor; stroke: none; }');
  I.nombres().filter(function (n) { return n !== 'parar'; }).forEach(function (n) {
    ok(I.markup(n).indexOf('solido') === -1, n + ' no es sólido: el relleno es la excepción');
  });
});

test('el botón de solo icono no usa la clase que se esconde a 320 px', function () {
  // `.btn-ico` se esconde en el panel mínimo para dejarle el ancho al texto del
  // botón. En un botón que ES el icono, eso dejaría un cuadrado vacío.
  const media = (CSS.match(/@media[^{]*\{[\s\S]*?\n\}/g) || [])
    .filter(function (b) { return /\.btn-ico\s*\{\s*display:\s*none/.test(b); })[0];
  ok(media, 'la media query que esconde .btn-ico sigue estando');
  ok(!/\.hp-ico\b[^-]/.test(media.replace(/\/\*[\s\S]*?\*\//g, '')),
    'y NO toca .hp-ico: el icono del botón de solo icono no se esconde nunca');
});

// ── 4. Donde había un emoji, ahora hay un icono ──────────────────────

/** El código sin comentarios: los comentarios NOMBRAN los emojis viejos a
 *  propósito, para poder contar de dónde salió cada icono. */
function codigoDe(f) {
  return fs.readFileSync(path.join(CEP, f), 'utf8')
    // El `/*` tiene que estar al principio o después de un espacio. Sin eso, el
    // `accept="image/*,application/pdf…"` del selector de archivos abre un
    // comentario que se come todo hasta el próximo `*/` — o sea la mitad de la
    // función donde vive. Pasó exactamente eso, y el test pasaba igual porque lo
    // que buscaba estaba afuera del pedazo comido.
    .replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1')
    // Y los `//` de final de línea, no sólo los de línea propia.
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

test('los controles del campo ya no son emojis tipeados', function () {
  // Los tres que nombró el editor (micrófono, refinar, capturar) más el clip, en
  // los cuatro archivos que dibujan la ficha. Se mira el JS: un emoji en una cadena
  // del JS es un dibujo de la fuente del sistema.
  ['dictado.js', 'stills.js', 'refs-view.js', 'main.js', 'prompt-card.js',
    'queue-view.js', 'corrections.js'].forEach(function (f) {
    const codigo = codigoDe(f);
    ['🎙', '✨', '📸', '⟲', '↻', '📤', '✎', '⏱'].forEach(function (e) {
      ok(codigo.indexOf(e) === -1, f + ': quedó un ' + e + ' en el código');
    });
  });
});

test('las TRES formas de rehacer tienen tres dibujos, y ninguno se gasta dos veces', function () {
  // Éste es el corazón del asunto y por eso es el test más largo del archivo.
  // En la Cola había TRES botones con el mismo ↻ para tres cosas que no se
  // parecen, y un cuarto (⟲) para una cuarta:
  //
  //   · APLICAR EL AJUSTE — rediseñar SOBRE la versión que hay, con lo escrito.
  //   · DESDE CERO        — tirar el diseño y volver a diseñar.
  //   · REINTENTAR        — el trabajo FALLÓ: lo mismo otra vez, desde donde se
  //                         cayó (si el modelo ya había terminado, sólo el render).
  //   · REACTIVAR         — el trabajo no falló: se quedó sin cupo. Vuelve a la
  //                         cola tal como estaba.
  //
  // Los cuatro tienen su dibujo y los cuatro dibujos son distintos. Que se
  // distingan a 15 px es lo que no se puede fijar por test: eso se mira en las
  // capturas (`capturar-listas.js`).
  const codigo = codigoDe('queue-view.js');
  // Los glifos que eran ETIQUETAS de botón. El 🧹 sigue apareciendo en los
  // mensajes que la limpieza escribe en la línea de estado del panel («🧹
  // Limpieza lista: …»), y eso es otra cosa: un mensaje no es un control, y el
  // panel usa emoji en sus mensajes desde siempre.
  ['⟲', '↻', '📌', '⏹', '⏸', '▶', '▲', '▼', '✕', '✎'].forEach(function (e) {
    ok(codigo.indexOf(e) === -1, 'quedó un ' + e + ' en los botones de la Cola');
  });
  has(codigo, 'HPIconos.enBoton(go, "ajustar")');
  has(codigo, 'HPIconos.enBoton(fresh, "desdeCero")');
  has(codigo, '"reintentar"');
  has(codigo, '"reactivar"');
  // Y los cuatro dibujos son cuatro dibujos, no el mismo con otro punto de
  // partida: se comparan los trazos, que es lo único que se puede comparar.
  const trazos = ['ajustar', 'desdeCero', 'reintentar', 'reactivar'].map(function (n) {
    ok(I.markup(n).length > 40, n + ': tiene que estar dibujado');
    return I.markup(n);
  });
  eq(new Set(trazos).size, 4, 'cuatro acciones distintas, cuatro dibujos distintos');
});

test('el resto de los glifos de la Cola y de Corrections también son iconos', function () {
  // Los que quedaban tipeados: 📌 Colocar, 🧹 Limpiar, ⏹ vaciar, ⏸ pausar,
  // ▶ Iniciar/Reanudar, ▲▼ mover, ✕ quitar, ✎ Feedback y ✎ Editar HTML.
  //
  // El ✎ estaba en DOS botones que hacen cosas distintas —dar feedback y editar
  // el HTML—, que es el mismo error del ↻ en chico. Son dos conceptos: un globo
  // de diálogo y un `< >`.
  const cola = codigoDe('queue-view.js');
  ['"colocar"', '"limpiar"', '"vaciar"', '"pausar"', '"reanudar"', '"subir"', '"bajar"',
    '"quitar"', '"comentar"', '"codigo"'].forEach(function (n) {
    has(cola, n, 'la Cola usa el icono ' + n);
  });
  const corr = codigoDe('corrections.js');
  ok(corr.indexOf('↻') === -1 && corr.indexOf('＋') === -1, 'y en Corrections tampoco quedan glifos');
  has(corr, 'HPIconos.enBoton(stageBtn, "encolar")');
  has(corr, 'HPIconos.enBoton(fixBtn, "ajustar")', 'Regenerar es un ajuste sobre lo que hay, no un reintento');
  // Dos que se repiten A PROPÓSITO, y por el mismo motivo que `generar` y
  // `encolar` se repiten entre la ficha y la barra de arriba: es la MISMA acción
  // con otro alcance. Dos dibujos para eso serían dos cosas que aprender.
  eq((cola.match(/"limpiar"/g) || []).length, 2,
    'limpiar previas y limpiar versiones viejas: la misma acción, un recurso o todos');
  eq((cola.match(/"reanudar"/g) || []).length, 2,
    'iniciar y reanudar: las dos ponen la cola a andar');
});

test('el 📤 de cada miniatura también es un icono, y sigue siendo el mismo toggle', function () {
  // Lo que NO se toca es lo que el 📤 HACE: decide si esa imagen viaja en este
  // pedido (y las ✓ usar se incrustan igual). Lo que cambió es que ya no lo
  // dibuja la fuente de emoji del sistema.
  const stills = codigoDe('stills.js');
  ok(stills.indexOf('📤') === -1, 'el emoji se fue');
  has(stills, 'HPIconos.enBoton(send, "reenviar")');
  has(stills, 'send.className = "still-send"', 'y el toggle es el mismo');
  ok(I.markup('reenviar').length > 40, 'con su propio dibujo');
});

test('el micrófono, el refinar y el capturar tienen su icono', function () {
  ['microfono', 'refinar', 'capturar', 'adjuntar', 'parar'].forEach(function (n) {
    ok(I.markup(n).length > 40, n + ': tiene que estar dibujado');
  });
  const dictado = fs.readFileSync(path.join(CEP, 'dictado.js'), 'utf8');
  has(dictado, 'icono: "microfono"');
  has(dictado, 'icono: "parar"');
  has(dictado, 'icono: "refinar"');
  has(fs.readFileSync(path.join(CEP, 'prompt-card.js'), 'utf8'), 'HPIconos.el(icono)');
});
