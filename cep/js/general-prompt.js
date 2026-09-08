/**
 * HPGeneral — de dónde salen los DOS prompts generales que arman el contexto:
 * el "Prompt general" (el del curso entero) y el "Prompt de secuencia" (el de
 * esta clase). Con la instrucción de cada marcador son los tres niveles.
 *
 * Vivían en el localStorage del panel, con una clave por proyecto Y secuencia, o
 * sea que NO viajaban con el .prproj. El editor que lo escribía generaba con la
 * marca, la paleta y la tipografía puestas; el compañero abría el mismo proyecto
 * y generaba con el campo vacío. Misma clase, mismo marcador, animaciones
 * peores, y nada en el panel que se lo dijera.
 *
 * Ahora la fuente de verdad es el disco, al lado del proyecto (ver
 * loadGeneralPrompt en bridge/store/project-fs.js): un archivo con el del CURSO,
 * arriba de las carpetas de secuencia, y uno con el de la CLASE adentro de la
 * suya. Los dos viajan al modelo; el de la clase no reemplaza al del curso, se
 * le suma, y donde se contradigan manda el de la clase (eso se le dice al modelo
 * con todas las letras en bridge/prompt/build-context.js).
 *
 * Este módulo es el único que sabe eso: mantiene una caché sincrónica por
 * proyecto+secuencia —porque la cola, la pestaña de correcciones y las tarjetas
 * leen sin poder esperar—, hace la migración de lo que ya estaba en localStorage
 * y sostiene el conflicto cuando las dos cosas existen y no dicen lo mismo.
 *
 * Tres cosas que conviene tener claras antes de tocar nada acá:
 *
 *  1. `load()` LEE Y NADA MÁS. La migración (subir lo local al proyecto,
 *     limpiarlo, apartar el pendiente) es `migrate()`, y la llama una sola
 *     cosa: la vista, una vez por contexto. La cola llama `load`. Cuando la
 *     migración vivía adentro de la lectura, encolar una corrección de otro
 *     corte podía promover al prompt general del curso un texto que estaba en
 *     una sola máquina, desde un camino que nadie mira.
 *  2. Cada campo escribe en SU archivo y en ninguno más. No hay un destino que
 *     elegir —eso era `writeScope`, y con un solo campo hacía falta—, pero la
 *     regla que sostenía sigue viva: vaciar un campo no puede tocar el otro
 *     archivo. Ver save().
 *  3. `save()` no relee: actualiza la caché con lo que contestó el motor. Cada
 *     tecleo de los campos pasa por acá, y releer costaba una llamada de más.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPGeneral.
 */
(function (global) {
  "use strict";

  var hpLog = HPLog.log;

  // clave "proyecto::secuencia" → estado leído del disco (ver estadoVacio).
  var cache = {};

  function claveDe(projectPath, sequenceName) {
    return String(projectPath || "") + "::" + String(sequenceName || "");
  }

  function rutasVacias() {
    return { project: "", sequence: "", sequenceLegacy: "" };
  }

  function estadoVacio() {
    return {
      // Los dos niveles, por separado: los dos viajan al modelo.
      projectText: "", sequenceText: "",
      // Que el archivo del curso EXISTA aunque esté vacío es un dato: el
      // proyecto decidió que no hay estilo, y entonces no hay nada que migrar.
      hasProjectFile: false,
      // El de esta clase se leyó del nombre que tenía antes de la 1.5.0.
      sequenceLegacy: false,
      // El texto local que quedó en el limbo esperando que el editor decida.
      pending: "",
      paths: rutasVacias(),
      // false = todavía no se leyó el disco de este contexto. Los lectores
      // sincrónicos lo miran para no confundir "no hay" con "no sé".
      loaded: false,
      // true = se intentó leer y el motor no pudo. Es la tercera cosa: ni "no
      // hay" ni "no sé todavía", sino "no se sabe y no se va a saber".
      failed: false
    };
  }

  /** El prompt general que esta máquina tenía guardado para esa secuencia. */
  function localDe(projectPath, sequenceName) {
    try {
      return HPStore.withContext(projectPath, sequenceName, function () {
        return String((HPStore.getMarkerData(HPStore.GENERAL_KEY) || {}).instruction || "").trim();
      });
    } catch (e) { return ""; }
  }

  function borrarLocal(projectPath, sequenceName) {
    try {
      HPStore.withContext(projectPath, sequenceName, function () {
        HPStore.setMarkerInstruction(HPStore.GENERAL_KEY, "");
      });
    } catch (e) {}
  }

  function pendingDe(projectPath, sequenceName) {
    try {
      return HPStore.withContext(projectPath, sequenceName, function () {
        return HPStore.getGeneralPending();
      });
    } catch (e) { return ""; }
  }

  function setPending(projectPath, sequenceName, text) {
    try {
      HPStore.withContext(projectPath, sequenceName, function () {
        HPStore.setGeneralPending(text);
      });
    } catch (e) {}
  }

  /** El estado cacheado de este contexto, o uno vacío si nunca se leyó. */
  function estado(projectPath, sequenceName) {
    var st = cache[claveDe(projectPath, sequenceName)];
    return st ? st : estadoVacio();
  }

  /** Arma el estado que se cachea a partir de lo que contestó el motor. */
  function estadoDe(r, previo, pending) {
    return {
      projectText: String((r && r.projectText) || ""),
      sequenceText: String((r && r.sequenceText) || ""),
      hasProjectFile: !!(r && r.hasProjectFile),
      sequenceLegacy: !!(r && r.sequenceLegacy),
      pending: String(pending || ""),
      paths: (r && r.paths) ? r.paths : ((previo && previo.paths) || rutasVacias()),
      loaded: true,
      failed: false
    };
  }

  /**
   * Trae del disco los dos prompts de este contexto. LECTURA PURA: no escribe
   * archivos y no toca el localStorage.
   *
   * Eso importa porque la cola llama acá por la secuencia de CUALQUIER job —uno
   * restaurado de otra sesión, una corrección de otro corte—, y un camino que no
   * es la interfaz no puede escribirle nada a nadie.
   */
  function load(projectPath, sequenceName) {
    var clave = claveDe(projectPath, sequenceName);
    return HPEngine.call("loadGeneralPrompt", {
      projectPath: projectPath, sequenceName: sequenceName
    }).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error) || "el motor no pudo leer el prompt general");
      var st = estadoDe(r, cache[clave], pendingDe(projectPath, sequenceName));
      cache[clave] = st;
      return st;
    }).catch(function (e) {
      // Sin motor (o con el proyecto en un disco que no está), lo peor que se
      // puede hacer es dar por sentado que no hay estilo: quedaría generando en
      // blanco, que es el bug original. Se sigue con lo que haya en esta máquina
      // —que era el estilo del curso— y se dice, en vez de callar y que se
      // descubra viendo el video.
      var local = localDe(projectPath, sequenceName);
      var st = estadoVacio();
      st.projectText = local;
      st.pending = pendingDe(projectPath, sequenceName);
      st.failed = true;
      cache[clave] = st;
      hpLog("Prompt general: no pude leerlo del proyecto (" + ((e && e.message) || e) + "). " +
        (local ? "Sigo con el que tenés guardado en esta máquina." : "Se genera sin él."), "WARN");
      return st;
    });
  }

  // Contextos a los que ya se les avisó del archivo con el nombre viejo. Una vez
  // por sesión y por secuencia: es una nota al pie, no una alarma.
  var avisadoViejo = {};

  /**
   * El prompt de esta clase se leyó del nombre que tenía antes de la 1.5.0.
   *
   * No hay nada que hacer —se leyó igual y se consolida solo al guardarlo—, pero
   * el log es donde en este panel se descubre de dónde salió el contexto de una
   * generación, y un archivo que cambia de nombre solo merece un renglón ahí. Va
   * únicamente por el camino de la vista: la cola lee por cualquier job y
   * repetirlo por cada uno sería ruido.
   */
  function avisarFormatoViejo(projectPath, sequenceName, st) {
    var clave = claveDe(projectPath, sequenceName);
    if (!st.sequenceLegacy || avisadoViejo[clave]) return;
    avisadoViejo[clave] = true;
    hpLog("Prompt de secuencia: “" + sequenceName + "” lo tiene en el archivo del formato viejo (" +
      st.paths.sequenceLegacy + "). Se lee igual, y la próxima vez que lo guardes queda como " +
      "prompt-secuencia.md. No tenés que hacer nada.");
  }

  /**
   * Lee y, además, MIGRA lo que hubiera quedado en el localStorage de esta
   * máquina. La llama la vista una vez por contexto y nadie más.
   *
   * Las tres salidas de la migración, y por qué:
   *
   *  - Hay algo acá y el proyecto no tiene nada escrito → se escribe como el
   *    prompt general del curso. Es el caso normal al actualizar: lo que el
   *    editor venía usando pasa a viajar con el .prproj.
   *  - Dice exactamente lo mismo que el proyecto → la copia local sobra y se
   *    borra, sin molestar a nadie.
   *  - Hay las dos cosas y DIFIEREN → no se toca ninguna. La copia local se
   *    aparta entera y el panel pregunta qué es: el prompt de esta clase, el
   *    general del curso, o algo que ya no sirve. Pisar en silencio, para
   *    cualquiera de los dos lados, es tirar trabajo del editor; y acá los dos
   *    lados pueden ser de personas distintas.
   */
  function migrate(projectPath, sequenceName) {
    return load(projectPath, sequenceName).then(function (st) {
      // El disco no contestó: no hay contra qué comparar, y mover algo con la
      // mitad de la información es la forma más cara de equivocarse.
      if (!st.loaded) return st;
      avisarFormatoViejo(projectPath, sequenceName, st);
      var local = localDe(projectPath, sequenceName);
      if (!local) return st;

      if (!st.hasProjectFile && !st.sequenceText) {
        return save(projectPath, sequenceName, local, "project").then(function (nuevo) {
          borrarLocal(projectPath, sequenceName);
          hpLog("Prompt general: lo que tenías guardado en esta máquina para “" + sequenceName +
            "” pasó a ser el prompt general del curso (" + nuevo.paths.project + "). Desde ahora viaja con el .prproj.");
          return nuevo;
        });
      }

      if (local === st.projectText || local === st.sequenceText) {
        borrarLocal(projectPath, sequenceName);
        return st;
      }

      // Ni se pisa el proyecto ni se tira lo de acá: queda apartado hasta que
      // el editor diga qué es. Sacarlo de `instruction` es lo que deja a los
      // campos mostrar lo que DE VERDAD viaja sin que escribir encima lo borre.
      setPending(projectPath, sequenceName, local);
      borrarLocal(projectPath, sequenceName);
      st.pending = local;
      hpLog("Prompt general: “" + sequenceName + "” tiene uno guardado en esta máquina que NO coincide " +
        "con el del proyecto. No se pisó ninguno; el panel te pregunta cuál vale.", "WARN");
      return st;
    });
  }

  /**
   * Guarda uno de los dos. `scope` = 'project' (el prompt general del curso,
   * para todas las secuencias) o 'sequence' (el de esta clase).
   *
   * `scope` NO es un destino que se mueva: es CUÁL de los dos campos guardó, y
   * cada campo manda siempre el suyo. Ésa es la forma nueva de la regla que
   * antes sostenía `writeScope`: vaciar un campo borra su archivo y no toca el
   * otro. Mientras el destino se deducía de qué archivo existiera en el disco,
   * el editor que seleccionaba todo y borraba para reescribir terminaba
   * escribiéndole el estilo del curso a los demás, sin que nada fallara.
   *
   * NO relee: la caché se actualiza con lo que contestó el motor. Por acá pasa
   * cada tecleo (con debounce), y releer era una segunda llamada por tecla para
   * enterarse de algo que ya sabíamos.
   */
  function save(projectPath, sequenceName, text, scope) {
    scope = scope === "sequence" ? "sequence" : "project";
    var clave = claveDe(projectPath, sequenceName);
    return HPEngine.call("saveGeneralPrompt", {
      projectPath: projectPath, sequenceName: sequenceName, text: text, scope: scope
    }).then(function (w) {
      if (!w || !w.ok) throw new Error((w && w.error) || "no pude guardarlo");
      var previo = cache[clave] || estadoVacio();
      // El motor recorta los espacios de los bordes antes de escribir: la caché
      // guarda lo mismo que devolvería releer el archivo, no lo que se tipeó.
      var t = String(text == null ? "" : text).trim();
      var st = {
        projectText: scope === "project" ? t : previo.projectText,
        sequenceText: scope === "sequence" ? (w.removed ? "" : t) : previo.sequenceText,
        // `created: false` = era vacío y el archivo no existía, así que no se
        // escribió nada y el proyecto sigue sin haber decidido.
        hasProjectFile: scope === "project" ? (w.created !== false) : previo.hasProjectFile,
        // Guardar el de la secuencia consolida el nombre nuevo (lo hace el
        // motor), así que deja de haber nada del formato viejo.
        sequenceLegacy: scope === "sequence" ? false : previo.sequenceLegacy,
        pending: previo.pending,
        paths: {
          project: (scope === "project" && w.path) ? w.path : previo.paths.project,
          sequence: (scope === "sequence" && w.path) ? w.path : previo.paths.sequence,
          sequenceLegacy: previo.paths.sequenceLegacy || ""
        },
        loaded: true,
        failed: false
      };
      cache[clave] = st;
      return st;
    });
  }

  /**
   * Cómo se dibuja este estado. La redacción vive acá y no en la vista porque
   * ES la corrección: el bug fue que el panel no decía de dónde salía el
   * contexto, así que las palabras que lo dicen se prueban como cualquier otra
   * decisión, sin tener que levantar el panel entero.
   */
  function describe(st, sequenceName) {
    var seq = String(sequenceName || "");
    var d = {
      loaded: st.loaded,
      pending: st.pending,
      // Qué texto va EN cada campo: el de su archivo, siempre. Los dos campos y
      // los dos archivos son uno a uno, así que lo que se lee y lo que se
      // guarda no pueden separarse — que es como se perdía texto.
      courseText: st.projectText,
      sequenceText: st.sequenceText,
      // Sin secuencia abierta no hay archivo donde guardar el de la clase.
      sequenceEnabled: !!seq,
      // El nombre de la secuencia va RECORTADO POR EL MEDIO: los nombres reales
      // de este proyecto son del tipo "12_MKA_..._ARMADO_FINAL_105875_02" y lo
      // que distingue un corte de otro es el sufijo, así que cortar por el final
      // —que es lo que hace el CSS— deja dos clases con el mismo rótulo. A 320
      // px, además, el rótulo entero no entra en un renglón.
      sequenceLabel: seq
        ? "Prompt de secuencia · solo “" + HPUtil.shortenMiddle(seq, 22) + "”"
        : "Prompt de secuencia"
    };

    if (st.pending) {
      d.badge = "⚠ dos versiones distintas — decidí cuál vale";
      d.badgeState = "warn";
      d.line = "Hay uno guardado en esta máquina que no coincide con el del proyecto.";
      d.lineState = "warn";
      return d;
    }
    if (st.failed) {
      // El motor no pudo leer el proyecto (disco de red caído, permisos). Antes
      // esto se dibujaba como "el proyecto no lleva el estilo del curso", que es
      // culpar al proyecto de un error de lectura.
      d.badge = "⚠ no pude leer el del proyecto";
      d.badgeState = "warn";
      d.line = st.projectText
        ? "No pude leerlo del proyecto: va el que tiene esta máquina y no viaja a la otra"
        : "No pude leerlo del proyecto: se genera sin el estilo del curso";
      d.lineState = "warn";
      return d;
    }
    if (!st.loaded) {
      // El disco todavía no contestó. Decir "no hay estilo" acá sería el mismo
      // error que este módulo vino a arreglar, un segundo más temprano: el panel
      // afirmando algo que no sabe. `loaded` existe justo para esto.
      d.badge = "leyendo el proyecto…";
      d.badgeState = "hint";
      d.line = "Buscando los prompts generales al lado del proyecto…";
      d.lineState = "";
      return d;
    }
    if (st.projectText && st.sequenceText) {
      d.badge = "✓ curso + esta secuencia";
      d.badgeState = "ok";
      d.line = "Al modelo van los DOS: el del curso como base y el de esta secuencia encima, " +
        "que MANDA donde se contradigan";
      d.lineState = "override";
      return d;
    }
    if (st.sequenceText) {
      d.badge = "✓ solo de esta secuencia";
      d.badgeState = "ok";
      d.line = "Al modelo va solo el de esta secuencia: el curso todavía no tiene prompt general";
      d.lineState = "";
      return d;
    }
    if (st.projectText) {
      d.badge = "✓ del curso";
      d.badgeState = "ok";
      d.line = "Al modelo va el del curso, el mismo para todas las secuencias. Viaja con el .prproj";
      d.lineState = "";
      return d;
    }
    // Sin nada. Lo que importa no es que falte una preferencia de este panel:
    // es que el proyecto no lleva el estilo del curso, así que quien lo abra en
    // otra máquina va a generar igual de a ciegas.
    d.badge = "sin estilo del curso — no viaja con el proyecto";
    d.badgeState = "hint";
    d.line = "Vacío. Lo que escribas acá queda en el proyecto y le llega a quien lo abra";
    d.lineState = "";
    return d;
  }

  global.HPGeneral = {
    /** Relee del disco, sin efectos. Ver load(). */
    load: load,
    /** Lee Y migra lo que quedó en esta máquina. Solo la vista, una vez. Ver migrate(). */
    migrate: migrate,
    /** Guarda uno de los dos campos, cada uno en su archivo. Ver save(). */
    save: save,

    /**
     * El estado cacheado de este contexto. `projectText` y `sequenceText` son
     * los dos niveles que viajan al modelo AHORA, sin esperar al disco;
     * `loaded` en false quiere decir que este contexto todavía no se leyó, y los
     * que escriben el payload lo usan para completar y nunca vaciar.
     */
    state: estado,

    /** Ese mismo estado, ya con las palabras que va a mostrar el panel. */
    describe: function (projectPath, sequenceName) {
      return describe(estado(projectPath, sequenceName), sequenceName);
    },

    /**
     * Qué hacer con el prompt local que no coincidía con el del proyecto:
     * 'sequence' (es el de esta clase), 'project' (es el general del curso) o
     * 'discard'. Cualquiera de las tres deja el limbo vacío.
     */
    resolvePending: function (projectPath, sequenceName, choice) {
      var texto = pendingDe(projectPath, sequenceName);
      setPending(projectPath, sequenceName, "");
      if (!texto || choice === "discard") {
        if (texto) hpLog("Prompt general: descartaste el que tenías guardado en esta máquina para “" + sequenceName + "”.");
        var st = cache[claveDe(projectPath, sequenceName)];
        if (!st) return load(projectPath, sequenceName);
        st.pending = "";
        return Promise.resolve(st);
      }
      var scope = choice === "sequence" ? "sequence" : "project";
      hpLog("Prompt general: el que tenías en esta máquina para “" + sequenceName + "” pasó a ser " +
        (scope === "sequence" ? "el prompt de esa secuencia (se suma al del curso y manda si se contradicen)."
          : "el prompt general del curso."));
      return save(projectPath, sequenceName, texto, scope).then(function (nuevo) {
        nuevo.pending = "";
        return nuevo;
      });
    }
  };
})(typeof window !== "undefined" ? window : this);
