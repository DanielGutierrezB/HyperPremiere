/**
 * HPUtil — helpers puros del panel (sin DOM, sin estado).
 * Vanilla JS, sin ES modules: se expone como window.HPUtil.
 */
(function (global) {
  "use strict";

  /** Debounce clásico: pospone fn hasta `delay` ms después de la última llamada. */
  function debounce(fn, delay) {
    var timer = null;
    return function () {
      var args = arguments;
      var self = this;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        fn.apply(self, args);
      }, delay);
    };
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** Segundos → "mm:ss" (para timecodes de marcadores). */
  function formatTime(seconds) {
    var total = Math.floor(seconds);
    var mm = Math.floor(total / 60);
    var ss = total % 60;
    return (mm < 10 ? "0" + mm : mm) + ":" + (ss < 10 ? "0" + ss : ss);
  }

  /**
   * TODO lo que hay que saber de un estado para dibujarlo: la palabra, el color,
   * el tooltip, y las tres preguntas que dirigen el dibujo.
   *
   * ── Por qué existe, y por qué existe UNA sola vez ────────────────────
   *
   * El mismo trabajo se muestra en dos pestañas: en la fila de la Cola y en la
   * ficha de su marcador. Hasta la 1.6.0 cada una lo decía a su manera —la Cola
   * pintando el título de verde/rojo/azul/ámbar/gris, que es color y nada más
   * (WCAG 1.4.1) y obligaba a leer cada nombre para sacar el estado; la ficha con
   * un glifo de 14 px (✓ ⏳ … ⚠)—. Dos redacciones del mismo dato envejecen
   * distinto, y ya habían envejecido: "⏳" quería decir «está corriendo» en la
   * ficha y «se quedó sin tokens» en la Cola.
   *
   * Ahora las dos piden la palabra acá. Y está en HPUtil y no en HPQueue —que es
   * la dueña de la máquina de estados— porque esto no decide nada: es cómo se
   * ESCRIBE un estado. Lo que sí es de la cola, «este terminó pero el clip no
   * entró», se lo pregunta la vista a `HPQueue.needsPlacing` y se lo pasa.
   *
   * ── Y por qué contesta además `activo`, `pendiente` y `terminado` ────
   *
   * Porque la primera versión se quedó a mitad de camino: centralizó la palabra y
   * el color, y dejó afuera las preguntas que dirigen el DIBUJO. ¿La fila se abre?
   * ¿El detalle va arriba o abajo? ¿El reloj cuenta o dice cuánto tardó? ¿La plata
   * va en el encabezado? ¿Los botones de la ficha quedan apagados? Eran veintiséis
   * interrogaciones al estado sueltas en literales de string, y `status === "done"`
   * se preguntaba seis veces bajo cuatro nombres distintos a diez líneas de
   * distancia: dos vocabularios para el mismo hecho, y el segundo sin dueño.
   *
   * Y ya habían divergido: la ficha del marcador se escribía a mano su propia
   * lista («queued», «modeling», «ready», «running») en vez de preguntarle a
   * HPQueue, o sea dos pestañas pintando el mismo trabajo con dos listas
   * mantenidas por separado.
   *
   * Los tres se le preguntan a HPQueue, que es la que se declara «un solo dueño»
   * del vocabulario de estados (ver `isActive` en cep/js/queue.js). Esto sigue sin
   * decidir nada: los trae junto con la palabra para que el que dibuja pregunte
   * UNA vez. Que las dos respuestas no puedan separarse lo fija el test que las
   * compara estado por estado (`tres-listas-una-gramatica`).
   *
   * `palabra` es corta a propósito: vive en el encabezado plegado, que a 320 px
   * ya envuelve, y la frase entera está en el mensaje de la fila justo debajo.
   * Lo que no puede pasar es que el estado sea sólo un color.
   *
   * `clase` es el vocabulario de la guarda izquierda (ver la sección 9 del CSS) y
   * es de CINCO, no de siete: lo que cambia de color es qué PIDE el estado, no en
   * qué etapa del pipeline está. Modelar y renderizar son dos etapas y un solo
   * «está pasando ahora».
   */
  function estadoDeTrabajo(status, sinColocar) {
    var e = comoSeEscribe(status, sinColocar);
    e.activo = HPQueue.isActive(status);
    e.pendiente = HPQueue.isPending(status);
    e.terminado = status === "done";
    return e;
  }

  /** La palabra, el color y el tooltip de cada estado. */
  function comoSeEscribe(status, sinColocar) {
    if (status === "done") {
      // Terminado NO quiere decir que salió bien: el render puede estar hecho y
      // el clip afuera del timeline, y esa fila llevaba la misma guarda verde que
      // la que terminó bien (está escrito en el CSS de `.qj-msg`, que por eso no
      // podía pintar el mensaje de color).
      if (sinColocar) {
        return { clase: "es-atencion", palabra: "sin colocar",
          titulo: "El render está hecho y el clip NO entró al timeline: falta colocarlo." };
      }
      return { clase: "es-listo", palabra: "listo", titulo: "Terminado y colocado." };
    }
    if (status === "error") {
      return { clase: "es-falla", palabra: "falló",
        titulo: "Se cayó: mirá el mensaje y probá «Reintentar»." };
    }
    if (status === "waiting") {
      return { clase: "es-atencion", palabra: "sin cupo",
        titulo: "Se quedó sin tokens. Cuando se reinicie tu uso, «Reactivar»." };
    }
    if (status === "modeling") {
      return { clase: "es-andando", palabra: "diseñando",
        titulo: "El modelo está diseñando la animación." };
    }
    if (status === "running") {
      return { clase: "es-andando", palabra: "rindiendo",
        titulo: "Se está renderizando el video." };
    }
    if (status === "ready") {
      return { clase: "es-quieto", palabra: "por rendir",
        titulo: "El diseño ya está: espera su carril de render." };
    }
    return { clase: "es-quieto", palabra: "en cola",
      titulo: "En espera de que la cola lo tome." };
  }

  /** Duración legible: "45s" o "1m 12s". */
  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m ? (m + "m " + (s < 10 ? "0" : "") + s + "s") : (s + "s");
  }

  /** Número con separador de miles (1234 -> "1.234"). */
  function addThousands(n) {
    n = Math.round(Number(n) || 0);
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  /**
   * Compacto para etiquetas cortas (1234 -> "1,2k"; 3412905 -> "3,4M").
   *
   * El escalón de millones hace falta desde que la entrada se cuenta completa:
   * una tanda de clases pasa los tres millones de tokens y "3.412.905" no cabe
   * en una línea del panel.
   */
  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace(".", ",") + "M";
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(".", ",") + "k";
    return String(n);
  }

  /**
   * El contador de uso de la sesión: la línea corta que se ve y el detalle que
   * va en el tooltip. Devuelve { line, detail }.
   *
   * Vive acá y no en main.js porque cada número tiene una trampa y las tres se
   * prueban (test/contador-uso.test.js):
   *
   *   - La ENTRADA es la suma de lo suelto más la caché leída más la escrita.
   *     El campo `inputTokens` de los CLI de agente es solo el pedazo que no
   *     estaba cacheado: un prompt de 20 caracteres reporta 2 de entrada y
   *     31.823 escritos a caché. Mostrando solo el primero, una sesión de 164
   *     generaciones marcaba 75.256 de entrada contra 2,3 M de salida.
   *   - Cuánto de eso es CACHÉ va a la vista, porque es lo que explica que la
   *     entrada real sea diez veces el prompt que armamos: es el contexto del
   *     propio agente, releído en cada llamada.
   *   - El COSTO no lo informan todos los proveedores (Cursor va por suscripción;
   *     la API de Anthropic no lo devuelve en el body), así que se dice sobre
   *     cuántas generaciones se juntó. Un "$15.37" pelado se lee como el costo de
   *     la sesión entera cuando en realidad cubre doce de ciento sesenta y cuatro.
   */
  /**
   * El gasto del DICTADO, que se muestra aparte del de las animaciones.
   *
   * Se dice al final de la línea y con su propia palabra ("dictado"), no sumado
   * al total: un refinado son unos cientos de tokens y una generación son
   * decenas de miles, así que mezclarlos hace que el promedio por generación
   * deje de querer decir nada. Y encima pueden venir de proveedores distintos:
   * el dictado elige el suyo.
   *
   * Devuelve { corta, larga } — vacías si todavía no se dictó nada.
   */
  function dictadoUsage(d) {
    if (!d || !d.refinados) return { corta: '', larga: '' };
    var entrada = (d.inputTokens || 0) + (d.cacheReadTokens || 0) + (d.cacheCreationTokens || 0);
    var corta = 'dictado: ' + d.refinados + (d.refinados === 1 ? ' refinado' : ' refinados');
    if (d.costUsd > 0) corta += ' · $' + d.costUsd.toFixed(2);
    var larga = '\nDictado (aparte, no entra en los números de arriba): ' +
      d.refinados + (d.refinados === 1 ? ' refinado' : ' refinados') + ' · ' +
      addThousands(entrada) + ' tokens de entrada · ' + addThousands(d.outputTokens || 0) + ' de salida';
    if (d.costUsd > 0) {
      larga += ' · $' + d.costUsd.toFixed(2) + ' informado por ' + d.costRefinados + ' de ' + d.refinados;
    } else {
      larga += ' · sin costo informado (refinador local o proveedor que no lo devuelve)';
    }
    larga += '.';
    return { corta: corta, larga: larga };
  }

  function sessionUsage(u) {
    var dic = dictadoUsage(u && u.dictado);
    if (!u || !u.generations) {
      // Se puede haber dictado sin haber generado nada todavía, y ese gasto
      // existe igual: decir "sin generaciones" y esconderlo sería perderlo.
      return {
        line: dic.corta || 'sin generaciones todavía',
        detail: 'Uso acumulado en esta sesión' + dic.larga,
        // El monto es lo único que queda en el encabezado (el detalle vive en
        // ⚙). Sin generaciones no hay costo informado, así que va vacío y la
        // pastilla no se dibuja.
        monto: '',
      };
    }
    var cache = (u.cacheReadTokens || 0) + (u.cacheCreationTokens || 0);
    var entrada = (u.inputTokens || 0) + cache;
    var gens = u.generations;

    var line = fmtTokens(entrada) + ' tokens de entrada' +
      (cache ? ' (' + fmtTokens(cache) + ' de caché)' : '') +
      ' · ' + fmtTokens(u.outputTokens || 0) + ' de salida';
    // El "en N de M" solo si sabemos N. Un acumulado de antes del arreglo tiene
    // dólares y ningún reparto: ahí decir "en 0 de 164" sería peor que callarse.
    var reparto = u.costGenerations > 0 && u.costGenerations < gens;
    if (u.costUsd > 0) {
      line += ' · $' + u.costUsd.toFixed(2) +
        (reparto ? ' en ' + u.costGenerations + ' de ' + gens : '');
    }
    line += ' · ' + gens + (gens === 1 ? ' generación' : ' generaciones');
    if (dic.corta) line += ' · ' + dic.corta;

    var detail = 'Entrada: ' + addThousands(entrada) + ' tokens = ' +
      addThousands(u.inputTokens || 0) + ' sin cachear + ' +
      addThousands(u.cacheReadTokens || 0) + ' leídos de caché + ' +
      addThousands(u.cacheCreationTokens || 0) + ' escritos a caché.';
    if (cache > (u.inputTokens || 0)) {
      detail += '\nCasi toda la entrada es caché: es el contexto que el agente vuelve a leer en cada llamada, ' +
        'no el prompt que armamos nosotros.';
    }
    detail += '\nSalida: ' + addThousands(u.outputTokens || 0) + ' tokens.' +
      '\nPor generación: ≈ ' + fmtTokens(Math.round(entrada / gens)) + ' de entrada · ≈ ' +
      fmtTokens(Math.round((u.outputTokens || 0) / gens)) + ' de salida.';
    if (u.costUsd > 0 && u.costGenerations > 0) {
      detail += '\nCosto: $' + u.costUsd.toFixed(2) + ' informado por ' + u.costGenerations +
        ' de ' + gens + ' generaciones (≈ $' + (u.costUsd / u.costGenerations).toFixed(2) + ' cada una).';
    }
    if (reparto) {
      detail += '\nLas demás no informan costo: Cursor va por suscripción y la API de Anthropic no lo devuelve.';
    }
    if (u.legacyMix) {
      detail += '\nOJO: parte de este acumulado se juntó cuando la entrada se contaba a medias ' +
        '(sin los tokens de caché), así que el total de entrada queda corto. ' +
        'Tocá "reiniciar" para empezar a medir limpio.';
    }
    detail += dic.larga;
    // El monto, solo: es lo que el encabezado muestra desde la v1.6.0 para no
    // perder el aviso de que estás gastando. Es EL MISMO número que la línea,
    // formateado igual, para que no puedan separarse nunca.
    return { line: line, detail: detail, monto: u.costUsd > 0 ? '$' + u.costUsd.toFixed(2) : '' };
  }

  // ── Cuánto le entra al modelo, y cuánto le metemos de verdad ──────────
  //
  // Son dos preguntas que el editor hace juntas cuando abre ⚙ ("¿cuánto de la
  // ventana estoy usando?") y que se contestan de fuentes distintas: la segunda
  // la medimos nosotros —el contador de la sesión—, la primera no la informa
  // nadie y hay que ponerla a mano.

  /**
   * Ventana de contexto por familia de Claude, en tokens.
   *
   * DE DÓNDE SALIÓ CADA NÚMERO, para poder auditarlo y actualizarlo:
   * de la documentación de Anthropic, "Context window sizes by model" y la
   * tabla de comparación de modelos, consultadas el 2026-09-03. Dicen que
   * tienen 1M de ventana Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus 5,
   * Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 5 y Sonnet 4.6; que el resto —Sonnet
   * 4.5, los Haiku— tiene 200k; y, textual, que "for every model with a
   * 1M-token context window, 1M is the default: you don't need a beta header".
   *
   * POR QUÉ ES UNA TABLA NUESTRA. Porque por donde el panel pregunta, no viene.
   * `cursor-agent --list-models` devuelve "<id> - <nombre>" y nada más, y de la
   * lista de Anthropic el motor lee `id` y `display_name` (ver listClaudeModels
   * en bridge/engine.js). La API sí ofrece `max_input_tokens`, y cuando llega
   * se le hace caso antes que a esta tabla — pero llega solo por ese camino.
   *
   * UNA FAMILIA QUE NO ESTÁ ACÁ NO MUESTRA NADA. Es a propósito: el editor va a
   * usar este número para decidir cuánto material le mete a una generación, así
   * que un default inventado es peor que un renglón vacío.
   *
   * VA A QUEDAR DESACTUALIZADA. Cada modelo nuevo entra al panel solo (la lista
   * se pide a la cuenta) pero acá hay que agregarlo a mano; hasta que alguien lo
   * haga, se lo ve sin ventana. Ese es el modo de fallar correcto.
   */
  var VENTANA_CLAUDE = {
    "claude-fable-5-1": 1000000,
    "claude-mythos-5-1": 1000000,
    "claude-fable-5": 1000000,
    "claude-mythos-5": 1000000,
    "claude-opus-5": 1000000,
    "claude-opus-4-8": 1000000,
    "claude-opus-4-7": 1000000,
    "claude-opus-4-6": 1000000,
    "claude-sonnet-5": 1000000,
    "claude-sonnet-4-6": 1000000,
    "claude-sonnet-4-5": 200000,
    "claude-haiku-4-5": 200000
  };

  // Lo único que se puede afirmar de cualquier Claude de la lista de arriba sin
  // saber por qué puerta entra: ninguno baja de 200k.
  var PISO_CLAUDE = 200000;

  /** Tamaños redondos de ventana: 1000000 → "1M", 200000 → "200k". */
  function fmtVentana(n) {
    n = Math.round(Number(n) || 0);
    var esc = n >= 1000000 ? [1000000, "M"] : (n >= 1000 ? [1000, "k"] : null);
    if (!esc) return String(n);
    var v = n / esc[0];
    return (v === Math.round(v) ? String(v) : v.toFixed(1).replace(".", ",")) + esc[1];
  }

  /**
   * Qué ventana de contexto corresponde, según MODELO + PROVEEDOR + CÓMO ESTÁS
   * AUTENTICADO. Devuelve null cuando no se sabe, que es la mitad del punto.
   *
   * La trampa que esto resuelve: el mismo Sonnet no tiene la misma ventana
   * según por dónde entres.
   *
   *   - Por CURSOR el dato lo da el propio proveedor: las variantes de 1M se
   *     llaman así en la lista que devuelve el CLI ("Claude Sonnet 5 1M
   *     Thinking"). Si el nombre no lo dice, Cursor no lo dice, y nosotros
   *     tampoco.
   *   - Por la API de Claude entrás a la ventana documentada, que para las
   *     familias de arriba es 1M sin ningún beta.
   *   - Por el CLI de Claude DEPENDE DE LA CREDENCIAL. Con una API key el CLI
   *     va por la API y vale lo mismo. Con la sesión de claude.ai o un token de
   *     suscripción, nadie nos dice qué ventana efectiva te toca: ni el CLI
   *     (`claude auth status` contesta con qué te autenticás, no cuánto te
   *     entra) ni la lista de modelos. Ahí se muestra el piso —200k, lo único
   *     seguro— marcado como piso, y NO se promete el 1M. Prometerlo es el
   *     error caro: el editor arma una generación de medio millón de tokens
   *     contra una ventana que no sabemos que tenga.
   *
   * @param {{provider:string, model:string, nombre?:string,
   *          autenticacion?:string, reportado?:number}} q
   *   `nombre` es el nombre para mostrar que devolvió el proveedor (de ahí sale
   *   el 1M de Cursor); `autenticacion` es el `authMethod` que contestó el CLI
   *   de Claude ('api_key' | 'claude.ai' | 'oauth_token' | '' si no se sabe);
   *   `reportado` es el `max_input_tokens` de la API cuando viene.
   * @returns {null | {tokens:number, texto:string, piso:boolean, largo:number}}
   *   `largo` es la ventana que ese modelo tiene por su mejor puerta. Cuando
   *   `piso` es true, es la que NO se está prometiendo, y el renglón la nombra
   *   en vez de decir "el 1M" a mano: el día que haya una familia de 500k, el
   *   texto sigue siendo cierto.
   */
  function ventanaDeContexto(q) {
    q = q || {};
    var provider = String(q.provider || "");

    if (provider === "cursor-cli") {
      if (!/\b1M\b/i.test(String(q.nombre || ""))) return null;
      return { tokens: 1000000, texto: "1M", piso: false, largo: 1000000 };
    }
    if (provider !== "claude-cli" && provider !== "claude-api") return null;

    // Los IDs actuales de Claude son sin fecha, pero los viejos traen el
    // snapshot pegado (claude-haiku-4-5-20251001) y es la misma familia.
    var familia = String(q.model || "").toLowerCase().replace(/-\d{8}$/, "");
    var largo = VENTANA_CLAUDE[familia];
    if (!largo) return null;

    var porLaApi = (provider === "claude-api") ||
      (provider === "claude-cli" && q.autenticacion === "api_key");
    if (porLaApi) {
      // Si la API dijo cuánto entra, le gana a la tabla: es el dato de la
      // cuenta de verdad y se actualiza solo.
      var rep = Number(q.reportado);
      var tokens = (isFinite(rep) && rep > 0) ? Math.round(rep) : largo;
      return { tokens: tokens, texto: fmtVentana(tokens), piso: false, largo: tokens };
    }
    // Suscripción, o todavía no sabemos con qué entra. Una familia que ya está
    // en el piso no tiene nada de ambiguo; una de 1M sí, y se dice.
    if (largo <= PISO_CLAUDE) return { tokens: largo, texto: fmtVentana(largo), piso: false, largo: largo };
    return { tokens: PISO_CLAUDE, texto: fmtVentana(PISO_CLAUDE) + "+", piso: true, largo: largo };
  }

  /**
   * Cuánta ENTRADA gasta una generación con este proveedor, según lo ya medido
   * en esta máquina. null si todavía no hay con qué contestar.
   *
   * Va por proveedor y no por modelo por dos razones: lo que domina la entrada
   * es de quién es la puerta (con Cursor cada llamada arrastra ~31,8k de
   * contexto del propio agente, con Claude directo no), y en Cursor el ID del
   * modelo cambia con el nivel de pensamiento, así que por modelo la muestra se
   * partiría en pedazos de una o dos generaciones.
   *
   * Los bolsillos por proveedor solo existen desde que la entrada se cuenta
   * entera: un acumulado viejo no tiene ninguno, así que no puede ensuciar este
   * promedio — contesta "todavía no" hasta que haya generaciones nuevas. Quién
   * decide si un bolsillo cuenta es HPStore al leerlo (mira `regla`, igual que
   * mira `rule` en el total); acá no se repite ese criterio, para que no haya
   * dos lugares donde cambiarlo.
   *
   * Lo de dividir por cero no es paranoia: esto sale de localStorage y un
   * archivo tocado a mano puede traer un bolsillo con cero generaciones.
   */
  function consumoTipico(uso, provider) {
    var b = uso && uso.porProveedor && uso.porProveedor[String(provider || "")];
    if (!b) return null;
    var gens = Number(b.generaciones) || 0;
    var entrada = Number(b.entrada) || 0;
    if (gens < 1 || entrada <= 0) return null;
    return { entrada: Math.round(entrada / gens), generaciones: gens };
  }

  /**
   * El renglón que va debajo del selector de ⚙, contestando la pregunta con la
   * que el editor lo abre: cuánto le entra a esto y cuánto le meto yo.
   *
   * Las dos mitades pueden faltar por separado y cada una lo dice con su
   * motivo, en vez de esconderse o de rellenarse con el número de otra cosa.
   */
  function lineaDeContexto(q) {
    q = q || {};
    var v = q.ventana;
    var c = q.consumo;
    var quien = String(q.proveedor || "este proveedor");
    var partes = [];

    if (!v) {
      partes.push("Ventana de contexto: no la tengo anotada para este modelo.");
    } else if (v.piso) {
      partes.push("Ventana de contexto: al menos " + fmtVentana(v.tokens) +
        " — por suscripción nadie dice cuál te toca de verdad, así que no te prometo los " +
        fmtVentana(v.largo) + ".");
    } else {
      partes.push("Ventana de contexto: " + v.texto + ".");
    }

    if (!c) {
      partes.push("Todavía no generaste con " + quien + ", así que no sé cuánto gasta acá.");
    } else {
      var t = "Una generación con " + quien + " gastó ≈ " + fmtTokens(c.entrada) +
        " de entrada (promedio de " + c.generaciones + ")";
      if (v) t += ", o sea ~" + Math.round((c.entrada / v.tokens) * 100) + "% de " +
        (v.piso ? "esos " : "") + fmtVentana(v.tokens);
      partes.push(t + ".");
    }

    // Acá NO se repite que Cursor arrastra ~30k de contexto propio: eso ya lo
    // dice el aviso amarillo que está dos renglones más abajo, y decirlo dos
    // veces seguidas es ruido. Además, con Cursor el promedio de arriba ya lo
    // muestra solo — es la razón por la que sale bastante más alto que el de
    // Claude para el mismo trabajo.
    return partes.join(" ");
  }

  /**
   * Acorta por el MEDIO, conservando principio y final.
   *
   * Los nombres de secuencia de una clase son largos y se diferencian en los
   * extremos: el número de clase adelante ("01_", "23_") y el del corte atrás
   * ("_105875" vs "_105875_02"). Cortando por el final —lo que hace el CSS— dos
   * cortes de la misma clase se ven idénticos, que es justo lo que hay que
   * distinguir para no corregir el equivocado.
   */
  function shortenMiddle(text, max) {
    var s = String(text == null ? "" : text);
    var tope = Math.max(8, Number(max) || 34);
    if (s.length <= tope) return s;
    // Con el "…" en medio, se reparte lo que queda; el final se lleva el resto
    // impar porque ahí está el sufijo que diferencia.
    var libres = tope - 1;
    var inicio = Math.floor(libres / 2);
    return s.slice(0, inicio) + "…" + s.slice(s.length - (libres - inicio));
  }

  /**
   * Dos nombres para mostrar juntos, recortados a lo que los DIFERENCIA.
   *
   * Los cortes de una misma clase comparten 40 caracteres y difieren en el
   * sufijo ("…_105875" vs "…_105875_02"). Mostrarlos enteros pone al editor a
   * comparar dos cadenas casi iguales letra por letra, justo cuando lo que
   * necesita es ver de un golpe que son distintas. Si en cambio los nombres se
   * parecen poco (leer de OTRA clase), se muestran completos: ahí el prefijo es
   * la información.
   */
  function distinguish(a, b, max) {
    var x = String(a == null ? "" : a);
    var y = String(b == null ? "" : b);
    var i = 0;
    while (i < x.length && i < y.length && x.charAt(i) === y.charAt(i)) i++;
    // Se retrocede al último separador para no cortar en mitad de una palabra.
    var corte = i;
    while (corte > 0 && !/[-_ .]/.test(x.charAt(corte - 1))) corte--;
    if (corte >= 12 && corte < x.length && corte < y.length) {
      return ["…" + x.slice(corte - 1), "…" + y.slice(corte - 1)];
    }
    return [shortenMiddle(x, max), shortenMiddle(y, max)];
  }

  /**
   * La marca dura de un comentario importado: Frame.io le pega al FINAL del
   * comentario su propio identificador —"Frame.io Comment ID: <uuid>"—, y eso
   * no aparece por casualidad.
   *
   * Es el reconocimiento bueno, y hubo que ir a buscarlo al .prproj de un
   * editor para encontrarlo. Los dos comentarios que había ahí se ven así:
   *
   *   nombre  = "Cande"        (el nombre es QUIÉN comentó)
   *   comment = "Texto listado:\n- Abrir navegador…\n\nFrame.io Comment ID: bba94422-…"
   *
   * O sea: en el nombre no hay ni rastro de Frame.io. Por eso el filtro por
   * nombre no veía ninguno y el editor seguía teniendo una tarjeta por
   * comentario de la revisión.
   */
  var FRAMEIO_COMMENT_ID = /frame\.?io[\s_-]*comment[\s_-]*id\s*:/i;

  /**
   * ¿Es un marcador de comentario importado de Frame.io?
   *
   * Al volver de revisión, Frame.io deja un marcador por comentario y quedan
   * mezclados con los de animación. No son trabajo para la herramienta: son
   * notas para el editor.
   *
   * Se mira el identificador (en el comentario o en el nombre, por si algún día
   * lo mueven) y, además, se sigue aceptando el nombre con dos puntos
   * ("Frame.io: …") porque hay quien los renombra a mano así. Lo que NO se hace
   * es descartar por la sola palabra "Frame.io" suelta en un comentario: un
   * marcador de animación que diga "esto lo pidieron por Frame.io" es trabajo
   * de verdad, y perderlo en silencio es peor que una tarjeta de más.
   */
  function isFrameIoMarker(marker) {
    var name = String((marker && marker.name) || "");
    var comment = String((marker && marker.comment) || "");
    if (FRAMEIO_COMMENT_ID.test(comment) || FRAMEIO_COMMENT_ID.test(name)) return true;
    return /frame\.io\s*:/i.test(name);
  }

  /**
   * Saca los marcadores de Frame.io de la lista que llega de Premiere.
   *
   * Devuelve una lista NUEVA (no toca la original) con `index` recalculado:
   * ese campo es el respaldo de la numeración cuando Premiere no expone el
   * guid del marcador, así que si quedara con los huecos de los descartados,
   * los marcadores se numerarían salteado.
   *
   * `ignoredMarkers` son los descartados, con nombre y segundo. Van para que el
   * log diga CUÁLES se fueron: si algún día el filtro se lleva puesto un
   * marcador de animación, tiene que poder verse, no adivinarse.
   */
  function withoutFrameIoMarkers(markers) {
    var kept = [];
    var dropped = [];
    for (var i = 0; i < (markers || []).length; i++) {
      var m = markers[i];
      if (isFrameIoMarker(m)) {
        dropped.push({ name: String((m && m.name) || "(sin nombre)"), start: (m && m.start) || 0 });
        continue;
      }
      var copy = {};
      for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) copy[k] = m[k];
      copy.index = kept.length;
      kept.push(copy);
    }
    return { markers: kept, ignored: dropped.length, ignoredMarkers: dropped };
  }

  /**
   * Los descartados, en una línea para el log: "Cande 2:26 · Candela 3:24".
   * Se cortan en 6: con una clase entera revisada pueden ser docenas y la idea
   * es poder reconocerlos de un vistazo, no leer la lista completa.
   */
  function describeIgnored(dropped) {
    dropped = dropped || [];
    var partes = [];
    for (var i = 0; i < dropped.length && i < 6; i++) {
      partes.push(dropped[i].name + " " + formatTime(dropped[i].start));
    }
    if (dropped.length > partes.length) partes.push("y " + (dropped.length - partes.length) + " más");
    return partes.join(" · ");
  }

  /**
   * Cómo se muestra el botón ⟳ según lo que contestó el motor (checkUpdate).
   * Son TRES estados, no dos: el tercero existe porque durante mucho tiempo
   * "no pude consultar GitHub" se veía igual que "estás al día", y así nadie
   * se enteró de que el chequeo estaba ciego.
   *   update  → hay versión nueva.
   *   ok      → al día, CONFIRMADO contra la fuente fresca.
   *   unknown → no se pudo averiguar (o contestó el respaldo, que puede estar
   *             atrasado). Se avisa, no se hace pasar por "al día".
   */
  function updateBadge(res, fallbackVersion) {
    var current = (res && res.current) || fallbackVersion || "";
    var v = current ? "v" + current : "v?";
    if (res && res.ok && res.changed) {
      return {
        state: "update", label: v + " → v" + res.remote,
        title: "¡Nueva versión v" + res.remote + " disponible en GitHub! Tocá para actualizar.",
      };
    }
    if (res && res.ok && res.verified) {
      return { state: "ok", label: v, title: "Estás en la última versión (verificado en GitHub). Tocá ⟳ para recargar el panel." };
    }
    return {
      state: "unknown", label: v + " ?",
      title: "No pude consultar GitHub, así que NO sé si hay una versión nueva." +
        ((res && res.error) ? " Motivo: " + res.error : "") +
        " Tocá ⟳ para reintentar.",
    };
  }

  /**
   * El micrófono del dictado, si esta máquina lo tiene. Devuelve el elemento o
   * `null`.
   *
   * El dictado es un AGREGADO a cada campo de prompt, nunca un requisito. En
   * Windows, en una máquina sin Whisper, o si `js/dictado.js` no llegó a
   * evaluarse, los cuatro campos tienen que dibujarse igual: sin esta guarda,
   * un panel sin dictado se queda sin campo donde escribir la instrucción, que
   * es la función principal del panel. Ese descuido dejó 44 tests en rojo una
   * vez, y se pregunta por `typeof` porque `!HPDictado` a secas tira
   * ReferenceError, o sea el mismo agujero por otra puerta.
   *
   * Vive acá y no repetida en cada vista porque los cuatro archivos que la
   * usan ya dependen de HPUtil sin preguntar (debounce, formatTime,
   * fmtDuration): tenerla acá no agrega ningún modo de falla que no exista ya.
   *
   * `opts.extras` viaja tal cual: desde la 1.6.0 la barra del micrófono ES la
   * barra de controles del campo (📸, el clip), así que el que devuelve null tiene
   * que armar la barra por su cuenta con esos mismos extras. Lo hace
   * HPPromptCard, en un solo lugar; acá la guarda sigue contestando lo único que
   * sabe: si en esta máquina hay dictado o no.
   */
  function micOpcional(ta, opts) {
    if (typeof HPDictado === "undefined" || !HPDictado || typeof HPDictado.attachMic !== "function") return null;
    try { return HPDictado.attachMic(ta, opts).el; } catch (e) { return null; }
  }

  /**
   * El nombre de una tarjeta, cuando además LLEVA a algún lado.
   *
   * ── El bug que esto arregla ──────────────────────────────────────────
   *
   * El nombre vive adentro del `<summary>` y es elástico (`flex: 1 1 80px`, para
   * poder recortar con tres puntos cuando no entra), así que se lleva TODO el
   * hueco del encabezado: el vacío que se ve entre el nombre y los datos de la
   * derecha está adentro del nombre. Y como llevar al timeline obliga a frenar el
   * despliegue nativo del `<details>` —si no, ir a mirar un clip abría o cerraba
   * la fila de paso—, ese `preventDefault` se estaba comiendo el clic de medio
   * encabezado. Resultado: la tarjeta no se abría haciendo clic en ella, y encima
   * el clic en el vacío MOVÍA el cursor de Premiere sin que nada lo insinuara. El
   * editor lo reportó como "me toca dar clic en el botón de la izquierda para
   * desplegarlo".
   *
   * ── La forma de arreglarlo ───────────────────────────────────────────
   *
   * La caja elástica sigue siendo elástica, porque el recorte con tres puntos la
   * necesita, pero deja de ser la que escucha: adentro va un `<span>` que mide lo
   * que miden las palabras, y ÉSE es el que lleva al timeline. Todo lo que sobra
   * en el encabezado vuelve a ser del `<summary>`, o sea que abre y cierra la
   * tarjeta como cualquier otra del panel.
   *
   * Y el subrayado se muda con el clic, que es lo que lo vuelve honesto: lo que
   * se ve subrayado es exactamente lo que responde.
   *
   * Vive acá porque el patrón es de la GRAMÁTICA de tarjeta, no de una pestaña:
   * lo tenían igual la Cola y Corrections, con el mismo bug, y la ficha de
   * marcador va a querer lo mismo el día que su nombre lleve a algún lado.
   * Devuelve la caja de afuera, que es la que se cuelga del encabezado.
   */
  function nombreQueLleva(texto, opts) {
    var o = opts || {};
    var caja = document.createElement("span");
    caja.className = "hp-nombre" + (o.clase ? " " + o.clase : "");
    var txt = document.createElement("span");
    txt.className = "hp-nombre-txt";
    txt.textContent = String(texto == null ? "" : texto);
    caja.appendChild(txt);
    if (typeof o.alHacerClic !== "function") return caja;
    txt.classList.add("is-link");
    if (o.titulo) txt.title = o.titulo;
    txt.addEventListener("click", function (e) {
      // Sigue haciendo falta, y ahora sólo sobre las palabras: sin esto, ir a
      // mirarlo al timeline abriría o cerraría la fila de paso.
      if (e && e.stopPropagation) e.stopPropagation();
      if (e && e.preventDefault) e.preventDefault();
      o.alHacerClic(e);
    });
    return caja;
  }

  /**
   * El globo del estimado de tokens de una ficha.
   *
   * ── Qué dice, y por qué las menciones van ACÁ ────────────────────────
   *
   * El globo cobra la promesa del renglón: si el estimado de verdad se arma con
   * el mismo cuerpo que viaja, entonces acá se puede leer CON QUÉ NÚMERO le llega
   * cada mención y cuál no le va a llegar. Es lo único que contesta "¿@Imagen_2 es
   * la que creo?" antes de gastar la generación — el aviso de abajo del campo lo
   * dice con lo que el panel tiene cacheado, y esto lo dice el que leyó el disco
   * para contar.
   *
   * Va en el globo y no en un renglón nuevo a propósito: el aviso fuerte ya
   * existe, sale con cada tecla y no espera al motor, así que un segundo renglón
   * diciendo lo mismo 300 ms después sería el panel contradiciéndose solo (ver
   * `explicar` en cep/js/menciones.js).
   *
   * ── Por qué es una función y no cuatro concatenaciones en la ficha ───
   *
   * Porque así se puede probar. Nadie ejecuta `main.js` en los tests —se lee como
   * texto—, así que mientras esto vivía adentro de `createMarkerCard` lo único
   * que se podía verificar era que el MOTOR produjera el campo; que el panel lo
   * leyera no lo miraba nadie. Es exactamente el tipo de cable que se corta sin
   * que nada falle: el globo simplemente deja de decir lo que sabe.
   */
  function tituloDelEstimado(r, extra) {
    var e = Array.isArray(extra) ? extra : [];
    var men = (r && r.menciones) || {};
    return "Estimado de tokens de ENTRADA de este pedido: " +
      fmtTokens(r && r.inputTokensEst) +
      (e.length ? " · incluye " + e.join(" y ") : "") +
      ". Se arma con el mismo cuerpo que se le manda al modelo." +
      (men.nota ? "\nMenciones: " + men.nota + "." : "") +
      (men.aviso ? "\nOJO: " + men.aviso + "." : "");
  }

  global.HPUtil = {
    debounce: debounce,
    micOpcional: micOpcional,
    nombreQueLleva: nombreQueLleva,
    tituloDelEstimado: tituloDelEstimado,
    escapeHtml: escapeHtml,
    formatTime: formatTime,
    estadoDeTrabajo: estadoDeTrabajo,
    fmtDuration: fmtDuration,
    addThousands: addThousands,
    fmtTokens: fmtTokens,
    fmtVentana: fmtVentana,
    sessionUsage: sessionUsage,
    dictadoUsage: dictadoUsage,
    ventanaDeContexto: ventanaDeContexto,
    consumoTipico: consumoTipico,
    lineaDeContexto: lineaDeContexto,
    shortenMiddle: shortenMiddle,
    distinguish: distinguish,
    updateBadge: updateBadge,
    isFrameIoMarker: isFrameIoMarker,
    withoutFrameIoMarkers: withoutFrameIoMarkers,
    describeIgnored: describeIgnored
  };
})(typeof window !== "undefined" ? window : this);
