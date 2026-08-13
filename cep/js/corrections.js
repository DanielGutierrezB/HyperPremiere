/**
 * HPCorrections — vista de la pestaña Corrections.
 *
 * Corrige recursos YA generados y enviados, SIN depender de los marcadores de
 * Premiere. Cuando el editor manda la clase a revisar y vuelve con comentarios,
 * los marcadores pueden estar borrados, movidos o mezclados con los de
 * Frame.io, y volver a abrirlos no es opción. Todo lo que hace falta se lee de
 * la carpeta de la secuencia: el HTML de cada versión y la ficha (.meta.json)
 * con el tramo del timeline donde iba el recurso.
 *
 * Lo que sale de acá vuelve al MISMO segundo y con la MISMA duración con la que
 * se generó, y se coloca en amarillo para distinguirlo de un vistazo.
 *
 * Deps de main vía init(deps):
 *   context()        → { projectPath, sequenceName } del panel
 *   refreshContext(cb) → relee proyecto/secuencia de Premiere y llama cb
 *   draft()          → si el modo borrador está activo
 *
 * Vanilla JS, sin ES modules: se expone como window.HPCorrections.
 */
(function (global) {
  "use strict";

  var hpLog = HPLog.log;
  var formatTime = HPUtil.formatTime;
  var fmtDuration = HPUtil.fmtDuration;

  var deps = null;
  var listEl = null;
  var statusEl = null;

  // Fila por slug, para poder pisar su línea de estado cuando el job avanza sin
  // volver a dibujar la lista (redibujar borraría lo que el editor está
  // escribiendo en otra fila).
  var rowsBySlug = {};

  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = cls || "muted";
  }

  /** Cuándo y cuánto duraba, en palabras. */
  function whenText(m) {
    if (m.start == null || !(m.duration > 0)) return "sin ficha del tramo";
    return "entra " + formatTime(m.start) + " · dura " + fmtDuration(m.duration);
  }

  /** De dónde salió ese tramo, para que el editor sepa cuánto confiar. */
  function sourceText(m) {
    if (m.timeSource === "ficha") return "";
    if (m.timeSource === "cola") return " (tomado de la cola)";
    if (m.timeSource === "html") return " (duración del HTML; falta el segundo de entrada)";
    return "";
  }

  // ── Encolar ────────────────────────────────────────────────────────

  /**
   * Manda la corrección a la cola como un refinamiento normal, con dos
   * diferencias: el HTML previo viaja explícito (el motor por defecto lee la
   * versión anterior, y acá podés corregir cualquiera) y el tramo sale de la
   * ficha en vez del marcador.
   */
  function enqueueCorrection(m, version, text, state) {
    var ctx = deps.context();
    state.className = "corr-state";
    state.textContent = "Leyendo la v" + version + "…";

    HPEngine.call("readMarkerHtml", {
      projectPath: ctx.projectPath, sequenceName: ctx.sequenceName,
      markerSlug: m.slug, version: version
    }).then(function (r) {
      if (!r || !r.ok || !r.html) throw new Error((r && r.error) || "no pude leer el HTML de la v" + version);

      var payload = {
        projectPath: ctx.projectPath, sequenceName: ctx.sequenceName,
        marker: {
          name: m.markerName || m.slug, start: m.start, end: m.start + m.duration,
          duration: m.duration, guid: m.markerGuid || ""
        },
        markerSlug: m.slug, mode: "adjust",
        instruction: text, adjustment: text,
        previousHtml: r.html,
        // Con o sin fondo tiene que salir igual que el original: si no, una
        // corrección convertiría un clip opaco en uno transparente.
        background: !!m.background,
        draft: deps.draft()
      };
      HPQueue.add({
        kind: "feedback", payload: payload,
        seqName: ctx.sequenceName, projectPath: ctx.projectPath,
        markerKey: m.slug, label: m.slug + " (corrección)",
        markerStart: m.start, markerDuration: m.duration,
        correction: true
      });
      hpLog("Corrección encolada [" + m.slug + "] sobre la v" + version + " · vuelve a " +
        formatTime(m.start) + " por " + fmtDuration(m.duration));
      state.className = "corr-state is-ok";
      state.textContent = "Encolada sobre la v" + version + ". El progreso está en la pestaña Cola.";
    }).catch(function (e) {
      state.className = "corr-state is-error";
      state.textContent = "No pude encolarla: " + ((e && e.message) || e);
    });
  }

  /** Renderiza un HTML traído de afuera como versión nueva, sin gastar IA. */
  function enqueueManualHtml(m, html, state) {
    var ctx = deps.context();
    HPQueue.add({
      kind: "renderManualHtml",
      payload: {
        projectPath: ctx.projectPath, sequenceName: ctx.sequenceName,
        marker: {
          name: m.markerName || m.slug, start: m.start, end: m.start + m.duration,
          duration: m.duration, guid: m.markerGuid || ""
        },
        markerSlug: m.slug, html: html, draft: deps.draft()
      },
      seqName: ctx.sequenceName, projectPath: ctx.projectPath, markerKey: m.slug,
      label: m.slug + " (HTML pegado)",
      markerStart: m.start, markerDuration: m.duration,
      correction: true
    });
    state.className = "corr-state is-ok";
    state.textContent = "Encolado para renderizar. El progreso está en la pestaña Cola.";
  }

  // ── Dibujar una fila ───────────────────────────────────────────────

  function buildRow(m) {
    var row = document.createElement("div");
    row.className = "corr-row" + (m.start == null ? " is-unknown" : "");

    var line = document.createElement("div");
    line.className = "corr-line";
    var name = document.createElement("span");
    name.className = "corr-name";
    name.textContent = m.slug + (m.markerName && m.markerName !== m.slug ? " · " + m.markerName : "");
    var when = document.createElement("span");
    when.className = "corr-when";
    when.textContent = whenText(m) + sourceText(m);
    var meta = document.createElement("span");
    meta.className = "corr-meta";
    meta.textContent = "v" + m.latestVersion + (m.model ? " [" + m.model + "]" : "") +
      " · " + m.versions.length + (m.versions.length === 1 ? " versión" : " versiones");
    line.appendChild(name); line.appendChild(when); line.appendChild(meta);
    row.appendChild(line);

    var state = document.createElement("div");
    state.className = "corr-state";

    // Sin el tramo no se puede recolocar nada: se pide UNA vez y queda guardado
    // en la ficha, así la próxima corrección ya no pregunta.
    if (m.start == null) {
      var warn = document.createElement("div");
      warn.className = "corr-warn";
      warn.textContent = "No encontré dónde iba este recurso (la versión es anterior a que se guardara la ficha). " +
        "Decime el segundo de entrada y la duración y lo dejo anotado.";
      row.appendChild(warn);

      var fix = document.createElement("div");
      fix.className = "corr-fix";
      var inStart = document.createElement("input");
      inStart.type = "number"; inStart.step = "0.1"; inStart.min = "0"; inStart.placeholder = "entra (s)";
      inStart.title = "Segundo del timeline donde arranca el recurso.";
      var inDur = document.createElement("input");
      inDur.type = "number"; inDur.step = "0.1"; inDur.min = "0.1"; inDur.placeholder = "dura (s)";
      inDur.title = "Cuántos segundos dura el recurso.";
      if (m.duration > 0) inDur.value = String(m.duration);
      var save = document.createElement("button");
      save.type = "button"; save.className = "qbtn"; save.textContent = "Guardar el tramo";
      fix.appendChild(inStart); fix.appendChild(inDur); fix.appendChild(save);
      row.appendChild(fix);
      row.appendChild(state);

      save.addEventListener("click", function () {
        var ctx = deps.context();
        state.className = "corr-state";
        state.textContent = "Guardando…";
        HPEngine.call("saveCorrectionPosition", {
          projectPath: ctx.projectPath, sequenceName: ctx.sequenceName,
          markerSlug: m.slug, start: Number(inStart.value), duration: Number(inDur.value)
        }).then(function (r) {
          if (!r || !r.ok) throw new Error((r && r.error) || "no se pudo guardar");
          state.className = "corr-state is-ok";
          state.textContent = "Anotado. Recargá la secuencia para corregirlo.";
        }).catch(function (e) {
          state.className = "corr-state is-error";
          state.textContent = "No pude guardarlo: " + ((e && e.message) || e);
        });
      });
      return row;
    }

    var box = document.createElement("textarea");
    box.rows = 2;
    box.placeholder = "Qué hay que corregir. Ej: “el título tapa la cara, subilo”, “falta la fuente del dato”.";
    row.appendChild(box);

    var actions = document.createElement("div");
    actions.className = "corr-actions";

    // Selector de versión: solo si hay más de una para elegir. Va con el
    // desplegable propio porque Premiere no dibuja el popup de los <select>.
    var pickVersion = null;
    if (m.versions.length > 1) {
      var selRoot = document.createElement("div");
      selRoot.title = "Sobre qué versión aplicar la corrección.";
      actions.appendChild(selRoot);
      pickVersion = HPWidgets.select(selRoot);
      pickVersion.setOptions(m.versions.map(function (v) {
        return { value: String(v.version), label: "v" + v.version + (v.model ? " [" + v.model + "]" : "") };
      }), String(m.latestVersion));
    }

    var fixBtn = document.createElement("button");
    fixBtn.type = "button"; fixBtn.className = "qbtn";
    fixBtn.textContent = "Corregir";
    fixBtn.title = "Rediseña sobre esa versión y devuelve el clip a " + formatTime(m.start) +
      ", con la misma duración y etiqueta amarilla.";
    actions.appendChild(fixBtn);
    actions.appendChild(state);
    row.appendChild(actions);

    fixBtn.addEventListener("click", function () {
      var text = box.value.trim();
      if (!text) {
        state.className = "corr-state is-error";
        state.textContent = "Escribí qué hay que corregir.";
        return;
      }
      var v = pickVersion ? parseInt(pickVersion.value, 10) : m.latestVersion;
      enqueueCorrection(m, v || m.latestVersion, text, state);
    });

    // Traer un HTML de afuera (o el que el editor haya retocado a mano).
    var pasteBox = document.createElement("details");
    pasteBox.className = "corr-html";
    var sum = document.createElement("summary");
    sum.textContent = "Pegar un HTML y renderizarlo (sin IA)";
    pasteBox.appendChild(sum);
    var code = document.createElement("textarea");
    code.rows = 6;
    code.placeholder = "Pegá acá el HTML de la composición. Se guarda como versión nueva y se coloca en el mismo tramo.";
    pasteBox.appendChild(code);
    var renderBtn = document.createElement("button");
    renderBtn.type = "button"; renderBtn.className = "qbtn";
    renderBtn.textContent = "Renderizar y colocar";
    pasteBox.appendChild(renderBtn);
    row.appendChild(pasteBox);

    renderBtn.addEventListener("click", function () {
      var html = code.value.trim();
      if (!html) {
        state.className = "corr-state is-error";
        state.textContent = "El HTML está vacío.";
        return;
      }
      enqueueManualHtml(m, html, state);
    });

    return row;
  }

  // ── Cargar la secuencia ────────────────────────────────────────────

  function render(res) {
    listEl.innerHTML = "";
    rowsBySlug = {};
    if (!res.markers.length) {
      var empty = document.createElement("div");
      empty.className = "corr-empty";
      empty.textContent = "Esta secuencia todavía no tiene recursos generados.";
      listEl.appendChild(empty);
      return;
    }
    for (var i = 0; i < res.markers.length; i++) {
      var m = res.markers[i];
      var row = buildRow(m);
      rowsBySlug[m.slug] = row;
      listEl.appendChild(row);
    }
  }

  function load() {
    setStatus("Leyendo la carpeta de la secuencia…");
    deps.refreshContext(function () {
      var ctx = deps.context();
      if (!ctx.sequenceName) {
        setStatus("No hay secuencia activa en Premiere.", "muted is-error");
        return;
      }
      HPEngine.call("listCorrections", {
        projectPath: ctx.projectPath, sequenceName: ctx.sequenceName
      }).then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || "no pude leer la carpeta");
        render(res);
        var sinFicha = res.markers.filter(function (m) { return m.start == null; }).length;
        setStatus(res.markers.length + " recurso(s) generados en “" + ctx.sequenceName + "”" +
          (sinFicha ? " · " + sinFicha + " sin el tramo anotado" : ""));
        hpLog("Corrections: " + res.markers.length + " recursos leídos de " + res.baseDir);
      }).catch(function (e) {
        listEl.innerHTML = "";
        setStatus("No pude leer lo generado: " + ((e && e.message) || e), "muted is-error");
      });
    });
  }

  global.HPCorrections = {
    /** Cablea las dependencias del panel y engancha el botón. Llamar UNA vez. */
    init: function (d) {
      deps = d;
      listEl = document.getElementById("corr-list");
      statusEl = document.getElementById("corr-status");
      var btn = document.getElementById("btn-load-corrections");
      if (btn) btn.addEventListener("click", load);
    },
    load: load
  };
})(typeof window !== "undefined" ? window : this);
