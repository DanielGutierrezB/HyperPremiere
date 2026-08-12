'use strict';

// Que un fallo diga POR QUÉ falló.
//
// Un editor en Windows vio esto y nada más: "salio con codigo 1. stderr:
// (vacio)". El motivo había llegado —el CLI, corriendo con --output-format
// json, lo escribe en STDOUT adentro del JSON— y el mensaje lo descartaba antes
// de mostrarlo. Estos tests fijan las tres cosas que no pueden volver a pasar:
// que el motivo se pierda, que se muestre como un bloque de JSON crudo, y que
// una falta de sesión se vea igual que cualquier otra falla.

const path = require('path');
const { test, ok, eq, has } = require('./harness');
const claude = require('../bridge/providers/claude-cli');
const cliErrors = require('../bridge/providers/cli-errors');

const FAKE = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-claude.js');
const saltarEnWindows = process.platform === 'win32';

/** Corre el proveedor contra el CLI de mentira y devuelve el error que tiró. */
async function fallar(modo, opts) {
  const prev = process.env.FAKE_MODE;
  process.env.FAKE_MODE = modo;
  try {
    await claude.generate({
      systemPrompt: 'sistema',
      userPrompt: 'diseñá algo',
      images: [],
      model: (opts && opts.model) || 'modelo-de-prueba',
      config: { binPath: FAKE, timeoutMs: 30000, promptViaStdin: false },
      onActivity: function () {},
    });
    return null; // generó: quien llama va a fallar el test
  } catch (e) {
    return (e && e.message) || String(e);
  } finally {
    if (prev === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = prev;
  }
}

test('con stderr vacío, el motivo que vino por stdout llega al mensaje', async function () {
  if (saltarEnWindows) return console.log('      (se saltea en Windows: el CLI de mentira es un script con shebang)');
  const msg = await fallar('falla-cuota');
  ok(msg, 'la generación tiene que fallar');
  has(msg, 'usage limit reached', 'el motivo que escribió el CLI viaja en el mensaje');
  eq(msg.indexOf('(vacio)'), -1, 'ya no se contesta "(vacío)" con el motivo en la mano');
  eq(msg.indexOf('(vacío)'), -1, 'ni con acentos');
});

test('la falta de sesión se dice con todas las letras y con el próximo paso', async function () {
  if (saltarEnWindows) return;
  const msg = await fallar('falla-sin-sesion');
  has(msg, 'no tiene sesión de Claude', 'la causa dicha por su nombre');
  has(msg, 'claude setup-token', 'el comando concreto que hay que correr');
  has(msg, 'PowerShell o CMD', 'y dónde correrlo en Windows, que es de donde vino el reporte');
  has(msg, '…o pegá el token directamente', 'más el camino que siempre funciona, tal como se llama en el panel');
});

test('el CLI puede cerrar con código 0 y el error adentro: mismo trato', async function () {
  if (saltarEnWindows) return;
  const msg = await fallar('falla-sin-sesion-code0');
  has(msg, 'no tiene sesión de Claude', 'no importa con qué código cerró: importa qué dijo');
  has(msg, 'claude setup-token', 'con el mismo próximo paso');
});

test('el JSON del error se muestra legible, no crudo', async function () {
  if (saltarEnWindows) return;
  const msg = await fallar('falla-sin-sesion');
  has(msg, 'Invalid API key', 'se cita la frase de adentro del JSON');
  eq(msg.indexOf('"is_error"'), -1, 'y no el bloque crudo que el editor no puede leer');
  eq(msg.indexOf('session_id'), -1, 'ni la ferretería del CLI');
});

test('un modelo que no existe se nombra, no se disfraza de código 1', async function () {
  if (saltarEnWindows) return;
  const msg = await fallar('falla-modelo', { model: 'claude-que-no-existe' });
  has(msg, 'no reconoce el modelo "claude-que-no-existe"', 'dice cuál es el modelo del problema');
  has(msg, 'Configuración', 'y dónde se cambia');
});

test('la cuota agotada manda a esperar o a cambiar de proveedor', async function () {
  if (saltarEnWindows) return;
  const msg = await fallar('falla-cuota');
  has(msg, 'sin cupo', 'la causa');
  has(msg, 'Cursor', 'y la salida concreta: generar con el otro proveedor mientras tanto');
});

test('un problema de permisos sigue leyéndose por stderr', async function () {
  if (saltarEnWindows) return;
  const msg = await fallar('falla-permisos');
  has(msg, 'permisos', 'la causa');
  has(msg, 'antivirus', 'con la pista que en Windows es la buena');
  has(msg, 'permission denied', 'y el detalle textual del sistema');
});

test('lo que escribió el modelo no se confunde con la causa del fallo', async function () {
  if (saltarEnWindows) return;
  // Con el estado en vivo, la composición viaja por el MISMO stdout que el
  // error: si se clasifica leyendo todo, una animación que diga "permisos"
  // termina disfrazada de problema de permisos.
  const msg = await fallar('falla-ruido');
  has(msg, 'se cortó la conexión', 'se cita el motivo de verdad, el del cierre');
  eq(msg.indexOf('permisos'), -1, 'y no se inventa una causa con la prosa del modelo');
  eq(msg.indexOf('sin cupo'), -1, 'ni con la otra');
});

test('si el CLI no dijo nada, el mensaje lo admite en vez de inventar', async function () {
  if (saltarEnWindows) return;
  const msg = await fallar('falla-muda');
  has(msg, 'código 1', 'queda el código, que es lo único que hubo');
  has(msg, 'no escribió nada', 'y se dice que no hubo salida, en vez de simular un motivo');
});

// ── La lectura del JSON, por su cuenta ──────────────────────────────────
// El proveedor la usa, pero estas son las formas en que los CLIs mandan un
// error y conviene fijarlas una por una.

test('saca la frase de cada forma en que viaja un error', function () {
  eq(cliErrors.legible('{"is_error":true,"result":"Invalid API key"}'), 'Invalid API key',
    'cierre del CLI de Claude');
  eq(cliErrors.legible('{"error":{"type":"not_found_error","message":"model: x"}}'), 'model: x',
    'error anidado de la API');
  eq(cliErrors.legible('{"error":"se cayó el backend"}'), 'se cayó el backend',
    'error como texto pelado');
  eq(cliErrors.legible('algo explotó'), 'algo explotó',
    'lo que no es JSON se cita tal cual');
  eq(cliErrors.legible('   '), '', 'sin salida, sin invento');
});

test('en el stream-json se queda con el último que dice algo', function () {
  const stream = [
    '{"type":"system","subtype":"init","session_id":"a"}',
    '{"type":"assistant","message":{"content":[]}}',
    '{"type":"result","is_error":true,"result":"Credit balance is too low"}',
  ].join('\n');
  eq(cliErrors.legible(stream), 'Credit balance is too low',
    'el que explica el final está abajo de todo, no arriba');
});

test('stderr manda, pero cuando viene vacío se mira stdout', function () {
  eq(cliErrors.deProceso({ err: 'error real', out: '{"result":"otra cosa"}' }), 'error real');
  eq(cliErrors.deProceso({ err: '\n  \n', out: '{"is_error":true,"result":"el motivo"}' }), 'el motivo',
    'un stderr con solo espacios no cuenta como salida');
  eq(cliErrors.deProceso({ err: '', out: '' }), '');
});

test('le pone nombre a los modos de falla que tienen arreglo distinto', function () {
  eq(cliErrors.causa('Invalid API key · Please run /login'), 'sesion');
  eq(cliErrors.causa('Error: 401 Unauthorized'), 'sesion');
  eq(cliErrors.causa('Claude AI usage limit reached|1799999999'), 'cuota');
  eq(cliErrors.causa('Credit balance is too low'), 'cuota');
  eq(cliErrors.causa('not_found_error: model: claude-x'), 'modelo');
  eq(cliErrors.causa('EACCES: permission denied'), 'permisos');
  eq(cliErrors.causa('se rompió algo raro'), '', 'lo que no reconocemos no se disfraza de nada');
});
