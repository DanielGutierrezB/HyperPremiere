/**
 * HPEngine — carga y acceso al motor Node in-process (bridge/engine.js).
 *
 * El motor corre DENTRO del panel vía Node de CEP (--enable-nodejs): acá se
 * resuelve su ruta (extensión empaquetada, symlink dev, override manual), se
 * hace el require con busteo de cache (para que ⟳ traiga cambios) y se expone
 * una interfaz de llamadas que SIEMPRE devuelve Promise.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPEngine.
 */
(function (global) {
  "use strict";

  var hpLog = HPLog.log;

  var engine = null;      // módulo del motor, o null si no cargó
  var enginePath = "";    // ruta desde la que cargó
  var engineErr = "";     // diagnóstico de por qué NO cargó (se muestra al usuario)
  var nodeReq = null;     // require de Node capturado (para el log y utilidades)

  // Override manual para desarrollo: ruta absoluta a engine.js en localStorage
  // (antes había una ruta de la máquina de Daniel hardcodeada en el código).
  var DEV_ENGINE_KEY = "hyperpremiere::engine-path";

  hpLog("Panel iniciando…");

  (function loadEngine() {
    try {
      hpLog("loadEngine: buscando motor Node…");
      var req = (typeof global.cep_node !== "undefined" && global.cep_node && global.cep_node.require)
        ? global.cep_node.require
        : (typeof require === "function" ? require : null);
      nodeReq = req;
      if (!req) {
        // Node no está habilitado en el panel: --enable-nodejs no tomó efecto.
        engineErr = "Node NO está habilitado en el panel (no hay require ni window.cep_node). " +
          "Revisá que el manifest tenga --enable-nodejs y reiniciá Premiere. " +
          "typeof require=" + (typeof require) + ", cep_node=" + (typeof global.cep_node !== "undefined" && !!global.cep_node);
        hpLog(engineErr, "ERROR");
        return;
      }
      // fs para calcular el realpath del symlink (probamos ambos requires: en
      // algunos CEP window.cep_node.require no resuelve builtins pero el global sí).
      function tryReq(r, m) { try { return r(m); } catch (e) { return null; } }
      var _fs = tryReq(req, "fs");
      if (!_fs && typeof require === "function" && require !== req) _fs = tryReq(require, "fs");

      // Armar rutas CANDIDATAS al motor. La extensión suele ser un symlink al
      // repo: si CEP nos da la ruta del symlink SIN resolver, "<ext>/../bridge"
      // apunta a la carpeta de extensiones (no al repo) y no existe. Por eso
      // probamos también la ruta REAL (realpath) y el override manual.
      var candidates = [];
      try {
        var _cs = new CSInterface();
        var extDir = _cs.getSystemPath(SystemPath.EXTENSION);
        if (extDir) {
          candidates.push(extDir + "/bridge/engine.js");    // bridge DENTRO de la extensión (empaquetado)
          candidates.push(extDir + "/../bridge/engine.js"); // bridge hermano (symlink resuelto)
          if (_fs && _fs.realpathSync) {
            try {
              var real = _fs.realpathSync(extDir);
              candidates.push(real + "/bridge/engine.js");
              candidates.push(real + "/../bridge/engine.js"); // symlink → repo/cep → repo/bridge
            } catch (e) {}
          }
        }
      } catch (e) {}
      // Override manual (dev): localStorage con la ruta absoluta a engine.js.
      try {
        var devPath = global.localStorage.getItem(DEV_ENGINE_KEY);
        if (devPath) candidates.push(devPath);
      } catch (e) {}
      hpLog("loadEngine: fs=" + (!!_fs) + " · candidatas:\n  " + candidates.join("\n  "));

      // Vaciar cache del bridge para que ⟳ traiga cambios del motor.
      try {
        if (req.cache) {
          Object.keys(req.cache).forEach(function (k) {
            if (k.replace(/\\/g, "/").indexOf("/bridge/") !== -1) delete req.cache[k];
          });
        }
      } catch (e) {}

      // Intentar requerir cada candidata DE VERDAD (no dependemos de existsSync:
      // algunos CEP no exponen fs por este require). La primera que cargue gana.
      var errors = [];
      for (var ci = 0; ci < candidates.length && !engine; ci++) {
        var cand = candidates[ci];
        if (!cand) continue;
        try {
          var mod = req(cand);
          if (mod) { engine = mod; enginePath = cand; hpLog("loadEngine: ✓ motor cargado desde " + cand); }
        } catch (e) {
          errors.push(cand + "  →  " + (e && (e.message || e)));
          hpLog("loadEngine: ✗ " + cand + " → " + (e && (e.message || e)), "WARN");
        }
      }
      if (!engine) {
        engineErr = "No pude cargar el motor. Rutas probadas:\n- " + errors.join("\n- ");
        hpLog(engineErr, "ERROR");
      }
    } catch (e) {
      engine = null;
      // Capturar la causa REAL (stack completo) para no andar adivinando.
      var detail = (e && (e.stack || e.message)) ? String(e.stack || e.message) : String(e);
      engineErr = "El motor falló al cargar (loadEngine).\n" + detail;
      hpLog(engineErr, "ERROR");
      try { if (typeof console !== "undefined" && console.error) console.error("[HyperPremiere] loadEngine:", e); } catch (e2) {}
    }
  })();

  // Mensaje de error del motor: real si lo tenemos, genérico si no.
  function errMsg() {
    return engineErr
      ? ("Motor no disponible.\n" + engineErr)
      : "Motor no disponible. Cerrá y reabrí Premiere para activar Node en el panel.";
  }

  /**
   * Llama a un método del motor y devuelve SIEMPRE una Promise (los métodos
   * sync como getConfig también quedan envueltos). Si Node no está disponible,
   * rechaza con un mensaje claro.
   */
  function call(method, arg) {
    if (!engine || typeof engine[method] !== "function") {
      return Promise.reject(new Error(engine ? ("El motor cargó pero no tiene el método '" + method + "'.") : errMsg()));
    }
    try {
      return Promise.resolve(engine[method](arg));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** Igual que call pero pasa un callback de progreso (prepareEngine, cola, etc.). */
  function callProg(method, arg, prog) {
    if (!engine || typeof engine[method] !== "function") {
      return Promise.reject(new Error(errMsg()));
    }
    try { return Promise.resolve(engine[method](arg, prog)); }
    catch (e) { return Promise.reject(e); }
  }

  global.HPEngine = {
    call: call,
    callProg: callProg,
    errMsg: errMsg,
    isLoaded: function () { return !!engine; },
    path: function () { return enginePath; },
    error: function () { return engineErr; },
    nodeRequire: function () { return nodeReq; }
  };
})(typeof window !== "undefined" ? window : this);
