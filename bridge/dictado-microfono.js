'use strict';

// El micrófono del dictado: cuáles hay, cuál se usa, cómo se abre y cuánto suena.
//
// Es la mitad de abajo de `dictado.js`. Ahí viven Whisper, la compuerta y la
// sesión; acá vive todo lo que pasa ANTES de que exista un buffer de audio: la
// lista de dispositivos, la elección del editor, el comando de ffmpeg con el
// que se abre el elegido, el RMS con el que se mide lo que entra y la prueba
// con medidor de ⚙. Las decisiones salieron de medir en esta máquina, con seis
// dispositivos de entrada enchufados, y están cada una con su número al lado.
//
// 1) LA LISTA LA DA ffmpeg, con `-f avfoundation -list_devices true -i ""`.
//    La imprime por STDERR, no por stdout, y sale con código 251 aunque haya
//    andado bien, porque después de listar intenta abrir "" y falla. O sea que
//    acá el código de salida no dice nada: se mira si apareció la sección
//    "AVFoundation audio devices:". Y desde que EOS Webcam Utility está
//    instalado, cada arranque de ffmpeg deja además una línea ajena en stderr
//    ("CMIOMS: EOSWebcamUtilityMain") que no es un error: hay que saber
//    ignorarla, o "no entró audio y stderr dice algo" se dispara en falso.
//
// 2) SE GUARDA EL NOMBRE, NO EL ÍNDICE. Los índices de avfoundation son la
//    posición en la lista de ese momento: enchufar unos auriculares corre a
//    todos los demás un lugar. En esta máquina, hoy, el [0] es el micrófono del
//    iPhone por Continuidad, el [2] es el de la MacBook y hay tres virtuales
//    (Steam, Zoom) que no son micrófonos. Mañana, sin el iPhone cerca, el de la
//    MacBook es el [1]. El nombre es lo único estable, así que la elección se
//    guarda por nombre y se resuelve a índice en el momento de capturar, con la
//    lista fresca. Si el nombre elegido no está, se cae al del sistema y SE DICE:
//    en el log y en el panel, nunca en silencio.
//
// 3) SIN ELECCIÓN, `:default`. Está verificado acá: avfoundation lo acepta para
//    audio y abre el que macOS tiene como entrada en Ajustes del Sistema →
//    Sonido → Entrada (con `-loglevel debug` ffmpeg lo confirma: "audio device
//    'MacBook Pro Microphone' opened"). Es mejor que "el primero de la lista",
//    que acá sería el iPhone. Para poder DECIR cuál es ese default sin abrir el
//    micrófono —que dispararía el permiso de macOS por abrir ⚙— se le pregunta a
//    `system_profiler SPAudioDataType -json`, que tarda 0,14 s y usa los mismos
//    nombres que avfoundation (los seis coincidieron, letra por letra).
//
// 4) LA PRUEBA USA EL MISMO COMANDO que el dictado, hasta el último argumento
//    (`argsDeCaptura` es la única función que los arma). Si el medidor anda y
//    el dictado no, la prueba mintió, y para eso no sirve.
//
// Lo que se midió acá, 2 s por dispositivo con ese comando:
//
//   [0] iPhone de Daniel Microphone   abre · 0 bytes en 3,5 s (el teléfono no está cerca)
//   [1] OBSBOT Meet 2 Microphone      abre · 0,38 s de muestras, TODAS en cero
//   [2] MacBook Pro Microphone        abre · sala callada −43,5 dBFS, pico −33,1
//   [3] Steam Streaming Speakers      abre · 2,9 s de muestras, todas en cero
//   [4] Steam Streaming Microphone    abre · idem
//   [5] ZoomAudioDevice               abre · idem
//   :default                          → [2], −46,1 dBFS
//
// Tres formas distintas de "no anda" y ninguna es un error de ffmpeg: por eso
// el veredicto distingue "no entregó ni una muestra" de "entrega ceros exactos"
// de "no llega a nivel de voz", y por eso "abrió" no alcanza como prueba.

const { run, startProcess, killTree } = require('./exec');

// Whisper trabaja a 16 kHz. Se le pide a ffmpeg que resamplee ahí mismo.
//
// Se probó capturar a 48 kHz nativo sin resamplear, por si el resampler era el
// culpable del retraso, y NO cambia nada: 2,60 s de retraso a los 20 s contra
// 2,69 s a 16 kHz, o sea empate, con el triple de bytes. Queda descartado.
const RATE = 16000;
const BYTES_POR_SEG = RATE * 2; // s16le mono

// La compuerta de silencio, y de dónde sale el número.
//
// Con el micrófono abierto sin que nadie hable, Whisper INVENTA. No es teoría:
// probando esto, un segundo de sala callada volvió como "¡Suscríbete!", y en
// otra corrida como "! las las las las las las". El
// `--condition-on-previous-text False` que usa el worker corta el bucle una vez
// que arrancó, pero no evita la primera frase. Lo único que la evita es no
// llamar al modelo.
//
// El umbral se midió con este micrófono y este mismo comando de ffmpeg:
//
//   sala callada, tres tomas de 6 s   RMS 0,0065 · 0,0107 · 0,0144  (-44 a -37 dBFS)
//   habla llegando al micrófono       RMS 0,078 a 0,089             (-21 dBFS)
//
// O sea que el piso de esta sala está bastante más arriba de lo que uno
// supondría —por eso el primer umbral, puesto a ojo en -52 dBFS, dejó pasar el
// "¡Suscríbete!"— y entre el ruido más fuerte y el habla más floja hay un
// factor de cinco. El umbral va en 0,02 (-34 dBFS): rechaza las tres tomas de
// sala con margen y acepta el habla con margen de sobra.
//
// Se eligió del lado ESTRICTO a propósito. Las dos fallas posibles no son
// igual de malas: si el umbral queda alto, alguien que habla bajito recibe
// "entró audio pero está en silencio (-38 dBFS)" y sabe qué tocar; si queda
// bajo, recibe "¡Suscríbete!" metido en la instrucción de su marcador y parece
// que la función está rota. Y para una sala más ruidosa o un micrófono más
// flojo está la variable de entorno.
const RMS_MINIMO = Number(process.env.HYPERPREMIERE_DICTADO_RMS) || 0.02;

// Cuánto dura la prueba de ⚙. Siete segundos alcanzan para decir una frase
// entera y ver la barra subir y bajar; menos, y el editor no llega a hablar.
const DURACION_PRUEBA_SEG = 7;
// Cada cuánto se manda una lectura al panel (10 por segundo), y sobre qué
// ventana se calcula: 200 ms es lo bastante corto para que la barra siga la
// voz y lo bastante largo para que no tiemble con cada sílaba.
const TICK_MS = 100;
const VENTANA_BYTES = Math.round(BYTES_POR_SEG * 0.2);

// El camino de arreglo del permiso de macOS, que es la causa más probable de
// que el micrófono "abra y no entregue nada", y la que el editor no puede
// adivinar: el diálogo del sistema NO nombra a HyperPremiere. El permiso lo
// pide Premiere como app anfitriona, así que dice "Adobe Premiere Pro 2026", y
// si alguna vez se le dijo que no, macOS no vuelve a preguntar.
const PERMISO_MACOS = 'Casi siempre es el permiso de micrófono de macOS, y tiene una trampa: ' +
  'el permiso lo pide PREMIERE, no el panel, así que el diálogo del sistema dice “Adobe Premiere Pro 2026”, ' +
  'y si alguna vez le dijiste que no, macOS no vuelve a preguntar. ' +
  'Andá a Ajustes del Sistema → Privacidad y seguridad → Micrófono, prendé Adobe Premiere Pro y reiniciá Premiere.';

// El ejecutable. Por nombre pelado, como en el resto del proyecto (engine.js
// ya le agrega Homebrew al PATH); la variable existe para los tests, que le
// ponen un ffmpeg de mentira, y para quien tenga uno fuera del PATH.
function ffmpegBin() {
  return process.env.HYPERPREMIERE_FFMPEG || 'ffmpeg';
}

// ---------------------------------------------------------------------------
// Lógica pura (lo que se prueba sin micrófono)
// ---------------------------------------------------------------------------

/** Los argumentos de captura. La ÚNICA función que los arma: dictado y prueba. */
function argsDeCaptura(entrada) {
  return ['-hide_banner', '-loglevel', 'error',
    '-f', 'avfoundation', '-i', String(entrada),
    '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'];
}

/** El comando entero como una línea, para el log. No lleva nada sensible. */
function comandoDeCaptura(entrada) {
  return [ffmpegBin()].concat(argsDeCaptura(entrada))
    .map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' ');
}

/** RMS de un bloque de PCM s16le mono, en escala 0..1. */
function rmsDePcm(buf) {
  if (!buf || buf.length < 2) return 0;
  let suma = 0;
  const n = Math.floor(buf.length / 2);
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2) / 32768;
    suma += v * v;
  }
  return Math.sqrt(suma / n);
}

/** Cuántas muestras de un bloque son cero EXACTO (no "casi cero": cero). */
function cerosDePcm(buf) {
  if (!buf || buf.length < 2) return 0;
  let ceros = 0;
  const n = Math.floor(buf.length / 2);
  for (let i = 0; i < n; i++) if (buf.readInt16LE(i * 2) === 0) ceros++;
  return ceros;
}

/** RMS lineal → dBFS, con el cero dicho en palabras y no como "-Infinity". */
function dbfs(rms) {
  if (!rms) return '-∞';
  return (20 * Math.log10(rms)).toFixed(1) + ' dBFS';
}

// La misma conversión pero en número, para la barra del panel. El cero
// absoluto se topa en -100 (no hay -∞ en JSON ni en un ancho de barra).
function dbfsNumero(rms) {
  if (!rms) return -100;
  return Math.max(-100, Math.round(20 * Math.log10(rms) * 10) / 10);
}

/**
 * La lista de dispositivos de audio que imprime `-list_devices`.
 *
 * Se mira la sección de AUDIO y nada más: la de video viene antes, con sus
 * propios índices desde cero, y confundirlas es abrir una cámara. No se
 * depende del prefijo de cada línea ("[AVFoundation indev @ 0x…]" hoy,
 * "[AVFoundation input device @ 0x…]" en versiones viejas): solo de la forma
 * `[N] nombre`, y el nombre se toma ENTERO hasta el final de la línea, con
 * paréntesis, tildes, guiones y lo que traiga.
 *
 * @returns {{dispositivos: Array<{indice:number, nombre:string}>, huboSeccion: boolean}}
 */
function parsearDispositivos(salida) {
  const dispositivos = [];
  let enAudio = false;
  let huboSeccion = false;
  for (const linea of String(salida || '').split(/\r?\n/)) {
    if (/AVFoundation audio devices:/i.test(linea)) { enAudio = true; huboSeccion = true; continue; }
    if (/AVFoundation video devices:/i.test(linea)) { enAudio = false; continue; }
    if (!enAudio) continue;
    const m = linea.match(/^\[[^\]]*\]\s*\[(\d+)\]\s+(.+?)\s*$/);
    if (!m) continue; // se terminó la lista: lo que sigue es el error de abrir ""
    dispositivos.push({ indice: Number(m[1]), nombre: m[2] });
  }
  return { dispositivos, huboSeccion };
}

/**
 * El nombre del dispositivo que macOS tiene como entrada por defecto, según
 * `system_profiler SPAudioDataType -json`. '' si no se pudo saber.
 */
function nombreDelDefaultEn(json) {
  try {
    const j = JSON.parse(String(json || ''));
    const grupos = Array.isArray(j.SPAudioDataType) ? j.SPAudioDataType : [];
    for (const g of grupos) {
      for (const it of (g._items || [])) {
        if (it.coreaudio_default_audio_input_device === 'spaudio_yes') return String(it._name || '');
      }
    }
  } catch (e) {}
  return '';
}

/**
 * Qué líneas de stderr son de ffmpeg de verdad. La de "CMIOMS:
 * EOSWebcamUtilityMain" la escribe un plugin de CoreMediaIO en cada arranque
 * de ffmpeg en esta máquina, con formato de NSLog (fecha, hora, "ffmpeg[pid:hilo]"),
 * y no es un error de nada. Sin este filtro, "no entró audio y stderr dice
 * algo" se dispara con el micrófono andando bien.
 */
function textoDeErrorDeFfmpeg(stderr) {
  return String(stderr || '').split(/\r?\n/)
    .filter((l) => l.trim() && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ ffmpeg\[\d+:\d+\]/.test(l))
    .join('\n').trim();
}

function hayErrorDeFfmpeg(stderr) {
  return textoDeErrorDeFfmpeg(stderr).length > 0;
}

/**
 * Qué dijo ffmpeg cuando no pudo abrir el micrófono, en palabras del editor.
 *
 * El orden importa: un índice que ya no existe también termina en "Input/output
 * error", así que si se mirara eso primero, desenchufar los auriculares se
 * diagnosticaría como un problema de permisos y mandaría al editor a Ajustes
 * del Sistema por nada.
 */
function leerErrorDeFfmpeg(salida, dispositivo) {
  const s = textoDeErrorDeFfmpeg(salida);
  const quien = dispositivo ? ' (' + dispositivo + ')' : '';
  if (/Invalid audio device index|Audio device not found|No AV capture device found/i.test(s)) {
    return 'ffmpeg no encontró el micrófono' + quien + ': se desenchufó o cambió de lugar en la lista. ' +
      'Refrescá la lista en ⚙ → Micrófono y elegilo de nuevo. Detalle de ffmpeg: ' + s.slice(-200);
  }
  if (/Input\/output error|Operation not permitted|not authorized|denied/i.test(s)) {
    return 'No pude abrir el micrófono' + quien + '. ' + PERMISO_MACOS + ' Detalle de ffmpeg: ' + s.slice(-200);
  }
  if (/No such|Input format|avfoundation/i.test(s)) {
    return 'ffmpeg no pudo abrir el micrófono' + quien + '. Elegí otro en ⚙ → Micrófono, o una entrada en ' +
      'Ajustes del Sistema → Sonido → Entrada. Detalle: ' + s.slice(-200);
  }
  return 'ffmpeg falló al abrir el micrófono' + quien + ': ' + (s.slice(-250) || '(no dijo nada)');
}

/**
 * De la elección guardada (un NOMBRE, o nada) a lo que se le pasa a ffmpeg.
 *
 * Función pura, y la decisión que más importa de este archivo: es la que
 * convierte "el micrófono que elegí ayer" en un índice de hoy, y la que decide
 * qué pasa cuando ese micrófono no está. Devuelve siempre algo abrible y dice
 * de dónde salió (`origen`) y qué hay que saber (`aviso`):
 *
 *   elegido           el nombre está en la lista → su índice de ahora
 *   default           no se eligió nada → `:default`, el de Ajustes → Sonido
 *   caida             se eligió uno que hoy no está → `:default`, avisando
 *   sin-dispositivos  la lista está vacía → `:default` igual, para que el error
 *                     lo dé ffmpeg con su texto y no una adivinanza nuestra
 *
 * @param {string} elegido - el nombre guardado en la config ('' = ninguno)
 * @param {Array<{indice:number,nombre:string}>} dispositivos - la lista fresca
 * @param {string} porDefecto - el nombre del default del sistema ('' si no se sabe)
 */
function resolverDispositivo(elegido, dispositivos, porDefecto) {
  const lista = Array.isArray(dispositivos) ? dispositivos : [];
  const nombre = String(elegido || '').trim();
  const def = String(porDefecto || '');
  const conNombre = (n) => lista.filter((d) => d.nombre === n);

  if (nombre) {
    const hits = conNombre(nombre);
    if (hits.length) {
      return {
        entrada: ':' + hits[0].indice, indice: hits[0].indice, nombre, elegido: nombre, origen: 'elegido',
        aviso: hits.length > 1
          ? 'Hay ' + hits.length + ' dispositivos que se llaman «' + nombre + '»; uso el primero (índice ' + hits[0].indice + ').'
          : '',
      };
    }
  }

  const delSistema = conNombre(def)[0];
  const r = {
    entrada: ':default',
    indice: delSistema ? delSistema.indice : -1,
    nombre: def || 'el que macOS tenga como entrada por defecto',
    elegido: nombre,
    origen: nombre ? 'caida' : 'default',
    aviso: '',
  };
  const cual = def
    ? '«' + def + '»' + (delSistema ? ' (índice ' + delSistema.indice + ')' : '')
    : 'el que figure en Ajustes del Sistema → Sonido → Entrada (no pude averiguar cuál)';
  if (!lista.length) {
    r.origen = 'sin-dispositivos';
    r.aviso = 'ffmpeg no encontró ningún dispositivo de entrada de audio en esta máquina. ' +
      'Conectá un micrófono y refrescá la lista en ⚙ → Micrófono.';
  } else if (nombre) {
    r.aviso = 'El micrófono elegido, «' + nombre + '», no está conectado ahora. Uso el que macOS tiene por defecto: ' +
      cual + '. Conectalo y refrescá la lista, o elegí otro en ⚙ → Micrófono.';
  } else {
    r.aviso = 'Todavía no elegiste micrófono: uso el que macOS tiene como entrada por defecto, ' +
      cual + '. Se elige en ⚙ → Micrófono.';
  }
  return r;
}

/** Una línea para el log: qué dispositivo, qué índice, de dónde salió. */
function describir(usa) {
  const u = usa || {};
  const origen = {
    elegido: 'elegido en ⚙',
    default: 'el del sistema, sin elección en ⚙',
    caida: 'el del sistema, porque el elegido «' + (u.elegido || '?') + '» no está',
    'sin-dispositivos': 'sin dispositivos en la lista',
  }[u.origen] || u.origen || '?';
  return '«' + (u.nombre || '?') + '» (' + (u.indice >= 0 ? 'índice ' + u.indice : 'índice desconocido') +
    ', ' + origen + ', entrada ' + (u.entrada || '?') + ')';
}

/** La lista para el log, en una línea. */
function resumenDeLista(lista) {
  const l = lista || {};
  const d = (l.dispositivos || []).map((x) => '[' + x.indice + '] ' + x.nombre).join(' · ') || '(ninguno)';
  return d + ' · por defecto del sistema: ' + (l.porDefecto ? '«' + l.porDefecto + '»' : 'no se pudo averiguar');
}

/**
 * El veredicto de la prueba, en palabras. Función pura sobre lo medido.
 *
 * Los cinco estados y por qué no son cuatro: "abrió pero no entrega nada"
 * tiene dos formas distintas, las dos medidas acá, y se diagnostican distinto.
 * El iPhone lejos no entrega NI UNA muestra en 3,5 s; los dispositivos
 * virtuales y el micrófono con el permiso negado entregan muestras a ritmo
 * normal, todas en cero exacto.
 *
 * @param {{bytes:number, segundos:number, duracion:number, rmsGlobal:number, pico:number,
 *          cerosPct:number, errorFfmpeg:string, dispositivo:object, umbral:number}} m
 * @returns {{estado:string, titulo:string, detalle:string}}
 */
function veredictoDePrueba(m) {
  const d = (m && m.dispositivo) || {};
  const quien = '«' + (d.nombre || '?') + '»' + (d.indice >= 0 ? ' (índice ' + d.indice + ')' : '');
  const umbral = m.umbral || RMS_MINIMO;
  const dur = Number(m.duracion || 0).toFixed(0);
  const seg = Number(m.segundos || 0).toFixed(1);
  const sonido = 'Ajustes del Sistema → Sonido → Entrada';

  if (!m.bytes && m.errorFfmpeg) {
    return {
      estado: 'no-abre',
      titulo: 'No pude abrir ' + quien + '.',
      detalle: leerErrorDeFfmpeg(m.errorFfmpeg, d.nombre),
    };
  }
  if (!m.bytes) {
    return {
      estado: 'sin-muestras',
      titulo: quien + ' abrió pero no entregó ni una muestra en ' + dur + ' s.',
      detalle: 'Pasa con un micrófono que figura en la lista pero no está disponible de verdad —el del iPhone por ' +
        'Continuidad cuando el teléfono no está cerca, medido acá— y cuando otra app lo tiene tomado. ' +
        PERMISO_MACOS + ' Si no es eso, elegí otro de la lista en ⚙ → Micrófono.',
    };
  }
  if (m.cerosPct >= 99.5) {
    return {
      estado: 'silencio-digital',
      titulo: quien + ' entrega audio, pero es silencio digital: ' + seg + ' s de muestras y todas en cero exacto.',
      detalle: 'El dispositivo abrió y no está mandando señal. ' + PERMISO_MACOS +
        ' También pasa si el micrófono lo tiene tomado otra app, o si es un dispositivo virtual ' +
        '(Zoom, Steam, OBS…) que figura como entrada pero no es un micrófono: elegí otro en ⚙ → Micrófono.',
    };
  }
  if (m.rmsGlobal >= umbral) {
    return {
      estado: 'ok',
      titulo: 'Entra audio por ' + quien + ' y pasa la compuerta del dictado.',
      detalle: 'Promedio ' + dbfs(m.rmsGlobal) + ', pico ' + dbfs(m.pico) + '; la compuerta está en ' +
        dbfs(umbral) + '. Podés dictar.',
    };
  }
  if (m.pico >= umbral) {
    return {
      estado: 'floja',
      titulo: 'Hubo voz por ' + quien + ', pero la prueba quedó floja en promedio.',
      detalle: 'El pico llegó a ' + dbfs(m.pico) + ' y pasa la compuerta (' + dbfs(umbral) + '), pero el promedio de los ' +
        dur + ' s quedó en ' + dbfs(m.rmsGlobal) + ', por debajo. El dictado mira el promedio de todo lo grabado, ' +
        'así que hablá seguido mientras dictás y más cerca del micrófono, o subí el volumen de entrada en ' + sonido + '.',
    };
  }
  return {
    estado: 'floja',
    titulo: 'Entra señal por ' + quien + ', pero muy floja.',
    detalle: 'Promedio ' + dbfs(m.rmsGlobal) + ', pico ' + dbfs(m.pico) + '; el dictado necesita pasar ' + dbfs(umbral) + '. ' +
      'Si estabas hablando, subí el volumen de entrada en ' + sonido + ', acercate, o probá otro micrófono de la lista. ' +
      'Si no hablaste durante la prueba, esto es el ruido de la sala y está bien que quede abajo de la compuerta: repetila hablando.',
  };
}

// ---------------------------------------------------------------------------
// La máquina: listar y resolver
// ---------------------------------------------------------------------------

async function porDefectoDelSistema() {
  if (process.platform !== 'darwin') return '';
  const r = await run('system_profiler', ['SPAudioDataType', '-json'], { timeoutMs: 8000 });
  return r.code === 0 ? nombreDelDefaultEn(r.out) : '';
}

/**
 * La lista fresca de dispositivos de entrada, con el default del sistema
 * marcado. Nunca lanza: si no se pudo, `ok:false` con el motivo y la salida
 * cruda de ffmpeg, que es lo que hace falta para diagnosticar desde lejos.
 */
async function listarDispositivos() {
  const [r, porDefecto] = await Promise.all([
    run(ffmpegBin(), ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { timeoutMs: 15_000 }),
    porDefectoDelSistema(),
  ]);
  const crudo = (String(r.err || '') + String(r.out || '')).trim();
  const p = parsearDispositivos(crudo);
  // code -1 es "no arrancó o venció el tiempo" (el ffmpeg real sale con 251
  // aunque la lista haya salido bien, así que el código solo importa acá).
  if (r.code === -1 && !p.huboSeccion) {
    return {
      ok: false, dispositivos: [], porDefecto, crudo,
      error: 'No pude correr ffmpeg para listar los micrófonos' + (r.err ? ' (' + String(r.err).trim().slice(0, 160) + ')' : '') +
        '. Es lo que abre el micrófono: instalalo con `brew install ffmpeg` y recargá el panel.',
    };
  }
  if (!p.huboSeccion) {
    return {
      ok: false, dispositivos: [], porDefecto, crudo,
      error: 'ffmpeg no devolvió la lista de dispositivos de audio de avfoundation: no encontré la sección ' +
        '"AVFoundation audio devices" en lo que escribió. La salida cruda va al log.',
    };
  }
  return { ok: true, dispositivos: p.dispositivos, porDefecto, crudo };
}

/**
 * Lo que necesita quien va a abrir el micrófono: la lista fresca y el
 * dispositivo resuelto a partir de la elección guardada en la config.
 */
async function dispositivoEnUso(cfg) {
  const lista = await listarDispositivos();
  if (!lista.ok) return { ok: false, error: lista.error, crudo: lista.crudo, dispositivos: [], porDefecto: lista.porDefecto };
  const usa = resolverDispositivo(cfg && cfg.microfono, lista.dispositivos, lista.porDefecto);
  return { ok: true, usa, dispositivos: lista.dispositivos, porDefecto: lista.porDefecto };
}

/**
 * Handler de ⚙: la lista para el desplegable, marcando el default del sistema
 * y diciendo cuál se usaría ahora mismo con la elección guardada.
 */
async function microfonoListar(cfg) {
  const r = await dispositivoEnUso(cfg);
  const elegido = String((cfg && cfg.microfono) || '').trim();
  if (!r.ok) return { ok: false, error: r.error, crudo: r.crudo, dispositivos: [], porDefecto: r.porDefecto, elegido };
  return {
    ok: true,
    dispositivos: r.dispositivos.map((d) => ({ indice: d.indice, nombre: d.nombre, porDefecto: d.nombre === r.porDefecto })),
    porDefecto: r.porDefecto,
    elegido,
    usa: r.usa,
  };
}

// ---------------------------------------------------------------------------
// La prueba con medidor
// ---------------------------------------------------------------------------

let prueba = null;

/** ¿Hay una prueba de micrófono andando? (el dictado no puede arrancar encima) */
function pruebaEnCurso() { return Boolean(prueba); }

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Abre el micrófono elegido con el comando del dictado y durante unos segundos
 * manda el nivel al panel; al final, el veredicto en palabras.
 *
 * `prog` es el sobre de progreso del motor (ver engine-client.js). Lo que
 * manda esto:
 *   - `msg`       → la etapa (buscando, abriendo, escuchando).
 *   - `microfono` → el dispositivo resuelto, apenas se sabe cuál es.
 *   - `nivel`     → { dbfs, picoDbfs, umbralDbfs, pasa, segundos }, ~10 por segundo.
 *   - `note`      → al ⬇ Log: la lista, el dispositivo, el comando, el resumen
 *                   de niveles, el veredicto y el stderr de ffmpeg si lo hubo.
 *
 * Devuelve `{ ok:true, estado, titulo, detalle, dispositivo, resumen, stderr }`
 * cuando la prueba pudo correr —aunque el veredicto sea malo— y `{ ok:false,
 * error }` solo si ni siquiera se pudo intentar.
 */
async function probarMicrofono(body, prog, cfg) {
  const informar = typeof prog === 'function' ? prog : function () {};
  // El panel no manda `segundos`; el tope de abajo es para que los tests no
  // esperen siete segundos por prueba.
  const duracion = Math.min(20, Math.max(0.5, Number((body && body.segundos) || DURACION_PRUEBA_SEG)));

  if (prueba) return { ok: false, error: 'Ya hay una prueba de micrófono andando. Esperá a que termine.' };
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'La prueba de micrófono, como el dictado, es solo para Mac por ahora: la captura usa avfoundation.' };
  }
  // Ocupado desde YA, antes de la primera espera: listar los dispositivos
  // tarda unas décimas, y dos clics seguidos abrirían dos ffmpeg sobre el
  // mismo micrófono.
  prueba = { t0: Date.now() };
  try {
    return await correrPrueba(informar, duracion, cfg);
  } finally {
    prueba = null;
  }
}

async function correrPrueba(informar, duracion, cfg) {
  informar({ msg: 'Buscando los micrófonos…' });
  const lista = await listarDispositivos();
  if (!lista.ok) {
    informar({ note: 'Prueba de micrófono: ' + lista.error + (lista.crudo ? '\n' + lista.crudo : ''), level: 'ERROR' });
    return { ok: false, error: lista.error, crudo: lista.crudo };
  }
  informar({ note: 'Prueba de micrófono · dispositivos: ' + resumenDeLista(lista) });
  const usa = resolverDispositivo(cfg && cfg.microfono, lista.dispositivos, lista.porDefecto);
  informar({
    note: 'Prueba de micrófono · uso ' + describir(usa) + (usa.aviso ? ' · ' + usa.aviso : ''),
    level: usa.origen === 'caida' || usa.origen === 'sin-dispositivos' ? 'WARN' : 'INFO',
  });
  informar({ microfono: usa, msg: 'Abriendo «' + usa.nombre + '»…' });
  informar({ note: 'Prueba de micrófono · comando: ' + comandoDeCaptura(usa.entrada) });

  const t0 = Date.now();
  // Líder de grupo, para que killTree se lleve el árbol entero (ver exec.js).
  const ff = startProcess(ffmpegBin(), argsDeCaptura(usa.entrada));
  const trozos = [];
  let errFf = '';
  let primerByteMs = 0;
  let cerro = false;
  ff.stdout.on('data', (c) => { if (!primerByteMs) primerByteMs = Date.now() - t0; trozos.push(c); });
  ff.stderr.on('data', (c) => { errFf += c; });
  const finDeFf = new Promise((r) => {
    ff.on('close', () => { cerro = true; r(); });
    ff.on('error', (e) => { cerro = true; errFf += '\n' + ((e && e.message) || e); r(); });
  });

  const lecturas = [];
  let pico = 0;
  let ceros = 0;
  let muestras = 0;
  let contados = 0;
  let avisoEscuchando = false;
  try {
    while (Date.now() - t0 < duracion * 1000 && !cerro) {
      await esperar(TICK_MS);
      const buf = Buffer.concat(trozos);
      if (buf.length > contados) {
        ceros += cerosDePcm(buf.slice(contados));
        muestras += Math.floor((buf.length - contados) / 2);
        contados = buf.length;
      }
      if (buf.length >= VENTANA_BYTES) {
        if (!avisoEscuchando) {
          avisoEscuchando = true;
          informar({ msg: 'Escuchando por «' + usa.nombre + '»… hablá normal, como si dictaras.' });
        }
        const rms = rmsDePcm(buf.slice(buf.length - VENTANA_BYTES));
        if (rms > pico) pico = rms;
        lecturas.push(rms);
        informar({
          nivel: {
            dbfs: dbfsNumero(rms), picoDbfs: dbfsNumero(pico), umbralDbfs: dbfsNumero(RMS_MINIMO),
            pasa: rms >= RMS_MINIMO, segundos: (Date.now() - t0) / 1000, duracion,
          },
        });
      } else if (!buf.length && hayErrorDeFfmpeg(errFf) && Date.now() - t0 > 1500) {
        break; // no abrió: no tiene sentido esperar los siete segundos
      }
    }
  } finally {
    try { killTree(ff); } catch (e) {}
  }
  await Promise.race([finDeFf, esperar(700)]);

  const buf = Buffer.concat(trozos);
  const rmsGlobal = rmsDePcm(buf);
  const cerosPct = muestras ? (100 * ceros / muestras) : 0;
  const enDb = lecturas.map(dbfsNumero);
  const resumen = {
    bytes: buf.length,
    segundos: Math.round(buf.length / BYTES_POR_SEG * 100) / 100,
    duracion,
    primerByteMs,
    lecturas: lecturas.length,
    minDbfs: enDb.length ? Math.min.apply(null, enDb) : null,
    maxDbfs: enDb.length ? Math.max.apply(null, enDb) : null,
    promedioDbfs: enDb.length ? Math.round(enDb.reduce((a, b) => a + b, 0) / enDb.length * 10) / 10 : null,
    globalDbfs: dbfs(rmsGlobal),
    picoDbfs: dbfs(pico),
    umbralDbfs: dbfs(RMS_MINIMO),
    cerosPct: Math.round(cerosPct * 10) / 10,
  };
  const errorFfmpeg = textoDeErrorDeFfmpeg(errFf);
  const v = veredictoDePrueba({
    bytes: buf.length, segundos: resumen.segundos, duracion, rmsGlobal, pico, cerosPct,
    errorFfmpeg, dispositivo: usa, umbral: RMS_MINIMO,
  });

  informar({
    note: 'Prueba de micrófono · resumen: ' + resumen.segundos + ' s de audio (' + resumen.bytes + ' bytes, primer byte a los ' +
      resumen.primerByteMs + ' ms) · ' + resumen.lecturas + ' lecturas · mín ' +
      (resumen.minDbfs === null ? '—' : resumen.minDbfs + ' dBFS') + ' · máx ' +
      (resumen.maxDbfs === null ? '—' : resumen.maxDbfs + ' dBFS') + ' · promedio de lecturas ' +
      (resumen.promedioDbfs === null ? '—' : resumen.promedioDbfs + ' dBFS') + ' · global ' + resumen.globalDbfs +
      ' · pico ' + resumen.picoDbfs + ' · compuerta ' + resumen.umbralDbfs + ' · muestras en cero ' + resumen.cerosPct + '%',
  });
  informar({
    note: 'Prueba de micrófono · veredicto (' + v.estado + '): ' + v.titulo + ' ' + v.detalle,
    level: v.estado === 'ok' ? 'INFO' : (v.estado === 'floja' ? 'WARN' : 'ERROR'),
  });
  const stderr = String(errFf || '').trim();
  if (stderr) informar({ note: 'Prueba de micrófono · stderr de ffmpeg, tal cual:\n' + stderr, level: v.estado === 'ok' ? 'INFO' : 'WARN' });

  return { ok: true, estado: v.estado, titulo: v.titulo, detalle: v.detalle, dispositivo: usa, resumen, stderr };
}

module.exports = {
  RATE, BYTES_POR_SEG, RMS_MINIMO, DURACION_PRUEBA_SEG,
  ffmpegBin,
  argsDeCaptura,
  comandoDeCaptura,
  rmsDePcm,
  dbfs,
  dbfsNumero,
  hayErrorDeFfmpeg,
  leerErrorDeFfmpeg,
  listarDispositivos,
  dispositivoEnUso,
  describir,
  resumenDeLista,
  microfonoListar,
  probarMicrofono,
  pruebaEnCurso,
  // Expuestos para los tests: son las decisiones puras de este archivo.
  _parsearDispositivos: parsearDispositivos,
  _nombreDelDefaultEn: nombreDelDefaultEn,
  _resolverDispositivo: resolverDispositivo,
  _veredictoDePrueba: veredictoDePrueba,
  _textoDeErrorDeFfmpeg: textoDeErrorDeFfmpeg,
  _cerosDePcm: cerosDePcm,
};
