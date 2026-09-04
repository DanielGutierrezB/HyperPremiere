'use strict';

// Dictado por voz: el micrófono del editor → texto en el campo del panel.
//
// Cómo está armado, y por qué así
// -------------------------------
// Son tres piezas, y las tres decisiones de diseño salieron de medir en esta
// máquina antes de escribir nada.
//
// 1) LA CAPTURA la hace ffmpeg, no el navegador del panel.
//    `getUserMedia` adentro de un panel CEP no tiene un solo reporte público de
//    que funcione (el CEF de Premiere es un Chromium 99 con el permission
//    delegate en nullptr), así que apoyar la función entera ahí era apostar.
//    ffmpeg ya es requisito del proyecto, `transcribe.js` lo invoca por nombre
//    pelado, y capturar con él está medido y andando. De paso queda un solo
//    camino de audio en vez de dos.
//    Sale PCM CRUDO por stdout (`-f s16le pipe:1`) y se acumula en memoria. Lo
//    que NO se hace es escribir un .wav e ir leyéndolo mientras crece: ffmpeg
//    lo vacía en bloques de ~8 s, así que el lector ve el archivo quieto y de
//    golpe ocho segundos de audio.
//    QUÉ micrófono se abre, con qué comando y cuánto suena lo que entra vive en
//    `dictado-microfono.js`: la lista de dispositivos, la elección por nombre,
//    la caída al del sistema, el RMS y la prueba con medidor de ⚙. Acá solo se
//    pide "el dispositivo en uso" y se abre.
//
// 2) NO SE TROCEA EL AUDIO. En cada refresco se manda el buffer ENTERO y se
//    reescribe el texto completo. Suena caro y es al revés: con el modelo
//    cargado en memoria, `small` transcribe 30 s de habla en medio segundo. A
//    cambio, la frase se auto-corrige a medida que crece el contexto en vez de
//    quedar cosida de pedazos que no se conocen entre sí. Nada de chunks de
//    2-5 s, nada de solapamiento, nada de cortar en silencio con
//    `silencedetect`: todo eso es la solución a un problema que acá no existe.
//
// 3) EL MODELO ES `small` Y ES OTRO, aparte del de las clases. `transcribe.js`
//    usa `large-v3` en Mac, que para dictado es la peor elección posible: 0,84 s
//    contra 0,14 s de inferencia. Y la diferencia de precisión, en una frase
//    dictada, no aparece. Medido acá con la misma frase de 18,5 s:
//
//      base   0,147 s  "que entre con un FAKE… los QUE Y FRAMES tienen que ser suaves"
//      small  0,287 s  "que entre con un FADE… los KEYFRAMES tienen que ser suaves"
//      turbo  0,403 s  igual que small, pero alucina "Gracias por ver el video" en silencio
//
//    O sea que `base` no es "un poco peor": rompe justo los términos técnicos
//    en inglés, que es lo único que el editor no puede dejar pasar. `small` es
//    el más chico que los escribe bien.
//
// Que el proceso de Whisper sea PERSISTENTE no es una optimización: cada
// invocación del CLI tiene un piso de ~1,2 s que no baja aunque el audio dure
// tres segundos, entre 8 y 15 veces lo que cuesta transcribir. Ver
// dictado-whisper.py, que es el proceso.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, startProcess, killTree } = require('./exec');
const { detectWhisper } = require('./transcribe');
const microfono = require('./dictado-microfono');
const vivosDe = require('./vivos');

const IS_MAC = process.platform === 'darwin';

// Las dos cosas de este archivo que son un PROCESO y no un dato: el Whisper
// persistente y la sesión de dictado con su ffmpeg. No pueden vivir en
// variables de módulo, porque el ⟳ del panel crea un módulo nuevo y deja al
// viejo con el micrófono abierto y sin nadie que lo pueda parar. Ver vivos.js,
// que además baja lo que dejó la instancia anterior antes de devolver esto.
const vivos = vivosDe.adoptar('dictado', { motor: null, sesion: null });

// Cómo se apaga esta caja cuando la adopte la instancia siguiente. Es la línea
// que hace que tocar ⟳ a mitad de un dictado cierre el micrófono en vez de
// dejarlo abierto cinco minutos.
vivos.bajarTodo = function (porQue) {
  cortarSesion(porQue);
  bajarMotor(porQue);
};

// ---------------------------------------------------------------------------
// Constantes, todas con su medición al lado
// ---------------------------------------------------------------------------

// La tasa de muestreo (16 kHz, la de Whisper) y la compuerta de silencio son
// del micrófono, no del dictado: se miden con el mismo comando de ffmpeg que
// usa la prueba de ⚙, así que viven allá con su medición al lado. Acá se usan.
const { RATE, BYTES_POR_SEG, RMS_MINIMO } = microfono;

// Cada cuánto se rehace la transcripción del buffer entero. Con `small` una
// vuelta de 30 s cuesta ~0,5 s, así que a 1,5 s el ciclo respira y el texto
// aparece de a frases en vez de temblar letra por letra.
const INTERVALO_MS = Number(process.env.HYPERPREMIERE_DICTADO_INTERVALO_MS) || 1500;

// Tope de un dictado. Cinco minutos son muchísimo para una instrucción de
// marcador, y el costo de cada refresco crece con el largo del buffer: pasado
// eso, el texto en vivo se arrastra. Se corta con un aviso, no en silencio.
const MAX_SEG = Number(process.env.HYPERPREMIERE_DICTADO_MAX_SEG) || 300;

// Sin usarse este rato, el proceso de Whisper se baja: son ~500 MB de modelo
// residentes por una función que se usa a ráfagas.
//
// Se lee en cada uso y no una vez al cargar el módulo porque así el test puede
// pedir que se baje a los 200 ms en vez de esperar los cinco minutos de verdad,
// sin ningún gancho de mentira metido en el código que corre en producción.
function inactividadMs() {
  return Number(process.env.HYPERPREMIERE_DICTADO_INACTIVIDAD_MS) || 300_000;
}

// La compuerta de silencio: con el micrófono abierto sin que nadie hable,
// Whisper INVENTA ("¡Suscríbete!", "! las las las las"), y lo único que lo
// evita es no llamar al modelo. El umbral (RMS_MINIMO, -34 dBFS) y la medición
// de la que sale están en dictado-microfono.js; acá está la DECISIÓN que lo
// usa, `convieneTranscribir`.

// La red de abajo, para lo que igual se cuele por la compuerta. Cuando Whisper
// alucina sobre silencio no dice cualquier cosa: dice UNA de un puñado de
// frases, las que más se repiten en los subtítulos de YouTube con los que se
// entrenó. Se descarta solo si la transcripción entera ES esa frase — un
// dictado de verdad nunca son cuatro palabras de agradecimiento — así que un
// editor que de verdad diga "gracias" adentro de una instrucción no pierde nada.
const ALUCINACIONES = [
  'suscribete', 'suscribete al canal', 'gracias por ver el video', 'gracias por ver',
  'gracias', 'muchas gracias', 'hasta la proxima', 'nos vemos en el proximo video',
  'subtitulos realizados por la comunidad de amara org', 'subtitulos por la comunidad de amara org',
  'amara org', 'thanks for watching', 'thank you', 'you',
];

// Audio nuevo mínimo para que valga la pena rehacer la transcripción. Por
// debajo de esto el texto vuelve idéntico y solo se gastó inferencia.
const NUEVO_MINIMO_SEG = 0.6;

const MODELO = process.env.HYPERPREMIERE_DICTADO_MODELO_WHISPER || 'mlx-community/whisper-small-mlx';
const IDIOMA = process.env.HYPERPREMIERE_DICTADO_IDIOMA || 'es';

// ---------------------------------------------------------------------------
// Lógica pura (lo que se puede probar sin micrófono ni modelo)
// ---------------------------------------------------------------------------

// El RMS del PCM y su paso a dBFS son del micrófono (los usa también la prueba
// de ⚙): una sola definición, allá.
const { rmsDePcm, dbfs, leerErrorDeFfmpeg } = microfono;

/**
 * La compuerta: ¿vale la pena llamar al modelo con lo que hay?
 *
 * Es función pura y está separada del bucle a propósito: es la decisión que
 * evita que se transcriba aire, y probarla no puede depender de tener un
 * micrófono al lado.
 *
 * @param {{rmsTotal:number, rmsNuevo:number, segundosNuevos:number, hayTexto:boolean}} estado
 * @returns {{transcribir:boolean, motivo:string}}
 */
function convieneTranscribir(estado) {
  const e = estado || {};
  if ((e.segundosNuevos || 0) < NUEVO_MINIMO_SEG) {
    return { transcribir: false, motivo: 'todavía no llegó audio nuevo' };
  }
  if ((e.rmsTotal || 0) < RMS_MINIMO) {
    // Nada de lo capturado suena. Llamar al modelo acá es cómo se consiguen
    // los "! las las las las" que aparecieron probando esto.
    return { transcribir: false, motivo: 'todo lo capturado es silencio (' + dbfs(e.rmsTotal || 0) + ')' };
  }
  if (e.hayTexto && (e.rmsNuevo || 0) < RMS_MINIMO) {
    // Ya hay una frase transcrita y el editor se quedó callado pensando: el
    // texto volvería igual. Se ahorra la vuelta y de paso no parpadea.
    return { transcribir: false, motivo: 'lo nuevo es silencio: el texto no cambiaría' };
  }
  return { transcribir: true, motivo: '' };
}

/**
 * ¿Lo que volvió es una alucinación de Whisper sobre el silencio?
 *
 * Dos formas, las dos vistas de verdad probando esto:
 *   - una de las frases de relleno de los subtítulos de YouTube ("¡Suscríbete!")
 *   - una palabra sola repetida ("! las las las las las las")
 *
 * Se mira la transcripción ENTERA, no un pedazo: descartar por contener la
 * palabra "gracias" se llevaría puesto un dictado real.
 *
 * @param {string} texto
 * @returns {boolean}
 */
function esAlucinacionDeSilencio(texto) {
  const limpio = String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // sin tildes
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!limpio) return false;
  if (ALUCINACIONES.indexOf(limpio) !== -1) return true;
  // Una sola palabra repetida y nada más. Cuatro es el piso: "no no no" puede
  // ser alguien corrigiéndose, "las las las las" no es nada.
  const palabras = limpio.split(' ');
  if (palabras.length >= 4 && palabras.every((p) => p === palabras[0])) return true;
  return false;
}

/**
 * ¿Se puede dictar en esta máquina, y si no, por qué?
 *
 * Función pura: recibe lo que se averiguó del sistema y devuelve el veredicto
 * con el texto que va a leer el editor en el botón. Está aparte del sondeo para
 * poder probar Windows desde un Mac, que es la mitad del requisito.
 *
 * @param {{plataforma:string, whisper:object|null, python:string, ffmpeg:boolean}} maquina
 * @returns {{disponible:boolean, motivo:string}}
 */
function veredicto(maquina) {
  const m = maquina || {};
  if (m.plataforma !== 'darwin') {
    return {
      disponible: false,
      motivo: 'El dictado por voz todavía es solo para Mac. La captura usa avfoundation, ' +
        'que es el sistema de audio de macOS, y el equivalente en Windows (dshow) no está probado. ' +
        'Escribí la instrucción a mano por ahora.',
    };
  }
  if (!m.ffmpeg) {
    return {
      disponible: false,
      motivo: 'Falta ffmpeg, que es lo que abre el micrófono. Instalalo con `brew install ffmpeg` y recargá el panel.',
    };
  }
  if (!m.whisper || m.whisper.style !== 'mlx') {
    return {
      disponible: false,
      motivo: 'El dictado necesita mlx-whisper (el Whisper de Apple Silicon), que es el único que se puede ' +
        'dejar cargado en memoria entre frase y frase. Usá el botón “Instalar Whisper” de ⚙, o ' +
        '`pip install mlx-whisper` a mano.',
    };
  }
  if (!m.python) {
    return {
      disponible: false,
      motivo: 'Encontré mlx-whisper pero no el Python con el que corre, así que no puedo dejarlo cargado. ' +
        'Reinstalalo con el botón “Instalar Whisper” de ⚙.',
    };
  }
  return { disponible: true, motivo: '' };
}

/**
 * El intérprete de Python que tiene mlx_whisper instalado.
 *
 * Se saca del SHEBANG del ejecutable `mlx_whisper`, que es un script de Python
 * con su intérprete escrito en la primera línea. Es el único camino que no
 * adivina: el PATH del panel adentro de Premiere no es el del editor (por eso
 * `transcribe.js` ya resuelve todo por ruta absoluta), y un `which python3`
 * puede devolver un Python que no tiene el paquete.
 */
function pythonDeWhisper(rutaWhisper) {
  if (!rutaWhisper) return '';
  try {
    const fd = fs.openSync(rutaWhisper, 'r');
    const buf = Buffer.alloc(256);
    const leidos = fs.readSync(fd, buf, 0, 256, 0);
    fs.closeSync(fd);
    const primera = buf.slice(0, leidos).toString('utf8').split('\n')[0];
    const m = primera.match(/^#!\s*(\S+)/);
    if (m && m[1] && fs.existsSync(m[1])) return m[1];
  } catch (e) {}
  // Respaldo: el python del mismo directorio (los venv los ponen juntos).
  const hermano = path.join(path.dirname(rutaWhisper), 'python3');
  return fs.existsSync(hermano) ? hermano : '';
}

/**
 * ¿El modelo ya está bajado? Solo para poder AVISAR antes de arrancar: la
 * primera vez son ~480 MB y un botón que se queda mudo un minuto parece colgado.
 * Si esto se equivoca, lo peor que pasa es un aviso de más.
 */
function modeloYaBajado(repo) {
  const home = process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface');
  const carpeta = 'models--' + String(repo || '').replace(/\//g, '--');
  try {
    return fs.existsSync(path.join(home, 'hub', carpeta)) || fs.existsSync(path.join(home, carpeta));
  } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// El proceso persistente de Whisper
// ---------------------------------------------------------------------------

// { proc, pcmPath, tmpDir, pendientes, siguienteId, timerOcio }, en `vivos`
// (ver arriba): es un proceso con medio giga de modelo adentro, no un dato.
function bajarMotor(porQue) {
  if (!vivos.motor) return;
  const m = vivos.motor;
  vivos.motor = null;
  clearTimeout(m.timerOcio);
  m.bajando = porQue || 'inactividad';
  try { m.proc.stdin.end(JSON.stringify({ cmd: 'chau' }) + '\n'); } catch (e) {}
  // Si no cierra solo en dos segundos, se lo mata: cargó medio giga de modelo
  // y no puede quedar dando vueltas.
  setTimeout(() => { try { killTree(m.proc); } catch (e) {} }, 2000);
  try { fs.rmSync(m.tmpDir, { recursive: true, force: true }); } catch (e) {}
  (m.pendientes || new Map()).forEach((f) => f.rechazar(new Error('el proceso de Whisper se bajó (' + m.bajando + ')')));
}

function rearmarOcio() {
  if (!vivos.motor) return;
  clearTimeout(vivos.motor.timerOcio);
  vivos.motor.timerOcio = setTimeout(() => bajarMotor('inactividad'), inactividadMs());
  // El temporizador de ocio NO tiene que mantener vivo a Node: si el motor de
  // HyperPremiere se está cerrando, esto lo dejaría colgado hasta cinco minutos.
  if (vivos.motor.timerOcio.unref) vivos.motor.timerOcio.unref();
}

/**
 * Levanta el proceso de Whisper si no está, y espera a que diga que está listo.
 * `onAviso` recibe lo que el proceso escribe a stderr (la descarga del modelo,
 * sobre todo), para que el panel pueda decir qué está pasando.
 */
function arrancarMotor(maquina, onAviso) {
  if (vivos.motor && vivos.motor.listo) { rearmarOcio(); return vivos.motor.listo; }
  if (vivos.motor) return vivos.motor.listo;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-dictado-'));
  const guion = path.join(__dirname, 'dictado-whisper.py');
  // `startProcess` y no `spawn` pelado: lo deja como líder de grupo, que es de
  // lo que depende que `killTree` mate también a los workers de Python que
  // levanta mlx (ver exec.js). El proceso hereda el entorno de Premiere, que no
  // tiene el PATH del editor; no hace falta, porque se lo invoca por ruta
  // absoluta.
  const proc = startProcess(maquina.python, [guion, MODELO, IDIOMA], { stdin: true });

  const pendientes = new Map();
  const m = { proc, tmpDir, pendientes, siguienteId: 1, pcmPath: path.join(tmpDir, 'buf.pcm'), timerOcio: null };
  vivos.motor = m;

  let resto = '';
  proc.stdout.on('data', (c) => {
    resto += c;
    let i;
    while ((i = resto.indexOf('\n')) !== -1) {
      const linea = resto.slice(0, i);
      resto = resto.slice(i + 1);
      if (!linea.trim()) continue;
      let msg;
      try { msg = JSON.parse(linea); } catch (e) { continue; }
      if (msg.listo) { m.arranqueMs = msg.ms; if (m.avisarListo) m.avisarListo(); continue; }
      const f = pendientes.get(msg.id);
      if (!f) continue;
      pendientes.delete(msg.id);
      if (msg.error) f.rechazar(new Error(msg.error)); else f.resolver(msg);
    }
  });
  proc.stderr.on('data', (c) => { if (onAviso) { try { onAviso(String(c)); } catch (e) {} } });
  proc.on('close', () => {
    if (vivos.motor === m) vivos.motor = null;
    pendientes.forEach((f) => f.rechazar(new Error('el proceso de Whisper se cerró solo')));
    pendientes.clear();
    if (m.fallarArranque) m.fallarArranque(new Error('el proceso de Whisper se cerró antes de estar listo'));
  });
  proc.on('error', (e) => {
    if (vivos.motor === m) vivos.motor = null;
    if (m.fallarArranque) m.fallarArranque(e);
  });

  m.listo = new Promise((resolver, rechazar) => {
    m.avisarListo = () => { rearmarOcio(); resolver(m); };
    m.fallarArranque = rechazar;
  });
  return m.listo;
}

/** Transcribe el buffer entero. Devuelve { texto, ms, segundos }. */
async function transcribirBuffer(buf) {
  if (!vivos.motor) throw new Error('el proceso de Whisper no está levantado');
  const m = vivos.motor;
  fs.writeFileSync(m.pcmPath, buf);
  const id = m.siguienteId++;
  const r = await new Promise((resolver, rechazar) => {
    m.pendientes.set(id, { resolver, rechazar });
    m.proc.stdin.write(JSON.stringify({ id, pcm: m.pcmPath, rate: RATE }) + '\n');
  });
  rearmarOcio();
  return r;
}

// ---------------------------------------------------------------------------
// Sondeo de la máquina
// ---------------------------------------------------------------------------

let maquinaCache = null;

async function sondearMaquina() {
  if (maquinaCache) return maquinaCache;
  const whisper = await detectWhisper().catch(() => null);
  const ff = await run(microfono.ffmpegBin(), ['-version'], { timeoutMs: 10_000 });
  const python = (whisper && whisper.style === 'mlx') ? pythonDeWhisper(whisper.path || whisper.bin) : '';
  maquinaCache = {
    plataforma: process.platform,
    whisper: whisper,
    python: python,
    ffmpeg: ff.code === 0,
  };
  return maquinaCache;
}

/** Se olvida lo sondeado (lo llama el instalador de Whisper al terminar). */
function olvidarMaquina() { maquinaCache = null; }

// Para los tests: la misma sesión de dictado, con el sondeo del disco hecho de
// antemano (un Whisper de mentira y el ffmpeg falso). Es el único gancho, y no
// cambia ningún camino: `dictadoArrancar` lee la caché igual que siempre.
function fijarMaquina(m) { maquinaCache = m || null; }

// ---------------------------------------------------------------------------
// La sesión de dictado
// ---------------------------------------------------------------------------

// La sesión en curso —{ id, ff, trozos, bytes, parando, … }— también vive en
// `vivos`: adentro hay un ffmpeg con el micrófono abierto.

/**
 * Corta el dictado que haya, si hay: se le pide al bucle que salga y se cierra
 * el micrófono EN EL ACTO, sin esperar a que termine la vuelta en curso.
 *
 * Lo llaman los dos que pueden querer cortar: el editor, tocando ■
 * (`dictadoParar`), y la instancia siguiente del módulo cuando adopta esta caja
 * después de un ⟳ (ver `vivos.bajarTodo`). En el segundo caso el resultado no
 * le llega a nadie —el panel que lo pidió ya no existe—, y está bien: lo que no
 * puede quedar es el micrófono tomado.
 */
function cortarSesion(porQue) {
  const esta = vivos.sesion;
  if (!esta) return;
  esta.parando = true;
  if (porQue) esta.cortadaPorQue = porQue;
  // El micrófono, ya. El `finally` del bucle lo vuelve a intentar y no molesta:
  // killTree sobre un proceso que ya murió no hace nada.
  if (esta.ff) { try { killTree(esta.ff); } catch (e) {} }
  if (esta.parar) esta.parar();
}

/** ¿Hay un dictado en curso? Y de qué campo. */
function dictadoEnCurso() { return vivos.sesion ? vivos.sesion.id : ''; }

/**
 * Estado del dictado en esta máquina. Barato y sin tocar el micrófono: es lo
 * que mira el panel para dibujar (o deshabilitar) el botón.
 *
 * `cfg` es la config del motor (trae `microfono`, el nombre elegido en ⚙): si
 * se puede dictar, se dice también QUÉ micrófono se va a abrir, para que el
 * botón lo muestre sin que el editor tenga que ir a ⚙ a averiguarlo.
 */
async function dictadoEstado(cfg) {
  const maquina = await sondearMaquina();
  const v = veredicto(maquina);
  const estado = {
    ok: true,
    disponible: v.disponible,
    motivo: v.motivo,
    plataforma: maquina.plataforma,
    modelo: MODELO,
    // La primera vez hay que bajar ~480 MB, y el botón tiene que decirlo en vez
    // de quedarse mudo.
    faltaBajarModelo: v.disponible && !modeloYaBajado(MODELO),
    cargado: Boolean(vivos.motor),
    enCurso: dictadoEnCurso(),
    maxSegundos: MAX_SEG,
  };
  if (v.disponible) {
    const mic = await microfono.dispositivoEnUso(cfg || {});
    estado.microfono = mic.ok ? mic.usa : { origen: 'error', nombre: '?', indice: -1, aviso: mic.error };
  }
  return estado;
}

/**
 * Arranca el dictado. Resuelve cuando alguien llama a `dictadoParar`, con el
 * texto CRUDO completo (el que después se refina, y al que se puede volver).
 *
 * `prog` es el mismo sobre que usa el resto del motor (ver engine-client.js).
 * Los campos que manda esto:
 *   - `fase`      → en qué etapa está: preparando · escuchando · cortando. Va
 *                   EXPLÍCITA y no se deduce del texto de `msg`: el panel la usa
 *                   para pasar el botón a "■", que es lo único con lo que el
 *                   editor puede frenar. Antes se sacaba con un regex sobre la
 *                   palabra "Escuchando"; reescribir esa frase —o traducirla—
 *                   dejaba el botón en "…" y el dictado sin forma de parar.
 *   - `msg`       → esa etapa dicha en palabras, para leer.
 *   - `dictado`   → { id, texto, segundos, rms } · el texto parcial. Se REESCRIBE
 *                   entero en cada refresco, no se agrega al final.
 *   - `microfono` → el dispositivo resuelto (nombre, índice, origen, aviso),
 *                   apenas se sabe cuál es: el panel lo muestra mientras escucha.
 *   - `note`      → al ⬇ Log (qué micrófono y con qué comando, qué modelo,
 *                   cuánto tardó cada vuelta).
 *
 * `cfg` es la config del motor: de ahí sale `microfono`, el nombre elegido en ⚙.
 */
async function dictadoArrancar(body, prog, cfg) {
  // El sobre va envuelto en un try. No es paranoia de rutina: si el editor toca
  // ⟳ a mitad de un dictado, `prog` es una función del panel que ya no existe, y
  // este dictado todavía tiene que hacer un par de cosas —cerrarse y soltar el
  // micrófono— antes de terminar. Que el aviso a un panel muerto se lleve puesta
  // esa limpieza sería cambiar un bug por otro.
  const informar = typeof prog === 'function'
    ? function (p) { try { prog(p); } catch (e) {} }
    : function () {};
  const id = String((body && body.id) || 'dictado');

  if (vivos.sesion) {
    return { ok: false, error: 'Ya hay un dictado en curso (' + vivos.sesion.id + '). Pará ése primero: hay un solo micrófono.' };
  }
  if (microfono.pruebaEnCurso()) {
    return { ok: false, error: 'Hay una prueba de micrófono andando en ⚙. Esperá a que termine (dura unos segundos) y volvé a tocar.' };
  }

  const maquina = await sondearMaquina();
  const v = veredicto(maquina);
  if (!v.disponible) return { ok: false, error: v.motivo };

  const yaEstaba = Boolean(vivos.motor);
  informar({
    fase: 'preparando',
    msg: yaEstaba
      ? 'Abriendo el micrófono…'
      : (modeloYaBajado(MODELO)
        ? 'Preparando el dictado (cargando Whisper ' + MODELO.split('/').pop() + ')…'
        : 'Primera vez: bajando el modelo de dictado (~480 MB). Va a tardar un rato; después arranca en un segundo.'),
  });

  try {
    await arrancarMotor(maquina, (linea) => {
      // La descarga del modelo imprime barras de progreso de huggingface. Se
      // muestra la última línea, que es donde va el porcentaje.
      const util = String(linea).trim().split(/[\r\n]/).filter(Boolean).pop();
      if (util && /%|Fetching|download/i.test(util)) informar({ fase: 'preparando', msg: 'Bajando el modelo de dictado… ' + util.slice(-70) });
    });
  } catch (e) {
    return { ok: false, error: 'No pude levantar Whisper para el dictado: ' + ((e && e.message) || e) };
  }
  if (vivos.motor && vivos.motor.arranqueMs && !yaEstaba) {
    informar({ note: 'Dictado: Whisper ' + MODELO + ' cargado en ' + (vivos.motor.arranqueMs / 1000).toFixed(2) + ' s.' });
  }

  // QUÉ micrófono, con la lista fresca de este momento: el nombre elegido en ⚙
  // se resuelve a su índice de hoy, y si no está, se cae al del sistema
  // DICIÉNDOLO. Queda en el log con nombre, índice y el comando exacto.
  informar({ fase: 'preparando', msg: 'Buscando el micrófono…' });
  const mic = await microfono.dispositivoEnUso(cfg || {});
  if (!mic.ok) {
    informar({ note: 'Dictado (' + id + '): ' + mic.error + (mic.crudo ? '\n' + mic.crudo : ''), level: 'ERROR' });
    return { ok: false, error: mic.error };
  }
  const usa = mic.usa;
  informar({
    note: 'Dictado (' + id + '): micrófono ' + microfono.describir(usa) + (usa.aviso ? ' · ' + usa.aviso : ''),
    level: usa.origen === 'caida' || usa.origen === 'sin-dispositivos' ? 'WARN' : 'INFO',
  });
  informar({ note: 'Dictado (' + id + '): comando ' + microfono.comandoDeCaptura(usa.entrada) });
  informar({ microfono: usa });

  const trozos = [];
  const esta = {
    id, trozos, bytes: 0, parar: null, parando: false,
    texto: '', bytesTranscritos: 0, vueltas: 0, msTotal: 0,
  };
  vivos.sesion = esta;

  const ff = startProcess(microfono.ffmpegBin(), microfono.argsDeCaptura(usa.entrada));
  esta.ff = ff;
  let errFf = '';
  ff.stdout.on('data', (c) => { trozos.push(c); esta.bytes += c.length; });
  ff.stderr.on('data', (c) => { errFf += c; });
  const finDeFf = new Promise((r) => { ff.on('close', r); ff.on('error', () => r()); });

  const cortar = new Promise((r) => { esta.parar = r; });
  informar({ fase: 'escuchando', msg: 'Escuchando por «' + usa.nombre + '»… hablá. Tocá el micrófono otra vez para parar.' });

  try {
    while (!esta.parando) {
      await Promise.race([cortar, esperar(INTERVALO_MS)]);
      if (esta.parando) break;

      if (!esta.bytes && microfono.hayErrorDeFfmpeg(errFf)) {
        // ffmpeg no abrió el micrófono. El motivo suele ser el permiso de
        // macOS, que lo pide PREMIERE como app anfitriona. (Se miran solo las
        // líneas de ffmpeg: la que deja el plugin de EOS Webcam Utility en
        // cada arranque no es un error.)
        esta.parando = true;
        esta.errorCaptura = leerErrorDeFfmpeg(errFf, usa.nombre);
        break;
      }
      if (esta.bytes / BYTES_POR_SEG >= MAX_SEG) {
        informar({ fase: 'cortando', msg: 'Corté a los ' + MAX_SEG + ' s: es el tope de un dictado. Mandá esto y seguí en otro.' });
        break;
      }
      await unaVuelta(esta, informar);
    }
  } finally {
    try { killTree(ff); } catch (e) {}
  }

  // Lo que ffmpeg alcance a soltar al cerrarse.
  await Promise.race([finDeFf, esperar(700)]);

  const buf = Buffer.concat(trozos);
  const segundos = buf.length / BYTES_POR_SEG;
  vivos.sesion = null;

  if (esta.errorCaptura) return { ok: false, error: esta.errorCaptura };
  if (!buf.length) {
    return {
      ok: false,
      error: 'No entró nada de audio por «' + usa.nombre + '». ' + (microfono.hayErrorDeFfmpeg(errFf)
        ? leerErrorDeFfmpeg(errFf, usa.nombre)
        : 'El micrófono se abrió pero no llegó una sola muestra. Probalo con “Probar micrófono” en ⚙, que dice qué le pasa.'),
    };
  }

  const rms = rmsDePcm(buf);
  if (rms < RMS_MINIMO) {
    return {
      ok: false, crudo: '', segundos,
      error: 'Entraron ' + segundos.toFixed(1) + ' s de audio por «' + usa.nombre + '» pero no llega a nivel de voz (' + dbfs(rms) +
        '; hace falta ' + dbfs(RMS_MINIMO) + '), así que no lo mando a transcribir: sobre el silencio Whisper inventa frases. ' +
        'Si estabas hablando, subí el volumen de entrada o acercate al micrófono ' +
        '(Ajustes del Sistema → Sonido → Entrada), o elegí otro micrófono en ⚙ y probalo ahí con el medidor.',
    };
  }

  // La pasada final va SIEMPRE, con o sin compuerta: es el texto que se queda.
  informar({ fase: 'cortando', msg: 'Cerrando el dictado…' });
  let texto = esta.texto;
  try {
    const r = await transcribirBuffer(buf);
    texto = r.texto;
    esta.vueltas++; esta.msTotal += r.ms;
  } catch (e) {
    if (!texto) return { ok: false, error: 'No pude transcribir el dictado: ' + ((e && e.message) || e) };
    informar({ note: 'Dictado: la pasada final falló (' + ((e && e.message) || e) + '), queda lo último que se había transcrito.', level: 'WARN' });
  }

  if (esAlucinacionDeSilencio(texto)) {
    return {
      ok: false, crudo: '', segundos,
      error: 'Los ' + segundos.toFixed(1) + ' s que entraron pasaron el nivel mínimo (' + dbfs(rms) + ') pero no traen voz: ' +
        'Whisper devolvió “' + texto + '”, que es lo que inventa cuando escucha ruido. Probá de nuevo hablando más cerca.',
    };
  }

  informar({
    note: 'Dictado (' + id + '): ' + segundos.toFixed(1) + ' s de audio por «' + usa.nombre + '» (índice ' + usa.indice + ') · ' +
      esta.vueltas + ' pasadas de Whisper ' + MODELO.split('/').pop() + ' · ' + (esta.msTotal / 1000).toFixed(2) +
      ' s de inferencia en total · nivel ' + dbfs(rms) + '.',
  });
  return { ok: true, crudo: texto, segundos, rms, vueltas: esta.vueltas, msInferencia: esta.msTotal, microfono: usa };
}

/** Una pasada: compuerta, transcripción del buffer entero, texto al panel. */
async function unaVuelta(esta, informar) {
  const buf = Buffer.concat(esta.trozos);
  const nuevo = buf.slice(esta.bytesTranscritos);
  const control = convieneTranscribir({
    rmsTotal: rmsDePcm(buf),
    rmsNuevo: rmsDePcm(nuevo),
    segundosNuevos: nuevo.length / BYTES_POR_SEG,
    hayTexto: Boolean(esta.texto),
  });
  if (!control.transcribir) return;

  let r;
  try {
    r = await transcribirBuffer(buf);
  } catch (e) {
    // Una pasada perdida no rompe el dictado: el buffer sigue creciendo y la
    // siguiente (o la final) lo agarra entero.
    informar({ note: 'Dictado: una pasada de Whisper falló (' + ((e && e.message) || e) + '); sigo escuchando.', level: 'WARN' });
    return;
  }
  esta.bytesTranscritos = buf.length;
  esta.vueltas++;
  esta.msTotal += r.ms;
  // La compuerta dejó pasar algo que no era voz. No se muestra: ver aparecer
  // "¡Suscríbete!" en el campo mientras se piensa qué dictar es peor que no
  // ver nada, y la vuelta siguiente lo reemplaza igual.
  if (esAlucinacionDeSilencio(r.texto)) return;
  if (r.texto !== esta.texto) {
    esta.texto = r.texto;
    informar({
      dictado: { id: esta.id, texto: r.texto, segundos: buf.length / BYTES_POR_SEG, escuchando: true },
    });
  }
}

/** Corta el dictado en curso. El `dictadoArrancar` correspondiente resuelve. */
function dictadoParar(body) {
  const id = String((body && body.id) || '');
  if (!vivos.sesion) return { ok: false, error: 'No hay ningún dictado en curso.' };
  if (id && vivos.sesion.id !== id) {
    return { ok: false, error: 'El dictado en curso es de otro campo (' + vivos.sesion.id + ').' };
  }
  cortarSesion();
  return { ok: true };
}

/**
 * La prueba de micrófono de ⚙ (ver dictado-microfono.js), pasando por acá por
 * una sola razón: hay UN micrófono, y si está dictando no se puede probar.
 */
function probarMicrofono(body, prog, cfg) {
  if (vivos.sesion) {
    return { ok: false, error: 'Hay un dictado en curso (' + vivos.sesion.id + '). Parálo primero: la prueba usa el mismo micrófono.' };
  }
  return microfono.probarMicrofono(body, prog, cfg);
}

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  dictadoEstado,
  dictadoArrancar,
  dictadoParar,
  dictadoEnCurso,
  probarMicrofono,
  olvidarMaquina,
  bajarMotor,
  // Expuestos para los tests: son las decisiones puras de este archivo (y las
  // del micrófono que este archivo usa, para no romper a quien las probaba acá).
  _convieneTranscribir: convieneTranscribir,
  _esAlucinacionDeSilencio: esAlucinacionDeSilencio,
  _veredicto: veredicto,
  _rmsDePcm: rmsDePcm,
  _pythonDeWhisper: pythonDeWhisper,
  _leerErrorDeFfmpeg: leerErrorDeFfmpeg,
  _dbfs: dbfs,
  _arrancarMotor: arrancarMotor,
  _transcribirBuffer: transcribirBuffer,
  _motorVivo: () => Boolean(vivos.motor),
  _fijarMaquina: fijarMaquina,
  RMS_MINIMO, MAX_SEG, MODELO, RATE,
};
