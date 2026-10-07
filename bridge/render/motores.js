// LOS MOTORES DE ANIMACIÓN, y la interfaz que los hace intercambiables.
//
// ── Por qué existe ───────────────────────────────────────────────────
//
// Hasta la 1.7.0 el panel tenía UN motor —HyperFrames: un HTML autocontenido
// animado con GSAP— y esa decisión estaba repartida por todo el pipeline: el
// system prompt hablaba de `#stage` y `data-duration`, el validador buscaba la
// timeline en `window.__timelines`, el archivo de cada versión era `.html`, el
// editor manual resaltaba con Prism en modo `markup` y el render era un
// `require('./render/hyperframes')` pelado en engine.js.
//
// Agregar Remotion no es "otro renderer": es OTRO LENGUAJE de composición (React
// en vez de HTML), otro contrato para el modelo, otra validación y otra
// extensión de archivo. Si cada una de esas decisiones se hubiera resuelto con
// un `if (motor === 'remotion')` en su lugar, serían nueve ifs en siete archivos
// y el tercer motor tendría que encontrarlos todos.
//
// Acá está la pregunta al revés: el pipeline le PIDE al motor lo que necesita
// saber. Quien orquesta no sabe si está tratando con HTML o con TSX.
//
// ── Qué es un motor ──────────────────────────────────────────────────
//
// Un objeto con esta forma. Todo lo que el resto del panel necesita preguntar
// sobre "cómo se escribe y cómo se renderiza una animación" está acá:
//
//   id            'hyperframes' | 'remotion'
//   nombre        Cómo se llama para un editor.
//   lenguaje      En qué idioma se escribe: extensión, fence, gramática de Prism,
//                 cómo se lo nombra y cómo se comenta. Ver lenguajes.js.
//
//   esCodigo(code) → boolean            ¿Es código de este motor, o es prosa?
//   duracionDeclarada(code) → number    Cuántos segundos DICE durar, o 0.
//
//       Cero no es un error: en Remotion la duración NO está en el código por
//       diseño (se lee con `useVideoConfig()`), así que la respuesta honesta es
//       "no lo dice". Lo pide la pestaña Corrections para los recursos viejos a
//       los que les falta la ficha, y es la última fuente de la cascada — la
//       peor, porque la posición no se puede recuperar de ahí, solo el largo.
//   systemPrompt()                      El system prompt completo del motor.
//   reglas                              Las reglas de SU contrato, una por renglón.
//   duracionEnElPedido(durationSec)     Cómo se le pide la duración (declararla o leerla).
//   bloqueDeAssets(infos)               Cómo se incrustan las imágenes provistas.
//   bloqueDeFondo()                     Qué significa "con fondo" en este motor.
//   textoDeProblema(problema)           Cómo se le dice al editor y al modelo.
//
//       El contrato se le dice al modelo en TRES lugares —el checklist del
//       pedido, el recordatorio del final y el pedido de arreglo— y los tres se
//       componen de `reglas` en `prompt/contrato.js`. Antes eran tres métodos
//       con su prosa escrita a mano, o sea las mismas cuatro reglas tipeadas
//       seis veces entre los dos motores: agregar una a uno y olvidarla en otro
//       no fallaba, dejaba a los proveedores sin system prompt con un contrato
//       incompleto.
//
//   revisar(code, { durationSec, markerSlug })
//       → { code, fixes, problema, detalle? }
//       Dado que YA es código (ver `esCodigo`), ¿cumple el contrato de este
//       motor? Completa lo que se pueda sin gastar una llamada y dice qué quedó
//       mal. `problema` es un código del propio motor, no una frase; `detalle`
//       es opcional y dice cuál —qué import sobra, qué línea no compila—.
//
//       Son dos métodos y no uno a propósito. `esCodigo` es barata y sintáctica;
//       esto es caro (en Remotion compila con Babel). Juntas, preguntar "¿esto
//       es prosa?" compilaba el archivo entero: `lastComposition` camina para
//       atrás por las versiones previas y pagaba una compilación por cada una.
//
//   renderizar({ code, outPath, durationSec, onProgress, format, assetsDir })
//       → Promise<void>. `format` es 'mov' (alpha) o 'mp4' (con fondo).
//
//   estado()   → { instalado: boolean, motivo: string }  (¿se puede usar acá?)
//   instalar(onProgress) → Promise<{ ok, mensaje }>      (opcional)
//
//   vistaPrevia({ code, durationSec, format, etiqueta, destino?, assetsDir?, alTerminar? })
//       (OPCIONAL) → Promise<{ ok, url, arrancado }>. Reproducir la composición
//       en vivo, sin renderizar. Es opcional porque no todo motor puede:
//       HyperFrames pide su timeline PAUSADA para capturarla cuadro por cuadro,
//       así que abrir ese HTML muestra el primer cuadro y nada más. Quien la
//       ofrezca pregunta si existe en vez de suponerlo. Con `destino` y
//       `alTerminar`, lo que se renderice DESDE la vista previa vuelve como
//       versión de ese marcador (ver remotion-studio.js).
//   escucharVistaPrevia(fn)  → Promise<{ ok, terminado }>: `fn(aviso)` por cada
//       render hecho desde la vista previa, hasta que se cierre.
//   cerrarVistaPrevia()      → { ok, andaba }
//   estadoDeVistaPrevia()    → { andando, url, etiqueta, renderizando }
//
// ── La regla que no se puede romper ──────────────────────────────────
//
// El motor NO sabe nada del proyecto, del marcador ni de la cola. Recibe código
// y devuelve video. Todo lo que huela a "dónde va este clip" vive en engine.js.

'use strict';

// El motor de siempre: el que usa todo lo que no dice cuál usa.
const PREDETERMINADO = 'hyperframes';

// Acá vivió un enum `PROBLEMA` de UN solo miembro —"esto no es código"— y no
// está más. Existía nada más para que `project-fs` y `compose` pudieran comparar
// contra él, y el precio era alto: el mismo literal escrito en tres archivos que
// no se referenciaban entre sí, sostenido por convención. Si alguien cambiaba
// uno, `compose.js` dejaba de matchear EN SILENCIO y la prosa se guardaba como
// una versión — que es exactamente el desastre que sus comentarios narran.
//
// Ahora la pregunta se hace con `motor.esCodigo(code)`, que devuelve un booleano
// y no se puede desalinear. Los códigos de problema que quedan son de CADA
// motor, que es donde tenían que estar: `no-stage` no significa nada en Remotion
// y `sin-export-default` no significa nada en HyperFrames.

const registro = new Map();

/**
 * Lo que un motor no dice, dicho por él.
 *
 * Están acá y no en cada llamador porque eran cuatro `typeof x === 'function'`
 * repartidos —uno en `catalogo()` y tres en `engine.js`— cada uno con su rama y
 * uno con su `try/catch`. Un motor que tiene una forma GARANTIZADA no necesita
 * que le pregunten si implementó algo: los que no lo hacen contestan lo que
 * corresponde y el llamador queda con un solo camino.
 *
 * `null` y no una función para `vistaPrevia` e `instalar` a propósito: ahí el
 * llamador SÍ tiene que cortar distinto (no hay nada que ofrecer), y un `null`
 * lo dice sin obligar a nadie a escribir una función que no hace nada.
 */
const PORDEFECTO = {
  // Viene con el panel: no hay nada que instalar ni que chequear.
  estado: () => ({ instalado: true, motivo: '' }),
  instalar: null,
  // Sin vista previa, y el motivo lo escribe el MOTOR. Antes el motivo de
  // HyperFrames vivía en `engine.js` —o sea que el orquestador sabía qué es
  // `window.__timelines` y por qué GSAP pausado no se puede reproducir—, que es
  // justo el conocimiento que el registro existe para sacarle de encima.
  vistaPrevia: null,
  motivoSinVistaPrevia: '',
  cerrarVistaPrevia: () => ({ ok: true, andaba: false }),
  // Los renders hechos DESDE la vista previa (el botón Render de Studio). Sin
  // vista previa no hay de dónde salgan: se contesta que no hay nada que escuchar.
  escucharVistaPrevia: () => Promise.resolve({ ok: true, terminado: 'este motor no tiene vista previa' }),
  // Cuántos segundos dice durar el código. Cero = no lo dice, que en Remotion es
  // la verdad y no una falta.
  duracionDeclarada: () => 0,
};

/** Anota un motor en el registro. Lo llaman los módulos de cada motor al cargarse. */
function registrar(motor) {
  if (!motor || !motor.id) throw new Error('registrar: un motor necesita `id`');
  const completo = Object.assign({}, PORDEFECTO, motor);
  registro.set(completo.id, completo);
  return completo;
}

/**
 * El motor con ese id.
 *
 * Un id desconocido cae en HyperFrames en vez de tirar, y es a propósito: este
 * id viaja en la ficha de cada versión y en la config del disco, o sea que
 * puede venir de una versión del panel MÁS NUEVA (un editor que probó un motor
 * que después se sacó) o simplemente mal escrito a mano. Ninguna de las dos
 * cosas puede dejar a alguien sin poder abrir su propio proyecto: lo peor que
 * puede pasar es que una versión vieja se ofrezca a re-renderizarse con el
 * motor que siempre estuvo.
 */
function motor(id) {
  const key = String(id || '').trim().toLowerCase();
  return registro.get(key) || registro.get(PREDETERMINADO);
}

/**
 * El motor con el que se hizo una versión que YA existe.
 *
 * Una ficha SIN el campo `engine` es de antes de que hubiera dos motores, o sea
 * HyperFrames. Que la ausencia signifique eso —y no "no sé"— es lo que hace que
 * todo lo generado hasta hoy siga abriéndose, refinándose y re-renderizándose
 * igual, sin migrar un solo archivo.
 */
function motorDeFicha(meta) {
  return motor((meta && meta.engine) || PREDETERMINADO);
}

/** ¿El panel conoce este id? (para no guardar en la config un motor que no existe) */
function existe(id) {
  return registro.has(String(id || '').trim().toLowerCase());
}

/** Los ids de los motores que este panel conoce, en el orden en que se ofrecen. */
function ids() {
  return Array.from(registro.keys());
}

/** Las extensiones de composición de TODOS los motores ('.html', '.tsx'). */
function extensiones() {
  const out = [];
  registro.forEach((m) => { if (out.indexOf(m.lenguaje.ext) === -1) out.push(m.lenguaje.ext); });
  return out;
}

/**
 * Qué motores hay y en qué estado, para el desplegable de ⚙.
 *
 * Incluye a los que NO están instalados: esconderlos dejaría al editor sin
 * manera de descubrir que Remotion existe, y el botón de instalarlo vive
 * justamente al lado del que no está.
 */
function catalogo() {
  return ids().map((id) => {
    const m = registro.get(id);
    let st;
    try {
      st = m.estado();
    } catch (e) {
      // Preguntar si un motor está instalado toca el disco. Que eso tire no
      // puede dejar sin desplegable a los otros.
      st = { instalado: false, motivo: (e && e.message) || String(e) };
    }
    return {
      id: id,
      nombre: m.nombre || id,
      ext: m.lenguaje.ext,
      lenguaje: m.lenguaje.prism,
      instalado: !!st.instalado,
      motivo: st.motivo || '',
      instalable: !!m.instalar,
    };
  });
}

module.exports = {
  PREDETERMINADO,
  registrar, motor, motorDeFicha, ids, existe, extensiones, catalogo,
  // Solo para los tests: saca un motor del registro. Existe porque una de las
  // cosas que hay que probar es qué pasa cuando el chequeo de instalación de UN
  // motor se cae, y eso se prueba registrando uno que tire — que después hay
  // que sacar, o el catálogo queda con un motor roto para el resto de la
  // corrida y los tests siguientes miden otra cosa.
  _olvidar: (id) => registro.delete(String(id || '').trim().toLowerCase()),
};
