'use strict';

// PREGUNTARLE AL CLI DE CLAUDE qué modelos tiene, y anotarlo.
//
// Es la mitad impura del selector de ⚙ (la pura, que decide qué se muestra, es
// claude-modelos.js). Hace cuatro cosas, y ninguna adivina:
//
//   1. Qué CLI hay: `claude --version`, que no gasta uso.
//   2. Cuál es el último de su canal, en el registro de npm, y si hace falta,
//      `claude update`. Sin esto el selector nunca puede mostrar los modelos
//      nuevos: llegan con el CLI nuevo, porque cada versión trae fija su tabla
//      de alias (con 2.1.201, `opus` era Opus 4.8; con 2.1.288, Opus 5.5).
//   3. Qué versiones anteriores ofrece, leídas del menú /model que viene
//      escrito adentro del propio binario.
//   4. Qué contesta de verdad cada modelo: una llamada mínima por cada uno, de
//      cuatro en cuatro, con el MISMO entorno con el que se genera. Lo que se
//      lee de cada respuesta es `modelUsage`, que trae el modelo que contestó y
//      su `contextWindow`: es la única fuente que dice cuánto le entra a un
//      modelo POR ESTA PUERTA, con esta cuenta.
//
// Lo medido se guarda en ~/.hyperpremiere/claude-modelos.json junto a la
// versión del CLI con que se midió, y deja de valer cuando el CLI cambia.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { run, salidaDe } = require('./exec');
const doctor = require('./claude-doctor');
const claudeSession = require('./claude-session');
const agentStream = require('./providers/agent-stream');
const { hpFetch } = require('./providers/http');
const CM = require('./claude-modelos');

const IS_WIN = process.platform === 'win32';

const REGISTRO_URL = 'https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags';
const NPM_MS = 8000;
// Medido con la cuenta real: cada llamada tarda ~2,3 s. El tope es para una
// sesión caída, ante la que el CLI reintenta en silencio varios minutos.
const SONDEO_MS = 45000;
// Medido: de 2.1.201 a 2.1.288 tardó 8 s. El tope es para una red lenta.
const ACTUALIZAR_MS = 10 * 60 * 1000;
// Cada llamada levanta un CLI de doscientos y pico de MB. Once a la vez son más
// de dos GB, en la misma máquina donde Premiere tiene abierta la clase.
const EN_PARALELO = 4;

// Lo que se le pide a cada modelo. Sin comillas ni llaves a propósito: en
// Windows viaja por cmd.exe, y lo único que interesa de la respuesta es quién
// la escribió, no qué dice.
const PROMPT_SONDEO = 'Contesta solo: ok';

/** Dónde queda lo medido. Se calcula al usarlo: los tests cambian el HOME. */
function archivo() {
  return path.join(os.homedir(), '.hyperpremiere', 'claude-modelos.json');
}

function leerMedicion() {
  try { return JSON.parse(fs.readFileSync(archivo(), 'utf8')); } catch (e) { return null; }
}

function guardarMedicion(med) {
  fs.mkdirSync(path.dirname(archivo()), { recursive: true });
  fs.writeFileSync(archivo(), JSON.stringify(med, null, 2), 'utf8');
}

// ─── El menú /model, leído del binario ───────────────────────────────

const AGUJA = 'descriptionForModel:"';
let menuGuardado = null;

/**
 * Las versiones anteriores que ofrece el menú /model del CLI, leídas de su
 * propio código: [{ familia, id, etiqueta, legacy }].
 *
 * El binario pesa más de 200 MB, así que se recorre por trozos de 8 MB
 * solapados —una opción partida por la frontera se lee entera en el trozo
 * donde empieza su `descriptionForModel`, y solo en ese— en vez de cargarlo
 * entero en el proceso donde vive el panel. Medido: 90 ms.
 *
 * Si no aparece nada (un CLI instalado de otra forma, un `.cmd` de npm en
 * Windows), queda el último de cada familia: es lo que había antes.
 */
function escanearMenu(file) {
  const aguja = Buffer.from(AGUJA);
  const TROZO = 8 * 1024 * 1024;
  const ANTES = 600;
  const DESPUES = 200;
  const out = [];
  const vistos = {};
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const total = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(TROZO + ANTES + DESPUES);
    for (let pos = 0; pos < total; pos += TROZO) {
      const desde = Math.max(0, pos - ANTES);
      const n = fs.readSync(fd, buf, 0, buf.length, desde);
      const vista = buf.subarray(0, n);
      let i = vista.indexOf(aguja, pos - desde);
      while (i !== -1 && desde + i < pos + TROZO) {
        const ini = Math.max(0, i - ANTES);
        const texto = vista.toString('latin1', ini, Math.min(n, i + DESPUES));
        const en = i - ini;
        const objeto = texto.lastIndexOf('{value:', en);
        const cierre = texto.indexOf('"', en + AGUJA.length);
        if (objeto !== -1 && cierre !== -1) {
          const o = CM.opcionDelMenu(texto.slice(objeto, cierre + 1));
          if (o && !vistos[o.id]) { vistos[o.id] = true; out.push(o); }
        }
        i = vista.indexOf(aguja, i + 1);
      }
    }
  } catch (e) {
    // Sin menú se sigue con los alias: no es motivo para que ⚙ no abra.
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* ya estaba cerrado */ } }
  }
  return out;
}

/**
 * El menú del CLI que hay ahora. Se recuerda por ruta REAL, tamaño y fecha del
 * binario —`~/.local/bin/claude` es un enlace a la versión instalada—, que
 * cambian en cada actualización: así no se escanea cada vez que se abre ⚙.
 */
function menu(bin) {
  let file;
  let st;
  try {
    file = fs.realpathSync(bin);
    st = fs.statSync(file);
  } catch (e) {
    return [];
  }
  const clave = file + '|' + st.size + '|' + Math.round(st.mtimeMs || 0);
  if (menuGuardado && menuGuardado.clave === clave) return menuGuardado.opciones;
  const opciones = escanearMenu(file);
  menuGuardado = { clave: clave, opciones: opciones };
  return opciones;
}

// ─── La versión del CLI ──────────────────────────────────────────────

/** { bin, version, error }. `bin` vacío = no hay CLI. Nunca lanza. */
async function instalado() {
  const found = await doctor.locate();
  if (!found.path && !found.finderBroke) return { bin: '', version: '', error: 'No encontré el CLI de Claude en esta máquina.' };
  const bin = found.path || 'claude';
  const v = await doctor.version(bin);
  return { bin: bin, version: v.ok ? v.version : '', error: v.ok ? '' : v.error };
}

/**
 * El canal de actualizaciones que tiene configurado Claude Code ("latest" o
 * "stable"). `claude update` sigue ese canal, así que hay que comparar contra
 * él: comparar siempre con "latest" teniendo el CLI en "stable" haría que
 * Verificar intentara actualizar en cada clic sin llegar nunca.
 */
function canal() {
  const home = os.homedir();
  for (const f of [path.join(home, '.claude.json'), path.join(home, '.claude', 'settings.json')]) {
    try {
      const m = /"autoUpdatesChannel"\s*:\s*"([a-z]+)"/.exec(fs.readFileSync(f, 'utf8'));
      if (m) return m[1];
    } catch (e) { /* ese archivo no está */ }
  }
  return 'latest';
}

/**
 * La última versión publicada en el canal del CLI: { version, canal, error }.
 * Va a npm, que es de donde se instala el propio CLI. Sin red se devuelve el
 * motivo y Verificar sigue con lo que hay: no saber cuál es la última no impide
 * medir la que está.
 */
async function ultimaDelCanal() {
  const ch = canal();
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), NPM_MS);
  try {
    const res = await hpFetch(REGISTRO_URL, { headers: { accept: 'application/json' }, signal: control.signal });
    if (!res.ok) return { version: '', canal: ch, error: 'el registro de npm contestó ' + res.status };
    const tags = await res.json();
    const v = String((tags && (tags[ch] || tags.latest)) || '');
    return v ? { version: v, canal: ch, error: '' } : { version: '', canal: ch, error: 'el registro de npm no trajo ninguna versión' };
  } catch (e) {
    const porTiempo = control.signal.aborted;
    return { version: '', canal: ch, error: porTiempo ? 'el registro de npm no contestó en ' + (NPM_MS / 1000) + ' s' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `claude update`: lo mismo que hace el editor en la terminal. Instala la
 * última del canal y deja el comando `claude` apuntando a ella, así que
 * también le actualiza el Claude Code de la terminal — y se dice en ⚙.
 *
 * `alSegundo(s)` corre cada segundo: una descarga de cien megas en silencio
 * parece un panel colgado. Devuelve { antes, despues, error }.
 */
async function actualizar(bin, alSegundo) {
  const t0 = Date.now();
  const tic = typeof alSegundo === 'function'
    ? setInterval(() => { try { alSegundo(Math.round((Date.now() - t0) / 1000)); } catch (e) { /* solo informa */ } }, 1000)
    : null;
  try {
    const antes = (await doctor.version(bin)).version;
    const r = await run(bin, ['update'], { timeoutMs: ACTUALIZAR_MS, shell: IS_WIN });
    const despues = (await doctor.version(bin)).version || antes;
    if (r.code !== 0 && despues === antes) {
      const cola = salidaDe(r, r.timedOut ? 'no terminó en ' + (ACTUALIZAR_MS / 60000) + ' min' : '')
        .split('\n').slice(-3).join(' · ');
      return { antes: antes, despues: despues, error: 'claude update falló: ' + (cola || 'sin motivo') };
    }
    return { antes: antes, despues: despues, error: '' };
  } finally {
    if (tic) clearInterval(tic);
  }
}

// ─── Una llamada mínima por modelo ───────────────────────────────────

function argsDeSondeo(objetivo, esfuerzo, conExtras) {
  const args = ['-p', PROMPT_SONDEO, '--output-format', 'json'];
  if (objetivo && objetivo !== 'default') args.push('--model', objetivo);
  if (esfuerzo && esfuerzo !== 'default') args.push('--effort', esfuerzo);
  // Sin herramientas contesta enseguida. Y sin guardar la sesión, porque si
  // no, cada Verificar le deja al editor una docena de conversaciones de
  // "Contesta solo: ok" en su historial de Claude Code.
  if (conExtras) args.push('--tools', '', '--no-session-persistence');
  return args;
}

/**
 * Le pide una respuesta mínima a un modelo y anota quién contestó.
 *
 * Devuelve { contesto: {id, ventana, salida} | null, error }. Un error acá no
 * es un fallo de Verificar: "no disponible para tu plan" es información para
 * el selector, y se guarda por modelo.
 *
 * El entorno es el de `envParaClaude`, el mismo con el que se genera: medir con
 * otra credencial sería medir otra cuenta.
 */
async function sondear(bin, objetivo, cfg, opts) {
  opts = opts || {};
  const esfuerzo = opts.esfuerzo || 'low';
  const tope = opts.timeoutMs || SONDEO_MS;
  const lanzar = (conExtras) => run(bin, argsDeSondeo(objetivo, esfuerzo, conExtras), {
    timeoutMs: tope,
    env: claudeSession.envParaClaude(cfg),
    // Fuera de cualquier proyecto: si no, el CLI levanta el CLAUDE.md y la
    // configuración de la carpeta donde arrancó Premiere.
    cwd: os.tmpdir(),
    shell: IS_WIN,
  });
  let r = await lanzar(true);
  // Un CLI anterior a alguno de los dos flags lo rechaza antes de llamar al
  // modelo, así que reintentar sin ellos no cuesta nada.
  if (r.code !== 0 && !r.timedOut && agentStream.isUnsupportedFlag((r.err || '') + '\n' + (r.out || ''))) {
    r = await lanzar(false);
  }
  if (r.timedOut) return { contesto: null, error: 'no contestó en ' + Math.round(tope / 1000) + ' s' };
  const crudo = String(r.out || '');
  let datos = null;
  const llave = crudo.indexOf('{');
  if (llave !== -1) {
    try { datos = JSON.parse(crudo.slice(llave, crudo.lastIndexOf('}') + 1)); } catch (e) { datos = null; }
  }
  if (!datos) return { contesto: null, error: salidaDe(r, 'el CLI contestó algo que no supe leer') };
  if (datos.is_error) return { contesto: null, error: String(datos.result || 'el modelo devolvió un error') };
  const c = CM.cualContesto(datos.modelUsage, objetivo);
  return c ? { contesto: c, error: '' } : { contesto: null, error: 'el CLI no dijo qué modelo contestó' };
}

/** Corre `fn` sobre la lista, de a `n` a la vez. */
async function deA(lista, n, fn) {
  const cola = lista.slice();
  const trabajar = async () => {
    while (cola.length) await fn(cola.shift());
  };
  await Promise.all(Array.from({ length: Math.min(n, cola.length) }, trabajar));
}

/**
 * Mide todo: los alias y las versiones fijas, y después el `[1m]` de los que
 * contestaron con menos de 1M (ver objetivosDe1M). Guarda solo si sirve.
 *
 * Devuelve { ok, medicion?, cli?, error? }. `alAvanzar(hechos, total)` por cada
 * llamada que termina.
 */
async function medirDeVerdad(cfg, opts) {
  const avisar = typeof opts.alAvanzar === 'function' ? opts.alAvanzar : function () {};
  const inst = opts.instalado || await instalado();
  if (!inst.bin) return { ok: false, error: inst.error || 'No encontré el CLI de Claude en esta máquina.' };
  // Sin saber con qué CLI se midió, lo medido no se puede guardar: no habría
  // forma de saber cuándo deja de valer.
  if (!inst.version) return { ok: false, error: 'no pude leer la versión del CLI (' + (inst.error || 'sin motivo') + ')' };

  const crudos = {};
  let hechos = 0;
  let total = 0;
  const tanda = async (objetivos) => {
    total += objetivos.length;
    avisar(hechos, total);
    await deA(objetivos, EN_PARALELO, async (obj) => {
      crudos[obj] = await sondear(inst.bin, obj, cfg);
      hechos++;
      avisar(hechos, total);
    });
  };

  await tanda(CM.objetivosAMedir(menu(inst.bin)));
  await tanda(CM.objetivosDe1M(CM.registrarMedicion(inst.version, crudos, '')));

  const med = CM.registrarMedicion(inst.version, crudos, new Date().toISOString());
  if (!CM.sirve(med)) {
    const primero = Object.keys(crudos).map((k) => crudos[k].error).find(Boolean);
    return { ok: false, error: primero || 'ningún modelo contestó' };
  }
  guardarMedicion(med);
  return { ok: true, medicion: med, cli: inst.version };
}

// Una medición a la vez. La automática (al abrir ⚙ con un CLI nuevo) y la de
// Verificar no pueden correr juntas: serían veintidós CLIs para medir lo mismo.
let enCurso = null;

/**
 * Mide, o se suma a la medición que ya está corriendo.
 *
 * Con `opts.otraVez` (Verificar) espera la que esté en curso y mide de nuevo:
 * la de antes pudo haber empezado con el CLI previo a un `claude update`.
 */
async function medir(cfg, opts) {
  opts = opts || {};
  if (enCurso && !opts.otraVez) return enCurso;
  if (enCurso) { try { await enCurso; } catch (e) { /* la nueva lo vuelve a intentar */ } }
  const esta = medirDeVerdad(cfg, opts);
  enCurso = esta;
  try {
    return await esta;
  } finally {
    if (enCurso === esta) enCurso = null;
  }
}

module.exports = {
  archivo, leerMedicion, guardarMedicion,
  escanearMenu, menu, instalado, canal, ultimaDelCanal, actualizar,
  sondear, medir,
  // Para los tests: que el menú se recuerde por binario es una decisión, y
  // hay que poder empezar de cero.
  _olvidarMenu: function () { menuGuardado = null; },
};
