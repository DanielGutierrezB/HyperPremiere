/**
 * HPRefsView — la caja de REFERENCIAS de los dos bloques generales: la del curso
 * entero y la de esta secuencia. Miniaturas, chips de documento, arrastrar y
 * soltar, 📸 capturar del programa, y el cartel de la migración.
 *
 * Es primo de HPStills y no el mismo módulo, y la diferencia es dónde escribe:
 * HPStills administra el material de UN MARCADOR, que sigue viviendo en el
 * localStorage de esta máquina porque es de un marcador de una clase y no le
 * sirve a nadie más; esta caja administra los dos niveles GENERALES, que ahora
 * viven en archivos al lado del .prproj (ver HPRefs y bridge/store/references.js).
 * Se ven igual a propósito —las mismas clases de CSS, las mismas etiquetas— pero
 * uno escribe sincrónico contra una clave y el otro asincrónico contra el disco,
 * y meter las dos cosas en las mismas funciones era pedir que alguna vez una
 * escritura del marcador terminara en la carpeta del proyecto.
 *
 * Lo que sí se comparte es el aspecto: se reusan `marker-stills`, `still-thumb`,
 * `dropzone` y `resource-chip` tal cual. Eso no es pereza, es lo que hace que
 * esta caja quepa en los 320 px sin CSS nuevo que medir.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPRefsView.
 */
(function (global) {
  "use strict";

  var hpLog = HPLog.log;

  var deps = { context: null, onChanged: function () {} };

  function ctx() {
    return (deps.context && deps.context()) || { projectPath: "", sequenceName: "" };
  }

  /** Igual que en HPStills: una ruta hay que convertirla a URL, no concatenarla. */
  function thumbSrc(p) {
    return HPStills.stillThumbSrc(p);
  }

  function items(scope) {
    var c = ctx();
    var st = HPRefs.state(c.projectPath, c.sequenceName);
    return (scope === "sequence" ? st.sequence : st.course) || [];
  }

  function fallo(scope, e) {
    hpLog("Referencias del " + (scope === "sequence" ? "bloque de esta secuencia" : "curso") +
      ": no pude guardar en el proyecto (" + ((e && e.message) || e) + ")", "ERROR");
  }

  /**
   * Redibuja la caja entera y avisa. Se llama después de CADA escritura y con lo
   * que contestó el motor, no con lo que el panel creía: si al guardar hubo que
   * desempatar un nombre repetido, el que vale es el que quedó en el disco.
   */
  function repintar(caja) {
    var lista = items(caja._scope);
    render(caja, lista);
    deps.onChanged();
  }

  // ── Las miniaturas y los chips ───────────────────────────────────────

  function miniatura(caja, it, index, numero) {
    var thumb = document.createElement("div");
    thumb.className = "still-thumb" + (it.missing ? " is-missing" : "");

    if (it.missing) {
      // El archivo que el manifiesto nombra no está: disco externo desmontado, o
      // alguien lo borró del Finder. Se dibuja el hueco y se dice por qué. Una
      // lista más corta y sin explicación es el modo de falla que este panel ya
      // conoce: el editor no se entera y el modelo diseña sin la referencia.
      var hueco = document.createElement("div");
      hueco.className = "still-missing";
      hueco.textContent = "?";
      hueco.title = "No encuentro el archivo “" + it.fileName + "”. Si el proyecto está en un " +
        "disco externo, revisá que esté montado; si lo borraste, sacala con la ✕.";
      thumb.appendChild(hueco);
    } else {
      var img = document.createElement("img");
      img.src = thumbSrc(it.file);
      img.title = it.name;
      thumb.appendChild(img);
    }

    var num = document.createElement("span");
    num.className = "still-num";
    num.textContent = numero;
    num.title = "Imagen " + numero + " — referila así en la instrucción (ej: \"imagen " + numero + "…\")";
    thumb.appendChild(num);

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "still-remove";
    remove.textContent = "x";
    remove.title = caja._scope === "sequence"
      ? "Quitar esta imagen de las referencias de esta secuencia (borra el archivo del proyecto)"
      : "Quitar esta imagen de las referencias del curso (borra el archivo del proyecto, y deja de verla la otra máquina)";
    remove.addEventListener("click", function () {
      var c = ctx();
      HPRefs.remove(c.projectPath, c.sequenceName, caja._scope, index)
        .then(function () { repintar(caja); })
        .catch(function (e) { fallo(caja._scope, e); });
    });
    thumb.appendChild(remove);

    var tag = document.createElement("button");
    tag.type = "button";
    tag.className = "still-tag" + (it.use ? " is-use" : "");
    tag.textContent = it.use ? "✓ usar" : "referencia";
    tag.title = it.use
      ? "Se INCRUSTA en el gráfico (logo/icono/foto). Clic para volver a solo referencia."
      : "Solo referencia visual (contexto). Clic para marcarla como recurso a INCRUSTAR.";
    tag.addEventListener("click", function () {
      var c = ctx();
      HPRefs.setUse(c.projectPath, c.sequenceName, caja._scope, index, !it.use)
        .then(function () { repintar(caja); })
        .catch(function (e) { fallo(caja._scope, e); });
    });
    thumb.appendChild(tag);

    return thumb;
  }

  function chip(caja, it, index) {
    var el = document.createElement("div");
    el.className = "resource-chip" + (it.missing ? " is-missing" : "");

    var icon = document.createElement("span");
    icon.className = "resource-icon";
    icon.textContent = it.missing ? "⚠" : (/pdf/i.test(it.mediaType) ? "📄" : "📎");

    var name = document.createElement("span");
    name.className = "resource-name";
    name.textContent = it.name || "recurso";
    name.title = it.missing
      ? "No encuentro el archivo “" + it.fileName + "”: revisá que el disco del proyecto esté montado."
      : it.file;

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "resource-remove";
    remove.textContent = "×";
    remove.title = "Quitar este documento (borra el archivo del proyecto)";
    remove.addEventListener("click", function () {
      var c = ctx();
      HPRefs.remove(c.projectPath, c.sequenceName, caja._scope, index)
        .then(function () { repintar(caja); })
        .catch(function (e) { fallo(caja._scope, e); });
    });

    el.appendChild(icon);
    el.appendChild(name);
    el.appendChild(remove);
    return el;
  }

  /**
   * Dibuja la lista de un nivel. El índice que se le pasa a HPRefs es el de la
   * lista ENTERA del nivel (imágenes y documentos juntos, en el orden del
   * manifiesto), y no el de la fila donde cayó: son dos contenedores distintos
   * en la pantalla y contarlos por separado borraría el que no era.
   */
  function render(caja, lista) {
    caja._thumbs.innerHTML = "";
    caja._docs.innerHTML = "";
    var numero = 0;
    lista.forEach(function (it, index) {
      if (it.kind === "image") {
        numero += 1;
        caja._thumbs.appendChild(miniatura(caja, it, index, numero));
      } else {
        caja._docs.appendChild(chip(caja, it, index));
      }
    });
  }

  // ── Meter material ───────────────────────────────────────────────────

  /**
   * Sube los archivos que soltó el editor, DE A UNO Y EN ORDEN.
   *
   * En serie y no en paralelo a propósito: el nombre del archivo se desempata
   * contra lo que ya hay en la carpeta, y dos escrituras simultáneas de dos
   * "captura.png" podían mirar la carpeta antes de que la otra escribiera y
   * quedarse las dos con el mismo nombre. Soltar cinco imágenes de una es
   * exactamente el caso.
   */
  function ingerir(caja, files) {
    if (!files || !files.length) return;
    var lista = [];
    for (var i = 0; i < files.length; i++) lista.push(files[i]);
    caja._status.textContent = "Guardando " + lista.length + " en el proyecto…";
    caja._status.className = "still-status";

    lista.reduce(function (cadena, file) {
      return cadena.then(function () {
        return leerArchivo(file).then(function (dataUrl) {
          var c = ctx();
          return HPRefs.add(c.projectPath, c.sequenceName, caja._scope, {
            name: file.name || "referencia",
            dataUrl: dataUrl,
            mediaType: file.type || ""
          });
        });
      });
    }, Promise.resolve()).then(function () {
      caja._status.textContent = caja._scope === "course"
        ? "✓ en la carpeta del proyecto: viajan con el .prproj"
        : "✓ en la carpeta de esta secuencia";
      repintar(caja);
    }, function (e) {
      caja._status.textContent = "No pude guardar: " + ((e && e.message) || e);
      caja._status.className = "still-status is-error";
      repintar(caja);
    });
  }

  function leerArchivo(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error("no pude leer " + (file.name || "el archivo"))); };
      reader.readAsDataURL(file);
    });
  }

  /**
   * 📸 el cuadro que se está viendo en el monitor de programa.
   *
   * Sale por el mismo camino de siempre (host.jsx → saveCapture), que lo deja en
   * `_capturas` de la secuencia, y de ahí se COPIA a la carpeta de referencias
   * del nivel. Se copia y no se mueve: `_capturas` es donde el panel viene
   * guardando los cuadros desde antes de esto, y las tarjetas de los marcadores
   * los referencian por esa ruta. Son unos MB por captura, al lado de los .mov.
   */
  function capturar(caja, btn) {
    var c = ctx();
    if (!c.sequenceName) return;
    var tmpPath = "/tmp/hp-ref-" + (new Date().getTime()) + ".png";
    var prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Capturando…";
    caja._status.textContent = "";
    caja._status.className = "still-status";

    function fail(msg) {
      caja._status.textContent = msg;
      caja._status.className = "still-status is-error";
      btn.textContent = prev;
      btn.disabled = false;
    }

    HPHost.captureProgramFrame(tmpPath, function (result) {
      if (!result || result.indexOf("ok|") !== 0) {
        fail("No se pudo capturar: " + (result || "sin secuencia/monitor"));
        return;
      }
      HPEngine.call("saveCapture", {
        projectPath: c.projectPath, sequenceName: c.sequenceName,
        markerSlug: caja._scope === "course" ? "referencias-curso" : "referencias-secuencia",
        tmpPath: result.substring(3)
      }).then(function (res) {
        if (!res || !res.ok || !res.savedPath) {
          fail("No se pudo guardar el cuadro: " + ((res && res.error) || ""));
          return;
        }
        return HPRefs.add(c.projectPath, c.sequenceName, caja._scope, { path: res.savedPath })
          .then(function () {
            caja._status.textContent = caja._scope === "course"
              ? "✓ guardada con el proyecto: la ve quien lo abra"
              : "✓ guardada en la carpeta de esta secuencia";
            btn.textContent = prev; btn.disabled = false;
            repintar(caja);
          });
      }).catch(function (e) {
        fail((e && e.message) || "error guardando el cuadro");
      });
    });
  }

  // ── El cartel de la migración ────────────────────────────────────────

  /**
   * Lo que esta máquina tenía guardado y no coincide con lo que ya hay en el
   * proyecto. Las mismas tres salidas que el cartel del prompt general, y por el
   * mismo motivo: de un lado está lo que arrastró el editor que tiene el panel
   * adelante, del otro lo que puso su compañero, y elegir por ellos es tirarle el
   * trabajo a alguno de los dos sin decírselo.
   *
   * Las dos primeras SUMAN. Reemplazar sería la pérdida que este cartel existe
   * para evitar, y sacar una de más se hace con su ✕, viendo cuál se saca.
   */
  function pintarConflicto(el) {
    if (!el) return;
    var c = ctx();
    var pend = HPRefs.state(c.projectPath, c.sequenceName).pending || [];
    el.innerHTML = "";
    if (!pend.length) { el.setAttribute("data-hidden", "true"); return; }
    el.setAttribute("data-hidden", "false");

    var t = document.createElement("p");
    t.className = "general-conflict-title";
    t.textContent = "Tenías " + pend.length + " referencia(s) guardadas en esta máquina y el proyecto " +
      "ya tiene otras. No se pisó ninguna: decime qué son y se suman.";
    el.appendChild(t);

    var tira = document.createElement("div");
    tira.className = "general-conflict-text";
    tira.textContent = pend.map(function (p) { return p.name; }).join(" · ");
    el.appendChild(tira);

    var acciones = document.createElement("div");
    acciones.className = "general-conflict-actions";
    [
      ["Son de esta clase", "sequence", "Se suman a las referencias de esta secuencia."],
      ["Son del curso", "course", "Se suman a las del curso: le llegan a todas las clases y a la otra máquina."],
      ["Descartarlas", "discard", "Se borran de esta máquina y quedan las del proyecto."]
    ].forEach(function (o) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = o[0];
      b.title = o[2];
      b.addEventListener("click", function () {
        HPRefs.resolvePending(c.projectPath, c.sequenceName, o[1]).then(function () {
          deps.onChanged();
        }, function (e) { fallo("sequence", e); });
      });
      acciones.appendChild(b);
    });
    el.appendChild(acciones);
  }

  // ── La caja ──────────────────────────────────────────────────────────

  /**
   * La caja de un nivel. `scope` = 'course' (todo el curso, al lado del .prproj)
   * o 'sequence' (esta clase, en su carpeta).
   */
  function createControl(scope) {
    var caja = document.createElement("div");
    caja.className = "marker-stills";
    caja._scope = scope === "sequence" ? "sequence" : "course";

    var status = document.createElement("div");
    status.className = "still-status";
    var thumbs = document.createElement("div");
    thumbs.className = "still-thumbs";
    var docs = document.createElement("div");
    docs.className = "resource-list";
    caja._status = status;
    caja._thumbs = thumbs;
    caja._docs = docs;

    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*,application/pdf,.pdf,.txt,.md,.csv,.json,.doc,.docx";
    fileInput.multiple = true;
    fileInput.style.display = "none";

    var captureBtn = document.createElement("button");
    captureBtn.type = "button";
    captureBtn.className = "btn-add-still";
    captureBtn.textContent = "📸 Capturar del programa";
    captureBtn.title = caja._scope === "course"
      ? "Toma el cuadro actual del monitor de programa y lo guarda como referencia DEL CURSO: viaja con el .prproj y la ve quien lo abra"
      : "Toma el cuadro actual del monitor de programa como referencia de esta secuencia";
    captureBtn.addEventListener("click", function () { capturar(caja, captureBtn); });

    var drop = document.createElement("div");
    drop.className = "dropzone";
    drop.innerHTML = '<span class="dz-text">Arrastrá imágenes, PDFs o referencias aquí, o <u>hacé clic para elegir</u></span>';
    drop.addEventListener("click", function () { fileInput.click(); });
    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("is-over"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("is-over"); });
    drop.addEventListener("drop", function (e) {
      e.preventDefault();
      drop.classList.remove("is-over");
      ingerir(caja, e.dataTransfer && e.dataTransfer.files);
    });
    fileInput.addEventListener("change", function () {
      ingerir(caja, fileInput.files);
      fileInput.value = "";
    });

    caja.appendChild(captureBtn);
    caja.appendChild(drop);
    caja.appendChild(fileInput);
    caja.appendChild(status);
    caja.appendChild(thumbs);
    caja.appendChild(docs);
    caja._capture = captureBtn;
    render(caja, items(caja._scope));
    return caja;
  }

  global.HPRefsView = {
    init: function (d) {
      deps.context = (d && d.context) || null;
      if (d && d.onChanged) deps.onChanged = d.onChanged;
    },
    createControl: createControl,

    /** Redibuja una caja ya montada con lo que hay en la caché de HPRefs. */
    refresh: function (caja) {
      if (!caja || !caja._thumbs) return;
      // Sin secuencia abierta no hay dónde dejar un cuadro capturado, así que el
      // botón no se ofrece en vez de fallar al apretarlo.
      if (caja._capture) {
        caja._capture.setAttribute("data-hidden", ctx().sequenceName ? "false" : "true");
      }
      render(caja, items(caja._scope));
    },

    /** El cartel de lo que quedó en esta máquina y no coincide con el proyecto. */
    renderConflict: pintarConflicto
  };
})(typeof window !== "undefined" ? window : this);
