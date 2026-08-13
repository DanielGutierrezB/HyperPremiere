'use strict';

// Las pestañas del panel (cep/js/tabs.js).
//
// Mientras fueron dos, conmutar era un booleano ("¿es la Cola?"). Al aparecer
// Corrections eso deja la vista vieja encima de la nueva: apretás Corrections y
// seguís viendo la Cola, o peor, las dos superpuestas. Estos tests fijan la
// única regla que importa: exactamente UNA vista visible, siempre.
//
// También cubre el camino de vuelta: desde la Cola se puede tocar el nombre de
// un clip terminado y el panel salta a su marcador (goToJobMarker), que pide
// "markers". Si esa vuelta dejara Corrections abierta, el editor no vería la
// tarjeta a la que lo mandaron.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, deepEq } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');

const ctx = { console: console };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(CEP, 'tabs.js'), 'utf8'), ctx, { filename: 'tabs.js' });

/** Botón/vista de mentira, con lo poco que el conmutador les toca. */
function nodo() {
  return {
    className: '', atributos: {}, listeners: [],
    setAttribute: function (k, v) { this.atributos[k] = v; },
    addEventListener: function (ev, fn) { if (ev === 'click') this.listeners.push(fn); },
    click: function () { this.listeners.forEach(function (f) { f(); }); },
  };
}

function armar(nombres) {
  const partes = {};
  const defs = (nombres || ['markers', 'queue', 'corrections']).map(function (n) {
    partes[n] = { tab: nodo(), view: nodo() };
    return { name: n, tab: partes[n].tab, view: partes[n].view };
  });
  return { partes: partes, tabs: ctx.HPTabs.create(defs) };
}

/** Qué vistas quedaron a la vista. */
function visibles(p) {
  return Object.keys(p.partes).filter(function (n) {
    return p.partes[n].view.atributos['data-hidden'] === 'false';
  });
}

/** Qué pestañas quedaron resaltadas. */
function activas(p) {
  return Object.keys(p.partes).filter(function (n) {
    return p.partes[n].tab.className.indexOf('is-active') !== -1;
  });
}

test('con tres pestañas, elegir una esconde las otras dos', function () {
  const p = armar();
  p.tabs.select('corrections');
  deepEq(visibles(p), ['corrections'], 'una sola vista a la vista');
  deepEq(activas(p), ['corrections'], 'y una sola pestaña resaltada');
});

test('conmutar entre las tres no deja restos de la anterior', function () {
  // El bug del booleano se veía justo acá: al pasar de Corrections a Cola, la
  // vista de Corrections se quedaba abierta porque nadie la apagaba.
  const p = armar();
  ['markers', 'queue', 'corrections', 'queue', 'markers'].forEach(function (n) {
    p.tabs.select(n);
    deepEq(visibles(p), [n], 'después de elegir ' + n);
  });
});

test('el clic en la pestaña hace lo mismo que pedirla por código', function () {
  const p = armar();
  p.partes.corrections.tab.click();
  deepEq(visibles(p), ['corrections']);
  p.partes.markers.tab.click();
  deepEq(visibles(p), ['markers']);
});

test('volver a Marcadores desde la Cola cierra Corrections (el salto al marcador)', function () {
  const p = armar();
  p.tabs.select('corrections');
  p.tabs.select('markers'); // lo que hace goToJobMarker al abrir una tarjeta
  deepEq(visibles(p), ['markers'], 'la tarjeta del marcador queda a la vista');
  eq(p.partes.corrections.view.atributos['data-hidden'], 'true');
});

test('la pestaña elegida se puede consultar', function () {
  const p = armar();
  eq(p.tabs.current(), '', 'antes de elegir, ninguna');
  p.tabs.select('queue');
  eq(p.tabs.current(), 'queue');
});

test('una pestaña a la que le falta el botón o la vista no rompe el panel', function () {
  // El panel se carga por partes y un id que cambie de nombre no puede tumbar
  // la navegación entera.
  const tabs = ctx.HPTabs.create([
    { name: 'markers', tab: null, view: nodo() },
    { name: 'queue', tab: nodo(), view: null },
  ]);
  tabs.select('queue');
  eq(tabs.current(), 'queue', 'siguió funcionando');
});

test('pedir una pestaña que no existe no deja dos vistas abiertas', function () {
  const p = armar();
  p.tabs.select('markers');
  p.tabs.select('la-que-no-existe');
  deepEq(visibles(p), [], 'mejor ninguna que dos superpuestas');
});

test('el botón de la Cola conserva el contador que lleva adentro', function () {
  // Se toca className y no el contenido: adentro del botón vive el <span> con
  // cuántos jobs hay pendientes.
  const p = armar();
  p.tabs.select('queue');
  eq(p.partes.queue.tab.className, 'tab is-active');
  p.tabs.select('markers');
  eq(p.partes.queue.tab.className, 'tab', 'se apaga sin borrar nada');
});
