'use strict';

// Mandar imágenes en una ronda de feedback, estando parado donde sea.
//
// El material de un marcador (imágenes de referencia, recursos a incrustar) se
// guarda contra SU secuencia. Mientras cada control era de la secuencia abierta
// eso no se notaba; con la cola de varias clases y las correcciones de un corte
// anterior, el editor abre la caja de feedback de un marcador de OTRA secuencia,
// y ahí hay dos maneras de fallar: no ofrecer las imágenes (lo que pasaba: un
// cartel diciendo "abrí su secuencia") o —peor— escribirlas en el marcador
// homónimo de la clase que esté abierta.
//
// Se prueba con el HPStore de verdad sobre un localStorage de mentira: el
// namespace por proyecto+secuencia es justo lo que está en juego.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');

// ── DOM mínimo ───────────────────────────────────────────────────────

function elemento(tag) {
  const el = {
    tagName: tag, children: [], listeners: {}, style: {}, classList: null,
    className: '', textContent: '', value: '', title: '', src: '', type: '',
    appendChild: function (h) { this.children.push(h); return h; },
    setAttribute: function (k, v) { this[k] = v; },
    getAttribute: function (k) { return this[k]; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    click: function () { (this.listeners.click || []).forEach(function (f) { f({ stopPropagation: function () {} }); }); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    buscar: function (clase) {
      for (const h of this.children) {
        if (h.className === clase) return h;
        const hit = h.buscar && h.buscar(clase);
        if (hit) return hit;
      }
      return null;
    },
    buscarTodos: function (clase) {
      let out = [];
      for (const h of this.children) {
        if (h.className === clase) out.push(h);
        if (h.buscarTodos) out = out.concat(h.buscarTodos(clase));
      }
      return out;
    },
    /** Texto de todo el subárbol, para buscar carteles. */
    texto: function () {
      let t = String(this.textContent || '');
      for (const h of this.children) if (h.texto) t += ' ' + h.texto();
      return t;
    },
  };
  el.classList = {
    add: function (c) { el.className = (el.className ? el.className + ' ' : '') + c; },
    remove: function (c) {
      el.className = String(el.className).split(' ').filter(function (x) { return x && x !== c; }).join(' ');
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return ''; },
    set: function () { el.children.length = 0; },
  });
  return el;
}

/** localStorage de mentira: un objeto, que es lo que HPStore necesita. */
function almacen() {
  const datos = {};
  return {
    datos: datos,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(datos, k) ? datos[k] : null; },
    setItem: function (k, v) { datos[k] = String(v); },
    removeItem: function (k) { delete datos[k]; },
  };
}

/** Panel de mentira con HPStore + HPStills de verdad. */
function montar(opts) {
  opts = opts || {};
  const espia = { capturas: [], guardados: [] };
  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Object: Object, Array: Array, isNaN: isNaN, parseInt: parseInt, RegExp: RegExp,
    Promise: Promise, setTimeout: setTimeout,
    localStorage: almacen(),
    HPLog: { log: function () {} },
    HPUtil: null, // lo define util.js
    HPHost: {
      captureProgramFrame: function (tmp, cb) { espia.capturas.push(tmp); cb('ok|' + tmp); },
    },
    HPEngine: {
      call: function (metodo, arg) {
        espia.guardados.push({ metodo: metodo, arg: arg });
        return Promise.resolve({ ok: true, savedPath: '/p/HyperPremiere/x/captura.png' });
      },
    },
    // Lector de archivos: se resuelve a mano para no depender de tiempos.
    FileReader: function () {
      const self = this;
      this.readAsDataURL = function (file) {
        self.result = 'data:image/png;base64,' + (file.name || 'x');
        self.onload();
      };
    },
    document: {
      createElement: elemento,
      getElementById: function (id) { return (opts.nodos || {})[id] || null; },
    },
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'store.js', 'stills.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  ctx.HPStills.init({ onGeneralChanged: function () {} });
  return { ctx: ctx, espia: espia };
}

/** Una imagen ya guardada en el marcador de una secuencia. */
function conImagen(ctx, seq, markerKey, ruta) {
  ctx.HPStore.withContext('/p/Clases.prproj', seq, function () {
    ctx.HPStore.addMarkerStill(markerKey, ruta);
  });
}

const OTRA = { projectPath: '/p/Clases.prproj', sequenceName: 'Clase 14' };

/** El botón 📤 de una miniatura (su clase lleva el estado pegado). */
function botonEnvio(thumb) {
  return thumb.children.filter(function (c) {
    return String(c.className).indexOf('still-send') === 0;
  })[0];
}

// ── Leer del marcador correcto ───────────────────────────────────────

test('el control muestra las imágenes de la secuencia que se le pide', function () {
  const { ctx } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14_02'); // el editor está en el corte nuevo
  conImagen(ctx, 'Clase 14', 'Marcador 3', '/ref/vieja.png');

  const control = ctx.HPStills.createControl('Marcador 3', Object.assign({ fbJobId: 'j1' }, OTRA));
  eq(control.buscar('still-thumbs').children.length, 1, 'la imagen del corte donde nació el recurso');
});

test('sin decir la secuencia, sigue siendo la abierta', function () {
  // Es el caso de siempre (tarjeta de marcador): no cambia nada.
  const { ctx } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14');
  conImagen(ctx, 'Clase 14', 'Marcador 3', '/ref/a.png');
  conImagen(ctx, 'Clase 14_02', 'Marcador 3', '/ref/b.png');

  const control = ctx.HPStills.createControl('Marcador 3');
  eq(control.buscar('still-thumbs').children.length, 1);
});

test('el marcador homónimo de la clase abierta no se mezcla', function () {
  const { ctx } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14_02');
  conImagen(ctx, 'Clase 14', 'Marcador 3', '/ref/vieja.png');
  conImagen(ctx, 'Clase 14_02', 'Marcador 3', '/ref/nueva-1.png');
  conImagen(ctx, 'Clase 14_02', 'Marcador 3', '/ref/nueva-2.png');

  const control = ctx.HPStills.createControl('Marcador 3', Object.assign({ fbJobId: 'j1' }, OTRA));
  eq(control.buscar('still-thumbs').children.length, 1, 'una, la de la secuencia pedida');
});

// ── Escribir en el marcador correcto ─────────────────────────────────

test('una imagen arrastrada se guarda en la secuencia del marcador', function () {
  const { ctx } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14_02');
  const control = ctx.HPStills.createControl('Marcador 3', Object.assign({ fbJobId: 'j1' }, OTRA));

  // El <input type=file> es el último hijo antes del estado; se dispara su change.
  const input = control.children.filter(function (c) { return c.tagName === 'input'; })[0];
  input.files = [{ name: 'logo.png', type: 'image/png' }];
  (input.listeners.change || []).forEach(function (f) { f(); });

  const enOrigen = ctx.HPStore.withContext('/p/Clases.prproj', 'Clase 14', function () {
    return ctx.HPStore.getMarkerData('Marcador 3').stills;
  });
  const enAbierta = ctx.HPStore.getMarkerData('Marcador 3').stills;
  eq(enOrigen.length, 1, 'quedó donde el motor la va a buscar al generar');
  eq(enAbierta.length, 0, 'y NO en el marcador de la clase que estaba abierta');
  eq(ctx.HPStore.getContext().sequenceName, 'Clase 14_02', 'el contexto del panel vuelve como estaba');
});

test('quitar una imagen la quita de la secuencia del marcador', function () {
  const { ctx } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14_02');
  conImagen(ctx, 'Clase 14', 'Marcador 3', '/ref/a.png');
  conImagen(ctx, 'Clase 14', 'Marcador 3', '/ref/b.png');

  const control = ctx.HPStills.createControl('Marcador 3', Object.assign({ fbJobId: 'j1' }, OTRA));
  control.buscar('still-thumbs').children[0].buscar('still-remove').click();

  const quedan = ctx.HPStore.withContext('/p/Clases.prproj', 'Clase 14', function () {
    return ctx.HPStore.getMarkerData('Marcador 3').stills;
  });
  eq(quedan.length, 1);
  has(quedan[0], 'b.png', 'se fue la que se pidió');
});

test('marcar "usar" se anota en la secuencia del marcador', function () {
  const { ctx } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14_02');
  conImagen(ctx, 'Clase 14', 'Marcador 3', '/ref/logo.png');

  const control = ctx.HPStills.createControl('Marcador 3', Object.assign({ fbJobId: 'j1' }, OTRA));
  const thumb = control.buscar('still-thumbs').children[0];
  eq(thumb.buscar('still-tag').textContent, 'referencia', 'por defecto no se incrusta');
  thumb.buscar('still-tag').click();

  const usos = ctx.HPStore.withContext('/p/Clases.prproj', 'Clase 14', function () {
    return ctx.HPStore.getMarkerData('Marcador 3').stillUse || [];
  });
  eq(usos[0], true);
});

test('la captura del programa se guarda en la carpeta del marcador', function () {
  // El frame es de lo que el editor está viendo, pero el archivo tiene que caer
  // en la carpeta de la secuencia DEL RECURSO: es ahí donde el motor lo busca.
  const { ctx, espia } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14_02');
  const control = ctx.HPStills.createControl('Marcador 3', Object.assign({ fbJobId: 'j1' }, OTRA));
  control.buscar('btn-add-still').click();

  const call = espia.guardados[0];
  eq(call.metodo, 'saveCapture');
  eq(call.arg.sequenceName, 'Clase 14');
  eq(call.arg.markerSlug, 'Marcador 3');
});

// ── Qué imágenes viajan ──────────────────────────────────────────────

test('por defecto viajan todas las del marcador pedido', function () {
  const { ctx } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14_02');
  conImagen(ctx, 'Clase 14', 'Marcador 3', '/ref/a.png');
  conImagen(ctx, 'Clase 14', 'Marcador 3', '/ref/b.png');
  conImagen(ctx, 'Clase 14_02', 'Marcador 3', '/ref/otra.png');

  ctx.HPStills.fbInit('j1');
  const idx = ctx.HPStills.fbCollect('j1', 'Marcador 3', Object.assign({}, OTRA));
  eq(JSON.stringify(idx), '[0,1]', 'las dos de la secuencia pedida, ni una de la abierta');
});

test('el 📤 apaga una imagen y esa no viaja', function () {
  const { ctx } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14_02');
  conImagen(ctx, 'Clase 14', 'Marcador 3', '/ref/a.png');
  conImagen(ctx, 'Clase 14', 'Marcador 3', '/ref/b.png');

  ctx.HPStills.fbInit('j1');
  const control = ctx.HPStills.createControl('Marcador 3', Object.assign({ fbJobId: 'j1' }, OTRA));
  const thumbs = control.buscar('still-thumbs');
  eq(botonEnvio(thumbs.children[0]).textContent, '📤 reenviar', 'arranca activa');
  botonEnvio(thumbs.children[0]).click();

  const idx = ctx.HPStills.fbCollect('j1', 'Marcador 3', Object.assign({}, OTRA));
  eq(JSON.stringify(idx), '[1]');
  const redibujada = control.buscar('still-thumbs').children[0];
  ok(/fb-off/.test(redibujada.className), 'y se ve apagada');
  eq(botonEnvio(redibujada).textContent, 'no se envía');
});
