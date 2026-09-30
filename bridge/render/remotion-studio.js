// LA VISTA PREVIA: el Studio de Remotion, reproduciendo una versión ya generada.
//
// ── Qué resuelve ─────────────────────────────────────────────────────
//
// Hasta acá, la única forma de ver una animación era renderizarla: ocho segundos
// por mirada, y si el timing no cerraba, otros ocho. Studio la REPRODUCE en
// vivo, con su timeline: se scrubea, se pone en loop, se marca un tramo y se
// mira ese tramo cien veces sin pagar un render.
//
// ── Qué NO es, que es la parte importante ────────────────────────────
//
// Studio NO edita. No hay inspector de propiedades ni nada que arrastrar: en
// Remotion, editar es editar código, y el código de una versión se toca en
// "Editar código" del panel. Acá se MIRA.
//
// Y se mira lo que ya está en disco: esto no llama al modelo, no escribe una
// versión nueva y no renderiza nada. El botón que hace entrar un clip a la
// secuencia sigue siendo el del panel, porque el Render de Studio saldría con
// sus propios ajustes —no con nuestro ProRes 4444 con alfa, ni con el nombre
// versionado, ni colocado en el tramo del marcador—.
//
// ── Por qué UN proceso y no uno por vista previa ─────────────────────
//
// Studio VIGILA el archivo de `--props` y recarga en caliente. Se midió: con
// Studio andando y la pestaña ya abierta, cambiar ese archivo hizo que pasara de
// una composición a la otra sin reiniciar nada.
//
// Así que hay un solo proceso por sesión del panel, y cambiar de marcador —o
// volver a mirar el mismo después de editarlo— es REESCRIBIR ESE ARCHIVO: la
// ventana que el editor ya tiene abierta se actualiza sola. Eso convierte al
// editor de código del panel y a esta ventana en un par: se toca el código, se
// aprieta "Vista previa", y lo que estaba en pantalla cambia.
//
// Levantar uno por mirada no sería catastrófico —el servidor empieza a servir la
// página enseguida y compila detrás— pero cada arranque es otro webpack en
// watch, y con cuatro carriles de render andando eso se siente.
//
// ── Y por qué HyperFrames no tiene esto ─────────────────────────────
//
// No es una omisión: su contrato pide que la timeline quede PAUSADA y registrada
// en `window.__timelines` para que el capturador la pueda posicionar cuadro por
// cuadro. Abrir ese HTML en un navegador muestra el primer cuadro y nada más.
// Darle una vista previa sería escribirle un reproductor aparte, que es otro
// trabajo y no un ajuste de este.

'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const instalacion = require('./remotion-instalar');
const { killTree } = require('../exec');
const vivos = require('../vivos');

// Cuánto se le da para empezar a servir antes de decir que no arrancó. Es
// generoso a propósito: con el proyecto ya compilado contesta en menos de un
// segundo, pero la primera vez en una máquina compila todo, y con cuatro
// carriles de render andando —lo normal mientras la cola avanza— no tiene la
// máquina para él.
const ARRANQUE_MS = 120 * 1000;

// Se apaga solo si nadie lo mira por este rato.
//
// Es la ÚNICA red que cubre que Premiere se cierre de golpe: el `beforeunload`
// del panel y la adopción de la caja de `vivos` cubren los dos el ⟳, que es otro
// evento. Sin esto, un webpack en watch queda comiendo memoria hasta que alguien
// lo note. Media hora es más de lo que dura una revisión de timing y menos de lo
// que tarda en molestar.
const INACTIVIDAD_MS = 30 * 60 * 1000;

// La sesión cuelga de `process` y no de una variable de este módulo, y no es un
// detalle: el ⟳ del panel borra la caché de `require` de todo `bridge/` y vuelve
// a cargarlo, pero el proceso de Node es el mismo. Con la sesión en una variable
// del módulo, recargar el panel con Studio andando dejaba un webpack en watch
// que nadie podía apagar —la instancia nueva arranca con `null`— y la próxima
// vista previa levantaba un SEGUNDO. Es exactamente el problema que `vivos.js`
// existe para resolver, con el mismo razonamiento que el micrófono del dictado:
// "hay un solo Studio" tiene que valer por PROCESO, no por instancia de módulo.
//
// Lo que `adoptar` hace es BAJAR la sesión anterior, no reengancharse a ella, y
// acá eso es más discutible que en el dictado: un dictado a medias después de un
// ⟳ está muerto de todos modos, pero un Studio andando es un espectador pasivo
// con una pestaña abierta, y bajarlo le deja al editor un "no se puede acceder a
// este sitio" — justo el final que `sesionViva` evita en el otro camino.
// Reengancharse pediría guardar el puerto en disco y verificarlo; queda anotado
// y no hecho, para que el próximo que lea sepa que es una decisión y no un
// olvido.
const caja = vivos.adoptar('remotion-studio', {
  sesion: null,
  bajarTodo: function (porQue) { apagar(porQue); },
});

/** Un puerto libre que nos dé el sistema, para no chocar con nada del editor. */
function puertoLibre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** El archivo por donde viaja la composición que Studio está mostrando. */
function archivoDeProps(dir) {
  return path.join(dir, 'vista-previa-props.json');
}

/**
 * Deja escrito qué composición tiene que mostrar Studio.
 *
 * Es la única vía: si Studio ya está andando, con esto se cambia lo que muestra
 * y la pestaña abierta se actualiza sola.
 */
function escribirProps(dir, props) {
  fs.writeFileSync(archivoDeProps(dir), JSON.stringify(props, null, 2), 'utf8');
}

/** ¿Está contestando? Se le pide la página, que es la prueba que importa. */
function responde(puerto) {
  return new Promise((resolve) => {
    const s = net.connect({ port: puerto, host: '127.0.0.1' }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

/** Espera a que el puerto conteste, o se rinde con lo que dijo el hijo. */
async function esperarQueLevante(puerto, salida) {
  const hasta = Date.now() + ARRANQUE_MS;
  while (Date.now() < hasta) {
    if (await responde(puerto)) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('La vista previa no levantó en ' + (ARRANQUE_MS / 1000) + 's.\n' +
    (salida() || '(el proceso no dijo nada)'));
}

function armarInactividad() {
  const s = caja.sesion;
  if (!s) return;
  clearTimeout(s.idle);
  s.idle = setTimeout(() => { apagar('por inactividad'); }, INACTIVIDAD_MS);
  // `unref` para que este temporizador no sea el que mantenga vivo al panel.
  if (s.idle.unref) s.idle.unref();
}

/**
 * Apaga Studio si está andando. Devuelve si había algo que apagar.
 *
 * Lo llaman tres cosas: el panel al cerrarse, el watchdog de inactividad, y el
 * propio arranque cuando la sesión anterior murió.
 */
function apagar(motivo) {
  const s = caja.sesion;
  if (!s) return { ok: true, andaba: false };
  caja.sesion = null;
  clearTimeout(s.idle);
  try { killTree(s.hijo); } catch (e) { /* ya estaba muerto */ }
  return { ok: true, andaba: true, motivo: motivo || '' };
}

/**
 * ¿Esta sesión está viva?
 *
 * Un hijo que murió solo NO cuenta, y es lo único que decide si la próxima vista
 * previa reusa o levanta: dándolo por vivo, el panel abriría una ventana en un
 * puerto que ya no contesta y el editor leería "no se puede acceder a este
 * sitio" sin ninguna pista de por qué.
 */
function sesionViva(s) {
  return !!(s && s.hijo && s.hijo.exitCode === null && !s.hijo.killed);
}

function viva() {
  return sesionViva(caja.sesion);
}

/**
 * Abre (o reusa) la vista previa mostrando esta composición.
 *
 * `{ codigoJs, conFondo, duracionEnCuadros, etiqueta }`. Devuelve
 * `{ ok, url, arrancado, etiqueta }`: `arrancado` dice si hubo que levantarlo,
 * que es la diferencia entre catorce segundos y ninguno — y es lo que el panel
 * necesita para decirle al editor si va a esperar.
 */
async function mostrar(o) {
  const st = instalacion.estado();
  if (!st.instalado) throw new Error('Remotion no está listo: ' + st.motivo);

  const props = {
    codigoJs: o.codigoJs,
    conFondo: !!o.conFondo,
    duracionEnCuadros: o.duracionEnCuadros,
  };

  // Ya andaba: con reescribir el archivo alcanza. Studio lo vigila y la pestaña
  // abierta se actualiza sola (ver la cabecera).
  if (viva()) {
    escribirProps(st.dir, props);
    caja.sesion.etiqueta = o.etiqueta || '';
    armarInactividad();
    return { ok: true, url: caja.sesion.url, arrancado: false, etiqueta: caja.sesion.etiqueta };
  }

  // Había una sesión pero el proceso ya no está (se cayó, o alguien lo mató por
  // afuera). Se limpia antes de levantar otra, o quedarían dos webpacks.
  apagar('el proceso anterior ya no estaba');

  // El archivo se escribe ANTES de arrancar: Studio lo lee al levantar, y si no
  // estuviera, la primera pantalla sería un error de props en vez de la
  // composición.
  escribirProps(st.dir, props);

  const puerto = await puertoLibre();
  const cli = path.join(st.dir, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');
  const bin = fs.existsSync(cli) ? cli : path.join(st.dir, 'node_modules', '.bin', 'remotion');

  // `cwd` en la carpeta de instalación, igual que el worker del render y por el
  // mismo motivo: Remotion resuelve desde ahí dónde está su navegador (ver
  // remotion-instalar.js). Y `--no-open` porque quien abre la ventana es el
  // panel, con el navegador del editor: si lo abriera Studio, se abriría una
  // pestaña por cada vez que se levanta y ninguna cuando se reusa.
  const hijo = spawn(process.execPath, [
    bin, 'studio', path.join('src', 'index.ts'),
    '--props=' + archivoDeProps(st.dir),
    '--port', String(puerto),
    '--no-open',
  ], {
    cwd: st.dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  let cola = '';
  const juntar = (d) => { cola = (cola + d.toString()).slice(-4000); };
  hijo.stdout.on('data', juntar);
  hijo.stderr.on('data', juntar);

  caja.sesion = {
    hijo: hijo,
    puerto: puerto,
    url: 'http://localhost:' + puerto + '/',
    etiqueta: o.etiqueta || '',
    idle: null,
  };
  // Que se muera solo no puede dejar la sesión anotada como viva: la próxima
  // vista previa reusaría un puerto que no contesta.
  hijo.on('close', () => { if (caja.sesion && caja.sesion.hijo === hijo) apagar('el proceso terminó'); });

  try {
    await esperarQueLevante(puerto, () => cola);
  } catch (e) {
    apagar('no levantó');
    throw e;
  }
  armarInactividad();
  return { ok: true, url: caja.sesion.url, arrancado: true, etiqueta: caja.sesion.etiqueta };
}

/** Qué está mostrando, para que el panel no ofrezca abrir lo que ya está abierto. */
function estado() {
  if (!viva()) return { andando: false, url: '', etiqueta: '' };
  return { andando: true, url: caja.sesion.url, etiqueta: caja.sesion.etiqueta };
}

module.exports = {
  mostrar, apagar, estado, INACTIVIDAD_MS,
  // Para los tests, las dos decisiones que fallan CALLADAS y no se pueden
  // alcanzar sin levantar un Studio de verdad: si una sesión cuenta como viva, y
  // que la caja sea la compartida por `process` y no una del módulo.
  _sesionViva: sesionViva,
  _caja: caja,
};
