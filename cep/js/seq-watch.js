/**
 * HPSeqWatch — se entera de que cambiaste de secuencia en Premiere.
 *
 * El panel NO se cambia de secuencia solo (ver el comentario del aviso en
 * main.js): lo único que tiene que hacer es DARSE CUENTA y avisar. El problema
 * era cómo se enteraba: un solo `window.focus`. En Mac cada panel CEP es una
 * vista que gana y pierde el foco, así que al volver de la línea de tiempo el
 * evento llega. En WINDOWS, con el panel acoplado adentro de la ventana de
 * Premiere, moverse entre paneles NO produce ninguna transición de foco a nivel
 * `window` (es la misma ventana nativa): el evento nunca llega, la comprobación
 * nunca corre y el panel se queda creyendo que seguís en la secuencia anterior
 * para siempre.
 *
 * Por eso acá el foco es solo un atajo y el piso es un SONDEO: preguntar cada
 * pocos segundos cuál es la secuencia activa. `hp_getActiveSequenceName()` lee
 * una propiedad y devuelve un string, así que el costo es despreciable — pero
 * solo mientras no se apilen llamadas ni se pregunte al pedo:
 *
 *   1. Si la consulta anterior todavía no volvió, este turno SE SALTEA (no se
 *      encola otra). Durante la exportación del audio para transcribir
 *      (exportAsMediaDirect) ExtendScript queda bloqueado varios minutos: sin
 *      esta guarda el sondeo le sumaría presión justo cuando la máquina está
 *      ocupada, y todas las respuestas llegarían juntas al liberarse.
 *   2. Con el panel oculto (otra pestaña del grupo, ventana minimizada) no se
 *      pregunta nada: no hay a quién avisarle.
 *   3. Si una respuesta no vuelve NUNCA (evalScript perdido al recargar el
 *      panel), a `lostMs` se la da por perdida y el sondeo revive. Sin esto un
 *      solo callback colgado dejaba el vigilante muerto en silencio, que es
 *      exactamente el bug original.
 *
 * Nota sobre el camino "sin sondeo": Premiere tiene `app.bind(...)` en
 * ExtendScript y desde el .jsx se puede empujar un `CSXSEvent` al panel. Sería
 * instantáneo, pero la guía de scripting solo documenta
 * `onActiveSequenceStructureChanged` (cambios ADENTRO de la secuencia activa),
 * no un evento de "cambiaste de secuencia", y no hay forma de probarlo desde
 * acá contra un Premiere real. Sondear cada pocos segundos es más aburrido y
 * funciona en las dos plataformas.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPSeqWatch.
 */
(function (global) {
  "use strict";

  // Cada cuánto se le pregunta a Premiere. 2,5 s es imperceptible para el
  // editor (cambia de secuencia y el aviso ya está) y son ~24 lecturas de una
  // propiedad por minuto: nada al lado de un render.
  var POLL_MS = 2500;
  // A partir de acá una consulta sin respuesta se considera perdida.
  var LOST_MS = 60000;

  /**
   * @param {object} opts
   *   ask(cb)            pregunta el nombre de la secuencia activa (string crudo del host)
   *   panelSequence()    nombre de la secuencia que está usando el panel
   *   onResult(otra)     "" = estás en la del panel; si no, el nombre de la otra
   *   hidden()           true si el panel no se ve (no preguntar)
   *   pollMs / lostMs / now  para los tests
   */
  function create(opts) {
    opts = opts || {};
    var ask = opts.ask;
    var panelSequence = opts.panelSequence || function () { return ""; };
    var onResult = opts.onResult || function () {};
    var hidden = opts.hidden || function () { return false; };
    var now = opts.now || function () { return Date.now(); };
    var pollMs = opts.pollMs > 0 ? opts.pollMs : POLL_MS;
    var lostMs = opts.lostMs > 0 ? opts.lostMs : LOST_MS;

    var pendingId = 0;   // id de la consulta en vuelo (0 = ninguna)
    var lastId = 0;
    var askedAt = 0;
    var timer = null;
    // Para los tests y para el log: cuántas veces preguntó y cuántas se salteó.
    var stats = { asked: 0, skippedBusy: 0, skippedHidden: 0, lost: 0 };

    /** Pregunta ahora si se puede. Devuelve true si realmente preguntó. */
    function check() {
      if (typeof ask !== "function") return false;
      if (hidden()) { stats.skippedHidden++; return false; }
      if (pendingId) {
        if (now() - askedAt < lostMs) { stats.skippedBusy++; return false; }
        stats.lost++;
      }
      var id = ++lastId;
      pendingId = id;
      askedAt = now();
      stats.asked++;
      ask(function (raw) {
        // Respuesta tardía de una consulta ya dada por perdida: si la dejáramos
        // hablar, el aviso podría mostrar un nombre viejo como si fuera de ahora.
        if (pendingId !== id) return;
        pendingId = 0;
        var live = String(raw === undefined || raw === null ? "" : raw);
        // Premiere sin proyecto abierto o un error del host no son "otra
        // secuencia": callarse es mejor que avisar cualquier cosa.
        if (!live || live.indexOf("Error:") === 0 || live.indexOf("(sin secuencia") === 0) return;
        onResult(live !== String(panelSequence() || "") ? live : "");
      });
      return true;
    }

    function start() {
      if (timer !== null) return api;
      timer = global.setInterval(check, pollMs);
      return api;
    }

    function stop() {
      if (timer === null) return api;
      global.clearInterval(timer);
      timer = null;
      return api;
    }

    var api = { check: check, start: start, stop: stop, stats: stats };
    return api;
  }

  global.HPSeqWatch = { create: create, POLL_MS: POLL_MS };
})(typeof window !== "undefined" ? window : this);
