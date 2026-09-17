/**
 * HPStills — el material de un marcador: miniaturas con etiqueta referencia/✓
 * usar, ingesta de archivos, captura del cuadro del programa, el inventario que
 * le llega al modelo y (en modo feedback) la selección por-imagen de qué se
 * reenvía.
 *
 * Lo usan las TRES pestañas: la ficha de cada marcador, la ronda de feedback de
 * la Cola y la fila de Corrections (las dos últimas con fbJobId). Este módulo es
 * el DUEÑO del estado de selección de reenvío por job (fbInit/fbCollect/fbClear),
 * así la vista de cola no necesita conocerlo.
 *
 * `crearTira(markerKey, opts)` acepta `opts.sequenceName` (+ projectPath): sobre
 * QUÉ secuencia trabaja. Sin eso, una tira solo podía tocar el marcador de la
 * secuencia abierta, y por eso el feedback de un job de otra clase —o una
 * corrección de un recurso nacido en el corte anterior— se quedaba sin imágenes.
 *
 * init(deps): onGeneralChanged() — avisar cuando cambian los adjuntos del
 * prompt general (main actualiza su resumen "✓ · n adj.").
 *
 * Vanilla JS, sin ES modules: se expone como window.HPStills.
 */
(function (global) {
  "use strict";

  var hpLog = HPLog.log;

  var deps = { onGeneralChanged: function () {}, onMaterialChanged: function () {} };

  function notifyIfGeneral(markerKey) {
    if (markerKey === HPStore.GENERAL_KEY) deps.onGeneralChanged();
  }

  /**
   * El material de un marcador cambió: se sumó o se sacó una imagen o un
   * documento, o una pasó de referencia a ✓ usar.
   *
   * Existe porque el texto del campo DEPENDE de esta lista y no se entera solo.
   * Una mención guarda el nombre del archivo, pero el chip muestra el NÚMERO, y
   * el número es la posición entre las que viajan: sacar la imagen 1 deja al chip
   * que la nombraba apuntando a la nada —tiene que ponerse rojo— y corre un lugar
   * a todos los de atrás. Sin este aviso el campo seguía mostrando los números
   * viejos: lo que el editor LEE dejaba de ser lo que el modelo RECIBE, que es
   * exactamente el modo de falla que las menciones vinieron a matar. Lo reportó
   * el editor así: "si elimino la imagen, sigue apareciendo referenciada normal".
   *
   * Avisa de TODO cambio y no sólo del nivel general, y va a los oyentes sin
   * filtrar por marcador a propósito: el material del curso y el de la clase
   * entran en la cuenta de todas las fichas abiertas, así que la pregunta "¿a
   * quién le cambió el número?" se contesta repintando, que es barato e
   * idempotente, y no adivinando.
   */
  function avisarCambio(markerKey) {
    notifyIfGeneral(markerKey);
    try { deps.onMaterialChanged(markerKey); } catch (e) {}
  }

  // ── Sobre qué marcador y qué secuencia trabaja un control ────────────
  // El material de un marcador vive en el namespace de SU secuencia. Mientras
  // todo control era de la secuencia abierta esto no hacía falta; con la cola
  // de varias clases y las correcciones de un corte anterior, sí: el control
  // tiene que decir sobre cuál opera o termina leyendo el marcador homónimo de
  // otra clase.
  //
  // `vista` = { key, fbJobId, ctx, mencionar, refrescar }. ctx null = la secuencia
  // abierta.
  // `mencionar(scope, nombre)` la pone la ficha que tiene el campo: es lo que
  // escribe `@[marcador/captura.png]` donde está el cursor cuando el editor toca
  // una miniatura, suelta un archivo o captura un cuadro. Desde la 1.6.x la ponen
  // las tres (la del marcador, la ronda de feedback de la Cola y la fila de
  // Corrections); donde no viene, la miniatura sigue haciendo lo de siempre.
  // `refrescar()` es cómo esa ficha se entera de que su material cambió. La del
  // marcador no la necesita —se la encuentra en el DOM por su `markerKey`, ver
  // `refresh`—, pero la ronda de la Cola y la fila de Corrections no viven en la
  // lista de marcadores y no hay cómo buscarlas: sin esto, capturar un cuadro
  // desde una de las dos guardaba la imagen y la tira no la dibujaba hasta el
  // próximo redibujo.
  function vistaDe(markerKey, opts) {
    opts = opts || {};
    return {
      key: markerKey,
      fbJobId: opts.fbJobId || null,
      mencionar: typeof opts.mencionar === "function" ? opts.mencionar : null,
      refrescar: typeof opts.refrescar === "function" ? opts.refrescar : null,
      ctx: opts.sequenceName
        ? { projectPath: opts.projectPath || "", sequenceName: opts.sequenceName }
        : null
    };
  }

  /**
   * Corre `fn` en el contexto de la vista. El contexto se resuelve EN CADA
   * lectura y no al crear el control: el editor puede cambiar de secuencia en
   * Premiere con la caja abierta, y lo que este control toca no depende de eso.
   */
  function enCtx(vista, fn) {
    var ctx = vista && vista.ctx;
    if (!ctx) return fn();
    return HPStore.withContext(ctx.projectPath || HPStore.getContext().projectPath, ctx.sequenceName, fn);
  }

  /** Los datos del marcador de la vista (imágenes, etiquetas, recursos). */
  function datosDe(vista) {
    return enCtx(vista, function () { return HPStore.getMarkerData(vista.key) || {}; });
  }

  // ── Selección de reenvío de imágenes en un feedback, por job ─────────
  //   sel[jobId] = { sel: { index: bool } }   ← solo los apagados a mano
  // Todas se reenvían por defecto. Antes las que ya estaban adjuntas venían
  // apagadas, con la idea de que el modelo "ya las había visto"; no las ve: cada
  // generación es una llamada sin memoria, y refinar sin el cuadro de referencia
  // era rediseñar a ciegas. El 📤 queda para apagar alguna a propósito.
  var feedbackImgSel = {};
  function fbSend(jobId, index) {
    var rec = feedbackImgSel[jobId];
    if (!rec) return false;
    if (rec.sel[index] !== undefined) return rec.sel[index];
    return true;
  }
  function fbToggle(jobId, index) {
    var rec = feedbackImgSel[jobId];
    if (!rec) return;
    rec.sel[index] = !fbSend(jobId, index);
  }
  /** Abre el estado de selección del job (una vez por apertura de la caja). */
  function fbInit(jobId) {
    if (feedbackImgSel[jobId] === undefined) feedbackImgSel[jobId] = { sel: {} };
  }
  /**
   * Índices de las imágenes que quedaron activas (📤) para reenviar al modelo.
   * `opts` es el mismo de `crearTira`: sin él se contarían las imágenes del
   * marcador homónimo de la secuencia abierta, que puede tener otras.
   */
  function fbCollect(jobId, markerKey, opts) {
    var out = [];
    if (feedbackImgSel[jobId]) {
      var cnt = (datosDe(vistaDe(markerKey, opts)).stills || []).length;
      for (var i = 0; i < cnt; i++) if (fbSend(jobId, i)) out.push(i);
    }
    return out;
  }
  function fbClear(jobId) { delete feedbackImgSel[jobId]; }

  // Fuente para el <img> del thumbnail: data URL tal cual, o ruta de archivo
  // (captura guardada en disco) servida por file://.
  //
  // La ruta hay que convertirla a URL, no concatenarla. En Windows es
  // "C:\Users\…\captura.png" y pegarle "file://" daba "file://C:%5CUsers…",
  // que Chromium no carga: hace falta "file:///C:/Users/…" con barras normales
  // y la barra extra de la raíz. En mac funcionaba de casualidad, porque la
  // ruta ya empieza con "/". Las miniaturas igual viajaban al modelo (eso lee
  // del disco); lo que no se veía era la imagen en el panel.
  /** El último tramo de una ruta: con eso se nombra (y se menciona) una captura. */
  function basename(p) {
    var partes = String(p || "").replace(/\\/g, "/").split("/");
    return partes[partes.length - 1] || "";
  }

  function stillThumbSrc(s) {
    s = String(s || "");
    if (/^data:/i.test(s) || /^file:\/\//i.test(s)) return s;
    var p = s.replace(/\\/g, "/");
    if (p.charAt(0) !== "/") p = "/" + p;
    // encodeURI deja pasar # y ?, que en una URL cortarían la ruta.
    return "file://" + encodeURI(p).replace(/#/g, "%23").replace(/\?/g, "%3F");
  }

  function renderStills(container, vista) {
    var markerKey = vista.key, fbJobId = vista.fbJobId;
    container.innerHTML = "";
    var data = datosDe(vista);
    var stills = data.stills || [], uses = data.stillUse || [], nombres = data.stillNames || [];

    for (var i = 0; i < stills.length; i++) {
      (function (index) {
        var thumb = document.createElement("div");
        thumb.className = "still-thumb";

        var img = document.createElement("img");
        img.src = stillThumbSrc(stills[index]);

        // Número de la imagen (1,2,3…). En la ficha del marcador ES el número que
        // ve el modelo, sin trampa: las del marcador van PRIMERAS en el pedido
        // (marcador → curso → clase), así que su posición acá y allá coinciden.
        var num = document.createElement("span");
        num.className = "still-num"; num.textContent = (index + 1);
        num.title = "Imagen " + (index + 1) + " del pedido";

        var remove = document.createElement("button");
        remove.type = "button";
        remove.className = "still-remove";
        remove.title = "Quitar esta imagen del marcador";
        remove.appendChild(HPIconos.el("quitar"));
        remove.addEventListener("click", function (e) {
          if (e && e.stopPropagation) e.stopPropagation();
          enCtx(vista, function () { HPStore.removeMarkerStill(markerKey, index); });
          renderStills(container, vista);
          avisarCambio(markerKey);
        });

        // Etiqueta Referencia ⇄ Usar: define si la imagen se INCRUSTA (usar) o
        // solo sirve de contexto visual (referencia, default). Evita que el modelo
        // adivine y meta la imagen equivocada.
        var isUse = !!uses[index];
        var tag = document.createElement("button");
        tag.type = "button";
        tag.className = "still-tag" + (isUse ? " is-use" : "");
        tag.textContent = isUse ? "✓ usar" : "referencia";
        tag.title = isUse
          ? "Se INCRUSTA en el gráfico (logo/icono/foto). Clic para volver a solo referencia."
          : "Solo referencia visual (contexto). Clic para marcarla como recurso a INCRUSTAR.";
        tag.addEventListener("click", function (e) {
          if (e && e.stopPropagation) e.stopPropagation();
          enCtx(vista, function () { HPStore.setMarkerStillUse(markerKey, index, !isUse); });
          renderStills(container, vista);
          avisarCambio(markerKey);
        });

        thumb.appendChild(img);
        thumb.appendChild(num);
        thumb.appendChild(remove);
        thumb.appendChild(tag);

        // En la ficha del marcador, tocar la imagen la MENCIONA en el campo. Es lo
        // que reemplaza contar en la cabeza: la mención se escribe con el nombre
        // del archivo y se traduce al número recién al mandar (ver
        // bridge/prompt/menciones.js), así que sigue apuntando a esta imagen aunque
        // se agregue o se borre otra antes.
        if (vista.mencionar && !fbJobId) {
          var nombre = nombres[index] || "";
          thumb.classList.add("es-mencionable");
          img.title = "Tocá para mencionarla en la instrucción («" + nombre + "»)";
          img.addEventListener("click", function () { vista.mencionar("marker", nombre); });
        }

        // Modo feedback: toggle "reenviar esta imagen al modelo". Por defecto las
        // imágenes YA existentes salen apagadas (gris) → no se reenvían (ahorro de
        // tokens); las NUEVAS agregadas en este feedback entran activas. No afecta el
        // incrustado: una imagen "✓ usar" se mete en el gráfico igual, se reenvíe o no.
        if (fbJobId) {
          var on = fbSend(fbJobId, index);
          thumb.classList.add("fb");
          if (!on) thumb.classList.add("fb-off");
          var send = document.createElement("button");
          send.type = "button";
          send.className = "still-send" + (on ? " is-on" : "");
          // El 📤 era un emoji del sistema. Lo que hace este botón no cambió —es
          // el toggle de si ESTA imagen viaja en este pedido—, pero el dibujo ahora
          // hereda el color del estado: prendido se lee en verde, apagado en gris,
          // que es justo lo que un emoji no puede hacer. Y el icono va sólo cuando
          // está prendido: apagado, lo que hay que leer es que NO se envía, y una
          // flecha saliendo al lado de esa frase la contradice.
          send.textContent = on ? "reenviar" : "no se envía";
          if (on) HPIconos.enBoton(send, "reenviar");
          send.title = on
            ? "Se reenvía al modelo en este feedback (usa tokens). Clic para no enviarla."
            : "No se reenvía (ahorra tokens). Clic si querés que el modelo la VEA en este ajuste.";
          var toggle = function (e) {
            e.stopPropagation();
            fbToggle(fbJobId, index);
            renderStills(container, vista);
          };
          send.addEventListener("click", toggle);
          img.style.cursor = "pointer";
          img.addEventListener("click", toggle);
          thumb.appendChild(send);
        }

        container.appendChild(thumb);
      })(i);
    }
  }

  // Lista de recursos de referencia (PDFs, docs, etc.) del marcador.
  function renderResources(container, vista) {
    var markerKey = vista.key;
    container.innerHTML = "";
    var resources = datosDe(vista).resources || [];
    for (var i = 0; i < resources.length; i++) {
      (function (index) {
        var chip = document.createElement("div");
        chip.className = "resource-chip";
        var nombre = resources[index].name || "recurso";
        var icon = document.createElement("span");
        icon.className = "resource-icon";
        icon.appendChild(HPIconos.el("documento"));
        var name = document.createElement("span");
        name.className = "resource-name";
        name.textContent = nombre;
        var remove = document.createElement("button");
        remove.type = "button";
        remove.className = "resource-remove";
        remove.title = "Quitar este recurso del marcador";
        remove.appendChild(HPIconos.el("quitar"));
        remove.addEventListener("click", function () {
          enCtx(vista, function () { HPStore.removeMarkerResource(markerKey, index); });
          renderResources(container, vista);
          avisarCambio(markerKey);
        });
        chip.appendChild(icon);
        chip.appendChild(name);
        // Un documento también se menciona, y su traducción no es un número: los
        // documentos no se numeran (los de texto se pegan en el prompt con su
        // nombre, los PDF llegan como archivo). La mención se vuelve «el documento
        // "manual.pdf"», que es exactamente cómo lo nombra el prompt.
        if (vista.mencionar) {
          chip.classList.add("es-mencionable");
          name.title = "Tocá para mencionarlo en la instrucción";
          name.addEventListener("click", function () { vista.mencionar("marker", nombre); });
        }
        chip.appendChild(remove);
        container.appendChild(chip);
      })(i);
    }
  }

  /**
   * Ingesta de una lista de File: imágenes → stills, el resto → recursos.
   *
   * Se ingiere DE A UNA Y EN ORDEN (no en paralelo) desde que el nombre importa:
   * el nombre es la identidad de una referencia cuando la instrucción la menciona,
   * y el desempate de dos «captura.png» se resuelve contra los que ya están. Con
   * cinco `FileReader` sueltos, el orden en que terminan es el orden en que el
   * disco los entrega, así que soltar cinco imágenes juntas dejaba los números —y
   * ahora los nombres— en cualquier orden.
   */
  function ingestFiles(files, vista, thumbs, resList, statusEl) {
    if (!files || !files.length) return;
    var markerKey = vista.key;
    var lista = [];
    for (var i = 0; i < files.length; i++) lista.push(files[i]);

    lista.reduce(function (cadena, file) {
      return cadena.then(function () {
        return leerArchivo(file).then(function (dataUrl) {
          var isImage = /^image\//i.test(file.type) || /\.(png|jpe?g|webp|gif)$/i.test(file.name || "");
          var nombre = file.name || (isImage ? "referencia.png" : "recurso");
          enCtx(vista, function () {
            if (isImage) {
              HPStore.addMarkerStill(markerKey, dataUrl, nombre);
            } else {
              HPStore.addMarkerResource(markerKey, {
                name: nombre,
                dataUrl: dataUrl,
                mediaType: file.type || ""
              });
            }
          });
          // La mención se escribe con el nombre que quedó GUARDADO y no con el del
          // archivo: si había otra que se llamaba igual, el que vale es el
          // desempatado, y mencionar el original apuntaría a la anterior.
          if (vista.mencionar) {
            var nombres = enCtx(vista, function () { return HPStore.getMarkerStillNames(markerKey); });
            vista.mencionar("marker", isImage ? nombres[nombres.length - 1] : nombre);
          }
        }).catch(function () {});
      });
    }, Promise.resolve()).then(function () {
      if (thumbs) renderStills(thumbs, vista);
      if (resList) renderResources(resList, vista);
      // Y la tira de la ficha, que puede ser otra caja que la que recibió el
      // archivo (soltar sobre el campo no pasa por ningún contenedor de imágenes).
      if (vista.refrescar) vista.refrescar();
      refreshCardOf(vista);
      avisarCambio(markerKey);
    });
    if (statusEl) statusEl.textContent = "";
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
   * Re-renderiza los stills/recursos buscando el contenedor VIVO en el DOM (no un
   * closure que pudo quedar viejo si la tarjeta se re-renderizó).
   *
   * Solo de un MARCADOR. La clave general (`GENERAL_KEY`) tenía acá su propia rama
   * —el `#general-stills-mount` del HTML— y ya no: desde la 1.6.0 las referencias
   * de los dos niveles generales las dibuja HPRefsView en la tira de SU ficha, y
   * lo único que queda de este módulo en esa clave es el limbo de la migración,
   * que no se dibuja. Buscar un id que no existe devolvía `false` en silencio.
   */
  function refresh(markerKey) {
    var mount = null;
    var container = document.getElementById("markers");
    if (container) {
      var cards = container.querySelectorAll("details.marker-card");
      for (var i = 0; i < cards.length; i++) { if (cards[i]._markerKey === markerKey) { mount = cards[i]; break; } }
    }
    if (!mount) return false;
    // La ficha del marcador redibuja la TIRA ENTERA y no solo sus miniaturas:
    // agregar una imagen propia le corre el número a todas las heredadas (el orden
    // del pedido es marcador → curso → clase), así que repintar la mitad dejaría
    // la otra mitad numerada como antes.
    if (typeof mount._refrescarTira === "function") { mount._refrescarTira(); return true; }
    var vista = vistaDe(markerKey, null);
    var t = mount.querySelector(".still-thumbs"), r = mount.querySelector(".resource-list");
    if (t) renderStills(t, vista);
    if (r) renderResources(r, vista);
    return true;
  }

  /**
   * La TARJETA del marcador, solo si es la de la secuencia abierta: con otro
   * contexto, la tarjeta que tiene esa misma clave es de otra clase y le
   * pintaríamos imágenes que no son suyas.
   */
  function refreshCardOf(vista) {
    if (vista.ctx && vista.ctx.sequenceName !== HPStore.getContext().sequenceName) return;
    refresh(vista.key);
  }

  // Captura el frame actual del monitor de programa (host.jsx exportFramePNG), lo
  // GUARDA en la carpeta de la secuencia (engine.saveCapture) y lo agrega como
  // still del marcador. Nota: QE muestra un alert nativo "Exported frame …" que
  // hay que cerrar (comportamiento de Premiere, no del plugin).
  function captureProgramStill(vista, thumbs, btn, statusEl) {
    var markerKey = vista.key;
    var tmpPath = "/tmp/hp-still-" + (new Date().getTime()) + ".png";
    // El botón de la ficha nueva es un icono solo, así que "Capturando…" no se
    // puede escribir adentro sin borrarle el dibujo. Lo que dice que está
    // trabajando es que queda apagado; lo que dice qué pasó es la línea de estado.
    // En la caja de feedback de la Cola, que todavía tiene el botón con palabras,
    // el texto se conserva igual: acá no se toca.
    var prev = btn.textContent;
    var conPalabras = !!String(prev || "").trim();
    btn.disabled = true;
    if (conPalabras) btn.textContent = "Capturando…";
    if (statusEl) { statusEl.textContent = ""; statusEl.className = "still-status"; }
    hpLog("Captura de programa para [" + markerKey + "] → " + tmpPath);

    function listo() {
      if (conPalabras) btn.textContent = prev;
      btn.disabled = false;
    }

    function fail(msg) {
      if (statusEl) { statusEl.textContent = msg; statusEl.className = "still-status is-error"; }
      listo();
    }

    HPHost.captureProgramFrame(tmpPath, function (result) {
      hpLog("Captura: host devolvió " + (result || "(vacío)"));
      if (!result || result.indexOf("ok|") !== 0) {
        fail("No se pudo capturar: " + (result || "sin secuencia/monitor"));
        return;
      }
      var realPath = result.substring(3); // "ok|<ruta real>"
      // El frame se captura del monitor (lo que el editor está viendo), pero se
      // guarda en la carpeta de la secuencia DEL MARCADOR: es ahí donde el motor
      // busca sus imágenes al generar.
      var ctx = vista.ctx || HPStore.getContext();
      HPEngine.call("saveCapture", {
        projectPath: ctx.projectPath || HPStore.getContext().projectPath, sequenceName: ctx.sequenceName,
        markerSlug: markerKey, tmpPath: realPath
      }).then(function (res) {
        if (res && res.ok && (res.savedPath || res.dataUrl)) {
          // Guardamos la RUTA en disco (no el base64) → no revienta la cuota de
          // localStorage. El engine la lee y la convierte a imagen al generar.
          var nombreArchivo = basename(res.savedPath || "");
          enCtx(vista, function () {
            HPStore.addMarkerStill(markerKey, res.savedPath || res.dataUrl, nombreArchivo);
          });
          // Y la mención queda escrita DONDE ESTABA EL CURSOR, que es lo que pidió
          // el editor: apretar "Capturar del programa" en medio de una frase deja
          // ahí la referencia al cuadro que acaba de tomar, sin ir a buscar qué
          // número le tocó.
          if (vista.mencionar) {
            var puestos = enCtx(vista, function () { return HPStore.getMarkerStillNames(markerKey); });
            vista.mencionar("marker", puestos[puestos.length - 1] || nombreArchivo);
          }
          // Refrescar el contenedor LOCAL (el que inició la captura, ej. la caja de
          // feedback) SIEMPRE, y además la tarjeta si está visible.
          if (thumbs) renderStills(thumbs, vista);
          if (vista.refrescar) vista.refrescar();
          refreshCardOf(vista);
          avisarCambio(markerKey);
          if (statusEl) statusEl.textContent = "✓ guardada en la carpeta de la secuencia";
          hpLog("Captura OK → " + res.savedPath + " · agregada a [" + markerKey + "]");
          listo();
        } else {
          fail("No se pudo guardar el frame: " + ((res && res.error) || ""));
          hpLog("saveCapture FALLÓ: " + ((res && res.error) || ""), "WARN");
        }
      }).catch(function (e) {
        fail((e && e.message) || "error guardando el frame");
        hpLog("saveCapture excepción: " + ((e && e.message) || e), "ERROR");
      });
    });
  }

  /**
   * La TIRA de referencias del marcador: las miniaturas y los chips de documento,
   * y nada más. La dibujan las TRES pestañas (la ficha de un marcador, la ronda
   * de feedback de la Cola y la fila de Corrections).
   *
   * Hubo un `createControl` que era una caja completa —con su botón «📸 Capturar
   * del programa» de ancho completo y su zona de arrastre de 52 px— y se fue en
   * la 1.6.x, cuando las dos pestañas que lo seguían usando pasaron al cuerpo de
   * ficha compartido. El 📸 y el clip de adjuntar viven en la barra de controles
   * del campo, y la zona de arrastre no existe más: el archivo se suelta sobre el
   * campo, como en cualquier editor de texto, y queda MENCIONADO donde estaba el
   * cursor. Los 82 px que ocupaban esos dos se los quedó el campo.
   *
   * Devuelve `{ el, estado, refrescar, cuantasImagenes }`.
   */
  function crearTira(markerKey, opts) {
    opts = opts || {};
    var vista = vistaDe(markerKey, opts);
    var el = document.createElement("div");
    el.className = "hp-tira-propia";
    var status = document.createElement("div");
    status.className = "still-status";
    var thumbs = document.createElement("div");
    thumbs.className = "still-thumbs";
    var docs = document.createElement("div");
    docs.className = "resource-list";
    el.appendChild(status);
    el.appendChild(thumbs);
    el.appendChild(docs);
    // Con la tira vacía NO hay ningún renglón: la tira no ocupa nada. Hubo uno que
    // decía "arrastrá una sobre el campo" y sobraba dos veces — el `placeholder` del
    // propio campo ya lo dice, y cuando la tira está vacía el campo suele estar vacío
    // también, o sea que el placeholder se está viendo—.
    function refrescar() {
      renderStills(thumbs, vista);
      renderResources(docs, vista);
    }
    refrescar();
    return {
      el: el,
      estado: status,
      refrescar: refrescar,
      cuantasImagenes: function () { return (datosDe(vista).stills || []).length; }
    };
  }

  /**
   * EL INVENTARIO de este pedido: las referencias que le llegan al modelo, en el
   * orden en que le llegan (marcador → curso → clase), con `falta` en las que el
   * manifiesto nombra y el disco no tiene.
   *
   * Cada fila es `{ scope, nombre, falta, tipo, src }`:
   *
   *  · `tipo` — "imagen" o "documento", DICHO y no adivinado. Antes se deducía de
   *    la extensión del nombre allá donde hacía falta (la canonización del ✨), y
   *    eso alcanzaba mientras la única pregunta era numerar; con los chips hay que
   *    decidir además si el hover muestra una miniatura o el icono de un tipo de
   *    documento, y una imagen llamada `captura.pdf.png` no puede quedar del lado
   *    equivocado por un regex. Acá se sabe sin adivinar: son dos listas distintas.
   *  · `src` — de dónde sale el `<img>` del preview, ya convertido. Es el mismo
   *    `stillThumbSrc` de las miniaturas de la tira, que es lo que importa: las del
   *    marcador son data URLs y las de los dos niveles generales son rutas en disco
   *    (y en Windows una ruta hay que CONVERTIRLA a `file:///C:/…`, no
   *    concatenarla). Si el preview armara la URL por su cuenta, en Windows se
   *    vería la miniatura de la tira y no la del chip, o al revés.
   *
   * Es lo que miran los chips del campo, el aviso de abajo y la canonización del ✨
   * (ver cep/js/menciones.js), y desde la 1.6.x lo miran los TRES lugares donde se
   * le escribe al modelo sobre un marcador: su ficha, la ronda de feedback de la
   * Cola y la fila de Corrections. Vive acá porque acá vive el material del
   * marcador y porque este módulo ya sabe leer el de OTRA secuencia
   * (`opts.sequenceName`), que es justo lo que las otras dos necesitan: una
   * corrección se escribe contra las imágenes del corte donde nació.
   *
   * Los dos niveles generales se leen de `HPRefs`, que los tiene cacheados por
   * proyecto y por secuencia. Si todavía no llegaron del disco, la lista sale con
   * lo que haya: es la capa de "antes de gastar la llamada", y la verdad la dice
   * el motor al mandar.
   */
  function inventario(markerKey, opts) {
    var vista = vistaDe(markerKey, opts);
    var d = datosDe(vista);
    var stills = d.stills || [];
    var inv = [];
    (d.stillNames || []).forEach(function (n, i) {
      inv.push({ scope: "marker", nombre: n, falta: false, tipo: "imagen", src: stillThumbSrc(stills[i]) });
    });
    (d.resources || []).forEach(function (r) {
      inv.push({ scope: "marker", nombre: (r && r.name) || "", falta: false, tipo: "documento", src: "" });
    });
    if (!global.HPRefs) return inv;
    var ctx = vista.ctx || HPStore.getContext();
    var st = HPRefs.state(ctx.projectPath, ctx.sequenceName) || {};
    [["course", st.course], ["sequence", st.sequence]].forEach(function (par) {
      (par[1] || []).forEach(function (it) { inv.push(deReferencia(par[0], it)); });
    });
    return inv;
  }

  /**
   * Una fila del inventario a partir de una referencia de HPRefs (los dos niveles
   * generales).
   *
   * Vive acá y no en HPRefsView aunque la lista sea de HPRefs, porque el inventario
   * es de este módulo y tiene que salir de un solo lugar: lo consumen el chip del
   * campo, el aviso, la canonización del ✨ y los bloques de estilo, y si cada uno
   * armara su fila, el chip de un bloque de estilo podría numerar distinto que el de
   * la ficha de un marcador sobre la misma referencia.
   */
  function deReferencia(scope, it) {
    var esImagen = (it && it.kind) === "image";
    return {
      scope: scope,
      nombre: (it && (it.fileName || it.name)) || "",
      falta: !!(it && it.missing),
      tipo: esImagen ? "imagen" : "documento",
      // Una que el disco no tiene no tiene de dónde sacar la miniatura: el preview
      // muestra el triángulo de aviso, que es lo que ya muestra la tira.
      src: esImagen && it && !it.missing ? stillThumbSrc(it.file) : ""
    };
  }

  global.HPStills = {
    init: function (d) {
      if (d && d.onGeneralChanged) deps.onGeneralChanged = d.onGeneralChanged;
      if (d && d.onMaterialChanged) deps.onMaterialChanged = d.onMaterialChanged;
    },
    crearTira: crearTira,
    inventario: inventario,
    deReferencia: deReferencia,
    /** Mete archivos en un marcador desde afuera (lo que se suelta sobre el campo). */
    ingerir: function (files, markerKey, opts) {
      var vista = vistaDe(markerKey, opts);
      ingestFiles(files, vista, null, null, null);
    },
    /** El 📸 de la barra de controles de la ficha. */
    capturar: function (markerKey, opts, btn, statusEl) {
      captureProgramStill(vistaDe(markerKey, opts), null, btn, statusEl);
    },
    refresh: refresh,
    // Selección de reenvío en feedback (dueño del estado por job):
    fbInit: fbInit,
    fbCollect: fbCollect,
    fbClear: fbClear,
    // Expuesta para el test de Windows (armado de la URL file://).
    stillThumbSrc: stillThumbSrc
  };
})(typeof window !== "undefined" ? window : this);
