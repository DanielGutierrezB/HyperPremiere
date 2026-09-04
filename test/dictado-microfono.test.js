'use strict';

// El micrófono del dictado, del lado del motor: qué dispositivos hay, cuál se
// abre y qué dice la prueba de ⚙.
//
// De dónde sale: con una interfaz de audio, unos auriculares Bluetooth y una
// webcam enchufados, "el micrófono" es una lotería. En esta máquina ffmpeg
// lista SEIS entradas y solo una es un micrófono de verdad que suena: el [0] es
// el iPhone por Continuidad (abre y no entrega nada), el [1] es la webcam
// (entrega ceros), tres son virtuales (Steam, Zoom: ceros) y el [2] es el de la
// MacBook. Lo que se fija acá es que se elija por NOMBRE, que se resuelva al
// índice de hoy, que si el elegido no está se caiga al del sistema DICIÉNDOLO,
// y que la prueba distinga las tres formas de "no anda" que se midieron.
//
// El micrófono de verdad no se abre acá (ver dictado-motor.test.js). La captura
// la hace un ffmpeg de mentira que escupe PCM con los niveles medidos, y lo que
// se comprueba es todo lo que se decide con lo que entra.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq, has } = require('./harness');
const microfono = require('../bridge/dictado-microfono');
const dictado = require('../bridge/dictado');

const FIXTURES = path.join(__dirname, 'fixtures');
const FAKE_FFMPEG = path.join(FIXTURES, 'fake-cli', 'fake-ffmpeg.js');
const FAKE_WORKER = path.join(FIXTURES, 'fake-cli', 'fake-whisper-worker.js');
const LISTA_REAL = fs.readFileSync(path.join(FIXTURES, 'avfoundation-list-devices.txt'), 'utf8');
const LISTA_RARA = fs.readFileSync(path.join(FIXTURES, 'avfoundation-list-devices-nombres-raros.txt'), 'utf8');
const PROFILER_REAL = fs.readFileSync(path.join(FIXTURES, 'system-profiler-audio.json'), 'utf8');
// Los procesos de mentira son scripts con shebang: en Windows no arrancan solos.
const saltarEnWindows = process.platform === 'win32';
// La prueba y el dictado usan avfoundation: fuera de Mac se rechazan antes de
// abrir nada, y eso tiene su propio test.
const saltarFueraDeMac = process.platform !== 'darwin';

// --- 1. La lista que imprime ffmpeg ------------------------------------------

test('la lista de audio se lee de la salida real de esta máquina, con sus índices', function () {
  const p = microfono._parsearDispositivos(LISTA_REAL);
  ok(p.huboSeccion, 'tiene que encontrar la sección de audio');
  eq(p.dispositivos.length, 6, 'seis entradas, tal como las lista ffmpeg acá');
  eq(p.dispositivos[0].indice, 0);
  eq(p.dispositivos[0].nombre, 'iPhone de Daniel Microphone');
  eq(p.dispositivos[2].indice, 2);
  eq(p.dispositivos[2].nombre, 'MacBook Pro Microphone');
  eq(p.dispositivos[5].nombre, 'ZoomAudioDevice');
});

test('las cámaras no se cuelan en la lista de micrófonos', function () {
  // La sección de video viene ANTES, con sus propios índices desde cero.
  // Confundirlas es abrir "FaceTime HD Camera" como si fuera un micrófono.
  const nombres = microfono._parsearDispositivos(LISTA_REAL).dispositivos.map((d) => d.nombre);
  ok(nombres.indexOf('FaceTime HD Camera') === -1);
  ok(nombres.indexOf('OBS Virtual Camera') === -1);
  ok(nombres.indexOf('Capture screen 0') === -1);
});

test('los nombres con paréntesis, tildes y guiones largos llegan enteros', function () {
  const d = microfono._parsearDispositivos(LISTA_RARA).dispositivos;
  eq(d.length, 9);
  eq(d[6].nombre, 'Auriculares de Daniel (2)', 'el "(2)" es parte del nombre, no un adorno');
  eq(d[7].nombre, 'Micrófono USB Røde NT-USB Mini (Entrada 1 · 48 kHz)');
  eq(d[8].nombre, 'Interfaz de audio Focusrite Scarlett 2i2 4th Gen — canal 1 (guitarra) y canal 2 (voz principal, condensador)',
    'un nombre largo no se recorta: es lo que se guarda y lo que se compara después');
  eq(d[8].indice, 8);
});

test('la línea ajena de EOS Webcam Utility y el error final no ensucian la lista', function () {
  // La salida real arranca con una línea de NSLog de un plugin de CoreMediaIO y
  // termina con el error de abrir "": ninguna de las dos es un dispositivo.
  const d = microfono._parsearDispositivos(LISTA_REAL).dispositivos;
  ok(d.every((x) => !/CMIOMS|Error opening/.test(x.nombre)));
});

test('el prefijo de las versiones viejas de ffmpeg se lee igual', function () {
  const viejo = '[AVFoundation input device @ 0x7f8a4b40] AVFoundation video devices:\n' +
    '[AVFoundation input device @ 0x7f8a4b40] [0] FaceTime HD Camera\n' +
    '[AVFoundation input device @ 0x7f8a4b40] AVFoundation audio devices:\n' +
    '[AVFoundation input device @ 0x7f8a4b40] [0] Built-in Microphone\n' +
    '[AVFoundation input device @ 0x7f8a4b40] [1] Auriculares de Daniel (2)\n';
  const p = microfono._parsearDispositivos(viejo);
  eq(p.dispositivos.length, 2);
  eq(p.dispositivos[1].nombre, 'Auriculares de Daniel (2)');
});

test('una salida sin la sección de audio se reconoce como "no pude listar"', function () {
  const p = microfono._parsearDispositivos('ffmpeg version 9.0.1\nUnrecognized option list_devices.\n');
  ok(!p.huboSeccion, 'y no una lista vacía que parezca "no hay micrófonos"');
  eq(p.dispositivos.length, 0);
});

test('el default del sistema se saca de system_profiler, con el mismo nombre que usa ffmpeg', function () {
  // Es lo que permite DECIR cuál es el default sin abrir el micrófono (abrirlo
  // dispararía el permiso de macOS por el solo hecho de abrir ⚙).
  eq(microfono._nombreDelDefaultEn(PROFILER_REAL), 'MacBook Pro Microphone');
  eq(microfono._nombreDelDefaultEn('esto no es json'), '', 'si no se pudo, vacío y no una excepción');
  eq(microfono._nombreDelDefaultEn('{"SPAudioDataType":[]}'), '');
});

// --- 2. Elegir por nombre, resolver a índice ---------------------------------

const LISTA = microfono._parsearDispositivos(LISTA_REAL).dispositivos;

test('el nombre elegido se resuelve al índice de HOY', function () {
  const r = microfono._resolverDispositivo('MacBook Pro Microphone', LISTA, 'MacBook Pro Microphone');
  eq(r.origen, 'elegido');
  eq(r.indice, 2);
  eq(r.entrada, ':2', 'lo que se le pasa a ffmpeg es el índice, resuelto en el momento');
  eq(r.aviso, '');
});

test('si los índices se corren, el mismo nombre sigue abriendo el mismo micrófono', function () {
  // Sin el iPhone cerca, todos suben un lugar. Guardar "índice 2" habría
  // abierto los Steam Streaming Speakers.
  const sinIphone = LISTA.slice(1).map((d, i) => ({ indice: i, nombre: d.nombre }));
  const r = microfono._resolverDispositivo('MacBook Pro Microphone', sinIphone, 'MacBook Pro Microphone');
  eq(r.indice, 1);
  eq(r.entrada, ':1');
});

test('el elegido que ya no está cae al del sistema Y LO DICE', function () {
  const r = microfono._resolverDispositivo('Auriculares de Daniel (2)', LISTA, 'MacBook Pro Microphone');
  eq(r.origen, 'caida');
  eq(r.entrada, ':default', 'se cae al del sistema, no al primero de la lista (que acá es el iPhone)');
  eq(r.nombre, 'MacBook Pro Microphone');
  eq(r.indice, 2, 'con el índice del default, para el log');
  eq(r.elegido, 'Auriculares de Daniel (2)', 'y se conserva qué se había elegido');
  has(r.aviso, 'Auriculares de Daniel (2)', 'el aviso nombra al que falta…');
  has(r.aviso, 'MacBook Pro Microphone', '…y al que se usa en su lugar');
  has(r.aviso, 'no está conectado');
});

test('sin elección, el del sistema, dicho como "todavía no elegiste"', function () {
  const r = microfono._resolverDispositivo('', LISTA, 'MacBook Pro Microphone');
  eq(r.origen, 'default');
  eq(r.entrada, ':default');
  eq(r.indice, 2);
  has(r.aviso, 'Todavía no elegiste');
  has(r.aviso, 'MacBook Pro Microphone', 'con el nombre: "el default" no le dice nada a nadie');
  has(r.aviso, '⚙', 'y dónde se elige');
});

test('si no se pudo averiguar el default, se dice eso en vez de inventar un nombre', function () {
  const r = microfono._resolverDispositivo('', LISTA, '');
  eq(r.entrada, ':default', 'ffmpeg lo resuelve igual');
  eq(r.indice, -1);
  has(r.aviso, 'no pude averiguar cuál');
  has(r.aviso, 'Sonido → Entrada', 'y dónde mirarlo');
});

test('con la lista vacía se avisa y no se adivina', function () {
  const r = microfono._resolverDispositivo('MacBook Pro Microphone', [], '');
  eq(r.origen, 'sin-dispositivos');
  has(r.aviso, 'ningún dispositivo');
});

test('dos dispositivos con el mismo nombre: se usa el primero, avisando', function () {
  const dobles = LISTA.concat([{ indice: 6, nombre: 'MacBook Pro Microphone' }]);
  const r = microfono._resolverDispositivo('MacBook Pro Microphone', dobles, '');
  eq(r.indice, 2);
  has(r.aviso, 'Hay 2 dispositivos');
});

test('la línea del log dice nombre, índice y de dónde salió', function () {
  const l = microfono.describir(microfono._resolverDispositivo('', LISTA, 'MacBook Pro Microphone'));
  has(l, '«MacBook Pro Microphone»');
  has(l, 'índice 2');
  has(l, 'sin elección en ⚙');
  has(l, ':default');
  const c = microfono.describir(microfono._resolverDispositivo('Auriculares de Daniel (2)', LISTA, 'MacBook Pro Microphone'));
  has(c, 'porque el elegido «Auriculares de Daniel (2)» no está');
});

// --- 3. Lo que dice ffmpeg cuando no abre ------------------------------------

test('un índice que ya no existe no se diagnostica como problema de permisos', function () {
  // Lo que imprime ffmpeg de verdad con ":9" en esta máquina: el mensaje
  // específico Y el "Input/output error" genérico. Si se mirara el genérico
  // primero, desenchufar los auriculares mandaría al editor a Ajustes del
  // Sistema a tocar un permiso que está bien.
  const m = microfono.leerErrorDeFfmpeg(
    '[AVFoundation indev @ 0xb60c1c140] Invalid audio device index\n' +
    '[in#0 @ 0xb60c1c000] Error opening input: Input/output error\n' +
    'Error opening input file :9.\nError opening input files: Input/output error', 'Auriculares de Daniel (2)');
  has(m, 'no encontró el micrófono');
  has(m, 'Auriculares de Daniel (2)');
  has(m, 'Refrescá la lista');
  ok(m.indexOf('Privacidad y seguridad') === -1, 'esto NO es un problema de permisos');
});

test('el error de entrada/salida a secas sí manda al permiso de Premiere', function () {
  const m = microfono.leerErrorDeFfmpeg('[in#0 @ 0x1] Error opening input: Input/output error', 'MacBook Pro Microphone');
  has(m, 'Privacidad y seguridad');
  has(m, 'Adobe Premiere Pro', 'el permiso lo pide Premiere: buscando "HyperPremiere" no lo va a encontrar');
  has(m, 'reiniciá Premiere');
  has(m, 'no vuelve a preguntar', 'y por qué no le apareció el diálogo otra vez');
});

test('la línea de EOS Webcam Utility en stderr no cuenta como error de ffmpeg', function () {
  // Medido acá: cada arranque de ffmpeg deja esa línea, con el micrófono
  // andando perfecto. Sin este filtro, "no entró audio y stderr dice algo"
  // se dispara en falso apenas el micrófono tarda un segundo en arrancar.
  const ruido = '2026-09-03 20:34:42.309 ffmpeg[17737:129621] CMIOMS: EOSWebcamUtilityMain \n';
  ok(!microfono.hayErrorDeFfmpeg(ruido));
  ok(microfono.hayErrorDeFfmpeg(ruido + '[in#0 @ 0x1] Error opening input: Input/output error\n'),
    'pero un error de verdad después de la línea sí se ve');
  eq(microfono._textoDeErrorDeFfmpeg(ruido + 'Audio device not found\n'), 'Audio device not found');
});

// --- 4. El veredicto de la prueba, como función pura -------------------------

const DISPOSITIVO = { nombre: 'MacBook Pro Microphone', indice: 2, origen: 'default', entrada: ':default' };
function medicion(extra) {
  return Object.assign({
    bytes: 7 * 32000, segundos: 7, duracion: 7, rmsGlobal: 0, pico: 0, cerosPct: 0,
    errorFfmpeg: '', dispositivo: DISPOSITIVO, umbral: 0.02,
  }, extra || {});
}

test('con voz de verdad el veredicto es "pasa la compuerta"', function () {
  // Medido acá hablándole al micrófono: RMS 0,078 a 0,089.
  const v = microfono._veredictoDePrueba(medicion({ rmsGlobal: 0.08, pico: 0.12 }));
  eq(v.estado, 'ok');
  has(v.titulo, 'pasa la compuerta');
  has(v.titulo, 'MacBook Pro Microphone');
  has(v.detalle, '-21.9 dBFS', 'el promedio, en números');
  has(v.detalle, '-34.0 dBFS', 'y dónde está la compuerta, para comparar');
});

test('la sala callada es "floja", con el número y qué tocar', function () {
  // Las tres tomas de sala medidas: RMS 0,0065 · 0,0107 · 0,0144.
  const v = microfono._veredictoDePrueba(medicion({ rmsGlobal: 0.0107, pico: 0.0144 }));
  eq(v.estado, 'floja');
  has(v.detalle, '-39.4 dBFS');
  has(v.detalle, 'Sonido → Entrada', 'dónde se sube el volumen de entrada');
  has(v.detalle, 'ruido de la sala', 'y que si no habló, esto es lo esperable');
});

test('hablar poco en la prueba se explica, no se castiga como micrófono roto', function () {
  // El pico pasa pero el promedio no: el dictado mira el promedio de todo lo
  // grabado, así que hay que decirle que hable seguido, no que cambie de micrófono.
  const v = microfono._veredictoDePrueba(medicion({ rmsGlobal: 0.012, pico: 0.09 }));
  eq(v.estado, 'floja');
  has(v.titulo, 'Hubo voz');
  has(v.detalle, 'promedio');
  has(v.detalle, 'hablá seguido');
});

test('todas las muestras en cero es silencio digital, y se nombra el permiso de Premiere', function () {
  // Lo que entregan los dispositivos virtuales y un micrófono con el permiso
  // negado: muestras a ritmo normal, todas en cero exacto. Medido acá con
  // Steam, Zoom y la webcam.
  const v = microfono._veredictoDePrueba(medicion({ cerosPct: 100 }));
  eq(v.estado, 'silencio-digital');
  has(v.titulo, 'cero exacto');
  has(v.detalle, 'Privacidad y seguridad');
  has(v.detalle, 'Adobe Premiere Pro');
  has(v.detalle, 'otra app', 'la segunda causa');
  has(v.detalle, 'virtual', 'y la tercera: Zoom, Steam, OBS figuran como entradas');
});

test('abrir sin entregar ni una muestra es otra cosa, y se dice', function () {
  // El iPhone por Continuidad con el teléfono lejos: abre, 0 bytes en 3,5 s.
  const v = microfono._veredictoDePrueba(medicion({
    bytes: 0, segundos: 0, dispositivo: { nombre: 'iPhone de Daniel Microphone', indice: 0, origen: 'elegido' },
  }));
  eq(v.estado, 'sin-muestras');
  has(v.titulo, 'iPhone de Daniel Microphone');
  has(v.titulo, 'ni una muestra');
  has(v.detalle, 'iPhone', 'con el ejemplo real, que es el que más confunde');
  has(v.detalle, 'Privacidad y seguridad', 'y el permiso, que también puede ser');
});

test('si ffmpeg no abrió, el veredicto trae su error textual y el dispositivo', function () {
  const v = microfono._veredictoDePrueba(medicion({
    bytes: 0, errorFfmpeg: '[in#0 @ 0x1] Error opening input: Input/output error',
    dispositivo: { nombre: 'Auriculares de Daniel (2)', indice: 6, origen: 'elegido' },
  }));
  eq(v.estado, 'no-abre');
  has(v.titulo, 'Auriculares de Daniel (2)');
  has(v.titulo, 'índice 6');
  has(v.detalle, 'Input/output error', 'lo que dijo ffmpeg, tal cual');
  has(v.detalle, 'Privacidad y seguridad');
});

// --- 5. La prueba entera, con el ffmpeg de mentira ---------------------------

/** Corre `fn` con el ffmpeg falso en un modo, y devuelve sus argv y las notas. */
async function conFfmpegFalso(modo, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-ffmpeg-'));
  const log = path.join(dir, 'argv.txt');
  const previos = { bin: process.env.HYPERPREMIERE_FFMPEG, modo: process.env.FAKE_FFMPEG_MODO, log: process.env.FAKE_FFMPEG_LOG };
  process.env.HYPERPREMIERE_FFMPEG = FAKE_FFMPEG;
  process.env.FAKE_FFMPEG_MODO = modo;
  process.env.FAKE_FFMPEG_LOG = log;
  const notas = [];
  const niveles = [];
  const mensajes = [];
  const fases = [];
  function prog(p) {
    if (p.note) notas.push((p.level || 'INFO') + ' ' + p.note);
    if (p.nivel) niveles.push(p.nivel);
    if (p.msg) mensajes.push(p.msg);
    if (p.fase) fases.push(p.fase);
  }
  try {
    const r = await fn(prog);
    const argv = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    return { r, argv, notas, niveles, mensajes, fases };
  } finally {
    ['HYPERPREMIERE_FFMPEG', 'FAKE_FFMPEG_MODO', 'FAKE_FFMPEG_LOG'].forEach(function (k, i) {
      const v = [previos.bin, previos.modo, previos.log][i];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CFG_MACBOOK = { microfono: 'MacBook Pro Microphone' };

test('la lista del handler de ⚙ marca el default y dice cuál se usaría', async function () {
  if (saltarEnWindows) return console.log('      (se saltea en Windows: el ffmpeg de mentira es un script con shebang)');
  const { r } = await conFfmpegFalso('voz', () => microfono.microfonoListar(CFG_MACBOOK));
  ok(r.ok, r.error);
  eq(r.dispositivos.length, 6);
  eq(r.elegido, 'MacBook Pro Microphone');
  eq(r.usa.indice, 2);
  eq(r.usa.origen, 'elegido');
  // `porDefecto` sale del system_profiler de verdad de esta máquina, así que
  // acá solo se fija que el marcado sea coherente con él.
  r.dispositivos.forEach((d) => eq(d.porDefecto, d.nombre === r.porDefecto));
});

test('la prueba abre el micrófono con EXACTAMENTE el comando del dictado', async function () {
  if (saltarEnWindows || saltarFueraDeMac) return;
  const { r, argv } = await conFfmpegFalso('voz', (prog) => microfono.probarMicrofono({ segundos: 0.6 }, prog, CFG_MACBOOK));
  ok(r.ok, r.error);
  const captura = argv.filter((a) => a.indexOf('-list_devices') === -1);
  eq(captura.length, 1, 'una sola captura');
  eq(JSON.stringify(captura[0]), JSON.stringify(microfono.argsDeCaptura(':2')),
    'si el medidor anda y el dictado no, la prueba mintió: por eso los argumentos son los mismos, hasta el último');
});

test('con voz, la prueba manda unas diez lecturas por segundo y termina en "ok"', async function () {
  if (saltarEnWindows || saltarFueraDeMac) return;
  const { r, niveles, notas } = await conFfmpegFalso('voz', (prog) => microfono.probarMicrofono({ segundos: 1 }, prog, CFG_MACBOOK));
  eq(r.estado, 'ok', r.titulo + ' ' + r.detalle);
  ok(niveles.length >= 5 && niveles.length <= 12, 'lecturas en un segundo: ' + niveles.length);
  const ultima = niveles[niveles.length - 1];
  ok(ultima.dbfs > -25 && ultima.dbfs < -19, 'el nivel de la onda a RMS 0,08 es -22 dBFS: ' + ultima.dbfs);
  eq(ultima.umbralDbfs, -34, 'y la referencia de la compuerta viaja con cada lectura');
  ok(ultima.pasa);
  // Lo que queda en el log, y con qué nivel.
  ok(notas.some((n) => /dispositivos: \[0\] iPhone de Daniel Microphone/.test(n)), 'la lista entera');
  ok(notas.some((n) => /uso «MacBook Pro Microphone» \(índice 2, elegido en ⚙, entrada :2\)/.test(n)), 'cuál y por qué');
  ok(notas.some((n) => /comando: .*-f avfoundation -i :2 -ac 1 -ar 16000 -f s16le pipe:1/.test(n)), 'el comando exacto');
  ok(notas.some((n) => /resumen: .* lecturas · mín .* · máx .* · promedio de lecturas .* · muestras en cero/.test(n)),
    'un resumen de niveles, no las lecturas una por una');
  ok(notas.some((n) => /^INFO Prueba de micrófono · veredicto \(ok\)/.test(n)));
});

test('un micrófono que entrega ceros termina en "silencio digital"', async function () {
  if (saltarEnWindows || saltarFueraDeMac) return;
  const { r, notas } = await conFfmpegFalso('ceros', (prog) => microfono.probarMicrofono({ segundos: 0.6 }, prog, CFG_MACBOOK));
  eq(r.estado, 'silencio-digital');
  eq(r.resumen.cerosPct, 100);
  ok(notas.some((n) => /^ERROR Prueba de micrófono · veredicto \(silencio-digital\)/.test(n)), 'y al log va como error');
});

test('un micrófono que abre y no entrega nada termina en "sin muestras"', async function () {
  if (saltarEnWindows || saltarFueraDeMac) return;
  const { r } = await conFfmpegFalso('nada', (prog) => microfono.probarMicrofono({ segundos: 0.6 }, prog, CFG_MACBOOK));
  eq(r.estado, 'sin-muestras');
  eq(r.resumen.bytes, 0);
});

test('si ffmpeg no abre, la prueba corta enseguida y el stderr va tal cual al log', async function () {
  if (saltarEnWindows || saltarFueraDeMac) return;
  const t0 = Date.now();
  const { r, notas } = await conFfmpegFalso('no-abre', (prog) => microfono.probarMicrofono({ segundos: 5 }, prog, CFG_MACBOOK));
  ok(Date.now() - t0 < 4000, 'no se quedó esperando los cinco segundos: ' + (Date.now() - t0) + ' ms');
  eq(r.estado, 'no-abre');
  has(r.stderr, 'Invalid audio device index', 'el stderr de ffmpeg viaja entero en el resultado');
  ok(notas.some((n) => /stderr de ffmpeg, tal cual:\n[\s\S]*Invalid audio device index/.test(n)), 'y al log, tal cual');
  has(r.detalle, 'Refrescá la lista', 'con el diagnóstico correcto: no es el permiso');
});

test('la línea de EOS Webcam Utility no hace fallar una captura que anda', async function () {
  if (saltarEnWindows || saltarFueraDeMac) return;
  const { r } = await conFfmpegFalso('ruido-cmio', (prog) => microfono.probarMicrofono({ segundos: 0.6 }, prog, CFG_MACBOOK));
  eq(r.estado, 'ok', 'la línea está en stderr y el audio entra igual');
  has(r.stderr, 'CMIOMS', 'pero queda en el log, por si algún día sí importa');
});

test('con el elegido desenchufado, la prueba cae al del sistema y lo deja escrito', async function () {
  if (saltarEnWindows || saltarFueraDeMac) return;
  const { r, notas } = await conFfmpegFalso('voz', (prog) =>
    microfono.probarMicrofono({ segundos: 0.6 }, prog, { microfono: 'Auriculares de Daniel (2)' }));
  eq(r.dispositivo.origen, 'caida');
  eq(r.dispositivo.entrada, ':default');
  ok(notas.some((n) => /^WARN .*«Auriculares de Daniel \(2\)», no está conectado ahora/.test(n)),
    'en el log, como advertencia, con el nombre del que falta');
});

test('la prueba no se pisa con otra prueba', async function () {
  if (saltarEnWindows || saltarFueraDeMac) return;
  await conFfmpegFalso('voz', async (prog) => {
    const una = microfono.probarMicrofono({ segundos: 0.6 }, prog, CFG_MACBOOK);
    await new Promise((r) => setTimeout(r, 150));
    const otra = await microfono.probarMicrofono({ segundos: 0.6 }, prog, CFG_MACBOOK);
    ok(!otra.ok);
    has(otra.error, 'Ya hay una prueba');
    await una;
  });
});

test('fuera de Mac la prueba se rechaza antes de abrir nada, diciendo por qué', async function () {
  if (process.platform === 'darwin') return console.log('      (en Mac no se puede simular otra plataforma: lo cubre el veredicto del dictado)');
  const r = await microfono.probarMicrofono({ segundos: 1 }, null, CFG_MACBOOK);
  ok(!r.ok);
  has(r.error, 'solo para Mac');
});

test('si ffmpeg no está, la lista falla con el arreglo y no con una excepción', async function () {
  const previo = process.env.HYPERPREMIERE_FFMPEG;
  process.env.HYPERPREMIERE_FFMPEG = path.join(os.tmpdir(), 'no-existe-ffmpeg-' + process.pid);
  try {
    const r = await microfono.listarDispositivos();
    ok(!r.ok);
    has(r.error, 'brew install ffmpeg');
  } finally {
    if (previo === undefined) delete process.env.HYPERPREMIERE_FFMPEG; else process.env.HYPERPREMIERE_FFMPEG = previo;
  }
});

// --- 6. El dictado registra qué micrófono usó -------------------------------

test('cada dictado deja en el log el micrófono, su índice y el comando', async function () {
  if (saltarEnWindows || saltarFueraDeMac) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-dictado-mic-'));
  const previos = { modo: process.env.FAKE_WHISPER_MODO, log: process.env.FAKE_WHISPER_LOG, intervalo: process.env.HYPERPREMIERE_DICTADO_INTERVALO_MS };
  process.env.FAKE_WHISPER_MODO = 'ok';
  process.env.FAKE_WHISPER_LOG = path.join(dir, 'eventos.txt');
  try {
    const { r, notas, argv, fases } = await conFfmpegFalso('voz', async (prog) => {
      // La máquina ya sondeada: Whisper de mentira, ffmpeg de mentira. Es el
      // mismo camino de código del dictado real, con el micrófono falso.
      dictado._fijarMaquina({ plataforma: 'darwin', whisper: { style: 'mlx' }, python: FAKE_WORKER, ffmpeg: true });
      const sesion = dictado.dictadoArrancar({ id: 'marcador:Marcador 3' }, prog, CFG_MACBOOK);
      await new Promise((res) => setTimeout(res, 900));
      dictado.dictadoParar({ id: 'marcador:Marcador 3' });
      return sesion;
    });
    ok(r.ok, r.error);
    eq(r.microfono.nombre, 'MacBook Pro Microphone');
    eq(r.microfono.indice, 2);
    ok(notas.some((n) => /Dictado \(marcador:Marcador 3\): micrófono «MacBook Pro Microphone» \(índice 2, elegido en ⚙, entrada :2\)/.test(n)),
      'qué dispositivo, con índice resuelto, identificando el dictado');
    ok(notas.some((n) => /Dictado \(marcador:Marcador 3\): comando .*-i :2 /.test(n)), 'y el comando exacto de ffmpeg');
    ok(notas.some((n) => /s de audio por «MacBook Pro Microphone» \(índice 2\)/.test(n)), 'y al cerrar, otra vez, con lo que entró');
    const captura = argv.filter((a) => a.indexOf('-list_devices') === -1 && a.indexOf('-version') === -1);
    eq(JSON.stringify(captura[0]), JSON.stringify(microfono.argsDeCaptura(':2')), 'y ffmpeg recibió ese comando, no otro');
    // La etapa viaja EXPLÍCITA en el sobre. El panel la necesita para pasar el
    // botón a "■", que es lo único con lo que el editor frena el micrófono:
    // dejársela adivinar del texto de `msg` ata ese control a una palabra en
    // castellano que cualquiera puede reescribir.
    ok(fases.indexOf('preparando') !== -1, 'preparando, antes de abrir nada');
    ok(fases.indexOf('escuchando') !== -1, 'y escuchando, apenas el micrófono está abierto: ' + fases.join(' · '));
    ok(fases.indexOf('escuchando') > fases.indexOf('preparando'), 'en ese orden');
  } finally {
    dictado.bajarMotor('fin del test');
    dictado.olvidarMaquina();
    Object.keys(previos).forEach(function (k) {
      const env = { modo: 'FAKE_WHISPER_MODO', log: 'FAKE_WHISPER_LOG', intervalo: 'HYPERPREMIERE_DICTADO_INTERVALO_MS' }[k];
      if (previos[k] === undefined) delete process.env[env]; else process.env[env] = previos[k];
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mientras hay una prueba de micrófono, el dictado no arranca encima', async function () {
  if (saltarEnWindows || saltarFueraDeMac) return;
  await conFfmpegFalso('voz', async (prog) => {
    const prueba = microfono.probarMicrofono({ segundos: 0.6 }, prog, CFG_MACBOOK);
    await new Promise((r) => setTimeout(r, 150));
    dictado._fijarMaquina({ plataforma: 'darwin', whisper: { style: 'mlx' }, python: FAKE_WORKER, ffmpeg: true });
    const arranque = dictado.dictadoArrancar({ id: 'x' }, prog, CFG_MACBOOK);
    // Si por un error SÍ arrancó, hay que pararlo: un dictado que nadie para
    // escucha cinco minutos, y el test se quedaría colgado en vez de fallar.
    const r = await Promise.race([arranque, new Promise((res) => setTimeout(() => res({ ok: true, colgado: true }), 1500))]);
    if (r.colgado) { dictado.dictadoParar({ id: 'x' }); await arranque.catch(() => {}); }
    // Y si llegó a levantar Whisper, bajarlo: un worker vivo mantiene vivo al
    // proceso del test, y el corredor se queda esperando a que termine.
    dictado.bajarMotor('fin del test');
    dictado.olvidarMaquina();
    await prueba;
    ok(!r.ok, 'el dictado arrancó encima de la prueba: dos ffmpeg sobre el mismo micrófono');
    has(r.error || '', 'prueba de micrófono');
  });
});
