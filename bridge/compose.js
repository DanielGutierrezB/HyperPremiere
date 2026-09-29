// Escalera de llamadas al modelo para conseguir UNA composición renderizable.
//
// Son hasta tres llamadas, con una regla común: nunca empeorar lo que ya tenemos.
//   1. El diseño.
//   2. Solo si el andamiaje no se pudo completar en código (ver composition.js):
//      un arreglo DIRIGIDO sobre su propio HTML. Pedir un diseño nuevo desde cero
//      costaba otra tanda entera de razonamiento —minutos, el 86-91% del tiempo de
//      un marcador— y devolvía un diseño distinto que ya no había pasado por la
//      auditoría del primero.
//   3. Solo si el modelo declaró `AUDIT: FALLA`: corregir esa falla de diseño
//      concreta, también sobre su propio HTML.
//
// Vive aparte de engine.js porque es una POLÍTICA (cuándo vale gastar otra
// llamada, qué se adopta y qué se descarta), no orquestación: acá se puede leer
// completa y probar sin tocar Premiere ni el disco.

'use strict';

const { stripHtmlFence } = require('./providers');
const { auditFailure } = require('./composition');
const { PROBLEMA } = require('./render/motores');

// Lo que dijo el modelo, en una línea y corto, para que quepa en el log del
// panel. Va entre comillas en el mensaje de error: es su explicación, no la
// nuestra, y suele decir exactamente qué lo frenó.
function quoteReply(text) {
  const una = String(text || '').replace(/\s+/g, ' ').trim();
  return una.length > 240 ? una.slice(0, 240) + '…' : (una || '(nada)');
}

/**
 * El pedido de corrección de una falla que el MODELO declaró en su auditoría.
 *
 * A diferencia del arreglo de estructura —que es del contrato de cada motor y
 * lo redacta el motor—, esto es de DISEÑO: elementos que se pisan, texto fuera
 * de la zona segura. Vale igual se escriba HTML o React, así que vive acá; lo
 * único que le pide al motor es cómo nombrarlo y con qué marcar el bloque.
 */
function auditFixPrompt(motor, userPrompt, code, falla) {
  return userPrompt +
    '\n\n## Corrección dirigida (tu PROPIA auditoría encontró esta falla)\n' +
    'Generaste la composición de abajo y tu auditoría declaró: "' + falla + '".\n' +
    'Corregí EXACTAMENTE esa falla conservando todo lo que está bien (idea, estilo, timing). ' +
    'Aplicá el protocolo de layout (regiones que no se pisan, zona segura de 80px, presupuesto de texto). ' +
    'Devolvé SOLO ' + motor.comoSeLlama + ' completo corregido, con su auditoría final en un comentario `AUDIT: …`.\n' +
    '\n### Tu versión con la falla\n```' + motor.fence + '\n' + code + '\n```';
}

/**
 * Consigue una composición renderizable. Devuelve `{ html, usage }`.
 *
 * Sigue diciendo `html` en la salida, y no es descuido: ese nombre viaja por
 * `prepareGeneration` hacia la cola, el panel y la ficha de cada versión.
 * Renombrarlo a `code` habría sido tocar seis lugares para no cambiar nada de
 * lo que pasa — el string es el código de la composición, se llame como se
 * llame. Adentro de esta función sí se dice `code`, que es lo que es.
 *
 * @param {object} a
 * @param {object} a.provider    Proveedor ya resuelto (ver providers/).
 * @param {object} a.config      Config del modelo (modelo, credenciales, effort…).
 * @param {object} a.motor       El motor de animación (ver render/motores.js).
 * @param {string} a.systemPrompt
 * @param {string} a.userPrompt
 * @param {string[]} a.images    Stills para visión.
 * @param {number} a.durationSec Duración del marcador.
 * @param {string} a.markerSlug  Respaldo para el id de la composición.
 * @param {function} [a.report]  onProgress({ pct, msg, note, level, act }).
 */
async function composeAnimation(a) {
  const motor = a.motor;
  const report = typeof a.report === 'function' ? a.report : function () {};
  // Estado en vivo de lo que el modelo está haciendo AHORA. Va en su propio
  // campo del sobre (`act`) y no en `msg`: el mensaje dice en qué etapa de la
  // escalera estamos —que cambia tres veces— y esto se refresca cada segundo.
  // Los proveedores que no saben contarlo simplemente no llaman a onActivity y
  // el panel se queda con la etapa y el reloj, sin inventar nada.
  // Es decoración: si el panel falla dibujándola, la generación sigue. Sin este
  // try, un error pintando el cartelito viajaba hacia atrás por el proveedor y
  // tiraba abajo un diseño de tres minutos ya pagado.
  const onActivity = function (act) {
    try { report({ act: act }); } catch (e) { /* la vista no manda acá */ }
  };
  // El uso de TODA la escalera junto: un recurso puede costar hasta tres
  // llamadas y lo que el editor quiere saber es lo que salió el recurso.
  // `totalInputTokens` es la entrada de verdad (ver makeUsage: el prompt viaja
  // por los campos de caché, no por `inputTokens`).
  const usage = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    totalInputTokens: 0, costUsd: null, calls: 0,
  };
  function addUsage(u) {
    if (!u) return;
    usage.inputTokens += Number(u.inputTokens) || 0;
    usage.outputTokens += Number(u.outputTokens) || 0;
    usage.cacheReadTokens += Number(u.cacheReadTokens) || 0;
    usage.cacheCreationTokens += Number(u.cacheCreationTokens) || 0;
    usage.totalInputTokens += Number(u.totalInputTokens) ||
      // Un proveedor de otra versión puede no traerlo: se recompone.
      ((Number(u.inputTokens) || 0) + (Number(u.cacheReadTokens) || 0) + (Number(u.cacheCreationTokens) || 0));
    if (typeof u.costUsd === 'number') usage.costUsd = (usage.costUsd || 0) + u.costUsd;
    usage.calls += 1;
  }

  // Una llamada al modelo + el andamiaje completado en código. Todo lo que se
  // arregla acá no cuesta ni una llamada ni un segundo, así que se aplica a TODA
  // salida: la primera, el reintento y la corrección de auditoría.
  async function ask(promptText) {
    const gen = await a.provider.generate({
      systemPrompt: a.systemPrompt, userPrompt: promptText, images: a.images,
      model: a.config.model, config: a.config, onActivity,
    });
    // La etapa terminó: lo último que dijo el modelo ya no es lo que pasa.
    onActivity(null);
    // El proveedor pudo haber tenido que rescatar la respuesta de un cierre raro
    // del CLI. Salió bien, pero tiene que quedar por escrito: si después el
    // recurso o el conteo de tokens sale distinto, esta línea lo explica.
    if (gen.warning) report({ note: gen.warning, level: 'WARN' });
    addUsage(gen.usage);
    const seen = motor.revisar(stripHtmlFence(gen.text), {
      durationSec: a.durationSec, markerSlug: a.markerSlug,
    });
    if (seen.fixes.length) {
      report({ note: 'Andamiaje completado en código (sin gastar otra llamada): ' + seen.fixes.join(' · ') });
    }
    return seen;
  }

  /** Qué está mal, con el detalle del motor cuando lo trae (ej. qué import sobra). */
  function porQue(seen) {
    const base = motor.textoDeProblema(seen.problema);
    return seen.detalle ? base + ' (' + seen.detalle + ')' : base;
  }

  let best = await ask(a.userPrompt);

  // El modelo contestó en prosa. Se corta acá, sin gastar la llamada de
  // estructura y SIN guardar nada.
  //
  // Las dos cosas se aprendieron el mismo día. Un editor perdió tres rondas
  // seguidas de un marcador porque el CLI de Cursor corría en `--mode ask` y el
  // modelo empezó a contestar "I'm in Ask mode… I can't author a final
  // production deliverable. Please switch to Agent mode" (el modo ya se
  // arregló, en cursor-cli.js; esto es la red).
  //
  //   - La llamada de estructura no sirve: le manda esa prosa como "tu versión a
  //     corregir" y el modelo se vuelve a negar. Se vio tres veces, veinte
  //     segundos y una tanda de tokens cada una.
  //   - Y guardarla era lo peor: quedaba como el HTML de la versión nueva, así
  //     que la ronda siguiente la leía como "la versión previa" y le pedía
  //     mejorar un texto de disculpa. El propio modelo lo detectó y lo dijo:
  //     "the 'versión previa' block does not actually contain the prior HTML
  //     (it contains an earlier refusal message instead)". Una negativa no
  //     puede contaminar la cadena de versiones.
  if (best.problema === PROBLEMA.NO_ES_CODIGO) {
    const vacia = !String(best.code || '').trim();
    throw Object.assign(new Error(
      (vacia
        ? 'El proveedor "' + a.config.provider + '" devolvió una respuesta vacía: no hay composición.\n'
        : 'El modelo no compuso nada: contestó en prosa en vez de devolver ' + motor.comoSeLlama + '.\n' +
          'Lo que dijo: «' + quoteReply(best.code) + '»\n') +
      'No lo guardo como versión: si lo guardara, la próxima corrección tomaría ' +
      'este texto como "la versión previa".\n' +
      'Qué hacer: dale "Reintentar". Si se repite, probá con otro modelo o con otro proveedor.'
    ), { problem: best.problema, usage: usage, sinComposicion: true });
  }

  // Reintento por estructura. Llegar acá ya es raro: el reparador cubre el id, la
  // duración y el registro desalineado.
  if (best.problema) {
    report({ pct: 45, msg: 'Corrigiendo la estructura de la composición…' });
    report({ note: 'LLAMADA EXTRA al modelo por estructura: ' + porQue(best) + '.', level: 'WARN' });
    const retry = await ask(motor.promptDeArreglo(a.userPrompt, best.code, best.problema, a.durationSec));
    if (!retry.problema) best = retry;
    else report({ note: 'El reintento de estructura TAMPOCO cumplió: sigo con la versión original.', level: 'WARN' });
  }

  // Corrección dirigida si el modelo ADMITIÓ una falla de diseño. Con AUDIT: OK no
  // cuesta nada.
  const falla = auditFailure(best.code);
  if (falla) {
    report({ pct: 48, msg: 'Tu auditoría detectó una falla de diseño — corrigiéndola…' });
    const fixed = await ask(auditFixPrompt(motor, a.userPrompt, best.code, falla));
    if (!fixed.problema) best = fixed;
    else report({ note: 'La corrección de auditoría no cumplía el contrato: me quedo con la versión anterior.', level: 'WARN' });
  }

  // Si después de todo el andamiaje sigue incompleto, esta composición NO se
  // puede renderizar, y decirlo acá es parte del trabajo de este módulo: es el
  // que conoce el contrato.
  //
  // Antes se devolvía igual y el render se la comía. Los dos finales posibles
  // eran malos: o el CLI cortaba con "Composition has zero duration" —que él
  // mismo marca como permanente— después de gastar los tres intentos de la
  // escalera bajando GPU y workers, y el editor terminaba leyendo un error que
  // nombraba la placa de video; o salía un .mov de la duración pedida con la
  // animación congelada, que es peor, porque eso no falla: se descubre mirando.
  //
  // El código viaja en el error para que quien llame lo pueda guardar: se pagó,
  // y con él se puede ver qué pasó o arreglarlo a mano.
  if (best.problema) {
    throw Object.assign(new Error(
      'La composición no quedó renderizable: ' + porQue(best) + '.\n' +
      'No la mando a renderizar porque no puede salir bien: daría un error de duración o un video congelado.\n' +
      'Qué hacer: volvé a generar el marcador, o arreglalo a mano con "Editar código".'
    ), { html: best.code, problem: best.problema, usage: usage, noRenderizable: true });
  }

  return { html: best.code, usage: usage };
}

module.exports = { composeAnimation };
