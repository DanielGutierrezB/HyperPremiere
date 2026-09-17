#!/usr/bin/env node
'use strict';

// Audita el panel con números, no con adjetivos.
//
// Hermano de `medir-botones.js`, pero mide otra cosa: ese pregunta si algo se
// rompe (desborde, solape); éste pregunta si algo se LEE. Son las medidas que
// hacen falta para defender —o para tirar a la basura— una decisión de diseño:
//
//   · inventario: cuántos tamaños de letra, cuántos colores de texto, cuántos
//     radios distintos hay pintados a la vez. Es la entropía del sistema, y es
//     lo que decide si la jerarquía se lee o si compite consigo misma.
//   · contraste REAL de cada texto visible contra el fondo que tiene detrás,
//     con la cadena de `opacity` compuesta (que es lo que el ojo ve y lo que
//     WCAG mide, no el color declarado en el CSS).
//   · alto de fila de las tres listas (marcadores, cola, correcciones) y cuántas
//     entran en el primer viewport.
//   · el presupuesto vertical: cuánto del panel se va en cromo fijo
//     (encabezado + acciones + sesión + pestañas) antes de que empiece el
//     contenido.
//   · blancos de clic por debajo de 24x24 CSS px (WCAG 2.2 SC 2.5.8).
//
// Corre sobre la maqueta, con el tema puesto o sin él, así el antes y el después
// se miden con la misma regla:
//
//   node test/manual/panel-demo/temas/estudiado/auditar.js --json /tmp/antes.json
//   node .../auditar.js --tema estudiado --json /tmp/despues.json
//
// Usa el Chrome del sistema por CDP con el puppeteer-core de `bridge/`, igual
// que `medir-botones.js` (no baja nada). HP_CHROME cambia la ruta.

const path = require('path');
const fs = require('fs');
const RAIZ = path.join(__dirname, '..', '..', '..', '..', '..');
const puppeteer = require(path.join(RAIZ, 'bridge', 'node_modules', 'puppeteer-core'));

const CHROME = process.env.HP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(nombre, def) {
  const i = process.argv.indexOf(nombre);
  return i === -1 ? def : process.argv[i + 1];
}

const BASE = arg('--base', 'http://localhost:4599/');
const TEMA = arg('--tema', '');
const ANCHOS = String(arg('--anchos', '320,400,600,900')).split(',').map(Number);
const ALTO = Number(arg('--alto', 700));
const JSON_OUT = arg('--json', '');
const CAPS = arg('--capturas', '');

const VISTAS = [
  { nombre: 'marcadores', escenario: '', abrir: 'todoAbierto', esperar: '.marker-card[open]' },
  // Una ficha con los CHIPS de mención en el campo, que `todoAbierto` no alcanza a
  // dar: el acordeón deja abierta la última que se tocó, y esa es la del checklist —
  // justo la que tiene su referencia escrita en texto plano y ninguna mención—. Y los
  // chips hay que medirlos: el que apunta bien es texto de acento sobre el fondo del
  // campo, y los dos estados rotos se pintan sobre una superficie tenue, así que el
  // fondo de ese texto NO es el del campo.
  { nombre: 'marcador-menciones', escenario: '', abrir: 'menciones', esperar: '.hp-chip' },
  // Y el MENÚ del `@` abierto: sus textos van sobre `--bg-overlay` y la fila
  // resaltada sobre el acento, así que ninguno de los dos fondos es el del campo y
  // hay que medirlos aparte. Es además la vista donde algo puede quedar cortado a
  // 320 px, que es lo que `desborde` cuenta.
  { nombre: 'marcador-arroba', escenario: '', abrir: 'arroba', esperar: '.hp-arroba-op' },
  // La lista con las tarjetas plegadas, que es como se ve al abrir el panel y
  // la única foto donde "cuántas filas entran sin scrollear" quiere decir algo.
  { nombre: 'marcadores-lista', escenario: '', abrir: 'listaPlegada', esperar: '.marker-card' },
  { nombre: 'prompts-generales', escenario: '', abrir: 'promptsGenerales', esperar: '#general-section[open] #general-instruction' },
  { nombre: 'cola', escenario: '', abrir: 'cola', esperar: '.queue-job' },
  { nombre: 'corrections', escenario: '', abrir: 'corrections', esperar: '.corr-row' },
  { nombre: 'config', escenario: '', abrir: 'config', esperar: '#btn-save-config' },
];

const SOLO = arg('--vistas', '');
const ELEGIDAS = SOLO ? VISTAS.filter((v) => SOLO.split(',').indexOf(v.nombre) !== -1) : VISTAS;

// ── Lo que corre dentro de la página ──────────────────────────────────

const ABRIR = async function (modo) {
  const respirar = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function abrirDetalles() {
    [].slice.call(document.querySelectorAll('details')).forEach(function (d) { d.open = true; });
  }
  function apretar(id) { const e = document.getElementById(id); if (e) e.click(); return !!e; }

  if (modo === 'todoAbierto') {
    abrirDetalles();
  } else if (modo === 'menciones') {
    // La primera ficha que tenga menciones escritas, y su desplegable "Avanzado"
    // abierto para que también entre a la cuenta lo que vive ahí.
    const fichas = [].slice.call(document.querySelectorAll('details.marker-card'));
    fichas.forEach(function (d) { d.open = false; });
    await respirar(200);
    const conMencion = fichas.filter(function (d) {
      const ta = d.querySelector('.hp-campo-input');
      return ta && String(ta.value || '').indexOf('@[') !== -1;
    })[0];
    if (conMencion) {
      conMencion.open = true;
      await respirar(400);
      [].slice.call(conMencion.querySelectorAll('details')).forEach(function (d) { d.open = true; });
      await respirar(200);
      const campo = conMencion.querySelector('.hp-campo-input');
      if (campo) {
        // Se le agrega un chip con un NÚMERO QUE NO EXISTE, para que los cuatro
        // estados de un chip estén en pantalla a la vez: el que apunta bien, la
        // referencia que ya no está adjunta, la que el disco no tiene y el número
        // que el editor escribió y que no apunta a nada. Los cuatro se pintan sobre
        // fondos distintos —dos sobre el del campo y dos sobre su propia superficie
        // tenue— así que hay que medirlos juntos y no de a uno.
        campo.value = campo.value + ' Y la @[Imagen_7].';
        campo.dispatchEvent(new Event('input', { bubbles: true }));
        campo.scrollTop = campo.scrollHeight;
        campo.dispatchEvent(new Event('scroll'));
      }
    }
    await respirar(300);
  } else if (modo === 'arroba') {
    // El MENÚ del `@` abierto, con sus nueve referencias agrupadas por ámbito. Es
    // otra vista y no un agregado a la de menciones porque es otra superficie: sus
    // textos van sobre `--bg-overlay` y la fila resaltada sobre el acento, o sea que
    // ninguno de los dos fondos es el del campo.
    const fichas = [].slice.call(document.querySelectorAll('details.marker-card'));
    fichas.forEach(function (d) { d.open = false; });
    await respirar(200);
    const ficha = fichas[0];
    if (ficha) {
      ficha.open = true;
      await respirar(400);
      const campo = ficha.querySelector('.hp-campo-input');
      if (campo) {
        campo.value = 'copiá @';
        campo.focus();
        campo.setSelectionRange(7, 7);
        campo.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    await respirar(400);
  } else if (modo === 'listaPlegada') {
    [].slice.call(document.querySelectorAll('details')).forEach(function (d) { d.open = false; });
    await respirar(300);
  } else if (modo === 'promptsGenerales') {
    [].slice.call(document.querySelectorAll('details.marker-card')).forEach(function (d) { d.open = false; });
    ['general-section', 'general-sequence-section'].forEach(function (id) {
      const gen = document.getElementById(id);
      if (gen) gen.open = true;
    });
    await respirar(400);
  } else if (modo === 'cola') {
    apretar('tab-queue');
    await respirar(1200);
  } else if (modo === 'corrections') {
    apretar('tab-corrections');
    await respirar(1400);
  } else if (modo === 'config') {
    apretar('btn-config');
    await respirar(600);
  }
};

const MEDIR = function () {
  // ── utilería de color ───────────────────────────────────────────────
  function parse(c) {
    if (!c) return null;
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  // source-over con alpha en las dos capas (el `a` del resultado importa: las
  // capas de adentro de un grupo con `opacity` pueden quedar semitransparentes).
  function sobre(fg, bg) {
    const as = fg.a, ab = bg.a;
    const a = as + ab * (1 - as);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (fg.r * as + bg.r * ab * (1 - as)) / a,
      g: (fg.g * as + bg.g * ab * (1 - as)) / a,
      b: (fg.b * as + bg.b * ab * (1 - as)) / a,
      a: a,
    };
  }
  function lum(c) {
    const f = function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function ratio(a, b) {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function hex(c) {
    const h = function (v) { return ('0' + Math.round(v).toString(16)).slice(-2); };
    return '#' + h(c.r) + h(c.g) + h(c.b);
  }

  // Opacidad acumulada de un elemento hacia la raíz. `opacity` no se hereda:
  // se multiplica al compositar, así que lo que el ojo ve es el producto.
  function opacidadAcumulada(el) {
    let o = 1, n = el;
    while (n && n !== document.documentElement) {
      const v = parseFloat(getComputedStyle(n).opacity);
      if (!isNaN(v)) o *= v;
      n = n.parentElement;
    }
    return o;
  }

  // El par de colores que el OJO ve en un texto: el del glifo y el del fondo
  // pegado a él, ya compuestos. Es lo que mide WCAG, y no coincide con lo que
  // declara el CSS en cuanto hay un `opacity` o un `rgba()` en el medio.
  //
  // El modelo es el de la especificación: un elemento con `opacity < 1` pinta
  // su subárbol en una capa aparte y la compone sobre lo que hay atrás. O sea
  // que el texto de un botón apagado NO se tiñe del color de fondo del botón
  // (adentro de la capa el glifo es opaco y lo tapa): los dos, glifo y fondo,
  // se desvanecen JUNTOS contra lo que hay detrás del grupo.
  //
  // Con la cuenta ingenua —alpha por opacidad, todo contra el fondo del padre—
  // un `.btn-generate:disabled` daba 1.05:1, que es un desastre inventado: el
  // glifo salía pintado de azul porque se lo mezclaba con su propio fondo.
  function parEfectivo(el) {
    const cadena = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) cadena.push(n);

    // El grupo de opacidad más EXTERNO de la cadena: ahí está el borde donde la
    // capa se compone. Si hay varios anidados, el producto los cubre igual.
    let gi = -1, O = 1;
    for (let i = 0; i < cadena.length; i++) {
      const v = parseFloat(getComputedStyle(cadena[i]).opacity);
      if (!isNaN(v) && v < 1) { O *= v; gi = i; }
    }

    const bgDe = function (n) {
      const c = parse(getComputedStyle(n).backgroundColor);
      return c && c.a > 0 ? c : null;
    };

    // Lo que hay DETRÁS del grupo (afuera, donde ya no se desvanece nada).
    //
    // El `Math.max(…, 1)` es de la etapa 3 y arregla un doble conteo: sin
    // grupo de opacidad `gi` vale -1, así que este recorrido arrancaba en 0 —el
    // ELEMENTO MISMO— y su fondo translúcido se componía dos veces, una acá y
    // otra en `dentro`. Con un `rgba(…, 0.14)` eso alcanzaba para mover el
    // resultado un punto entero: la pastilla de estado en rojo medía 4.36:1
    // cuando el ojo ve 5.61, o sea que la herramienta reprobaba un texto que
    // pasa. Al revés no puede pasar (contar un fondo de más siempre ACLARA el
    // fondo), pero un número que no es el que el ojo ve no sirve para decidir.
    let atras = { r: 14, g: 17, b: 22, a: 1 }; // el fondo del panel, por si acaso
    const afuera = [];
    for (let i = Math.max(gi + 1, 1); i < cadena.length; i++) {
      const c = bgDe(cadena[i]);
      if (c) afuera.push(c);
      if (c && c.a >= 1) break;
    }
    for (let i = afuera.length - 1; i >= 0; i--) atras = sobre(afuera[i], atras);

    // Los fondos de ADENTRO del grupo (de el hacia afuera), sobre transparente.
    let dentro = { r: 0, g: 0, b: 0, a: 0 };
    for (let i = Math.max(gi, 0); i >= 0; i--) {
      const c = bgDe(cadena[i]);
      if (c) dentro = sobre(c, dentro);
    }

    const fgCss = parse(getComputedStyle(el).color) || { r: 255, g: 255, b: 255, a: 1 };
    const glifoEnCapa = sobre(fgCss, dentro);       // el glifo tapa el fondo del botón
    const fg = sobre({ r: glifoEnCapa.r, g: glifoEnCapa.g, b: glifoEnCapa.b, a: glifoEnCapa.a * O }, atras);
    const bg = sobre({ r: dentro.r, g: dentro.g, b: dentro.b, a: dentro.a * O }, atras);
    return { fg: fg, bg: bg, O: O };
  }

  function visible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function textoPropio(el) {
    let t = '';
    for (let i = 0; i < el.childNodes.length; i++) {
      const n = el.childNodes[i];
      if (n.nodeType === 3) t += n.nodeValue;
    }
    return t.replace(/\s+/g, ' ').trim();
  }

  function claseDe(el) {
    const c = (el.className && typeof el.className === 'string') ? el.className : '';
    return (el.id ? '#' + el.id : '') + (c ? '.' + c.trim().split(/\s+/).join('.') : el.tagName.toLowerCase());
  }

  // El sello amarillo de la maqueta no es parte del panel: no entra a ninguna
  // cuenta (si entrara, aportaría un tamaño, un color y un contraste de 1:1 que
  // en Premiere no existen).
  const todos = [].slice.call(document.querySelectorAll('body *')).filter(function (el) {
    if (!visible(el)) return false;
    return (el.textContent || '').indexOf('MAQUETA · datos falsos') === -1;
  });

  // ── inventario tipográfico / cromático ──────────────────────────────
  const tamanos = {}, colores = {}, radios = {}, pesos = {}, bordes = {};
  const textos = [];
  todos.forEach(function (el) {
    const cs = getComputedStyle(el);
    const t = textoPropio(el);
    if (t) {
      const fs = Math.round(parseFloat(cs.fontSize) * 10) / 10;
      tamanos[fs] = (tamanos[fs] || 0) + 1;
      pesos[cs.fontWeight] = (pesos[cs.fontWeight] || 0) + 1;

      const par = parEfectivo(el);
      colores[hex(par.fg)] = (colores[hex(par.fg)] || 0) + 1;

      // "Texto grande" de WCAG 1.4.3: ≥18 pt (24 px) o ≥14 pt (18.66 px) en
      // negrita. Acá abajo no hay nada de eso, así que todo pide 4.5:1.
      const grande = fs >= 24 || (fs >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
      const cr = ratio(par.fg, par.bg);
      textos.push({
        sel: claseDe(el),
        px: fs,
        peso: cs.fontWeight,
        fg: hex(par.fg),
        bg: hex(par.bg),
        op: Math.round(par.O * 100) / 100,
        ratio: Math.round(cr * 100) / 100,
        pide: grande ? 3 : 4.5,
        pasa: cr >= (grande ? 3 : 4.5),
        muestra: t.slice(0, 48),
      });
    }
    const rad = cs.borderTopLeftRadius;
    if (rad && rad !== '0px') radios[rad] = (radios[rad] || 0) + 1;
    if (parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0) {
      const b = parse(cs.borderTopColor) || parse(cs.borderLeftColor);
      if (b && b.a > 0) {
        const bg = parEfectivo(el).bg;
        bordes[hex(sobre({ r: b.r, g: b.g, b: b.b, a: b.a * opacidadAcumulada(el) }, bg))] =
          (bordes[hex(sobre({ r: b.r, g: b.g, b: b.b, a: b.a * opacidadAcumulada(el) }, bg))] || 0) + 1;
      }
    }
  });

  // ── sondas: los estados que no están pintados en la pantalla ────────
  //
  // Lo deshabilitado casi nunca está a la vista cuando uno saca la foto, y es
  // justo el caso que se sospecha roto. Así que se fuerza: se apaga un botón de
  // cada familia, se mide, y se lo devuelve como estaba. Mismo criterio para el
  // 🎙 apagado por plataforma, que vive de una clase y no del atributo.
  const sondas = [];
  function sondaApagada(nombre, sel, clase) {
    const el = document.querySelector(sel);
    if (!el || !visible(el)) return;
    const eraDisabled = el.disabled;
    const tenia = clase ? el.classList.contains(clase) : false;
    // Sin esto la medición MIENTE, y mintió: `.btn-generate` tiene
    // `transition: background 160ms`, así que apagarlo y leer el estilo en el
    // mismo tick devuelve el color de ANTES de la transición — el botón
    // apagado se medía con su fondo azul y daba 1.08:1 cuando en realidad
    // quedaba en 5.5:1. Se congelan las transiciones del elemento antes de
    // leer y se lo devuelve como estaba.
    const transEra = el.style.transition;
    el.style.transition = 'none';
    if (clase) el.classList.add(clase); else el.disabled = true;
    void el.offsetWidth;   // fuerza el recálculo con el estado nuevo
    const par = parEfectivo(el);
    const cs = getComputedStyle(el);
    const fs = Math.round(parseFloat(cs.fontSize) * 10) / 10;
    const cr = ratio(par.fg, par.bg);
    sondas.push({
      nombre: nombre, sel: claseDe(el), px: fs, peso: cs.fontWeight,
      fg: hex(par.fg), bg: hex(par.bg), op: Math.round(par.O * 100) / 100,
      ratio: Math.round(cr * 100) / 100, pasa: cr >= 4.5,
    });
    if (clase) { if (!tenia) el.classList.remove(clase); } else { el.disabled = eraDisabled; }
    el.style.transition = transEra;
  }
  sondaApagada('botón primario apagado', '.btn-primary');
  sondaApagada('botón normal apagado', '.actions button:not(.btn-primary)');
  sondaApagada('Generar apagado', '.btn-generate');
  sondaApagada('botón secundario apagado', '.btn-secondary');
  sondaApagada('botón de cola apagado', '.qbtn');
  sondaApagada('botón de ícono apagado', '.icon-btn');
  sondaApagada('🎙 apagado por plataforma', '.mic-btn', 'is-off');

  /**
   * Mide un texto por selector, tal como está, y lo devuelve con nombre.
   *
   * El censo de contraste ya los cuenta a todos, pero devuelve un mínimo y una
   * mediana: para los textos que se acaban de agregar hace falta el número propio, y
   * si no se lo pide por nombre queda escondido adentro de un promedio de 346.
   */
  function sondaTexto(nombre, sel) {
    const el = document.querySelector(sel);
    if (!el || !visible(el)) { sondas.push({ nombre: nombre, sel: sel, ausente: true }); return; }
    const par = parEfectivo(el);
    const cs = getComputedStyle(el);
    const cr = ratio(par.fg, par.bg);
    sondas.push({
      nombre: nombre, sel: claseDe(el), px: Math.round(parseFloat(cs.fontSize) * 10) / 10,
      peso: cs.fontWeight, fg: hex(par.fg), bg: hex(par.bg),
      op: Math.round(par.O * 100) / 100, ratio: Math.round(cr * 100) / 100, pasa: cr >= 4.5,
    });
  }
  // Los CHIPS de mención: el que apunta bien y los dos estados rotos. Los rotos se
  // pintan sobre una superficie tenue, así que el fondo de ese texto NO es el del
  // campo y hay que medirlo aparte; y el que apunta bien es el azul del acento, que
  // es el color más saturado que el panel usa sobre texto de 13 px.
  sondaTexto('chip de mención', '.hp-chip:not(.is-colgada):not(.is-sin-disco):not(.is-ambigua):not(.is-sin-numero)');
  sondaTexto('chip colgado', '.hp-chip.is-colgada');
  sondaTexto('chip sin disco', '.hp-chip.is-sin-disco');
  // El chip con un número que no existe. Va en el MISMO rojo que el colgado —los dos
  // no apuntan a nada— así que lo que esto comprueba es que ese rojo siga pasando AA
  // sobre su superficie tenue, ahora que además lo usa un chip que dice un número.
  sondaTexto('chip con número inválido', '.hp-chip.is-sin-numero');
  // Y el nombre del archivo en el preview del hover, que es donde el chip corto
  // manda a leer qué imagen es. Se abre a mano: sin `mouseover` no existe.
  const chip0 = document.querySelector('.hp-chip:not(.is-colgada):not(.is-sin-disco)');
  if (chip0) chip0.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  sondaTexto('preview del chip · nombre', '.hp-chip-preview .hp-chip-preview-pie');

  // El MENÚ del `@`: sus cuatro textos van sobre la superficie del desplegable
  // (`--bg-overlay`) y no sobre el campo, y el de la fila resaltada va sobre el
  // acento — que es el fondo más claro que el panel le pone debajo de un texto.
  sondaTexto('menú @ · número', '.hp-arroba-op:not(.is-sel):not(.is-sin-disco) .hp-arroba-num');
  sondaTexto('menú @ · nombre', '.hp-arroba-op:not(.is-sel) .hp-arroba-nombre');
  sondaTexto('menú @ · rótulo del ámbito', '.hp-arroba-rotulo');
  sondaTexto('menú @ · fila resaltada', '.hp-arroba-op.is-sel .hp-arroba-num');
  sondaTexto('menú @ · sin disco', '.hp-arroba-op.is-sin-disco .hp-arroba-falta');

  // ── alto de fila de las listas ──────────────────────────────────────
  function alturas(sel) {
    const els = [].slice.call(document.querySelectorAll(sel)).filter(visible);
    if (!els.length) return null;
    const hs = els.map(function (e) { return Math.round(e.getBoundingClientRect().height * 10) / 10; });
    return { n: hs.length, min: Math.min.apply(null, hs), max: Math.max.apply(null, hs), mediana: hs.sort(function (a, b) { return a - b; })[Math.floor(hs.length / 2)] };
  }

  // ── cromo fijo vs contenido ─────────────────────────────────────────
  function altoDe(sel) {
    const e = document.querySelector(sel);
    if (!e || !visible(e)) return 0;
    return Math.round(e.getBoundingClientRect().height * 10) / 10;
  }
  const cromo = {
    header: altoDe('.panel-header'),
    actions: altoDe('.actions'),
    sesion: altoDe('.session-usage'),
    tabs: altoDe('.tabs'),
    output: altoDe('#output'),
  };
  cromo.total = cromo.header + cromo.actions + cromo.sesion + cromo.tabs;
  cromo.pct = Math.round((cromo.total / window.innerHeight) * 1000) / 10;

  // ── blancos de clic (WCAG 2.2 SC 2.5.8: 24x24 CSS px) ───────────────
  const clicables = [].slice.call(document.querySelectorAll(
    'button, a, input, textarea, summary, [role="button"], .hps-option, .still-tag, .still-remove, .still-send, .resource-remove, .qbtn, .tab, .queue-clear'
  )).filter(visible);
  // El criterio no es «mide menos de 24»: es «mide menos de 24 Y NO tiene la
  // separación que pide la excepción de espaciado». Textual: «Undersized
  // targets… are positioned so that if a 24 CSS pixel diameter circle is
  // centered on the bounding box of each, the circles do not intersect another
  // target or the circle for another undersized target.»
  // Así que un ✕ de 20×24 metido en una fila con 6 px de aire alrededor PASA,
  // y medirlo como falla es medir un proxy y no la norma.
  const blancos = clicables.map(function (el) {
    const r = el.getBoundingClientRect();
    return {
      el: el, r: r,
      w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
      cx: r.left + r.width / 2, cy: r.top + r.height / 2,
      chico: r.width < 24 || r.height < 24,
    };
  });
  function circuloTocaCaja(c, r) {
    // ¿El círculo de radio 12 centrado en (c.cx, c.cy) toca el rectángulo r?
    const dx = Math.max(r.left - c.cx, 0, c.cx - r.right);
    const dy = Math.max(r.top - c.cy, 0, c.cy - r.bottom);
    return (dx * dx + dy * dy) < 144;
  }
  const chicos = [];
  blancos.forEach(function (a) {
    if (!a.chico) return;
    let choca = null;
    for (let i = 0; i < blancos.length; i++) {
      const b = blancos[i];
      if (b === a) continue;
      if (b.el.contains(a.el) || a.el.contains(b.el)) continue;  // anidados: mismo blanco
      const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
      if (b.chico ? d < 24 : circuloTocaCaja(a, b.r)) {
        choca = { con: claseDe(b.el), d: Math.round(d * 10) / 10 };
        break;
      }
    }
    if (choca) {
      chicos.push({
        sel: claseDe(a.el), w: a.w, h: a.h,
        t: (a.el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
        choca: choca,
      });
    }
  });
  const chicosConEspacio = blancos.filter(function (c) { return c.chico; }).length - chicos.length;

  // ── censo del primer viewport ───────────────────────────────────────
  // Qué compite por la atención antes de scrollear: cajas dibujadas (borde o
  // fondo propio), rótulos en mayúsculas y cosas pintadas con el acento.
  const vp = { w: window.innerWidth, h: window.innerHeight };
  function enViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < vp.h && r.right > 0 && r.left < vp.w && r.width > 2 && r.height > 2;
  }
  const arriba = todos.filter(enViewport);
  let cajas = 0, mayusculas = 0, saturados = 0, conTexto = 0;
  arriba.forEach(function (el) {
    const cs = getComputedStyle(el);
    if (cs.textTransform === 'uppercase' && textoPropio(el)) mayusculas++;
    if (textoPropio(el)) conTexto++;

    // «Caja VISIBLE», no «caja declarada». Contar todo lo que tenga un borde o
    // un fondo no dice nada: en este panel casi todo lo tiene, y la mitad son
    // `rgba(255,255,255,.08)`, que compone a 1.25:1 y no se ve. Lo que compite
    // por la atención es lo que el ojo distingue del fondo, así que se mide el
    // contraste del borde y del fondo contra la superficie de atrás y se cuenta
    // sólo de 1.3:1 para arriba.
    const par = parEfectivo(el);
    const bg = parse(cs.backgroundColor);
    const bordeAncho = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) +
      parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    const b = parse(cs.borderTopColor) || parse(cs.borderLeftColor);
    const detras = el.parentElement ? parEfectivo(el.parentElement).bg : { r: 15, g: 17, b: 21, a: 1 };
    let visibleCaja = false;
    if (bg && bg.a > 0.02 && ratio(par.bg, detras) >= 1.3) visibleCaja = true;
    if (!visibleCaja && bordeAncho > 0 && b && b.a > 0.02) {
      const bc = sobre({ r: b.r, g: b.g, b: b.b, a: b.a * opacidadAcumulada(el) }, par.bg);
      if (ratio(bc, par.bg) >= 1.3) visibleCaja = true;
    }
    if (visibleCaja) cajas++;

    // Texto pintado con un color SATURADO (acento o semántico): es el otro
    // reclamo de atención, y el que más se gasta de más.
    const fg = parse(cs.color);
    if (fg && textoPropio(el)) {
      const mx = Math.max(fg.r, fg.g, fg.b), mn = Math.min(fg.r, fg.g, fg.b);
      if (mx - mn > 55) saturados++;
    }
  });

  // ── cuántas filas entran sin scrollear ──────────────────────────────
  function entran(sel) {
    const els = [].slice.call(document.querySelectorAll(sel)).filter(visible);
    return els.filter(function (e) {
      const r = e.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= vp.h;
    }).length;
  }

  // ── espacio perdido ─────────────────────────────────────────────────
  //
  // Dos formas de perderlo, y las dos se miden. A lo ancho: cuántos píxeles hay
  // entre el borde del panel y la primera letra de una fila (la suma de los
  // padding de todas las cajas anidadas que la envuelven). A lo alto: qué
  // proporción del primer viewport está cubierta por cajas de texto.
  function sangria(sel) {
    const e = document.querySelector(sel);
    if (!e || !visible(e)) return null;
    const r = e.getBoundingClientRect();
    let anidado = 0;
    for (let n = e.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const bg = parse(cs.backgroundColor);
      const bw = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderLeftWidth);
      const bc = parse(cs.borderLeftColor) || parse(cs.borderTopColor);
      if ((bg && bg.a > 0.02) || (bw > 0 && bc && bc.a > 0.02)) anidado++;
    }
    return { izq: Math.round(r.left), der: Math.round(vpAncho() - r.right), anidado: anidado };
  }
  function vpAncho() { return window.innerWidth; }

  let tinta = 0;
  [].slice.call(document.querySelectorAll('body *')).forEach(function (el) {
    if (!visible(el)) return;
    if ((el.textContent || '').indexOf('MAQUETA · datos falsos') !== -1) return;
    if (!textoPropio(el)) return;
    const r = el.getBoundingClientRect();
    const alto = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    const ancho = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    if (alto > 0 && ancho > 0) tinta += alto * ancho;
  });

  const perdido = {
    marcador: sangria('.marker-summary .marker-name'),
    job: sangria('.qj-title'),
    corr: sangria('.corr-name'),
    rotulo: sangria('.context-body .field-label'),
    tintaPct: Math.round((tinta / (window.innerWidth * window.innerHeight)) * 1000) / 10,
  };

  // ── la tensión de los dos prompts ───────────────────────────────────
  let dosPrompts = null;
  const a = document.querySelector('#general-instruction');
  const b = document.querySelector('#general-sequence-instruction');
  if (a && b && visible(a) && visible(b)) {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    dosPrompts = {
      span: Math.round(rb.bottom - ra.top),
      viewport: vp.h,
      juntos: rb.bottom - ra.top <= vp.h,
      topCurso: Math.round(ra.top),
      topSecuencia: Math.round(rb.top),
    };
  }

  // ── desborde ────────────────────────────────────────────────────────
  const desborde = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth);

  const fallas = textos.filter(function (t) { return !t.pasa; });
  const ratios = textos.map(function (t) { return t.ratio; }).sort(function (x, y) { return x - y; });

  return {
    viewport: vp,
    desborde: desborde,
    inventario: {
      tamanos: tamanos,
      nTamanos: Object.keys(tamanos).length,
      colores: colores,
      nColores: Object.keys(colores).length,
      radios: radios,
      nRadios: Object.keys(radios).length,
      pesos: pesos,
      bordes: bordes,
      nBordes: Object.keys(bordes).length,
    },
    filas: {
      marcador: alturas('.marker-card > .marker-summary'),
      marcadorCard: alturas('.marker-card'),
      job: alturas('.queue-job'),
      corr: alturas('.corr-row'),
      boton: alturas('.actions button'),
      tab: alturas('.tab'),
    },
    cromo: cromo,
    entran: {
      marcadores: entran('.marker-card'),
      jobs: entran('.queue-job'),
      corr: entran('.corr-row'),
    },
    censo: {
      elementos: arriba.length,
      conTexto: conTexto,
      cajas: cajas,
      mayusculas: mayusculas,
      saturados: saturados,
    },
    blancos: {
      total: clicables.length,
      fallan: chicos.length,                  /* chicos Y sin la separación */
      chicosConEspacio: chicosConEspacio,     /* chicos pero pasan por la excepción */
      lista: chicos.slice(0, 40),
    },
    contraste: {
      n: textos.length,
      min: ratios[0],
      p10: ratios[Math.floor(ratios.length * 0.1)],
      mediana: ratios[Math.floor(ratios.length / 2)],
      fallan: fallas.length,
      peores: fallas.sort(function (x, y) { return x.ratio - y.ratio; }).slice(0, 25),
    },
    sondas: sondas,
    perdido: perdido,
    dosPrompts: dosPrompts,
  };
};

// ── El recorrido ──────────────────────────────────────────────────────

(async function () {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--hide-scrollbars'],
  });
  const salida = { tema: TEMA || '(actual)', vistas: {} };
  const q = TEMA ? ('?tema=' + TEMA) : '';

  for (const vista of ELEGIDAS) {
    salida.vistas[vista.nombre] = {};
    for (const w of ANCHOS) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: ALTO, deviceScaleFactor: 2 });
      let url = BASE + q;
      if (vista.escenario) url += (q ? '&' : '?') + vista.escenario.replace(/^\?/, '');
      await page.goto(url, { waitUntil: 'networkidle2' });
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
        for (let i = 0; i < 3 && !(await hay()); i++) {
          await page.evaluate(ABRIR, vista.abrir);
          await new Promise((r) => setTimeout(r, 1200));
        }
        if (!(await hay())) throw new Error('la vista ' + vista.nombre + ' a ' + w + ' px no se abrió');
      }
      const m = await page.evaluate(MEDIR);
      salida.vistas[vista.nombre][w] = m;
      if (CAPS) {
        fs.mkdirSync(CAPS, { recursive: true });
        await page.screenshot({ path: path.join(CAPS, vista.nombre + '-' + w + '.png') });
      }
      console.log('· ' + vista.nombre + ' @' + w +
        ' · desborde ' + m.desborde +
        ' · tamaños ' + m.inventario.nTamanos +
        ' · colores ' + m.inventario.nColores +
        ' · contraste min ' + m.contraste.min + ' (fallan ' + m.contraste.fallan + '/' + m.contraste.n + ')' +
        ' · blancos 2.5.8 fallan ' + m.blancos.fallan + '/' + m.blancos.total +
        ' (' + m.blancos.chicosConEspacio + ' chicos con espacio)' +
        ' · cromo ' + m.cromo.total + 'px (' + m.cromo.pct + '%)');
      await page.close();
    }
  }

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(salida, null, 1));
    console.log('\n→ ' + JSON_OUT);
  }
  await browser.close();
})();
