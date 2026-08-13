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
 * se generó, en una pista nueva y en amarillo para distinguirlo de un vistazo.
 *
 * Cada fila es una ronda de feedback completa, como la de la Cola: instrucción,
 * imágenes nuevas, qué imágenes viajan y qué versión se toma como base.
 *
 * Tampoco depende de estar parado en la secuencia correcta: la clase suele
 * volver de la revisión re-cortada y con otro nombre ("_02"), así que se elige
 * de qué carpeta leer y se dice a qué secuencia se va a colocar.
 *
 * El HTML de cada versión se lee del disco y se puede retocar y renderizar sin
 * gastar IA: la pestaña ya encontró los archivos, no tiene sentido pedirlos.
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
  function jobBase(m) {
    var ctx = deps.context();
    return {
      projectPath: ctx.projectPath,
      seqName: destino,
      storeSeqName: origen.sequenceName,
      markerKey: m.slug,
      markerStart: m.start, markerDuration: m.duration,
      correction: true
    };
  }

  /**
   * Sobre qué secuencia trabaja el material del marcador. Sus imágenes viven
   * contra la secuencia donde nació el recurso, no contra la que está abierta.
   */
  function stillsOpts(m) {
    return {
      fbJobId: "corr:" + origen.slug + ":" + m.slug,
      projectPath: deps.context().projectPath,
      sequenceName: origen.sequenceName
    };
  }

  /** Lee del namespace de una secuencia sin dejar el contexto cambiado. */
  function leerDe(seqName, fn) {
    return HPStore.withContext(deps.context().projectPath, seqName, fn);
  }

  /**
   * El marco de la clase: objetivo e indicaciones generales. Están guardados
   * contra la secuencia donde nació el recurso, y ahí pueden no estar —ese corte
   * nunca se abrió en esta máquina—, así que lo que falte se toma de la secuencia
   * abierta: es la misma clase con otro corte, y mandar "(sin objetivo
   * declarado)" es pedirle al modelo que corrija sin saber de qué va la clase.
   */
  function marcoDeLaClase() {
    function leer() {
      return {
        objective: HPStore.getObjective() || "",
        general: (HPStore.getMarkerData(HPStore.GENERAL_KEY) || {}).instruction || ""
      };
    }
    var propio = leerDe(origen.sequenceName, leer);
    if (!otroCorte() || (propio.objective && propio.general)) return propio;
    var vecino = leerDe(destino, leer);
    return {
      objective: propio.objective || vecino.objective,
      general: propio.general || vecino.general
    };
  }

  /**
   * Manda la corrección a la cola como un refinamiento normal, con dos
   * diferencias: el HTML previo viaja explícito (el motor por defecto lee la
   * versión anterior, y acá podés corregir cualquiera) y el tramo sale de la
   * ficha en vez del marcador.
   */
  function enqueueCorrection(m, version, text, state) {
    var ctx = deps.context();
    var opts = stillsOpts(m);
    state.className = "corr-state";
    state.textContent = "Leyendo la v" + version + "…";

    HPEngine.call("readMarkerHtml", {
      projectPath: ctx.projectPath, sequenceName: origen.sequenceName,
      markerSlug: m.slug, version: version
    }).then(function (r) {
      if (!r || !r.ok || !r.html) throw new Error((r && r.error) || "no pude leer el HTML de la v" + version);

      var marco = marcoDeLaClase();
      var job = jobBase(m);
      job.kind = "feedback";
      job.label = m.slug + " (corrección)";
      job.payload = {
        projectPath: ctx.projectPath, sequenceName: origen.sequenceName,
        marker: markerFromMeta(m),
        markerSlug: m.slug, mode: "adjust",
        // `instruction` es el ENCARGO del recurso (lo que se pidió cuando se
        // generó, guardado en la ficha) y `adjustment` es la corrección de ahora.
        // Son dos secciones distintas del prompt: mandando la corrección en los
        // dos lados, el modelo rediseñaba sin saber qué era ese gráfico —"subí el
        // título" como TODO el encargo— y encima la ficha nueva se quedaba con
        // eso, así que el encargo se perdía para siempre.
        instruction: m.instruction || text,
        adjustment: text,
        objective: marco.objective,
        generalInstruction: marco.general,
        previousHtml: r.html,
        // Qué imágenes del marcador viajan (el 📤 de cada miniatura). La cola las
        // resuelve contra la secuencia de origen justo antes de llamar al modelo.
        stillsSend: HPStills.fbCollect(opts.fbJobId, m.slug, opts),
        // Con o sin fondo tiene que salir igual que el original: si no, una
        // corrección convertiría un clip opaco en uno transparente.
        background: !!m.background,
        draft: deps.draft()
      };
      HPQueue.add(job);
      HPStills.fbClear(opts.fbJobId); // la próxima ronda arranca con todas activas
      hpLog("Corrección encolada [" + m.slug + "] sobre la v" + version + " · de “" +
        origen.sequenceName + "” a “" + destino + "” en " + formatTime(m.start) +
        " por " + fmtDuration(m.duration));
      state.className = "corr-state is-ok";
      state.textContent = "Encolada sobre la v" + version + ". El progreso está en la pestaña Cola.";
    }).catch(function (e) {
      state.className = "corr-state is-error";
      state.textContent = "No pude encolarla: " + ((e && e.message) || e);
    });
  }

  /** Renderiza el HTML editado a mano como versión nueva, sin gastar IA. */
  function enqueueManualHtml(m, html, state) {
    var ctx = deps.context();
    var job = jobBase(m);
    job.kind = "renderManualHtml";
    job.label = m.slug + " (HTML a mano)";
    job.payload = {
      projectPath: ctx.projectPath, sequenceName: origen.sequenceName,
      marker: markerFromMeta(m),
      // Con fondo o sin fondo decide el formato del video (mp4 opaco / mov con
      // alpha). Sin esto, editar a mano un recurso opaco lo devolvía en mov.
      background: !!m.background,
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
    // El nombre lleva al timeline. Es lo primero que se quiere hacer con una fila
    // —ver qué hay ahí antes de escribir la corrección— y más todavía cuando el
    // segundo viene de otro corte y hay que confirmar que sigue sirviendo.
    if (m.start != null) {
      name.className = "corr-name is-link";
      name.title = "Llevar el cursor de Premiere a este punto de “" + destino + "”.";
      name.addEventListener("click", function () {
        HPHost.openSequenceAndSeek(destino, m.start, function () {});
      });
    }
    when.className = "corr-when";
    when.textContent = whenText(m) + sourceText(m);
    var meta = document.createElement("span");
    meta.className = "corr-meta";
    meta.textContent = "v" + m.latestVersion + (m.model ? " [" + m.model + "]" : "") +
      " · " + m.versions.length + (m.versions.length === 1 ? " versión" : " versiones");
    line.appendChild(name); line.appendChild(when); line.appendChild(meta);
    row.appendChild(line);

    // El encargo con el que nació el recurso, tal como quedó en su ficha. Se
    // muestra porque es lo que el modelo va a recibir junto con la corrección, y
    // porque al mes uno ya no se acuerda de qué le pidió a ese gráfico.
    if (m.instruction) {
      var brief = document.createElement("div");
      brief.className = "corr-brief";
      brief.textContent = "Se pidió: " + m.instruction;
      brief.title = m.instruction;
      row.appendChild(brief);
    }

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

    // Una corrección es una ronda de feedback como las de la Cola, así que tiene
    // que traer lo mismo: mandar imágenes nuevas, decidir cuáles viajan y marcar
    // qué se incrusta. Trabaja sobre la secuencia de ORIGEN, donde están las
    // imágenes con las que se generó el recurso.
    var opts = stillsOpts(m);
    HPStills.fbInit(opts.fbJobId);
    var hint = document.createElement("div");
    hint.className = "qj-fb-hint";
    hint.textContent = "Las imágenes viajan otra vez en cada corrección (el modelo no recuerda la anterior). " +
      "📤 apaga la que no querés mandar; ✓ usar se incrusta igual.";
    row.appendChild(hint);
    row.appendChild(HPStills.createControl(m.slug, opts));

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

    // El botón grande de la ronda de feedback, igual que en la Cola y en las
    // tarjetas: es la acción de la fila, no un control más de la barra.
    var fixBtn = document.createElement("button");
    fixBtn.type = "button"; fixBtn.className = "qbtn qbtn-react";
    fixBtn.textContent = "↻ Regenerar";
    fixBtn.title = "Rediseña sobre esa versión y devuelve el clip a " + formatTime(m.start) +
      " de “" + destino + "”, con la misma duración, en una pista nueva y en amarillo.";
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
      enqueueCorrection(m, chosenVersion(), text, state);
    });

    // El HTML de la versión, cargado del disco. Antes esto era una caja vacía
    // pidiendo que pegaras un HTML, lo cual no tenía sentido: la pestaña acaba de
    // encontrar todas las versiones y sabe leerlas. Sirve para mirar qué tiene el
    // recurso antes de escribir la corrección, para retocarlo a mano sin gastar
    // IA, y para pegar una versión de afuera encima si eso es lo que querés.
    var htmlBox = document.createElement("details");
    htmlBox.className = "corr-html";
    var sum = document.createElement("summary");
    htmlBox.appendChild(sum);

    var editor = HPWidgets.makeCodeEditor();
    htmlBox.appendChild(editor.el);
    var renderBtn = document.createElement("button");
    renderBtn.type = "button"; renderBtn.className = "qbtn";
    renderBtn.textContent = "Renderizar y colocar";
    renderBtn.title = "Renderiza este HTML como versión nueva, sin llamar a la IA, y lo coloca en el tramo.";
    htmlBox.appendChild(renderBtn);
    row.appendChild(htmlBox);

    /** Qué versión está elegida en este momento. */
    function chosenVersion() {
      var v = pickVersion ? parseInt(pickVersion.value, 10) : m.latestVersion;
      return v || m.latestVersion;
    }

    var cargada = 0; // versión que está en el editor (0 = ninguna)
    function updateSummary() {
      sum.textContent = "Ver y editar el HTML de la v" + chosenVersion() + " (sin IA)";
    }
    updateSummary();

    /** Trae el HTML de la versión elegida, salvo que ya esté cargado. */
    function loadHtml() {
      var v = chosenVersion();
      updateSummary();
      if (cargada === v) return;
      var ctx = deps.context();
      state.className = "corr-state";
      state.textContent = "Leyendo la v" + v + "…";
      HPEngine.call("readMarkerHtml", {
        projectPath: ctx.projectPath, sequenceName: origen.sequenceName,
        markerSlug: m.slug, version: v
      }).then(function (r) {
        if (!r || !r.ok || typeof r.html !== "string") throw new Error((r && r.error) || "no pude leerlo");
        editor.setValue(r.html);
        cargada = v;
        state.className = "corr-state";
        state.textContent = "v" + v + " cargada. Podés retocarla y renderizar, sin gastar IA.";
      }).catch(function (e) {
        state.className = "corr-state is-error";
        state.textContent = "No pude leer el HTML de la v" + v + ": " + ((e && e.message) || e);
      });
    }

    htmlBox.addEventListener("toggle", function () { if (htmlBox.open) loadHtml(); });
    // Cambiar de versión con el editor abierto tiene que traer ESA versión: si no,
    // se renderizaría el HTML de una versión con la etiqueta de otra.
    if (pickVersion) {
      pickVersion.onChange = function () { if (htmlBox.open) loadHtml(); else updateSummary(); };
    }

    renderBtn.addEventListener("click", function () {
      var html = editor.getValue().trim();
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
    // Antes acá había un campo para escribir el segundo de destino. Sobra: el
    // clip cae en una pista nueva, arriba de todo, así que si el corte se movió
    // se arrastra en el timeline, que es más rápido y más seguro que calcularlo.
    nota.textContent = "El clip cae en el segundo del corte viejo, en una pista nueva: si se movió, arrastralo.";
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

  /**
   * Deja en el panel el transcript del corte donde nació el recurso. De ahí sale
   * el fragmento del marcador: qué se está diciendo en ese tramo, con los
   * tiempos. Puede faltar —ese corte quizá nunca se abrió en esta máquina— y
   * está en el disco, en su propia carpeta, así que se trae. Sin él el modelo
   * corrige sin el guion y la animación deja de acompañar lo que se dice.
   */
  function traerTranscript(projectPath, seqName) {
    var tiene = leerDe(seqName, function () { return (HPStore.getTranscript() || []).length; });
    if (tiene) return;
    HPEngine.call("loadTranscript", { projectPath: projectPath, sequenceName: seqName })
      .then(function (r) {
        if (!r || !r.ok || !r.found || !r.segments || !r.segments.length) return;
        leerDe(seqName, function () {
          HPStore.setTranscript(r.segments);
          HPStore.setTranscriptOffset(Number(r.offset) || 0);
        });
        hpLog("Corrections: traje del disco el transcript de “" + seqName + "” (" +
          r.segments.length + " segmentos): es el guion que va con estos recursos.");
      })
      .catch(function (e) {
        hpLog("Corrections: no pude traer el transcript de “" + seqName + "”: " +
          ((e && e.message) || e), "WARN");
      });
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
        if (origen.sequenceName) traerTranscript(ctx.projectPath, origen.sequenceName);
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
