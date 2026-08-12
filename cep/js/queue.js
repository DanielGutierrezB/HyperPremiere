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
 * Colabora con los otros módulos por sus globals (mismo patrón que todo el
 * panel): HPStore (contexto + datos del marcador + uso de sesión), HPEngine
 * (motor Node), HPHost (colocar/recolorear clips en Premiere), HPConfigUI
 * (proveedor activo) y HPTranscript. La UI se entera por HPQueue.on(cb).
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

  // ── Timing auto-calibrado (estimación de la cola) ────────────────────
  // Promedio de CARRIL-segundos por job de modelo, y carril-segundos de render por
  // segundo de composición. Se afina con el uso real y persiste en localStorage.
  //
  // La clave dice "v2" porque cambió la unidad: antes se guardaba tiempo de pared
  // de a un job por vez, y ahora corren varios a la vez, así que cada muestra se
  // guarda multiplicada por los carriles que estaban ocupados. Mezclar las dos
  // cosas en el mismo promedio daba estimaciones cada vez peores; con la clave
  // nueva la calibración vieja se descarta y se re-aprende sola.
  var TIMING = { modelJobs: 0, modelSec: 0, renderCompSec: 0, renderSec: 0 };
  try {
    var _t = JSON.parse(global.localStorage.getItem("hyperpremiere::timing-v2") || "null");
    if (_t && typeof _t === "object") TIMING = _t;
  } catch (e) {}
  function saveTiming() { try { global.localStorage.setItem("hyperpremiere::timing-v2", JSON.stringify(TIMING)); } catch (e) {} }
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

  // ── Vocabulario de estados (un solo lugar) ─────────────────────────
  // "activo" = tomado por el pipeline (modelando, esperando render o rendereando).
  function isActive(status) {
    return status === "modeling" || status === "ready" || status === "running";
  }
  // "pendiente" = va a procesarse (en cola o activo).
  function isPending(status) {
    return status === "queued" || isActive(status);
  }
  // "mejorable con Render HQ" = clip OPACO (con fondo/mp4) hecho en borrador.
  // Alpha siempre sale en ProRes 4444 (máxima calidad) → HQ sería un no-op.
  function isUpgradable(job) {
    return !!(job.payload && job.payload.draft && job.payload.background);
  }

  // ── Persistencia por proyecto (queue.json) ────────────────────────
  // Estados en curso (modeling/ready/running) se guardan como "queued": si
  // cerraste a mitad, al reabrir quedan pendientes (no colgados).
  function normStatus(s) {
    return isActive(s) ? "queued" : s;
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
      // Cuánto tardó cada etapa: el mensaje ya lo dice, pero guardar los números
      // deja que la vista los vuelva a componer sin parsear texto.
      _modelMs: j._modelMs, _renderMs: j._renderMs,
      _failedStage: j._failedStage, payload: p
    };
  }
  var persistTimer = null;
  function persist() {
    if (persistTimer) return; // debounce: 1 escritura por ventana; captura el estado al disparar
    persistTimer = setTimeout(function () {
      persistTimer = null;
      var projectPath = HPStore.getContext().projectPath;
      if (!projectPath) return; // proyecto sin guardar: no persistimos a carpeta
      var lean = [];
      for (var i = 0; i < jobs.length; i++) if (jobs[i].projectPath === projectPath) lean.push(serializeJob(jobs[i]));
      HPEngine.callProg("saveQueue", { projectPath: projectPath, jobs: lean })
        .then(function () {}).catch(function (e) { hpLog("saveQueue falló: " + ((e && e.message) || e), "WARN"); });
    }, 1000);
  }
  // Cuánto tardó ESTE recurso, guardado en el marcador. El mensaje de la cola
  // también lo dice, pero la cola se vacía: acá queda para cuando el editor
  // mire el marcador la semana que viene y quiera saber qué le costó.
  function saveMarkerTimings(job) {
    try {
      HPStore.withContext(job.projectPath, job.seqName, function () {
        HPStore.setMarkerTimings(job.markerKey, {
          modelMs: job._modelMs || 0,
          renderMs: job._renderMs || 0,
          totalMs: job._totalMs || 0,
          version: job.version || 0,
          at: Date.now()
        });
      });
    } catch (e) {}
  }

  function markGenerated(job) {
    // Persistir el flag en el namespace del job (aunque estés en otra secuencia).
    try {
      HPStore.withContext(job.projectPath, job.seqName, function () {
        HPStore.setMarkerGenerated(job.markerKey, true);
      });
    } catch (e) {}
  }

  // Pipeline de 2 carriles: MODELO (nube) y RENDER (local).
  //  - RENDER: SIEMPRE de a uno (cada render es un Chrome capturando frames;
  //    varios revientan la RAM).
  //  - MODELO (LLM): el trabajo en la nube NO compite por recursos locales, así
  //    que corren VARIOS en paralelo (hasta MODEL_CONCURRENCY) → para un lote,
  //    los diseños se resuelven solapados en vez de uno por uno. Con proveedor
  //    LOCAL (Ollama) el modelo usa la máquina: se fuerza a 1 y no se solapa
  //    con el render.
  var modelRunning = 0;
  // Carriles de render OCUPADOS: se guardan los jobs, no un número. Con un
  // contador, cualquier camino que se olvide de restar (o que reste dos veces)
  // deja la cola trabada para siempre sin que nada lo note; con la lista, tomar y
  // soltar son operaciones sobre el job y soltar dos veces no hace nada.
  var renderInFlight = [];
  function renderRunning() { return renderInFlight.length; }
  function takeRenderLane(job) { renderInFlight.push(job); }
  function releaseRenderLane(job) {
    var i = renderInFlight.indexOf(job);
    if (i >= 0) renderInFlight.splice(i, 1);
  }
  // Techo del carril de RENDER. Arranca en 1 (lo de siempre) y el panel lo sube a
  // lo que aguante la máquina en cuanto engineStatus le contesta: en un M3 Max
  // dos renders a la vez bajaron el tiempo de un lote 32% sin ralentizar ninguno
  // y con los .mov idénticos byte a byte (ver renderLanes en render/hyperframes.js).
  var renderConcurrency = 1;
  // En local (Ollama) el modelo usa la misma máquina que el render: ahí no se
  // paraleliza nada, se rinde de a uno.
  function renderCap() { return HPConfigUI.isLocalProvider() ? 1 : renderConcurrency; }
  // Techo de llamadas al LLM en paralelo (solo nube). Configurable desde el
  // panel; conservador por defecto para no disparar rate limits (el flujo
  // waiting→reactivar ya cubre los 429, pero mejor no provocarlos).
  var MODEL_CONCURRENCY_DEFAULT = 3;
  var modelConcurrency = MODEL_CONCURRENCY_DEFAULT;
  try {
    var _mc = parseInt(global.localStorage.getItem("hyperpremiere::model-concurrency"), 10);
    if (!isNaN(_mc) && _mc >= 1 && _mc <= 8) modelConcurrency = _mc;
  } catch (e) {}
  // Cupo efectivo de modelo AHORA: 1 en local (comparte máquina), el techo en nube.
  function modelCap() { return HPConfigUI.isLocalProvider() ? 1 : modelConcurrency; }
  // paused: la cola no ARRANCA nuevos jobs (los que corren terminan). Sirve
  // para "Enviar a la cola" (staging) sin que empiece a procesar.
  var paused = false;

  function onP(job) {
    return function (p) {
      if (!p) return;
      var visible = false;
      if (typeof p.pct === "number") { job.pct = Math.max(0, Math.min(100, p.pct)); visible = true; }
      if (p.msg) { job.msg = p.msg; visible = true; }
      if (p.usage) { job.usage = p.usage; visible = true; }
      // "note": lo que el motor quiere dejar por escrito y no cabe en la barra
      // (qué reparó del contrato, por qué gastó una llamada extra, con qué
      // configuración renderizó). Va al ⬇ Log, que es donde se diagnostica, con
      // el nivel que mande el motor: varias notas son avisos, no información.
      if (p.note) { hpLog("[" + job.label + "] " + p.note, p.level); visible = true; }
      // "act": qué está haciendo el modelo AHORA (razonando, leyendo una imagen,
      // escribiendo la composición). Llega varias veces por segundo, así que
      // NO emite: emitir redibuja la cola entera y encima agenda una escritura
      // de queue.json. Lo levanta el reloj de la vista en su próximo tic, que
      // ya corre por el temporizador. Se distingue `act: null` (la etapa
      // terminó, hay que borrar la línea) de que no venga el campo.
      if (Object.prototype.hasOwnProperty.call(p, "act")) {
        job.act = (p.act && p.act.label) ? { label: p.act.label, phase: p.act.phase, at: Date.now() } : null;
        // Que este proveedor SÍ sabe contar lo que hace se aprende una sola vez
        // y no se olvida entre llamada y llamada: si no, en el hueco entre el
        // diseño y una corrección el panel decía "este proveedor no informa el
        // detalle" justo del que sí informa.
        if (job.act) job._actSeen = true;
      }
      if (visible) emit();
    };
  }

  // Fallo de una etapa: "sin tokens" queda en waiting (reactivable); el resto
  // en error. _failedStage permite reintentar desde el punto de fallo.
  function failJob(job, err, stage) {
    var f = classifyFailure(err);
    job.act = null; // lo que estaba haciendo cuando falló ya no es el estado
    if (f.rate) {
      job.status = "waiting"; job.pct = 0;
      job.msg = "⏳ Sin tokens / límite alcanzado — esperá el reinicio y tocá ↻ Reactivar · " + shortenErr(f.msg);
    } else {
      job.status = "error"; job.msg = "Error: " + shortenErr(f.msg);
    }
    job._failedStage = stage;
    hpLog("Job " + (stage === "model" ? "MODELO" : "RENDER") + " FALLÓ [" + job.label + "] · rate=" + !!f.rate + " · " + f.msg, "ERROR");
  }

  // Acumula el uso de tokens en el contador de sesión y avisa a la UI.
  function countUsage(job, usage) {
    if (!usage || job._usageCounted) return;
    job.usage = usage;
    HPStore.addSessionUsage(usage);
    job._usageCounted = true;
    emit();
  }

  // Las llamadas al host son callback-style (CEP): acá se vuelven promesas para
  // que colocar-y-cerrar sea una sola cadena y el carril se libere en un solo
  // lugar (ver startRender). Nunca rechazan: el host contesta "ok" o "error: …".
  function hostRecolorHQ(job) {
    return new Promise(function (resolve) {
      HPHost.recolorClip(job.seqName, job.markerStart, COLOR_MAGENTA, resolve);
    });
  }
  // ¿El .mov que vamos a colocar trae audio? La pregunta la contesta el motor
  // con ffprobe: adentro de Premiere no hay con qué abrir el archivo. El host lo
  // necesita para NO agregar una pista de audio vacía con cada animación muda
  // (que son todas las de hoy) — eso le corría las pistas al editor. Si no se
  // puede saber, se asume mudo: es lo que deja la secuencia como está, y el
  // sonido del clip, si lo hubiera, Premiere lo baja igual.
  function movHasAudio(movPath) {
    return HPEngine.call("mediaHasAudio", { path: movPath }).then(function (r) {
      if (r && r.ok === false) hpLog("No pude saber si el video trae audio (¿ffprobe?): lo coloco como mudo.", "WARN");
      return !!(r && r.hasAudio);
    }).catch(function (e) {
      hpLog("mediaHasAudio falló: " + ((e && e.message) || e) + " — coloco el clip como mudo.", "WARN");
      return false;
    });
  }
  function hostPlace(job, movPath, color) {
    return movHasAudio(movPath).then(function (hasAudio) {
      return new Promise(function (resolve) {
        HPHost.placeClip(movPath, job.seqName, job.markerStart, job.markerDuration, color, hasAudio, resolve);
      });
    });
  }

  // Cuánto tardó cada ETAPA, para el mensaje del job terminado. Son dos trabajos
  // muy distintos (la nube pensando vs. tu máquina renderizando) y saber cuál se
  // llevó el tiempo es lo que dice si conviene bajar el nivel de pensamiento o
  // achicar el marcador. NO suman el total a propósito: entre una y otra el job
  // puede haber esperado un carril de render libre, y colocar el clip en
  // Premiere va después.
  function stageBreakdown(job) {
    var partes = [];
    if (job._modelMs > 0) partes.push("IA " + fmtDuration(job._modelMs / 1000));
    if (job._renderMs > 0) partes.push("render " + fmtDuration(job._renderMs / 1000));
    return partes.length ? " (" + partes.join(" · ") + ")" : "";
  }

  function markDone(job, msgTxt) {
    // Tiempo de pared del recurso, salvo en el reintento de SOLO render: ahí el
    // diseño se pagó antes de que este reloj arrancara, así que manda la suma
    // de las etapas (si no, el total quedaba más chico que una de sus partes).
    job._totalMs = Math.max(Date.now() - job.startedAt, (job._modelMs || 0) + (job._renderMs || 0));
    var dur = fmtDuration(job._totalMs / 1000);
    var tok = job.usage ? " · " + addThousands(job.usage.inputTokens) + "↑ " + addThousands(job.usage.outputTokens) + "↓" : "";
    job.status = "done"; job.pct = 100; job.act = null;
    job.msg = msgTxt + " (v" + job.version + ")" + tok + " · " + dur + stageBreakdown(job);
    hpLog("Job DONE [" + job.label + "] v" + job.version + " · " + msgTxt + " · " + dur);
    // Calibración en CARRIL-segundos: lo medido es tiempo de pared, y si el render
    // compartió la máquina con otro, tardó más por eso. Guardar el tiempo × los
    // carriles que había deja la muestra comparable con las de un carril solo, y
    // así la estimación puede dividir por el cupo sin mezclar unidades.
    var _rs = job._renderStart ? (Date.now() - job._renderStart) / 1000 : 0;
    var _cs = Number(job.markerDuration) || 0;
    if (_rs > 1 && _cs > 0 && _rs < 7200) {
      TIMING.renderSec += _rs * (job._renderLanes || 1);
      TIMING.renderCompSec += _cs;
      saveTiming();
    }
    markGenerated(job);
    saveMarkerTimings(job);
  }

  // Coloca el resultado en Premiere y cierra el job. Devuelve una promesa que
  // siempre se cumple; el carril lo libera quien la encadena.
  function finishPlace(job, res) {
    job.version = res.version;
    countUsage(job, res.usage);
    // Render HQ = reemplazo en su lugar: el archivo ya se sobrescribió en disco;
    // NO colocamos clip nuevo, solo recoloreamos el clip existente a MAGENTA.
    if (res.replaced || job.kind === "renderVersionHQ") {
      job.pct = 98; job.msg = "Marcando como HQ (magenta)…"; emit();
      return hostRecolorHQ(job).then(function (r) {
        markDone(job, r === "ok" ? "✓ HQ reemplazado (magenta)" : "HQ hecho; recoloreá a mano: " + r);
      });
    }
    // Color: café = "borrador mejorable con Render HQ" — SOLO aplica a clips
    // opacos (mp4) en borrador. Los clips con alpha ya salen en máxima calidad
    // (PNG→ProRes 4444) aunque estés en borrador → magenta.
    var color = isUpgradable(job) ? COLOR_BROWN : COLOR_MAGENTA;
    job.pct = 98; job.msg = "Colocando en " + job.seqName + "…"; emit();
    return hostPlace(job, res.movPath, color).then(function (place) {
      markDone(job, place === "ok" ? "✓ Listo y colocado" : "Render OK; colocá a mano: " + place);
    });
  }

  // Rehidrata lo pesado del payload (stills/transcript/recursos/objetivo) desde
  // HPStore justo antes de correr. Necesario para jobs restaurados de queue.json
  // (que se guardan livianos); en jobs frescos es idempotente.
  function rehydratePayload(job) {
    if (!job.payload) return;
    try {
      HPStore.withContext(job.projectPath, job.seqName, function () {
        var segments = HPStore.getTranscript() || [];
        var md = HPStore.getMarkerData(job.markerKey) || {};
        var gen = HPStore.getMarkerData(HPStore.GENERAL_KEY) || {}; // prompt general
        job.payload.transcript = segments;
        job.payload.markerTranscript = HPTranscript.sliceForMarker(
          segments, job.markerStart, job.markerStart + job.markerDuration, HPStore.getTranscriptOffset());
        // Stills (visión) + assets (a incrustar) = marcador + generales.
        job.payload.assets = HPStore.getMarkerAssets(job.markerKey).concat(HPStore.getMarkerAssets(HPStore.GENERAL_KEY));
        // Las imágenes viajan en TODA generación, también al refinar: el modelo no
        // recuerda la llamada anterior, así que una imagen que no se manda es una
        // imagen que no existe para él. Lo único que se respeta es que el editor
        // apague alguna a mano en la caja de feedback (stillsSend = índices en los
        // stills DEL MARCADOR); las del prompt general van siempre, son la marca.
        if (job.payload.mode === "adjust" && Array.isArray(job.payload.stillsSend)) {
          var _all = md.stills || [];
          job.payload.stills = job.payload.stillsSend
            .map(function (ix) { return _all[ix]; })
            .filter(function (s) { return !!s; })
            .concat(gen.stills || []);
        } else {
          job.payload.stills = (md.stills || []).concat(gen.stills || []);
        }
        job.payload.resources = (md.resources || []).concat(gen.resources || []);
        if (!job.payload.generalInstruction) job.payload.generalInstruction = gen.instruction || "";
        if (!job.payload.objective) job.payload.objective = HPStore.getObjective();
        if (typeof job.payload.background !== "boolean") job.payload.background = !!md.background;
      });
    } catch (e) { hpLog("rehydratePayload falló [" + job.label + "]: " + ((e && e.message) || e), "WARN"); }
  }

  function startModel(job) {
    modelRunning++; job.status = "modeling"; job.pct = 3; job.msg = "Diseñando…"; job.startedAt = Date.now();
    job._modelStart = Date.now(); job._modelMs = 0; job.act = null; job._actSeen = false;
    job._modelLanes = modelRunning; // para calibrar en carril-segundos
    rehydratePayload(job); emit();
    var method = job.kind === "generate" ? "prepareGenerate" : "prepareFeedback";
    hpLog("Job MODELO [" + job.label + "] · " + method + " · modelo=" + (HPConfigUI.modelName() || "?") + " · en paralelo=" + modelRunning);
    HPEngine.callProg(method, job.payload, onP(job)).then(function (prep) {
      modelRunning--;
      if (job._cancelled) { hpLog("Job CANCELADO [" + job.label + "] tras modelo — descartado."); emit(); pump(); return; }
      if (!prep || !prep.ok) throw new Error(prep && prep.error ? prep.error : "error preparando");
      job.prepared = prep;
      countUsage(job, prep.usage);
      job._modelMs = Date.now() - (job._modelStart || Date.now());
      job.status = "ready"; job.msg = "En espera de render… · IA " + fmtDuration(job._modelMs / 1000);
      job.act = null; // el modelo ya no está haciendo nada: no dejar su último paso colgado
      // Calibración: segundos que tardó el modelo (para estimar la cola).
      // En carril-segundos, igual que el render (ver markDone): con 3 diseños a la
      // vez cada uno tarda más de pared, y la estimación divide por el cupo.
      var _ms = job._modelMs / 1000;
      if (_ms > 1 && _ms < 3600) {
        TIMING.modelJobs++;
        TIMING.modelSec += _ms * (job._modelLanes || 1);
        saveTiming();
      }
      hpLog("Job MODELO ok [" + job.label + "] → listo para render");
      emit(); pump();
    }).catch(function (err) {
      modelRunning--;
      if (job._cancelled) { emit(); pump(); return; }
      failJob(job, err, "model"); // falló el diseño → reintentar re-llama a la IA
      emit(); pump();
    });
  }

  function startRender(job) {
    takeRenderLane(job);
    job.status = "running"; if (!job.startedAt) job.startedAt = Date.now();
    job._renderStart = Date.now(); job._renderMs = 0; job.act = null;
    job._renderLanes = renderRunning(); // para calibrar en carril-segundos
    job.msg = "Renderizando…"; emit();
    hpLog("Job RENDER [" + job.label + "] · kind=" + job.kind + " · en paralelo=" + renderRunning());
    var p = (job.kind === "renderManualHtml")
      ? HPEngine.callProg("renderManualHtml", job.payload, onP(job))
      : (job.kind === "renderVersionHQ")
        ? HPEngine.callProg("renderVersionHQ", job.payload, onP(job))
        : (job.kind === "renderLatest")
          ? HPEngine.callProg("renderLatest", job.payload, onP(job))
          : HPEngine.callProg("renderPrepared", job.prepared, onP(job));
    // Render → colocación → cierre, en una sola cadena, y el carril se libera en
    // el último eslabón: pase lo que pase (error, cancelación, o que Premiere no
    // conteste) hay UN solo lugar que lo suelta.
    p.then(function (res) {
      // El render propiamente dicho termina ACÁ: lo que viene después (importar
      // y colocar el clip en Premiere) es otra cosa y no debe contarse como
      // tiempo de render.
      job._renderMs = Date.now() - (job._renderStart || Date.now());
      if (!res || !res.ok) throw new Error(res && res.error ? res.error : "error desconocido");
      if (job._cancelled) { hpLog("Job CANCELADO [" + job.label + "] tras render — descartado."); return; }
      return finishPlace(job, res);
    }).catch(function (err) {
      // el modelo ya estaba OK; reintentar re-renderiza sin IA
      if (!job._cancelled) failJob(job, err, "render");
    }).then(function () {
      releaseRenderLane(job); emit(); pump();
    });
  }

  // Chequeo previo a los jobs de IA, lo instala el panel (ver setModelPreflight).
  // Devuelve true si el contexto de la clase ya está, o una Promise<bool> que se
  // resuelve cuando termina de prepararlo.
  var modelPreflight = null;
  var preflightRunning = false;

  // Un job listo para el carril de RENDER: o ya pasó por el modelo ("ready"), o es
  // un render puro que no necesita IA.
  function isRenderable(job) {
    return job.status === "ready" ||
      (job.status === "queued" &&
        (job.kind === "renderManualHtml" || job.kind === "renderVersionHQ" || job.kind === "renderLatest"));
  }

  function pump() {
    if (paused) return; // staging: no arrancar nuevos jobs
    // En local (Ollama) NO se solapa: modelo y render usan la misma máquina.
    var overlap = !HPConfigUI.isLocalProvider();
    // Carril RENDER: hasta renderCap() a la vez (en local, además, no mientras el
    // modelo corre). Con varios diseños de IA resolviéndose en paralelo, los
    // renders llegaban todos juntos y se hacían fila de a uno; ese embudo es lo
    // que abre este cupo.
    //
    // Se juntan los elegibles ANTES de arrancar ninguno: startRender emite, emitir
    // corre a los suscriptores, y un suscriptor que borre o cancele un job cambia
    // `jobs` mientras lo estaríamos recorriendo.
    if (overlap || modelRunning === 0) {
      var eligible = jobs.filter(isRenderable);
      for (var i = 0; i < eligible.length && renderRunning() < renderCap(); i++) startRender(eligible[i]);
    }
    // Carril MODELO: arranca TANTOS jobs de IA como permita el cupo (nube:
    // MODEL_CONCURRENCY en paralelo; local: 1 y no mientras el render corre).
    // startModel incrementa modelRunning en su 1ª línea, así que la condición
    // ve el conteo actualizado en cada vuelta.
    //
    // Antes de gastar tokens en un job de IA se comprueba que su secuencia tenga
    // contexto (transcript + objetivo): sin él las animaciones salen muy
    // inferiores. El contexto es POR SECUENCIA, así que se pregunta job por job
    // — con un solo chequeo al principio, un job de otra secuencia sin transcript
    // se colaba y se generaba a ciegas. Una secuencia sin transcript NO frena a
    // las que ya lo tienen: mientras se transcribe una, las otras generan.
    for (var n = 0; n < jobs.length; n++) {
      var next = jobs[n];
      if (next.status !== "queued") continue;
      if (next.kind !== "generate" && next.kind !== "feedback") continue;
      if (modelPreflight && modelPreflight(next, true) !== true) {
        // Solo UNA preparación a la vez: transcribir exige abrir la secuencia en
        // Premiere, y dos a la vez se pisarían.
        if (preflightRunning) continue;
        preflightRunning = true;
        Promise.resolve(modelPreflight(next)).then(function (ready) {
          preflightRunning = false;
          if (ready) { pump(); return; }
          // No se pudo preparar: la cola queda en pausa en vez de generar a
          // ciegas. El panel ya explicó qué pasó y cómo seguir.
          paused = true; emit();
        }, function (e) {
          // El preflight no debería rechazar (explica los fallos resolviendo
          // false). Si rompe, sin este log la cola se pausaba sin decir por qué.
          hpLog("El chequeo previo del contexto ROMPIÓ: " + ((e && (e.stack || e.message)) || e), "ERROR");
          preflightRunning = false;
          paused = true; emit();
        });
        continue;
      }
      if (modelRunning >= modelCap() || !(overlap || (renderRunning() === 0 && modelRunning === 0))) break;
      startModel(next);
    }
  }

  function nextModelJob() {
    for (var k = 0; k < jobs.length; k++) {
      var m = jobs[k];
      if (m.status === "queued" && (m.kind === "generate" || m.kind === "feedback")) return m;
    }
    return null;
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
    // Vocabulario de estados compartido con las vistas (un solo dueño).
    isActive: isActive,
    isPending: isPending,
    isUpgradable: isUpgradable,

    // Chequeo que corre antes de CADA job de IA (el panel lo usa para asegurar
    // transcript + objetivo de la secuencia de ese job).
    //   fn(job, true)  → solo consulta: true si ya está listo, sin efectos.
    //   fn(job)        → true si está listo, o una Promise<bool> que prepara el
    //                    contexto; si resuelve false, la cola se pausa en vez
    //                    de generar a ciegas.
    setModelPreflight: function (fn) { modelPreflight = fn; },

    // Techo del carril de render. NO es una preferencia: lo decide el motor
    // perfilando la máquina (en una floja un segundo render revienta el buffer), y
    // acá solo se valida que sea un número usable. Devuelve el cupo que quedó.
    setRenderLanes: function (n) {
      n = parseInt(n, 10);
      renderConcurrency = (isNaN(n) || n < 1) ? 1 : n;
      pump(); // por si el nuevo cupo permite arrancar otro render ya mismo
      return renderCap();
    },

    // Cuántas llamadas al LLM corren en paralelo (nube). Persistente.
    getModelConcurrency: function () { return modelConcurrency; },
    setModelConcurrency: function (n) {
      n = parseInt(n, 10);
      if (isNaN(n) || n < 1) n = 1;
      if (n > 8) n = 8;
      modelConcurrency = n;
      try { global.localStorage.setItem("hyperpremiere::model-concurrency", String(n)); } catch (e) {}
      pump(); // por si el nuevo cupo permite arrancar más ya mismo
      return n;
    },

    // Estimación de la cola (auto-calibrada con el uso real).
    timing: {
      calibrated: function () { return TIMING.modelJobs > 0 || TIMING.renderCompSec > 0; },
      // Segundos que falta esperar para `genCount` diseños y `compSec` segundos de
      // composición por renderizar. Las muestras están en carril-segundos, así que
      // cada etapa se divide por SU cupo. Vive en la cola, no en la vista, porque
      // los cupos los manda la cola.
      estimateSec: function (genCount, compSec) {
        var modelSec = (Number(genCount) || 0) * avgModelSec() / Math.max(1, modelCap());
        var rndSec = (Number(compSec) || 0) * renderSecPerCompSec() / Math.max(1, renderCap());
        return modelSec + rndSec;
      }
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
      for (var i = 0; i < jobs.length; i++) if (isActive(jobs[i].status)) return true;
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
        j._renderMs = 0; j.act = null;
        // El tiempo del modelo solo se borra si el modelo va a correr de nuevo:
        // en un reintento de SOLO render el diseño ya se pagó y ese rato se
        // gastó igual, así que sigue contando en el total del recurso.
        if (j._failedStage !== "render") { j._modelMs = 0; j._actSeen = false; }
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
          // Índices (en los stills del marcador) que el editor dejó activos. Sin
          // lista, van TODAS: quedarse sin referencias tiene que ser una decisión
          // explícita suya, no lo que pasa cuando alguien no pasó el parámetro.
          if (Array.isArray(stillsSend)) j.payload.stillsSend = stillsSend;
          else delete j.payload.stillsSend;
        }
        else { j.payload.mode = "generate"; j.kind = "generate"; delete j.payload.stillsSend; }
        j.status = "queued"; j.pct = 0;
        j.msg = txt ? "Reencolado con feedback, esperando turno…" : "Reencolado, esperando turno…";
        j.prepared = null; j._usageCounted = false; j.version = undefined;
        j.startedAt = 0; j.usage = null; j._modelMs = 0; j._renderMs = 0; j.act = null;
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
        return isPending(j.status) || j.status === "waiting";
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
        if (isActive(j.status)) {
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
        if (isActive(jobs[i].status)) jobs[i]._cancelled = true;
      }
      hpLog("Vaciar cola: " + jobs.length + " job(s) eliminados (activos marcados como cancelados).");
      jobs = [];
      paused = false;
      emit(); // persist guardará la cola vacía
    }
  };
})(typeof window !== "undefined" ? window : this);
