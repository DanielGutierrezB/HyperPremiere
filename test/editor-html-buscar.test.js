'use strict';

// BUSCAR DENTRO DEL EDITOR DE HTML.
//
// Lo pidió el editor: "al editor del html, ¿podemos agregar una opción de
// buscar? La idea es poder buscar una palabra en específico". Un HTML generado
// tiene varios cientos de líneas y lo que se arregla a mano suele ser un color o
// un texto que aparece una vez; sin buscar hay que barrerlo con la vista. El ⌘F
// del navegador no sirve: CEF no lo trae, y buscaría en el panel entero.
//
// Lo que este archivo fija es la LÓGICA: cuántas encuentra, en cuál va, que dé la
// vuelta y que deje la coincidencia seleccionada —que es cómo se resalta, porque
// el editor ya tiene dos capas y meter marcas adentro del HTML de Prism sería
// reescribir su salida—. Que además SCROLLEE hasta ella no se puede medir acá (no
// hay layout): eso lo mide `/tmp`-style en el navegador, con el arnés de la
// maqueta, y está anotado en el widget.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');

/** Un DOM de mentira, lo justo para montar el editor. */
function elemento(tag) {
  const el = {
    tagName: tag, children: [], listeners: {}, style: {}, className: '',
    textContent: '', value: '', title: '', type: '', disabled: false,
    selectionStart: 0, selectionEnd: 0, scrollTop: 0, scrollLeft: 0, clientHeight: 200,
    spellcheck: true,
    appendChild: function (h) { this.children.push(h); return h; },
    setAttribute: function (k, v) { this[k] = v; },
    getAttribute: function (k) { return this[k]; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    dispatchEvent: function (e) { (this.listeners[(e && e.type) || ''] || []).forEach(function (f) { f(e); }); return true; },
    setSelectionRange: function (a, b) { this.selectionStart = a; this.selectionEnd = b; },
    focus: function () {},
    select: function () {},
    buscar: function (clase) {
      for (const h of this.children) {
        if (String(h.className || '').split(' ').indexOf(clase) !== -1) return h;
        const hit = h.buscar && h.buscar(clase);
        if (hit) return hit;
      }
      return null;
    },
  };
  el.classList = {
    add: function (c) { if (String(el.className).split(' ').indexOf(c) === -1) el.className = (el.className ? el.className + ' ' : '') + c; },
    remove: function (c) { el.className = String(el.className).split(' ').filter(function (x) { return x && x !== c; }).join(' '); },
    toggle: function (c, on) { if (on) el.classList.add(c); else el.classList.remove(c); },
    contains: function (c) { return String(el.className).split(' ').indexOf(c) !== -1; },
  };
  Object.defineProperty(el, 'innerHTML', { get: function () { return el._html || ''; }, set: function (v) { el._html = v; } });
  return el;
}

function montar() {
  const ctx = {
    console: console, String: String, Number: Number, Object: Object, Array: Array,
    Math: Math, parseFloat: parseFloat, parseInt: parseInt,
    HPUtil: { escapeHtml: function (s) { return String(s); } },
    HPIconos: { el: function (n) { const s = elemento('span'); s.className = 'hp-ico'; s._icono = n; return s; } },
    getComputedStyle: function () { return { lineHeight: '18px' }; },
    Event: function (t) { return { type: t }; },
    KeyboardEvent: function (t, o) { return Object.assign({ type: t, preventDefault: function () {} }, o || {}); },
    document: {
      createElement: elemento,
      addEventListener: function () {},
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(CEP, 'widgets.js'), 'utf8'), ctx, { filename: 'widgets.js' });
  const ed = ctx.HPWidgets.makeCodeEditor();
  const campo = ed.el.buscar('code-input');
  const barra = ed.el.buscar('code-find');
  return {
    ed: ed, campo: campo, barra: barra,
    entrada: ed.el.buscar('code-find-input'),
    cuenta: ed.el.buscar('code-find-count'),
    /** Escribir en el buscador, como quien teclea. */
    buscar: function (q) {
      const e = ed.el.buscar('code-find-input');
      e.value = q;
      e.dispatchEvent({ type: 'input' });
    },
    /** ↵ o ⇧↵ en el buscador. */
    enter: function (shift) {
      ed.el.buscar('code-find-input').dispatchEvent({
        type: 'keydown', key: 'Enter', shiftKey: !!shift, preventDefault: function () {},
      });
    },
    seleccionado: function () { return campo.value.slice(campo.selectionStart, campo.selectionEnd); },
  };
}

const HTML = '<div class="titulo">uno</div>\n<p>nada</p>\n<div class="titulo">dos</div>\n<span>TITULO en mayúsculas</span>';

test('el editor de HTML viene con su barra de buscar', function () {
  const m = montar();
  ok(m.barra, 'la barra está');
  ok(m.entrada, 'con su campo');
  eq(m.cuenta.textContent, '', 'y sin decir nada hasta que se busque algo');
});

test('dice cuántas encontró y en cuál va', function () {
  const m = montar();
  m.ed.setValue(HTML);
  m.buscar('titulo');
  // Tres: dos en minúscula y la de mayúsculas, porque buscar código sin
  // distinguir mayúsculas es lo que uno espera.
  eq(m.cuenta.textContent, '1 de 3');
});

test('la coincidencia queda SELECCIONADA, que es cómo se resalta', function () {
  const m = montar();
  m.ed.setValue(HTML);
  m.buscar('titulo');
  eq(m.seleccionado(), 'titulo', 'la primera');
  eq(m.campo.selectionStart, HTML.indexOf('titulo'), 'y en el lugar que corresponde');
});

test('↵ avanza y ⇧↵ retrocede, dando la vuelta en las dos puntas', function () {
  const m = montar();
  m.ed.setValue(HTML);
  m.buscar('titulo');
  m.enter();
  eq(m.cuenta.textContent, '2 de 3');
  m.enter();
  eq(m.cuenta.textContent, '3 de 3');
  m.enter();
  eq(m.cuenta.textContent, '1 de 3', 'de la última vuelve a la primera');
  m.enter(true);
  eq(m.cuenta.textContent, '3 de 3', 'y para atrás, igual');
});

test('lo dice cuando esa palabra no está, sin pintarlo de error', function () {
  const m = montar();
  m.ed.setValue(HTML);
  m.buscar('zzz');
  eq(m.cuenta.textContent, 'sin resultados');
  ok(m.barra.classList.contains('sin-nada'), 'se marca para poder apagarle el color');
  // Que una palabra no esté no es un error del panel ni un aviso: es la
  // respuesta. Por eso la clase es `sin-nada` y no `is-error`.
  ok(!m.barra.classList.contains('is-error'), 'y NO como un error');
});

test('borrar lo buscado deja la barra callada', function () {
  const m = montar();
  m.ed.setValue(HTML);
  m.buscar('titulo');
  m.buscar('');
  eq(m.cuenta.textContent, '', 'sin cuenta y sin «sin resultados»');
});

test('las coincidencias se recuentan al editar el HTML', function () {
  // Si no, la cuenta miente en cuanto uno arregla lo que vino a arreglar — que es
  // justo lo que se hace después de encontrarlo.
  const m = montar();
  m.ed.setValue(HTML);
  m.buscar('titulo');
  eq(m.cuenta.textContent, '1 de 3');
  m.campo.value = HTML + '\n<div class="titulo">tres</div>';
  m.campo.dispatchEvent({ type: 'input' });
  has(m.cuenta.textContent, 'de 4', 'la cuenta siguió al texto: ' + m.cuenta.textContent);
});

test('los botones de ir y venir están apagados mientras no haya a dónde ir', function () {
  const m = montar();
  m.ed.setValue('<p>una sola vez: titulo</p>');
  m.buscar('titulo');
  eq(m.cuenta.textContent, '1 de 1');
  const arriba = m.ed.el.buscar('code-find-btn');
  eq(arriba.disabled, true, 'con una sola coincidencia no hay anterior ni siguiente');
});

test('buscar no toca el HTML', function () {
  // El buscador es de lectura: lo único que mueve es el cursor.
  const m = montar();
  m.ed.setValue(HTML);
  m.buscar('titulo');
  m.enter();
  eq(m.ed.getValue(), HTML);
});
