/**
 * HPQueue — cola global de generación/render (máquina de estados, sin DOM).
 *
 * Serial (uno a la vez → no revienta la RAM con varios renders), persiste
 * entre secuencias y por proyecto (queue.json), y procesa con un pipeline de
 * 2 carriles: MODELO (nube) y RENDER (local) — el modelo del siguiente
 * marcador puede correr mientras el actual renderiza, salvo proveedor local.
 *
 * Estados de un job:
 *   queued → modeling → ready → running → done
 *                    ↘ waiting (sin tokens; se reactiva a mano)
 *                    ↘ error   (reintentable desde el punto de fallo)
 *
 * Lo que la cola necesita del resto del panel entra por HPQueue.init(deps):
 *   getContext()  → { projectPath, sequenceName } actuales del panel
 *   isLocalProvider() → true si el proveedor corre en esta máquina (no solapar)
 *   modelName()   → nombre del modelo activo (solo para el log)
 *   onUsage(u)    → acumular tokens consumidos (contador de sesión)
 *   placeClip(movPath, seqName, startSec, durationSec, colorLabel, cb)
 *   recolorClip(seqName, startSec, colorLabel, cb)
 *
 * Vanilla JS, sin ES modules: se expone como window.HPQueue.
 */
(function (global) {
  "use strict";

  var hpLog = HPLog.log;
  var fmtDuration = HPUtil.fmtDuration;
  var addThousands = HPUtil.addThousands;

  // Índices de etiqueta de color de Premiere (orden del menú Etiqueta):
  // café (marrón) = borrador; magenta = procesado en alta calidad.
  var COLOR_BROWN = 14;
  var COLOR_MAGENTA = 11;

  var deps = null; // lo llena init(); la cola no se usa antes de eso

  // ── Timing auto-calibrado (estimación de la cola) ────────────────────
  // Promedio de segundos por job de modelo, y segundos de render por segundo
  // de composición. Se afina con el uso real y persiste en localStorage.
  var TIMING = { modelJobs: 0, modelSec: 0, renderCompSec: 0, renderSec: 0 };
  try {
    var _t = JSON.parse(global.localStorage.getItem("hyperpremiere::timing") || "null");
    if (_t && typeof _t === "object") TIMING = _t;
  } catch (e) {}
  function saveTiming() { try { global.localStorage.setItem("hyperpremiere::timing", JSON.stringify(TIMING)); } catch (e) {} }
  function avgModelSec() { return TIMING.modelJobs > 0 ? (TIMING.modelSec / TIMING.modelJobs) : 150; }      // default ~2.5 min
  function renderSecPerCompSec() { return TIMING.renderCompSec > 0 ? (TIMING.renderSec / TIMING.renderCompSec) : 4; } // default 4×

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
      var projectPath = deps.getContext().projectPath;
      if (!projectPath) return; // proyecto sin guardar: no persistimos a carpeta
      var lean = [];
      for (var i = 0; i < jobs.length; i++) if (jobs[i].projectPath === projectPath) lean.push(serializeJob(jobs[i]));
      HPEngine.callProg("saveQueue", { projectPath: projectPath, jobs: lean })
        .then(function () {}).catch(function (e) { hpLog("saveQueue falló: " + ((e && e.message) || e), "WARN"); });
    }, 1000);
  }
  function markGenerated(job) {
    // Persistir el flag en el namespace del job (aunque estés en otra secuencia).
    try {
      var ctx = deps.getContext();
      HPStore.setContext(job.projectPath, job.seqName);
      HPStore.setMarkerGenerated(job.markerKey, true);
      HPStore.setContext(ctx.projectPath, ctx.sequenceName);
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

  // Fallo de una etapa: "sin tokens" queda en waiting (reactivable); el resto
  // en error. _failedStage permite reintentar desde el punto de fallo.
  function failJob(job, err, stage) {
    var f = classifyFailure(err);
    if (f.rate) {
      job.status = "waiting"; job.pct = 0;
      job.msg = "⏳ Sin tokens / límite alcanzado — esperá el reinicio y tocá ↻ Reactivar · " + shortenErr(f.msg);
    } else {
      job.status = "error"; job.msg = "Error: " + shortenErr(f.msg);
    }
    job._failedStage = stage;
    hpLog("Job " + (stage === "model" ? "MODELO" : "RENDER") + " FALLÓ [" + job.label + "] · rate=" + !!f.rate + " · " + f.msg, "ERROR");
  }

  function finishPlace(job, res) {
    // Job cancelado mientras renderizaba: no colocamos nada, liberamos el carril.
    if (job._cancelled) { renderBusy = false; hpLog("Job CANCELADO [" + job.label + "] tras render — descartado."); emit(); pump(); return; }
    job.version = res.version;
    if (res.usage && !job._usageCounted) { job.usage = res.usage; deps.onUsage(res.usage); job._usageCounted = true; }
    function done(msgTxt) {
      var dur = fmtDuration((Date.now() - job.startedAt) / 1000);
      var tok = job.usage ? " · " + addThousands(job.usage.inputTokens) + "↑ " + addThousands(job.usage.outputTokens) + "↓" : "";
      job.status = "done"; job.pct = 100;
      job.msg = msgTxt + " (v" + job.version + ")" + tok + " · " + dur;
      hpLog("Job DONE [" + job.label + "] v" + job.version + " · " + msgTxt + " · " + dur);
      // Calibración: segundos de render por segundo de composición.
      var _rs = job._renderStart ? (Date.now() - job._renderStart) / 1000 : 0;
      var _cs = Number(job.markerDuration) || 0;
      if (_rs > 1 && _cs > 0 && _rs < 7200) { TIMING.renderSec += _rs; TIMING.renderCompSec += _cs; saveTiming(); }
      markGenerated(job);
      renderBusy = false; emit(); pump();
    }
    // Render HQ = reemplazo en su lugar: el archivo ya se sobrescribió en disco;
    // NO colocamos clip nuevo, solo recoloreamos el clip existente a MAGENTA.
    if (res.replaced || job.kind === "renderVersionHQ") {
      job.pct = 98; job.msg = "Marcando como HQ (magenta)…"; emit();
      deps.recolorClip(job.seqName, job.markerStart, COLOR_MAGENTA, function (r) {
        done(r === "ok" ? "✓ HQ reemplazado (magenta)" : "HQ hecho; recoloreá a mano: " + r);
      });
      return;
    }
    // Color: café = "borrador mejorable con Render HQ" — SOLO aplica a clips
    // opacos (mp4) en borrador. Los clips con alpha ya salen en máxima calidad
    // (PNG→ProRes 4444) aunque estés en borrador → magenta.
    var isDraftOpaque = !!(job.payload && job.payload.draft && job.payload.background);
    var color = isDraftOpaque ? COLOR_BROWN : COLOR_MAGENTA;
    job.pct = 98; job.msg = "Colocando en " + job.seqName + "…"; emit();
    deps.placeClip(res.movPath, job.seqName, job.markerStart, job.markerDuration, color, function (place) {
      done(place === "ok" ? "✓ Listo y colocado" : "Render OK; colocá a mano: " + place);
    });
  }

  // Rehidrata lo pesado del payload (stills/transcript/recursos/objetivo) desde
  // HPStore justo antes de correr. Necesario para jobs restaurados de queue.json
  // (que se guardan livianos); en jobs frescos es idempotente.
  function rehydratePayload(job) {
    if (!job.payload) return;
    var ctx = deps.getContext();
    try {
      HPStore.setContext(job.projectPath, job.seqName);
      var segments = HPStore.getTranscript() || [];
      var md = HPStore.getMarkerData(job.markerKey) || {};
      var gen = HPStore.getMarkerData(HPStore.GENERAL_KEY) || {}; // prompt general
      job.payload.transcript = segments;
      job.payload.markerTranscript = HPTranscript.sliceByRange(segments, job.markerStart, job.markerStart + job.markerDuration);
      // Stills (visión) + assets (a incrustar) = marcador + generales.
      job.payload.assets = HPStore.getMarkerAssets(job.markerKey).concat(HPStore.getMarkerAssets(HPStore.GENERAL_KEY));
      // Refinamiento (adjust): solo reenviamos como visión las imágenes que el editor
      // dejó activas (stillsSend = índices en los stills del marcador). Ahorro de
      // tokens. Los assets "usar" se incrustan en el render igual, se reenvíen o no.
      if (job.payload.mode === "adjust" && Array.isArray(job.payload.stillsSend)) {
        var _all = md.stills || [];
        job.payload.stills = job.payload.stillsSend
          .map(function (ix) { return _all[ix]; })
          .filter(function (s) { return !!s; });
      } else {
        job.payload.stills = (md.stills || []).concat(gen.stills || []);
      }
      job.payload.resources = (md.resources || []).concat(gen.resources || []);
      if (!job.payload.generalInstruction) job.payload.generalInstruction = gen.instruction || "";
      if (!job.payload.objective) job.payload.objective = HPStore.getObjective();
      if (typeof job.payload.background !== "boolean") job.payload.background = !!md.background;
    } catch (e) { hpLog("rehydratePayload falló [" + job.label + "]: " + ((e && e.message) || e), "WARN"); }
    finally { try { HPStore.setContext(ctx.projectPath, ctx.sequenceName); } catch (e2) {} }
  }

  function startModel(job) {
    modelBusy = true; job.status = "modeling"; job.pct = 3; job.msg = "Diseñando…"; job.startedAt = Date.now();
    rehydratePayload(job); emit();
    var method = job.kind === "generate" ? "prepareGenerate" : "prepareFeedback";
    hpLog("Job MODELO [" + job.label + "] · " + method + " · modelo=" + (deps.modelName() || "?"));
    HPEngine.callProg(method, job.payload, onP(job)).then(function (prep) {
      if (job._cancelled) { modelBusy = false; hpLog("Job CANCELADO [" + job.label + "] tras modelo — descartado."); emit(); pump(); return; }
      if (!prep || !prep.ok) throw new Error(prep && prep.error ? prep.error : "error preparando");
      job.prepared = prep;
      if (prep.usage) { job.usage = prep.usage; deps.onUsage(prep.usage); job._usageCounted = true; }
      job.status = "ready"; job.msg = "En espera de render…";
      // Calibración: segundos que tardó el modelo (para estimar la cola).
      var _ms = (Date.now() - (job.startedAt || Date.now())) / 1000;
      if (_ms > 1 && _ms < 3600) { TIMING.modelJobs++; TIMING.modelSec += _ms; saveTiming(); }
      hpLog("Job MODELO ok [" + job.label + "] → listo para render");
      modelBusy = false; emit(); pump();
    }).catch(function (err) {
      if (job._cancelled) { modelBusy = false; emit(); pump(); return; }
      failJob(job, err, "model"); // falló el diseño → reintentar re-llama a la IA
      modelBusy = false; emit(); pump();
    });
  }

  function startRender(job) {
    renderBusy = true; job.status = "running"; if (!job.startedAt) job.startedAt = Date.now();
    job._renderStart = Date.now();
    job.msg = "Renderizando…"; emit();
    hpLog("Job RENDER [" + job.label + "] · kind=" + job.kind);
    var p = (job.kind === "renderManualHtml")
      ? HPEngine.callProg("renderManualHtml", job.payload, onP(job))
      : (job.kind === "renderVersionHQ")
        ? HPEngine.callProg("renderVersionHQ", job.payload, onP(job))
        : (job.kind === "renderLatest")
          ? HPEngine.callProg("renderLatest", job.payload, onP(job))
          : HPEngine.callProg("renderPrepared", job.prepared, onP(job));
    p.then(function (res) {
      if (!res || !res.ok) throw new Error(res && res.error ? res.error : "error desconocido");
      finishPlace(job, res);
    }).catch(function (err) {
      if (job._cancelled) { renderBusy = false; emit(); pump(); return; }
      failJob(job, err, "render"); // el modelo ya estaba OK; reintentar re-renderiza sin IA
      renderBusy = false; emit(); pump();
    });
  }

  function pump() {
    if (paused) return; // staging: no arrancar nuevos jobs
    // En local (Ollama) NO se solapa: modelo y render usan la misma máquina.
    var overlap = !deps.isLocalProvider();
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

  global.HPQueue = {
    /** Cablea las dependencias del panel. Llamar UNA vez antes de usar la cola. */
    init: function (d) { deps = d; },

    // Estimación de la cola (auto-calibrada con el uso real).
    timing: {
      avgModelSec: avgModelSec,
      renderSecPerCompSec: renderSecPerCompSec,
      calibrated: function () { return TIMING.modelJobs > 0 || TIMING.renderCompSec > 0; }
    },

    // Carga la cola guardada de un proyecto (queue.json). Reemplaza la cola en
    // memoria. Queda PAUSADA si hay pendientes: los ves y arrancás con Iniciar
    // (no auto-procesa al abrir, para no gastar tokens sin querer).
    restore: function (projectPath) {
      HPEngine.callProg("loadQueue", { projectPath: projectPath }).then(function (res) {
        var loaded = (res && res.jobs) || [];
        jobs = [];
        var hasPending = false;
        for (var i = 0; i < loaded.length; i++) {
          var lj = loaded[i];
          lj.status = normStatus(lj.status);
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
    regenerate: function (id, adjustmentText, stillsSend) {
      for (var i = 0; i < jobs.length; i++) {
        var j = jobs[i];
        if (j.id !== id) continue;
        if (j.kind !== "generate" && j.kind !== "feedback") return; // solo IA
        var txt = (adjustmentText || "").trim();
        j.payload = j.payload || {};
        if (txt) {
          j.payload.adjustment = txt; j.payload.mode = "adjust"; j.kind = "feedback";
          // Índices (en los stills del marcador) a reenviar como visión; [] = ninguno.
          j.payload.stillsSend = Array.isArray(stillsSend) ? stillsSend : [];
        }
        else { j.payload.mode = "generate"; j.kind = "generate"; delete j.payload.stillsSend; }
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
})(typeof window !== "undefined" ? window : this);
