'use strict';

// EL CAMPO CON CHIPS: `@Imagen_1` a la vista, `@[curso/manual.png]` guardado.
//
// Lo que pidió el editor: *"me gustaría que en vez de decir '@' y la ruta, fuera
// '@Imagen_1, @Imagen_2', algo más simple. Si hago hover, debería mostrarme un
// pequeño preview […]. Si selecciono la palabra, debo poder borrarla completa,
// pero si doy doble clic debo poder modificar cómo está escrita, así puedo
// cambiar Imagen_1 por Imagen_2."*
//
// Y la disyuntiva que eligió sabiendo el costo: el número es CAPA DE PRESENTACIÓN.
// Lo guardado sigue siendo el nombre del archivo, porque es lo único que sobrevive
// a que la lista se reordene (la cabecera de `bridge/prompt/menciones.js` lo explica
// entero). De ahí sale todo lo que este archivo fija, y son dos familias:
//
//   1. QUE NADA DE LO QUE SE GUARDA CAMBIÓ. `value` tiene que devolver exactamente
//      el mismo string que devolvía el `<textarea>`, o el texto en disco, el payload
//      del job, el `queue.json`, los `.meta.json`, el `localStorage` y el prompt
//      empiezan a decir otra cosa. La evidencia de punta a punta es
//      `node test/manual/menciones-al-modelo.js`; acá se fija el eslabón del campo.
//   2. QUE EL NÚMERO QUE SE MUESTRA SEA EL DEL MOTOR. Un chip que dice «Imagen_2»
//      sobre lo que va a llegar como «imagen 3» es PEOR que el token largo, porque
//      el token largo no miente. Las dos cuentas se corren sobre el mismo material.
//
// Y en el medio, la fachada: el campo dejó de ser un `<textarea>` y seis cosas le
// siguen hablando en `value` / `selectionStart` / `setSelectionRange` / `input` (el
// dictado, el ✨, `HPMenciones.insertar`, el control de alto, el guardado de cada
// pestaña y el aviso). La traducción de offsets es la parte delicada, así que se
// prueba en los DOS sentidos y con el chip como unidad atómica.
//
// Lo que este archivo NO puede hacer es medir el navegador: el DOM de mentira no
// tiene layout ni la edición nativa de un `contenteditable`. Que el preview aparezca
// donde va, que Chromium se lleve el chip entero y que nada desborde a 320 px se mide
// con `node test/manual/panel-demo/medir-chips.js`.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, deepEq, has } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');
const motor = require('../bridge/prompt/menciones');

// ── Un DOM de mentira con SELECCIÓN ──────────────────────────────────
//
// Los otros dobles del repo no la tienen porque ninguna otra vista la necesita.
// Acá es el punto: la fachada traduce entre offsets del texto canónico y posiciones
// del DOM, y sin selección sólo se podría probar la mitad de cada traducción.

function armarDom() {
  const sel = { anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0 };

  function comun(tag) {
    const n = {
      tagName: tag,
      childNodes: [],
      parentNode: null,
      style: {},
      className: '',
      listeners: {},
      appendChild: function (h) { this.childNodes.push(h); h.parentNode = this; return h; },
      removeChild: function (h) {
        const i = this.childNodes.indexOf(h);
        if (i !== -1) this.childNodes.splice(i, 1);
        h.parentNode = null;
        return h;
      },
      replaceChild: function (nuevo, viejo) {
        const i = this.childNodes.indexOf(viejo);
        if (i !== -1) this.childNodes[i] = nuevo;
        nuevo.parentNode = this;
        viejo.parentNode = null;
        return viejo;
      },
      setAttribute: function (k, v) { this['attr:' + k] = String(v); },
      getAttribute: function (k) { return this['attr:' + k] === undefined ? null : this['attr:' + k]; },
      removeAttribute: function (k) { delete this['attr:' + k]; },
      /** Sólo por clase, que es lo único que el campo le pide al DOM. */
      querySelectorAll: function (sel) {
        const clase = String(sel).replace(/^\./, '');
        const out = [];
        (function bajar(n) {
          (n.childNodes || []).forEach(function (h) {
            if (String(h.className || '').split(' ').indexOf(clase) !== -1) out.push(h);
            bajar(h);
          });
        })(this);
        return out;
      },
      addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
      dispatchEvent: function (e) { (this.listeners[e.type] || []).forEach((f) => f(e)); return true; },
      /** Como si el editor hubiera hecho algo: dispara los oyentes de ese evento. */
      disparar: function (ev, e) {
        const evento = Object.assign({ type: ev, preventDefault: function () {}, stopPropagation: function () {} }, e || {});
        if (!evento.target) evento.target = this;
        (this.listeners[ev] || []).forEach((f) => f(evento));
        return evento;
      },
      focus: function () { doc.activeElement = this; },
      // Lo que un `<input>` de verdad le da al chip en edición: su valor y su
      // `select()`. Se anota que se seleccionó porque eso es lo que el editor pidió
      // —«que abra completo como si fuera un campo de texto», con el número marcado
      // para que escribir lo reemplace— y es lo único de eso que se puede fijar sin
      // un navegador.
      value: '',
      select: function () { this._seleccionado = true; },
      /** Los chips del campo, en orden. */
      chips: function () { return this.childNodes.filter((h) => h._hpToken); },
    };
    n.classList = {
      add: function (c) {
        if (String(n.className).split(' ').indexOf(c) === -1) n.className = (n.className ? n.className + ' ' : '') + c;
      },
      remove: function (c) {
        n.className = String(n.className).split(' ').filter((x) => x && x !== c).join(' ');
      },
    };
    Object.defineProperty(n, 'innerHTML', {
      get: function () { return ''; },
      set: function () { n.childNodes.length = 0; },
      configurable: true,
    });
    // `textContent` como en el DOM de verdad y no como una propiedad suelta:
    // escribirlo BORRA los hijos, y leerlo junta el texto de los que hay. Los dos
    // lados importan acá. El primero, porque el chip en edición reemplaza su
    // etiqueta por un `<input>` y si el texto viejo se quedara, el test leería un
    // input que ya no está. El segundo, porque el `textContent` vacío de un chip con
    // un input adentro es justo lo que `normalizar` usa para decidir si un chip se
    // cayó del texto — con una propiedad suelta ese caso no se podía probar.
    if (tag !== undefined) {
      Object.defineProperty(n, 'textContent', {
        get: function () {
          return n.childNodes.map(function (h) { return h.textContent || ''; }).join('');
        },
        set: function (v) {
          n.childNodes.length = 0;
          if (String(v)) n.appendChild(doc.createTextNode(String(v)));
        },
        configurable: true,
      });
    } else {
      n.textContent = '';   // un nodo de texto: su dato, tal cual
    }
    return n;
  }

  const doc = {
    activeElement: null,
    createElement: comun,
    createTextNode: function (t) {
      // Sin `tagName`: es lo que distingue un nodo de texto de un elemento, en el
      // DOM de verdad y acá (ver `esTexto` en cep/js/campo.js).
      const n = comun(undefined);
      n.textContent = String(t);
      return n;
    },
    createRange: function () {
      return {
        setStart: function (n, o) { this.startNode = n; this.startOffset = o; },
        setEnd: function (n, o) { this.endNode = n; this.endOffset = o; },
        selectNodeContents: function (n) {
          this.startNode = n; this.startOffset = 0;
          this.endNode = n; this.endOffset = (n.childNodes || []).length;
        },
      };
    },
  };
  doc.body = comun('body');

  const ctx = {
    console: console, String: String, Number: Number, Object: Object, Array: Array,
    Math: Math, isNaN: isNaN, parseInt: parseInt, JSON: JSON,
    document: doc,
    innerWidth: 400,
    Event: function (tipo, o) { this.type = tipo; this.bubbles = !!(o && o.bubbles); },
    getSelection: function () {
      return {
        anchorNode: sel.anchorNode, anchorOffset: sel.anchorOffset,
        focusNode: sel.focusNode, focusOffset: sel.focusOffset,
        removeAllRanges: function () {},
        addRange: function (r) {
          sel.anchorNode = r.startNode; sel.anchorOffset = r.startOffset;
          sel.focusNode = r.endNode; sel.focusOffset = r.endOffset;
        },
      };
    },
    // El icono del preview de un documento.
    HPIconos: {
      el: function (nombre) { const s = comun('span'); s.className = 'hp-ico'; s._icono = nombre; return s; },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  ['menciones.js', 'campo.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  });
  /** Pone el cursor (o la selección) en una posición del DOM, como un clic. */
  ctx.cursorEn = function (nodo, off, nodo2, off2) {
    sel.anchorNode = nodo; sel.anchorOffset = off;
    sel.focusNode = nodo2 === undefined ? nodo : nodo2;
    sel.focusOffset = off2 === undefined ? off : off2;
  };
  ctx.doc = doc;
  return ctx;
}

/**
 * `HPMenciones` cargado SOLO, sin DOM: lo que decide cuándo se abre el menú del `@`
 * y qué ofrece son funciones puras, y probarlas sin montar nada es la mitad de por
 * qué viven ahí y no en el campo.
 */
const P = (function () {
  const ctx = { console: console, String: String, Number: Number, Object: Object, Array: Array, Math: Math, document: undefined };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(CEP, 'menciones.js'), 'utf8'), ctx, { filename: 'menciones.js' });
  return ctx.HPMenciones;
})();

// El inventario de un pedido real: dos imágenes del marcador, una del curso, un
// documento del curso, una de la clase que el disco no tiene y otra de la clase.
// Es el mismo orden en que le llegan al modelo (marcador → curso → clase).
const INV = [
  { scope: 'marker', nombre: 'boceto.png', falta: false, tipo: 'imagen', src: 'data:image/png;base64,AAA' },
  { scope: 'marker', nombre: 'captura.png', falta: false, tipo: 'imagen', src: 'data:image/png;base64,BBB' },
  { scope: 'course', nombre: 'manual-de-marca-nova.png', falta: false, tipo: 'imagen', src: 'file:///p/manual.png' },
  { scope: 'course', nombre: 'guia.pdf', falta: false, tipo: 'documento', src: '' },
  { scope: 'sequence', nombre: 'paleta.png', falta: true, tipo: 'imagen', src: '' },
  { scope: 'sequence', nombre: 'encuadre.png', falta: false, tipo: 'imagen', src: 'file:///p/encuadre.png' },
];

/** Un campo montado, con su inventario y lo que el campo le fue diciendo. */
function campo(inventario) {
  const ctx = armarDom();
  const dicho = [];
  const el = ctx.HPCampo.crear({
    clase: 'marker-instruction',
    placeholder: 'qué querés que haga',
    inventario: function () { return inventario || INV; },
    decir: function (r) { dicho.push(r); },
  });
  ctx.doc.body.appendChild(el);
  ctx.doc.activeElement = el;
  // Lo que escuchan los que ya escuchaban: el `input`.
  const inputs = [];
  el.addEventListener('input', function () { inputs.push(el.value); });
  return { ctx: ctx, el: el, dicho: dicho, inputs: inputs };
}

/**
 * Escribe `texto` en el campo como lo escribe una persona: el valor, el cursor al
 * final y el `input`, que es el orden del navegador. Es el camino por el que se abre
 * el menú del `@`.
 */
function tipear(c, texto) {
  c.el.value = texto;
  c.el.setSelectionRange(texto.length, texto.length);
  c.el.disparar('input');
}

/** El menú del `@`: en qué está y qué filas dibujó. */
function menu(c) {
  const m = c.ctx.HPCampo._menu();
  return {
    abierto: m.campo === c.el,
    consulta: m.consulta,
    sel: m.sel,
    etiquetas: m.filas.map(function (f) { return f.etiqueta + ' ' + f.nombre; }),
    rotulos: m.el ? m.el.querySelectorAll('.hp-arroba-rotulo').map(function (r) { return r.textContent; }) : [],
    filas: m.el ? m.el.querySelectorAll('.hp-arroba-op') : [],
    vacio: m.el ? m.el.querySelectorAll('.hp-arroba-vacio')[0] : null,
    escondido: m.el ? m.el.getAttribute('data-hidden') : null,
  };
}

// ── 1. `value`: el texto canónico, y EXACTAMENTE el de antes ─────────

// Lo normal, lo raro y lo roto. Es el mismo corpus que usa `menciones-panel` para
// que las dos gramáticas no se separen, más los casos que sólo le importan al campo
// (saltos, espacios dobles, chips pegados).
const CORPUS = [
  '',
  'sin ninguna mención',
  'poné @[curso/manual-de-marca-nova.png] arriba',
  '@[marcador/Captura de pantalla 2026-09-15 a la(s) 11.04.32.png] es la buena',
  'dos: @[marcador/boceto.png] y @[curso/guia.pdf]',
  'sin ámbito: @[suelta.png]',
  'ámbito inventado: @[proyecto/x.png]',
  'pegada al texto:@[curso/a.png]y sigue',
  'un corchete suelto @[ sin cerrar',
  'vacía @[] y nada',
  'MAYÚSCULAS @[CURSO/A.PNG]',
  'como en la imagen 2, en texto plano',
  'tres seguidas @[curso/a.png]@[clase/b.png]@[marcador/c.png]',
  'anidada @[curso/[a].png]',
  'con < y > y & adentro',
  'un salto\ny otro\n\n y espacios   dobles',
  '@[ curso/con espacios alrededor ]',
  '@[marcador/boceto.png]',
  'termina en mención @[curso/guia.pdf]',
];

test('`value` devuelve EXACTAMENTE el string que se le puso', function () {
  // Es la condición de la que dependen los seis lugares por donde viaja una
  // instrucción. Si el campo devolviera un carácter distinto —el token
  // reconstruido sin sus espacios, un salto de más al final— el texto en disco
  // dejaría de ser el que el editor escribió y nada fallaría.
  const c = campo();
  CORPUS.forEach(function (t) {
    c.el.value = t;
    eq(c.el.value, t, JSON.stringify(t));
  });
});

test('el token se guarda TAL CUAL vino, sin reconstruirlo', function () {
  // `partir` recorta espacios, así que un token reconstruido a partir de lo
  // parseado mediría menos caracteres que el que está en el campo — y con él se
  // correrían todos los offsets del cursor.
  const c = campo();
  c.el.value = 'mirá @[ curso/con espacios alrededor ] y listo';
  eq(c.el.chips().length, 1);
  eq(c.el.chips()[0]._hpToken, '@[ curso/con espacios alrededor ]');
  eq(c.el.value, 'mirá @[ curso/con espacios alrededor ] y listo');
});

test('un `@[]` sin nombre no es una mención: queda como texto', function () {
  // Es lo mismo que decide el motor, y por eso está fijado: si el campo lo tomara
  // por mención, `value` devolvería un chip donde el motor no ve nada.
  const c = campo();
  c.el.value = 'vacía @[] y nada';
  eq(c.el.chips().length, 0);
  eq(c.el.value, 'vacía @[] y nada');
});

test('el campo vacío devuelve "" y muestra el placeholder', function () {
  const c = campo();
  c.el.value = '';
  eq(c.el.value, '');
  eq(c.el.getAttribute('data-vacio'), 'true', 'el placeholder se prende con esto y no con `:empty`');
  c.el.value = 'algo';
  eq(c.el.getAttribute('data-vacio'), 'false');
});

// ── 2. Los CHIPS: qué se ve ──────────────────────────────────────────

test('cada mención es un chip atómico para el navegador', function () {
  const c = campo();
  c.el.value = 'copiá @[marcador/boceto.png] y @[curso/guia.pdf]';
  const chips = c.el.chips();
  eq(chips.length, 2);
  chips.forEach(function (ch) {
    eq(ch.getAttribute('contenteditable'), 'false',
      'es lo que hace que el cursor no entre y que Backspace se lo lleve entero');
  });
});

test('el chip muestra el número y guarda el nombre', function () {
  // La disyuntiva entera, en un test.
  const c = campo();
  c.el.value = 'la tipografía de @[curso/manual-de-marca-nova.png]';
  eq(c.el.chips()[0].textContent, '@Imagen_3', 'a la vista, el número');
  eq(c.el.value, 'la tipografía de @[curso/manual-de-marca-nova.png]', 'guardado, el nombre');
});

test('un documento se muestra como documento', function () {
  const c = campo();
  c.el.value = 'mirá @[curso/guia.pdf]';
  eq(c.el.chips()[0].textContent, '@Documento_1');
  eq(c.el.chips()[0].getAttribute('data-tipo'), 'documento');
});

test('el tooltip dice el token entero: es donde la mención se sigue LEYENDO', function () {
  // El argumento original para guardar el nombre y no un identificador opaco era
  // que la mención se lee. Con el chip mostrando un número, el lugar donde se sigue
  // leyendo qué archivo es exactamente es el tooltip.
  const c = campo();
  c.el.value = '@[curso/manual-de-marca-nova.png] y @[curso/guia.pdf]';
  has(c.el.chips()[0].title, '@[curso/manual-de-marca-nova.png]');
  has(c.el.chips()[0].title, 'imagen 3', 'y con qué número le va a llegar al modelo');
  has(c.el.chips()[1].title, 'el documento «guia.pdf»',
    'y un documento con su nombre, que es exactamente como lo nombra el prompt');
  has(c.el.chips()[1].title, 'los documentos no se numeran');
});

test('los tres estados rotos se ven EN el chip', function () {
  const c = campo();
  c.el.value = '@[curso/no-existe.png] · @[clase/paleta.png]';
  const chips = c.el.chips();
  has(chips[0].className, 'is-colgada');
  eq(chips[0].textContent, '@no-existe.svg'.replace('no-existe.svg', 'no-existe.png'),
    'sin número no hay número: se muestra el nombre, que es lo que deja arreglarlo');
  has(chips[1].className, 'is-sin-disco');
  eq(chips[1].textContent, '@paleta.png');
});

// ── 3. La traducción de offsets, en los DOS sentidos ─────────────────

test('del DOM al texto canónico: el cursor en un nodo de texto', function () {
  const c = campo();
  c.el.value = 'poné @[marcador/boceto.png] arriba';
  const [texto1, chip, texto2] = c.el.childNodes;
  eq(texto1.textContent, 'poné ');
  ok(chip._hpToken, 'el chip en el medio');
  c.ctx.cursorEn(texto1, 3);
  eq(c.el.selectionStart, 3);
  c.ctx.cursorEn(texto2, 4);
  eq(c.el.selectionStart, 'poné @[marcador/boceto.png]'.length + 4,
    'el chip aporta los caracteres de su TOKEN, no los de su etiqueta');
});

test('del texto canónico al DOM, y vuelta: los dos sentidos cierran', function () {
  const c = campo();
  const t = 'poné @[marcador/boceto.png] y @[curso/guia.pdf] al final';
  c.el.value = t;
  // Todos los offsets del texto: el de ida y el de vuelta tienen que coincidir,
  // salvo adentro de un token, donde el chip es atómico y el cursor se acerca al
  // borde (eso se fija en el test que sigue).
  const dentroDeToken = [];
  c.ctx.HPMenciones.encontrar(t).forEach(function (m) {
    for (let i = m.desde + 1; i < m.desde + m.raw.length; i++) dentroDeToken.push(i);
  });
  for (let o = 0; o <= t.length; o++) {
    if (dentroDeToken.indexOf(o) !== -1) continue;
    c.el.setSelectionRange(o, o);
    eq(c.el.selectionStart, o, 'offset ' + o);
  }
});

test('el chip es ATÓMICO: el cursor sólo cae antes o después', function () {
  const c = campo();
  const t = 'poné @[marcador/boceto.png] arriba';
  const desde = 5;
  const hasta = 5 + '@[marcador/boceto.png]'.length;
  c.el.value = t;
  // Un offset que cae en el medio del token —lo pide `insertar` cuando el cursor
  // anotado quedó viejo, y lo pide el dictado— se acerca al borde más cercano en
  // vez de partir la mención: el cursor tiene que quedar en algún lado, y la mitad
  // de un token no es un lado.
  c.el.setSelectionRange(desde + 2, desde + 2);
  eq(c.el.selectionStart, desde, 'cerca del principio, antes del chip');
  c.el.setSelectionRange(hasta - 2, hasta - 2);
  eq(c.el.selectionStart, hasta, 'cerca del final, después del chip');
});

test('la selección anclada en el campo mismo también tiene respuesta', function () {
  // Pasa con un clic en el aire de la última línea: el navegador ancla la selección
  // en el contenedor, con un índice de HIJO y no de carácter.
  const c = campo();
  c.el.value = '@[marcador/boceto.png] final';
  c.ctx.cursorEn(c.el, 0);
  eq(c.el.selectionStart, 0);
  c.ctx.cursorEn(c.el, 1);
  eq(c.el.selectionStart, '@[marcador/boceto.png]'.length, 'después del primer hijo');
  c.ctx.cursorEn(c.el, 2);
  eq(c.el.selectionStart, '@[marcador/boceto.png] final'.length);
});

test('un offset más allá del texto se cae al final, no rompe', function () {
  const c = campo();
  c.el.value = 'corto';
  c.el.setSelectionRange(400, 400);
  eq(c.el.selectionStart, 5);
});

test('la aritmética la hace UNA función, y las cuatro operaciones la usan', function () {
  // Repartirla es cómo se llega a que el cursor caiga un carácter corrido sólo
  // cuando hay dos chips seguidos. Se fija sobre el código porque es una decisión de
  // estructura: `mapa()` es la única que recorre los hijos contando caracteres.
  const src = fs.readFileSync(path.join(CEP, 'campo.js'), 'utf8');
  has(src, 'function mapa(campo)');
  // Las tres operaciones que quedan RECIBEN el mapa: ninguna vuelve a recorrer los
  // hijos por su cuenta. Es lo que hace que el chip mida `token.length` en los
  // cuatro caminos y no en tres de cuatro.
  has(src, 'function serializar(m)');
  has(src, 'function offsetDe(m, campo, nodo, dentro)');
  has(src, 'function posicionDe(m, offset)');
  // Y una sola función recorre los hijos contando caracteres: el largo que aporta un
  // chip es el de su TOKEN, y quien lo lee es el mapa y nadie más. Si otra función
  // volviera a contarlo, habría dos cuentas que se pueden separar.
  const cuerpoDelMapa = src.slice(src.indexOf('function mapa(campo)'), src.indexOf('function serializar'));
  has(cuerpoDelMapa, 'if (chip) texto = token;');
  eq((src.match(/\bif \(chip\) texto = token;/g) || []).length, 1);
});

test('el token de un chip vive también en un ATRIBUTO, para sobrevivir a un clon', function () {
  // Un `contenteditable` clona nodos por caminos que no se controlan: el undo
  // nativo y arrastrar un pedazo de texto de un lado al otro del campo. Un clon se
  // lleva los atributos y NO las propiedades de JavaScript, así que sin el atributo
  // un chip clonado dejaba de ser un chip y `value` devolvía su ETIQUETA: al modelo
  // le llegaba «@Imagen_3» como texto suelto, que es exactamente la falla que
  // guardar el nombre vino a evitar.
  const c = campo();
  c.el.value = 'poné @[marcador/boceto.png] arriba';
  const chip = c.el.chips()[0];
  eq(chip.getAttribute('data-token'), '@[marcador/boceto.png]');
  // Y un nodo que sólo tiene el atributo —lo que queda de un clon— sigue contando
  // como chip: aporta su token al valor, no su etiqueta.
  const clon = c.ctx.doc.createElement('span');
  clon.setAttribute('data-token', '@[curso/guia.pdf]');
  clon.textContent = '@Documento_1';
  c.el.appendChild(clon);
  eq(c.el.value, 'poné @[marcador/boceto.png] arriba@[curso/guia.pdf]');
});

// ── 4. El borrado: el chip se va entero o no se va ───────────────────

test('Backspace pegado a la derecha de un chip se lo lleva completo', function () {
  const c = campo();
  c.el.value = 'poné @[marcador/boceto.png] arriba';
  const fin = 5 + '@[marcador/boceto.png]'.length;
  c.el.setSelectionRange(fin, fin);
  c.el.disparar('keydown', { key: 'Backspace' });
  eq(c.el.value, 'poné  arriba', 'se fue el token entero, sin medio token de basura');
  eq(c.el.chips().length, 0);
  eq(c.el.selectionStart, 5, 'y el cursor queda donde estaba el chip');
  eq(c.inputs.length, 1, 'y avisa, para que el que guarda se entere');
});

test('Delete pegado a la izquierda también', function () {
  const c = campo();
  c.el.value = 'poné @[marcador/boceto.png] arriba';
  c.el.setSelectionRange(5, 5);
  c.el.disparar('keydown', { key: 'Delete' });
  eq(c.el.value, 'poné  arriba');
  eq(c.el.chips().length, 0);
});

test('con dos chips seguidos, cada tecla se lleva el que le toca', function () {
  // Es el caso donde una aritmética repartida se corre un carácter.
  const c = campo();
  c.el.value = '@[marcador/boceto.png]@[curso/guia.pdf]';
  c.el.setSelectionRange('@[marcador/boceto.png]'.length, '@[marcador/boceto.png]'.length);
  c.el.disparar('keydown', { key: 'Backspace' });
  eq(c.el.value, '@[curso/guia.pdf]', 'Backspace se lleva el de la izquierda');

  const d = campo();
  d.el.value = '@[marcador/boceto.png]@[curso/guia.pdf]';
  d.el.setSelectionRange('@[marcador/boceto.png]'.length, '@[marcador/boceto.png]'.length);
  d.el.disparar('keydown', { key: 'Delete' });
  eq(d.el.value, '@[marcador/boceto.png]', 'y Delete el de la derecha');
});

test('en medio del texto, Backspace es del navegador y no se toca', function () {
  // Sólo se intercepta cuando hay un chip pegado: interceptar siempre sería
  // reimplementar la edición de texto, y con ella el undo nativo.
  const c = campo();
  c.el.value = 'poné algo';
  c.el.setSelectionRange(4, 4);
  const e = c.el.disparar('keydown', { key: 'Backspace' });
  eq(c.el.value, 'poné algo', 'el campo no se tocó: lo hace el navegador');
  eq(c.inputs.length, 0);
  eq(e.target, c.el);
});

test('con algo seleccionado, borrar es del navegador', function () {
  const c = campo();
  c.el.value = 'poné @[marcador/boceto.png] arriba';
  c.el.setSelectionRange(0, 5);
  c.el.disparar('keydown', { key: 'Backspace' });
  eq(c.el.value, 'poné @[marcador/boceto.png] arriba',
    'un contenteditable="false" se borra entero por su cuenta cuando entra en un rango');
});

// ── 5. Enter y pegar ─────────────────────────────────────────────────

test('Enter entra como un "\\n" de verdad, no como un `<br>` ni un `<div>`', function () {
  // Así el contenido del campo sigue siendo una lista plana de texto y chips, que es
  // lo que el mapa sabe contar. Y `value` sigue siendo el texto de siempre.
  const c = campo();
  c.el.value = 'primero';
  c.el.setSelectionRange(7, 7);
  c.el.disparar('keydown', { key: 'Enter' });
  eq(c.el.value, 'primero\n');
  eq(c.el.selectionStart, 8);
  eq(c.inputs.length, 1);
});

test('un salto en medio de una frase con chips no le corre el número a nadie', function () {
  const c = campo();
  c.el.value = 'poné @[marcador/boceto.png] arriba';
  c.el.setSelectionRange(5, 5);
  c.el.disparar('keydown', { key: 'Enter' });
  eq(c.el.value, 'poné \n@[marcador/boceto.png] arriba');
  eq(c.el.chips()[0].textContent, '@Imagen_1');
});

test('pegar entra como TEXTO PLANO, y un token pegado sale con su chip', function () {
  // Un `contenteditable` acepta HTML por defecto, así que pegar de un navegador o
  // de un documento metía `<span>` con su estilo adentro del campo — y un elemento
  // que no es un chip es basura que el mapa tiene que adivinar.
  const c = campo();
  c.el.value = 'usá ';
  c.el.setSelectionRange(4, 4);
  const pegado = {
    clipboardData: {
      getData: function (tipo) {
        return tipo === 'text/plain' ? '@[curso/manual-de-marca-nova.png] tal cual' : '<b>no</b>';
      },
    },
  };
  c.el.disparar('paste', pegado);
  eq(c.el.value, 'usá @[curso/manual-de-marca-nova.png] tal cual');
  eq(c.el.chips().length, 1, 'y lo pegado ya se ve como chip');
  eq(c.el.chips()[0].textContent, '@Imagen_3');
});

// ── 6. El doble clic: donde el número se vuelve significado ──────────

/**
 * Abre el doble clic sobre el primer chip y devuelve el `<input>` que quedó adentro.
 *
 * Las teclas van AL INPUT y no al campo, y eso es el punto: la primera versión de
 * esto emulaba la edición —el campo leía las teclas y se las pasaba al chip— y el
 * editor la rechazó por lo que le faltaba («que abra completo como si fuera un campo
 * de texto»: cursor, selección, flechas). Un `<input>` de verdad las recibe nativas.
 */
function editar(c, i) {
  const chip = c.el.chips()[i || 0];
  chip.disparar('dblclick');
  return { chip: chip, inp: chip.childNodes[0] };
}

/** Escribe en el input del chip como el editor: el valor y su `input`. */
function tipearNumero(e, texto) {
  e.inp.value = texto;
  e.inp.disparar('input');
}

test('doble clic abre un CAMPO DE TEXTO con el número adentro', function () {
  const c = campo();
  c.el.value = 'la de @[curso/manual-de-marca-nova.png]';
  const e = editar(c);
  ok(e.inp, 'hay un input de verdad adentro del chip');
  eq(e.inp.tagName, 'input');
  eq(e.inp.type, 'text');
  eq(e.inp.value, '3', 'con el número que el editor va a cambiar');
  eq(c.ctx.doc.activeElement, e.inp, 'y con el foco puesto: ahí es donde se escribe');
  has(e.chip.className, 'is-editando');
  eq(e.chip.getAttribute('contenteditable'), 'false',
    'el chip sigue sin ser editable: lo editable es el input que tiene adentro, que ' +
    'es un control aparte y por eso el navegador SÍ le enruta las teclas');
  eq(c.el.value, 'la de @[curso/manual-de-marca-nova.png]',
    'y mientras se edita, lo GUARDADO no se movió: el token vive aparte de la etiqueta');
});

test('el número arranca SELECCIONADO, así escribir lo reemplaza de una', function () {
  const c = campo();
  c.el.value = '@[curso/manual-de-marca-nova.png]';
  const e = editar(c);
  eq(e.inp._seleccionado, true);
});

test('el chip en edición no se lo lleva la limpieza del campo', function () {
  // Un chip con un `<input>` adentro tiene el `textContent` vacío, o sea que parece
  // un chip al que le borraron la etiqueta — y ésos se sacan. Si no se salteara, el
  // primer `input` del campo se llevaría puesto el chip que se está editando.
  const c = campo();
  c.el.value = 'la de @[curso/manual-de-marca-nova.png] arriba';
  const e = editar(c);
  c.el.disparar('input');
  eq(c.el.chips().length, 1);
  eq(c.el.value, 'la de @[curso/manual-de-marca-nova.png] arriba');
  // Y la edición sigue abierta: si el campo la cerrara sola en el primer `input`, el
  // editor vería desaparecer el cursor en medio de escribir el número.
  has(c.el.chips()[0].className, 'is-editando');
  eq(c.el.chips()[0].childNodes[0], e.inp, 'el mismo input, no uno nuevo');
});

test('escribir 2 repunta a la que HOY es la 2, y guarda su nombre', function () {
  // Es lo que pidió el editor —"cambiar Imagen_1 por Imagen_2"— y lo que hace que
  // el cambio sobreviva: se guarda el NOMBRE de la que en este momento es la 2.
  const c = campo();
  c.el.value = 'la de @[curso/manual-de-marca-nova.png]';
  const e = editar(c);
  tipearNumero(e, '2');
  e.inp.disparar('keydown', { key: 'Enter' });
  eq(c.el.value, 'la de @[marcador/captura.png]', 'la 2 del pedido es la segunda del marcador');
  eq(c.el.chips()[0].textContent, '@Imagen_2');
  eq(c.inputs.length, 1, 'y avisa, para que el que guarda persista');
});

test('el Enter del input no llega al campo: no deja un salto de línea', function () {
  // Es la misma familia de problema que el Enter del menú del `@`, y la razón por la
  // que el input para el evento.
  const c = campo();
  c.el.value = 'la de @[curso/manual-de-marca-nova.png]';
  const e = editar(c);
  tipearNumero(e, '1');
  e.inp.disparar('keydown', { key: 'Enter' });
  ok(c.el.value.indexOf('\n') === -1, 'sin salto: ' + JSON.stringify(c.el.value));
  eq(c.el.value, 'la de @[marcador/boceto.png]');
});

test('lo que no es un dígito se filtra, y tres es el tope', function () {
  // Se filtra en el `input` y no atajando teclas, para no pelearle al teclado: pegar
  // y el dictado del sistema entran por el mismo lugar. Las flechas y la selección
  // siguen siendo del navegador.
  const c = campo();
  c.el.value = '@[curso/manual-de-marca-nova.png]';
  const e = editar(c);
  tipearNumero(e, '3a b@2');
  eq(e.inp.value, '32');
  tipearNumero(e, '123456');
  eq(e.inp.value, '123', 'más de tres dígitos no es un número de referencia');
});

test('Tab confirma igual que Enter', function () {
  const c = campo();
  c.el.value = '@[curso/manual-de-marca-nova.png]';
  const e = editar(c);
  tipearNumero(e, '1');
  e.inp.disparar('keydown', { key: 'Tab' });
  eq(c.el.value, '@[marcador/boceto.png]');
});

// ── 6.b Un número que no apunta a nada: rojo, y NO se deshace ────────
//
// Acá estaba la regla vieja: «un número que no existe no inventa nada: el chip queda
// como estaba y se dice». El editor la corrigió y tenía razón: *"si lo modifico a
// algo que no está, pues debería dejar de aparecer azul ya que no está referenciando
// nada. O que aparezca rojo avisando que no referencia a nada"*. Deshacerle lo que
// escribió es peor que mostrárselo mal — el chip volviendo solo al 3 se siente como
// que el panel le pelea el teclado, y lo deja creyendo que quedó el 3 cuando quería
// el 7.

test('un número que no existe queda EN ROJO, con el número que escribió', function () {
  const c = campo();
  c.el.value = 'la de @[curso/manual-de-marca-nova.png]';
  const e = editar(c);
  tipearNumero(e, '7');
  e.inp.disparar('keydown', { key: 'Enter' });
  eq(c.el.chips()[0].textContent, '@Imagen_7',
    'dice 7 porque 7 es lo que escribió y lo que tiene que corregir');
  has(c.el.chips()[0].className, 'is-sin-numero', 'y deja de ser azul');
  eq(c.inputs.length, 1, 'el texto cambió, así que se avisa y se guarda');
});

test('y lo GUARDADO es ese número, de forma que no apunte a nada', function () {
  // No hay nombre de archivo que guardar, así que se guarda lo único que es un
  // registro fiel de lo que el editor pidió. Y no contradice guardar el nombre: el
  // nombre existe para que una mención VÁLIDA sobreviva a que la lista se reordene.
  const c = campo();
  c.el.value = '@[curso/manual-de-marca-nova.png]';
  const e = editar(c);
  tipearNumero(e, '7');
  e.inp.disparar('keydown', { key: 'Enter' });
  eq(c.el.value, '@[Imagen_7]');
  eq(P.estadoDe(P.encontrar('@[Imagen_7]')[0], INV), 'sin-numero');
});

test('el estado sobrevive a recargar el campo: está en el texto', function () {
  // Es la mitad de por qué esto es mejor que el aviso de una sola vez que había
  // antes: el chip rojo sigue rojo después de cambiar de pestaña y volver, porque lo
  // que lo hace rojo es el token guardado y no un mensaje que ya pasó.
  const c = campo();
  c.el.value = 'la de @[Imagen_7] arriba';
  eq(c.el.chips()[0].textContent, '@Imagen_7');
  has(c.el.chips()[0].className, 'is-sin-numero');
});

test('el renglón de abajo lo dice con palabras, y dice CUÁNTAS hay', function () {
  // Con el chip rojo el color es lo único que avisa; el renglón es el que explica. Y
  // decir cuántas hay es la mitad del aviso: el editor escribió 7 porque creía que
  // había siete.
  const p = P.revisar('la de @[Imagen_7]', INV);
  eq(p.length, 1);
  eq(p[0].motivo, 'sin-numero');
  eq(p[0].numero, 7);
  eq(p[0].de, 4, 'cuatro imágenes viajan de las cinco');
  const r = P.renglon(p);
  has(r.texto, 'la imagen 7');
  has(r.texto, 'hay 4');
  has(r.texto, 'de 1 a 4');
  has(r.texto, 'modelo va a leer que falta');
  eq(r.clase, 'is-error', 'rojo, igual que la colgada: no apunta a nada');
});

test('y el aviso NO lo confunde con una referencia que se borró', function () {
  // Las dos están en rojo, pero una se arregla volviendo a adjuntar el archivo y la
  // otra escribiendo otro número. Un aviso que dijera «volvé a adjuntar «Imagen_7»»
  // mandaría a buscar un archivo que no existe.
  const suelto = P.renglon(P.revisar('@[Imagen_7]', INV));
  const colgada = P.renglon(P.revisar('@[curso/borrada.png]', INV));
  ok(suelto.texto !== colgada.texto);
  ok(suelto.texto.indexOf('ya no está en la lista') === -1);
  has(colgada.texto, 'ya no está');
});

test('el tooltip dice qué pasó y cómo se arregla', function () {
  // En un chip rojo que dice `@Imagen_7`, el color es lo único que avisa: sin el
  // tooltip no se entiende ni qué pasó ni cómo se sale.
  const c = campo();
  c.el.value = '@[Imagen_7]';
  const t = c.el.chips()[0].title;
  has(t, '@[Imagen_7]', 'el token, como en todos los chips');
  has(t, 'escribiste 7');
  has(t, 'de 1 a 4', 'cuántas hay');
  has(t, 'el modelo va a leer que esa referencia falta');
  has(t, 'Doble clic para corregir');
});

test('el globo del chip y el renglón de abajo dicen LO MISMO', function () {
  // Las dos frases se leen JUNTAS —el globo sale al pasar el mouse por el chip y el
  // renglón está dos centímetros más abajo—, así que divergir acá no es una
  // inconsistencia de estilo: es el panel contradiciéndose solo delante del editor.
  //
  // Y divergieron. Estaban redactadas en tres lugares y el renglón se quedó con un
  // ternario muerto cuyas dos ramas decían lo mismo: el globo decía «hay 3
  // imágenes» y el renglón «hay 3». Ahora las dos le piden el diagnóstico a
  // `HPMenciones.explicar`, y lo que se fija es que sigan pidiéndoselo: para cada
  // motivo, lo que dice el globo tiene que estar también en el renglón.
  const c = campo();
  const M = c.ctx.HPMenciones;

  // Los tres motivos que el campo puede mostrar en un chip. El de arriba es un
  // número que no existe: 4 imágenes viajan —la de la clase que el disco no tiene
  // no ocupa número— así que un 7 no apunta a nada.
  ['@[Imagen_7]', '@[curso/no-existe.svg]', '@[clase/paleta.png]'].forEach(function (texto) {
    c.el.value = texto;
    const globo = c.el.chips()[0].title;
    const problemas = M.revisar(texto, INV);
    const e = M.explicar(problemas[0]);
    has(globo, e.largo, texto + ': el globo dice el diagnóstico de `explicar`, tal cual');
    has(M.renglon(problemas).texto, e.corto, texto + ': y el renglón dice el mismo');
  });

  // Y con la frase escrita, porque «los dos dicen lo que dice `explicar`» no
  // alcanza: si `explicar` se queda corta, los dos se quedan cortos juntos.
  c.el.value = '@[Imagen_7]';
  has(c.el.chips()[0].title, 'hay 4 imágenes', 'el globo dice cuántas hay, y de qué');
  has(M.renglon(M.revisar('@[Imagen_7]', INV)).texto, 'hay 4 imágenes',
    'y el renglón dice cuántas hay, y de qué');

  // Y el documento se cuenta con los documentos, no con las imágenes: son dos
  // numeraciones distintas, y decir «hay 4» a secas —que es lo que decía el renglón—
  // manda a contar la lista equivocada.
  c.el.value = '@[Documento_9]';
  has(c.el.chips()[0].title, 'hay 1 documentos', 'el globo cuenta los documentos');
  has(M.renglon(M.revisar('@[Documento_9]', INV)).texto, 'hay 1 documentos',
    'y el renglón también');
});

test('se arregla con el mismo gesto: rojo → número válido → azul con el nombre', function () {
  // La ida y la vuelta, que es lo que no puede quedar pegado.
  const c = campo();
  c.el.value = 'la de @[curso/manual-de-marca-nova.png]';
  const mal = editar(c);
  tipearNumero(mal, '7');
  mal.inp.disparar('keydown', { key: 'Enter' });
  eq(c.el.value, 'la de @[Imagen_7]');

  const bien = editar(c);
  eq(bien.inp.value, '7', 'el input abre con el número que había escrito, no vacío');
  tipearNumero(bien, '2');
  bien.inp.disparar('keydown', { key: 'Enter' });
  eq(c.el.value, 'la de @[marcador/captura.png]', 'vuelve a guardar un NOMBRE');
  eq(c.el.chips()[0].textContent, '@Imagen_2');
  eq(c.el.chips()[0].className, 'hp-chip', 'y vuelve a azul, sin marca de estado');
});

test('un documento inválido se guarda como documento, y se arregla entre documentos', function () {
  const inv = INV.concat([{ scope: 'sequence', nombre: 'brief.md', falta: false, tipo: 'documento', src: '' }]);
  const c = campo(inv);
  c.el.value = 'mirá @[curso/guia.pdf]';
  const mal = editar(c);
  tipearNumero(mal, '9');
  mal.inp.disparar('keydown', { key: 'Enter' });
  eq(c.el.value, 'mirá @[Documento_9]');
  eq(c.el.chips()[0].textContent, '@Documento_9');
  // Y al corregirlo sigue moviéndose entre los DOCUMENTOS, no entre las imágenes.
  const bien = editar(c);
  tipearNumero(bien, '2');
  bien.inp.disparar('keydown', { key: 'Enter' });
  eq(c.el.value, 'mirá @[clase/brief.md]');
});

test('Escape y Enter ahora son DOS cosas distintas', function () {
  // Antes terminaban en lo mismo —el número inválido se deshacía igual— así que el
  // Escape no se distinguía de nada. Ahora cancelar deja el chip apuntando a lo que
  // apuntaba, y confirmar guarda lo que el editor escribió aunque no apunte a nada.
  const a = campo();
  a.el.value = '@[curso/manual-de-marca-nova.png]';
  const cancelado = editar(a);
  tipearNumero(cancelado, '7');
  cancelado.inp.disparar('keydown', { key: 'Escape' });
  eq(a.el.value, '@[curso/manual-de-marca-nova.png]', 'Escape: como estaba');
  eq(a.el.chips()[0].textContent, '@Imagen_3');
  eq(a.inputs.length, 0, 'y sin cambio no hay nada que guardar');

  const b = campo();
  b.el.value = '@[curso/manual-de-marca-nova.png]';
  const confirmado = editar(b);
  tipearNumero(confirmado, '7');
  confirmado.inp.disparar('keydown', { key: 'Enter' });
  eq(b.el.value, '@[Imagen_7]', 'Enter: queda lo que escribió');
});

test('el número vacío sigue siendo "no pedí nada"', function () {
  const c = campo();
  c.el.value = '@[curso/manual-de-marca-nova.png]';
  const e = editar(c);
  tipearNumero(e, '');
  e.inp.disparar('keydown', { key: 'Enter' });
  eq(c.el.value, '@[curso/manual-de-marca-nova.png]', 'no se guarda un `@[Imagen_]`');
  eq(c.el.chips()[0].textContent, '@Imagen_3');
});

test('irse del input CONFIRMA lo que se estaba escribiendo', function () {
  // Es lo que hace cualquier campo chico: se escribe «2» y se sigue con lo suyo.
  // Y es el `blur` del INPUT y no el del campo: el campo pierde el foco justo cuando
  // la edición empieza (se lo lleva el input), así que cerrar con el blur del campo
  // habría cerrado la edición en el momento de abrirla.
  const c = campo();
  c.el.value = '@[curso/manual-de-marca-nova.png]';
  const e = editar(c);
  tipearNumero(e, '1');
  e.inp.disparar('blur');
  eq(c.el.value, '@[marcador/boceto.png]');
});

test('el Backspace del input no se lleva el chip de al lado', function () {
  // Es el defecto de la vuelta anterior con otra cara: si el campo se metiera con
  // las teclas mientras se edita un número, el Backspace con el cursor al principio
  // del input le parecería «hay que borrar el chip que termina acá» — y se llevaría
  // OTRA mención mientras el editor corregía este número.
  const c = campo();
  c.el.value = '@[marcador/boceto.png]@[curso/manual-de-marca-nova.png]';
  const e = editar(c, 1);
  // El cursor adentro del input, que es donde lo pone el navegador al abrir la
  // edición. Visto desde el campo, ese punto es justo donde TERMINA el chip de al
  // lado: si el campo mirara las teclas, leería «hay que borrar el chip que termina
  // acá».
  c.ctx.cursorEn(e.inp, 0);
  c.el.disparar('keydown', { key: 'Backspace', target: e.inp });
  eq(c.el.chips().length, 2, 'los dos chips siguen ahí');
  eq(c.el.value, '@[marcador/boceto.png]@[curso/manual-de-marca-nova.png]');
});

test('abrir la edición NO la cierra sola, aunque el campo pierda el foco', function () {
  const c = campo();
  c.el.value = '@[curso/manual-de-marca-nova.png]';
  const e = editar(c);
  c.el.disparar('blur');       // el foco se lo llevó el input, que es hijo del campo
  eq(e.chip.className.indexOf('is-editando') !== -1, true, 'sigue abierta');
  ok(e.chip.childNodes[0], 'y el input sigue ahí');
});

// ── 6.c La gramática del número suelto ──────────────────────────────

test('un número suelto se reconoce por su forma, y sólo esa forma', function () {
  deepEq(P.numeroSuelto({ scope: '', nombre: 'Imagen_7' }), { tipo: 'imagen', numero: 7 });
  deepEq(P.numeroSuelto({ scope: '', nombre: 'Documento_12' }), { tipo: 'documento', numero: 12 });
  // Un archivo de VERDAD no se confunde: la forma no lleva extensión ni ámbito.
  eq(P.numeroSuelto({ scope: '', nombre: 'Imagen_7.png' }), null);
  eq(P.numeroSuelto({ scope: 'course', nombre: 'Imagen_7' }), null);
  eq(P.numeroSuelto({ scope: '', nombre: 'imagen 7' }), null);
  eq(P.numeroSuelto({ scope: '', nombre: 'Imagen_' }), null);
  eq(P.numeroSuelto({ scope: '', nombre: 'boceto.png' }), null);
});

test('y si por casualidad EXISTE una referencia con ese nombre, gana ella', function () {
  // `estadoDe` sólo pregunta por el número suelto cuando no hay ningún candidato, así
  // que un documento que de verdad se llame «Imagen_7» se resuelve como lo que es.
  const inv = [{ scope: 'course', nombre: 'Imagen_7', falta: false, tipo: 'documento', src: '' }];
  eq(P.estadoDe({ scope: '', nombre: 'Imagen_7' }, inv), '');
  eq(P.etiqueta({ scope: '', nombre: 'Imagen_7' }, inv).texto, '@Documento_1');
});

test('el token lo escribe el mismo módulo que lo lee', function () {
  eq(P.escribirNumero('imagen', 7), '@[Imagen_7]');
  eq(P.escribirNumero('documento', 3), '@[Documento_3]');
  deepEq(P.numeroSuelto(P.encontrar(P.escribirNumero('imagen', 42))[0]), { tipo: 'imagen', numero: 42 });
});

test('el motor lo trata como una mención colgada: el modelo lee que falta', function () {
  // Es lo que hace que guardar el número no sea peligroso: el motor no le presta el
  // número de otra imagen, dice que esa referencia no está. Ya estaba fijado en
  // `menciones.test.js`; acá se comprueba con el token que el panel escribe.
  const items = motor.indice({
    stills: ['/p/a.png', '/p/b.png'],
    stillRefs: [{ scope: 'marker', name: 'a.png' }, { scope: 'course', name: 'b.png' }],
    resources: [],
  });
  const r = motor.resolver('poné la @[Imagen_7] arriba', items);
  has(r.texto, '«Imagen_7» (referencia que ya no está adjunta a este pedido)');
  ok(r.texto.indexOf('imagen 1') === -1 && r.texto.indexOf('imagen 2') === -1,
    'y NO se le presta el número de otra: ' + r.texto);
  eq(r.problemas[0].motivo, 'colgada');
});

// ── 7. El preview del hover ──────────────────────────────────────────

test('el hover de una imagen muestra su miniatura, con la fuente del inventario', function () {
  // Las del marcador son data URLs y las de los dos niveles generales son rutas en
  // disco convertidas a `file://` (en Windows con la barra extra de la raíz). El
  // inventario las trae ya convertidas, por `stillThumbSrc`, que es el mismo criterio
  // de las miniaturas de la tira: si el preview armara la URL por su cuenta, en
  // Windows se vería una y no la otra.
  const c = campo();
  c.el.value = '@[curso/manual-de-marca-nova.png]';
  c.el.chips()[0].disparar('mouseover');
  const prev = c.ctx.doc.body.childNodes.filter((n) => n.className === 'hp-chip-preview')[0];
  ok(prev, 'el preview se cuelga del body: adentro del campo lo recortaría el scroll');
  const img = prev.childNodes.filter((n) => n.tagName === 'img')[0];
  eq(img.src, 'file:///p/manual.png');
  has(prev.childNodes.map((n) => n.textContent).join(' '), 'manual-de-marca-nova.png',
    'y el nombre del archivo, que es lo que el chip dejó de mostrar');
});

test('el hover de un documento muestra el icono de su tipo', function () {
  const c = campo();
  c.el.value = '@[curso/guia.pdf]';
  c.el.chips()[0].disparar('mouseover');
  const prev = c.ctx.doc.body.childNodes.filter((n) => n.className === 'hp-chip-preview')[0];
  const ico = prev.childNodes.filter((n) => n._icono)[0];
  eq(ico._icono, 'documento', 'el mismo dibujo que la tira usa para un documento');
});

test('el hover de una que el disco no tiene muestra el triángulo de aviso', function () {
  const c = campo();
  c.el.value = '@[clase/paleta.png]';
  c.el.chips()[0].disparar('mouseover');
  const prev = c.ctx.doc.body.childNodes.filter((n) => n.className === 'hp-chip-preview')[0];
  eq(prev.childNodes.filter((n) => n._icono)[0]._icono, 'falta',
    'no hay miniatura que mostrar, y el aviso es el mismo que ya muestra la tira');
});

test('el hover de una mención colgada no intenta mostrar nada', function () {
  const c = campo();
  c.el.value = '@[curso/no-existe.png]';
  c.el.chips()[0].disparar('mouseover');
  eq(c.ctx.doc.body.childNodes.filter((n) => n.className === 'hp-chip-preview').length, 0,
    'esa referencia ya no está en la lista: no hay nada de dónde sacar una miniatura');
});

// ── 8. La fachada, probada por quien no sabe que cambió ──────────────

test('`HPMenciones.insertar` anda SIN TOCARLA, que es la prueba de la fachada', function () {
  // Si hubiera que tocar `insertar` para que los chips anden, lo que falta está en
  // la fachada del campo. Habla en `value`, `selectionStart` y `setSelectionRange`
  // sobre el texto canónico, y no se enteró de nada.
  const c = campo();
  c.el.value = 'poné el logo y el título';
  c.el.setSelectionRange(12, 12);
  let guardado = null;
  c.ctx.HPMenciones.insertar(c.el, c.ctx.HPMenciones.escribir('course', 'manual-de-marca-nova.png'), {
    onChange: function (t) { guardado = t; },
  });
  eq(c.el.value, 'poné el logo @[curso/manual-de-marca-nova.png] y el título');
  eq(guardado, c.el.value, 'y avisa para que el que llama persista');
  eq(c.el.chips().length, 1, 'y ya se ve como chip');
  eq(c.el.selectionStart, 'poné el logo @[curso/manual-de-marca-nova.png]'.length,
    'con el cursor después de la mención, para poder seguir escribiendo');
});

test('insertar al lado de un chip que ya está cuenta bien los caracteres', function () {
  const c = campo();
  c.el.value = 'copiá @[marcador/boceto.png]';
  c.el.setSelectionRange(c.el.value.length, c.el.value.length);
  c.ctx.HPMenciones.insertar(c.el, '@[curso/guia.pdf]');
  eq(c.el.value, 'copiá @[marcador/boceto.png] @[curso/guia.pdf]');
  eq(c.el.chips().length, 2);
});

test('el dictado escribe en un campo con chips y no pierde ninguno', function () {
  // El dictado reescribe el campo ENTERO en cada refresco (`ta.value = texto`) y le
  // maneja el alto. Es el camino que más veces pasa por el setter, y el que más
  // fácil se lleva puesto un chip.
  const c = campo();
  c.el.value = 'copiá @[marcador/boceto.png] y ';
  ['copiá @[marcador/boceto.png] y el', 'copiá @[marcador/boceto.png] y el encuadre',
    'copiá @[marcador/boceto.png] y el encuadre de @[clase/encuadre.png]'].forEach(function (t) {
    c.el.value = t;
    eq(c.el.value, t, 'refresco: ' + t);
  });
  eq(c.el.chips().length, 2);
  eq(c.el.chips().map(function (ch) { return ch.textContent; }).join(' '), '@Imagen_1 @Imagen_4');
  eq(c.inputs.length, 0,
    'y poner el valor por código NO dispara `input`, igual que un textarea: el ' +
    'dictado avisa por su cuenta y no se pisa con los refrescos');
});

test('el ✨ canoniza y lo canonizado entra como chip', function () {
  // El ✨ convierte un "imagen 2" escrito a mano en la mención del archivo que de
  // verdad es la 2, y después el refinado se escribe en el campo por el setter.
  const c = campo();
  const r = c.ctx.HPMenciones.canonizar('Como en la imagen 2, con la paleta de la imagen 3.', INV);
  eq(r.texto, 'Como en la @[marcador/captura.png], con la paleta de la @[curso/manual-de-marca-nova.png].');
  c.el.value = r.texto;
  eq(c.el.chips().map(function (ch) { return ch.textContent; }).join(' '), '@Imagen_2 @Imagen_3',
    'y el número que muestra el chip es el mismo que el ✨ usó para elegir el archivo');
  eq(c.el.value, r.texto, 'y lo guardado sigue siendo el nombre');
});

test('tecleando NO se redibujan los chips: se perdería el undo nativo', function () {
  // Es la regla delicada del campo. Los chips se crean al cargar el texto, al
  // insertar una mención, al refinar y cuando cambia la lista de referencias; nunca
  // en un `input`. Se comprueba por IDENTIDAD del nodo: si se hubiera redibujado,
  // el chip sería otro objeto.
  const c = campo();
  c.el.value = 'poné @[marcador/boceto.png] arriba';
  const antes = c.el.chips()[0];
  c.el.childNodes[2].textContent = ' arriba a la derecha';
  c.el.disparar('input');
  eq(c.el.chips()[0], antes, 'el mismo nodo: nadie lo volvió a crear');
  eq(c.el.value, 'poné @[marcador/boceto.png] arriba a la derecha');
});

test('y `repintar()` sí los redibuja, que es lo que pide una lista que se movió', function () {
  // Agregar una imagen al marcador le corre el número a todas las heredadas. El
  // chip tiene que decir el nuevo, y lo guardado no se toca.
  const inv = INV.slice();
  const c = campo(inv);
  c.el.value = 'la tipografía de @[curso/manual-de-marca-nova.png]';
  eq(c.el.chips()[0].textContent, '@Imagen_3');
  inv.unshift({ scope: 'marker', nombre: 'nueva.png', falta: false, tipo: 'imagen', src: 'data:x' });
  c.el.repintar();
  eq(c.el.chips()[0].textContent, '@Imagen_4', 'el número siguió a la lista');
  eq(c.el.value, 'la tipografía de @[curso/manual-de-marca-nova.png]', 'y el texto no se movió');
});

// El caso que reportó el editor, y es el que duele: "si elimino la imagen, sigue
// apareciendo referenciada normal. Si la elimino de arriba debería de borrarse y
// corregir en las siguientes".
//
// Borrar es peor que agregar. Agregando, el chip que se queda viejo apunta a otra
// imagen; borrando pasan las dos cosas a la vez: el que nombraba a la que se fue
// queda apuntando a la nada —y tiene que DECIRLO, no seguir azul— y todos los de
// atrás se corren un lugar.
test('al borrar una imagen, el chip que la nombraba queda colgado y los de atrás se corren', function () {
  const inv = INV.slice();
  const c = campo(inv);
  c.el.value = 'copiá @[marcador/boceto.png] y la tipografía de @[curso/manual-de-marca-nova.png]';
  eq(c.el.chips()[0].textContent, '@Imagen_1', 'la del marcador es la 1');
  eq(c.el.chips()[1].textContent, '@Imagen_3', 'la del curso es la 3');
  eq(c.el.chips()[0].className.indexOf('is-colgada'), -1, 'y ninguna está colgada todavía');

  // Se borra la primera, como quien aprieta la ✕ de la miniatura de arriba.
  inv.shift();
  c.el.repintar();

  has(c.el.chips()[0].className, 'is-colgada', 'la que nombraba a la que se fue lo dice');
  eq(c.el.chips()[0].textContent, '@boceto.png',
    'y muestra el NOMBRE, que es lo único con lo que se puede arreglar');
  eq(c.el.chips()[1].textContent, '@Imagen_2', 'la de atrás se corrió sola: era la 3');
  // Y lo guardado sigue intacto: el texto es del editor, no del panel.
  eq(c.el.value, 'copiá @[marcador/boceto.png] y la tipografía de @[curso/manual-de-marca-nova.png]');
});

// ── 9. El número del chip es el número del MOTOR ─────────────────────

test('el chip numera exactamente como `indice()` del motor', function () {
  // Las dos cuentas, sobre el mismo material. El panel mira su inventario y el motor
  // mira el payload que va a viajar; si se separaran, el chip diría «Imagen_2» sobre
  // lo que va a llegar como «imagen 3» y el gráfico saldría distinto sin que nada
  // falle — que es el modo de falla que todo este mecanismo vino a matar.
  const c = campo();

  // El mismo pedido, dicho en los dos vocabularios.
  const stills = INV.filter((it) => it.tipo === 'imagen');
  const payload = {
    stills: stills.map((it) => it.src || ('/p/' + it.nombre)),
    stillRefs: stills.map((it) => ({ scope: it.scope, name: it.nombre })),
    resources: INV.filter((it) => it.tipo === 'documento')
      .map((it) => ({ scope: it.scope, fileName: it.nombre })),
    // Lo que el panel llama `falta`, el motor lo llama "no viaja".
    viaja: function (s, i) { return !stills[i].falta; },
  };
  const items = motor.indice(payload);

  items.filter((it) => it.kind === 'image').forEach(function (it) {
    const men = { scope: it.scope, nombre: it.nombre };
    const e = c.ctx.HPMenciones.etiqueta(men, INV);
    eq(e.numero, it.numero, it.nombre + ': el panel y el motor tienen que decir el mismo número');
    if (it.numero) eq(e.texto, '@Imagen_' + it.numero, it.nombre);
  });
});

test('y la traducción de vuelta cierra el círculo: chip → motor → el mismo archivo', function () {
  // Es la comprobación de punta a punta en chico: lo que el chip muestra como
  // «Imagen_4» tiene que llegarle al modelo como «imagen 4», y viceversa.
  const c = campo();
  c.el.value = 'el encuadre de @[clase/encuadre.png]';
  eq(c.el.chips()[0].textContent, '@Imagen_4');

  const stills = INV.filter((it) => it.tipo === 'imagen');
  const items = motor.indice({
    stills: stills.map((it) => '/p/' + it.nombre),
    stillRefs: stills.map((it) => ({ scope: it.scope, name: it.nombre })),
    resources: INV.filter((it) => it.tipo === 'documento')
      .map((it) => ({ scope: it.scope, fileName: it.nombre })),
    viaja: function (s, i) { return !stills[i].falta; },
  });
  eq(motor.resolver(c.el.value, items).texto, 'el encuadre de imagen 4');
});

test('los documentos NO los numera el motor: el `_1` del chip es del panel', function () {
  // Y no se "arregla" el motor para que numere: el prompt está verificado
  // nombrándolos («el documento "guia.pdf"»).
  const c = campo();
  c.el.value = 'según @[curso/guia.pdf]';
  eq(c.el.chips()[0].textContent, '@Documento_1');
  const items = motor.indice({
    stills: [], stillRefs: [], resources: [{ scope: 'course', fileName: 'guia.pdf' }],
  });
  eq(motor.resolver('según @[curso/guia.pdf]', items).texto, 'según el documento «guia.pdf»');
  eq(items[0].numero, 0, 'el motor no le da número a un documento');
});

test('las dos gramáticas siguen encontrando lo mismo, ahora con el campo en medio', function () {
  // El corpus entero, pasando por el campo: lo que el panel dibuja como chip es
  // exactamente lo que el motor va a encontrar para traducir. Si el campo tomara por
  // mención algo que el motor no ve (o al revés), habría un chip que no viaja.
  const c = campo();
  CORPUS.forEach(function (t) {
    c.el.value = t;
    deepEq(
      c.el.chips().map(function (ch) { return ch._hpToken; }),
      motor.encontrar(t).map(function (m) { return m.raw; }),
      JSON.stringify(t));
  });
});

// ── 10. Lo que el navegador mete por su cuenta ───────────────────────

test('un `<span>` que entró con un arrastre se desarma y no pierde su texto', function () {
  const c = campo();
  c.el.value = 'poné @[marcador/boceto.png]';
  const intruso = c.ctx.doc.createElement('span');
  intruso.textContent = ' y algo más';
  c.el.appendChild(intruso);
  c.el.disparar('input');
  eq(c.el.value, 'poné @[marcador/boceto.png] y algo más', 'el texto se conserva');
  eq(c.el.childNodes.filter(function (n) { return n.tagName === 'span' && !n._hpToken; }).length, 0,
    'y el elemento ajeno ya no está');
  eq(c.el.chips().length, 1, 'con el chip intacto');
});

test('un chip al que le borraron la etiqueta por dentro se va entero', function () {
  // Es el "medio token de basura" al revés: el chip no se ve y su token seguiría
  // viajando al modelo.
  const c = campo();
  c.el.value = 'poné @[marcador/boceto.png] arriba';
  c.el.chips()[0].textContent = '';
  c.el.disparar('input');
  eq(c.el.value, 'poné  arriba');
  eq(c.el.chips().length, 0);
});

// ── 11. El MENÚ que se abre al escribir `@` ──────────────────────────
//
// «Al escribir a mano "@" debería salir un menú de selección de las referencias.
// Así puedo solo seleccionar lo que deseo rápidamente.» Es el complemento de la
// tira de arriba: para mencionar tocando una miniatura hay que sacar la mano del
// teclado en medio de una frase.
//
// Se prueba en dos capas, y a propósito: CUÁNDO se abre y QUÉ ofrece son funciones
// puras sobre `(texto, cursor)` y sobre el inventario, así que se pueden fijar sobre
// los veinte casos raros —un mail, un `@` pegado a una palabra, una mención ya
// escrita— sin montar nada. Lo que necesita DOM (las teclas, el clic, que el Enter
// no se le escape al campo) se prueba abajo, y lo que necesita un navegador de
// verdad (que Chromium no meta el salto de línea, que el menú no quede cortado a
// 320 px) se mide con `medir-chips.js`.

// ── 11.a Cuándo se abre ──────────────────────────────────────────────

test('el `@` al principio del campo abre el menú', function () {
  deepEq(P.disparo('@', 1), { desde: 0, consulta: '' });
  deepEq(P.disparo('@bo', 3), { desde: 0, consulta: 'bo' });
});

test('después de un espacio o de un salto, también', function () {
  deepEq(P.disparo('copiá @', 7), { desde: 6, consulta: '' });
  deepEq(P.disparo('copiá @boce', 11), { desde: 6, consulta: 'boce' });
  deepEq(P.disparo('primera línea\n@', 15), { desde: 14, consulta: '' });
});

test('pegado a una palabra NO se abre: eso es un mail o un handle', function () {
  // Es la regla que el editor pidió con nombre y apellido, y la que evita que cada
  // dirección de correo escrita en una instrucción sea un tropiezo.
  eq(P.disparo('escribile a dani@nova.com', 17), null);
  eq(P.disparo('como dice @marcelo', 18) === null, false, 'un `@` después de espacio sí abre');
  eq(P.disparo('x@', 2), null);
  eq(P.disparo('logo@2x.png', 5), null);
});

test('adentro de una mención YA escrita no se abre', function () {
  // `@[curso/logo.svg]` es una mención escrita (o pegada, o insertada por la tira):
  // reabrir el menú ahí sería ofrecerle reemplazar lo que acaba de elegir. El
  // corchete corta la búsqueda hacia atrás.
  const t = 'poné @[curso/manual-de-marca-nova.png] arriba';
  eq(P.disparo(t, 10), null);
  eq(P.disparo(t, t.length - 3), null);
});

test('cuando lo tecleado tiene un espacio, el menú se cierra', function () {
  // El editor terminó la palabra y siguió con la frase: el menú ya no viene al caso.
  eq(P.disparo('copiá @boceto y ', 16), null);
  deepEq(P.disparo('copiá @boceto', 13), { desde: 6, consulta: 'boceto' });
});

test('sin ningún `@` hacia atrás no pasa nada', function () {
  eq(P.disparo('una instrucción normal', 22), null);
  eq(P.disparo('', 0), null);
});

test('una consulta larguísima no abre el menú', function () {
  // El tope existe para que un `@` que quedó diez palabras atrás no abra un menú:
  // lo que se teclea después del `@` es un nombre de archivo a medio escribir.
  eq(P.disparo('@' + 'a'.repeat(200), 201), null);
});

// ── 11.b Qué ofrece ──────────────────────────────────────────────────

test('sin consulta ofrece TODO, en el orden en que le llega al modelo', function () {
  const filas = P.candidatos(INV, '');
  eq(filas.length, 6);
  eq(filas.map(function (f) { return f.etiqueta; }).join(' '),
    '@Imagen_1 @Imagen_2 @Imagen_3 @Documento_1 @paleta.png @Imagen_4');
  eq(filas.map(function (f) { return f.rotulo; }).join(' | '),
    'de este marcador | de este marcador | del curso | del curso | de esta clase | de esta clase');
});

test('cada fila trae lo MISMO que va a decir el chip, y su token', function () {
  // Si el menú numerara por su cuenta, tendríamos dos cuentas que se pueden
  // separar: la lista diría «Imagen_3» y el chip que aparece en su lugar otra cosa.
  const fila = P.candidatos(INV, 'manual')[0];
  eq(fila.etiqueta, '@Imagen_3');
  eq(fila.numero, 3);
  eq(fila.token, '@[curso/manual-de-marca-nova.png]');
  eq(fila.tipo, 'imagen');
  eq(fila.src, 'file:///p/manual.png', 'y de dónde sale su miniatura, ya convertida');
  eq(P.etiqueta({ scope: fila.scope, nombre: fila.nombre }, INV).texto, fila.etiqueta,
    'la misma función que usa el chip');
});

test('filtra por nombre de archivo, sin mayúsculas y SIN ACENTOS', function () {
  // No es un lujo: hay archivos que se llaman «Guía de estilo» y «Captura de
  // pantalla», y tener que acertarle al acento para encontrarlos es peor que abrir
  // la tira con el mouse.
  const inv = [
    { scope: 'course', nombre: 'Guía de estilo ACADEMIA.pdf', falta: false, tipo: 'documento', src: '' },
    { scope: 'course', nombre: 'Captura de pantalla 2026.png', falta: false, tipo: 'imagen', src: 'x' },
  ];
  ['guia', 'GUIA', 'guía', 'GUÍA', 'ia de est'].forEach(function (q) {
    eq(P.candidatos(inv, q).length, 1, q);
    eq(P.candidatos(inv, q)[0].nombre, 'Guía de estilo ACADEMIA.pdf', q);
  });
  eq(P.candidatos(inv, 'PANTALLA')[0].nombre, 'Captura de pantalla 2026.png');
  eq(P.candidatos(inv, 'zzz').length, 0);
});

test('las que el disco no tiene aparecen, marcadas', function () {
  // Esconderlas es peor: el editor sabe que agregó ese archivo, no lo vería en la
  // lista y se iría a buscar el motivo al lugar equivocado.
  const fila = P.candidatos(INV, 'paleta')[0];
  eq(fila.falta, true);
  eq(fila.etiqueta, '@paleta.png', 'sin número, porque no viaja y no ocupa ninguno');
});

test('los rótulos de ámbito son LOS MISMOS que los de la tira de referencias', function () {
  // Dos nombres para el mismo nivel a diez píxeles de distancia es peor que
  // ninguno: la tira de la ficha dice «del curso» y «de esta clase», y el menú
  // tiene que decir esas palabras y no otras.
  const refs = fs.readFileSync(path.join(CEP, 'refs-view.js'), 'utf8');
  has(refs, '"del curso"');
  has(refs, '"de esta clase"');
  eq(P.rotulo('course'), 'del curso');
  eq(P.rotulo('sequence'), 'de esta clase');
  eq(P.rotulo('marker'), 'de este marcador');
});

// ── 11.c El menú, con el campo montado ───────────────────────────────

test('escribir `@` abre el menú con las referencias agrupadas', function () {
  const c = campo();
  tipear(c, 'copiá @');
  const m = menu(c);
  ok(m.abierto);
  eq(m.escondido, 'false');
  eq(m.filas.length, 6, 'las seis referencias del pedido');
  deepEq(m.rotulos, ['de este marcador', 'del curso', 'de esta clase'],
    'un rótulo por ámbito, en el orden del pedido');
  eq(m.filas[0].querySelectorAll('.hp-arroba-num')[0].textContent, '@Imagen_1');
  eq(m.filas[0].querySelectorAll('.hp-arroba-nombre')[0].textContent, 'boceto.png');
});

test('cada fila dibuja la referencia con la MISMA función que el preview', function () {
  // Una imagen muestra su miniatura y un documento el icono de su tipo. Es la
  // decisión de `miniatura()`, una sola para los dos lugares: con dos, el día que
  // una referencia sin disco deje de tener miniatura en un lado la seguiría
  // teniendo en el otro.
  const c = campo();
  tipear(c, '@');
  const m = menu(c);
  const img = m.filas[0].querySelectorAll('.hp-arroba-mini')[0].childNodes[0];
  eq(img.tagName, 'img');
  eq(img.src, 'data:image/png;base64,AAA');
  // La cuarta fila es el documento del curso.
  const doc = m.filas[3].querySelectorAll('.hp-arroba-mini')[0].childNodes[0];
  eq(doc._icono, 'documento');
  // Y la quinta es la que el disco no tiene: el triángulo, y dicho con palabras.
  eq(m.filas[4].querySelectorAll('.hp-arroba-mini')[0].childNodes[0]._icono, 'falta');
  eq(m.filas[4].querySelectorAll('.hp-arroba-falta')[0].textContent, 'no está en el disco');
});

test('tecleando después del `@` la lista se filtra', function () {
  const c = campo();
  tipear(c, 'copiá @man');
  const m = menu(c);
  eq(m.consulta, 'man');
  eq(m.filas.length, 1);
  deepEq(m.etiquetas, ['@Imagen_3 manual-de-marca-nova.png']);
});

test('con referencias adjuntas y nada que coincida, el menú se CIERRA', function () {
  // Lo que se está escribiendo después del `@` ya no es el nombre de ningún
  // archivo, así que un menú abierto sólo le tapa el texto.
  const c = campo();
  tipear(c, 'escribile a @zzzz');
  eq(menu(c).abierto, false);
});

test('las flechas mueven la selección, y dan la vuelta', function () {
  const c = campo();
  tipear(c, '@');
  eq(menu(c).sel, 0, 'arranca en la primera');
  c.el.disparar('keydown', { key: 'ArrowDown' });
  eq(menu(c).sel, 1);
  c.el.disparar('keydown', { key: 'ArrowUp' });
  c.el.disparar('keydown', { key: 'ArrowUp' });
  eq(menu(c).sel, 5, 'para arriba desde la primera cae en la última');
  c.el.disparar('keydown', { key: 'ArrowDown' });
  eq(menu(c).sel, 0);
});

test('el keyup de la flecha NO devuelve la selección al principio', function () {
  // El navegador manda `keydown` y después `keyup`, y en el `keyup` el campo
  // vuelve a preguntar si corresponde tener el menú abierto. Si esa revisión
  // redibujara, la flecha movería la selección y el keyup la traería de vuelta:
  // el menú se vería clavado en la primera fila.
  const c = campo();
  tipear(c, '@');
  c.el.disparar('keydown', { key: 'ArrowDown' });
  c.el.disparar('keyup', { key: 'ArrowDown' });
  eq(menu(c).sel, 1);
});

test('Enter elige la resaltada, deja el chip y NO mete un salto de línea', function () {
  // Es la trampa de este pedido: en un campo de prompt, un Enter que se le escapa
  // al campo mete un salto. Acá se fija que el campo no lo vea; que Chromium
  // tampoco lo meta por su cuenta se mide en `medir-chips.js`, porque hace falta
  // que esté editando de verdad.
  const c = campo();
  tipear(c, 'copiá @man');
  c.el.disparar('keydown', { key: 'Enter' });
  eq(c.el.value, 'copiá @[curso/manual-de-marca-nova.png]');
  ok(c.el.value.indexOf('\n') === -1, 'sin salto de línea');
  eq(c.el.chips().length, 1, 'y ya es un chip');
  eq(c.el.chips()[0].textContent, '@Imagen_3');
  eq(menu(c).abierto, false, 'y el menú se cerró');
});

test('el `@` y lo que se hubiera tecleado desaparecen', function () {
  const c = campo();
  tipear(c, 'la tipografía de @manual y nada más');
  // El cursor está al final, así que hay que ponerlo donde estaría de verdad:
  // justo después de lo tecleado.
  c.el.setSelectionRange('la tipografía de @manual'.length, 'la tipografía de @manual'.length);
  c.el.disparar('input');
  c.el.disparar('keydown', { key: 'Enter' });
  eq(c.el.value, 'la tipografía de @[curso/manual-de-marca-nova.png] y nada más');
});

test('Tab también elige', function () {
  const c = campo();
  tipear(c, '@boce');
  c.el.disparar('keydown', { key: 'Tab' });
  eq(c.el.value, '@[marcador/boceto.png]');
});

test('los espacios de alrededor los cuida quien ya los cuidaba', function () {
  // La inserción pasa por `HPMenciones.insertar`, el mismo camino que tocar una
  // miniatura de la tira: no hay una segunda regla de espaciado que pueda decir
  // otra cosa.
  const c = campo();
  tipear(c, 'copiá @boce');
  c.el.disparar('keydown', { key: 'Enter' });
  eq(c.el.value, 'copiá @[marcador/boceto.png]', 'un solo espacio a la izquierda');
  tipear(c, 'copiá @boce, y listo');
  c.el.setSelectionRange('copiá @boce'.length, 'copiá @boce'.length);
  c.el.disparar('input');
  c.el.disparar('keydown', { key: 'Enter' });
  eq(c.el.value, 'copiá @[marcador/boceto.png], y listo',
    'y sin espacio antes de una coma');
});

test('Escape cierra sin elegir, y lo tecleado queda como estaba', function () {
  const c = campo();
  tipear(c, 'copiá @man');
  c.el.disparar('keydown', { key: 'Escape' });
  eq(menu(c).abierto, false);
  eq(c.el.value, 'copiá @man', 'el texto no se toca: cerrar no es elegir');
  eq(c.el.chips().length, 0);
});

test('con el mouse también: un clic en la fila elige esa', function () {
  const c = campo();
  tipear(c, '@');
  menu(c).filas[2].disparar('click');
  eq(c.el.value, '@[curso/manual-de-marca-nova.png]');
  eq(menu(c).abierto, false);
});

test('el mouse mueve la MISMA selección que las flechas', function () {
  // Con dos marcas distintas, dos filas dirían a la vez que son la que va a entrar
  // con Enter.
  const c = campo();
  tipear(c, '@');
  menu(c).filas[3].disparar('mouseover');
  eq(menu(c).sel, 3);
  c.el.disparar('keydown', { key: 'Enter' });
  eq(c.el.value, '@[curso/guia.pdf]', 'entró la que el mouse había resaltado');
});

test('elegir una que el disco no tiene deja la mención con su aviso de siempre', function () {
  const c = campo();
  tipear(c, '@paleta');
  c.el.disparar('keydown', { key: 'Enter' });
  eq(c.el.value, '@[clase/paleta.png]');
  eq(c.el.chips()[0].textContent, '@paleta.png');
  has(c.el.chips()[0].className, 'is-sin-disco');
});

test('sin ninguna referencia adjunta no hay menú vacío: hay una línea que dice cómo', function () {
  // La duda real de alguien que recién abrió el panel no es cuál elegir: es de
  // dónde salen. Y son dos caminos, así que se nombran los dos.
  const c = campo([]);
  tipear(c, 'poné @');
  const m = menu(c);
  ok(m.abierto, 'el menú se abre igual: callarse sería no contestar nada');
  eq(m.filas.length, 0, 'sin ninguna fila que elegir');
  ok(m.vacio, 'y con el cartel');
  has(m.vacio.textContent, 'Arrastrá una imagen');
  has(m.vacio.textContent, 'Estilo del curso');
});

test('sobre ese cartel, las flechas y el Enter no hacen nada', function () {
  // No hay nada que navegar ni que elegir, así que el Enter vuelve a ser del campo
  // (mete su salto de línea, que es lo que corresponde ahí).
  const c = campo([]);
  tipear(c, '@');
  c.el.disparar('keydown', { key: 'ArrowDown' });
  eq(menu(c).sel, 0);
  c.el.disparar('keydown', { key: 'Enter' });
  eq(c.el.value, '@\n', 'el Enter fue del campo, como si el menú no estuviera');
});

test('mover el cursor lejos del `@` cierra el menú', function () {
  const c = campo();
  tipear(c, 'copiá @man');
  ok(menu(c).abierto);
  c.el.setSelectionRange(3, 3);
  c.el.disparar('mouseup');
  eq(menu(c).abierto, false);
});

test('con algo seleccionado no se abre: no hay un cursor donde escribir', function () {
  const c = campo();
  c.el.value = 'copiá @man';
  c.el.setSelectionRange(0, 10);
  c.el.disparar('input');
  eq(menu(c).abierto, false);
});

test('irse del campo lo cierra', function () {
  const c = campo();
  tipear(c, '@');
  ok(menu(c).abierto);
  c.el.disparar('blur');
  eq(menu(c).abierto, false);
});

test('el menú y la edición del número de un chip no pueden estar abiertos a la vez', function () {
  // Los dos son modales del campo y se comen las mismas teclas: con los dos
  // abiertos, una flecha movería la selección del menú y además escribiría en el
  // chip.
  const c = campo();
  tipear(c, '@boce');
  ok(menu(c).abierto);
  c.el.value = '@[marcador/boceto.png]';
  c.el.chips()[0].disparar('dblclick');
  eq(menu(c).abierto, false, 'abrir la edición cierra el menú');
  // Y al revés: con la edición abierta, teclear un `@` no abre el menú (las teclas
  // son del chip).
  c.el.disparar('keydown', { key: '@' });
  eq(menu(c).abierto, false);
});

test('el campo dice que tiene un menú, y cuál fila está resaltada', function () {
  // Sin esto un lector de pantalla se queda callado justo cuando apareció una lista
  // de seis opciones.
  const c = campo();
  eq(c.el.getAttribute('aria-haspopup'), 'listbox');
  eq(c.el.getAttribute('aria-expanded'), 'false');
  tipear(c, '@');
  eq(c.el.getAttribute('aria-expanded'), 'true');
  eq(c.el.getAttribute('aria-activedescendant'), menu(c).filas[0].id);
  c.el.disparar('keydown', { key: 'ArrowDown' });
  eq(c.el.getAttribute('aria-activedescendant'), menu(c).filas[1].id);
  c.el.disparar('keydown', { key: 'Escape' });
  eq(c.el.getAttribute('aria-expanded'), 'false');
});

// ── 12. Copiar un chip se lleva la MENCIÓN, no su etiqueta ───────────

test('copiar pone en el portapapeles el texto canónico', function () {
  // Sin esto, copiar un pedazo de instrucción con un chip adentro ponía
  // «@Imagen_3» en el portapapeles: pegado en el marcador de al lado le llega al
  // modelo como texto suelto, y ahí el número vuelve a ser el dato — justo lo que
  // guardar el nombre vino a evitar.
  const c = campo();
  c.el.value = 'copiá @[marcador/boceto.png] arriba';
  c.el.setSelectionRange(6, 'copiá @[marcador/boceto.png]'.length);
  let puesto = null;
  let frenado = false;
  c.el.disparar('copy', {
    clipboardData: { setData: function (tipo, v) { puesto = tipo + '|' + v; } },
    preventDefault: function () { frenado = true; },
  });
  eq(puesto, 'text/plain|@[marcador/boceto.png]');
  eq(frenado, true, 'y se queda con el evento: el portapapeles del navegador diría la etiqueta');
});

test('y lo copiado, pegado, vuelve a ser un chip', function () {
  const c = campo();
  c.el.value = 'usá ';
  c.el.setSelectionRange(4, 4);
  c.el.disparar('paste', {
    clipboardData: { getData: function () { return '@[marcador/boceto.png]'; } },
  });
  eq(c.el.value, 'usá @[marcador/boceto.png]');
  eq(c.el.chips().length, 1);
});

test('sin nada seleccionado, copiar es del navegador', function () {
  const c = campo();
  c.el.value = 'algo';
  c.el.setSelectionRange(2, 2);
  let frenado = false;
  c.el.disparar('copy', {
    clipboardData: { setData: function () {} },
    preventDefault: function () { frenado = true; },
  });
  eq(frenado, false);
});

test('cortar también se lleva el token, y borra', function () {
  const c = campo();
  c.el.value = 'copiá @[marcador/boceto.png] arriba';
  c.el.setSelectionRange(6, 'copiá @[marcador/boceto.png]'.length);
  let puesto = null;
  c.el.disparar('cut', {
    clipboardData: { setData: function (tipo, v) { puesto = v; } },
  });
  eq(puesto, '@[marcador/boceto.png]');
  // Los dos espacios que quedan son los que quedan al cortar cualquier palabra: lo
  // seleccionado era el token y nada más.
  eq(c.el.value, 'copiá  arriba');
  eq(c.el.chips().length, 0);
});
