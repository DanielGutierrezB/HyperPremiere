'use strict';

// El cartel de ⚙, del lado del panel (cep/js/config-ui.js).
//
// El motor ya sabe contestar si el CLI puede autenticarse (ver
// claude-session.test.js). Lo que se fija acá es lo otro: qué hace el panel
// con esa respuesta, que es lo único que el editor llega a ver.
//
// La regla es una sola y tiene tres valores, no dos: solo se avisa cuando se
// SABE que falta la sesión. Ni mientras se averigua, ni cuando no se pudo.
// Con dos valores, "todavía no sé" se dibujaba igual que "no tenés", y ése
// era el bug: el editor del caso real generó tres recursos seguidos con el
// cartel puesto.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');

/** Un nodo del DOM con lo poco que config-ui.js le toca. */
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
 *
 * `respuestas` dice qué contesta cada método del motor. Lo importante es
 * `claudeSessionStatus`: es la pregunta nueva y el eje de todo el arreglo.
 */
function armar(respuestas) {
  const nodos = {};
  const pendientes = [];
  const ctx = {
    console: console,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    Date: Date, Math: Math, JSON: JSON,
    HPQueue: { getModelConcurrency: function () { return 3; }, setModelConcurrency: function (n) { return n; } },
    HPWidgets: {
      // El select propio del panel (CEF no dibuja bien los nativos).
      select: function () {
        return {
          value: '', onChange: null,
          setOptions: function (opts, val) { this.value = val || (opts[0] && opts[0].value) || ''; },
        };
      },
    },
    HPEngine: {
      call: function (metodo) {
        const r = respuestas[metodo];
        if (typeof r === 'function') return r();
        return Promise.resolve(r === undefined ? null : r);
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
    nodos: nodos,
    pendientes: pendientes,
    /** Lo que dice el semáforo del resumen. */
    resumen: function () { return nodos['cfg-summary'].textContent; },
    /** Lo que dice el renglón del login. */
    login: function () { return nodos['login-status'].textContent; },
  };
}

/** Deja correr las promesas encadenadas del panel. */
function asentar() {
  return new Promise(function (r) { setTimeout(r, 20); });
}

const CON_TOKEN = { provider: 'claude-cli', model: 'claude-sonnet-5', hasSession: true, effort: 'high', usesEffort: true };
const SIN_TOKEN = { provider: 'claude-cli', model: 'claude-sonnet-5', hasSession: false, effort: 'high', usesEffort: true };

test('el editor que se logueó por su terminal NO recibe el cartel', async function () {
  // El caso del bug: el panel no tiene ningún token guardado (hasSession false)
  // y el CLI igual puede generar, porque tiene su propia sesión. Antes esto
  // dibujaba "⚠ iniciá sesión en Claude" para siempre.
  const p = armar({
    getConfig: SIN_TOKEN,
    claudeSessionStatus: {
      estado: 'con-sesion', metodo: 'claude.ai',
      resumen: '✓ Sesión de Claude activa — con la sesión del CLI de esta máquina', detalle: '',
    },
  });
  await asentar();
  ok(p.resumen().indexOf('iniciá sesión') === -1, 'no se le pide iniciar sesión a quien ya la tiene');
  has(p.resumen(), '✓', 'el semáforo queda en verde');
  has(p.login(), 'sesión del CLI de esta máquina', 'y el renglón dice con qué credencial entra');
});

test('cuando de verdad falta la sesión, el cartel aparece', async function () {
  const p = armar({
    getConfig: SIN_TOKEN,
    claudeSessionStatus: {
      estado: 'sin-sesion', metodo: 'none',
      resumen: 'Esta máquina no tiene sesión de Claude.',
      detalle: 'Qué hacer: abrí una terminal y corré  claude auth login',
    },
  });
  await asentar();
  has(p.resumen(), 'iniciá sesión en Claude', 'el aviso sigue existiendo para el caso que lo merece');
  has(p.login(), 'claude auth login', 'con el próximo paso a la vista');
});

test('si no se pudo averiguar, no se avisa nada', async function () {
  // Un CLI viejo, un binario que no contesta. No saber no es un problema del
  // editor, y tratarlo como uno es exactamente el bug que se vino a sacar.
  const p = armar({
    getConfig: SIN_TOKEN,
    claudeSessionStatus: {
      estado: 'no-se-sabe', metodo: '',
      resumen: 'No pude comprobar la sesión de Claude (esta versión del CLI no conoce `claude auth status`).',
      detalle: 'No quiere decir que falte: si venís generando bien, está todo en orden.',
    },
  });
  await asentar();
  ok(p.resumen().indexOf('iniciá sesión') === -1, 'no se afirma lo que no se sabe');
  has(p.resumen(), '✓', 'el semáforo no se pone en amarillo por una duda nuestra');
  has(p.login(), 'No pude comprobar', 'pero se dice, en el renglón donde corresponde');
});

test('sin el CLI se avisa otra cosa: falta el binario, no la sesión', async function () {
  const p = armar({
    getConfig: SIN_TOKEN,
    claudeSessionStatus: {
      estado: 'sin-cli', metodo: '',
      resumen: 'No encontré el CLI de Claude en esta máquina.',
      detalle: 'Qué hacer: instalalo con  curl -fsSL https://claude.ai/install.sh | bash',
    },
  });
  await asentar();
  has(p.resumen(), 'falta el CLI de Claude', 'mandar a iniciar sesión acá sería hacerle perder el rato');
  ok(p.resumen().indexOf('iniciá sesión') === -1, 'no se confunden los dos problemas');
});

test('mientras se averigua, el panel se queda callado', async function () {
  // La respuesta tarda un cuarto de segundo. En ese rato el cartel no puede
  // decir que falta la sesión: todavía no lo sabe nadie.
  let soltar;
  const p = armar({
    getConfig: SIN_TOKEN,
    claudeSessionStatus: function () { return new Promise(function (r) { soltar = r; }); },
  });
  await asentar();
  ok(p.resumen().indexOf('iniciá sesión') === -1, 'sin respuesta todavía, no se asusta a nadie');
  // Y no alcanza con que no diga la frase: mientras no se sabe, el semáforo no
  // se pone en ámbar. Arrancar en "no" pinta un ⚠ SIN MOTIVO —el motivo todavía
  // no lo contestó nadie— y eso es el bug original con el cartel vacío.
  ok(p.resumen().indexOf('⚠') === -1, 'ni se dibuja el ⚠ con el motivo en blanco');
  has(p.resumen(), '✓', 'no saber todavía no es un problema del editor');
  soltar({ estado: 'sin-sesion', resumen: 'Esta máquina no tiene sesión de Claude.', detalle: '' });
  await asentar();
  has(p.resumen(), 'iniciá sesión en Claude', 'y cuando la respuesta llega, se dice');
});

test('con el token guardado en el panel el verde no espera a nadie', async function () {
  // Este caso se sabe sin preguntar: el token lo inyectamos nosotros. Que no
  // parpadee en el arranque es la razón de que el valor inicial no sea "?".
  const p = armar({ getConfig: CON_TOKEN, claudeSessionStatus: function () { return new Promise(function () {}); } });
  await asentar();
  has(p.resumen(), '✓', 'verde desde el primer dibujo');
});

test('el semáforo de los otros proveedores no cambió', async function () {
  const p = armar({ getConfig: { provider: 'claude-api', model: 'claude-sonnet-5', apiKey: '', hasSession: false } });
  await asentar();
  has(p.resumen(), 'falta API key', 'la API key se sigue exigiendo igual');
});
