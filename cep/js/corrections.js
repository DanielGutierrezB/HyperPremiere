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
 * Tampoco depende de estar parado en la secuencia correcta: la clase suele
 * volver de la revisión re-cortada y con otro nombre ("_02"), así que se elige
 * de qué carpeta leer y se dice a qué secuencia se va a colocar.
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
  var pickerEl = null;
  var pickSource = null;

  // Fila por slug, para poder pisar su línea de estado cuando el job avanza sin
  // volver a dibujar la lista (redibujar borraría lo que el editor está
  // escribiendo en otra fila).
  var rowsBySlug = {};

  // De dónde se leyó lo generado y a dónde se coloca. Son dos secuencias
  // distintas cuando la clase volvió re-cortada: los archivos y las imágenes de
  // referencia están en la vieja, y el clip corregido va a la que está abierta.
  var origen = { slug: "", sequenceName: "" };
  var destino = "";

  /** Los recursos salieron de otro corte de esta clase. */
  function otroCorte() {
    return !!origen.sequenceName && !!destino && origen.sequenceName !== destino;
  }

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
   * El marcador como lo vio el modelo cuando se generó: sus tiempos son los del
   * corte donde nació, y de ahí sale el tramo del transcript que se le manda.
   */
  function markerFromMeta(m) {
    return {
      name: m.markerName || m.slug, start: m.start, end: m.start + m.duration,
      duration: m.duration, guid: m.markerGuid || ""
    };
  }

  /**
   * Lo común a los dos caminos (rediseñar y renderizar un HTML pegado): el
   * recurso se genera en la carpeta de DONDE SALIÓ, para que su historia de
   * versiones siga siendo una, y el clip se coloca en la secuencia ABIERTA, que
   * es la que el editor está mirando.
   */
  function jobBase(m, second) {
    var ctx = deps.context();
    return {
      projectPath: ctx.projectPath,
      seqName: destino,
      storeSeqName: origen.sequenceName,
      markerKey: m.slug,
      markerStart: m.start, markerDuration: m.duration,
      placeStart: second,
      correction: true
    };
  }

  /**
   * Manda la corrección a la cola como un refinamiento normal, con dos
   * diferencias: el HTML previo viaja explícito (el motor por defecto lee la
   * versión anterior, y acá podés corregir cualquiera) y el tramo sale de la
   * ficha en vez del marcador.
   */
  function enqueueCorrection(m, version, text, second, state) {
    var ctx = deps.context();
    state.className = "corr-state";
    state.textContent = "Leyendo la v" + version + "…";

    HPEngine.call("readMarkerHtml", {
      projectPath: ctx.projectPath, sequenceName: origen.sequenceName,
      markerSlug: m.slug, version: version
    }).then(function (r) {
      if (!r || !r.ok || !r.html) throw new Error((r && r.error) || "no pude leer el HTML de la v" + version);

      var job = jobBase(m, second);
      job.kind = "feedback";
      job.label = m.slug + " (corrección)";
      job.payload = {
        projectPath: ctx.projectPath, sequenceName: origen.sequenceName,
        marker: markerFromMeta(m),
        markerSlug: m.slug, mode: "adjust",
        instruction: text, adjustment: text,
        previousHtml: r.html,
        // Con o sin fondo tiene que salir igual que el original: si no, una
        // corrección convertiría un clip opaco en uno transparente.
        background: !!m.background,
        draft: deps.draft()
      };
      HPQueue.add(job);
      hpLog("Corrección encolada [" + m.slug + "] sobre la v" + version + " · de “" +
        origen.sequenceName + "” a “" + destino + "” en " + formatTime(second) +
        " por " + fmtDuration(m.duration));
      state.className = "corr-state is-ok";
      state.textContent = "Encolada sobre la v" + version + ". El progreso está en la pestaña Cola.";
    }).catch(function (e) {
      state.className = "corr-state is-error";
      state.textContent = "No pude encolarla: " + ((e && e.message) || e);
    });
  }

  /** Renderiza un HTML traído de afuera como versión nueva, sin gastar IA. */
  function enqueueManualHtml(m, html, second, state) {
    var ctx = deps.context();
    var job = jobBase(m, second);
    job.kind = "renderManualHtml";
    job.label = m.slug + " (HTML pegado)";
    job.payload = {
      projectPath: ctx.projectPath, sequenceName: origen.sequenceName,
      marker: markerFromMeta(m),
      markerSlug: m.slug, html: html, draft: deps.draft()
    };
    HPQueue.add(job);
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
          projectPath: ctx.projectPath, sequenceName: origen.sequenceName,
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

    // Si los recursos salieron de otro corte de la clase, el segundo guardado es
    // el de ESE corte: puede seguir sirviendo o no, y el único que lo sabe es el
    // editor. Se ofrece escrito, para confirmar de un clic o cambiarlo.
    var inSecond = null;
    if (otroCorte()) {
      inSecond = document.createElement("input");
      inSecond.type = "number"; inSecond.step = "0.1"; inSecond.min = "0";
      inSecond.className = "corr-second";
      inSecond.value = String(Math.round(m.start * 10) / 10);
      inSecond.title = "En qué segundo de “" + destino + "” colocar el clip. Viene con el del corte donde se generó.";
      actions.appendChild(inSecond);
    }

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
    fixBtn.title = "Rediseña sobre esa versión y devuelve el clip a " +
      (otroCorte() ? "el segundo que digas en “" + destino + "”" : formatTime(m.start)) +
      ", con la misma duración y etiqueta amarilla.";
    actions.appendChild(fixBtn);
    actions.appendChild(state);
    row.appendChild(actions);

    /** El segundo donde colocar, ya validado. null = el editor lo dejó inválido. */
    function secondToPlace() {
      if (!inSecond) return m.start;
      var n = Number(inSecond.value);
      return (isFinite(n) && n >= 0) ? n : null;
    }

    fixBtn.addEventListener("click", function () {
      var text = box.value.trim();
      if (!text) {
        state.className = "corr-state is-error";
        state.textContent = "Escribí qué hay que corregir.";
        return;
      }
      var second = secondToPlace();
      if (second == null) {
        state.className = "corr-state is-error";
        state.textContent = "El segundo donde colocarlo no es válido.";
        return;
      }
      var v = pickVersion ? parseInt(pickVersion.value, 10) : m.latestVersion;
      enqueueCorrection(m, v || m.latestVersion, text, second, state);
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
      var second = secondToPlace();
      if (second == null) {
        state.className = "corr-state is-error";
        state.textContent = "El segundo donde colocarlo no es válido.";
        return;
      }
      enqueueManualHtml(m, html, second, state);
    });

    return row;
  }

  // ── Cargar la secuencia ────────────────────────────────────────────

  /**
   * El desplegable de "de qué secuencia leer". Aparece solo cuando hay algo que
   * elegir; con una sola carpeta sería un control que no decide nada.
   */
  function renderPicker(res) {
    if (!pickerEl) return;
    pickerEl.innerHTML = "";
    pickSource = null;
    if (res.sources.length < 2) return;

    var label = document.createElement("span");
    label.className = "corr-picker-label";
    label.textContent = "Leer de";
    pickerEl.appendChild(label);

    var host = document.createElement("div");
    host.title = "De qué secuencia leer los recursos ya generados.";
    pickerEl.appendChild(host);
    pickSource = HPWidgets.select(host);
    pickSource.setOptions(res.sources.map(function (s) {
      // Acortado por el medio: el ancho del panel corta por el final, y ahí está
      // el sufijo que distingue un corte de otro de la misma clase.
      return { value: s.slug, label: HPUtil.shortenMiddle(s.sequenceName, 30) + " (" + s.count + ")" };
    }), res.folderSlug);
    pickSource.onChange = function (slug) { load(slug); };
  }

  /**
   * El aviso de que se está leyendo de otra secuencia. Es lo primero que hay que
   * entender antes de apretar Corregir: de dónde salieron los archivos y a qué
   * timeline va a caer el clip.
   *
   * Va en renglones con etiqueta y no en prosa: los nombres de estas clases
   * miden 45 caracteres y se diferencian en el sufijo, así que un párrafo con
   * los dos nombres tres veces es una pared que nadie lee.
   */
  function renderBanner(res) {
    if (!otroCorte()) return;
    var box = document.createElement("div");
    box.className = "corr-cross";

    var titulo = document.createElement("div");
    titulo.className = "corr-cross-title";
    titulo.textContent = res.guessed
      ? "Esta secuencia no tiene recursos generados; te traje los de otro corte."
      : "Estás corrigiendo recursos de otro corte.";
    box.appendChild(titulo);

    // Los dos nombres van recortados a lo que los diferencia: uno al lado del
    // otro, dos cadenas de 45 caracteres iguales salvo el final no se leen.
    var corto = HPUtil.distinguish(origen.sequenceName, destino, 34);
    [["Leo de", corto[0], origen.sequenceName], ["Coloco en", corto[1], destino]].forEach(function (par) {
      var fila = document.createElement("div");
      fila.className = "corr-cross-row";
      var k = document.createElement("span");
      k.className = "corr-cross-key";
      k.textContent = par[0];
      var v = document.createElement("span");
      v.className = "corr-cross-val";
      v.textContent = par[1];
      v.title = par[2];
      fila.appendChild(k); fila.appendChild(v);
      box.appendChild(fila);
    });

    var nota = document.createElement("div");
    nota.className = "corr-cross-note";
    nota.textContent = "Los segundos son los del corte viejo: revisá el de cada fila antes de mandar.";
    box.appendChild(nota);

    listEl.appendChild(box);
  }

  function render(res) {
    listEl.innerHTML = "";
    rowsBySlug = {};
    if (!res.markers.length) {
      var empty = document.createElement("div");
      empty.className = "corr-empty";
      empty.textContent = res.sources.length
        ? "Ninguna secuencia de este proyecto tiene recursos generados para “" + destino + "”. " +
          "Elegí de qué secuencia leer."
        : "Este proyecto todavía no tiene recursos generados.";
      listEl.appendChild(empty);
      return;
    }
    renderBanner(res);
    for (var i = 0; i < res.markers.length; i++) {
      var m = res.markers[i];
      var row = buildRow(m);
      rowsBySlug[m.slug] = row;
      listEl.appendChild(row);
    }
  }

  /** `folderSlug` fuerza una carpeta; sin él, el motor elige la que corresponde. */
  function load(folderSlug) {
    setStatus("Leyendo la carpeta de la secuencia…");
    deps.refreshContext(function () {
      var ctx = deps.context();
      if (!ctx.sequenceName) {
        setStatus("No hay secuencia activa en Premiere.", "muted is-error");
        return;
      }
      HPEngine.call("listCorrections", {
        projectPath: ctx.projectPath, sequenceName: ctx.sequenceName,
        folderSlug: folderSlug || ""
      }).then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || "no pude leer la carpeta");
        res.sources = res.sources || [];
        destino = ctx.sequenceName;
        origen = { slug: res.folderSlug, sequenceName: res.sourceSequenceName || ctx.sequenceName };
        renderPicker(res);
        render(res);
        var sinFicha = res.markers.filter(function (m) { return m.start == null; }).length;
        // El nombre entero está en el aviso y en el desplegable: acá alcanza con
        // el conteo, que es lo que se mira después de apretar el botón.
        setStatus(res.markers.length + " recurso(s) generados en “" +
          HPUtil.shortenMiddle(origen.sequenceName, 30) + "”" +
          (sinFicha ? " · " + sinFicha + " sin el tramo anotado" : ""));
        hpLog("Corrections: " + res.markers.length + " recursos leídos de " + res.baseDir +
          (otroCorte() ? " (secuencia abierta: “" + destino + "”)" : ""));
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
      pickerEl = document.getElementById("corr-picker");
      var btn = document.getElementById("btn-load-corrections");
      // El listener NO puede ser `load` a pelo: recibiría el evento del clic
      // como si fuera la carpeta a leer.
      if (btn) btn.addEventListener("click", function () { load(); });
    },
    load: function (folderSlug) { load(folderSlug); }
  };
})(typeof window !== "undefined" ? window : this);
