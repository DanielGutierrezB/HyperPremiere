'use strict';

// Que la imagen de referencia LLEGUE y que se sepa si el modelo la miró.
//
// De dónde sale: un editor pasó su cuadro de referencia y la animación salió
// como si no existiera. En el log de su máquina, cada generación traía la misma
// denegación de permiso —el CLI queriendo usar Write— y el aviso que leía el
// editor decía "el modelo diseñó sin eso", que era falso y tapaba lo que sí
// importaba. Del lado del modelo no había NINGUNA forma de saber si había
// abierto la imagen: el prompt se la mandaba abrir y, si no lo hacía, la
// composición salía igual de presentable.
//
// Tres cosas se fijan acá:
//   · el CLI arranca con las herramientas justas (leer, y nada más),
//   · si una imagen quedó sin abrir, el editor se entera,
//   · el aviso de permisos no confunde "no me dejaron leer" (cambia el diseño)
//     con "no me dejaron escribir" (no lo cambia).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq, has } = require('./harness');
const { imagesAsFilesNote } = require('../bridge/providers');
const agentStream = require('../bridge/providers/agent-stream');
const claude = require('../bridge/providers/claude-cli');

const FAKE_CLAUDE = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-claude.js');

// Los CLI de mentira son scripts con shebang: en Windows no arrancan solos.
const saltarEnWindows = process.platform === 'win32';

// Un PNG de 1x1 de verdad: el proveedor lo escribe a disco, así que tiene que
// ser un data URL válido.
const PNG_1x1 = 'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hp-imagen-')), 'recibido.json');
}

/**
 * Corre el proveedor de Claude contra el CLI de mentira.
 * @returns {{ res, args, intentos }} lo que devolvió y lo que recibió el CLI.
 */
async function correr(modo, imagenes, extra) {
  const log = tmpLog();
  const prev = { modo: process.env.FAKE_MODE, log: process.env.FAKE_LOG, n: process.env.FAKE_IMAGENES };
  process.env.FAKE_MODE = modo;
  process.env.FAKE_LOG = log;
  if (extra && extra.cuantasAbre) process.env.FAKE_IMAGENES = String(extra.cuantasAbre);
  try {
    const res = await claude.generate({
      systemPrompt: 'Sé breve.',
      userPrompt: '## Instrucción del editor\nAnimá "sesgo".',
      images: imagenes,
      model: 'modelo-de-prueba',
      config: { binPath: FAKE_CLAUDE, timeoutMs: 30000 },
      // Sin onActivity no hay stream, y sin stream no hay con qué comprobar
      // nada: es la misma condición que en producción.
      onActivity: (extra && extra.sinStream) ? undefined : function () {},
    });
    const datos = JSON.parse(fs.readFileSync(log, 'utf8'));
    const intentos = fs.readFileSync(log + '.jsonl', 'utf8')
      .split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); });
    return { res: res, args: datos.args, intentos: intentos };
  } finally {
    process.env.FAKE_MODE = prev.modo === undefined ? '' : prev.modo;
    process.env.FAKE_LOG = prev.log === undefined ? '' : prev.log;
    if (prev.n === undefined) delete process.env.FAKE_IMAGENES; else process.env.FAKE_IMAGENES = prev.n;
  }
}

/** El valor que sigue a un flag en la línea de comandos que recibió el CLI. */
function valorDe(args, flag) {
  const i = args.indexOf(flag);
  return (i !== -1 && i + 1 < args.length) ? args[i + 1] : null;
}

// ── Las herramientas con las que arranca ──────────────────────────────

test('el CLI arranca con la herramienta de leer y con ninguna más', async function () {
  if (saltarEnWindows) return;
  const { args } = await correr('mira-imagenes', [PNG_1x1]);
  eq(valorDe(args, '--tools'), 'Read', 'el juego de herramientas tiene que ser solo Read');
  eq(valorDe(args, '--allowedTools'), 'Read', 'y leer no puede quedar pendiente de un permiso');
});

test('lo que sigue al toolset es otro flag, nunca el prompt', async function () {
  if (saltarEnWindows) return;
  // --tools y --allowedTools son variádicos: se comen todo lo que les siga
  // hasta el próximo flag. Es la trampa que ya se pagó con --add-dir.
  const { args } = await correr('mira-imagenes', [PNG_1x1]);
  ['--tools', '--allowedTools'].forEach(function (f) {
    const i = args.indexOf(f);
    ok(i !== -1, 'falta ' + f);
    const siguiente = args[i + 2];
    ok(siguiente === undefined || siguiente.charAt(0) === '-',
      f + ' se está comiendo el argumento que le sigue: ' + siguiente);
  });
});

test('un CLI que no conoce el flag genera igual, sin él', async function () {
  if (saltarEnWindows) return;
  const { res, intentos } = await correr('sin-tools', [PNG_1x1]);
  ok(res.text.length > 0, 'la generación no puede perderse por un flag');
  eq(intentos.length, 2, 'un flag rechazado se paga con UN reintento, no con tres');
  const ultimo = intentos[intentos.length - 1];
  eq(ultimo.args.indexOf('--tools'), -1, 'el último intento tiene que ir sin el flag rechazado');
  // Lo que NO se puede perder por el camino: soltar el acotado no puede
  // llevarse puesto el estado en vivo ni el system prompt de verdad.
  ok(ultimo.args.indexOf('stream-json') !== -1, 'el estado en vivo no tenía por qué caerse');
  eq(ultimo.systemPromptVia, 'argumento', 'el system prompt siguió por su canal');
});

// ── ¿Miró la imagen? ──────────────────────────────────────────────────

test('si el modelo no abre la imagen, el editor se entera', async function () {
  if (saltarEnWindows) return;
  const { res } = await correr('no-mira', [PNG_1x1]);
  has(res.warning, 'NO abrió', 'el modo de falla mudo tiene que dejar de ser mudo');
  has(res.warning, 'Qué hacer', 'un aviso sin próximo paso no sirve de nada');
});

test('abrir una de dos también se avisa, y se dice cuál faltó', async function () {
  if (saltarEnWindows) return;
  const { res } = await correr('mira-una-sola', [PNG_1x1, PNG_1x1]);
  has(res.warning, 'solo 1 de las 2', 'hay que decir cuántas miró');
  has(res.warning, 'imagen-2.png', 'y cuál se salteó');
});

test('el modelo que las abre todas no genera ningún aviso', async function () {
  if (saltarEnWindows) return;
  const { res } = await correr('mira-imagenes', [PNG_1x1, PNG_1x1], { cuantasAbre: 2 });
  eq(res.warning, '', 'un aviso que aparece cuando todo salió bien enseña a ignorar los avisos');
});

test('sin imágenes no hay nada que comprobar ni que avisar', async function () {
  if (saltarEnWindows) return;
  const { res } = await correr('no-mira', []);
  eq(res.warning, '', 'no se puede avisar de imágenes que nadie mandó');
});

test('sin estado en vivo no se inventa el aviso', async function () {
  if (saltarEnWindows) return;
  // Sin stream no hay forma de saber qué abrió: callarse es lo honesto.
  const { res } = await correr('no-mira', [PNG_1x1], { sinStream: true });
  eq(res.warning, '', 'sin datos no se afirma nada');
});

// ── El aviso de permisos ──────────────────────────────────────────────

test('que no lo dejen ESCRIBIR no significa que diseñó a ciegas', async function () {
  if (saltarEnWindows) return;
  const { res } = await correr('deniega-write', [PNG_1x1]);
  has(res.warning, 'Write', 'igual hay que decir qué pidió');
  has(res.warning, 'No afecta al diseño', 'era lo que faltaba aclarar');
  eq(res.warning.indexOf('diseñó sin ver'), -1,
    'esto es lo que leía el editor de la máquina donde fallaba, y era falso');
});

test('que no lo dejen LEER sí lo significa, y se dice fuerte', async function () {
  if (saltarEnWindows) return;
  const { res } = await correr('deniega-read', [PNG_1x1]);
  has(res.warning, 'LEER', 'la palabra tiene que estar');
  has(res.warning, 'diseñó sin ver eso', 'y la consecuencia también');
});

// ── Las piezas, por separado ──────────────────────────────────────────

test('el prompt dice cuántas imágenes son y que se comprueba', function () {
  const una = imagesAsFilesNote(['/tmp/x/imagen-1.png']);
  has(una, 'UN archivo', 'con una sola no corresponde hablar en plural');
  has(una, 'se comprueba', 'la advertencia es cierta: conviene decirla');
  const dos = imagesAsFilesNote(['/tmp/x/imagen-1.png', '/tmp/x/imagen-2.png']);
  has(dos, 'son 2 archivos');
  has(dos, 'Abrí las 2', 'abrir una sola de dos es la mitad del trabajo');
  eq(imagesAsFilesNote([]), '', 'sin imágenes, ni una palabra');
});

test('se reconoce lo que leyó cada CLI, en su propio dialecto', function () {
  const claudeStream = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    // Con parciales, el bloque de herramienta llega SIN argumentos: si se
    // leyera de ahí, siempre parecería que no abrió nada.
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/a/imagen-1.png' } }] } }),
    'ruido que no es JSON',
  ].join('\n');
  const cursorStream = JSON.stringify({
    type: 'tool_call', subtype: 'started',
    tool_call: { readToolCall: { args: { path: './imagen-2.png' } } },
  });
  eq(agentStream.filesRead(claudeStream).join('|'), '/tmp/a/imagen-1.png');
  eq(agentStream.filesRead(cursorStream).join('|'), './imagen-2.png');
  eq(agentStream.filesRead('').length, 0);
});

test('la comparación es por nombre de archivo, no por ruta', function () {
  // El modelo escribe la ruta como quiere: relativa, con ./, con la barra de la
  // otra plataforma. Lo que se pregunta es si miró ESA imagen.
  const faltan = agentStream.filesMissing(
    ['/tmp/hp/imagen-1.png', '/tmp/hp/imagen-2.png'],
    ['./imagen-1.png', 'C:\\Temp\\otra.png']
  );
  eq(faltan.join('|'), '/tmp/hp/imagen-2.png');
  eq(agentStream.filesMissing(['/x/IMAGEN-1.PNG'], ['/y/imagen-1.png']).length, 0,
    'mayúsculas y minúsculas no son una imagen distinta');
  eq(agentStream.filesMissing([], ['/x/a.png']).length, 0);
});
