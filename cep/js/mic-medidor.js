/**
 * HPMicMedidor — el medidor de nivel de la prueba de micrófono (⚙ → Micrófono).
 *
 * Dibuja lo que el motor manda por `callProg("microfonoProbar")` unas diez
 * veces por segundo: una barra con el nivel en dBFS, un tic con el pico
 * sostenido y una marca fija donde está la compuerta de silencio del dictado
 * (−34 dBFS). Es lo que le muestra al editor, sin números que interpretar, si
 * su voz PASA o no la compuerta: la barra se pone verde cuando la cruza. Al
 * final pinta el veredicto que ya viene redactado del motor.
 *
 * No sabe de ffmpeg ni del motor: recibe `{ dbfs, picoDbfs, umbralDbfs, pasa }`
 * y un `{ estado, titulo, detalle }`. Por eso la geometría (de dBFS a
 * porcentaje de barra) y la clase de cada veredicto son funciones puras, que es
 * lo único de este archivo que se puede probar sin pantalla. El dibujo en sí
 * se mira en la maqueta (test/manual/panel-demo).
 *
 * Vanilla JS, sin ES modules: se expone como window.HPMicMedidor.
 */
(function (global) {
  "use strict";

  // El borde izquierdo de la barra. −60 dBFS es "nada": la sala callada que se
  // midió está en −44/−37 y ya se ve como una barrita; el habla, en −21, llega
  // a dos tercios. Más abajo no hay nada que valga la pena mostrar.
  var PISO_DBFS = -60;

  /** De dBFS al ancho de la barra, 0..100. Sin número (o −∞) es cero. */
  function porcentaje(dbfs) {
    if (dbfs == null || typeof dbfs !== "number" || !isFinite(dbfs)) return 0;
    var p = (dbfs - PISO_DBFS) / (0 - PISO_DBFS) * 100;
    return Math.max(0, Math.min(100, p));
  }

  function fmt(dbfs) {
    if (dbfs == null || typeof dbfs !== "number" || !isFinite(dbfs) || dbfs <= PISO_DBFS - 20) return "−∞";
    return (dbfs < 0 ? "−" : "") + Math.abs(dbfs).toFixed(1);
  }

  /** La línea de números debajo de la barra. */
  function textoNivel(n) {
    n = n || {};
    return fmt(n.dbfs) + " dBFS · pico " + fmt(n.picoDbfs) + " · compuerta " + fmt(n.umbralDbfs) +
      (n.pasa ? " · pasa" : " · no pasa") +
      (typeof n.segundos === "number" && typeof n.duracion === "number"
        ? " · " + Math.min(n.duracion, Math.round(n.segundos)) + "/" + n.duracion + " s"
        : "");
  }

  /**
   * Con qué color se lee cada veredicto. Verde solo cuando de verdad se puede
   * dictar; "floja" es amarillo porque hay señal y el arreglo es de volumen;
   * el resto es rojo porque el dictado no va a andar hasta que se toque algo.
   */
  function claseDeVeredicto(estado) {
    if (estado === "ok") return "is-ok";
    if (estado === "floja") return "is-warn";
    return "is-error";
  }

  /**
   * Arma el medidor adentro de `contenedor` (vacío al principio, oculto).
   * Devuelve { arrancar, mensaje, nivel, veredicto, limpiar }.
   */
  function crear(contenedor) {
    var raiz = document.createElement("div");
    raiz.className = "mic-meter";
    raiz.setAttribute("data-hidden", "true");
    var track = document.createElement("div");
    track.className = "mic-meter-track";
    var fill = document.createElement("div");
    fill.className = "mic-meter-fill";
    var gate = document.createElement("div");
    gate.className = "mic-meter-gate";
    gate.title = "La compuerta de silencio del dictado (−34 dBFS): lo que quede a la izquierda no se transcribe.";
    var peak = document.createElement("div");
    peak.className = "mic-meter-peak";
    track.appendChild(fill);
    track.appendChild(gate);
    track.appendChild(peak);
    var texto = document.createElement("div");
    texto.className = "mic-meter-text";
    var veredicto = document.createElement("div");
    veredicto.className = "mic-verdict";
    raiz.appendChild(track);
    raiz.appendChild(texto);
    raiz.appendChild(veredicto);
    if (contenedor) contenedor.appendChild(raiz);

    function mostrar() { raiz.setAttribute("data-hidden", "false"); }

    return {
      el: raiz,
      /** Arranca una prueba: barra en cero, veredicto borrado. */
      arrancar: function () {
        mostrar();
        fill.style.width = "0%";
        fill.className = "mic-meter-fill";
        peak.style.left = "0%";
        texto.textContent = "Abriendo el micrófono…";
        veredicto.textContent = "";
        veredicto.className = "mic-verdict";
      },
      /** La etapa (buscando, abriendo, escuchando), mientras no hay niveles. */
      mensaje: function (msg) { mostrar(); if (msg) texto.textContent = msg; },
      /** Una lectura del motor: { dbfs, picoDbfs, umbralDbfs, pasa, segundos, duracion }. */
      nivel: function (n) {
        n = n || {};
        mostrar();
        fill.style.width = porcentaje(n.dbfs) + "%";
        fill.className = "mic-meter-fill" + (n.pasa ? " is-ok" : "");
        gate.style.left = porcentaje(n.umbralDbfs) + "%";
        peak.style.left = porcentaje(n.picoDbfs) + "%";
        texto.textContent = textoNivel(n);
      },
      /** El resultado, tal como lo redactó el motor: { estado, titulo, detalle }. */
      veredicto: function (r) {
        r = r || {};
        mostrar();
        veredicto.textContent = "";
        var b = document.createElement("b");
        b.textContent = r.titulo || "La prueba terminó sin veredicto.";
        veredicto.appendChild(b);
        if (r.detalle) veredicto.appendChild(document.createTextNode(" " + r.detalle));
        veredicto.className = "mic-verdict " + claseDeVeredicto(r.estado);
      },
      limpiar: function () {
        raiz.setAttribute("data-hidden", "true");
        veredicto.textContent = "";
        texto.textContent = "";
      },
    };
  }

  global.HPMicMedidor = {
    crear: crear,
    // Expuestos para los tests: la geometría y el color, que es lo que se puede
    // fijar sin pantalla.
    _porcentaje: porcentaje,
    _textoNivel: textoNivel,
    _claseDeVeredicto: claseDeVeredicto,
    PISO_DBFS: PISO_DBFS,
  };
})(typeof window !== "undefined" ? window : this);
