(function () {
  "use strict";

  var DEBOUNCE_MS = 300;

  // Motor "todo en uno": corre dentro del panel vía Node (CEP --enable-nodejs).
  // No hay servidor ni proceso externo. Ruta absoluta al módulo del repo.
  var ENGINE_PATH = "/Users/danielgutierrez/Desktop/Codigo/HyperPremiere/bridge/engine.js";
  var HP_ENGINE = null;
  (function loadEngine() {
    try {
      var req = (typeof window !== "undefined" && window.cep_node && window.cep_node.require)
        ? window.cep_node.require
        : (typeof require === "function" ? require : null);
      if (req) HP_ENGINE = req(ENGINE_PATH);
    } catch (e) {
      HP_ENGINE = null;
    }
  })();

  // Llama a un método del motor y devuelve SIEMPRE una Promise (los métodos
  // sync como getConfig también quedan envueltos). Si Node no está disponible,
  // rechaza con un mensaje claro.
  function hpCall(method, arg) {
    if (!HP_ENGINE || typeof HP_ENGINE[method] !== "function") {
      return Promise.reject(new Error("Motor no disponible. Cerrá y reabrí Premiere para activar Node en el panel."));
    }
    try {
      return Promise.resolve(HP_ENGINE[method](arg));
    } catch (e) {
      return Promise.reject(e);
    }
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

  var btnTestConnection = document.getElementById("btn-test-connection");
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

  function loadContext(done) {
    csInterface.evalScript("hp_getProjectPath()", function (projectPath) {
      csInterface.evalScript("hp_getActiveSequenceName()", function (sequenceName) {
        currentProjectPath = projectPath || "";
        currentSequenceName = sequenceName || "";
        HPStore.setContext(currentProjectPath, currentSequenceName);
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

  function onTestConnection() {
    setOutput("Consultando secuencia activa…", false);

    csInterface.evalScript("hp_getActiveSequenceName()", function (result) {
      if (result === undefined || result === null || result === "EvalScript error.") {
        setOutput("Error al comunicarse con Premiere (EvalScript).", true);
        return;
      }
      setOutput("Secuencia activa: " + result, false);
    });
  }

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

  function renderStills(container, markerKey) {
    container.innerHTML = "";
    var stills = HPStore.getMarkerData(markerKey).stills;

    for (var i = 0; i < stills.length; i++) {
      (function (index) {
        var thumb = document.createElement("div");
        thumb.className = "still-thumb";

        var img = document.createElement("img");
        img.src = stills[index];

        var remove = document.createElement("button");
        remove.type = "button";
        remove.className = "still-remove";
        remove.textContent = "x";
        remove.addEventListener("click", function () {
          HPStore.removeMarkerStill(markerKey, index);
          renderStills(container, markerKey);
        });

        thumb.appendChild(img);
        thumb.appendChild(remove);
        container.appendChild(thumb);
      })(i);
    }
  }

  function createStillsControl(markerKey) {
    var wrap = document.createElement("div");
    wrap.className = "marker-stills";

    var thumbs = document.createElement("div");
    thumbs.className = "still-thumbs";

    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.multiple = true;
    fileInput.style.display = "none";

    // Botón principal: capturar el frame ACTUAL del monitor de programa.
    var captureBtn = document.createElement("button");
    captureBtn.type = "button";
    captureBtn.className = "btn-add-still";
    captureBtn.textContent = "📸 Capturar del programa";

    var stillStatus = document.createElement("div");
    stillStatus.className = "still-status";

    captureBtn.addEventListener("click", function () {
      captureProgramStill(markerKey, thumbs, captureBtn, stillStatus);
    });

    // Secundario: subir un archivo de imagen.
    var addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn-add-still-file";
    addBtn.textContent = "…o subir archivo";
    addBtn.addEventListener("click", function () {
      fileInput.click();
    });

    fileInput.addEventListener("change", function () {
      var files = fileInput.files;
      if (!files || !files.length) return;
      var pending = files.length;

      for (var i = 0; i < files.length; i++) {
        (function (file) {
          var reader = new FileReader();
          reader.onload = function () {
            HPStore.addMarkerStill(markerKey, reader.result);
            pending--;
            if (pending === 0) renderStills(thumbs, markerKey);
          };
          reader.onerror = function () {
            pending--;
            if (pending === 0) renderStills(thumbs, markerKey);
          };
          reader.readAsDataURL(file);
        })(files[i]);
      }
      fileInput.value = "";
    });

    wrap.appendChild(captureBtn);
    wrap.appendChild(addBtn);
    wrap.appendChild(fileInput);
    wrap.appendChild(stillStatus);
    wrap.appendChild(thumbs);
    renderStills(thumbs, markerKey);
    return wrap;
  }

  // Captura el frame actual del monitor de programa (host.jsx exportFramePNG),
  // lo lee con Node (engine.readStill) y lo agrega como still del marcador.
  function captureProgramStill(markerKey, thumbs, btn, statusEl) {
    var tmpPath = "/tmp/hp-still-" + (new Date().getTime()) + ".png";
    var arg = JSON.stringify(tmpPath);
    var prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Capturando…";
    if (statusEl) { statusEl.textContent = ""; statusEl.className = "still-status"; }

    function fail(msg) {
      if (statusEl) { statusEl.textContent = msg; statusEl.className = "still-status is-error"; }
      btn.textContent = prev;
      btn.disabled = false;
    }

    csInterface.evalScript("hp_captureProgramFrame(" + arg + ")", function (result) {
      if (!result || result.indexOf("ok|") !== 0) {
        fail("No se pudo capturar: " + (result || "sin secuencia/monitor"));
        return;
      }
      var realPath = result.substring(3); // "ok|<ruta real>"
      hpCall("readStill", realPath)
        .then(function (res) {
          if (res && res.ok && res.dataUrl) {
            HPStore.addMarkerStill(markerKey, res.dataUrl);
            renderStills(thumbs, markerKey);
            if (statusEl) statusEl.textContent = "";
            btn.textContent = prev;
            btn.disabled = false;
          } else {
            fail("No se pudo leer el frame: " + ((res && res.error) || ""));
          }
        })
        .catch(function (e) { fail((e && e.message) || "error leyendo el frame"); });
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

  // Genera el recurso de un marcador.
  // mode: "generate" (1ra vez, desde cero) | "adjust" (refina sobre lo previo,
  // usando la instrucción de arriba) | "regen" (desde cero, solo prompt+stills).
  function runGenerationForMarker(marker, statusEl, buttons, mode, onSuccess) {
    var markerKey = markerKeyFor(marker);
    var data = HPStore.getMarkerData(markerKey);
    var segments = HPStore.getTranscript() || [];
    var markerTranscript = HPTranscript.sliceByRange(
      segments, marker.start, marker.start + marker.duration
    );

    var payload = {
      projectPath: currentProjectPath,
      sequenceName: currentSequenceName,
      objective: HPStore.getObjective(),
      transcript: segments,
      marker: {
        name: marker.name || markerKey,
        start: marker.start,
        end: marker.start + marker.duration,
        duration: marker.duration
      },
      markerTranscript: markerTranscript,
      instruction: data.instruction || "",
      stills: data.stills || [],
      markerSlug: markerKey,
      mode: mode
    };

    // "adjust" = refinar: la instrucción de arriba es el pedido; el motor lee
    // el HTML de la última versión del disco como referencia.
    if (mode === "adjust") payload.adjustment = data.instruction || "";

    var method = mode === "generate" ? "generate" : "feedback";

    setButtonsDisabled(buttons, true);

    // Barra de progreso con frase descriptiva por etapa.
    statusEl.textContent = "";
    statusEl.className = "marker-status is-busy";
    var bar = document.createElement("div"); bar.className = "hp-bar";
    var fill = document.createElement("div"); fill.className = "hp-bar-fill"; bar.appendChild(fill);
    var msgEl = document.createElement("div"); msgEl.className = "hp-bar-msg";
    statusEl.appendChild(bar); statusEl.appendChild(msgEl);
    function onProgress(p) {
      if (!p) return;
      if (typeof p.pct === "number") fill.style.width = Math.max(0, Math.min(100, p.pct)) + "%";
      if (p.msg) msgEl.textContent = p.msg;
    }
    onProgress({ pct: 3, msg: "Preparando…" });

    var call;
    if (HP_ENGINE && typeof HP_ENGINE[method] === "function") {
      try { call = Promise.resolve(HP_ENGINE[method](payload, onProgress)); }
      catch (e) { call = Promise.reject(e); }
    } else {
      call = Promise.reject(new Error("Motor no disponible. Cerrá y reabrí Premiere."));
    }

    call
      .then(function (res) {
        if (!res || !res.ok) throw new Error(res && res.error ? res.error : "error desconocido");
        onProgress({ pct: 98, msg: "Colocando en el timeline…" });
        var movArg = JSON.stringify(res.movPath);
        csInterface.evalScript(
          "hp_placeClip(" + movArg + ", " + marker.start + ", " + marker.duration + ")",
          function (place) {
            if (place === "ok") {
              statusEl.textContent = "✓ Listo y colocado (v" + res.version + ")";
              statusEl.className = "marker-status is-ok";
            } else {
              statusEl.textContent = "Render OK, pero no se pudo colocar: " + place;
              statusEl.className = "marker-status is-error";
            }
            HPStore.setMarkerGenerated(markerKey, true);
            setButtonsDisabled(buttons, false);
            if (onSuccess) onSuccess();
          }
        );
      })
      .catch(function (err) {
        statusEl.textContent = "Error: " + (err && err.message ? err.message : String(err));
        statusEl.className = "marker-status is-error";
        setButtonsDisabled(buttons, false);
      });
  }

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
    instruction.value = HPStore.getMarkerData(markerKey).instruction;
    instruction.addEventListener("input", debounce(function () {
      HPStore.setMarkerInstruction(markerKey, instruction.value);
    }, DEBOUNCE_MS));
    body.appendChild(instruction);

    body.appendChild(createStillsControl(markerKey));

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
    var status = document.createElement("div");
    status.className = "marker-status";
    var buttons = [genBtn, regenBtn];

    // Refleja el estado: sin generar → solo "Generar"; ya generado → "Generar"
    // (refina) + "Regenerar desde cero", y badge ✓.
    function syncUI() {
      var generated = HPStore.getMarkerData(markerKey).generated;
      genBtn.textContent = generated ? "Generar (refinar)" : "Generar";
      regenBtn.style.display = generated ? "" : "none";
      sBadge.textContent = generated ? "✓" : "";
    }

    genBtn.addEventListener("click", function () {
      var mode = HPStore.getMarkerData(markerKey).generated ? "adjust" : "generate";
      runGenerationForMarker(marker, status, buttons, mode, syncUI);
    });
    regenBtn.addEventListener("click", function () {
      runGenerationForMarker(marker, status, buttons, "regen", syncUI);
    });

    actions.appendChild(genBtn);
    actions.appendChild(regenBtn);
    body.appendChild(actions);
    body.appendChild(status);
    card.appendChild(body);

    syncUI();
    return card;
  }

  function renderMarkers(markers) {
    markersContainer.innerHTML = "";

    if (markers.length === 0) {
      setOutput("La secuencia activa no tiene marcadores.", false);
      return;
    }

    for (var i = 0; i < markers.length; i++) {
      markersContainer.appendChild(createMarkerCard(markers[i]));
    }
    setOutput("Marcadores cargados: " + markers.length, false);
  }

  function onLoadMarkers() {
    setOutput("Cargando marcadores…", false);

    // Refrescar el contexto antes de renderizar: si el usuario cambió de
    // proyecto o secuencia, las tarjetas deben rehidratarse del namespace nuevo.
    loadContext(function () {
      hydrateObjective();
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

  var cfgProvider = document.getElementById("cfg-provider");
  var cfgModel = document.getElementById("cfg-model");
  var cfgApiKey = document.getElementById("cfg-apikey");
  var cfgBaseUrl = document.getElementById("cfg-baseurl");
  var btnSaveConfig = document.getElementById("btn-save-config");
  var configStatus = document.getElementById("config-status");

  function loadConfig() {
    hpCall("getConfig")
      .then(function (cfg) {
        if (!cfg) return;
        if (cfg.provider) cfgProvider.value = cfg.provider;
        var m = cfg.model || "claude-sonnet-5";
        cfgModel.value = m;
        // Si el modelo guardado no está entre las opciones, lo agrego para que
        // el editor siempre vea CUÁL tiene seleccionado.
        if (cfgModel.value !== m) {
          var opt = document.createElement("option");
          opt.value = m; opt.textContent = m + " (personalizado)";
          cfgModel.appendChild(opt);
          cfgModel.value = m;
        }
        if (cfg.baseUrl) cfgBaseUrl.value = cfg.baseUrl;
        if (cfg.apiKey) cfgApiKey.setAttribute("placeholder", "•••• (guardada)");
        if (cfg.hasSession && loginStatus) loginStatus.textContent = "✓ Sesión de Claude activa";
      })
      .catch(function (e) {
        if (configStatus) configStatus.textContent = (e && e.message) || "Motor no disponible";
      });
  }

  function saveConfig() {
    var body = {
      provider: cfgProvider.value,
      model: cfgModel.value.trim()
    };
    if (cfgApiKey.value.trim()) body.apiKey = cfgApiKey.value.trim();
    if (cfgBaseUrl.value.trim()) body.baseUrl = cfgBaseUrl.value.trim();

    configStatus.textContent = "Guardando…";
    hpCall("setConfig", body)
      .then(function () {
        configStatus.textContent = "✓ Guardado";
        cfgApiKey.value = "";
      })
      .catch(function (e) {
        configStatus.textContent = "Error al guardar: " + ((e && e.message) || "");
      });
  }

  if (btnSaveConfig) btnSaveConfig.addEventListener("click", saveConfig);

  // Actualización: muestra la versión y, al tocar, hace git pull y recarga.
  var btnUpdate = document.getElementById("btn-update");
  var versionLabel = document.getElementById("version-label");
  hpCall("getVersion").then(function (v) {
    if (versionLabel && v) versionLabel.textContent = "v" + v;
  }).catch(function () {});
  if (btnUpdate) {
    btnUpdate.addEventListener("click", function () {
      btnUpdate.disabled = true;
      var icon = btnUpdate.querySelector(".update-icon");
      if (icon) icon.classList.add("spinning");
      hpCall("selfUpdate")
        .then(function (res) {
          if (res && res.ok) {
            if (versionLabel) versionLabel.textContent = "v" + res.version;
            if (res.changed) {
              btnUpdate.title = "Actualizado a v" + res.version + " — recargando…";
              setTimeout(function () { window.location.reload(); }, 700);
            } else {
              btnUpdate.title = "Ya estás en la última (v" + res.version + ")";
              if (icon) icon.classList.remove("spinning");
              btnUpdate.disabled = false;
            }
          } else {
            throw new Error((res && res.error) || "error");
          }
        })
        .catch(function (e) {
          btnUpdate.title = "Error al actualizar: " + ((e && e.message) || "");
          if (icon) icon.classList.remove("spinning");
          btnUpdate.disabled = false;
        });
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
            loginStatus.textContent = "✓ Sesión de Claude lista";
            cfgProvider.value = "claude-cli";
          } else {
            loginStatus.textContent = "Error: " + ((data && data.error) || "desconocido");
          }
        })
        .catch(function (e) {
          loginStatus.textContent = "Error: " + ((e && e.message) || "login falló");
        })
        .then(function () { btnLoginClaude.disabled = false; });
    });
  }

  btnTestConnection.addEventListener("click", onTestConnection);
  btnLoadMarkers.addEventListener("click", onLoadMarkers);
  loadConfig();

  // Arranque: fijar contexto y rehidratar objetivo + estado del transcript.
  loadContext(function () {
    hydrateObjective();
    updateTranscriptStatus();
  });
})();
