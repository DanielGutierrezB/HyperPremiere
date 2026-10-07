/**
 * HPAbrirRemotion — «Abrir Remotion», el mismo desde las tres listas.
 *
 * La ficha de un marcador, un trabajo terminado de la Cola y una fila de
 * Corrections muestran el mismo recurso, y un recurso hecho con Remotion se
 * abre igual desde las tres: Studio en el navegador, su archivo `.tsx` en el
 * editor de código, y el Render de Studio reemplazando el clip en Premiere (ver
 * cep/js/studio-renders.js). Lo que cambia entre una y otra es de dónde sale el
 * marcador —qué proyecto, en qué carpeta están sus versiones, dónde va el clip—
 * y en qué renglón se dice lo que pasó. Eso es lo que recibe `abrirUltima`.
 *
 * ── Siempre la ÚLTIMA versión, preguntada al apretar ───────────────────
 *
 * No la que la lista tiene anotada, y no es por las dudas: abrir otra versión
 * que aquella de la que salió el archivo de Studio manda a respaldos lo que el
 * editor escribió ahí (ver bridge/render/remotion-editables.js), y lo que una
 * lista tiene anotado se atrasa —un render de Studio hecho después ya es una
 * versión nueva, y la Cola no se entera—.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPAbrirRemotion.
 */
(function (global) {
  "use strict";

  function log(texto, nivel) {
    if (global.HPLog && HPLog.log) HPLog.log(texto, nivel || "INFO");
  }

  function nombreDe(ruta) {
    return String(ruta || "").split(/[\\\/]/).pop();
  }

  /**
   * Qué decirle al editor después de abrir Studio: qué archivo está mirando
   * —es el que edita—, qué pasó con lo que ese archivo tenía, y que el Render
   * de Studio reemplaza el clip. `conArchivo` = se pidió abrir el archivo en su
   * editor, que es lo que hace «Abrir Remotion».
   */
  function mensaje(r, conArchivo) {
    var nombre = nombreDe(r.archivo);
    var dicho;
    if (conArchivo && nombre) {
      dicho = (r.arrancado ? "Remotion abierto" : "Remotion actualizado") +
        ((r.editor && r.editor.ok)
          ? ", y «" + nombre + "» en tu editor: lo que guardes ahí se ve en Studio al momento."
          : ". No pude abrir «" + nombre + "» con tu editor: está en " + r.archivo +
            ", y lo que guardes ahí se ve en Studio al momento.");
    } else {
      dicho = r.arrancado
        ? "Remotion abierto en el navegador."
        : "Remotion actualizado — mirá la pestaña que ya tenías abierta.";
    }
    if (r.accion === "conservado") dicho += " Seguís con tus cambios sin renderizar.";
    if (r.accion === "respaldado" && r.respaldo) {
      dicho += " Lo que tenías sin renderizar quedó en «" + nombreDe(r.respaldo) + "».";
    }
    return dicho + " «Render» en Studio reemplaza el clip de este marcador en Premiere.";
  }

  /**
   * La última versión de un marcador si es de Remotion; 0 si no tiene, o si la
   * última es de otro motor. `donde` = { projectPath, sequenceName, markerSlug },
   * con `sequenceName` la secuencia de la CARPETA donde están sus versiones.
   */
  function ultimaVersion(donde) {
    return HPEngine.call("listMarkerVersions", {
      projectPath: donde.projectPath, sequenceName: donde.sequenceName, markerSlug: donde.markerSlug
    }).then(function (r) {
      var vs = (r && r.ok && r.versions) || [];
      var ult = vs[vs.length - 1];
      return (ult && ult.engine === "remotion") ? ult.version : 0;
    }).catch(function () { return 0; });
  }

  /**
   * El tramo sin los datos que no se saben. Un `name: undefined` no es "sin
   * nombre": pisa el de la ficha de la versión (el motor junta los dos), y el
   * render de Studio saldría con un marcador sin nombre.
   */
  function tramo(m) {
    var out = {};
    if (!m) return out;
    if (m.name) out.name = m.name;
    if (typeof m.start === "number" && isFinite(m.start)) out.start = m.start;
    if (typeof m.duration === "number" && m.duration > 0) out.duration = m.duration;
    return out;
  }

  /**
   * Abre Studio con una versión y deja escuchando sus renders.
   *
   * `o` = { projectPath, sequenceName, markerSlug, version, code?, engine?,
   * marker?, background?, colocarEn?, abrirArchivo?, boton?, decir }. `decir(texto,
   * esError)` es el renglón donde cada lista cuenta lo que pasa; `colocarEn`, la
   * secuencia donde va el clip si no hay ninguno que reemplazar, cuando no es la
   * de la carpeta (una corrección de otro corte).
   */
  function abrir(o) {
    if (o.boton) o.boton.disabled = true;
    o.decir("Abriendo Remotion…", false);
    var pedido = {
      projectPath: o.projectPath, sequenceName: o.sequenceName,
      markerSlug: o.markerSlug, version: o.version || 0,
      code: o.code || "",
      // El motor solo hace falta cuando no hay versión en disco de la que
      // leerlo (código recién pegado en el editor del panel).
      engine: o.engine || "",
      abrirArchivo: !!o.abrirArchivo,
      // Con el segundo de entrada: si el clip ya no está en la secuencia, el
      // render de Studio entra ahí, como una generación.
      marker: tramo(o.marker)
    };
    // Sin `background`, el de la ficha de la versión: con fondo se ve opaco y
    // sin fondo con el damero, tal como saldría el render.
    if (o.background !== undefined) pedido.background = !!o.background;
    if (o.colocarEn) pedido.colocarEn = o.colocarEn;
    return HPEngine.call("previewComposition", pedido).then(function (r) {
      if (o.boton) o.boton.disabled = false;
      if (!r || !r.ok) {
        // El motivo lo escribe el motor y se muestra COMPLETO: cuando dice que
        // no puede, explica por qué, y eso es lo único que evita que parezca
        // que algo está roto.
        o.decir((r && r.error) || "no se pudo abrir Remotion", true);
        log("Abrir Remotion: " + ((r && r.error) || "sin motivo"), "WARN");
        return r || { ok: false };
      }
      HPUtil.abrirEnNavegador(r.url);
      HPStudioRenders.escuchar();
      o.decir(mensaje(r, !!o.abrirArchivo), false);
      log("Remotion Studio con " + r.etiqueta + " en " + r.url +
        (r.arrancado ? " (recién levantado)" : " (el que ya estaba)") +
        (r.archivo ? " · archivo: " + r.archivo + " (" + r.accion + ")" : "") +
        (r.respaldo ? " · lo que tenía sin renderizar: " + r.respaldo : "") +
        (r.editor && !r.editor.ok ? " · no se pudo abrir en el editor: " + r.editor.error : ""));
      return r;
    }).catch(function (e) {
      if (o.boton) o.boton.disabled = false;
      o.decir("Error: " + ((e && e.message) || ""), true);
      return { ok: false, error: (e && e.message) || String(e) };
    });
  }

  /**
   * Lo que hace el botón «Abrir Remotion»: la ÚLTIMA versión del marcador en
   * Studio, con su archivo en el editor de código (ver la cabecera).
   *
   * `o` = lo mismo que `abrir`, sin `version` ni `code`.
   */
  function abrirUltima(o) {
    if (o.boton) o.boton.disabled = true;
    return ultimaVersion(o).then(function (v) {
      if (!v) {
        if (o.boton) o.boton.disabled = false;
        o.decir("La última versión de " + o.markerSlug + " no es de Remotion, así que no hay Studio que abrir.", true);
        return { ok: false, version: 0 };
      }
      return abrir({
        projectPath: o.projectPath, sequenceName: o.sequenceName, markerSlug: o.markerSlug,
        version: v, engine: "remotion", marker: o.marker, background: o.background,
        colocarEn: o.colocarEn, abrirArchivo: true, boton: o.boton, decir: o.decir
      });
    });
  }

  global.HPAbrirRemotion = {
    abrir: abrir,
    abrirUltima: abrirUltima,
    ultimaVersion: ultimaVersion,
    mensaje: mensaje
  };
})(typeof window !== "undefined" ? window : this);
