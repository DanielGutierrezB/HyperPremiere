'use strict';

// Que al modelo le llegue EXACTAMENTE lo mismo en Windows que en Mac.
//
// El caso real: en la máquina Windows del editor, dos de tres marcadores
// volvieron sin el `<div id="stage">` que la PLANTILLA OBLIGATORIA del system
// prompt exige. Las 21 composiciones generadas en Mac lo cumplían todas. Mismos
// insumos, distinto resultado — así que lo que cambiaba era lo que llegaba.
//
// Y cambiaba: en Windows el prompt no puede ir por la línea de comandos (cmd.exe
// la corta a los 8191 caracteres y solo el system prompt ya son 12.500), así que
// va por stdin. Con el prompt de usuario mudándose a stdin se había mudado
// TAMBIÉN el system prompt, pegado adelante con un `---` en el medio: dejaba de
// ser un system prompt y pasaba a ser el arranque de un mensaje de usuario
// larguísimo. La plantilla seguía estando; ya no estaba donde se obedece.
//
// Estos tests corren el proveedor por los dos caminos contra un CLI de mentira
// que escribe en un archivo el prompt EXACTO que recibió (por argumento y por
// stdin) y comparan byte a byte. Si los dos caminos vuelven a divergir, fallan.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq, has } = require('./harness');
const claude = require('../bridge/providers/claude-cli');

const FAKE = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-claude.js');
const SYSTEM_MD = path.join(__dirname, '..', 'bridge', 'prompt', 'system.md');

// El CLI de mentira es un script con shebang: en Windows no arranca solo.
const saltarEnWindows = process.platform === 'win32';

// El system prompt DE VERDAD, no uno de juguete: la falla que motiva este
// archivo es que se perdía justamente su sección de plantilla obligatoria.
const SYSTEM = fs.readFileSync(SYSTEM_MD, 'utf8');

// Un prompt de usuario con todo lo que en teoría podía romperse en el viaje:
// acentos, eñes, emoji, comillas, signos que cmd.exe interpreta (%, &, ^, |),
// y una ruta de Windows con contrabarras, espacios y guion largo — igualita a
// las del disco E: del editor.
const RUTA_WINDOWS = 'E:\\2607_curso–etica-ai\\_capturas\\Marcador 12 [v2].png';
const USUARIO = [
  '## Objetivo de la clase',
  'Explicar la ética en IA — con ñ, tildes (áéíóú) y un emoji 🎬.',
  'Cita textual: "no lo tapes" & 100% de foco ^ nada de | pipes.',
  '',
  '## Referencia en disco',
  '- imagen 1 → ' + RUTA_WINDOWS,
  '',
  'Devolvé SOLO el HTML completo de la composición.',
].join('\n');

// Dos PNG mínimos (1x1) para que el proveedor los deje en disco y le tenga que
// contar al modelo dónde quedaron.
const PNG_1X1 = 'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hp-prompt-')), 'recibido.json');
}

/**
 * Corre el proveedor y devuelve LO QUE VIO EL CLI, ya normalizado a las dos
 * cosas que le importan al modelo: su system prompt y su mensaje de usuario.
 *
 * `viaStdin` es el interruptor de plataforma: false = el camino de mac
 * (argumentos), true = el de Windows (stdin). Se fuerza a mano para poder
 * comparar los dos acá, en la misma máquina y con los mismos insumos.
 */
async function correr(viaStdin, opts) {
  opts = opts || {};
  const log = tmpLog();
  const prev = { modo: process.env.FAKE_MODE, log: process.env.FAKE_LOG };
  process.env.FAKE_MODE = opts.modo || 'viejo';
  process.env.FAKE_LOG = log;
  try {
    await claude.generate({
      systemPrompt: SYSTEM,
      userPrompt: USUARIO,
      images: opts.sinImagenes ? [] : [PNG_1X1, PNG_1X1],
      model: 'modelo-de-prueba',
      config: Object.assign({
        binPath: FAKE, timeoutMs: 30000, promptViaStdin: viaStdin,
      }, opts.config || {}),
    });
  } catch (e) {
    if (!opts.puedeFallar) throw e;
  }
  const r = JSON.parse(fs.readFileSync(log, 'utf8'));
  if (prev.modo === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = prev.modo;
  if (prev.log === undefined) delete process.env.FAKE_LOG; else process.env.FAKE_LOG = prev.log;

  // El mensaje del editor entra por argumento (mac) o por stdin (Windows): para
  // comparar, lo que importa es el texto, no por qué caño vino.
  r.mensajeDeUsuario = r.promptPosicional !== null ? r.promptPosicional : r.stdinCompleto;
  // Todos los intentos, en orden: el log de arriba solo guarda el último.
  r.intentos = fs.readFileSync(log + '.jsonl', 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return r;
}

// ── La comparación: mismos insumos, ¿mismo prompt? ──────────────────────

test('el system prompt le llega al modelo IGUAL por los dos caminos (mac y Windows)', async function () {
  if (saltarEnWindows) return;
  const mac = await correr(false);
  const win = await correr(true);

  ok(mac.systemPrompt !== null, 'en mac el system prompt llega (vía ' + mac.systemPromptVia + ')');
  ok(win.systemPrompt !== null,
    'en Windows el system prompt TAMBIÉN tiene que llegar como system prompt, y llegó vía "' +
    win.systemPromptVia + '"');
  eq(win.systemPrompt, mac.systemPrompt,
    'byte a byte, el system prompt de Windows y el de mac son el mismo texto');
});

test('el mensaje del editor le llega al modelo IGUAL por los dos caminos', async function () {
  if (saltarEnWindows) return;
  const mac = await correr(false);
  const win = await correr(true);
  // Las rutas de las imágenes temporales cambian en cada corrida (mkdtemp), así
  // que se comparan con ese pedazo neutralizado: lo que se afirma es que no hay
  // NINGUNA otra diferencia de texto entre las dos plataformas.
  const sinTemp = (s) => String(s).replace(/hyperpremiere-stills-[A-Za-z0-9]+/g, 'DIR');
  eq(sinTemp(win.mensajeDeUsuario), sinTemp(mac.mensajeDeUsuario),
    'el mensaje de usuario es el mismo texto en las dos plataformas');
});

test('en Windows el system prompt NO va escondido adentro del mensaje del editor', async function () {
  if (saltarEnWindows) return;
  // Esta es la falla concreta que se arregló: el system prompt viajaba pegado
  // al principio del mensaje de usuario con un "---" de separador. La plantilla
  // llegaba, pero como párrafo de un mensaje larguísimo en vez de como
  // instrucción del sistema — y el modelo la salteaba 2 de cada 3 veces.
  const win = await correr(true);
  eq(win.mensajeDeUsuario.indexOf('# PLANTILLA OBLIGATORIA'), -1,
    'la plantilla no aparece dentro del mensaje del editor');
  eq(win.mensajeDeUsuario.indexOf('Sos un motion designer senior'), -1,
    'el rol tampoco: el system prompt no se mete en el mensaje de usuario');
  eq(win.mensajeDeUsuario.indexOf('\n\n---\n\n'), -1,
    'ya no hay un "---" pegando dos prompts que son cosas distintas');
});

test('la PLANTILLA OBLIGATORIA con el <div id="stage"> llega entera por los dos caminos', async function () {
  if (saltarEnWindows) return;
  // Lo que en Windows volvía sin cumplirse. Se verifica que el texto que lo
  // exige esté completo —no recortado— en el system prompt de las dos.
  for (const [nombre, via] of [['mac', false], ['Windows', true]]) {
    const r = await correr(via);
    has(r.systemPrompt, '# PLANTILLA OBLIGATORIA', 'en ' + nombre + ' llega la sección de la plantilla');
    has(r.systemPrompt, '<div id="stage"', 'en ' + nombre + ' llega el contenedor obligatorio');
    has(r.systemPrompt, 'window.__timelines[COMP_ID] = tl;', 'en ' + nombre + ' llega el registro de la timeline');
    eq(r.systemPrompt, SYSTEM.trim(),
      'en ' + nombre + ' el system prompt llega completo y sin nada pegado');
  }
});

// ── Las hipótesis que había que descartar ───────────────────────────────

test('acentos, eñes y emojis sobreviven intactos el viaje por stdin', async function () {
  if (saltarEnWindows) return;
  // Si stdin se mandara con la codificación de la consola de Windows en vez de
  // UTF-8, el modelo recibiría basura sin que nadie viera un error. Se afirma
  // que no pasa: el texto vuelve idéntico, carácter por carácter.
  const win = await correr(true);
  has(win.mensajeDeUsuario, 'ética en IA — con ñ, tildes (áéíóú) y un emoji 🎬',
    'el texto con acentos y emoji llega tal cual por stdin');
  has(win.systemPrompt, 'Devolvé SOLO el HTML completo de la composición',
    'y el system prompt también conserva sus tildes');
});

test('una ruta de Windows llega con sus contrabarras intactas por los dos caminos', async function () {
  if (saltarEnWindows) return;
  // La sospecha era que una contrabarra adentro del prompt podía desaparecer o
  // escaparse. No pasa: ni por argumento ni por stdin. La ruta con espacios,
  // guion largo y corchetes vuelve carácter por carácter.
  const mac = await correr(false);
  const win = await correr(true);
  has(mac.mensajeDeUsuario, RUTA_WINDOWS, 'por argumento la ruta llega entera');
  has(win.mensajeDeUsuario, RUTA_WINDOWS, 'por stdin la ruta llega entera');
});

test('en Windows el prompt largo no pasa por la línea de comandos', async function () {
  if (saltarEnWindows) return;
  // El motivo de que exista el camino por stdin: cmd.exe corta la línea a 8191
  // caracteres. Lo que SÍ puede ir por argumento es la RUTA del archivo con el
  // system prompt, que mide un puñado de bytes.
  const win = await correr(true);
  const largo = win.args.filter((a) => a.length > 1000);
  eq(largo.length, 0, 'ningún argumento gigante en la línea de comandos: ' + JSON.stringify(largo.map((a) => a.length)));
  ok(win.stdinLen > 200, 'el mensaje del editor viajó por stdin (' + win.stdinLen + ' caracteres)');
  const linea = win.args.join(' ').length;
  ok(linea < 8191, 'la línea de comandos entera entra en el tope de cmd.exe (' + linea + ' caracteres)');
});

// ── Las imágenes de referencia: que el CLI tenga permiso de abrirlas ─────

test('el CLI recibe declarada la carpeta donde están las imágenes de referencia', async function () {
  if (saltarEnWindows) return;
  // Las imágenes no van adjuntas: se dejan en un temporal y el prompt dice
  // dónde están. Pero el CLI de Claude solo lee sin preguntar adentro de sus
  // "allowed working directories", y ese temporal no es su directorio de
  // trabajo. En headless no hay a quién preguntarle, así que la lectura se
  // deniega en silencio y el modelo diseña a ciegas.
  //
  // Que en mac casi nunca se notara es un accidente: Premiere arranca el panel
  // con el directorio de trabajo en la raíz, y el temporal de mac (/var/...)
  // cuelga de ahí. En Windows el temporal está en C:\Users\...\Temp y el
  // directorio de trabajo es la carpeta de Premiere: no cuelga de ningún lado.
  for (const [nombre, via] of [['mac', false], ['Windows', true]]) {
    const r = await correr(via);
    ok(r.addDirs.length > 0, 'en ' + nombre + ' se le declara al CLI alguna carpeta con --add-dir');
    // La carpeta declarada tiene que ser LA MISMA donde el prompt dice que
    // están las imágenes. Declarar otra no sirve de nada.
    const enElPrompt = r.mensajeDeUsuario.match(/- imagen 1 → (.+)/g) || [];
    const rutaImagen = enElPrompt[enElPrompt.length - 1].replace('- imagen 1 → ', '').trim();
    ok(r.addDirs.some((d) => rutaImagen.indexOf(d) === 0),
      'en ' + nombre + ' la carpeta declarada (' + r.addDirs.join(', ') +
      ') es la que contiene la imagen del prompt (' + rutaImagen + ')');
  }
});

test('sin imágenes no se le declara ninguna carpeta de más al CLI', async function () {
  if (saltarEnWindows) return;
  // El permiso se da porque hace falta, no por costumbre: sin imágenes de
  // referencia el CLI no necesita ver ningún temporal nuestro.
  const r = await correr(false, { sinImagenes: true });
  eq(r.addDirs.length, 0, 'no hay --add-dir de sobra: ' + JSON.stringify(r.addDirs));
});

test('las carpetas que el prompt manda leer (recursos del editor) se declaran también', async function () {
  if (saltarEnWindows) return;
  // El motor le dice al modelo "abrí estos PDFs/documentos" con la ruta del
  // proyecto. En el disco E: del editor esa carpeta tampoco cuelga del
  // directorio de trabajo del CLI, así que sin declararla el modelo compone sin
  // los recursos que el editor subió a propósito.
  const dirRecursos = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-recursos-'));
  try {
    const r = await correr(true, { config: { readDirs: [dirRecursos] } });
    ok(r.addDirs.indexOf(dirRecursos) !== -1,
      'la carpeta de recursos se declara: ' + JSON.stringify(r.addDirs));
  } finally {
    try { fs.rmSync(dirRecursos, { recursive: true, force: true }); } catch (e) {}
  }
});

test('una ruta que no es una carpeta existente no se le pasa al CLI', async function () {
  if (saltarEnWindows) return;
  // El disco del proyecto puede estar desmontado. Comprobado contra el CLI de
  // verdad: una ruta inexistente la ignora, pero si le pasás un ARCHIVO escribe
  // "no es un directorio" por stderr — y stderr es lo que el panel le muestra
  // al editor cuando algo falla. Un aviso nuestro ahí adentro solo confunde.
  const archivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hp-noesdir-')), 'un-archivo.txt');
  fs.writeFileSync(archivo, 'no soy una carpeta', 'utf8');
  const r = await correr(true, { config: { readDirs: ['/no/existe/esta/carpeta', archivo] } });
  eq(r.addDirs.indexOf('/no/existe/esta/carpeta'), -1, 'la ruta fantasma se descarta');
  eq(r.addDirs.indexOf(archivo), -1, 'un archivo suelto también se descarta');
});

test('el prompt de usuario nunca queda detrás de un --add-dir', async function () {
  if (saltarEnWindows) return;
  // Trampa comprobada contra el CLI de verdad: `--add-dir` es variádico
  // ("--add-dir <directories...>"), así que se traga el argumento siguiente si
  // no empieza con guion. Con `claude -p --add-dir /tmp hola`, el CLI se come
  // "hola" y corta con "Input must be provided either through stdin or as a
  // prompt argument". Si alguien reordena buildArgs y el prompt del editor
  // queda después de un --add-dir, se pierde la generación entera.
  const r = await correr(false); // camino de mac: el prompt va por argumento
  eq(r.args[0], '-p', 'la llamada arranca con -p');
  eq(r.args[1], r.mensajeDeUsuario, 'y el prompt va pegado a -p, en la posición 1');
  const primerAddDir = r.args.indexOf('--add-dir');
  ok(primerAddDir > 1, 'todos los --add-dir vienen después del prompt');
  // Y cada --add-dir tiene que estar seguido de SU carpeta y de un flag, nunca
  // de texto suelto que el CLI pueda confundir con otra carpeta.
  r.args.forEach((a, i) => {
    if (a !== '--add-dir') return;
    const siguiente = r.args[i + 2];
    ok(siguiente === undefined || siguiente.charAt(0) === '-',
      'después de "--add-dir ' + r.args[i + 1] + '" viene un flag o el final, no texto suelto (vino: ' +
      JSON.stringify(String(siguiente).slice(0, 40)) + ')');
  });
});

// ── Que el arreglo no deje sin generar a un CLI más viejo ───────────────

test('con un CLI viejo que no conoce --append-system-prompt-file, se vuelve al método de antes', async function () {
  if (saltarEnWindows) return;
  // El flag existe desde claude 2.1.x. Si la máquina del editor tiene una
  // versión anterior, el CLI corta al instante con "unknown option" y sin gastar
  // un token: ahí se reintenta con el system prompt pegado al mensaje, que es
  // peor pero genera. Quedarse sin recurso sería mucho peor.
  const r = await correr(true, { modo: 'sin-sysfile' });
  eq(r.intentos.length, 2, 'hubo un primer intento y un reintento');
  ok(r.intentos[0].args.indexOf('--append-system-prompt-file') !== -1,
    'el primer intento SÍ probó con el flag nuevo (si no, este test no probaría nada)');
  eq(r.args.indexOf('--append-system-prompt-file'), -1,
    'el reintento ya no lleva el flag que el CLI rechazó');
  has(r.stdinCompleto, '# PLANTILLA OBLIGATORIA',
    'y el system prompt igual llega, ahora sí adentro del mensaje');
  has(r.stdinCompleto, 'Devolvé SOLO el HTML completo de la composición',
    'con el mensaje del editor a continuación');
});
