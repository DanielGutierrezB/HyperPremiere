'use strict';

// Instalar Whisper local desde el panel, sin terminal.
//
// Antes, un editor sin Whisper leía un tooltip que le pedía bajar un .7z de
// GitHub, descomprimirlo y "dejar la carpeta en el PATH". Para alguien que no
// programa eso es un muro; y encima el PATH que ve el panel NO es el del
// editor (Premiere arranca con un entorno recortado), así que el consejo
// fallaba incluso siguiéndolo al pie de la letra.
//
// Acá está el camino automático. Dos caminos, uno por plataforma, elegidos por
// "el que menos le pide al editor":
//
//   Windows → Faster-Whisper-XXL, el standalone de Purfview. Es un ejecutable
//     suelto con las librerías adentro: no necesita Python ni pelearse con
//     CUDA. Se baja del release de GitHub y se descomprime en NUESTRA carpeta.
//   Mac / Linux → un entorno virtual de Python propio (~/.hyperpremiere/whisper/venv)
//     con `mlx-whisper` en Apple Silicon (GPU de Apple, lo más rápido) o
//     `whisper-ctranslate2` en el resto. El venv es propio a propósito: no
//     tocamos el Python del editor ni dependemos de que su pip esté en el PATH.
//
// Tres reglas que valen para los dos caminos:
//   1. Se avisa CUÁNTO va a bajar y se pide confirmación antes de empezar (son
//      cientos de MB; en Windows, más de un giga).
//   2. Lo que se baja se verifica: HTTPS contra hosts de GitHub, tamaño exacto
//      del asset, digest si el release publica uno, y que el archivo
//      descomprima a la estructura esperada.
//   3. Recién se anota como "instalado" DESPUÉS de correr la herramienta. Que
//      el archivo exista no prueba nada.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const { run } = require('./exec');
const { hpFetch } = require('./providers/http');
const { whisperHome, writeInstalled, forgetInstalled, wipeSub } = require('./store/whisper-home');
const { detectWhisper, TOOLS, FWXXL_URL } = require('./transcribe');

const IS_WIN = process.platform === 'win32';
const UA = 'HyperPremiere';

// ── De dónde se baja el standalone de Windows ───────────────────────────
const GH_RELEASE_API = 'https://api.github.com/repos/Purfview/whisper-standalone-win/releases/tags/Faster-Whisper-XXL';
// Respaldo si la API de GitHub no contesta (sin red no se instala igual, pero
// una API caída no tiene por qué dejar al editor sin número que mirar).
const FWXXL_PINNED = {
  name: 'Faster-Whisper-XXL_r245.4_windows.7z',
  version: 'r245.4',
  bytes: 1424256246,
  sha256: '',
  url: 'https://github.com/Purfview/whisper-standalone-win/releases/download/Faster-Whisper-XXL/Faster-Whisper-XXL_r245.4_windows.7z',
};
// Los redirects de una descarga de GitHub terminan en githubusercontent.com.
// Cualquier otro host = algo se metió en el medio: se aborta.
const ALLOWED_HOSTS = ['github.com', 'api.github.com', 'codeload.github.com'];

// Ejecutable que TIENE que aparecer al descomprimir. Si no está, el paquete no
// es el que esperábamos y no se instala nada.
const FWXXL_EXE = 'faster-whisper-xxl.exe';

// Modelo mínimo para la prueba final (bajar el modelo real son varios GB y se
// baja solo la primera vez que el editor transcribe de verdad).
const SMOKE_MODEL = { mlx: 'mlx-community/whisper-tiny', other: 'tiny' };

// Instalación en curso: para poder cancelar desde el panel.
let cancelled = false;
let currentReq = null;
let currentChild = null;

function cancelWhisperInstall() {
  cancelled = true;
  if (currentReq) { try { currentReq.destroy(new Error('cancelado')); } catch (e) {} }
  if (currentChild) { try { currentChild.kill(); } catch (e) {} }
  return { ok: true };
}

function abortIfCancelled() {
  if (cancelled) throw new Error('Instalación cancelada.');
}

// ── Red: descarga verificada y reanudable ───────────────────────────────

/**
 * La URL tiene que ser HTTPS y de un host de GitHub. Es la única defensa que
 * podemos ofrecer sobre un binario de terceros: que venga de donde decimos y
 * por un canal cifrado. Se aplica a CADA salto del redirect, no solo al primero.
 */
function assertAllowedUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { throw new Error('URL de descarga inválida: ' + raw); }
  if (u.protocol !== 'https:') {
    throw new Error('La descarga tiene que ir por HTTPS y esta va por ' + u.protocol + ' — se aborta: ' + raw);
  }
  const host = String(u.hostname || '').toLowerCase();
  const ok = ALLOWED_HOSTS.indexOf(host) !== -1 || /(^|\.)githubusercontent\.com$/.test(host);
  if (!ok) throw new Error('La descarga apunta a un host inesperado (' + host + ') — se aborta.');
  return u;
}

// Abre el stream de respuesta siguiendo redirects, validando cada salto.
function openStream(rawUrl, opts, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const check = opts.check || assertAllowedUrl;
    let u;
    try { u = check(rawUrl) || new URL(rawUrl); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get({
      hostname: u.hostname,
      port: u.port || undefined,
      path: (u.pathname || '/') + (u.search || ''),
      headers: Object.assign({ 'user-agent': UA, accept: '*/*' }, opts.headers || {}),
    }, (res) => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, u).href; } catch (e) { return reject(new Error('redirect inválido')); }
        return resolve(openStream(next, opts, redirectsLeft - 1));
      }
      resolve({ res: res, url: u.href });
    });
    currentReq = req;
    // Watchdog de conexión muerta: sin esto, una descarga cortada por la red
    // queda colgada para siempre y el panel parece trabado.
    req.setTimeout(opts.stallMs || 90_000, () => {
      req.destroy(new Error('la conexión se quedó sin respuesta'));
    });
    req.on('error', (e) => reject(new Error('error de red: ' + ((e && e.message) || e))));
  });
}

function pipeToFile(res, part, append, startAt, total, onProgress) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
    let got = startAt;
    let lastTick = 0;
    let settled = false;
    function done(err) {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(got);
    }
    res.on('data', (c) => {
      got += c.length;
      const now = Date.now();
      if (onProgress && now - lastTick > 400) { lastTick = now; onProgress(got, total); }
    });
    res.on('error', (e) => { try { ws.destroy(); } catch (e2) {} done(new Error('se cortó la descarga: ' + ((e && e.message) || e))); });
    ws.on('error', (e) => done(new Error('no pude escribir el archivo: ' + ((e && e.message) || e))));
    ws.on('close', () => { if (onProgress) onProgress(got, total); done(null); });
    res.pipe(ws);
  });
}

/**
 * Baja `url` a `dest`, con reanudación y verificación.
 *
 * Se escribe en `<dest>.part` con un `<dest>.part.json` al lado que dice de qué
 * URL y de qué tamaño es ese pedazo. Si el editor vuelve a apretar el botón
 * después de un corte, se pide el resto con Range en vez de bajar un giga otra
 * vez; si el sidecar no coincide (otra versión, otra URL), el pedazo se tira.
 * El archivo final solo aparece cuando el tamaño (y el digest, si lo hay)
 * coinciden: nunca queda un `dest` a medias que parezca bueno.
 *
 * opts: { expectedBytes, sha256, onProgress(got,total), check, stallMs }
 */
async function downloadTo(url, dest, opts) {
  opts = opts || {};
  const part = dest + '.part';
  const meta = part + '.json';
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let have = 0;
  if (!opts._noResume) {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch (e) {}
    const sameSource = prev && prev.url === url && (!opts.expectedBytes || prev.total === opts.expectedBytes);
    if (sameSource) { try { have = fs.statSync(part).size; } catch (e) { have = 0; } }
  }
  if (!have) {
    try { fs.rmSync(part, { force: true }); } catch (e) {}
    try { fs.rmSync(meta, { force: true }); } catch (e) {}
  }
  // Un pedazo MÁS GRANDE que el archivo entero no es un pedazo: es basura.
  if (opts.expectedBytes && have > opts.expectedBytes) {
    try { fs.rmSync(part, { force: true }); } catch (e) {}
    have = 0;
  }

  const complete = opts.expectedBytes && have === opts.expectedBytes;
  if (!complete) {
    const headers = {};
    if (have > 0) headers.range = 'bytes=' + have + '-';
    const { res } = await openStream(url, { headers: headers, check: opts.check, stallMs: opts.stallMs }, 5);
    const status = res.statusCode;
    if (status === 416) {
      // El servidor no acepta ese rango: el pedazo que teníamos no sirve.
      res.resume();
      try { fs.rmSync(part, { force: true }); } catch (e) {}
      try { fs.rmSync(meta, { force: true }); } catch (e) {}
      return downloadTo(url, dest, Object.assign({}, opts, { _noResume: true }));
    }
    if (status !== 200 && status !== 206) {
      res.resume();
      throw new Error('La descarga respondió HTTP ' + status + ' — se aborta.');
    }
    const append = status === 206;
    if (!append) have = 0;
    const len = Number(res.headers['content-length']) || 0;
    const total = opts.expectedBytes || (have + len) || 0;
    try { fs.writeFileSync(meta, JSON.stringify({ url: url, total: total }), 'utf8'); } catch (e) {}
    await pipeToFile(res, part, append, have, total, opts.onProgress);
    currentReq = null;
  }

  let size = 0;
  try { size = fs.statSync(part).size; } catch (e) {}
  if (opts.expectedBytes && size !== opts.expectedBytes) {
    throw new Error('El archivo bajó incompleto o cambiado: ' + size + ' bytes en vez de ' +
      opts.expectedBytes + '. Volvé a apretar el botón (retoma desde donde iba).');
  }
  if (opts.sha256) {
    const got = await sha256File(part);
    if (got.toLowerCase() !== String(opts.sha256).toLowerCase()) {
      try { fs.rmSync(part, { force: true }); } catch (e) {}
      try { fs.rmSync(meta, { force: true }); } catch (e) {}
      throw new Error('El archivo bajado no coincide con la firma que publica GitHub — se descarta por seguridad.');
    }
  }
  try { fs.rmSync(dest, { force: true }); } catch (e) {}
  fs.renameSync(part, dest);
  try { fs.rmSync(meta, { force: true }); } catch (e) {}
  return dest;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('data', (c) => h.update(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

// ── Qué se puede instalar en ESTA máquina ───────────────────────────────

const MANUAL_MAC_ARM = 'A mano, desde la Terminal: `pip3 install mlx-whisper`.';
const MANUAL_PIP = 'A mano, desde la terminal: `pip3 install whisper-ctranslate2` (necesita Python 3).';
const MANUAL_WIN = 'A mano: bajá Faster-Whisper-XXL de ' + FWXXL_URL +
  ', descomprimilo con 7-Zip y dejá esa carpeta en el PATH.';

/**
 * Decide el camino para un entorno dado. Pura a propósito: así se puede probar
 * "Mac Intel sin Python" o "FreeBSD" sin tener esas máquinas.
 *
 * env = { platform, arch, python, asset }
 *   python → ruta al Python del sistema, o null/'' si no hay.
 *   asset  → { name, version, url, bytes, sha256 } del release de Windows.
 */
function planFor(env) {
  env = env || {};
  const home = whisperHome();
  const base = { ok: true, targetDir: home, alreadyInstalled: false, supported: false, method: '', reason: '', manual: '' };

  if (env.platform === 'win32') {
    const asset = env.asset || FWXXL_PINNED;
    return Object.assign(base, {
      supported: true,
      method: 'fwxxl',
      bin: 'faster-whisper-xxl',
      label: 'Faster-Whisper-XXL ' + (asset.version || ''),
      version: asset.version || '',
      url: asset.url,
      bytes: asset.bytes || 0,
      sha256: asset.sha256 || '',
      downloadMB: Math.round((asset.bytes || 0) / 1048576),
      exact: !!env.asset,
      manual: MANUAL_WIN,
      why: 'Es un ejecutable suelto con todo adentro: no necesita Python ni instalar CUDA, ' +
        'y usa la placa NVIDIA sola si la hay.',
    });
  }

  const mac = env.platform === 'darwin';
  const linux = env.platform === 'linux';
  if (!mac && !linux) {
    return Object.assign(base, {
      reason: 'No sé instalar Whisper automáticamente en este sistema (' + env.platform + ').',
      manual: MANUAL_PIP,
    });
  }

  const arm = mac && env.arch === 'arm64';
  const pkg = arm ? 'mlx-whisper' : 'whisper-ctranslate2';
  const bin = arm ? 'mlx_whisper' : 'whisper-ctranslate2';
  const manual = arm ? MANUAL_MAC_ARM : MANUAL_PIP;
  if (!env.python) {
    return Object.assign(base, {
      reason: 'No encontré Python 3 en este equipo, y en ' + (mac ? 'Mac' : 'Linux') +
        ' Whisper se instala con Python. Instalalo (en Mac: `brew install python`, o desde python.org) y volvé a probar.',
      manual: manual,
    });
  }
  return Object.assign(base, {
    supported: true,
    method: 'pip-venv',
    pkg: pkg,
    bin: bin,
    python: env.python,
    label: pkg,
    // pip no dice de antemano cuánto pesa el árbol de dependencias; el número
    // es el medido en una instalación limpia y se marca como aproximado.
    downloadMB: arm ? 260 : 220,
    exact: false,
    manual: manual,
    why: arm
      ? 'Usa la GPU de tu Mac (Apple Silicon): es el Whisper más rápido en esta máquina.'
      : 'mlx solo corre en Apple Silicon; acá el más rápido es faster-whisper por pip.',
  });
}

/** Dónde está el Python del sistema (para armar nuestro venv). '' si no hay. */
async function findPython() {
  const candidates = IS_WIN ? ['python', 'py'] : ['python3', 'python'];
  for (const c of candidates) {
    const r = IS_WIN
      ? await run('where', [c], { timeoutMs: 10_000, shell: true })
      : await run('which', [c], { timeoutMs: 8_000 });
    const line = r.code === 0 ? (r.out.trim().split(/\r?\n/)[0] || '').trim() : '';
    if (line) {
      // `python` puede ser el 2.x viejo de un Mac antiguo: pedirle la versión.
      const v = await run(line, ['--version'], { timeoutMs: 15_000 });
      if (/Python 3\./.test(v.out + v.err)) return line;
    }
  }
  return '';
}

/** El asset de Windows que corresponde bajar (el más nuevo del release). */
async function resolveWindowsAsset() {
  try {
    const res = await hpFetch(GH_RELEASE_API, { headers: { 'user-agent': UA, accept: 'application/vnd.github+json' } });
    if (!res.ok) return null;
    const rel = await res.json();
    const wins = (rel.assets || []).filter((a) => /_windows\.(7z|zip)$/i.test(a.name || ''));
    if (!wins.length) return null;
    wins.sort((a, b) => versionRank(b.name) - versionRank(a.name));
    const a = wins[0];
    assertAllowedUrl(a.browser_download_url);
    const digest = String(a.digest || '');
    return {
      name: a.name,
      version: (a.name.match(/_r([\d.]+)_/) || [])[1] ? 'r' + a.name.match(/_r([\d.]+)_/)[1] : '',
      url: a.browser_download_url,
      bytes: Number(a.size) || 0,
      sha256: digest.indexOf('sha256:') === 0 ? digest.slice(7) : '',
    };
  } catch (e) {
    return null;
  }
}

// "Faster-Whisper-XXL_r245.4_windows.7z" → 245.004 (para ordenar r245.4 > r245.1 > r192.3.4).
function versionRank(name) {
  const m = String(name).match(/_r([\d.]+)_/);
  if (!m) return 0;
  const parts = m[1].split('.').map((n) => parseInt(n, 10) || 0);
  return (parts[0] || 0) * 1e6 + (parts[1] || 0) * 1e3 + (parts[2] || 0);
}

/**
 * Qué pasaría si el editor apretara el botón: qué se instala, cuánto baja y
 * dónde. El panel lo muestra ANTES de arrancar y pide confirmación.
 *
 * `body.offline` = no salgas a la red. Lo usa el arranque del panel (que solo
 * necesita saber si el botón aplica) para no colgar el badge esperando a
 * GitHub; el número que muestra entonces es el de la versión fijada. Al
 * apretar el botón se pide el plan completo, con el tamaño exacto de HOY.
 */
async function whisperInstallPlan(body) {
  const offline = !!(body && body.offline);
  const already = await detectWhisper();
  if (already) {
    // Ya hay Whisper: no hace falta averiguar cómo se instalaría (y un "no
    // encontré Python" acá sería un motivo falso para algo que no se va a hacer).
    return {
      ok: true, alreadyInstalled: true, supported: false, method: '', reason: '', manual: '',
      targetDir: whisperHome(), tool: already.bin, path: already.path,
    };
  }
  const env = { platform: process.platform, arch: process.arch };
  if (process.platform === 'win32') env.asset = offline ? null : await resolveWindowsAsset();
  else env.python = await findPython();
  return planFor(env);
}

// ── Instalación ─────────────────────────────────────────────────────────

function mb(bytes) { return (bytes / 1048576).toFixed(0); }

async function installFwxxl(plan, report) {
  const home = whisperHome();
  const dlDir = path.join(home, 'descarga');
  const archive = path.join(dlDir, plan.url.split('/').pop());
  const totalMB = plan.downloadMB || mb(plan.bytes);

  report({ pct: 2, msg: 'Bajando ' + plan.label + ' (' + totalMB + ' MB)…' });
  await downloadTo(plan.url, archive, {
    expectedBytes: plan.bytes,
    sha256: plan.sha256,
    onProgress: (got, total) => {
      if (cancelled) return;
      const pctDl = total ? Math.round((got / total) * 100) : 0;
      report({
        pct: 2 + Math.round(pctDl * 0.68),
        msg: 'Bajando ' + plan.label + '… ' + mb(got) + ' / ' + (total ? mb(total) : '?') + ' MB (' + pctDl + '%)',
      });
    },
  });
  abortIfCancelled();

  report({ pct: 72, msg: 'Descomprimiendo (tarda unos minutos, es más de un giga)…' });
  wipeSub('extract');
  const extractDir = path.join(home, 'extract');
  const usado = await extractArchive(archive, extractDir);
  abortIfCancelled();

  report({ pct: 88, msg: 'Revisando que el paquete traiga lo que tiene que traer…' });
  const exe = findFile(extractDir, FWXXL_EXE, 4);
  if (!exe) {
    throw new Error('El archivo se bajó y se descomprimió, pero adentro no está ' + FWXXL_EXE +
      ': no es el paquete que esperábamos. No instalo nada.');
  }
  // El .exe usa las librerías que tiene al lado: se mueve su carpeta entera.
  wipeSub('tool');
  const toolDir = path.join(home, 'tool');
  fs.renameSync(path.dirname(exe), toolDir);
  wipeSub('extract');
  return {
    bin: 'faster-whisper-xxl',
    path: path.join(toolDir, path.basename(exe)),
    version: plan.version || '',
    method: 'fwxxl',
    archive: archive,
    extractedWith: usado,
  };
}

async function installPip(plan, report) {
  const home = whisperHome();
  const venv = path.join(home, 'venv');
  // Un venv a medio armar de un intento anterior es la causa clásica de
  // "reintenté y sigue fallando": se tira y se hace de nuevo.
  wipeSub('venv');
  report({ pct: 5, msg: 'Armando un entorno de Python propio (no toca el tuyo)…' });
  const mk = await run(plan.python, ['-m', 'venv', venv], {
    timeoutMs: 300_000, onSpawn: (c) => { currentChild = c; },
  });
  currentChild = null;
  abortIfCancelled();
  const py = path.join(venv, IS_WIN ? 'Scripts' : 'bin', IS_WIN ? 'python.exe' : 'python');
  if (mk.code !== 0 || !fs.existsSync(py)) {
    throw new Error('No pude crear el entorno de Python: ' + ((mk.err || mk.out) || '').slice(-300));
  }

  report({ pct: 12, msg: 'Instalando ' + plan.pkg + ' (~' + plan.downloadMB + ' MB)…' });
  // pip imprime "Downloading algo.whl (123.4 MB)" y después una barra con el
  // avance de ESA rueda, y baja varias a la vez: si se reporta cada línea tal
  // cual, el contador salta para atrás y parece que se rompió. Se acumula lo ya
  // bajado y el número nunca retrocede.
  let doneMB = 0;
  let currentMB = 0;
  let shownMB = 0;
  let lastTick = 0;
  const r = await run(py, ['-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', plan.pkg], {
    timeoutMs: 0, idleTimeoutMs: 600_000,
    onSpawn: (c) => { currentChild = c; },
    onData: (s) => {
      const dl = /Downloading\s+\S+\s+\(([\d.]+)\s*MB\)/.exec(s);
      if (dl) { doneMB += currentMB; currentMB = parseFloat(dl[1]) || 0; }
      const bar = /(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\s*MB/.exec(s);
      const got = Math.max(shownMB, doneMB + (bar ? parseFloat(bar[1]) : 0));
      const now = Date.now();
      if (got === shownMB && now - lastTick < 3000) return; // sin novedad, no repetir
      shownMB = got;
      lastTick = now;
      const pct = plan.downloadMB ? Math.min(88, Math.round((got / plan.downloadMB) * 100)) : 0;
      report({
        pct: 12 + Math.round(pct * 0.75),
        msg: got > 0
          ? 'Instalando ' + plan.pkg + '… ' + got.toFixed(0) + ' MB bajados'
          : 'Instalando ' + plan.pkg + '… (preparando la descarga)',
      });
    },
  });
  currentChild = null;
  abortIfCancelled();
  if (r.code !== 0) {
    throw new Error('pip no pudo instalar ' + plan.pkg + ':\n' + ((r.err || r.out) || '').slice(-400));
  }
  const bin = path.join(venv, IS_WIN ? 'Scripts' : 'bin', plan.bin + (IS_WIN ? '.exe' : ''));
  if (!fs.existsSync(bin)) {
    throw new Error('pip dijo que instaló ' + plan.pkg + ' pero no aparece el comando ' + plan.bin + '. No lo doy por bueno.');
  }
  return { bin: plan.bin, path: bin, method: 'pip-venv', version: '' };
}

/**
 * Descomprime probando lo que suele haber en la máquina, en orden. El `tar` de
 * Windows 10/11 (bsdtar) lee 7z; si no, 7-Zip si está instalado. Devuelve con
 * qué se logró, o explota con un texto que le sirve al editor.
 */
async function extractArchive(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const attempts = [
    { cmd: 'tar', args: ['-xf', archive, '-C', destDir] },
    { cmd: '7z', args: ['x', '-y', '-o' + destDir, archive] },
    { cmd: '7za', args: ['x', '-y', '-o' + destDir, archive] },
    { cmd: '7zz', args: ['x', '-y', '-o' + destDir, archive] },
  ];
  const errores = [];
  for (const a of attempts) {
    const r = await run(a.cmd, a.args, {
      timeoutMs: 1_800_000, idleTimeoutMs: 600_000, shell: IS_WIN,
      onSpawn: (c) => { currentChild = c; },
    });
    currentChild = null;
    if (r.code === 0 && fs.readdirSync(destDir).length) return a.cmd;
    errores.push(a.cmd + ': ' + ((r.err || r.out) || 'código ' + r.code).trim().slice(-120));
  }
  throw new Error('No pude descomprimir el archivo con ninguna herramienta del equipo (' + errores.join(' · ') + ').' +
    '\nEl archivo YA está bajado en: ' + archive +
    '\nQué hacer: descomprimilo a mano con 7-Zip (https://7-zip.org) y dejá esa carpeta en el PATH,' +
    ' o instalá 7-Zip y volvé a apretar el botón (no se vuelve a bajar).');
}

/** Busca un archivo por nombre hasta `depth` niveles. Devuelve la ruta o ''. */
function findFile(dir, name, depth) {
  const target = String(name).toLowerCase();
  let nivel = [dir];
  for (let d = 0; d <= depth && nivel.length; d++) {
    const siguiente = [];
    for (const cur of nivel) {
      let entries = [];
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
      for (const e of entries) {
        const p = path.join(cur, e.name);
        if (e.isDirectory()) siguiente.push(p);
        else if (e.name.toLowerCase() === target) return p;
      }
    }
    nivel = siguiente;
  }
  return '';
}

// ── Verificación: que la herramienta CORRA, no que el archivo exista ────

/** Un WAV mono 16 kHz de 1 segundo, para probar la cadena entera de verdad. */
function writeTestWav(file) {
  const rate = 16000;
  const n = rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 3000), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
  return file;
}

function smokeArgs(bin, wav, outDir) {
  const tool = TOOLS.filter((t) => t.bin === bin)[0] || { style: 'openai' };
  if (tool.style === 'mlx') {
    return [wav, '--model', SMOKE_MODEL.mlx, '--output-dir', outDir, '--output-format', 'json'];
  }
  const args = [wav, '--model', SMOKE_MODEL.other, '--output_dir', outDir, '--output_format', 'json'];
  if (tool.style === 'fwxxl') args.push('--beep_off');
  return args;
}

/**
 * Comprueba que lo instalado ANDA. Dos escalones:
 *   1. `--help` tiene que salir con código 0 — obligatorio. Si el ejecutable no
 *      arranca (falta una librería, arquitectura equivocada), muere acá.
 *   2. una transcripción real de un audio de 1 segundo con el modelo más chico.
 *      Es la prueba de verdad, pero necesita bajar ese modelo: si no se puede
 *      (sin red en ese momento), no invalida la instalación, se dice qué se
 *      pudo probar y qué no.
 * Devuelve 'transcripción de prueba' o '--help'.
 */
async function verifyTool(binPath, bin, report) {
  report({ pct: 90, msg: 'Probando que la herramienta arranque…' });
  const h = await run(binPath, ['--help'], {
    timeoutMs: 180_000, shell: IS_WIN, onSpawn: (c) => { currentChild = c; },
  });
  currentChild = null;
  if (h.code !== 0) {
    throw new Error('Se instaló pero NO arranca: `' + bin + ' --help` terminó con código ' + h.code + '.\n' +
      ((h.err || h.out) || '').slice(-300));
  }
  abortIfCancelled();

  report({ pct: 94, msg: 'Transcribiendo un audio de prueba de 1 segundo (baja un modelo chico)…' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-whisper-test-'));
  try {
    const wav = writeTestWav(path.join(tmp, 'prueba.wav'));
    const t = await run(binPath, smokeArgs(bin, wav, tmp), {
      timeoutMs: 900_000, idleTimeoutMs: 300_000, cwd: tmp, shell: IS_WIN,
      onSpawn: (c) => { currentChild = c; },
    });
    currentChild = null;
    const escribio = fs.readdirSync(tmp).some((n) => n.toLowerCase().endsWith('.json'));
    if (t.code === 0 && escribio) return 'transcripción de prueba';
    return '--help';
  } catch (e) {
    return '--help';
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

/**
 * Instala Whisper. Reporta avance por onProgress({ pct, msg, note, level }).
 * Devuelve { ok, tool, path, verified, method } o { ok:false, error, manual }.
 *
 * `body.plan` = el plan que el panel ya le mostró al editor y él confirmó (así
 * lo que se baja es exactamente lo que decía el cartel). Sin él, se recalcula.
 */
async function installWhisper(body, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  cancelled = false;
  let plan = (body && body.plan) || null;
  try {
    if (!plan) plan = await whisperInstallPlan();
    if (plan.alreadyInstalled) {
      return { ok: true, alreadyInstalled: true, tool: plan.tool, path: plan.path };
    }
    if (!plan.supported) {
      return { ok: false, error: plan.reason, manual: plan.manual };
    }
    // Mientras dura la instalación, "no hay nada instalado por nosotros": si se
    // corta a mitad, el panel no queda apuntando a algo que no anda.
    forgetInstalled();
    fs.mkdirSync(whisperHome(), { recursive: true });

    const rec = plan.method === 'fwxxl'
      ? await installFwxxl(plan, report)
      : await installPip(plan, report);
    abortIfCancelled();

    const verified = await verifyTool(rec.path, rec.bin, report);
    const tool = TOOLS.filter((t) => t.bin === rec.bin)[0] || {};
    writeInstalled({
      bin: rec.bin,
      path: rec.path,
      style: tool.style || 'openai',
      fast: !!tool.fast,
      method: rec.method,
      version: rec.version || '',
      verified: verified,
      installedAt: new Date().toISOString(),
    });
    report({
      pct: 100,
      msg: '✓ ' + rec.bin + ' instalado y probado (' + verified + ').',
      note: 'Whisper instalado por el panel en ' + rec.path + ' · verificado con ' + verified +
        (rec.extractedWith ? ' · descomprimido con ' + rec.extractedWith : ''),
    });
    return { ok: true, tool: rec.bin, path: rec.path, verified: verified, method: rec.method };
  } catch (e) {
    // Nunca dejamos anotado algo que no verificamos: el estado vuelve a "falta
    // Whisper" y el botón se puede apretar de nuevo.
    forgetInstalled();
    wipeSub('extract');
    wipeSub('tool');
    if (plan && plan.method === 'pip-venv') wipeSub('venv');
    // El archivo bajado NO se borra a propósito: es lo caro (más de un giga) y
    // ya está verificado por tamaño. Volver a apretar el botón lo reusa.
    const msg = (e && e.message) || String(e);
    return {
      ok: false,
      cancelled: cancelled || /cancelada/i.test(msg),
      error: msg,
      manual: (plan && plan.manual) || '',
    };
  } finally {
    currentReq = null;
    currentChild = null;
  }
}

module.exports = {
  whisperInstallPlan,
  installWhisper,
  cancelWhisperInstall,
  // Expuestos para los tests (la instalación real baja más de un giga y necesita
  // Windows: lo que se prueba acá son las piezas, con un servidor de mentira).
  _planFor: planFor,
  _resolveWindowsAsset: resolveWindowsAsset,
  _pinnedAsset: FWXXL_PINNED,
  _assertAllowedUrl: assertAllowedUrl,
  _downloadTo: downloadTo,
  _extractArchive: extractArchive,
  _findFile: findFile,
  _versionRank: versionRank,
  _writeTestWav: writeTestWav,
  _smokeArgs: smokeArgs,
};
