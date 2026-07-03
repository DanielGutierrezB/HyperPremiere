(function () {
  "use strict";

  var DEBOUNCE_MS = 300;
  var BRIDGE_URL = "http://127.0.0.1:7867";

  var csInterface = new CSInterface();

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

  function markerKeyFor(marker) {
    var base = marker.name || "marcador-" + marker.index;
    return slug(base) + "@" + Math.round(marker.start);
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
    fetch(BRIDGE_URL + "/derive-objective", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: segments })
    })
      .then(function (r) { return r.json(); })
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

    var addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn-add-still";
    addBtn.textContent = "Añadir still";
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

    wrap.appendChild(addBtn);
    wrap.appendChild(fileInput);
    wrap.appendChild(thumbs);
    renderStills(thumbs, markerKey);
    return wrap;
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

  // Recuerda el htmlPath de la última generación por marcador (para ajustes).
  var htmlPathByMarker = {};

  // Lee un archivo local usando la API de CEP (para pasar el HTML previo).
  function readLocalFile(path) {
    try {
      if (window.cep && window.cep.fs && path) {
        var r = window.cep.fs.readFile(path);
        if (r && r.err === 0) return r.data;
      }
    } catch (e) {}
    return "";
  }

  // Genera / regenera / ajusta el recurso de un marcador.
  // mode: "generate" | "regen" | "adjust". adjustment: texto (solo adjust).
  function runGenerationForMarker(marker, statusEl, buttons, mode, adjustment) {
    var markerKey = markerKeyFor(marker);
    var data = HPStore.getMarkerData(markerKey);
    var segments = HPStore.getTranscript() || [];
    var markerTranscript = HPTranscript.sliceByRange(
      segments,
      marker.start,
      marker.start + marker.duration
    );

    var payload = {
      projectPath: currentProjectPath,
      sequenceName: currentSequenceName,
      objective: HPStore.getObjective(),
      transcript: segments,
      marker: {
        name: marker.name || "Marcador " + (marker.index + 1),
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

    if (mode === "adjust") {
      payload.adjustment = adjustment || "";
      payload.previousHtml = readLocalFile(htmlPathByMarker[markerKey]);
    }

    var endpoint = mode === "generate" ? "/generate" : "/feedback";
    var verb = mode === "regen" ? "Regenerando" : mode === "adjust" ? "Ajustando" : "Generando";

    setButtonsDisabled(buttons, true);
    statusEl.textContent = verb + "… (puede tardar)";
    statusEl.className = "marker-status is-busy";

    fetch(BRIDGE_URL + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || !res.ok) {
          throw new Error(res && res.error ? res.error : "error desconocido");
        }
        if (res.htmlPath) htmlPathByMarker[markerKey] = res.htmlPath;
        statusEl.textContent = "Colocando en el timeline…";
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
            setButtonsDisabled(buttons, false);
          }
        );
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : String(err);
        statusEl.textContent = "Error: " + msg + " · ¿está corriendo el puente?";
        statusEl.className = "marker-status is-error";
        setButtonsDisabled(buttons, false);
      });
  }

  function setButtonsDisabled(buttons, disabled) {
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = disabled;
  }

  function createMarkerCard(marker) {
    var markerKey = markerKeyFor(marker);

    var card = document.createElement("div");
    card.className = "marker-card";

    var header = document.createElement("div");
    header.className = "marker-header";

    var name = document.createElement("div");
    name.className = "marker-name";
    name.textContent = marker.name || "Marcador " + (marker.index + 1);

    var meta = document.createElement("div");
    meta.className = "marker-meta";
    meta.textContent = formatTime(marker.start) + " · " + marker.duration.toFixed(1) + " s";

    header.appendChild(name);
    header.appendChild(meta);
    // El seek vive solo en la cabecera: los controles de abajo no lo disparan.
    header.addEventListener("click", function () {
      onHeaderClick(card, marker);
    });
    card.appendChild(header);

    var instruction = document.createElement("textarea");
    instruction.className = "marker-instruction";
    instruction.placeholder = "¿Qué querés que haga la IA en este marcador?";
    instruction.value = HPStore.getMarkerData(markerKey).instruction;
    instruction.addEventListener(
      "input",
      debounce(function () {
        HPStore.setMarkerInstruction(markerKey, instruction.value);
      }, DEBOUNCE_MS)
    );
    card.appendChild(instruction);

    card.appendChild(createStillsControl(markerKey));

    var sliceEl = createTranscriptSlice(marker);
    if (sliceEl) card.appendChild(sliceEl);

    // Acciones: Generar / Regenerar / Ajustar (llaman al puente y colocan el .mov).
    var actions = document.createElement("div");
    actions.className = "marker-actions";

    var genBtn = document.createElement("button");
    genBtn.type = "button";
    genBtn.className = "btn-generate";
    genBtn.textContent = "Generar";

    var regenBtn = document.createElement("button");
    regenBtn.type = "button";
    regenBtn.className = "btn-secondary";
    regenBtn.textContent = "Regenerar";

    var adjustBtn = document.createElement("button");
    adjustBtn.type = "button";
    adjustBtn.className = "btn-secondary";
    adjustBtn.textContent = "Ajustar";

    var status = document.createElement("div");
    status.className = "marker-status";

    var buttons = [genBtn, regenBtn, adjustBtn];

    genBtn.addEventListener("click", function () {
      runGenerationForMarker(marker, status, buttons, "generate");
    });
    regenBtn.addEventListener("click", function () {
      runGenerationForMarker(marker, status, buttons, "regen");
    });
    adjustBtn.addEventListener("click", function () {
      var adjustment = window.prompt("¿Qué ajuste querés? (ej. 'más lento', 'que el título aparezca al final')");
      if (adjustment === null) return; // canceló
      runGenerationForMarker(marker, status, buttons, "adjust", adjustment);
    });

    actions.appendChild(genBtn);
    actions.appendChild(regenBtn);
    actions.appendChild(adjustBtn);
    card.appendChild(actions);
    card.appendChild(status);

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
    fetch(BRIDGE_URL + "/config")
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (!cfg) return;
        if (cfg.provider) cfgProvider.value = cfg.provider;
        if (cfg.model) cfgModel.value = cfg.model;
        if (cfg.baseUrl) cfgBaseUrl.value = cfg.baseUrl;
        // apiKey viene enmascarada: no la mostramos, dejamos placeholder.
        if (cfg.apiKey) cfgApiKey.setAttribute("placeholder", "•••• (guardada)");
      })
      .catch(function () {
        if (configStatus) configStatus.textContent = "Puente no disponible";
      });
  }

  function saveConfig() {
    var body = {
      provider: cfgProvider.value,
      model: cfgModel.value.trim()
    };
    // Solo mandar apiKey/baseUrl si el usuario escribió algo (no pisar con vacío).
    if (cfgApiKey.value.trim()) body.apiKey = cfgApiKey.value.trim();
    if (cfgBaseUrl.value.trim()) body.baseUrl = cfgBaseUrl.value.trim();

    configStatus.textContent = "Guardando…";
    fetch(BRIDGE_URL + "/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function () {
        configStatus.textContent = "✓ Guardado";
        cfgApiKey.value = "";
      })
      .catch(function () {
        configStatus.textContent = "Error al guardar (¿puente corriendo?)";
      });
  }

  if (btnSaveConfig) btnSaveConfig.addEventListener("click", saveConfig);

  // Iniciar sesión en Claude: el puente corre `claude setup-token`, abre el
  // navegador y guarda el token solo. No hay que pegar nada a mano.
  var btnLoginClaude = document.getElementById("btn-login-claude");
  var loginStatus = document.getElementById("login-status");
  if (btnLoginClaude) {
    btnLoginClaude.addEventListener("click", function () {
      btnLoginClaude.disabled = true;
      loginStatus.textContent = "Abrí el navegador y autorizá… (esperando)";
      fetch(BRIDGE_URL + "/login-claude", { method: "POST" })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.ok) {
            loginStatus.textContent = "✓ Sesión de Claude lista";
            cfgProvider.value = "claude-cli";
          } else {
            loginStatus.textContent = "Error: " + ((data && data.error) || "desconocido");
          }
        })
        .catch(function () {
          loginStatus.textContent = "Error de conexión con el puente";
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
