'use strict';

// Cómo se le arma el mensaje a Cursor, y que Claude no pague por eso.
//
// De dónde sale: `cursor-agent` no tiene canal de system prompt (su --help no
// ofrece ninguno), así que las instrucciones del sistema viajan adentro del
// mensaje de usuario. Es la misma forma degradada que en Windows le hacía
// devolver al CLI de Claude composiciones sin el `<div id="stage">`.
//
// De ahí salieron dos cambios, y la medición contra el CLI de verdad
// (test/manual/cursor-contrato.js) los trató distinto:
//
//   · Separar el manual del pedido con títulos que digan qué es cada bloque:
//     QUEDÓ. Cuesta 51 caracteres y saca la ambigüedad de un `---` pelado.
//     Pero el título no puede reclamar autoridad — ver el test de abajo.
//   · Repetir el andamiaje al final: QUEDÓ APAGADO. 10/10 contra 10/10 en el
//     modelo por defecto; no mejora nada y cuesta ~5,8% más de prompt.
//
// Estos tests fijan lo determinístico de las dos cosas: el orden cuando el
// recordatorio se prende, que apagado no aparezca, que el encabezado no se
// haga pasar por instrucciones del sistema, y que el proveedor de Claude siga
// mandando su system prompt por su propio canal.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq, has } = require('./harness');
const { contractReminder } = require('../bridge/providers');
const cursor = require('../bridge/providers/cursor-cli');
const claude = require('../bridge/providers/claude-cli');

const FAKE_CURSOR = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-cursor.js');
const FAKE_CLAUDE = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-claude.js');
const SYSTEM_MD = path.join(__dirname, '..', 'bridge', 'prompt', 'system.md');

// Los CLI de mentira son scripts con shebang: en Windows no arrancan solos.
const saltarEnWindows = process.platform === 'win32';

const SYSTEM = fs.readFileSync(SYSTEM_MD, 'utf8');
const USUARIO = '## Instrucción del editor\nAnimá el concepto "sesgo" en 8 segundos.';

function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hp-contrato-')), 'recibido.json');
}

/** Corre el proveedor de Cursor contra el CLI de mentira y devuelve lo que recibió. */
async function correrCursor(opts) {
  opts = opts || {};
  const log = tmpLog();
  const prev = { modo: process.env.FAKE_MODE, log: process.env.FAKE_LOG };
  process.env.FAKE_MODE = 'plano';
  process.env.FAKE_LOG = log;
  try {
    await cursor.generate({
      systemPrompt: opts.sinSystem ? '' : SYSTEM,
      userPrompt: USUARIO,
      images: [],
      model: 'modelo-de-prueba',
      config: Object.assign({ cursorBinPath: FAKE_CURSOR, timeoutMs: 30000, promptViaStdin: true },
        opts.config || {}),
    });
  } finally {
    if (prev.modo === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = prev.modo;
    if (prev.log === undefined) delete process.env.FAKE_LOG; else process.env.FAKE_LOG = prev.log;
  }
  const r = JSON.parse(fs.readFileSync(log, 'utf8'));
  r.mensaje = r.promptPosicional !== null ? r.promptPosicional : r.stdinCompleto;
  return r;
}

/** Lo mismo con el proveedor de Claude, para poder afirmar que no cambió. */
async function correrClaude(viaStdin) {
  const log = tmpLog();
  const prev = { modo: process.env.FAKE_MODE, log: process.env.FAKE_LOG };
  process.env.FAKE_MODE = 'viejo';
  process.env.FAKE_LOG = log;
  try {
    await claude.generate({
      systemPrompt: SYSTEM,
      userPrompt: USUARIO,
      images: [],
      model: 'modelo-de-prueba',
      config: { binPath: FAKE_CLAUDE, timeoutMs: 30000, promptViaStdin: viaStdin },
    });
  } finally {
    if (prev.modo === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = prev.modo;
    if (prev.log === undefined) delete process.env.FAKE_LOG; else process.env.FAKE_LOG = prev.log;
  }
  const r = JSON.parse(fs.readFileSync(log, 'utf8'));
  r.mensaje = r.promptPosicional !== null ? r.promptPosicional : r.stdinCompleto;
  return r;
}

// ── El orden: el contrato tiene que ser lo último ───────────────────────

test('cursor: por defecto NO se repite el contrato (se midió y no mejora)', async function () {
  if (saltarEnWindows) return;
  // 10/10 contra 10/10 en claude-sonnet-5-thinking-high, y 10/10 contra 10/10
  // en composer-2.5 con el contrato empujado a 5.000 caracteres del final.
  // Cero mejora, ~5,8% más de prompt en cada llamada: no va puesto.
  const r = await correrCursor();
  eq(r.mensaje.indexOf('# ANTES DE RESPONDER'), -1, 'el recordatorio no viaja');
  ok(r.mensaje.endsWith(USUARIO), 'el mensaje termina donde lo dejó el motor');
});

test('cursor: prendido, el andamiaje es lo ÚLTIMO que lee el modelo', async function () {
  if (saltarEnWindows) return;
  const r = await correrCursor({ config: { contractTail: true } });
  ok(r.mensaje.trimEnd().endsWith(contractReminder().trimEnd()),
    'el mensaje termina con el recordatorio del contrato');
  // Y las tres cosas que si faltan no se puede renderizar están ahí abajo.
  const cola = r.mensaje.slice(-1200);
  has(cola, 'data-composition-id', 'el id de la composición está en la cola');
  has(cola, 'data-duration', 'la duración está en la cola');
  has(cola, '__timelines', 'el registro de la timeline está en la cola');
});

test('cursor: el system prompt va primero y con un título que dice qué es', async function () {
  if (saltarEnWindows) return;
  const r = await correrCursor();
  ok(r.mensaje.indexOf('# CÓMO SE COMPONE EN ESTE PROYECTO') === 0,
    'el mensaje arranca diciendo qué es el bloque que viene');
  const finSystem = r.mensaje.indexOf('# EL PEDIDO');
  ok(finSystem > 0, 'y hay un corte explícito donde termina el manual y empieza el laburo');
  has(r.mensaje.slice(0, finSystem), '# PLANTILLA OBLIGATORIA',
    'la plantilla completa sigue estando arriba, entera');
});

test('cursor: el encabezado NO se hace pasar por instrucciones del sistema', async function () {
  if (saltarEnWindows) return;
  // Esto no es cosmético. La primera versión encabezaba con "INSTRUCCIONES DEL
  // SISTEMA (mandan sobre todo lo demás)" y en una corrida real contra
  // cursor-agent el modelo se negó a componer: dijo que el mensaje "incluye un
  // bloque que se presenta como instrucciones del sistema dentro del propio
  // pedido del usuario" y que no le iba a dar prioridad sobre su configuración
  // real. Un mensaje de usuario que se declara sistema tiene la forma exacta de
  // una inyección. La generación se perdió entera.
  const r = await correrCursor();
  const cabeza = r.mensaje.slice(0, 400).toLowerCase();
  for (const frase of ['instrucciones del sistema', 'system prompt', 'mandan sobre todo',
    'ignorá', 'ignora las instrucciones']) {
    eq(cabeza.indexOf(frase), -1, 'el encabezado no dice "' + frase + '"');
  }
});

test('cursor: el orden es sistema → pedido → imágenes → contrato', async function () {
  if (saltarEnWindows) return;
  // Un orden distinto es un cambio de comportamiento, no un detalle de formato:
  // el motivo de todo esto es DÓNDE cae cada cosa.
  const r = await correrCursor({ config: { contractTail: true } });
  const pos = {
    sistema: r.mensaje.indexOf('# CÓMO SE COMPONE EN ESTE PROYECTO'),
    pedido: r.mensaje.indexOf('# EL PEDIDO'),
    contrato: r.mensaje.indexOf('# ANTES DE RESPONDER'),
  };
  ok(pos.sistema < pos.pedido, 'el sistema va antes que el pedido');
  ok(pos.pedido < pos.contrato, 'el pedido va antes que el contrato');
  eq(r.mensaje.indexOf('Animá el concepto "sesgo"') > pos.pedido, true,
    'la instrucción del editor cae adentro del bloque del pedido');
});

test('cursor: sin system prompt no se inventa el bloque, y el contrato igual cierra', async function () {
  if (saltarEnWindows) return;
  // El recordatorio no depende del system prompt: es el piso que el render exige.
  const r = await correrCursor({ sinSystem: true, config: { contractTail: true } });
  eq(r.mensaje.indexOf('# CÓMO SE COMPONE EN ESTE PROYECTO'), -1, 'no se inventa un bloque de sistema vacío');
  has(r.mensaje, '# ANTES DE RESPONDER', 'y el contrato está igual');
});

// ── El costo: que repetir salga barato ──────────────────────────────────

test('el recordatorio es el andamiaje y nada más (no una copia de system.md)', function () {
  const rec = contractReminder();
  // Repetir es pagar tokens de entrada en CADA llamada. Se repite lo que si
  // falta impide renderizar; lo de estilo no, porque saltearlo da composiciones
  // distintas, no composiciones rotas.
  ok(rec.length < 1200, 'el recordatorio es corto: ' + rec.length + ' caracteres');
  ok(rec.length < SYSTEM.length / 10,
    'y es menos de la décima parte de system.md (' + rec.length + ' vs ' + SYSTEM.length + ')');
  has(rec, 'data-composition-id', 'repite el id de la composición');
  has(rec, 'data-duration', 'repite la duración');
  has(rec, 'data-fps', 'repite el resto del esqueleto');
  has(rec, '__timelines', 'repite el registro de la timeline');
  // Lo que NO tiene que repetir: el diseño.
  eq(rec.indexOf('glassmorphism'), -1, 'no repite reglas de estilo');
  eq(rec.indexOf('DM Sans'), -1, 'no repite la tipografía');
  eq(rec.indexOf('AUDITORÍA'), -1, 'no repite el protocolo de auditoría');
});

test('cursor: el interruptor cambia el recordatorio y NADA más', async function () {
  if (saltarEnWindows) return;
  // Sin este interruptor no hay forma de comparar "con" contra "sin" en la
  // misma máquina, el mismo día y el mismo modelo — y sin esa comparación la
  // pregunta "¿sirve repetir el contrato?" se contesta con una corazonada.
  const con = await correrCursor({ config: { contractTail: true } });
  const sin = await correrCursor({ config: { contractTail: false } });
  has(con.mensaje, '# ANTES DE RESPONDER', 'con el interruptor puesto, está');
  eq(sin.mensaje.indexOf('# ANTES DE RESPONDER'), -1, 'apagado, no está');
  eq(con.mensaje.length - sin.mensaje.length, contractReminder().length,
    'y la única diferencia entre los dos es exactamente el recordatorio');
  eq(sin.mensaje, con.mensaje.slice(0, sin.mensaje.length),
    'apagado, el mensaje es un prefijo exacto del prendido');
});

// ── Que Claude no se degrade ni pague de más ────────────────────────────

test('claude NO lleva recordatorio: su system prompt ya viaja donde se obedece', async function () {
  if (saltarEnWindows) return;
  // Claude tiene canal propio de system prompt en las dos plataformas (por
  // argumento en mac, por archivo en Windows). Repetirle el contrato sería
  // pagar tokens de entrada en cada llamada para arreglar un problema que no
  // tiene — y encima ensuciar los 21 de 21 que ya venía cumpliendo.
  for (const [nombre, viaStdin] of [['mac', false], ['Windows', true]]) {
    const r = await correrClaude(viaStdin);
    eq(r.mensaje.indexOf('# ANTES DE RESPONDER'), -1,
      'en ' + nombre + ' el mensaje del editor no lleva el recordatorio');
    eq(r.mensaje.indexOf('# CÓMO SE COMPONE EN ESTE PROYECTO'), -1,
      'en ' + nombre + ' tampoco lleva el encabezado que es solo de Cursor');
    eq(r.mensaje, USUARIO, 'en ' + nombre + ' el mensaje es exactamente lo que armó el motor');
  }
});

test('claude sigue mandando el system prompt por su propio canal', async function () {
  if (saltarEnWindows) return;
  // El arreglo de Windows no se puede haber caído por tocar código compartido.
  const mac = await correrClaude(false);
  const win = await correrClaude(true);
  eq(mac.systemPromptVia, 'argumento', 'en mac va como argumento');
  eq(win.systemPromptVia, 'archivo', 'en Windows va por archivo');
  eq(win.systemPrompt, mac.systemPrompt, 'y es el mismo texto en las dos');
  eq(mac.systemPrompt, SYSTEM.trim(), 'que es system.md entero');
});
