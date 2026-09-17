'use strict';

// Los tres bloques de contexto son TRES TARJETAS HERMANAS, y el rótulo
// "Marcadores" va después.
//
// Dos cosas se arreglaron juntas acá, y las dos eran de orden:
//
// 1. EL ORDEN DEL HTML. El rótulo `<div class="section-label">Marcadores</div>`
//    estaba ANTES del bloque "Estilo de esta secuencia", o sea que el prompt de
//    la clase quedaba adentro del área de los marcadores — el mismo error que se
//    había corregido para el prompt del curso y que se arrastró al separarlos.
//    Ahora los tres son hermanos, en orden de alcance (curso → clase →
//    secuencia), y el rótulo separa lo que de verdad rotula: la lista.
//
// 2. LA ESCALERA DE SANGRÍAS. Los tres alcances se dibujaban con 0 / 10 / 18 px
//    de sangría, guardas de 3/2 px y títulos de 13/12/11 px: tres canales
//    apuntando para el mismo lado. Leía bien en dos niveles y a medias en el
//    tercero, y el tercero es el que más importa —la instrucción del marcador—,
//    porque no es un contenedor con rótulo: es el `<textarea>` pelado, así que
//    la sangría y la guarda se le dibujaban AL CAMPO y no al grupo (de ahí
//    salieron el borde de arriba de otro color y el texto pegado al borde). Un
//    canal que funciona en dos de tres casos es un canal que hay que aprender, y
//    en un panel de 400 px la sangría se paga en ancho de escritura.
//    Ahora las tres son tarjetas al ras, con el mismo recuadro y el mismo
//    desplegable que una ficha de marcador, y el alcance lo dice el TÍTULO.
//
// Lo que NO se pierde, y también se fija acá: que se entienda que los tres
// niveles viajan juntos y que el más específico manda donde se contradigan. Eso
// lo dicen los dos renglones que se nombran entre sí (`.general-source`) y la
// insignia de cada bloque; el contenido de esos renglones lo prueba
// prompt-general-proyecto.test.js, acá se fija que sigan dibujados y que la
// contradicción se VEA.
//
// Lo que estos tests NO hacen: medir cajas. El DOM de mentira del repo no tiene
// motor de layout, así que se fija la regla de CSS y la estructura del HTML. La
// medición se rehace con la maqueta (`medir-botones.js`, `auditar.js`).

const fs = require('fs');
const path = require('path');
const { test, ok, eq, has } = require('./harness');

const RAIZ = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(RAIZ, 'cep', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(RAIZ, 'cep', 'css', 'style.css'), 'utf8');

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

/** Todas las declaraciones que alcanzan a ese selector exacto, en cualquier @media. */
function declaraciones(selector, incluirMedia) {
  const d = {};
  REGLAS.filter((r) => r.selector === selector && (incluirMedia || !r.dentroDeMedia)).forEach((r) => {
    r.cuerpo.split(';').forEach((par) => {
      const i = par.indexOf(':');
      if (i !== -1) d[par.slice(0, i).trim()] = par.slice(i + 1).trim();
    });
  });
  return d;
}

/** Dónde aparece un trozo en el HTML. Falla si no está, para no comparar -1. */
function donde(trozo) {
  const i = HTML.indexOf(trozo);
  ok(i !== -1, 'el HTML tiene «' + trozo + '»');
  return i;
}

const LOS_TRES = ['id="general-section"', 'id="context-section"', 'id="general-sequence-section"'];

// ── 1. El orden, y que sean hermanos de verdad ────────────────────────

test('los tres van en orden de alcance: el curso, la clase, esta secuencia', function () {
  const pos = LOS_TRES.map(donde);
  ok(pos[0] < pos[1] && pos[1] < pos[2],
    'del más ancho al más angosto, que es como se lee el panel de arriba a abajo');
});

test('el rótulo "Marcadores" separa lo del CURSO de lo de esta clase', function () {
  // El orden completo: Estilo del curso · Contexto de la clase · el rótulo
  // «Marcadores» · Estilo de esta secuencia · la lista.
  //
  // La 1.6.0 movió el bloque de la secuencia ARRIBA del rótulo y se lo presentó al
  // editor como un bug corregido —el mismo que se había corregido para el prompt del
  // curso—. No lo era: lo había puesto ahí a propósito, y su argumento es mejor que
  // el de la simetría. Lo que está debajo del separador es de la SECUENCIA en la que
  // estás y cambia al cambiar de clase; el estilo del curso se mantiene. Así que el
  // separador no separa "los bloques" de "la lista": separa lo del curso de lo de
  // esta clase, y el bloque de la secuencia va del lado de la clase.
  const rotulo = donde('<div class="section-label">Marcadores</div>');
  ok(donde('id="general-section"') < rotulo, 'el del CURSO va arriba: no es de ninguna clase');
  ok(donde('id="context-section"') < rotulo,
    'y el Contexto de la clase también. Por la regla del editor sería de la secuencia, pero ' +
    'señaló solo el de estilo y ese bloque nunca le molestó arriba: queda anotado, no tocado.');
  ok(rotulo < donde('id="general-sequence-section"'),
    'el estilo de ESTA SECUENCIA va abajo, con lo que cambia al cambiar de clase');
  ok(donde('id="general-sequence-section"') < donde('class="markers-scroll"'),
    'y arriba de la lista, que es lo que rotula junto con él');
});

test('son hermanos: ninguno vive adentro de otro', function () {
  // Es el bug de fondo, y el que volvió dos veces. Un `<details>` adentro de
  // otro se lee como "esto es parte de aquello", que es justo lo que los tres
  // alcances NO son: viajan juntos, pero cada uno es de su propio alcance.
  const cuerpo = HTML.slice(donde('<main id="view-markers"'), donde('class="markers-scroll"'));
  LOS_TRES.forEach(function (id) {
    const i = cuerpo.indexOf(id);
    // Hasta donde ABRE su propio `<details>`, que no cuenta como "encima".
    const antes = cuerpo.slice(0, cuerpo.lastIndexOf('<details', i));
    const abiertos = (antes.match(/<details/g) || []).length - (antes.match(/<\/details>/g) || []).length;
    eq(abiertos, 0, id + ' tiene que abrirse con cero <details> abiertos encima');
  });
});

test('las tres son el mismo tipo de caja: un <details> con su <summary>', function () {
  // "Con su recuadro desplegable, como las de abajo": el mecanismo de plegado es
  // el mismo que el de una tarjeta de marcador (`<details class="marker-card">`
  // + `<summary class="marker-summary">`), no un div con un click handler.
  LOS_TRES.forEach(function (id) {
    const i = donde(id);
    const abre = HTML.lastIndexOf('<details', i);
    ok(abre !== -1 && i - abre < 40, id + ' tiene que estar en la etiqueta de un <details>');
    has(HTML.slice(abre, i + 260), 'class="context-section', id + ' lleva la clase de la tarjeta de contexto');
    has(HTML.slice(abre, i + 400), '<summary class="hp-sumario"',
      id + ' se pliega con el mismo <summary> que las tres listas');
  });
});

// ── 2. Se ven como las tarjetas de abajo ──────────────────────────────

test('la tarjeta de contexto usa la misma caja que las de las tres listas', function () {
  // Y desde la 1.6.x no se le PARECE: es la misma. Las tres tarjetas de contexto
  // llevan `hp-tarjeta` en el HTML, así que su recuadro, su superficie, su radio y
  // su guarda salen de la misma regla que una ficha de marcador, una fila de la
  // Cola y una de Corrections. Antes eran dos bloques de declaraciones que había
  // que mantener iguales a mano, y este test era el que se acordaba.
  ['general-section', 'context-section', 'general-sequence-section'].forEach(function (id) {
    const i = donde('id="' + id + '"');
    has(HTML.slice(i, i + 200), 'hp-tarjeta', id + ' usa la tarjeta compartida');
  });
  const tarjeta = declaraciones('.hp-tarjeta');
  ok(tarjeta['border-radius'], 'con su radio de contenedor: ' + tarjeta['border-radius']);
  ok(tarjeta['background-color'], 'su superficie: ' + tarjeta['background-color']);
  ok(tarjeta.border, 'su hairline: ' + tarjeta.border);
  ok(tarjeta['border-left'], 'y su guarda izquierda: ' + tarjeta['border-left']);
  eq(tarjeta.padding, '0', 'sin padding propio: el aire lo ponen la fila y el cuerpo');
  // Lo único que las tarjetas de contexto declaran por su cuenta es el peso del
  // rótulo y que no reparten alto; si vuelven a declarar caja, vuelve el problema.
  const propio = declaraciones('.help-section, .context-section');
  eq(Object.keys(propio).join(','), 'flex', 'lo único propio es el `flex: none`');
});

test('la fila plegada es la MISMA que la de un marcador', function () {
  // Tenía su propia copia de las declaraciones (`display: flex`, el padding, el
  // `min-height`, el chevron) y este test comparaba las dos a mano. Ahora las tres
  // tarjetas de contexto usan `hp-sumario`, que es el encabezado de las tres
  // listas, así que no hay nada que comparar: es una regla.
  ['general-section', 'context-section', 'general-sequence-section'].forEach(function (id) {
    const i = donde('id="' + id + '"');
    has(HTML.slice(i, i + 320), '<summary class="hp-sumario"', id + ' usa el encabezado compartido');
  });
  const fila = declaraciones('.hp-sumario');
  ok(fila.padding, 'con su padding de fila: ' + fila.padding);
  ok(fila['min-height'], 'y su alto mínimo declarado: ' + fila['min-height']);
  const viejas = REGLAS.filter(function (r) {
    return !r.dentroDeMedia && /^(\.help-section|\.context-section) > summary$/.test(r.selector);
  });
  eq(viejas.length, 0, 'sin la copia de antes: ' + viejas.map((r) => r.selector).join(' | '));
  const cuerpo = declaraciones('.context-body');
  eq(cuerpo.padding, declaraciones('.hp-cuerpo').padding, 'y el cuerpo, el mismo padding');
});

test('desplegada se marca igual que una tarjeta de lista abierta', function () {
  // Era la guarda izquierda de 2 px a `--border-field`, y se movió: desde la
  // 1.6.x la guarda dice EL ESTADO en las tres listas del panel (ver la sección 9
  // del CSS), así que una misma barra no puede querer decir «está abierta» acá y
  // «este trabajo falló» tres centímetros más abajo. Lo que marca abierta es el
  // RECUADRO encendido, con el mismo token y el mismo 3.37:1 que pide 1.4.11 para
  // «whether a component is selected or focused» — más el chevron girado y el
  // cuerpo desplegado, que son forma y no color.
  const abierta = declaraciones('.hp-tarjeta[open], .hp-tarjeta.is-selected');
  eq(abierta['border-top-color'], 'var(--border-field)');
  eq(abierta['border-right-color'], 'var(--border-field)');
  eq(abierta['border-bottom-color'], 'var(--border-field)');
  eq(abierta['border-left-color'], undefined,
    'y NO el borde izquierdo: ése es del estado');
  // El chevron es el segundo canal, y es una forma.
  has(CSS, '.hp-tarjeta[open] > .hp-sumario::before { transform: rotate(90deg); }');
});

// ── 3. La escalera se fue, y no vuelve por la ventana ─────────────────

test('ninguno de los tres tiene sangría propia', function () {
  // Ni en la regla base ni en la media query del panel mínimo, que es donde
  // vivía la mitad de la escalera (`margin-left: 6px` a 320 px).
  ['#general-section', '#context-section', '#general-sequence-section'].forEach(function (sel) {
    const d = declaraciones(sel, true);
    eq(d['margin-left'], undefined, sel + ' no se sangra: el alcance lo dice el título');
    eq(d['padding-left'], undefined, sel + ' tampoco por padding');
  });
});

test('ninguno de los tres tiene guarda de alcance propia', function () {
  // Las guardas de 3 px en tres tonos distintos eran el segundo canal de la
  // escalera. La única guarda que queda es la de ESTADO (abierta / cerrada), y
  // es la misma para las tres.
  ['#general-section', '#context-section', '#general-sequence-section'].forEach(function (sel) {
    const d = declaraciones(sel, true);
    ok(!d['border-left'] && !d['border-left-color'] && !d['border-left-width'],
      sel + ' no dibuja una guarda propia');
    eq(d['border-radius'], undefined, sel + ' tampoco se recorta el radio para dejar ver la guarda');
  });
});

test('los tres títulos miden lo mismo', function () {
  // Eran 13 / 12 / 11 px. El tamaño codificaba el alcance, y con tres pasos de
  // 1 px eso no se lee (ver la cabecera de style.css). Ahora `.section-title` es
  // nivel 1 —13 px / 600— para las tres, igual que el nombre de un marcador,
  // porque hace el mismo trabajo: es la identidad de la fila cuando está
  // plegada.
  const conTamanoPropio = REGLAS.filter(function (r) {
    return /(#general-section|#context-section|#general-sequence-section)[\s\S]*\.section-title/.test(r.selector)
      && /font-size/.test(r.cuerpo);
  });
  eq(conTamanoPropio.length, 0,
    'ningún bloque le pone tamaño propio a su título: ' + conTamanoPropio.map((r) => r.selector).join(', '));
  const titulo = declaraciones('.marker-summary .marker-name, .qj-title, .corr-name, .help-head, .qp-seq, .section-title');
  eq(titulo['font-size'], '13px', 'los tres títulos son nivel 1');
  eq(titulo['font-weight'], '600');
});

test('el campo del marcador no lleva ninguna marca de alcance', function () {
  // `.marker-instruction` ES el `<textarea>`, no un contenedor. Cada vez que se
  // le dibujó algo para hablar del GRUPO salió un error de CSS visible: un
  // `border-top` de otro color que los otros tres lados, texto pegado al borde
  // de arriba, o una sombra interior que desaparecía al enfocar el campo.
  const d = declaraciones('.marker-instruction', true);
  eq(d['box-shadow'], undefined, 'sin guarda interior: se la come el anillo de foco');
  eq(d['border-top'], undefined, 'sin borde de arriba propio: el borde lo pone la regla de textarea, uniforme');
  eq(d['padding-top'], undefined, 'y sin padding de arriba propio, que era lo que corría el texto 3 px');
  eq(d['margin-left'], undefined, 'ni sangría: el campo no es el grupo');
});

// ── 4. Los dos bugs de la tarjeta de marcador, arreglados de raíz ─────
//
// Los dos eran la misma cosa: una regla y su contra-regla en el mismo archivo.
// La tarjeta plegada medía 55.5 px para mostrar un renglón de 19.5 px de texto,
// y de ahí salían casi los 23 px que se recuperaron.

test('hay UNA sola regla de tarjeta, que es lo que arregla el doble padding', function () {
  // La causa, textual: una regla de la v0.1.3 redefinía `.marker-card`
  // (borde, radio, fondo, `margin-bottom`) SIN resetear el `padding: 9px 12px`
  // de la regla original, que quedaba vivo. Así los 8 px de la fila se sumaban a
  // esos 9 y el nombre del marcador quedaba a 17 px del borde de su tarjeta.
  // Neutralizarlo con un `padding: 0` en una tercera regla habría dejado las
  // tres, y la próxima persona sin saber cuál manda.
  //
  // Desde la 1.6.x la tarjeta es de las tres listas, así que la pregunta se hace
  // sobre `.hp-tarjeta` — y `.marker-card` no puede volver a declarar caja.
  const propias = REGLAS.filter(function (r) {
    return !r.dentroDeMedia && r.selector.split(',').map((s) => s.trim()).indexOf('.hp-tarjeta') !== -1;
  });
  eq(propias.length, 1, 'una sola, o vuelve la pregunta de cuál gana: ' + propias.map((r) => r.selector).join(' | '));
  const d = declaraciones('.hp-tarjeta');
  eq(d.padding, '0', 'el padding lo pone la fila (`.hp-sumario`), que es la que sabe cuánto aire quiere');
  ok(d['padding-top'] === undefined && d['padding-left'] === undefined, 'y no vuelve por las propiedades largas');
  const marcador = REGLAS.filter(function (r) {
    return !r.dentroDeMedia && /^\.marker-card$/.test(r.selector);
  });
  eq(marcador.length, 0, 'y la tarjeta de marcador no redefine la caja por su cuenta');
});

test('el espacio entre tarjetas lo pone la lista, y nadie más', function () {
  // El otro: `.markers { gap: 6px }` MÁS `.marker-card { margin-bottom: 6px }`
  // = 12 px entre tarjetas. Dos reglas para una separación, en dos archivos de
  // ideas distintas, y ninguna de las dos mal escrita por su cuenta.
  // La separación es una sola para las tres listas: `.hp-lista`.
  const lista = declaraciones('.hp-lista');
  ok(lista.gap, 'la lista separa a sus hijos con gap: ' + lista.gap);
  eq(lista.display, 'flex');
  has(HTML, 'class="markers hp-lista"', 'la lista de marcadores es una de ellas');
  has(HTML, 'class="corr-list hp-lista"', 'y la de correcciones');
  has(fs.readFileSync(path.join(RAIZ, 'cep', 'js', 'queue-view.js'), 'utf8'), 'lista.className = "hp-lista queue-lista"',
    'y la de la Cola, que la arma el JS por secuencia');
  const tarjeta = declaraciones('.hp-tarjeta');
  eq(tarjeta['margin-bottom'], undefined, 'la tarjeta no se separa a sí misma: eso contaba doble');
  eq(tarjeta.margin, undefined, 'ni por el atajo');
  const filas = REGLAS.filter(function (r) {
    return !r.dentroDeMedia && /^(\.queue-job|\.corr-row)$/.test(r.selector);
  });
  eq(filas.length, 0, 'ni las otras dos: ' + filas.map((r) => r.selector).join(' | '));
});

// ── 5. Lo que NO se pierde: los tres viajan juntos ────────────────────

test('cada bloque sigue teniendo su renglón y su insignia', function () {
  // Plegada, la insignia es todo lo que se ve de una tarjeta; el renglón es lo
  // que dice con qué contexto se genera. Son los dos canales que quedaron a
  // cargo de explicar el anidado ahora que no hay escalera.
  ['id="general-source"', 'id="general-sequence-source"',
    'id="general-summary"', 'id="general-sequence-summary"'].forEach(function (id) {
    donde(id);
  });
});

test('cuando un nivel manda sobre el otro, se VE', function () {
  // Es la única contradicción posible entre los tres alcances, y es la que la
  // escalera pretendía explicar de antemano. Se dice con palabras (el renglón
  // nombra al otro bloque por su título en pantalla, lo fija
  // prompt-general-proyecto.test.js) y se pinta con el ámbar de «atención».
  eq(declaraciones('.general-source.is-override').color, 'var(--warn)');
  eq(declaraciones('.general-source.is-override')['font-weight'], '500', 'y con un peso más, no sólo color');
  eq(declaraciones('.general-source.is-warn').color, 'var(--warn)');
});

test('la guarda de acento de adentro del bloque de secuencia se fue', function () {
  // Era un refuerzo de la escalera dibujado POR DENTRO de una sola de las tres
  // cajas. Con las tres iguales, una barra adentro de una dice que ésa es
  // distinta, que es lo contrario de lo que son.
  const d = declaraciones('.general-level.is-sequence');
  eq(d['border-left'], '0');
  eq(d['padding-left'], '0');
});
