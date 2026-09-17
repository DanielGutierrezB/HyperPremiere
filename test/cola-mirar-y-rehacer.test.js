'use strict';

// Tres cosas de la Cola que el editor pidió después de usarla en serio:
//
//   1. Clic en el nombre = ir a verlo al timeline, y nada más. Antes ese clic se
//      llevaba al panel entero a la pestaña Marcadores y recargaba la secuencia:
//      un viaje de ida por mirar un clip de cinco segundos.
//   2. "Regenerar desde cero" dentro de la caja de feedback, como en la tarjeta
//      del marcador. Había un solo botón que refinaba o rediseñaba según si el
//      cuadro tenía texto, y para lo segundo había que irse a Marcadores.
//   3. "Ver solo esta secuencia": la cola junta varias clases a propósito, pero
//      cuando estás sentado en una, lo de las otras es ruido.
//
// Se dibuja la cola de verdad (queue-view sobre un DOM de mentira) y se aprieta
// lo que apretaría el editor: lo que se prueba es el cableado.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');

function elemento(tag) {
  const el = {
    tagName: tag, children: [], listeners: {}, style: {}, className: '',
    textContent: '', value: '', title: '', type: '', rows: 0, checked: false, childNodes: [],
    appendChild: function (h) { this.children.push(h); this.childNodes.push(h); return h; },
    setAttribute: function (k, v) { this[k] = v; },
    getAttribute: function (k) { return this[k]; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    click: function () { (this.listeners.click || []).forEach(function (f) { f({ stopPropagation: function () {} }); }); },
    change: function () { (this.listeners.change || []).forEach(function (f) { f({}); }); },
    /**
     * `querySelector` de mentira, pero de verdad: entiende una lista de clases
     * separadas por coma (`.still-thumb, .resource-chip`), que es la única forma
     * que el panel usa contra la tira.
     *
     * Era un stub que devolvía `null` siempre, y eso hacía INVISIBLE para los
     * tests al código que pregunta "¿la tira tiene algo?" — que es justo donde
     * estaba el bug de la tira que no se destapaba. Un stub que contesta que no
     * hay nada es peor que no tenerlo: el test pasa y no mide.
     */
    querySelector: function (sel) {
      const clases = String(sel || '').split(',')
        .map(function (s) { return s.trim().replace(/^\./, ''); })
        .filter(Boolean);
      for (const c of clases) {
        const hit = this.buscar && this.buscar(c);
        if (hit) return hit;
      }
      return null;
    },
    querySelectorAll: function () { return []; },
    buscar: function (clase) {
      for (const h of this.children) {
        if (String(h.className || "").split(" ").indexOf(clase) !== -1) return h;
        const hit = h.buscar && h.buscar(clase);
        if (hit) return hit;
      }
      return null;
    },
    porTexto: function (texto) {
      for (const h of this.children) {
        if (String(h.textContent).indexOf(texto) >= 0) return h;
        const hit = h.porTexto && h.porTexto(texto);
        if (hit) return hit;
      }
      return null;
    },
    texto: function () {
      let t = String(this.textContent || '');
      for (const h of this.children) if (h.texto) t += ' ' + h.texto();
      return t;
    },
  };
  el.classList = {
    add: function (c) { el.className = (el.className ? el.className + ' ' : '') + c; },
    remove: function () {},
  };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return ''; },
    set: function () { el.children.length = 0; el.childNodes.length = 0; },
  });
  return el;
}

/**
 * Dibuja la cola con `jobs`. `opts.secuenciaAbierta` es la que el panel cree
 * abierta (la del filtro); `opts.recordado` simula la preferencia guardada de
 * una sesión anterior.
 */
function dibujar(jobs, opts) {
  opts = opts || {};
  const nodos = {
    'queue-panel': elemento('div'),
    'view-queue': elemento('div'),
    'tab-queue-count': elemento('span'),
  };
  const guardado = {};
  if (opts.recordado) guardado['hyperpremiere::queue-only-current'] = '1';
  const espia = {
    timeline: [], aMarcadores: [], regenerados: [], desdeCero: [],
    salidas: [], confirmaciones: [], limpiados: [],
  };
  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Object: Object, Array: Array, isNaN: isNaN, parseInt: parseInt, Set: Set,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: function () { return 0; }, clearInterval: function () {},
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(guardado, k) ? guardado[k] : null; },
      setItem: function (k, v) { guardado[k] = String(v); },
    },
    HPLog: { log: function () {} },
    HPWidgets: {
      // El overlay de confirmación: se anota (con lo que le escribe adentro, que
      // es lo que el editor lee antes de decidir) y el "sí" se ejecuta solo si
      // el test lo pide, que es como se distingue avisar de hacer.
      confirmOverlay: function (titulo, armarCuerpo, boton, onOk) {
        const body = elemento('div');
        if (armarCuerpo) armarCuerpo(body);
        espia.confirmaciones.push({
          titulo: titulo, boton: boton, cuerpo: body.texto(), aceptar: onOk,
        });
      },
    },
    HPEngine: { call: function () { return Promise.resolve({ ok: true }); } },
    HPStills: {
      fbInit: function () {}, fbClear: function () {}, fbCollect: function () { return [0]; },
      // La tira de referencias de la ronda, que desde la 1.6.x es la misma que la
      // de una ficha de marcador (`crearTira`, no la caja completa de antes).
      crearTira: function () {
        const el = elemento('div'); el.className = 'hp-tira-propia';
        return { el: el, estado: elemento('div'), refrescar: function () {}, cuantasImagenes: function () { return 0; } };
      },
      // El inventario que mira el resaltado de menciones. Vacío: lo que se fija
      // acá es el cableado, y el inventario tiene sus propios tests.
      inventario: function () { return []; },
      capturar: function () {}, ingerir: function () {},
    },
    HPQueue: {
      jobs: function () { return jobs; },
      isPending: function (s) { return s === 'queued' || s === 'modeling' || s === 'ready' || s === 'running'; },
      isActive: function (s) { return s === 'modeling' || s === 'ready' || s === 'running'; },
      isPaused: function () { return false; },
      hasActive: function () { return false; },
      hasQueued: function () { return false; },
      needsPlacing: function () { return false; },
      regenerate: function (id, texto, idx) { espia.regenerados.push({ id: id, texto: texto, idx: idx }); },
      regenerateFresh: function (id) { espia.desdeCero.push(id); },
      // El estimado del pie no se arma con `j.payload`: la cola contesta cómo va
      // a viajar ese payload (con el material y los niveles del estilo puestos).
      payloadForEstimate: function (j) { return Promise.resolve(j.payload || {}); },
      timing: { calibrated: function () { return true; }, estimateSec: function () { return 0; } },
    },
    document: {
      createElement: elemento,
      createTextNode: function (t) { const n = elemento('#text'); n.textContent = t; return n; },
      getElementById: function (id) { return nodos[id] || null; },
    },
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  // `menciones.js`, `campo.js` y `prompt-card.js` entran desde la 1.6.x: la ronda
  // de feedback es el cuerpo de ficha compartido, con su campo de chips y su barra
  // de controles. Los tres son reales, no dobles: es justo lo que se vino a
  // compartir.
  for (const f of ['util.js', 'iconos.js', 'menciones.js', 'campo.js', 'prompt-card.js', 'queue-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  ctx.HPQueueView.init({
    goToJobMarker: function (job, abrirEditor) { espia.aMarcadores.push({ job: job, abrirEditor: abrirEditor }); },
    showJobInTimeline: function (job) { espia.timeline.push(job); },
    currentSequence: function () { return opts.secuenciaAbierta || ''; },
    setOutput: function (txt, esError) { espia.salidas.push({ txt: txt, esError: esError }); },
    preparingSequence: function () { return null; },
    sequenceContext: function () { return null; },
  });
  ctx.HPQueueView.render(jobs);
  return {
    ctx: ctx, panel: nodos['queue-panel'], espia: espia, guardado: guardado,
    render: function () { ctx.HPQueueView.render(jobs); },
  };
}

function terminado(extra) {
  return Object.assign({
    id: 'j1', status: 'done', kind: 'feedback', label: 'Marcador 1 (corrección)',
    seqName: 'Clase 23', projectPath: '/p/Clases.prproj', markerKey: 'Marcador 1',
    markerStart: 128.5, markerDuration: 8, version: 4, msg: 'Listo y colocado',
  }, extra);
}

function abrirFeedback(d) {
  const btn = d.panel.porTexto('Feedback');
  ok(btn, 'el job terminado ofrece dar feedback');
  btn.click();
  return d.panel;
}

// ── 1. Clic en el nombre: al timeline y nada más ─────────────────────

test('el nombre lleva al timeline, sin arrastrar el panel a otra pestaña', function () {
  const d = dibujar([terminado()]);
  const nombre = d.panel.porTexto('Marcador 1 (corrección)');
  ok(nombre, 'el nombre está');
  nombre.click();

  eq(d.espia.timeline.length, 1, 'se fue a verlo al timeline');
  eq(d.espia.timeline[0].markerStart, 128.5, 'al segundo donde está el recurso');
  eq(d.espia.aMarcadores.length, 0, 'y NO se cambió de pestaña ni se recargó la secuencia');
  has(nombre.title, 'timeline', 'lo que promete el tooltip es lo que hace');
});

test('a Marcadores se sigue llegando por “Editar HTML”, que sí lo necesita', function () {
  const d = dibujar([terminado()]);
  d.panel.porTexto('Editar HTML').click();
  eq(d.espia.aMarcadores.length, 1);
  eq(d.espia.aMarcadores[0].abrirEditor, true, 'y con el editor abierto');
  eq(d.espia.timeline.length, 0);
});

// ── 2. Refinar y regenerar desde cero, las dos ahí mismo ─────────────

test('la caja de feedback ofrece las dos salidas', function () {
  const d = dibujar([terminado()]);
  abrirFeedback(d);
  ok(d.panel.porTexto('Aplicar el ajuste'), 'refinar sobre lo que hay');
  ok(d.panel.porTexto('Regenerar desde cero'), 'o tirarlo y rediseñar');
});

/**
 * Escribe en el campo de la ronda como escribe el editor: se le pone el texto y
 * después se emite el `input`, que es el orden del navegador.
 *
 * Antes alcanzaba con emitir el evento con un `target` de mentira, porque el
 * handler leía `e.target.value`. Ya no: el campo es un `contenteditable` con chips
 * (cep/js/campo.js) y su `value` sale de serializar lo que tiene adentro, así que
 * el texto tiene que estar EN el campo. Que el test tenga que ponerlo ahí es lo
 * correcto: es lo que pasa de verdad.
 */
function escribir(d, texto) {
  const campo = d.panel.buscar('qj-fb-input');
  campo.value = texto;
  campo.listeners.input.forEach(function (f) { f({}); });
  return campo;
}

test('refinar manda el texto y las imágenes que quedaron activas', function () {
  const d = dibujar([terminado()]);
  abrirFeedback(d);
  escribir(d, 'subí el título');
  d.panel.porTexto('Aplicar el ajuste').click();

  eq(d.espia.regenerados.length, 1);
  eq(d.espia.regenerados[0].texto, 'subí el título');
  eq(JSON.stringify(d.espia.regenerados[0].idx), '[0]', 'las que el editor dejó en 📤');
  eq(d.espia.desdeCero.length, 0);
});

test('refinar sin escribir nada avisa, en vez de rediseñar por su cuenta', function () {
  // Era lo que pasaba antes: el cuadro vacío y el mismo botón hacía una
  // regeneración total. El editor se enteraba al ver el resultado.
  const d = dibujar([terminado()]);
  abrirFeedback(d);
  d.panel.porTexto('Aplicar el ajuste').click();

  eq(d.espia.regenerados.length, 0, 'no se encoló nada');
  eq(d.espia.desdeCero.length, 0);
  eq(d.espia.salidas.length, 1);
  has(d.espia.salidas[0].txt, 'Escribí qué ajustar');
  eq(d.espia.salidas[0].esError, true);
});

test('desde cero pregunta siempre: está pegado a Refinar y se le apunta mal', function () {
  const d = dibujar([terminado()]);
  abrirFeedback(d);
  d.panel.porTexto('Regenerar desde cero').click();

  eq(d.espia.desdeCero.length, 0, 'un clic no arranca nada');
  eq(d.espia.confirmaciones.length, 1);
  has(d.espia.confirmaciones[0].cuerpo, '¿Seguro querés generar esta animación desde cero?');
  d.espia.confirmaciones[0].aceptar();
  eq(d.espia.desdeCero.length, 1, 'recién con el sí');
  eq(d.espia.desdeCero[0], 'j1');
  eq(d.espia.regenerados.length, 0, 'y no es un refinamiento disfrazado');
});

test('con feedback escrito, la confirmación avisa que ese texto no se usa', function () {
  const d = dibujar([terminado()]);
  abrirFeedback(d);
  escribir(d, 'el fondo tapa el texto');
  d.panel.porTexto('Regenerar desde cero').click();

  has(d.espia.confirmaciones[0].cuerpo, 'NO se usa');
  has(d.espia.confirmaciones[0].cuerpo, 'Aplicar el ajuste', 'y dice cuál es el botón que sí lo usa');
});

// Los dos botones estaban AL COSTADO del campo, en dos columnas altas y
// angostas, y el campo se quedaba con lo que sobraba: 137 px con el panel en 400
// y 57 px en 320, medido en la maqueta. Desde la 1.6.x la ronda ES el cuerpo de
// ficha compartido, así que el campo se lleva el ancho entero por estructura —no
// comparte renglón con nada— y las dos salidas viven en el PIE de la ficha, el
// mismo lugar y la misma regla que en la ficha de un marcador.
// Lo que se puede fijar acá es la ESTRUCTURA (qué nodo cuelga de cuál y en qué
// orden); el tamaño y el color se fijan leyendo el CSS, en
// panel-caja-feedback.test.js, porque este DOM de mentira no tiene layout.

test('el campo de la ronda es el campo de una ficha, y está solo en su caja', function () {
  const d = dibujar([terminado()]);
  abrirFeedback(d);
  const envoltorio = d.panel.buscar('hp-campo');
  ok(envoltorio, 'el campo vive en el envoltorio de la ficha');
  // El campo y nada más: ningún botón le come ancho. Hubo un ESPEJO de resaltado
  // acá adentro —un `<div>` detrás pintando el mismo texto con las menciones en
  // `<span>`— y se fue con los chips: un chip muestra `@Imagen_1` donde el texto
  // guardado tiene 38 caracteres, así que no hay nada que alinear.
  eq(envoltorio.children.map(function (c) { return c.className; }).join(' | '),
    'qj-fb-input hp-campo-input',
    'el campo solo; nada que le pelee el ancho');
});

test('las dos salidas van en el pie de la ficha, y el ajuste a la derecha', function () {
  const d = dibujar([terminado()]);
  abrirFeedback(d);
  const pie = d.panel.buscar('hp-acciones');
  ok(pie, 'la ronda tiene el mismo pie que la ficha de un marcador');
  // A la izquierda lo que descarta trabajo hecho, a la derecha lo que se aprieta
  // todos los días: es la regla del pie, y acá se cumple igual que allá.
  eq(pie.buscar('hp-acciones-izq').children.map(function (b) { return b.textContent; }).join(),
    'Regenerar desde cero', 'lo destructivo, lejos del dedo');
  // El rótulo se fija acá a propósito: NO puede volver a decir "Refinar". El
  // ✨ Refinar del dictado queda a seis píxeles y reescribe el texto del pedido,
  // no la animación; dos botones con la misma palabra pegados era una trampa.
  eq(pie.buscar('hp-acciones-der').children.map(function (b) { return b.textContent; }).join(),
    'Aplicar el ajuste', 'y la de todos los días en el vértice');
});

test('la ronda trae los chips de mención, que antes no tenía', function () {
  // El motor ya traducía las menciones del campo `adjustment` igual que las de la
  // instrucción de un marcador (ver CAMPOS_CON_MENCIONES en bridge/engine.js), así
  // que un `@[curso/logo.svg]` escrito acá viajaba traducido y el panel no lo
  // pintaba ni avisaba si quedaba colgado. Lo trae el cuerpo compartido.
  const d = dibujar([terminado()]);
  abrirFeedback(d);
  const campo = d.panel.buscar('hp-campo-input');
  ok(campo, 'el campo que pinta las menciones como chips');
  eq(campo.contenteditable, 'true', 'y es editable: acá se escribe');
  ok(d.panel.buscar('hp-aviso'), 'y el renglón que dice si alguna no apunta a nada');
});

test('el ajuste es de la familia “rehacer” y desde cero es la apagada', function () {
  // Las clases son el puente con el CSS: si cambian sin cambiar la hoja, los dos
  // botones vuelven a ser dos `.qbtn` cualquiera y se pierde la jerarquía.
  const d = dibujar([terminado()]);
  abrirFeedback(d);
  eq(d.panel.porTexto('Aplicar el ajuste').className, 'qbtn qbtn-react');
  eq(d.panel.porTexto('Regenerar desde cero').className, 'qbtn qbtn-fresh');
});

// ── 3. Ver solo esta secuencia ───────────────────────────────────────

function tresClases() {
  return [
    terminado({ id: 'j1', seqName: 'Clase 23', label: 'Marcador 1' }),
    terminado({ id: 'j2', seqName: 'Clase 24', label: 'Marcador 2' }),
    terminado({ id: 'j3', seqName: 'Clase 23', label: 'Marcador 3' }),
    terminado({ id: 'j4', seqName: 'Clase 25', label: 'Marcador 4' }),
  ];
}

test('el filtro solo se ofrece cuando hay algo de otras secuencias', function () {
  const solaClase = dibujar([terminado()], { secuenciaAbierta: 'Clase 23' });
  eq(solaClase.panel.buscar('queue-filter'), null, 'con una sola clase en la cola sería ruido');

  const varias = dibujar(tresClases(), { secuenciaAbierta: 'Clase 23' });
  ok(varias.panel.buscar('queue-filter'), 'con varias, aparece');
});

test('sin filtro se ve todo; con filtro, solo la secuencia abierta', function () {
  const d = dibujar(tresClases(), { secuenciaAbierta: 'Clase 23' });
  has(d.panel.texto(), 'Clase 24', 'de entrada están todas');

  const cb = d.panel.buscar('queue-filter').children[0];
  cb.checked = true; cb.change();

  const t = d.panel.texto();
  has(t, 'Clase 23');
  ok(t.indexOf('Clase 24') === -1, 'las otras clases no se dibujan');
  ok(t.indexOf('Clase 25') === -1);
  has(t, '2 marcador(es) de otras secuencias ocultos', 'y se dice cuántos quedaron afuera');
});

test('el filtro no toca la cola: los contadores siguen siendo de todo', function () {
  // Es lo que evita el susto de creer que se borraron los demás.
  const d = dibujar(tresClases().map(function (j, i) {
    return i ? j : Object.assign(j, { status: 'queued' });
  }), { secuenciaAbierta: 'Clase 23' });
  const cb = d.panel.buscar('queue-filter').children[0];
  cb.checked = true; cb.change();

  eq(d.ctx.HPQueue.jobs().length, 4, 'la cola sigue teniendo los cuatro');
  has(d.panel.texto(), 'en proceso/espera', 'y la cabecera cuenta sobre el total');
});

test('la preferencia se recuerda entre sesiones', function () {
  const d = dibujar(tresClases(), { secuenciaAbierta: 'Clase 23' });
  const cb = d.panel.buscar('queue-filter').children[0];
  cb.checked = true; cb.change();
  eq(d.guardado['hyperpremiere::queue-only-current'], '1', 'queda guardada');

  const otra = dibujar(tresClases(), { secuenciaAbierta: 'Clase 23', recordado: true });
  eq(otra.panel.buscar('queue-filter').children[0].checked, true, 'y vuelve marcada');
  ok(otra.panel.texto().indexOf('Clase 24') === -1, 'filtrando de una');
});

test('si no hay nada de la secuencia abierta, se dice en vez de quedar en blanco', function () {
  const d = dibujar(tresClases(), { secuenciaAbierta: 'Clase 99', recordado: true });
  const t = d.panel.texto();
  has(t, 'No hay nada de “Clase 99”');
  has(t, '4 marcador(es) de otras secuencias ocultos');
  ok(d.panel.buscar('queue-filter'), 'y el filtro sigue ahí para poder destildarlo');
});

// ── El material cambia y los chips se enteran ─────────────────────────
//
// Una ficha montada se anota en `HPPromptCard` para poder repintarse cuando
// cambia la lista de referencias. Es la mitad de arriba del arreglo que pidió el
// editor —"si elimino la imagen, sigue apareciendo referenciada normal"—: la de
// abajo es que la tira avise (lo fija `feedback-imagenes`) y la del medio, que el
// campo sepa repintar (lo fija `menciones-campo`).
//
// Acá se mide que la ronda de feedback, que es una ficha como cualquier otra,
// quede anotada y se repinte cuando alguien avisa.
test('la ronda de feedback se anota para repintarse cuando cambia el material', function () {
  const d = dibujar([terminado({ id: 'j1', seqName: 'Clase 23', label: 'Marcador 1' })]);
  const antes = d.ctx.HPPromptCard._montadas();
  d.panel.porTexto('Feedback').click();
  ok(d.ctx.HPPromptCard._montadas() > antes, 'abrir la ronda monta una ficha, y queda anotada');

  // Y repintar no explota ni pierde lo escrito, que es lo único que el editor
  // notaría si esto se hiciera mal.
  const campo = d.panel.buscar('qj-fb-input');
  campo.value = 'el cartel tapa la cara del profe';
  d.ctx.HPPromptCard.repintarTodas();
  eq(campo.value, 'el cartel tapa la cara del profe', 'el texto sigue ahí después de repintar');
});

// La tira se esconde cuando no tiene nada (`.hp-tira[data-vacia="true"]`), y esa
// marca la calculaba UNA sola vez, al montar. El problema es que hay dos maneras
// de que la tira cambie y sólo una pasa por ahí: la ficha la redibuja entera,
// pero los dueños del material —`HPStills` y `HPRefsView`— escriben adentro por su
// cuenta cuando se captura un cuadro o se suelta un archivo.
//
// Con la marca vieja, el material se guardaba y la miniatura quedaba en el DOM
// adentro de un contenedor con `display: none`. Lo reportó el editor sobre los dos
// bloques de estilo, que es donde más se nota porque ahí la tira suele arrancar
// vacía: "al darle captura […] no aparecen", y después "sí los trae pero no
// aparecen en sus interfaces".
test('la tira escondida se destapa cuando le aparece material', function () {
  const d = dibujar([terminado({ id: 'j1', seqName: 'Clase 23', label: 'Marcador 1' })]);
  d.panel.porTexto('Feedback').click();

  const tira = d.panel.buscar('hp-tira');
  ok(tira, 'la ronda tiene su tira');
  eq(tira.getAttribute('data-vacia'), 'true', 'arranca vacía, o sea escondida');

  // Como cuando el 📸 guarda un cuadro: el dueño escribe adentro de la tira sin
  // volver a dibujarla.
  const propia = tira.buscar('hp-tira-propia');
  const thumb = d.ctx.document.createElement('div');
  thumb.className = 'still-thumb';
  propia.appendChild(thumb);

  d.ctx.HPPromptCard.repintarTodas();
  eq(tira.getAttribute('data-vacia'), 'false', 'y al aparecer material deja de estar escondida');
});
