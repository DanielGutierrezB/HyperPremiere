'use strict';

/**
 * Registro de proveedores de generacion.
 *
 * Interfaz comun que implementa cada proveedor:
 *   async generate({ systemPrompt, userPrompt, images, model, config })
 *       -> { text, usage, warning? }   ·  `text` es SOLO el HTML de la composicion
 *   async complete({ ...lo mismo })
 *       -> { text, usage, warning? }   ·  `text` es lo que escribio el modelo, crudo
 * donde `images` es un array de data URLs ("data:image/png;base64,....").
 *
 * `generate` es `complete` + `stripHtmlFence`, y nada mas. Los dos existen
 * porque el panel le pide a estos mismos proveedores dos cosas distintas: una
 * COMPOSICION (que viene envuelta en un fence de markdown y hay que
 * desenvolver) y TEXTO a secas (el refinador del dictado). Reescribir el
 * proveedor afuera para el segundo caso es como se pierden las cosas que solo
 * estan aca: que el CLI puede salir con codigo 0 y `is_error: true`, la
 * escalera de reintento por flag desconocido, el system prompt por archivo en
 * Windows y el diagnostico de "sin sesion / sin cuota / modelo inexistente".
 *
 * `cursor-cli` y `openai-compat` todavia implementan solo `generate`: nadie les
 * pide texto crudo. El dia que haga falta, se parten igual.
 */

const PROVIDERS = {
  'claude-cli': './claude-cli',
  'claude-api': './claude-api',
  'cursor-cli': './cursor-cli',
  'openai-compat': './openai-compat',
  'ollama': './ollama',
};

/**
 * Cuáles de los cinco pueden ABRIR UN ARCHIVO del disco.
 *
 * Son dos, y no es un detalle de implementación: es lo que decide si el PDF que
 * el editor arrastró le llega al modelo o no le llega. Los dos CLI de agente
 * tienen herramienta de lectura —se les nombra la ruta, se les declara la
 * carpeta, y abren el archivo—. Los otros tres hablan por HTTP con un modelo que
 * no tiene disco: lo único que les entra son texto e imágenes, en el mensaje.
 * Un PDF ahí no viaja de ninguna forma.
 *
 * Vive acá y no en el motor porque es una propiedad de los proveedores, y
 * porque el día que uno de los tres aprenda a recibir documentos se agrega en la
 * misma lista donde se lo cuenta.
 */
const LEEN_ARCHIVOS = ['claude-cli', 'cursor-cli'];

function leeArchivos(provider) {
  return LEEN_ARCHIVOS.indexOf(String(provider || '').trim().toLowerCase()) !== -1;
}

/**
 * Devuelve el modulo del proveedor pedido.
 * Carga perezosa (require dentro de la funcion) para evitar requires circulares:
 * los proveedores importan stripHtmlFence desde este mismo archivo.
 *
 * @param {string} name - 'claude-cli' | 'claude-api' | 'openai-compat' | 'ollama'
 * @returns {{ generate: Function }}
 */
function getProvider(name) {
  const key = String(name || '').trim().toLowerCase();
  const modPath = PROVIDERS[key];
  if (!modPath) {
    const known = Object.keys(PROVIDERS).join(', ');
    throw new Error(`Proveedor desconocido: "${name}". Validos: ${known}`);
  }
  return require(modPath);
}

/**
 * Extrae el HTML de una respuesta de modelo.
 *
 * Los modelos suelen envolver el resultado en fences de markdown:
 *   ```html\n<html>...</html>\n```
 * Esta funcion quita el fence (```html o ``` generico) y devuelve solo el
 * contenido. Si hay varios fences, prefiere el primero etiquetado como html;
 * si no hay ninguno, devuelve el texto recortado tal cual.
 *
 * @param {string} text
 * @returns {string}
 */
function stripHtmlFence(text) {
  if (typeof text !== 'string') return '';
  // Modelos con "thinking" (ej. Qwen3-VL local) anteponen <think>…</think> con
  // su razonamiento antes del HTML: lo quitamos para no contaminar la salida.
  const noThink = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const trimmed = noThink.trim();
  if (!trimmed) return '';

  // Fence etiquetado como html (case-insensitive), con o sin salto final.
  const htmlFence = trimmed.match(/```html\s*\n([\s\S]*?)```/i);
  if (htmlFence) return htmlFence[1].trim();

  // Fence generico: solo lo usamos si el contenido parece HTML,
  // para no comernos texto que tenga fences de otro lenguaje.
  const anyFence = trimmed.match(/```[a-zA-Z0-9-]*\s*\n([\s\S]*?)```/);
  if (anyFence && /<\s*(!doctype|html|div|body|section|svg)/i.test(anyFence[1])) {
    return anyFence[1].trim();
  }

  // Caso borde: la respuesta ENTERA es un fence sin cierre (respuesta cortada).
  if (trimmed.startsWith('```')) {
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline !== -1) {
      return trimmed
        .slice(firstNewline + 1)
        .replace(/```\s*$/, '')
        .trim();
    }
  }

  return trimmed;
}

/**
 * Parsea un data URL de imagen en sus partes.
 * Utilidad compartida por los proveedores que mandan imagenes base64.
 *
 * @param {string} dataUrl - "data:image/png;base64,AAAA..."
 * @returns {{ mediaType: string, base64: string } | null} null si no es un data URL valido
 */
function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (!m) return null;
  return { mediaType: m[1], base64: m[2].replace(/\s+/g, '') };
}

/**
 * Nombre de archivo de la imagen de referencia número `n` (1-based).
 *
 * El prompt numera las imágenes ("imagen 1", "imagen 2"…) porque así las nombra
 * el editor en su instrucción. Los proveedores que las dejan como archivo usan
 * ESTE nombre para que el número y el archivo sean lo mismo: pedirle al modelo
 * que mapee "imagen 2" a un "still-2.png" es trabajo regalado.
 *
 * @param {number} n - posición 1-based
 * @param {string} mediaType - "image/png", "image/jpeg"…
 * @returns {string}
 */
function imageFileName(n, mediaType) {
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
  return 'imagen-' + n + (ext[mediaType] || '.png');
}

/**
 * Texto que le explica al modelo que las imágenes son ARCHIVOS, no adjuntos.
 *
 * Lo usan los proveedores de línea de comandos (claude-cli, cursor-cli), que no
 * pueden adjuntar imágenes a un mensaje: las dejan en disco. El resto del prompt
 * no habla del transporte justamente porque depende de quién atienda; esta es la
 * mitad que sabe el proveedor.
 *
 * @param {string[]} refs - cómo abrir cada imagen, en orden ("./imagen-1.png" o
 *   una ruta absoluta, según dónde corra el agente)
 * @returns {string} '' si no hay imágenes
 */
function imagesAsFilesNote(refs) {
  const list = Array.isArray(refs) ? refs : [];
  if (!list.length) return '';
  const cuantas = list.length === 1
    ? 'es UN archivo en disco'
    : 'son ' + list.length + ' archivos en disco';
  return '\n\n## Dónde están las imágenes de referencia\n' +
    'No van adjuntas a este mensaje: ' + cuantas + '. Abrilos con tu herramienta de ' +
    'lectura ANTES de diseñar.\n' +
    list.map((r, i) => '- imagen ' + (i + 1) + ' → ' + r).join('\n') +
    (list.length > 1 ? '\nAbrí las ' + list.length + ': con una sola no alcanza.' : '') +
    '\nEs la única forma de ver el cuadro sobre el que se va a superponer tu composición, ' +
    'y se comprueba: si alguna queda sin abrir, el editor recibe el aviso de que ' +
    'diseñaste sin verla.';
}

/**
 * Texto que le dice al modelo dónde están los DOCUMENTOS que subió el editor
 * (PDFs y demás binarios: la documentación de la marca, un brief, una ficha).
 *
 * Existe por el mismo motivo que `imagesAsFilesNote` y se separó por el mismo
 * descubrimiento: la ruta que sirve depende de quién atienda. El motor escribía
 * la ruta del proyecto en el prompt para los dos CLI por igual, y para
 * `cursor-agent` eso era una ruta fuera de su `--workspace`: el PDF quedaba
 * nombrado en el pedido y fuera de su alcance, y componía sin él sin que nada
 * fallara. Ahora cada proveedor dice la ruta que él puede abrir.
 *
 * Los tres proveedores que hablan por HTTP (claude-api, openai-compat, ollama)
 * no llaman a esto: a ellos el documento directamente no les llega, y eso se
 * avisa antes de gastar la llamada (ver PROVEEDORES_QUE_LEEN en engine.js).
 *
 * @param {string[]} refs - rutas a los documentos, en orden
 * @returns {string} '' si no hay ninguno
 */
function docsAsFilesNote(refs) {
  const list = Array.isArray(refs) ? refs : [];
  if (!list.length) return '';
  return '\n\n## Documentación de referencia que subió el editor (leela del disco antes de componer)\n' +
    'Son ' + (list.length === 1 ? 'un archivo' : list.length + ' archivos') +
    ' en disco, no adjuntos de este mensaje. Abrilos con tu herramienta de lectura ANTES de ' +
    'diseñar; es contexto para el diseño, no contenido para copiar tal cual a la pantalla:\n' +
    list.map((r) => '- ' + r).join('\n');
}

/**
 * El andamiaje obligatorio, repetido corto y tajante al FINAL del mensaje.
 *
 * APAGADO POR DEFECTO. Se prende con `contractTail: true` en el proveedor de
 * Cursor. Lo que sigue es por qué existe y por qué igual no se usa.
 *
 * La hipótesis: `cursor-agent` no tiene canal de system prompt (su --help no
 * ofrece ninguno), así que el system prompt viaja adentro del mensaje de
 * usuario. Como lo que queda al final de un texto largo se obedece más que lo
 * que queda al principio —que es el modo de falla que se vio en Windows con el
 * CLI de Claude, con el system prompt en el carácter 4.223 y composiciones sin
 * `<div id="stage">`—, repetir el andamiaje al final debería subir el
 * cumplimiento.
 *
 * LA MEDICIÓN DIJO QUE NO. Contra el cursor-agent de verdad
 * (test/manual/cursor-contrato.js), corridas intercaladas, contando cuántas
 * composiciones cumplen el contrato SIN que el reparador tenga que adoptarles
 * la raíz:
 *
 *   claude-sonnet-5-thinking-high (el modelo por defecto), corridas
 *   intercaladas de 10 y 10:  prompt anterior 10/10  ·  con recordatorio 10/10
 *   composer-2.5 con el caso difícil (la continuidad de engine.js empujando el
 *   contrato a 5.000 caracteres del final), 10 y 10:  10/10  ·  10/10
 *   grok-4.6-low-fast y codex-5.3-low-fast, 3 cada uno: 3/3 sin recordatorio
 *   Y 6/6 más en el modelo por defecto con lo que quedó puesto (encabezados
 *   sin recordatorio), para confirmar que no aparecen rechazos.
 *
 * No hay margen que ganar: el contrato ya se cumple siempre. De hecho el
 * control negativo —borrarle al prompt system.md ENTERO y la sección de
 * contrato de build-context.js— igual devolvió `id="stage"`,
 * `data-composition-id` y `window.__timelines[...]` en 4 de 4: estos modelos
 * conocen las convenciones de HyperFrames sin que se las digamos.
 *
 * Y cuesta: +843 caracteres de entrada por llamada (~5,8% del prompt) y, en el
 * modelo por defecto, una mediana de +14% de tokens de salida y +16% de tiempo
 * (172s → 200s). Los rangos se pisan, así que el sobrecosto de salida no está
 * probado; el de entrada sí, y la mejora es cero.
 *
 * Se deja el código, no el interruptor puesto: la respuesta vale para estos
 * modelos y este prompt. Si mañana cambia el modelo por defecto, o engine.js
 * empieza a colgar secciones mucho más largas después del contrato, la pregunta
 * se vuelve a abrir — y entonces se vuelve a medir, no a suponer.
 *
 * Qué repite y qué no: SOLO el andamiaje —el contenedor con sus data-*, la
 * timeline única y su registro—, que son las tres cosas sin las cuales el
 * render no existe. Nada de estilo: saltear el estilo da composiciones
 * distintas, no composiciones rotas.
 *
 * Los proveedores con system prompt de verdad (claude-cli, claude-api) NO usan
 * esto: ahí el contrato ya viaja donde se obedece.
 *
 * @returns {string}
 */
function contractReminder() {
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
}

/**
 * Normaliza el uso de tokens a una forma común para todos los proveedores.
 * Los campos ausentes quedan en 0; costUsd es null cuando el proveedor no lo
 * reporta (Anthropic API) y 0 cuando es local (Ollama).
 *
 * `totalInputTokens` es TODO lo que entró al modelo, y es el número que hay que
 * mostrar. Existe porque `inputTokens` a secas engaña: en los dos CLI de agente
 * es apenas el pedacito que NO estaba cacheado, y el prompt entero viaja por los
 * campos de caché. Se comprobó con la llamada más chica posible —un prompt de 20
 * caracteres a cursor-agent— y volvió así:
 *
 *   { inputTokens: 2, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 31823 }
 *
 * Esos 31.823 son el contexto del propio agente, escrito a la caché. En una
 * generación de verdad los tres números conviven (2 sueltos, 46.919 leídos de
 * caché, 48.257 escritos) y sumar solo el primero mostraba **4 tokens de
 * entrada** para un marcador que consumió casi cien mil. Con 164 generaciones
 * encima, el contador de la sesión marcaba 75.256 de entrada contra 2,3 M de
 * salida: un overview que no describía nada.
 *
 * Los tres se suman porque los tres se consumieron. Van también por separado
 * para poder decir cuánto fue caché, que es lo que explica la diferencia entre
 * lo que pedimos y lo que se procesó (y cuesta distinto).
 *
 * @param {string} provider
 * @param {string} model
 * @param {object} raw - { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd }
 */
function makeUsage(provider, model, raw) {
  raw = raw || {};
  const n = function (v) { v = Number(v); return Number.isFinite(v) ? v : 0; };
  const entrada = n(raw.inputTokens);
  const cacheLeida = n(raw.cacheReadTokens);
  const cacheEscrita = n(raw.cacheCreationTokens);
  return {
    inputTokens: entrada,
    outputTokens: n(raw.outputTokens),
    cacheReadTokens: cacheLeida,
    cacheCreationTokens: cacheEscrita,
    totalInputTokens: entrada + cacheLeida + cacheEscrita,
    costUsd: (raw.costUsd === null || raw.costUsd === undefined || !Number.isFinite(Number(raw.costUsd)))
      ? (raw.costUsd === 0 ? 0 : null)
      : Number(raw.costUsd),
    provider: provider || '',
    model: model || '',
  };
}

module.exports = {
  getProvider, stripHtmlFence, parseImageDataUrl, makeUsage,
  imageFileName, imagesAsFilesNote, docsAsFilesNote, contractReminder,
  leeArchivos, LEEN_ARCHIVOS,
};
