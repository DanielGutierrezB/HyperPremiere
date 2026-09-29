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
const { inspectComposition, PROBLEM } = require('../composition');
const { registrar } = require('./motores');
const { systemPrompt } = require('../prompt/system');

// Qué decirle al modelo (y al editor) por cada cosa que no se pudo completar en
// código. El módulo del contrato devuelve códigos justamente para que la
// redacción viva del lado del motor, que es el que sabe cómo se llama cada
// pieza de SU contrato.
const TEXTO = {
  // Neutral a propósito: lo lee tanto la generación como el render de un HTML
  // editado a mano, y ahí no hay ningún modelo a quien atribuirle nada.
  [PROBLEM.NOT_HTML]: 'esto no es una composición HTML',
  [PROBLEM.NO_STAGE]: 'no encuentro el contenedor `<div id="stage">`',
  [PROBLEM.MANY_STAGES]: 'hay más de un elemento con `id="stage"` y no sé cuál es la composición',
  [PROBLEM.NO_REGISTRATION]: 'la timeline no queda registrada en `window.__timelines`, así que el motor no la encuentra',
  [PROBLEM.MANY_REGISTRATIONS]: 'hay varios registros en `window.__timelines` y no sé cuál corresponde a esta composición',
  [PROBLEM.NO_DURATION]: 'falta la duración (`data-duration`) en el `#stage`',
};

module.exports = registrar({
  id: 'hyperframes',
  nombre: 'HyperFrames (HTML + GSAP)',
  ext: '.html',
  // Cómo lo resalta Prism en el editor del panel.
  lenguaje: 'markup',
  fence: 'html',
  comoSeLlama: 'el HTML',

  comentario(texto) {
    return '<!-- ' + texto + ' -->';
  },

  systemPrompt() {
    return systemPrompt('system-hyperframes.md');
  },

  textoDeProblema(problema) {
    return TEXTO[problema] || 'el andamiaje de la composición está incompleto';
  },

  /** El contrato, dentro del prompt de usuario (reduce reintentos por HTML inválido). */
  bloqueDeContrato(durationSec) {
    const d = Number(durationSec) || 0;
    return '\n## Duración objetivo\n' +
      'La composición debe durar ' + d.toFixed(2) + ' s (declarala en data-duration del #stage y ' +
      'que la timeline cubra exactamente ese rango).\n' +
      '\n## Contrato obligatorio (verificá antes de responder)\n' +
      '- El <div id="stage"> DEBE tener: data-composition-id, data-width="1920", data-height="1080", ' +
      'data-duration (número > 0 = duración en segundos) y data-fps="30".\n' +
      '- El script DEBE terminar con window.__timelines[COMP_ID] = tl; (COMP_ID = data-composition-id).\n' +
      '- Sin esos tres (data-composition-id, data-duration > 0, __timelines) el render falla.\n' +
      '\nDevolvé SOLO el HTML completo de la composición.';
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

  recordatorioFinal() {
    return '\n\n---\n\n' +
      '# ANTES DE RESPONDER — el contrato que no se negocia\n\n' +
      'Esto va último porque es lo único sin lo cual el render NO EXISTE. ' +
      'Repasá los cuatro puntos sobre tu propio HTML antes de mandarlo:\n\n' +
      '1. UN solo contenedor raíz, con TODOS estos atributos:\n' +
      '   `<div id="stage" data-composition-id="comp" data-start="0" ' +
      'data-width="1920" data-height="1080" data-duration="…" data-fps="30">`\n' +
      '   donde `data-duration` es la duración objetivo que te pedí arriba, en segundos, número > 0.\n' +
      '2. UNA sola timeline GSAP, pausada, con tiempos absolutos.\n' +
      '3. El script TERMINA registrándola con la MISMA clave que `data-composition-id`:\n' +
      "   `window.__timelines['comp'] = tl;`\n" +
      '4. Devolvé SOLO el HTML, de `<!DOCTYPE html>` a `</html>`. Nada antes, nada después.\n\n' +
      'Si falta cualquiera de los cuatro, la composición no se puede renderizar y el trabajo se pierde entero.';
  },

  promptDeArreglo(userPrompt, code, problema, durationSec) {
    return userPrompt +
      '\n\n## Arreglo de estructura (NO rediseñes)\n' +
      'Generaste la composición de abajo, pero ' + this.textoDeProblema(problema) + '.\n' +
      'Devolvé EL MISMO HTML —mismo diseño, mismo CSS, mismos tweens y tiempos— con SOLO el andamiaje corregido:\n' +
      '- El `<div id="stage">` con data-composition-id, data-start="0", data-width="1920", data-height="1080", ' +
      'data-duration="' + Number(durationSec).toFixed(2) + '" y data-fps="30".\n' +
      '- UN solo `<div id="stage">` y UNA sola timeline, cerrando con `window.__timelines[COMP_ID] = tl;` ' +
      '(COMP_ID igual a data-composition-id).\n' +
      'No cambies nada más: sin esto el render falla, pero el diseño ya está aprobado.\n' +
      '\n### Tu versión a corregir\n```html\n' + code + '\n```';
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
