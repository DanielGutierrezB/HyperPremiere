'use strict';

// MEDIR LOS MODELOS DE CLAUDE CON EL CLI, de punta a punta y sin red.
//
// La mitad pura del selector (claude-modelos.test.js) decide qué mostrar con lo
// medido. Acá se prueba lo que tiene consecuencias afuera del panel, contra un
// CLI de mentira que contesta `--version`, `update` y cada llamada mínima con el
// `modelUsage` de una tabla (fixtures/fake-cli/fake-claude-modelos.js):
//
//   - que el menú se lea del archivo del CLI de verdad, no de una lista;
//   - que se mida con la MISMA credencial con la que se genera;
//   - que no se lancen más de cuatro CLIs a la vez ni se ensucie el historial
//     de Claude Code del editor con una conversación por modelo;
//   - que lo medido se guarde con la versión del CLI, y solo si sirve;
//   - que Verificar actualice el CLI cuando hay uno nuevo, y mida CON EL NUEVO;
//   - y que "default" no viaje como si fuera un modelo o un nivel.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq, deepEq, has } = require('./harness');

const medir = require('../bridge/claude-medir');
const CM = require('../bridge/claude-modelos');
const engine = require('../bridge/engine');
const claude = require('../bridge/providers/claude-cli');

const FAKE = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-claude-modelos.js');
const FAKE_GENERAR = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-claude.js');
// Los CLI de mentira son scripts con shebang: en Windows no arrancan solos.
const saltarEnWindows = process.platform === 'win32';

/** Lo que contestó el CLI de verdad (2.1.288), recortado a lo que el fake tiene en su menú. */
const TABLA = {
  fable: { id: 'claude-fable-5-1', ventana: 1000000 },
  opus: { id: 'claude-opus-5-5', ventana: 1000000, salida: 128000 },
  sonnet: { id: 'claude-sonnet-5-5', ventana: 1000000, salida: 128000 },
  haiku: { id: 'claude-haiku-4-5-20251001', ventana: 200000, salida: 32000 },
  'claude-opus-4-8': { id: 'claude-opus-4-8', ventana: 1000000 },
  'claude-opus-4-1': { id: 'claude-opus-5-5', ventana: 1000000 },
  'claude-opus-4-6': { id: 'claude-opus-4-6', ventana: 200000 },
  'claude-opus-4-6[1m]': { id: 'claude-opus-4-6[1m]', ventana: 1000000 },
  'haiku[1m]': { error: 'API Error: 400 The long context beta is not yet available for this subscription.' },
};

const VARIABLES = ['HOME', 'USERPROFILE', 'HYPERPREMIERE_CLAUDE_BIN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'FAKE_ESTADO', 'FAKE_ULTIMA', 'FAKE_UPDATE', 'FAKE_TABLA', 'FAKE_LOG', 'FAKE_VIEJO', 'FAKE_DEMORA',
  'FAKE_MODE'];

/**
 * Corre `fn` con el CLI de mentira y una casa vacía, y deja todo como estaba.
 *
 * La casa es propia de cada test —no la del arnés, que es una para toda la
 * suite— porque lo que se prueba es justamente qué queda escrito en ella.
 *
 * `o.ultima` es lo que "contesta npm": se reemplaza la consulta en vez de ir a
 * la red, que en un test sería una dependencia de la conexión de quien lo corre.
 */
async function conCli(o, fn) {
  o = o || {};
  const antes = {};
  VARIABLES.forEach((k) => { antes[k] = process.env[k]; });
  const ultimaReal = medir.ultimaDelCanal;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-medir-'));
  const casa = path.join(dir, 'casa');
  fs.mkdirSync(casa);
  const estado = path.join(dir, 'version.txt');
  const log = path.join(dir, 'llamadas.jsonl');
  fs.writeFileSync(estado, o.version || '2.1.288');
  try {
    process.env.HOME = casa;
    process.env.USERPROFILE = casa;
    process.env.HYPERPREMIERE_CLAUDE_BIN = FAKE;
    process.env.FAKE_ESTADO = estado;
    process.env.FAKE_LOG = log;
    process.env.FAKE_TABLA = JSON.stringify(o.tabla || TABLA);
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    ['FAKE_ULTIMA', 'FAKE_UPDATE', 'FAKE_VIEJO', 'FAKE_DEMORA'].forEach((k) => { delete process.env[k]; });
    if (o.ultima) process.env.FAKE_ULTIMA = o.ultima;
    if (o.updateFalla) process.env.FAKE_UPDATE = 'falla';
    if (o.viejo) process.env.FAKE_VIEJO = '1';
    if (o.demora) process.env.FAKE_DEMORA = String(o.demora);
    medir.ultimaDelCanal = async function () {
      return o.ultima ? { version: o.ultima, canal: 'latest', error: '' }
        : { version: '', canal: 'latest', error: 'sin red en el test' };
    };
    medir._olvidarMenu();
    return await fn({
      casa: casa,
      llamadas: function () {
        try {
          return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        } catch (e) { return []; }
      },
      guardada: function () { return medir.leerMedicion(); },
    });
  } finally {
    medir.ultimaDelCanal = ultimaReal;
    VARIABLES.forEach((k) => { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; });
  }
}

// ── El menú sale del archivo del CLI ──────────────────────────────────

test('las versiones anteriores se leen del archivo del CLI, no de una lista', function () {
  const menu = medir.escanearMenu(FAKE);
  deepEq(menu.map((o) => o.id), ['claude-opus-4-8', 'claude-opus-4-1', 'claude-opus-4-6']);
  eq(menu.find((o) => o.id === 'claude-opus-4-1').legacy, true);
});

test('un archivo sin menú no rompe nada: quedan los alias', function () {
  eq(medir.escanearMenu(FAKE_GENERAR).length, 0);
  eq(medir.escanearMenu('/no/existe/claude').length, 0);
});

test('el menú se escanea una vez por binario y no cada vez que se abre ⚙', function () {
  medir._olvidarMenu();
  const a = medir.menu(FAKE);
  const b = medir.menu(FAKE);
  ok(a === b, 'el mismo binario devuelve lo mismo, sin volver a leer 200 MB');
});

// ── La medición ───────────────────────────────────────────────────────

test('mide los alias y las versiones del menú, y guarda con qué CLI', async function () {
  if (saltarEnWindows) return;
  await conCli({}, async function (c) {
    const r = await medir.medir({ oauthToken: '' }, {});
    ok(r.ok, 'tenía que poder medir: ' + (r.error || ''));
    const g = c.guardada();
    eq(g.cli, '2.1.288', 'sin la versión no se sabe cuándo deja de valer');
    eq(g.resultados.opus.resuelto, 'claude-opus-5-5');
    eq(g.resultados.opus.ventana, 1000000);
    eq(g.resultados['claude-opus-4-1'].noDisponible, 'Retirada: la contesta Opus 5.5');
  });
});

test('el [1m] se pregunta en una segunda tanda, solo a los de menos de 1M', async function () {
  if (saltarEnWindows) return;
  await conCli({}, async function (c) {
    await medir.medir({}, {});
    const pedidos = c.llamadas().filter((l) => l.comando === 'pedido').map((l) => l.pedido);
    deepEq(pedidos.filter((p) => /\[1m\]$/.test(p)).sort(), ['claude-opus-4-6[1m]', 'haiku[1m]']);
    eq(pedidos.length, 9, 'siete de la primera tanda y dos de la segunda');
    eq(c.guardada().resultados['claude-opus-4-6[1m]'].ventana, 1000000);
  });
});

test('mide con la MISMA credencial con la que se genera', async function () {
  if (saltarEnWindows) return;
  // Medir con otra sería medir otra cuenta: otro plan, otros modelos, otra ventana.
  await conCli({}, async function (c) {
    await medir.medir({ oauthToken: 'sk-ant-oat01-del-panel' }, {});
    const tokens = c.llamadas().filter((l) => l.comando === 'pedido').map((l) => l.token);
    ok(tokens.length > 0 && tokens.every((t) => t === 'sk-ant-oat01-del-panel'),
      'cada llamada tiene que llevar el token del panel, como la generación: ' + tokens.join(','));
  });
});

test('nunca hay más de cuatro CLIs a la vez', async function () {
  if (saltarEnWindows) return;
  // Cada llamada levanta un CLI de más de 200 MB, en la máquina donde está Premiere.
  await conCli({ demora: 150 }, async function (c) {
    await medir.medir({}, {});
    const tramos = c.llamadas().filter((l) => l.comando === 'pedido');
    let pico = 0;
    tramos.forEach((t) => {
      const juntos = tramos.filter((o) => o.inicio < t.fin && o.fin > t.inicio).length;
      pico = Math.max(pico, juntos);
    });
    ok(pico <= 4, 'corrieron ' + pico + ' a la vez');
    ok(pico >= 2, 'y tampoco de a uno: serían once esperas en fila (' + pico + ')');
  });
});

test('no le deja una conversación por modelo en el historial de Claude Code', async function () {
  if (saltarEnWindows) return;
  await conCli({}, async function (c) {
    await medir.medir({}, {});
    const una = c.llamadas().find((l) => l.comando === 'pedido');
    ok(una.args.indexOf('--no-session-persistence') !== -1, 'args: ' + una.args.join(' '));
    eq(una.args[una.args.indexOf('--effort') + 1], 'low', 'medir no necesita pensar');
    eq(fs.realpathSync(una.cwd), fs.realpathSync(os.tmpdir()),
      'fuera de cualquier proyecto: si no, el CLI levanta el CLAUDE.md de la carpeta de Premiere');
  });
});

test('un CLI que no conoce esos flags se mide igual, sin ellos', async function () {
  if (saltarEnWindows) return;
  await conCli({ viejo: true }, async function (c) {
    const r = await medir.medir({}, {});
    ok(r.ok, 'un flag de más no puede dejar al selector sin medir: ' + (r.error || ''));
    ok(c.llamadas().some((l) => l.comando === 'rechazo'), 'tenía que haberlo intentado primero');
  });
});

test('si no contesta NINGUNO no se guarda nada: es la sesión, no los modelos', async function () {
  if (saltarEnWindows) return;
  const todoMal = {};
  Object.keys(TABLA).forEach((k) => { todoMal[k] = { error: 'Invalid API key · Please run /login' }; });
  await conCli({ tabla: todoMal }, async function (c) {
    const r = await medir.medir({}, {});
    eq(r.ok, false);
    has(r.error, 'Invalid API key');
    eq(c.guardada(), null, 'guardarlo deshabilitaría todo el selector');
  });
});

test('dos mediciones pedidas juntas son una sola', async function () {
  if (saltarEnWindows) return;
  // La automática de ⚙ y un Verificar apretado enseguida no pueden lanzar
  // veintidós CLIs para medir lo mismo.
  await conCli({ demora: 50 }, async function (c) {
    await Promise.all([medir.medir({}, {}), medir.medir({}, {})]);
    eq(c.llamadas().filter((l) => l.comando === 'pedido').length, 9);
  });
});

// ── Verificar ─────────────────────────────────────────────────────────

test('con un CLI atrasado, Verificar lo actualiza y mide CON EL NUEVO', async function () {
  if (saltarEnWindows) return;
  // Es lo que hace aparecer los modelos nuevos: llegan con el CLI nuevo.
  await conCli({ version: '2.1.288', ultima: '2.1.289' }, async function (c) {
    const pasos = [];
    const r = await engine.verificarClaude({}, function (p) { if (p && p.msg) pasos.push(p.msg); });
    ok(r.ok, 'tenía que contestar: ' + (r.error || ''));
    eq(r.actualizado, true);
    eq(r.cli, '2.1.289');
    eq(c.guardada().cli, '2.1.289', 'lo medido es del CLI nuevo, no del de antes');
    ok(c.llamadas().some((l) => l.comando === 'update'), 'tenía que haber corrido claude update');
    ok(pasos.some((m) => /Actualizando Claude Code 2\.1\.288 → 2\.1\.289/.test(m)),
      'y decirlo mientras pasa: ' + pasos.join(' | '));
  });
});

test('al día, Verificar no actualiza nada', async function () {
  if (saltarEnWindows) return;
  await conCli({ version: '2.1.289', ultima: '2.1.289' }, async function (c) {
    const r = await engine.verificarClaude({}, function () {});
    eq(r.actualizado, false);
    ok(!c.llamadas().some((l) => l.comando === 'update'));
  });
});

test('si el update falla, se dice y se mide con el que hay', async function () {
  if (saltarEnWindows) return;
  await conCli({ version: '2.1.288', ultima: '2.1.289', updateFalla: true }, async function (c) {
    const r = await engine.verificarClaude({}, function () {});
    ok(r.ok, 'lo elegido contesta igual');
    has(r.notas.join(' '), 'claude update falló');
    eq(c.guardada().cli, '2.1.288');
  });
});

test('sin red, Verificar no se cae: anota que no pudo comparar y mide', async function () {
  if (saltarEnWindows) return;
  await conCli({}, async function (c) {
    const r = await engine.verificarClaude({}, function () {});
    ok(r.ok);
    has(r.notas.join(' '), 'no pude consultar la última versión');
    ok(c.guardada(), 'la medición no depende de npm');
  });
});

test('la última prueba es con lo ELEGIDO: modelo, ventana y pensamiento', async function () {
  if (saltarEnWindows) return;
  await conCli({}, async function (c) {
    engine.setConfig({ provider: 'claude-cli', model: 'claude-opus-4-6[1m]', effort: 'max' });
    const r = await engine.verificarClaude({}, function () {});
    ok(r.ok, r.error || '');
    const ultima = c.llamadas().filter((l) => l.comando === 'pedido').pop();
    eq(ultima.pedido, 'claude-opus-4-6[1m]');
    eq(ultima.args[ultima.args.indexOf('--effort') + 1], 'max', 'es la combinación con la que se va a generar');
    eq(r.resumen, 'Opus 4.6 · 1M · pensamiento Máximo');
  });
});

test('si lo elegido no contesta, Verificar lo dice con el motivo del CLI', async function () {
  if (saltarEnWindows) return;
  await conCli({}, async function () {
    engine.setConfig({ provider: 'claude-cli', model: 'haiku[1m]', effort: 'high' });
    const r = await engine.verificarClaude({}, function () {});
    eq(r.ok, false);
    has(r.error, 'not yet available for this subscription');
  });
});

// ── El catálogo que pide ⚙ ────────────────────────────────────────────

test('el catálogo no llama a ningún modelo', async function () {
  if (saltarEnWindows) return;
  await conCli({}, async function (c) {
    const cat = await engine.catalogoClaude({});
    ok(cat.ok && cat.instalado);
    eq(cat.cli, '2.1.288');
    eq(c.llamadas().length, 0, 'abrir ⚙ no puede gastar uso del plan');
    eq(cat.vencida, true, 'todavía no se midió nada');
  });
});

test('medido, el catálogo trae las versiones; con otro CLI, deja de traerlas', async function () {
  if (saltarEnWindows) return;
  await conCli({ version: '2.1.288' }, async function () {
    const medido = await engine.medirModelosClaude({}, function () {});
    eq(medido.vencida, false);
    eq(medido.grupos.find((g) => g.familia === 'opus').opciones[0].etiqueta, 'Opus 5.5 · último');
    fs.writeFileSync(process.env.FAKE_ESTADO, '2.1.300');
    const despues = await engine.catalogoClaude({});
    eq(despues.vencida, true);
    eq(despues.grupos.find((g) => g.familia === 'opus').opciones[0].etiqueta, 'Opus · último',
      'con el CLI nuevo, `opus` puede ser otro modelo: no se afirma lo de antes');
    has(despues.estado, 'Claude Code 2.1.288');
  });
});

test('si la medición falla, el catálogo lo dice en vez de quedarse callado', async function () {
  if (saltarEnWindows) return;
  const todoMal = {};
  Object.keys(TABLA).forEach((k) => { todoMal[k] = { error: 'Invalid API key' }; });
  await conCli({ tabla: todoMal }, async function () {
    const cat = await engine.medirModelosClaude({}, function () {});
    eq(cat.medida, false);
    has(cat.estado, 'No pude comprobar las versiones');
  });
});

// ── La config ─────────────────────────────────────────────────────────

test('sin nada guardado, el CLI arranca con el ALIAS de Sonnet y no con una versión vieja', async function () {
  await conCli({}, async function () {
    eq(engine.getConfig().model, 'sonnet', '"claude-sonnet-5" era el último cuando se escribió; hoy es una versión anterior');
    engine.setConfig({ provider: 'claude-api' });
    eq(engine.getConfig().model, 'claude-sonnet-5', 'la API no entiende alias: ahí sigue el ID');
  });
});

test('"Predeterminado" se guarda como tal y no vuelve como "Alto"', async function () {
  await conCli({}, async function () {
    engine.setConfig({ provider: 'claude-cli', effort: 'default' });
    eq(engine.getConfig().effort, 'default');
    engine.setConfig({ effort: 'cualquiera' });
    eq(engine.getConfig().effort, 'high', 'lo que no se conoce sigue volviendo al recomendado');
  });
});

test('"default" no viaja al CLI como modelo ni como nivel', async function () {
  if (saltarEnWindows) return;
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hp-default-')), 'recibido.json');
  const antes = { log: process.env.FAKE_LOG, modo: process.env.FAKE_MODE };
  process.env.FAKE_LOG = log;
  process.env.FAKE_MODE = 'stream';
  try {
    await claude.complete({
      systemPrompt: 'sistema', userPrompt: 'hola', images: [], model: 'default',
      config: { binPath: FAKE_GENERAR, timeoutMs: 30000, effort: 'default' },
    });
    const args = JSON.parse(fs.readFileSync(log, 'utf8')).args;
    eq(args.indexOf('--model'), -1, '"el de tu plan" es no mandar --model: ' + args.join(' '));
    eq(args.indexOf('--effort'), -1, '"que decida el modelo" es no mandar --effort');
  } finally {
    if (antes.log === undefined) delete process.env.FAKE_LOG; else process.env.FAKE_LOG = antes.log;
    if (antes.modo === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = antes.modo;
  }
});

test('un modelo con [1m] viaja entero, como un solo argumento', async function () {
  if (saltarEnWindows) return;
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hp-1m-')), 'recibido.json');
  const antes = { log: process.env.FAKE_LOG, modo: process.env.FAKE_MODE };
  process.env.FAKE_LOG = log;
  process.env.FAKE_MODE = 'stream';
  try {
    await claude.complete({
      systemPrompt: 'sistema', userPrompt: 'hola', images: [], model: 'claude-opus-4-6[1m]',
      config: { binPath: FAKE_GENERAR, timeoutMs: 30000, effort: 'high' },
    });
    const args = JSON.parse(fs.readFileSync(log, 'utf8')).args;
    eq(args[args.indexOf('--model') + 1], 'claude-opus-4-6[1m]');
  } finally {
    if (antes.log === undefined) delete process.env.FAKE_LOG; else process.env.FAKE_LOG = antes.log;
    if (antes.modo === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = antes.modo;
  }
});

// Se usa CM para que el archivo diga, en un lugar, contra qué formato se guarda.
test('lo que se guarda tiene el formato que el catálogo sabe leer', async function () {
  if (saltarEnWindows) return;
  await conCli({}, async function (c) {
    await medir.medir({}, {});
    eq(c.guardada().formato, CM.FORMATO);
    eq(CM.vencida(c.guardada(), '2.1.288'), false);
  });
});
