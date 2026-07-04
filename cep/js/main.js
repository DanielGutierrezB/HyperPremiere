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
      resources: data.resources || [],
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

    // Cronómetro de la generación: cuenta el tiempo transcurrido en vivo.
    var startedAt = Date.now();
    function elapsedSec() { return (Date.now() - startedAt) / 1000; }
    var tick = setInterval(function () {
      msgEl.setAttribute("data-elapsed", fmtDuration(elapsedSec()));
      var base = (msgEl.textContent || "").replace(/\s*·\s*\d+m?\s*\d*s?$/, "");
      msgEl.textContent = base + " · " + fmtDuration(elapsedSec());
    }, 1000);
    function stopTimer() { if (tick) { clearInterval(tick); tick = null; } }

    var call;
    if (HP_ENGINE && typeof HP_ENGINE[method] === "function") {
      try { call = Promise.resolve(HP_ENGINE[method](payload, onProgress)); }
      catch (e) { call = Promise.reject(e); }
    } else {
      call = Promise.reject(new Error("Motor no disponible. Cerrá y reabrí Premiere."));
    }

    return call
      .then(function (res) {
        if (!res || !res.ok) throw new Error(res && res.error ? res.error : "error desconocido");
        stopTimer();
        // Contabilizar tokens de esta generación en el acumulado de la sesión.
        var usg = res.usage || null;
        if (usg) { HPStore.addSessionUsage(usg); updateSessionUsageBar(); }
        var tokTxt = usg
          ? " · " + addThousands(usg.inputTokens) + " tokens de entrada, " + addThousands(usg.outputTokens) + " de salida"
          : "";
        var durTxt = " · tardó " + fmtDuration(elapsedSec());
        onProgress({ pct: 98, msg: "Colocando en el timeline…" });
        return new Promise(function (resolvePlace) {
          var movArg = JSON.stringify(res.movPath);
          csInterface.evalScript(
            "hp_placeClip(" + movArg + ", " + marker.start + ", " + marker.duration + ")",
            function (place) {
              if (place === "ok") {
                statusEl.textContent = "✓ Listo y colocado (versión " + res.version + ")" + tokTxt + durTxt;
                statusEl.className = "marker-status is-ok";
              } else {
                statusEl.textContent = "Render OK, pero no se pudo colocar: " + place;
                statusEl.className = "marker-status is-error";
              }
              HPStore.setMarkerGenerated(markerKey, true);
              setButtonsDisabled(buttons, false);
              if (onSuccess) onSuccess();
              resolvePlace();
            }
          );
        });
      })
      .catch(function (err) {
        stopTimer();
        statusEl.textContent = "Error: " + (err && err.message ? err.message : String(err)) + " · tras " + fmtDuration(elapsedSec());
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

    function doGenerate() {
      var mode = HPStore.getMarkerData(markerKey).generated ? "adjust" : "generate";
      return runGenerationForMarker(marker, status, buttons, mode, syncUI);
    }
    genBtn.addEventListener("click", doGenerate);
    regenBtn.addEventListener("click", function () {
      runGenerationForMarker(marker, status, buttons, "regen", syncUI);
    });

    // Para el botón global "Generar listos".
    card._runGen = doGenerate;
    card._isReady = function () {
      return !!(HPStore.getMarkerData(markerKey).instruction || "").trim();
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
    body.appendChild(actions);
    body.appendChild(estimate);
    body.appendChild(status);
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
      return;
    }

    for (var i = 0; i < markers.length; i++) {
      markersContainer.appendChild(createMarkerCard(markers[i]));
    }
    var seqTxt = currentSequenceName ? "Secuencia: " + currentSequenceName + "\n" : "";
    setOutput(seqTxt + "Marcadores cargados: " + markers.length + " · estado guardado ✓", false);
    // Flujo progresivo: al tener marcadores, colapsar contexto para dar aire.
    var ctx = document.getElementById("context-section");
    if (ctx && objectiveInput && objectiveInput.value.trim()) ctx.open = false;
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

  // Rellena el <select> de modelos según el proveedor y marca el activo.
  function populateModels(provider, selected) {
    var list = MODELS[provider] || CLAUDE_MODELS;
    cfgModel.innerHTML = "";
    var matched = false;
    for (var i = 0; i < list.length; i++) {
      var opt = document.createElement("option");
      opt.value = list[i].v; opt.textContent = list[i].t;
      cfgModel.appendChild(opt);
      if (list[i].v === selected) matched = true;
    }
    if (selected && !matched && provider !== "claude-cli" && provider !== "claude-api") {
      // ID personalizado que no está en la lista → seleccionar "Otro" y precargar.
      cfgModel.value = "__custom__";
      if (cfgModelCustom) cfgModelCustom.value = selected;
    } else if (matched) {
      cfgModel.value = selected;
    } else {
      cfgModel.value = list[0].v;
    }
  }

  // Modelo efectivo: el del <select>, o el texto libre si eligió "Otro".
  function effectiveModel() {
    if (cfgModel.value === "__custom__") return (cfgModelCustom.value || "").trim();
    return cfgModel.value;
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
    var p = cfgProvider.value;
    showRow("row-login", p === "claude-cli");
    showRow("row-apikey", p === "claude-api" || p === "openai-compat");
    showRow("row-baseurl", p === "openai-compat" || p === "ollama");
    showRow("row-model-custom", cfgModel.value === "__custom__");
    var hintEl = document.getElementById("baseurl-hint");
    if (hintEl) hintEl.textContent = BASEURL_HINT[p] || "";
  }

  // Semáforo del resumen: verde si el proveedor está listo, aviso si falta algo.
  function updateSummary() {
    if (!cfgSummary) return;
    var p = cfgProvider.value;
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
    var body = { provider: cfgProvider.value, model: effectiveModel() };
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
          var list = r.models.map(function (m) { return { v: m, t: m }; });
          list.push({ v: "__custom__", t: "Otro (escribir ID)…" });
          MODELS["ollama"] = list;
          if (cfgProvider.value === "ollama") { populateModels("ollama", selected || effectiveModel()); applyProviderUI(); updateSummary(); }
        }
      })
      .catch(function () {});
  }

  // Vuelca una config (del motor) a los controles del panel.
  function applyConfigToUI(cfg) {
    if (!cfg) return;
    if (cfg.provider) cfgProvider.value = cfg.provider;
    currentHasSession = Boolean(cfg.hasSession);
    cfgBaseUrl.value = cfg.baseUrl || "";
    cfgApiKey.value = "";
    if (cfg.apiKey) { cfgApiKey.setAttribute("data-has", "1"); cfgApiKey.setAttribute("placeholder", "•••• (guardada)"); }
    else { cfgApiKey.removeAttribute("data-has"); cfgApiKey.setAttribute("placeholder", "Pegá tu API key"); }
    if (cfg.hasSession && loginStatus) loginStatus.textContent = "✓ Sesión de Claude activa";
    populateModels(cfgProvider.value, cfg.model || defaultModelFor(cfgProvider.value));
    applyProviderUI();
    updateSummary();
    if (cfgProvider.value === "ollama") refreshOllamaModels(cfg.model);
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

  // Cambiar de proveedor: guarda el proveedor activo y RESTAURA las credenciales
  // guardadas de ese proveedor (no se pierden al saltar entre modelos).
  cfgProvider.addEventListener("change", function () {
    configStatus.textContent = "Cambiando…";
    hpCall("setConfig", { provider: cfgProvider.value })
      .then(function (cfg) { applyConfigToUI(cfg); configStatus.textContent = "✓ Guardado"; })
      .catch(function (e) { configStatus.textContent = "Error: " + ((e && e.message) || ""); });
  });
  cfgModel.addEventListener("change", function () {
    applyProviderUI();
    autoSave();
  });
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
            currentHasSession = true;
            populateModels(cfgProvider.value, effectiveModel());
            applyProviderUI();
            autoSave();
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

  btnLoadMarkers.addEventListener("click", onLoadMarkers);

  // Generar todos los marcadores listos (con instrucción), en secuencia.
  var btnGenerateAll = document.getElementById("btn-generate-all");
  var batchStatus = document.getElementById("batch-status");
  function generateAllReady() {
    var cards = markersContainer.querySelectorAll("details.marker-card");
    var ready = [];
    for (var i = 0; i < cards.length; i++) {
      if (cards[i]._isReady && cards[i]._isReady()) ready.push(cards[i]);
    }
    if (!ready.length) {
      if (batchStatus) batchStatus.textContent = "No hay marcadores listos (poné una instrucción en al menos uno).";
      return;
    }
    btnGenerateAll.disabled = true;
    function step(i) {
      if (i >= ready.length) {
        btnGenerateAll.disabled = false;
        if (batchStatus) batchStatus.textContent = "✓ Generados " + ready.length + " marcador(es).";
        return;
      }
      if (batchStatus) batchStatus.textContent = "Generando " + (i + 1) + " de " + ready.length + "…";
      var c = ready[i];
      c.open = true; // abrir para ver su barra de progreso
      Promise.resolve(c._runGen()).then(function () { step(i + 1); });
    }
    step(0);
  }
  if (btnGenerateAll) btnGenerateAll.addEventListener("click", generateAllReady);

  loadConfig();

  // Arranque: fijar contexto y rehidratar objetivo + estado del transcript.
  loadContext(function () {
    hydrateObjective();
    updateTranscriptStatus();
  });
})();
