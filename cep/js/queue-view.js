/**
 * HPQueueView — vista de la pestaña Cola: lista agrupada por secuencia con
 * controles (reordenar, pausar, reactivar, feedback inline, Render HQ,
 * limpiar versiones viejas) y el estimado de tiempo/tokens/costo pendiente.
 *
 * Solo DOM: el estado vive en HPQueue (y la selección de imágenes de
 * feedback en HPStills). Deps de main vía init(deps):
 *   goToJobMarker(job, openEditor) → abrir secuencia + enfocar la tarjeta
 *   showJobInTimeline(job)        → llevar el timeline al recurso, y nada más
 *   currentSequence()             → la secuencia abierta, para el filtro
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

  // Filtro "ver solo esta secuencia". Es una preferencia de cómo MIRAR la cola,
  // no un estado del trabajo, así que vive en localStorage y no en queue.json:
  // se recuerda entre sesiones y no viaja con el proyecto.
  var ONLY_CURRENT_KEY = "hyperpremiere::queue-only-current";
  function onlyCurrentSeq() {
    try { return global.localStorage.getItem(ONLY_CURRENT_KEY) === "1"; } catch (e) { return false; }
  }
  function setOnlyCurrentSeq(v) {
    try { global.localStorage.setItem(ONLY_CURRENT_KEY, v ? "1" : "0"); } catch (e) {}
  }

  // ── Reloj y estado en vivo de los jobs activos ───────────────────────
  // Dos cosas cambian cuando la cola NO emite: el tiempo, que corre solo, y lo
  // que el modelo está haciendo, que llega varias veces por segundo (ver `act`
  // en queue.js). Ninguna de las dos puede redibujar la cola: el re-render
  // borraría lo que el editor esté tipeando en una caja de feedback y le
  // movería el scroll. Por eso render() anota los NODOS de cada job activo y
  // este tic los va pisando por referencia, una vez por segundo.
  var liveRows = [];
  var liveTimer = null;

  // Cuánto puede pasar sin una sola novedad del modelo antes de que valga la
  // pena decirlo. Los avisos llegan cada pocos segundos, así que un minuto
  // callado ya es raro: puede ser una herramienta larga o un CLI trabado, y el
  // editor merece poder distinguirlo del "está pensando".
  var SIN_NOVEDAD_MS = 60000;

  // La segunda línea de un job activo: qué está haciendo el modelo ahora. Si el
  // proveedor no sabe contarlo, se dice —callado quedaría igual que colgado, y
  // un texto decorativo que rote solo sería mentir.
  function liveDetail(j) {
    if (j.act && j.act.label) {
      var quieto = j.act.at ? (Date.now() - j.act.at) : 0;
      // El reloj de arriba sigue corriendo igual; lo que se agrega acá es que
      // ese tiempo NO es de algo que esté avanzando a la vista.
      return "↳ " + j.act.label +
        (quieto > SIN_NOVEDAD_MS ? " · sin novedad hace " + fmtDuration(quieto / 1000) : "");
    }
    // Sin detalle: puede ser el hueco entre dos llamadas al modelo (el
    // proveedor sí informa, ver _actSeen) o un proveedor que no lo informa
    // nunca —API directa, Ollama—, y ahí conviene decirlo.
    if (j.status === "modeling" && !j._actSeen && j.startedAt && (Date.now() - j.startedAt) > 15000) {
      return "↳ este proveedor no informa el detalle de lo que hace";
    }
    // En el render no hay nada que "contar", pero sí cuánto debería tardar:
    // la cola ya tiene calibrado su ritmo con los renders anteriores.
    if (j.status === "running" && HPQueue.timing.calibrated() && Number(j.markerDuration) > 0) {
      return "↳ estimado ≈ " + fmtDuration(HPQueue.timing.estimateSec(0, j.markerDuration));
    }
    return "";
  }

  function tickLive() {
    for (var i = 0; i < liveRows.length; i++) {
      var r = liveRows[i], j = r.job;
      if (r.clk) r.clk.textContent = j.startedAt ? "⏱ " + fmtDuration((Date.now() - j.startedAt) / 1000) : "";
      if (r.fill) r.fill.style.width = (j.pct || 0) + "%";
      if (r.act) {
        var txt = liveDetail(j);
        r.act.textContent = txt;
        r.act.setAttribute("data-hidden", txt ? "false" : "true");
      }
    }
  }

  // Arranca el tic si hay algo vivo que mirar y lo apaga si no: un intervalo
  // corriendo sobre nodos que ya no están en el DOM es una fuga silenciosa.
  function syncLiveClock() {
    if (liveRows.length && !liveTimer) liveTimer = setInterval(tickLive, 1000);
    if (!liveRows.length && liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    if (liveRows.length) tickLive(); // que el primer dibujo ya salga con la hora puesta
  }

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
  // Cada `target` es { projectPath, sequenceName } y, si la limpieza es de un
  // solo recurso, además markerSlug. El orden importa y no es negociable: si se
  // borrara del disco primero, Premiere se queda con clips apuntando a archivos
  // que no están y te recibe con el cartel de "Link Media".
  function performCleanup(targets) {
    deps.setOutput("🧹 Limpiando versiones viejas…", false);
    hpLog("Limpiando versiones viejas en " + targets.length + " secuencia(s)…");
    var listPromises = targets.map(function (t) {
      return HPEngine.call("listOldVersions", t).then(function (r) { return (r && r.ok) ? (r.files || []) : []; }).catch(function () { return []; });
    });
    Promise.all(listPromises).then(function (lists) {
      // Rutas completas, no nombres: es la identidad del clip (ver purgeClipsByPath).
      var rutas = [];
      lists.forEach(function (files) { files.forEach(function (f) { if (f && f.path) rutas.push(f.path); }); });
      if (!rutas.length) { deps.setOutput("🧹 No hay versiones viejas para limpiar.", false); return; }
      // Paso 2: sacarlos de secuencia + proyecto ANTES de borrar (evita re-vincular).
      HPHost.purgeClipsByPath(rutas, function (purge) {
        hpLog("purge en Premiere: " + purge + " (" + rutas.length + " archivo(s))");
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

  /**
   * Muestra el detalle (qué se borra ↔ qué se conserva) y pide confirmación;
   * recién al aceptar borra. El detalle lo arma el MOTOR mirando el disco, así
   * que la pregunta dice lo mismo trate de una secuencia entera o de un solo
   * recurso: lo que cambia es qué targets se le pasan.
   * `nada` = qué decir cuando no hay nada viejo que borrar.
   */
  function confirmAndClean(targets, titulo, nada) {
    var previewPromises = targets.map(function (t) {
      return HPEngine.call("cleanupPreview", t)
        .then(function (r) { return (r && r.ok) ? r : { groups: [], totalDeletes: 0, totalBytes: 0, sequenceName: t.sequenceName }; })
        .catch(function () { return { groups: [], totalDeletes: 0, totalBytes: 0, sequenceName: t.sequenceName }; });
    });
    Promise.all(previewPromises).then(function (previews) {
      var totalDeletes = 0, totalBytes = 0;
      previews.forEach(function (p) { totalDeletes += p.totalDeletes || 0; totalBytes += p.totalBytes || 0; });
      if (!totalDeletes) { deps.setOutput(nada, false); return; }
      HPWidgets.confirmOverlay(titulo, function (body) {
        var intro = document.createElement("p");
        var strong = document.createElement("strong"); strong.textContent = totalDeletes + " video(s)";
        intro.appendChild(document.createTextNode("Se van a borrar "));
        intro.appendChild(strong);
        intro.appendChild(document.createTextNode(" viejos (" + (totalBytes / 1048576).toFixed(1) + " MB) del disco y de las " +
          "secuencias donde estén. Se conserva la última versión. Los HTMLs no se tocan: podés volver sobre una versión vieja desde Corrections."));
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

  /**
   * "🧹 Limpiar previas" de un job terminado: borra las versiones ANTERIORES de
   * ESE recurso y deja la que el editor acaba de aprobar. Es el momento real de
   * fin de clase — quedaste conforme con la v5 y las cuatro anteriores son
   * cientos de MB que además Premiere sigue mostrando en el proyecto—, y va por
   * marcador porque los otros pueden estar a medio revisar.
   */
  function cleanJobPrevious(job) {
    confirmAndClean([{
      projectPath: job.projectPath,
      // La carpeta del recurso es la de la secuencia donde NACIÓ: en una
      // corrección no es la que estás mirando.
      sequenceName: job.storeSeqName || job.seqName,
      markerSlug: job.markerKey
    }], "Limpiar las versiones previas de " + job.markerKey,
      "🧹 " + job.markerKey + " no tiene versiones anteriores: no hay nada que borrar.");
  }

  // Botón "limpiar versiones viejas": lo mismo para TODAS las secuencias de la cola.
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
    confirmAndClean(targets, "Limpiar versiones viejas", "🧹 No hay versiones viejas para limpiar.");
  }

  // Costo estimado de la cola, auto-calibrado con lo REAL de esta sesión.
  //
  // Se calibra por GENERACIÓN, no por token, y eso arregla dos cosas. La
  // primera: el $/token salía de dividir el costo por `inputTokens`, que en los
  // CLI de agente es el pedacito sin cachear —así que la tarifa daba cientos de
  // dólares por millón y el estimado de la cola era un disparate—. La segunda:
  // aunque se cuente la entrada completa, sumar los tokens de los proveedores
  // que NO informan costo (Cursor por suscripción) contra los dólares de los que
  // sí, mezcla dos cosas distintas. El promedio se saca solo de las generaciones
  // que informaron costo, que es la única muestra con las dos mitades.
  // Local = gratis; sin muestra todavía = se calcula al correr.
  function estimateCostLabel(aiJobCount) {
    if (HPConfigUI.isLocalProvider()) return "gratis (local)";
    var u = HPStore.getSessionUsage();
    if (u && u.costUsd > 0 && u.costGenerations > 0) {
      var est = aiJobCount * (u.costUsd / u.costGenerations);
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
    // La cola sabe cuántos diseños y cuántos renders corren en paralelo, así que
    // la cuenta la hace ella (ver timing.estimateSec).
    var timeSec = HPQueue.timing.estimateSec(genCount, compSec);

    var foot = document.createElement("div"); foot.className = "queue-estimate";
    var line1 = document.createElement("div"); line1.className = "qe-line";
    line1.textContent = "⏳ Pendiente: " + pend.length + " marcador(es) · vídeo total " + fmtDuration(compSec) +
      " · tiempo ≈ " + fmtDuration(timeSec) + (HPQueue.timing.calibrated() ? "" : " (aprox.)");
    foot.appendChild(line1);
    var line2 = document.createElement("div"); line2.className = "qe-line qe-tok";
    line2.textContent = "Tokens del prompt: calculando…";
    // Lo que se puede estimar es NUESTRO prompt, porque lo armamos nosotros. La
    // entrada real que después informa el contador es bastante mayor: los CLI de
    // agente le suman su propio contexto (~30k tokens) y lo releen en cada
    // llamada. Decirlo acá evita que los dos números parezcan contradecirse.
    line2.setAttribute("title", "Es el tamaño de lo que le mandamos (objetivo, guion, " +
      "instrucciones, imágenes). Con los CLI de agente, la entrada que termina contando el " +
      "medidor de sesión es mayor: cada llamada arrastra el contexto del propio agente.");
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
      line2.textContent = "Tokens del prompt (toda la cola): ≈ " + addThousands(total) +
        " · " + aiJobs.length + " llamada(s) a la IA · costo " + estimateCostLabel(aiJobs.length);
    }).catch(function () { line2.textContent = ""; });
  }

  // Cerrar la caja y olvidar lo que había: se llama al mandar, por cualquiera de
  // los dos caminos.
  function closeFeedback(id) {
    feedbackOpen[id] = false;
    feedbackDraft[id] = "";
    HPStills.fbClear(id);
  }

  // Caja de feedback inline de un job terminado: texto + refinar/regenerar +
  // control de imágenes con selección de reenvío.
  function buildFeedbackBox(j) {
    var fb = document.createElement("div"); fb.className = "qj-feedback-wrap";
    var inRow = document.createElement("div"); inRow.className = "qj-feedback";
    var ta = document.createElement("textarea"); ta.className = "qj-fb-input"; ta.rows = 2;
    ta.placeholder = "Qué ajustar… (se regenera manteniendo el puesto en la cola)";
    ta.value = feedbackDraft[j.id] || "";
    ta.addEventListener("input", function (e) { feedbackDraft[j.id] = e.target.value; });
    ta.addEventListener("click", function (e) { e.stopPropagation(); });
    inRow.appendChild(ta);
    // Sobre qué secuencia trabaja el material de este marcador. Es la del job,
    // NO la que el editor tenga abierta: con la cola de varias clases, o
    // corrigiendo algo generado en el corte anterior, no coinciden.
    var stillsOpts = {
      fbJobId: j.id, projectPath: j.projectPath,
      sequenceName: j.storeSeqName || j.seqName
    };
    // Las DOS salidas de una ronda de feedback, las mismas que ofrece la tarjeta
    // del marcador: refinar sobre lo que hay, o tirarlo y rediseñar. Antes acá
    // había un solo botón que hacía una cosa o la otra según si el cuadro tenía
    // texto, y para rediseñar desde cero había que irse a la pestaña Marcadores.
    var go = document.createElement("button"); go.type = "button"; go.className = "qbtn qbtn-react"; go.textContent = "↻ Refinar";
    go.title = "Ajusta sobre la última versión con tu feedback (mantiene lo que funciona y retoma el mismo puesto en la cola)";
    go.addEventListener("click", function (e) {
      e.stopPropagation();
      var t = (feedbackDraft[j.id] || "").trim();
      // Sin texto no hay refinamiento posible: antes esto salía como una
      // regeneración total y el editor se enteraba al ver el resultado.
      if (!t) {
        deps.setOutput("Escribí qué ajustar para refinar, o usá “Regenerar desde cero”.", true);
        return;
      }
      // Índices de las imágenes que el usuario dejó activas (📤) para reenviar.
      var sendIdx = HPStills.fbCollect(j.id, j.markerKey, stillsOpts);
      closeFeedback(j.id);
      HPQueue.regenerate(j.id, t, sendIdx);
    });
    inRow.appendChild(go);
    var fresh = document.createElement("button"); fresh.type = "button"; fresh.className = "qbtn qbtn-fresh"; fresh.textContent = "⟲ Regenerar desde cero";
    fresh.title = "Descarta el diseño anterior y vuelve a diseñar con la instrucción y el material de hoy. " +
      "No usa el texto de este cuadro. Pregunta antes.";
    // SIEMPRE pregunta. Está pegado a Refinar y las dos palabras se parecen, así
    // que el error de puntería es esperable: sin confirmación, un clic de más
    // tira una animación que estaba bien y arranca una generación entera.
    fresh.addEventListener("click", function (e) {
      e.stopPropagation();
      var t = (feedbackDraft[j.id] || "").trim();
      HPWidgets.confirmOverlay("Regenerar desde cero", function (body) {
        var p = document.createElement("p");
        p.textContent = "¿Seguro querés generar esta animación desde cero? " +
          "Se descarta el diseño anterior y se vuelve a diseñar con la instrucción del marcador " +
          "y el material de hoy — es una generación completa, con su costo y su espera.";
        body.appendChild(p);
        if (t) {
          var q = document.createElement("p");
          q.textContent = "El feedback que escribiste NO se usa: desde cero no parte de la versión previa. " +
            "Si lo que querés es aplicarlo, cerrá esto y dale “↻ Refinar”.";
          body.appendChild(q);
        }
      }, "Regenerar desde cero", function () { closeFeedback(j.id); HPQueue.regenerateFresh(j.id); });
    });
    inRow.appendChild(fresh);
    fb.appendChild(inRow);
    // Imágenes/elementos para el feedback — mismo control que la tarjeta
    // (drag&drop + 📸 captura + etiqueta referencia/usar). Se agregan al
    // marcador y la regeneración los toma.
    //
    // Antes esto solo aparecía si el job era de la secuencia ABIERTA, y si no se
    // reemplazaba por un "abrí su secuencia en la pestaña Marcadores": una ronda
    // de feedback sin poder mandar una imagen, que es justo lo que hace falta
    // para arreglar un gráfico. El control ya sabe operar sobre otra secuencia.
    HPStills.fbInit(j.id); // selección de reenvío: todas activas, 📤 apaga
    var hint = document.createElement("div"); hint.className = "qj-fb-hint";
    hint.textContent = "Al refinar, las imágenes se envían otra vez: el modelo no recuerda la generación anterior. Usá 📤 si querés que alguna NO viaje. Las ✓ usar se incrustan igual.";
    fb.appendChild(hint);
    var mnt = document.createElement("div"); mnt.className = "qj-fb-stills";
    mnt.addEventListener("click", function (e) { e.stopPropagation(); });
    mnt.appendChild(HPStills.createControl(j.markerKey, stillsOpts));
    fb.appendChild(mnt);
    return fb;
  }

  // Panel de cola global: agrupado por secuencia, con reordenamiento
  // (secuencia arriba/abajo y marcador arriba/abajo dentro de su secuencia).
  function render(jobs) {
    var panel = document.getElementById("queue-panel");
    if (!panel) return;
    var prepSeq = (deps && deps.preparingSequence) ? deps.preparingSequence() : null;
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
    // Los nodos vivos del dibujo anterior ya no existen: se re-anotan abajo.
    liveRows = [];
    if (!jobs.length) {
      panel.innerHTML = '<div class="queue-empty">La cola está vacía. Encolá marcadores con “Enviar a la cola” o arrancá con “Generar”.</div>';
      syncLiveClock();
      return;
    }
    panel.innerHTML = "";

    var head = document.createElement("div"); head.className = "queue-head";
    var title = document.createElement("span");
    title.textContent = "Cola" + (pending ? " · " + pending + " en proceso/espera" : " · sin pendientes")
      + (waiting ? " · " + waiting + " esperando tokens ⏳" : "");
    head.appendChild(title);
    // Filtro "ver solo esta secuencia". La cola junta varias clases a propósito
    // —así se deja trabajando y se va— pero cuando estás sentado en una, lo de
    // las otras es ruido. No toca la cola: solo deja de dibujarlo, y los
    // contadores de al lado siguen siendo de todo.
    var actual = (deps && deps.currentSequence) ? String(deps.currentSequence() || "") : "";
    var otras = 0;
    for (i = 0; i < jobs.length; i++) if (jobs[i].seqName !== actual) otras++;
    var filtrando = false;
    if (actual && otras > 0) {
      filtrando = onlyCurrentSeq();
      var lab = document.createElement("label"); lab.className = "queue-filter";
      lab.title = "Muestra solo los marcadores de “" + actual + "”. No cambia la cola: " +
        "los de las otras secuencias siguen ahí y se procesan igual.";
      var cbx = document.createElement("input"); cbx.type = "checkbox"; cbx.checked = filtrando;
      cbx.addEventListener("change", function () {
        setOnlyCurrentSeq(cbx.checked);
        render(HPQueue.jobs());
      });
      lab.appendChild(cbx);
      lab.appendChild(document.createTextNode(" ver solo esta secuencia"));
      head.appendChild(lab);
    }
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

    var visibles = jobs;
    if (filtrando) {
      visibles = jobs.filter(function (j) { return j.seqName === actual; });
      var nota = document.createElement("div"); nota.className = "queue-filter-note";
      nota.textContent = visibles.length
        ? "Filtrado por “" + actual + "” · " + otras + " marcador(es) de otras secuencias ocultos"
        : "No hay nada de “" + actual + "” en la cola · " + otras + " marcador(es) de otras secuencias ocultos";
      panel.appendChild(nota);
    }

    // Agrupar por secuencia preservando el orden de proceso.
    var groups = [], map = {};
    for (i = 0; i < visibles.length; i++) {
      var jj = visibles[i];
      if (!map[jj.seqName]) { map[jj.seqName] = { seqName: jj.seqName, jobs: [] }; groups.push(map[jj.seqName]); }
      map[jj.seqName].jobs.push(jj);
    }

    groups.forEach(function (g, gi) {
      var queuedInGroup = g.jobs.filter(function (j) { return j.status === "queued"; }).length;
      var gh = document.createElement("div"); gh.className = "queue-seq";
      var gname = document.createElement("span"); gname.className = "qs-name"; gname.textContent = g.seqName;
      gh.appendChild(gname);
      // Contexto de la secuencia: saber de un vistazo si ya tiene transcript y
      // objetivo, o si va a haber que transcribirla antes de generar.
      var ctx = (deps && deps.sequenceContext) ? deps.sequenceContext(g.seqName) : null;
      if (ctx) {
        var tag = document.createElement("span"); tag.className = "qs-ctx";
        if (ctx.hasTranscript && ctx.hasObjective) {
          tag.classList.add("is-ready");
          tag.textContent = "✓ transcript + objetivo";
          tag.title = "Esta secuencia ya tiene transcript y objetivo: se genera directo, sin transcribir.";
        } else if (ctx.hasTranscript) {
          tag.classList.add("is-ready");
          tag.textContent = "✓ transcript · falta objetivo";
          tag.title = "Ya tiene transcript. El objetivo se saca solo antes de generar.";
        } else if (g.seqName === prepSeq) {
          tag.classList.add("is-working");
          tag.textContent = "◔ transcribiendo…";
          tag.title = "Se está transcribiendo ahora (mirá el progreso arriba).";
        } else {
          tag.classList.add("is-missing");
          tag.textContent = "falta transcript";
          tag.title = "No tiene transcript: antes de generar se transcribe y se saca el objetivo.";
        }
        gh.appendChild(tag);
      }
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
        // Nodos de este job que se refrescan solos (reloj, estado del modelo,
        // barra). Se llena abajo y solo se registra si el job está activo.
        var liveJob = { job: j, clk: null, act: null, fill: null };
        var line = document.createElement("div"); line.className = "qj-line";
        var top = document.createElement("div"); top.className = "qj-title";
        var dot = (j.status === "running") ? "▶ " : (j.status === "modeling") ? "✎ " : (j.status === "ready") ? "◔ " : (j.status === "queued") ? "• " : (j.status === "done") ? "✓ " : (j.status === "waiting") ? "⏳ " : "⚠ ";
        top.textContent = dot + j.label;
        // El nombre del clip terminado lleva al timeline y nada más: abre su
        // secuencia y para el cursor donde está el recurso, para poder verlo.
        // Antes también cambiaba a la pestaña Marcadores y la recargaba, y eso
        // era un viaje de ida: por mirar un clip de cinco segundos se perdía la
        // cola. A Marcadores se sigue llegando con "✎ Editar HTML".
        if (j.status === "done") {
          top.classList.add("qj-title-link");
          top.setAttribute("title", "Ver en el timeline: abre “" + j.seqName + "” y lleva el cursor a este punto");
          top.addEventListener("click", (function (job) { return function (e) { e.stopPropagation(); deps.showJobInTimeline(job); }; })(j));
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
          // Reloj de la corrida: el dato que faltaba para saber si un marcador
          // que lleva tres minutos es normal o se colgó. Lo actualiza tickLive.
          var clk = document.createElement("span"); clk.className = "qj-clock";
          line.appendChild(clk);
          liveJob.clk = clk;
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
          // Render hecho y clip afuera: lo único que falta es colocarlo, y va
          // primero y destacado. Antes acá solo estaba ✎ Feedback, que gasta
          // otra generación entera para repetir un .mov que ya está en disco.
          if (HPQueue.needsPlacing(j)) {
            var pb = iconBtn("📌 Colocar",
              "El render ya está hecho: colocar el clip en “" + j.seqName + "” sin volver a generar. " +
              "Si falló porque estabas en otro proyecto o la secuencia estaba cerrada, abrilos y probá de nuevo.",
              (function (id) { return function () { HPQueue.placeAgain(id); }; })(j.id));
            pb.className = "qbtn qbtn-react"; dc.appendChild(pb);
          }
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
          // Limpiar las versiones previas de ESTE recurso, cuando el editor ya
          // quedó conforme. No se ofrece en una v1 (no hay nada anterior); si no
          // sabemos la versión —un job que quedó de otra sesión— se ofrece igual
          // y el detalle de la confirmación lo dice.
          if (!(j.version > 0 && j.version < 2)) {
            dc.appendChild(iconBtn("🧹 Limpiar previas",
              "Borra las versiones anteriores de este recurso: del disco y de las secuencias donde estén. " +
              "Conserva esta última y los HTMLs.",
              (function (job) { return function () { cleanJobPrevious(job); }; })(j)));
          }
          line.appendChild(dc);
        }
        row.appendChild(line);
        var msg = document.createElement("div"); msg.className = "qj-msg";
        // Un job en cola mientras se prepara el contexto de SU secuencia no está
        // simplemente "en cola": espera el transcript. Decirlo evita que parezca
        // que la cola se colgó (el progreso está en el cartel de arriba).
        if (j.status === "queued" && prepSeq && j.seqName === prepSeq) {
          msg.textContent = "Esperando el transcript de la secuencia…";
          msg.classList.add("qj-msg-waiting");
        } else {
          msg.textContent = j.msg || j.status;
        }
        row.appendChild(msg);
        // Lo que el modelo está haciendo AHORA, debajo de la etapa. Es la línea
        // que resuelve el "no sé si avanza": la etapa ("Diseñando la animación
        // con X…") se escribe una vez y no cambia en varios minutos.
        if (HPQueue.isActive(j.status)) {
          var act = document.createElement("div"); act.className = "qj-act";
          act.setAttribute("data-hidden", "true");
          row.appendChild(act);
          liveJob.act = act;
        }
        // Caja de feedback inline (solo en jobs terminados y si el usuario la abrió).
        if (j.status === "done" && feedbackOpen[j.id]) {
          row.appendChild(buildFeedbackBox(j));
        }
        if (j.status === "running" || j.status === "modeling") {
          var bar = document.createElement("div"); bar.className = "hp-bar";
          var fill = document.createElement("div"); fill.className = "hp-bar-fill"; fill.style.width = (j.pct || 0) + "%"; bar.appendChild(fill);
          row.appendChild(bar);
          liveJob.fill = fill;
        }
        if (HPQueue.isActive(j.status)) liveRows.push(liveJob);
        panel.appendChild(row);
      });
    });
    renderQueueEstimate(panel, jobs);
    syncLiveClock();
    // Preservar el scroll de la vista de cola (se refresca seguido durante el proceso).
    if (scroller) scroller.scrollTop = savedScroll;
  }

  global.HPQueueView = {
    /** Cablea las dependencias del panel. Llamar UNA vez antes de renderizar. */
    init: function (d) { deps = d; },
    render: render,
    /**
     * Línea "qué está haciendo ahora" de un job activo ("" si no hay nada que
     * decir). La comparte la tarjeta del marcador (main.js), que muestra lo
     * mismo en otro lugar: dos redacciones del mismo estado envejecerían
     * distinto.
     */
    activityLine: liveDetail
  };
})(typeof window !== "undefined" ? window : this);
