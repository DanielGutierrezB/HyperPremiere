/**
 * main.js — orquestador del panel HyperPremiere.
 *
 * Acá vive lo que es genuinamente de esta pantalla: contexto (proyecto +
 * secuencia), objetivo/transcript/prompt general, las TARJETAS de marcador
 * (instrucción, imágenes, editor de HTML) y el wiring de header/pestañas.
 *
 * El resto está en módulos propios (cargados antes por index.html):
 *   HPUtil (js/util.js)              helpers puros
 *   HPLog (js/log.js)                log de diagnóstico + descarga
 *   HPEngine (js/engine-client.js)   carga y llamadas al motor Node
 *   HPStore (js/store.js)            persistencia por proyecto+secuencia
 *   HPTranscript (js/transcript.js)  parser del transcript
 *   HPWidgets (js/widgets.js)        select propio, editor de código, tooltips
 *   HPQueue (js/queue.js)            cola de generación/render (estado)
 *   HPQueueView (js/queue-view.js)   pestaña Cola (vista)
 *   HPConfigUI (js/config-ui.js)     configuración del proveedor/modelo
 */
(function () {
  "use strict";

  var DEBOUNCE_MS = 300;

  var hpLog = HPLog.log;
  var hpCall = HPEngine.call;
  var debounce = HPUtil.debounce;
  var formatTime = HPUtil.formatTime;

  // Clave del "Prompt general" (instrucción + stills + recursos que aplican a
  // TODOS los marcadores). Ver HPStore.GENERAL_KEY.
  var GEN_KEY = HPStore.GENERAL_KEY;
  var focusMarkerAfterRender = null; // markerKey a enfocar tras renderizar (desde "Ver")
  var focusOpenEditor = false;       // además abrir el editor HTML de esa tarjeta

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

  // ---------------------------------------------------------------------
  // Contexto (proyecto + secuencia) para HPStore
  // ---------------------------------------------------------------------

  var currentProjectPath = "";
  var currentSequenceName = "";
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

  // ── Cableado de los módulos (cola, vista de cola) ────────────────────
  HPQueue.init({
    getContext: function () { return { projectPath: currentProjectPath, sequenceName: currentSequenceName }; },
    isLocalProvider: function () { return HPConfigUI.isLocalProvider(); },
    modelName: function () { return HPConfigUI.modelName(); },
    onUsage: function (usage) { HPStore.addSessionUsage(usage); updateSessionUsageBar(); },
    placeClip: function (movPath, seqName, startSec, durationSec, colorLabel, cb) {
      csInterface.evalScript(
        "hp_placeClipInSequence(" + JSON.stringify(movPath) + ", " + JSON.stringify(seqName) + ", " +
        startSec + ", " + durationSec + ", " + colorLabel + ")", cb);
    },
    recolorClip: function (seqName, startSec, colorLabel, cb) {
      csInterface.evalScript(
        "hp_recolorClipAt(" + JSON.stringify(seqName) + ", " + startSec + ", " + colorLabel + ")", cb);
    }
  });
  HPQueueView.init({
    getContext: function () { return { projectPath: currentProjectPath, sequenceName: currentSequenceName }; },
    goToJobMarker: function (job, openEditor) { goToJobMarker(job, openEditor); },
    createStillsControl: function (markerKey, fbJobId) { return createStillsControl(markerKey, fbJobId); },
    cleanOldVersions: function () { cleanOldVersionsFromQueue(); },
    setOutput: setOutput
  });
  HPQueue.on(function () { HPQueueView.render(HPQueue.jobs()); reflectQueueOnCards(); });

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

  // Deriva el objetivo de la clase llamando al motor (deriveObjective).
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
        // Silencioso: el editor puede escribir el objetivo a mano si el motor no está.
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

  // Nombre/ID consecutivo por orden del marcador: "Marcador 1", "Marcador 2"…
  // Es la nomenclatura que ve el editor Y la que usan los archivos generados.
  function markerKeyFor(marker) {
    return "Marcador " + (marker.index + 1);
  }

  // Fuente para el <img> del thumbnail: data URL tal cual, o ruta de archivo
  // (captura guardada en disco) servida por file:// (encodeURI para espacios).
  function stillThumbSrc(s) {
    s = String(s || "");
    if (/^data:/i.test(s) || /^file:\/\//i.test(s)) return s;
    return "file://" + encodeURI(s);
  }

  // ¿El texto de un refinamiento se refiere a las imágenes adjuntas? Si NO las
  // menciona, en un feedback podemos NO reenviarlas como visión (ahorro grande de
  // tokens: las imágenes son lo más caro). Las imágenes marcadas "✓ usar" igual se
  // incrustan en el gráfico por archivo, así que el logo/ícono sigue apareciendo.
  var IMG_REF_RE = /(im[aá]genes?|logo|isotipo|logotipo|[íi]conos?|\bmarca\b|foto|captura|referenci|ilustraci)/i;
  function feedbackNeedsImages(text) { return IMG_REF_RE.test(String(text || "")); }

  function renderStills(container, markerKey, fbJobId) {
    container.innerHTML = "";
    var data = HPStore.getMarkerData(markerKey);
    var stills = data.stills, uses = data.stillUse || [];

    for (var i = 0; i < stills.length; i++) {
      (function (index) {
        var thumb = document.createElement("div");
        thumb.className = "still-thumb";

        var img = document.createElement("img");
        img.src = stillThumbSrc(stills[index]);

        // Número de la imagen (1,2,3…) para poder referenciarla en la instrucción:
        // "imagen 1 hacé X, imagen 2 revisá Y". El orden coincide con lo que ve el modelo.
        var num = document.createElement("span");
        num.className = "still-num"; num.textContent = (index + 1);
        num.title = "Imagen " + (index + 1) + " — referila así en la instrucción (ej: \"imagen " + (index + 1) + "…\")";

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
        thumb.appendChild(num);
        thumb.appendChild(remove);
        thumb.appendChild(tag);

        // Modo feedback: toggle "reenviar esta imagen al modelo". Por defecto las
        // imágenes YA existentes salen apagadas (gris) → no se reenvían (ahorro de
        // tokens); las NUEVAS agregadas en este feedback entran activas. No afecta el
        // incrustado: una imagen "✓ usar" se mete en el gráfico igual, se reenvíe o no.
        // (La selección por job vive en HPQueueView: fbSend/fbToggle.)
        if (fbJobId) {
          var on = HPQueueView.fbSend(fbJobId, index);
          thumb.classList.add("fb");
          if (!on) thumb.classList.add("fb-off");
          var send = document.createElement("button");
          send.type = "button";
          send.className = "still-send" + (on ? " is-on" : "");
          send.textContent = on ? "📤 reenviar" : "no se envía";
          send.title = on
            ? "Se reenvía al modelo en este feedback (usa tokens). Clic para no enviarla."
            : "No se reenvía (ahorra tokens). Clic si querés que el modelo la VEA en este ajuste.";
          var toggle = function (e) {
            e.stopPropagation();
            HPQueueView.fbToggle(fbJobId, index);
            renderStills(container, markerKey, fbJobId);
          };
          send.addEventListener("click", toggle);
          img.style.cursor = "pointer";
          img.addEventListener("click", toggle);
          thumb.appendChild(send);
        }

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
  function ingestFiles(files, markerKey, thumbs, resList, statusEl, fbJobId) {
    if (!files || !files.length) return;
    var pending = files.length;
    function done() {
      pending--;
      if (pending === 0) { renderStills(thumbs, markerKey, fbJobId); renderResources(resList, markerKey); }
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

  function createStillsControl(markerKey, fbJobId) {
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
      captureProgramStill(markerKey, thumbs, captureBtn, stillStatus, fbJobId);
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
      ingestFiles(files, markerKey, thumbs, resList, stillStatus, fbJobId);
    });

    fileInput.addEventListener("change", function () {
      ingestFiles(fileInput.files, markerKey, thumbs, resList, stillStatus, fbJobId);
      fileInput.value = "";
    });

    wrap.appendChild(captureBtn);
    wrap.appendChild(drop);
    wrap.appendChild(fileInput);
    wrap.appendChild(stillStatus);
    wrap.appendChild(thumbs);
    wrap.appendChild(resList);
    renderStills(thumbs, markerKey, fbJobId);
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
  function captureProgramStill(markerKey, thumbs, btn, statusEl, fbJobId) {
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
          // Refrescar el contenedor LOCAL (el que inició la captura, ej. la caja de
          // feedback) SIEMPRE, y además la tarjeta si está visible.
          if (thumbs) renderStills(thumbs, markerKey, fbJobId);
          refreshStills(markerKey);
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
      assets: HPStore.getMarkerAssets(markerKey).concat(HPStore.getMarkerAssets(GEN_KEY)),
      resources: (data.resources || []).concat(gen.resources || []),
      background: !!data.background, draft: draftMode,
      markerSlug: markerKey, mode: mode
    };
    if (mode === "adjust") {
      payload.adjustment = data.instruction || "";
      // Auto (sin UI por-imagen en la tarjeta): si la instrucción menciona imágenes,
      // reenvía TODAS las del marcador; si no, ninguna (ahorro de tokens).
      payload.stillsSend = feedbackNeedsImages(payload.adjustment)
        ? (data.stills || []).map(function (_s, ix) { return ix; })
        : [];
    }
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

  // "Ver" (clic en el nombre del clip): abre la secuencia + salta al marcador en
  // Premiere, y en el panel carga los marcadores de esa secuencia, va a la pestaña
  // Marcadores y enfoca/despliega la tarjeta de ese marcador.
  function goToJobMarker(job, openEditor) {
    if (!job) return;
    var seqArg = JSON.stringify(job.seqName);
    csInterface.evalScript(
      "hp_openSequenceAndSeek(" + seqArg + ", " + Number(job.markerStart) + ")",
      function () {
        focusMarkerAfterRender = job.markerKey; // renderMarkers lo enfoca al terminar
        focusOpenEditor = !!openEditor;         // y abre su editor HTML si se pidió
        selectTab("markers");
        onLoadMarkers(); // relee la secuencia (ya activa) y renderiza sus marcadores
      }
    );
  }

  // ── Limpieza de versiones viejas (desde la pestaña Cola) ─────────────

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
      // Paso 2: sacarlos de secuencia + proyecto ANTES de borrar (evita re-vincular).
      // Los nombres viajan unidos por "\n" (ExtendScript no trae JSON.parse).
      csInterface.evalScript("hp_purgeClipsByName(" + JSON.stringify(names.join("\n")) + ")", function (purge) {
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
      HPWidgets.confirmOverlay("Limpiar versiones viejas", function (body) {
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
      // Cada emit reconstruye el status; paramos el reloj anterior para no dejar timers colgados.
      if (card._clockTimer) { clearInterval(card._clockTimer); card._clockTimer = null; }
      var active = job.status === "queued" || job.status === "modeling" || job.status === "ready" || job.status === "running";
      if (active) {
        setButtonsDisabled(buttons, true);
        status.className = "marker-status is-busy";
        status.textContent = "";
        var bar = document.createElement("div"); bar.className = "hp-bar";
        var fill = document.createElement("div"); fill.className = "hp-bar-fill";
        fill.style.width = (job.pct || 0) + "%"; bar.appendChild(fill);
        var m = document.createElement("div"); m.className = "hp-bar-msg";
        var msgTxt = document.createElement("span"); msgTxt.textContent = job.msg || "";
        var clk = document.createElement("span"); clk.className = "hp-bar-clock";
        m.appendChild(msgTxt); m.appendChild(clk);
        status.appendChild(bar); status.appendChild(m);
        sBadge.textContent = (job.status === "running" || job.status === "modeling") ? "⏳" : "…";
        // Reloj en vivo: tiempo transcurrido junto a la barra + mensaje.
        card._activeJob = job;
        var tickClock = function () {
          var j = card._activeJob; if (!j) return;
          clk.textContent = j.startedAt ? " · ⏱ " + HPUtil.fmtDuration((Date.now() - j.startedAt) / 1000) : "";
        };
        tickClock();
        card._clockTimer = setInterval(tickClock, 1000);
      } else if (job.status === "done") {
        card._activeJob = null;
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
      if (card._clockTimer) { clearInterval(card._clockTimer); card._clockTimer = null; }
      card._activeJob = null;
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
            estimate.textContent = "≈ " + HPUtil.fmtTokens(r.inputTokensEst) + " tokens de entrada" + (extra.length ? " (" + extra.join(", ") + ")" : "");
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

    var codeEd = HPWidgets.makeCodeEditor();

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

    var verSel = HPWidgets.select(verMount);

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
    // Enfoque pedido desde "Ver" (clic en el nombre del clip en la Cola).
    if (focusMarkerAfterRender) { focusMarkerCard(focusMarkerAfterRender); focusMarkerAfterRender = null; focusOpenEditor = false; }
  }

  // Despliega, resalta y hace scroll a la tarjeta del marcador `markerKey`.
  function focusMarkerCard(markerKey) {
    if (!markersContainer) return;
    var cards = markersContainer.querySelectorAll("details.marker-card");
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (c._markerKey !== markerKey) continue;
      try { c.open = true; } catch (e) {}
      // Abrir el editor de HTML de la tarjeta si se llegó con "Editar HTML".
      if (focusOpenEditor) {
        var ed = c.querySelector("details.html-editor");
        if (ed) { try { ed.open = true; } catch (e) {} }
      }
      try { (focusOpenEditor && c.querySelector("details.html-editor") ? c.querySelector("details.html-editor") : c).scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) { c.scrollIntoView(); }
      c.classList.add("is-focused");
      (function (card) { setTimeout(function () { card.classList.remove("is-focused"); }, 2200); })(c);
      break;
    }
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

  btnLoadMarkers.addEventListener("click", onLoadMarkers);

  // ── Contador de uso de la sesión (tokens) ───────────────────────────
  var suValue = document.getElementById("su-value");
  var suReset = document.getElementById("su-reset");
  function updateSessionUsageBar() {
    if (!suValue) return;
    var u = HPStore.getSessionUsage();
    if (!u.generations) { suValue.textContent = "sin generaciones todavía"; return; }
    var txt = HPUtil.addThousands(u.inputTokens) + " tokens de entrada · " +
      HPUtil.addThousands(u.outputTokens) + " de salida";
    if (u.costUsd > 0) txt += " · $" + u.costUsd.toFixed(3);
    txt += " · " + u.generations + (u.generations === 1 ? " generación" : " generaciones");
    suValue.textContent = txt;
  }
  if (suReset) suReset.addEventListener("click", function () {
    HPStore.resetSessionUsage();
    updateSessionUsageBar();
  });
  updateSessionUsageBar();

  // ── Actualización (⟳): versión, aviso de update y recarga del panel ──
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

  // Recarga COMPLETA del panel (re-ejecuta los scripts → loadEngine,
  // reloadHostJsx, busteo de cache del bridge). Sirve tanto para traer código
  // nuevo como para reintentar la carga del motor si quedó caído. Varias vías
  // por si alguna no está disponible en esta versión de CEP.
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

  // ── Botones globales: generar/encolar todos los marcadores listos ────
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
      var res = HPLog.download({
        engineLoaded: HPEngine.isLoaded(),
        enginePath: HPEngine.path(),
        engineErr: HPEngine.error(),
        nodeRequire: HPEngine.nodeRequire()
      });
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

  HPConfigUI.init();
  HPWidgets.installTooltips();

  // Arranque: fijar contexto y rehidratar objetivo + estado del transcript.
  loadContext(function () {
    hydrateObjective();
    hydrateGeneral();
    updateTranscriptStatus();
  });

  // Si el motor no cargó, avisar de una (sin esperar a que corra la cola) con la
  // causa REAL, para no andar adivinando "Motor no disponible".
  if (!HPEngine.isLoaded()) {
    setHeaderStatus("motor no cargó", "error");
    setOutput(HPEngine.errMsg() + "\n\n(Tocá ⬇ en el header para descargar el log y mandámelo.)", true);
    hpLog("Panel listo — MOTOR NO CARGÓ.", "ERROR");
  } else {
    setHeaderStatus("motor OK", "ok");
    hpLog("Panel listo — motor OK desde " + HPEngine.path());
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
      HPEngine.callProg("prepareEngine", null, function (p) {
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
