/**
 * HPClaudeSelector — el selector de ⚙ para "Claude (CLI / suscripción)":
 * modelo, ventana de contexto y nivel de pensamiento, como en Editor Pro.
 *
 * ── Qué decide y qué no ──────────────────────────────────────────────
 *
 * NADA de lo que se ofrece está escrito acá. El catálogo lo arma el motor
 * (bridge/claude-modelos.js) con lo que dice el CLI instalado y lo que se midió
 * con tu cuenta, y llega con cada celda ya resuelta: cada ventana de cada
 * modelo trae el `--model` exacto que hay que mandar, y cada opción su texto
 * explicativo. Este módulo elige una celda y pinta. Así una lista vieja no
 * puede volver a esconderse en el panel, que es como se quedó ofreciendo Opus 5
 * con Opus 5.5 publicado.
 *
 * ── Por qué es un módulo aparte de config-ui.js ──────────────────────
 *
 * Por el mismo motivo que la fila del motor de animación vive en HPMotores:
 * tiene su propio estado (el catálogo, la elección en curso, la medición que
 * está corriendo) y sus propios nodos. config-ui.js le delega cuando el
 * proveedor es el CLI de Claude y sigue siendo el dueño de guardar.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPClaudeSelector.
 */
(function (global) {
  "use strict";

  var nodos = null;
  var alCambiar = function () {};
  var cat = null;
  var sel = { valor: "", ventana: "", esfuerzo: "" };
  // El modelo que hay guardado mientras el catálogo no llegó: el panel no puede
  // quedarse sin decir qué tiene puesto, ni inventar una opción que no hay.
  var guardado = "";
  var progreso = "";
  // La medición automática corre UNA vez por versión del CLI y por sesión del
  // panel: si falla (sin red, sin sesión), no se reintenta en cada apertura de
  // ⚙ — para eso está Verificar.
  var yaMedido = {};
  // Lo avisa config-ui cuando el CLI confirma la sesión. Medir sin ella sería
  // gastar doce llamadas en enterarse de que falta iniciar sesión.
  var conSesion = false;

  function log(texto, nivel) {
    if (global.HPLog && HPLog.log) HPLog.log(texto, nivel || "INFO");
  }

  /** Todas las opciones de modelo, en el orden en que se muestran. */
  function opciones() {
    if (!cat) return [];
    var out = [cat.predeterminado];
    (cat.grupos || []).forEach(function (g) { out = out.concat(g.opciones); });
    if (cat.propio) out.push(cat.propio);
    return out;
  }

  function opcion(valor) {
    var todas = opciones();
    for (var i = 0; i < todas.length; i++) if (todas[i].valor === valor) return todas[i];
    return todas[0] || null;
  }

  function ventanaDe(o, id) {
    if (!o) return null;
    for (var i = 0; i < o.ventanas.length; i++) if (o.ventanas[i].id === id) return o.ventanas[i];
    return o.ventanas[0];
  }

  function esfuerzoDe(id) {
    var lista = (cat && cat.esfuerzos) || [];
    for (var i = 0; i < lista.length; i++) if (lista[i].id === id) return lista[i];
    return null;
  }

  // ── Pintar ──────────────────────────────────────────────────────────

  function pintarAcerca() {
    if (!nodos || !nodos.acerca) return;
    var lineas = [];
    var o = opcion(sel.valor);
    var v = ventanaDe(o, sel.ventana);
    var e = esfuerzoDe(sel.esfuerzo);
    if (o) {
      lineas.push(o.acerca);
      if (v && v.acerca) lineas.push(v.acerca);
      if (e) lineas.push("Pensamiento: " + e.acerca + ".");
      if (o.noDisponible) lineas.push("No está disponible en tu plan ahora: " + o.noDisponible);
      else if (v && v.noDisponible) lineas.push("Esa ventana no está disponible en tu plan ahora: " + v.noDisponible);
    }
    lineas.push(progreso || (cat ? cat.estado : "Leyendo qué modelos tiene tu Claude Code…"));
    nodos.acerca.textContent = lineas.filter(Boolean).join("\n");
  }

  function pintar() {
    if (!nodos) return;
    if (!cat) {
      // Mientras no hay catálogo se muestra lo guardado, tal cual, y nada más.
      nodos.modelo.setOptions([{ value: guardado, label: guardado || "—" }], guardado);
      nodos.ventana.setOptions([{ value: "serie", label: "—" }], "serie");
      nodos.ventana.setDisabled(true);
      pintarAcerca();
      return;
    }
    var items = [{ value: cat.predeterminado.valor, label: cat.predeterminado.etiqueta }];
    (cat.grupos || []).forEach(function (g) {
      g.opciones.forEach(function (o) {
        items.push({
          value: o.valor,
          label: o.etiqueta + (o.noDisponible ? " (no disponible)" : ""),
          grupo: g.nombre,
          // La elegida nunca se deshabilita: el desplegable mostraría otra y el
          // editor no sabría qué tiene puesto.
          deshabilitada: !!o.noDisponible && o.valor !== sel.valor,
          ayuda: o.noDisponible || ""
        });
      });
    });
    if (cat.propio) items.push({ value: cat.propio.valor, label: cat.propio.etiqueta, grupo: "Otro" });
    nodos.modelo.setOptions(items, sel.valor);

    var o = opcion(sel.valor);
    nodos.ventana.setOptions(o.ventanas.map(function (v) {
      return {
        value: v.id,
        label: v.etiqueta + (v.noDisponible ? " (no disponible)" : ""),
        deshabilitada: !!v.noDisponible && v.id !== sel.ventana,
        ayuda: v.noDisponible || ""
      };
    }), sel.ventana);
    // Con una sola ventana posible no hay nada que decidir: se ve, no se toca.
    nodos.ventana.setDisabled(o.ventanas.length < 2);

    nodos.esfuerzo.setOptions(cat.esfuerzos.map(function (e) {
      return { value: e.id, label: e.etiqueta };
    }), sel.esfuerzo);
    pintarAcerca();
  }

  function aplicarCatalogo(c) {
    if (!c || !c.ok) return false;
    cat = c;
    sel = { valor: c.actual.valor, ventana: c.actual.ventana, esfuerzo: c.actual.esfuerzo };
    pintar();
    // La sesión y el catálogo llegan por dos caminos y en cualquier orden.
    if (conSesion) medirSiHaceFalta();
    return true;
  }

  // ── Lo que llama config-ui.js ───────────────────────────────────────

  /**
   * `o` = { modelo, ventana, esfuerzo }: los tres desplegables (HPWidgets.select);
   * { acerca }: el bloque de renglones; { estado, verificar }: el renglón de la
   * sesión y el botón; `alCambiar()`: guardar, que lo sabe hacer config-ui.
   */
  function montar(o) {
    nodos = o;
    if (typeof o.alCambiar === "function") alCambiar = o.alCambiar;
    if (o.verificar) o.verificar.addEventListener("click", verificar);
  }

  /** Pide el catálogo para lo guardado y lo pinta. */
  function cargar(modelo, esfuerzo) {
    guardado = String(modelo || "");
    if (!cat) { sel.esfuerzo = esfuerzo || "high"; pintar(); }
    return HPEngine.call("catalogoClaude", { model: guardado, effort: esfuerzo })
      .then(function (c) {
        if (!aplicarCatalogo(c)) pintar();
        return c;
      })
      .catch(function () { pintar(); return null; });
  }

  /** El `--model` de la celda elegida. Es lo que se guarda. */
  function modelo() {
    if (!cat) return guardado;
    var v = ventanaDe(opcion(sel.valor), sel.ventana);
    return v ? v.modelo : guardado;
  }

  function esfuerzo() { return sel.esfuerzo; }

  function alElegirModelo(valor) {
    // La ventana se arrastra si el modelo nuevo la tiene. Es seguro porque los
    // ids dicen la VARIANTE y no el tamaño: el 1M de serie de Opus 5.5 es
    // "serie", igual que los 200k de Opus 4.6, así que pasar de uno al otro no
    // le deja puesto a Opus 4.6 un 1M extendido que nadie pidió (y que en
    // algunos planes gasta créditos extra). Solo viaja "1m" si se eligió "1m".
    var quiere = sel.ventana;
    sel.valor = valor;
    var o = opcion(valor);
    var v = null;
    for (var i = 0; i < o.ventanas.length; i++) {
      if (o.ventanas[i].id === quiere && !o.ventanas[i].noDisponible) v = o.ventanas[i];
    }
    sel.ventana = (v || o.ventanas[0]).id;
    pintar();
    alCambiar();
  }

  function alElegirVentana(id) {
    sel.ventana = id;
    pintarAcerca();
    alCambiar();
  }

  function alElegirEsfuerzo(id) {
    sel.esfuerzo = id;
    pintarAcerca();
  }

  /** "Opus 5.5 · 1M · pensamiento Alto", para el resumen de ⚙. */
  function resumen() {
    if (!cat) return guardado;
    var o = opcion(sel.valor);
    var v = ventanaDe(o, sel.ventana);
    var e = esfuerzoDe(sel.esfuerzo);
    var nombre = o.etiqueta.replace(/ · (último|legacy)$/, "");
    var partes = [nombre];
    if (v && v.tokens > 0) partes.push(v.etiqueta.replace(/ \(de serie\)$/, ""));
    if (e) partes.push("pensamiento " + e.etiqueta);
    return partes.join(" · ");
  }

  /** La ventana MEDIDA de lo elegido, en tokens; 0 si no se midió. */
  function ventanaMedida() {
    if (!cat) return 0;
    var v = ventanaDe(opcion(sel.valor), sel.ventana);
    return v ? (v.tokens || 0) : 0;
  }

  // ── Medir y verificar ───────────────────────────────────────────────

  function alProgresar(p) {
    if (!p) return;
    if (p.note) log(p.note, p.level);
    if (p.msg) { progreso = p.msg; pintarAcerca(); }
  }

  /**
   * La medición automática: corre sola cuando lo medido no es de este CLI y hay
   * sesión. Sin esto el selector dice "Opus · último", que no dice qué modelo
   * tenés puesto, hasta que alguien se acuerde de tocar Verificar.
   */
  function medirSiHaceFalta() {
    if (!cat || !cat.instalado || !cat.vencida || !cat.cli || yaMedido[cat.cli]) return null;
    yaMedido[cat.cli] = true;
    log("Claude Code " + cat.cli + " todavía no se midió: compruebo qué versión contesta cada modelo.");
    return HPEngine.callProg("medirModelosClaude", { model: modelo(), effort: sel.esfuerzo }, alProgresar)
      .then(function (c) {
        progreso = "";
        if (!aplicarCatalogo(c)) pintarAcerca();
        return c;
      })
      .catch(function (e) {
        progreso = "No pude comprobar las versiones: " + ((e && e.message) || e);
        pintarAcerca();
        return null;
      });
  }

  function haySesion() {
    conSesion = true;
    return medirSiHaceFalta();
  }

  function decir(texto, clase) {
    if (!nodos || !nodos.estado) return;
    nodos.estado.textContent = texto;
    nodos.estado.className = "muted" + (clase ? " " + clase : "");
  }

  /**
   * "Verificar": CLI al día, medición de todo, y una llamada con lo elegido.
   * El renglón de la sesión va contando cada paso: actualizar el CLI puede
   * tardar, y un botón mudo durante un minuto parece un panel colgado.
   */
  function verificar() {
    if (!nodos) return null;
    if (nodos.verificar) nodos.verificar.disabled = true;
    decir("Comprobando la versión de Claude Code…");
    return HPEngine.callProg("verificarClaude", { model: modelo(), effort: sel.esfuerzo }, function (p) {
      if (p && p.msg) decir(p.msg);
      if (p && p.note) log(p.note, p.level);
    }).then(function (r) {
      progreso = "";
      if (r && r.catalogo) aplicarCatalogo(r.catalogo);
      var notas = (r && r.notas && r.notas.length) ? "\n" + r.notas.join(". ") + "." : "";
      if (r && r.ok) {
        var cli = r.cli ? " · Claude Code " + r.cli +
          (r.actualizado ? " (actualizado)" : (r.ultima && r.ultima === r.cli ? " (la última)" : "")) : "";
        decir("✓ Claude contestó · " + (r.resumen || resumen()) + cli + notas, "login-ok");
        log("Verificar Claude: contestó con " + (r.resumen || resumen()) + cli + (notas ? " ·" + notas : ""));
      } else {
        decir("✗ " + ((r && r.error) || "Claude no contestó") + notas, "login-err");
        log("Verificar Claude: " + ((r && r.error) || "no contestó") + (notas ? " ·" + notas : ""), "WARN");
      }
      return r;
    }).catch(function (e) {
      decir("✗ No pude verificar: " + ((e && e.message) || e), "login-err");
      return null;
    }).then(function (r) {
      if (nodos.verificar) nodos.verificar.disabled = false;
      return r;
    });
  }

  global.HPClaudeSelector = {
    montar: montar,
    cargar: cargar,
    modelo: modelo,
    esfuerzo: esfuerzo,
    alElegirModelo: alElegirModelo,
    alElegirVentana: alElegirVentana,
    alElegirEsfuerzo: alElegirEsfuerzo,
    resumen: resumen,
    ventanaMedida: ventanaMedida,
    haySesion: haySesion,
    verificar: verificar
  };
})(typeof window !== "undefined" ? window : this);
