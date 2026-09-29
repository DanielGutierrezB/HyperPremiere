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
//   ext           Extensión del archivo de composición ('.html', '.tsx').
//   lenguaje      Cómo resaltarlo en el editor del panel (Prism: 'markup'|'tsx').
//   fence         Con qué se abre el bloque de código en un prompt ('html', 'tsx').
//   comoSeLlama   "el HTML" / "el componente": entra en los mensajes al editor.
//
//   comentario(texto)                   El texto como comentario en SU lenguaje.
//   systemPrompt()                      El system prompt completo del motor.
//   bloqueDeContrato(durationSec)       Recordatorio del contrato en el prompt de usuario.
//   bloqueDeAssets(infos)               Cómo se incrustan las imágenes provistas.
//   bloqueDeFondo()                     Qué significa "con fondo" en este motor.
//   recordatorioFinal()                 El contrato repetido al final (proveedores sin system real).
//   promptDeArreglo(userPrompt, code, problema, durationSec)
//                                       Pedido de arreglo DIRIGIDO sobre su propio código.
//   textoDeProblema(problema)           Cómo se le dice al editor y al modelo.
//
//   revisar(code, { durationSec, markerSlug })
//       → { code, fixes, problema, duration }
//       Completa en código lo que se pueda (sin gastar una llamada) y dice qué
//       quedó mal. `problema` es un código (abajo), no una frase.
//
//   renderizar({ code, outPath, durationSec, onProgress, format, assetsDir })
//       → Promise<void>. `format` es 'mov' (alpha) o 'mp4' (con fondo).
//
//   estado()   → { instalado: boolean, motivo: string }  (¿se puede usar acá?)
//   instalar(onProgress) → Promise<{ ok, mensaje }>      (opcional)
//
//   vistaPrevia({ code, durationSec, format, etiqueta })  (OPCIONAL)
//       → Promise<{ ok, url, arrancado }>. Reproducir la composición en vivo,
//       sin renderizar. Es opcional porque no todo motor puede: HyperFrames pide
//       su timeline PAUSADA para capturarla cuadro por cuadro, así que abrir ese
//       HTML muestra el primer cuadro y nada más. Quien la ofrezca pregunta si
//       existe en vez de suponerlo.
//   cerrarVistaPrevia()      → { ok, andaba }
//   estadoDeVistaPrevia()    → { andando, url, etiqueta }
//
// ── La regla que no se puede romper ──────────────────────────────────
//
// El motor NO sabe nada del proyecto, del marcador ni de la cola. Recibe código
// y devuelve video. Todo lo que huela a "dónde va este clip" vive en engine.js.

'use strict';

// El motor de siempre: el que usa todo lo que no dice cuál usa.
const PREDETERMINADO = 'hyperframes';

// Los problemas que puede tener una composición, sea del motor que sea.
//
// Son códigos y no frases porque los lee gente distinta: el prompt de arreglo
// (que le habla al modelo), el log del panel (que le habla al editor) y los
// tests. Cada motor usa los que le aplican y puede no usar ninguno de los
// otros: `no-stage` no significa nada en Remotion, igual que `sin-componente`
// no significa nada en HyperFrames.
//
// El único que TODOS comparten es el primero, y por eso vive acá: quien
// orquesta corta distinto cuando el modelo no compuso nada (ver compose.js).
const PROBLEMA = {
  // No es una composición: el modelo contestó en prosa. Es de otra especie que
  // los demás —no le falta andamiaje, no hay nada que arreglar—.
  // El valor es 'not-html' y no 'no-es-codigo' por compatibilidad: así se llamó
  // desde que existe y viaja en los errores que el panel ya sabe leer.
  NO_ES_CODIGO: 'not-html',
};

const registro = new Map();

/** Anota un motor en el registro. Lo llaman los módulos de cada motor al cargarse. */
function registrar(motor) {
  if (!motor || !motor.id) throw new Error('registrar: un motor necesita `id`');
  registro.set(motor.id, motor);
  return motor;
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
  registro.forEach((m) => { if (out.indexOf(m.ext) === -1) out.push(m.ext); });
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
      st = m.estado ? m.estado() : { instalado: true, motivo: '' };
    } catch (e) {
      // Preguntar si un motor está instalado toca el disco. Que eso tire no
      // puede dejar sin desplegable a los otros.
      st = { instalado: false, motivo: (e && e.message) || String(e) };
    }
    return {
      id: id,
      nombre: m.nombre || id,
      ext: m.ext,
      lenguaje: m.lenguaje,
      instalado: !!st.instalado,
      motivo: st.motivo || '',
      instalable: typeof m.instalar === 'function',
    };
  });
}

module.exports = {
  PROBLEMA, PREDETERMINADO,
  registrar, motor, motorDeFicha, ids, existe, extensiones, catalogo,
  // Solo para los tests: saca un motor del registro. Existe porque una de las
  // cosas que hay que probar es qué pasa cuando el chequeo de instalación de UN
  // motor se cae, y eso se prueba registrando uno que tire — que después hay
  // que sacar, o el catálogo queda con un motor roto para el resto de la
  // corrida y los tests siguientes miden otra cosa.
  _olvidar: (id) => registro.delete(String(id || '').trim().toLowerCase()),
};
