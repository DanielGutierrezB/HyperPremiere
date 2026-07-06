(function () {
  "use strict";

  var DEBOUNCE_MS = 300;

  // Índices de etiqueta de color de Premiere (orden del menú Etiqueta):
  // café (marrón) = borrador; magenta = procesado en alta calidad.
  var HP_COLOR_BROWN = 14;
  var HP_COLOR_MAGENTA = 11;

  // Clave especial de HPStore para el "Prompt general" (instrucción + stills +
  // recursos que aplican a TODOS los marcadores). Reusa toda la maquinaria de
  // marcador (getMarkerData/addMarkerStill/…) sin ser un marcador real.
  var GEN_KEY = "__general__";

  // Timing auto-calibrado para estimar la cola: promedio de segundos por job de
  // modelo, y segundos de render por segundo de composición. Se afina con el uso.
  var HP_TIMING = { modelJobs: 0, modelSec: 0, renderCompSec: 0, renderSec: 0 };
  try { var _t = JSON.parse(window.localStorage.getItem("hyperpremiere::timing") || "null"); if (_t && typeof _t === "object") HP_TIMING = _t; } catch (e) {}
  function saveTiming() { try { window.localStorage.setItem("hyperpremiere::timing", JSON.stringify(HP_TIMING)); } catch (e) {} }
  function avgModelSec() { return HP_TIMING.modelJobs > 0 ? (HP_TIMING.modelSec / HP_TIMING.modelJobs) : 150; }      // default ~2.5 min
  function renderSecPerCompSec() { return HP_TIMING.renderCompSec > 0 ? (HP_TIMING.renderSec / HP_TIMING.renderCompSec) : 4; } // default 4×

  // ── Log en memoria (para el botón "Descargar log") ──────────────────
  // Todo lo relevante (carga del motor, cola, errores) se escribe acá con
  // timestamp. El usuario lo baja a Descargas y nos lo manda ante una falla.
  var HP_LOG = [];
  var HP_LOG_MAX = 5000;
  var HP_REQ = null; // require de Node capturado por loadEngine (para escribir el archivo).
  function hpPad(n) { return n < 10 ? "0" + n : "" + n; }
  function hpStamp() {
    try {
      var d = new Date();
      return d.getFullYear() + "-" + hpPad(d.getMonth() + 1) + "-" + hpPad(d.getDate()) + " " +
        hpPad(d.getHours()) + ":" + hpPad(d.getMinutes()) + ":" + hpPad(d.getSeconds());
    } catch (e) { return "?"; }
  }
  function hpLog(msg, level) {
    var line = "[" + hpStamp() + "]" + (level ? " [" + level + "]" : "") + " " + msg;
    HP_LOG.push(line);
    if (HP_LOG.length > HP_LOG_MAX) HP_LOG.shift();
    try { if (typeof console !== "undefined" && console.log) console.log("[HyperPremiere]", msg); } catch (e) {}
  }
  hpLog("Panel iniciando…");

  // Motor "todo en uno": corre dentro del panel vía Node (CEP --enable-nodejs).
  // La ruta se deriva de la carpeta de la extensión (cross-platform: mac/Windows),
  // el bridge vive en <extensión>/../bridge. Fallback dev por si CEP no la da.
  var HP_ENGINE = null;
  // Diagnóstico de por qué el motor no cargó (se muestra al usuario en vez del
  // mensaje genérico). Lo llena loadEngine().
  var HP_ENGINE_ERR = "";
  var ENGINE_PATH = "/Users/danielgutierrez/Desktop/Codigo/HyperPremiere/bridge/engine.js";
  (function loadEngine() {
    try {
      hpLog("loadEngine: buscando motor Node…");
      var req = (typeof window !== "undefined" && window.cep_node && window.cep_node.require)
        ? window.cep_node.require
        : (typeof require === "function" ? require : null);
      HP_REQ = req;
      if (!req) {
        // Node no está habilitado en el panel: --enable-nodejs no tomó efecto.
        HP_ENGINE_ERR = "Node NO está habilitado en el panel (no hay require ni window.cep_node). " +
          "Revisá que el manifest tenga --enable-nodejs y reiniciá Premiere. " +
          "typeof require=" + (typeof require) + ", cep_node=" + (typeof window !== "undefined" && !!window.cep_node);
        hpLog(HP_ENGINE_ERR, "ERROR");
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
      // probamos también la ruta REAL (realpath) y el fallback dev hardcodeado.
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
      candidates.push(ENGINE_PATH); // fallback dev (repo de Daniel)
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
      for (var ci = 0; ci < candidates.length && !HP_ENGINE; ci++) {
        var cand = candidates[ci];
        if (!cand) continue;
        try {
          var mod = req(cand);
          if (mod) { HP_ENGINE = mod; ENGINE_PATH = cand; hpLog("loadEngine: ✓ motor cargado desde " + cand); }
        } catch (e) {
          errors.push(cand + "  →  " + (e && (e.message || e)));
          hpLog("loadEngine: ✗ " + cand + " → " + (e && (e.message || e)), "WARN");
        }
      }
      if (!HP_ENGINE) {
        HP_ENGINE_ERR = "No pude cargar el motor. Rutas probadas:\n- " + errors.join("\n- ");
        hpLog(HP_ENGINE_ERR, "ERROR");
      }
    } catch (e) {
      HP_ENGINE = null;
      // Capturar la causa REAL (stack completo) para no andar adivinando.
      var detail = (e && (e.stack || e.message)) ? String(e.stack || e.message) : String(e);
      HP_ENGINE_ERR = "El motor falló al cargar (loadEngine).\n" + detail;
      hpLog(HP_ENGINE_ERR, "ERROR");
      try { if (typeof console !== "undefined" && console.error) console.error("[HyperPremiere] loadEngine:", e); } catch (e2) {}
    }
  })();

  // Handler global de errores no atrapados → al log (así el botón los captura).
  try {
    window.addEventListener("error", function (ev) {
      hpLog("window.onerror: " + (ev && ev.message) + " @ " + (ev && ev.filename) + ":" + (ev && ev.lineno), "ERROR");
    });
    window.addEventListener("unhandledrejection", function (ev) {
      var r = ev && ev.reason;
      hpLog("promesa sin atrapar: " + (r && (r.stack || r.message) ? (r.stack || r.message) : r), "ERROR");
    });
  } catch (e) {}

  // Construye el texto del log (encabezado con contexto + entradas) y lo baja a
  // Descargas. Funciona aunque el motor NO haya cargado (usa fs directo o, si no
  // hay Node, un blob de descarga del navegador).
  function buildLogText() {
    var version = "?";
    try { version = document.getElementById("version-label") ? document.getElementById("version-label").textContent : "?"; } catch (e) {}
    var ua = "?"; try { ua = navigator.userAgent; } catch (e) {}
    var plat = "?"; try { plat = (typeof process !== "undefined" && process.platform) ? process.platform : "?"; } catch (e) {}
    var md = [];
    md.push("# HyperPremiere — log de diagnóstico");
    md.push("");
    md.push("- **Generado:** " + hpStamp());
    md.push("- **Versión panel:** " + version);
    md.push("- **Motor cargado:** " + (HP_ENGINE ? "✅ SÍ" : "❌ NO"));
    if (HP_ENGINE) md.push("- **Ruta del motor:** `" + ENGINE_PATH + "`");
    md.push("- **Plataforma:** " + plat);
    md.push("- **Entradas de log:** " + HP_LOG.length);
    md.push("- **UserAgent:** " + ua);
    if (HP_ENGINE_ERR) {
      md.push("");
      md.push("## Error del motor");
      md.push("");
      md.push("```");
      md.push(HP_ENGINE_ERR);
      md.push("```");
    }
    md.push("");
    md.push("## Entradas");
    md.push("");
    md.push("```log");
    md.push(HP_LOG.join("\n"));
    md.push("```");
    md.push("");
    return md.join("\n");
  }

  function downloadLog() {
    var text = buildLogText();
    // Nombre único: Hyperpremiere_log_YYYY-MM-DD_HH-MM-SS.md
    var stampFile = hpStamp().replace(/:/g, "-").replace(/\s/g, "_");
    var fileName = "Hyperpremiere_log_" + stampFile + ".md";
    // 1) Vía Node fs → carpeta Descargas del usuario (lo más confiable en CEP).
    try {
      var r = HP_REQ || (typeof require === "function" ? require : null);
      if (r) {
        var fs = r("fs"), os = r("os"), path = r("path");
        if (fs && os && path) {
          var dl = path.join(os.homedir(), "Downloads");
          try { if (fs.existsSync && !fs.existsSync(dl)) dl = os.homedir(); } catch (e) { dl = os.homedir(); }
          var outPath = path.join(dl, fileName);
          fs.writeFileSync(outPath, text, "utf8");
          hpLog("Log descargado en " + outPath);
          return { ok: true, path: outPath };
        }
      }
    } catch (e) {
      hpLog("downloadLog: fs falló (" + (e && e.message) + "), intento blob", "WARN");
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

  // Mensaje de error del motor: real si lo tenemos, genérico si no.
  function engineErrMsg() {
    return HP_ENGINE_ERR
      ? ("Motor no disponible.\n" + HP_ENGINE_ERR)
      : "Motor no disponible. Cerrá y reabrí Premiere para activar Node en el panel.";
  }

  // Llama a un método del motor y devuelve SIEMPRE una Promise (los métodos
  // sync como getConfig también quedan envueltos). Si Node no está disponible,
  // rechaza con un mensaje claro.
  function hpCall(method, arg) {
    if (!HP_ENGINE || typeof HP_ENGINE[method] !== "function") {
      return Promise.reject(new Error(HP_ENGINE ? ("El motor cargó pero no tiene el método '" + method + "'.") : engineErrMsg()));
    }
    try {
      return Promise.resolve(HP_ENGINE[method](arg));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  // Igual que hpCall pero pasa un callback de progreso (para prepareEngine, etc.).
  function hpCallProg(method, arg, prog) {
    if (!HP_ENGINE || typeof HP_ENGINE[method] !== "function") {
      return Promise.reject(new Error(engineErrMsg()));
    }
    try { return Promise.resolve(HP_ENGINE[method](arg, prog)); }
    catch (e) { return Promise.reject(e); }
  }

  var csInterface = new CSInterface();

  // CEP NO re-evalúa el ScriptPath (host.jsx) al recargar el panel: mantiene el
  // motor ExtendScript viejo en memoria. Lo recargamos explícitamente en cada
  // apertura para que los cambios del .jsx siempre tomen efecto.
  (function reloadHostJsx() {
    try {
      var ext = csInterface.getSystemPath(SystemPath.EXTENSION);
      csInterface.evalScript('$.evalFile("' + ext + '/jsx/host.jsx")');
    } catch (e) {}
  })();

  var btnLoadMarkers = document.getElementById("btn-load-markers");
  var output = document.getElementById("output");
  var markersContainer = document.getElementById("markers");
  var objectiveInput = document.getElementById("objective");
  var btnLoadTranscript = document.getElementById("btn-load-transcript");
  var transcriptFileInput = document.getElementById("transcript-file");
  var transcriptStatus = document.getElementById("transcript-status");

  function setOutput(text, isError) {
    output.textContent = text;
    output.classList.toggle("is-error", Boolean(isError));
  }

  function formatTime(seconds) {
    var total = Math.floor(seconds);
    var mm = Math.floor(total / 60);
    var ss = total % 60;
    return (mm < 10 ? "0" + mm : mm) + ":" + (ss < 10 ? "0" + ss : ss);
  }

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

  // Editor de código con resaltado de sintaxis: textarea transparente encima de
  // un <pre> coloreado por Prism (sirve offline, sin CDN). Devuelve { el,
  // getValue, setValue }. Resalta HTML + CSS + JS embebidos.
  function makeCodeEditor() {
    var box = document.createElement("div");
    box.className = "code-edit";
    var pre = document.createElement("pre");
    pre.className = "code-hl";
    pre.setAttribute("aria-hidden", "true");
    var code = document.createElement("code");
    pre.appendChild(code);
    var input = document.createElement("textarea");
    input.className = "code-input";
    input.spellcheck = false;
    box.appendChild(pre);
    box.appendChild(input);

    function paint() {
      var src = input.value;
      if (typeof Prism !== "undefined" && Prism.languages && Prism.languages.markup) {
        // Newline final: Prism/pre necesita que la última línea tenga cierre.
        code.innerHTML = Prism.highlight(src + "\n", Prism.languages.markup, "markup");
      } else {
        code.innerHTML = escapeHtml(src) + "\n";
      }
    }
    function sync() { pre.scrollTop = input.scrollTop; pre.scrollLeft = input.scrollLeft; }

    input.addEventListener("input", paint);
    input.addEventListener("scroll", sync);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Tab") {
        e.preventDefault();
        var s = input.selectionStart, en = input.selectionEnd;
        input.value = input.value.slice(0, s) + "  " + input.value.slice(en);
        input.selectionStart = input.selectionEnd = s + 2;
        paint();
      }
    });

    return {
      el: box,
      getValue: function () { return input.value; },
      setValue: function (v) { input.value = String(v == null ? "" : v); paint(); sync(); },
      focus: function () { input.focus(); }
    };
  }

  function slug(text) {
    var s = String(text).toLowerCase();
    // Quitar acentos: NFD separa la letra base de su diacritico.
    if (typeof s.normalize === "function") {
      s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    } else {
      s = s
        .replace(/[áàäâã]/g, "a")
        .replace(/[éèëê]/g, "e")
        .replace(/[íìïî]/g, "i")
        .replace(/[óòöôõ]/g, "o")
        .replace(/[úùüû]/g, "u")
        .replace(/ñ/g, "n")
        .replace(/ç/g, "c");
    }
    return s.replace(/[^a-z0-9]+/g, "-");
  }

  // Nombre/ID consecutivo por orden del marcador: "Marcador 1", "Marcador 2"…
  // Es la nomenclatura que ve el editor Y la que usan los archivos generados.
  function markerKeyFor(marker) {
    return "Marcador " + (marker.index + 1);
  }

  // ---------------------------------------------------------------------
  // Contexto (proyecto + secuencia) para HPStore
  // ---------------------------------------------------------------------

  var currentProjectPath = "";
  var currentSequenceName = "";
  // Proveedor local (Ollama): la cola NO solapa modelo+render (ambos usan la máquina).
  var currentProviderIsLocal = false;
  var currentModelName = ""; // para el log de diagnóstico
  // Modo borrador (render rápido, menor calidad) — preferencia global de sesión.
  var draftMode = false;
  try { draftMode = window.localStorage.getItem("hyperpremiere::draft") === "1"; } catch (e) {}

  var lastRestoredProject = null; // para restaurar la cola solo al cambiar de proyecto
  function loadContext(done) {
    csInterface.evalScript("hp_getProjectPath()", function (projectPath) {
      csInterface.evalScript("hp_getActiveSequenceName()", function (sequenceName) {
        currentProjectPath = projectPath || "";
        currentSequenceName = sequenceName || "";
        HPStore.setContext(currentProjectPath, currentSequenceName);
        // Al abrir el panel o cambiar de proyecto, cargar la cola guardada de ESE
        // proyecto (queue.json en su carpeta HyperPremiere).
        if (currentProjectPath !== lastRestoredProject) {
          lastRestoredProject = currentProjectPath;
          HPQueue.restore(currentProjectPath);
        }
        if (done) done();
      });
    });
  }

  // ---------------------------------------------------------------------
  // Objetivo
  // ---------------------------------------------------------------------

  function hydrateObjective() {
    if (!objectiveInput) return;
    objectiveInput.value = HPStore.getObjective();
  }

  // ── Prompt general (aplica a todos los marcadores) ──────────────────
  var generalInput = document.getElementById("general-instruction");
  var generalMount = document.getElementById("general-stills-mount");
  var generalSummary = document.getElementById("general-summary");
  function updateGeneralSummary() {
    if (!generalSummary) return;
    var g = HPStore.getMarkerData(GEN_KEY);
    var n = (g.stills ? g.stills.length : 0) + (g.resources ? g.resources.length : 0);
    var hasTxt = (g.instruction || "").trim().length > 0;
    generalSummary.textContent = (hasTxt || n) ? ("✓" + (n ? " · " + n + " adj." : "")) : "";
  }
  function hydrateGeneral() {
    if (generalInput) generalInput.value = HPStore.getMarkerData(GEN_KEY).instruction || "";
    if (generalMount) {
      generalMount.innerHTML = "";
      generalMount.appendChild(createStillsControl(GEN_KEY));
    }
    updateGeneralSummary();
  }
  if (generalInput) {
    generalInput.addEventListener("input", debounce(function () {
      HPStore.setMarkerInstruction(GEN_KEY, generalInput.value);
      updateGeneralSummary();
    }, DEBOUNCE_MS));
  }

  if (objectiveInput) {
    objectiveInput.addEventListener(
      "input",
      debounce(function () {
        HPStore.setObjective(objectiveInput.value);
      }, DEBOUNCE_MS)
    );
  }

  // ---------------------------------------------------------------------
  // Transcript
  // ---------------------------------------------------------------------

  function transcriptDuration(segments) {
    var max = 0;
    for (var i = 0; i < segments.length; i++) {
      if (segments[i] && segments[i].end > max) max = segments[i].end;
    }
    return max;
  }

  function updateTranscriptStatus() {
    if (!transcriptStatus) return;
    var segments = HPStore.getTranscript();
    if (!segments || segments.length === 0) {
      transcriptStatus.textContent = "";
      return;
    }
    transcriptStatus.textContent =
      segments.length + " segmentos · " + formatTime(transcriptDuration(segments)) + " total";
  }

  // Deriva el objetivo de la clase llamando al puente (/derive-objective).
  // El resultado llena #objective pero queda editable por el editor.
  function deriveObjectiveFromTranscript(segments) {
    if (objectiveInput) {
      objectiveInput.setAttribute("placeholder", "Derivando objetivo del transcript…");
    }
    hpCall("deriveObjective", { transcript: segments })
      .then(function (data) {
        if (data && data.ok && data.objective) {
          objectiveInput.value = data.objective;
          HPStore.setObjective(data.objective);
        }
        if (data && data.usage) { HPStore.addSessionUsage(data.usage); updateSessionUsageBar(); }
      })
      .catch(function () {
        // Silencioso: el editor puede escribir el objetivo a mano si el puente no está.
      })
      .then(function () {
        if (objectiveInput) {
          objectiveInput.setAttribute(
            "placeholder",
            "Describe qué debe lograr el estudiante al terminar esta clase. Se usa como contexto para generar instrucciones por marcador."
          );
        }
      });
  }

  function onTranscriptFileChosen() {
    var file = transcriptFileInput.files && transcriptFileInput.files[0];
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function () {
      var res = HPTranscript.parse(reader.result);
      if (!res.segments.length) {
        transcriptStatus.textContent = "No se reconocieron segmentos en el archivo.";
        return;
      }
      HPStore.setTranscript(res.segments);
      updateTranscriptStatus();
      // La IA deriva el objetivo de la clase desde el transcript.
      // Solo si el objetivo está vacío (no pisar lo que el editor haya escrito).
      if (!HPStore.getObjective() || !HPStore.getObjective().trim()) {
        deriveObjectiveFromTranscript(res.segments);
      }
    };
    reader.onerror = function () {
      transcriptStatus.textContent = "No se pudo leer el archivo.";
    };
    reader.readAsText(file);
    // Permitir volver a elegir el mismo archivo.
    transcriptFileInput.value = "";
  }

  if (btnLoadTranscript && transcriptFileInput) {
    btnLoadTranscript.addEventListener("click", function () {
      transcriptFileInput.click();
    });
    transcriptFileInput.addEventListener("change", onTranscriptFileChosen);
  }

  // ---------------------------------------------------------------------
  // Marcadores
  // ---------------------------------------------------------------------

  function selectCard(card) {
    var cards = markersContainer.querySelectorAll(".marker-card");
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.remove("is-selected");
    }
    card.classList.add("is-selected");
  }

  function onHeaderClick(card, marker) {
    selectCard(card);
    csInterface.evalScript("hp_seekToTime(" + marker.start + ")", function (result) {
      if (result !== "ok") {
        setOutput("No se pudo mover el playhead: " + result, true);
      }
    });
  }

  // Fuente para el <img> del thumbnail: data URL tal cual, o ruta de archivo
  // (captura guardada en disco) servida por file:// (encodeURI para espacios).
  function stillThumbSrc(s) {
    s = String(s || "");
    if (/^data:/i.test(s) || /^file:\/\//i.test(s)) return s;
    return "file://" + encodeURI(s);
  }
  // De un getMarkerData, devuelve solo las imágenes marcadas "usar" (recurso a incrustar).
  function assetSrcsOf(d) {
    var out = [], s = (d && d.stills) || [], u = (d && d.stillUse) || [];
    for (var i = 0; i < s.length; i++) if (u[i]) out.push(s[i]);
    return out;
  }
  function renderStills(container, markerKey) {
    container.innerHTML = "";
    var data = HPStore.getMarkerData(markerKey);
    var stills = data.stills, uses = data.stillUse || [];

    for (var i = 0; i < stills.length; i++) {
      (function (index) {
        var thumb = document.createElement("div");
        thumb.className = "still-thumb";

        var img = document.createElement("img");
        img.src = stillThumbSrc(stills[index]);

        var remove = document.createElement("button");
        remove.type = "button";
        remove.className = "still-remove";
        remove.textContent = "x";
        remove.title = "Quitar esta imagen del marcador";
        remove.addEventListener("click", function () {
          HPStore.removeMarkerStill(markerKey, index);
          renderStills(container, markerKey);
          if (markerKey === GEN_KEY) updateGeneralSummary();
        });

        // Etiqueta Referencia ⇄ Usar: define si la imagen se INCRUSTA (usar) o
        // solo sirve de contexto visual (referencia, default). Evita que el modelo
        // adivine y meta la imagen equivocada.
        var isUse = !!uses[index];
        var tag = document.createElement("button");
        tag.type = "button";
        tag.className = "still-tag" + (isUse ? " is-use" : "");
        tag.textContent = isUse ? "✓ usar" : "referencia";
        tag.title = isUse
          ? "Se INCRUSTA en el gráfico (logo/icono/foto). Clic para volver a solo referencia."
          : "Solo referencia visual (contexto). Clic para marcarla como recurso a INCRUSTAR.";
        tag.addEventListener("click", function () {
          HPStore.setMarkerStillUse(markerKey, index, !isUse);
          renderStills(container, markerKey);
          if (markerKey === GEN_KEY) updateGeneralSummary();
        });

        thumb.appendChild(img);
        thumb.appendChild(remove);
        thumb.appendChild(tag);
        container.appendChild(thumb);
      })(i);
    }
  }

  // Lista de recursos de referencia (PDFs, docs, etc.) del marcador.
  function renderResources(container, markerKey) {
    container.innerHTML = "";
    var resources = HPStore.getMarkerData(markerKey).resources || [];
    for (var i = 0; i < resources.length; i++) {
      (function (index) {
        var chip = document.createElement("div");
        chip.className = "resource-chip";
        var icon = document.createElement("span");
        icon.className = "resource-icon";
        icon.textContent = /pdf/i.test(resources[index].mediaType) ? "📄" : "📎";
        var name = document.createElement("span");
        name.className = "resource-name";
        name.textContent = resources[index].name || "recurso";
        var remove = document.createElement("button");
        remove.type = "button";
        remove.className = "resource-remove";
        remove.textContent = "×";
        remove.title = "Quitar este recurso del marcador";
        remove.addEventListener("click", function () {
          HPStore.removeMarkerResource(markerKey, index);
          renderResources(container, markerKey);
        });
        chip.appendChild(icon);
        chip.appendChild(name);
        chip.appendChild(remove);
        container.appendChild(chip);
      })(i);
    }
  }

  // Ingesta de una lista de File: imágenes → stills, el resto → recursos.
  function ingestFiles(files, markerKey, thumbs, resList, statusEl) {
    if (!files || !files.length) return;
    var pending = files.length;
    function done() {
      pending--;
      if (pending === 0) { renderStills(thumbs, markerKey); renderResources(resList, markerKey); }
    }
    for (var i = 0; i < files.length; i++) {
      (function (file) {
        var reader = new FileReader();
        var isImage = /^image\//i.test(file.type) || /\.(png|jpe?g|webp|gif)$/i.test(file.name || "");
        reader.onload = function () {
          if (isImage) {
            HPStore.addMarkerStill(markerKey, reader.result);
          } else {
            HPStore.addMarkerResource(markerKey, {
              name: file.name || "recurso",
              dataUrl: reader.result,
              mediaType: file.type || ""
            });
          }
          done();
        };
        reader.onerror = done;
        reader.readAsDataURL(file);
      })(files[i]);
    }
    if (statusEl) statusEl.textContent = "";
  }

  function createStillsControl(markerKey) {
    var wrap = document.createElement("div");
    wrap.className = "marker-stills";

    var thumbs = document.createElement("div");
    thumbs.className = "still-thumbs";

    var resList = document.createElement("div");
    resList.className = "resource-list";

    var fileInput = document.createElement("input");
    fileInput.type = "file";
    // Todo tipo de recursos: imágenes (stills) + PDFs/docs/referencias.
    fileInput.accept = "image/*,application/pdf,.pdf,.txt,.md,.csv,.json,.doc,.docx";
    fileInput.multiple = true;
    fileInput.style.display = "none";

    // Botón principal: capturar el frame ACTUAL del monitor de programa.
    var captureBtn = document.createElement("button");
    captureBtn.type = "button";
    captureBtn.className = "btn-add-still";
    captureBtn.textContent = "📸 Capturar del programa";
    captureBtn.title = "Toma el frame actual del monitor de programa como imagen de referencia para este marcador";

    var stillStatus = document.createElement("div");
    stillStatus.className = "still-status";

    captureBtn.addEventListener("click", function () {
      captureProgramStill(markerKey, thumbs, captureBtn, stillStatus);
    });

    // Zona drag & drop: al clicar abre el selector; al soltar, ingiere.
    var drop = document.createElement("div");
    drop.className = "dropzone";
    drop.innerHTML = '<span class="dz-text">Arrastrá imágenes, PDFs o referencias aquí, o <u>hacé clic para elegir</u></span>';
    drop.addEventListener("click", function () { fileInput.click(); });
    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("is-over"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("is-over"); });
    drop.addEventListener("drop", function (e) {
      e.preventDefault();
      drop.classList.remove("is-over");
      var files = e.dataTransfer && e.dataTransfer.files;
      ingestFiles(files, markerKey, thumbs, resList, stillStatus);
    });

    fileInput.addEventListener("change", function () {
      ingestFiles(fileInput.files, markerKey, thumbs, resList, stillStatus);
      fileInput.value = "";
    });

    wrap.appendChild(captureBtn);
    wrap.appendChild(drop);
    wrap.appendChild(fileInput);
    wrap.appendChild(stillStatus);
    wrap.appendChild(thumbs);
    wrap.appendChild(resList);
    renderStills(thumbs, markerKey);
    renderResources(resList, markerKey);
    return wrap;
  }

  // Re-renderiza los stills/recursos buscando el contenedor VIVO en el DOM (no un
  // closure que pudo quedar viejo si la tarjeta se re-renderizó). markerKey puede
  // ser GEN_KEY (zona de prompt general) o la clave de un marcador.
  function refreshStills(markerKey) {
    var mount = null;
    if (markerKey === GEN_KEY) {
      mount = document.getElementById("general-stills-mount");
    } else if (markersContainer) {
      var cards = markersContainer.querySelectorAll("details.marker-card");
      for (var i = 0; i < cards.length; i++) { if (cards[i]._markerKey === markerKey) { mount = cards[i]; break; } }
    }
    if (!mount) return false;
    var t = mount.querySelector(".still-thumbs"), r = mount.querySelector(".resource-list");
    if (t) renderStills(t, markerKey);
    if (r) renderResources(r, markerKey);
    return true;
  }

  // Captura el frame actual del monitor de programa (host.jsx exportFramePNG), lo
  // GUARDA en la carpeta de la secuencia (engine.saveCapture) y lo agrega como
  // still del marcador. Nota: QE muestra un alert nativo "Exported frame …" que
  // hay que cerrar (comportamiento de Premiere, no del plugin).
  function captureProgramStill(markerKey, thumbs, btn, statusEl) {
    var tmpPath = "/tmp/hp-still-" + (new Date().getTime()) + ".png";
    var arg = JSON.stringify(tmpPath);
    var prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Capturando…";
    if (statusEl) { statusEl.textContent = ""; statusEl.className = "still-status"; }
    hpLog("Captura de programa para [" + markerKey + "] → " + tmpPath);

    function fail(msg) {
      if (statusEl) { statusEl.textContent = msg; statusEl.className = "still-status is-error"; }
      btn.textContent = prev;
      btn.disabled = false;
    }

    csInterface.evalScript("hp_captureProgramFrame(" + arg + ")", function (result) {
      hpLog("Captura: host devolvió " + (result || "(vacío)"));
      if (!result || result.indexOf("ok|") !== 0) {
        fail("No se pudo capturar: " + (result || "sin secuencia/monitor"));
        return;
      }
      var realPath = result.substring(3); // "ok|<ruta real>"
      hpCall("saveCapture", {
        projectPath: currentProjectPath, sequenceName: currentSequenceName,
        markerSlug: markerKey, tmpPath: realPath
      }).then(function (res) {
        if (res && res.ok && (res.savedPath || res.dataUrl)) {
          // Guardamos la RUTA en disco (no el base64) → no revienta la cuota de
          // localStorage. El engine la lee y la convierte a imagen al generar.
          HPStore.addMarkerStill(markerKey, res.savedPath || res.dataUrl);
          // Refrescar por el contenedor VIVO (robusto ante re-render) + fallback al closure.
          if (!refreshStills(markerKey) && thumbs) renderStills(thumbs, markerKey);
          if (markerKey === GEN_KEY) updateGeneralSummary();
          if (statusEl) statusEl.textContent = "✓ guardada en la carpeta de la secuencia";
          hpLog("Captura OK → " + res.savedPath + " · agregada a [" + markerKey + "]");
          btn.textContent = prev; btn.disabled = false;
        } else {
          fail("No se pudo guardar el frame: " + ((res && res.error) || ""));
          hpLog("saveCapture FALLÓ: " + ((res && res.error) || ""), "WARN");
        }
      }).catch(function (e) {
        fail((e && e.message) || "error guardando el frame");
        hpLog("saveCapture excepción: " + ((e && e.message) || e), "ERROR");
      });
    });
  }

  function createTranscriptSlice(marker) {
    var segments = HPStore.getTranscript();
    if (!segments || !segments.length) return null;

    var slice = HPTranscript.sliceByRange(segments, marker.start, marker.start + marker.duration);
    if (!slice.length) return null;

    var texts = [];
    for (var i = 0; i < slice.length; i++) {
      texts.push(slice[i].text);
    }

    var el = document.createElement("div");
    el.className = "transcript-slice";
    el.textContent = texts.join(" ");
    return el;
  }

  // Clasifica un fallo: distingue "sin tokens / límite alcanzado" (reactivable
  // cuando se reinicie el uso) del resto de errores. Detecta por el texto del
  // error (los proveedores incluyen "HTTP 429", "usage limit", "quota", etc.).
  function classifyFailure(err) {
    var msg = (err && err.message) ? err.message : String(err || "");
    var low = msg.toLowerCase();
    var rate = /http 429|\b429\b|too many requests|rate[ _-]?limit|usage limit|limit reached|resets? at|quota|insufficient[_ ]?quota|credit balance|out of credit|billing|payment required|\b402\b|overloaded|\b529\b/.test(low);
    return { rate: rate, msg: msg };
  }
  function shortenErr(msg) {
    msg = String(msg || "").replace(/\s+/g, " ").trim();
    return msg.length > 180 ? msg.slice(0, 180) + "…" : msg;
  }

  // ── Cola global de generación/render ────────────────────────────────
  // Serial (uno a la vez → no revienta la RAM con varios renders), persiste
  // entre secuencias (vive en el JS del panel) y es visible desde cualquier
  // secuencia. Cada job coloca su clip en SU secuencia por nombre.
  var HPQueue = (function () {
    var jobs = [];
    var counter = 0;
    var subs = [];
    function emit() { for (var i = 0; i < subs.length; i++) { try { subs[i](jobs); } catch (e) {} } persist(); }

    // ── Persistencia por proyecto (queue.json) ────────────────────────
    // Estados en curso (modeling/ready/running) se guardan como "queued": si
    // cerraste a mitad, al reabrir quedan pendientes (no colgados).
    function normStatus(s) {
      return (s === "modeling" || s === "ready" || s === "running") ? "queued" : s;
    }
    // Copia liviana del job para el archivo: sin lo pesado ni regenerable
    // (stills base64, transcript, prepared). Eso se rehidrata desde HPStore
    // al momento de correr (los datos del marcador persisten por proyecto).
    function serializeJob(j) {
      var p = null;
      if (j.payload) {
        p = {};
        for (var k in j.payload) if (Object.prototype.hasOwnProperty.call(j.payload, k)) p[k] = j.payload[k];
        delete p.stills; delete p.transcript; delete p.markerTranscript; delete p.resources;
      }
      return {
        id: j.id, status: normStatus(j.status), pct: (normStatus(j.status) === "done" ? 100 : 0),
        msg: j.msg, kind: j.kind, seqName: j.seqName, projectPath: j.projectPath,
        markerKey: j.markerKey, label: j.label, markerStart: j.markerStart,
        markerDuration: j.markerDuration, version: j.version, usage: j.usage,
        _failedStage: j._failedStage, payload: p
      };
    }
    var persistTimer = null;
    function persist() {
      if (persistTimer) return; // debounce: 1 escritura por ventana; captura el estado al disparar
      persistTimer = setTimeout(function () {
        persistTimer = null;
        if (!currentProjectPath) return; // proyecto sin guardar: no persistimos a carpeta
        var lean = [];
        for (var i = 0; i < jobs.length; i++) if (jobs[i].projectPath === currentProjectPath) lean.push(serializeJob(jobs[i]));
        callEngine("saveQueue", { projectPath: currentProjectPath, jobs: lean })
          .then(function () {}).catch(function (e) { hpLog("saveQueue falló: " + ((e && e.message) || e), "WARN"); });
      }, 1000);
    }
    function markGenerated(job) {
      // Persistir el flag en el namespace del job (aunque estés en otra secuencia).
      try {
        HPStore.setContext(job.projectPath, job.seqName);
        HPStore.setMarkerGenerated(job.markerKey, true);
        HPStore.setContext(currentProjectPath, currentSequenceName);
      } catch (e) {}
    }
    // Pipeline de 2 carriles: MODELO (nube) y RENDER (local). El render corre de
    // a uno (es lo pesado en RAM); el modelo del siguiente puede ir mientras el
    // actual renderiza — SOLO si el proveedor es cloud (en local no se solapa,
    // porque el modelo también usa la máquina).
    var modelBusy = false, renderBusy = false;
    // paused: la cola no ARRANCA nuevos jobs (los que corren terminan). Sirve
    // para "Enviar a la cola" (staging) sin que empiece a procesar.
    var paused = false;
    function onP(job) {
      return function (p) {
        if (!p) return;
        if (typeof p.pct === "number") job.pct = Math.max(0, Math.min(100, p.pct));
        if (p.msg) job.msg = p.msg;
        if (p.usage) job.usage = p.usage;
        emit();
      };
    }
    function callEngine(method, arg, prog) {
      if (HP_ENGINE && typeof HP_ENGINE[method] === "function") {
        try { return Promise.resolve(HP_ENGINE[method](arg, prog)); }
        catch (e) { return Promise.reject(e); }
      }
      return Promise.reject(new Error(engineErrMsg()));
    }
    function finishPlace(job, res) {
      // Job cancelado mientras renderizaba: no colocamos nada, liberamos el carril.
      if (job._cancelled) { renderBusy = false; hpLog("Job CANCELADO [" + job.label + "] tras render — descartado."); emit(); pump(); return; }
      job.version = res.version;
      if (res.usage && !job._usageCounted) { job.usage = res.usage; HPStore.addSessionUsage(res.usage); updateSessionUsageBar(); job._usageCounted = true; }
      var seqArg = JSON.stringify(job.seqName);
      function done(msgTxt) {
        var dur = fmtDuration((Date.now() - job.startedAt) / 1000);
        var tok = job.usage ? " · " + addThousands(job.usage.inputTokens) + "↑ " + addThousands(job.usage.outputTokens) + "↓" : "";
        job.status = "done"; job.pct = 100;
        job.msg = msgTxt + " (v" + job.version + ")" + tok + " · " + dur;
        hpLog("Job DONE [" + job.label + "] v" + job.version + " · " + msgTxt + " · " + dur);
        // Calibración: segundos de render por segundo de composición.
        var _rs = job._renderStart ? (Date.now() - job._renderStart) / 1000 : 0;
        var _cs = Number(job.markerDuration) || 0;
        if (_rs > 1 && _cs > 0 && _rs < 7200) { HP_TIMING.renderSec += _rs; HP_TIMING.renderCompSec += _cs; saveTiming(); }
        markGenerated(job);
        renderBusy = false; emit(); pump();
      }
      // Render HQ = reemplazo en su lugar: el archivo ya se sobrescribió en disco;
      // NO colocamos clip nuevo, solo recoloreamos el clip existente a MAGENTA.
      if (res.replaced || job.kind === "renderVersionHQ") {
        job.pct = 98; job.msg = "Marcando como HQ (magenta)…"; emit();
        csInterface.evalScript(
          "hp_recolorClipAt(" + seqArg + ", " + job.markerStart + ", " + HP_COLOR_MAGENTA + ")",
          function (r) { done(r === "ok" ? "✓ HQ reemplazado (magenta)" : "HQ hecho; recoloreá a mano: " + r); }
        );
        return;
      }
      // Colocación normal: café si fue borrador, magenta si fue alta calidad.
      var color = (job.payload && job.payload.draft) ? HP_COLOR_BROWN : HP_COLOR_MAGENTA;
      job.pct = 98; job.msg = "Colocando en " + job.seqName + "…"; emit();
      var movArg = JSON.stringify(res.movPath);
      csInterface.evalScript(
        "hp_placeClipInSequence(" + movArg + ", " + seqArg + ", " + job.markerStart + ", " + job.markerDuration + ", " + color + ")",
        function (place) { done(place === "ok" ? "✓ Listo y colocado" : "Render OK; colocá a mano: " + place); }
      );
    }
    // Rehidrata lo pesado del payload (stills/transcript/recursos/objetivo) desde
    // HPStore justo antes de correr. Necesario para jobs restaurados de queue.json
    // (que se guardan livianos); en jobs frescos es idempotente.
    function rehydratePayload(job) {
      if (!job.payload) return;
      try {
        HPStore.setContext(job.projectPath, job.seqName);
        var segments = HPStore.getTranscript() || [];
        var md = HPStore.getMarkerData(job.markerKey) || {};
        var gen = HPStore.getMarkerData(GEN_KEY) || {}; // prompt general
        job.payload.transcript = segments;
        job.payload.markerTranscript = HPTranscript.sliceByRange(segments, job.markerStart, job.markerStart + job.markerDuration);
        // Stills (visión) + assets (a incrustar) = marcador + generales.
        job.payload.stills = (md.stills || []).concat(gen.stills || []);
        job.payload.assets = assetSrcsOf(md).concat(assetSrcsOf(gen));
        job.payload.resources = (md.resources || []).concat(gen.resources || []);
        if (!job.payload.generalInstruction) job.payload.generalInstruction = gen.instruction || "";
        if (!job.payload.objective) job.payload.objective = HPStore.getObjective();
        if (typeof job.payload.background !== "boolean") job.payload.background = !!md.background;
      } catch (e) { hpLog("rehydratePayload falló [" + job.label + "]: " + ((e && e.message) || e), "WARN"); }
      finally { try { HPStore.setContext(currentProjectPath, currentSequenceName); } catch (e2) {} }
    }
    function startModel(job) {
      modelBusy = true; job.status = "modeling"; job.pct = 3; job.msg = "Diseñando…"; job.startedAt = Date.now();
      rehydratePayload(job); emit();
      var method = job.kind === "generate" ? "prepareGenerate" : "prepareFeedback";
      hpLog("Job MODELO [" + job.label + "] · " + method + " · modelo=" + (currentModelName || "?"));
      callEngine(method, job.payload, onP(job)).then(function (prep) {
        if (job._cancelled) { modelBusy = false; hpLog("Job CANCELADO [" + job.label + "] tras modelo — descartado."); emit(); pump(); return; }
        if (!prep || !prep.ok) throw new Error(prep && prep.error ? prep.error : "error preparando");
        job.prepared = prep;
        if (prep.usage) { job.usage = prep.usage; HPStore.addSessionUsage(prep.usage); updateSessionUsageBar(); job._usageCounted = true; }
        job.status = "ready"; job.msg = "En espera de render…";
        // Calibración: segundos que tardó el modelo (para estimar la cola).
        var _ms = (Date.now() - (job.startedAt || Date.now())) / 1000;
        if (_ms > 1 && _ms < 3600) { HP_TIMING.modelJobs++; HP_TIMING.modelSec += _ms; saveTiming(); }
        hpLog("Job MODELO ok [" + job.label + "] → listo para render");
        modelBusy = false; emit(); pump();
      }).catch(function (err) {
        var f = classifyFailure(err);
        if (f.rate) {
          job.status = "waiting"; job.pct = 0;
          job.msg = "⏳ Sin tokens / límite alcanzado — esperá el reinicio y tocá ↻ Reactivar · " + shortenErr(f.msg);
        } else {
          job.status = "error"; job.msg = "Error: " + shortenErr(f.msg);
        }
        if (job._cancelled) { modelBusy = false; emit(); pump(); return; }
        job._failedStage = "model"; // falló el diseño → reintentar re-llama a la IA
        hpLog("Job MODELO FALLÓ [" + job.label + "] · rate=" + !!f.rate + " · " + f.msg, "ERROR");
        modelBusy = false; emit(); pump();
      });
    }
    function startRender(job) {
      renderBusy = true; job.status = "running"; if (!job.startedAt) job.startedAt = Date.now();
      job._renderStart = Date.now();
      job.msg = "Renderizando…"; emit();
      hpLog("Job RENDER [" + job.label + "] · kind=" + job.kind);
      var p = (job.kind === "renderManualHtml")
        ? callEngine("renderManualHtml", job.payload, onP(job))
        : (job.kind === "renderVersionHQ")
          ? callEngine("renderVersionHQ", job.payload, onP(job))
          : (job.kind === "renderLatest")
            ? callEngine("renderLatest", job.payload, onP(job))
            : callEngine("renderPrepared", job.prepared, onP(job));
      p.then(function (res) {
        if (!res || !res.ok) throw new Error(res && res.error ? res.error : "error desconocido");
        finishPlace(job, res);
      }).catch(function (err) {
        if (job._cancelled) { renderBusy = false; emit(); pump(); return; }
        var f = classifyFailure(err);
        if (f.rate) {
          job.status = "waiting"; job.pct = 0;
          job.msg = "⏳ Sin tokens / límite alcanzado — esperá el reinicio y tocá ↻ Reactivar · " + shortenErr(f.msg);
        } else {
          job.status = "error"; job.msg = "Error: " + shortenErr(f.msg);
        }
        job._failedStage = "render"; // el modelo ya estaba OK; reintentar re-renderiza sin IA
        hpLog("Job RENDER FALLÓ [" + job.label + "] · rate=" + !!f.rate + " · " + f.msg, "ERROR");
        renderBusy = false; emit(); pump();
      });
    }
    function pump() {
      if (paused) return; // staging: no arrancar nuevos jobs
      // En local (Ollama) NO se solapa: modelo y render usan la misma máquina.
      var overlap = !currentProviderIsLocal;
      // Carril RENDER (uno a la vez; en local, además, no mientras el modelo corre).
      if (!renderBusy && (overlap || !modelBusy)) {
        for (var i = 0; i < jobs.length; i++) {
          var j = jobs[i];
          if (j.status === "ready" || (j.status === "queued" && (j.kind === "renderManualHtml" || j.kind === "renderVersionHQ" || j.kind === "renderLatest"))) { startRender(j); break; }
        }
      }
      // Carril MODELO (en local, no mientras el render corre).
      if (!modelBusy && (overlap || !renderBusy)) {
        for (var k = 0; k < jobs.length; k++) {
          var m = jobs[k];
          if (m.status === "queued" && (m.kind === "generate" || m.kind === "feedback")) { startModel(m); break; }
        }
      }
    }
    // Reordenamiento: solo afecta a los jobs EN COLA (el que corre no se mueve).
    // Reescribe el orden de las ranuras "queued" en el array según orderIds.
    function reorderQueued(orderIds) {
      var byId = {}; jobs.forEach(function (j) { byId[j.id] = j; });
      var newQueued = orderIds.map(function (id) { return byId[id]; }).filter(Boolean);
      var slots = [], i;
      for (i = 0; i < jobs.length; i++) if (jobs[i].status === "queued") slots.push(i);
      for (i = 0; i < slots.length && i < newQueued.length; i++) jobs[slots[i]] = newQueued[i];
      emit();
    }
    // Grupos de jobs EN COLA por secuencia (preserva orden de aparición).
    function queuedGroups() {
      var groups = [], map = {};
      jobs.forEach(function (j) {
        if (j.status !== "queued") return;
        if (!map[j.seqName]) { map[j.seqName] = { seqName: j.seqName, ids: [] }; groups.push(map[j.seqName]); }
        map[j.seqName].ids.push(j.id);
      });
      return groups;
    }
    function flatten(groups) {
      var ids = [];
      groups.forEach(function (g) { ids = ids.concat(g.ids); });
      reorderQueued(ids);
    }

    function enqueue(job) {
      job.id = "j" + (++counter);
      job.status = "queued"; job.pct = 0; job.msg = "En cola…";
      jobs.push(job);
      hpLog("Encolado " + job.id + " [" + job.label + "] · kind=" + job.kind + " · seq=" + job.seqName);
      return job.id;
    }
    return {
      // Carga la cola guardada de un proyecto (queue.json). Reemplaza la cola en
      // memoria. Queda PAUSADA si hay pendientes: los ves y arrancás con Iniciar
      // (no auto-procesa al abrir, para no gastar tokens sin querer).
      restore: function (projectPath) {
        callEngine("loadQueue", { projectPath: projectPath }).then(function (res) {
          var loaded = (res && res.jobs) || [];
          jobs = [];
          var hasPending = false;
          for (var i = 0; i < loaded.length; i++) {
            var lj = loaded[i];
            lj.status = (lj.status === "modeling" || lj.status === "ready" || lj.status === "running") ? "queued" : lj.status;
            lj.pct = (lj.status === "done") ? 100 : (lj.pct || 0);
            lj.prepared = null;
            lj._usageCounted = (lj.status === "done");
            if (lj.status === "queued" || lj.status === "waiting") hasPending = true;
            var num = parseInt(String(lj.id || "").replace(/^j/, ""), 10);
            if (!isNaN(num) && num > counter) counter = num;
            jobs.push(lj);
          }
          if (hasPending) paused = true; // no arrancar solo; que Daniel toque Iniciar
          hpLog("Cola restaurada: " + jobs.length + " job(s)" + (hasPending ? " (pausada, tocá ▶ Iniciar)" : "") + ".");
          emit();
        }).catch(function (e) { hpLog("loadQueue falló: " + ((e && e.message) || e), "WARN"); });
      },
      // Encola Y arranca (Generar / Regenerar / render manual).
      add: function (job) {
        var id = enqueue(job); paused = false; emit(); pump();
        return id;
      },
      // Encola SIN arrancar (Enviar a la cola). NO llama a pump: si la cola ya
      // está corriendo, el propio ciclo lo tomará al terminar el actual; si está
      // quieta, queda en espera hasta que toques Iniciar (o Generar).
      addStaged: function (job) {
        var id = enqueue(job); emit();
        return id;
      },
      start: function () { paused = false; emit(); pump(); },
      pause: function () { paused = true; emit(); },
      isPaused: function () { return paused; },
      hasActive: function () {
        for (var i = 0; i < jobs.length; i++) { var s = jobs[i].status; if (s === "modeling" || s === "ready" || s === "running") return true; }
        return false;
      },
      hasQueued: function () { for (var i = 0; i < jobs.length; i++) if (jobs[i].status === "queued") return true; return false; },
      hasWaiting: function () { for (var i = 0; i < jobs.length; i++) if (jobs[i].status === "waiting") return true; return false; },
      // Reencola un job que quedó "waiting" (sin tokens). Se usa cuando el uso
      // ya se reinició. Vuelve a "queued" y arranca (respeta el pipeline).
      reactivate: function (id) {
        for (var i = 0; i < jobs.length; i++) {
          var j = jobs[i];
          if (j.id === id && j.status === "waiting") {
            j.status = "queued"; j.pct = 0; j.msg = "Reencolado, esperando turno…";
            j.prepared = null; j._usageCounted = false;
          }
        }
        paused = false; emit(); pump();
      },
      // Reintenta un job en "error" DESDE EL PUNTO DE FALLO:
      // - Si falló en RENDER (el diseño de la IA ya estaba hecho) → re-renderiza
      //   SIN volver a llamar a la IA (usa el prepared en memoria, o re-renderiza
      //   la última versión HTML del disco). Ahorra tiempo y tokens.
      // - Si falló en el MODELO → re-corre desde cero (re-llama a la IA).
      retry: function (id) {
        for (var i = 0; i < jobs.length; i++) {
          var j = jobs[i];
          if (j.id !== id || (j.status !== "error" && j.status !== "waiting")) continue;
          j.pct = 0; j._usageCounted = false; j._cancelled = false; j.startedAt = 0;
          if (j._failedStage === "render") {
            if (j.prepared) {
              // Diseño en memoria → solo re-render (renderPrepared).
              j.status = "ready"; j.msg = "Reintentando el render (sin re-diseñar)…";
            } else {
              // Diseño en disco (tras recarga) → re-render de la última versión sin IA.
              j.kind = "renderLatest";
              j.payload = {
                projectPath: j.projectPath, sequenceName: j.seqName, markerSlug: j.markerKey,
                marker: { start: j.markerStart, end: j.markerStart + j.markerDuration, duration: j.markerDuration },
                background: !!(j.payload && j.payload.background), draft: !!(j.payload && j.payload.draft)
              };
              j.status = "queued"; j.msg = "Reintentando el render (sin re-diseñar)…";
            }
            hpLog("Reintento RENDER de [" + j.label + "] (sin re-llamar a la IA).");
          } else {
            j.status = "queued"; j.prepared = null; j.msg = "Reintentando desde cero…";
            hpLog("Reintento COMPLETO de [" + j.label + "] (re-diseña con IA).");
          }
        }
        paused = false; emit(); pump();
      },
      // Reencola TODOS los jobs "waiting" de una vez (o solo los de una secuencia
      // si se pasa seqName). Devuelve cuántos reactivó.
      reactivateAll: function (seqName) {
        var n = 0;
        for (var i = 0; i < jobs.length; i++) {
          var j = jobs[i];
          if (j.status === "waiting" && (!seqName || j.seqName === seqName)) {
            j.status = "queued"; j.pct = 0; j.msg = "Reencolado, esperando turno…";
            j.prepared = null; j._usageCounted = false; n++;
          }
        }
        paused = false; emit(); pump(); return n;
      },
      // Regenera un job YA terminado (o cualquiera) manteniendo su MISMO puesto
      // en el array de la cola: se muta en su lugar y vuelve a "queued", así el
      // pipeline lo retoma en la posición original (no al final). Si viene texto
      // de feedback, se regenera en modo "ajustar" (toma la versión previa como
      // base); si no, es una regeneración total.
      regenerate: function (id, adjustmentText) {
        for (var i = 0; i < jobs.length; i++) {
          var j = jobs[i];
          if (j.id !== id) continue;
          if (j.kind !== "generate" && j.kind !== "feedback") return; // solo IA
          var txt = (adjustmentText || "").trim();
          j.payload = j.payload || {};
          if (txt) { j.payload.adjustment = txt; j.payload.mode = "adjust"; j.kind = "feedback"; }
          else { j.payload.mode = "generate"; j.kind = "generate"; }
          j.status = "queued"; j.pct = 0;
          j.msg = txt ? "Reencolado con feedback, esperando turno…" : "Reencolado, esperando turno…";
          j.prepared = null; j._usageCounted = false; j.version = undefined;
          j.startedAt = 0; j.usage = null;
          break;
        }
        paused = false; emit(); pump();
      },
      on: function (cb) { subs.push(cb); },
      jobs: function () { return jobs; },
      latestFor: function (seqName, markerKey) {
        var found = null;
        for (var i = 0; i < jobs.length; i++) if (jobs[i].seqName === seqName && jobs[i].markerKey === markerKey) found = jobs[i];
        return found;
      },
      // Mueve un marcador (job en cola) dentro de su secuencia. dir: -1 sube, +1 baja.
      moveJob: function (id, dir) {
        var groups = queuedGroups();
        for (var gi = 0; gi < groups.length; gi++) {
          var ids = groups[gi].ids, p = ids.indexOf(id);
          if (p >= 0) {
            var t = p + dir;
            if (t < 0 || t >= ids.length) return;
            var tmp = ids[p]; ids[p] = ids[t]; ids[t] = tmp;
            flatten(groups); return;
          }
        }
      },
      // Mueve una secuencia entera (grupo) arriba/abajo en el orden de proceso.
      moveSeq: function (seqName, dir) {
        var groups = queuedGroups(), gi = -1, i;
        for (i = 0; i < groups.length; i++) if (groups[i].seqName === seqName) { gi = i; break; }
        if (gi < 0) return;
        var t = gi + dir;
        if (t < 0 || t >= groups.length) return;
        var tmp = groups[gi]; groups[gi] = groups[t]; groups[t] = tmp;
        flatten(groups);
      },
      remove: function (id) {
        jobs = jobs.filter(function (j) {
          return !(j.id === id && (j.status === "queued" || j.status === "waiting" || j.status === "error"));
        });
        emit();
      },
      clearFinished: function () {
        // Conserva los activos, los en cola y los "waiting" (esos el usuario los
        // quiere reactivar cuando tenga tokens); limpia solo done/error.
        jobs = jobs.filter(function (j) {
          return j.status === "queued" || j.status === "modeling" || j.status === "ready" || j.status === "running" || j.status === "waiting";
        });
        emit();
      },
      // Cancela UN job aunque esté activo: si está en vuelo (modelo/render) lo
      // marca _cancelled (su resultado se descarta al terminar) y lo saca de la
      // lista. Sirve para parar y rehacer.
      cancelJob: function (id) {
        var next = [];
        for (var i = 0; i < jobs.length; i++) {
          var j = jobs[i];
          if (j.id !== id) { next.push(j); continue; }
          if (j.status === "modeling" || j.status === "ready" || j.status === "running") {
            j._cancelled = true; // su promesa en vuelo se descartará al resolver
            hpLog("Cancelando job activo [" + j.label + "] (se descarta al terminar la etapa en vuelo).");
          }
          // en cualquier caso, lo sacamos de la cola visible
        }
        jobs = next;
        emit(); pump();
      },
      // Vacía TODA la cola (incluidos activos) para rehacer desde cero. Lo que ya
      // está en vuelo (IA/render) no se puede matar, pero su resultado se descarta.
      clearAll: function () {
        for (var i = 0; i < jobs.length; i++) {
          var s = jobs[i].status;
          if (s === "modeling" || s === "ready" || s === "running") jobs[i]._cancelled = true;
        }
        hpLog("Vaciar cola: " + jobs.length + " job(s) eliminados (activos marcados como cancelados).");
        jobs = [];
        paused = false;
        emit(); // persist guardará la cola vacía
      }
    };
  })();

  // Encola la generación IA de un marcador. staged=true → solo encola (no arranca).
  function enqueueMarkerGeneration(marker, mode, staged) {
    var markerKey = markerKeyFor(marker);
    var data = HPStore.getMarkerData(markerKey);
    var gen = HPStore.getMarkerData(GEN_KEY); // prompt general (aplica a todos)
    var segments = HPStore.getTranscript() || [];
    var markerTranscript = HPTranscript.sliceByRange(segments, marker.start, marker.start + marker.duration);
    var payload = {
      projectPath: currentProjectPath, sequenceName: currentSequenceName,
      objective: HPStore.getObjective(), transcript: segments,
      marker: { name: marker.name || markerKey, start: marker.start, end: marker.start + marker.duration, duration: marker.duration },
      markerTranscript: markerTranscript, instruction: data.instruction || "",
      generalInstruction: gen.instruction || "",
      // stills = TODAS las imágenes (marcador + generales) para que el modelo las VEA (contexto).
      stills: (data.stills || []).concat(gen.stills || []),
      // assets = solo las marcadas "usar" → se INCRUSTAN en el gráfico (logo/icono/foto).
      assets: assetSrcsOf(data).concat(assetSrcsOf(gen)),
      resources: (data.resources || []).concat(gen.resources || []),
      background: !!data.background, draft: draftMode,
      markerSlug: markerKey, mode: mode
    };
    if (mode === "adjust") payload.adjustment = data.instruction || "";
    var job = {
      kind: mode === "generate" ? "generate" : "feedback",
      payload: payload, seqName: currentSequenceName, projectPath: currentProjectPath,
      markerKey: markerKey, label: markerKey + (marker.name ? " · " + marker.name : ""),
      markerStart: marker.start, markerDuration: marker.duration
    };
    if (staged) HPQueue.addStaged(job); else HPQueue.add(job);
  }

  // Refleja el estado de los jobs en las tarjetas de la secuencia ACTUAL.
  function reflectQueueOnCards() {
    if (!markersContainer) return;
    var cards = markersContainer.querySelectorAll("details.marker-card");
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (!c._markerKey || !c._applyJob) continue;
      var job = HPQueue.latestFor(currentSequenceName, c._markerKey);
      if (job) c._applyJob(job);
      else if (c._clearJob) c._clearJob(); // sin job (ej. borrado de la cola) → re-habilitar
    }
  }

  function iconBtn(txt, title, cb) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "qbtn"; b.textContent = txt; b.title = title;
    b.addEventListener("click", function (e) { e.stopPropagation(); cb(); });
    return b;
  }

  // Abre la secuencia del job y salta el playhead a su marcador para revisar,
  // aunque el editor esté en otra secuencia. Usado desde la Cola (job terminado).
  function openJobInPremiere(job) {
    if (!job) return;
    var seqArg = JSON.stringify(job.seqName);
    csInterface.evalScript(
      "hp_openSequenceAndSeek(" + seqArg + ", " + Number(job.markerStart) + ")",
      function () {}
    );
  }

  // Re-renderiza en alta calidad la última versión de UN marcador (un job).
  // Se usa desde la Cola cuando el job se hizo en borrador y a Daniel le gustó.
  function renderJobHQ(job) {
    if (!job) return;
    HPQueue.add({
      kind: "renderVersionHQ",
      payload: {
        projectPath: job.projectPath, sequenceName: job.seqName, markerSlug: job.markerKey,
        marker: { start: job.markerStart, end: job.markerStart + job.markerDuration, duration: job.markerDuration },
        background: !!(job.payload && job.payload.background)
      },
      seqName: job.seqName, projectPath: job.projectPath, markerKey: job.markerKey,
      label: job.label + " (Render HQ)", markerStart: job.markerStart, markerDuration: job.markerDuration
    });
  }

  // Limpia videos de versiones viejas de todas las secuencias que aparecen en la
  // cola (+ la secuencia actual). Conserva HTMLs. Muestra cuánto liberó.
  // Overlay de confirmación genérico (reusa estilos del overlay de ayuda).
  function showConfirmOverlay(title, buildBody, okLabel, onOk) {
    var ov = document.createElement("div"); ov.className = "help-overlay"; ov.setAttribute("data-hidden", "false");
    var card = document.createElement("div"); card.className = "help-card";
    var head = document.createElement("div"); head.className = "help-head";
    var h = document.createElement("span"); h.textContent = title; head.appendChild(h);
    var x = document.createElement("button"); x.type = "button"; x.className = "icon-btn"; x.textContent = "✕"; x.title = "Cancelar"; head.appendChild(x);
    card.appendChild(head);
    var body = document.createElement("div"); body.className = "help-body"; buildBody(body); card.appendChild(body);
    var actions = document.createElement("div"); actions.className = "config-actions";
    var cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancelar";
    var ok = document.createElement("button"); ok.type = "button"; ok.className = "btn-primary"; ok.textContent = okLabel;
    actions.appendChild(cancel); actions.appendChild(ok); card.appendChild(actions);
    ov.appendChild(card); document.body.appendChild(ov);
    function close() { try { document.body.removeChild(ov); } catch (e) {} }
    x.addEventListener("click", close); cancel.addEventListener("click", close);
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    ok.addEventListener("click", function () { close(); onOk(); });
  }

  // Ejecuta la limpieza REAL (ya confirmada): secuencia → proyecto → disco.
  function performCleanup(targets) {
    setOutput("🧹 Limpiando versiones viejas…", false);
    hpLog("Limpiando versiones viejas en " + targets.length + " secuencia(s)…");
    var listPromises = targets.map(function (t) {
      return hpCall("listOldVersions", t).then(function (r) { return (r && r.ok) ? (r.files || []) : []; }).catch(function () { return []; });
    });
    Promise.all(listPromises).then(function (lists) {
      var names = [];
      lists.forEach(function (files) { files.forEach(function (f) { if (f && f.name) names.push(f.name); }); });
      if (!names.length) { setOutput("🧹 No hay versiones viejas para limpiar.", false); return; }
      var namesJson = JSON.stringify(names);
      // Paso 2: sacarlos de secuencia + proyecto ANTES de borrar (evita re-vincular).
      csInterface.evalScript("hp_purgeClipsByName(" + JSON.stringify(namesJson) + ")", function (purge) {
        hpLog("purge en Premiere: " + purge + " (" + names.length + " nombres)");
        var totalDeleted = 0, totalBytes = 0, pending = targets.length, errs = [];
        targets.forEach(function (t) {
          hpCall("cleanOldVersions", t).then(function (res) {
            if (res && res.ok) { totalDeleted += res.deleted || 0; totalBytes += res.freedBytes || 0; }
            else errs.push((res && res.error) || "error");
          }).catch(function (e) { errs.push((e && e.message) || "error"); })
            .then(function () {
              if (--pending === 0) {
                var mb = (totalBytes / (1024 * 1024)).toFixed(1);
                var okPurge = String(purge || "").indexOf("ok|") === 0;
                var msg = "🧹 Limpieza lista: " + totalDeleted + " video(s) borrados · " + mb + " MB liberados." +
                  (okPurge ? " Quitados de la secuencia y del proyecto." : " (No pude quitarlos del proyecto: " + purge + ")") +
                  " Los HTMLs se conservan.";
                if (errs.length) msg += " · " + errs.length + " error(es) al borrar";
                setOutput(msg, errs.length > 0 || !okPurge);
                hpLog(msg);
              }
            });
        });
      });
    });
  }

  // Botón "limpiar versiones viejas": PRIMERO muestra el detalle (qué se borra ↔
  // qué se conserva) y pide confirmación; recién al aceptar borra.
  function cleanOldVersionsFromQueue() {
    var seen = {}, targets = [];
    function addTarget(pp, sn) {
      if (!sn) return;
      var k = String(pp) + "::" + String(sn);
      if (seen[k]) return; seen[k] = true;
      targets.push({ projectPath: pp, sequenceName: sn });
    }
    var jobs = HPQueue.jobs();
    for (var i = 0; i < jobs.length; i++) addTarget(jobs[i].projectPath, jobs[i].seqName);
    addTarget(currentProjectPath, currentSequenceName);
    if (!targets.length) { setOutput("No hay secuencias en la cola para limpiar.", false); return; }

    var previewPromises = targets.map(function (t) {
      return hpCall("cleanupPreview", t)
        .then(function (r) { return (r && r.ok) ? r : { groups: [], totalDeletes: 0, totalBytes: 0, sequenceName: t.sequenceName }; })
        .catch(function () { return { groups: [], totalDeletes: 0, totalBytes: 0, sequenceName: t.sequenceName }; });
    });
    Promise.all(previewPromises).then(function (previews) {
      var totalDeletes = 0, totalBytes = 0;
      previews.forEach(function (p) { totalDeletes += p.totalDeletes || 0; totalBytes += p.totalBytes || 0; });
      if (!totalDeletes) { setOutput("🧹 No hay versiones viejas para limpiar.", false); return; }
      showConfirmOverlay("Limpiar versiones viejas", function (body) {
        var intro = document.createElement("p");
        var strong = document.createElement("strong"); strong.textContent = totalDeletes + " video(s)";
        intro.appendChild(document.createTextNode("Se van a borrar "));
        intro.appendChild(strong);
        intro.appendChild(document.createTextNode(" viejos (" + (totalBytes / 1048576).toFixed(1) + " MB). Se conserva la última versión de cada marcador. Los HTMLs no se tocan."));
        body.appendChild(intro);
        previews.forEach(function (p) {
          if (!p.groups || !p.groups.length) return;
          var sh = document.createElement("div"); sh.className = "section-label"; sh.textContent = p.sequenceName || "secuencia";
          body.appendChild(sh);
          p.groups.forEach(function (g) {
            g.deletes.forEach(function (d) {
              var row = document.createElement("div"); row.className = "cleanup-row";
              var del = document.createElement("span"); del.className = "cl-del"; del.textContent = "🗑 " + d.name;
              var keep = document.createElement("span"); keep.className = "cl-keep"; keep.textContent = "conserva: " + (g.keep ? g.keep.name : "?");
              row.appendChild(del); row.appendChild(keep);
              body.appendChild(row);
            });
          });
        });
      }, "Borrar " + totalDeletes + " video(s)", function () { performCleanup(targets); });
    });
  }

  // Re-renderiza en HQ la última versión de cada marcador de una secuencia
  // (según los jobs de esa secuencia en la cola). Encola y arranca.
  function renderSeqHQ(seqName) {
    var jobs = HPQueue.jobs();
    var byMarker = {};
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      if (j.seqName === seqName && j.markerKey) byMarker[j.markerKey] = j; // el último gana
    }
    Object.keys(byMarker).forEach(function (mk) {
      var j = byMarker[mk];
      HPQueue.add({
        kind: "renderVersionHQ",
        payload: {
          projectPath: j.projectPath, sequenceName: seqName, markerSlug: mk,
          marker: { start: j.markerStart, end: j.markerStart + j.markerDuration, duration: j.markerDuration },
          background: !!(j.payload && j.payload.background)
        },
        seqName: seqName, projectPath: j.projectPath, markerKey: mk,
        label: mk + " (Render HQ)", markerStart: j.markerStart, markerDuration: j.markerDuration
      });
    });
  }

  // Estado UI de la caja de feedback por job (id → abierto?) y borrador de texto
  // (id → texto), para que sobreviva a los re-render frecuentes de la cola.
  var feedbackOpen = {};
  var feedbackDraft = {};

  // Panel de cola global: agrupado por secuencia, con reordenamiento
  // (secuencia arriba/abajo y marcador arriba/abajo dentro de su secuencia).
  function renderQueue(jobs) {
    var panel = document.getElementById("queue-panel");
    if (!panel) return;
    var scroller = document.getElementById("view-queue");
    var savedScroll = scroller ? scroller.scrollTop : 0;
    var pending = 0, waiting = 0, i;
    for (i = 0; i < jobs.length; i++) {
      var st = jobs[i].status;
      if (st === "queued" || st === "modeling" || st === "ready" || st === "running") pending++;
      else if (st === "waiting") waiting++;
    }
    // Badge de la pestaña Cola (incluye los que esperan tokens para que se noten).
    var badge = document.getElementById("tab-queue-count");
    if (badge) {
      var total = pending + waiting;
      if (total) {
        badge.textContent = waiting ? (total + " ⏳") : total;
        badge.setAttribute("data-hidden", "false");
        badge.className = "tab-badge" + (waiting ? " is-waiting" : "");
      } else {
        badge.setAttribute("data-hidden", "true");
        badge.className = "tab-badge";
      }
    }
    if (!jobs.length) {
      panel.innerHTML = '<div class="queue-empty">La cola está vacía. Encolá marcadores con “Enviar a la cola” o arrancá con “Generar”.</div>';
      return;
    }
    panel.innerHTML = "";

    var head = document.createElement("div"); head.className = "queue-head";
    var title = document.createElement("span");
    title.textContent = "Cola" + (pending ? " · " + pending + " en proceso/espera" : " · sin pendientes")
      + (waiting ? " · " + waiting + " esperando tokens ⏳" : "");
    head.appendChild(title);
    // Reactivar todos: aparece cuando hay jobs pausados por falta de tokens.
    if (waiting) {
      var reactAll = document.createElement("button"); reactAll.type = "button"; reactAll.className = "queue-react";
      reactAll.textContent = "↻ Reactivar todos (" + waiting + ")";
      reactAll.title = "Reencola todo lo que quedó sin tokens (usalo cuando se reinicie tu uso)";
      reactAll.addEventListener("click", function () { HPQueue.reactivateAll(); });
      head.appendChild(reactAll);
    }
    // Toggle Pausar ⇄ Reanudar. Si está pausada, SIEMPRE se muestra "Reanudar"
    // (haya o no un job activo) — antes quedaba trabado sin opción de reanudar.
    if (HPQueue.isPaused()) {
      var resumeBtn = document.createElement("button"); resumeBtn.type = "button"; resumeBtn.className = "queue-start";
      resumeBtn.textContent = "▶ Reanudar";
      resumeBtn.title = "Reanuda la cola (sigue procesando los marcadores pendientes)";
      resumeBtn.addEventListener("click", function () { HPQueue.start(); });
      head.appendChild(resumeBtn);
    } else if (HPQueue.hasActive()) {
      var pauseBtn = document.createElement("button"); pauseBtn.type = "button"; pauseBtn.className = "queue-clear";
      pauseBtn.textContent = "⏸ pausar";
      pauseBtn.title = "Pausa la cola: no arranca nuevos marcadores (el que está corriendo termina su etapa). Después reanudás.";
      pauseBtn.addEventListener("click", function () { HPQueue.pause(); });
      head.appendChild(pauseBtn);
    } else if (HPQueue.hasQueued()) {
      var startBtn = document.createElement("button"); startBtn.type = "button"; startBtn.className = "queue-start";
      startBtn.textContent = "▶ Iniciar cola";
      startBtn.title = "Empieza a procesar los marcadores en espera, uno a la vez";
      startBtn.addEventListener("click", function () { HPQueue.start(); });
      head.appendChild(startBtn);
    }
    var clr = document.createElement("button"); clr.type = "button"; clr.className = "queue-clear";
    clr.textContent = "limpiar terminados";
    clr.title = "Quita de la lista los jobs terminados y con error (conserva en cola, en proceso y los que esperan tokens)";
    clr.addEventListener("click", function () { HPQueue.clearFinished(); });
    head.appendChild(clr);
    // Vaciar cola: para TODO (incluido lo activo) y limpia la lista, para rehacer.
    var wipe = document.createElement("button"); wipe.type = "button"; wipe.className = "queue-clear is-danger";
    wipe.textContent = "⏹ vaciar cola";
    wipe.title = "Para y quita TODOS los marcadores de la cola (incluido el que está corriendo) para rehacer el proceso.";
    wipe.addEventListener("click", function () {
      var n = HPQueue.jobs().length;
      showConfirmOverlay("Vaciar la cola", function (body) {
        var p = document.createElement("p");
        p.textContent = "Se van a quitar los " + n + " marcador(es) de la cola, incluido el que esté procesando. " +
          "Lo que ya está en vuelo (IA o render) termina en segundo plano pero su resultado se descarta. No borra archivos ya generados en disco.";
        body.appendChild(p);
      }, "Vaciar (" + n + ")", function () { HPQueue.clearAll(); setOutput("Cola vaciada.", false); });
    });
    head.appendChild(wipe);
    // Limpiar versiones viejas: borra del disco los videos de versiones NO-últimas
    // de cada marcador (conserva HTMLs). Corre sobre todas las secuencias de la cola.
    var cleanBtn = document.createElement("button"); cleanBtn.type = "button"; cleanBtn.className = "queue-clear";
    cleanBtn.textContent = "🧹 limpiar versiones viejas";
    cleanBtn.title = "Borra del disco los videos de versiones anteriores de cada marcador (deja solo la última). Conserva los HTMLs y el historial.";
    cleanBtn.addEventListener("click", function () { cleanOldVersionsFromQueue(); });
    head.appendChild(cleanBtn);
    panel.appendChild(head);

    // Agrupar por secuencia preservando el orden de proceso.
    var groups = [], map = {};
    for (i = 0; i < jobs.length; i++) {
      var jj = jobs[i];
      if (!map[jj.seqName]) { map[jj.seqName] = { seqName: jj.seqName, jobs: [] }; groups.push(map[jj.seqName]); }
      map[jj.seqName].jobs.push(jj);
    }

    groups.forEach(function (g, gi) {
      var queuedInGroup = g.jobs.filter(function (j) { return j.status === "queued"; }).length;
      var gh = document.createElement("div"); gh.className = "queue-seq";
      var gname = document.createElement("span"); gname.className = "qs-name"; gname.textContent = g.seqName;
      gh.appendChild(gname);
      var ctrls = document.createElement("span"); ctrls.className = "qs-ctrls";
      // Reordenar la secuencia completa (solo si tiene jobs en cola).
      if (queuedInGroup > 0) {
        if (gi > 0) ctrls.appendChild(iconBtn("▲", "Subir esta secuencia", function () { HPQueue.moveSeq(g.seqName, -1); }));
        if (gi < groups.length - 1) ctrls.appendChild(iconBtn("▼", "Bajar esta secuencia", function () { HPQueue.moveSeq(g.seqName, 1); }));
      }
      // Render HQ: re-renderiza en alta calidad la última versión de cada marcador
      // de esta secuencia (útil tras previsualizar en borrador). Si hay ≥1 hecho.
      var doneInGroup = g.jobs.filter(function (j) { return j.status === "done"; }).length;
      if (doneInGroup > 0) {
        var hqSeq = g.seqName;
        var hq = iconBtn("Render HQ", "Re-renderiza en alta calidad la última versión de cada marcador de esta secuencia", function () { renderSeqHQ(hqSeq); });
        hq.className = "qbtn qbtn-hq";
        ctrls.appendChild(hq);
      }
      if (ctrls.childNodes.length) gh.appendChild(ctrls);
      panel.appendChild(gh);

      var qIdx = 0, qCount = g.jobs.filter(function (j) { return j.status === "queued"; }).length;
      g.jobs.forEach(function (j) {
        var row = document.createElement("div"); row.className = "queue-job is-" + j.status;
        var line = document.createElement("div"); line.className = "qj-line";
        var top = document.createElement("div"); top.className = "qj-title";
        var dot = (j.status === "running") ? "▶ " : (j.status === "modeling") ? "✎ " : (j.status === "ready") ? "◔ " : (j.status === "queued") ? "• " : (j.status === "done") ? "✓ " : (j.status === "waiting") ? "⏳ " : "⚠ ";
        top.textContent = dot + j.label;
        line.appendChild(top);
        if (j.status === "queued") {
          var jc = document.createElement("span"); jc.className = "qj-ctrls";
          if (qIdx > 0) jc.appendChild(iconBtn("▲", "Priorizar este marcador", function () { HPQueue.moveJob(j.id, -1); }));
          if (qIdx < qCount - 1) jc.appendChild(iconBtn("▼", "Posponer este marcador", function () { HPQueue.moveJob(j.id, 1); }));
          jc.appendChild(iconBtn("✕", "Quitar de la cola", function () { HPQueue.remove(j.id); }));
          line.appendChild(jc);
          qIdx++;
        } else if (j.status === "waiting") {
          var wc = document.createElement("span"); wc.className = "qj-ctrls";
          var rb = iconBtn("↻ Reactivar", "Reencolar este marcador (cuando tengas tokens de nuevo)", (function (id) { return function () { HPQueue.reactivate(id); }; })(j.id));
          rb.className = "qbtn qbtn-react";
          wc.appendChild(rb);
          wc.appendChild(iconBtn("✕", "Descartar", (function (id) { return function () { HPQueue.remove(id); }; })(j.id)));
          line.appendChild(wc);
        } else if (j.status === "modeling" || j.status === "ready" || j.status === "running") {
          // Job activo: se puede cancelar (lo en vuelo termina en 2º plano y se descarta).
          var ac = document.createElement("span"); ac.className = "qj-ctrls";
          ac.appendChild(iconBtn("✕ cancelar", "Cancelar este marcador (para rehacerlo). Lo que esté en vuelo se descarta.",
            (function (id) { return function () { HPQueue.cancelJob(id); }; })(j.id)));
          line.appendChild(ac);
        } else if (j.status === "error") {
          // Job con error: reintentar (tras arreglar la causa) o descartar.
          var ec = document.createElement("span"); ec.className = "qj-ctrls";
          var retryBtn = iconBtn("↻ Reintentar", "Volver a intentar este marcador desde cero",
            (function (id) { return function () { HPQueue.retry(id); }; })(j.id));
          retryBtn.className = "qbtn qbtn-react";
          ec.appendChild(retryBtn);
          ec.appendChild(iconBtn("✕", "Descartar", (function (id) { return function () { HPQueue.remove(id); }; })(j.id)));
          line.appendChild(ec);
        } else if (j.status === "done") {
          // Job terminado: revisar en Premiere, subir a HQ si fue borrador, o
          // dar feedback y regenerar (retomando el mismo puesto en la cola).
          var dc = document.createElement("span"); dc.className = "qj-ctrls";
          dc.appendChild(iconBtn("👁 Ver", "Abrir esta secuencia y saltar al marcador para revisar",
            (function (job) { return function () { openJobInPremiere(job); }; })(j)));
          // Render HQ solo si el job se hizo en borrador (aún no está en alta).
          if (j.kind !== "renderVersionHQ" && j.payload && j.payload.draft) {
            var hqb = iconBtn("Render HQ", "Re-renderizar este marcador en alta calidad",
              (function (job) { return function () { renderJobHQ(job); }; })(j));
            hqb.className = "qbtn qbtn-hq"; dc.appendChild(hqb);
          }
          if (j.kind === "generate" || j.kind === "feedback") {
            dc.appendChild(iconBtn("✎ Feedback", "Dar feedback y regenerar (mantiene el puesto en la cola)",
              (function (id) { return function () { feedbackOpen[id] = !feedbackOpen[id]; renderQueue(HPQueue.jobs()); }; })(j.id)));
          }
          line.appendChild(dc);
        }
        row.appendChild(line);
        var msg = document.createElement("div"); msg.className = "qj-msg"; msg.textContent = j.msg || j.status;
        row.appendChild(msg);
        // Caja de feedback inline (solo en jobs terminados y si el usuario la abrió).
        if (j.status === "done" && feedbackOpen[j.id]) {
          var fb = document.createElement("div"); fb.className = "qj-feedback-wrap";
          var inRow = document.createElement("div"); inRow.className = "qj-feedback";
          var ta = document.createElement("textarea"); ta.className = "qj-fb-input"; ta.rows = 2;
          ta.placeholder = "Qué ajustar… (se regenera manteniendo el puesto en la cola)";
          ta.value = feedbackDraft[j.id] || "";
          ta.addEventListener("input", (function (id) { return function (e) { feedbackDraft[id] = e.target.value; }; })(j.id));
          ta.addEventListener("click", function (e) { e.stopPropagation(); });
          inRow.appendChild(ta);
          var go = document.createElement("button"); go.type = "button"; go.className = "qbtn qbtn-react"; go.textContent = "↻ Regenerar";
          go.title = "Regenerar con tu feedback (retoma el mismo puesto en la cola)";
          go.addEventListener("click", (function (id) {
            return function (e) {
              e.stopPropagation();
              var t = feedbackDraft[id] || "";
              feedbackOpen[id] = false; feedbackDraft[id] = "";
              HPQueue.regenerate(id, t);
            };
          })(j.id));
          inRow.appendChild(go);
          fb.appendChild(inRow);
          // Imágenes/elementos para el feedback — mismo control que la tarjeta
          // (drag&drop + 📸 captura + etiqueta referencia/usar). Se agregan al
          // marcador y la regeneración los toma. Solo si el job es de la secuencia
          // actual (HPStore opera sobre ese contexto).
          if (j.seqName === currentSequenceName && j.projectPath === currentProjectPath) {
            var mnt = document.createElement("div"); mnt.className = "qj-fb-stills";
            mnt.addEventListener("click", function (e) { e.stopPropagation(); });
            mnt.appendChild(createStillsControl(j.markerKey));
            fb.appendChild(mnt);
          } else {
            var note = document.createElement("div"); note.className = "qj-msg";
            note.textContent = "Para adjuntar imágenes a este marcador, abrí su secuencia en la pestaña Marcadores.";
            fb.appendChild(note);
          }
          row.appendChild(fb);
        }
        if (j.status === "running" || j.status === "modeling") {
          var bar = document.createElement("div"); bar.className = "hp-bar";
          var fill = document.createElement("div"); fill.className = "hp-bar-fill"; fill.style.width = (j.pct || 0) + "%"; bar.appendChild(fill);
          row.appendChild(bar);
        }
        panel.appendChild(row);
      });
    });
    renderQueueEstimate(panel, jobs);
    // Preservar el scroll de la vista de cola (se refresca seguido durante el proceso).
    if (scroller) scroller.scrollTop = savedScroll;
  }

  // Footer con estimación de la cola (marcadores en espera): tiempo y tokens de
  // entrada estimados para procesar TODO lo pendiente, así se decide antes de lanzar.
  function renderQueueEstimate(panel, jobs) {
    var pend = [];
    for (var i = 0; i < jobs.length; i++) {
      var s = jobs[i].status;
      if (s === "queued" || s === "modeling" || s === "ready" || s === "running") pend.push(jobs[i]);
    }
    if (!pend.length) return;
    var genCount = 0, compSec = 0;
    for (var k = 0; k < pend.length; k++) {
      var j = pend[k];
      if (j.kind === "generate" || j.kind === "feedback") genCount++;
      compSec += Number(j.markerDuration) || 0;
    }
    // Tiempo ≈ (jobs de modelo × promedio modelo) + (segundos de composición × factor render).
    var timeSec = genCount * avgModelSec() + compSec * renderSecPerCompSec();
    var calibrated = HP_TIMING.modelJobs > 0 || HP_TIMING.renderCompSec > 0;

    var foot = document.createElement("div"); foot.className = "queue-estimate";
    var line1 = document.createElement("div"); line1.className = "qe-line";
    line1.textContent = "⏳ Pendiente: " + pend.length + " marcador(es) · vídeo total " + fmtDuration(compSec) +
      " · tiempo ≈ " + fmtDuration(timeSec) + (calibrated ? "" : " (aprox.)");
    foot.appendChild(line1);
    var line2 = document.createElement("div"); line2.className = "qe-line qe-tok";
    line2.textContent = "Tokens de entrada estimados: calculando…";
    foot.appendChild(line2);
    panel.appendChild(foot);

    // Tokens: sumar estimateTokens de cada job de IA pendiente (cacheado por job).
    var aiJobs = pend.filter(function (j) { return j.kind === "generate" || j.kind === "feedback"; });
    if (!aiJobs.length) { line2.textContent = "Sin llamadas a la IA pendientes (solo render)."; return; }
    Promise.all(aiJobs.map(function (j) {
      if (typeof j._tokEst === "number") return Promise.resolve(j._tokEst);
      return hpCall("estimateTokens", j.payload).then(function (r) {
        j._tokEst = (r && r.ok) ? (r.inputTokensEst || 0) : 0; return j._tokEst;
      }).catch(function () { return 0; });
    })).then(function (vals) {
      var total = vals.reduce(function (a, b) { return a + (b || 0); }, 0);
      line2.textContent = "Tokens de entrada estimados (toda la cola): ≈ " + addThousands(total) +
        " · " + aiJobs.length + " llamada(s) a la IA · costo " + estimateCostLabel(total);
    }).catch(function () { line2.textContent = ""; });
  }

  // Costo estimado de la cola, auto-calibrado con el costo REAL ya acumulado en la
  // sesión ($/token de entrada). Local = gratis; sin datos aún = se calcula al correr.
  function estimateCostLabel(inputTokens) {
    if (currentProviderIsLocal) return "gratis (local)";
    var u = HPStore.getSessionUsage();
    if (u && u.costUsd > 0 && u.inputTokens > 0) {
      var est = inputTokens * (u.costUsd / u.inputTokens);
      return "≈ $" + (est < 0.1 ? est.toFixed(4) : est.toFixed(2));
    }
    return "s/d (se calcula al procesar)";
  }

  HPQueue.on(function () { renderQueue(HPQueue.jobs()); reflectQueueOnCards(); });

  function setButtonsDisabled(buttons, disabled) {
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = disabled;
  }

  // Tarjeta colapsable por marcador (compacta; escala a muchos marcadores).
  function createMarkerCard(marker) {
    var markerKey = markerKeyFor(marker);

    var card = document.createElement("details");
    card.className = "marker-card";

    var summary = document.createElement("summary");
    summary.className = "marker-summary";
    var sName = document.createElement("span");
    sName.className = "marker-name";
    sName.textContent = markerKey + (marker.name ? " · " + marker.name : "");
    var sMeta = document.createElement("span");
    sMeta.className = "marker-meta";
    sMeta.textContent = formatTime(marker.start) + " · " + marker.duration.toFixed(1) + "s";
    var sBadge = document.createElement("span");
    sBadge.className = "marker-badge";
    summary.appendChild(sName);
    summary.appendChild(sMeta);
    summary.appendChild(sBadge);
    // Al abrir/clicar el marcador, mover el playhead a ese punto.
    summary.addEventListener("click", function () {
      csInterface.evalScript("hp_seekToTime(" + marker.start + ")", function () {});
    });
    card.appendChild(summary);

    var body = document.createElement("div");
    body.className = "marker-body";

    var instruction = document.createElement("textarea");
    instruction.className = "marker-instruction";
    instruction.placeholder = "¿Qué querés que haga la IA en este marcador?";
    // Si el marcador trae un comentario en Premiere y todavía no escribiste una
    // instrucción, lo usamos como punto de partida (y lo guardamos).
    var initialInstruction = HPStore.getMarkerData(markerKey).instruction;
    if (!initialInstruction && marker.comment && marker.comment.trim()) {
      initialInstruction = marker.comment.trim();
      HPStore.setMarkerInstruction(markerKey, initialInstruction);
    }
    instruction.value = initialInstruction;
    instruction.addEventListener("input", debounce(function () {
      HPStore.setMarkerInstruction(markerKey, instruction.value);
    }, DEBOUNCE_MS));
    body.appendChild(instruction);

    body.appendChild(createStillsControl(markerKey));

    // Toggle de fondo: con fondo → mp4 HD opaco; sin fondo → mov con alpha.
    var bgRow = document.createElement("label");
    bgRow.className = "bg-toggle";
    var bgCheck = document.createElement("input");
    bgCheck.type = "checkbox";
    bgCheck.checked = !!HPStore.getMarkerData(markerKey).background;
    bgCheck.addEventListener("change", function () {
      HPStore.setMarkerBackground(markerKey, bgCheck.checked);
      updateEstimate();
    });
    var bgLbl = document.createElement("span");
    bgLbl.textContent = "Con fondo (mp4 HD opaco, temático) — sin fondo = alpha";
    bgRow.appendChild(bgCheck);
    bgRow.appendChild(bgLbl);
    body.appendChild(bgRow);

    // Transcript del marcador: colapsado (la herramienta ya lo tiene, es solo referencia).
    var sliceEl = createTranscriptSlice(marker);
    if (sliceEl) {
      var tDetails = document.createElement("details");
      tDetails.className = "transcript-details";
      var tSum = document.createElement("summary");
      tSum.textContent = "Ver transcript del marcador";
      tDetails.appendChild(tSum);
      tDetails.appendChild(sliceEl);
      body.appendChild(tDetails);
    }

    var actions = document.createElement("div");
    actions.className = "marker-actions";
    var genBtn = document.createElement("button");
    genBtn.type = "button";
    genBtn.className = "btn-generate";
    var regenBtn = document.createElement("button");
    regenBtn.type = "button";
    regenBtn.className = "btn-secondary";
    regenBtn.textContent = "Regenerar desde cero";
    regenBtn.title = "Descarta lo anterior y crea una versión nueva solo con la instrucción y recursos actuales";
    var queueBtn = document.createElement("button");
    queueBtn.type = "button";
    queueBtn.className = "btn-secondary";
    queueBtn.textContent = "＋ Enviar a la cola";
    queueBtn.title = "Encola sin empezar a procesar (arrancá con Iniciar cola)";
    var status = document.createElement("div");
    status.className = "marker-status";
    var buttons = [genBtn, regenBtn, queueBtn];

    // Refleja el estado: sin generar → solo "Generar"; ya generado → "Generar"
    // (refina) + "Regenerar desde cero", y badge ✓.
    function syncUI() {
      var generated = HPStore.getMarkerData(markerKey).generated;
      genBtn.textContent = generated ? "Generar (refinar)" : "Generar";
      genBtn.title = generated
        ? "Ajusta sobre la última versión usando tu nueva instrucción (mantiene lo que funciona)"
        : "Genera el gráfico animado de este marcador con la IA y lo coloca en el timeline";
      regenBtn.style.display = generated ? "" : "none";
      sBadge.textContent = generated ? "✓" : "";
    }

    function doGenerate() {
      var mode = HPStore.getMarkerData(markerKey).generated ? "adjust" : "generate";
      enqueueMarkerGeneration(marker, mode);
    }
    genBtn.addEventListener("click", doGenerate);
    regenBtn.addEventListener("click", function () {
      enqueueMarkerGeneration(marker, "regen");
    });
    queueBtn.addEventListener("click", function () {
      var mode = HPStore.getMarkerData(markerKey).generated ? "adjust" : "generate";
      enqueueMarkerGeneration(marker, mode, true); // staged: no arranca
    });

    // Para los botones globales "Generar listos" / "Agregar listos a la cola".
    card._runGen = doGenerate;
    card._runGenStaged = function () {
      var mode = HPStore.getMarkerData(markerKey).generated ? "adjust" : "generate";
      enqueueMarkerGeneration(marker, mode, true);
    };
    card._isReady = function () {
      return !!(HPStore.getMarkerData(markerKey).instruction || "").trim();
    };
    card._markerKey = markerKey;

    // Refleja el estado de un job de la cola en esta tarjeta: barra en el
    // status y un indicador en el summary (visible aunque esté colapsada).
    card._applyJob = function (job) {
      if (!job) return;
      var active = job.status === "queued" || job.status === "modeling" || job.status === "ready" || job.status === "running";
      if (active) {
        setButtonsDisabled(buttons, true);
        status.className = "marker-status is-busy";
        status.textContent = "";
        var bar = document.createElement("div"); bar.className = "hp-bar";
        var fill = document.createElement("div"); fill.className = "hp-bar-fill";
        fill.style.width = (job.pct || 0) + "%"; bar.appendChild(fill);
        var m = document.createElement("div"); m.className = "hp-bar-msg"; m.textContent = job.msg || "";
        status.appendChild(bar); status.appendChild(m);
        sBadge.textContent = (job.status === "running" || job.status === "modeling") ? "⏳" : "…";
      } else if (job.status === "done") {
        setButtonsDisabled(buttons, false);
        status.className = "marker-status is-ok";
        status.textContent = job.msg || "✓ Listo";
        syncUI();
      } else if (job.status === "waiting") {
        // Sin tokens / límite alcanzado: se reactiva desde la pestaña Cola.
        setButtonsDisabled(buttons, false);
        status.className = "marker-status is-warn";
        status.textContent = job.msg || "⏳ Sin tokens — reactivá desde la Cola cuando se reinicie tu uso";
        sBadge.textContent = "⏳";
      } else if (job.status === "error") {
        setButtonsDisabled(buttons, false);
        status.className = "marker-status is-error";
        status.textContent = job.msg || "Error";
        sBadge.textContent = "⚠";
      }
    };
    // Sin job asociado (ej. se borró de la cola): re-habilita los botones.
    card._clearJob = function () {
      setButtonsDisabled(buttons, false);
      status.className = "marker-status";
      status.textContent = "";
      syncUI();
    };

    var estimate = document.createElement("div");
    estimate.className = "marker-estimate";

    // Estima los tokens de entrada de este marcador (sin llamar al modelo).
    function updateEstimate() {
      var d = HPStore.getMarkerData(markerKey);
      var segs = HPStore.getTranscript() || [];
      var mt = HPTranscript.sliceByRange(segs, marker.start, marker.start + marker.duration);
      var body = {
        objective: HPStore.getObjective(),
        transcript: segs,
        marker: { name: marker.name || markerKey, start: marker.start, end: marker.start + marker.duration, duration: marker.duration },
        markerTranscript: mt,
        instruction: d.instruction || "",
        stills: d.stills || [],
        resources: d.resources || []
      };
      hpCall("estimateTokens", body)
        .then(function (r) {
          if (r && r.ok) {
            var extra = [];
            if (r.breakdown && r.breakdown.images) extra.push(r.breakdown.images + " img");
            if (r.breakdown && r.breakdown.resources) extra.push(r.breakdown.resources + " rec");
            estimate.textContent = "≈ " + fmtTokens(r.inputTokensEst) + " tokens de entrada" + (extra.length ? " (" + extra.join(", ") + ")" : "");
          }
        })
        .catch(function () {});
    }
    card._updateEstimate = updateEstimate;

    // Recalcular el estimado cuando cambia la instrucción.
    instruction.addEventListener("input", debounce(updateEstimate, DEBOUNCE_MS));

    actions.appendChild(genBtn);
    actions.appendChild(regenBtn);
    actions.appendChild(queueBtn);
    body.appendChild(actions);
    body.appendChild(estimate);
    body.appendChild(status);

    // ── Editor de HTML manual (elegir versión → Abrir → editar → Render) ──
    var editor = document.createElement("details");
    editor.className = "html-editor";
    var eSum = document.createElement("summary");
    eSum.textContent = "Editar HTML manualmente";
    editor.appendChild(eSum);

    var eBody = document.createElement("div");
    eBody.className = "html-editor-body";

    var verRow = document.createElement("div");
    verRow.className = "editor-row";
    var verMount = document.createElement("div");
    var openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn-secondary";
    openBtn.textContent = "Abrir";
    openBtn.title = "Carga el HTML de la versión elegida en el editor para retocarlo a mano";
    verRow.appendChild(verMount);
    verRow.appendChild(openBtn);

    var codeEd = makeCodeEditor();

    var renderBtn = document.createElement("button");
    renderBtn.type = "button";
    renderBtn.className = "btn-generate";
    renderBtn.textContent = "Guardar y renderizar (nueva versión)";
    renderBtn.title = "Renderiza el HTML editado como una versión nueva [manual], sin gastar IA, y la coloca en el timeline";

    var eStatus = document.createElement("div");
    eStatus.className = "marker-status";

    eBody.appendChild(verRow);
    eBody.appendChild(codeEd.el);
    eBody.appendChild(renderBtn);
    eBody.appendChild(eStatus);
    editor.appendChild(eBody);
    body.appendChild(editor);

    var verSel = HPSelect(verMount);

    function refreshVersions() {
      hpCall("listMarkerVersions", {
        projectPath: currentProjectPath, sequenceName: currentSequenceName, markerSlug: markerKey
      }).then(function (r) {
        if (r && r.ok && r.versions && r.versions.length) {
          var opts = r.versions.map(function (v) {
            return { value: String(v.version), label: "v" + v.version + (v.model ? " [" + v.model + "]" : "") };
          });
          verSel.setOptions(opts, String(r.versions[r.versions.length - 1].version));
        } else {
          verSel.setOptions([{ value: "", label: "(sin versiones aún)" }], "");
        }
      }).catch(function () {});
    }

    openBtn.addEventListener("click", function () {
      var v = parseInt(verSel.value, 10);
      if (!v) { eStatus.className = "marker-status is-error"; eStatus.textContent = "Generá una versión primero."; return; }
      eStatus.className = "marker-status"; eStatus.textContent = "Abriendo v" + v + "…";
      hpCall("readMarkerHtml", {
        projectPath: currentProjectPath, sequenceName: currentSequenceName, markerSlug: markerKey, version: v
      }).then(function (r) {
        if (r && r.ok) { codeEd.setValue(r.html); eStatus.textContent = "v" + v + " cargada — editá y dale Render."; }
        else { eStatus.className = "marker-status is-error"; eStatus.textContent = "No se pudo abrir: " + ((r && r.error) || ""); }
      }).catch(function (e) { eStatus.className = "marker-status is-error"; eStatus.textContent = "Error: " + ((e && e.message) || ""); });
    });

    renderBtn.addEventListener("click", function () {
      var html = codeEd.getValue().trim();
      if (!html) { eStatus.className = "marker-status is-error"; eStatus.textContent = "El HTML está vacío."; return; }
      HPQueue.add({
        kind: "renderManualHtml",
        payload: {
          projectPath: currentProjectPath, sequenceName: currentSequenceName,
          marker: { name: marker.name || markerKey, start: marker.start, end: marker.start + marker.duration, duration: marker.duration },
          markerSlug: markerKey, html: html, draft: draftMode
        },
        seqName: currentSequenceName, projectPath: currentProjectPath, markerKey: markerKey,
        label: markerKey + " (edición manual)", markerStart: marker.start, markerDuration: marker.duration
      });
      eStatus.className = "marker-status";
      eStatus.textContent = "Encolado. Mirá el progreso en la Cola (arriba) o en el estado del marcador.";
      // Refrescar la lista de versiones cuando el job termine (aprox).
      setTimeout(refreshVersions, 1500);
    });

    // Refrescar la lista de versiones al abrir el editor.
    editor.addEventListener("toggle", function () { if (editor.open) refreshVersions(); });

    card.appendChild(body);

    // Acordeón: al abrir esta tarjeta, colapsar las demás (ahorra pantalla).
    card.addEventListener("toggle", function () {
      if (!card.open) return;
      updateEstimate();
      var all = markersContainer.querySelectorAll("details.marker-card");
      for (var i = 0; i < all.length; i++) {
        if (all[i] !== card) all[i].open = false;
      }
    });

    syncUI();
    return card;
  }

  function renderMarkers(markers) {
    markersContainer.innerHTML = "";

    if (markers.length === 0) {
      setOutput("La secuencia activa no tiene marcadores.", false);
      setHeaderStatus((currentSequenceName || "secuencia") + " · sin marcadores", "idle");
      return;
    }

    for (var i = 0; i < markers.length; i++) {
      markersContainer.appendChild(createMarkerCard(markers[i]));
    }
    setOutput(markers.length + " marcador(es) cargados · estado guardado ✓", false);
    // Estado de secuencia arriba, en verde.
    setHeaderStatus((currentSequenceName || "secuencia") + " ✓", "ok");
    // Flujo progresivo: al tener marcadores, colapsar contexto para dar aire.
    var ctx = document.getElementById("context-section");
    if (ctx && objectiveInput && objectiveInput.value.trim()) ctx.open = false;
    // Si hay jobs en curso de esta secuencia, reflejar su progreso en las tarjetas.
    reflectQueueOnCards();
  }

  function onLoadMarkers() {
    setOutput("Cargando marcadores…", false);

    // Refrescar el contexto antes de renderizar: si el usuario cambió de
    // proyecto o secuencia, las tarjetas deben rehidratarse del namespace nuevo.
    loadContext(function () {
      hydrateObjective();
      hydrateGeneral();
      updateTranscriptStatus();

      csInterface.evalScript("hp_getMarkers()", function (result) {
        if (result === undefined || result === null || result === "EvalScript error.") {
          setOutput("Error al comunicarse con Premiere (EvalScript).", true);
          return;
        }

        var data;
        try {
          data = JSON.parse(result);
        } catch (e) {
          setOutput("Respuesta inválida del host: " + result, true);
          return;
        }

        if (data && data.error) {
          markersContainer.innerHTML = "";
          setOutput(data.error, true);
          return;
        }

        renderMarkers(data);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Configuración del modelo (proveedor / modelo / token / baseUrl)
  // ---------------------------------------------------------------------

  // Desplegable propio: Premiere (CEP/CEF) no dibuja el popup de los <select>
  // nativos, así que armamos uno con divs (botón + menú) que sí despliega.
  function HPSelect(root) {
    if (!root) return null;
    root.classList.add("hp-select");
    root.innerHTML = "";
    var trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "hps-trigger";
    var label = document.createElement("span");
    label.className = "hps-label";
    var arrow = document.createElement("span");
    arrow.className = "hps-arrow";
    arrow.textContent = "▾";
    trigger.appendChild(label);
    trigger.appendChild(arrow);
    var menu = document.createElement("div");
    menu.className = "hps-menu";
    menu.hidden = true;
    root.appendChild(trigger);
    root.appendChild(menu);

    var opts = [];
    var value = null;
    var api = { onChange: null };

    function labelFor(v) {
      for (var i = 0; i < opts.length; i++) if (opts[i].value === v) return opts[i].label;
      return v || "—";
    }
    function markSelected() {
      var kids = menu.children;
      for (var i = 0; i < kids.length; i++) {
        kids[i].className = "hps-option" + (kids[i].getAttribute("data-value") === value ? " is-sel" : "");
      }
    }
    function close() { menu.hidden = true; root.classList.remove("is-open"); if (_hpOpenSelect && _hpOpenSelect.root === root) _hpOpenSelect = null; }
    function toggle(e) {
      e.stopPropagation();
      if (menu.hidden) {
        // Cerrar cualquier otro desplegable abierto (solo uno a la vez).
        if (_hpOpenSelect && _hpOpenSelect.root !== root) _hpOpenSelect.close();
        menu.hidden = false; root.classList.add("is-open");
        _hpOpenSelect = { root: root, close: close };
      } else { close(); }
    }

    trigger.addEventListener("click", toggle);

    api.setOptions = function (list, selected) {
      opts = (list || []).map(function (o) { return { value: String(o.value), label: String(o.label) }; });
      menu.innerHTML = "";
      opts.forEach(function (o) {
        var el = document.createElement("div");
        el.className = "hps-option";
        el.setAttribute("data-value", o.value);
        el.textContent = o.label;
        el.addEventListener("click", function (e) {
          e.stopPropagation();
          var changed = (o.value !== value);
          value = o.value;
          label.textContent = o.label;
          markSelected();
          close();
          if (changed && typeof api.onChange === "function") api.onChange(value);
        });
        menu.appendChild(el);
      });
      if (selected != null) value = String(selected);
      label.textContent = labelFor(value);
      markSelected();
    };
    Object.defineProperty(api, "value", {
      get: function () { return value; },
      set: function (v) { value = (v == null ? null : String(v)); label.textContent = labelFor(value); markSelected(); }
    });
    return api;
  }

  // Un único listener global cierra el desplegable abierto al clicar afuera
  // (evita acumular un listener por cada HPSelect creado al recargar marcadores).
  var _hpOpenSelect = null;
  document.addEventListener("click", function (e) {
    if (_hpOpenSelect && !_hpOpenSelect.root.contains(e.target)) _hpOpenSelect.close();
  });

  var cfgProviderSel = HPSelect(document.getElementById("cfg-provider"));
  var cfgModelSel = HPSelect(document.getElementById("cfg-model"));
  var cfgModelCustom = document.getElementById("cfg-model-custom");
  var cfgApiKey = document.getElementById("cfg-apikey");
  var cfgBaseUrl = document.getElementById("cfg-baseurl");
  var btnSaveConfig = document.getElementById("btn-save-config");
  var configStatus = document.getElementById("config-status");
  var cfgSummary = document.getElementById("cfg-summary");
  var configSection = document.querySelector(".config-section");

  var currentHasSession = false;

  // Modelos compatibles por proveedor. Claude corre por CLI o API; los demás
  // por API compatible (OpenAI/Gemini/OpenRouter) o local (Ollama).
  var CLAUDE_MODELS = [
    { v: "claude-sonnet-5", t: "Sonnet 5 — rápido (recomendado)" },
    { v: "claude-opus-4-8", t: "Opus 4.8 — máxima calidad (lento)" },
    { v: "claude-haiku-4-5-20251001", t: "Haiku 4.5 — el más rápido" },
    { v: "claude-fable-5", t: "Fable 5" }
  ];
  var MODELS = {
    "claude-cli": CLAUDE_MODELS,
    "claude-api": CLAUDE_MODELS,
    "openai-compat": [
      { v: "gpt-4o", t: "OpenAI · GPT-4o" },
      { v: "gpt-4o-mini", t: "OpenAI · GPT-4o mini" },
      { v: "gemini-2.0-flash", t: "Google · Gemini 2.0 Flash" },
      { v: "gemini-1.5-pro", t: "Google · Gemini 1.5 Pro" },
      { v: "__custom__", t: "Otro (escribir ID)…" }
    ],
    "ollama": [
      { v: "qwen3-coder:30b", t: "qwen3-coder:30b" },
      { v: "llama3.2-vision", t: "llama3.2-vision (con imágenes)" },
      { v: "__custom__", t: "Otro (escribir ID)…" }
    ]
  };
  var PROVIDER_LABEL = {
    "claude-cli": "Claude (suscripción)",
    "claude-api": "Claude (API)",
    "openai-compat": "API compatible",
    "ollama": "Ollama local"
  };
  var BASEURL_HINT = {
    "openai-compat": "OpenAI: https://api.openai.com/v1 · Gemini: https://generativelanguage.googleapis.com/v1beta/openai · OpenRouter: https://openrouter.ai/api/v1",
    "ollama": "opcional — por defecto http://localhost:11434"
  };

  function showRow(id, show) {
    var el = document.getElementById(id);
    if (el) el.setAttribute("data-hidden", show ? "false" : "true");
  }

  // Rellena el desplegable de modelos según el proveedor y marca el activo.
  function populateModels(provider, selected) {
    var list = MODELS[provider] || CLAUDE_MODELS;
    var matched = false;
    for (var i = 0; i < list.length; i++) if (list[i].v === selected) matched = true;
    var opts = list.map(function (o) { return { value: o.v, label: o.t }; });
    var val;
    if (selected && !matched && provider !== "claude-cli" && provider !== "claude-api") {
      // ID personalizado que no está en la lista → seleccionar "Otro" y precargar.
      val = "__custom__";
      if (cfgModelCustom) cfgModelCustom.value = selected;
    } else if (matched) {
      val = selected;
    } else {
      val = list[0].v;
    }
    cfgModelSel.setOptions(opts, val);
  }

  // Modelo efectivo: el del desplegable, o el texto libre si eligió "Otro".
  function effectiveModel() {
    if (cfgModelSel.value === "__custom__") return (cfgModelCustom.value || "").trim();
    return cfgModelSel.value;
  }

  function modelLabel(id) {
    for (var p in MODELS) {
      for (var i = 0; i < MODELS[p].length; i++) {
        if (MODELS[p][i].v === id) return MODELS[p][i].t.replace(/ —.*$/, "").replace(/\s*·.*$/, " ").trim() || id;
      }
    }
    return id;
  }

  // Muestra/oculta campos según el proveedor y actualiza pistas.
  function applyProviderUI() {
    var p = cfgProviderSel.value;
    showRow("row-login", p === "claude-cli");
    showRow("row-apikey", p === "claude-api" || p === "openai-compat");
    showRow("row-baseurl", p === "openai-compat" || p === "ollama");
    showRow("row-model-custom", cfgModelSel.value === "__custom__");
    var hintEl = document.getElementById("baseurl-hint");
    if (hintEl) hintEl.textContent = BASEURL_HINT[p] || "";
    // Aviso de lentitud para modelos locales.
    var noteEl = document.getElementById("provider-note");
    if (noteEl) {
      if (p === "ollama") {
        var m = effectiveModel();
        var dense = /vl:32b|:32b|coder:30b|gemma4/i.test(m);
        noteEl.textContent = "⏳ Modelo local: cada marcador puede tardar " +
          (dense ? "10–20+ min (modelo denso/pesado)" : "2–4 min") +
          ". No cierres el panel mientras genera.";
        noteEl.setAttribute("data-hidden", "false");
      } else {
        noteEl.setAttribute("data-hidden", "true");
      }
    }
  }

  // Semáforo del resumen: verde si el proveedor está listo, aviso si falta algo.
  function updateSummary() {
    if (!cfgSummary) return;
    var p = cfgProviderSel.value;
    var model = effectiveModel();
    var ok = true, warn = "";
    if (p === "claude-cli" && !currentHasSession) { ok = false; warn = "iniciá sesión en Claude"; }
    if (p === "claude-api" && !(cfgApiKey.value.trim() || cfgApiKey.getAttribute("data-has") === "1")) { ok = false; warn = "falta API key"; }
    if (p === "openai-compat" && !cfgBaseUrl.value.trim()) { ok = false; warn = "falta Base URL"; }
    if (!model) { ok = false; warn = "falta el modelo"; }
    if (ok) {
      cfgSummary.textContent = "✓ " + (PROVIDER_LABEL[p] || p) + " · " + modelLabel(model);
      cfgSummary.className = "cfg-summary is-ok";
    } else {
      cfgSummary.textContent = "⚠ " + warn;
      cfgSummary.className = "cfg-summary is-warn";
    }
    return ok;
  }

  function autoSave() {
    var body = { provider: cfgProviderSel.value, model: effectiveModel() };
    if (cfgApiKey.value.trim()) body.apiKey = cfgApiKey.value.trim();
    if (cfgBaseUrl.value.trim()) body.baseUrl = cfgBaseUrl.value.trim();
    if (!body.model) { updateSummary(); return; }
    configStatus.textContent = "Guardando…";
    hpCall("setConfig", body)
      .then(function () {
        configStatus.textContent = "✓ Guardado";
        if (cfgApiKey.value.trim()) { cfgApiKey.setAttribute("data-has", "1"); cfgApiKey.value = ""; cfgApiKey.setAttribute("placeholder", "•••• (guardada)"); }
        updateSummary();
      })
      .catch(function (e) {
        configStatus.textContent = "Error al guardar: " + ((e && e.message) || "");
      });
  }

  function defaultModelFor(p) {
    return (p === "claude-cli" || p === "claude-api") ? "claude-sonnet-5" : "";
  }

  // Autopobla la lista de Ollama con los modelos realmente instalados.
  function refreshOllamaModels(selected) {
    var base = (cfgBaseUrl.value || "").trim();
    hpCall("listOllamaModels", base)
      .then(function (r) {
        if (r && r.ok && r.models && r.models.length) {
          var list = r.models.map(function (m) {
            // Marcar los modelos con visión (pueden leer los stills).
            var vision = /(-vl|vision|llava)/i.test(m);
            return { v: m, t: m + (vision ? "  👁 visión" : "") };
          });
          list.push({ v: "__custom__", t: "Otro (escribir ID)…" });
          MODELS["ollama"] = list;
          if (cfgProviderSel.value === "ollama") { populateModels("ollama", selected || effectiveModel()); applyProviderUI(); updateSummary(); }
        }
      })
      .catch(function () {});
  }

  // Vuelca una config (del motor) a los controles del panel.
  function applyConfigToUI(cfg) {
    if (!cfg) return;
    if (cfg.provider) cfgProviderSel.value = cfg.provider;
    currentProviderIsLocal = (cfg.provider === "ollama");
    currentModelName = cfg.model || "";
    currentHasSession = Boolean(cfg.hasSession);
    cfgBaseUrl.value = cfg.baseUrl || "";
    cfgApiKey.value = "";
    if (cfg.apiKey) { cfgApiKey.setAttribute("data-has", "1"); cfgApiKey.setAttribute("placeholder", "•••• (guardada)"); }
    else { cfgApiKey.removeAttribute("data-has"); cfgApiKey.setAttribute("placeholder", "Pegá tu API key"); }
    if (cfg.hasSession && loginStatus) { loginStatus.textContent = "✓ Sesión de Claude activa"; loginStatus.className = "muted login-ok"; }
    populateModels(cfgProviderSel.value, cfg.model || defaultModelFor(cfgProviderSel.value));
    applyProviderUI();
    updateSummary();
    if (cfgProviderSel.value === "ollama") refreshOllamaModels(cfg.model);
  }

  function loadConfig() {
    hpCall("getConfig")
      .then(function (cfg) {
        applyConfigToUI(cfg);
        // Si ya está bien configurado, arranca colapsado (flujo progresivo).
        if (updateSummary() && configSection) configSection.open = false;
      })
      .catch(function (e) {
        if (configStatus) configStatus.textContent = (e && e.message) || "Motor no disponible";
      });
  }

  // Opciones fijas del proveedor.
  cfgProviderSel.setOptions([
    { value: "claude-cli", label: "Claude (CLI / suscripción)" },
    { value: "claude-api", label: "Claude (API key)" },
    { value: "openai-compat", label: "API compatible (OpenAI / Gemini / OpenRouter…)" },
    { value: "ollama", label: "Local (Ollama)" }
  ], "claude-cli");

  // Cambiar de proveedor: guarda el proveedor activo y RESTAURA las credenciales
  // guardadas de ese proveedor (no se pierden al saltar entre modelos).
  cfgProviderSel.onChange = function () {
    configStatus.textContent = "Cambiando…";
    hpCall("setConfig", { provider: cfgProviderSel.value })
      .then(function (cfg) { applyConfigToUI(cfg); configStatus.textContent = "✓ Guardado"; })
      .catch(function (e) { configStatus.textContent = "Error: " + ((e && e.message) || ""); });
  };
  cfgModelSel.onChange = function () {
    applyProviderUI();
    autoSave();
  };
  if (cfgModelCustom) cfgModelCustom.addEventListener("input", debounce(function () { updateSummary(); }, DEBOUNCE_MS));
  if (cfgApiKey) cfgApiKey.addEventListener("input", function () { updateSummary(); });
  if (cfgBaseUrl) cfgBaseUrl.addEventListener("input", debounce(function () { updateSummary(); }, DEBOUNCE_MS));
  if (btnSaveConfig) btnSaveConfig.addEventListener("click", autoSave);

  // ── Contador de uso de la sesión (tokens) ───────────────────────────
  var suValue = document.getElementById("su-value");
  var suReset = document.getElementById("su-reset");
  // Número con separador de miles (1234 -> "1.234").
  function addThousands(n) {
    n = Math.round(Number(n) || 0);
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }
  // Compacto para etiquetas cortas (1234 -> "1,2k").
  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(".", ",") + "k";
    return String(n);
  }
  // Duración legible: "45s" o "1m 12s".
  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m ? (m + "m " + (s < 10 ? "0" : "") + s + "s") : (s + "s");
  }
  function updateSessionUsageBar() {
    if (!suValue) return;
    var u = HPStore.getSessionUsage();
    if (!u.generations) { suValue.textContent = "sin generaciones todavía"; return; }
    var txt = addThousands(u.inputTokens) + " tokens de entrada · " +
      addThousands(u.outputTokens) + " de salida";
    if (u.costUsd > 0) txt += " · $" + u.costUsd.toFixed(3);
    txt += " · " + u.generations + (u.generations === 1 ? " generación" : " generaciones");
    suValue.textContent = txt;
  }
  if (suReset) suReset.addEventListener("click", function () {
    HPStore.resetSessionUsage();
    updateSessionUsageBar();
  });
  updateSessionUsageBar();

  // Actualización: muestra la versión y, al tocar, hace git pull y recarga.
  var btnUpdate = document.getElementById("btn-update");
  var versionLabel = document.getElementById("version-label");
  hpCall("getVersion").then(function (v) {
    if (versionLabel && v) versionLabel.textContent = "v" + v;
  }).catch(function () {});

  // Aviso de actualización: al abrir el panel (y cada 30 min) consulta GitHub;
  // si hay versión nueva, el botón ⟳ se resalta y avisa que puede actualizar.
  function checkForUpdate() {
    hpCall("checkUpdate").then(function (res) {
      if (!btnUpdate) return;
      if (res && res.ok && res.changed) {
        btnUpdate.classList.add("has-update");
        if (versionLabel) versionLabel.textContent = "v" + res.current + " → v" + res.remote;
        btnUpdate.title = "¡Nueva versión v" + res.remote + " disponible en GitHub! Tocá para actualizar.";
      } else {
        btnUpdate.classList.remove("has-update");
        if (res && res.ok && res.current && versionLabel) versionLabel.textContent = "v" + res.current;
      }
    }).catch(function () {});
  }
  checkForUpdate();
  setInterval(checkForUpdate, 30 * 60 * 1000);

  // Recarga COMPLETA del panel (re-ejecuta main.js → loadEngine, reloadHostJsx,
  // busteo de cache del bridge). Sirve tanto para traer código nuevo como para
  // reintentar la carga del motor si quedó caído. Varias vías por si alguna no
  // está disponible en esta versión de CEP.
  function reloadPanel() {
    hpLog("Recargando el panel completo…");
    try { window.location.reload(); return; } catch (e) {}
    try { window.location.href = window.location.href; return; } catch (e) {}
    try { csInterface.evalScript(""); } catch (e) {}
  }

  if (btnUpdate) {
    btnUpdate.addEventListener("click", function () {
      btnUpdate.disabled = true;
      var icon = btnUpdate.querySelector(".update-icon");
      if (icon) icon.classList.add("spinning");
      btnUpdate.title = "Buscando actualización y recargando el panel…";
      hpLog("Botón ⟳: buscar update + recargar panel.");

      // Recargamos SIEMPRE, haya o no update (y aunque el motor esté caído).
      // Failsafe: si el git fetch se cuelga, recargamos igual a los 12s.
      var reloaded = false;
      function goReload() {
        if (reloaded) return; reloaded = true;
        setTimeout(reloadPanel, 350);
      }
      setTimeout(goReload, 12000);

      hpCall("selfUpdate")
        .then(function (res) {
          if (res && res.ok && res.changed) {
            hpLog("Update aplicado v" + (res.previous || "?") + " → v" + res.version + " (GitHub).");
            if (versionLabel) versionLabel.textContent = "v" + res.version;
          } else if (res && res.ok) {
            hpLog("Ya en la última (v" + res.version + "). Recargo igual.");
          } else {
            hpLog("selfUpdate sin cambios: " + ((res && res.error) || "?") + ". Recargo igual.", "WARN");
          }
        })
        .catch(function (e) {
          // Motor caído / offline: recargamos igual (la recarga puede revivir el motor).
          hpLog("selfUpdate falló: " + ((e && e.message) || "") + " — recargo igual.", "WARN");
        })
        .then(goReload);
    });
  }

  // Iniciar sesión en Claude: el puente corre `claude setup-token`, abre el
  // navegador y guarda el token solo. No hay que pegar nada a mano.
  var btnLoginClaude = document.getElementById("btn-login-claude");
  var loginStatus = document.getElementById("login-status");
  if (btnLoginClaude) {
    btnLoginClaude.addEventListener("click", function () {
      btnLoginClaude.disabled = true;
      loginStatus.textContent = "Abrí el navegador y autorizá… (esperando)";
      hpCall("loginClaude")
        .then(function (data) {
          if (data && data.ok) {
            loginStatus.textContent = "✓ Sesión de Claude activa";
            loginStatus.className = "muted login-ok";
            cfgProviderSel.value = "claude-cli";
            currentHasSession = true;
            populateModels(cfgProviderSel.value, effectiveModel());
            applyProviderUI();
            autoSave();
          } else {
            loginStatus.textContent = "Error: " + ((data && data.error) || "desconocido");
            loginStatus.className = "muted login-err";
          }
        })
        .catch(function (e) {
          loginStatus.textContent = "Error: " + ((e && e.message) || "login falló");
          loginStatus.className = "muted login-err";
        })
        .then(function () { btnLoginClaude.disabled = false; });
    });
  }

  btnLoadMarkers.addEventListener("click", onLoadMarkers);

  // Generar todos los marcadores listos (con instrucción), en secuencia.
  var btnGenerateAll = document.getElementById("btn-generate-all");
  var batchStatus = document.getElementById("batch-status");
  function enqueueAllReady(staged) {
    var cards = markersContainer.querySelectorAll("details.marker-card");
    var n = 0;
    for (var i = 0; i < cards.length; i++) {
      if (cards[i]._isReady && cards[i]._isReady()) {
        if (staged) cards[i]._runGenStaged(); else cards[i]._runGen();
        n++;
      }
    }
    if (batchStatus) {
      batchStatus.textContent = n
        ? (staged
            ? "Encolados " + n + " marcador(es) en espera — tocá “Iniciar cola” cuando quieras."
            : "Encolados " + n + " marcador(es) — se procesan uno a uno (mirá la Cola arriba).")
        : "No hay marcadores listos (poné una instrucción en al menos uno).";
    }
  }
  if (btnGenerateAll) btnGenerateAll.addEventListener("click", function () { enqueueAllReady(false); });
  var btnQueueReady = document.getElementById("btn-queue-ready");
  if (btnQueueReady) btnQueueReady.addEventListener("click", function () { enqueueAllReady(true); });

  // ── Estado en el header (verde OK / rojo error) ─────────────────────
  var hdrStatus = document.getElementById("hdr-status");
  function setHeaderStatus(text, state) {
    if (!hdrStatus) return;
    hdrStatus.textContent = text;
    hdrStatus.className = "hdr-chip is-" + (state || "idle");
  }

  // ── Toggle de modo borrador (global) ────────────────────────────────
  var draftCheck = document.getElementById("draft-mode");
  if (draftCheck) {
    draftCheck.checked = draftMode;
    draftCheck.addEventListener("change", function () {
      draftMode = draftCheck.checked;
      try { window.localStorage.setItem("hyperpremiere::draft", draftMode ? "1" : "0"); } catch (e) {}
    });
  }

  // ── Pestañas: Marcadores / Cola ─────────────────────────────────────
  var tabMarkers = document.getElementById("tab-markers");
  var tabQueue = document.getElementById("tab-queue");
  var viewMarkers = document.getElementById("view-markers");
  var viewQueue = document.getElementById("view-queue");
  function selectTab(which) {
    var q = which === "queue";
    if (viewMarkers) viewMarkers.setAttribute("data-hidden", q ? "true" : "false");
    if (viewQueue) viewQueue.setAttribute("data-hidden", q ? "false" : "true");
    if (tabMarkers) tabMarkers.className = "tab" + (q ? "" : " is-active");
    if (tabQueue) tabQueue.className = "tab" + (q ? " is-active" : "");
  }
  if (tabMarkers) tabMarkers.addEventListener("click", function () { selectTab("markers"); });
  if (tabQueue) tabQueue.addEventListener("click", function () { selectTab("queue"); });

  // ── "¿Cómo funciona?" como overlay ──────────────────────────────────
  var helpPanel = document.getElementById("help-panel");
  var btnHelp = document.getElementById("btn-help");
  var btnHelpClose = document.getElementById("btn-help-close");
  function toggleHelp(show) {
    if (!helpPanel) return;
    helpPanel.setAttribute("data-hidden", show ? "false" : "true");
  }
  // Botón "Descargar log": baja el log de diagnóstico a Descargas.
  var btnLog = document.getElementById("btn-log");
  if (btnLog) {
    btnLog.addEventListener("click", function () {
      hpLog("Usuario pidió descargar el log.");
      var res = downloadLog();
      if (res && res.ok) {
        setOutput("Log descargado en:\n" + res.path + "\nMandámelo para revisar la falla.", false);
      } else {
        setOutput("No pude descargar el log: " + (res && res.error), true);
      }
    });
  }

  if (btnHelp) btnHelp.addEventListener("click", function () { toggleHelp(helpPanel.getAttribute("data-hidden") !== "false" ? true : false); });
  if (btnHelpClose) btnHelpClose.addEventListener("click", function () { toggleHelp(false); });
  if (helpPanel) helpPanel.addEventListener("click", function (e) { if (e.target === helpPanel) toggleHelp(false); });

  loadConfig();

  // ── Tooltips propios ────────────────────────────────────────────────
  // CEF (Premiere) NO dibuja los tooltips nativos de `title`. Mostramos uno
  // propio leyendo el atributo title/data-tip de cualquier botón o control.
  (function customTooltips() {
    var tip = document.createElement("div");
    tip.className = "hp-tip"; tip.setAttribute("data-hidden", "true");
    document.body.appendChild(tip);
    var curEl = null;
    function titledAncestor(el) {
      while (el && el !== document.body && el.nodeType === 1) {
        if (el.getAttribute) {
          var t = el.getAttribute("title");
          if (t) { el.setAttribute("data-tip", t); el.removeAttribute("title"); return { el: el, t: t }; }
          var dt = el.getAttribute("data-tip");
          if (dt) return { el: el, t: dt };
        }
        el = el.parentNode;
      }
      return null;
    }
    function place(el) {
      var r = el.getBoundingClientRect();
      tip.style.visibility = "hidden"; tip.setAttribute("data-hidden", "false");
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      var left = Math.max(6, Math.min(window.innerWidth - tw - 6, r.left));
      var top = r.bottom + 6;
      if (top + th > window.innerHeight - 6) top = r.top - th - 6; // arriba si no cabe abajo
      tip.style.left = left + "px"; tip.style.top = Math.max(6, top) + "px";
      tip.style.visibility = "visible";
    }
    document.addEventListener("mouseover", function (e) {
      var r = titledAncestor(e.target);
      if (!r) return;
      if (r.el === curEl && tip.getAttribute("data-hidden") === "false") return;
      curEl = r.el; tip.textContent = r.t; place(r.el);
    });
    document.addEventListener("mouseout", function (e) {
      if (!curEl) return;
      // Ocultar solo al salir del elemento con tooltip (no al pasar a un hijo).
      if (e.relatedTarget && curEl.contains(e.relatedTarget)) return;
      tip.setAttribute("data-hidden", "true"); curEl = null;
    });
    document.addEventListener("click", function () { tip.setAttribute("data-hidden", "true"); curEl = null; }, true);
  })();

  // Arranque: fijar contexto y rehidratar objetivo + estado del transcript.
  loadContext(function () {
    hydrateObjective();
    hydrateGeneral();
    updateTranscriptStatus();
  });

  // Si el motor no cargó, avisar de una (sin esperar a que corra la cola) con la
  // causa REAL, para no andar adivinando "Motor no disponible".
  if (!HP_ENGINE) {
    setHeaderStatus("motor no cargó", "error");
    setOutput(engineErrMsg() + "\n\n(Tocá ⬇ en el header para descargar el log y mandámelo.)", true);
    hpLog("Panel listo — MOTOR NO CARGÓ.", "ERROR");
  } else {
    setHeaderStatus("motor OK", "ok");
    hpLog("Panel listo — motor OK desde " + ENGINE_PATH);
    checkEngineDeps();
  }

  // ── Preparación del motor (autocontenido, 1ª corrida) ───────────────
  // Si el código del motor cargó pero faltan sus dependencias (instalación
  // limpia del ZXP), mostramos el banner para instalarlas una sola vez.
  var epBanner = document.getElementById("engine-prep");
  var epMsg = document.getElementById("ep-msg");
  var epProg = document.getElementById("ep-progress");
  var epFill = document.getElementById("ep-fill");
  var btnPrepare = document.getElementById("btn-prepare-engine");
  function showEnginePrep(show) { if (epBanner) epBanner.setAttribute("data-hidden", show ? "false" : "true"); }
  function checkEngineDeps() {
    hpCall("engineStatus").then(function (st) {
      if (st && st.ok && st.depsReady === false) {
        hpLog("Motor SIN dependencias (instalación limpia) — mostrando 'Preparar motor'.", "WARN");
        showEnginePrep(true);
        setHeaderStatus("preparar motor", "warn");
      } else {
        showEnginePrep(false);
      }
    }).catch(function () {});
  }
  if (btnPrepare) {
    btnPrepare.addEventListener("click", function () {
      btnPrepare.disabled = true;
      if (epProg) epProg.setAttribute("data-hidden", "false");
      if (epMsg) epMsg.textContent = "Preparando…";
      hpLog("Usuario tocó 'Preparar motor'.");
      hpCallProg("prepareEngine", null, function (p) {
        if (!p) return;
        if (typeof p.pct === "number" && epFill) epFill.style.width = Math.max(0, Math.min(100, p.pct)) + "%";
        if (p.msg && epMsg) epMsg.textContent = p.msg;
      }).then(function (res) {
        if (res && res.ok) {
          if (epFill) epFill.style.width = "100%";
          if (epMsg) epMsg.textContent = "✓ Motor listo.";
          hpLog("Motor preparado OK.");
          setHeaderStatus("motor OK", "ok");
          setTimeout(function () { showEnginePrep(false); }, 1500);
        } else {
          throw new Error((res && res.error) || "falló la preparación");
        }
      }).catch(function (e) {
        if (epMsg) epMsg.textContent = "Error: " + ((e && e.message) || "no se pudo preparar");
        hpLog("prepareEngine falló: " + ((e && e.message) || e), "ERROR");
        btnPrepare.disabled = false;
      });
    });
  }
})();
