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
      el: box,
      getValue: function () { return input.value; },
      setValue: function (v) { input.value = String(v == null ? "" : v); paint(); sync(); },
      focus: function () { input.focus(); }
    };
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

    function labelFor(v) {
      for (var i = 0; i < opts.length; i++) if (opts[i].value === v) return opts[i].label;
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
      opts = (list || []).map(function (o) { return { value: String(o.value), label: String(o.label) }; });
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
          label.textContent = o.label;
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
