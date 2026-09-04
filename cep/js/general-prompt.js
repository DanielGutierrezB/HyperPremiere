/**
 * HPGeneral — de dónde sale el "Prompt general" (el estilo del curso).
 *
 * Vivía en el localStorage del panel, con una clave por proyecto Y secuencia, o
 * sea que NO viajaba con el .prproj. El editor que lo escribía generaba con la
 * marca, la paleta y la tipografía puestas; el compañero abría el mismo proyecto
 * y generaba con el campo vacío. Misma clase, mismo marcador, animaciones
 * peores, y nada en el panel que se lo dijera.
 *
 * Ahora la fuente de verdad es el disco, al lado del proyecto (ver
 * loadGeneralPrompt en bridge/store/project-fs.js): una BASE del proyecto y,
 * opcionalmente, un prompt PROPIO de una secuencia que la pisa. Este módulo es
 * el único que sabe eso: mantiene una caché sincrónica por proyecto+secuencia
 * —porque la cola, la pestaña de correcciones y las tarjetas leen sin poder
 * esperar—, hace la migración de lo que ya estaba en localStorage y sostiene el
 * conflicto cuando las dos cosas existen y no dicen lo mismo.
 *
 * Tres cosas que conviene tener claras antes de tocar nada acá:
 *
 *  1. `load()` LEE Y NADA MÁS. La migración (subir lo local al proyecto,
 *     limpiarlo, apartar el pendiente) es `migrate()`, y la llama una sola
 *     cosa: la vista, una vez por contexto. La cola llama `load`. Cuando la
 *     migración vivía adentro de la lectura, encolar una corrección de otro
 *     corte podía promover a BASE DEL PROYECTO un texto que estaba en una sola
 *     máquina, desde un camino que nadie mira.
 *  2. `writeScope` —en qué archivo escribe el campo— es estado, no una
 *     deducción. Ver switchScope().
 *  3. `save()` no relee: actualiza la caché con lo que contestó el motor. Cada
 *     tecleo del campo pasa por acá, y releer costaba una llamada de más.
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
    return { project: "", sequence: "" };
  }

  function estadoVacio() {
    return {
      // Lo que le llega al modelo y de dónde salió ('sequence' | 'project' | 'none').
      text: "", source: "none",
      projectText: "", sequenceText: "",
      // Que el archivo de la base EXISTA aunque esté vacío es un dato: el
      // proyecto decidió que no hay base, y entonces no hay nada que migrar.
      hasProjectFile: false,
      // El texto local que quedó en el limbo esperando que el editor decida.
      pending: "",
      // En qué archivo escribe lo que se tipea en el campo. Ver switchScope().
      writeScope: "project",
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

  /**
   * Arma el estado que se cachea a partir de lo que contestó el motor.
   *
   * `writeScope` se SIEMBRA con lo que hay en el disco la primera vez que se lee
   * un contexto, y después lo mueven únicamente las dos acciones del botón. La
   * única excepción va en un solo sentido: si en el disco hay un prompt propio
   * de la secuencia, el campo edita ése, siempre. Al revés —que el archivo deje
   * de existir y el destino se caiga a la base— es exactamente el bug que esto
   * arregla, y por eso no hay ninguna regla que lo haga.
   */
  function estadoDe(r, previo, pending) {
    var sequenceText = String((r && r.sequenceText) || "");
    return {
      text: String((r && r.text) || ""),
      source: String((r && r.source) || "none"),
      projectText: String((r && r.projectText) || ""),
      sequenceText: sequenceText,
      hasProjectFile: !!(r && r.hasProjectFile),
      pending: String(pending || ""),
      writeScope: sequenceText ? "sequence" : ((previo && previo.loaded) ? previo.writeScope : "project"),
      paths: (r && r.paths) ? r.paths : ((previo && previo.paths) || rutasVacias()),
      loaded: true,
      failed: false
    };
  }

  /**
   * Trae del disco el prompt general de este contexto. LECTURA PURA: no escribe
   * archivos, no toca el localStorage y no mueve el destino de escritura.
   *
   * Eso importa porque la cola llama acá por la secuencia de CUALQUIER job —uno
   * restaurado de otra sesión, una corrección de otro corte—, y un camino que no
   * es la interfaz no puede cambiarle el proyecto a nadie.
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
      // y se dice, en vez de callar y que se descubra viendo el video.
      var local = localDe(projectPath, sequenceName);
      var st = estadoVacio();
      st.text = local;
      st.source = local ? "local" : "none";
      st.pending = pendingDe(projectPath, sequenceName);
      st.failed = true;
      cache[clave] = st;
      hpLog("Prompt general: no pude leerlo del proyecto (" + ((e && e.message) || e) + "). " +
        (local ? "Sigo con el que tenés guardado en esta máquina." : "Se genera sin él."), "WARN");
      return st;
    });
  }

  /**
   * Lee y, además, MIGRA lo que hubiera quedado en el localStorage de esta
   * máquina. La llama la vista una vez por contexto y nadie más.
   *
   * Las tres salidas de la migración, y por qué:
   *
   *  - Hay algo acá y el proyecto no tiene nada escrito → se escribe en el
   *    proyecto. Es el caso normal al actualizar: lo que el editor venía usando
   *    pasa a ser la base y desde ahí viaja con el .prproj.
   *  - Dice exactamente lo mismo que el proyecto → la copia local sobra y se
   *    borra, sin molestar a nadie.
   *  - Hay las dos cosas y DIFIEREN → no se toca ninguna. La copia local se
   *    aparta entera y el panel pregunta qué es: el prompt de esta clase, la
   *    base nueva de todo el proyecto, o algo que ya no sirve. Pisar en
   *    silencio, para cualquiera de los dos lados, es tirar trabajo del editor;
   *    y acá los dos lados pueden ser de personas distintas.
   */
  function migrate(projectPath, sequenceName) {
    return load(projectPath, sequenceName).then(function (st) {
      // El disco no contestó: no hay contra qué comparar, y mover algo con la
      // mitad de la información es la forma más cara de equivocarse.
      if (!st.loaded) return st;
      var local = localDe(projectPath, sequenceName);
      if (!local) return st;

      if (!st.hasProjectFile && !st.sequenceText) {
        return save(projectPath, sequenceName, local, "project").then(function (nuevo) {
          borrarLocal(projectPath, sequenceName);
          hpLog("Prompt general: lo que tenías guardado en esta máquina para “" + sequenceName +
            "” pasó a ser la BASE del proyecto (" + nuevo.paths.project + "). Desde ahora viaja con el .prproj.");
          return nuevo;
        });
      }

      if (local === st.projectText || local === st.sequenceText) {
        borrarLocal(projectPath, sequenceName);
        return st;
      }

      // Ni se pisa el proyecto ni se tira lo de acá: queda apartado hasta que
      // el editor diga qué es. Sacarlo de `instruction` es lo que deja al campo
      // mostrar lo que DE VERDAD viaja sin que escribir encima lo borre.
      setPending(projectPath, sequenceName, local);
      borrarLocal(projectPath, sequenceName);
      st.pending = local;
      hpLog("Prompt general: “" + sequenceName + "” tiene uno guardado en esta máquina que NO coincide " +
        "con el del proyecto. No se pisó ninguno; el panel te pregunta cuál vale.", "WARN");
      return st;
    });
  }

  /**
   * Guarda el prompt general. `scope` = 'project' (la base, para todas las
   * secuencias) o 'sequence' (solo esta, pisando la base).
   *
   * NO relee: la caché se actualiza con lo que contestó el motor. Por acá pasa
   * cada tecleo del campo (con debounce), y releer era una segunda llamada por
   * tecla para enterarse de algo que ya sabíamos.
   *
   * Tampoco mueve `writeScope`. Vaciar el propio de una secuencia borra el
   * archivo —eso lo decide el motor—, pero el campo sigue escribiendo en la
   * secuencia: borrar el texto no es pedir que lo próximo vaya a la base.
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
        pending: previo.pending,
        writeScope: previo.writeScope,
        paths: {
          project: (scope === "project" && w.path) ? w.path : previo.paths.project,
          sequence: (scope === "sequence" && w.path) ? w.path : previo.paths.sequence
        },
        loaded: true,
        failed: false
      };
      st.text = st.sequenceText || st.projectText;
      st.source = st.sequenceText ? "sequence" : (st.projectText ? "project" : "none");
      cache[clave] = st;
      return st;
    });
  }

  /**
   * Las DOS transiciones deliberadas de destino, y las únicas que hay.
   *
   *  - a 'sequence': esta clase pasa a tener el suyo. Arranca con una COPIA de
   *    la base y no en blanco, porque empezar vacío sería volver a generar sin
   *    el estilo del curso, que es el bug de arriba.
   *  - a 'project': se borra el propio de la clase y vuelve a valer la base.
   *
   * Están juntas acá y no en la vista porque son la máquina de estados: el
   * destino de escritura solo se mueve cuando alguien lo pide, con el botón que
   * pregunta antes. Que se moviera solo —cuando el archivo de la secuencia
   * dejaba de existir— era reescribir la base de todo el proyecto, para todos
   * los editores, porque uno vació un campo para volver a tipearlo.
   */
  function switchScope(projectPath, sequenceName, scope) {
    var st = estado(projectPath, sequenceName);
    var destino = scope === "sequence" ? "sequence" : "project";
    var texto = destino === "sequence" ? st.projectText : "";
    return save(projectPath, sequenceName, texto, "sequence").then(function (nuevo) {
      nuevo.writeScope = destino;
      return nuevo;
    });
  }

  /**
   * Cómo se dibuja este estado. La redacción vive acá y no en la vista porque
   * ES la corrección: el bug fue que el panel no decía de dónde salía el
   * contexto, así que las palabras que lo dicen se prueban como cualquier otra
   * decisión, sin tener que levantar el panel entero.
   */
  function describe(st) {
    var propio = st.writeScope === "sequence";
    var d = {
      source: st.source,
      pending: st.pending,
      loaded: st.loaded,
      // En qué archivo escribe lo que se tipea en el campo.
      scope: st.writeScope,
      // Y qué texto va EN el campo: el del archivo al que escribe, que puede no
      // ser el que viaja al modelo (una secuencia con el suyo vacío usa la base
      // mientras tanto). Si estos dos se separan, lo próximo que se tipee se
      // guarda en un lado y se lee del otro, que es como se pierde texto.
      // Sin poder leer el proyecto no hay archivos: va lo que tenga la máquina.
      fieldText: st.failed ? st.text : (propio ? st.sequenceText : st.projectText),
      // Sin base no hay nada que pisar: ofrecer "uno propio" sería ofrecer
      // escribir lo mismo en otro archivo.
      offerOwn: propio || !!st.projectText,
      showBase: propio && !!st.projectText,
      baseText: st.projectText
    };
    d.ownLabel = propio
      ? "Volver a la base del proyecto"
      : "Usar uno propio para esta secuencia";
    d.ownTitle = propio
      ? "Borra el prompt propio de esta secuencia. Vuelve a valer la base del proyecto."
      : "Arranca con una copia de la base para que la cambies solo en esta clase. La base no se toca.";

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
      d.line = st.text
        ? "No pude leerlo del proyecto: va el que tiene esta máquina y no viaja a la otra"
        : "No pude leerlo del proyecto: se genera sin el estilo del curso";
      d.lineState = "warn";
      return d;
    }
    if (propio && st.sequenceText) {
      d.badge = "✓ propio de esta secuencia";
      d.badgeState = "ok";
      d.line = "Propio de esta secuencia · PISA la base del proyecto";
      d.lineState = "override";
      return d;
    }
    if (propio) {
      // El campo edita el prompt de la clase y está vacío: no es lo mismo que
      // haber vuelto a la base (eso es el botón), y mientras tanto lo que viaja
      // es la base. Decirlo es lo que evita tipear creyendo que se está
      // escribiendo en un lado cuando se escribe en el otro.
      d.badge = st.projectText ? "✓ base del proyecto" : "sin estilo del curso — no viaja con el proyecto";
      d.badgeState = st.projectText ? "ok" : "hint";
      d.line = st.projectText
        ? "Propio de esta secuencia · vacío por ahora, así que vale la base del proyecto"
        : "Propio de esta secuencia · vacío. Lo que escribas acá vale solo para esta clase";
      d.lineState = "";
      return d;
    }
    if (st.projectText) {
      d.badge = "✓ base del proyecto";
      d.badgeState = "ok";
      d.line = "Base del proyecto · la misma para todas las secuencias, viaja con el .prproj";
      d.lineState = "";
      return d;
    }
    if (!st.loaded) {
      // El disco todavía no contestó. Decir "no hay estilo" acá sería el mismo
      // error que este módulo vino a arreglar, un segundo más temprano: el panel
      // afirmando algo que no sabe. `loaded` existe justo para esto.
      d.badge = "leyendo el proyecto…";
      d.badgeState = "hint";
      d.line = "Buscando el estilo del curso al lado del proyecto…";
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
    save: save,
    /** Las dos transiciones de destino del botón. Ver switchScope(). */
    switchScope: switchScope,

    /**
     * El estado cacheado de este contexto. `text` y `source` son lo que viaja al
     * modelo AHORA, sin esperar al disco; `loaded` en false quiere decir que
     * este contexto todavía no se leyó, y los que escriben el payload lo usan
     * para completar y nunca vaciar.
     */
    state: estado,

    /** Ese mismo estado, ya con las palabras que va a mostrar el panel. */
    describe: function (projectPath, sequenceName) {
      return describe(estado(projectPath, sequenceName));
    },

    /**
     * Qué hacer con el prompt local que no coincidía con el del proyecto:
     * 'sequence' (es el de esta clase), 'project' (es la base nueva) o
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
        (scope === "sequence" ? "el propio de esa secuencia (pisa la base)." : "la base del proyecto."));
      // Contestar el conflicto ES elegir dónde escribe el campo de ahora en más.
      return save(projectPath, sequenceName, texto, scope).then(function (nuevo) {
        nuevo.pending = "";
        nuevo.writeScope = scope;
        return nuevo;
      });
    }
  };
})(typeof window !== "undefined" ? window : this);
