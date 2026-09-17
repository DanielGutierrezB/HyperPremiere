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
 * Lo que sí se comparte es el aspecto: se reusan `marker-stills`, `still-thumb`
 * y `resource-chip` tal cual. Eso no es pereza, es lo que hace que esta caja
 * quepa en los 320 px sin CSS nuevo que medir. (Acá figuraba también
 * `dropzone`, y se cayó con la zona de arrastre en la 1.6.x: el archivo se
 * suelta sobre el CAMPO. Ver `.hp-campo.is-over` en el CSS.)
 *
 * Vanilla JS, sin ES modules: se expone como window.HPRefsView.
 */
(function (global) {
  "use strict";

  var hpLog = HPLog.log;

  var deps = { context: null, onChanged: function () {}, mencionar: null };

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
    // Y las fichas abiertas, que es lo que hace `HPStills` con su material: una
    // referencia del curso o de la clase entra en la cuenta de TODAS, así que
    // sumarla o sacarla corre los números de los chips. Y destapa la tira, que se
    // esconde cuando está vacía —el caso del editor: capturaba en un bloque de
    // estilo recién abierto, la referencia se guardaba y no aparecía nunca—.
    //
    // Va acá y no en el cableado de `main.js` por una razón práctica: `main.js` no
    // lo ejecuta ningún test, así que ahí este cable se corta sin que nada falle.
    // Y no agrega acoplamiento: esta vista ya usa `HPPromptCard` para sus botones.
    if (global.HPPromptCard && HPPromptCard.repintarTodas) HPPromptCard.repintarTodas();
  }

  // ── Las miniaturas y los chips ───────────────────────────────────────

  function miniatura(caja, it, index) {
    var thumb = document.createElement("div");
    thumb.className = "still-thumb" + (it.missing ? " is-missing" : "");

    if (it.missing) {
      // El archivo que el manifiesto nombra no está: disco externo desmontado, o
      // alguien lo borró del Finder. Se dibuja el hueco y se dice por qué. Una
      // lista más corta y sin explicación es el modo de falla que este panel ya
      // conoce: el editor no se entera y el modelo diseña sin la referencia.
      var hueco = document.createElement("div");
      hueco.className = "still-missing";
      hueco.appendChild(HPIconos.el("falta"));
      hueco.title = "No encuentro el archivo “" + it.fileName + "”. Si el proyecto está en un " +
        "disco externo, revisá que esté montado; si lo borraste, sacala con la ✕.";
      thumb.appendChild(hueco);
    } else {
      var img = document.createElement("img");
      img.src = thumbSrc(it.file);
      img.title = it.name;
      thumb.appendChild(img);
    }

    // Acá NO va el número, y eso es un arreglo y no una pérdida. El número que
    // esta caja mostraba era el de la referencia DENTRO de su nivel, y el que ve
    // el modelo es el del pedido entero: marcador → curso → clase. Con dos
    // capturas en el marcador, la primera del curso era la «imagen 1» en pantalla
    // y la «imagen 3» para el modelo. O sea que el número que el panel ofrecía
    // para copiar en la instrucción era, casi siempre, el equivocado — y no se
    // puede arreglar acá, porque depende de qué marcador esté generando.
    // Lo que sí se puede es no hacer falta: se toca la referencia y queda
    // MENCIONADA por su nombre, y el número lo pone el motor al mandar (ver
    // bridge/prompt/menciones.js). En la ficha del marcador, donde el pedido se
    // conoce completo, el número sí se muestra.
    var nombre = it.fileName || it.name;
    if (deps.mencionar) {
      thumb.classList.add("es-mencionable");
      thumb.title = "Tocá para mencionarla en el prompt de este bloque («" + nombre + "»)";
      // El ✕ y la etiqueta ✓ usar cortan el evento con `stopPropagation`, así que
      // acá solo llega el clic en la imagen.
      thumb.addEventListener("click", function () { deps.mencionar(caja._scope, nombre); });
    }

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "still-remove";
    remove.appendChild(HPIconos.el("quitar"));
    remove.title = caja._scope === "sequence"
      ? "Quitar esta imagen de las referencias de esta secuencia (borra el archivo del proyecto)"
      : "Quitar esta imagen de las referencias del curso (borra el archivo del proyecto, y deja de verla la otra máquina)";
    remove.addEventListener("click", function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
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
    tag.addEventListener("click", function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
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
    icon.appendChild(HPIconos.el(it.missing ? "falta" : "documento"));

    var nombre = it.fileName || it.name;
    var name = document.createElement("span");
    name.className = "resource-name";
    name.textContent = it.name || "recurso";
    name.title = it.missing
      ? "No encuentro el archivo “" + it.fileName + "”: revisá que el disco del proyecto esté montado."
      : it.file;
    if (deps.mencionar) {
      el.classList.add("es-mencionable");
      name.title = "Tocá para mencionarlo en el prompt de este bloque · " + name.title;
      name.addEventListener("click", function () { deps.mencionar(caja._scope, nombre); });
    }

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "resource-remove";
    remove.title = "Quitar este documento (borra el archivo del proyecto)";
    remove.appendChild(HPIconos.el("quitar"));
    remove.addEventListener("click", function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
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
    lista.forEach(function (it, index) {
      if (it.kind === "image") caja._thumbs.appendChild(miniatura(caja, it, index));
      else caja._docs.appendChild(chip(caja, it, index));
    });
    // Con la tira vacía NO hay ningún renglón, acá tampoco: lo dice el `placeholder`
    // del campo, que es lo que se está viendo justo cuando la tira está vacía.
  }

  /**
   * Las referencias HEREDADAS, como se ven en la ficha de un marcador: las del
   * curso y las de la clase, con el número que de verdad les toca en ESTE pedido.
   *
   * Están en la ficha del marcador porque el editor pidió ver arriba del campo lo
   * que va con el prompt, y lo que va con el prompt son las cinco, no las dos
   * propias. Y por eso acá el número sí se puede escribir: el pedido se conoce
   * entero (las propias primero, después el curso, después la clase), así que
   * `desde` es cuántas imágenes propias tiene el marcador y de ahí sigue la
   * cuenta.
   *
   * Van como una FRASE y no como miniaturas ni como chips de 24 px, y el motivo es
   * presupuesto medido. Con tres referencias del curso y dos de la clase —el caso
   * normal, no el raro— cinco miniaturas de 80×64 son 136 px arriba del campo y
   * cinco chips de 24 px son 80. Una frase con los nombres separados por · son 32,
   * y el campo es lo que el editor vino a usar.
   *
   * Que los nombres sean texto de un renglón y no botones cuadrados NO les saca el
   * blanco de clic que pide SC 2.5.8: es la excepción «Inline» del propio criterio
   * («the target is in a sentence or its size is otherwise constrained by the
   * line-height of non-target text»), la misma con la que funciona cualquier enlace
   * dentro de un párrafo. Y hay precedente en el panel: el «hacé clic para elegir»
   * de la zona de arrastre y el «abrir la página» del login de Claude.
   *
   * Y van SIN ✕ ni ✓ usar: borrar una del curso le llega a todas las clases y a la
   * otra máquina, así que esa decisión se toma en el bloque del curso, viendo lo que
   * se saca. Acá se ven, se cuentan y se mencionan.
   */
  function crearHeredadas(opts) {
    opts = opts || {};
    var el = document.createElement("div");
    el.className = "hp-heredadas";
    var c = ctx();
    var st = HPRefs.state(c.projectPath, c.sequenceName);
    var numero = Number(opts.desde) || 0;
    [["course", st.course, "del curso"], ["sequence", st.sequence, "de esta clase"]].forEach(function (par) {
      var lista = par[1] || [];
      if (!lista.length) return;
      var linea = document.createElement("div");
      linea.className = "hp-heredada-linea";
      var rot = document.createElement("span");
      rot.className = "hp-heredada-rot";
      rot.textContent = par[2];
      linea.appendChild(rot);
      lista.forEach(function (it, i) {
        var esImagen = it.kind === "image";
        // Una imagen que el disco no tiene NO viaja, así que no ocupa número: si
        // gastara uno, el resto de la tira quedaría corrida contra lo que ve el
        // modelo, que es todo lo que esta tira viene a arreglar.
        if (esImagen && !it.missing) numero += 1;
        if (i) linea.appendChild(separador());
        linea.appendChild(refHeredada(par[0], it, esImagen && !it.missing ? numero : 0, opts.mencionar, par[2]));
      });
      el.appendChild(linea);
    });
    return el;
  }

  function separador() {
    var s = document.createElement("span");
    s.className = "hp-heredada-sep";
    s.textContent = "·";
    return s;
  }

  function refHeredada(scope, it, numero, mencionar, deQuien) {
    var nombre = it.fileName || it.name;
    var ref = document.createElement("button");
    ref.type = "button";
    ref.className = "hp-heredada" + (it.missing ? " is-missing" : "");
    if (it.missing) ref.appendChild(HPIconos.el("falta"));
    else if (numero) {
      var n = document.createElement("span");
      n.className = "hp-heredada-num";
      n.textContent = String(numero);
      ref.appendChild(n);
    } else ref.appendChild(HPIconos.el("documento"));
    var etq = document.createElement("span");
    etq.className = "hp-heredada-txt";
    // Acortado por el MEDIO: estos nombres comparten el principio y se diferencian
    // en el sufijo («…_v4.pdf» contra «…_v3.pdf»), así que recortar el final borra
    // justo lo que distingue una referencia de otra. El nombre entero está en el
    // tooltip, y es el que la mención escribe.
    // 18 y no 24: con el alto de 24 px que pide SC 2.5.8, lo que decide cuántas
    // entran por renglón es el largo del nombre, y a 24 caracteres entraban dos por
    // renglón a 400 px (tres renglones para cinco referencias). A 18 entran tres.
    etq.textContent = HPUtil.shortenMiddle(nombre, 18);
    ref.appendChild(etq);
    if (it.use) ref.appendChild(HPIconos.el("usar", "hp-heredada-usar"));
    ref.title = it.missing
      ? "«" + nombre + "» es una referencia " + deQuien + " que el proyecto nombra y el disco no tiene: " +
        "no viaja al modelo, y por eso no tiene número. Se saca (o se recupera) en su propio bloque."
      : (numero ? "Imagen " + numero + " de este pedido · " : "Documento · ") + deQuien + " · «" + nombre +
        "». Tocá para mencionarla en la instrucción.";
    if (mencionar && !it.missing) {
      ref.classList.add("es-mencionable");
      ref.addEventListener("click", function () { mencionar(scope, nombre); });
    } else {
      ref.disabled = true;
    }
    return ref;
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
    // Con el botón vuelto icono, "Capturando…" no se puede escribir adentro sin
    // borrarle el dibujo: lo que dice que está trabajando es que queda apagado, y
    // lo que dice qué está haciendo es la línea de estado, que es donde el editor
    // ya lee el resultado.
    btn.disabled = true;
    caja._status.textContent = "Capturando el cuadro del programa…";
    caja._status.className = "still-status";

    function fail(msg) {
      caja._status.textContent = msg;
      caja._status.className = "still-status is-error";
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
            btn.disabled = false;
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
   * La caja de un nivel: SOLO EL INVENTARIO. `scope` = 'course' (todo el curso, al
   * lado del .prproj) o 'sequence' (esta clase, en su carpeta).
   *
   * Se le fueron tres cosas en la 1.6.0, y las tres para el mismo lado:
   *
   *  · El 📸 y el clip de adjuntar, que se fueron a la BARRA DE CONTROLES del
   *    campo (ver HPPromptCard). Son herramientas del campo, no del inventario, y
   *    ahora los tres bloques y la ficha del marcador las tienen en el mismo lugar.
   *  · La ZONA DE ARRASTRE, 52 px permanentes con la instrucción de arrastrar. Se
   *    suelta sobre el campo, y lo que queda escrito es la mención.
   *  · El TECHO de 108 px con scroll propio. Era lo peor del sistema y lo decía su
   *    propio autor: esconde contenido detrás de una barra cuya única señal es la
   *    barra. Y existía por un número medido —el inventario del curso empujaba el
   *    campo de la clase 234 px hacia abajo— que ya no aplica: lo que ocupaba ese
   *    espacio eran el botón y la zona de arrastre (90 de los 108), que se
   *    fueron. Ahora la tira envuelve y se ve entera; con cuatro referencias son
   *    68 px a 400 px de ancho, o sea 40 menos que el techo que las escondía.
   */
  function createControl(scope) {
    var caja = document.createElement("div");
    caja.className = "marker-stills hp-tira-propia";
    caja._scope = scope === "sequence" ? "sequence" : "course";

    var thumbs = document.createElement("div");
    thumbs.className = "still-thumbs";
    var docs = document.createElement("div");
    docs.className = "resource-list";
    // El renglón de estado (lo que dice el 📸, y lo que dice un guardado que falló)
    // NO vive acá adentro: lo pone la ficha debajo de la barra de controles, y se lo
    // engancha `HPGeneralView` con `caja._status`. La caja se esconde entera cuando
    // el inventario está vacío, y un error de guardado aparece justamente ahí — con
    // el bloque todavía sin referencias.
    caja._status = document.createElement("div");
    caja._thumbs = thumbs;
    caja._docs = docs;

    caja.appendChild(thumbs);
    caja.appendChild(docs);
    render(caja, items(caja._scope));
    return caja;
  }

  /** El renglón donde este módulo dice qué pasó. Lo coloca la ficha, no la caja. */
  function crearEstado() {
    var el = document.createElement("div");
    el.className = "still-status";
    return el;
  }

  /**
   * El 📸 de la barra de controles de un bloque de estilo. Lo crea acá y no
   * HPPromptCard porque lo que hace —copiar el cuadro a la carpeta de ESE nivel—
   * es de este módulo; la ficha solo lo cuelga donde va.
   *
   * Recibe una FUNCIÓN que devuelve la caja y no la caja: el botón vive en la
   * barra de controles, que se cuelga una sola vez, y la caja del inventario se
   * recrea en cada cambio de secuencia. Con la caja capturada en el closure, el 📸
   * seguiría escribiendo en la de la clase anterior.
   */
  function botonCapturar(scope, caja) {
    var titulo = scope === "course"
      ? "Toma el cuadro actual del monitor de programa y lo guarda como referencia DEL CURSO: viaja con el .prproj y la ve quien lo abra"
      : "Toma el cuadro actual del monitor de programa como referencia de esta secuencia";
    return HPPromptCard.botonIcono("capturar", titulo, function (b) {
      var c = typeof caja === "function" ? caja() : caja;
      if (c) capturar(c, b);
    });
  }

  global.HPRefsView = {
    init: function (d) {
      deps.context = (d && d.context) || null;
      if (d && d.onChanged) deps.onChanged = d.onChanged;
      // Cómo se menciona una referencia en el campo de ese bloque. La pone la
      // vista que tiene el campo (HPGeneralView), porque es la que sabe en cuál de
      // los dos hay que escribir.
      if (d && d.mencionar) deps.mencionar = d.mencionar;
    },
    createControl: createControl,
    crearEstado: crearEstado,
    botonCapturar: botonCapturar,
    crearHeredadas: crearHeredadas,
    /** Mete en un nivel lo que se soltó sobre su campo. */
    ingerir: function (caja, files) { ingerir(caja, files); },

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
