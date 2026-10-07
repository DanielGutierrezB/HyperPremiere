// REMOTION STUDIO: mirar una versión en vivo, y renderizarla desde ahí.
//
// ── Qué resuelve ─────────────────────────────────────────────────────
//
// Hasta acá, la única forma de ver una animación era renderizarla: ocho segundos
// por mirada, y si el timing no cerraba, otros ocho. Studio la REPRODUCE en
// vivo, con su timeline: se scrubea, se pone en loop, se marca un tramo y se
// mira ese tramo cien veces sin pagar un render.
//
// ── Y su botón Render, que reemplaza el clip en Premiere ─────────────
//
// Al principio Studio era solo para mirar, y el botón que hacía entrar un clip
// a la secuencia era únicamente el del panel. El editor lo pidió al revés: que
// el Render de la interfaz de Studio reemplace en Premiere el clip de ese
// marcador, cada vez. Ahora es así, y descansa en tres cosas:
//
//   1. Cada vez que el panel abre un marcador, las props que lee Studio llevan
//      un `destino`: un identificador que acá se asocia con el marcador, la
//      versión y el código que se mostró. Studio guarda en cada trabajo de
//      render las props con que arrancó, así que cada render dice SOLO a qué
//      marcador pertenece, aunque en el medio se haya abierto otro. Medido con
//      la interfaz real (test/manual/studio-render.js): verde con el marcador
//      verde, azul después de abrir el azul, sin recargar la pestaña.
//   2. El panel se suscribe a `/events`, el mismo canal por el que la interfaz
//      de Studio se entera de su cola de renders. Cuando un trabajo pasa a
//      `done`, el archivo que dejó se guarda como una versión nueva del
//      marcador —con su código y su ficha— UNA sola vez, y se avisa.
//   3. Quien recibe el aviso (el panel, ver cep/js/studio-renders.js) reemplaza
//      en Premiere el archivo del clip que ya estaba puesto.
//
// Los ajustes de ese render salen de `remotion.config.ts`: ProRes 4444 con
// alfa, igual que el render del panel. Y las props por defecto de la
// composición son las de afuera (ver Root.tsx): sin eso, el botón renderizaba
// la composición vacía y fallaba.
//
// ── Por qué UN proceso y no uno por vista previa ─────────────────────
//
// Studio VIGILA el archivo de `--props` y recarga en caliente. Así que hay un
// solo proceso por sesión del panel, y cambiar de marcador —o volver a mirar el
// mismo después de editarlo— es REESCRIBIR ESE ARCHIVO: la ventana que el
// editor ya tiene abierta se actualiza sola.
//
// Lo que eso obliga es una regla: no se cambia de marcador mientras Studio
// está renderizando otro. Las imágenes que una composición incrusta viven en
// UNA carpeta (`public/assets/`) y todos los marcadores las llaman igual
// (`asset-01.png`): cambiarlas a mitad de un render le pondría a un clip las
// imágenes de otro, y ese clip entraría a Premiere.
//
// ── Y por qué HyperFrames no tiene esto ─────────────────────────────
//
// No es una omisión: su contrato pide que la timeline quede PAUSADA y registrada
// en `window.__timelines` para que el capturador la pueda posicionar cuadro por
// cuadro. Abrir ese HTML en un navegador muestra el primer cuadro y nada más.

'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const instalacion = require('./remotion-instalar');
const { copiarImagenes } = require('./remotion-imagenes');
const { nodeBin } = require('./node-bin');
const { killTree, startProcess } = require('../exec');
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

// Avisos que llegaron sin nadie escuchando (un render que terminó antes de que
// el panel se suscribiera). Se entregan al suscribirse; más de esto es basura.
const PENDIENTES_MAX = 20;

// La sesión cuelga de `process` y no de una variable de este módulo, y no es un
// detalle: el ⟳ del panel borra la caché de `require` de todo `bridge/` y vuelve
// a cargarlo, pero el proceso de Node es el mismo. Con la sesión en una variable
// del módulo, recargar el panel con Studio andando dejaba un webpack en watch
// que nadie podía apagar —la instancia nueva arranca con `null`— y la próxima
// vista previa levantaba un SEGUNDO. Es exactamente el problema que `vivos.js`
// existe para resolver.
//
// Lo que `adoptar` hace es BAJAR la sesión anterior, no reengancharse a ella:
// un ⟳ deja al editor con un "no se puede acceder a este sitio" en la pestaña
// de Studio. Reengancharse pediría guardar el puerto en disco y verificarlo;
// queda anotado y no hecho, para que el próximo que lea sepa que es una
// decisión y no un olvido.
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
 * propio arranque cuando la sesión anterior murió. Quien estaba escuchando los
 * renders se entera de que se terminó.
 */
function apagar(motivo) {
  const s = caja.sesion;
  if (!s) return { ok: true, andaba: false };
  caja.sesion = null;
  clearTimeout(s.idle);
  try { if (s.sse) s.sse.destroy(); } catch (e) { /* ya estaba cerrada */ }
  try { killTree(s.hijo); } catch (e) { /* ya estaba muerto */ }
  const cerrar = s.alCerrar.splice(0);
  cerrar.forEach((fin) => { try { fin({ ok: true, terminado: motivo || '' }); } catch (e) { /* el panel se fue */ } });
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

function sesionNueva(datos) {
  return Object.assign({
    idle: null,
    // id → destino: qué marcador, versión y código mostró el panel con esas props.
    destinos: {},
    // Quién guarda un render terminado (versiones.js); lo trae cada `mostrar`.
    alTerminar: null,
    // UN solo oyente (ver `escuchar`), y lo que llegó sin oyente.
    escucha: null, alCerrar: [], pendientes: [],
    // Trabajos ya procesados, y los que siguen renderizando → su destino.
    vistos: {}, enCurso: {},
    // Los renders terminados se guardan de a uno: dos seguidos no pueden
    // pelearse por el mismo número de versión.
    cadena: Promise.resolve(),
    sse: null,
  }, datos);
}

// ─── Lo que avisa Studio por /events ─────────────────────────────────

/**
 * Parte un pedazo del stream de `/events` en eventos completos.
 *
 * El protocolo es Server-Sent Events: cada evento es `data: <json>` y termina en
 * una línea en blanco, pero un `data` de `http` puede cortar en cualquier lado.
 * Devuelve `{ eventos, resto }`: lo que no llegó a cerrarse vuelve a entrar con
 * el pedazo siguiente.
 */
function leerEventos(texto) {
  const bloques = String(texto || '').split('\n\n');
  const resto = bloques.pop();
  const eventos = [];
  for (const b of bloques) {
    for (const linea of b.split('\n')) {
      if (linea.indexOf('data: ') !== 0) continue;
      try { eventos.push(JSON.parse(linea.slice(6))); } catch (e) { /* no era un evento */ }
    }
  }
  return { eventos: eventos, resto: resto };
}

/** El `destino` que viajó en las props de un trabajo de Studio, o ''. */
function destinoDelTrabajo(trabajo) {
  try {
    const props = JSON.parse((trabajo && trabajo.serializedInputPropsWithCustomSchema) || '{}');
    return props && typeof props.destino === 'string' ? props.destino : '';
  } catch (e) {
    return '';
  }
}

/**
 * Lo que cambió en la cola de renders de Studio, aplicado a la sesión.
 *
 * Studio manda la cola ENTERA en cada cambio —un trabajo terminado sigue
 * apareciendo en los avisos de los que vienen después—, así que lo que importa
 * es no procesar dos veces el mismo. Devuelve los trabajos que acaban de
 * terminar (bien o mal) y que todavía nadie miró.
 */
function alCambiarLaCola(s, cola) {
  const terminados = [];
  for (const t of cola || []) {
    // Solo video: una imagen fija o una secuencia de PNG no tienen nada que
    // reemplazar en la línea de tiempo.
    if (!t || t.type !== 'video' || !t.id) continue;
    if (t.status === 'idle' || t.status === 'running') {
      s.enCurso[t.id] = destinoDelTrabajo(t);
      continue;
    }
    delete s.enCurso[t.id];
    if ((t.status === 'done' || t.status === 'failed') && !s.vistos[t.id]) {
      s.vistos[t.id] = true;
      terminados.push(t);
    }
  }
  return terminados;
}

function avisar(s, aviso) {
  if (s.escucha) {
    try { s.escucha(aviso); } catch (e) { /* el panel que escuchaba ya no está */ }
    return;
  }
  s.pendientes.push(aviso);
  if (s.pendientes.length > PENDIENTES_MAX) s.pendientes.shift();
}

/** Guarda un render terminado de Studio y avisa. De a uno (ver `cadena`). */
function procesar(s, trabajo) {
  s.cadena = s.cadena.then(async () => {
    const destino = s.destinos[destinoDelTrabajo(trabajo)];
    if (trabajo.status === 'failed') {
      avisar(s, {
        ok: false, etiqueta: destino ? destino.etiqueta : '',
        error: 'El render de Studio falló: ' + ((trabajo.error && trabajo.error.message) || 'sin motivo'),
      });
      return;
    }
    // Un render de algo que no abrió el panel —el archivo de props tocado a
    // mano, o una composición elegida en la lista de Studio— no tiene a qué
    // clip ir, y adivinarlo sería pisar el de otro marcador.
    if (!destino || typeof s.alTerminar !== 'function') {
      avisar(s, {
        ok: false, etiqueta: '',
        error: 'Studio terminó un render que no salió de ningún marcador abierto desde el panel (' +
          trabajo.outName + '): no lo pongo en Premiere.',
      });
      return;
    }
    try {
      const r = await s.alTerminar({
        archivo: path.resolve(s.dir, trabajo.outName),
        destino: destino,
        trabajo: { id: trabajo.id, outName: trabajo.outName, codec: trabajo.codec },
      });
      avisar(s, Object.assign({ ok: true }, r));
    } catch (e) {
      avisar(s, { ok: false, etiqueta: destino.etiqueta, error: (e && e.message) || String(e) });
    }
  });
  return s.cadena;
}

/**
 * Se suscribe a `/events`, como la interfaz de Studio, y no se suelta mientras
 * la sesión viva: si Studio cierra la conexión (al reiniciarse, por ejemplo),
 * se vuelve a enganchar al segundo.
 */
function conectarEventos(s) {
  if (caja.sesion !== s || !sesionViva(s)) return;
  let resto = '';
  const req = http.get({ host: '127.0.0.1', port: s.puerto, path: '/events' }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (pedazo) => {
      const r = leerEventos(resto + pedazo);
      resto = r.resto;
      for (const ev of r.eventos) {
        if (ev && ev.type === 'render-queue-updated') {
          alCambiarLaCola(s, ev.queue).forEach((t) => procesar(s, t));
        }
      }
    });
    res.on('end', () => reconectar(s));
  });
  req.on('error', () => reconectar(s));
  s.sse = req;
}

function reconectar(s) {
  if (caja.sesion !== s || !sesionViva(s)) return;
  const t = setTimeout(() => conectarEventos(s), 1000);
  if (t.unref) t.unref();
}

/** El marcador que Studio está renderizando, si es otro que `destino`; si no, null. */
function otroRenderizando(s, destino) {
  for (const id of Object.keys(s.enCurso)) {
    const d = s.destinos[s.enCurso[id]];
    if (d && !mismoMarcador(d, destino)) return d;
  }
  return null;
}

function mismoMarcador(a, b) {
  return !!a && !!b && a.projectPath === b.projectPath &&
    a.sequenceName === b.sequenceName && a.markerSlug === b.markerSlug;
}

// ─── Lo que llama el motor ───────────────────────────────────────────

/**
 * Abre (o reusa) Studio mostrando esta composición.
 *
 * `{ codigoJs, conFondo, duracionEnCuadros, etiqueta, destino?, assetsDir?,
 * alTerminar? }`. Con `destino` —el marcador, la versión y el código fuente que
 * se muestran— un render hecho en Studio sabe a qué clip va; `alTerminar` es
 * quien lo guarda como versión.
 *
 * Devuelve `{ ok, url, arrancado, etiqueta }`: `arrancado` dice si hubo que
 * levantarlo, que es lo que el panel necesita para decirle al editor si va a
 * esperar.
 */
async function mostrar(o) {
  const st = instalacion.estado();
  if (!st.instalado) throw new Error('Remotion no está listo: ' + st.motivo);
  instalacion.sincronizarHuesped(st.dir);

  const sigue = viva() ? caja.sesion : null;
  if (sigue && o.destino) {
    const otro = otroRenderizando(sigue, o.destino);
    if (otro) {
      throw new Error('Studio está renderizando «' + otro.etiqueta + '». Esperá a que termine antes de abrir ' +
        'otro marcador: las imágenes de los dos van a la misma carpeta, y el render saldría con las de éste.');
    }
  }

  const id = o.destino ? crypto.randomBytes(8).toString('hex') : '';
  const props = {
    codigoJs: o.codigoJs,
    conFondo: !!o.conFondo,
    duracionEnCuadros: o.duracionEnCuadros,
    destino: id,
  };
  // Las imágenes de ESTE marcador, y solo las de éste (ver la cabecera). Antes
  // de levantar Studio, además, porque es lo que crea `public/`: sin esa carpeta
  // al arrancar, Studio no la sirve.
  copiarImagenes(o.assetsDir, st.dir);

  // Ya andaba: con reescribir el archivo alcanza. Studio lo vigila y la pestaña
  // abierta se actualiza sola.
  if (sigue) {
    if (id) sigue.destinos[id] = o.destino;
    if (typeof o.alTerminar === 'function') sigue.alTerminar = o.alTerminar;
    escribirProps(st.dir, props);
    sigue.etiqueta = o.etiqueta || '';
    armarInactividad();
    return { ok: true, url: sigue.url, arrancado: false, etiqueta: sigue.etiqueta };
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
  //
  // El node sale de node-bin.js y NO de `process.execPath`, que adentro de
  // Premiere es un binario de Adobe. Y `startProcess` en vez de `spawn` pelado,
  // porque deja al hijo como líder de grupo: Studio levanta un webpack en watch
  // con sus propios workers, y `apagar()` los tiene que bajar a todos.
  const hijo = startProcess(await nodeBin(), [
    bin, 'studio', path.join('src', 'index.ts'),
    '--props=' + archivoDeProps(st.dir),
    '--port', String(puerto),
    '--no-open',
  ], {
    cwd: st.dir,
  });

  let cola = '';
  const juntar = (d) => { cola = (cola + d.toString()).slice(-4000); };
  hijo.stdout.on('data', juntar);
  hijo.stderr.on('data', juntar);

  const s = sesionNueva({
    hijo: hijo,
    puerto: puerto,
    dir: st.dir,
    url: 'http://localhost:' + puerto + '/',
    etiqueta: o.etiqueta || '',
    alTerminar: typeof o.alTerminar === 'function' ? o.alTerminar : null,
  });
  if (id) s.destinos[id] = o.destino;
  caja.sesion = s;
  // Que se muera solo no puede dejar la sesión anotada como viva: la próxima
  // vista previa reusaría un puerto que no contesta.
  hijo.on('close', () => { if (caja.sesion === s) apagar('el proceso terminó'); });

  try {
    await esperarQueLevante(puerto, () => cola);
  } catch (e) {
    apagar('no levantó');
    throw e;
  }
  conectarEventos(s);
  armarInactividad();
  return { ok: true, url: s.url, arrancado: true, etiqueta: s.etiqueta };
}

/**
 * Escucha los renders de Studio: `fn(aviso)` por cada uno que termina, con lo
 * que devolvió `alTerminar` (o `{ ok: false, error }`).
 *
 * Hay UN solo oyente, y es a propósito: quien escucha reemplaza un clip en
 * Premiere, y dos oyentes serían dos reemplazos por render. Suscribirse de
 * nuevo suelta al anterior. Devuelve una promesa que se cumple cuando Studio se
 * apaga (o cuando otro oyente toma el lugar), con el motivo.
 */
function escuchar(fn) {
  const s = caja.sesion;
  if (!sesionViva(s)) return Promise.resolve({ ok: true, terminado: 'Studio no está abierto' });
  const anteriores = s.alCerrar.splice(0);
  anteriores.forEach((fin) => { try { fin({ ok: true, terminado: 'otro oyente tomó su lugar' }); } catch (e) { /* ya no estaba */ } });
  s.escucha = fn;
  const atrasados = s.pendientes.splice(0);
  atrasados.forEach((aviso) => { try { fn(aviso); } catch (e) { /* sigue con el resto */ } });
  return new Promise((resolve) => { s.alCerrar.push(resolve); });
}

/** Qué está mostrando, para que el panel no ofrezca abrir lo que ya está abierto. */
function estado() {
  if (!viva()) return { andando: false, url: '', etiqueta: '', renderizando: false };
  const s = caja.sesion;
  return { andando: true, url: s.url, etiqueta: s.etiqueta, renderizando: Object.keys(s.enCurso).length > 0 };
}

module.exports = {
  mostrar, apagar, estado, escuchar, INACTIVIDAD_MS,
  // Para los tests: lo que se decide sin levantar un Studio de verdad. Si una
  // sesión cuenta como viva, que la caja sea la compartida por `process`, cómo
  // se parte el stream de /events, qué trabajo es nuevo y a qué marcador
  // pertenece, y el guardado de a uno.
  _sesionViva: sesionViva,
  _caja: caja,
  _leerEventos: leerEventos,
  _destinoDelTrabajo: destinoDelTrabajo,
  _alCambiarLaCola: alCambiarLaCola,
  _procesar: procesar,
  _sesionNueva: sesionNueva,
  _otroRenderizando: otroRenderizando,
};
