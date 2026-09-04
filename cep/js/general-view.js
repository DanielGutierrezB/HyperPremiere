/**
 * HPGeneralView — el bloque "Prompt general" del encabezado del panel.
 *
 * El TEXTO vive al lado del .prproj y lo administra HPGeneral (una base del
 * proyecto y, si una clase lo necesita, uno propio de la secuencia que la pisa).
 * Acá está solamente lo que se ve y se toca: el campo, el renglón que dice de
 * cuál de los dos sale lo que se está por mandar, el botón que cambia de destino
 * y el cartel de cuando esta máquina y el proyecto no dicen lo mismo.
 *
 * Que se diga de dónde sale no es decoración: el bug entero fue no poder
 * saberlo. El segundo editor generaba con el campo vacío y el panel se callaba.
 *
 * Las IMÁGENES de referencia siguen siendo por secuencia y en esta máquina (ver
 * el README): son base64 y no entran en un archivo de texto al lado del
 * proyecto sin cambiarles el almacenamiento.
 *
 * La regla que sostiene todo esto: el campo muestra SIEMPRE el archivo al que
 * escribe (`fieldText`), y el destino solo cambia con las dos acciones del
 * botón. Si el campo y el destino se separan, lo que se tipea se guarda en un
 * lado y se lee del otro, y así se reescribe la base de todo el proyecto sin
 * querer.
 *
 * Deps de main vía init(deps):
 *   context()            → { projectPath, sequenceName } del panel
 *   setOutput(txt, err)  → la línea de resultado de arriba de todo
 *
 * Vanilla JS, sin ES modules: se expone como window.HPGeneralView.
 */
(function (global) {
  "use strict";

  var DEBOUNCE_MS = 300;

  var hpLog = HPLog.log;

  /**
   * El micrófono del dictado, si esta máquina lo tiene. Devuelve el elemento o
   * `null`.
   *
   * El dictado es un AGREGADO al campo, nunca un requisito, y las situaciones en
   * las que el módulo NO está son reales: Windows (donde el botón va
   * deshabilitado por decisión tomada), una máquina sin Whisper instalado, y que
   * `js/dictado.js` no llegue a evaluarse. En los tres casos el prompt general
   * tiene que dibujarse igual y escribirse a mano.
   *
   * La guarda vive en cada archivo que la usa y no en un módulo común a
   * propósito: un módulo común sería otra cosa que puede faltar, o sea el mismo
   * bug una capa más arriba.
   */
  function micOpcional(ta, opts) {
    if (typeof HPDictado === "undefined" || !HPDictado || typeof HPDictado.attachMic !== "function") return null;
    try { return HPDictado.attachMic(ta, opts).el; } catch (e) { return null; }
  }

  var deps = null;

  var input = null;
  var mount = null;
  var summary = null;
  var sourceEl = null;
  var scopeBtn = null;
  var baseBox = null;
  var baseText = null;
  var conflict = null;

  // Qué hidratación es la que vale y si el editor ya escribió en esta. Sin
  // esto, la respuesta del disco (que llega cientos de ms después) le pisa el
  // campo al que ya empezó a tipear.
  var hidratacion = 0;
  var tecleado = false;

  function ctx() {
    return (deps && deps.context && deps.context()) || { projectPath: "", sequenceName: "" };
  }
  function estado() {
    var c = ctx();
    return HPGeneral.state(c.projectPath, c.sequenceName);
  }
  function vista() {
    var c = ctx();
    return HPGeneral.describe(c.projectPath, c.sequenceName);
  }

  /** El badge del encabezado plegado: qué estilo viaja y cuántos adjuntos hay. */
  function refreshSummary() {
    if (!summary) return;
    var v = vista();
    var g = HPStore.getMarkerData(HPStore.GENERAL_KEY);
    var n = (g.stills ? g.stills.length : 0) + (g.resources ? g.resources.length : 0);
    // Los adjuntos se cuentan aparte porque son de esta secuencia y de esta
    // máquina: no van con el texto ni viajan con el proyecto.
    summary.textContent = v.badge + (n && v.badgeState === "ok" ? " · " + n + " adj." : "");
    summary.className = "cfg-summary section-state is-" + v.badgeState;
  }

  /** El renglón que dice de dónde sale lo que está escrito en el campo. */
  function pintarOrigen() {
    var v = vista();
    if (sourceEl) {
      sourceEl.textContent = v.line;
      sourceEl.className = "general-source" + (v.lineState ? " is-" + v.lineState : "");
    }
    if (baseBox) {
      baseBox.setAttribute("data-hidden", v.showBase ? "false" : "true");
      if (baseText) baseText.textContent = v.baseText;
    }
    if (scopeBtn) {
      scopeBtn.setAttribute("data-hidden", v.offerOwn ? "false" : "true");
      scopeBtn.textContent = v.ownLabel;
      scopeBtn.title = v.ownTitle;
    }
  }

  /**
   * El cartel de cuando esta máquina y el proyecto no dicen lo mismo.
   *
   * No se resuelve solo a propósito: de un lado está lo que escribió el editor
   * que tiene el panel adelante y del otro lo que puso su compañero en el
   * proyecto. Elegir por ellos es tirar el trabajo de alguno de los dos sin
   * decírselo, que es justo la forma de perder trabajo que este cambio vino a
   * sacar. Las tres salidas cubren las tres cosas que ese texto puede ser.
   */
  function pintarConflicto() {
    if (!conflict) return;
    var st = estado();
    conflict.innerHTML = "";
    if (!st.pending) { conflict.setAttribute("data-hidden", "true"); return; }
    conflict.setAttribute("data-hidden", "false");

    var t = document.createElement("p");
    t.className = "general-conflict-title";
    t.textContent = "Tenías un prompt general guardado en esta máquina que no coincide con el del proyecto. " +
      "No se pisó ninguno: decidí qué es el tuyo.";
    conflict.appendChild(t);

    var pre = document.createElement("div");
    pre.className = "general-conflict-text";
    pre.textContent = st.pending;
    conflict.appendChild(pre);

    var acciones = document.createElement("div");
    acciones.className = "general-conflict-actions";
    [
      ["Es el de esta clase", "sequence", "Lo guarda como prompt propio de esta secuencia: pisa la base del proyecto solo acá."],
      ["Que sea la base de todo el proyecto", "project", "Reemplaza la base del proyecto. Le va a llegar a todas las secuencias y a la otra máquina."],
      ["Descartarlo", "discard", "Se queda el del proyecto y este texto se borra."]
    ].forEach(function (o) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = o[0];
      b.title = o[2];
      b.addEventListener("click", function () {
        var c = ctx();
        // Contestar el conflicto puede cambiar el destino de escritura, así que
        // el campo se repinta: campo y destino no pueden quedar separados.
        HPGeneral.resolvePending(c.projectPath, c.sequenceName, o[1]).then(function () { pintar(); }, fallo);
      });
      acciones.appendChild(b);
    });
    conflict.appendChild(acciones);
  }

  /**
   * Redibuja todo con lo que ya está en la caché. `escribirCampo: false` deja el
   * textarea como está, para las dos veces que pisarlo sería borrarle al editor
   * lo que está tipeando: el guardado con debounce y la respuesta tardía del
   * disco. Toda transición de destino, en cambio, SÍ repinta.
   */
  function pintar(opts) {
    if (input && (!opts || opts.escribirCampo !== false)) input.value = vista().fieldText;
    pintarConflicto();
    pintarOrigen();
    refreshSummary();
  }

  function fallo(e) {
    if (deps && deps.setOutput) {
      deps.setOutput("No pude guardar el prompt general en el proyecto: " + ((e && e.message) || e), true);
    }
  }

  function guardar() {
    var c = ctx();
    var v = vista();
    HPGeneral.save(c.projectPath, c.sequenceName, input.value, v.scope)
      .then(function () { pintar({ escribirCampo: false }); })
      .catch(fallo);
  }

  /** "Volver a la base del proyecto": se borra texto escrito, así que se pregunta. */
  function volverALaBase() {
    var c = ctx();
    var st = estado();
    HPWidgets.confirmOverlay("Volver a la base del proyecto", function (body) {
      var p = document.createElement("p");
      p.textContent = "Se borra el prompt propio de esta secuencia y vuelve a valer la base del proyecto.";
      body.appendChild(p);
      var q = document.createElement("p");
      q.className = "muted";
      // Puede estar vacío: el editor borró el texto para reescribirlo y todavía
      // no escribió nada. Ahí no se pierde nada, y decir "se pierde: " a secas
      // haría dudar de si hay algo que no se está mostrando.
      q.textContent = st.sequenceText
        ? "Se pierde: " + st.sequenceText
        : "Esta clase no tiene nada escrito propio: no se pierde texto, solo vuelve a escribirse en la base.";
      body.appendChild(q);
      var r = document.createElement("p");
      r.className = "muted";
      r.textContent = "Queda: " + (st.projectText || "(el proyecto no tiene base)");
      body.appendChild(r);
    }, "Volver a la base", function () {
      HPGeneral.switchScope(c.projectPath, c.sequenceName, "project").then(function () {
        hpLog("Prompt general: “" + c.sequenceName + "” vuelve a usar la base del proyecto.");
        pintar();
      }).catch(fallo);
    });
  }

  /** "Usar uno propio para esta secuencia": arranca con una copia de la base. */
  function usarPropio() {
    var c = ctx();
    HPGeneral.switchScope(c.projectPath, c.sequenceName, "sequence").then(function () {
      hpLog("Prompt general: “" + c.sequenceName + "” pasa a tener el suyo (copia de la base del proyecto).");
      pintar();
      if (input) input.focus();
    }).catch(fallo);
  }

  global.HPGeneralView = {
    init: function (d) {
      deps = d || {};

      input = document.getElementById("general-instruction");
      mount = document.getElementById("general-stills-mount");
      summary = document.getElementById("general-summary");
      sourceEl = document.getElementById("general-source");
      scopeBtn = document.getElementById("btn-general-scope");
      baseBox = document.getElementById("general-base");
      baseText = document.getElementById("general-base-text");
      conflict = document.getElementById("general-conflict");

      if (input) {
        // Se marca en el evento crudo y no en el guardado: entre la primera
        // tecla y el debounce hay 300 ms, y es justo cuando llega el disco.
        input.addEventListener("input", function () { tecleado = true; });
        input.addEventListener("input", HPUtil.debounce(guardar, DEBOUNCE_MS));
        // El prompt general es el campo más largo que se escribe a mano en el
        // panel (marca, paleta, tipografía, tono), así que es el que más se
        // agradece dictar. Va sin debounce: lo que escribe el dictado ya es el
        // texto final, no una tecla.
        var mic = micOpcional(input, { id: "prompt-general", onChange: guardar });
        if (mic) input.parentNode.insertBefore(mic, input.nextSibling);
      }

      if (scopeBtn) {
        scopeBtn.addEventListener("click", function () {
          if (estado().writeScope === "sequence") volverALaBase();
          else usarPropio();
        });
      }
    },

    /**
     * Arranca (o rearranca) el bloque para el contexto actual. Es el único lugar
     * desde donde se MIGRA lo que quedara en el localStorage de esta máquina:
     * subir algo al proyecto es una decisión de la interfaz, no un efecto de que
     * alguien haya leído.
     */
    hydrate: function () {
      var c = ctx();
      if (mount) {
        mount.innerHTML = "";
        mount.appendChild(HPStills.createControl(HPStore.GENERAL_KEY));
      }
      var turno = ++hidratacion;
      tecleado = false;
      pintar();
      // Si mientras tanto se cambió de secuencia, o el editor ya empezó a
      // escribir, el campo NO se toca: pisarlo le borra lo que tipeó.
      var repintar = function () { pintar({ escribirCampo: turno === hidratacion && !tecleado }); };
      // El disco manda, pero tarda: se pinta lo cacheado y se repinta al volver.
      // También si falló: el renglón tiene que decir que no se pudo leer.
      HPGeneral.migrate(c.projectPath, c.sequenceName).then(repintar, repintar);
    },

    /** Las imágenes del prompt general cambiaron (las cuenta el badge). */
    refreshSummary: refreshSummary
  };
})(typeof window !== "undefined" ? window : this);
