/**
 * HPMotores — los motores de animación, del lado del panel: el catálogo y la
 * fila de ⚙ que los elige.
 *
 * ── Por qué el catálogo es un módulo y no un objeto literal ──────────
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
 * ── Y por qué la FILA de ⚙ también está acá ──────────────────────────
 *
 * Porque es lo mismo que este módulo ya sabe: el desplegable, la línea de
 * estado, el botón de instalar y la condición de la licencia se arman del mismo
 * catálogo. Vivía en `config-ui.js` y le costaba ciento treinta y siete líneas
 * más un slot mutable de nivel de módulo que arrancaba en `null` —con su
 * null-check en el camino del render de la config, porque montar la fila puede
 * fallar si faltan los nodos—. Acá el módulo se acuerda de sus propios nodos y
 * `config-ui.js` queda con dos líneas: montarla y aplicarle la config.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPMotores.
 */
(function (global) {
  "use strict";

  var catalogo = [];

  // Los nodos de la fila de ⚙ y su desplegable. Viven en el módulo porque la
  // línea de estado y el botón se redibujan cuando cambia la elección, sin
  // volver a preguntarle nada al disco.
  var sel = null;
  var linea = null;
  var btn = null;
  var barra = null;
  var relleno = null;

  // Lo que dice la licencia de Remotion, que es su única condición de uso. Se
  // escribe en el tooltip y en la línea de estado, no en un cartel: es un dato
  // que se lee una vez, al elegirlo, y un cartel permanente en ⚙ sería ruido en
  // todas las sesiones siguientes. El texto sale de su página de precios.
  var LICENCIAS = {
    remotion: "Licencia gratuita para personas y empresas de hasta 3 integrantes, " +
      "con uso comercial sin límite. De 4 en adelante, Remotion pide su licencia de empresa.",
  };

  function log(texto, nivel) {
    if (typeof HPLog !== "undefined" && HPLog && HPLog.log) HPLog.log(texto, nivel);
  }

  function set(lista) {
    if (Array.isArray(lista) && lista.length) catalogo = lista;
    return catalogo;
  }

  function buscar(id) {
    var key = String(id || "");
    for (var i = 0; i < catalogo.length; i++) if (catalogo[i].id === key) return catalogo[i];
    return null;
  }

  /** El motor que está elegido en el desplegable. */
  function elegido() {
    return (sel && buscar(sel.value)) || catalogo[0] || null;
  }

  /**
   * La línea de estado y el botón, según el motor elegido.
   *
   * Es lo que el editor lee para decidir, y son tres estados que se arreglan
   * distinto: listo (y su licencia), sin instalar, e instalado a medias. El
   * MOTIVO lo escribe el bridge y se muestra tal cual: sabe si le falta el
   * proyecto, las dependencias o el Chrome, y un "no está instalado" genérico
   * mandaría a reinstalar 400 MB cuando faltan 137 de navegador.
   */
  function pintar() {
    if (!linea) return;
    var m = elegido();
    if (!m) { linea.textContent = ""; return; }
    var licencia = LICENCIAS[m.id] || "";
    if (m.instalado) {
      linea.textContent = licencia || "Viene con el panel: no hay nada que instalar.";
      linea.className = "muted";
    } else {
      linea.textContent = m.motivo || "Todavía no está instalado en este equipo.";
      linea.className = "muted is-warn";
    }
    if (!btn) return;
    btn.setAttribute("data-hidden", (!m.instalado && m.instalable) ? "false" : "true");
    // El botón dice "Instalar" a secas y no "Instalar Remotion (React)": el
    // nombre está en el desplegable, pegado a la izquierda. Repetirlo le comía
    // al desplegable 120 px y a 320 —el ancho en el que el editor deja el panel
    // para ver el timeline— lo dejaba en «Remotio…», que es justo el dato que
    // hay que leer para elegir.
    btn.title = "Baja e instala " + m.nombre + " en ~/.hyperpremiere. Se hace una sola vez por equipo." +
      (licencia ? "\n" + licencia : "");
  }

  /** Guarda la elección, y avisa si se eligió uno que todavía no se puede usar. */
  function elegir(id) {
    var m = buscar(id);
    pintar();
    // `HPEngine.call` directo y no un alias de arriba del módulo: este archivo
    // carga con los helpers, ANTES de engine-client.js, así que un alias
    // quedaría en `undefined` para siempre. Adentro del handler el global ya
    // está. Es lo mismo que hace `callProg` unas líneas más abajo.
    return HPEngine.call("setConfig", { renderEngine: id })
      .then(function () {
        log("Motor de animación: lo nuevo se va a componer con " + (m ? m.nombre : id) + ".");
        if (m && !m.instalado) {
          log("OJO: ese motor todavía no está instalado. Instalalo desde ⚙ antes de encolar.", "WARN");
        }
      })
      .catch(function (e) {
        if (!linea) return;
        linea.textContent = "No pude guardar el motor: " + ((e && e.message) || e);
        linea.className = "muted is-error";
      });
  }

  /** Baja e instala el motor elegido, con su barra de progreso. */
  function instalar(recargar) {
    var m = elegido();
    if (!m || m.instalado) return;
    btn.disabled = true;
    if (barra) barra.setAttribute("data-hidden", "false");
    linea.textContent = "Instalando " + m.nombre + "… (se hace una sola vez, puede tardar varios minutos)";
    linea.className = "muted";
    log("Instalando el motor " + m.nombre + " a pedido del editor.");
    HPEngine.callProg("installRenderEngine", { engine: m.id }, function (p) {
      if (!p) return;
      if (typeof p.pct === "number" && relleno) relleno.style.width = Math.max(0, Math.min(100, p.pct)) + "%";
      if (p.msg) linea.textContent = p.msg;
      if (p.note) log(p.note, p.level || "INFO");
    }).then(function (r) {
      btn.disabled = false;
      if (!r || !r.ok) throw new Error((r && r.error) || "el motor no dijo por qué");
      if (relleno) relleno.style.width = "100%";
      log(m.nombre + " quedó instalado.");
      // Se relee del disco en vez de marcarlo instalado acá: lo que decide si se
      // puede usar es que los archivos estén, y eso lo contesta el bridge.
      if (typeof recargar === "function") recargar();
    }).catch(function (e) {
      btn.disabled = false;
      if (barra) barra.setAttribute("data-hidden", "true");
      linea.textContent = "No se pudo instalar: " + ((e && e.message) || e);
      linea.className = "muted is-error";
      log("La instalación de " + m.nombre + " falló: " + ((e && e.message) || e), "ERROR");
    });
  }

  /**
   * Monta la fila de ⚙. `recargar` es lo que hay que llamar cuando una
   * instalación termina, para que el estado se relea del disco.
   *
   * Devuelve si pudo: sin los nodos (o sin HPWidgets) no hay fila, y el resto
   * del módulo sigue sirviendo igual como catálogo.
   */
  function montarFila(recargar) {
    var caja = document.getElementById("cfg-engine");
    linea = document.getElementById("engine-status");
    btn = document.getElementById("btn-install-engine");
    barra = document.getElementById("engine-progress");
    relleno = document.getElementById("engine-fill");
    if (!caja || !linea || typeof HPWidgets === "undefined") return false;

    sel = HPWidgets.select(caja);
    sel.onChange = function () { elegir(sel.value); };
    if (btn) btn.addEventListener("click", function () { instalar(recargar); });
    return true;
  }

  /**
   * Refleja en la fila la config recién leída.
   *
   * El desplegable se arma del catálogo que trae la config, no de una lista
   * escrita en el panel: agregar un motor en el bridge lo hace aparecer acá sin
   * tocar nada de esto.
   */
  function aplicar(cfg) {
    set((cfg && cfg.motores) || []);
    if (!catalogo.length || !sel) return;
    sel.setOptions(catalogo.map(function (m) {
      // El nombre dice el lenguaje ("HyperFrames (HTML + GSAP)"), que es la
      // diferencia que de verdad importa al elegir. El "— sin instalar" va en la
      // opción misma y no solo en la línea de abajo: es lo que hace que se vea
      // al desplegar, antes de elegirlo.
      return { value: m.id, label: m.nombre + (m.instalado ? "" : " — sin instalar") };
    }), (cfg && cfg.renderEngine) || catalogo[0].id);
    pintar();
  }

  global.HPMotores = {
    /** Guarda lo que contestó el bridge (getConfig / engineStatus traen `motores`). */
    set: set,
    /** La fila «Motor de animación» de ⚙: montarla una vez, aplicarle la config. */
    montarFila: montarFila,
    aplicar: aplicar,
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
