// El motor HYPERFRAMES: un HTML autocontenido animado con GSAP, capturado
// cuadro por cuadro por el CLI de hyperframes.
//
// Es el motor de siempre y lo que hay acá es CABLEADO, no lógica nueva: el
// render vive en `hyperframes.js` (con sus perfiles medidos por máquina y su
// escalera de GPU) y el contrato de la composición en `composition.js`. Este
// archivo es el que los presenta con la forma que pide `motores.js`.
//
// Lo que sí se MUDÓ acá, y vale decir de dónde vino: los pedazos del prompt que
// hablan de `#stage`, `data-duration` y `window.__timelines` estaban repartidos
// en tres archivos que no tenían por qué saber de GSAP —`engine.js`
// (`bloqueDeAssets`, `bloqueDeFondo`), `prompt/build-context.js` (el bloque de
// contrato) y `providers/index.js` (el recordatorio final)—. Mientras hubo un
// solo motor daba igual dónde vivieran; con dos, cada uno de esos textos es una
// respuesta que depende de cuál se esté usando.

'use strict';

const fs = require('fs');
const path = require('path');

const { renderComposition } = require('./hyperframes');
const { inspectComposition, esComposicionHtml, PROBLEM } = require('../composition');
const { registrar } = require('./motores');
const lenguajes = require('./lenguajes');
const { systemPrompt } = require('../prompt/system');

// Qué decirle al modelo (y al editor) por cada cosa que no se pudo completar en
// código. El módulo del contrato devuelve códigos justamente para que la
// redacción viva del lado del motor, que es el que sabe cómo se llama cada
// pieza de SU contrato.
//
// `NOT_HTML` no está en la tabla y no es un olvido: `revisar` solo se llama
// sobre algo que `esCodigo` ya aprobó, y las dos preguntas usan la MISMA función
// (`esComposicionHtml`), así que esa rama de `inspectComposition` es inalcanzable
// por acá.
const TEXTO = {
  [PROBLEM.NO_STAGE]: 'no encuentro el contenedor `<div id="stage">`',
  [PROBLEM.MANY_STAGES]: 'hay más de un elemento con `id="stage"` y no sé cuál es la composición',
  [PROBLEM.NO_REGISTRATION]: 'la timeline no queda registrada en `window.__timelines`, así que el motor no la encuentra',
  [PROBLEM.MANY_REGISTRATIONS]: 'hay varios registros en `window.__timelines` y no sé cuál corresponde a esta composición',
  [PROBLEM.NO_DURATION]: 'falta la duración (`data-duration`) en el `#stage`',
};

module.exports = registrar({
  id: 'hyperframes',
  nombre: 'HyperFrames (HTML + GSAP)',
  lenguaje: lenguajes.HTML,

  esCodigo: esComposicionHtml,

  /**
   * Por qué este motor no tiene vista previa. Es un dato y no una excusa: la
   * timeline se registra PAUSADA para que el capturador la pueda posicionar
   * cuadro por cuadro, así que abrir este HTML en un navegador muestra el primer
   * cuadro y nada más.
   *
   * Vive acá porque es conocimiento de HyperFrames. Estaba escrito en
   * `engine.js`, o sea que el orquestador sabía qué es `window.__timelines` — el
   * tipo de cosa que el registro de motores existe para sacarle de encima.
   */
  motivoSinVistaPrevia:
    'su contrato pide la timeline pausada para poder capturarla cuadro por cuadro, ' +
    'así que abrirla en un navegador muestra el primer cuadro y nada más.\n' +
    'Para ver cómo quedó, renderizala: es lo mismo que mostraría una vista previa.',

  /**
   * La duración que el HTML declara en `data-duration`, o 0.
   *
   * `composition.js` es el único lugar del código que sabe leerla, y la pestaña
   * Corrections la necesita para los recursos viejos a los que les falta la
   * ficha. Se pide con `durationSec: 0` justamente para que no inyecte la
   * nuestra: lo que se quiere saber es qué dice el archivo, no qué querríamos.
   */
  duracionDeclarada(code) {
    try {
      return inspectComposition(String(code || ''), { durationSec: 0 }).duration || 0;
    } catch (e) {
      return 0;
    }
  },

  systemPrompt() {
    return systemPrompt('system-hyperframes.md');
  },

  textoDeProblema(problema) {
    return TEXTO[problema] || 'el andamiaje de la composición está incompleto';
  },

  /**
   * El contrato, como DATOS. Los tres lugares donde se le dice al modelo
   * —el checklist del pedido, el recordatorio final y el pedido de arreglo— se
   * componen de esta lista (ver prompt/contrato.js). Antes eran tres bloques de
   * prosa escritos a mano que repetían estas mismas reglas, y agregar una a uno
   * sin agregarla a los otros no fallaba: dejaba a los proveedores sin system
   * prompt con un contrato incompleto.
   */
  reglas: [
    'El <div id="stage"> DEBE tener: data-composition-id, data-start="0", data-width="1920", ' +
      'data-height="1080", data-duration (número > 0 = duración en segundos) y data-fps="30".',
    'UN solo <div id="stage"> y UNA sola timeline GSAP, pausada, con tiempos absolutos.',
    'El script DEBE TERMINAR registrándola con la MISMA clave que data-composition-id: ' +
      "window.__timelines['comp'] = tl;",
    'Sin esas tres cosas (data-composition-id, data-duration > 0 y __timelines) el render falla.',
  ],

  /** Cómo se le pide la duración: acá se DECLARA en el HTML. */
  duracionEnElPedido(durationSec) {
    return 'La composición debe durar ' + durationSec.toFixed(2) + ' s: declaralo en ' +
      'data-duration del #stage y que la timeline cubra exactamente ese rango.';
  },

  bloqueDeAssets(infos) {
    if (!infos.length) return '';
    return '\n\n## Imágenes provistas disponibles como ARCHIVO (para incrustar)\n' +
      'Las imágenes de referencia también están disponibles como archivos en la carpeta assets/ del proyecto ' +
      '(con sus dimensiones reales en px — respetá el aspect ratio al usarlas):\n' +
      infos.map((a) => '- assets/' + a.name + (a.w && a.h ? ' (' + a.w + '×' + a.h + ' px)' : '')).join('\n') +
      '\nSi la instrucción pide USAR o incluir una imagen provista (un logo, icono, foto o marca), ' +
      'INCRUSTALA tal cual con <img src="assets/NOMBRE"> (ruta relativa exacta) — NO la recrees ni dibujes una aproximación. ' +
      'Escalala manteniendo su proporción (usá las dimensiones de arriba) y ubicala según la instrucción. ' +
      'Si son solo referencia visual (por ej. un frame del video para leer composición/paleta), usalas como contexto y NO las incrustes.';
  },

  bloqueDeFondo() {
    return '\n\n## Fondo (esta composición LLEVA FONDO — NO es transparente)\n' +
      '- Cubrí TODO el #stage (1920×1080) con un fondo OPACO de pantalla completa; sin zonas transparentes.\n' +
      '- Estilo MINIMALISTA con algo de TEXTURA sutil (grano fino, gradiente suave, patrón geométrico tenue o ruido leve). Nada recargado.\n' +
      '- La temática del fondo debe relacionarse con el OBJETIVO de la clase y el tema de este tramo del transcript (evocá el concepto, no lo hagas literal).\n' +
      '- CONTRASTE: lo que va al frente (texto/gráficos) debe leerse con claridad sobre el fondo. Asegurá suficiente diferencia de luminosidad; si hace falta, poné un velo/oscurecido detrás del texto.\n' +
      '- Paleta sobria y coherente; el fondo NO debe competir con la información del frente.';
  },

  revisar(code, opts) {
    const r = inspectComposition(code, opts || {});
    return { code: r.html, fixes: r.fixes, problema: r.problem, duration: r.duration };
  },

  renderizar(o) {
    return renderComposition({
      html: o.code,
      outMovPath: o.outPath,
      durationSec: o.durationSec,
      onProgress: o.onProgress,
      format: o.format,
      assetsDir: o.assetsDir,
    });
  },

  /**
   * HyperFrames viaja DENTRO del panel (`bridge/node_modules/hyperframes`), así
   * que su instalación es la del propio motor Node: la resuelve "Preparar
   * motor" y no hay nada que instalar aparte.
   */
  estado() {
    const isWin = process.platform === 'win32';
    const bin = path.join(__dirname, '..', 'node_modules', '.bin', isWin ? 'hyperframes.cmd' : 'hyperframes');
    if (fs.existsSync(bin)) return { instalado: true, motivo: '' };
    return {
      instalado: false,
      motivo: 'Falta preparar el motor del panel (⚙ → Preparar motor): ahí se instala hyperframes.',
    };
  },
});
