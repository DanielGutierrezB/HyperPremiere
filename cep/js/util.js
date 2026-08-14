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
  function sessionUsage(u) {
    if (!u || !u.generations) {
      return { line: 'sin generaciones todavía', detail: 'Uso acumulado en esta sesión' };
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
    return { line: line, detail: detail };
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
   * ¿Es un marcador de comentario importado de Frame.io?
   *
   * Al volver de revisión, Frame.io deja un marcador por comentario y quedan
   * mezclados con los de animación. No son trabajo para la herramienta: son
   * notas para el editor. Se piden los dos puntos ("Frame.io:") y no solo el
   * nombre suelto, para no llevarse puesto un marcador que el editor haya
   * llamado "frames" o "Frame final".
   */
  function isFrameIoMarker(marker) {
    var name = (marker && marker.name) || "";
    return /frame\.io\s*:/i.test(name);
  }

  /**
   * Saca los marcadores de Frame.io de la lista que llega de Premiere.
   *
   * Devuelve una lista NUEVA (no toca la original) con `index` recalculado:
   * ese campo es el respaldo de la numeración cuando Premiere no expone el
   * guid del marcador, así que si quedara con los huecos de los descartados,
   * los marcadores se numerarían salteado.
   */
  function withoutFrameIoMarkers(markers) {
    var kept = [];
    var ignored = 0;
    for (var i = 0; i < (markers || []).length; i++) {
      var m = markers[i];
      if (isFrameIoMarker(m)) { ignored++; continue; }
      var copy = {};
      for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) copy[k] = m[k];
      copy.index = kept.length;
      kept.push(copy);
    }
    return { markers: kept, ignored: ignored };
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

  global.HPUtil = {
    debounce: debounce,
    escapeHtml: escapeHtml,
    formatTime: formatTime,
    fmtDuration: fmtDuration,
    addThousands: addThousands,
    fmtTokens: fmtTokens,
    sessionUsage: sessionUsage,
    shortenMiddle: shortenMiddle,
    distinguish: distinguish,
    updateBadge: updateBadge,
    isFrameIoMarker: isFrameIoMarker,
    withoutFrameIoMarkers: withoutFrameIoMarkers
  };
})(typeof window !== "undefined" ? window : this);
