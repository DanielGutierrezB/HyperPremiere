'use strict';

// El encabezado del panel se montaba encima de sí mismo, y ahora también lleva
// el selector de micrófono.
//
// Lo que se veía en el panel de Daniel, con el panel angosto: "HyperPremiere"
// dibujado ENCIMA de la insignia verde de estado, y el `?` encima del
// `⟳ v1.4.4…`, que además quedaba cortado. Medido en la maqueta
// (test/manual/panel-demo, que usa el HTML y el CSS de verdad) a 320, 360, 400,
// 470, 600 y 900 px:
//
//   ancho | desborde del doc | solapes                          | ⟳
//   ------+------------------+----------------------------------+-------------
//    320  |        0 px      | marca × insignia 7, marca × ⚙ 26 | 155 px
//    360  |        0 px      | marca × insignia 15, marca × ? 23| 219 px
//    400  |        0 px      | marca × ? 16                     | 252 px
//    470  |        4 px      | marca × insignia 6               |  19 px ← cortado
//    600  |        0 px      | (ninguno)                        |  70 px
//    900  |        0 px      | (ninguno)                        |  70 px
//
// Dos causas, las dos por dejar encoger lo que no puede encogerse:
//
// 1. `.brand` traía `min-width: 0` —permiso para quedar más chica que su
//    contenido—. El nombre es `white-space: nowrap` y no recortaba, así que lo
//    que no entraba en la caja se pintaba AFUERA, sobre las herramientas. En
//    flex nada se superpone por sí solo: se superpone cuando un texto sin
//    recorte sale de una caja aplastada.
//
// 2. La etiqueta de versión era otra aparición del `button { flex: 1;
//    min-width: 0 }` global (el que repartía la barra de acciones en partes
//    iguales y de paso aplastaba a todos los demás botones del panel). A 470 px
//    `.btn-update` quedó en 19 px de ancho con su "⟳ v1.4.49" (70 px)
//    chorreando sobre el `?`, y se lo tapó blindando el CONTENEDOR
//    (`.header-tools > * { flex: none }`), además de los tres blindajes uno por
//    uno que ya había.
//
//    Eso duró un día: la regla global era la causa de otros tres bugs iguales,
//    así que se la invirtió —los botones valen su etiqueta por default— y los
//    veinticuatro parches se sacaron. El del encabezado también, y medido: las cajas
//    dan idénticas con y sin él. Lo que fija esa parte de estos tests, entonces,
//    ya no es el blindaje sino el default; la regla nueva la fija
//    panel-botones-flex.test.js.
//
// Lo que estos tests NO hacen: medir cajas. El DOM de mentira del repo no tiene
// motor de layout —no reparte flex, no envuelve, no mide nada—, así que un test
// que dijera "no se solapa" acá estaría fingiendo. Lo que se fija es la regla de
// CSS donde vive el bug (igual que panel-cartel-preparar-motor.test.js) y el
// COMPORTAMIENTO del selector compartido, que sí es lógica de verdad. La
// medición se rehace con la maqueta.
//
// Lo medido después del arreglo, a los mismos anchos: desborde del documento y
// del encabezado en 0 px, cero pares de elementos superpuestos, la etiqueta de
// versión entera en sus 70 px siempre, y el encabezado en dos filas hasta ~660
// px y en una de ahí para arriba (75 px de alto contra los 74 de antes, con un
// control MÁS adentro).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const RAIZ = path.join(__dirname, '..');
const CEP = path.join(RAIZ, 'cep', 'js');
const CSS = fs.readFileSync(path.join(RAIZ, 'cep', 'css', 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(RAIZ, 'cep', 'index.html'), 'utf8');

// ── Leer el CSS de verdad ────────────────────────────────────────────
// Mismo lector que panel-cartel-preparar-motor.test.js: saca los comentarios y
// recorre contando llaves, así un @media no pasa por selector.

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
        // `dentroDeMedia` importa: la regla base y la de la media query tienen
        // el mismo selector, y mezclarlas leería la del panel mínimo como si
        // fuera la de todos los anchos.
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

function flexShrink(d) {
  if (d['flex-shrink'] !== undefined) return Number(d['flex-shrink']);
  if (d.flex === undefined) return undefined;
  if (d.flex === 'none') return 0;
  const p = String(d.flex).split(/\s+/);
  return p.length === 1 ? 1 : Number(p[1]); // `flex: 1` también deja encoger
}

function flexBasis(d) {
  if (d['flex-basis'] !== undefined) return d['flex-basis'];
  if (d.flex === undefined) return undefined;
  if (d.flex === 'none') return 'auto';
  const p = String(d.flex).split(/\s+/);
  if (p.length === 3) return p[2];
  return /^[\d.]+$/.test(p[0]) ? '0%' : p[0];
}

// ── 1. La invariante del encabezado, en el CSS ────────────────────────

test('el encabezado envuelve: sin eso no hay dónde poner lo que no cabe', function () {
  // Es la mitad de la invariante. Un encabezado que no envuelve solo puede
  // resolver la falta de ancho aplastando a alguien, y aplastar a alguien con
  // texto sin recortar es exactamente cómo se pinta encima del vecino.
  eq(declaraciones('.panel-header')['flex-wrap'], 'wrap');
});

test('la marca no se encoge, y su nombre recorta si alguna vez tuviera que', function () {
  // Acá vivía el bug de "HyperPremiere encima de motor OK": `.brand` tenía
  // `min-width: 0` y el nombre `white-space: nowrap` sin recorte.
  const b = declaraciones('.brand');
  eq(flexShrink(b), 0, 'con permiso para encogerse el nombre se pinta afuera de la caja');
  eq(flexBasis(b), 'auto', 'y su base es su propio ancho');
  eq(b['max-width'], '100%', 'el techo la ata a la fila incluso en el caso imposible');
  const n = declaraciones('.brand-name');
  eq(n.overflow, 'hidden', 'la red de último recurso: lo que se salga se recorta, no se pinta encima');
  eq(n['text-overflow'], 'ellipsis');
  eq(n['white-space'], 'nowrap', 'el nombre del producto no se parte en dos líneas');
});

test('el grupo de herramientas NO envuelve por dentro: ahí el ? caía sobre el ⟳', function () {
  // `.header-tools` envolvía, y al envolver por el MEDIO del grupo la segunda
  // línea arrancaba debajo de la marca: de ahí salían "marca × ⚙" a 320 y
  // "marca × ?" a 360 y 400. Ahora el grupo es indivisible y se va entero a la
  // fila de abajo (lo hace el encabezado, que sí envuelve).
  eq(declaraciones('.header-tools')['flex-wrap'], 'nowrap');
});

test('el encabezado ya no necesita blindar a sus botones: lo hace el default', function () {
  // Acá hubo un `.header-tools > * { flex: none }`, puesto el mismo día que el
  // micrófono, cuando la etiqueta de versión apareció en 19 px a 470 px. Era
  // uno de los veinticuatro parches contra el mismo `button { flex: 1;
  // min-width: 0 }` global, y se fue con él: ahora los botones valen su
  // etiqueta en todo el panel, no
  // solo acá. Vuelto a medir con `medir-encabezado.js` a 320, 360, 400, 470,
  // 600 y 900, con el menú del micrófono abierto y en `?e=sin-dictado`: las
  // cajas del encabezado dan idénticas a las de antes de sacarlo —desborde 0,
  // cero solapes, la etiqueta de versión entera, el mismo alto (75 px en dos
  // filas, 46 en una)—.
  eq(declaraciones('.header-tools > *').flex, undefined,
    'el blindaje del contenedor ya no hace falta, y dejarlo escondería de dónde viene el ancho');
  const g = declaraciones('button');
  eq(flexBasis(g), 'auto', 'el default de los botones es valer su etiqueta…');
  eq(g['min-width'], undefined, '…y conservar el piso automático de flex, que es lo que impide aplastarlos');
  const reparto = REGLAS.filter((r) => !r.dentroDeMedia && r.selector === 'button' && /flex:\s*1/.test(r.cuerpo));
  eq(reparto.length, 0, 'el reparto global —el que dejó la versión en 19 px— no está más');
});

test('el que crece en el encabezado es el grupo, no cada botón', function () {
  // Sin el `flex: none` del contenedor hay que decir explícitamente quién se
  // lleva el espacio libre, o el encabezado se lee distinto. Lo hace el grupo
  // entero, y adentro el micrófono.
  eq(flexGrow(declaraciones('.header-tools')), 1, 'el grupo toma el sobrante y lo empuja a la derecha');
  eq(flexGrow(declaraciones('.hdr-mic')), 1, 'y adentro del grupo, el micrófono es el que lo usa');
});

test('la insignia de estado es la que cede, y recorta al ceder', function () {
  // La otra mitad de la invariante: el que puede quedar más chico que su texto
  // tiene que recortarlo. La insignia ya recortaba; lo que se agregó es el
  // permiso para ceder, para que el que cede no termine siendo el vecino.
  const d = declaraciones('.hdr-chip');
  eq(flexShrink(d), 1);
  eq(d['min-width'], '0');
  eq(d.overflow, 'hidden');
  eq(d['text-overflow'], 'ellipsis');
});

test('el micrófono es el único del grupo con permiso para ceder, y tiene piso', function () {
  const d = declaraciones('.hdr-mic');
  eq(flexShrink(d), 1, 'es el que absorbe la falta de ancho del grupo');
  eq(flexBasis(d), '34px', 'la base es el ícono solo: así el largo del nombre del dispositivo ' +
    'NO decide a qué ancho envuelve el encabezado (con base auto, enchufar algo de nombre largo lo movía)');
  eq(d['min-width'], '34px', 'y no puede quedar más chico que su ícono');
  ok(/^\d+px$/.test(d['max-width']), 'con techo, para no dejar una caja vacía enorme en un panel ancho: ' + d['max-width']);
  const label = declaraciones('.hdr-mic .hps-label');
  eq(label['min-width'], '0', 'el nombre cede antes que la caja');
});

test('el menú del micrófono se cuelga del encabezado, no del botón de 34 px', function () {
  // En el resto del panel el menú va EN FLUJO y empuja lo de abajo (así lo dice
  // su comentario). En el encabezado no puede: empujaría la barra de acciones.
  // Y anclado al botón mediría 34 px, que no sirve para leer un nombre de
  // dispositivo. Se cuelga del encabezado y toma el ancho del panel.
  const menu = declaraciones('.hdr-mic .hps-menu');
  eq(menu.position, 'absolute');
  eq(menu.top, '100%', 'justo debajo del encabezado');
  ok(menu.left && menu.right, 'atado a los dos bordes: es el ancho del panel, no el del botón');
  eq(declaraciones('.panel-header').position, 'relative', 'el encabezado es el contenedor del menú');
  eq(declaraciones('.hdr-mic').position, 'static', 'el desplegable NO puede ser el contenedor, o el menú mediría 34 px');
});

test('en el panel mínimo el micrófono queda en ícono, y eso está dicho en una media query', function () {
  // A 320 px la fila de herramientas le deja 99 px al desplegable: descontando
  // ícono, flecha y padding quedan ~51 px de nombre, o sea media palabra. Es
  // mejor el ícono con el nombre en el tooltip que "MacBoo…".
  const limpio = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const bloques = limpio.match(/@media[^{]*\{[\s\S]*?\n\}/g) || [];
  const elDelMic = bloques.filter((b) => /\.hdr-mic/.test(b))[0];
  ok(elDelMic, 'tiene que haber una media query que compacte el micrófono');
  const tope = /max-width:\s*(\d+)px/.exec(elDelMic);
  ok(tope && Number(tope[1]) >= 320 && Number(tope[1]) <= 480,
    'el corte tiene que caer entre el ancho mínimo del panel y el de arranque: ' + (tope && tope[1]));
  has(elDelMic, '.hdr-mic .hps-label', 'lo que se esconde es la etiqueta, no el control');
  has(elDelMic, 'display: none');
});

// ── 2. La estructura del HTML que esas reglas necesitan ───────────────

test('la insignia es HERMANA del grupo de herramientas, no hija', function () {
  // Es el cambio de estructura del arreglo: adentro de `.header-tools` la
  // insignia era el primero de un grupo que envolvía por el medio. Afuera, se
  // queda arriba con la marca y las herramientas bajan enteras.
  const head = /<header class="panel-header">([\s\S]*?)<\/header>/.exec(HTML);
  ok(head, 'el encabezado tiene que existir');
  const iChip = head[1].indexOf('id="hdr-status"');
  const iTools = head[1].indexOf('class="header-tools"');
  ok(iChip !== -1, 'la insignia tiene que estar en el encabezado');
  ok(iTools !== -1, 'y el grupo de herramientas también');
  ok(iChip < iTools, 'la insignia va ANTES de que abra el grupo, o sea afuera de él');
});

test('el micrófono es hijo directo del grupo y arranca escondido', function () {
  // `.header-tools > *` es un selector de hijo directo: envolver el micrófono
  // en otro div lo dejaría sin blindaje y el desborde volvería sin que nadie
  // toque el CSS. Y arranca escondido porque en una máquina sin dictado no se
  // dibuja nunca.
  const head = /<header class="panel-header">([\s\S]*?)<\/header>/.exec(HTML)[1];
  const grupo = head.slice(head.indexOf('class="header-tools"'));
  // Entre que abre el grupo y el primer botón no puede haber ningún <div> que
  // no sea el del micrófono: cualquier envoltorio lo deja fuera del alcance de
  // `.header-tools > *` y el desborde vuelve sin que nadie toque el CSS.
  const mic = /<div id="hdr-mic"([^>]*)>\s*<\/div>/.exec(grupo.slice(0, grupo.indexOf('<button')));
  ok(mic, 'el punto de montaje del micrófono va como hijo directo del grupo, sin envoltorio');
  has(mic[1], 'data-hidden="true"', 'escondido hasta que se sepa que hay de qué elegir');
  has(mic[1], 'class="hdr-mic"');
});

test('mic-select.js se carga antes de config-ui.js, que es quien lo monta', function () {
  const orden = (HTML.match(/<script src="js\/([^"]+)"/g) || []).map((s) => /js\/([^"]+)/.exec(s)[1]);
  const iSel = orden.indexOf('mic-select.js');
  ok(iSel !== -1, 'el módulo del selector tiene que estar en el orden de carga');
  ok(iSel < orden.indexOf('config-ui.js'), 'antes de ⚙, que monta su vista');
  ok(iSel < orden.indexOf('main.js'), 'y antes del orquestador, que monta la del encabezado');
});

// ── 3. El selector compartido: un estado, dos vistas ─────────────────
//
// Acá sí se prueba comportamiento de verdad. Lo que importa es que NO haya dos
// implementaciones: elegir arriba tiene que cambiar lo que muestra ⚙ sin que
// nadie recargue nada, y las dos vistas tienen que preguntarle a ffmpeg UNA vez.

function elemento(tag) {
  const el = {
    tagName: tag, children: [], listeners: {}, style: {}, className: '',
    textContent: '', value: '', title: '', disabled: false, atributos: {},
    appendChild: function (h) { this.children.push(h); h.parentNode = this; return h; },
    setAttribute: function (k, v) { this.atributos[k] = v; if (k === 'title') this.title = v; },
    getAttribute: function (k) { return this.atributos[k] === undefined ? null : this.atributos[k]; },
    removeAttribute: function (k) { delete this.atributos[k]; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    click: function () { (this.listeners.click || []).forEach((f) => f({ stopPropagation() {}, preventDefault() {} })); },
    focus: function () {},
  };
  el.classList = { add(c) { el.className = (el.className ? el.className + ' ' : '') + c; }, remove() {} };
  Object.defineProperty(el, 'innerHTML', { get: () => '', set: () => { el.children.length = 0; } });
  return el;
}

const LISTA = [
  { indice: 0, nombre: 'iPhone de Daniel Microphone', porDefecto: false },
  { indice: 1, nombre: 'OBSBOT Meet 2 Microphone', porDefecto: false },
  { indice: 2, nombre: 'MacBook Pro Microphone', porDefecto: true },
];

function respuestaDeLista(elegido, dispositivos) {
  const lista = dispositivos || LISTA;
  const hay = lista.filter((d) => d.nombre === elegido)[0];
  let usa;
  if (hay) {
    usa = { entrada: ':' + hay.indice, indice: hay.indice, nombre: hay.nombre, elegido, origen: 'elegido', aviso: '' };
  } else if (elegido) {
    usa = {
      entrada: ':default', indice: 2, nombre: 'MacBook Pro Microphone', elegido, origen: 'caida',
      aviso: 'El micrófono elegido, «' + elegido + '», no está conectado ahora. Uso el que macOS tiene por defecto: «MacBook Pro Microphone» (índice 2).',
    };
  } else {
    usa = {
      entrada: ':default', indice: 2, nombre: 'MacBook Pro Microphone', elegido: '', origen: 'default',
      aviso: 'Todavía no elegiste micrófono: uso el que macOS tiene como entrada por defecto, «MacBook Pro Microphone» (índice 2). Se elige en ⚙ → Micrófono.',
    };
  }
  return { ok: true, dispositivos: lista, porDefecto: 'MacBook Pro Microphone', elegido, usa };
}

/**
 * Levanta mic-select.js con las DOS vistas montadas, como en el panel de
 * verdad: la del encabezado y la de ⚙.
 */
function armar(opts) {
  opts = opts || {};
  const nodos = {};
  const selects = [];
  const guardados = [];
  const llamadas = [];
  const log = [];
  let elegido = opts.elegido || '';
  const ctx = {
    console, setTimeout, clearTimeout, Promise, JSON, Math, Object, String, Number, Array, Boolean,
    HPLog: { log: function (m, n) { log.push((n || 'INFO') + ' ' + m); } },
    HPWidgets: {
      select: function (el) {
        const s = {
          nodo: el, value: '', onChange: null, opciones: [],
          setOptions: function (o, val) { this.opciones = o.slice(); this.value = val != null ? String(val) : ''; },
          elegir: function (v) { const c = v !== this.value; this.value = v; if (c && this.onChange) this.onChange(v); },
          /** Lo que muestra el botón CERRADO (el `corto` si lo hay). */
          etiquetaCerrada: function () {
            const o = this.opciones.filter((x) => String(x.value) === String(this.value))[0];
            return o ? (o.corto || o.label) : '';
          },
          /** Lo que muestra el menú DESPLEGADO. */
          etiquetasDelMenu: function () { return this.opciones.map((o) => o.label); },
        };
        selects.push(s);
        return s;
      },
    },
    HPEngine: {
      call: function (metodo, body) {
        llamadas.push(metodo);
        if (metodo === 'setConfig') {
          guardados.push(body || {});
          if (body && body.microfono !== undefined) elegido = body.microfono;
          return Promise.resolve({});
        }
        if (metodo === 'microfonoListar') {
          return Promise.resolve(opts.lista ? opts.lista(elegido) : respuestaDeLista(elegido, opts.dispositivos));
        }
        if (metodo === 'dictadoEstado') {
          if (opts.sinDictado) return Promise.resolve({ ok: true, disponible: false, motivo: 'El dictado por voz todavía es solo para Mac.' });
          if (opts.dictadoRoto) return Promise.reject(new Error('el motor no contestó'));
          if (opts.dictadoMudo) return Promise.resolve(null); // contesta, pero no dice nada
          return Promise.resolve({ ok: true, disponible: true, motivo: '', enCurso: opts.enCurso || '' });
        }
        return Promise.resolve(null);
      },
    },
    HPDictado: { olvidarEstado: function () { llamadas.push('HPDictado.olvidarEstado'); } },
    document: {
      createElement: elemento,
      getElementById: function (id) { if (!nodos[id]) { nodos[id] = elemento('div'); nodos[id].id = id; } return nodos[id]; },
    },
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  ['util.js', 'mic-select.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  });
  const M = ctx.HPMicSelect;
  // El orden del panel: primero el encabezado (main.js), después ⚙, y el
  // listado lo pide ⚙ una vez.
  const enc = M.montarEncabezado(ctx.document.getElementById('hdr-mic'));
  const cfg = M.montar(ctx.document.getElementById('cfg-mic'), {
    status: ctx.document.getElementById('mic-status'),
    refresh: ctx.document.getElementById('btn-mic-refresh'),
  });
  M.refrescar('al abrir el panel');
  return {
    M, ctx, nodos, guardados, llamadas, log,
    encabezado: enc, config: cfg,
    selEnc: function () { return selects[0]; },
    selCfg: function () { return selects[1]; },
    micNodo: function () { return nodos['hdr-mic']; },
    estado: function () { return nodos['mic-status']; },
    visible: function () { return nodos['hdr-mic'].getAttribute('data-hidden') === 'false'; },
  };
}

function asentar(ms) { return new Promise((r) => setTimeout(r, ms || 20)); }

test('una sola implementación: elegir en el encabezado cambia lo que muestra ⚙', function () {
  return armarYCorrer(async function (p) {
    await asentar();
    p.selEnc().elegir('OBSBOT Meet 2 Microphone');
    await asentar();
    eq(p.selCfg().value, 'OBSBOT Meet 2 Microphone', 'la vista de ⚙ se enteró sin que nadie la recargue');
    has(p.estado().textContent, 'Elegido: «OBSBOT Meet 2 Microphone»', 'y su línea de estado también');
    eq(p.selEnc().value, 'OBSBOT Meet 2 Microphone');
  });
});

test('y al revés: elegir en ⚙ cambia lo que muestra el encabezado', function () {
  return armarYCorrer(async function (p) {
    await asentar();
    p.selCfg().elegir('iPhone de Daniel Microphone');
    await asentar();
    eq(p.selEnc().value, 'iPhone de Daniel Microphone');
    has(p.micNodo().getAttribute('title'), 'iPhone de Daniel Microphone', 'el tooltip de arriba también');
  });
});

test('las dos vistas le preguntan a ffmpeg UNA vez al abrir el panel', function () {
  // Listar corre ffmpeg. Dos vistas montándose harían dos corridas por cada
  // apertura del panel, y una de ellas no le sirve a nadie.
  return armarYCorrer(async function (p) {
    await asentar();
    eq(p.llamadas.filter((l) => l === 'microfonoListar').length, 1, p.llamadas.join(' · '));
  });
});

test('dos pedidos de listado a la vez son UNA corrida de ffmpeg', function () {
  // Es la carrera real: el encabezado y ⚙ se montan uno atrás del otro y los
  // dos quieren la lista antes de que vuelva la primera respuesta. Sin el
  // reparto de la consulta en vuelo, abrir el panel corre ffmpeg dos veces.
  return armarYCorrer(async function (p) {
    await asentar();
    const antes = p.llamadas.filter((l) => l === 'microfonoListar').length;
    const a = p.M.refrescar('uno');
    const b = p.M.refrescar('dos');
    eq(a, b, 'la segunda tiene que devolver la MISMA promesa, no arrancar otra');
    await Promise.all([a, b]);
    eq(p.llamadas.filter((l) => l === 'microfonoListar').length, antes + 1,
      'una sola corrida para los dos pedidos: ' + p.llamadas.join(' · '));
  });
});

test('la elección se guarda por NOMBRE, venga de arriba o de ⚙', function () {
  return armarYCorrer(async function (p) {
    await asentar();
    p.selEnc().elegir('OBSBOT Meet 2 Microphone');
    await asentar();
    const g = p.guardados.filter((x) => x.microfono !== undefined);
    eq(g.length, 1);
    eq(g[0].microfono, 'OBSBOT Meet 2 Microphone', 'el nombre, no "1": los índices de avfoundation cambian al enchufar algo');
    ok(p.llamadas.indexOf('HPDictado.olvidarEstado') !== -1, 'y los botones 🎙 se enteran');
  });
});

test('el botón cerrado de arriba muestra el nombre corto; el menú, el completo', function () {
  // Arriba hay 34 px en un panel mínimo y "MacBook Pro Microphone" no entra.
  // Desplegado sobra ancho, y ahí el nombre entero es la información.
  return armarYCorrer(async function (p) {
    await asentar();
    p.selEnc().elegir('MacBook Pro Microphone');
    await asentar();
    eq(p.selEnc().etiquetaCerrada(), 'MacBook Pro', 'sin el "Microphone" que repiten todos los dispositivos de macOS');
    ok(p.selEnc().etiquetasDelMenu().some((e) => e.indexOf('MacBook Pro Microphone') === 0),
      'pero el menú lista el nombre entero: ' + p.selEnc().etiquetasDelMenu().join(' | '));
    eq(p.selCfg().etiquetaCerrada(), 'MacBook Pro Microphone · por defecto del sistema',
      'y en ⚙, donde la fila es ancha, el botón cerrado también muestra el entero');
  });
});

test('el tooltip de arriba dice el nombre completo y de dónde salió', function () {
  // Es lo que reemplaza a la línea de estado de ⚙: arriba no hay lugar para
  // una frase, así que va en el tooltip. Sin eso, el ícono no diría nada.
  return armarYCorrer(async function (p) {
    await asentar();
    has(p.micNodo().getAttribute('title'), 'MacBook Pro Microphone');
    has(p.micNodo().getAttribute('title'), 'por defecto', 'y que es el del sistema porque nadie eligió');
    p.selEnc().elegir('OBSBOT Meet 2 Microphone');
    await asentar();
    has(p.micNodo().getAttribute('title'), '«OBSBOT Meet 2 Microphone»');
    has(p.micNodo().getAttribute('title'), 'elegido');
  });
});

test('el elegido que no está enchufado se ve en ámbar arriba y dicho en ⚙', function () {
  return armarYCorrer(async function (p) {
    await asentar();
    has(p.micNodo().className, 'is-warn', 'arriba, en ámbar: no es un error, pero hay que verlo');
    has(p.micNodo().getAttribute('title'), 'Auriculares de Daniel (2)');
    has(p.micNodo().getAttribute('title'), 'MacBook Pro Microphone', 'con cuál se usa en su lugar');
    // El "(2)" del final sobrevive al recorte, y no es un detalle: es lo que
    // distingue este par de auriculares del otro. Recortando por el final, los
    // dos se verían "Auriculares de Danie…".
    eq(p.selEnc().etiquetaCerrada(), '⚠ Auriculare… Daniel (2)', 'y el botón cerrado lo marca');
    has(p.estado().className, 'is-warn');
  }, { elegido: 'Auriculares de Daniel (2)' });
});

// ── 4. Cuando el dictado no está ─────────────────────────────────────

test('sin dictado en esta máquina, el encabezado NO dibuja el desplegable', function () {
  // Windows, sin ffmpeg o sin el Whisper de Apple Silicon. Un desplegable para
  // elegir el micrófono de una función que no corre es un control que el editor
  // toca y no hace nada. El porqué lo sigue diciendo ⚙ y el 🎙 de cada campo.
  return armarYCorrer(async function (p) {
    await asentar();
    ok(!p.visible(), 'el punto de montaje queda escondido');
    ok(p.log.some((l) => /no se muestra porque en esta máquina no se puede dictar/.test(l)),
      'y queda dicho en el ⬇ Log, que es lo único que llega de otra máquina');
    eq(p.selCfg().opciones.length, 4, 'pero la fila de ⚙ se arma igual: ahí es donde se diagnostica');
  }, { sinDictado: true });
});

test('si no se sabe si se puede dictar, el desplegable se muestra igual', function () {
  // No saber no es "no hay". Si el motor no contesta esa pregunta, manda lo
  // otro: si se pudieron listar los dispositivos, hay de qué elegir. Se esconde
  // solo cuando el motor DICE que no, y son dos casos distintos: que la llamada
  // se caiga, y que conteste algo que no trae el dato.
  return armarYCorrer(async function (p) {
    await asentar();
    ok(p.visible(), 'la llamada se cayó: se muestra igual');
  }, { dictadoRoto: true });
});

test('un motor que contesta sin decir si se puede dictar tampoco esconde nada', function () {
  return armarYCorrer(async function (p) {
    await asentar();
    ok(p.visible(), 'contestó, pero sin el dato: eso no es "no se puede"');
  }, { dictadoMudo: true });
});

test('sin dispositivos, el encabezado tampoco dibuja nada', function () {
  return armarYCorrer(async function (p) {
    await asentar();
    ok(!p.visible(), 'un desplegable vacío arriba es peor que ninguno');
  }, { dispositivos: [] });
});

test('si no se pudo listar, arriba no hay desplegable y ⚙ dice por qué', function () {
  return armarYCorrer(async function (p) {
    await asentar();
    ok(!p.visible(), 'un desplegable en error arriba no sirve para nada');
    has(p.estado().textContent, 'No pude listar los micrófonos');
    has(p.estado().className, 'is-error');
    ok(p.log.some((l) => /^ERROR .*No pude correr ffmpeg/.test(l)));
  }, { lista: () => ({ ok: false, error: 'No pude correr ffmpeg para listar los micrófonos.', crudo: 'spawn ffmpeg ENOENT' }) });
});

// ── 5. Cambiar de micrófono con un dictado andando ───────────────────

test('con un dictado en curso se guarda igual, y se dice que vale desde el próximo', function () {
  // El motor resolvió nombre → índice al abrir el micrófono y su ffmpeg ya está
  // corriendo con ese dispositivo: cambiar acá en el medio no lo rompe ni lo
  // cambia. Lo que no se puede es dejar creer que el cambio fue en vivo.
  return armarYCorrer(async function (p) {
    await asentar();
    p.selCfg().elegir('OBSBOT Meet 2 Microphone');
    await asentar(40);
    eq(p.guardados.filter((x) => x.microfono !== undefined)[0].microfono, 'OBSBOT Meet 2 Microphone', 'se guarda');
    has(p.estado().textContent, 'sigue con el micrófono que abrió');
    has(p.estado().textContent, 'próximo');
    has(p.estado().className, 'is-warn');
    ok(p.log.some((l) => /^WARN Micrófono: cambiado con un dictado en curso/.test(l)));
  }, { enCurso: 'marcador:Marcador 3' });
});

test('sin dictado andando no se agrega ninguna advertencia', function () {
  return armarYCorrer(async function (p) {
    await asentar();
    p.selCfg().elegir('OBSBOT Meet 2 Microphone');
    await asentar(40);
    eq(p.estado().textContent.indexOf('próximo'), -1, 'la línea queda limpia: ' + p.estado().textContent);
    eq(p.estado().className, 'muted');
  });
});

// ── 6. El nombre corto de la barra angosta ───────────────────────────

test('el nombre corto saca el sufijo que repiten todos los dispositivos', function () {
  return armarYCorrer(async function (p) {
    const c = p.M._nombreCorto;
    eq(c('MacBook Pro Microphone'), 'MacBook Pro');
    eq(c('OBSBOT Meet 2 Microphone'), 'OBSBOT Meet 2');
    eq(c('Micrófono del iMac'), 'Micrófono del iMac', 'el sufijo se saca del FINAL, no de donde aparezca');
  });
});

test('un dispositivo llamado "Microphone" a secas no queda sin nombre', function () {
  return armarYCorrer(async function (p) {
    eq(p.M._nombreCorto('Microphone'), 'Microphone', 'mejor un nombre redundante que una etiqueta vacía');
    eq(p.M._nombreCorto('Mic'), 'Mic');
    eq(p.M._nombreCorto(''), '');
    eq(p.M._nombreCorto(null), '');
  });
});

test('un nombre larguísimo se acorta por el MEDIO, con el helper del repo', function () {
  // Los dispositivos virtuales (Steam, Zoom, OBS) traen nombres larguísimos, y
  // el largo del nombre no puede inflar el ancho que el desplegable le pide a
  // la fila. Se acorta por el medio (HPUtil.shortenMiddle) y no por el final:
  // dos dispositivos de la misma marca se diferencian en el sufijo.
  return armarYCorrer(async function (p) {
    const c = p.M._nombreCorto('Steam Streaming Speakers Virtual Device 2 Microphone');
    ok(c.length <= 22, 'con techo: ' + c + ' (' + c.length + ')');
    has(c, '…');
    ok(c.indexOf('Steam') === 0, 'el principio se conserva');
    ok(/2$/.test(c), 'y el final también, que es lo que diferencia dos del mismo fabricante: ' + c);
  });
});

/**
 * El harness corre las funciones de test y espera la promesa; `armar` monta las
 * dos vistas, así que cada test arranca con su propio contexto (el módulo tiene
 * estado de módulo, y compartirlo entre tests los volvería dependientes del
 * orden).
 */
function armarYCorrer(fn, opts) {
  return fn(armar(opts));
}
