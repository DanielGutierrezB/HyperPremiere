/**
 * HPWidgets — widgets genéricos del panel, sin lógica de negocio:
 *   - makeCodeEditor: editor de código con resaltado (Prism) para el HTML.
 *   - select: desplegable propio (CEF de Premiere no dibuja el popup nativo).
 *   - confirmOverlay: overlay de confirmación genérico.
 *   - installTooltips: tooltips propios (CEF no dibuja los `title` nativos).
 *
 * Vanilla JS, sin ES modules: se expone como window.HPWidgets.
 */
(function (global) {
  "use strict";

  var escapeHtml = HPUtil.escapeHtml;

  // Editor de código con resaltado de sintaxis: textarea transparente encima de
  // un <pre> coloreado por Prism (sirve offline, sin CDN). Devuelve { el,
  // getValue, setValue }. Resalta HTML + CSS + JS embebidos.
  function makeCodeEditor() {
    var caja = document.createElement("div");
    caja.className = "code-edit-wrap";
    var box = document.createElement("div");
    box.className = "code-edit";
    var pre = document.createElement("pre");
    pre.className = "code-hl";
    pre.setAttribute("aria-hidden", "true");
    var code = document.createElement("code");
    pre.appendChild(code);
    var input = document.createElement("textarea");
    input.className = "code-input";
    input.spellcheck = false;
    box.appendChild(pre);
    box.appendChild(input);
    caja.appendChild(box);
    caja.appendChild(buscador(input));

    function paint() {
      var src = input.value;
      if (typeof Prism !== "undefined" && Prism.languages && Prism.languages.markup) {
        // Newline final: Prism/pre necesita que la última línea tenga cierre.
        code.innerHTML = Prism.highlight(src + "\n", Prism.languages.markup, "markup");
      } else {
        code.innerHTML = escapeHtml(src) + "\n";
      }
    }
    function sync() { pre.scrollTop = input.scrollTop; pre.scrollLeft = input.scrollLeft; }

    input.addEventListener("input", paint);
    input.addEventListener("scroll", sync);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Tab") {
        e.preventDefault();
        var s = input.selectionStart, en = input.selectionEnd;
        input.value = input.value.slice(0, s) + "  " + input.value.slice(en);
        input.selectionStart = input.selectionEnd = s + 2;
        paint();
      }
    });

    return {
      el: caja,
      getValue: function () { return input.value; },
      setValue: function (v) { input.value = String(v == null ? "" : v); paint(); sync(); },
      focus: function () { input.focus(); }
    };
  }

  /**
   * La barra de BUSCAR del editor de HTML.
   *
   * ── Por qué existe ───────────────────────────────────────────────────
   *
   * Lo pidió el editor: "al editor del html, ¿podemos agregar una opción de
   * buscar? La idea es poder buscar una palabra en específico". Un HTML generado
   * tiene varios cientos de líneas y el arreglo a mano suele ser cambiar un color
   * o un texto que aparece una vez: sin buscar, hay que barrerlo con la vista.
   * El `⌘F` del navegador no sirve acá: CEF no lo trae, y aunque lo trajera
   * buscaría en el panel entero y no en el campo.
   *
   * ── Cómo resalta, que es la decisión ─────────────────────────────────
   *
   * NO pinta las coincidencias. El editor ya tiene dos capas —el `<pre>` que
   * colorea Prism y el textarea transparente encima—, y meter marcas adentro del
   * HTML que genera Prism es reescribir su salida: hay que partir los `<span>`
   * del resaltado por el medio cuando la palabra cae entre dos, y cualquier
   * desajuste desalinea las dos capas.
   *
   * En vez de eso usa la SELECCIÓN del propio campo, que ya se ve (el textarea
   * es transparente pero su `::selection` se pinta). Ir a una coincidencia es
   * seleccionarla, que además deja el cursor donde hay que escribir: el gesto
   * completo es buscar y corregir, no buscar y después ubicarse.
   */
  function buscador(input) {
    var barra = document.createElement("div");
    barra.className = "code-find";

    var campo = document.createElement("input");
    campo.type = "text";
    campo.className = "code-find-input";
    campo.placeholder = "Buscar en el HTML…";
    campo.setAttribute("aria-label", "Buscar en el HTML");

    var cuenta = document.createElement("span");
    cuenta.className = "code-find-count hp-dato";

    var antes = botonDeBusqueda("subir", "Anterior (⇧↵)");
    var luego = botonDeBusqueda("bajar", "Siguiente (↵)");

    barra.appendChild(campo);
    barra.appendChild(cuenta);
    barra.appendChild(antes);
    barra.appendChild(luego);

    var encontrados = [];
    var cual = -1;

    /** Dónde empieza cada coincidencia, sin distinguir mayúsculas ni acentos. */
    function buscar() {
      var q = campo.value;
      encontrados = [];
      cual = -1;
      if (q) {
        // Sin mayúsculas: se busca "DIV" y se encuentra "div", que es lo que uno
        // espera de un buscador de código. Los acentos SÍ cuentan: en un HTML lo
        // que se busca suele ser un nombre de clase o una etiqueta, y ahí la
        // diferencia entre "titulo" y "título" es real.
        var texto = input.value.toLowerCase();
        var aguja = q.toLowerCase();
        var i = texto.indexOf(aguja);
        while (i !== -1) {
          encontrados.push(i);
          // Se salta la coincidencia entera, o sea que no se cuentan las que se
          // solapan: buscando "aa" en "aaaa" hay dos y no tres, que es lo que
          // hace cualquier buscador y lo que uno cuenta mirando.
          i = texto.indexOf(aguja, i + aguja.length);
        }
      }
      pintarCuenta();
    }

    function pintarCuenta() {
      var hay = encontrados.length;
      if (!campo.value) { cuenta.textContent = ""; barra.classList.remove("sin-nada"); return; }
      // "3 de 12" y no sólo el total: lo que se necesita saber recorriéndolas es
      // dónde va uno, y si dio la vuelta.
      cuenta.textContent = hay ? (cual + 1) + " de " + hay : "sin resultados";
      barra.classList.toggle("sin-nada", !hay);
      antes.disabled = hay < 2;
      luego.disabled = hay < 2;
    }

    /**
     * Va a la coincidencia `n` (da la vuelta en las dos puntas) y la deja
     * SELECCIONADA.
     *
     * El scroll se calcula a mano contando renglones y no se le deja al
     * navegador: en un textarea, mover la selección por código no arrastra la
     * vista, así que la coincidencia quedaba seleccionada fuera de pantalla y
     * parecía que no había encontrado nada. Se la deja en el medio del campo, que
     * es donde se puede leer con su contexto.
     */
    function ir(n) {
      if (!encontrados.length) return;
      cual = (n + encontrados.length) % encontrados.length;
      var desde = encontrados[cual];
      var hasta = desde + campo.value.length;
      input.focus();
      input.setSelectionRange(desde, hasta);

      var renglon = input.value.slice(0, desde).split("\n").length - 1;
      var alto = parseFloat(global.getComputedStyle(input).lineHeight) || 18;
      input.scrollTop = Math.max(0, renglon * alto - input.clientHeight / 2);
      input.dispatchEvent(new Event("scroll"));
      pintarCuenta();
    }

    campo.addEventListener("input", function () { buscar(); ir(0); });
    campo.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); ir(e.shiftKey ? cual - 1 : cual + 1); }
      // Escape devuelve el foco al código: se busca para ARREGLAR, así que salir
      // del buscador tiene que dejar el cursor donde se va a escribir, y donde lo
      // dejó la última coincidencia.
      if (e.key === "Escape") { e.preventDefault(); input.focus(); }
    });
    antes.addEventListener("click", function () { ir(cual - 1); });
    luego.addEventListener("click", function () { ir(cual + 1); });

    // ⌘F / Ctrl+F con el cursor en el código: lo natural, y en CEF no lo toma
    // nadie más. Si hay algo seleccionado, se busca eso, que es el gesto de
    // "encontrá los otros como éste".
    input.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        var sel = input.value.slice(input.selectionStart, input.selectionEnd);
        if (sel && sel.indexOf("\n") === -1) campo.value = sel;
        campo.focus();
        campo.select();
        buscar();
        if (encontrados.length) ir(0);
      }
    });
    // Lo que se escribe cambia dónde están las coincidencias: recontarlas es más
    // barato que dejar una cuenta que miente.
    input.addEventListener("input", function () { if (campo.value) buscar(); });

    return barra;
  }

  function botonDeBusqueda(icono, titulo) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "code-find-btn hp-ico-btn";
    b.title = titulo;
    b.disabled = true;
    // Las mismas flechas con las que la Cola reordena: es el mismo gesto de
    // "el de arriba" y "el de abajo", y no hace falta un dibujo nuevo.
    if (global.HPIconos && HPIconos.el) b.appendChild(HPIconos.el(icono));
    else b.textContent = icono === "subir" ? "\u2191" : "\u2193";
    return b;
  }

  // Un único listener global cierra el desplegable abierto al clicar afuera
  // (evita acumular un listener por cada select creado al recargar marcadores).
  var _openSelect = null;
  document.addEventListener("click", function (e) {
    if (_openSelect && !_openSelect.root.contains(e.target)) _openSelect.close();
  });

  // Desplegable propio: Premiere (CEP/CEF) no dibuja el popup de los <select>
  // nativos, así que armamos uno con divs (botón + menú) que sí despliega.
  function select(root) {
    if (!root) return null;
    root.classList.add("hp-select");
    root.innerHTML = "";
    var trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "hps-trigger";
    var label = document.createElement("span");
    label.className = "hps-label";
    var arrow = document.createElement("span");
    arrow.className = "hps-arrow";
    arrow.textContent = "▾";
    trigger.appendChild(label);
    trigger.appendChild(arrow);
    var menu = document.createElement("div");
    menu.className = "hps-menu";
    menu.hidden = true;
    root.appendChild(trigger);
    root.appendChild(menu);

    var opts = [];
    var value = null;
    var api = { onChange: null };

    // Lo que muestra el botón cerrado puede ser MÁS CORTO que lo que muestra el
    // menú: en el encabezado del panel el desplegable del micrófono tiene 34 px
    // y el menú, desplegado, todo el ancho. Sin `corto` es la misma etiqueta.
    function labelFor(v) {
      for (var i = 0; i < opts.length; i++) if (opts[i].value === v) return opts[i].corto || opts[i].label;
      return v || "—";
    }
    function markSelected() {
      var kids = menu.children;
      for (var i = 0; i < kids.length; i++) {
        kids[i].className = "hps-option" + (kids[i].getAttribute("data-value") === value ? " is-sel" : "");
      }
    }
    function close() { menu.hidden = true; root.classList.remove("is-open"); if (_openSelect && _openSelect.root === root) _openSelect = null; }
    function toggle(e) {
      e.stopPropagation();
      if (menu.hidden) {
        // Cerrar cualquier otro desplegable abierto (solo uno a la vez).
        if (_openSelect && _openSelect.root !== root) _openSelect.close();
        menu.hidden = false; root.classList.add("is-open");
        _openSelect = { root: root, close: close };
      } else { close(); }
    }

    trigger.addEventListener("click", toggle);

    api.setOptions = function (list, selected) {
      opts = (list || []).map(function (o) {
        return { value: String(o.value), label: String(o.label), corto: o.corto == null ? "" : String(o.corto) };
      });
      menu.innerHTML = "";
      opts.forEach(function (o) {
        var el = document.createElement("div");
        el.className = "hps-option";
        el.setAttribute("data-value", o.value);
        el.textContent = o.label;
        el.addEventListener("click", function (e) {
          e.stopPropagation();
          var changed = (o.value !== value);
          value = o.value;
          label.textContent = o.corto || o.label;
          markSelected();
          close();
          if (changed && typeof api.onChange === "function") api.onChange(value);
        });
        menu.appendChild(el);
      });
      if (selected != null) value = String(selected);
      label.textContent = labelFor(value);
      markSelected();
    };
    Object.defineProperty(api, "value", {
      get: function () { return value; },
      set: function (v) { value = (v == null ? null : String(v)); label.textContent = labelFor(value); markSelected(); }
    });
    return api;
  }

  // Overlay de confirmación genérico (reusa estilos del overlay de ayuda).
  function confirmOverlay(title, buildBody, okLabel, onOk) {
    var ov = document.createElement("div"); ov.className = "help-overlay"; ov.setAttribute("data-hidden", "false");
    var card = document.createElement("div"); card.className = "help-card";
    var head = document.createElement("div"); head.className = "help-head";
    var h = document.createElement("span"); h.textContent = title; head.appendChild(h);
    var x = document.createElement("button"); x.type = "button"; x.className = "icon-btn"; x.textContent = "✕"; x.title = "Cancelar"; head.appendChild(x);
    card.appendChild(head);
    var body = document.createElement("div"); body.className = "help-body"; buildBody(body); card.appendChild(body);
    var actions = document.createElement("div"); actions.className = "config-actions";
    var cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancelar";
    var ok = document.createElement("button"); ok.type = "button"; ok.className = "btn-primary"; ok.textContent = okLabel;
    actions.appendChild(cancel); actions.appendChild(ok); card.appendChild(actions);
    ov.appendChild(card); document.body.appendChild(ov);
    function close() { try { document.body.removeChild(ov); } catch (e) {} }
    x.addEventListener("click", close); cancel.addEventListener("click", close);
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    ok.addEventListener("click", function () { close(); onOk(); });
  }

  // Tooltips propios: CEF (Premiere) NO dibuja los tooltips nativos de `title`.
  // Mostramos uno propio leyendo el atributo title/data-tip de cualquier control.
  function installTooltips() {
    var tip = document.createElement("div");
    tip.className = "hp-tip"; tip.setAttribute("data-hidden", "true");
    document.body.appendChild(tip);
    var curEl = null;
    function titledAncestor(el) {
      while (el && el !== document.body && el.nodeType === 1) {
        if (el.getAttribute) {
          var t = el.getAttribute("title");
          if (t) { el.setAttribute("data-tip", t); el.removeAttribute("title"); return { el: el, t: t }; }
          var dt = el.getAttribute("data-tip");
          if (dt) return { el: el, t: dt };
        }
        el = el.parentNode;
      }
      return null;
    }
    function place(el) {
      var r = el.getBoundingClientRect();
      tip.style.visibility = "hidden"; tip.setAttribute("data-hidden", "false");
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      var left = Math.max(6, Math.min(window.innerWidth - tw - 6, r.left));
      var top = r.bottom + 6;
      if (top + th > window.innerHeight - 6) top = r.top - th - 6; // arriba si no cabe abajo
      tip.style.left = left + "px"; tip.style.top = Math.max(6, top) + "px";
      tip.style.visibility = "visible";
    }
    document.addEventListener("mouseover", function (e) {
      var r = titledAncestor(e.target);
      if (!r) return;
      if (r.el === curEl && tip.getAttribute("data-hidden") === "false") return;
      curEl = r.el; tip.textContent = r.t; place(r.el);
    });
    document.addEventListener("mouseout", function (e) {
      if (!curEl) return;
      // Ocultar solo al salir del elemento con tooltip (no al pasar a un hijo).
      if (e.relatedTarget && curEl.contains(e.relatedTarget)) return;
      tip.setAttribute("data-hidden", "true"); curEl = null;
    });
    document.addEventListener("click", function () { tip.setAttribute("data-hidden", "true"); curEl = null; }, true);
  }

  global.HPWidgets = {
    makeCodeEditor: makeCodeEditor,
    select: select,
    confirmOverlay: confirmOverlay,
    installTooltips: installTooltips
  };
})(typeof window !== "undefined" ? window : this);
