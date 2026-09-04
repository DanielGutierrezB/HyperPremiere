'use strict';

// Cuánto le entra al modelo y cuánto le metemos de verdad.
//
// El pedido del editor: "no me dice claramente cuántos tokens consume, tipo
// 300k o 1M de tokens". Lo que faltaba era el tamaño de la ventana al lado del
// modelo y, más útil todavía, cuánto gasta una generación de las suyas.
//
// Las dos mitades tienen su trampa y por eso se prueban acá:
//
//   - LA VENTANA NO LA INFORMA EL PROVEEDOR. `cursor-agent --list-models`
//     devuelve "<id> - <nombre>" y de la lista de Anthropic el motor lee id y
//     display_name. Sale de una tabla nuestra (HPUtil, VENTANA_CLAUDE), así que
//     hay que fijar lo que pasa con una familia que NO está en la tabla: no se
//     muestra nada. Un default inventado es peor que un renglón vacío, porque
//     el editor decide con ese número cuánto material le mete a la generación.
//
//   - EL MISMO MODELO NO TIENE LA MISMA VENTANA SEGÚN POR DÓNDE ENTRES. Por
//     Cursor, las variantes de 1M lo dicen en su propio nombre. Por el CLI de
//     Claude depende de la CREDENCIAL: con API key va por la API, con la sesión
//     de claude.ai nadie dice cuánta ventana efectiva te toca. Prometer el 1M
//     ahí es el error que más caro sale.
//
//   - EL PROMEDIO REAL ES POR PROVEEDOR. Con Cursor cada llamada arrastra
//     ~31,8k de contexto del propio agente; con Claude directo, no. Mostrar el
//     promedio de uno como si describiera al otro es el mismo tipo de mentira.
//     Y un acumulado viejo (el que ya tiene `legacyMix`) contaba la entrada a
//     medias: tampoco puede aportar un promedio.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');

/** Solo HPUtil: las decisiones son funciones puras, sin DOM ni almacenamiento. */
function cargarUtil() {
  const ctx = { console: console, JSON: JSON, Math: Math, Date: Date };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(CEP, 'util.js'), 'utf8'), ctx, { filename: 'util.js' });
  return ctx.HPUtil;
}

/** HPUtil + HPStore con un localStorage de mentira (cada test arranca limpio). */
function cargarPanel() {
  const disco = {};
  const ctx = {
    console: console, JSON: JSON, Math: Math, Date: Date,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(disco, k) ? disco[k] : null; },
      setItem: function (k, v) { disco[k] = String(v); },
      removeItem: function (k) { delete disco[k]; },
    },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  ['util.js', 'store.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  });
  return { HPUtil: ctx.HPUtil, HPStore: ctx.HPStore, disco: disco };
}

const U = cargarUtil();

// ── 1. La tabla: lo que está y lo que no ──────────────────────────────

test('una familia que está en la tabla muestra su ventana', function () {
  const v = U.ventanaDeContexto({ provider: 'claude-api', model: 'claude-sonnet-5' });
  ok(v, 'Sonnet 5 está en la tabla');
  eq(v.tokens, 1000000);
  eq(v.texto, '1M', 'es el número que el editor pidió ver, con sus letras');
  eq(v.piso, false, 'por la API la ventana es esa, no un mínimo');
});

test('una familia que NO está en la tabla no muestra nada', function () {
  // El caso de todos los días: Cursor o Anthropic sacan un modelo nuevo, el
  // panel lo lista solo (la lista se pide a la cuenta) y la tabla todavía no lo
  // tiene. Ahí se ve el modelo sin ventana, y está bien.
  eq(U.ventanaDeContexto({ provider: 'claude-api', model: 'claude-sonnet-9' }), null);
  eq(U.ventanaDeContexto({ provider: 'claude-cli', model: 'un-modelo-que-no-existe' }), null);
});

test('un ID con la fecha del snapshot pegada es la misma familia', function () {
  const v = U.ventanaDeContexto({ provider: 'claude-api', model: 'claude-haiku-4-5-20251001' });
  ok(v, 'los IDs viejos traen el snapshot; la familia es la misma');
  eq(v.tokens, 200000);
});

test('los proveedores que no son Claude ni Cursor no inventan ventana', function () {
  eq(U.ventanaDeContexto({ provider: 'ollama', model: 'qwen3-coder:30b' }), null);
  eq(U.ventanaDeContexto({ provider: 'openai-compat', model: 'gpt-4o' }), null,
    'una base URL cualquiera puede servir cualquier cosa: no hay nada que afirmar');
});

// ── 2. El 1M, que depende de la puerta ────────────────────────────────

test('el 1M NO se promete por el CLI de Claude sin API key', function () {
  // Lo caro de este error: el editor lee "1M", arma una generación de medio
  // millón de tokens y se la come la ventana que sí tenía.
  ['claude.ai', 'oauth_token'].forEach(function (metodo) {
    const v = U.ventanaDeContexto({
      provider: 'claude-cli', model: 'claude-sonnet-5', autenticacion: metodo,
    });
    ok(v, 'algo se puede decir: ningún Claude de la lista baja de 200k');
    eq(v.tokens, 200000, 'se muestra el piso, que es lo único seguro (' + metodo + ')');
    eq(v.piso, true, 'y marcado como piso, no como la ventana');
    eq(v.texto.indexOf('M'), -1, 'no aparece un "1M" por ningún lado: ' + v.texto);
  });
});

test('sin saber con qué credencial entra, tampoco se promete el 1M', function () {
  // El cuarto de segundo entre que abre ⚙ y que contesta `claude auth status`,
  // y también el caso "no se sabe" (un CLI viejo que no conoce el comando).
  const v = U.ventanaDeContexto({ provider: 'claude-cli', model: 'claude-opus-5', autenticacion: '' });
  eq(v.tokens, 200000);
  eq(v.piso, true, 'no saber se parece más a no prometer que a prometer');
});

test('con API key el CLI de Claude va por la API y ahí sí es 1M', function () {
  const v = U.ventanaDeContexto({
    provider: 'claude-cli', model: 'claude-sonnet-5', autenticacion: 'api_key',
  });
  eq(v.tokens, 1000000);
  eq(v.piso, false);
});

test('una familia que ya está en el piso no tiene nada de ambiguo', function () {
  // Sonnet 4.5 son 200k por los dos caminos: acá no hay 1M que prometer ni
  // dejar de prometer, así que el número va pelado, sin el "+".
  const v = U.ventanaDeContexto({
    provider: 'claude-cli', model: 'claude-sonnet-4-5', autenticacion: 'claude.ai',
  });
  eq(v.texto, '200k');
  eq(v.piso, false, 'marcarlo como piso sería sembrar una duda que no existe');
});

test('por Cursor el 1M sí se promete, porque lo dice Cursor', function () {
  // El nombre que devuelve `cursor-agent --list-models` es literal: "Claude
  // Sonnet 5 1M Thinking". El dato es del proveedor, no nuestro.
  const v = U.ventanaDeContexto({
    provider: 'cursor-cli', model: 'claude-sonnet-5-thinking-high',
    nombre: 'Claude Sonnet 5 · 1M',
  });
  eq(v.tokens, 1000000);
  eq(v.piso, false);
});

test('por Cursor, un modelo cuyo nombre no dice 1M no muestra ventana', function () {
  eq(U.ventanaDeContexto({ provider: 'cursor-cli', model: 'composer-2.5', nombre: 'Composer 2.5' }), null,
    'Cursor no lo dice y nosotros no lo sabemos');
  eq(U.ventanaDeContexto({ provider: 'cursor-cli', model: 'auto', nombre: 'Auto (que elija Cursor)' }), null);
});

test('la credencial de Claude no se le aplica a Cursor', function () {
  // Son dos suscripciones distintas; `authMethod` habla del CLI de Claude.
  const v = U.ventanaDeContexto({
    provider: 'cursor-cli', model: 'claude-sonnet-5-thinking-high',
    nombre: 'Claude Sonnet 5 · 1M', autenticacion: 'claude.ai',
  });
  eq(v.tokens, 1000000, 'el nombre de Cursor manda igual');
});

// ── 3. Lo que informa la API le gana a la tabla ───────────────────────

test('si la API dice cuánto entra, ese número le gana a nuestra tabla', function () {
  // `max_input_tokens` viene en la lista de modelos de Anthropic y el motor lo
  // pasa (listClaudeModels). Es el único lugar donde el dato llega de la fuente.
  const v = U.ventanaDeContexto({ provider: 'claude-api', model: 'claude-sonnet-5', reportado: 400000 });
  eq(v.tokens, 400000, 'la cuenta de verdad manda sobre lo que anotamos nosotros');
  eq(v.texto, '400k');
});

test('un max_input_tokens vacío o absurdo no borra la ventana', function () {
  // La respuesta lo admite en null, y por CLI casi siempre viene así.
  [0, null, undefined, -5, 'muchos'].forEach(function (r) {
    const v = U.ventanaDeContexto({ provider: 'claude-api', model: 'claude-sonnet-5', reportado: r });
    eq(v.tokens, 1000000, 'se cae a la tabla en vez de quedarse mudo (reportado=' + String(r) + ')');
  });
});

test('lo que informa la API no habilita el 1M por suscripción', function () {
  // La lista de modelos se consulta con la credencial guardada, así que puede
  // contestar 1M mientras el CLI entra por claude.ai. Ese número describe la
  // API, no la puerta por la que va a generar.
  const v = U.ventanaDeContexto({
    provider: 'claude-cli', model: 'claude-sonnet-5',
    autenticacion: 'claude.ai', reportado: 1000000,
  });
  eq(v.tokens, 200000);
  eq(v.piso, true);
});

// ── 4. El promedio real, por proveedor ────────────────────────────────

test('sin datos de ese proveedor no se inventa un promedio', function () {
  const p = cargarPanel();
  p.HPStore.addSessionUsage({ provider: 'cursor-cli', totalInputTokens: 128412, outputTokens: 6104 });
  const u = p.HPStore.getSessionUsage();
  ok(p.HPUtil.consumoTipico(u, 'cursor-cli'), 'con Cursor sí hay medición');
  eq(p.HPUtil.consumoTipico(u, 'claude-cli'), null,
    'el promedio de Cursor no describe a Claude: arrastra ~31,8k de contexto del agente');
  eq(p.HPUtil.consumoTipico(u, 'ollama'), null);
});

test('el promedio es la entrada COMPLETA dividida por las generaciones', function () {
  const p = cargarPanel();
  // Los tres campos, como los manda un CLI de agente: el suelto es un puñado y
  // el prompt entero viaja por los de caché.
  p.HPStore.addSessionUsage({
    provider: 'cursor-cli', inputTokens: 4, outputTokens: 9252,
    cacheReadTokens: 84015, cacheCreationTokens: 49316,
  });
  p.HPStore.addSessionUsage({
    provider: 'cursor-cli', inputTokens: 6, outputTokens: 6104,
    cacheReadTokens: 96140, cacheCreationTokens: 51001,
  });
  const c = p.HPUtil.consumoTipico(p.HPStore.getSessionUsage(), 'cursor-cli');
  eq(c.generaciones, 2);
  eq(c.entrada, Math.round((133335 + 147147) / 2), 'contar solo `inputTokens` daría 5');
});

test('cada proveedor lleva su propia cuenta', function () {
  const p = cargarPanel();
  p.HPStore.addSessionUsage({ provider: 'cursor-cli', totalInputTokens: 130000, outputTokens: 100 });
  p.HPStore.addSessionUsage({ provider: 'claude-cli', totalInputTokens: 30000, outputTokens: 100 });
  p.HPStore.addSessionUsage({ provider: 'claude-cli', totalInputTokens: 40000, outputTokens: 100 });
  const u = p.HPStore.getSessionUsage();
  eq(p.HPUtil.consumoTipico(u, 'cursor-cli').entrada, 130000);
  eq(p.HPUtil.consumoTipico(u, 'claude-cli').entrada, 35000);
  eq(u.generations, 3, 'y el total de la sesión los sigue sumando a todos');
});

test('un uso sin proveedor entra al total pero no ensucia ningún bolsillo', function () {
  const p = cargarPanel();
  p.HPStore.addSessionUsage({ totalInputTokens: 999999, outputTokens: 10 });
  const u = p.HPStore.getSessionUsage();
  eq(u.generations, 1);
  eq(Object.keys(u.porProveedor).length, 0, 'no se sabe de quién es: no se le atribuye a nadie');
});

test('una sesión con contabilidad vieja no ensucia el promedio', function () {
  // El acumulado de antes del arreglo: 164 generaciones con la entrada contada
  // a medias y ningún bolsillo por proveedor. Repartirlo sería inventar de
  // dónde salió, y encima con la entrada corta.
  const p = cargarPanel();
  p.disco['hyperpremiere::session-usage'] = JSON.stringify({
    inputTokens: 75256, outputTokens: 2341682, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUsd: 15.37, costGenerations: 12, generations: 164,
  });
  const u = p.HPStore.getSessionUsage();
  ok(u.legacyMix, 'la marca de siempre sigue puesta');
  eq(p.HPUtil.consumoTipico(u, 'claude-cli'), null, 'todavía no hay con qué contestar');
  eq(p.HPUtil.consumoTipico(u, 'cursor-cli'), null);

  // Y de acá en adelante se mide limpio, sin arrastrar lo viejo.
  p.HPStore.addSessionUsage({ provider: 'claude-cli', totalInputTokens: 90000, outputTokens: 5000 });
  const c = p.HPUtil.consumoTipico(p.HPStore.getSessionUsage(), 'claude-cli');
  eq(c.entrada, 90000, 'solo la generación nueva, no un promedio de 165');
  eq(c.generaciones, 1);
});

test('un bolsillo sin la marca de cómo se contó se descarta', function () {
  // Es la misma política que `rule` en el total: sin saber con qué criterio se
  // juntó, un promedio no quiere decir nada.
  const p = cargarPanel();
  p.disco['hyperpremiere::session-usage'] = JSON.stringify({
    generations: 3, rule: 2,
    porProveedor: { 'claude-cli': { entrada: 300, salida: 10, generaciones: 3 } },
  });
  eq(p.HPUtil.consumoTipico(p.HPStore.getSessionUsage(), 'claude-cli'), null);
});

test('un bolsillo con cero generaciones no divide por cero', function () {
  // Sale de localStorage: un archivo tocado a mano puede traer cualquier cosa, y
  // "≈ NaN de entrada" es peor que no decir nada.
  const p = cargarPanel();
  p.disco['hyperpremiere::session-usage'] = JSON.stringify({
    generations: 1, rule: 2,
    porProveedor: { 'claude-cli': { entrada: 500, salida: 10, generaciones: 0, regla: 2 } },
  });
  eq(p.HPUtil.consumoTipico(p.HPStore.getSessionUsage(), 'claude-cli'), null);
});

test('reiniciar el contador también borra lo de cada proveedor', function () {
  const p = cargarPanel();
  p.HPStore.addSessionUsage({ provider: 'cursor-cli', totalInputTokens: 130000, outputTokens: 100 });
  p.HPStore.resetSessionUsage();
  eq(p.HPUtil.consumoTipico(p.HPStore.getSessionUsage(), 'cursor-cli'), null,
    'reiniciar es reiniciar: no puede quedar un promedio del acumulado anterior');
});

test('el refinado del dictado no se mete en el promedio de las generaciones', function () {
  // Va a su propio bolsillo desde antes; que siga así importa acá porque son
  // órdenes de magnitud distintos (cientos de tokens contra decenas de miles).
  const p = cargarPanel();
  p.HPStore.addSessionUsage({ provider: 'claude-cli', totalInputTokens: 90000, outputTokens: 5000 });
  p.HPStore.addDictadoUsage({ provider: 'claude-cli', inputTokens: 300, outputTokens: 80 });
  eq(p.HPUtil.consumoTipico(p.HPStore.getSessionUsage(), 'claude-cli').entrada, 90000);
});

// ── 5. El renglón que se lee ──────────────────────────────────────────

test('el renglón dice la ventana y qué parte de ella se está usando', function () {
  const t = U.lineaDeContexto({
    provider: 'cursor-cli', proveedor: 'Cursor (suscripción)',
    ventana: U.ventanaDeContexto({ provider: 'cursor-cli', model: 'x', nombre: 'Claude Sonnet 5 · 1M' }),
    consumo: { entrada: 137780, generaciones: 12 },
  });
  has(t, '1M', 'la ventana');
  has(t, '138k', 'lo que gasta una generación de verdad');
  has(t, '12', 'sobre cuántas está medido');
  has(t, '14%', 'y la respuesta a la pregunta con la que abrió ⚙');
});

test('el renglón no repite lo que el aviso de Cursor ya dice', function () {
  // Que Cursor arrastre ~30k de contexto propio se avisa dos renglones más
  // abajo, en el cartel amarillo del proveedor. Dicho también acá quedaban dos
  // párrafos seguidos con el mismo número. Con Cursor el promedio de arriba ya
  // lo muestra solo: sale bastante más alto que el de Claude por el mismo trabajo.
  const t = U.lineaDeContexto({
    provider: 'cursor-cli', proveedor: 'Cursor (suscripción)',
    ventana: { tokens: 1000000, texto: '1M', piso: false },
    consumo: { entrada: 128412, generaciones: 12 },
  });
  eq(t.indexOf('contexto del propio agente'), -1);
  has(t, '128k', 'lo que sí dice es cuánto gasta de verdad');
});

test('sin medición, el renglón lo dice en vez de mostrar otro número', function () {
  const t = U.lineaDeContexto({
    provider: 'claude-cli', proveedor: 'Claude (suscripción)',
    ventana: U.ventanaDeContexto({ provider: 'claude-cli', model: 'claude-sonnet-5', autenticacion: 'claude.ai' }),
    consumo: null,
  });
  has(t, 'Todavía no generaste');
  has(t, 'Claude (suscripción)');
  // El 1M aparece, pero negado ("no te prometo los 1M"). Lo que no puede pasar
  // es que la ventana se anuncie como 1M.
  has(t, 'Ventana de contexto: al menos 200k');
  eq(t.indexOf('Ventana de contexto: 1M'), -1);
});

test('sin ventana conocida, el renglón lo dice y muestra igual el consumo', function () {
  const t = U.lineaDeContexto({
    provider: 'ollama', proveedor: 'Ollama local',
    ventana: null, consumo: { entrada: 12000, generaciones: 3 },
  });
  has(t, 'no la tengo anotada');
  has(t, '12k', 'la mitad que sí se sabe se muestra igual');
});

test('la ventana de piso se dice como piso, no como la ventana', function () {
  const t = U.lineaDeContexto({
    provider: 'claude-cli', proveedor: 'Claude (suscripción)',
    ventana: U.ventanaDeContexto({ provider: 'claude-cli', model: 'claude-opus-5', autenticacion: 'oauth_token' }),
    consumo: { entrada: 100000, generaciones: 4 },
  });
  has(t, 'al menos 200k');
  has(t, 'no te prometo los 1M');
  has(t, '50% de esos 200k', 'el porcentaje se ancla al número que se mostró');
});

test('los tamaños se escriben como el editor los pidió', function () {
  eq(U.fmtVentana(1000000), '1M', 'no "1,0M"');
  eq(U.fmtVentana(200000), '200k');
  eq(U.fmtVentana(300000), '300k');
  eq(U.fmtVentana(2000000), '2M');
});

// ── 6. El selector de ⚙, armado de verdad ─────────────────────────────
//
// Lo de arriba prueba las decisiones; esto prueba que el panel las use. Es el
// mismo andamio del test del selector de pensamiento: HPWidgets y el motor de
// mentira, el config-ui.js real.

const MODELOS_CLAUDE = [
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
];
const MODELOS_CURSOR = [
  { id: 'auto', name: 'Auto', family: 'auto', effort: '' },
  { id: 'claude-sonnet-5-thinking-high', name: 'Claude Sonnet 5 1M Thinking', family: 'claude-sonnet-5', effort: 'high' },
  { id: 'claude-sonnet-5-thinking-xhigh', name: 'Claude Sonnet 5 1M Extra High Thinking', family: 'claude-sonnet-5', effort: 'xhigh' },
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

/** El panel de ⚙ con el motor de mentira. `sesion` es lo que contesta el CLI. */
function armarPanel(cfg, extra) {
  extra = extra || {};
  const nodos = {};
  const selects = {};
  const disco = {};
  let idSelect = 0;
  const ctx = {
    console: console, JSON: JSON, Math: Math, Date: Date,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(disco, k) ? disco[k] : null; },
      setItem: function (k, v) { disco[k] = String(v); },
      removeItem: function (k) { delete disco[k]; },
    },
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
          elegir: function (v) {
            const cambio = (v !== this.value);
            this.value = v;
            if (cambio && typeof this.onChange === 'function') this.onChange(v);
          },
          etiquetas: function () { return this.opciones.map(function (o) { return o.label; }); },
          /** La etiqueta de la opción que está elegida, que es la que se ve. */
          elegida: function () {
            const self = this;
            const hit = this.opciones.filter(function (o) { return o.value === self.value; })[0];
            return hit ? hit.label : '';
          },
        };
        selects[s.nombre] = s;
        return s;
      },
    },
    HPEngine: {
      call: function (metodo, body) {
        if (metodo === 'setConfig') return Promise.resolve(cfg);
        if (metodo === 'getConfig') return Promise.resolve(cfg);
        if (metodo === 'listClaudeModels') return Promise.resolve({ ok: true, models: extra.claudeModels || MODELOS_CLAUDE });
        if (metodo === 'listCursorModels') return Promise.resolve({ ok: true, models: MODELOS_CURSOR });
        if (metodo === 'claudeSessionStatus') {
          return Promise.resolve(extra.sesion || { estado: 'con-sesion', metodo: 'claude.ai', resumen: '✓', detalle: '' });
        }
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
  ['util.js', 'store.js', 'config-ui.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  });
  ctx.HPConfigUI.init();
  return {
    store: ctx.HPStore,
    modelo: function () { return selects['cfg-model']; },
    renglon: function () { return nodos['cfg-context'].textContent; },
  };
}

function asentar() {
  return new Promise(function (r) { setTimeout(r, 20); });
}

test('el desplegable de Claude muestra la ventana al lado del nombre', async function () {
  const p = armarPanel({ provider: 'claude-api', model: 'claude-sonnet-5', effort: 'high' });
  await asentar();
  const etiquetas = p.modelo().etiquetas().join(' | ');
  has(etiquetas, 'Claude Sonnet 5 · 1M', 'era lo que faltaba: el tamaño junto al modelo');
  has(etiquetas, 'Claude Sonnet 4.5 · 200k', 'y el que tiene menos también lo dice');
});

test('por suscripción, el desplegable NO ofrece el 1M', async function () {
  // La mutación que más caro sale es justo ésta al revés.
  const p = armarPanel({ provider: 'claude-cli', model: 'claude-sonnet-5', effort: 'high', hasSession: true },
    { sesion: { estado: 'con-sesion', metodo: 'claude.ai', resumen: '✓', detalle: '' } });
  await asentar();
  const etiquetas = p.modelo().etiquetas().join(' | ');
  has(etiquetas, 'Claude Sonnet 5 · 200k+');
  eq(etiquetas.indexOf('1M'), -1, 'ni en el Sonnet ni en el Opus: ' + etiquetas);
  has(p.renglon(), 'no te prometo los 1M');
});

test('con API key en el CLI, el mismo Sonnet sí muestra 1M', async function () {
  const p = armarPanel({ provider: 'claude-cli', model: 'claude-sonnet-5', effort: 'high', hasSession: true },
    { sesion: { estado: 'con-sesion', metodo: 'api_key', resumen: '✓', detalle: '' } });
  await asentar();
  has(p.modelo().etiquetas().join(' | '), 'Claude Sonnet 5 · 1M',
    'la etiqueta se rearma cuando el CLI contesta con qué credencial entra');
  has(p.renglon(), 'Ventana de contexto: 1M');
});

test('si no se pudo averiguar la sesión, el desplegable se queda en el piso', async function () {
  const p = armarPanel({ provider: 'claude-cli', model: 'claude-sonnet-5', effort: 'high' },
    { sesion: { estado: 'no-se-sabe', metodo: '', resumen: 'no pude comprobarlo', detalle: '' } });
  await asentar();
  eq(p.modelo().etiquetas().join(' | ').indexOf('1M'), -1);
});

test('en Cursor el 1M ya venía en el nombre y no se repite', async function () {
  const p = armarPanel({ provider: 'cursor-cli', model: 'claude-sonnet-5-thinking-high', effort: 'high' });
  await asentar();
  // Cursor pone el 1M dentro del nombre ("Claude Sonnet 5 1M Thinking") y el
  // agrupado por familia ya lo conserva. Pegarle el nuestro encima daría
  // "Claude Sonnet 5 1M · 1M".
  const elegida = p.modelo().elegida();
  has(elegida, '1M');
  eq(elegida.split('1M').length - 1, 1, 'una sola vez: ' + elegida);
  has(p.renglon(), 'Ventana de contexto: 1M');
});

test('un modelo de Cursor sin 1M en el nombre no lo inventa', async function () {
  const p = armarPanel({ provider: 'cursor-cli', model: 'composer-2.5', effort: '' });
  await asentar();
  eq(p.modelo().elegida(), 'Composer 2.5');
  has(p.renglon(), 'no la tengo anotada');
});

test('el renglón arranca sin promedio y lo tiene después de generar', async function () {
  const p = armarPanel({ provider: 'cursor-cli', model: 'claude-sonnet-5-thinking-high', effort: 'high' });
  await asentar();
  has(p.renglon(), 'Todavía no generaste');
  p.store.addSessionUsage({ provider: 'cursor-cli', totalInputTokens: 128412, outputTokens: 6104 });
  // El renglón se refresca solo: la cola puede estar trabajando con ⚙ abierto.
  has(p.renglon(), '128k');
  has(p.renglon(), '13% de 1M');
});

test('cambiar de proveedor no arrastra el promedio del anterior', async function () {
  const p = armarPanel({ provider: 'claude-cli', model: 'claude-sonnet-5', effort: 'high' });
  await asentar();
  p.store.addSessionUsage({ provider: 'cursor-cli', totalInputTokens: 128412, outputTokens: 6104 });
  has(p.renglon(), 'Todavía no generaste con Claude (suscripción)',
    'lo medido con Cursor no describe lo que va a gastar Claude');
});
