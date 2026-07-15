/**
 * HPQueueView — vista de la pestaña Cola: lista agrupada por secuencia con
 * controles (reordenar, pausar, reactivar, feedback inline, Render HQ,
 * limpiar versiones viejas) y el estimado de tiempo/tokens/costo pendiente.
 *
 * Solo DOM: el estado vive en HPQueue (y la selección de imágenes de
 * feedback en HPStills). Deps de main vía init(deps):
 *   goToJobMarker(job, openEditor) → abrir secuencia + enfocar la tarjeta
 *   setOutput(text, isError)      → mensaje en la barra de salida del panel
 *
 * Vanilla JS, sin ES modules: se expone como window.HPQueueView.
 */
(function (global) {
  "use strict";

  var hpLog = HPLog.log;
  var fmtDuration = HPUtil.fmtDuration;
  var addThousands = HPUtil.addThousands;

  var deps = null; // lo llena init()

  // Estado UI de la caja de feedback por job (id → abierto?) y borrador de texto
  // (id → texto), para que sobreviva a los re-render frecuentes de la cola.
  var feedbackOpen = {};
  var feedbackDraft = {};

  function iconBtn(txt, title, cb) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "qbtn"; b.textContent = txt; b.title = title;
    b.addEventListener("click", function (e) { e.stopPropagation(); cb(); });
    return b;
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

  // Re-renderiza en HQ la última versión de cada marcador MEJORABLE (opaco en
  // borrador) de una secuencia, según los jobs de esa secuencia en la cola.
  function renderSeqHQ(seqName) {
    var jobs = HPQueue.jobs();
    var byMarker = {};
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      if (j.seqName === seqName && j.markerKey) byMarker[j.markerKey] = j; // el último gana
    }
    Object.keys(byMarker).forEach(function (mk) {
      if (HPQueue.isUpgradable(byMarker[mk])) renderJobHQ(byMarker[mk]);
    });
  }

  // ── Limpieza de versiones viejas ──────────────────────────────────────

  // Ejecuta la limpieza REAL (ya confirmada): secuencia → proyecto → disco.
  function performCleanup(targets) {
    deps.setOutput("🧹 Limpiando versiones viejas…", false);
    hpLog("Limpiando versiones viejas en " + targets.length + " secuencia(s)…");
    var listPromises = targets.map(function (t) {
      return HPEngine.call("listOldVersions", t).then(function (r) { return (r && r.ok) ? (r.files || []) : []; }).catch(function () { return []; });
    });
    Promise.all(listPromises).then(function (lists) {
      var names = [];
      lists.forEach(function (files) { files.forEach(function (f) { if (f && f.name) names.push(f.name); }); });
      if (!names.length) { deps.setOutput("🧹 No hay versiones viejas para limpiar.", false); return; }
      // Paso 2: sacarlos de secuencia + proyecto ANTES de borrar (evita re-vincular).
      HPHost.purgeClipsByName(names, function (purge) {
        hpLog("purge en Premiere: " + purge + " (" + names.length + " nombres)");
        var totalDeleted = 0, totalBytes = 0, pending = targets.length, errs = [];
        targets.forEach(function (t) {
          HPEngine.call("cleanOldVersions", t).then(function (res) {
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
                deps.setOutput(msg, errs.length > 0 || !okPurge);
                hpLog(msg);
              }
            });
        });
      });
    });
  }

  // Botón "limpiar versiones viejas": PRIMERO muestra el detalle (qué se borra ↔
  // qué se conserva) y pide confirmación; recién al aceptar borra.
  function cleanOldVersions() {
    var seen = {}, targets = [];
    function addTarget(pp, sn) {
      if (!sn) return;
      var k = String(pp) + "::" + String(sn);
      if (seen[k]) return; seen[k] = true;
      targets.push({ projectPath: pp, sequenceName: sn });
    }
    var jobs = HPQueue.jobs();
    for (var i = 0; i < jobs.length; i++) addTarget(jobs[i].projectPath, jobs[i].seqName);
    var ctx = HPStore.getContext();
    addTarget(ctx.projectPath, ctx.sequenceName);
    if (!targets.length) { deps.setOutput("No hay secuencias en la cola para limpiar.", false); return; }

    var previewPromises = targets.map(function (t) {
      return HPEngine.call("cleanupPreview", t)
        .then(function (r) { return (r && r.ok) ? r : { groups: [], totalDeletes: 0, totalBytes: 0, sequenceName: t.sequenceName }; })
        .catch(function () { return { groups: [], totalDeletes: 0, totalBytes: 0, sequenceName: t.sequenceName }; });
    });
    Promise.all(previewPromises).then(function (previews) {
      var totalDeletes = 0, totalBytes = 0;
      previews.forEach(function (p) { totalDeletes += p.totalDeletes || 0; totalBytes += p.totalBytes || 0; });
      if (!totalDeletes) { deps.setOutput("🧹 No hay versiones viejas para limpiar.", false); return; }
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

  // Costo estimado de la cola, auto-calibrado con el costo REAL ya acumulado en la
  // sesión ($/token de entrada). Local = gratis; sin datos aún = se calcula al correr.
  function estimateCostLabel(inputTokens) {
    if (HPConfigUI.isLocalProvider()) return "gratis (local)";
    var u = HPStore.getSessionUsage();
    if (u && u.costUsd > 0 && u.inputTokens > 0) {
      var est = inputTokens * (u.costUsd / u.inputTokens);
      return "≈ $" + (est < 0.1 ? est.toFixed(4) : est.toFixed(2));
    }
    return "s/d (se calcula al procesar)";
  }

  // Footer con estimación de la cola (marcadores en espera): tiempo y tokens de
  // entrada estimados para procesar TODO lo pendiente, así se decide antes de lanzar.
  function renderQueueEstimate(panel, jobs) {
    var pend = jobs.filter(function (j) { return HPQueue.isPending(j.status); });
    if (!pend.length) return;
    var genCount = 0, compSec = 0;
    for (var k = 0; k < pend.length; k++) {
      var j = pend[k];
      if (j.kind === "generate" || j.kind === "feedback") genCount++;
      compSec += Number(j.markerDuration) || 0;
    }
    // Tiempo ≈ (jobs de modelo × promedio modelo) + (segundos de composición × factor render).
    var timeSec = genCount * HPQueue.timing.avgModelSec() + compSec * HPQueue.timing.renderSecPerCompSec();

    var foot = document.createElement("div"); foot.className = "queue-estimate";
    var line1 = document.createElement("div"); line1.className = "qe-line";
    line1.textContent = "⏳ Pendiente: " + pend.length + " marcador(es) · vídeo total " + fmtDuration(compSec) +
      " · tiempo ≈ " + fmtDuration(timeSec) + (HPQueue.timing.calibrated() ? "" : " (aprox.)");
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
      return HPEngine.call("estimateTokens", j.payload).then(function (r) {
        j._tokEst = (r && r.ok) ? (r.inputTokensEst || 0) : 0; return j._tokEst;
      }).catch(function () { return 0; });
    })).then(function (vals) {
      var total = vals.reduce(function (a, b) { return a + (b || 0); }, 0);
      line2.textContent = "Tokens de entrada estimados (toda la cola): ≈ " + addThousands(total) +
        " · " + aiJobs.length + " llamada(s) a la IA · costo " + estimateCostLabel(total);
    }).catch(function () { line2.textContent = ""; });
  }

  // Caja de feedback inline de un job terminado: texto + regenerar + control de
  // imágenes con selección de reenvío (solo si el job es de la secuencia actual).
  function buildFeedbackBox(j) {
    var fb = document.createElement("div"); fb.className = "qj-feedback-wrap";
    var inRow = document.createElement("div"); inRow.className = "qj-feedback";
    var ta = document.createElement("textarea"); ta.className = "qj-fb-input"; ta.rows = 2;
    ta.placeholder = "Qué ajustar… (se regenera manteniendo el puesto en la cola)";
    ta.value = feedbackDraft[j.id] || "";
    ta.addEventListener("input", function (e) { feedbackDraft[j.id] = e.target.value; });
    ta.addEventListener("click", function (e) { e.stopPropagation(); });
    inRow.appendChild(ta);
    var go = document.createElement("button"); go.type = "button"; go.className = "qbtn qbtn-react"; go.textContent = "↻ Regenerar";
    go.title = "Regenerar con tu feedback (retoma el mismo puesto en la cola)";
    go.addEventListener("click", function (e) {
      e.stopPropagation();
      var t = feedbackDraft[j.id] || "";
      // Índices de las imágenes que el usuario dejó activas (📤) para reenviar.
      var sendIdx = HPStills.fbCollect(j.id, j.markerKey);
      feedbackOpen[j.id] = false; feedbackDraft[j.id] = ""; HPStills.fbClear(j.id);
      HPQueue.regenerate(j.id, t, sendIdx);
    });
    inRow.appendChild(go);
    fb.appendChild(inRow);
    // Imágenes/elementos para el feedback — mismo control que la tarjeta
    // (drag&drop + 📸 captura + etiqueta referencia/usar). Se agregan al
    // marcador y la regeneración los toma. Solo si el job es de la secuencia
    // actual (HPStore opera sobre ese contexto).
    var ctx = HPStore.getContext();
    if (j.seqName === ctx.sequenceName && j.projectPath === ctx.projectPath) {
      // Selección de reenvío por imagen. Se inicializa una vez por apertura: las
      // imágenes YA adjuntas quedan apagadas (no se reenvían → ahorro de tokens);
      // las NUEVAS que agregues acá entran activas. Cada miniatura tiene su 📤.
      HPStills.fbInit(j.id, j.markerKey);
      var hint = document.createElement("div"); hint.className = "qj-fb-hint";
      hint.textContent = "Estás refinando lo ya generado: las imágenes adjuntas NO se reenvían (📤 para reactivar la que necesites). Las nuevas que agregues se envían solas. Las ✓ usar se incrustan igual.";
      fb.appendChild(hint);
      var mnt = document.createElement("div"); mnt.className = "qj-fb-stills";
      mnt.addEventListener("click", function (e) { e.stopPropagation(); });
      mnt.appendChild(HPStills.createControl(j.markerKey, j.id));
      fb.appendChild(mnt);
    } else {
      var note = document.createElement("div"); note.className = "qj-msg";
      note.textContent = "Para adjuntar imágenes a este marcador, abrí su secuencia en la pestaña Marcadores.";
      fb.appendChild(note);
    }
    return fb;
  }

  // Panel de cola global: agrupado por secuencia, con reordenamiento
  // (secuencia arriba/abajo y marcador arriba/abajo dentro de su secuencia).
  function render(jobs) {
    var panel = document.getElementById("queue-panel");
    if (!panel) return;
    var scroller = document.getElementById("view-queue");
    var savedScroll = scroller ? scroller.scrollTop : 0;
    var pending = 0, waiting = 0, i;
    for (i = 0; i < jobs.length; i++) {
      if (HPQueue.isPending(jobs[i].status)) pending++;
      else if (jobs[i].status === "waiting") waiting++;
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
      HPWidgets.confirmOverlay("Vaciar la cola", function (body) {
        var p = document.createElement("p");
        p.textContent = "Se van a quitar los " + n + " marcador(es) de la cola, incluido el que esté procesando. " +
          "Lo que ya está en vuelo (IA o render) termina en segundo plano pero su resultado se descarta. No borra archivos ya generados en disco.";
        body.appendChild(p);
      }, "Vaciar (" + n + ")", function () { HPQueue.clearAll(); deps.setOutput("Cola vaciada.", false); });
    });
    head.appendChild(wipe);
    // Limpiar versiones viejas: borra del disco los videos de versiones NO-últimas
    // de cada marcador (conserva HTMLs). Corre sobre todas las secuencias de la cola.
    var cleanBtn = document.createElement("button"); cleanBtn.type = "button"; cleanBtn.className = "queue-clear";
    cleanBtn.textContent = "🧹 limpiar versiones viejas";
    cleanBtn.title = "Borra del disco los videos de versiones anteriores de cada marcador (deja solo la última). Conserva los HTMLs y el historial.";
    cleanBtn.addEventListener("click", function () { cleanOldVersions(); });
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
      // Render HQ (secuencia): solo si hay ≥1 clip MEJORABLE (opaco hecho en
      // borrador). Alpha y opacos ya en alta no cuentan (Render HQ sería no-op).
      var upgradable = g.jobs.filter(function (j) {
        return j.status === "done" && HPQueue.isUpgradable(j);
      }).length;
      if (upgradable > 0) {
        var hqSeq = g.seqName;
        var hq = iconBtn("Render HQ", "Re-renderiza en alta los clips CON FONDO que se hicieron en borrador de esta secuencia", function () { renderSeqHQ(hqSeq); });
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
        // El nombre del clip terminado es clickeable = "Ver": abre la secuencia,
        // salta al marcador y lo carga/enfoca en la pestaña Marcadores.
        if (j.status === "done") {
          top.classList.add("qj-title-link");
          top.setAttribute("title", "Ver: abrir esta secuencia, saltar al marcador y cargarlo en Marcadores");
          top.addEventListener("click", (function (job) { return function (e) { e.stopPropagation(); deps.goToJobMarker(job); }; })(j));
        }
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
        } else if (HPQueue.isActive(j.status)) {
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
          // (El "Ver" ahora es clic en el nombre del clip — ver arriba.)
          // Render HQ SOLO tiene sentido en clips OPACOS (con fondo/mp4): ahí el
          // borrador usa JPEG 80 y HQ sube a 95. En clips con ALPHA el borrador ya
          // sale en PNG lossless → ProRes 4444 (máxima calidad), así que NO se ofrece.
          if (j.kind !== "renderVersionHQ" && HPQueue.isUpgradable(j)) {
            var hqb = iconBtn("Render HQ", "Re-renderizar este marcador opaco en alta calidad (el borrador usó compresión mayor)",
              (function (job) { return function () { renderJobHQ(job); }; })(j));
            hqb.className = "qbtn qbtn-hq"; dc.appendChild(hqb);
          }
          if (j.kind === "generate" || j.kind === "feedback") {
            dc.appendChild(iconBtn("✎ Feedback", "Dar feedback y regenerar (mantiene el puesto en la cola)",
              (function (id) { return function () {
                var willOpen = !feedbackOpen[id];
                feedbackOpen = {}; // solo una caja de feedback abierta a la vez
                if (willOpen) feedbackOpen[id] = true;
                render(HPQueue.jobs());
              }; })(j.id)));
            dc.appendChild(iconBtn("✎ Editar HTML", "Editar el HTML de este marcador y renderizarlo de nuevo (en la pestaña Marcadores)",
              (function (job) { return function () { deps.goToJobMarker(job, true); }; })(j)));
          }
          line.appendChild(dc);
        }
        row.appendChild(line);
        var msg = document.createElement("div"); msg.className = "qj-msg"; msg.textContent = j.msg || j.status;
        row.appendChild(msg);
        // Caja de feedback inline (solo en jobs terminados y si el usuario la abrió).
        if (j.status === "done" && feedbackOpen[j.id]) {
          row.appendChild(buildFeedbackBox(j));
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

  global.HPQueueView = {
    /** Cablea las dependencias del panel. Llamar UNA vez antes de renderizar. */
    init: function (d) { deps = d; },
    render: render
  };
})(typeof window !== "undefined" ? window : this);
