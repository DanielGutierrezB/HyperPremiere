/**
 * HPMicSelect — el selector de micrófono del dictado, UNA implementación
 * montada en DOS lugares: el encabezado del panel y la fila de ⚙.
 *
 * Vivía suelto adentro de config-ui.js. Cuando el desplegable pasó a estar
 * también arriba, copiarlo era la manera segura de que los dos se
 * desincronizaran: elegís un micrófono en el encabezado y ⚙ sigue mostrando el
 * anterior hasta que alguien lo recargue. Así que hay un solo estado —lo último
 * que contestó el motor— y N vistas que lo pintan; elegir en cualquiera guarda,
 * vuelve a preguntar y repinta TODAS.
 *
 * Del motor se usan dos cosas y nada más: `microfonoListar()`, que devuelve la
 * lista con el default del sistema y con cuál se usaría ahora, y
 * `setConfig({ microfono })`, que guarda la elección por NOMBRE (los índices de
 * avfoundation son la posición en la lista de ese momento: enchufar unos
 * auriculares los corre a todos). La prueba con medidor NO está acá: es de ⚙,
 * donde hay lugar para la barra y el veredicto.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPMicSelect.
 */
(function (global) {
  "use strict";

  // Sufijos que repiten todos los dispositivos de audio de macOS y que en el
  // encabezado no distinguen nada: las seis entradas de esta máquina terminan
  // en "Microphone". Sacarlo deja lo único que el editor mira ("MacBook Pro",
  // "OBSBOT Meet 2", "iPhone de Daniel") y ahorra ~75 px de una barra que en un
  // panel de 320 tiene 296. El nombre COMPLETO sigue estando en el tooltip, en
  // el menú desplegado y en ⚙; lo que se guarda es siempre el nombre entero.
  var SUFIJOS = [/\s+microphone$/i, /\s+micr[oó]fono$/i, /\s+mic$/i];
  // Tope del nombre corto. No es el ancho de la caja —eso lo resuelve el CSS con
  // su ellipsis—, es un techo para que un dispositivo virtual con un nombre de
  // sesenta caracteres no infle el ancho que el desplegable le pide a la fila.
  var TOPE_CORTO = 22;

  var vistas = [];
  var ultima = null;    // lo último que contestó microfonoListar
  var enVuelo = null;   // la consulta en curso: dos vistas montándose preguntan una vez
  var hpLog = null;

  function log(msg, nivel) {
    if (!hpLog) hpLog = (typeof HPLog !== "undefined" && HPLog && HPLog.log) ? HPLog.log : function () {};
    hpLog(msg, nivel);
  }

  // ── Decisiones puras (lo que se prueba sin motor y sin layout) ─────────

  /**
   * El nombre para la barra angosta: sin el "Microphone" que repiten todos y
   * con un tope de largo.
   *
   * Si al sacar el sufijo no queda nada —un dispositivo llamado "Microphone" a
   * secas— se devuelve el nombre tal cual: es mejor un nombre largo que una
   * etiqueta vacía.
   */
  function nombreCorto(nombre) {
    var s = String(nombre == null ? "" : nombre).trim();
    if (!s) return "";
    var corto = s;
    for (var i = 0; i < SUFIJOS.length; i++) {
      var sin = corto.replace(SUFIJOS[i], "").trim();
      if (sin) { corto = sin; break; }
    }
    return HPUtil.shortenMiddle(corto, TOPE_CORTO);
  }

  /** La línea de estado bajo el desplegable, a partir de lo que resolvió el motor. */
  function textoDeEstado(r) {
    var u = (r && r.usa) || {};
    if (u.origen === "elegido") {
      return { texto: "Elegido: «" + u.nombre + "» (índice " + u.indice + " ahora)." + (u.aviso ? " " + u.aviso : ""), clase: "" };
    }
    if (u.origen === "caida" || u.origen === "sin-dispositivos") return { texto: u.aviso || "", clase: "is-warn" };
    return { texto: u.aviso || "", clase: "" };
  }

  /**
   * Las opciones del desplegable: "el del sistema" primero, después la lista.
   *
   * `compacto` agrega el nombre corto, que es lo que muestra el botón CERRADO
   * del encabezado —ahí hay 34 px en un panel mínimo—. El menú desplegado usa
   * `label` en las dos vistas: ahí sobra ancho y el nombre entero es la
   * información. En ⚙ el botón cerrado muestra el entero, porque la fila es
   * ancha y esa fila es la que se mira para diagnosticar.
   */
  function opciones(r, compacto) {
    var porDefecto = (r && r.porDefecto) || "";
    var opts = [{
      value: "",
      label: "Por defecto del sistema" + (porDefecto ? " · " + porDefecto : " (Ajustes → Sonido → Entrada)"),
      corto: porDefecto ? nombreCorto(porDefecto) : "del sistema",
    }];
    var elegido = String((r && r.elegido) || "");
    var lo = false;
    ((r && r.dispositivos) || []).forEach(function (d) {
      if (d.nombre === elegido) lo = true;
      opts.push({
        value: d.nombre,
        label: d.nombre + (d.porDefecto ? " · por defecto del sistema" : ""),
        corto: nombreCorto(d.nombre),
      });
    });
    // El elegido que hoy no está enchufado se ofrece igual, diciéndolo: si se
    // lo sacara de la lista, el editor no vería qué tiene elegido ni podría
    // conservarlo para cuando lo vuelva a conectar.
    if (elegido && !lo) {
      opts.push({ value: elegido, label: elegido + " · no conectado ahora", corto: "⚠ " + nombreCorto(elegido) });
    }
    if (compacto) return opts;
    return opts.map(function (o) { return { value: o.value, label: o.label }; });
  }

  /**
   * El tooltip del desplegable del encabezado: ahí arriba no hay lugar para la
   * línea de estado que sí tiene ⚙, así que el nombre completo, de dónde salió
   * y el aviso de que el elegido no está viajan en el tooltip.
   */
  function tooltip(r) {
    var u = (r && r.usa) || {};
    if (!u.nombre) return "Micrófono del dictado por voz.";
    var base = "Micrófono del dictado por voz. ";
    if (u.origen === "caida") return base + (u.aviso || "El micrófono elegido no está conectado.");
    if (u.origen === "elegido") return base + "Usa «" + u.nombre + "» (índice " + u.indice + " ahora), elegido acá.";
    return base + (u.aviso || "Usa «" + u.nombre + "», el que macOS tiene por defecto.");
  }

  /**
   * ¿Se puede ofrecer el desplegable? Un encabezado con un desplegable vacío o
   * en error es peor que un encabezado sin desplegable: el editor toca algo que
   * no hace nada. En ⚙ es al revés —ahí sí hay que decir POR QUÉ no se puede—,
   * y por eso la respuesta es la misma pero cada vista la usa distinto.
   */
  function hayDeQueElegir(r) {
    return Boolean(r && r.ok && ((r.dispositivos || []).length || r.elegido));
  }

  // ── Las vistas ────────────────────────────────────────────────────────

  function pintar(vista) {
    var r = ultima;
    if (vista.compacto) {
      // El encabezado se esconde entero si no hay de qué elegir: sin dictado en
      // esta máquina (Windows, sin ffmpeg, sin Whisper) o sin dispositivos.
      var mostrar = vista.dictadoDisponible !== false && hayDeQueElegir(r);
      vista.root.setAttribute("data-hidden", mostrar ? "false" : "true");
      if (!mostrar) return;
      // El tooltip propio del panel se queda con el `title` la primera vez que
      // se pasa por encima (lo mueve a `data-tip`), así que el viejo se borra:
      // si no, un micrófono que se desenchufó seguiría avisando lo de antes.
      vista.root.setAttribute("title", tooltip(r));
      vista.root.removeAttribute("data-tip");
      vista.root.className = "hdr-mic" + (((r.usa || {}).origen === "caida") ? " is-warn" : "");
    }
    if (!r || !r.ok) {
      var motivo = (r && r.error) || "el motor no contestó";
      vista.estado("No pude listar los micrófonos: " + motivo, "is-error");
      return;
    }
    vista.sel.setOptions(opciones(r, vista.compacto), r.elegido || "");
    var e = textoDeEstado(r);
    vista.estado(e.texto, e.clase);
  }

  function pintarTodas() { vistas.forEach(pintar); }

  /**
   * Le pregunta al motor qué micrófonos hay y repinta todas las vistas.
   *
   * Dos vistas montándose al abrir el panel harían dos consultas —y cada una
   * corre ffmpeg—, así que la que está en vuelo se comparte. `porQue` es lo que
   * sale en el ⬇ Log: sirve para distinguir el listado del arranque del que
   * pidió el editor con ↻ tras enchufar algo.
   */
  function refrescar(porQue) {
    if (enVuelo) return enVuelo;
    vistas.forEach(function (v) { if (!v.compacto) v.estado("Buscando micrófonos…", ""); });
    enVuelo = HPEngine.call("microfonoListar").then(function (r) {
      enVuelo = null;
      ultima = r;
      if (!r || !r.ok) {
        var motivo = (r && r.error) || "el motor no contestó";
        log("Micrófonos (" + porQue + "): no se pudieron listar: " + motivo, "ERROR");
        if (r && r.crudo) log("Micrófonos: salida cruda de ffmpeg:\n" + r.crudo, "ERROR");
        pintarTodas();
        return r;
      }
      log("Micrófonos (" + porQue + "): " + (r.dispositivos.map(function (d) {
        return "[" + d.indice + "] " + d.nombre;
      }).join(" · ") || "(ninguno)") + " · por defecto del sistema: " + (r.porDefecto ? "«" + r.porDefecto + "»" : "no se pudo averiguar") +
        " · elegido en ⚙: " + (r.elegido ? "«" + r.elegido + "»" : "ninguno"));
      var u = r.usa || {};
      log("Micrófono en uso: «" + u.nombre + "» (índice " + u.indice + ", " + u.origen + ", entrada " + u.entrada + ")" +
        (u.aviso ? " · " + u.aviso : ""), u.origen === "caida" || u.origen === "sin-dispositivos" ? "WARN" : "INFO");
      pintarTodas();
      return r;
    }).catch(function (e) {
      enVuelo = null;
      ultima = { ok: false, error: "no le pude preguntar al motor: " + ((e && e.message) || e) };
      log("Micrófonos (" + porQue + "): " + ((e && e.message) || e), "ERROR");
      pintarTodas();
      return ultima;
    });
    return enVuelo;
  }

  /**
   * Guarda la elección y repinta las dos vistas.
   *
   * Un dictado ANDANDO no se toca: el motor resolvió nombre → índice al abrir
   * el micrófono y su ffmpeg ya está corriendo con ese dispositivo. Cambiar acá
   * en el medio no lo rompe ni lo cambia — vale desde el próximo dictado, y eso
   * se DICE en vez de dejar creer que el cambio fue en vivo.
   */
  function elegir(nombre, vista) {
    var v = String(nombre || "");
    vista.estado("Guardando…", "");
    return HPEngine.call("setConfig", { microfono: v }).then(function () {
      log("Micrófono elegido en ⚙: " + (v ? "«" + v + "»" : "ninguno (vuelve al del sistema)"));
      // El estado de "¿se puede dictar y con qué?" que guardan los botones 🎙
      // ya no vale: los que se dibujen de acá en más tienen que decir el nuevo.
      if (typeof HPDictado !== "undefined" && HPDictado && typeof HPDictado.olvidarEstado === "function") HPDictado.olvidarEstado();
      return refrescar("tras elegir").then(function () { return avisarSiHayDictado(); });
    }).catch(function (e) {
      vista.estado("No pude guardar el micrófono: " + ((e && e.message) || e), "is-error");
    });
  }

  /** Si el motor dice que hay un dictado andando, se agrega a la línea de ⚙. */
  function avisarSiHayDictado() {
    return HPEngine.call("dictadoEstado").then(function (st) {
      if (!st || !st.enCurso) return;
      var nota = "El dictado que está andando sigue con el micrófono que abrió; el nuevo vale desde el próximo.";
      log("Micrófono: cambiado con un dictado en curso. " + nota, "WARN");
      vistas.forEach(function (v) {
        if (v.compacto) return;
        v.estado(((v.ultimoTexto || "") + " " + nota).trim(), "is-warn");
      });
    }).catch(function () { /* no saber si hay dictado no es un problema */ });
  }

  /**
   * Monta una vista del selector.
   *
   * @param {Element} root - el div donde va el desplegable.
   * @param {object} [opts]
   *   compacto: la del encabezado (se esconde sola, dice todo por tooltip).
   *   status: el nodo de la línea de estado (solo la de ⚙ tiene una).
   *   refresh: el botón ↻.
   * @returns {object|null} la vista, o null si no hay dónde montarla.
   */
  function montar(root, opts) {
    opts = opts || {};
    var sel = HPWidgets.select(root);
    if (!sel) return null;
    var nodoEstado = opts.status || null;
    var vista = {
      root: root,
      sel: sel,
      compacto: Boolean(opts.compacto),
      dictadoDisponible: null,
      ultimoTexto: "",
      estado: function (texto, clase) {
        vista.ultimoTexto = texto;
        if (!nodoEstado) return;
        nodoEstado.textContent = texto;
        nodoEstado.className = "muted" + (clase ? " " + clase : "");
      },
    };
    sel.onChange = function (v) { elegir(v, vista); };
    if (opts.refresh) opts.refresh.addEventListener("click", function () { refrescar("refrescado a pedido"); });
    vistas.push(vista);
    // Ya hay respuesta (la otra vista se montó antes): se pinta sin volver a
    // preguntarle a ffmpeg.
    if (ultima) pintar(vista);
    return vista;
  }

  /**
   * Monta la del encabezado, que además tiene que decidir si se muestra.
   *
   * En una máquina sin dictado (Windows, sin ffmpeg, sin el Whisper de Apple
   * Silicon) el desplegable de arriba no aparece: elegir el micrófono de una
   * función que no corre es ruido, y el porqué ya lo explica ⚙ y el botón 🎙 de
   * cada campo. Si el motor no contesta se muestra igual —no saber no es "no
   * hay"—, y ahí manda si se pudo listar o no.
   */
  function montarEncabezado(root, opts) {
    var vista = montar(root, Object.assign({ compacto: true }, opts || {}));
    if (!vista) return null;
    root.setAttribute("data-hidden", "true");
    HPEngine.call("dictadoEstado").then(function (st) {
      vista.dictadoDisponible = (st && st.disponible === false) ? false : true;
      if (vista.dictadoDisponible === false) {
        log("Micrófono en el encabezado: no se muestra porque en esta máquina no se puede dictar. " + ((st && st.motivo) || ""));
      }
      pintar(vista);
      // Red por si ⚙ no cargó: normalmente el listado ya está pedido cuando
      // llega esto, y entonces esta línea no hace nada (la consulta en vuelo se
      // comparte).
      if (!ultima && !enVuelo) refrescar("al abrir el panel");
    }).catch(function () { vista.dictadoDisponible = true; pintar(vista); });
    return vista;
  }

  global.HPMicSelect = {
    montar: montar,
    montarEncabezado: montarEncabezado,
    refrescar: refrescar,
    /** Lo último que contestó el motor (lo usa ⚙ para el medidor). */
    ultimaRespuesta: function () { return ultima; },
    // Expuestos para los tests: son las decisiones puras de este archivo.
    _nombreCorto: nombreCorto,
    _textoDeEstado: textoDeEstado,
    _opciones: opciones,
    _tooltip: tooltip,
    _hayDeQueElegir: hayDeQueElegir,
    _olvidar: function () { vistas = []; ultima = null; enVuelo = null; },
  };
})(typeof window !== "undefined" ? window : this);
