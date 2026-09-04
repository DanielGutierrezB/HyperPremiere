/**
 * HPDictado — el botón de micrófono que va al lado de cada campo de prompt.
 *
 * Es UNO solo para los cuatro campos donde se escribe una instrucción: la de
 * cada marcador, las Indicaciones generales, el feedback de la Cola y el de
 * Corrections. Ninguno de los cuatro sabe nada del dictado más allá de una
 * línea: `caja.appendChild(HPDictado.attachMic(textarea, {…}).el)`.
 *
 * Por qué no vive en widgets.js
 * -----------------------------
 * Ahí iba a ir, y no entra. `widgets.js` dice de sí mismo, en su primera
 * línea, que son "widgets genéricos del panel, SIN lógica de negocio":
 * `makeCodeEditor` y `select` no le piden nada a nadie, devuelven
 * `{ el, getValue, setValue }` y se pueden usar en cualquier proyecto. Este
 * botón llama al motor por tres métodos distintos, decide cuándo pisar lo que
 * el editor escribió, acumula el gasto en el contador de la sesión y escribe en
 * el ⬇ Log. Meterlo ahí adentro sería romper la única regla que ese archivo
 * tiene. Lo que sí se copia es la FORMA: se devuelve `{ el, … }` y el que lo
 * llama decide dónde ponerlo, así ningún campo tiene que cambiar su layout.
 *
 * El ciclo, tal como lo ve el editor
 * ----------------------------------
 * Un clic arranca, otro para (no hay que mantener el botón apretado). Mientras
 * habla, el texto aparece de a frases. Al parar, un modelo chico lo convierte en
 * una instrucción clara, y queda a la vista un "↩ dictado crudo" para volver a
 * lo que dijo textual si el refinado no le gusta.
 *
 * Dos cosas que parecen detalles y no lo son:
 *   - Lo que el editor YA tenía escrito no se pisa nunca. El dictado se agrega
 *     abajo mientras habla, y al refinar las dos partes se mandan juntas como
 *     UNA idea (así lo pidió), no una atrás de la otra.
 *   - El texto en vivo se REESCRIBE ENTERO en cada refresco, no se agrega al
 *     final. Es la consecuencia de que el motor retranscriba el buffer completo
 *     cada vez, que es lo que hace que la frase se auto-corrija sola.
 *   - Mientras se habla, el campo CRECE con lo que se va diciendo, hasta un tope
 *     atado al alto del panel. El tope no es cosmético: lo que hay debajo del
 *     campo es el botón para parar, y un campo que lo empuja fuera de la vista
 *     deja al editor dictando sin poder frenar. Ver `altoDelCampo`.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPDictado.
 */
(function (global) {
  "use strict";

  var hpLog = HPLog.log;

  // Un micrófono, un dictado. Si hay dos campos con el botón prendido, el
  // motor rechaza el segundo; acá se evita antes para no mostrar un error que
  // el editor no provocó.
  var enCurso = null;

  // Lo que contestó el motor sobre esta máquina. Se pide UNA vez: ni el sistema
  // operativo ni Whisper aparecen a mitad de sesión. La promesa se comparte
  // entre todos los botones, así diez tarjetas de marcador no hacen diez
  // consultas.
  var estadoMaquina = null;
  function pedirEstado() {
    if (!estadoMaquina) {
      estadoMaquina = HPEngine.call("dictadoEstado").catch(function (e) {
        return { ok: false, disponible: false, motivo: "No pude preguntarle al motor si se puede dictar: " + ((e && e.message) || e) };
      });
    }
    return estadoMaquina;
  }

  // ---------------------------------------------------------------------
  // Lógica pura (lo que se prueba sin micrófono, sin motor y sin layout)
  // ---------------------------------------------------------------------

  /**
   * El texto del campo SIN refinar: lo que ya estaba escrito más lo dictado.
   *
   * Es a lo que vuelve el "↩ dictado crudo", así que con el campo vacío tiene
   * que devolver EXACTAMENTE lo que se dictó, sin agregarle nada.
   */
  function textoSinRefinar(previo, crudo) {
    var a = String(previo == null ? "" : previo).trim();
    var b = String(crudo == null ? "" : crudo).trim();
    if (!a) return b;
    if (!b) return a;
    return a + "\n" + b;
  }

  /**
   * Lo que se ve en el campo MIENTRAS habla. Lo suyo arriba, intacto; el
   * dictado abajo, que es la parte que se reescribe entera en cada refresco.
   */
  function textoEnVivo(previo, parcial) {
    return textoSinRefinar(previo, parcial);
  }

  /**
   * Qué micrófono se va a abrir, en una frase para el tooltip y la línea de
   * estado. `m` es lo que resolvió el motor: { nombre, indice, origen, elegido,
   * aviso }. Se dice DE DÓNDE salió: con una interfaz, unos auriculares y una
   * webcam enchufados, "el micrófono" no dice nada; y si el elegido no está y
   * se cayó a otro, eso es lo primero que hay que ver.
   */
  function textoDeMicrofono(m) {
    if (!m || !m.nombre) return "";
    if (m.origen === "caida") {
      return "⚠ El micrófono elegido («" + (m.elegido || "?") + "») no está conectado: uso «" + m.nombre + "», el del sistema.";
    }
    if (m.origen === "elegido") return "Micrófono: «" + m.nombre + "» (elegido en ⚙).";
    if (m.origen === "error" || m.origen === "sin-dispositivos") return "⚠ " + (m.aviso || "No pude averiguar qué micrófono hay.");
    return "Micrófono: «" + m.nombre + "», el que macOS tiene por defecto (todavía no elegiste uno; se elige en ⚙).";
  }

  // Cuánto del panel puede ocupar el campo mientras se dicta. Va como FRACCIÓN
  // y no como número de píxeles porque el panel es redimensionable: el manifest
  // lo abre en 400×600, con mínimo 320×400 y máximo 2200×2200. Un tope fijo de
  // 260 px es cómodo en un panel de 900 de alto y se come entero uno de 400.
  var FRACCION_PANEL = 0.45;
  // Y con un techo duro arriba: en un panel alto, un campo de 900 px no se lee
  // mejor: solo aleja el ■ de parar del texto que se está mirando.
  var TOPE_ABSOLUTO = 320;
  // Lo que se le deja SIEMPRE a lo de abajo: la barra del micrófono con su línea
  // de estado (que en el panel angosto envuelve a dos renglones) más el aire de
  // la tarjeta. Es la reserva que mantiene el ■ apretable, que es la condición
  // que manda sobre todas las demás: un campo que crece y empuja el botón fuera
  // de la vista deja al editor dictando sin poder frenar.
  var RESERVA_BARRA = 96;

  /**
   * Cuánto tiene que medir el campo mientras se dicta, y si le toca scroll.
   *
   * Es LA decisión de esta parte y no necesita DOM, así que va acá y se prueba
   * sin navegador. Lo que sí necesita DOM —medir el texto suelto y el panel—
   * entra por parámetro.
   *
   * El orden de prioridades, de más fuerte a más débil:
   *   1. el botón tiene que entrar         → nunca se pasa de `altoPanel - reserva`
   *   2. el campo no se come el panel      → ni de `altoPanel * FRACCION_PANEL`
   *   3. ni crece de gusto en uno alto     → ni de TOPE_ABSOLUTO
   *   4. y no queda más chico que en reposo, salvo que eso rompa la 1.
   *
   * @param {{contenido:number, altoPanel:number, minimo:number, reserva?:number}} o
   *   `contenido` — cuánto mide el texto suelto (el scrollHeight del textarea).
   *   `altoPanel` — el alto del panel entero (window.innerHeight).
   *   `minimo`    — el alto que tenía el campo en reposo: dictar no lo achica.
   *   `reserva`   — lo que hay que dejarle a la barra del micrófono debajo.
   * @returns {{alto:number, scroll:boolean, tope:number}}
   */
  function altoDelCampo(o) {
    o = o || {};
    var contenido = Math.max(0, Math.round(Number(o.contenido) || 0));
    var altoPanel = Math.max(0, Math.round(Number(o.altoPanel) || 0));
    var minimo = Math.max(0, Math.round(Number(o.minimo) || 0));
    var reserva = o.reserva == null ? RESERVA_BARRA : Math.max(0, Math.round(Number(o.reserva) || 0));

    var tope = Math.min(Math.round(altoPanel * FRACCION_PANEL), TOPE_ABSOLUTO, altoPanel - reserva);
    if (tope < 0) tope = 0;
    // `minimo` empuja para arriba y `tope` corta después: en un panel tan bajo
    // que ni el campo en reposo entra con el botón, gana el botón. Con el mínimo
    // del manifest (400 de alto) eso no pasa —el tope ahí es 180 px— pero la
    // cuenta tiene que quedar del lado seguro igual, porque es la única que
    // sostiene el invariante `alto + reserva <= altoPanel`.
    var alto = Math.min(Math.max(contenido, minimo), tope);
    return { alto: alto, scroll: contenido > alto, tope: tope };
  }

  /**
   * Cómo se dibuja el botón en cada estado. Función pura para poder fijar por
   * test lo que de otro modo habría que mirar a ojo: sobre todo que en Windows
   * NO se esconda —que se vea que la función existe— sino que quede apagado
   * DICIENDO por qué.
   *
   * @param {string} estado - averiguando | no-disponible | listo | preparando |
   *                          escuchando | refinando
   * @param {object} [datos] - { motivo, refinador, sinRefinador, faltaBajarModelo, segundos, microfono }
   * @returns {{texto:string, titulo:string, apagado:boolean, clase:string}}
   */
  function pintarBoton(estado, datos) {
    var d = datos || {};
    if (estado === "averiguando") {
      return { texto: "🎙", titulo: "Averiguando si se puede dictar en esta máquina…", apagado: true, clase: "" };
    }
    if (estado === "no-disponible") {
      return {
        texto: "🎙",
        // El motivo va entero en el tooltip: es lo único que le dice al editor
        // por qué el botón está apagado y qué haría falta para prenderlo.
        titulo: "Dictado por voz no disponible. " + (d.motivo || "No se pudo averiguar por qué."),
        apagado: true,
        clase: "is-off",
      };
    }
    if (estado === "preparando") {
      return {
        texto: "…",
        titulo: d.faltaBajarModelo
          ? "Bajando el modelo de dictado (~480 MB). Es una sola vez; después arranca en un segundo."
          : "Preparando el dictado…",
        apagado: true, clase: "is-busy",
      };
    }
    if (estado === "escuchando") {
      return {
        texto: "■",
        titulo: "Escuchando" + (d.segundos ? " (" + Math.round(d.segundos) + " s)" : "") + ". Tocá para parar y refinar.",
        apagado: false, clase: "is-rec",
      };
    }
    if (estado === "refinando") {
      return {
        texto: "…",
        titulo: "Refinando el dictado con " + (d.refinador || "el modelo") + "…",
        apagado: true, clase: "is-busy",
      };
    }
    var mic = textoDeMicrofono(d.microfono);
    return {
      texto: "🎙",
      titulo: "Dictar por voz. Un clic arranca, otro para. Al parar, " +
        (d.sinRefinador
          ? "el texto queda como lo dictaste: no hay refinador en esta máquina (" + d.sinRefinador + ")."
          : (d.refinador || "un modelo chico") + " lo deja como una instrucción clara, y podés volver al dictado crudo.") +
        (mic ? " " + mic : ""),
      apagado: false, clase: "",
    };
  }

  /**
   * La línea de estado de abajo del botón. Vive acá y no pegada al DOM porque
   * es lo que el editor lee cuando algo sale mal, y tiene que poder probarse.
   *
   * @param {{fase:string, segundos?:number, refinador?:string, ms?:number, aviso?:string, error?:string, microfono?:object}} s
   */
  function lineaDeEstado(s) {
    s = s || {};
    if (s.error) return { texto: s.error, clase: "is-error" };
    if (s.fase === "escuchando") {
      // Con qué micrófono, a la vista mientras escucha: es el momento en que el
      // editor se da cuenta de que le está hablando al equivocado.
      var m = s.microfono || {};
      var por = m.nombre
        ? " por «" + m.nombre + "»" + (m.origen === "caida" ? " (el elegido, «" + (m.elegido || "?") + "», no está conectado)" : "")
        : "";
      return {
        texto: "Escuchando" + por + "… " + Math.round(s.segundos || 0) + " s. El texto va unos segundos atrás de lo que hablás; " +
          "cuando pares se pone al día.",
        clase: m.origen === "caida" ? "is-warn" : "",
      };
    }
    if (s.fase === "refinando") {
      return { texto: "Refinando con " + (s.refinador || "el modelo") + "… " + Math.round(s.segundos || 0) + " s", clase: "" };
    }
    if (s.fase === "refinado") {
      return {
        texto: "Refinado con " + (s.refinador || "el modelo") +
          (s.ms ? " en " + (s.ms / 1000).toFixed(1) + " s" : "") + ".",
        clase: "is-ok",
      };
    }
    if (s.fase === "sin-refinar") {
      return { texto: s.aviso || "Quedó el dictado sin refinar.", clase: "is-warn" };
    }
    return { texto: "", clase: "" };
  }

  // ---------------------------------------------------------------------
  // El botón
  // ---------------------------------------------------------------------

  /**
   * Cuelga un micrófono de un textarea. Devuelve `{ el }`: la barra con el
   * botón y su línea de estado, que el que llama inserta donde le quede bien.
   * No toca el layout del campo ni lo envuelve en nada.
   *
   * @param {HTMLTextAreaElement} ta
   * @param {{id:string, onChange?:function}} opts
   *   `id`      — identifica el campo (el motor no deja dos dictados a la vez).
   *   `onChange`— se llama cada vez que el widget escribe en el campo, para que
   *               el que llama persista como ya lo hace (HPStore, el borrador
   *               de la Cola, lo que sea). Sin esto, un dictado se pierde al
   *               cambiar de pestaña.
   */
  function attachMic(ta, opts) {
    opts = opts || {};
    var id = String(opts.id || "campo");
    var avisar = typeof opts.onChange === "function" ? opts.onChange : function () {};

    var bar = document.createElement("div");
    bar.className = "mic-bar";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mic-btn";
    var linea = document.createElement("span");
    linea.className = "mic-state";
    var volver = document.createElement("button");
    volver.type = "button";
    volver.className = "mic-undo";
    volver.setAttribute("data-hidden", "true");
    bar.appendChild(btn);
    bar.appendChild(linea);
    bar.appendChild(volver);

    var fase = "averiguando";
    var info = {};
    var previo = "";       // lo que el editor tenía escrito al arrancar
    var crudo = "";        // lo dictado, textual
    var refinado = "";     // lo que devolvió el refinador
    var viendoCrudo = false;
    var reloj = null;
    var t0 = 0;
    // El micrófono que el motor dijo que abrió en ESTE dictado. Manda sobre el
    // del estado general, que se pidió una vez al abrir el panel y puede haber
    // quedado viejo si el editor cambió de micrófono en ⚙ después.
    var micActual = null;

    function pintar(extra) {
      var p = pintarBoton(fase, {
        motivo: info.motivo, refinador: info.refinador, sinRefinador: info.sinRefinador,
        faltaBajarModelo: info.faltaBajarModelo, segundos: (extra && extra.segundos) || 0,
        microfono: micActual || info.microfono,
      });
      btn.textContent = p.texto;
      btn.disabled = p.apagado;
      btn.title = p.titulo;
      btn.className = "mic-btn" + (p.clase ? " " + p.clase : "");
      var l = lineaDeEstado(Object.assign({ fase: fase, microfono: micActual || info.microfono }, extra || {}));
      linea.textContent = l.texto;
      linea.className = "mic-state" + (l.clase ? " " + l.clase : "");
    }

    function escribir(texto) {
      ta.value = texto;
      avisar(texto);
    }

    // ── El campo, mientras se dicta ──────────────────────────────────
    //
    // El alto que tenía el campo antes de empezar. Se toma al arrancar y no al
    // colgar el botón porque `attachMic` corre ANTES de que el campo esté en el
    // documento (el que llama inserta la barra después), y ahí no mide nada.
    var altoBase = 0;

    /** Sube `el` al viewport solo si hace falta. Sin animación: se va a rehacer. */
    function traer(el) {
      try { if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" }); } catch (e) {}
    }

    /**
     * Despliega lo que tenga al campo tapado. Los contenedores que se pliegan en
     * este panel son `<details>` —la tarjeta de cada marcador, "Preparación", el
     * prompt general—, así que se usa ESE mecanismo, el mismo que mueve el
     * acordeón de main.js, y no una clase nueva que habría que mantener al día.
     */
    function desplegar() {
      var n = ta.parentNode;
      for (var i = 0; n && i < 24; i++) {
        if (String(n.tagName || "").toUpperCase() === "DETAILS" && n.open === false) {
          try { n.open = true; } catch (e) {}
        }
        n = n.parentNode;
      }
    }

    /**
     * Mide el campo, le pide el alto a `altoDelCampo` y lo aplica.
     *
     * El `height:auto` de antes de medir es lo que deja que el campo también
     * ACHIQUE: sin eso, `scrollHeight` nunca baja del alto que ya tiene puesto y
     * un refinado más corto que el dictado dejaría el campo estirado. Va en el
     * mismo turno que la medición, así que no se pinta el estado intermedio.
     */
    function acomodarCampo() {
      if (!ta || !ta.style || typeof ta.scrollHeight !== "number") return null;
      var panel = Number(global.innerHeight) || 0;
      if (!panel) return null;
      ta.style.height = "auto";
      // Todo el panel es `box-sizing: border-box` y `scrollHeight` no cuenta el
      // borde: sin sumarlo el campo queda dos píxeles corto y muestra una barra
      // de scroll que no hace falta.
      var borde = Math.max(0, (ta.offsetHeight || 0) - (ta.clientHeight || 0));
      var r = altoDelCampo({ contenido: (ta.scrollHeight || 0) + borde, altoPanel: panel, minimo: altoBase });
      ta.style.height = r.alto + "px";
      ta.style.overflowY = r.scroll ? "auto" : "hidden";
      return r;
    }

    /**
     * Lo que se hace en cada refresco del texto en vivo: crecer, dejar el FINAL
     * a la vista y comprobar que el botón sigue alcanzable.
     *
     * Lo del final no pasa solo. Mientras se habla el texto se REESCRIBE ENTERO
     * en cada refresco (el motor retranscribe el buffer completo, ver la
     * cabecera), no se agrega al final, así que el navegador no tiene ningún
     * "estaba abajo" que conservar: hay que volver a bajarlo cada vez. Se hace
     * en el mismo turno en que se escribe el valor y sin timers ni animación, o
     * sea que el navegador pinta una sola vez y no se ve el salto.
     */
    function seguirElTexto() {
      acomodarCampo();
      try { ta.scrollTop = ta.scrollHeight; } catch (e) {}
      traer(bar);
    }

    /**
     * Al terminar: el campo queda del alto que pide lo que quedó escrito —ni
     * estirado si quedó una línea, ni apretado si quedó un párrafo— y se le
     * devuelve el scroll normal, que es el que va a querer el que siga
     * escribiendo a mano.
     */
    function asentarCampo() {
      var r = acomodarCampo();
      if (r) ta.style.overflowY = "";
      traer(bar);
    }

    function mostrarVolver(hay) {
      volver.setAttribute("data-hidden", hay ? "false" : "true");
      volver.textContent = viendoCrudo ? "↪ volver al refinado" : "↩ dictado crudo";
      volver.title = viendoCrudo
        ? "Vuelve al texto que dejó el refinador."
        : "Deja en el campo exactamente lo que dictaste, sin refinar.";
    }

    volver.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      viendoCrudo = !viendoCrudo;
      escribir(viendoCrudo ? textoSinRefinar(previo, crudo) : refinado);
      asentarCampo(); // el crudo casi siempre es más largo que el refinado
      mostrarVolver(true);
    });

    pedirEstado().then(function (st) {
      info = st || {};
      fase = info.disponible ? "listo" : "no-disponible";
      pintar();
    });

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (fase === "escuchando") { parar(); return; }
      if (fase !== "listo") return;
      arrancar();
    });

    function parar() {
      HPEngine.call("dictadoParar", { id: id }).catch(function () {});
    }

    function arrancar() {
      if (enCurso) {
        pintar({ error: "Ya hay un dictado andando en otro campo. Pará ése primero: hay un solo micrófono." });
        return;
      }
      enCurso = id;
      previo = ta.value;
      crudo = "";
      refinado = "";
      viendoCrudo = false;
      mostrarVolver(false);
      fase = "preparando";
      pintar();

      // El campo, a la vista, antes de la primera frase. Si la tarjeta estaba
      // plegada o el scroll del panel lo dejó afuera, el editor no ve nada de lo
      // que va diciendo y encima pierde de vista el botón para parar. Se mide el
      // alto de reposo recién acá, ya desplegado: adentro de un `<details>`
      // cerrado el campo no mide nada.
      desplegar();
      altoBase = ta.offsetHeight || 0;
      traer(ta);
      traer(bar);

      t0 = Date.now();
      clearInterval(reloj);
      reloj = setInterval(function () {
        if (fase === "escuchando" || fase === "refinando") pintar({ segundos: (Date.now() - t0) / 1000 });
      }, 1000);

      micActual = null;
      HPEngine.callProg("dictadoArrancar", { id: id }, function (p) {
        if (!p) return;
        if (p.note) hpLog(p.note, p.level || "INFO");
        if (p.microfono) micActual = p.microfono;
        if (p.dictado && p.dictado.id === id) {
          escribir(textoEnVivo(previo, p.dictado.texto));
          seguirElTexto();
        }
        // En qué etapa está lo dice el MOTOR, en `p.fase` (ver el sobre en
        // engine-client.js). Antes se deducía con un regex sobre la palabra
        // "Escuchando" del mensaje: cualquiera que reescribiera esa frase —o la
        // tradujera— dejaba el botón en "…" para siempre, y el editor sin forma
        // de frenar un micrófono abierto.
        //
        // Al pasar a "escuchando" la línea de estado se llena, y en el panel
        // angosto eso son dos renglones más que empujan el botón para abajo.
        // Medido en la maqueta a 400 px de alto: sin este reajuste el ■ queda
        // 2 px cortado hasta que llega la primera frase.
        if (p.fase === "escuchando" && fase !== "escuchando") {
          fase = "escuchando"; t0 = Date.now(); pintar({ segundos: 0 }); traer(bar);
        }
        // Mientras prepara, el mensaje del motor manda sobre el nuestro: la
        // primera vez avisa que está bajando 480 MB, que es la diferencia entre
        // "tarda" y "se colgó". Y al cortar por el tope, también: ahí se dice
        // por qué se cortó solo.
        if (p.msg && (fase === "preparando" || p.fase === "cortando")) {
          linea.textContent = p.msg;
          linea.className = "mic-state";
        }
      }).then(function (r) {
        clearInterval(reloj);
        enCurso = null;
        if (!r || !r.ok) {
          fase = "listo";
          escribir(previo); // no dejarle a medias lo que el motor no pudo transcribir
          asentarCampo();   // y que el campo vuelva al alto de eso, no al del dictado que se perdió
          pintar({ error: (r && r.error) || "El dictado no devolvió nada." });
          hpLog("Dictado (" + id + "): " + ((r && r.error) || "sin resultado"), "WARN");
          return;
        }
        crudo = r.crudo || "";
        // El crudo entra al campo YA, antes de refinar: si el refinador tarda
        // nueve segundos o se cae, el editor tiene su dictado igual.
        escribir(textoSinRefinar(previo, crudo));
        asentarCampo();
        refinar();
      }).catch(function (e) {
        clearInterval(reloj);
        enCurso = null;
        fase = "listo";
        pintar({ error: "El dictado se cayó: " + ((e && e.message) || e) });
      });
    }

    function refinar() {
      fase = "refinando";
      t0 = Date.now();
      clearInterval(reloj);
      reloj = setInterval(function () { pintar({ segundos: (Date.now() - t0) / 1000, refinador: info.refinador }); }, 1000);
      pintar({ segundos: 0, refinador: info.refinador });

      HPEngine.call("dictadoRefinar", { crudo: crudo, previo: previo }).then(function (r) {
        clearInterval(reloj);
        fase = "listo";
        r = r || {};
        // El gasto del refinado va al contador de la sesión APARTE del de las
        // animaciones: son dos cosas distintas y mezclarlas haría ilegible el
        // número que el editor mira para saber cuánto le costó una clase.
        if (r.usage) HPStore.addDictadoUsage(r.usage);
        if (r.ok) {
          refinado = r.texto;
          escribir(refinado);
          asentarCampo();
          mostrarVolver(true);
          mostrarFase("refinado", { refinador: r.refinador, ms: r.ms });
          hpLog("Dictado (" + id + "): refinado con " + r.refinador + " en " + (r.ms / 1000).toFixed(2) + " s.");
          return;
        }
        // No se pudo refinar. El campo se queda con el dictado —que es útil— y
        // se dice por qué, que es lo que evita que parezca que no hizo nada.
        refinado = textoSinRefinar(previo, crudo);
        escribir(refinado);
        asentarCampo();
        mostrarFase("sin-refinar", { aviso: r.aviso });
        hpLog("Dictado (" + id + "): " + (r.aviso || "no se pudo refinar"), "WARN");
      }).catch(function (e) {
        clearInterval(reloj);
        fase = "listo";
        refinado = textoSinRefinar(previo, crudo);
        mostrarFase("sin-refinar", { aviso: "El refinado falló: " + ((e && e.message) || e) + ". Queda el dictado como salió." });
      });
    }

    // La línea de resultado sobrevive al botón volviendo a "listo": el editor
    // tiene que poder leer con qué se refinó después de que terminó.
    function mostrarFase(f, extra) {
      var l = lineaDeEstado(Object.assign({ fase: f }, extra || {}));
      linea.textContent = l.texto;
      linea.className = "mic-state" + (l.clase ? " " + l.clase : "");
      var p = pintarBoton("listo", info);
      btn.textContent = p.texto; btn.disabled = false; btn.title = p.titulo; btn.className = "mic-btn";
    }

    pintar();
    return { el: bar, boton: btn, _pintar: pintar };
  }

  // Lo que se sabe de la máquina se pide una vez… salvo que cambie algo que
  // está en esa respuesta. Elegir otro micrófono en ⚙ es exactamente eso: los
  // botones que se dibujen de ahí en más tienen que decir el nuevo. (Los que ya
  // están dibujados se enteran igual al dictar: el motor dice cuál abrió.)
  function olvidarEstado() { estadoMaquina = null; }

  global.HPDictado = {
    attachMic: attachMic,
    olvidarEstado: olvidarEstado,
    // Expuestos para los tests: son las decisiones puras de este archivo.
    _textoSinRefinar: textoSinRefinar,
    _textoEnVivo: textoEnVivo,
    _pintarBoton: pintarBoton,
    _altoDelCampo: altoDelCampo,
    _lineaDeEstado: lineaDeEstado,
    _textoDeMicrofono: textoDeMicrofono,
    _olvidarEstado: function () { estadoMaquina = null; enCurso = null; },
  };
})(typeof window !== "undefined" ? window : this);
