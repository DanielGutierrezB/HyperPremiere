'use strict';

// Elegir cuánto piensa el modelo, igual en los dos proveedores.
//
// De dónde sale: un editor con Cursor no encontraba cómo subirle la exigencia
// al Sonnet. Y no la tenía escondida por casualidad: en Cursor el nivel de
// razonamiento no es un flag, viene DENTRO del ID del modelo
// (claude-sonnet-5-thinking-high, -xhigh…), así que el desplegable mostraba una
// lista de IDs donde el nivel había que saber leerlo, y la fila de "Nivel de
// pensamiento" —la que sí se entiende— estaba escondida porque "en Cursor no
// aplica". Aplicaba: estaba disfrazada de modelo.
//
// Lo que se fija acá: que el editor vea los mismos dos controles con los dos
// proveedores, que el ID se vuelva a armar solo, y que no se le ofrezca un
// nivel que su cuenta no tiene.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');
const cursor = require('../bridge/providers/cursor-cli');

const CEP = path.join(__dirname, '..', 'cep', 'js');
const FAKE_CURSOR = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-cursor.js');
// Los CLI de mentira son scripts con shebang: en Windows no arrancan solos.
const saltarEnWindows = process.platform === 'win32';

// La lista tal como la devuelve el motor: los nombres son los que pone Cursor
// (de ahí sale el "1M") y family/effort los separa cursor-cli.js.
const MODELOS_CURSOR = [
  { id: 'auto', name: 'Auto', family: 'auto', effort: '' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', family: 'claude-sonnet-5', effort: '' },
  { id: 'claude-sonnet-5-thinking-high', name: 'Claude Sonnet 5 1M Thinking', family: 'claude-sonnet-5', effort: 'high' },
  { id: 'claude-sonnet-5-thinking-xhigh', name: 'Claude Sonnet 5 1M Extra High Thinking', family: 'claude-sonnet-5', effort: 'xhigh' },
  { id: 'claude-opus-5-thinking-high', name: 'Claude Opus 5 Thinking', family: 'claude-opus-5', effort: 'high' },
  { id: 'composer-2.5', name: 'Composer 2.5', family: 'composer-2.5', effort: '' },
];

function nodo(id) {
  return {
    id: id, value: '', textContent: '', className: '', disabled: false, open: false,
    style: {}, atributos: {},
    setAttribute: function (k, v) { this.atributos[k] = v; },
    getAttribute: function (k) { return this.atributos[k]; },
    removeAttribute: function (k) { delete this.atributos[k]; },
    addEventListener: function () {},
    focus: function () {},
  };
}

/**
 * Levanta el panel con un DOM y un motor de mentira.
 * `guardados` junta lo que el panel manda a setConfig: es donde se ve qué ID
 * de modelo terminó eligiendo.
 */
function armar(cfg, extra) {
  const nodos = {};
  const guardados = [];
  const selects = {};
  let idSelect = 0;
  const ctx = {
    console: console,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    Date: Date, Math: Math, JSON: JSON,
    HPQueue: { getModelConcurrency: function () { return 3; }, setModelConcurrency: function (n) { return n; } },
    HPWidgets: {
      select: function (el) {
        const s = {
          nombre: (el && el.id) || ('select-' + (idSelect++)),
          value: '', onChange: null, opciones: [],
          setOptions: function (opts, val) {
            this.opciones = opts.slice();
            this.value = val != null ? String(val) : ((opts[0] && opts[0].value) || '');
          },
          /** Lo que pasa cuando el editor elige una opción con el mouse. */
          elegir: function (v) {
            const cambio = (v !== this.value);
            this.value = v;
            if (cambio && typeof this.onChange === 'function') this.onChange(v);
          },
          /** Las etiquetas que ve el editor, en orden. */
          etiquetas: function () { return this.opciones.map(function (o) { return o.label; }); },
          valores: function () { return this.opciones.map(function (o) { return o.value; }); },
        };
        selects[s.nombre] = s;
        return s;
      },
    },
    HPEngine: {
      call: function (metodo, body) {
        if (metodo === 'setConfig') { guardados.push(body || {}); return Promise.resolve(cfg); }
        if (metodo === 'getConfig') return Promise.resolve(cfg);
        if (metodo === 'listCursorModels') {
          const r = (extra && extra.cursorModels) || MODELOS_CURSOR;
          if (r === 'falla') return Promise.resolve({ ok: false, error: 'sin sesión' });
          return Promise.resolve({ ok: true, models: r });
        }
        if (metodo === 'claudeSessionStatus') return Promise.resolve({ estado: 'con-sesion', resumen: '✓', detalle: '' });
        return Promise.resolve(null);
      },
    },
    document: {
      getElementById: function (id) {
        if (!nodos[id]) nodos[id] = nodo(id);
        return nodos[id];
      },
    },
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  ['util.js', 'config-ui.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  });
  ctx.HPConfigUI.init();
  return {
    api: ctx.HPConfigUI,
    nodos: nodos,
    guardados: guardados,
    modelo: function () { return selects['cfg-model']; },
    pensamiento: function () { return selects['cfg-effort']; },
    filaPensamiento: function () { return nodos['row-effort'].atributos['data-hidden']; },
    resumen: function () { return nodos['cfg-summary'].textContent; },
  };
}

function asentar() {
  return new Promise(function (r) { setTimeout(r, 20); });
}

const CURSOR = { provider: 'cursor-cli', model: 'claude-sonnet-5-thinking-high', effort: 'high' };

// ── Los dos controles, con los dos proveedores ────────────────────────

test('en Cursor el nivel de pensamiento tiene su propio desplegable', async function () {
  const p = armar(CURSOR);
  await asentar();
  eq(p.filaPensamiento(), 'false', 'la fila del nivel tiene que estar A LA VISTA');
  const niveles = p.pensamiento().valores();
  ok(niveles.indexOf('high') !== -1 && niveles.indexOf('xhigh') !== -1,
    'los niveles que la cuenta tiene se ofrecen: ' + niveles.join(','));
});

test('el desplegable de modelo muestra familias, no una lista de IDs', async function () {
  const p = armar(CURSOR);
  await asentar();
  const etiquetas = p.modelo().etiquetas().join(' | ');
  has(etiquetas, 'Claude Sonnet 5 · 1M', 'el 1M es la razón por la que se elige esa variante');
  eq(etiquetas.indexOf('thinking-xhigh'), -1, 'el nivel ya no viaja disfrazado de modelo');
  eq(etiquetas.indexOf('Thinking'), -1, 'lo dice el desplegable de al lado: repetirlo es ruido');
  // Una entrada por familia: sonnet, opus, composer y auto.
  eq(p.modelo().opciones.length, 4, 'seis IDs son cuatro modelos: ' + etiquetas);
});

test('el ID que se guarda se arma con familia + nivel', async function () {
  const p = armar(CURSOR);
  await asentar();
  p.pensamiento().elegir('xhigh');
  await asentar();
  const ultimo = p.guardados[p.guardados.length - 1];
  eq(ultimo.model, 'claude-sonnet-5-thinking-xhigh', 'es el ID que entiende el CLI de Cursor');
  eq(ultimo.effort, 'xhigh', 'y el nivel se guarda para que el panel lo recuerde');
});

test('al abrir, el nivel elegido es el que dice el ID guardado', async function () {
  const p = armar({ provider: 'cursor-cli', model: 'claude-sonnet-5-thinking-xhigh', effort: 'low' });
  await asentar();
  eq(p.pensamiento().value, 'xhigh',
    'manda el ID con el que se venía generando, no un esfuerzo viejo de otro proveedor');
});

test('el nivel del ID le gana al que quedó guardado del panel', async function () {
  // Los dos valores son válidos y distintos: el ID dice "alto" y el campo
  // `effort` —que en Cursor es solo un recuerdo del panel— dice "muy alto". El
  // que vale es el del ID, porque es con el que se generó de verdad. Si no,
  // abrir el panel le cambia calladito el modelo al editor.
  const p = armar({ provider: 'cursor-cli', model: 'claude-sonnet-5-thinking-high', effort: 'xhigh' });
  await asentar();
  eq(p.pensamiento().value, 'high', 'el ID manda');
  eq(p.api.modelName(), 'claude-sonnet-5-thinking-high', 'y el modelo no cambió por abrir el panel');
});

test('una familia sin niveles lo dice en vez de ofrecer uno falso', async function () {
  const p = armar(CURSOR);
  await asentar();
  p.modelo().elegir('fam:composer-2.5');
  await asentar();
  eq(p.pensamiento().opciones.length, 1, 'no hay niveles que ofrecer');
  has(p.pensamiento().etiquetas()[0], 'No aplica');
  const ultimo = p.guardados[p.guardados.length - 1];
  eq(ultimo.model, 'composer-2.5', 'y el modelo se guarda pelado, como Cursor lo espera');
});

test('cambiar de familia nunca da un ID que la cuenta no tiene', async function () {
  // El editor viene de Sonnet en "muy alto" y se pasa a Opus, que en su cuenta
  // solo tiene "alto". No puede salir de ahí un ID inventado
  // (claude-opus-5-thinking-xhigh no existe) ni una generación perdida: se baja
  // al vecino y se dice cuál quedó.
  const p = armar(CURSOR);
  await asentar();
  p.pensamiento().elegir('xhigh');
  await asentar();
  p.modelo().elegir('fam:claude-opus-5');
  await asentar();
  const ultimo = p.guardados[p.guardados.length - 1];
  eq(ultimo.model, 'claude-opus-5-thinking-high', 'el nivel más cercano que esa familia sí tiene');
  eq(p.pensamiento().value, 'high', 'y el desplegable muestra el que quedó, no el que se pidió');
});

test('un nivel que la cuenta no tiene se resuelve al vecino de abajo', async function () {
  // El mismo caso pero sin pasar por el desplegable: la config guardada trae
  // "máximo" (que en Cursor no existe) y la familia llega hasta "muy alto".
  const p = armar({ provider: 'cursor-cli', model: 'claude-sonnet-5-thinking-xhigh', effort: 'max' },
    { cursorModels: MODELOS_CURSOR });
  await asentar();
  eq(p.pensamiento().valores().indexOf('max'), -1, 'no se ofrece un nivel que no existe');
  eq(p.pensamiento().value, 'xhigh', 'se queda en el más alto que hay');
});

test('si no se puede consultar la cuenta, el selector igual funciona', async function () {
  const p = armar(CURSOR, { cursorModels: 'falla' });
  await asentar();
  has(p.modelo().etiquetas().join(' | '), 'Claude Sonnet 5 1M', 'la lista de respaldo también viene agrupada');
  ok(p.pensamiento().valores().length >= 1, 'y el nivel se sigue pudiendo elegir');
});

test('el resumen dice con qué nivel se va a generar', async function () {
  const p = armar(CURSOR);
  await asentar();
  has(p.resumen(), 'pensamiento high', 'antes esto solo aparecía con Claude');
});

// ── Lo que le llega al panel desde el CLI de verdad ───────────────────

test('el motor separa familia y nivel de cada modelo de la cuenta', async function () {
  if (saltarEnWindows) return;
  const r = await cursor.listModels({ cursorBinPath: FAKE_CURSOR });
  ok(r.ok, 'la lista tiene que poder leerse: ' + (r.error || ''));
  const porId = {};
  r.models.forEach(function (m) { porId[m.id] = m; });

  eq(porId['claude-sonnet-5-thinking-xhigh'].family, 'claude-sonnet-5');
  eq(porId['claude-sonnet-5-thinking-xhigh'].effort, 'xhigh');
  eq(porId['claude-sonnet-5'].effort, '', 'la variante pelada no tiene nivel');
  eq(porId['composer-2.5'].family, 'composer-2.5');
  eq(porId['composer-2.5'].effort, '');

  // La curaduría de siempre, que el agrupado no puede haber aflojado.
  ok(!porId['claude-sonnet-5-thinking-high-fast'], 'las "-fast" cuestan más cupo: afuera');
  ok(!porId['claude-sonnet-5-thinking-none'], 'sin razonamiento no se diseña');
  ok(!porId['gemini-3.1-flash'], 'la gama chica no da buenos diseños');
  ok(porId['auto'], 'y el "auto" se sigue ofreciendo');
});

// ── Lo que ve el log de diagnóstico ───────────────────────────────────

test('el log puede decir con qué modelo y con qué pensamiento se generó', async function () {
  const p = armar(CURSOR);
  await asentar();
  eq(p.api.effortName(), 'high');
  p.pensamiento().elegir('xhigh');
  await asentar();
  eq(p.api.effortName(), 'xhigh', 'el log tiene que leer el nivel de AHORA');
  eq(p.api.modelName(), 'claude-sonnet-5-thinking-xhigh',
    'y el modelo de ahora, no el que había al abrir el panel');
});

test('un proveedor sin niveles no inventa uno para el log', async function () {
  const p = armar({ provider: 'ollama', model: 'qwen3-coder:30b' });
  await asentar();
  eq(p.api.effortName(), '', 'Ollama no tiene nivel de pensamiento: no hay nada que anotar');
  eq(p.filaPensamiento(), 'true', 'y la fila no se muestra');
});

// ── Claude no se toca ─────────────────────────────────────────────────

test('en Claude siguen estando los cinco niveles y el ID pelado', async function () {
  const p = armar({ provider: 'claude-cli', model: 'claude-sonnet-5', effort: 'high', hasSession: true });
  await asentar();
  eq(p.filaPensamiento(), 'false');
  eq(p.pensamiento().valores().join(','), 'low,medium,high,xhigh,max',
    'el esfuerzo de Claude es un flag aparte: están todos');
  p.pensamiento().elegir('max');
  await asentar();
  const ultimo = p.guardados[p.guardados.length - 1];
  eq(ultimo.model, 'claude-sonnet-5', 'el modelo de Claude no lleva el nivel adentro');
  eq(ultimo.effort, 'max');
});
