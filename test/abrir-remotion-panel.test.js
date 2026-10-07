'use strict';

// «ABRIR REMOTION», EL MISMO DESDE LAS TRES LISTAS.
//
// La ficha de un marcador, un trabajo terminado de la Cola y una fila de
// Corrections abren Studio con el mismo módulo (cep/js/abrir-remotion.js). Con
// qué marcador lo llama cada lista lo prueban los tests de cada una
// (tres-listas-una-gramatica y correcciones-encolar); acá, lo que hace el botón
// una vez que sabe qué marcador es:
//
//   1. Abre la ÚLTIMA versión, preguntada al disco al apretar.
//   2. Le pide al motor lo que la vista previa necesita, sin datos inventados.
//   3. Dice qué archivo se abrió y qué pasó con lo que tenía.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, deepEq, has } = require('./harness');

/** HPAbrirRemotion con un motor de mentira que contesta `respuestas`. */
function cargar(respuestas) {
  const visto = { llamadas: [], navegador: [], escuchas: 0 };
  const ctx = {
    console: console, Promise: Promise, String: String, Number: Number, isFinite: isFinite,
    HPLog: { log: function () {} },
    HPUtil: { abrirEnNavegador: function (url) { visto.navegador.push(url); } },
    HPStudioRenders: { escuchar: function () { visto.escuchas++; } },
    HPEngine: {
      call: function (metodo, body) {
        visto.llamadas.push({ metodo: metodo, body: body });
        const r = respuestas[metodo];
        if (r instanceof Error) return Promise.reject(r);
        return Promise.resolve(typeof r === 'function' ? r(body) : r);
      },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'cep', 'js', 'abrir-remotion.js'), 'utf8'), ctx);
  return { api: ctx.HPAbrirRemotion, visto: visto };
}

const VERSIONES = {
  ok: true,
  versions: [
    { version: 1, engine: 'hyperframes' },
    { version: 2, engine: 'remotion' },
    { version: 3, engine: 'remotion' },
  ],
};

const ABIERTO = {
  ok: true, url: 'http://localhost:51758/', arrancado: true, etiqueta: 'Marcador 1 v3',
  archivo: '/h/.hyperpremiere/remotion/marcadores/Clase 3 - abc123/Marcador 1.tsx',
  accion: 'nuevo', respaldo: '', editor: { ok: true },
};

function renglon() {
  const dichos = [];
  return { dichos: dichos, decir: function (texto, esError) { dichos.push({ texto: texto, esError: !!esError }); } };
}

function donde(extra) {
  return Object.assign({ projectPath: '/p/Curso.prproj', sequenceName: 'Clase 3', markerSlug: 'Marcador 1' }, extra);
}

// ── 1. La última versión ──────────────────────────────────────────────

test('abre la ÚLTIMA versión, preguntada al disco al apretar', async function () {
  const m = cargar({ listMarkerVersions: VERSIONES, previewComposition: ABIERTO });
  const r = renglon();
  await m.api.abrirUltima(donde({ decir: r.decir }));
  const pedido = m.visto.llamadas.filter((l) => l.metodo === 'previewComposition')[0].body;
  eq(pedido.version, 3, 'la más nueva, no la que la lista tenía anotada');
  eq(pedido.abrirArchivo, true, 'con el archivo en el editor: es lo que hace el botón');
  eq(pedido.engine, 'remotion');
  eq(m.visto.llamadas[0].metodo, 'listMarkerVersions', 'primero se pregunta cuál es');
  deepEq(m.visto.llamadas[0].body, { projectPath: '/p/Curso.prproj', sequenceName: 'Clase 3', markerSlug: 'Marcador 1' });
});

test('si la última no es de Remotion, lo dice y no abre nada', async function () {
  const m = cargar({ listMarkerVersions: { ok: true, versions: [{ version: 1, engine: 'remotion' }, { version: 2, engine: 'hyperframes' }] } });
  const r = renglon();
  const boton = { disabled: false };
  await m.api.abrirUltima(donde({ decir: r.decir, boton: boton }));
  eq(m.visto.llamadas.filter((l) => l.metodo === 'previewComposition').length, 0);
  eq(r.dichos[0].esError, true);
  has(r.dichos[0].texto, 'no es de Remotion');
  eq(boton.disabled, false, 'el botón vuelve a quedar usable');
});

test('ultimaVersion contesta 0 sin versiones, y 0 si el motor no contesta', async function () {
  eq(await cargar({ listMarkerVersions: { ok: true, versions: [] } }).api.ultimaVersion(donde()), 0);
  eq(await cargar({ listMarkerVersions: new Error('se cayó') }).api.ultimaVersion(donde()), 0);
  eq(await cargar({ listMarkerVersions: VERSIONES }).api.ultimaVersion(donde()), 3);
});

// ── 2. Lo que se le pide al motor ─────────────────────────────────────

test('el tramo viaja sin los datos que no se saben', async function () {
  // El motor junta el tramo del panel con el de la ficha de la versión: un
  // `name: undefined` pisaba el nombre de la ficha, y el render de Studio salía
  // con un marcador sin nombre. Es lo que manda la Cola, que no sabe el nombre.
  const m = cargar({ listMarkerVersions: VERSIONES, previewComposition: ABIERTO });
  await m.api.abrirUltima(donde({ decir: renglon().decir, marker: { name: undefined, start: 12.4, duration: undefined } }));
  const pedido = m.visto.llamadas[1].body;
  // Las claves y no `deepEq`: JSON se saltea las que valen `undefined`, que es
  // justo lo que hay que ver.
  deepEq(Object.keys(pedido.marker), ['start']);
  eq(pedido.marker.start, 12.4);
  ok(!('background' in pedido), 'sin «Con fondo» de la lista, decide la ficha de la versión');
  ok(!('colocarEn' in pedido), 'y sin otro corte, el clip va a la secuencia de la carpeta');
});

test('lo que una lista sí sabe, viaja: el fondo de la ficha y dónde colocar', async function () {
  const m = cargar({ listMarkerVersions: VERSIONES, previewComposition: ABIERTO });
  await m.api.abrirUltima(donde({
    decir: renglon().decir, background: true, colocarEn: 'Clase 3_02',
    marker: { name: 'Intro', start: 0, duration: 4 },
  }));
  const pedido = m.visto.llamadas[1].body;
  eq(pedido.background, true);
  eq(pedido.colocarEn, 'Clase 3_02');
  deepEq(pedido.marker, { name: 'Intro', start: 0, duration: 4 }, 'un marcador en el segundo 0 también tiene tramo');
});

test('abierto, abre el navegador y queda escuchando los renders', async function () {
  const m = cargar({ listMarkerVersions: VERSIONES, previewComposition: ABIERTO });
  await m.api.abrirUltima(donde({ decir: renglon().decir }));
  deepEq(m.visto.navegador, ['http://localhost:51758/']);
  eq(m.visto.escuchas, 1, 'el Render de Studio tiene que encontrar a alguien que reemplace el clip');
});

test('si el motor no puede, se dice con su motivo y no se abre nada', async function () {
  const m = cargar({ listMarkerVersions: VERSIONES, previewComposition: { ok: false, error: 'Remotion no está listo: falta su navegador' } });
  const r = renglon();
  const boton = { disabled: false };
  await m.api.abrirUltima(donde({ decir: r.decir, boton: boton }));
  eq(m.visto.navegador.length, 0);
  eq(m.visto.escuchas, 0);
  const ultimo = r.dichos[r.dichos.length - 1];
  eq(ultimo.esError, true);
  has(ultimo.texto, 'falta su navegador', 'el motivo completo: es lo que dice qué hacer');
  eq(boton.disabled, false);
});

test('mientras abre, el botón no se puede volver a apretar', async function () {
  let soltar = null;
  const m = cargar({
    listMarkerVersions: VERSIONES,
    previewComposition: function () { return new Promise(function (r) { soltar = r; }); },
  });
  const boton = { disabled: false };
  const yendo = m.api.abrirUltima(donde({ decir: renglon().decir, boton: boton }));
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(boton.disabled, true, 'dos clics serían dos Studios pedidos a la vez');
  soltar(ABIERTO);
  await yendo;
  eq(boton.disabled, false);
});

// ── 3. Lo que se dice ─────────────────────────────────────────────────

test('dice qué archivo se abrió, y que el Render reemplaza el clip', function () {
  const m = cargar({});
  const t = m.api.mensaje(ABIERTO, true);
  has(t, '«Marcador 1.tsx» en tu editor');
  has(t, 'lo que guardes ahí se ve en Studio al momento');
  has(t, '«Render» en Studio reemplaza el clip de este marcador en Premiere');
});

test('si el editor no se pudo abrir, dice dónde está el archivo', function () {
  const t = cargar({}).api.mensaje(Object.assign({}, ABIERTO, { editor: { ok: false, error: 'no hay aplicación' } }), true);
  has(t, 'No pude abrir «Marcador 1.tsx»');
  has(t, ABIERTO.archivo, 'la ruta entera, para abrirlo a mano');
});

test('dice qué pasó con lo que el archivo tenía sin renderizar', function () {
  const api = cargar({}).api;
  has(api.mensaje(Object.assign({}, ABIERTO, { accion: 'conservado' }), true), 'Seguís con tus cambios sin renderizar');
  const r = api.mensaje(Object.assign({}, ABIERTO, {
    accion: 'respaldado', respaldo: '/h/marcadores/Clase 3 - abc123/respaldos/Marcador 1 (sin renderizar, 2026-10-07 16.05.09).tsx',
  }), true);
  has(r, 'quedó en «Marcador 1 (sin renderizar, 2026-10-07 16.05.09).tsx»', 'con el nombre del respaldo');
});

test('el panel lo carga antes que la ficha, y deja dicho quién pinta los renders', function () {
  // La ficha del marcador pregunta al dibujarse si su última versión es de
  // Remotion; la Cola y Corrections lo usan recién al apretar. Y lo que pasa
  // cuando un render de Studio entra a Premiere es lo mismo venga de la lista
  // que venga: lo configura main.js una vez.
  const raiz = path.join(__dirname, '..', 'cep');
  const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
  const script = (f) => html.indexOf('<script src="js/' + f + '"></script>');
  const i = script('abrir-remotion.js');
  ok(i !== -1, 'index.html lo carga');
  ok(i < script('main.js'), 'antes que main.js');
  ok(script('studio-renders.js') !== -1 && script('studio-renders.js') < i,
    'y después del que reemplaza el clip, que es el que usa');
  has(fs.readFileSync(path.join(raiz, 'js', 'main.js'), 'utf8'), 'HPStudioRenders.configurar({ alTerminar: alRenderDeStudio });');
});

test('la vista previa del editor del panel no habla del editor de código', function () {
  const api = cargar({}).api;
  const t = api.mensaje(Object.assign({}, ABIERTO, { editor: null }), false);
  ok(t.indexOf('tu editor') === -1, t);
  has(t, 'Remotion abierto en el navegador.');
  has(api.mensaje(Object.assign({}, ABIERTO, { arrancado: false, editor: null }), false), 'mirá la pestaña que ya tenías abierta');
});
