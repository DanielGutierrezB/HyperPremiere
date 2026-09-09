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
 * Este módulo es el único que sabe eso: mantiene una caché sincrónica —porque la
 * cola, la pestaña de correcciones y las tarjetas leen sin poder esperar—, hace
 * la migración de lo que ya estaba en localStorage y sostiene el conflicto
 * cuando las dos cosas existen y no dicen lo mismo.
 *
 * Cuatro cosas que conviene tener claras antes de tocar nada acá:
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
 *  4. La caché está PARTIDA POR ALCANCE, una por nivel, y `estado()` las
 *     compone. Es lo que hace que guardar un nivel no pueda afirmar nada del
 *     otro — ver el comentario de cursoCache/seqCache, que cuenta el bug.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPGeneral.
 */
(function (global) {
  "use strict";

  var hpLog = HPLog.log;

  /**
   * DOS cachés, una por alcance, porque son dos valores de alcance distinto.
   *
   * El prompt del CURSO es uno solo para todo el proyecto; el de la clase es de
   * su secuencia y de ninguna otra. Mientras los dos vivieron en un solo
   * registro por "proyecto::secuencia", guardar uno tenía que afirmar algo sobre
   * el otro: `save()` mezclaba la respuesta del motor con lo que hubiera
   * cacheado y marcaba la entrada entera como leída. Si esa clave no existía —lo
   * normal desde que una fila de Corrections guarda contra la secuencia de
   * ORIGEN del recurso, que puede no estar abierta— la entrada terminaba
   * diciendo `loaded: true` y `sequenceText: ""` sin haber tocado el disco. La
   * cola le creía (ensureGeneralPrompt saltea la lectura cuando `loaded`) y la
   * generación siguiente de esa clase salía sin su prompt de secuencia. Con
   * `scope: "sequence"` era peor: salía sin el del curso, que es textualmente el
   * bug que la 1.5.0 vino a matar.
   *
   * Partidas, eso no se puede escribir: guardar el del curso no toca `seqCache`,
   * así que `loaded` compone en false, la cola lee el disco y el nivel de la
   * clase entra bien. Y no hay nada que propagar cuando el valor vive en un
   * solo lugar.
   */
  var cursoCache = {};  // proyecto            → { text, hasFile, path, loaded, failed }
  var seqCache = {};    // proyecto::secuencia → { text, legacy, path, legacyPath, pending, loaded, failed }

  function claveDe(projectPath, sequenceName) {
    return String(projectPath || "") + "::" + String(sequenceName || "");
  }

  function cursoVacio() {
    return {
      text: "",
      // Que el archivo del curso EXISTA es lo que la migración mira para no
      // subir lo de esta máquina encima de un proyecto que ya usa estos
      // archivos. Vaciar el campo lo BORRA (igual que el de la secuencia: un
      // archivo de cero bytes en la raíz del proyecto viaja al lado del .prproj
      // a las otras máquinas), así que hoy solo es distinto de `text` cuando
      // alguien dejó el archivo vacío a mano.
      hasFile: false,
      path: "",
      // false = todavía no se leyó el disco de este proyecto. Los lectores
      // sincrónicos lo miran para no confundir "no hay" con "no sé".
      loaded: false,
      // true = se intentó leer y el motor no pudo. Es la tercera cosa: ni "no
      // hay" ni "no sé todavía", sino "no se sabe y no se va a saber".
      failed: false
    };
  }

  function seqVacia() {
    return {
      text: "",
      // El de esta clase se leyó del nombre que tenía antes de la 1.5.0.
      legacy: false,
      path: "", legacyPath: "",
      // El texto local que quedó en el limbo esperando que el editor decida.
      pending: "",
      loaded: false, failed: false
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

  /**
   * Los dos niveles de este contexto, compuestos: uno sale de la caché del
   * proyecto y el otro de la de la secuencia.
   *
   * La forma es la de siempre, para que nadie afuera tenga que saber que son
   * dos. Lo único que cambia de significado es `loaded`, que ahora es una Y: se
   * sabe de este contexto cuando se leyeron LOS DOS niveles. Eso es lo que hace
   * que guardar uno no pueda hacer pasar al otro por leído.
   *
   * No cuesta una lectura de más: el motor contesta los dos niveles en la misma
   * llamada, así que un solo `load()` deja los dos en verde.
   */
  function estado(projectPath, sequenceName) {
    var curso = cursoCache[String(projectPath || "")] || cursoVacio();
    var seq = seqCache[claveDe(projectPath, sequenceName)] || seqVacia();
    return {
      // Los dos niveles, por separado: los dos viajan al modelo.
      projectText: curso.text,
      sequenceText: seq.text,
      hasProjectFile: curso.hasFile,
      sequenceLegacy: seq.legacy,
      pending: seq.pending,
      paths: { project: curso.path, sequence: seq.path, sequenceLegacy: seq.legacyPath },
      loaded: curso.loaded && seq.loaded,
      failed: curso.failed || seq.failed
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
    var pKey = String(projectPath || "");
    var sKey = claveDe(projectPath, sequenceName);
    return HPEngine.call("loadGeneralPrompt", {
      projectPath: projectPath, sequenceName: sequenceName
    }).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error) || "el motor no pudo leer el prompt general");
      // Una sola llamada, los dos niveles: el motor los lee juntos y cada uno va
      // a la caché de su alcance.
      var rutas = r.paths || {};
      var previoCurso = cursoCache[pKey] || cursoVacio();
      var previaSeq = seqCache[sKey] || seqVacia();
      cursoCache[pKey] = {
        text: String(r.projectText || ""),
        hasFile: !!r.hasProjectFile,
        path: rutas.project || previoCurso.path,
        loaded: true, failed: false
      };
      seqCache[sKey] = {
        text: String(r.sequenceText || ""),
        legacy: !!r.sequenceLegacy,
        path: rutas.sequence || previaSeq.path,
        legacyPath: rutas.sequenceLegacy || previaSeq.legacyPath,
        pending: pendingDe(projectPath, sequenceName),
        loaded: true, failed: false
      };
      return estado(projectPath, sequenceName);
    }).catch(function (e) {
      // Sin motor (o con el proyecto en un disco que no está), lo peor que se
      // puede hacer es dar por sentado que no hay estilo: quedaría generando en
      // blanco, que es el bug original. Se sigue con lo que haya en esta máquina
      // —que era el estilo del curso— y se dice, en vez de callar y que se
      // descubra viendo el video.
      var local = localDe(projectPath, sequenceName);
      // Una lectura que falla no puede deshacer una que salió bien: si ese nivel
      // ya se había leído (otra clase del mismo proyecto hace un rato, o este
      // mismo contexto en el job anterior), ése es el mejor dato que hay y se
      // conserva. Vale para los dos, y desde que la cola relee por cada job pasó
      // a importar de verdad: un parpadeo del disco en medio de un lote de veinte
      // marcadores no puede dejar a los que faltan generando sin estilo.
      if (!cursoCache[pKey] || !cursoCache[pKey].loaded) {
        cursoCache[pKey] = { text: local, hasFile: false, path: "", loaded: false, failed: true };
      }
      if (!seqCache[sKey] || !seqCache[sKey].loaded) {
        var seq = seqVacia();
        seq.pending = pendingDe(projectPath, sequenceName);
        seq.failed = true;
        seqCache[sKey] = seq;
      }
      hpLog("Prompt general: no pude leerlo del proyecto (" + ((e && e.message) || e) + "). " +
        (local ? "Sigo con el que tenés guardado en esta máquina." : "Se genera sin él."), "WARN");
      return estado(projectPath, sequenceName);
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
      // El limbo es de ESTA clase (la clave del localStorage lleva su nombre),
      // así que vive con el nivel de la secuencia.
      seqCache[claveDe(projectPath, sequenceName)].pending = local;
      hpLog("Prompt general: “" + sequenceName + "” tiene uno guardado en esta máquina que NO coincide " +
        "con el del proyecto. No se pisó ninguno; el panel te pregunta cuál vale.", "WARN");
      return estado(projectPath, sequenceName);
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
   *
   * Toca UNA de las dos cachés, la del alcance que se guardó, y no dice nada del
   * otro nivel. Ésa es la forma de la regla, hacia adentro: guardar el del curso
   * no puede afirmar que el de esta clase está vacío —no se leyó— y guardar el
   * de la clase no puede afirmar que el del curso lo está. Al no tocarla, la
   * caché del otro nivel sigue diciendo "no sé", que es la verdad, y el que
   * necesite ese nivel va a leer el disco.
   */
  function save(projectPath, sequenceName, text, scope) {
    scope = scope === "sequence" ? "sequence" : "project";
    return HPEngine.call("saveGeneralPrompt", {
      projectPath: projectPath, sequenceName: sequenceName, text: text, scope: scope
    }).then(function (w) {
      if (!w || !w.ok) throw new Error((w && w.error) || "no pude guardarlo");
      // El motor recorta los espacios de los bordes antes de escribir: la caché
      // guarda lo mismo que devolvería releer el archivo, no lo que se tipeó.
      var t = String(text == null ? "" : text).trim();
      if (scope === "project") {
        var pKey = String(projectPath || "");
        var previo = cursoCache[pKey] || cursoVacio();
        // El del curso es uno solo para todo el proyecto, así que guardarlo acá
        // ya lo deja al día para TODAS las secuencias: no hay nada que propagar
        // porque no hay copias.
        cursoCache[pKey] = {
          text: t,
          // `created: false` = no quedó archivo: o era vacío y no había ninguno,
          // o se vació y el motor lo borró.
          hasFile: w.created !== false,
          path: w.path || previo.path,
          loaded: true, failed: false
        };
      } else {
        var sKey = claveDe(projectPath, sequenceName);
        var previa = seqCache[sKey] || seqVacia();
        seqCache[sKey] = {
          text: w.removed ? "" : t,
          // Guardar el de la secuencia consolida el nombre nuevo (lo hace el
          // motor), así que deja de haber nada del formato viejo.
          legacy: false,
          path: w.path || previa.path,
          legacyPath: previa.legacyPath,
          pending: previa.pending,
          loaded: true, failed: false
        };
      }
      return estado(projectPath, sequenceName);
    });
  }

  // Cómo se llaman en la pantalla los dos bloques. Están acá, y no sueltos en el
  // HTML, porque desde que se separaron —el del curso arriba, con el Contexto de
  // la clase; el de la secuencia adentro del área de marcadores— cada renglón
  // NOMBRA al otro bloque para mandar al editor a donde se escribe la otra
  // mitad. Un rótulo que cambie de un lado y no del otro lo deja buscando una
  // sección que no existe; hay un test que compara estas dos cadenas con el HTML.
  var TITULO_CURSO = "Estilo del curso";
  var TITULO_SECUENCIA = "Estilo de esta secuencia";

  /**
   * El bloque de arriba: el prompt del CURSO entero, pegado al Contexto de la
   * clase. Su estado sale solo de su archivo; lo único que dice del otro nivel
   * es DÓNDE está, que es lo que dejó de verse solo al separarlos.
   */
  function describirCurso(st, d) {
    if (st.pending) {
      // El cartel de conflicto vive en ESTE bloque, y por eso el renglón habla
      // de él: es el único de los dos que se dibuja siempre (el otro no existe
      // sin secuencia abierta), y de sus tres salidas la cara es la que
      // reemplaza el archivo que comparten los dos editores.
      d.courseBadge = "⚠ dos versiones distintas — decidí cuál vale";
      d.courseBadgeState = "warn";
      d.courseLine = "Hay uno guardado en esta máquina que no coincide con el del proyecto.";
      d.courseLineState = "warn";
      return;
    }
    if (st.failed) {
      // El motor no pudo leer el proyecto (disco de red caído, permisos). Antes
      // esto se dibujaba como "el proyecto no lleva el estilo del curso", que es
      // culpar al proyecto de un error de lectura.
      d.courseBadge = "⚠ no pude leer el del proyecto";
      d.courseBadgeState = "warn";
      d.courseLine = st.projectText
        ? "No pude leerlo del proyecto: va el que tiene esta máquina y no viaja a la otra"
        : "No pude leerlo del proyecto: se genera sin el estilo del curso";
      d.courseLineState = "warn";
      return;
    }
    if (!st.loaded) {
      // El disco todavía no contestó. Decir "no hay estilo" acá sería el mismo
      // error que este módulo vino a arreglar, un segundo más temprano: el panel
      // afirmando algo que no sabe. `loaded` existe justo para esto.
      d.courseBadge = "leyendo el proyecto…";
      d.courseBadgeState = "hint";
      d.courseLine = "Buscando el prompt del curso al lado del proyecto…";
      d.courseLineState = "";
      return;
    }
    if (st.projectText) {
      d.courseBadge = "✓ del curso";
      d.courseBadgeState = "ok";
      d.courseLine = "El mismo en todas las clases del curso. Viaja con el .prproj";
    } else {
      // Lo que importa no es que falte una preferencia de este panel: es que el
      // proyecto no lleva el estilo del curso, así que quien lo abra en otra
      // máquina va a generar igual de a ciegas.
      d.courseBadge = "sin estilo del curso — no viaja con el proyecto";
      d.courseBadgeState = "hint";
      d.courseLine = "Vacío. Lo que escribas acá queda en el proyecto y le llega a quien lo abra";
    }
    d.courseLineState = "";
    // El puntero al otro bloque: una sola frase, siempre la misma. Es la mitad
    // de "ninguno de los dos queda mudo sobre el otro" que le toca a éste; la
    // otra mitad —quién manda— la dice el de la secuencia, que es el que gana.
    // En los estados de arriba no va: mandar al editor a otra parte del panel
    // mientras tiene algo que decidir acá le tapa lo que le está pasando.
    if (d.sequenceEnabled) {
      d.courseLine += ". Lo de esta clase va abajo, en “" + TITULO_SECUENCIA + "”";
    }
  }

  /**
   * El bloque de abajo, adentro del área de marcadores: el de ESTA secuencia.
   * Acá se dice la precedencia, y en un solo lugar: es el nivel que gana, así
   * que es el único donde saberla cambia lo que el editor escribe.
   */
  function describirSecuencia(st, d) {
    if (!d.sequenceEnabled) {
      // El bloque no se dibuja, pero se contesta igual: que la vista no tenga
      // que inventar qué poner en un renglón que no está.
      d.sequenceBadge = "sin secuencia abierta";
      d.sequenceBadgeState = "hint";
      d.sequenceLine = "Sin secuencia abierta no hay dónde guardar el de esta clase";
      d.sequenceLineState = "";
      return;
    }
    if (st.pending) {
      d.sequenceBadge = "⚠ hay un prompt sin decidir";
      d.sequenceBadgeState = "warn";
      d.sequenceLine = "Ese texto puede ser el de esta clase: se decide arriba, en “" + TITULO_CURSO + "”";
      d.sequenceLineState = "warn";
      return;
    }
    if (st.failed) {
      d.sequenceBadge = "⚠ no pude leer el del proyecto";
      d.sequenceBadgeState = "warn";
      d.sequenceLine = "No pude leer el proyecto: tampoco sé si esta secuencia tiene el suyo";
      d.sequenceLineState = "warn";
      return;
    }
    if (!st.loaded) {
      d.sequenceBadge = "leyendo el proyecto…";
      d.sequenceBadgeState = "hint";
      d.sequenceLine = "Buscando el de esta secuencia al lado del proyecto…";
      d.sequenceLineState = "";
      return;
    }
    if (st.sequenceText && st.projectText) {
      d.sequenceBadge = "✓ MANDA sobre el del curso";
      d.sequenceBadgeState = "ok";
      d.sequenceLine = "Al modelo van los DOS: el del curso (arriba) como base y éste encima, " +
        "que MANDA donde se contradigan";
      d.sequenceLineState = "override";
      return;
    }
    if (st.sequenceText) {
      d.sequenceBadge = "✓ solo de esta secuencia";
      d.sequenceBadgeState = "ok";
      d.sequenceLine = "Al modelo va solo éste: el curso (arriba) todavía no tiene prompt general";
      d.sequenceLineState = "";
      return;
    }
    if (st.projectText) {
      d.sequenceBadge = "sin nada propio: va el del curso";
      d.sequenceBadgeState = "hint";
      d.sequenceLine = "Vacío: esta clase usa el del curso (arriba) y nada más. " +
        "Lo que escribas acá se suma y MANDA donde se contradigan";
      d.sequenceLineState = "";
      return;
    }
    d.sequenceBadge = "sin nada propio";
    d.sequenceBadgeState = "hint";
    d.sequenceLine = "Vacío, y el del curso (arriba) también: se genera sin estilo";
    d.sequenceLineState = "";
  }

  /**
   * Cómo se dibuja este estado. La redacción vive acá y no en la vista porque
   * ES la corrección: el bug fue que el panel no decía de dónde salía el
   * contexto, así que las palabras que lo dicen se prueban como cualquier otra
   * decisión, sin tener que levantar el panel entero.
   *
   * Devuelve DOS juegos de palabras, uno por bloque, porque los dos niveles ya
   * no se ven juntos. Pegados, que los dos viajaran y que el de abajo mandara se
   * leía de un vistazo: dos campos y un renglón entre medio. Separados hay que
   * decirlo, y no dos veces el mismo párrafo — ver describirCurso() y
   * describirSecuencia(), que es donde está el reparto.
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
    describirCurso(st, d);
    describirSecuencia(st, d);
    return d;
  }

  global.HPGeneral = {
    /**
     * Los títulos de los dos bloques del panel. Se exponen porque los renglones
     * de cada uno nombran al otro, y un test los compara con el index.html: si
     * un rótulo cambia de un lado nada más, el renglón manda al editor a una
     * sección que no existe.
     */
    TITULOS: { curso: TITULO_CURSO, secuencia: TITULO_SECUENCIA },

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
      var sKey = claveDe(projectPath, sequenceName);
      function vaciarLimbo() {
        if (seqCache[sKey]) seqCache[sKey].pending = "";
      }
      if (!texto || choice === "discard") {
        if (texto) hpLog("Prompt general: descartaste el que tenías guardado en esta máquina para “" + sequenceName + "”.");
        if (!seqCache[sKey]) return load(projectPath, sequenceName);
        vaciarLimbo();
        return Promise.resolve(estado(projectPath, sequenceName));
      }
      var scope = choice === "sequence" ? "sequence" : "project";
      hpLog("Prompt general: el que tenías en esta máquina para “" + sequenceName + "” pasó a ser " +
        (scope === "sequence" ? "el prompt de esa secuencia (se suma al del curso y manda si se contradicen)."
          : "el prompt general del curso."));
      return save(projectPath, sequenceName, texto, scope).then(function () {
        vaciarLimbo();
        return estado(projectPath, sequenceName);
      });
    }
  };
})(typeof window !== "undefined" ? window : this);
