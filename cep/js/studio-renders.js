/**
 * HPStudioRenders — lo que pasa en Premiere cuando se aprieta Render en
 * Remotion Studio: el clip de ese marcador pasa a mostrar el render nuevo.
 *
 * ── El circuito ──────────────────────────────────────────────────────
 *
 * El panel abre Studio con un marcador («Abrir Remotion» en su ficha, o «Vista
 * previa» en el editor de código). Cada render que el editor haga desde la
 * interfaz de Studio vuelve al motor, que lo guarda como VERSIÓN NUEVA de ese
 * marcador (ver guardarRenderDeStudio en bridge/versiones.js) y avisa acá. Lo
 * que queda hacer es lo único que el motor no puede, porque solo el panel habla
 * con Premiere: reemplazar el archivo del clip que ya estaba puesto.
 *
 * Reemplazar, no colocar otro arriba: es lo que pidió el editor, y es lo que
 * hace `hp_relinkMedia` (el clip queda en su lugar, su pista y sus recortes).
 * Si ninguna versión de ese marcador está en el proyecto —lo sacaron, o se
 * abrió otro—, se coloca como una generación, en el segundo del marcador.
 *
 * ── Un solo oyente ───────────────────────────────────────────────────
 *
 * `escuchar` se puede llamar cada vez que se abre Studio: si ya hay una
 * suscripción no se hace otra. Dos suscripciones serían dos reemplazos por
 * render, y el motor tampoco lo permitiría (ver `escuchar` en
 * remotion-studio.js). Y los avisos se aplican de a uno: el segundo render de
 * una tanda tiene que encontrar el clip ya apuntando al primero.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPStudioRenders.
 */
(function (global) {
  "use strict";

  var escuchando = false;
  var cadena = Promise.resolve();
  // Lo pone main.js: pintar el resultado en la ficha y en la línea de estado.
  var alTerminar = function () {};

  function log(texto, nivel) {
    if (global.HPLog && HPLog.log) HPLog.log(texto, nivel || "INFO");
  }

  function nombreDe(ruta) {
    return String(ruta || "").split(/[\\\/]/).pop().replace(/\.[^.]+$/, "");
  }

  function contar(resultado) {
    try { alTerminar(resultado); } catch (e) { /* la ficha ya no está */ }
  }

  /** ¿El video trae audio? Igual que la cola: ante la duda, mudo. */
  function tieneAudio(archivo) {
    return HPEngine.call("mediaHasAudio", { path: archivo })
      .then(function (r) { return !!(r && r.hasAudio); })
      .catch(function () { return false; });
  }

  /** Lo que no se pudo reemplazar entra como una generación, en su segundo. */
  function colocar(aviso) {
    var m = aviso.marker || {};
    return tieneAudio(aviso.archivo).then(function (hasAudio) {
      return new Promise(function (resolve) {
        HPHost.placeClip(aviso.archivo, aviso.sequenceName, Number(m.start) || 0, Number(m.duration) || 0,
          -1, hasAudio, resolve);
      });
    }).then(function (r) {
      r = String(r || "");
      if (r === "ok") {
        log("Render de Studio: " + aviso.etiqueta + " no tenía clip en la secuencia; lo coloqué en " +
          HPUtil.formatTime(Number(m.start) || 0) + ".");
        contar({ ok: true, aviso: aviso, como: "colocado",
          texto: "✓ Render de Studio: " + aviso.etiqueta + " colocado en la secuencia (no había clip que reemplazar)." });
        return;
      }
      log("Render de Studio: " + aviso.etiqueta + " quedó guardado pero no se pudo colocar: " + r, "WARN");
      contar({ ok: false, aviso: aviso,
        texto: "✗ El render de Studio quedó guardado como " + aviso.etiqueta + ", pero no se pudo colocar: " +
          r.replace(/^error:\s*/, "") });
    });
  }

  /** Aplica en Premiere UN render de Studio ya guardado como versión. */
  function aplicar(aviso) {
    if (!aviso || !aviso.ok) {
      var motivo = (aviso && aviso.error) || "Studio no dijo por qué";
      log("Render de Studio" + (aviso && aviso.etiqueta ? " de " + aviso.etiqueta : "") + ": " + motivo, "WARN");
      contar({ ok: false, aviso: aviso || {}, texto: "✗ " + motivo });
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      HPHost.relinkMedia(aviso.anteriores || [], aviso.archivo, resolve);
    }).then(function (res) {
      res = String(res || "");
      if (res.indexOf("ok|") === 0) {
        var partes = res.split("|");
        log("Render de Studio: " + aviso.etiqueta + " reemplazó a " + nombreDe(partes[2]) +
          " en Premiere (" + partes[1] + (partes[1] === "1" ? " ítem" : " ítems") + ").");
        contar({ ok: true, aviso: aviso, como: "reemplazado",
          texto: "✓ Render de Studio: " + aviso.etiqueta + " reemplazó al clip que estaba en la secuencia." });
        return;
      }
      if (res === "nada") return colocar(aviso);
      log("Render de Studio: " + aviso.etiqueta + " quedó guardado pero no pude reemplazar el clip: " + res, "WARN");
      contar({ ok: false, aviso: aviso,
        texto: "✗ El render de Studio quedó guardado como " + aviso.etiqueta +
          ", pero no pude reemplazar el clip: " + res.replace(/^error:\s*/, "") });
    });
  }

  /**
   * Empieza a escuchar los renders de Studio, si no se estaba escuchando ya.
   * `opciones.alTerminar(resultado)` se llama con cada render aplicado:
   * `{ ok, aviso, texto, como }`.
   */
  function escuchar(opciones) {
    if (opciones && typeof opciones.alTerminar === "function") alTerminar = opciones.alTerminar;
    if (escuchando) return;
    escuchando = true;
    HPEngine.callProg("escucharRendersDeStudio", {}, function (p) {
      if (!p || !p.renderDeStudio) return;
      var aviso = p.renderDeStudio;
      cadena = cadena.then(function () { return aplicar(aviso); }).catch(function () {});
    }).then(function () { escuchando = false; }, function () { escuchando = false; });
  }

  global.HPStudioRenders = {
    escuchar: escuchar,
    // Para los tests: aplicar un aviso sin pasar por el motor.
    _aplicar: aplicar,
    _escuchando: function () { return escuchando; }
  };
})(typeof window !== "undefined" ? window : this);
