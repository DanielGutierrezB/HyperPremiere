/**
 * HPGeneralView — los DOS bloques de prompts generales del panel.
 *
 * Son dos campos y dos archivos al lado del .prproj, que los administra
 * HPGeneral: el "Prompt general" del curso entero (se queda al cambiar de
 * secuencia) y el "Prompt de secuencia" de esta clase. Los dos viajan al modelo,
 * con la instrucción del marcador como tercer nivel. Acá está solamente lo que
 * se ve y se toca: los dos campos, el renglón de cada uno y el cartel de cuando
 * esta máquina y el proyecto no dicen lo mismo.
 *
 * Los dos bloques están SEPARADOS en la pantalla, y esta vista maneja los dos:
 * "Estilo del curso" arriba, junto al Contexto de la clase, porque no es de
 * ninguna clase; "Estilo de esta secuencia" adentro del área de marcadores,
 * porque es de ésta y de ninguna otra. Lo que se paga por separarlos es que la
 * relación entre los dos dejó de verse sola, y lo que la sostiene ahora son los
 * dos renglones: cada uno nombra al otro bloque, y la precedencia se dice una
 * sola vez, en el de la secuencia, que es el que gana.
 *
 * Que se diga qué viaja no es decoración: el bug entero fue no poder saberlo. El
 * segundo editor generaba con el campo vacío y el panel se callaba.
 *
 * Las REFERENCIAS —capturas, logos, PDFs— viajan igual que los textos y por el
 * mismo camino: cada bloque tiene la suya y cada una vive en archivos, la del
 * curso al lado del .prproj y la de la clase en la carpeta de su secuencia (ver
 * HPRefs). Hasta la 1.5.1 eran base64 en el localStorage de una máquina y solo
 * existían del lado de la secuencia, así que el renglón de arriba prometía
 * "viaja con el .prproj" mientras el manual de marca se quedaba en la máquina
 * que lo arrastró.
 *
 * La regla que sostiene todo esto: cada campo muestra y guarda SU archivo, y
 * nada más. Antes había un solo campo y un botón para cambiarle el destino
 * (`writeScope`), y ahí la regla había que defenderla a mano: si el campo y el
 * destino se separaban, lo que se tipeaba se guardaba en un lado y se leía del
 * otro, y así se reescribía el estilo del curso sin querer. Con un campo por
 * archivo eso no se puede escribir.
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

  /**
   * El micrófono del dictado, si esta máquina lo tiene. Devuelve el elemento o
   * `null`.
   *
   * El dictado es un AGREGADO a los campos, nunca un requisito: sin él, los
   * prompts generales se dibujan igual y se escriben a mano. La guarda está en
   * HPUtil.
   */
  var micOpcional = HPUtil.micOpcional;

  var deps = null;

  // Los dos bloques están separados en la pantalla y cada uno tiene lo suyo: su
  // badge (lo que se lee plegado) y su renglón. Que compartieran un resumen
  // combinado sería, en cada uno, decir algo que no es sobre el bloque que se
  // está mirando.
  var mount = null;
  var courseMount = null;
  var summary = null;
  var seqSummary = null;
  var sourceEl = null;
  var seqSourceEl = null;
  var conflict = null;
  var refsConflict = null;
  var seqSection = null;

  // Las dos cajas de referencias, ya montadas: una por bloque. Se guardan para
  // poder repintarlas sin volver a crearlas, que es lo que deja que una escritura
  // asincrónica que vuelve del disco actualice la caja que el editor tiene
  // adelante en vez de una copia vieja.
  var courseRefs = null;
  var seqRefs = null;

  // Los dos niveles, cada uno con su campo y su archivo. `scope` es el que
  // entiende HPGeneral.save: cuál de los dos se está guardando.
  var niveles = [
    { scope: "project", id: "general-instruction", mic: "prompt-general", texto: "courseText", input: null },
    { scope: "sequence", id: "general-sequence-instruction", mic: "prompt-secuencia", texto: "sequenceText", input: null }
  ];

  var seqLabel = null;
  var seqRow = null;

  // Qué hidratación es la que vale y en qué campos ya escribió el editor. Sin
  // esto, la respuesta del disco (que llega cientos de ms después) le pisa el
  // campo al que ya empezó a tipear.
  var hidratacion = 0;
  var tecleado = {};

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

  /**
   * El badge de cada encabezado plegado: qué hay en ESE nivel.
   *
   * Los adjuntos se cuentan en el badge del bloque DONDE ESTÁN, cada uno con los
   * suyos. Antes había un solo contador —el de la secuencia— porque las
   * referencias eran una sola bolsa; con dos niveles, sumarlos en un badge sería
   * decir en el bloque del curso que hay material que en realidad es de una clase.
   */
  function refreshSummary() {
    var v = vista();
    var c = ctx();
    if (summary) {
      var nCurso = HPRefs.count(c.projectPath, c.sequenceName, "course");
      var adjCurso = nCurso && v.courseBadgeState !== "warn" ? " · " + nCurso + " adj." : "";
      summary.textContent = v.courseBadge + adjCurso;
      summary.className = "cfg-summary section-state is-" + v.courseBadgeState;
    }
    if (seqSummary) {
      var n = HPRefs.count(c.projectPath, c.sequenceName, "sequence");
      var adj = n && v.sequenceBadgeState !== "warn" ? " · " + n + " adj." : "";
      seqSummary.textContent = v.sequenceBadge + adj;
      seqSummary.className = "cfg-summary section-state is-" + v.sequenceBadgeState;
    }
  }

  function pintarRenglon(el, texto, estado) {
    if (!el) return;
    el.textContent = texto;
    el.className = "general-source" + (estado ? " is-" + estado : "");
  }

  /**
   * Los renglones que dicen qué le va a llegar al modelo. Son dos, uno por
   * bloque, y cada uno nombra al otro: separados, es lo único que sostiene que
   * se entienda que los dos viajan y cuál manda. Las palabras las arma
   * HPGeneral.describe, que es donde se prueban.
   */
  function pintarOrigen() {
    var v = vista();
    pintarRenglon(sourceEl, v.courseLine, v.courseLineState);
    pintarRenglon(seqSourceEl, v.sequenceLine, v.sequenceLineState);
    // El rótulo nombra la secuencia: es la mitad de "nunca dudar de dónde estás
    // escribiendo", y la otra mitad es que sean dos campos distintos.
    if (seqLabel) seqLabel.textContent = v.sequenceLabel;
    // Sin secuencia abierta no hay carpeta donde guardar nada de esta clase, así
    // que no se ofrece el bloque entero —ni el campo ni las referencias— en vez
    // de aceptar cosas que no tendrían dónde ir.
    if (seqSection) seqSection.setAttribute("data-hidden", v.sequenceEnabled ? "false" : "true");
    if (seqRow) seqRow.setAttribute("data-hidden", v.sequenceEnabled ? "false" : "true");
  }

  /**
   * El cartel de cuando esta máquina y el proyecto no dicen lo mismo.
   *
   * Esto NO era parte del botón de destino: es lo que queda de la migración del
   * localStorage, y sigue haciendo falta. De un lado está lo que escribió el
   * editor que tiene el panel adelante y del otro lo que puso su compañero en el
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
      ["Es el de esta clase", "sequence", "Lo guarda como Prompt de secuencia: se suma al general del curso y manda donde se contradigan."],
      ["Que sea el general del curso", "project", "Reemplaza el Prompt general del curso. Le va a llegar a todas las secuencias y a la otra máquina."],
      ["Descartarlo", "discard", "Se queda el del proyecto y este texto se borra."]
    ].forEach(function (o) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = o[0];
      b.title = o[2];
      b.addEventListener("click", function () {
        var c = ctx();
        HPGeneral.resolvePending(c.projectPath, c.sequenceName, o[1]).then(function () { pintar(); }, fallo);
      });
      acciones.appendChild(b);
    });
    conflict.appendChild(acciones);
  }

  /** Nunca se le escribe encima a ningún campo (el guardado con debounce). */
  function ninguno() { return false; }

  /**
   * Redibuja todo con lo que ya está en la caché. `escribible(scope)` decide, por
   * campo, si se le puede escribir el valor del disco encima: hay dos momentos
   * en que hacerlo le borraría al editor lo que está tipeando —el guardado con
   * debounce y la respuesta tardía del disco— y son por campo, porque tener uno
   * a medio escribir no es motivo para dejar el otro sin actualizar.
   */
  function pintar(escribible) {
    var v = vista();
    var puede = escribible || function () { return true; };
    niveles.forEach(function (n) {
      if (n.input && puede(n.scope)) n.input.value = v[n.texto];
    });
    pintarConflicto();
    pintarReferencias();
    pintarOrigen();
    refreshSummary();
  }

  /** Las dos cajas de referencias y el cartel de las que quedaron en el limbo. */
  function pintarReferencias() {
    if (courseRefs) HPRefsView.refresh(courseRefs);
    if (seqRefs) HPRefsView.refresh(seqRefs);
    HPRefsView.renderConflict(refsConflict);
  }

  function fallo(e) {
    if (deps && deps.setOutput) {
      deps.setOutput("No pude guardar el prompt general en el proyecto: " + ((e && e.message) || e), true);
    }
  }

  /** Lo que hace cada tecleo: guardar ESE campo en SU archivo. */
  function guardar(n) {
    var c = ctx();
    HPGeneral.save(c.projectPath, c.sequenceName, n.input.value, n.scope)
      .then(function () { pintar(ninguno); })
      .catch(fallo);
  }

  global.HPGeneralView = {
    init: function (d) {
      deps = d || {};

      mount = document.getElementById("general-stills-mount");
      courseMount = document.getElementById("general-course-refs");
      summary = document.getElementById("general-summary");
      sourceEl = document.getElementById("general-source");
      conflict = document.getElementById("general-conflict");
      refsConflict = document.getElementById("general-refs-conflict");
      seqSection = document.getElementById("general-sequence-section");
      seqSummary = document.getElementById("general-sequence-summary");
      seqSourceEl = document.getElementById("general-sequence-source");
      seqLabel = document.getElementById("general-sequence-label");
      seqRow = document.getElementById("general-sequence-row");

      niveles.forEach(function (n) {
        n.input = document.getElementById(n.id);
        if (!n.input) return;
        // Se marca en el evento crudo y no en el guardado: entre la primera
        // tecla y el debounce hay 300 ms, y es justo cuando llega el disco.
        n.input.addEventListener("input", function () { tecleado[n.scope] = true; });
        n.input.addEventListener("input", HPUtil.debounce(function () { guardar(n); }, DEBOUNCE_MS));
        // Los prompts generales son los campos más largos que se escriben a mano
        // en el panel (marca, paleta, tipografía, tono), así que son los que más
        // se agradecen dictar. Van sin debounce: lo que escribe el dictado ya es
        // el texto final, no una tecla.
        var mic = micOpcional(n.input, { id: n.mic, onChange: function () { guardar(n); } });
        if (mic) n.input.parentNode.insertBefore(mic, n.input.nextSibling);
      });
    },

    /**
     * Arranca (o rearranca) el bloque para el contexto actual. Es el único lugar
     * desde donde se MIGRA lo que quedara en el localStorage de esta máquina:
     * subir algo al proyecto es una decisión de la interfaz, no un efecto de que
     * alguien haya leído.
     */
    hydrate: function () {
      var c = ctx();
      // Las cajas se recrean por contexto: cada una queda atada al nivel que
      // dibuja, y lo que muestran sale de la caché de ESE nivel.
      if (courseMount) {
        courseMount.innerHTML = "";
        courseRefs = HPRefsView.createControl("course");
        courseMount.appendChild(courseRefs);
      }
      if (mount) {
        mount.innerHTML = "";
        seqRefs = HPRefsView.createControl("sequence");
        mount.appendChild(seqRefs);
      }
      var turno = ++hidratacion;
      tecleado = {};
      pintar();
      // Si mientras tanto se cambió de secuencia, o el editor ya empezó a
      // escribir en ese campo, el campo NO se toca: pisarlo le borra lo que tipeó.
      var repintar = function () {
        pintar(function (scope) { return turno === hidratacion && !tecleado[scope]; });
      };
      // El disco manda, pero tarda: se pinta lo cacheado y se repinta al volver.
      // También si falló: el renglón tiene que decir que no se pudo leer.
      //
      // Las dos migraciones —la del texto y la de las referencias— salen SOLO de
      // acá y por el mismo motivo: subir al proyecto algo que estaba en una
      // máquina es una decisión de la interfaz, no un efecto de que alguien haya
      // leído. Desde la cola, encolar una corrección de otro corte le habría
      // subido a los dos editores material que nadie pidió mover.
      HPGeneral.migrate(c.projectPath, c.sequenceName).then(repintar, repintar);
      HPRefs.migrate(c.projectPath, c.sequenceName).then(repintar, repintar);
    },

    /**
     * Redibuja los dos campos con lo que hay en la caché, sin migrar ni volver a
     * montar nada. Lo llama la pestaña de correcciones cuando guarda el prompt
     * del curso desde una fila: es el mismo archivo, y estos campos no pueden
     * quedar mostrando el texto anterior.
     */
    refresh: function () { pintar(); },

    /** Las imágenes del prompt general cambiaron (las cuenta el badge). */
    refreshSummary: refreshSummary
  };
})(typeof window !== "undefined" ? window : this);
