/**
 * HPCorrectionsContexto — el panel “Lo que recibió este marcador” de una fila
 * de Corrections.
 *
 * El contexto con el que se generó un recurso, a la vista y editable: el prompt
 * general del curso, el de la secuencia, el objetivo de la clase y el encargo
 * del marcador. Son los cuatro pedazos que leyó el modelo, y hasta que esto
 * existió no se podían ver desde esa pestaña — se corregía a ciegas sobre un
 * contexto que uno se acordaba a medias.
 *
 * DOS cosas distintas se pueden estar mostrando, y no se mezclan sin avisar:
 *
 *  - **Lo que se mandó.** La ficha de la versión lo guardó. Es un dato, y se
 *    dice de qué versión salió.
 *  - **Una reconstrucción.** Ninguna versión lo guardó, así que lo que se
 *    muestra son los archivos del proyecto TAL COMO ESTÁN HOY. Pueden haber
 *    cambiado veinte veces desde que ese recurso se generó, y mirando esto se
 *    decide un rediseño: callarlo sería dejar que se tomen decisiones sobre un
 *    contexto inventado.
 *
 * Editar acá es un ajuste PARA ESA CORRECCIÓN. No reescribe los archivos del
 * proyecto: el prompt del curso lo comparten todas las clases y viaja en el
 * .prproj a las máquinas de los demás editores, así que reescribirlo desde una
 * fila donde uno está pensando en un clip suelto es cómo se le cambia el estilo
 * a un curso entero sin darse cuenta (ya pasó, con un solo campo y un destino
 * que se deducía del disco). Para que quede, hay una acción aparte, que aparece
 * recién cuando hay algo que guardar y dice a quién le llega.
 *
 * Va PLEGADO: la fila ya tiene nombre, tramo, versiones, el encargo, el campo
 * de corrección con su micrófono, las imágenes y el editor de HTML. Cuatro
 * campos de texto largos más, abiertos, la vuelven inmirable en un panel de 320
 * px. Lo que se lee sin abrir nada es el renglón del resumen, que es donde está
 * lo que hay que saber de un vistazo: si es un dato o una reconstrucción, y si
 * ya tiene un ajuste puesto.
 *
 * Vive en su propio archivo, y no adentro de corrections.js, porque es una
 * VISTA: tiene una sola entrada (build) y una sola salida ({ el, override,
 * instruction }), igual que las demás *-view.js del panel.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPCorrectionsContexto.
 */
(function (global) {
  "use strict";

  var hpLog = HPLog.log;

  /**
   * Las filas dibujadas ahora mismo, para poder avisarles entre ellas.
   *
   * Guardar un nivel desde una fila reescribe el archivo del proyecto, o sea la
   * RECONSTRUCCIÓN que las otras filas están mostrando. Sin esto, la fila de al
   * lado sigue con el texto anterior y la corrección que se mande desde ahí
   * viaja con él: el mismo estilo viejo, en la fila de al lado, sin que nada lo
   * diga. La lista la vacía corrections.js antes de volver a dibujar.
   */
  var vivas = [];

  function reset() { vivas.length = 0; }

  /**
   * Arma el panel de un recurso.
   *
   * `deps`:
   *   projectPath()   → la ruta del .prproj
   *   sequenceName()  → la secuencia de ORIGEN del recurso (donde nació, que
   *                     puede no ser la que el editor tiene abierta)
   *   promptsNow()    → el objeto VIVO con los dos prompts del proyecto como
   *                     están hoy ({ course, sequence, failed }); guardar acá lo
   *                     pone al día, y por eso se pide el objeto y no una copia
   *   objetivo()      → el objetivo de la clase
   */
  function build(m, state, deps) {
    var guardado = !!m.prompts;
    var rec = m.prompts || {};
    // Qué niveles de ESA versión se habían ajustado a mano en aquella
    // corrección. Lo anota la ficha, y es lo único que distingue "el archivo
    // cambió desde entonces" de "esto nunca salió del archivo".
    var ajustadoEntonces = (rec && rec.adjusted) || {};
    var promptsNow = deps.promptsNow();
    // El punto de partida de cada campo. Con ficha, lo que viajó; sin ficha, los
    // archivos de hoy (y el objetivo que tenga el panel, que tampoco se guardaba).
    var base = {
      course: guardado ? String(rec.course || "") : promptsNow.course,
      sequence: guardado ? String(rec.sequence || "") : promptsNow.sequence,
      objective: guardado ? String(rec.objective || "") : deps.objetivo(),
      instruction: m.instruction || ""
    };

    var caja = document.createElement("details");
    caja.className = "corr-prompts";
    var sum = document.createElement("summary");
    var titulo = document.createElement("span");
    titulo.className = "corr-prompts-title";
    titulo.textContent = "Lo que recibió este marcador";
    var tag = document.createElement("span");
    sum.appendChild(titulo);
    sum.appendChild(tag);
    caja.appendChild(sum);

    var nota = document.createElement("div");
    caja.appendChild(nota);

    var campos = {};   // clave → { ta, hint, btn, wrap }
    var tocado = {};   // clave → true cuando el editor lo cambió
    var opciones = {}; // clave → el descriptor con el que se dibujó el nivel

    /**
     * Si lo que hay en el campo se apartó de su punto de partida.
     *
     * Es la única definición de "ajustado" que hay acá, y por eso está una sola
     * vez: mientras estuvo escrita en tres lugares, uno de los tres —el de
     * después de guardar— la forzaba a `false` sin comparar, y el campo podía
     * mostrar una cosa mientras el pedido llevaba otra.
     */
    function marcar(key) {
      tocado[key] = campos[key].ta.value !== base[key];
      return tocado[key];
    }

    /** Qué claves tienen un ajuste puesto ahora mismo. */
    function ajustadas() {
      return Object.keys(campos).filter(function (k) { return !!tocado[k]; });
    }

    /**
     * El renglón que se lee con la fila plegada, y la nota de arriba. Son el
     * lugar donde se dice qué se está mirando: un dato, una reconstrucción, o un
     * ajuste que el editor puso y todavía no mandó.
     */
    function pintarEstado() {
      var ajuste = ajustadas();
      if (ajuste.length) {
        tag.className = "corr-prompts-tag is-adjusted";
        tag.textContent = "· ajustado para esta corrección";
      } else if (guardado) {
        tag.className = "corr-prompts-tag is-saved";
        tag.textContent = "· lo que se mandó al generar la v" + m.promptsVersion;
      } else {
        tag.className = "corr-prompts-tag is-rebuilt";
        tag.textContent = "· no quedó guardado: reconstruido";
      }
      nota.className = "corr-prompts-note" + (guardado ? "" : " is-rebuilt");
      nota.textContent = guardado
        ? "Esto es lo que se le mandó al modelo cuando se generó la v" + m.promptsVersion +
          ", tal como salió. Lo que edites vale para esta corrección y nada más: " +
          "los archivos del proyecto no se tocan."
        : (promptsNow.failed
          ? "De esta versión no se puede saber qué se mandó (se generó antes de que la ficha lo " +
            "guardara) y tampoco pude leer los archivos del proyecto. Los campos están vacíos " +
            "porque no se pudo leer, no porque no haya estilo: revisá que el disco del proyecto esté."
          : "De esta versión no se puede saber qué se mandó: se generó antes de que la ficha lo " +
            "guardara. Lo de abajo son los archivos del proyecto COMO ESTÁN HOY, que pueden haber " +
            "cambiado desde entonces — es una reconstrucción, no lo que recibió. De acá en adelante " +
            "sí queda guardado.");
    }

    /**
     * Guarda un nivel en su archivo del proyecto, de verdad y para siempre. Es
     * la acción explícita, y pregunta antes diciendo a quién le llega: el del
     * curso lo van a usar todas las clases y le va a llegar a cualquiera que abra
     * el .prproj.
     */
    function guardarNivel(o) {
      var c = campos[o.key];
      var esCurso = o.scope === "project";
      var quien = esCurso
        ? "Pasa a ser el Prompt general del curso: lo van a usar TODAS las clases de este " +
          "proyecto y le va a llegar a cualquiera que abra el .prproj (el archivo viaja al lado " +
          "del proyecto). Se reemplaza lo que diga hoy."
        : "Pasa a ser el Prompt de secuencia de “" + deps.sequenceName() + "”: lo van a usar " +
          "todos los marcadores de esa clase. No toca el prompt general del curso.";
      HPWidgets.confirmOverlay(o.saveTitle, function (body) {
        var p = document.createElement("p");
        p.textContent = quien;
        body.appendChild(p);
        // El texto de este campo salió de lo que se mandó hace un mes, no de lo
        // que el archivo dice hoy: guardarlo se lleva por delante lo que otro
        // editor haya escrito desde entonces. Es la única forma de perder trabajo
        // que deja abierta esta acción, así que se avisa donde todavía se cancela.
        if (o.difiere()) {
          var q = document.createElement("p");
          q.textContent = "OJO: el archivo dice otra cosa hoy. Lo que estás por guardar salió de lo " +
            "que se le mandó al modelo cuando se generó la v" + m.promptsVersion + ", no de lo que el " +
            "archivo dice ahora: al guardarlo se reemplaza el texto actual, con los cambios que le " +
            "haya hecho otro editor.";
          body.appendChild(q);
        }
        var r = document.createElement("p");
        r.textContent = "Si solo querés que valga para esta corrección, cancelá: el ajuste ya viaja " +
          "con este pedido sin guardar nada.";
        body.appendChild(r);
      }, o.saveTitle, function () {
        // El texto se lee ACÁ, cuando el editor aceptó, y no cuando apretó el
        // botón: entre las dos cosas hay una confirmación de cinco renglones, y
        // si tocó el campo mientras la leía, al archivo tiene que ir lo que el
        // campo dice AHORA. Leyéndolo antes se guardaba el texto viejo y el
        // campo quedaba mostrando otro, en la única función cuyo contrato entero
        // es que lo que ves es lo que viaja.
        var texto = c.ta.value;
        state.className = "corr-state";
        state.textContent = "Guardando…";
        HPGeneral.save(deps.projectPath(), deps.sequenceName(), texto, o.scope)
          .then(function () {
            var limpio = String(texto == null ? "" : texto).trim();
            // Guardado deja de ser un ajuste: ahora el archivo dice esto, y de
            // ahí lo va a leer la cola como para cualquier otra generación. Se
            // vuelve a COMPARAR en vez de darlo por hecho: si el editor siguió
            // tecleando mientras se escribía el archivo, lo que hay en el campo
            // sigue siendo un ajuste y tiene que viajar como tal.
            base[o.key] = limpio;
            promptsNow[o.key] = limpio;
            marcar(o.key);
            pintarBoton(o);
            pintarNivel(o);
            pintarEstado();
            // Las otras filas de la lista estaban mostrando el archivo anterior:
            // ahora dice esto, y la que reconstruye tiene que reconstruir con lo
            // de ahora o mandaría el viejo sin decirlo.
            avisarALasOtras(o.key, limpio);
            state.className = "corr-state is-ok";
            state.textContent = esCurso
              ? "Guardado en el archivo del curso: le llega a todas las clases y a quien abra el .prproj."
              : "Guardado en el archivo de “" + deps.sequenceName() + "”: vale para todos sus marcadores.";
            hpLog("Prompt " + (esCurso ? "general del curso" : "de secuencia (“" + deps.sequenceName() + "”)") +
              " guardado desde una fila de correcciones [" + m.slug + "].");
            // El encabezado tiene los mismos dos campos: si el del curso cambió,
            // tiene que dejar de mostrar el viejo.
            if (global.HPGeneralView && HPGeneralView.refresh) HPGeneralView.refresh();
          })
          .catch(function (e) {
            state.className = "corr-state is-error";
            state.textContent = "No pude guardarlo en el proyecto: " + ((e && e.message) || e);
          });
      });
    }

    /** El pie de un campo: qué alcance tiene lo que hay escrito ahí. */
    function pintarNivel(o) {
      var c = campos[o.key];
      var ajustado = !!tocado[o.key];
      var partes = [ajustado ? o.hintAjustado : o.hint];
      if (!ajustado && o.difiere()) {
        // Por qué lo que se muestra no es lo que dice el archivo. Son dos
        // motivos opuestos y el dato para distinguirlos está en la ficha: o el
        // archivo cambió desde entonces, o ese texto nunca salió del archivo
        // porque se ajustó a mano para aquella corrección. Decir siempre lo
        // primero le echaba la culpa a un archivo que no se tocó.
        partes.push(ajustadoEntonces[o.key]
          ? "Esto no salió del archivo: se ajustó a mano para aquella corrección, " +
            "y por eso no coincide con lo que el proyecto dice hoy."
          : "El archivo del proyecto dice otra cosa hoy: esto es lo que se mandó entonces.");
      }
      c.hint.textContent = partes.join(" ");
      c.hint.className = "corr-level-hint" + (ajustado ? " is-adjusted" : "");
    }

    /**
     * El botón de guardar para siempre se crea la primera vez que hay algo que
     * guardar. Dibujarlo siempre pondría dos acciones destructivas más en cada
     * fila —doce en una clase de seis recursos— para el caso raro.
     */
    function pintarBoton(o) {
      if (!o.scope) return;
      var c = campos[o.key];
      if (!c.btn) {
        if (!tocado[o.key]) return;
        var b = document.createElement("button");
        b.type = "button";
        b.className = "qbtn corr-level-save";
        b.textContent = o.saveTitle;
        b.title = o.saveTip;
        b.addEventListener("click", function () { guardarNivel(o); });
        c.btn = b;
        c.wrap.appendChild(b);
        return;
      }
      c.btn.setAttribute("data-hidden", tocado[o.key] ? "false" : "true");
    }

    /** Un nivel: rótulo, campo y pie. El botón de guardar aparece si hace falta. */
    function nivel(o) {
      var wrap = document.createElement("div");
      wrap.className = "corr-level";
      var lab = document.createElement("div");
      lab.className = "corr-level-label";
      lab.textContent = o.label;
      var ta = document.createElement("textarea");
      ta.className = "corr-level-input";
      ta.rows = o.rows;
      ta.value = base[o.key];
      ta.placeholder = o.placeholder;
      var hint = document.createElement("div");
      hint.className = "corr-level-hint";
      wrap.appendChild(lab);
      wrap.appendChild(ta);
      wrap.appendChild(hint);
      campos[o.key] = { ta: ta, hint: hint, btn: null, wrap: wrap };
      opciones[o.key] = o;

      // Los cuatro niveles se comportan igual al tipear; el único que tiene
      // scope suma el botón de guardarlo en el proyecto.
      ta.addEventListener("input", function () {
        marcar(o.key);
        pintarBoton(o);
        pintarNivel(o);
        pintarEstado();
      });
      pintarNivel(o);
      caja.appendChild(wrap);
    }

    /** Lo guardado y el archivo de hoy no dicen lo mismo. */
    function difiereDeHoy(key) {
      return function () {
        return guardado && !promptsNow.failed && base[key] !== promptsNow[key];
      };
    }

    /**
     * Otra fila guardó ese nivel en el proyecto. Lo que esta fila muestra puede
     * haber quedado viejo, y de dos maneras distintas:
     *
     *  - Si esta fila RECONSTRUYE (su versión no guardó nada), lo que ofrece es
     *    "el archivo de hoy" — y el archivo de hoy acaba de cambiar. Se pone al
     *    día, salvo que el editor ya haya escrito ahí: eso es suyo.
     *  - Si esta fila muestra lo que SU versión recibió, el texto no se toca (es
     *    historia, no una copia del archivo), pero el pie que compara con el
     *    archivo sí cambia de respuesta.
     */
    function ponerseAlDia(key, texto) {
      if (!campos[key]) return;
      if (!guardado && !tocado[key]) {
        base[key] = texto;
        campos[key].ta.value = texto;
      }
      pintarBoton(opciones[key]);
      pintarNivel(opciones[key]);
      pintarEstado();
    }

    function avisarALasOtras(key, texto) {
      vivas.forEach(function (otra) {
        if (otra.al !== ponerseAlDia) otra.al(key, texto);
      });
    }

    // En el orden en que le llegan al modelo: del curso entero al clip.
    nivel({
      key: "course", scope: "project", rows: 3,
      label: "Prompt general · todo el curso",
      placeholder: "El curso no tiene prompt general.",
      hint: "El estilo del curso: lo comparten todas las clases y viaja en el .prproj.",
      hintAjustado: "Ajustado para esta corrección. El archivo del curso NO se toca.",
      saveTitle: "Guardar para todo el curso",
      saveTip: "Escribe este texto en el archivo del curso. Lo van a usar todas las clases del proyecto " +
        "y le va a llegar a quien lo abra. Pregunta antes.",
      difiere: difiereDeHoy("course")
    });
    nivel({
      key: "sequence", scope: "sequence", rows: 3,
      label: "Prompt de secuencia · solo “" + HPUtil.shortenMiddle(deps.sequenceName(), 22) + "”",
      placeholder: "Esa clase no agrega nada al estilo del curso.",
      hint: "Lo propio de esa clase: manda donde contradiga al del curso.",
      hintAjustado: "Ajustado para esta corrección. El archivo de la secuencia NO se toca.",
      saveTitle: "Guardar para esta secuencia",
      saveTip: "Escribe este texto en el archivo de esa secuencia. Lo van a usar todos sus marcadores. " +
        "No toca el del curso. Pregunta antes.",
      difiere: difiereDeHoy("sequence")
    });
    nivel({
      key: "objective", scope: "", rows: 2,
      label: "Objetivo de la clase",
      placeholder: "Sin objetivo declarado.",
      hint: "De qué va la clase. Se escribe en la pestaña Marcadores.",
      hintAjustado: "Ajustado para esta corrección. Lo de la pestaña Marcadores queda como está.",
      difiere: function () { return false; }
    });
    nivel({
      key: "instruction", scope: "", rows: 2,
      label: "Encargo de este marcador",
      placeholder: "No quedó guardado qué se le pidió a este recurso.",
      // El único de los cuatro que no es compartido, y por eso el único que se
      // cambia para siempre sin preguntar: es de este recurso y de ningún otro.
      hint: "Lo que se le pidió a este recurso. La versión nueva nace con esto como su encargo.",
      hintAjustado: "La versión nueva nace con este encargo (es de este recurso y de ningún otro).",
      difiere: function () { return false; }
    });

    pintarEstado();
    vivas.push({ al: ponerseAlDia });

    return {
      el: caja,
      /**
       * El ajuste local, o null si no hay ninguno. Solo las claves que el editor
       * tocó: lo demás lo sigue diciendo el disco al momento de generar.
       */
      override: function () {
        var out = null;
        ["course", "sequence", "objective"].forEach(function (k) {
          if (!tocado[k]) return;
          out = out || {};
          out[k] = campos[k].ta.value;
        });
        return out;
      },
      /**
       * El encargo ajustado, o null si el editor no tocó ese campo (ahí manda lo
       * que diga la ficha del recurso).
       *
       * Se contesta por TOCADO y no por si hay texto, igual que los otros tres
       * niveles: vaciarlo es un ajuste válido —"esta versión nace sin encargo
       * escrito"— y es lo que el pie promete cuando el campo queda en blanco.
       * Mientras se contestaba el texto pelado, el vacío se leía como "no hay
       * nada que ajustar" y viajaba el encargo anterior: la fila se pintaba como
       * ajustada, el pie prometía que la versión nueva nacía con lo que había
       * escrito ahí, y al modelo le llegaba lo de siempre.
       */
      instruction: function () {
        if (!tocado.instruction) return null;
        return campos.instruction.ta.value.trim();
      }
    };
  }

  global.HPCorrectionsContexto = {
    /** Arma el panel de una fila. Ver build(). */
    build: build,
    /**
     * Se dibuja la lista de nuevo: las filas de antes ya no están en pantalla y
     * no tienen que enterarse de nada. La llama corrections.js antes de render.
     */
    reset: reset
  };
})(typeof window !== "undefined" ? window : this);
