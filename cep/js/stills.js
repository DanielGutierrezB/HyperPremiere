/**
 * HPStills — control de imágenes y recursos de un marcador: miniaturas con
 * etiqueta referencia/✓ usar, drag & drop, 📸 captura del programa, y (en modo
 * feedback) la selección por-imagen de qué se reenvía al modelo.
 *
 * Lo usan las tarjetas de marcador, la zona de "Prompt general" (markerKey =
 * HPStore.GENERAL_KEY), la caja de feedback de la pestaña Cola y las filas de
 * Corrections (las dos últimas con fbJobId). Este módulo es el DUEÑO del estado
 * de selección de reenvío por job (fbInit/fbCollect/fbClear), así la vista de
 * cola no necesita conocerlo.
 *
 * `createControl(markerKey, opts)` acepta `opts.sequenceName` (+ projectPath):
 * sobre QUÉ secuencia trabaja. Sin eso, un control solo podía tocar el marcador
 * de la secuencia abierta, y por eso el feedback de un job de otra clase —o una
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

  var deps = { onGeneralChanged: function () {} };

  function notifyIfGeneral(markerKey) {
    if (markerKey === HPStore.GENERAL_KEY) deps.onGeneralChanged();
  }

  // ── Sobre qué marcador y qué secuencia trabaja un control ────────────
  // El material de un marcador vive en el namespace de SU secuencia. Mientras
  // todo control era de la secuencia abierta esto no hacía falta; con la cola
  // de varias clases y las correcciones de un corte anterior, sí: el control
  // tiene que decir sobre cuál opera o termina leyendo el marcador homónimo de
  // otra clase.
  //
  // `vista` = { key, fbJobId, ctx }. ctx null = la secuencia abierta.
  function vistaDe(markerKey, opts) {
    opts = opts || {};
    return {
      key: markerKey,
      fbJobId: opts.fbJobId || null,
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
   * `opts` es el mismo de createControl: sin él se contarían las imágenes del
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
    var stills = data.stills || [], uses = data.stillUse || [];

    for (var i = 0; i < stills.length; i++) {
      (function (index) {
        var thumb = document.createElement("div");
        thumb.className = "still-thumb";

        var img = document.createElement("img");
        img.src = stillThumbSrc(stills[index]);

        // Número de la imagen (1,2,3…) para poder referenciarla en la instrucción:
        // "imagen 1 hacé X, imagen 2 revisá Y". El orden coincide con lo que ve el modelo.
        var num = document.createElement("span");
        num.className = "still-num"; num.textContent = (index + 1);
        num.title = "Imagen " + (index + 1) + " — referila así en la instrucción (ej: \"imagen " + (index + 1) + "…\")";

        var remove = document.createElement("button");
        remove.type = "button";
        remove.className = "still-remove";
        remove.textContent = "x";
        remove.title = "Quitar esta imagen del marcador";
        remove.addEventListener("click", function () {
          enCtx(vista, function () { HPStore.removeMarkerStill(markerKey, index); });
          renderStills(container, vista);
          notifyIfGeneral(markerKey);
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
        tag.addEventListener("click", function () {
          enCtx(vista, function () { HPStore.setMarkerStillUse(markerKey, index, !isUse); });
          renderStills(container, vista);
          notifyIfGeneral(markerKey);
        });

        thumb.appendChild(img);
        thumb.appendChild(num);
        thumb.appendChild(remove);
        thumb.appendChild(tag);

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
          send.textContent = on ? "📤 reenviar" : "no se envía";
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
        var icon = document.createElement("span");
        icon.className = "resource-icon";
        icon.textContent = /pdf/i.test(resources[index].mediaType) ? "📄" : "📎";
        var name = document.createElement("span");
        name.className = "resource-name";
        name.textContent = resources[index].name || "recurso";
        var remove = document.createElement("button");
        remove.type = "button";
        remove.className = "resource-remove";
        remove.textContent = "×";
        remove.title = "Quitar este recurso del marcador";
        remove.addEventListener("click", function () {
          enCtx(vista, function () { HPStore.removeMarkerResource(markerKey, index); });
          renderResources(container, vista);
        });
        chip.appendChild(icon);
        chip.appendChild(name);
        chip.appendChild(remove);
        container.appendChild(chip);
      })(i);
    }
  }

  // Ingesta de una lista de File: imágenes → stills, el resto → recursos.
  function ingestFiles(files, vista, thumbs, resList, statusEl) {
    if (!files || !files.length) return;
    var markerKey = vista.key;
    var pending = files.length;
    function done() {
      pending--;
      if (pending === 0) {
        renderStills(thumbs, vista);
        renderResources(resList, vista);
        notifyIfGeneral(markerKey);
      }
    }
    for (var i = 0; i < files.length; i++) {
      (function (file) {
        var reader = new FileReader();
        var isImage = /^image\//i.test(file.type) || /\.(png|jpe?g|webp|gif)$/i.test(file.name || "");
        reader.onload = function () {
          enCtx(vista, function () {
            if (isImage) {
              HPStore.addMarkerStill(markerKey, reader.result);
            } else {
              HPStore.addMarkerResource(markerKey, {
                name: file.name || "recurso",
                dataUrl: reader.result,
                mediaType: file.type || ""
              });
            }
          });
          done();
        };
        reader.onerror = done;
        reader.readAsDataURL(file);
      })(files[i]);
    }
    if (statusEl) statusEl.textContent = "";
  }

  // Re-renderiza los stills/recursos buscando el contenedor VIVO en el DOM (no un
  // closure que pudo quedar viejo si la tarjeta se re-renderizó). markerKey puede
  // ser GENERAL_KEY (zona de prompt general) o la clave de un marcador.
  function refresh(markerKey) {
    var mount = null;
    if (markerKey === HPStore.GENERAL_KEY) {
      mount = document.getElementById("general-stills-mount");
    } else {
      var container = document.getElementById("markers");
      if (container) {
        var cards = container.querySelectorAll("details.marker-card");
        for (var i = 0; i < cards.length; i++) { if (cards[i]._markerKey === markerKey) { mount = cards[i]; break; } }
      }
    }
    if (!mount) return false;
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
    var prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Capturando…";
    if (statusEl) { statusEl.textContent = ""; statusEl.className = "still-status"; }
    hpLog("Captura de programa para [" + markerKey + "] → " + tmpPath);

    function fail(msg) {
      if (statusEl) { statusEl.textContent = msg; statusEl.className = "still-status is-error"; }
      btn.textContent = prev;
      btn.disabled = false;
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
          enCtx(vista, function () { HPStore.addMarkerStill(markerKey, res.savedPath || res.dataUrl); });
          // Refrescar el contenedor LOCAL (el que inició la captura, ej. la caja de
          // feedback) SIEMPRE, y además la tarjeta si está visible.
          if (thumbs) renderStills(thumbs, vista);
          refreshCardOf(vista);
          notifyIfGeneral(markerKey);
          if (statusEl) statusEl.textContent = "✓ guardada en la carpeta de la secuencia";
          hpLog("Captura OK → " + res.savedPath + " · agregada a [" + markerKey + "]");
          btn.textContent = prev; btn.disabled = false;
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
   * Control completo: 📸 captura + drag&drop + miniaturas + recursos.
   * opts = { fbJobId, projectPath, sequenceName } — ver cabecera del módulo.
   */
  function createControl(markerKey, opts) {
    var vista = vistaDe(markerKey, opts);
    var wrap = document.createElement("div");
    wrap.className = "marker-stills";

    var thumbs = document.createElement("div");
    thumbs.className = "still-thumbs";

    var resList = document.createElement("div");
    resList.className = "resource-list";

    var fileInput = document.createElement("input");
    fileInput.type = "file";
    // Todo tipo de recursos: imágenes (stills) + PDFs/docs/referencias.
    fileInput.accept = "image/*,application/pdf,.pdf,.txt,.md,.csv,.json,.doc,.docx";
    fileInput.multiple = true;
    fileInput.style.display = "none";

    // Botón principal: capturar el frame ACTUAL del monitor de programa.
    var captureBtn = document.createElement("button");
    captureBtn.type = "button";
    captureBtn.className = "btn-add-still";
    captureBtn.textContent = "📸 Capturar del programa";
    captureBtn.title = "Toma el frame actual del monitor de programa como imagen de referencia para este marcador";

    var stillStatus = document.createElement("div");
    stillStatus.className = "still-status";

    captureBtn.addEventListener("click", function () {
      captureProgramStill(vista, thumbs, captureBtn, stillStatus);
    });

    // Zona drag & drop: al clicar abre el selector; al soltar, ingiere.
    var drop = document.createElement("div");
    drop.className = "dropzone";
    drop.innerHTML = '<span class="dz-text">Arrastrá imágenes, PDFs o referencias aquí, o <u>hacé clic para elegir</u></span>';
    drop.addEventListener("click", function () { fileInput.click(); });
    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("is-over"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("is-over"); });
    drop.addEventListener("drop", function (e) {
      e.preventDefault();
      drop.classList.remove("is-over");
      var files = e.dataTransfer && e.dataTransfer.files;
      ingestFiles(files, vista, thumbs, resList, stillStatus);
    });

    fileInput.addEventListener("change", function () {
      ingestFiles(fileInput.files, vista, thumbs, resList, stillStatus);
      fileInput.value = "";
    });

    wrap.appendChild(captureBtn);
    wrap.appendChild(drop);
    wrap.appendChild(fileInput);
    wrap.appendChild(stillStatus);
    wrap.appendChild(thumbs);
    wrap.appendChild(resList);
    renderStills(thumbs, vista);
    renderResources(resList, vista);
    return wrap;
  }

  global.HPStills = {
    init: function (d) { if (d && d.onGeneralChanged) deps.onGeneralChanged = d.onGeneralChanged; },
    createControl: createControl,
    refresh: refresh,
    // Selección de reenvío en feedback (dueño del estado por job):
    fbInit: fbInit,
    fbCollect: fbCollect,
    fbClear: fbClear,
    // Expuesta para el test de Windows (armado de la URL file://).
    stillThumbSrc: stillThumbSrc
  };
})(typeof window !== "undefined" ? window : this);
