/**
 * HPUtil — helpers puros del panel (sin DOM, sin estado).
 * Vanilla JS, sin ES modules: se expone como window.HPUtil.
 */
(function (global) {
  "use strict";

  /** Debounce clásico: pospone fn hasta `delay` ms después de la última llamada. */
  function debounce(fn, delay) {
    var timer = null;
    return function () {
      var args = arguments;
      var self = this;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        fn.apply(self, args);
      }, delay);
    };
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** Segundos → "mm:ss" (para timecodes de marcadores). */
  function formatTime(seconds) {
    var total = Math.floor(seconds);
    var mm = Math.floor(total / 60);
    var ss = total % 60;
    return (mm < 10 ? "0" + mm : mm) + ":" + (ss < 10 ? "0" + ss : ss);
  }

  /** Duración legible: "45s" o "1m 12s". */
  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m ? (m + "m " + (s < 10 ? "0" : "") + s + "s") : (s + "s");
  }

  /** Número con separador de miles (1234 -> "1.234"). */
  function addThousands(n) {
    n = Math.round(Number(n) || 0);
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  /** Compacto para etiquetas cortas (1234 -> "1,2k"). */
  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(".", ",") + "k";
    return String(n);
  }

  global.HPUtil = {
    debounce: debounce,
    escapeHtml: escapeHtml,
    formatTime: formatTime,
    fmtDuration: fmtDuration,
    addThousands: addThousands,
    fmtTokens: fmtTokens
  };
})(typeof window !== "undefined" ? window : this);
