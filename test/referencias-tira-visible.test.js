'use strict';

// LA TIRA DE UN BLOQUE DE ESTILO SE DESTAPA CUANDO LE APARECE MATERIAL.
//
// El bug, tal como lo reportó el editor: "al darle captura en el área de Estilo
// del curso como de secuencia, no aparecen", y después de mirar el disco: "sí los
// trae pero no aparecen en sus interfaces".
//
// La tira se esconde cuando no tiene nada (`.hp-tira[data-vacia="true"]`) y esa
// marca se calculaba UNA vez, al montar la ficha. Pero hay dos maneras de que la
// tira cambie y sólo una pasa por ahí: la ficha la redibuja entera, y los DUEÑOS
// del material —`HPStills` para lo de un marcador, `HPRefsView` para los dos
// niveles generales— escriben adentro por su cuenta cuando se captura un cuadro o
// se suelta un archivo. Esos no la redibujan: la actualizan.
//
// Resultado: la referencia se guardaba de verdad —la insignia del bloque hasta la
// contaba— y la miniatura quedaba en el DOM adentro de un contenedor con
// `display: none`. En los dos bloques de estilo es donde más se nota, porque ahí
// la tira suele arrancar vacía.
//
// Lo que se fija acá es el aviso: que `HPRefsView`, cuando cambia el material de
// un nivel, le diga a las fichas abiertas que se repinten. Que el repintado
// destape la tira lo fija `cola-mirar-y-rehacer`; que la ficha sepa repintar,
// `menciones-campo`.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');

function elemento(tag) {
  const el = {
    tagName: tag, children: [], listeners: {}, style: {}, className: '',
    textContent: '', value: '', title: '', type: '', disabled: false,
    appendChild: function (h) { this.children.push(h); return h; },
    removeChild: function (h) { this.children = this.children.filter(function (x) { return x !== h; }); },
    setAttribute: function (k, v) { this[k] = v; },
    getAttribute: function (k) { return this[k]; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
  };
  el.classList = {
    add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; },
  };
  Object.defineProperty(el, 'innerHTML', { get: function () { return ''; }, set: function () { el.children.length = 0; } });
  return el;
}

/** `HPRefsView` montado, con lo mínimo alrededor y un espía en el repintado. */
function montar() {
  const espia = { repintados: 0, cambios: 0, agregadas: [] };
  const guardadas = { course: [], sequence: [] };

  const ctx = {
    console: console, String: String, Number: Number, Object: Object, Array: Array,
    Math: Math, JSON: JSON, Promise: Promise, setTimeout: setTimeout,
    FileReader: function () {
      const self = this;
      this.readAsDataURL = function () {
        self.result = 'data:image/png;base64,AAAA';
        setTimeout(function () { self.onload(); }, 0);
      };
    },
    document: { createElement: elemento, addEventListener: function () {} },
    HPLog: { log: function () {} },
    HPUtil: { escapeHtml: function (s) { return String(s); }, shortenMiddle: function (s) { return s; } },
    HPIconos: { el: function () { return elemento('span'); } },
    // La fuente del `<img>` de una miniatura la decide `HPStills`: es el que sabe
    // que las del marcador son data URLs y las de los dos niveles son rutas que en
    // Windows hay que convertir a `file:///C:/…`.
    HPStills: { fuenteDeMiniatura: function (v) { return String(v); }, stillThumbSrc: function (v) { return String(v); } },
    // La ficha: lo único que interesa es si le avisan.
    HPPromptCard: {
      botonIcono: function () { return elemento('button'); },
      repintarTodas: function () { espia.repintados++; },
    },
    HPRefs: {
      state: function () { return { course: guardadas.course, sequence: guardadas.sequence }; },
      add: function (p, s, scope, ref) {
        espia.agregadas.push({ scope: scope, ref: ref });
        guardadas[scope].push({ fileName: ref.name || 'x.png', name: ref.name || 'x.png', kind: 'image', file: 'data:image/png;base64,AAAA' });
        return Promise.resolve();
      },
    },
    HPEngine: { call: function () { return Promise.resolve({ ok: true }); } },
    HPHost: { captureProgramFrame: function (p, cb) { cb('ok|' + p); } },
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(CEP, 'refs-view.js'), 'utf8'), ctx, { filename: 'refs-view.js' });
  ctx.HPRefsView.init({
    context: function () { return { projectPath: '/p/Curso.prproj', sequenceName: 'Clase 12' }; },
    onChanged: function () { espia.cambios++; },
  });
  return { ctx: ctx, espia: espia };
}

test('soltar un archivo en un bloque de estilo avisa a las fichas abiertas', async function () {
  const m = montar();
  const caja = m.ctx.HPRefsView.createControl('course');
  caja._status = elemento('div');

  m.ctx.HPRefsView.ingerir(caja, [{ name: 'logo.png', type: 'image/png' }]);
  // La ingesta es una cadena de promesas con una lectura de archivo adentro.
  await new Promise(function (r) { setTimeout(r, 30); });

  eq(m.espia.agregadas.length, 1, 'la referencia se guardó');
  ok(m.espia.repintados > 0,
    'y se avisó a las fichas: sin esto la tira que arrancó vacía se queda escondida');
});

test('el aviso va además del de siempre, no en su lugar', function () {
  // `onChanged` refresca las insignias de los dos bloques y existía desde antes.
  // El repintado de las fichas es OTRA cosa y se suma: si uno reemplazara al
  // otro, la insignia contaría el material que la tira no muestra — que es
  // exactamente lo que vio el editor.
  const m = montar();
  const caja = m.ctx.HPRefsView.createControl('sequence');
  caja._status = elemento('div');
  m.ctx.HPRefsView.refresh(caja);
  eq(m.espia.repintados, 0, 'un refresco a secas no es un cambio de material');
});
