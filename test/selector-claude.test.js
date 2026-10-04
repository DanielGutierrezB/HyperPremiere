'use strict';

// EL SELECTOR DE ⚙ CON CLAUDE POR EL CLI, del lado del panel.
//
// El pedido fue el de Editor Pro: ver todos los modelos, la ventana de contexto
// y los niveles de pensamiento, con qué versión hay detrás de cada uno. Lo que
// se fija acá es lo que el editor ve y lo que queda guardado cuando toca algo:
//
//   - los modelos agrupados por familia, con el último arriba y su versión
//     medida, y los que el plan no tiene a la vista pero sin poder elegirlos;
//   - que abrir ⚙ no cambie con qué se genera;
//   - que cada elección guarde el `--model` EXACTO de su celda;
//   - que la ventana no se arrastre cuando no fue una elección;
//   - la medición que corre sola una vez por versión del CLI, y Verificar.
//
// El motor de mentira contesta el catálogo con el módulo de verdad
// (bridge/claude-modelos.js) y la medición real de Claude Code 2.1.288: lo
// único simulado es el DOM.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, deepEq, has } = require('./harness');
const CM = require('../bridge/claude-modelos');

const CEP = path.join(__dirname, '..', 'cep', 'js');

const MENU = [
  { familia: 'sonnet', id: 'claude-sonnet-4-6', etiqueta: 'Sonnet 4.6', legacy: true },
  { familia: 'opus', id: 'claude-opus-4-1', etiqueta: 'Opus 4.1', legacy: true },
  { familia: 'opus', id: 'claude-opus-4-6', etiqueta: 'Opus 4.6', legacy: true },
  { familia: 'opus', id: 'claude-opus-5', etiqueta: 'Opus 5', legacy: false },
];

function contesto(id, ventana) { return { contesto: { id: id, ventana: ventana, salida: 64000 }, error: '' }; }

const MEDIDA = CM.registrarMedicion('2.1.288', {
  fable: contesto('claude-fable-5-1', 1000000),
  opus: contesto('claude-opus-5-5', 1000000),
  sonnet: contesto('claude-sonnet-5-5', 1000000),
  haiku: contesto('claude-haiku-4-5-20251001', 200000),
  'claude-sonnet-4-6': contesto('claude-sonnet-4-6', 200000),
  'claude-sonnet-4-6[1m]': contesto('claude-sonnet-4-6[1m]', 1000000),
  'claude-opus-4-1': contesto('claude-opus-5-5', 1000000),
  'claude-opus-4-6': contesto('claude-opus-4-6', 200000),
  'claude-opus-4-6[1m]': contesto('claude-opus-4-6[1m]', 1000000),
  'claude-opus-5': contesto('claude-opus-5', 1000000),
  'haiku[1m]': { contesto: null, error: 'The long context beta is not yet available for this subscription.' },
}, '2026-10-03T12:00:00.000Z');

function nodo(id) {
  return {
    id: id, value: '', textContent: '', className: '', disabled: false,
    style: {}, atributos: {}, oyentes: {},
    setAttribute: function (k, v) { this.atributos[k] = v; },
    getAttribute: function (k) { return this.atributos[k]; },
    removeAttribute: function (k) { delete this.atributos[k]; },
    addEventListener: function (tipo, fn) { this.oyentes[tipo] = fn; },
    click: function () { if (this.oyentes.click) this.oyentes.click({}); },
    focus: function () {},
  };
}

/**
 * ⚙ con el CLI de Claude. `o.medida` es lo que el motor tiene medido (null:
 * nada todavía); `o.sesion`, lo que contesta el chequeo de sesión.
 */
function armar(cfg, o) {
  o = o || {};
  const nodos = {};
  const selects = {};
  const guardados = [];
  const llamadas = [];
  let guardado = Object.assign({}, cfg);
  const medidaDe = { actual: o.medida === undefined ? MEDIDA : o.medida };

  function catalogo(body) {
    const c = CM.catalogo({
      menu: MENU, medicion: medidaDe.actual, cli: o.cli || '2.1.288',
      modelo: (body && body.model) || guardado.model, esfuerzo: (body && body.effort) || guardado.effort,
    });
    return Object.assign({ ok: true, instalado: true }, c);
  }

  const ctx = {
    console: console, JSON: JSON, Math: Math, Date: Date,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    HPQueue: { getModelConcurrency: function () { return 3; }, setModelConcurrency: function (n) { return n; } },
    HPLog: { log: function (t) { llamadas.push({ metodo: 'log', texto: t }); } },
    HPWidgets: {
      select: function (el) {
        const s = {
          nombre: el && el.id, value: '', onChange: null, opciones: [], deshabilitado: false,
          setOptions: function (opts, val) {
            this.opciones = opts.slice();
            this.value = val != null ? String(val) : ((opts[0] && opts[0].value) || '');
          },
          setDisabled: function (v) { this.deshabilitado = !!v; },
          elegir: function (v) {
            const op = this.opciones.find((x) => x.value === v);
            if (op && op.deshabilitada) return; // como el de verdad: no se puede
            const cambio = (v !== this.value);
            this.value = v;
            if (cambio && typeof this.onChange === 'function') this.onChange(v);
          },
          etiquetas: function () { return this.opciones.map((x) => x.label); },
          valores: function () { return this.opciones.map((x) => x.value); },
          opcion: function (v) { return this.opciones.find((x) => x.value === v); },
        };
        selects[s.nombre] = s;
        return s;
      },
    },
    HPEngine: {
      call: function (metodo, body) {
        llamadas.push({ metodo: metodo, body: body });
        if (metodo === 'setConfig') {
          guardados.push(body || {});
          guardado = Object.assign({}, guardado, body);
          return Promise.resolve(guardado);
        }
        if (metodo === 'getConfig') return Promise.resolve(guardado);
        if (metodo === 'catalogoClaude') return Promise.resolve(o.sinCatalogo ? null : catalogo(body));
        if (metodo === 'claudeSessionStatus') {
          return Promise.resolve(o.sesion || { estado: 'con-sesion', metodo: 'claude.ai', resumen: '✓ Sesión activa', detalle: '' });
        }
        if (metodo === 'testProvider') return Promise.resolve({ ok: true, detail: 'ok' });
        return Promise.resolve(null);
      },
      callProg: function (metodo, body, prog) {
        llamadas.push({ metodo: metodo, body: body });
        if (metodo === 'medirModelosClaude') {
          prog({ msg: 'Comprobando qué versiones ofrece tu plan… 3/11' });
          if (o.medicionFalla) {
            return Promise.resolve(Object.assign(catalogo(body), { medida: false,
              estado: 'No pude comprobar las versiones: getaddrinfo ENOTFOUND api.anthropic.com' }));
          }
          medidaDe.actual = MEDIDA;
          return Promise.resolve(Object.assign(catalogo(body), { medida: true }));
        }
        if (metodo === 'verificarClaude') {
          prog({ msg: 'Comprobando qué versiones responden… 5/11' });
          medidaDe.actual = MEDIDA;
          const c = catalogo(body);
          return Promise.resolve({ ok: true, cli: '2.1.289', actualizado: true, ultima: '2.1.289',
            notas: [], resumen: CM.resumen(c), catalogo: c });
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
  ['util.js', 'iconos.js', 'motores.js', 'claude-selector.js', 'config-ui.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  });
  ctx.HPConfigUI.init();
  return {
    api: ctx.HPConfigUI,
    nodos: nodos,
    guardados: guardados,
    llamadas: llamadas,
    proveedor: function () { return selects['cfg-provider']; },
    modelo: function () { return selects['cfg-model']; },
    ventana: function () { return selects['cfg-window']; },
    pensamiento: function () { return selects['cfg-effort']; },
    acerca: function () { return nodos['cfg-claude-about'].textContent; },
    resumen: function () { return nodos['cfg-summary'].textContent; },
    renglon: function () { return nodos['cfg-context'].textContent; },
    veces: function (metodo) { return llamadas.filter((l) => l.metodo === metodo).length; },
    ultimoGuardado: function () { return guardados[guardados.length - 1] || null; },
  };
}

function asentar() {
  return new Promise(function (r) { setTimeout(r, 25); });
}

const OPUS = { provider: 'claude-cli', model: 'opus', effort: 'high', hasSession: true };

// ── Lo que se ve ──────────────────────────────────────────────────────

test('los modelos se ven agrupados por familia, con la versión que hay detrás', async function () {
  const p = armar(OPUS);
  await asentar();
  const ops = p.modelo().opciones;
  eq(ops[0].label, 'Predeterminado de tu plan');
  deepEq(ops.filter((x) => x.grupo).map((x) => x.grupo).filter((g, i, a) => a.indexOf(g) === i),
    ['Fable', 'Opus', 'Sonnet', 'Haiku']);
  const opus = ops.filter((x) => x.grupo === 'Opus').map((x) => x.label);
  deepEq(opus, ['Opus 5.5 · último', 'Opus 5', 'Opus 4.6 · legacy', 'Opus 4.1 · legacy (no disponible)']);
});

test('lo que el plan no tiene se VE, pero no se puede elegir, y dice por qué', async function () {
  const p = armar(OPUS);
  await asentar();
  const retirada = p.modelo().opcion('claude-opus-4-1');
  eq(retirada.deshabilitada, true);
  eq(retirada.ayuda, 'Retirada: la contesta Opus 5.5');
  p.modelo().elegir('claude-opus-4-1');
  await asentar();
  eq(p.guardados.length, 0, 'no se puede guardar algo que contesta otro modelo');
});

test('la elegida no se deshabilita aunque el plan ya no la tenga', async function () {
  // Si se deshabilitara, el desplegable mostraría otra y el editor no sabría qué tiene puesto.
  const p = armar({ provider: 'claude-cli', model: 'claude-opus-4-1', effort: 'high', hasSession: true });
  await asentar();
  eq(p.modelo().value, 'claude-opus-4-1');
  eq(p.modelo().opcion('claude-opus-4-1').deshabilitada, false);
  has(p.acerca(), 'No está disponible en tu plan ahora: Retirada: la contesta Opus 5.5');
});

test('abajo se lee qué es, qué ventana trae, qué hace ese nivel y con qué CLI se comprobó', async function () {
  const p = armar(OPUS);
  await asentar();
  const a = p.acerca();
  has(a, 'Siempre el último Opus de tu Claude Code (hoy Opus 5.5).');
  has(a, 'Viene con la ventana de 1M de serie.');
  has(a, 'Pensamiento: piensa con cuidado');
  has(a, 'Comprobado con Claude Code 2.1.288.');
});

test('el resumen de ⚙ dice versión, ventana y nivel', async function () {
  const p = armar(OPUS);
  await asentar();
  eq(p.resumen(), '✓ Claude (suscripción) · Opus 5.5 · 1M · pensamiento Alto');
});

test('el renglón de la ventana dice la MEDIDA, no un piso de 200k', async function () {
  const p = armar({ provider: 'claude-cli', model: 'claude-sonnet-4-6', effort: 'high', hasSession: true });
  await asentar();
  has(p.renglon(), 'Ventana de contexto: 200k, medida con tu cuenta.');
  p.ventana().elegir('1m');
  await asentar();
  has(p.renglon(), 'Ventana de contexto: 1M, medida con tu cuenta.');
});

// ── Lo que se guarda ──────────────────────────────────────────────────

test('abrir ⚙ no cambia con qué se genera', async function () {
  // La config de esta máquina era `claude-opus-5`: una versión fija desde que salió Opus 5.5.
  const p = armar({ provider: 'claude-cli', model: 'claude-opus-5', effort: 'high', hasSession: true });
  await asentar();
  eq(p.guardados.length, 0, 'abrir no guarda nada');
  eq(p.modelo().value, 'claude-opus-5');
  has(p.acerca(), 'Fijado en Opus 5: no cambia cuando se actualiza Claude Code.');
  eq(p.api.modelName(), 'claude-opus-5');
});

test('elegir el último guarda el ALIAS, que avanza solo con el CLI', async function () {
  const p = armar({ provider: 'claude-cli', model: 'claude-opus-5', effort: 'high', hasSession: true });
  await asentar();
  p.modelo().elegir('opus');
  await asentar();
  eq(p.ultimoGuardado().model, 'opus');
});

test('cada ventana guarda su --model exacto', async function () {
  const p = armar({ provider: 'claude-cli', model: 'claude-opus-4-6', effort: 'high', hasSession: true });
  await asentar();
  deepEq(p.ventana().etiquetas(), ['200k', '1M']);
  eq(p.ventana().deshabilitado, false, 'acá sí hay algo que elegir');
  p.ventana().elegir('1m');
  await asentar();
  eq(p.ultimoGuardado().model, 'claude-opus-4-6[1m]');
  has(p.acerca(), 'Puede gastar créditos extra de tu plan.');
});

test('con 1M de serie la ventana se ve pero no se toca', async function () {
  const p = armar(OPUS);
  await asentar();
  deepEq(p.ventana().etiquetas(), ['1M (de serie)']);
  eq(p.ventana().deshabilitado, true);
});

test('la ventana elegida se arrastra al cambiar de modelo, si el otro la tiene', async function () {
  const p = armar({ provider: 'claude-cli', model: 'claude-opus-4-6[1m]', effort: 'high', hasSession: true });
  await asentar();
  p.modelo().elegir('claude-sonnet-4-6');
  await asentar();
  eq(p.ultimoGuardado().model, 'claude-sonnet-4-6[1m]', 'el editor eligió 1M y lo sigue queriendo');
});

test('un 1M que no se eligió no se arrastra: puede gastar créditos extra', async function () {
  // Opus 5.5 trae 1M de serie: ahí no hubo elección. Pasar a Opus 4.6 no puede
  // dejarle puesto el 1M extendido que nadie pidió.
  const p = armar(OPUS);
  await asentar();
  p.modelo().elegir('claude-opus-4-6');
  await asentar();
  eq(p.ultimoGuardado().model, 'claude-opus-4-6');
  eq(p.ventana().value, 'serie');
});

test('un 1M que el plan no tiene no se puede elegir', async function () {
  const p = armar({ provider: 'claude-cli', model: 'haiku', effort: 'high', hasSession: true });
  await asentar();
  const largo = p.ventana().opcion('1m');
  eq(largo.deshabilitada, true);
  has(largo.ayuda, 'not yet available');
  p.ventana().elegir('1m');
  await asentar();
  eq(p.guardados.length, 0);
});

test('seis niveles de pensamiento, y "Predeterminado" guarda que decida el modelo', async function () {
  const p = armar(OPUS);
  await asentar();
  deepEq(p.pensamiento().valores(), ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
  deepEq(p.pensamiento().etiquetas(), ['Predeterminado', 'Bajo', 'Medio', 'Alto', 'Muy alto', 'Máximo']);
  p.pensamiento().elegir('default');
  await asentar();
  eq(p.ultimoGuardado().effort, 'default');
  eq(p.ultimoGuardado().model, 'opus', 'cambiar el nivel no toca el modelo');
  has(p.acerca(), 'Pensamiento: no se lo indico y decide el modelo');
});

// ── Medir y verificar ─────────────────────────────────────────────────

test('sin medir, mide solo al confirmarse la sesión', async function () {
  const p = armar(OPUS, { medida: null });
  await asentar();
  eq(p.veces('medirModelosClaude'), 1, 'sin esto el selector dice "Opus · último", que no dice qué modelo tenés');
  eq(p.modelo().opcion('opus').label, 'Opus 5.5 · último', 'y al terminar, el desplegable ya dice la versión');
});

test('si la medición falla, no se repite cada vez que se recarga ⚙: para eso está Verificar', async function () {
  const p = armar(OPUS, { medida: null, medicionFalla: true });
  await asentar();
  eq(p.veces('medirModelosClaude'), 1);
  has(p.acerca(), 'No pude comprobar las versiones');
  // Volver a elegir el proveedor rearma todo y vuelve a pedir el catálogo.
  p.proveedor().onChange('claude-cli');
  await asentar();
  ok(p.veces('catalogoClaude') >= 2, 'el catálogo sí se volvió a pedir');
  eq(p.veces('medirModelosClaude'), 1, 'la medición no: doce llamadas por cada recarga sería gastar el plan en nada');
});

test('sin sesión no mide: cada llamada fallaría por lo mismo', async function () {
  const p = armar(OPUS, { medida: null, sesion: { estado: 'sin-sesion', resumen: 'Esta máquina no tiene sesión de Claude.', detalle: '' } });
  await asentar();
  eq(p.veces('medirModelosClaude'), 0);
});

test('con lo medido al día no mide nada al abrir', async function () {
  const p = armar(OPUS);
  await asentar();
  eq(p.veces('medirModelosClaude'), 0, 'abrir ⚙ no puede gastar uso del plan cada vez');
});

test('Verificar dice cada paso y al final con qué contestó', async function () {
  const p = armar(OPUS);
  await asentar();
  p.nodos['btn-claude-verify'].click();
  await asentar();
  eq(p.veces('verificarClaude'), 1);
  const linea = p.nodos['login-status'].textContent;
  has(linea, '✓ Claude contestó · Opus 5.5 · 1M · pensamiento Alto');
  has(linea, 'Claude Code 2.1.289 (actualizado)');
  eq(p.nodos['btn-claude-verify'].disabled, false, 'el botón vuelve a quedar disponible');
});

test('si el motor no trae catálogo, ⚙ muestra lo guardado y no inventa nada', async function () {
  const p = armar({ provider: 'claude-cli', model: 'claude-opus-5', effort: 'high', hasSession: true }, { sinCatalogo: true });
  await asentar();
  deepEq(p.modelo().valores(), ['claude-opus-5']);
  eq(p.guardados.length, 0);
  eq(p.api.modelName(), 'claude-opus-5');
});

// ── Los otros proveedores no se tocan ─────────────────────────────────

test('con la API de Claude sigue la lista de la cuenta, sin el selector del CLI', async function () {
  const p = armar({ provider: 'claude-api', model: 'claude-sonnet-5', effort: 'high' });
  await asentar();
  eq(p.veces('catalogoClaude'), 0);
  eq(p.nodos['row-window'].atributos['data-hidden'], 'true');
  eq(p.nodos['cfg-claude-about'].atributos['data-hidden'], 'true');
});
