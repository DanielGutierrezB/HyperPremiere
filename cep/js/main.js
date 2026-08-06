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
        // El contexto quedó al día: si había aviso de "otra secuencia activa", sobra.
        showSeqNotice("");
        // Recargar una secuencia = otra oportunidad de preparar bien SU contexto
        // (puede que le hayas arreglado el audio). Las decisiones que tomaste en
        // las otras secuencias de la cola siguen valiendo.
        delete contextPrepFailed[currentSequenceName];
        delete contextPrepared[currentSequenceName];
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
    setOutput: setOutput,
    // Nombre de la secuencia cuyo contexto se está preparando, para que la cola
    // diga "esperando el transcript" en vez de un "En cola…" sin explicación.
    preparingSequence: function () { return prepSequence; },
    // Estado del contexto de una secuencia, o null si todavía no lo sabemos.
    sequenceContext: function (seqName) { return seqStatus[seqName] || null; }
  });
  // Cada evento de la cola refresca la vista de Cola, las tarjetas de la
  // secuencia actual y el contador de uso de la sesión.
  HPQueue.on(function () {
    refreshSeqStatusFromJobs(HPQueue.jobs());
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
    if (hasTxt || n) {
      generalSummary.textContent = "✓ activo" + (n ? " · " + n + " adj." : "");
      generalSummary.className = "cfg-summary section-state is-ok";
    } else {
      // Vacío: sugerir desplegarlo (aplica a TODOS los marcadores de abajo).
      generalSummary.textContent = "opcional · estilo/marca para todos — desplegá";
      generalSummary.className = "cfg-summary section-state is-hint";
    }
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
        "✓ " + segments.length + " segmentos · " + formatTime(transcriptDuration(segments)) + " total";
      transcriptStatus.className = "muted transcript-ok";
    } else {
      transcriptStatus.textContent = "";
      transcriptStatus.className = "muted";
    }
    updateContextSummary();
  }

  // ── Transcript persistido en la carpeta de la secuencia ──────────────
  // El localStorage del panel es solo una caché: se pierde si se limpia la caché
  // de CEP o si cambia la ruta del proyecto (guardar como…), y entonces el
  // transcript "desaparecía" aunque estuviera en disco. La copia de la carpeta de
  // la secuencia es la fuente de verdad, así que al abrir se lee de ahí.

  // Guarda el transcript actual en la carpeta de la secuencia. Silencioso: si
  // falla, el panel sigue andando con la copia en memoria.
  function persistTranscript(segments, extra) {
    extra = extra || {};
    var body = {
      projectPath: currentProjectPath,
      sequenceName: currentSequenceName,
      segments: segments,
      offset: HPStore.getTranscriptOffset() || 0,
      source: extra.source || "",
      language: extra.language || "",
      tool: extra.tool || ""
    };
    return hpCall("saveTranscript", body)
      .then(function (r) {
        if (r && r.ok) hpLog("Transcript guardado en la secuencia: " + r.path);
        else hpLog("No pude guardar el transcript en disco: " + ((r && r.error) || "?"), "WARN");
        return r;
      })
      .catch(function (e) {
        hpLog("No pude guardar el transcript en disco: " + ((e && e.message) || e), "WARN");
      });
  }

  // Al abrir (o al recargar contexto) trae el transcript de la secuencia si hay.
  // Si en disco no hay nada pero sí en la caché local, lo sube a disco: así las
  // secuencias que ya tenían transcript quedan migradas sin intervención.
  function hydrateTranscriptFromDisk(done) {
    hpCall("loadTranscript", { projectPath: currentProjectPath, sequenceName: currentSequenceName })
      .then(function (r) {
        if (r && r.ok && r.found && r.segments && r.segments.length) {
          HPStore.setTranscript(r.segments);
          // setOffset ya refresca los fragmentos y la fila de desfase.
          setOffset(Number(r.offset) || 0, r.source ? ("de " + r.source) : "");
          updateTranscriptStatus();
          // Sobre el estado normal, aclarar que salió del disco (no lo generó ahora).
          if (transcriptStatus) {
            transcriptStatus.textContent = "✓ " + r.segments.length + " segmentos · " +
              formatTime(transcriptDuration(r.segments)) + " total · guardado en esta secuencia";
            transcriptStatus.className = "muted transcript-ok";
          }
          hpLog("Transcript recuperado del disco: " + r.segments.length + " segmentos · " + r.path +
            (r.legacy ? " (formato viejo)" : ""));
          // Un transcript viejo (transcript-whisper.json) se reescribe con el
          // nombre canónico para que el import de JSON y Whisper compartan archivo.
          if (r.legacy) persistTranscript(r.segments, { source: r.source, language: r.language, tool: r.tool });
          if (done) done();
          return;
        }
        var local = HPStore.getTranscript() || [];
        if (local.length) {
          hpLog("El transcript estaba solo en la caché local: lo guardo en la carpeta de la secuencia.");
          persistTranscript(local, { source: "caché del panel" });
        }
        if (done) done();
      })
      .catch(function (e) {
        hpLog("No pude leer el transcript del disco: " + ((e && e.message) || e), "WARN");
        if (done) done();
      });
  }

  // ── Cambio de secuencia activa en Premiere ───────────────────────────
  // El panel fija el contexto al abrirse y al cargar marcadores. Si mientras
  // tanto cambiás de secuencia en Premiere, seguiría mostrando el objetivo y el
  // transcript de la anterior. NO se cambia el contexto solo: las tarjetas ya
  // renderizadas escribirían en el namespace equivocado. Se avisa y decidís vos.
  var seqNotice = document.getElementById("seq-notice");
  function showSeqNotice(otherSequence) {
    if (!seqNotice) return;
    if (!otherSequence) {
      seqNotice.setAttribute("data-hidden", "true");
      seqNotice.textContent = "";
      return;
    }
    seqNotice.textContent = "En Premiere está activa la secuencia “" + otherSequence +
      "” pero el panel está trabajando sobre “" + (currentSequenceName || "(ninguna)") +
      "”. Todo lo que hagas (transcribir, generar) va a la del PANEL, no a la que ves.";
    // Botón para pasarse de una: tener que ir a buscar "Cargar marcadores" es la
    // fricción que hace que uno siga trabajando desincronizado sin darse cuenta.
    var go = document.createElement("button");
    go.type = "button";
    go.className = "seq-notice-go";
    go.textContent = "Pasarme a “" + otherSequence + "”";
    go.title = "Carga esa secuencia en el panel, con sus marcadores, su transcript y su objetivo";
    go.addEventListener("click", function () { onLoadMarkers(); });
    seqNotice.appendChild(go);
    seqNotice.setAttribute("data-hidden", "false");
  }

  function checkActiveSequenceChanged() {
    if (!HPHost || !HPHost.getActiveSequenceName) return;
    HPHost.getActiveSequenceName(function (name) {
      var live = String(name || "");
      if (!live || live.indexOf("Error:") === 0 || live.indexOf("(sin secuencia") === 0) return;
      showSeqNotice(live !== currentSequenceName ? live : "");
    });
  }

  // Al volver el foco al panel es el momento exacto en que pudo haber cambiado la
  // secuencia (fuiste a Premiere y volviste). Más barato que sondear en bucle.
  window.addEventListener("focus", checkActiveSequenceChanged);

  // Resumen del header de "Contexto de la clase" (visible cuando está colapsado):
  // muestra de un vistazo si hay objetivo y transcript.
  var contextSummary = document.getElementById("context-summary");
  function updateContextSummary() {
    if (!contextSummary) return;
    var segs = HPStore.getTranscript() || [];
    var hasTranscript = segs.length > 0;
    var hasObj = (HPStore.getObjective() || "").trim().length > 0;
    // Check verde SOLO cuando la secuencia está lista de verdad: tiene
    // transcript Y objetivo claro. Si falta algo, se avisa en ámbar qué falta.
    if (hasTranscript && hasObj) {
      contextSummary.textContent = "✓ objetivo + transcript (" + segs.length + " seg)";
      contextSummary.className = "section-state is-ok";
    } else if (hasTranscript) {
      contextSummary.textContent = segs.length + " segmentos · falta objetivo";
      contextSummary.className = "section-state is-warn";
    } else if (hasObj) {
      contextSummary.textContent = "objetivo ✓ · falta transcript";
      contextSummary.className = "section-state is-warn";
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
  // Premiere exporta el audio de la secuencia a un .wav temporal (mono 16 kHz,
  // justo lo que Whisper quiere), se transcribe y se BORRA. Antes se transcribía
  // el "clip más largo" y eso elegía mal: en un timeline con overlays del propio
  // plugin el más largo podía ser un "Marcador N vX.mov", que es ProRes MUDO.
  // Bonus: al ser la mezcla de la secuencia, los tiempos ya están alineados al
  // timeline → desfase 0, sin detección ni ajuste a mano.
  var btnTranscribe = document.getElementById("btn-transcribe-seq");
  var transcribeProgress = document.getElementById("transcribe-progress");
  var transcribeFill = document.getElementById("transcribe-fill");
  var transcribing = false; // mientras corre, el botón se vuelve "Cancelar"
  var transcribeInFlight = null; // la promesa en curso, para que la compartan botón y cola
  var transcribeInFlightSeq = ""; // de QUÉ secuencia es esa promesa
  function showTranscribeBar(show) {
    if (transcribeProgress) transcribeProgress.setAttribute("data-hidden", show ? "false" : "true");
    if (transcribeFill && show) transcribeFill.style.width = "0%";
  }
  var TRANSCRIBE_LABEL = "🎙 Transcribir esta secuencia";

  // ── Espejo del progreso en la pestaña Cola ───────────────────────────
  // Cuando la cola espera el transcript, el progreso vive en la sección Contexto
  // (otra pestaña): desde la Cola solo se veía "En cola…" sin explicación. Este
  // bloque lo replica ahí. Se actualiza directo (no re-renderiza la cola) porque
  // los ticks de Whisper son frecuentes.
  var qpBox = document.getElementById("queue-prep");
  var qpSeq = document.getElementById("qp-seq");
  var qpMsg = document.getElementById("qp-msg");
  var qpFill = document.getElementById("qp-fill");
  var qpCancel = document.getElementById("qp-cancel");
  // Secuencia cuyo contexto se está preparando (null = ninguna). La vista de la
  // cola la usa para marcar qué jobs están esperando el transcript.
  var prepSequence = null;

  function showPrepInQueue(sequenceName) {
    prepSequence = sequenceName || null;
    if (!qpBox) return;
    if (!prepSequence) {
      qpBox.setAttribute("data-hidden", "true");
      return;
    }
    if (qpSeq) qpSeq.textContent = "Preparando el contexto de “" + prepSequence + "”";
    if (qpFill) qpFill.style.width = "0%";
    qpBox.setAttribute("data-hidden", "false");
  }

  function prepProgress(msg, pct) {
    if (qpMsg && msg) qpMsg.textContent = msg;
    if (qpFill && typeof pct === "number") qpFill.style.width = Math.max(0, Math.min(100, pct)) + "%";
  }

  // ── Estado del contexto de cada secuencia de la cola ─────────────────
  // La cola puede tener jobs de varias secuencias y cada una tiene su transcript.
  // Este caché contesta "¿esta ya está lista?" de forma síncrona para la vista;
  // se llena consultando el disco (el transcript vive en la carpeta de la
  // secuencia, y la caché del panel solo tiene el de la activa).
  var seqStatus = {};        // seq → { hasTranscript, hasObjective }
  var seqStatusAsking = {};  // seq → true mientras se consulta el disco

  function markContextChanged(seqName) {
    if (seqName) delete seqStatus[seqName];
    HPQueueView.render(HPQueue.jobs());
  }

  // Consulta en lote el estado de las secuencias de la cola que no conocemos.
  function refreshSeqStatusFromJobs(jobs) {
    var pending = [], byName = {}, i, j;
    for (i = 0; i < jobs.length; i++) {
      j = jobs[i];
      if (!j.seqName || seqStatus[j.seqName] || seqStatusAsking[j.seqName]) continue;
      if (byName[j.seqName]) continue;
      byName[j.seqName] = j.projectPath || currentProjectPath;
      pending.push(j.seqName);
    }
    if (!pending.length) return;
    pending.forEach(function (n) { seqStatusAsking[n] = true; });
    // Todas las secuencias de la cola son del proyecto abierto, así que una sola
    // consulta alcanza (el motor recorre las carpetas y devuelve solo el conteo).
    hpCall("transcriptSummary", { projectPath: byName[pending[0]], sequenceNames: pending })
      .then(function (r) {
        var disk = (r && r.ok && r.byName) || {};
        pending.forEach(function (name) {
          delete seqStatusAsking[name];
          var onDisk = disk[name] && disk[name].found;
          seqStatus[name] = {
            hasTranscript: !!onDisk || transcriptCountFor(byName[name], name) > 0,
            hasObjective: !objectiveIsEmpty(byName[name], name)
          };
        });
        HPQueueView.render(HPQueue.jobs());
      })
      .catch(function (e) {
        pending.forEach(function (name) { delete seqStatusAsking[name]; });
        hpLog("No pude revisar qué secuencias ya tienen transcript: " + ((e && e.message) || e), "WARN");
      });
  }

  if (qpCancel) {
    qpCancel.addEventListener("click", function () {
      hpLog("Usuario canceló la preparación del contexto desde la Cola.");
      qpMsg.textContent = "Cancelando…";
      hpCall("cancelTranscription").catch(function () {});
    });
  }

  // Los errores de transcripción son MULTILÍNEA y explican qué hacer, pero
  // `.muted` los recortaba a una línea con elipsis: quedaba un mensaje
  // inservible. Con is-error el texto se muestra completo y seleccionable.
  function transcribeStatus(msg, isError) {
    if (!transcriptStatus) return;
    transcriptStatus.textContent = msg;
    transcriptStatus.classList.toggle("is-error", Boolean(isError));
  }

  function endTranscribe() {
    transcribing = false;
    if (btnTranscribe) {
      btnTranscribe.disabled = false;
      btnTranscribe.textContent = TRANSCRIBE_LABEL;
    }
    showTranscribeBar(false);
  }

  // Paso 1: Premiere exporta la mezcla de audio de la secuencia a un .wav temporal.
  // Premiere SIEMPRE exporta la secuencia activa, así que se confirma que sea
  // `expectedSeq`: si no, el audio es de otra clase y guardarlo como transcript de
  // ésta pisaría el bueno con el equivocado (y sin avisar).
  function exportSequenceAudioToTemp(expectedSeq) {
    return hpCall("newTempAudioPath").then(function (t) {
      if (!t || !t.ok || !t.path) throw new Error("no pude preparar la ruta temporal del audio");
      return new Promise(function (resolve, reject) {
        HPHost.exportSequenceAudio(t.path, function (res) {
          var parts = String(res == null ? "" : res).split("|");
          if (parts[0] !== "ok" || !parts[1]) {
            hpLog("Exportación de audio FALLÓ: " + res, "ERROR");
            reject(new Error("No pude exportar el audio de la secuencia.\n" + (res || "sin respuesta del host") +
              "\nQué hacer: revisá que la secuencia tenga audio, o cargá el transcript con \"Cargar JSON\"."));
            return;
          }
          var exported = parts[3] || "";
          if (expectedSeq && exported && exported !== expectedSeq) {
            hpLog("Exportación ABORTADA: pedí el audio de “" + expectedSeq + "” y Premiere exportó “" +
              exported + "”.", "ERROR");
            reject(new Error("Premiere exportó el audio de “" + exported + "”, no de “" + expectedSeq + "”.\n" +
              "No guardo eso como transcript de esta clase: sería el de otra.\n" +
              "Qué hacer: abrí “" + expectedSeq + "” en el timeline y probá de nuevo."));
            return;
          }
          hpLog("Audio de “" + (exported || "?") + "” exportado: " + parts[1] + " (preset: " + (parts[2] || "?") + ")");
          resolve(parts[1]);
        });
      });
    });
  }

  // Paso 2: Whisper local sobre ese .wav. Resuelve null si lo cancelaste.
  function runWhisperOn(audioPath, projectPath, seqName) {
    transcribeStatus("Audio exportado. Transcribiendo…");
    // El progreso también va al ⬇ Log (throttleado): si algo se cuelga,
    // el log muestra hasta dónde llegó — antes quedaba mudo tras el clip.
    var lastProgLog = 0;
    return HPEngine.callProg("transcribeMedia", {
      mediaPath: audioPath, projectPath: projectPath, sequenceName: seqName,
      clipName: seqName || "",
      // Ya es mono 16 kHz: nada de ffmpeg. Y es temporal: se borra al terminar,
      // pase lo que pase (una clase entera en WAV son cientos de MB).
      alreadyPrepared: true, deleteAfter: true
    }, function (p) {
      if (!p) return;
      if (p.msg) {
        // La fila de estado vive en la sección Contexto, que muestra la secuencia
        // ACTIVA: si estamos transcribiendo otra (cola con varias), se aclara
        // cuál, o parecería el transcript de la que tenés en pantalla.
        transcribeStatus(seqName === currentSequenceName ? p.msg : ("“" + seqName + "”: " + p.msg));
        var now = Date.now();
        if (now - lastProgLog > 15000) { lastProgLog = now; hpLog("Transcripción: " + p.msg); }
      }
      if (typeof p.pct === "number" && transcribeFill) {
        transcribeFill.style.width = Math.max(0, Math.min(100, p.pct)) + "%";
      }
      prepProgress(p.msg, p.pct); // espejo en la pestaña Cola
    }).then(function (r) {
      if (r && r.cancelled) return null;
      if (!r || !r.ok) throw new Error((r && r.error) || "la transcripción falló");
      return r;
    });
  }

  // Paso 3: adoptar el resultado. Si es de OTRA secuencia (cola con varias), se
  // escribe en SU namespace sin tocar la UI, que muestra la secuencia activa.
  function adoptWhisperResult(r, projectPath, seqName) {
    var loopNote = r.loopsRemoved ? " · limpié " + r.loopsRemoved + " repeticiones alucinadas" : "";
    hpLog("Transcripción local OK (" + seqName + "): " + r.segments.length + " segmentos · " +
      r.language + loopNote + " · " + r.savedPath);
    if (r.loops && r.loops.length) {
      r.loops.forEach(function (l) {
        // Whisper a veces entra en bucle sobre el silencio y repite la última
        // frase decenas de veces; se limpia en el motor y se avisa acá, porque
        // si no el editor ve un transcript "más corto" sin saber por qué.
        hpLog("Bucle de Whisper: " + l.count + "× “" + String(l.text).slice(0, 60) + "” entre " +
          Math.round(l.start) + "s y " + Math.round(l.end) + "s", "WARN");
      });
    }
    if (seqName !== currentSequenceName) {
      HPStore.withContext(projectPath, seqName, function () {
        HPStore.setTranscript(r.segments);
        HPStore.setTranscriptOffset(0);
      });
      return;
    }
    HPStore.setTranscript(r.segments);
    // El audio ES la secuencia: los tiempos ya coinciden con el timeline.
    setOffset(0, "audio de la secuencia");
    updateTranscriptStatus();
    transcribeStatus(r.segments.length + " segmentos · " + (r.language ? "idioma: " + r.language + " · " : "") +
      r.tool + loopNote + " ✓ (guardado en la carpeta de la secuencia)");
  }

  // Deja `seqName` abierta en Premiere. Devuelve el nombre de la que estaba (para
  // poder volver) o "" si ya era la activa.
  //
  // SIEMPRE le pregunta a Premiere cuál está activa, incluso cuando `seqName` es la
  // del panel: si el editor cambió de timeline y no pulsó "Cargar marcadores", el
  // panel cree estar en una y Premiere está en otra, y exportar sin comprobarlo
  // transcribía la clase equivocada.
  function activateSequence(seqName) {
    if (!seqName) return Promise.resolve("");
    return new Promise(function (resolve, reject) {
      HPHost.getActiveSequenceName(function (before) {
        var prev = String(before || "");
        if (prev === seqName) { resolve(""); return; }
        hpLog("En Premiere está activa “" + prev + "”: abro “" + seqName + "” para exportar SU audio.");
        HPHost.openSequenceAndSeek(seqName, 0, function (res) {
          if (String(res || "").indexOf("ok") !== 0) {
            reject(new Error("No pude abrir la secuencia “" + seqName + "” en Premiere: " + (res || "sin respuesta") +
              "\nQué hacer: abrila a mano en el timeline y volvé a intentar."));
            return;
          }
          resolve(prev);
        });
      });
    });
  }

  /**
   * Transcribe una secuencia de punta a punta y deja el transcript en su
   * namespace del store. Resuelve con los segmentos, o con null si lo cancelaste;
   * rechaza con un Error cuyo mensaje ya es presentable. Lo usan el botón 🎙 y el
   * paso previo obligatorio antes de generar (que puede pedir OTRA secuencia si
   * la cola tiene jobs de varias).
   *
   * Si la secuencia no es la activa, la abre en Premiere (única forma de exportar
   * su audio) y al terminar vuelve a la que estabas.
   */
  function transcribeSequence(projectPath, seqName) {
    if (transcribeInFlight) {
      // Misma secuencia (tocaste el botón y después Generar): se engancha a la que
      // hay en vuelo en vez de arrancar una segunda exportación.
      if (transcribeInFlightSeq === seqName) return transcribeInFlight;
      // Otra secuencia: Premiere solo puede exportar el audio de UNA a la vez,
      // así que esta espera su turno. Devolver la promesa en vuelo le daría el
      // transcript de la secuencia equivocada.
      hpLog("“" + seqName + "” espera su turno para transcribir (ahora está “" + transcribeInFlightSeq + "”).");
      return transcribeInFlight.then(next, next);
    }
    transcribing = true;
    transcribeInFlightSeq = seqName;
    if (btnTranscribe) {
      btnTranscribe.textContent = "✕ Cancelar transcripción";
      btnTranscribe.title = "Cancela la transcripción en curso (mata el proceso de whisper)";
    }
    showTranscribeBar(true);
    status("Exportando el audio de la secuencia (Premiere puede quedarse un rato)…");
    showPrepInQueue(seqName);
    prepProgress("Exportando el audio de la secuencia…", 0);
    hpLog("Transcripción local de “" + seqName + "”: exportando el audio…");

    var returnTo = "";
    transcribeInFlight = activateSequence(seqName)
      .then(function (prev) {
        returnTo = prev;
        return exportSequenceAudioToTemp(seqName);
      })
      .then(function (audioPath) { return runWhisperOn(audioPath, projectPath, seqName); })
      .then(function (r) {
        endTranscribe();
        if (!r) {
          status("Transcripción cancelada.");
          hpLog("Transcripción local cancelada por el usuario.");
          return restoreSequence().then(finish(null));
        }
        adoptWhisperResult(r, projectPath, seqName);
        markContextChanged(seqName);
        return restoreSequence().then(finish(r.segments));
      }, function (e) {
        endTranscribe();
        return restoreSequence().then(function () { clear(); throw e; });
      });
    return transcribeInFlight;

    // La fila de estado vive en la sección Contexto, que muestra la secuencia
    // ACTIVA: si transcribimos otra, se aclara cuál.
    function status(msg) {
      transcribeStatus(seqName === currentSequenceName ? msg : ("“" + seqName + "”: " + msg));
    }
    // Recién acá se libera el "en vuelo": si se liberara antes de volver a la
    // secuencia del editor, un segundo pedido arrancaría otra exportación
    // mientras Premiere todavía está cambiando de timeline.
    function clear() { transcribeInFlight = null; transcribeInFlightSeq = ""; }
    function finish(value) { return function () { clear(); return value; }; }
    function next() { return transcribeSequence(projectPath, seqName); }

    // Volver a la secuencia que el editor tenía abierta: le movimos el timeline
    // para exportar el audio, no se lo dejamos cambiado.
    function restoreSequence() {
      if (!returnTo || returnTo === seqName) return Promise.resolve();
      return new Promise(function (resolve) {
        hpLog("Vuelvo a la secuencia “" + returnTo + "”, que era la que tenías abierta.");
        HPHost.openSequenceAndSeek(returnTo, 0, function () { resolve(); });
      });
    }
  }

  function transcribeCurrentSequence() {
    return transcribeSequence(currentProjectPath, currentSequenceName);
  }

  function objectiveIsEmpty(projectPath, seqName) {
    if (seqName && seqName !== currentSequenceName) {
      return HPStore.withContext(projectPath, seqName, function () {
        return !HPStore.getObjective() || !HPStore.getObjective().trim();
      });
    }
    return !HPStore.getObjective() || !HPStore.getObjective().trim();
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
      transcribeCurrentSequence().then(function (segments) {
        // Derivar el objetivo si está vacío (igual que al importar un JSON).
        if (segments && objectiveIsEmpty()) {
          prepProgress("Sacando el objetivo de la clase…", 100);
          return deriveObjectiveFromTranscript(segments);
        }
      }).catch(function (e) {
        transcribeStatus("Error: " + ((e && e.message) || "no se pudo transcribir"), true);
        hpLog("Transcripción local FALLÓ: " + ((e && e.message) || e), "ERROR");
      }).then(function () {
        // Si la cola sigue preparando contexto, ella cierra el cartel.
        if (!anyContextPrepRunning()) showPrepInQueue(null);
      });
    });
  }

  // Deriva el objetivo de la clase llamando al motor (deriveObjective).
  // El resultado llena #objective pero queda editable por el editor.
  // Devuelve una Promise (el paso previo a generar la espera) que nunca rechaza.
  var objectiveInFlight = null;
  function deriveObjectiveFromTranscript(segments) {
    // Una sola derivación a la vez: el botón de transcribir y el paso previo a
    // generar pueden pedirla sobre la MISMA transcripción compartida, y serían
    // dos llamadas al modelo en paralelo para el mismo resultado.
    if (objectiveInFlight) return objectiveInFlight;
    if (objectiveInput) {
      objectiveInput.setAttribute("placeholder", "Derivando objetivo del transcript…");
    }
    objectiveInFlight = hpCall("deriveObjective", { transcript: segments })
      .then(function (data) {
        if (data && data.ok && data.objective) {
          objectiveInput.value = data.objective;
          HPStore.setObjective(data.objective);
        }
        if (data && data.usage) { HPStore.addSessionUsage(data.usage); updateSessionUsageBar(); }
      })
      .catch(function (e) {
        // Silencioso: el editor puede escribir el objetivo a mano si el motor no está.
        hpLog("No pude derivar el objetivo: " + ((e && e.message) || e), "WARN");
      })
      .then(function () {
        objectiveInFlight = null;
        if (objectiveInput) {
          objectiveInput.setAttribute(
            "placeholder",
            "Describe qué debe lograr el estudiante al terminar esta clase. Se usa como contexto para generar instrucciones por marcador."
          );
        }
        updateContextSummary();
      });
    return objectiveInFlight;
  }

  // Importa el transcript parseado: CALIBRA sus unidades contra la duración
  // real de la secuencia (un JSON con tiempos en frames/ms queda corrido de
  // forma MULTIPLICATIVA y ningún desfase lo arregla — este era el bug de
  // fondo), reinicia el desfase a 0 (un transcript nuevo no hereda el desfase
  // del anterior) y muestra el veredicto transcript vs secuencia.
  function adoptTranscript(segments) {
    // Un JSON puede venir con bucles de Whisper (los respaldos hechos antes de
    // que el motor los limpiara, o transcripts de otras herramientas).
    var noLoops = HPTranscript.stripRepetitionLoops(segments);
    if (noLoops.removed > 0) {
      hpLog("Transcript importado: limpié " + noLoops.removed + " repeticiones alucinadas.", "WARN");
      segments = noLoops.segments;
    }
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
      if (noLoops.removed > 0) verdict += " · limpié " + noLoops.removed + " repeticiones alucinadas";
      transcriptStatus.textContent = verdict;
      // Verde solo si coincide limpio; ámbar/neutro si hubo aviso de unidades o desajuste.
      transcriptStatus.className = "muted" + ((cal.match === false || cal.label) ? "" : " transcript-ok");
      hpLog("Transcript importado: " + segments.length + " segmentos · dur " + tDur + "s · seq " + seqDur + "s · calibración: " +
        (cal.label || (cal.match === false ? "NO COINCIDE" : "ok")) + " · desfase reiniciado a 0");

      // Se copia a la carpeta de la secuencia (reemplazando el que hubiera), así
      // el JSON importado queda disponible al reabrir sin volver a buscarlo.
      // Se guardan los segmentos YA calibrados: al recargar no hay que recalibrar.
      persistTranscript(cal.segments, { source: "JSON importado" });

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

  // Nombre/ID del marcador: lo asigna LA HERRAMIENTA la primera vez que ve ese
  // marcador (por su guid de Premiere) y no se reusa. NO es su posición en la
  // secuencia: así podés borrar, rehacer y mover marcadores sin que el nuevo
  // herede la instrucción, las imágenes ni los videos del que estaba en ese
  // lugar. Por eso la numeración puede tener huecos (1, 2, 5…), y está bien.
  // Es la nomenclatura que ve el editor Y la que usan los archivos generados.
  function markerKeyFor(marker) {
    var n = HPStore.assignMarkerNumber(marker && marker.guid);
    // Sin guid (Premiere que no lo expone): volvemos a la posición, como antes.
    if (!n) n = (marker.index || 0) + 1;
    return "Marcador " + n;
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

  // ── Contexto obligatorio antes de generar ────────────────────────────
  // Generar sin transcript da animaciones MUCHO peores: el modelo no sabe qué se
  // dice en ese tramo de la clase y adivina. Así que antes de gastar tokens, si
  // la secuencia no tiene transcript (u objetivo), se transcribe y se deriva el
  // objetivo, y recién entonces la cola procesa. Los jobs se encolan igual y los
  // ves en la pestaña Cola, esperando.
  //
  // Se registra como preflight de la cola, así que cubre todos los caminos:
  // Generar, Generar listos, ▶ Iniciar cola, reintentar y regenerar.
  // Todo el estado es POR SECUENCIA: la cola puede tener jobs de varias y cada
  // una tiene su transcript y su objetivo. Solo se transcribe la que tenga jobs
  // pendientes sin transcript, nunca "todas".
  var contextPrep = {};       // seq → promesa de preparación en curso
  // Si la preparación falló o la cancelaste, el siguiente ▶ Iniciar cola vale como
  // "generá igual, me la juego": si no, te quedarías trabado sin poder generar
  // nunca en una secuencia sin audio.
  var contextPrepFailed = {}; // seq → true
  // Ya preparamos el contexto de esa secuencia. Sin esta marca, si derivar el
  // objetivo falla (motor caído) el objetivo queda vacío, el preflight vuelve a
  // pedir preparación y se entra en un bucle infinito quemando tokens.
  var contextPrepared = {};   // seq → true

  function anyContextPrepRunning() {
    for (var k in contextPrep) { if (contextPrep.hasOwnProperty(k)) return true; }
    return false;
  }

  function transcriptCountFor(projectPath, seqName) {
    if (!seqName || seqName === currentSequenceName) return (HPStore.getTranscript() || []).length;
    return HPStore.withContext(projectPath, seqName, function () {
      return (HPStore.getTranscript() || []).length;
    });
  }

  // Chequeo SÍNCRONO (lo que el panel ya sabe). Puede dar "no listo" para una
  // secuencia cuyo transcript está en disco pero no en la caché: de eso se
  // encarga prepareContextFor, que lo busca antes de transcribir.
  function contextIsReadyFor(projectPath, seqName) {
    if (contextPrepared[seqName]) return true;
    return transcriptCountFor(projectPath, seqName) > 0 && !objectiveIsEmpty(projectPath, seqName);
  }

  // Devuelve una Promise<bool> que NUNCA rechaza: true = listo para generar,
  // false = no se pudo (ya se explicó por pantalla) y la cola queda en pausa.
  // Compartida por secuencia: si mandás 10 marcadores de una, transcribe UNA vez.
  function prepareContextFor(projectPath, seqName) {
    if (contextPrep[seqName]) return contextPrep[seqName];

    var isActive = (seqName === currentSequenceName);
    var label = isActive ? "esta secuencia" : "la secuencia “" + seqName + "”";
    // Cartel en la pestaña Cola desde el minuto cero: si solo falta el objetivo
    // no pasa por transcribeSequence, que es quien normalmente lo abre.
    showPrepInQueue(seqName);
    prepProgress("Buscando el transcript de la secuencia…", 0);
    // Re-render para que los jobs digan "esperando el transcript" y no "En cola…".
    HPQueueView.render(HPQueue.jobs());

    var prep = loadTranscriptInto(projectPath, seqName)
      .then(function (segs) {
        if (segs && segs.length) return segs; // ya estaba hecho (disco o caché)
        setOutput(label.charAt(0).toUpperCase() + label.slice(1) + " no tiene transcript y sin él las " +
          "animaciones salen mucho peores.\nLo genero primero, saco el objetivo de la clase y después " +
          "arranco con la cola.");
        hpLog("Generación pedida sin transcript en “" + seqName + "”: transcribo y derivo el objetivo antes de procesar.");
        return transcribeSequence(projectPath, seqName);
      })
      .then(function (segs) {
        if (!segs || !segs.length) {
          // Cancelaste la transcripción: no generamos a ciegas.
          setOutput("Cancelaste la transcripción, así que no generé nada.\nLos marcadores quedaron en la " +
            "pestaña Cola. Podés cargar un transcript con \"Cargar JSON\", o pulsar ▶ Iniciar cola otra vez " +
            "para generar igual sin él.");
          return false;
        }
        if (!objectiveIsEmpty(projectPath, seqName)) return true;
        setOutput("Transcript listo. Sacando el objetivo de la clase…");
        prepProgress("Transcript listo. Sacando el objetivo de la clase…", 100);
        // El objetivo es "mejor esfuerzo": si no se puede derivar, generamos con
        // el transcript igual (que es lo que más mueve la calidad) y podés
        // escribirlo a mano. Bloquear acá dejaría la cola trabada.
        return deriveObjectiveInto(segs, projectPath, seqName).then(function () {
          if (objectiveIsEmpty(projectPath, seqName)) {
            hpLog("No pude derivar el objetivo de “" + seqName + "”: genero con el transcript solo.", "WARN");
          }
          return true;
        });
      })
      .catch(function (e) {
        var why = (e && e.message) || "no pude preparar el contexto";
        setOutput("No pude preparar el contexto de " + label + ", así que no generé nada:\n" + why +
          "\n\nLos marcadores quedaron en la pestaña Cola. Cargá el transcript con \"Cargar JSON\" y pulsá " +
          "▶ Iniciar cola, o pulsá ▶ Iniciar cola otra vez para generar igual sin transcript (va a salir peor).", true);
        hpLog("Preparación del contexto de “" + seqName + "” FALLÓ: " + why, "ERROR");
        return false;
      })
      .then(function (ok) {
        contextPrepFailed[seqName] = !ok;
        contextPrepared[seqName] = ok;
        showPrepInQueue(null);
        markContextChanged(seqName);
        if (ok) setOutput("Contexto listo" + (isActive ? "" : " (" + seqName + ")") + ". Arranco con la cola.");
        return ok;
      });

    // De un solo uso: si falla o la cancelás, el próximo intento vuelve a probar
    // en vez de quedar pegado a una promesa vieja.
    contextPrep[seqName] = prep;
    function release() { delete contextPrep[seqName]; }
    prep.then(release, release);
    return prep;
  }

  // Trae el transcript de una secuencia desde su carpeta si la caché no lo tiene.
  // Devuelve los segmentos (o [] si no hay en ningún lado) y nunca rechaza.
  function loadTranscriptInto(projectPath, seqName) {
    var cached = transcriptCountFor(projectPath, seqName);
    if (cached > 0) {
      return Promise.resolve(seqName === currentSequenceName
        ? HPStore.getTranscript()
        : HPStore.withContext(projectPath, seqName, function () { return HPStore.getTranscript(); }));
    }
    // La activa tiene su propio camino, que además reescribe los transcripts en
    // formato viejo y actualiza la fila de estado de la sección Contexto.
    if (seqName === currentSequenceName) {
      return new Promise(function (resolve) {
        hydrateTranscriptFromDisk(function () { resolve(HPStore.getTranscript() || []); });
      });
    }
    return hpCall("loadTranscript", { projectPath: projectPath, sequenceName: seqName })
      .then(function (r) {
        if (!r || !r.ok || !r.found || !r.segments || !r.segments.length) return [];
        hpLog("Transcript de “" + seqName + "” recuperado del disco: " + r.segments.length + " segmentos.");
        HPStore.withContext(projectPath, seqName, function () {
          HPStore.setTranscript(r.segments);
          HPStore.setTranscriptOffset(Number(r.offset) || 0);
        });
        return r.segments;
      })
      .catch(function () { return []; });
  }

  // Deriva el objetivo dejándolo en el namespace de SU secuencia. Para la activa
  // usa la ruta normal (que además llena el textarea).
  function deriveObjectiveInto(segments, projectPath, seqName) {
    if (seqName === currentSequenceName) return deriveObjectiveFromTranscript(segments);
    return hpCall("deriveObjective", { transcript: segments })
      .then(function (data) {
        if (data && data.ok && data.objective) {
          HPStore.withContext(projectPath, seqName, function () { HPStore.setObjective(data.objective); });
        }
        if (data && data.usage) { HPStore.addSessionUsage(data.usage); updateSessionUsageBar(); }
      })
      .catch(function (e) {
        hpLog("No pude derivar el objetivo de “" + seqName + "”: " + ((e && e.message) || e), "WARN");
      });
  }

  // La cola consulta esto antes de arrancar CUALQUIER job de IA. Con dryRun=true
  // solo contesta si el contexto está listo, sin ponerse a prepararlo: así la
  // cola puede saltear los jobs que esperan y arrancar los que ya pueden.
  HPQueue.setModelPreflight(function (job, dryRun) {
    var seqName = (job && job.seqName) || currentSequenceName;
    var projectPath = (job && job.projectPath) || currentProjectPath;
    if (contextIsReadyFor(projectPath, seqName)) return true;
    if (dryRun) return false;
    // Ya intentamos preparar el contexto y no se pudo: si volvés a arrancar la
    // cola es porque querés generar así. La decisión vale para TODA la cola de
    // esa secuencia (marcar solo "ya falló" haría que el 2º job volviera a
    // intentar transcribir y dejara el resto del lote sin generar).
    if (contextPrepFailed[seqName]) {
      contextPrepFailed[seqName] = false;
      contextPrepared[seqName] = true;
      setOutput("Genero SIN transcript, como pediste. Las animaciones van a ser más genéricas: " +
        "el modelo no sabe qué se dice en cada marcador.");
      hpLog("Generando “" + seqName + "” sin transcript por decisión del editor.", "WARN");
      markContextChanged(seqName);
      return true;
    }
    return prepareContextFor(projectPath, seqName);
  });

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
    // La cola no arranca jobs de IA hasta que el contexto esté listo (ver el
    // preflight más abajo), así que acá no hay nada especial que hacer.
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

    // Acordeón: al abrir esta tarjeta, colapsar las demás (ahorra pantalla) y
    // también plegar el setup de arriba (Preparación) para dar el máximo espacio.
    card.addEventListener("toggle", function () {
      if (!card.open) return;
      updateEstimate();
      var all = markersContainer.querySelectorAll("details.marker-card");
      for (var i = 0; i < all.length; i++) {
        if (all[i] !== card) all[i].open = false;
      }
      // Plegar el setup y el prompt general → máximo espacio para el marcador.
      var ctx = document.getElementById("context-section");
      if (ctx) ctx.open = false;
      var gen = document.getElementById("general-section");
      if (gen) gen.open = false;
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

    // Secuencias que vienen de la numeración por posición: adoptar el orden
    // actual como numeración inicial ANTES de crear las tarjetas, para que las
    // instrucciones y los videos ya generados sigan calzando con su marcador.
    // No hace nada si la secuencia ya tiene registro.
    var guids = [];
    for (var g = 0; g < markers.length; g++) guids.push(markers[g].guid);
    if (HPStore.seedMarkerNumbers(guids)) {
      hpLog("Numeración de marcadores: adoptado el orden actual (1.." + guids.length + ") para esta secuencia");
    }

    for (var i = 0; i < markers.length; i++) {
      markersContainer.appendChild(createMarkerCard(markers[i]));
    }
    setOutput(markers.length + " marcador(es) cargados · estado guardado ✓", false);
    // Estado de secuencia arriba, en verde.
    setHeaderStatus((currentSequenceName || "secuencia") + " ✓", "ok");
    // Flujo progresivo: al tener marcadores, si ya hay contexto (objetivo o
    // transcript), colapsar Contexto para que los marcadores tengan el espacio
    // — sobre todo con el panel chico. El header colapsado muestra el resumen,
    // así que no se pierde nada de vista. (Prompt general ya viene replegado.)
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
      // Cambiar de secuencia acá es lo normal: hay que traer SU transcript.
      hydrateTranscriptFromDisk();

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
  // El transcript se busca en la carpeta de la secuencia, no en la caché local:
  // así al reabrir Premiere reconoce que esta secuencia ya lo tiene hecho.
  loadContext(function () {
    hydrateObjective();
    hydrateGeneral();
    hydrateOffset();
    updateTranscriptStatus();
    hydrateTranscriptFromDisk();
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
  // Lo que el panel hace con la respuesta de engineStatus: mostrar u ocultar
  // "Preparar motor" y configurar los carriles de render de la cola.
  function applyEngineStatus(st) {
    if (!st) return;
    if (st.ok && st.depsReady === false) {
      hpLog("Motor SIN dependencias (instalación limpia) — mostrando 'Preparar motor'.", "WARN");
      showEnginePrep(true);
      setHeaderStatus("preparar motor", "warn");
    } else {
      showEnginePrep(false);
    }
    // Cuántos renders aguanta ESTA máquina en paralelo: lo perfila el motor
    // (RAM/cores) y la cola lo usa como techo de su carril de render.
    if (st.renderLanes) {
      hpLog("Carriles de render en esta máquina: " + HPQueue.setRenderLanes(st.renderLanes) +
        " (con Ollama local, siempre 1).");
    }
  }
  function checkEngineDeps() {
    hpCall("engineStatus").then(applyEngineStatus).catch(function () {});
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
