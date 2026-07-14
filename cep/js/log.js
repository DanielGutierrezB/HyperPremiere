/**
 * HPLog — log en memoria del panel (para el botón "⬇ Log").
 *
 * Todo lo relevante (carga del motor, cola, errores) se escribe acá con
 * timestamp. El usuario lo baja a Descargas y nos lo manda ante una falla.
 * También captura los errores no atrapados de la ventana.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPLog.
 */
(function (global) {
  "use strict";

  var LOG = [];
  var LOG_MAX = 5000;

  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function stamp() {
    try {
      var d = new Date();
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
        pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    } catch (e) { return "?"; }
  }

  function log(msg, level) {
    var line = "[" + stamp() + "]" + (level ? " [" + level + "]" : "") + " " + msg;
    LOG.push(line);
    if (LOG.length > LOG_MAX) LOG.shift();
    try { if (typeof console !== "undefined" && console.log) console.log("[HyperPremiere]", msg); } catch (e) {}
  }

  // Errores no atrapados → al log (así el botón ⬇ los captura).
  try {
    global.addEventListener("error", function (ev) {
      log("window.onerror: " + (ev && ev.message) + " @ " + (ev && ev.filename) + ":" + (ev && ev.lineno), "ERROR");
    });
    global.addEventListener("unhandledrejection", function (ev) {
      var r = ev && ev.reason;
      log("promesa sin atrapar: " + (r && (r.stack || r.message) ? (r.stack || r.message) : r), "ERROR");
    });
  } catch (e) {}

  /**
   * Texto completo del log (encabezado con contexto + entradas).
   * ctx = { engineLoaded, enginePath, engineErr } (lo aporta HPEngine vía main).
   */
  function buildText(ctx) {
    ctx = ctx || {};
    var version = "?";
    try { version = document.getElementById("version-label") ? document.getElementById("version-label").textContent : "?"; } catch (e) {}
    var ua = "?"; try { ua = navigator.userAgent; } catch (e) {}
    var plat = "?"; try { plat = (typeof process !== "undefined" && process.platform) ? process.platform : "?"; } catch (e) {}
    var md = [];
    md.push("# HyperPremiere — log de diagnóstico");
    md.push("");
    md.push("- **Generado:** " + stamp());
    md.push("- **Versión panel:** " + version);
    md.push("- **Motor cargado:** " + (ctx.engineLoaded ? "✅ SÍ" : "❌ NO"));
    if (ctx.engineLoaded) md.push("- **Ruta del motor:** `" + ctx.enginePath + "`");
    md.push("- **Plataforma:** " + plat);
    md.push("- **Entradas de log:** " + LOG.length);
    md.push("- **UserAgent:** " + ua);
    if (ctx.engineErr) {
      md.push("");
      md.push("## Error del motor");
      md.push("");
      md.push("```");
      md.push(ctx.engineErr);
      md.push("```");
    }
    md.push("");
    md.push("## Entradas");
    md.push("");
    md.push("```log");
    md.push(LOG.join("\n"));
    md.push("```");
    md.push("");
    return md.join("\n");
  }

  /**
   * Baja el log a Descargas. Funciona aunque el motor NO haya cargado: usa el
   * fs de Node (ctx.nodeRequire) o, si no hay Node, un blob del navegador.
   */
  function download(ctx) {
    var text = buildText(ctx);
    // Nombre único: Hyperpremiere_log_YYYY-MM-DD_HH-MM-SS.md
    var stampFile = stamp().replace(/:/g, "-").replace(/\s/g, "_");
    var fileName = "Hyperpremiere_log_" + stampFile + ".md";
    // 1) Vía Node fs → carpeta Descargas del usuario (lo más confiable en CEP).
    try {
      var r = (ctx && ctx.nodeRequire) || (typeof require === "function" ? require : null);
      if (r) {
        var fs = r("fs"), os = r("os"), path = r("path");
        if (fs && os && path) {
          var dl = path.join(os.homedir(), "Downloads");
          try { if (fs.existsSync && !fs.existsSync(dl)) dl = os.homedir(); } catch (e) { dl = os.homedir(); }
          var outPath = path.join(dl, fileName);
          fs.writeFileSync(outPath, text, "utf8");
          log("Log descargado en " + outPath);
          return { ok: true, path: outPath };
        }
      }
    } catch (e) {
      log("downloadLog: fs falló (" + (e && e.message) + "), intento blob", "WARN");
    }
    // 2) Fallback: blob + <a download> (si el panel lo permite).
    try {
      var blob = new Blob([text], { type: "text/markdown" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = fileName;
      document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
      return { ok: true, path: "(descarga del navegador: " + fileName + ")" };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "no se pudo descargar" };
    }
  }

  global.HPLog = {
    log: log,
    stamp: stamp,
    buildText: buildText,
    download: download
  };
})(typeof window !== "undefined" ? window : this);
