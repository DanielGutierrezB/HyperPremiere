#!/usr/bin/env node
'use strict';

// CLI de mentira que se hace pasar por `claude` para probar sin red ni tokens
// los caminos que en la vida real aparecen una vez cada mil: un CLI viejo que
// no conoce los flags nuevos, un stream que se corta antes del final, y el
// prompt entrando por stdin (lo que se usa en Windows).
//
// Y los caminos que aparecen SIEMPRE en la máquina de otro: cerrar con código 1
// dejando stderr vacío y el motivo en stdout, como hace el CLI de verdad cuando
// corre con --output-format json. Esos modos empiezan con "falla-".
//
// Qué hace lo elige FAKE_MODE; en FAKE_LOG deja lo que recibió, para poder
// afirmar que el prompt viajó por donde tenía que viajar.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const modo = process.env.FAKE_MODE || 'stream';
const log = process.env.FAKE_LOG;
const fixtures = path.join(__dirname, '..');

/** Valor del flag `nombre`, o null si no vino. */
function flag(nombre) {
  const i = args.indexOf(nombre);
  return (i !== -1 && i + 1 < args.length) ? args[i + 1] : null;
}

/** Todos los valores de un flag repetible (ej. --add-dir). */
function flags(nombre) {
  const out = [];
  args.forEach((a, i) => { if (a === nombre && i + 1 < args.length) out.push(args[i + 1]); });
  return out;
}

// El system prompt puede llegar como texto en la línea de comandos o como
// archivo. Se resuelve ACÁ, mientras el archivo temporal todavía existe: el
// proveedor lo borra apenas termina, así que el test no lo puede leer después.
function systemPromptRecibido() {
  const inline = flag('--append-system-prompt');
  if (inline !== null) return { systemPrompt: inline, systemPromptVia: 'argumento' };
  const file = flag('--append-system-prompt-file');
  if (file !== null) {
    try { return { systemPrompt: fs.readFileSync(file, 'utf8'), systemPromptVia: 'archivo' }; } catch (e) {
      return { systemPrompt: null, systemPromptVia: 'archivo-ilegible' };
    }
  }
  return { systemPrompt: null, systemPromptVia: 'no vino' };
}

function anotar(extra) {
  if (!log) return;
  // `stdinCompleto` y `systemPrompt` son la prueba: con esto un test puede
  // comparar BYTE A BYTE lo que recibe el CLI por el camino de mac (argumentos)
  // y por el de Windows (stdin), que es donde se escondía la diferencia.
  const datos = Object.assign({
    args: args,
    modo: modo,
    cwd: process.cwd(),
    addDirs: flags('--add-dir'),
  }, systemPromptRecibido(), extra);
  try { fs.writeFileSync(log, JSON.stringify(datos), 'utf8'); } catch (e) {}
  // Una línea por invocación, al lado del log. Cuando el motor reintenta (un
  // flag que el CLI rechaza, el streaming que se apaga), el archivo de arriba
  // se pisa y solo queda el último intento; acá quedan TODOS, que es lo que hay
  // que mirar para afirmar que el reintento pasó por donde tenía que pasar.
  try { fs.appendFileSync(log + '.jsonl', JSON.stringify(datos) + '\n', 'utf8'); } catch (e) {}
}

function leerStdin() {
  return new Promise((resolve) => {
    let s = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', () => resolve(s));
  });
}

const streaming = args.indexOf('stream-json') !== -1;

async function main() {
  const stdin = await leerStdin();
  // El prompt de usuario por argumento va pegado a `-p` (el proveedor lo mete
  // en la posición 1); todo lo demás son flags o valores de flag.
  const posicional = (args[0] === '-p' && args[1] && args[1].charAt(0) !== '-') ? args[1] : null;
  anotar({
    stdinLen: stdin.length,
    stdin: stdin.slice(0, 200),
    stdinCompleto: stdin,
    promptPosicional: posicional,
  });

  if (modo === 'viejo' && streaming) {
    // Exactamente lo que contesta un CLI que no conoce el flag (verificado).
    process.stderr.write("error: unknown option '--include-partial-messages'\n");
    process.exit(1);
  }

  // Un CLI anterior a `--append-system-prompt-file` (el flag existe desde
  // claude 2.1.x). La máquina del editor puede tener una versión más vieja, y
  // ahí el motor tiene que volver al método de antes en vez de dejarlo sin
  // generar. La frase es la que escribe commander de verdad.
  if (modo === 'sin-sysfile' && args.indexOf('--append-system-prompt-file') !== -1) {
    process.stderr.write("error: unknown option '--append-system-prompt-file'\n");
    process.exitCode = 1;
    return;
  }

  // ── Cerrar mal: el motivo va a STDOUT y stderr queda vacío ──────────
  // Es lo que hace el CLI de verdad con --output-format json, y es el caso que
  // dejaba al editor con "salió con código 1. stderr: (vacío)".
  function cierraMal(objeto, code) {
    process.stdout.write(JSON.stringify(objeto) + '\n');
    // exitCode y no exit(): con exit() la escritura a un pipe se puede cortar.
    process.exitCode = code === undefined ? 1 : code;
  }

  if (modo === 'falla-sin-sesion' || modo === 'falla-sin-sesion-code0') {
    // Máquina sin login terminado: el CLI arranca, no tiene con qué
    // autenticarse y cierra en el acto. A veces con código 1 y a veces con 0 y
    // el error adentro del JSON.
    cierraMal({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      result: 'Invalid API key · Please run /login',
      session_id: 'sesion-de-mentira', duration_ms: 120,
    }, modo === 'falla-sin-sesion-code0' ? 0 : 1);
    return;
  }
  if (modo === 'falla-cuota') {
    cierraMal({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      result: 'Claude AI usage limit reached|1799999999',
    });
    return;
  }
  if (modo === 'falla-modelo') {
    // Forma en que viaja un error de la API: anidado bajo `error`.
    cierraMal({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-que-no-existe' } });
    return;
  }
  if (modo === 'falla-ruido') {
    // Con el estado en vivo, TODO lo que escribió el modelo sale por el mismo
    // stdout. Acá la composición habla de permisos y de límites de uso, y el
    // fallo real es otro: la causa no se puede adivinar leyendo esa prosa.
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }) + '\n');
    process.stdout.write(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '<p>permission denied · usage limit reached</p>' }] },
    }) + '\n');
    cierraMal({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      result: 'se cortó la conexión con el servidor',
    });
    return;
  }
  if (modo === 'falla-permisos') {
    // Este sí escribe por stderr: el arreglo no puede romper lo que ya andaba.
    process.stderr.write('Error: EACCES: permission denied, open /usr/local/lib/claude\n');
    process.exitCode = 1;
    return;
  }
  if (modo === 'falla-muda') {
    // Ni una letra por ningún lado: el motor tiene que DECIR que no dijo nada.
    process.exitCode = 1;
    return;
  }

  if (modo === 'viejo' || modo === 'sin-sysfile') {
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: '<html>viejo</html>',
      usage: { input_tokens: 5, output_tokens: 7 },
      total_cost_usd: 0.01,
    }) + '\n');
    return;
  }

  // Los modos de stream reproducen una salida REAL capturada del CLI.
  const real = fs.readFileSync(path.join(fixtures, 'claude-thinking.jsonl'), 'utf8');
  if (modo === 'sin-final') {
    // Se corta antes del evento de resultado: queda el rescate por los mensajes.
    const lineas = real.split('\n').filter(Boolean)
      .filter((l) => l.indexOf('"type":"result"') === -1);
    process.stdout.write(lineas.join('\n') + '\n');
    return;
  }
  if (modo === 'final-vacio') {
    // El evento final LLEGA, con sus tokens, pero sin texto. Visto una vez en
    // pruebas reales: el agente dio una segunda vuelta y esa terminó sin
    // respuesta, con la composición ya escrita en la vuelta anterior. Es
    // distinto de 'sin-final' (ahí no hay evento) y hay que rescatar igual,
    // pero SIN perder el conteo de tokens, que en este caso sí vino.
    const lineas = real.split('\n').filter(Boolean)
      .filter((l) => l.indexOf('"type":"result"') === -1);
    process.stdout.write(lineas.join('\n') + '\n');
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: '',
      usage: { input_tokens: 33, output_tokens: 44 },
      total_cost_usd: 0.05,
    }) + '\n');
    return;
  }
  if (modo === 'mudo') {
    // Ni resultado ni mensajes: el modelo no dejó una sola línea. Acá no hay
    // nada que rescatar y el motor tiene que DECIRLO, no quedarse callado.
    const lineas = real.split('\n').filter(Boolean)
      .filter((l) => l.indexOf('"type":"result"') === -1 && l.indexOf('"type":"assistant"') === -1);
    process.stdout.write(lineas.join('\n') + '\n');
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: '',
      usage: { input_tokens: 33, output_tokens: 0 },
      total_cost_usd: 0.01,
    }) + '\n');
    return;
  }
  if (modo === 'stdin') {
    // Devuelve por dónde entró el prompt, para poder afirmarlo desde el test.
    process.stdout.write(real.split('\n').filter(Boolean).slice(0, -1).join('\n') + '\n');
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: 'STDIN:' + stdin.length + ' ARGS:' + args.filter((a) => a.length > 200).length,
      usage: { input_tokens: 11, output_tokens: 22 },
      total_cost_usd: 0.02,
    }) + '\n');
    return;
  }
  process.stdout.write(real);
}

main();
