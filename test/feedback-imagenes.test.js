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
        if (String(h.className || "").split(" ").indexOf(clase) !== -1) return h;
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
  // La MISMA lista que `children`, y acá alcanza: en el DOM de verdad la diferencia
  // es que `childNodes` también trae los nodos de texto, y eso es lo que el campo de
  // prompt recorre desde que pinta las menciones como chips (cep/js/campo.js).
  el.childNodes = el.children;
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
      // El campo de prompt arma nodos de TEXTO: desde la 1.6.x es un
      // `contenteditable` que pinta las menciones como chips, no un `<textarea>`.
      createTextNode: function (t) { const n = elemento('#text'); n.textContent = t; return n; },
      getElementById: function (id) { return (opts.nodos || {})[id] || null; },
    },
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'iconos.js', 'store.js', 'stills.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  espia.material = [];
  ctx.HPStills.init({
    onGeneralChanged: function () {},
    onMaterialChanged: function (k) { espia.material.push(k); },
  });
  return { ctx: ctx, espia: espia };
}

/** Una imagen ya guardada en el marcador de una secuencia. */
function conImagen(ctx, seq, markerKey, ruta) {
  ctx.HPStore.withContext('/p/Clases.prproj', seq, function () {
    ctx.HPStore.addMarkerStill(markerKey, ruta);
  });
}

const OTRA = { projectPath: '/p/Clases.prproj', sequenceName: 'Clase 14' };

/**
 * La TIRA de referencias de un marcador: lo que dibujan las tres pestañas desde
 * la 1.6.x. Antes acá se montaba `createControl`, que era la caja completa —con
 * su botón «📸 Capturar del programa» de ancho completo y su zona de arrastre de
 * 52 px—; esa caja ya no la usa nadie y se fue. Lo que se mide es lo mismo: qué
 * miniaturas se dibujan, de qué secuencia salen y qué pasa al tocarlas.
 */
function tiraDe(ctx, markerKey, opts) {
  return ctx.HPStills.crearTira(markerKey, opts).el;
}

/** El botón de reenvío de una miniatura (su clase lleva el estado pegado). */
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

  const control = tiraDe(ctx, 'Marcador 3', Object.assign({ fbJobId: 'j1' }, OTRA));
  eq(control.buscar('still-thumbs').children.length, 1, 'la imagen del corte donde nació el recurso');
});

test('sin decir la secuencia, sigue siendo la abierta', function () {
  // Es el caso de siempre (tarjeta de marcador): no cambia nada.
  const { ctx } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14');
  conImagen(ctx, 'Clase 14', 'Marcador 3', '/ref/a.png');
  conImagen(ctx, 'Clase 14_02', 'Marcador 3', '/ref/b.png');

  const control = tiraDe(ctx, 'Marcador 3');
  eq(control.buscar('still-thumbs').children.length, 1);
});

test('el marcador homónimo de la clase abierta no se mezcla', function () {
  const { ctx } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14_02');
  conImagen(ctx, 'Clase 14', 'Marcador 3', '/ref/vieja.png');
  conImagen(ctx, 'Clase 14_02', 'Marcador 3', '/ref/nueva-1.png');
  conImagen(ctx, 'Clase 14_02', 'Marcador 3', '/ref/nueva-2.png');

  const control = tiraDe(ctx, 'Marcador 3', Object.assign({ fbJobId: 'j1' }, OTRA));
  eq(control.buscar('still-thumbs').children.length, 1, 'una, la de la secuencia pedida');
});

// ── Escribir en el marcador correcto ─────────────────────────────────

test('una imagen arrastrada se guarda en la secuencia del marcador', async function () {
  const { ctx } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14_02');
  // Lo que se suelta sobre el CAMPO entra por acá (`soltar` de la ficha) y lo que
  // se elige con el clip también: la zona de arrastre no existe más.
  ctx.HPStills.ingerir([{ name: 'logo.png', type: 'image/png' }], 'Marcador 3',
    Object.assign({ fbJobId: 'j1' }, OTRA));
  // Desde la 1.6.0 la ingesta va DE A UNA Y EN ORDEN, con una promesa por archivo,
  // y por eso hay que esperar un turno. El motivo es el NOMBRE: es la identidad de
  // una referencia cuando la instrucción la menciona, y el desempate de dos
  // «captura.png» se resuelve contra las que ya están. Con cinco FileReader
  // sueltos, el orden en que terminan es el orden en que el disco los entrega, así
  // que soltar cinco juntas dejaba los nombres en cualquier orden.
  await new Promise(function (r) { setTimeout(r, 0); });

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

  const control = tiraDe(ctx, 'Marcador 3', Object.assign({ fbJobId: 'j1' }, OTRA));
  control.buscar('still-thumbs').children[0].buscar('still-remove').click();

  const quedan = ctx.HPStore.withContext('/p/Clases.prproj', 'Clase 14', function () {
    return ctx.HPStore.getMarkerData('Marcador 3').stills;
  });
  eq(quedan.length, 1);
  has(quedan[0], 'b.png', 'se fue la que se pidió');
});

// El bug que el editor reportó así: "si elimino la imagen, sigue apareciendo
// referenciada normal. Si la elimino de arriba debería de borrarse y corregir en
// las siguientes".
//
// Un chip guarda el NOMBRE pero muestra el NÚMERO, y el número es la posición
// entre las que viajan. Sacar la imagen 1 deja colgada a la mención que la
// nombraba y corre un lugar a todas las de atrás: si el campo no se entera, lo
// que el editor LEE deja de ser lo que el modelo RECIBE. Es el modo de falla que
// todo el mecanismo de menciones vino a matar, así que el aviso es parte del
// contrato de la tira y no un detalle de la vista.
//
// Se mide el AVISO y no el repintado porque acá no hay ficha montada; que el
// aviso repinte lo fija `panel-ficha-marcador`, y que main lo cablee, el test de
// abajo.
test('sacar o sumar material AVISA, que es de lo que dependen los números de los chips', function () {
  const { ctx, espia } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14_02');
  conImagen(ctx, 'Clase 14', 'Marcador 3', '/ref/a.png');
  conImagen(ctx, 'Clase 14', 'Marcador 3', '/ref/b.png');

  const control = tiraDe(ctx, 'Marcador 3', Object.assign({ fbJobId: 'j1' }, OTRA));
  eq(espia.material.length, 0, 'dibujar la tira no es un cambio');

  control.buscar('still-thumbs').children[0].buscar('still-remove').click();
  eq(espia.material.length, 1, 'quitar una imagen avisa');
  eq(espia.material[0], 'Marcador 3', 'y dice de qué marcador');

  // Pasar a ✓ usar también mueve la cuenta: cambia lo que se incrusta.
  control.buscar('still-thumbs').children[0].buscar('still-tag').click();
  eq(espia.material.length, 2, 'marcar «usar» también avisa');
});

test('quitar un DOCUMENTO avisa igual que quitar una imagen', function () {
  // Éste no avisaba ni siquiera al nivel general: el renglón de abajo cuenta los
  // documentos y el prompt los nombra, así que sacarlos también mueve lo que el
  // campo tiene que decir.
  const { ctx, espia } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14_02');
  ctx.HPStore.withContext('/p/Clases.prproj', 'Clase 14', function () {
    ctx.HPStore.addMarkerResource('Marcador 3', { name: 'guia.pdf', dataUrl: 'data:application/pdf;base64,QQ==' });
  });

  const control = tiraDe(ctx, 'Marcador 3', Object.assign({ fbJobId: 'j1' }, OTRA));
  const chip = control.buscar('resource-list').children[0];
  ok(chip, 'el documento está en la tira');
  chip.buscar('resource-remove').click();
  eq(espia.material.length, 1, 'quitar un documento avisa');
});

test('marcar "usar" se anota en la secuencia del marcador', function () {
  const { ctx } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14_02');
  conImagen(ctx, 'Clase 14', 'Marcador 3', '/ref/logo.png');

  const control = tiraDe(ctx, 'Marcador 3', Object.assign({ fbJobId: 'j1' }, OTRA));
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
  // El 📸 es un botón de la barra de controles de la ficha y llama acá: el botón
  // de ancho completo que vivía adentro de la caja de imágenes ya no existe.
  ctx.HPStills.capturar('Marcador 3', Object.assign({ fbJobId: 'j1' }, OTRA),
    elemento('button'), elemento('div'));

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

test('el toggle de reenvío apaga una imagen y esa no viaja', function () {
  const { ctx } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14_02');
  conImagen(ctx, 'Clase 14', 'Marcador 3', '/ref/a.png');
  conImagen(ctx, 'Clase 14', 'Marcador 3', '/ref/b.png');

  ctx.HPStills.fbInit('j1');
  const control = tiraDe(ctx, 'Marcador 3', Object.assign({ fbJobId: 'j1' }, OTRA));
  const thumbs = control.buscar('still-thumbs');
  // El 📤 pasó a ser un icono de trazo (ver cep/js/iconos.js); la etiqueta es la
  // misma palabra y el `textContent` de un botón sigue siendo su etiqueta, porque
  // un `<svg>` no aporta texto.
  eq(botonEnvio(thumbs.children[0]).textContent, 'reenviar', 'arranca activa');
  botonEnvio(thumbs.children[0]).click();

  const idx = ctx.HPStills.fbCollect('j1', 'Marcador 3', Object.assign({}, OTRA));
  eq(JSON.stringify(idx), '[1]');
  const redibujada = control.buscar('still-thumbs').children[0];
  ok(/fb-off/.test(redibujada.className), 'y se ve apagada');
  eq(botonEnvio(redibujada).textContent, 'no se envía');
});

// ── El inventario que miran los chips del campo ───────────────────────
//
// Lo consumen los TRES lugares donde se le escribe al modelo sobre un marcador
// —su ficha, esta ronda de feedback y la fila de Corrections— más los dos bloques
// de estilo, y tiene que salir de un solo lugar: de ahí sale el número de cada
// chip, su estado y la miniatura de su hover. Si cada vista armara su fila, el
// chip de un bloque de estilo podría numerar distinto que el de la ficha de un
// marcador sobre la misma referencia.

test('el inventario DICE de qué tipo es cada referencia, no lo deja adivinar', function () {
  // Antes se deducía de la extensión del nombre allá donde hacía falta, y
  // alcanzaba mientras la única pregunta era numerar. Con los chips hay que
  // decidir además si el hover muestra una miniatura o el icono de un documento, y
  // una imagen llamada «captura.pdf.png» no puede quedar del lado equivocado por
  // un regex. Acá se sabe sin adivinar: son dos listas distintas.
  const { ctx } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14');
  ctx.HPStore.addMarkerStill('Marcador 3', '/ref/captura.pdf.png', 'captura.pdf.png');
  ctx.HPStore.addMarkerResource('Marcador 3', { name: 'guia', dataUrl: 'data:text/plain,x' });

  const inv = ctx.HPStills.inventario('Marcador 3');
  eq(inv.length, 2);
  eq(inv[0].tipo, 'imagen', 'el `.pdf` del medio no la vuelve un documento');
  eq(inv[1].tipo, 'documento', 'y un documento sin extensión sigue siéndolo');
});

test('y trae de dónde sale la miniatura del hover, ya convertida', function () {
  // Las del marcador son data URLs y las de los dos niveles generales son rutas en
  // disco; en Windows una ruta hay que CONVERTIRLA a `file:///C:/…`, no
  // concatenarla. El inventario la trae hecha, por la misma función que las
  // miniaturas de la tira: si el preview del chip armara la URL por su cuenta, en
  // Windows se vería una y no la otra.
  const { ctx } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14');
  ctx.HPStore.addMarkerStill('Marcador 3', 'data:image/png;base64,AAA', 'pegada.png');
  ctx.HPStore.addMarkerStill('Marcador 3', 'C:\\Users\\ed\\captura.png', 'captura.png');

  const inv = ctx.HPStills.inventario('Marcador 3');
  eq(inv[0].src, 'data:image/png;base64,AAA', 'una data URL va tal cual');
  eq(inv[1].src, 'file:///C:/Users/ed/captura.png', 'y una ruta de Windows convertida');
  eq(inv[0].src, ctx.HPStills.stillThumbSrc('data:image/png;base64,AAA'),
    'y sale de la misma función que la miniatura de la tira');
});

test('un documento no trae miniatura: el hover muestra el icono de su tipo', function () {
  const { ctx } = montar();
  ctx.HPStore.setContext('/p/Clases.prproj', 'Clase 14');
  ctx.HPStore.addMarkerResource('Marcador 3', { name: 'manual.pdf', dataUrl: 'data:application/pdf,x' });
  eq(ctx.HPStills.inventario('Marcador 3')[0].src, '');
});
