/**
 * HPTabs — conmutador de las pestañas del panel (Marcadores / Cola /
 * Corrections).
 *
 * Es poco código, pero tiene una trampa: mientras fueron dos, "la otra" se
 * podía escribir como un booleano, y al aparecer la tercera ese booleano deja
 * una vista vieja encima de la nueva. Con la tabla, sumar una pestaña es sumar
 * una fila y no hay ninguna condición que actualizar.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPTabs.
 */
(function (global) {
  "use strict";

  /**
   * @param {Array<{name: string, tab: Element, view: Element}>} defs
   *        Los elementos pueden faltar (el panel se carga por partes): una
   *        pestaña sin su botón o sin su vista simplemente no se toca.
   * @returns {{select: function(string), current: function(): string}}
   */
  function create(defs) {
    var list = defs || [];
    var actual = "";

    function select(which) {
      actual = which;
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        var on = t.name === which;
        if (t.view) t.view.setAttribute("data-hidden", on ? "false" : "true");
        // Se toca la clase y no el contenido: el botón de la Cola lleva adentro
        // el <span> del contador.
        if (t.tab) t.tab.className = "tab" + (on ? " is-active" : "");
      }
    }

    for (var i = 0; i < list.length; i++) {
      (function (t) {
        if (t.tab) t.tab.addEventListener("click", function () { select(t.name); });
      })(list[i]);
    }

    return { select: select, current: function () { return actual; } };
  }

  global.HPTabs = { create: create };
})(typeof window !== "undefined" ? window : this);
