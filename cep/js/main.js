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
 *   HPHost (js/host-client.js)       llamadas a ExtendScript (host.jsx)
 *   HPStore (js/store.js)            persistencia por proyecto+secuencia
 *   HPTranscript (js/transcript.js)  parser del transcript
 *   HPWidgets (js/widgets.js)        select propio, editor de código, tooltips
 *   HPStills (js/stills.js)          control de imágenes/recursos por marcador
 *   HPQueue (js/queue.js)            cola de generación/render (estado)
 *   HPQueueView (js/queue-view.js)   pestaña Cola (vista + limpieza)
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
    HPHost.getProjectPath(function (projectPath) {
      HPHost.getActiveSequenceName(function (sequenceName) {
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

  // ── Cableado de las vistas ───────────────────────────────────────────
  HPStills.init({ onGeneralChanged: function () { updateGeneralSummary(); } });
  HPQueueView.init({
    goToJobMarker: function (job, openEditor) { goToJobMarker(job, openEditor); },
    setOutput: setOutput
  });
  // Cada evento de la cola refresca la vista de Cola, las tarjetas de la
  // secuencia actual y el contador de uso de la sesión.
  HPQueue.on(function () {
    HPQueueView.render(HPQueue.jobs());
    reflectQueueOnCards();
    updateSessionUsageBar();
  });

  // ---------------------------------------------------------------------
  // Objetivo
  // ---------------------------------------------------------------------

  function hydrateObjective() {
    if (!objectiveInput) return;
    objectiveInput.value = HPStore.getObjective();
    updateContextSummary();
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
      generalMount.appendChild(HPStills.createControl(GEN_KEY));
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
        updateContextSummary();
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
    var hasTranscript = segments && segments.length > 0;
    updateOffsetRowVisibility(hasTranscript);
    if (hasTranscript) {
      transcriptStatus.textContent =
        segments.length + " segmentos · " + formatTime(transcriptDuration(segments)) + " total";
    } else {
      transcriptStatus.textContent = "";
    }
    updateContextSummary();
  }

  // Resumen del header de "Contexto de la clase" (visible cuando está colapsado):
  // muestra de un vistazo si hay objetivo y transcript.
  var contextSummary = document.getElementById("context-summary");
  function updateContextSummary() {
    if (!contextSummary) return;
    var segs = HPStore.getTranscript() || [];
    var hasObj = (HPStore.getObjective() || "").trim().length > 0;
    var parts = [];
    if (hasObj) parts.push("objetivo ✓");
    if (segs.length) parts.push(segs.length + " segmentos");
    if (parts.length) {
      contextSummary.textContent = parts.join(" · ");
      contextSummary.className = "section-state is-ok";
    } else {
      contextSummary.textContent = "sin objetivo ni transcript";
      contextSummary.className = "section-state";
    }
  }

  // ── Desfase transcript ↔ timeline ────────────────────────────────────
  // El transcript viene del video ORIGINAL; si el editor recortó el inicio o
  // corrió el clip en la secuencia, el texto de cada marcador queda corrido.
  // El desfase se guarda POR SECUENCIA y se aplica en todos los recortes
  // (fragmento de la tarjeta, estimado y prompt del modelo).
  var offsetRow = document.getElementById("offset-row");
  var offsetInput = document.getElementById("transcript-offset");
  var offsetStatus = document.getElementById("offset-status");
  var btnDetectOffset = document.getElementById("btn-detect-offset");
  // Desde que las unidades se calibran solas y el formato de Premiere se
  // parsea bien, el desfase manual quedó para UN caso: un transcript que NO
  // coincide con la secuencia (es de otro corte / del video original). La
  // fila se muestra SOLO entonces (o si ya hay un desfase distinto de 0).
  var offsetRowNeeded = false;
  function updateOffsetRowVisibility(hasTranscript) {
    if (!offsetRow) return;
    var show = !!hasTranscript && (offsetRowNeeded || HPStore.getTranscriptOffset() !== 0);
    offsetRow.setAttribute("data-hidden", show ? "false" : "true");
  }

  function hydrateOffset() {
    if (offsetInput) offsetInput.value = String(HPStore.getTranscriptOffset());
    if (offsetStatus) offsetStatus.textContent = "";
  }

  // Refresca en vivo los fragmentos de transcript de las tarjetas ya
  // renderizadas (para verificar el desfase o ver el transcript recién
  // generado sin recargar marcadores). Si la tarjeta se creó SIN transcript,
  // le agrega el bloque desplegable ahora.
  function refreshTranscriptSlices() {
    if (!markersContainer) return;
    var segments = HPStore.getTranscript() || [];
    var offset = HPStore.getTranscriptOffset();
    var cards = markersContainer.querySelectorAll("details.marker-card");
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (!c._marker) continue;
      var slice = HPTranscript.sliceForMarker(segments, c._marker.start, c._marker.start + c._marker.duration, offset);
      var texts = [];
      for (var k = 0; k < slice.length; k++) texts.push(slice[k].text);
      var sliceEl = c.querySelector(".transcript-slice");
      if (!sliceEl && texts.length) {
        // La tarjeta nació sin transcript (se generó/cargó después): armar el bloque.
        var tDetails = document.createElement("details");
        tDetails.className = "transcript-details";
        var tSum = document.createElement("summary");
        tSum.textContent = "Ver transcript del marcador";
        sliceEl = document.createElement("div");
        sliceEl.className = "transcript-slice";
        tDetails.appendChild(tSum);
        tDetails.appendChild(sliceEl);
        var actionsEl = c.querySelector(".marker-actions");
        if (actionsEl && actionsEl.parentNode) actionsEl.parentNode.insertBefore(tDetails, actionsEl);
        else continue;
      }
      if (!sliceEl) continue;
      sliceEl.textContent = texts.length ? texts.join(" ") : "(sin transcript en este rango — revisá el desfase)";
      if (c.open && c._updateEstimate) c._updateEstimate();
    }
  }

  function setOffset(value, sourceMsg) {
    var v = Number(value);
    if (!isFinite(v)) v = 0;
    HPStore.setTranscriptOffset(v);
    if (offsetInput && offsetInput.value !== String(v)) offsetInput.value = String(v);
    if (offsetStatus) {
      offsetStatus.textContent = (sourceMsg || "") +
        (v ? ((sourceMsg ? " · " : "") + "corrido " + (v > 0 ? "+" : "") + v + "s") : (sourceMsg ? "" : "sin desfase"));
    }
    updateOffsetRowVisibility((HPStore.getTranscript() || []).length > 0);
    refreshTranscriptSlices();
  }

  if (offsetInput) {
    offsetInput.addEventListener("input", debounce(function () {
      setOffset(offsetInput.value, "");
    }, DEBOUNCE_MS));
  }
  // Info del clip principal de la secuencia como objeto, o null (con log).
  function parsePrimaryClipInfo(res) {
    var info = null;
    try { info = JSON.parse(String(res || "")); } catch (e) {}
    if (!info || !info.ok) {
      hpLog("getPrimaryClipInfo falló: " + ((info && info.error) || res || "sin respuesta"), "WARN");
      return null;
    }
    return info;
  }

  if (btnDetectOffset) {
    btnDetectOffset.addEventListener("click", function () {
      if (offsetStatus) offsetStatus.textContent = "Detectando…";
      HPHost.getPrimaryClipInfo(function (res) {
        var info = parsePrimaryClipInfo(res);
        if (!info) {
          if (offsetStatus) offsetStatus.textContent = "No pude detectar: revisá que la secuencia tenga clips";
          return;
        }
        var secs = Math.round(Number(info.offset || 0) * 10) / 10;
        setOffset(secs, "del clip “" + (info.clipName || "?") + "”");
        hpLog("Desfase detectado del timeline: " + secs + "s (clip: " + info.clipName + ")");
      });
    });
  }

  // ── Transcribir la secuencia con Whisper LOCAL ───────────────────────
  // Transcribe el MEDIO original del clip principal (large-v3, idioma
  // automático — sirve para clases que mezclan español e inglés) y alinea
  // el resultado al timeline con el desfase del clip. Sin nube, sin tokens.
  var btnTranscribe = document.getElementById("btn-transcribe-seq");
  var transcribeProgress = document.getElementById("transcribe-progress");
  var transcribeFill = document.getElementById("transcribe-fill");
  var transcribing = false; // mientras corre, el botón se vuelve "Cancelar"
  function showTranscribeBar(show) {
    if (transcribeProgress) transcribeProgress.setAttribute("data-hidden", show ? "false" : "true");
    if (transcribeFill && show) transcribeFill.style.width = "0%";
  }
  if (btnTranscribe) {
    btnTranscribe.addEventListener("click", function () {
      // Segundo clic durante la corrida = CANCELAR (mata ffmpeg/whisper).
      if (transcribing) {
        hpLog("Usuario canceló la transcripción.");
        btnTranscribe.textContent = "✕ Cancelando…";
        hpCall("cancelTranscription").catch(function () {});
        return;
      }
      transcribing = true;
      var prevLabel = "🎙 Transcribir esta secuencia";
      btnTranscribe.textContent = "✕ Cancelar transcripción";
      btnTranscribe.title = "Cancela la transcripción en curso (mata el proceso de whisper)";
      function status(msg) { if (transcriptStatus) transcriptStatus.textContent = msg; }
      function done() {
        transcribing = false;
        btnTranscribe.disabled = false;
        btnTranscribe.textContent = prevLabel;
        showTranscribeBar(false);
      }
      showTranscribeBar(true);
      status("Buscando el clip principal de la secuencia…");
      hpLog("Transcripción local: pidiendo clip principal…");

      HPHost.getPrimaryClipInfo(function (res) {
        var info = parsePrimaryClipInfo(res);
        if (!info) { status("No pude leer la secuencia: ¿tiene clips?"); done(); return; }
        if (!info.mediaPath) { status("El clip “" + (info.clipName || "?") + "” no tiene ruta de medio (¿es un gráfico/sintético?)."); done(); return; }
        hpLog("Transcripción local: clip “" + info.clipName + "” → " + info.mediaPath + " (desfase " + info.offset + "s)");
        status("Transcribiendo “" + info.clipName + "”…");

        // El progreso también va al ⬇ Log (throttleado): si algo se cuelga,
        // el log muestra hasta dónde llegó — antes quedaba mudo tras el clip.
        var lastProgLog = 0;
        HPEngine.callProg("transcribeMedia", {
          mediaPath: info.mediaPath, projectPath: currentProjectPath, sequenceName: currentSequenceName
        }, function (p) {
          if (!p) return;
          if (p.msg) {
            status(p.msg);
            var now = Date.now();
            if (now - lastProgLog > 15000) { lastProgLog = now; hpLog("Transcripción: " + p.msg); }
          }
          if (typeof p.pct === "number" && transcribeFill) {
            transcribeFill.style.width = Math.max(0, Math.min(100, p.pct)) + "%";
          }
        }).then(function (r) {
          if (r && r.cancelled) {
            status("Transcripción cancelada.");
            hpLog("Transcripción local cancelada por el usuario.");
            done();
            return;
          }
          if (!r || !r.ok) throw new Error((r && r.error) || "la transcripción falló");
          HPStore.setTranscript(r.segments);
          // Alinear automáticamente al timeline con el desfase del clip.
          setOffset(Math.round(Number(info.offset || 0) * 10) / 10, "del clip “" + (info.clipName || "?") + "”");
          updateTranscriptStatus();
          status(r.segments.length + " segmentos · " + (r.language ? "idioma: " + r.language + " · " : "") +
            r.tool + " ✓ (respaldo en la carpeta de la secuencia)");
          hpLog("Transcripción local OK: " + r.segments.length + " segmentos · " + r.language + " · " + r.savedPath);
          // Derivar el objetivo si está vacío (igual que al importar un JSON).
          if (!HPStore.getObjective() || !HPStore.getObjective().trim()) {
            deriveObjectiveFromTranscript(r.segments);
          }
          done();
        }).catch(function (e) {
          status("Error: " + ((e && e.message) || "no se pudo transcribir"));
          hpLog("Transcripción local FALLÓ: " + ((e && e.message) || e), "ERROR");
          done();
        });
      });
    });
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

  // Importa el transcript parseado: CALIBRA sus unidades contra la duración
  // real de la secuencia (un JSON con tiempos en frames/ms queda corrido de
  // forma MULTIPLICATIVA y ningún desfase lo arregla — este era el bug de
  // fondo), reinicia el desfase a 0 (un transcript nuevo no hereda el desfase
  // del anterior) y muestra el veredicto transcript vs secuencia.
  function adoptTranscript(segments) {
    HPHost.getSequenceDuration(function (res) {
      var seqDur = 0;
      if (String(res || "").indexOf("ok|") === 0) seqDur = parseFloat(String(res).substring(3)) || 0;

      var cal = HPTranscript.calibrateUnits(segments, seqDur);
      HPStore.setTranscript(cal.segments);
      // Transcript nuevo = base de tiempo nueva: el desfase anterior no aplica.
      HPStore.setTranscriptOffset(0);
      // La fila de desfase solo aparece si este transcript NO coincide con la
      // secuencia (su único caso de uso legítimo que queda).
      offsetRowNeeded = (cal.match === false);
      hydrateOffset();
      updateTranscriptStatus();
      refreshTranscriptSlices();

      var tDur = transcriptDuration(cal.segments);
      var verdict;
      if (cal.label) {
        verdict = "⚠ Los tiempos venían en " + cal.label + " — corregidos. " +
          "Transcript " + formatTime(tDur) + " · secuencia " + formatTime(seqDur) + " ✓";
      } else if (cal.match === false) {
        verdict = "⚠ El transcript dura " + formatTime(tDur) + " pero la secuencia " + formatTime(seqDur) +
          " — los tiempos NO coinciden con esta secuencia (¿es de otro corte?). Revisá el fragmento de un marcador.";
      } else if (cal.match === true) {
        verdict = segments.length + " segmentos · transcript " + formatTime(tDur) + " · secuencia " + formatTime(seqDur) + " ✓";
      } else {
        verdict = segments.length + " segmentos · " + formatTime(tDur) + " total (no pude leer la duración de la secuencia para validar)";
      }
      transcriptStatus.textContent = verdict;
      hpLog("Transcript importado: " + segments.length + " segmentos · dur " + tDur + "s · seq " + seqDur + "s · calibración: " +
        (cal.label || (cal.match === false ? "NO COINCIDE" : "ok")) + " · desfase reiniciado a 0");

      // La IA deriva el objetivo de la clase desde el transcript.
      // Solo si el objetivo está vacío (no pisar lo que el editor haya escrito).
      if (!HPStore.getObjective() || !HPStore.getObjective().trim()) {
        deriveObjectiveFromTranscript(cal.segments);
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
      adoptTranscript(res.segments);
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

  // ¿El texto de un refinamiento se refiere a las imágenes adjuntas? Si NO las
  // menciona, en un feedback podemos NO reenviarlas como visión (ahorro grande de
  // tokens: las imágenes son lo más caro). Las imágenes marcadas "✓ usar" igual se
  // incrustan en el gráfico por archivo, así que el logo/ícono sigue apareciendo.
  var IMG_REF_RE = /(im[aá]genes?|logo|isotipo|logotipo|[íi]conos?|\bmarca\b|foto|captura|referenci|ilustraci)/i;
  function feedbackNeedsImages(text) { return IMG_REF_RE.test(String(text || "")); }

  function createTranscriptSlice(marker) {
    var segments = HPStore.getTranscript();
    if (!segments || !segments.length) return null;

    var slice = HPTranscript.sliceForMarker(segments, marker.start, marker.start + marker.duration, HPStore.getTranscriptOffset());
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
    var markerTranscript = HPTranscript.sliceForMarker(segments, marker.start, marker.start + marker.duration, HPStore.getTranscriptOffset());
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
    HPHost.openSequenceAndSeek(job.seqName, job.markerStart, function () {
      focusMarkerAfterRender = job.markerKey; // renderMarkers lo enfoca al terminar
      focusOpenEditor = !!openEditor;         // y abre su editor HTML si se pidió
      selectTab("markers");
      onLoadMarkers(); // relee la secuencia (ya activa) y renderiza sus marcadores
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
      HPHost.seekTo(marker.start);
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

    body.appendChild(HPStills.createControl(markerKey));

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
    card._marker = marker; // para refrescar el fragmento al cambiar el desfase

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
      var mt = HPTranscript.sliceForMarker(segs, marker.start, marker.start + marker.duration, HPStore.getTranscriptOffset());
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
    // Flujo progresivo: al tener marcadores, si ya hay contexto (objetivo o
    // transcript), colapsar la sección para que los marcadores tengan el
    // espacio — sobre todo con el panel chico. El header colapsado muestra el
    // estado, así que no se pierde nada de vista.
    var ctx = document.getElementById("context-section");
    var hasContext = (objectiveInput && objectiveInput.value.trim()) || (HPStore.getTranscript() || []).length > 0;
    if (ctx && hasContext) ctx.open = false;
    updateContextSummary();
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
      hydrateOffset();
      updateTranscriptStatus();

      HPHost.getMarkers(function (result) {
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

  // Recarga COMPLETA del panel (re-ejecuta los scripts → loadEngine, recarga de
  // host.jsx, busteo de cache del bridge). Sirve tanto para traer código nuevo
  // como para reintentar la carga del motor si quedó caído.
  function reloadPanel() {
    hpLog("Recargando el panel completo…");
    try { window.location.reload(); return; } catch (e) {}
    try { window.location.href = window.location.href; } catch (e) {}
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
    hydrateOffset();
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
    checkWhisperStatus();
  }

  // ── Indicador de Whisper local (junto al botón 🎙) ──────────────────
  function checkWhisperStatus() {
    var badge = document.getElementById("whisper-badge");
    if (!badge) return;
    hpCall("whisperStatus").then(function (st) {
      if (!st || !st.ok) return;
      badge.setAttribute("data-hidden", "false");
      if (st.available && st.fast) {
        badge.className = "whisper-badge";
        badge.textContent = "✓ " + st.tool + " · " + st.model;
        badge.title = "Whisper local rápido: “" + st.tool + "” con el modelo " + st.model +
          " (se cambia con HYPERPREMIERE_WHISPER_MODEL). 🎙 transcribe sin nube y sin tokens.";
      } else if (st.available) {
        // Backend lento (openai whisper en CPU): avisar y recomendar el rápido.
        badge.className = "whisper-badge is-slow";
        badge.textContent = "⚠ " + st.tool + " (lento)";
        badge.title = "Detectado “" + st.tool + "” (CPU, lento con " + st.model + "). " + (st.recommend || "") +
          " Igual funciona; se cambia con HYPERPREMIERE_WHISPER_MODEL / HYPERPREMIERE_WHISPER_BIN.";
      } else {
        badge.className = "whisper-badge is-missing";
        badge.textContent = "sin whisper local";
        badge.title = (st.recommend || "No encontré whisper local.") + " Sin él, usá “Cargar transcript (JSON)”.";
      }
      hpLog("Whisper local: " + (st.available ? (st.tool + " @ " + (st.path || "?") + " · " + st.model + (st.fast ? " (rápido)" : " (lento)")) : "NO detectado") +
        (st.recommend ? " · " + st.recommend : ""));
    }).catch(function () {});
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
