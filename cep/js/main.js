(function () {
  "use strict";

  var DEBOUNCE_MS = 300;

  // Motor "todo en uno": corre dentro del panel vía Node (CEP --enable-nodejs).
  // La ruta se deriva de la carpeta de la extensión (cross-platform: mac/Windows),
  // el bridge vive en <extensión>/../bridge. Fallback dev por si CEP no la da.
  var HP_ENGINE = null;
  var ENGINE_PATH = "/Users/danielgutierrez/Desktop/Codigo/HyperPremiere/bridge/engine.js";
  (function loadEngine() {
    try {
      // Ruta de la extensión (cep/) para ubicar el bridge sin hardcodear el SO.
      try {
        var _cs = new CSInterface();
        var extDir = _cs.getSystemPath(SystemPath.EXTENSION);
        if (extDir) ENGINE_PATH = extDir + "/../bridge/engine.js";
      } catch (e) {}

      var req = (typeof window !== "undefined" && window.cep_node && window.cep_node.require)
        ? window.cep_node.require
        : (typeof require === "function" ? require : null);
      if (!req) return;
      // Node cachea los require: sin esto, recargar el panel (⟳) NO trae los
      // cambios del motor. Vaciamos la caché del bridge (separador-agnóstico:
      // normalizamos \ a / para que funcione también en Windows).
      try {
        if (req.cache) {
          Object.keys(req.cache).forEach(function (k) {
            if (k.replace(/\\/g, "/").indexOf("/bridge/") !== -1) delete req.cache[k];
          });
        }
      } catch (e) {}
      HP_ENGINE = req(ENGINE_PATH);
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
  // Modo borrador (render rápido, menor calidad) — preferencia global de sesión.
  var draftMode = false;
  try { draftMode = window.localStorage.getItem("hyperpremiere::draft") === "1"; } catch (e) {}

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

  // ── Cola global de generación/render ────────────────────────────────
  // Serial (uno a la vez → no revienta la RAM con varios renders), persiste
  // entre secuencias (vive en el JS del panel) y es visible desde cualquier
  // secuencia. Cada job coloca su clip en SU secuencia por nombre.
  var HPQueue = (function () {
    var jobs = [];
    var counter = 0;
    var subs = [];
    function emit() { for (var i = 0; i < subs.length; i++) { try { subs[i](jobs); } catch (e) {} } }
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
      return Promise.reject(new Error("Motor no disponible. Cerrá y reabrí Premiere."));
    }
    function finishPlace(job, res) {
      job.version = res.version;
      if (res.usage && !job._usageCounted) { job.usage = res.usage; HPStore.addSessionUsage(res.usage); updateSessionUsageBar(); job._usageCounted = true; }
      job.pct = 98; job.msg = "Colocando en " + job.seqName + "…"; emit();
      var movArg = JSON.stringify(res.movPath), seqArg = JSON.stringify(job.seqName);
      csInterface.evalScript(
        "hp_placeClipInSequence(" + movArg + ", " + seqArg + ", " + job.markerStart + ", " + job.markerDuration + ")",
        function (place) {
          var dur = fmtDuration((Date.now() - job.startedAt) / 1000);
          var tok = job.usage ? " · " + addThousands(job.usage.inputTokens) + "↑ " + addThousands(job.usage.outputTokens) + "↓" : "";
          job.status = "done"; job.pct = 100;
          job.msg = (place === "ok" ? "✓ Listo y colocado" : "Render OK; colocá a mano: " + place) +
            " (v" + job.version + ")" + tok + " · " + dur;
          markGenerated(job);
          renderBusy = false; emit(); pump();
        }
      );
    }
    function startModel(job) {
      modelBusy = true; job.status = "modeling"; job.pct = 3; job.msg = "Diseñando…"; job.startedAt = Date.now(); emit();
      var method = job.kind === "generate" ? "prepareGenerate" : "prepareFeedback";
      callEngine(method, job.payload, onP(job)).then(function (prep) {
        if (!prep || !prep.ok) throw new Error(prep && prep.error ? prep.error : "error preparando");
        job.prepared = prep;
        if (prep.usage) { job.usage = prep.usage; HPStore.addSessionUsage(prep.usage); updateSessionUsageBar(); job._usageCounted = true; }
        job.status = "ready"; job.msg = "En espera de render…";
        modelBusy = false; emit(); pump();
      }).catch(function (err) {
        job.status = "error"; job.msg = "Error: " + (err && err.message ? err.message : String(err));
        modelBusy = false; emit(); pump();
      });
    }
    function startRender(job) {
      renderBusy = true; job.status = "running"; if (!job.startedAt) job.startedAt = Date.now();
      job.msg = "Renderizando…"; emit();
      var p = (job.kind === "renderManualHtml")
        ? callEngine("renderManualHtml", job.payload, onP(job))
        : callEngine("renderPrepared", job.prepared, onP(job));
      p.then(function (res) {
        if (!res || !res.ok) throw new Error(res && res.error ? res.error : "error desconocido");
        finishPlace(job, res);
      }).catch(function (err) {
        job.status = "error"; job.msg = "Error: " + (err && err.message ? err.message : String(err));
        renderBusy = false; emit(); pump();
      });
    }
    function pump() {
      // En local (Ollama) NO se solapa: modelo y render usan la misma máquina.
      var overlap = !currentProviderIsLocal;
      // Carril RENDER (uno a la vez; en local, además, no mientras el modelo corre).
      if (!renderBusy && (overlap || !modelBusy)) {
        for (var i = 0; i < jobs.length; i++) {
          var j = jobs[i];
          if (j.status === "ready" || (j.status === "queued" && j.kind === "renderManualHtml")) { startRender(j); break; }
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

    return {
      add: function (job) {
        job.id = "j" + (++counter);
        job.status = "queued"; job.pct = 0; job.msg = "En cola…";
        jobs.push(job); emit(); pump();
        return job.id;
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
        jobs = jobs.filter(function (j) { return !(j.id === id && j.status === "queued"); });
        emit();
      },
      clearFinished: function () {
        jobs = jobs.filter(function (j) {
          return j.status === "queued" || j.status === "modeling" || j.status === "ready" || j.status === "running";
        });
        emit();
      }
    };
  })();

  // Encola la generación IA de un marcador (no corre al instante: la cola serializa).
  function enqueueMarkerGeneration(marker, mode) {
    var markerKey = markerKeyFor(marker);
    var data = HPStore.getMarkerData(markerKey);
    var segments = HPStore.getTranscript() || [];
    var markerTranscript = HPTranscript.sliceByRange(segments, marker.start, marker.start + marker.duration);
    var payload = {
      projectPath: currentProjectPath, sequenceName: currentSequenceName,
      objective: HPStore.getObjective(), transcript: segments,
      marker: { name: marker.name || markerKey, start: marker.start, end: marker.start + marker.duration, duration: marker.duration },
      markerTranscript: markerTranscript, instruction: data.instruction || "",
      stills: data.stills || [], resources: data.resources || [],
      background: !!data.background, draft: draftMode,
      markerSlug: markerKey, mode: mode
    };
    if (mode === "adjust") payload.adjustment = data.instruction || "";
    HPQueue.add({
      kind: mode === "generate" ? "generate" : "feedback",
      payload: payload, seqName: currentSequenceName, projectPath: currentProjectPath,
      markerKey: markerKey, label: markerKey + (marker.name ? " · " + marker.name : ""),
      markerStart: marker.start, markerDuration: marker.duration
    });
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
    }
  }

  function iconBtn(txt, title, cb) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "qbtn"; b.textContent = txt; b.title = title;
    b.addEventListener("click", function (e) { e.stopPropagation(); cb(); });
    return b;
  }

  // Panel de cola global: agrupado por secuencia, con reordenamiento
  // (secuencia arriba/abajo y marcador arriba/abajo dentro de su secuencia).
  function renderQueue(jobs) {
    var panel = document.getElementById("queue-panel");
    if (!panel) return;
    if (!jobs.length) { panel.setAttribute("data-hidden", "true"); panel.innerHTML = ""; return; }
    var pending = 0, i;
    for (i = 0; i < jobs.length; i++) { var st = jobs[i].status; if (st === "queued" || st === "modeling" || st === "ready" || st === "running") pending++; }
    panel.setAttribute("data-hidden", "false");
    panel.innerHTML = "";

    var head = document.createElement("div"); head.className = "queue-head";
    var title = document.createElement("span");
    title.textContent = "Cola" + (pending ? " · " + pending + " en proceso/espera" : " · sin pendientes");
    var clr = document.createElement("button"); clr.type = "button"; clr.className = "queue-clear";
    clr.textContent = "limpiar terminados";
    clr.addEventListener("click", function () { HPQueue.clearFinished(); });
    head.appendChild(title); head.appendChild(clr); panel.appendChild(head);

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
      // Reordenar la secuencia completa (solo si tiene jobs en cola).
      if (queuedInGroup > 0) {
        var ctrls = document.createElement("span"); ctrls.className = "qs-ctrls";
        if (gi > 0) ctrls.appendChild(iconBtn("▲", "Subir esta secuencia", function () { HPQueue.moveSeq(g.seqName, -1); }));
        if (gi < groups.length - 1) ctrls.appendChild(iconBtn("▼", "Bajar esta secuencia", function () { HPQueue.moveSeq(g.seqName, 1); }));
        gh.appendChild(ctrls);
      }
      panel.appendChild(gh);

      var qIdx = 0, qCount = g.jobs.filter(function (j) { return j.status === "queued"; }).length;
      g.jobs.forEach(function (j) {
        var row = document.createElement("div"); row.className = "queue-job is-" + j.status;
        var line = document.createElement("div"); line.className = "qj-line";
        var top = document.createElement("div"); top.className = "qj-title";
        var dot = (j.status === "running") ? "▶ " : (j.status === "modeling") ? "✎ " : (j.status === "ready") ? "◔ " : (j.status === "queued") ? "• " : (j.status === "done") ? "✓ " : "⚠ ";
        top.textContent = dot + j.label;
        line.appendChild(top);
        if (j.status === "queued") {
          var jc = document.createElement("span"); jc.className = "qj-ctrls";
          if (qIdx > 0) jc.appendChild(iconBtn("▲", "Priorizar este marcador", function () { HPQueue.moveJob(j.id, -1); }));
          if (qIdx < qCount - 1) jc.appendChild(iconBtn("▼", "Posponer este marcador", function () { HPQueue.moveJob(j.id, 1); }));
          jc.appendChild(iconBtn("✕", "Quitar de la cola", function () { HPQueue.remove(j.id); }));
          line.appendChild(jc);
          qIdx++;
        }
        row.appendChild(line);
        var msg = document.createElement("div"); msg.className = "qj-msg"; msg.textContent = j.msg || j.status;
        row.appendChild(msg);
        if (j.status === "running" || j.status === "modeling") {
          var bar = document.createElement("div"); bar.className = "hp-bar";
          var fill = document.createElement("div"); fill.className = "hp-bar-fill"; fill.style.width = (j.pct || 0) + "%"; bar.appendChild(fill);
          row.appendChild(bar);
        }
        panel.appendChild(row);
      });
    });
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
      enqueueMarkerGeneration(marker, mode);
    }
    genBtn.addEventListener("click", doGenerate);
    regenBtn.addEventListener("click", function () {
      enqueueMarkerGeneration(marker, "regen");
    });

    // Para el botón global "Generar listos".
    card._runGen = doGenerate;
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
      } else if (job.status === "error") {
        setButtonsDisabled(buttons, false);
        status.className = "marker-status is-error";
        status.textContent = job.msg || "Error";
        sBadge.textContent = "⚠";
      }
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
    verRow.appendChild(verMount);
    verRow.appendChild(openBtn);

    var codeEd = makeCodeEditor();

    var renderBtn = document.createElement("button");
    renderBtn.type = "button";
    renderBtn.className = "btn-generate";
    renderBtn.textContent = "Guardar y renderizar (nueva versión)";

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
              btnUpdate.title = "Actualizado v" + (res.previous || "?") + " → v" + res.version + " (GitHub) — recargando…";
              setTimeout(function () { window.location.reload(); }, 700);
            } else {
              btnUpdate.title = "Ya estás en la última (v" + res.version + ", igual a GitHub)";
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
  function generateAllReady() {
    var cards = markersContainer.querySelectorAll("details.marker-card");
    var n = 0;
    for (var i = 0; i < cards.length; i++) {
      if (cards[i]._isReady && cards[i]._isReady()) { cards[i]._runGen(); n++; }
    }
    if (batchStatus) {
      batchStatus.textContent = n
        ? "Encolados " + n + " marcador(es) — se procesan uno a uno (mirá la Cola arriba)."
        : "No hay marcadores listos (poné una instrucción en al menos uno).";
    }
  }
  if (btnGenerateAll) btnGenerateAll.addEventListener("click", generateAllReady);

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

  // ── "¿Cómo funciona?" como overlay ──────────────────────────────────
  var helpPanel = document.getElementById("help-panel");
  var btnHelp = document.getElementById("btn-help");
  var btnHelpClose = document.getElementById("btn-help-close");
  function toggleHelp(show) {
    if (!helpPanel) return;
    helpPanel.setAttribute("data-hidden", show ? "false" : "true");
  }
  if (btnHelp) btnHelp.addEventListener("click", function () { toggleHelp(helpPanel.getAttribute("data-hidden") !== "false" ? true : false); });
  if (btnHelpClose) btnHelpClose.addEventListener("click", function () { toggleHelp(false); });
  if (helpPanel) helpPanel.addEventListener("click", function (e) { if (e.target === helpPanel) toggleHelp(false); });

  loadConfig();

  // Arranque: fijar contexto y rehidratar objetivo + estado del transcript.
  loadContext(function () {
    hydrateObjective();
    updateTranscriptStatus();
  });
})();
