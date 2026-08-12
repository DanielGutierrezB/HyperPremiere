'use strict';

// El botón "Instalar Whisper", probado sin bajar un giga ni tener un Windows.
//
// Lo que se puede probar de verdad acá:
//   - que el panel se da cuenta de que FALTA Whisper (y de que ya lo tiene);
//   - que lo que instalamos nosotros gana sobre el PATH (que adentro de
//     Premiere no es el del editor);
//   - que una descarga cortada o cambiada se RECHAZA en vez de instalarse;
//   - que reintentar después de un corte funciona y retoma donde iba;
//   - que en una plataforma donde no podemos instalar, queda el camino a mano.
//
// Lo que NO se prueba acá (y no se puede sin esas máquinas): la descarga real
// de 1,3 GB, el 7z de Windows y la instalación por pip.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { test, ok, eq, has } = require('./harness');
const { run } = require('../bridge/exec');

const HOME_ENV = 'HYPERPREMIERE_WHISPER_HOME';
const BIN_ENV = 'HYPERPREMIERE_WHISPER_BIN';

// Cada test corre con una "carpeta de instalación" propia y descartable, así
// nada toca el ~/.hyperpremiere del que corre los tests.
function conCasaLimpia(fn) {
  return async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-whisper-home-'));
    const prev = process.env[HOME_ENV];
    process.env[HOME_ENV] = dir;
    // Los módulos leen la carpeta en cada llamada (no al requerirse), pero el
    // cache de require es global: se limpian para que cada test parta de cero.
    for (const k of Object.keys(require.cache)) {
      if (k.indexOf('whisper-home') !== -1 || k.indexOf('transcribe.js') !== -1 || k.indexOf('whisper-install') !== -1) {
        delete require.cache[k];
      }
    }
    try {
      await fn(dir);
    } finally {
      if (prev === undefined) delete process.env[HOME_ENV]; else process.env[HOME_ENV] = prev;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
  };
}

/** Un "ejecutable" de mentira que solo tiene que existir en el disco. */
function fakeBin(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/sh\necho fake\n', { mode: 0o755 });
  return p;
}

// ── Detección ───────────────────────────────────────────────────────────

test('sin Whisper instalado, el panel lo dice (y ofrece instalarlo)', conCasaLimpia(async function () {
  const prev = process.env[BIN_ENV];
  process.env[BIN_ENV] = 'hp-whisper-que-no-existe';
  try {
    const { whisperStatus } = require('../bridge/transcribe');
    const st = await whisperStatus();
    eq(st.available, false, 'no hay Whisper');
    eq(st.tool, '', 'y no inventa ninguna herramienta');
    ok(st.recommend.length > 0, 'queda el texto del camino a mano');
  } finally {
    if (prev === undefined) delete process.env[BIN_ENV]; else process.env[BIN_ENV] = prev;
  }
}));

test('lo que instaló el panel se usa por su ruta, sin depender del PATH', conCasaLimpia(async function (home) {
  const { writeInstalled, readInstalled } = require('../bridge/store/whisper-home');
  const bin = fakeBin(path.join(home, 'venv', 'bin'), 'mlx_whisper');
  writeInstalled({ bin: 'mlx_whisper', path: bin, style: 'mlx', fast: true, verified: '--help' });
  ok(readInstalled(), 'el registro se lee');

  const { detectWhisper, whisperStatus } = require('../bridge/transcribe');
  const tool = await detectWhisper();
  ok(tool, 'lo encuentra');
  eq(tool.path, bin, 'y lo va a ejecutar por su ruta absoluta, no por el PATH');
  eq(tool.style, 'mlx', 'con los flags que le corresponden a esa herramienta');
  const st = await whisperStatus();
  eq(st.available, true, 'el panel lo muestra como disponible');
  eq(st.managed, true, 'y sabe que lo instaló él');
}));

test('si el editor borra la carpeta a mano, el registro deja de valer', conCasaLimpia(async function (home) {
  const { writeInstalled, readInstalled } = require('../bridge/store/whisper-home');
  const bin = fakeBin(path.join(home, 'tool'), 'faster-whisper-xxl.exe');
  writeInstalled({ bin: 'faster-whisper-xxl', path: bin });
  fs.rmSync(path.join(home, 'tool'), { recursive: true, force: true });
  eq(readInstalled(), null, 'no apunta a un ejecutable fantasma');
}));

// ── Plan por plataforma ─────────────────────────────────────────────────

test('cada plataforma va por el camino que menos le pide al editor', conCasaLimpia(async function () {
  const { _planFor } = require('../bridge/whisper-install');

  const win = _planFor({ platform: 'win32', arch: 'x64' });
  eq(win.supported, true, 'Windows se puede');
  eq(win.method, 'fwxxl', 'con el ejecutable suelto (sin Python)');
  ok(win.downloadMB > 500, 'y avisa que son cientos de MB: ' + win.downloadMB);

  const mac = _planFor({ platform: 'darwin', arch: 'arm64', python: '/usr/bin/python3' });
  eq(mac.method, 'pip-venv', 'en Apple Silicon, entorno propio de Python');
  eq(mac.bin, 'mlx_whisper', 'con mlx (usa la GPU de Apple)');

  const intel = _planFor({ platform: 'darwin', arch: 'x64', python: '/usr/bin/python3' });
  eq(intel.bin, 'whisper-ctranslate2', 'en Mac Intel, mlx no corre: va faster-whisper por pip');
}));

test('donde no se puede instalar solo, queda el camino a mano', conCasaLimpia(async function () {
  const { _planFor } = require('../bridge/whisper-install');

  const raro = _planFor({ platform: 'freebsd', arch: 'x64' });
  eq(raro.supported, false, 'plataforma que no sabemos manejar');
  ok(raro.reason.length > 0, 'y explica por qué');
  ok(raro.manual.length > 0, 'sin dejar al editor sin salida');

  const sinPython = _planFor({ platform: 'darwin', arch: 'x64', python: '' });
  eq(sinPython.supported, false, 'un Mac sin Python 3 tampoco');
  has(sinPython.reason, 'Python 3', 'y el motivo es entendible');
  ok(sinPython.manual.length > 0, 'con las instrucciones a mano');
}));

test('del release de Windows se elige la versión más nueva', conCasaLimpia(async function () {
  const { _versionRank } = require('../bridge/whisper-install');
  ok(_versionRank('Faster-Whisper-XXL_r245.4_windows.7z') > _versionRank('Faster-Whisper-XXL_r245.1_windows.7z'),
    'r245.4 gana a r245.1');
  ok(_versionRank('Faster-Whisper-XXL_r245.1_windows.7z') > _versionRank('Faster-Whisper-XXL_r192.3.4_windows.7z'),
    'r245.1 gana a r192.3.4');
}));

// ── De dónde se baja ────────────────────────────────────────────────────

test('solo se baja por HTTPS y desde GitHub', conCasaLimpia(async function () {
  const { _assertAllowedUrl } = require('../bridge/whisper-install');
  ok(_assertAllowedUrl('https://github.com/Purfview/whisper-standalone-win/releases/download/x/y.7z'), 'GitHub sí');
  ok(_assertAllowedUrl('https://objects.githubusercontent.com/algo'), 'y el host al que redirige');
  for (const mala of [
    'http://github.com/Purfview/x.7z',            // sin cifrar
    'https://github.evil.com/x.7z',               // parece GitHub y no lo es
    'https://mirror-rapido.example/x.7z',         // cualquier otro host
  ]) {
    let tiro = false;
    try { _assertAllowedUrl(mala); } catch (e) { tiro = true; }
    ok(tiro, 'se rechaza ' + mala);
  }
}));

// ── Descarga: verificación, corte y reintento ───────────────────────────

// Servidor local que hace de GitHub. `plan` describe qué hacer con cada pedido:
// entregar todo, cortar a la mitad, o devolver un archivo distinto.
function servidor(cuerpo, guion) {
  const pedidos = [];
  const srv = http.createServer((req, res) => {
    const modo = guion.shift() || 'ok';
    const range = /bytes=(\d+)-/.exec(req.headers.range || '');
    const desde = range ? parseInt(range[1], 10) : 0;
    pedidos.push({ modo: modo, desde: desde });
    if (modo === 'corta') {
      // Empieza a mandar y se corta: el caso de la conexión que se cae a mitad
      // de camino. Se espera a que el pedazo SALGA de verdad (si se destruye el
      // socket antes, el cliente no recibe nada y no hay nada que retomar).
      res.writeHead(200, { 'content-length': String(cuerpo.length) });
      res.write(cuerpo.slice(0, Math.floor(cuerpo.length / 3)), () => {
        setTimeout(() => res.destroy(), 30);
      });
      return;
    }
    if (modo === 'otro') {
      const falso = Buffer.from('esto no es lo que pediste');
      res.writeHead(200, { 'content-length': String(falso.length) });
      res.end(falso);
      return;
    }
    if (desde > 0) {
      res.writeHead(206, {
        'content-length': String(cuerpo.length - desde),
        'content-range': 'bytes ' + desde + '-' + (cuerpo.length - 1) + '/' + cuerpo.length,
      });
      res.end(cuerpo.slice(desde));
      return;
    }
    res.writeHead(200, { 'content-length': String(cuerpo.length) });
    res.end(cuerpo);
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      url: 'http://127.0.0.1:' + srv.address().port + '/paquete.7z',
      pedidos: pedidos,
      cerrar: () => new Promise((r) => srv.close(r)),
    }));
  });
}

// El servidor de mentira habla http, así que se le pasa un control propio; el
// control de verdad (HTTPS + host de GitHub) tiene su test aparte, arriba.
const sinControlDeHost = (u) => new URL(u);

test('un archivo incompleto o cambiado se rechaza y no se instala', conCasaLimpia(async function (home) {
  const { _downloadTo } = require('../bridge/whisper-install');
  const cuerpo = Buffer.alloc(64 * 1024, 7);
  const s = await servidor(cuerpo, ['otro']);
  const dest = path.join(home, 'descarga', 'paquete.7z');
  try {
    let error = '';
    try {
      await _downloadTo(s.url, dest, { expectedBytes: cuerpo.length, check: sinControlDeHost });
    } catch (e) { error = e.message; }
    has(error, 'incompleto o cambiado', 'se aborta con un motivo claro');
    ok(!fs.existsSync(dest), 'y NO queda un archivo que parezca bueno');
  } finally { await s.cerrar(); }
}));

test('si la firma que publica GitHub no coincide, se descarta', conCasaLimpia(async function (home) {
  const { _downloadTo } = require('../bridge/whisper-install');
  const cuerpo = Buffer.alloc(4096, 3);
  const s = await servidor(cuerpo, ['ok']);
  const dest = path.join(home, 'descarga', 'paquete.7z');
  try {
    let error = '';
    try {
      await _downloadTo(s.url, dest, {
        expectedBytes: cuerpo.length, check: sinControlDeHost,
        sha256: '0'.repeat(64),
      });
    } catch (e) { error = e.message; }
    has(error, 'no coincide con la firma', 'se rechaza por seguridad');
    ok(!fs.existsSync(dest), 'sin dejar el archivo');
    ok(!fs.existsSync(dest + '.part'), 'ni el pedazo que se venía bajando');
  } finally { await s.cerrar(); }
}));

test('si se corta la descarga, apretar de nuevo retoma donde iba', conCasaLimpia(async function (home) {
  const { _downloadTo } = require('../bridge/whisper-install');
  const cuerpo = Buffer.alloc(300 * 1024, 9);
  const s = await servidor(cuerpo, ['corta', 'ok']);
  const dest = path.join(home, 'descarga', 'paquete.7z');
  try {
    let error = '';
    try {
      await _downloadTo(s.url, dest, { expectedBytes: cuerpo.length, check: sinControlDeHost });
    } catch (e) { error = e.message; }
    ok(error, 'el primer intento falla, como en la vida real');
    ok(fs.existsSync(dest + '.part'), 'pero lo bajado queda guardado');

    const r = await _downloadTo(s.url, dest, { expectedBytes: cuerpo.length, check: sinControlDeHost });
    eq(r, dest, 'el segundo intento termina bien');
    eq(fs.statSync(dest).size, cuerpo.length, 'con el archivo entero');
    ok(fs.readFileSync(dest).equals(cuerpo), 'y byte a byte igual al original');
    ok(s.pedidos[1].desde > 0, 'pidió solo el resto (' + s.pedidos[1].desde + ' bytes ya los tenía)');
    ok(!fs.existsSync(dest + '.part'), 'sin dejar restos');
  } finally { await s.cerrar(); }
}));

test('un pedazo de OTRA descarga no se reusa: se baja de nuevo', conCasaLimpia(async function (home) {
  const { _downloadTo } = require('../bridge/whisper-install');
  const cuerpo = Buffer.alloc(20 * 1024, 5);
  const s = await servidor(cuerpo, ['ok']);
  const dest = path.join(home, 'descarga', 'paquete.7z');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest + '.part', Buffer.alloc(9000, 1));
  fs.writeFileSync(dest + '.part.json', JSON.stringify({ url: 'https://otra/cosa.7z', total: 99 }));
  try {
    await _downloadTo(s.url, dest, { expectedBytes: cuerpo.length, check: sinControlDeHost });
    eq(s.pedidos[0].desde, 0, 'arrancó de cero en vez de pegar el pedazo ajeno');
    ok(fs.readFileSync(dest).equals(cuerpo), 'y el archivo es el correcto');
  } finally { await s.cerrar(); }
}));

// ── Lo que se descomprime tiene que traer lo esperado ───────────────────

test('se exige la estructura esperada adentro del paquete', conCasaLimpia(async function (home) {
  const { _findFile } = require('../bridge/whisper-install');
  const raiz = path.join(home, 'extract');
  fakeBin(path.join(raiz, 'Faster-Whisper-XXL'), 'faster-whisper-xxl.exe');
  const encontrado = _findFile(raiz, 'faster-whisper-xxl.exe', 4);
  ok(encontrado, 'lo encuentra aunque venga en una subcarpeta');
  eq(path.basename(encontrado), 'faster-whisper-xxl.exe', 'y es el ejecutable que buscábamos');

  const vacio = path.join(home, 'extract-malo');
  fakeBin(vacio, 'leeme.txt');
  eq(_findFile(vacio, 'faster-whisper-xxl.exe', 4), '', 'un paquete que no lo trae se detecta');
}));

test('un paquete de verdad se descomprime y se le encuentra el ejecutable', conCasaLimpia(async function (home) {
  const { _extractArchive, _findFile } = require('../bridge/whisper-install');
  // El paquete real es un .7z, que acá no se puede armar sin herramientas
  // extra; lo que se prueba es la MECÁNICA (descomprimir de verdad con el tar
  // del sistema y exigir la estructura), con un .tar que sí se puede armar
  // en cualquier máquina. El `tar` de Windows 10/11 es el mismo libarchive.
  const src = path.join(home, 'src', 'Faster-Whisper-XXL');
  fakeBin(src, 'faster-whisper-xxl.exe');
  fs.writeFileSync(path.join(src, 'libreria-al-lado.dll'), Buffer.alloc(2048, 1));
  const archivo = path.join(home, 'paquete.tar');
  const armado = await run('tar', ['-cf', archivo, '-C', path.join(home, 'src'), 'Faster-Whisper-XXL'], { timeoutMs: 30_000 });
  if (armado.code !== 0) return console.log('      (se saltea: no hay tar en esta máquina)');

  const destino = path.join(home, 'extract');
  const usado = await _extractArchive(archivo, destino);
  ok(usado, 'se descomprimió con ' + usado);
  const exe = _findFile(destino, 'faster-whisper-xxl.exe', 4);
  ok(exe, 'y adentro está el ejecutable que esperábamos');
  ok(fs.existsSync(path.join(path.dirname(exe), 'libreria-al-lado.dll')),
    'con sus librerías al lado (por eso se mueve la carpeta entera, no el .exe solo)');
}));

test('descomprimir algo que no es un archivo válido falla con instrucciones', conCasaLimpia(async function (home) {
  const { _extractArchive } = require('../bridge/whisper-install');
  const basura = path.join(home, 'roto.7z');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(basura, 'no soy un 7z');
  let error = '';
  try { await _extractArchive(basura, path.join(home, 'extract')); } catch (e) { error = e.message; }
  has(error, 'No pude descomprimir', 'se rinde con un motivo');
  has(error, basura, 'y le dice al editor dónde quedó lo que ya bajó');
}));

// ── La prueba final (que la herramienta CORRA) ─────────────────────────

test('el audio de prueba es un WAV de 1 segundo, mono 16 kHz', conCasaLimpia(async function (home) {
  const { _writeTestWav } = require('../bridge/whisper-install');
  fs.mkdirSync(home, { recursive: true });
  const wav = _writeTestWav(path.join(home, 'prueba.wav'));
  const b = fs.readFileSync(wav);
  eq(b.slice(0, 4).toString(), 'RIFF', 'es un WAV');
  eq(b.readUInt16LE(22), 1, 'mono');
  eq(b.readUInt32LE(24), 16000, '16 kHz (lo que Whisper espera)');
  eq(b.length, 44 + 16000 * 2, 'un segundo exacto');
}));

test('la prueba final usa el modelo más chico, no el de 3 GB', conCasaLimpia(async function () {
  const { _smokeArgs } = require('../bridge/whisper-install');
  const mlx = _smokeArgs('mlx_whisper', 'a.wav', '/tmp/x');
  has(mlx.join(' '), 'whisper-tiny', 'mlx pide el repo del modelo tiny');
  ok(mlx.indexOf('--output-dir') !== -1, 'con los flags con guion que usa mlx');
  const fw = _smokeArgs('faster-whisper-xxl', 'a.wav', '/tmp/x');
  eq(fw[fw.indexOf('--model') + 1], 'tiny', 'el standalone también');
  ok(fw.indexOf('--beep_off') !== -1, 'y sin el beep, que adentro de Premiere sobra');
}));
