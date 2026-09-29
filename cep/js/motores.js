/**
 * HPMotores — qué motores de animación hay, para el lado del panel.
 *
 * ── Por qué es un módulo y no un objeto literal ──────────────────────
 *
 * Los motores viven en el bridge (bridge/render/motores.js): él sabe cómo se
 * llama cada uno, en qué lenguaje se compone y si está instalado en ESTA
 * máquina. El panel necesita el nombre en tres lugares que no tienen nada que
 * ver entre sí —el desplegable de ⚙, el tooltip de una fila de Corrections y el
 * detalle de un trabajo terminado en la Cola— y ninguno de los tres puede
 * preguntárselo al disco cada vez que dibuja una fila.
 *
 * Así que se lee UNA vez al abrir el panel y se guarda acá. Escribir la lista a
 * mano en el panel era la otra opción, y es la que se descartó: serían dos
 * catálogos que hay que acordarse de mantener iguales, y el día que no lo estén
 * el panel va a mostrar un motor que el bridge no tiene (o al revés) sin que
 * nada falle.
 *
 * Mientras la lista no llegó, `nombre(id)` devuelve el id. Es lo honesto: el id
 * es corto y reconocible ('remotion'), y poner "cargando…" en un tooltip que se
 * dibuja una sola vez lo dejaría diciendo eso para siempre.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPMotores.
 */
(function (global) {
  "use strict";

  var catalogo = [];

  function buscar(id) {
    var key = String(id || "");
    for (var i = 0; i < catalogo.length; i++) if (catalogo[i].id === key) return catalogo[i];
    return null;
  }

  global.HPMotores = {
    /** Guarda lo que contestó el bridge (getConfig / engineStatus traen `motores`). */
    set: function (lista) {
      if (Array.isArray(lista) && lista.length) catalogo = lista;
      return catalogo;
    },
    lista: function () { return catalogo.slice(); },
    /** Cómo se le dice a este motor a un editor. Sin catálogo, el id pelado. */
    nombre: function (id) {
      var m = buscar(id);
      return m ? m.nombre : String(id || "");
    },
    /** Con qué gramática lo resalta Prism ('markup' | 'tsx'). */
    lenguaje: function (id) {
      var m = buscar(id);
      return (m && m.lenguaje) || "markup";
    },
    /**
     * ¿Se puede usar en este equipo?
     *
     * Un id que el catálogo no conoce se contesta `true`, y es a propósito: la
     * única cosa que este dato decide es si el panel avisa antes de encolar, y
     * un aviso por un motor que no sabemos si falta sería un falso positivo que
     * frena trabajo bueno. El bridge vuelve a chequearlo antes de renderizar,
     * que es donde la respuesta importa de verdad.
     */
    instalado: function (id) {
      var m = buscar(id);
      return m ? !!m.instalado : true;
    },
  };
})(this);
