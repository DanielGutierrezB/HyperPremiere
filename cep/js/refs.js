/**
 * HPRefs — de dónde salen las REFERENCIAS de los dos niveles generales: las del
 * CURSO entero y las de ESTA secuencia. Capturas, logos, manuales de marca, PDFs.
 *
 * Es la otra mitad de lo que hizo HPGeneral con el texto, y por el mismo motivo.
 * El texto del curso ya viaja con el .prproj; las imágenes se quedaban en el
 * localStorage de la máquina que las arrastró, o sea que el compañero abría el
 * mismo proyecto y generaba sin el manual de marca. Y arriba, en el bloque que
 * dice con todas las letras "Viaja con el .prproj", eran la excepción muda a esa
 * promesa.
 *
 * Ahora la fuente de verdad es el disco (ver bridge/store/references.js): una
 * carpeta `_referencias` con el material del CURSO, arriba de las carpetas de
 * secuencia, y otra adentro de cada secuencia con el suyo. Los dos niveles
 * viajan al modelo, uno atrás del otro.
 *
 * Cuatro cosas que conviene tener claras antes de tocar nada acá, y son las
 * mismas cuatro que en general-prompt.js — a propósito: es el mismo problema con
 * otro contenido, y dos soluciones distintas para el mismo problema serían dos
 * cosas que mantener.
 *
 *  1. `load()` LEE Y NADA MÁS. La migración de lo que quedó en el localStorage
 *     es `migrate()`, y la llama una sola cosa: la vista, una vez por contexto.
 *     La cola llama `load`. Si migrar viviera adentro de la lectura, encolar una
 *     corrección de otro corte subiría al proyecto —para los dos editores— un
 *     material que estaba en una sola máquina, desde un camino que nadie mira.
 *  2. Cada bloque escribe en SU carpeta y en ninguna otra. Quitar una referencia
 *     del curso no puede tocar las de la clase, ni al revés.
 *  3. Las escrituras son asincrónicas (van al disco) pero la caché se actualiza
 *     con lo que contestó el motor, sin releer: el motor devuelve la lista
 *     entera justamente para eso.
 *  4. La caché está PARTIDA POR ALCANCE, una por nivel, y `estado()` las compone.
 *     Es lo que hace que guardar en un nivel no pueda afirmar nada del otro —
 *     ver el comentario de cursoCache/seqCache en general-prompt.js, que cuenta
 *     el bug con el que se aprendió.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPRefs.
 */
(function (global) {
  "use strict";

  var hpLog = HPLog.log;

  /**
   * DOS cachés, una por alcance, por el mismo motivo que en HPGeneral: las del
   * curso son del PROYECTO y las de la clase son de su secuencia y de ninguna
   * otra. Guardar un valor de proyecto dentro de un registro por secuencia es lo
   * que produjo el bug que la 1.5.1 vino a matar en los prompts —una entrada
   * fabricada diciendo `loaded: true` sobre un nivel que nadie había leído—, y
   * acá el precio sería el mismo: una generación sin las referencias de marca,
   * que no falla, sale distinta y se descubre viendo el video.
   */
  var cursoCache = {};  // proyecto            → { items, loaded, failed }
  var seqCache = {};    // proyecto::secuencia → { items, pending, loaded, failed }

  function claveDe(projectPath, sequenceName) {
    return String(projectPath || "") + "::" + String(sequenceName || "");
  }

  function cursoVacio() {
    return { items: [], loaded: false, failed: false, path: "" };
  }

  function seqVacia() {
    return { items: [], pending: [], loaded: false, failed: false, path: "" };
  }

  function esArray(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
  }

  // ── Lo que quedó en el localStorage de esta máquina ──────────────────

  function localesDe(projectPath, sequenceName) {
    try {
      return HPStore.withContext(projectPath, sequenceName, function () {
        return HPStore.getGeneralRefsLocal();
      });
    } catch (e) { return []; }
  }

  function borrarLocales(projectPath, sequenceName) {
    try {
      HPStore.withContext(projectPath, sequenceName, function () {
        HPStore.clearGeneralRefsLocal();
      });
    } catch (e) {}
  }

  function pendientesDe(projectPath, sequenceName) {
    try {
      return HPStore.withContext(projectPath, sequenceName, function () {
        return HPStore.getGeneralRefsPending();
      });
    } catch (e) { return []; }
  }

  function setPendientes(projectPath, sequenceName, list) {
    try {
      HPStore.withContext(projectPath, sequenceName, function () {
        HPStore.setGeneralRefsPending(list);
      });
    } catch (e) {}
  }

  /**
   * Cuánto pesa una referencia local, para poder compararla con la del disco sin
   * decodificarla.
   *
   * Un data URL en base64 son 4 caracteres por cada 3 bytes, menos el relleno.
   * Alcanza y es una resta: decodificar 1,5 MB en el hilo del panel para
   * contestar "¿es la misma?" sería pagar justo lo que este cambio vino a dejar
   * de pagar. Una ruta (una captura del programa) no se puede medir desde acá y
   * devuelve 0, que lo único que hace es mandar el caso al cartel de conflicto —
   * o sea, a preguntar en vez de suponer.
   */
  function bytesDe(ref) {
    var v = String((ref && ref.dataUrl) || "");
    var coma = v.indexOf(",");
    if (!/^data:/i.test(v) || coma === -1) return 0;
    var b64 = v.slice(coma + 1).replace(/\s+/g, "");
    var relleno = /=$/.test(b64) ? (/==$/.test(b64) ? 2 : 1) : 0;
    return Math.max(0, Math.floor(b64.length * 3 / 4) - relleno);
  }

  /**
   * ¿Lo de esta máquina ya está en el proyecto, tal cual?
   *
   * Se comparan nombre y tamaño, que es lo que distingue un archivo de otro sin
   * leerlo entero. Si coincide todo, la copia local sobra y se borra sin
   * molestar a nadie; si algo no coincide, no se decide por el editor.
   */
  function yaEstan(locales, enDisco) {
    if (!locales.length) return true;
    var restantes = enDisco.slice();
    for (var i = 0; i < locales.length; i++) {
      var b = bytesDe(locales[i]);
      if (!b) return false; // una ruta: no se puede comparar, se pregunta
      var j = -1;
      for (var k = 0; k < restantes.length; k++) {
        if (restantes[k].name === locales[i].name && restantes[k].bytes === b) { j = k; break; }
      }
      if (j === -1) return false;
      restantes.splice(j, 1);
    }
    return true;
  }

  // ── El estado compuesto ──────────────────────────────────────────────

  /**
   * Los dos niveles de este contexto, compuestos: uno sale de la caché del
   * proyecto y el otro de la de la secuencia.
   *
   * `loaded` es una Y, igual que en HPGeneral: se sabe de este contexto cuando
   * se leyeron LOS DOS niveles. Eso es lo que hace que guardar en uno no pueda
   * hacer pasar al otro por leído.
   */
  function estado(projectPath, sequenceName) {
    var curso = cursoCache[String(projectPath || "")] || cursoVacio();
    var seq = seqCache[claveDe(projectPath, sequenceName)] || seqVacia();
    return {
      course: curso.items,
      sequence: seq.items,
      pending: seq.pending,
      paths: { course: curso.path, sequence: seq.path },
      loaded: curso.loaded && seq.loaded,
      failed: curso.failed || seq.failed
    };
  }

  /** Las que le van a llegar al modelo por este contexto: primero el curso. */
  function paraElModelo(st) {
    var out = { images: [], assets: [], docs: [] };
    [st.course, st.sequence].forEach(function (lista) {
      (lista || []).forEach(function (it) {
        if (it.kind === "image") {
          out.images.push(it.file);
          if (it.use) out.assets.push(it.file);
        } else {
          out.docs.push({ name: it.name, path: it.file, mediaType: it.mediaType });
        }
      });
    });
    return out;
  }

  /**
   * Trae del disco las referencias de los dos niveles. LECTURA PURA: no escribe
   * archivos y no toca el localStorage.
   *
   * La cola llama acá por la secuencia de CUALQUIER job —uno restaurado de otra
   * sesión, una corrección de un corte que nunca se abrió en esta máquina—, y un
   * camino que no es la interfaz no puede escribirle nada a nadie.
   */
  function load(projectPath, sequenceName) {
    var pKey = String(projectPath || "");
    var sKey = claveDe(projectPath, sequenceName);
    return HPEngine.call("loadReferences", {
      projectPath: projectPath, sequenceName: sequenceName
    }).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error) || "el motor no pudo leer las referencias");
      var rutas = r.paths || {};
      var previoCurso = cursoCache[pKey] || cursoVacio();
      var previaSeq = seqCache[sKey] || seqVacia();
      cursoCache[pKey] = {
        items: esArray(r.course) ? r.course : [],
        path: rutas.course || previoCurso.path,
        loaded: true, failed: false
      };
      seqCache[sKey] = {
        items: esArray(r.sequence) ? r.sequence : [],
        path: rutas.sequence || previaSeq.path,
        pending: pendientesDe(projectPath, sequenceName),
        loaded: true, failed: false
      };
      avisarFaltantes(estado(projectPath, sequenceName));
      return estado(projectPath, sequenceName);
    }).catch(function (e) {
      // Una lectura que falla no puede deshacer una que salió bien: si ese nivel
      // ya se había leído, ése es el mejor dato que hay y se conserva. Vale para
      // los dos, y con la cola releyendo por job importa de verdad — un parpadeo
      // del disco en medio de un lote de veinte no puede dejar a los que faltan
      // generando sin la marca.
      if (!cursoCache[pKey] || !cursoCache[pKey].loaded) {
        cursoCache[pKey] = { items: [], path: "", loaded: false, failed: true };
      }
      if (!seqCache[sKey] || !seqCache[sKey].loaded) {
        var seq = seqVacia();
        seq.pending = pendientesDe(projectPath, sequenceName);
        seq.failed = true;
        seqCache[sKey] = seq;
      }
      hpLog("Referencias: no las pude leer del proyecto (" + ((e && e.message) || e) + "). " +
        "Se genera con las que haya.", "WARN");
      return estado(projectPath, sequenceName);
    });
  }

  // Contextos a los que ya se les avisó de un archivo que no está. Una vez por
  // sesión y por nivel: es una advertencia, no una alarma que se repita por job.
  var avisadoFaltante = {};

  /**
   * Una referencia que el manifiesto nombra y en el disco no está.
   *
   * Es el disco externo desmontado, o alguien que la borró del Finder. Sin este
   * renglón el panel dibuja una lista más corta y el modelo diseña sin ella, que
   * es el modo de falla mudo de siempre.
   */
  function avisarFaltantes(st) {
    [["curso", st.course], ["esta secuencia", st.sequence]].forEach(function (par) {
      var faltan = (par[1] || []).filter(function (it) { return it.missing; });
      if (!faltan.length) return;
      var clave = par[0] + "::" + faltan.map(function (f) { return f.fileName; }).join("|");
      if (avisadoFaltante[clave]) return;
      avisadoFaltante[clave] = true;
      hpLog("Referencias del " + par[0] + ": " + faltan.length + " archivo(s) que el proyecto " +
        "nombra no están en el disco (" + faltan.map(function (f) { return f.name; }).join(", ") +
        "). Si el proyecto vive en un disco externo, revisá que esté montado.", "WARN");
    });
  }

  /**
   * Las migraciones por contexto: la que está EN VUELO y si ya se intentó.
   *
   * Existe para que alguien las pueda esperar. Entre que el panel arranca y que
   * la migración contesta hay una ventana en la que `forModel` devuelve solo lo
   * que hay en el proyecto —o sea, nada— y generar ahí sale sin el material y
   * sin que nada lo diga. La ventana es corta, pero es la PRIMERA generación
   * después de actualizar, que es justo la que nadie mira con desconfianza. El
   * que espera es el preflight de la cola (ver main.js): el motor no puede
   * avisar porque no sabe que hay material en el limbo, el único que lo sabe es
   * el panel.
   */
  var migraciones = {};

  function registroDe(clave) {
    if (!migraciones[clave]) migraciones[clave] = { enVuelo: null, intentada: false };
    return migraciones[clave];
  }

  /**
   * La migración, anotada para que se pueda esperar. Lo que hace vive en
   * `migrar`; acá solo queda dicho que está corriendo y cuándo terminó.
   *
   * `intentada` se marca igual si falló: el material sigue en esta máquina y
   * quien pregunte tiene que enterarse de que ya no viene nadie a moverlo.
   */
  function migrate(projectPath, sequenceName) {
    var reg = registroDe(claveDe(projectPath, sequenceName));
    var p = migrar(projectPath, sequenceName);
    var listo = function () { reg.enVuelo = null; reg.intentada = true; };
    // Se guarda una promesa que NUNCA rechaza: el que espera solo quiere saber
    // que ya se resolvió, y una migración que falla no puede romperle el
    // chequeo previo a la cola.
    reg.enVuelo = p.then(listo, listo);
    return p;
  }

  /**
   * Lee y, además, MIGRA lo que hubiera quedado en el localStorage de esta
   * máquina. La llama la vista una vez por contexto y nadie más.
   *
   * Las tres salidas, y por qué:
   *
   *  - Hay material acá y la carpeta de la secuencia está vacía → sube ahí. A la
   *    de la SECUENCIA y no a la del curso porque es lo que ese material decía
   *    ser: el bloque se llamaba "Referencias de esta secuencia" y la clave del
   *    localStorage lleva el nombre de la clase. Promoverlo al curso sería
   *    decidir por el editor que el manual de una clase es el de todas, y eso le
   *    llega a los dos editores.
   *  - Ya está lo mismo en el proyecto (mismo nombre y mismo tamaño) → la copia
   *    local sobra y se borra, sin molestar a nadie.
   *  - Hay las dos cosas y NO son lo mismo → no se toca ninguna. Lo local se
   *    aparta entero y el panel pregunta qué es. Pisar en silencio, para
   *    cualquiera de los dos lados, es tirar trabajo del editor; y acá los dos
   *    lados pueden ser de personas distintas.
   */
  function migrar(projectPath, sequenceName) {
    return load(projectPath, sequenceName).then(function (st) {
      // El disco no contestó: no hay contra qué comparar, y mover material con
      // la mitad de la información es la forma más cara de equivocarse.
      if (!st.loaded) return st;
      // Sin secuencia abierta no hay carpeta donde poner nada de esta clase, y
      // lo local está guardado justamente contra una clase.
      if (!sequenceName) return st;
      var locales = localesDe(projectPath, sequenceName);
      if (!locales.length) return st;

      if (!st.sequence.length) {
        return subir(projectPath, sequenceName, "sequence", locales).then(function (nuevo) {
          borrarLocales(projectPath, sequenceName);
          hpLog("Referencias: las " + locales.length + " que tenías guardadas en esta máquina para “" +
            sequenceName + "” pasaron a la carpeta de esa secuencia (" + nuevo.paths.sequence +
            "). Desde ahora viajan con el .prproj.");
          return nuevo;
        });
      }

      if (yaEstan(locales, st.sequence)) {
        borrarLocales(projectPath, sequenceName);
        return estado(projectPath, sequenceName);
      }

      // Ni se pisa el proyecto ni se tira lo de acá: queda apartado hasta que el
      // editor diga qué es. Se aparta ANTES de vaciar, y solo se vacía si el
      // apartado quedó escrito: al revés, un localStorage lleno perdería las dos
      // copias de una.
      setPendientes(projectPath, sequenceName, locales);
      if (pendientesDe(projectPath, sequenceName).length === locales.length) {
        borrarLocales(projectPath, sequenceName);
      }
      seqCache[claveDe(projectPath, sequenceName)].pending = locales;
      hpLog("Referencias: “" + sequenceName + "” tiene " + locales.length + " guardada(s) en esta " +
        "máquina y el proyecto ya tiene otras. No se pisó ninguna; el panel te pregunta qué son.", "WARN");
      return estado(projectPath, sequenceName);
    });
  }

  /** Sube una lista de referencias locales a un nivel, de a una y en orden. */
  function subir(projectPath, sequenceName, scope, locales) {
    return locales.reduce(function (cadena, ref) {
      return cadena.then(function () {
        return add(projectPath, sequenceName, scope, ref);
      });
    }, Promise.resolve()).then(function () {
      return estado(projectPath, sequenceName);
    });
  }

  // ── Escrituras ───────────────────────────────────────────────────────

  /** Deja en la caché del nivel lo que contestó el motor, y nada del otro. */
  function anotar(projectPath, sequenceName, scope, items, path) {
    if (scope === "sequence") {
      var sKey = claveDe(projectPath, sequenceName);
      var previa = seqCache[sKey] || seqVacia();
      seqCache[sKey] = {
        items: esArray(items) ? items : [],
        path: path || previa.path,
        pending: previa.pending,
        loaded: true, failed: false
      };
    } else {
      var pKey = String(projectPath || "");
      var previo = cursoCache[pKey] || cursoVacio();
      cursoCache[pKey] = {
        items: esArray(items) ? items : [],
        path: path || previo.path,
        loaded: true, failed: false
      };
    }
    return estado(projectPath, sequenceName);
  }

  function llamar(metodo, projectPath, sequenceName, scope, extra) {
    var arg = { projectPath: projectPath, sequenceName: sequenceName, scope: scope };
    Object.keys(extra || {}).forEach(function (k) { arg[k] = extra[k]; });
    return HPEngine.call(metodo, arg).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error) || "el motor no pudo guardar la referencia");
      return anotar(projectPath, sequenceName, scope, r.items, r.dir);
    });
  }

  /**
   * Agrega una referencia a un nivel. `ref` = { name, dataUrl | path, mediaType,
   * use }: lo que se arrastra viene en base64 y lo que ya es un archivo (una
   * captura del programa) viene por su ruta, y el motor la copia sin
   * recodificarla.
   */
  function add(projectPath, sequenceName, scope, ref) {
    ref = ref || {};
    var extra = { name: ref.name, mediaType: ref.mediaType, use: !!ref.use };
    // Una captura del programa se guardaba como RUTA desde antes de esto: si
    // viene así, va así. Convertirla a base64 para volver a escribirla en disco
    // es el viaje que este cambio vino a sacar.
    var v = String(ref.dataUrl || ref.path || "");
    if (/^data:/i.test(v)) extra.dataUrl = v; else extra.path = v;
    return llamar("addReference", projectPath, sequenceName, scope, extra);
  }

  global.HPRefs = {
    /** Relee del disco, sin efectos. Ver load(). */
    load: load,
    /** Lee Y migra lo que quedó en esta máquina. Solo la vista, una vez. */
    migrate: migrate,

    /**
     * El material de ESTA MÁQUINA que todavía no viaja, y por qué.
     *
     *  - `local`: sigue en el localStorage. O la migración no corrió todavía
     *    —arranca al hidratar el bloque general, y una clase que nunca se abrió
     *    no lo hidrató nunca— o corrió y no pudo (el proyecto sin leer).
     *  - `pending`: la migración lo APARTÓ porque el proyecto ya tenía otras y
     *    no se pisa ninguna; espera que el editor conteste el cartel.
     *  - `migrating`: hay una en vuelo, así que esto se resuelve solo esperando.
     *
     * Lo pregunta el chequeo previo de la cola: mientras esto no dé cero,
     * generar sale sin ese material. Con el localStorage vacío da cero y nadie
     * espera ni ve ningún cartel, que es el caso de todo el mundo salvo el día
     * que actualiza.
     */
    unmigrated: function (projectPath, sequenceName) {
      var reg = migraciones[claveDe(projectPath, sequenceName)];
      var locales = localesDe(projectPath, sequenceName).length;
      var apartadas = pendientesDe(projectPath, sequenceName).length;
      return {
        local: locales,
        pending: apartadas,
        total: locales + apartadas,
        migrating: !!(reg && reg.enVuelo),
        tried: !!(reg && reg.intentada)
      };
    },

    /**
     * Cuando la migración de este contexto haya terminado; ya mismo si no hay
     * ninguna corriendo. NO dispara ninguna: esperar no es decidir mover nada,
     * y mover es una decisión de la interfaz (ver migrate).
     */
    settled: function (projectPath, sequenceName) {
      var reg = migraciones[claveDe(projectPath, sequenceName)];
      return (reg && reg.enVuelo) || Promise.resolve();
    },

    /**
     * El estado cacheado de este contexto: las dos listas, sin esperar al disco.
     * `loaded` en false quiere decir que este contexto todavía no se leyó, y los
     * que arman el payload lo usan para completar y nunca vaciar.
     */
    state: estado,

    /**
     * Lo que de este contexto le va al modelo, ya en el orden en que viaja: las
     * del CURSO primero y las de la clase después, que es el mismo orden en que
     * van los dos textos. `assets` son las marcadas "✓ usar" (se incrustan);
     * `docs` son los PDFs y la documentación.
     *
     * Vive acá y no en cada uno de los que arman un pedido porque son tres —la
     * tarjeta del marcador, la cola y el estimado de tokens— y el estimado
     * quedándose atrás del pedido de verdad ya fue un bug: decía ≈4.875 y se
     * mandaban ≈9.207.
     */
    forModel: function (projectPath, sequenceName) {
      return paraElModelo(estado(projectPath, sequenceName));
    },

    add: add,

    /** Saca una referencia de un nivel: borra el archivo y reescribe el manifiesto. */
    remove: function (projectPath, sequenceName, scope, index) {
      return llamar("removeReference", projectPath, sequenceName, scope, { index: index });
    },

    /** La marca "✓ usar" (se incrusta) o referencia a secas. */
    setUse: function (projectPath, sequenceName, scope, index, use) {
      return llamar("setReferenceUse", projectPath, sequenceName, scope, { index: index, use: !!use });
    },

    /**
     * Qué hacer con las referencias locales que no coincidían con las del
     * proyecto: 'sequence' (son de esta clase), 'course' (son del curso) o
     * 'discard'. Cualquiera de las tres deja el limbo vacío.
     *
     * Las dos primeras SUMAN, no reemplazan: del otro lado hay material que puso
     * otro editor y borrarlo para poner el propio es la pérdida que este cartel
     * existe para evitar. Si sobra una, se saca con su ✕ y se ve lo que se está
     * sacando.
     */
    resolvePending: function (projectPath, sequenceName, choice) {
      var locales = pendientesDe(projectPath, sequenceName);
      var sKey = claveDe(projectPath, sequenceName);
      function vaciarLimbo() {
        setPendientes(projectPath, sequenceName, []);
        if (seqCache[sKey]) seqCache[sKey].pending = [];
      }
      if (!locales.length || choice === "discard") {
        if (locales.length) {
          hpLog("Referencias: descartaste las " + locales.length + " que tenías guardadas en esta " +
            "máquina para “" + sequenceName + "”.");
        }
        vaciarLimbo();
        if (!seqCache[sKey]) return load(projectPath, sequenceName);
        return Promise.resolve(estado(projectPath, sequenceName));
      }
      var scope = choice === "course" ? "course" : "sequence";
      return subir(projectPath, sequenceName, scope, locales).then(function () {
        vaciarLimbo();
        hpLog("Referencias: las " + locales.length + " que tenías en esta máquina para “" +
          sequenceName + "” pasaron a ser " +
          (scope === "course" ? "las del CURSO: le llegan a todas las clases y a la otra máquina."
            : "las de esta secuencia."));
        return estado(projectPath, sequenceName);
      });
    },

    /** Cuántas hay en cada nivel (lo que cuentan los badges de los dos bloques). */
    count: function (projectPath, sequenceName, scope) {
      var st = estado(projectPath, sequenceName);
      return (scope === "sequence" ? st.sequence : st.course).length;
    }
  };
})(typeof window !== "undefined" ? window : this);
