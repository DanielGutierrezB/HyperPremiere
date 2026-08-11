'use strict';

// Los caminos raros del proveedor, probados sin red ni tokens con un CLI de
// mentira (fixtures/fake-cli). Son justo los que nadie ve hasta que fallan en
// la máquina de otro:
//   - el CLI es más viejo que los flags del estado en vivo,
//   - el stream se corta antes del evento final,
//   - el prompt viaja por stdin (Windows) mientras el estado sale por stdout.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq, has } = require('./harness');
const claude = require('../bridge/providers/claude-cli');

const FAKE = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-claude.js');

function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hp-fake-')), 'recibido.json');
}

/** Corre el proveedor contra el CLI de mentira en el modo pedido. */
async function correr(modo, opts) {
  const log = tmpLog();
  const acts = [];
  const prev = { modo: process.env.FAKE_MODE, log: process.env.FAKE_LOG };
  process.env.FAKE_MODE = modo;
  process.env.FAKE_LOG = log;
  try {
    const r = await claude.generate({
      systemPrompt: 'sistema',
      userPrompt: (opts && opts.userPrompt) || 'diseñá algo',
      images: [],
      model: 'modelo-de-prueba',
      config: {
        binPath: FAKE, timeoutMs: 30000,
        promptViaStdin: !!(opts && opts.viaStdin),
      },
      onActivity: (opts && opts.sinEstado) ? undefined : function (a) { acts.push(a); },
    });
    return { r: r, acts: acts, recibido: JSON.parse(fs.readFileSync(log, 'utf8')) };
  } finally {
    if (prev.modo === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = prev.modo;
    if (prev.log === undefined) delete process.env.FAKE_LOG; else process.env.FAKE_LOG = prev.log;
  }
}

const saltarEnWindows = process.platform === 'win32';

test('un CLI viejo que no conoce los flags nuevos igual genera', async function () {
  if (saltarEnWindows) return console.log('      (se saltea en Windows: el CLI de mentira es un script con shebang)');
  const { r, acts } = await correr('viejo');
  eq(r.text.trim(), '<html>viejo</html>', 'la generación sale igual, sin estado en vivo');
  ok(r.usage && r.usage.inputTokens === 5, 'y los tokens se siguen contando');
  eq(acts.length, 0, 'no se inventa ningún estado que el CLI no dio');
});

test('si el stream se corta antes del final, no se pierde el diseño ya pagado', async function () {
  if (saltarEnWindows) return;
  const { r, acts } = await correr('sin-final');
  ok(r.text.length > 0, 'la respuesta se rescata de los mensajes del asistente');
  ok(acts.length > 0, 'el estado en vivo funcionó igual');
  eq(r.usage, null, 'lo único que se pierde es el conteo de tokens');
});

test('en el camino de Windows el prompt entra por stdin y el estado sale por stdout', async function () {
  if (saltarEnWindows) return;
  // El prompt largo es el motivo del stdin: por la línea de comandos, cmd.exe
  // lo cortaría a los 8191 caracteres.
  const largo = 'diseñá algo. ' + 'contexto '.repeat(2000);
  const { r, acts, recibido } = await correr('stdin', { viaStdin: true, userPrompt: largo });
  ok(recibido.stdinLen > 8191, 'el prompt entero viajó por stdin (' + recibido.stdinLen + ' caracteres)');
  eq(recibido.args.indexOf('--append-system-prompt'), -1, 'el system prompt no va por la línea de comandos');
  has(r.text, 'ARGS:0', 'ningún argumento gigante quedó en la línea de comandos');
  ok(acts.length > 0, 'y el estado en vivo llegó igual: las dos cosas conviven');
  ok(r.usage && r.usage.inputTokens === 11, 'con los tokens intactos');
});

test('sin nadie mirando, el CLI corre con el formato de siempre', async function () {
  if (saltarEnWindows) return;
  const { r, recibido } = await correr('viejo', { sinEstado: true });
  eq(recibido.args.indexOf('stream-json'), -1, 'no se pide el stream si nadie lo va a leer');
  ok(r.text.length > 0, 'y genera');
});

test('el estado en vivo se puede apagar por variable de entorno', async function () {
  if (saltarEnWindows) return;
  const prev = process.env.HYPERPREMIERE_STREAM;
  process.env.HYPERPREMIERE_STREAM = '0';
  try {
    const { recibido, acts } = await correr('viejo');
    eq(recibido.args.indexOf('stream-json'), -1, 'apagado: se pide el formato de siempre');
    eq(acts.length, 0, 'y no llega ningún estado');
  } finally {
    if (prev === undefined) delete process.env.HYPERPREMIERE_STREAM;
    else process.env.HYPERPREMIERE_STREAM = prev;
  }
});
