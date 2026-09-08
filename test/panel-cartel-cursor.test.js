'use strict';

// El cartel de ⚙ con CURSOR elegido, del lado del panel.
//
// Es el mismo arreglo que se le hizo a Claude en su momento (ver
// panel-cartel-sesion.test.js) aplicado al proveedor que no lo tenía: hasta la
// 1.5.0, con Cursor elegido el panel no preguntaba nada y el editor se enteraba
// de que le faltaba la sesión cuando una generación se caía con el error crudo
// del proceso —`spawn cursor-agent ENOENT` primero, y después
// `Authentication required. Run 'agent login'…`—.
//
// La regla que se fija acá es la misma y por el mismo motivo: solo se avisa
// cuando se SABE que falta. Con dos valores en vez de tres, "todavía no sé" se
// dibuja igual que "no tenés", que es el bug que ya se pagó una vez en Claude.
// Y uno nuevo, el cuarto: "hay credencial pero la cuenta no tiene cupo".

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');

function nodo(id) {
  return {
    id: id, value: '', textContent: '', className: '', disabled: false, open: false,
    style: {}, atributos: {},
    setAttribute: function (k, v) { this.atributos[k] = v; },
    getAttribute: function (k) { return this.atributos[k]; },
    removeAttribute: function (k) { delete this.atributos[k]; },
    addEventListener: function (ev, fn) { if (ev === 'click') this.alClic = fn; },
    focus: function () {},
  };
}

function armar(respuestas) {
  const nodos = {};
  const llamados = [];
  const ctx = {
    console: console,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    Date: Date, Math: Math, JSON: JSON,
    HPQueue: { getModelConcurrency: function () { return 3; }, setModelConcurrency: function (n) { return n; } },
    HPWidgets: {
      select: function () {
        return {
          value: '', onChange: null,
          setOptions: function (opts, val) { this.value = val || (opts[0] && opts[0].value) || ''; },
        };
      },
    },
    HPEngine: {
      call: function (metodo) {
        llamados.push(metodo);
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
    llamados: llamados,
    resumen: function () { return nodos['cfg-summary'].textContent; },
    clase: function () { return nodos['cfg-summary'].className; },
    /** El renglón de estado propio de Cursor. */
    cursor: function () { return nodos['cursor-status'].textContent; },
    /** El renglón de Claude, que con Cursor elegido no tiene nada que decir. */
    claude: function () { return nodos['login-status'].textContent; },
  };
}

function asentar() {
  return new Promise(function (r) { setTimeout(r, 20); });
}

const CURSOR = {
  provider: 'cursor-cli', model: 'claude-sonnet-5-thinking-high',
  hasSession: false, effort: 'high', usesEffort: true,
};

// --- Los tres estados, más el de cupo ----------------------------------------

test('con sesión de Cursor, el semáforo queda en verde y dice con qué entra', async function () {
  const p = armar({
    getConfig: CURSOR,
    cursorSessionStatus: {
      estado: 'con-sesion',
      resumen: '✓ Sesión de Cursor activa — con la sesión del CLI de esta máquina (editor@estudio.com)',
      detalle: '',
    },
  });
  await asentar();
  has(p.resumen(), '✓');
  ok(p.resumen().indexOf('iniciá sesión') === -1);
  has(p.cursor(), 'editor@estudio.com', 'con qué credencial entra, que es lo que se manda por chat');
});

test('sin sesión, el cartel nombra a CURSOR y no a Claude', async function () {
  // El caso exacto del editor: instaló el CLI y le faltaba el login. Antes de
  // esto, el panel no tenía nada que decirle hasta que una generación fallara.
  const p = armar({
    getConfig: CURSOR,
    cursorSessionStatus: {
      estado: 'sin-sesion',
      resumen: 'Esta máquina no tiene sesión de Cursor.',
      detalle: 'Qué hacer: abrí una terminal y corré  ~/.local/bin/cursor-agent login',
    },
  });
  await asentar();
  has(p.resumen(), 'iniciá sesión en Cursor');
  ok(p.resumen().indexOf('Claude') === -1,
    'mandar a arreglar Claude a alguien que eligió Cursor es mandarlo a trabajar para nosotros');
  has(p.cursor(), 'cursor-agent login', 'con el próximo paso a la vista');
});

test('si no se pudo averiguar, NO se dibuja como que falta', async function () {
  // Es el bug que ya se pagó una vez con Claude: el panel mostraba "falta
  // iniciar sesión" mientras el editor generaba sin problemas. Repetirlo en
  // Cursor sería pagarlo dos veces.
  const p = armar({
    getConfig: CURSOR,
    cursorSessionStatus: {
      estado: 'no-se-sabe',
      resumen: 'No pude comprobar la sesión de Cursor.',
      detalle: 'No quiere decir que falte: si venís generando bien, está todo en orden.',
    },
  });
  await asentar();
  ok(p.resumen().indexOf('iniciá sesión') === -1, 'no se afirma lo que no se sabe');
  ok(p.resumen().indexOf('falta') === -1);
  has(p.resumen(), '✓', 'el semáforo no se pone en rojo por una duda nuestra');
  has(p.cursor(), 'No pude comprobar', 'pero se dice, en el renglón donde corresponde');
});

test('sin el CLI se avisa otra cosa: falta el binario, no la sesión', async function () {
  // La primera captura del editor: `spawn cursor-agent ENOENT`.
  const p = armar({
    getConfig: CURSOR,
    cursorSessionStatus: {
      estado: 'sin-cli',
      resumen: 'No encontré el CLI de Cursor en esta máquina.',
      detalle: 'Qué hacer: instalalo con  curl https://cursor.com/install -fsS | bash',
    },
  });
  await asentar();
  has(p.resumen(), 'falta el CLI de Cursor');
  ok(p.resumen().indexOf('iniciá sesión') === -1, 'no se confunden los dos problemas');
  has(p.cursor(), 'cursor.com/install');
});

test('mientras se averigua, el panel se queda callado', async function () {
  let soltar;
  const p = armar({
    getConfig: CURSOR,
    cursorSessionStatus: function () { return new Promise(function (r) { soltar = r; }); },
  });
  await asentar();
  ok(p.resumen().indexOf('iniciá sesión') === -1, 'sin respuesta todavía, no se asusta a nadie');
  soltar({ estado: 'sin-sesion', resumen: 'Esta máquina no tiene sesión de Cursor.', detalle: '' });
  await asentar();
  has(p.resumen(), 'iniciá sesión en Cursor', 'y cuando la respuesta llega, se dice');
});

// --- El cuarto estado: hay credencial y aun así no va a poder ----------------

test('"sin cupo" se dibuja en ámbar, no en verde ni en rojo', async function () {
  // El caso real, tal como llegó en la captura: indicador verde arriba y
  // `Credit balance is too low` en la cola, abajo. Las dos cosas eran ciertas y
  // juntas le mentían al editor.
  const p = armar({
    getConfig: CURSOR,
    cursorSessionStatus: {
      estado: 'sin-cupo',
      resumen: '⚠ hay credencial, pero la cuenta no tiene cupo.',
      detalle: 'Qué hacer: esperá a que se renueve, cargá crédito, o cambiá de proveedor en ⚙.',
    },
  });
  await asentar();
  ok(p.resumen().indexOf('✓') === -1, 'verde sería la mentira que se vino a sacar');
  has(p.resumen(), 'sin cupo');
  has(p.resumen(), 'Cursor', 'y de qué proveedor: el editor puede tener dos y solo uno agotado');
  has(p.clase(), 'is-cupo',
    'ni rojo: rojo es "te falta configurar algo", y acá está todo puesto');
  has(p.cursor(), 'cargá crédito', 'con la salida, que no está adentro del panel');
});

test('sin cupo NO se le pide iniciar sesión: la credencial está', async function () {
  const p = armar({
    getConfig: CURSOR,
    cursorSessionStatus: { estado: 'sin-cupo', resumen: '⚠ hay credencial, pero la cuenta no tiene cupo.', detalle: '' },
  });
  await asentar();
  ok(p.resumen().indexOf('iniciá sesión') === -1,
    'loguearse de nuevo no carga crédito: es hacerle perder el rato');
});

// --- Que Claude no opine cuando no es el elegido -----------------------------

test('con Cursor elegido, a Claude no se le pregunta nada', async function () {
  const p = armar({
    getConfig: CURSOR,
    cursorSessionStatus: { estado: 'con-sesion', resumen: '✓ Sesión de Cursor activa', detalle: '' },
    claudeSessionStatus: { estado: 'sin-sesion', resumen: 'Esta máquina no tiene sesión de Claude.', detalle: '' },
  });
  await asentar();
  ok(p.llamados.indexOf('claudeSessionStatus') === -1,
    'preguntar por un proveedor que no se eligió es un arranque de CLI regalado');
  eq(p.claude(), '', 'y su renglón queda vacío: no tiene nada que decir acá');
  // OJO con qué se busca: la palabra "Claude" SÍ aparece, y está bien, porque
  // el modelo que el editor eligió adentro de Cursor es un Claude ("Claude
  // Sonnet 5 1M"). Lo que no puede aparecer es que le pidan arreglar Claude.
  ['iniciá sesión en Claude', 'falta el CLI de Claude', 'claude auth login'].forEach(function (t) {
    ok(p.resumen().indexOf(t) === -1, 'no corresponde: "' + t + '"');
  });
});

test('y al revés: con Claude elegido no se le pregunta a Cursor', async function () {
  const p = armar({
    getConfig: { provider: 'claude-cli', model: 'claude-sonnet-5', hasSession: true },
    claudeSessionStatus: { estado: 'con-sesion', resumen: '✓ Sesión de Claude activa', detalle: '' },
  });
  await asentar();
  ok(p.llamados.indexOf('cursorSessionStatus') === -1);
  eq(p.cursor(), '');
});

// --- El diagnóstico ----------------------------------------------------------

test('el botón de Diagnóstico de Cursor arma la ficha aunque el CLI no esté', async function () {
  // Es lo que le pedimos al editor que apriete y nos mande cuando algo no anda
  // en su máquina y no la tenemos adelante. Si justo cuando falta el CLI el
  // botón no contestara nada, no serviría para el único caso que importa.
  const p = armar({
    getConfig: CURSOR,
    cursorSessionStatus: { estado: 'sin-cli', resumen: 'No encontré el CLI de Cursor.', detalle: '' },
    cursorCliStatus: {
      ok: false,
      report: 'CLI de Cursor: NO encontrado\nBuscado en: /usr/local/bin, ~/.local/bin, /opt/homebrew/bin',
    },
  });
  await asentar();
  p.nodos['btn-cursor-doctor'].alClic();
  await asentar();
  has(p.cursor(), 'NO encontrado');
  has(p.cursor(), 'Buscado en', 'dónde se buscó, que es lo que distingue "no está" de "no lo veo"');
});
