/**
 * HPCorrections — vista de la pestaña Corrections.
 *
 * Corrige recursos YA generados y enviados, SIN depender de los marcadores de
 * Premiere. Cuando el editor manda la clase a revisar y vuelve con comentarios,
 * los marcadores pueden estar borrados, movidos o mezclados con los de
 * Frame.io, y volver a abrirlos no es opción. Todo lo que hace falta se lee de
 * la carpeta de la secuencia: el HTML de cada versión y la ficha (.meta.json)
 * con el tramo del timeline donde iba el recurso.
 *
 * Lo que sale de acá vuelve al MISMO segundo y con la MISMA duración con la que
 * se generó, en una pista nueva y en amarillo para distinguirlo de un vistazo.
 *
 * Cada fila es una ronda de feedback completa, como la de la Cola: instrucción,
 * imágenes nuevas, qué imágenes viajan y qué versión se toma como base.
 *
 * ── La fila, desde la 1.6.x ───────────────────────────────────────────
 *
 * Es una TARJETA con la misma anatomía que la ficha de un marcador y que un
 * trabajo de la Cola (ver la sección 9 del CSS): un encabezado de 32 px que se
 * puede barrer —nombre · tramo · versiones · estado— y, plegado adentro, el
 * CUERPO DE FICHA compartido (`HPPromptCard`) con la corrección, su tira de
 * referencias, su barra de controles y su pie.
 *
 * Antes la fila estaba toda desplegada y medía ~490 px, con su propio layout:
 * campo, barra de micrófono, un botón «📸 Capturar del programa» de ancho
 * completo, una zona de arrastre de 52 px y dos acciones al pie. O sea el layout
 * que la etapa 2 había sacado de la ficha del marcador, vivo acá. Con seis
 * recursos generados —una clase normal— eso son casi 3.000 px de scroll para
 * encontrar el que hay que corregir, y para encontrarlo alcanzan el nombre y el
 * segundo en que entra.
 *
 * Lo que se gana de arriba y no estaba: los chips que muestran las menciones, el
 * aviso de la mención colgada y la canonización del ✨. El motor traduce las
 * menciones del campo `adjustment` igual que las de `instruction`, así que un
 * `@[curso/logo.svg]` escrito acá ya viajaba traducido y el panel no lo pintaba.
 *
 * Tampoco depende de estar parado en la secuencia correcta: la clase suele
 * volver de la revisión re-cortada y con otro nombre ("_02"), así que se elige
 * de qué carpeta leer y se dice a qué secuencia se va a colocar.
 *
 * El HTML de cada versión se lee del disco y se puede retocar y renderizar sin
 * gastar IA: la pestaña ya encontró los archivos, no tiene sentido pedirlos.
 *
 * Cada fila muestra además EL CONTEXTO con el que se generó el recurso —los dos
 * prompts generales, el objetivo y el encargo— y deja ajustarlo para esa
 * corrección sin escribir los archivos del proyecto. Eso es una vista aparte
 * (HPCorrectionsContexto, en corrections-contexto.js): ahí está la diferencia
 * entre "esto es lo que se mandó" y "esto es una reconstrucción de los archivos
 * de hoy".
 *
 * Deps de main vía init(deps):
 *   context()        → { projectPath, sequenceName } del panel
 *   refreshContext(cb) → relee proyecto/secuencia de Premiere y llama cb
 *
 * Vanilla JS, sin ES modules: se expone como window.HPCorrections.
 */
(function (global) {
  "use strict";

  var hpLog = HPLog.log;
  var formatTime = HPUtil.formatTime;
  var fmtDuration = HPUtil.fmtDuration;

  // El micrófono de la corrección ya no se pide acá: la barra de controles de la
  // fila la arma HPPromptCard, que es la que tiene la guarda de "esta máquina no
  // puede dictar" (HPUtil.micOpcional) y dibuja la misma barra con los controles
  // solos cuando no se puede. El dictado es un agregado, nunca un requisito.

  var deps = null;
  var listEl = null;
  var statusEl = null;
  var pickerEl = null;
  var pickSource = null;

  // Fila por slug, para poder pisar su línea de estado cuando el job avanza sin
  // volver a dibujar la lista (redibujar borraría lo que el editor está
  // escribiendo en otra fila).
  var rowsBySlug = {};

  // De dónde se leyó lo generado y a dónde se coloca. Son dos secuencias
  // distintas cuando la clase volvió re-cortada: los archivos y las imágenes de
  // referencia están en la vieja, y el clip corregido va a la que está abierta.
  var origen = { slug: "", sequenceName: "" };
  var destino = "";

  // Los dos prompts generales COMO ESTÁN HOY en el proyecto (los lee el motor al
  // listar). NO son "lo que recibió" ningún recurso: son los archivos de este
  // momento, y son lo único que se puede ofrecer para las versiones cuya ficha
  // no guardó nada. Que la diferencia esté a la vista es la mitad de esto.
  var promptsNow = { course: "", sequence: "", failed: false };

  /** Los recursos salieron de otro corte de esta clase. */
  function otroCorte() {
    return !!origen.sequenceName && !!destino && origen.sequenceName !== destino;
  }

  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = cls || "muted";
  }

  /** Cuándo y cuánto duraba, en palabras. */
  function whenText(m) {
    if (m.start == null || !(m.duration > 0)) return "sin ficha del tramo";
    return "entra " + formatTime(m.start) + " · dura " + fmtDuration(m.duration);
  }

  /** De dónde salió ese tramo, para que el editor sepa cuánto confiar. */
  function sourceText(m) {
    if (m.timeSource === "ficha") return "";
    if (m.timeSource === "cola") return " (tomado de la cola)";
    if (m.timeSource === "html") return " (duración del HTML; falta el segundo de entrada)";
    return "";
  }

  // ── Encolar ────────────────────────────────────────────────────────

  /**
   * El marcador como lo vio el modelo cuando se generó: sus tiempos son los del
   * corte donde nació, y de ahí sale el tramo del transcript que se le manda.
   */
  function markerFromMeta(m) {
    return {
      name: m.markerName || m.slug, start: m.start, end: m.start + m.duration,
      duration: m.duration, guid: m.markerGuid || ""
    };
  }

  /**
   * Lo común a los dos caminos (rediseñar y renderizar un HTML pegado): el
   * recurso se genera en la carpeta de DONDE SALIÓ, para que su historia de
   * versiones siga siendo una, y el clip se coloca en la secuencia ABIERTA, que
   * es la que el editor está mirando.
   */
  function jobBase(m) {
    var ctx = deps.context();
    return {
      projectPath: ctx.projectPath,
      seqName: destino,
      storeSeqName: origen.sequenceName,
      markerKey: m.slug,
      markerStart: m.start, markerDuration: m.duration,
      correction: true
    };
  }

  /**
   * Sobre qué secuencia trabaja el material del marcador. Sus imágenes viven
   * contra la secuencia donde nació el recurso, no contra la que está abierta.
   */
  function stillsOpts(m) {
    return {
      fbJobId: "corr:" + origen.slug + ":" + m.slug,
      projectPath: deps.context().projectPath,
      sequenceName: origen.sequenceName
    };
  }

  /** Lee del namespace de una secuencia sin dejar el contexto cambiado. */
  function leerDe(seqName, fn) {
    return HPStore.withContext(deps.context().projectPath, seqName, fn);
  }

  /**
   * El objetivo de la clase. Está guardado contra la secuencia donde nació el
   * recurso, y ahí puede no estar —ese corte nunca se abrió en esta máquina—,
   * así que si falta se toma de la secuencia abierta: es la misma clase con otro
   * corte, y mandar "(sin objetivo declarado)" es pedirle al modelo que corrija
   * sin saber de qué va la clase.
   *
   * Los prompts generales NO se buscan acá y no viajan en el job: los resuelve
   * la cola contra la secuencia de origen justo antes de llamar al modelo. Desde
   * que viven al lado del .prproj hay uno del curso que cubre a todas las
   * secuencias, así que este rebusque de mirar al corte vecino dejó de tener
   * sentido — y de paso una corrección deja de poder salir con un estilo
   * distinto del que sale una generación normal del mismo marcador.
   */
  function objetivoDeLaClase() {
    function leer() { return HPStore.getObjective() || ""; }
    var propio = leerDe(origen.sequenceName, leer);
    if (propio || !otroCorte()) return propio;
    return leerDe(destino, leer);
  }

  /**
   * Manda la corrección a la cola como un refinamiento normal, con dos
   * diferencias: el HTML previo viaja explícito (el motor por defecto lee la
   * versión anterior, y acá podés corregir cualquiera) y el tramo sale de la
   * ficha en vez del marcador.
   *
   * `staged` = encolar SIN arrancar. Es la diferencia entre corregir una cosa y
   * juntar las correcciones de toda la clase: se revisan todos los recursos, se
   * escribe qué está mal en cada uno y después se larga la cola de una vez.
   */
  function enqueueCorrection(m, version, text, state, staged, prompts) {
    var ctx = deps.context();
    var opts = stillsOpts(m);
    state.className = "corr-state";
    state.textContent = "Leyendo la v" + version + "…";

    HPEngine.call("readMarkerHtml", {
      projectPath: ctx.projectPath, sequenceName: origen.sequenceName,
      markerSlug: m.slug, version: version
    }).then(function (r) {
      if (!r || !r.ok || !r.html) throw new Error((r && r.error) || "no pude leer el HTML de la v" + version);

      var job = jobBase(m);
      job.kind = "feedback";
      job.label = m.slug + " (corrección)";
      var encargo = prompts.instruction();
      job.payload = {
        projectPath: ctx.projectPath, sequenceName: origen.sequenceName,
        marker: markerFromMeta(m),
        markerSlug: m.slug, mode: "adjust",
        // `instruction` es el ENCARGO del recurso (lo que se pidió cuando se
        // generó, guardado en la ficha) y `adjustment` es la corrección de ahora.
        // Son dos secciones distintas del prompt: mandando la corrección en los
        // dos lados, el modelo rediseñaba sin saber qué era ese gráfico —"subí el
        // título" como TODO el encargo— y encima la ficha nueva se quedaba con
        // eso, así que el encargo se perdía para siempre.
        // El encargo puede venir editado del panel de "lo que recibió": es de
        // este recurso y de ningún otro, así que cambiarlo no le toca nada a
        // nadie — y como la ficha nueva se escribe con esto, queda como su
        // encargo de acá en adelante. Eso lo dice el campo.
        //
        // `null` = no lo tocó, y ahí manda la ficha (o, si esa versión no anotó
        // ninguno, la corrección de ahora: es preferible a que el modelo no sepa
        // qué era ese gráfico). VACÍO no es lo mismo que no tocado: es el ajuste
        // de un editor que borró el campo, y viaja vacío como en los otros tres
        // niveles.
        instruction: encargo === null ? (m.instruction || text) : encargo,
        adjustment: text,
        objective: objetivoDeLaClase(),
        previousHtml: r.html,
        // Qué imágenes del marcador viajan (el 📤 de cada miniatura). La cola las
        // resuelve contra la secuencia de origen justo antes de llamar al modelo.
        stillsSend: HPStills.fbCollect(opts.fbJobId, m.slug, opts),
        // Con o sin fondo tiene que salir igual que el original: si no, una
        // corrección convertiría un clip opaco en uno transparente.
        background: !!m.background
      };
      // El ajuste local de los prompts, si el editor tocó alguno. Viaja en el
      // payload y lo aplica el motor al armar el pedido (bridge/prompt/
      // build-context.js), que es el único lugar donde el contexto se combina.
      // NO se resuelve acá: la cola relee los archivos del proyecto justo antes
      // de generar —para que arreglar el estilo y reintentar salga con el
      // arreglado— y si esta pestaña mandara el texto ya resuelto, esa relectura
      // lo pisaría y el ajuste sería decorativo.
      var ajuste = prompts.override();
      if (ajuste) job.payload.promptOverride = ajuste;
      if (staged) HPQueue.addStaged(job); else HPQueue.add(job);
      HPStills.fbClear(opts.fbJobId); // la próxima ronda arranca con todas activas
      hpLog("Corrección encolada [" + m.slug + "] sobre la v" + version + " · de “" +
        origen.sequenceName + "” a “" + destino + "” en " + formatTime(m.start) +
        " por " + fmtDuration(m.duration) + (staged ? " · en espera (no arranca sola)" : "") +
        (ajuste ? " · con los prompts ajustados a mano para esta corrección (" +
          Object.keys(ajuste).join(" + ") + "); los archivos del proyecto no se tocaron" : "") +
        // Un encargo vaciado a mano es una decisión que no se ve en ninguna
        // parte del resultado: el recurso sale distinto y nada dice por qué.
        (encargo === "" ? " · sin encargo: el editor vació ese campo para esta versión" : ""));
      state.className = "corr-state is-ok";
      state.textContent = staged
        ? "En espera sobre la v" + version + ". Arranca cuando toques “Iniciar cola”."
        : "Encolada sobre la v" + version + ". El progreso está en la pestaña Cola.";
    }).catch(function (e) {
      state.className = "corr-state is-error";
      state.textContent = "No pude encolarla: " + ((e && e.message) || e);
    });
  }

  /** Renderiza el HTML editado a mano como versión nueva, sin gastar IA. */
  function enqueueManualHtml(m, html, state) {
    var ctx = deps.context();
    var job = jobBase(m);
    job.kind = "renderManualHtml";
    job.label = m.slug + " (HTML a mano)";
    job.payload = {
      projectPath: ctx.projectPath, sequenceName: origen.sequenceName,
      marker: markerFromMeta(m),
      // Con fondo o sin fondo decide el formato del video (mp4 opaco / mov con
      // alpha). Sin esto, editar a mano un recurso opaco lo devolvía en mov.
      background: !!m.background,
      markerSlug: m.slug, html: html
    };
    HPQueue.add(job);
    state.className = "corr-state is-ok";
    state.textContent = "Encolado para renderizar. El progreso está en la pestaña Cola.";
  }

  // ── Dibujar una fila ───────────────────────────────────────────────

  /**
   * Lo que este marcador recibió, en su propia vista (corrections-contexto.js).
   *
   * Lo que necesita de acá son cuatro cosas que cambian con cada carga de la
   * pestaña, así que se le pasan como funciones y no como valores: la secuencia
   * de ORIGEN del recurso (que no siempre es la abierta), el objetivo de la
   * clase, y el objeto VIVO con los prompts del proyecto —guardar un nivel desde
   * una fila lo pone al día para todas—.
   */
  function contextoDe(m, state) {
    return HPCorrectionsContexto.build(m, state, {
      projectPath: function () { return deps.context().projectPath; },
      sequenceName: function () { return origen.sequenceName; },
      promptsNow: function () { return promptsNow; },
      objetivo: objetivoDeLaClase
    });
  }

  /**
   * El encabezado plegado de una fila, con la misma anatomía que el de una ficha
   * de marcador y el de un trabajo de la Cola (ver la sección 9 del CSS).
   *
   * A la izquierda lo que identifica al recurso: su nombre —que lleva el cursor
   * de Premiere a ese punto— y el tramo, que es EL dato de esta pestaña (es lo
   * que reemplaza al marcador que ya no está). A la derecha lo que confirma: las
   * versiones y de dónde sale lo que se muestra.
   *
   * `estado` es la pastilla, y acá dice algo distinto de lo que dice en la Cola:
   * no hay trabajo en curso, así que lo que hace falta saber sin abrir la fila es
   * si de esta versión se PUEDE saber con qué se generó. Eso estaba sólo adentro
   * del desplegable del contexto, o sea que para enterarse había que abrir seis
   * filas de una en una.
   */
  function buildSummary(m, puedeAbrir) {
    var line = document.createElement(puedeAbrir ? "summary" : "div");
    line.className = "corr-line hp-sumario" + (puedeAbrir ? "" : " sin-abrir");
    // El nombre lleva al timeline. Es lo primero que se quiere hacer con una fila
    // —ver qué hay ahí antes de escribir la corrección— y más todavía cuando el
    // segundo viene de otro corte y hay que confirmar que sigue sirviendo.
    //
    // Va por `nombreQueLleva` y no a mano: lo clickeable tiene que ser las
    // PALABRAS y no la caja elástica, o el clic en el hueco del encabezado deja de
    // abrir la tarjeta y mueve el cursor de Premiere sin avisar (está contado
    // entero allá).
    var name = HPUtil.nombreQueLleva(
      m.slug + (m.markerName && m.markerName !== m.slug ? " · " + m.markerName : ""),
      {
        clase: "corr-name",
        titulo: m.start != null ? "Llevar el cursor de Premiere a este punto de “" + destino + "”." : "",
        alHacerClic: m.start == null ? null : function () {
          HPHost.openSequenceAndSeek(destino, m.start, function () {});
        }
      }
    );
    line.appendChild(name);

    var der = document.createElement("span");
    der.className = "hp-sumario-der";
    var when = document.createElement("span");
    when.className = "corr-when hp-dato";
    when.textContent = whenText(m);
    when.title = whenText(m) + sourceText(m) +
      ". De acá sale el segundo en que vuelve el clip corregido y cuánto dura.";
    der.appendChild(when);
    var meta = document.createElement("span");
    meta.className = "corr-meta hp-dato";
    meta.textContent = "v" + m.latestVersion + (m.model ? " [" + m.model + "]" : "") +
      " · " + m.versions.length + (m.versions.length === 1 ? " versión" : " versiones");
    meta.title = "La última versión de este recurso y con qué modelo se hizo. Adentro se elige " +
      "sobre cuál rediseñar.";
    der.appendChild(meta);
    var pastilla = document.createElement("span");
    pastilla.className = "hp-estado";
    if (m.start == null) {
      pastilla.textContent = "sin tramo";
      pastilla.title = "No sé dónde iba este recurso, así que todavía no se puede corregir: abrí la fila y decime el segundo.";
    } else if (!m.prompts) {
      pastilla.textContent = "reconstruido";
      pastilla.title = "De esta versión no quedó guardado qué contexto recibió: lo que se muestra adentro " +
        "son los archivos del proyecto como están HOY.";
    } else {
      pastilla.textContent = "listo";
      pastilla.title = "Tiene su tramo anotado y la ficha guardó con qué contexto se generó.";
    }
    der.appendChild(pastilla);
    line.appendChild(der);
    return line;
  }

  function buildRow(m) {
    // La fila sin tramo hace UNA sola pregunta (dónde iba) y no puede mandar nada
    // a ninguna parte, así que no se pliega: no hay ronda de feedback que
    // esconder, y esconder la pregunta sería esconder lo único que la desbloquea.
    var puedeAbrir = m.start != null;
    var row = document.createElement(puedeAbrir ? "details" : "div");
    // `is-unknown` se conserva: es el estado crudo de la fila. `es-atencion` es la
    // guarda de estado compartida con las otras dos pestañas, y `es-quieto` es
    // "nada que atender acá" (ver la sección 9 del CSS).
    row.className = "corr-row hp-tarjeta " +
      (m.start == null ? "es-atencion is-unknown" : (m.prompts ? "es-quieto" : "es-atencion"));
    row.appendChild(buildSummary(m, puedeAbrir));

    var cuerpo = document.createElement("div");
    cuerpo.className = "hp-cuerpo";
    row.appendChild(cuerpo);

    var state = document.createElement("div");
    state.className = "corr-state";

    // Sin el tramo no se puede recolocar nada: se pide UNA vez y queda guardado
    // en la ficha, así la próxima corrección ya no pregunta.
    if (m.start == null) {
      var warn = document.createElement("div");
      warn.className = "corr-warn";
      warn.textContent = "No encontré dónde iba este recurso (la versión es anterior a que se guardara la ficha). " +
        "Decime el segundo de entrada y la duración y lo dejo anotado.";
      cuerpo.appendChild(warn);

      var fix = document.createElement("div");
      fix.className = "corr-fix";
      var inStart = document.createElement("input");
      inStart.type = "number"; inStart.step = "0.1"; inStart.min = "0"; inStart.placeholder = "entra (s)";
      inStart.title = "Segundo del timeline donde arranca el recurso.";
      var inDur = document.createElement("input");
      inDur.type = "number"; inDur.step = "0.1"; inDur.min = "0.1"; inDur.placeholder = "dura (s)";
      inDur.title = "Cuántos segundos dura el recurso.";
      if (m.duration > 0) inDur.value = String(m.duration);
      var save = document.createElement("button");
      save.type = "button"; save.className = "qbtn"; save.textContent = "Guardar el tramo";
      fix.appendChild(inStart); fix.appendChild(inDur); fix.appendChild(save);
      cuerpo.appendChild(fix);
      cuerpo.appendChild(state);

      save.addEventListener("click", function () {
        var ctx = deps.context();
        state.className = "corr-state";
        state.textContent = "Guardando…";
        HPEngine.call("saveCorrectionPosition", {
          projectPath: ctx.projectPath, sequenceName: origen.sequenceName,
          markerSlug: m.slug, start: Number(inStart.value), duration: Number(inDur.value)
        }).then(function (r) {
          if (!r || !r.ok) throw new Error((r && r.error) || "no se pudo guardar");
          state.className = "corr-state is-ok";
          state.textContent = "Anotado. Recargá la secuencia para corregirlo.";
        }).catch(function (e) {
          state.className = "corr-state is-error";
          state.textContent = "No pude guardarlo: " + ((e && e.message) || e);
        });
      });
      return row;
    }

    // El encargo con el que nació el recurso, tal como quedó en su ficha. Se
    // muestra porque es lo que el modelo va a recibir junto con la corrección, y
    // porque al mes uno ya no se acuerda de qué le pidió a ese gráfico.
    var antes = [];
    if (m.instruction) {
      var brief = document.createElement("div");
      brief.className = "corr-brief";
      brief.textContent = "Se pidió: " + m.instruction;
      brief.title = m.instruction;
      antes.push(brief);
    }

    // Lo que el marcador recibió, plegado. Va arriba del campo de corrección
    // porque es contexto: es lo que se consulta ANTES de escribir qué está mal,
    // igual que el "Se pidió:" de arriba, del que es la versión completa.
    var prompts = contextoDe(m, state);
    antes.push(prompts.el);

    // Al corregir las imágenes viajan otra vez, y el 📤 es para dejar alguna
    // afuera a propósito. El renglón va arriba de la tira porque explica lo que
    // se está por ver.
    var hint = document.createElement("div");
    hint.className = "qj-fb-hint";
    hint.textContent = "Las imágenes viajan otra vez en cada corrección (el modelo no recuerda la anterior). " +
      "Tocá “reenviar” en la que no querés mandar; ✓ usar se incrusta igual.";
    antes.push(hint);

    // El campo lo crea la ficha: es un `contenteditable` con chips de mención (ver
    // cep/js/campo.js) y no un `<textarea>`, así que acá se le pasa cómo tiene que
    // ser y se lo lee después en `ficha.campo`.

    // Una corrección es una ronda de feedback como las de la Cola, así que tiene
    // que traer lo mismo: mandar imágenes nuevas, decidir cuáles viajan y marcar
    // qué se incrusta. Trabaja sobre la secuencia de ORIGEN, donde están las
    // imágenes con las que se generó el recurso.
    var opts = stillsOpts(m);
    HPStills.fbInit(opts.fbJobId);
    var ficha = null;

    // Selector de versión: solo si hay más de una para elegir. Va con el
    // desplegable propio porque Premiere no dibuja el popup de los <select>.
    //
    // Vive en la BARRA DE CONTROLES, con el 📸 y el clip, y no en el pie: es un
    // parámetro del pedido y no una acción, que es exactamente lo que hace ahí el
    // «Con fondo» de la ficha de un marcador. En el pie quedaba peor de lo que
    // suena: el pie envuelve al revés (lo destructivo arriba, ver `.hp-acciones`),
    // así que a 400 px el «sobre qué versión» terminaba DEBAJO de los dos botones
    // que lo usan.
    var pickVersion = null;
    var selRoot = null;
    if (m.versions.length > 1) {
      selRoot = document.createElement("div");
      selRoot.className = "corr-pick-version";
      selRoot.title = "Sobre qué versión aplicar la corrección.";
      pickVersion = HPWidgets.select(selRoot);
      pickVersion.setOptions(m.versions.map(function (v) {
        return { value: String(v.version), label: "v" + v.version + (v.model ? " [" + v.model + "]" : "") };
      }), String(m.latestVersion));
    }

    // Dos formas de mandar la misma corrección: dejarla EN ESPERA para revisar
    // toda la clase y largar la cola de una vez, o arrancarla ya. Es el mismo par
    // que tienen las fichas de Marcadores ("Enviar a la cola" / "Generar") y va
    // en el mismo lugar: la de todos los días en el vértice de abajo a la
    // derecha, la otra a su izquierda.
    var stageBtn = document.createElement("button");
    stageBtn.type = "button"; stageBtn.className = "qbtn qbtn-stage";
    stageBtn.textContent = "Enviar a la cola";
    HPIconos.enBoton(stageBtn, "encolar");
    stageBtn.title = "Deja la corrección en espera, sin empezar a procesarla. Arranca cuando toques “Iniciar cola”.";

    // El botón grande de la ronda de feedback, igual que en la Cola y en las
    // fichas: es la acción de la fila, no un control más de la barra. Y lleva el
    // dibujo de «aplicar el ajuste», que es lo que hace: rediseñar SOBRE la
    // versión elegida con lo que se escribió. No es reintentar ni desde cero.
    var fixBtn = document.createElement("button");
    fixBtn.type = "button"; fixBtn.className = "qbtn qbtn-react";
    fixBtn.textContent = "Regenerar";
    HPIconos.enBoton(fixBtn, "ajustar");
    fixBtn.title = "Rediseña YA sobre esa versión y devuelve el clip a " + formatTime(m.start) +
      " de “" + destino + "”, con la misma duración, en una pista nueva y en amarillo.";

    // El HTML de la versión, cargado del disco. Antes esto era una caja vacía
    // pidiendo que pegaras un HTML, lo cual no tenía sentido: la pestaña acaba de
    // encontrar todas las versiones y sabe leerlas. Sirve para mirar qué tiene el
    // recurso antes de escribir la corrección, para retocarlo a mano sin gastar
    // IA, y para pegar una versión de afuera encima si eso es lo que querés.
    // Vive en "Avanzado", que es donde vive el editor de HTML de la ficha de un
    // marcador: es la misma herramienta en el otro lugar.
    var htmlBox = document.createElement("details");
    htmlBox.className = "corr-html";
    var sum = document.createElement("summary");
    htmlBox.appendChild(sum);

    var editor = HPWidgets.makeCodeEditor();
    htmlBox.appendChild(editor.el);
    var renderBtn = document.createElement("button");
    renderBtn.type = "button"; renderBtn.className = "qbtn";
    renderBtn.textContent = "Renderizar y colocar";
    renderBtn.title = "Renderiza este HTML como versión nueva, sin llamar a la IA, y lo coloca en el tramo.";
    htmlBox.appendChild(renderBtn);

    // Y el cuerpo, que es el MISMO que el de la instrucción de un marcador y el
    // de la ronda de feedback de la Cola (cep/js/prompt-card.js). Lo que esta
    // fila agrega es lo que sólo ella tiene: lo que se lee antes de escribir (el
    // encargo original y el contexto que recibió la versión) y el selector de
    // versión en el pie.
    ficha = HPPromptCard.montar({
      camposClase: "corr-input",
      placeholder: "Qué hay que corregir. Ej: “el título tapa la cara, subilo”, “falta la fuente del dato”. " +
        "Arrastrá una imagen acá para adjuntarla y mencionarla.",
      micId: "correccion:" + m.slug,
      // El texto de esta caja no se persiste en ningún lado (se lee al apretar
      // Regenerar), así que el dictado no tiene nada que avisarle a nadie: sólo
      // hay que repintar el resaltado de las menciones.
      onChange: function () { ficha.revisar(); },
      antes: antes,
      // La tira, el inventario, el 📸, el clip, el arrastre y la canonización los
      // arma la ficha (ver cep/js/prompt-card.js): son los mismos que en la ficha
      // del marcador y en la ronda de la Cola. Lo único de acá es sobre qué
      // secuencia trabaja —la de ORIGEN, donde están las imágenes con las que se
      // generó el recurso— y eso ya lo dice `opts`.
      stills: { clave: m.slug, opts: opts },
      controles: [selRoot],
      avanzado: [{ el: htmlBox }],
      // Sin nada a la izquierda: en una corrección no hay acción destructiva —lo
      // que descarta trabajo hecho es «Regenerar desde cero», y eso vive en la
      // ronda de la Cola y en la ficha del marcador, no acá—.
      acciones: { izquierda: [], derecha: [stageBtn, fixBtn] },
      pie: [state]
    });
    cuerpo.appendChild(ficha.el);

    /** Los dos botones mandan lo mismo; cambia si la cola arranca o espera. */
    function mandar(staged) {
      var text = ficha.campo.value.trim();
      if (!text) {
        state.className = "corr-state is-error";
        state.textContent = "Escribí qué hay que corregir.";
        return;
      }
      enqueueCorrection(m, chosenVersion(), text, state, staged, prompts);
    }
    stageBtn.addEventListener("click", function () { mandar(true); });
    fixBtn.addEventListener("click", function () { mandar(false); });

    /** Qué versión está elegida en este momento. */
    function chosenVersion() {
      var v = pickVersion ? parseInt(pickVersion.value, 10) : m.latestVersion;
      return v || m.latestVersion;
    }

    var cargada = 0; // versión que está en el editor (0 = ninguna)
    function updateSummary() {
      sum.textContent = "Ver y editar el HTML de la v" + chosenVersion() + " (sin IA)";
    }
    updateSummary();

    /** Trae el HTML de la versión elegida, salvo que ya esté cargado. */
    function loadHtml() {
      var v = chosenVersion();
      updateSummary();
      if (cargada === v) return;
      var ctx = deps.context();
      state.className = "corr-state";
      state.textContent = "Leyendo la v" + v + "…";
      HPEngine.call("readMarkerHtml", {
        projectPath: ctx.projectPath, sequenceName: origen.sequenceName,
        markerSlug: m.slug, version: v
      }).then(function (r) {
        if (!r || !r.ok || typeof r.html !== "string") throw new Error((r && r.error) || "no pude leerlo");
        editor.setValue(r.html);
        cargada = v;
        state.className = "corr-state";
        state.textContent = "v" + v + " cargada. Podés retocarla y renderizar, sin gastar IA.";
      }).catch(function (e) {
        state.className = "corr-state is-error";
        state.textContent = "No pude leer el HTML de la v" + v + ": " + ((e && e.message) || e);
      });
    }

    // Acordeón, el mismo que la lista de marcadores: abrir una fila cierra las
    // demás. Abierta, una fila mide ~490 px —es la más cargada del panel— así que
    // con dos abiertas no se ve una lista, se ve un formulario largo.
    row.addEventListener("toggle", function () {
      if (!row.open || !listEl || !listEl.querySelectorAll) return;
      var todas = listEl.querySelectorAll("details.corr-row");
      for (var i = 0; i < todas.length; i++) if (todas[i] !== row) todas[i].open = false;
    });

    htmlBox.addEventListener("toggle", function () { if (htmlBox.open) loadHtml(); });
    // Cambiar de versión con el editor abierto tiene que traer ESA versión: si no,
    // se renderizaría el HTML de una versión con la etiqueta de otra.
    if (pickVersion) {
      pickVersion.onChange = function () { if (htmlBox.open) loadHtml(); else updateSummary(); };
    }

    renderBtn.addEventListener("click", function () {
      var html = editor.getValue().trim();
      if (!html) {
        state.className = "corr-state is-error";
        state.textContent = "El HTML está vacío.";
        return;
      }
      enqueueManualHtml(m, html, state);
    });

    return row;
  }

  // ── Cargar la secuencia ────────────────────────────────────────────

  /**
   * El desplegable de "de qué secuencia leer". Aparece solo cuando hay algo que
   * elegir; con una sola carpeta sería un control que no decide nada.
   */
  function renderPicker(res) {
    if (!pickerEl) return;
    pickerEl.innerHTML = "";
    pickSource = null;
    if (res.sources.length < 2) return;

    var label = document.createElement("span");
    label.className = "corr-picker-label";
    label.textContent = "Leer de";
    pickerEl.appendChild(label);

    var host = document.createElement("div");
    host.title = "De qué secuencia leer los recursos ya generados.";
    pickerEl.appendChild(host);
    pickSource = HPWidgets.select(host);
    pickSource.setOptions(res.sources.map(function (s) {
      // Acortado por el medio: el ancho del panel corta por el final, y ahí está
      // el sufijo que distingue un corte de otro de la misma clase.
      return { value: s.slug, label: HPUtil.shortenMiddle(s.sequenceName, 30) + " (" + s.count + ")" };
    }), res.folderSlug);
    pickSource.onChange = function (slug) { load(slug); };
  }

  /**
   * El aviso de que se está leyendo de otra secuencia. Es lo primero que hay que
   * entender antes de apretar Corregir: de dónde salieron los archivos y a qué
   * timeline va a caer el clip.
   *
   * Va en renglones con etiqueta y no en prosa: los nombres de estas clases
   * miden 45 caracteres y se diferencian en el sufijo, así que un párrafo con
   * los dos nombres tres veces es una pared que nadie lee.
   */
  function renderBanner(res) {
    if (!otroCorte()) return;
    var box = document.createElement("div");
    box.className = "corr-cross";

    var titulo = document.createElement("div");
    titulo.className = "corr-cross-title";
    titulo.textContent = res.guessed
      ? "Esta secuencia no tiene recursos generados; te traje los de otro corte."
      : "Estás corrigiendo recursos de otro corte.";
    box.appendChild(titulo);

    // Los dos nombres van recortados a lo que los diferencia: uno al lado del
    // otro, dos cadenas de 45 caracteres iguales salvo el final no se leen.
    var corto = HPUtil.distinguish(origen.sequenceName, destino, 34);
    [["Leo de", corto[0], origen.sequenceName], ["Coloco en", corto[1], destino]].forEach(function (par) {
      var fila = document.createElement("div");
      fila.className = "corr-cross-row";
      var k = document.createElement("span");
      k.className = "corr-cross-key";
      k.textContent = par[0];
      var v = document.createElement("span");
      v.className = "corr-cross-val";
      v.textContent = par[1];
      v.title = par[2];
      fila.appendChild(k); fila.appendChild(v);
      box.appendChild(fila);
    });

    var nota = document.createElement("div");
    nota.className = "corr-cross-note";
    // Antes acá había un campo para escribir el segundo de destino. Sobra: el
    // clip cae en una pista nueva, arriba de todo, así que si el corte se movió
    // se arrastra en el timeline, que es más rápido y más seguro que calcularlo.
    nota.textContent = "El clip cae en el segundo del corte viejo, en una pista nueva: si se movió, arrastralo.";
    box.appendChild(nota);

    listEl.appendChild(box);
  }

  function render(res) {
    listEl.innerHTML = "";
    rowsBySlug = {};
    // Las filas de la carga anterior ya no están en pantalla: que no se enteren
    // de lo que guarde una de las nuevas.
    HPCorrectionsContexto.reset();
    if (!res.markers.length) {
      var empty = document.createElement("div");
      empty.className = "corr-empty";
      empty.textContent = res.sources.length
        ? "Ninguna secuencia de este proyecto tiene recursos generados para “" + destino + "”. " +
          "Elegí de qué secuencia leer."
        : "Este proyecto todavía no tiene recursos generados.";
      listEl.appendChild(empty);
      return;
    }
    renderBanner(res);
    for (var i = 0; i < res.markers.length; i++) {
      var m = res.markers[i];
      var row = buildRow(m);
      rowsBySlug[m.slug] = row;
      listEl.appendChild(row);
    }
  }

  /** `folderSlug` fuerza una carpeta; sin él, el motor elige la que corresponde. */
  function load(folderSlug) {
    setStatus("Leyendo la carpeta de la secuencia…");
    deps.refreshContext(function () {
      var ctx = deps.context();
      if (!ctx.sequenceName) {
        setStatus("No hay secuencia activa en Premiere.", "muted is-error");
        return;
      }
      HPEngine.call("listCorrections", {
        projectPath: ctx.projectPath, sequenceName: ctx.sequenceName,
        folderSlug: folderSlug || ""
      }).then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || "no pude leer la carpeta");
        res.sources = res.sources || [];
        destino = ctx.sequenceName;
        origen = { slug: res.folderSlug, sequenceName: res.sourceSequenceName || ctx.sequenceName };
        // Se lee una vez para toda la lista: es la reconstrucción que se le ofrece
        // a los recursos cuya ficha no guardó los prompts.
        promptsNow = res.promptsNow || { course: "", sequence: "", failed: false };
        renderPicker(res);
        render(res);
        var sinFicha = res.markers.filter(function (m) { return m.start == null; }).length;
        // Cuántos son de antes de que la ficha guardara el contexto. Se dice acá
        // arriba porque cambia lo que se puede saber de esas filas, y no hay que
        // abrirlas de a una para enterarse.
        var sinPrompts = res.markers.filter(function (m) { return !m.prompts; }).length;
        // El nombre entero está en el aviso y en el desplegable: acá alcanza con
        // el conteo, que es lo que se mira después de apretar el botón.
        setStatus(res.markers.length + " recurso(s) generados en “" +
          HPUtil.shortenMiddle(origen.sequenceName, 30) + "”" +
          (sinFicha ? " · " + sinFicha + " sin el tramo anotado" : "") +
          (sinPrompts ? " · " + sinPrompts + " sin el contexto guardado (se reconstruye)" : ""));
        hpLog("Corrections: " + res.markers.length + " recursos leídos de " + res.baseDir +
          (otroCorte() ? " (secuencia abierta: “" + destino + "”)" : ""));
      }).catch(function (e) {
        listEl.innerHTML = "";
        setStatus("No pude leer lo generado: " + ((e && e.message) || e), "muted is-error");
      });
    });
  }

  global.HPCorrections = {
    /** Cablea las dependencias del panel y engancha el botón. Llamar UNA vez. */
    init: function (d) {
      deps = d;
      listEl = document.getElementById("corr-list");
      statusEl = document.getElementById("corr-status");
      pickerEl = document.getElementById("corr-picker");
      var btn = document.getElementById("btn-load-corrections");
      // El listener NO puede ser `load` a pelo: recibiría el evento del clic
      // como si fuera la carpeta a leer.
      if (btn) btn.addEventListener("click", function () { load(); });
    },
    load: function (folderSlug) { load(folderSlug); }
  };
})(typeof window !== "undefined" ? window : this);
