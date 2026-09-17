/**
 * HPQueueView — vista de la pestaña Cola: lista agrupada por secuencia con
 * controles (reordenar, pausar, reactivar, feedback inline, limpiar versiones
 * viejas) y el estimado de tiempo/tokens/costo pendiente.
 *
 * ── La fila, desde la 1.6.x ───────────────────────────────────────────
 *
 * Cada trabajo es una TARJETA con la misma anatomía que la ficha de un marcador
 * y que una fila de Corrections (ver la sección 9 del CSS):
 *
 *   · un ENCABEZADO de 32 px que se puede barrer: el nombre y el cronómetro a la
 *     izquierda, las acciones que se aprietan sin abrir nada (reintentar,
 *     colocar, reordenar) y a la derecha el tramo del timeline, lo que cuesta o
 *     costó, y el ESTADO EN PALABRAS;
 *   · un CUERPO con el mensaje de estado, lo que el modelo está haciendo ahora y
 *     la barra de progreso;
 *   · y, plegada adentro, la RONDA DE FEEDBACK, que es el cuerpo de ficha
 *     compartido (`HPPromptCard`) con otras dos acciones.
 *
 * Lo que NO cambió, porque es la función de esta pestaña: la guarda izquierda de
 * 3 px sigue diciendo el estado y sigue alineada en la misma columna en todas las
 * filas. Lo que cambió es que ahora las otras dos pestañas la usan para lo mismo
 * (ver la decisión escrita en la sección 9 del CSS).
 *
 * Solo DOM: el estado vive en HPQueue (y la selección de imágenes de
 * feedback en HPStills). Deps de main vía init(deps):
 *   goToJobMarker(job, openEditor) → abrir secuencia + enfocar la tarjeta
 *   showJobInTimeline(job)        → llevar el timeline al recurso, y nada más
 *   currentSequence()             → la secuencia abierta, para el filtro
 *   setOutput(text, isError)      → mensaje en la barra de salida del panel
 *
 * Vanilla JS, sin ES modules: se expone como window.HPQueueView.
 */
(function (global) {
  "use strict";

  var hpLog = HPLog.log;
  var fmtDuration = HPUtil.fmtDuration;
  var addThousands = HPUtil.addThousands;

  // El micrófono de la ronda de feedback ya no se pide acá: la barra de
  // controles la arma HPPromptCard, que es la que tiene la guarda de "esta
  // máquina no puede dictar" (HPUtil.micOpcional) y dibuja la misma barra con los
  // controles solos cuando no se puede.

  var deps = null; // lo llena init()

  // Estado UI de la caja de feedback por job (id → abierto?) y borrador de texto
  // (id → texto), para que sobreviva a los re-render frecuentes de la cola.
  var feedbackOpen = {};
  var feedbackDraft = {};

  // Filtro "ver solo esta secuencia". Es una preferencia de cómo MIRAR la cola,
  // no un estado del trabajo, así que vive en localStorage y no en queue.json:
  // se recuerda entre sesiones y no viaja con el proyecto.
  var ONLY_CURRENT_KEY = "hyperpremiere::queue-only-current";
  function onlyCurrentSeq() {
    try { return global.localStorage.getItem(ONLY_CURRENT_KEY) === "1"; } catch (e) { return false; }
  }
  function setOnlyCurrentSeq(v) {
    try { global.localStorage.setItem(ONLY_CURRENT_KEY, v ? "1" : "0"); } catch (e) {}
  }

  // ── Reloj y estado en vivo de los jobs activos ───────────────────────
  // Dos cosas cambian cuando la cola NO emite: el tiempo, que corre solo, y lo
  // que el modelo está haciendo, que llega varias veces por segundo (ver `act`
  // en queue.js). Ninguna de las dos puede redibujar la cola: el re-render
  // borraría lo que el editor esté tipeando en una caja de feedback y le
  // movería el scroll. Por eso render() anota los NODOS de cada job activo y
  // este tic los va pisando por referencia, una vez por segundo.
  var liveRows = [];
  var liveTimer = null;

  // Los nodos del número de plata de cada trabajo PENDIENTE. El estimado del
  // prompt lo pide el pie de la vista y tarda (una llamada al motor por job), así
  // que cuando llega hay que volver a pintar los encabezados que lo esperaban —y
  // no redibujar la cola, que le borraría al editor lo que esté escribiendo.
  var estNodes = [];

  // Cuánto puede pasar sin una sola novedad del modelo antes de que valga la
  // pena decirlo. Los avisos llegan cada pocos segundos, así que un minuto
  // callado ya es raro: puede ser una herramienta larga o un CLI trabado, y el
  // editor merece poder distinguirlo del "está pensando".
  var SIN_NOVEDAD_MS = 60000;

  // La segunda línea de un job activo: qué está haciendo el modelo ahora. Si el
  // proveedor no sabe contarlo, se dice —callado quedaría igual que colgado, y
  // un texto decorativo que rote solo sería mentir.
  function liveDetail(j) {
    if (j.act && j.act.label) {
      var quieto = j.act.at ? (Date.now() - j.act.at) : 0;
      // El reloj de arriba sigue corriendo igual; lo que se agrega acá es que
      // ese tiempo NO es de algo que esté avanzando a la vista.
      return "↳ " + j.act.label +
        (quieto > SIN_NOVEDAD_MS ? " · sin novedad hace " + fmtDuration(quieto / 1000) : "");
    }
    // Sin detalle: puede ser el hueco entre dos llamadas al modelo (el
    // proveedor sí informa, ver _actSeen) o un proveedor que no lo informa
    // nunca —API directa, Ollama—, y ahí conviene decirlo.
    if (j.status === "modeling" && !j._actSeen && j.startedAt && (Date.now() - j.startedAt) > 15000) {
      return "↳ este proveedor no informa el detalle de lo que hace";
    }
    // En el render no hay nada que "contar", pero sí cuánto debería tardar:
    // la cola ya tiene calibrado su ritmo con los renders anteriores.
    if (j.status === "running" && HPQueue.timing.calibrated() && Number(j.markerDuration) > 0) {
      return "↳ estimado ≈ " + fmtDuration(HPQueue.timing.estimateSec(0, j.markerDuration));
    }
    return "";
  }

  /**
   * ¿El mensaje de un trabajo dice lo mismo que su pastilla de estado?
   *
   * Se compara sin acentos, sin mayúsculas y sin puntuación, que es lo que hace
   * que «En cola…» y «en cola» sean la misma cosa y que «Reencolado, esperando
   * turno…» no lo sea. Es una comparación y no una lista de frases a propósito:
   * las frases las escribe HPQueue y cambian; la pregunta no.
   */
  function mismaCosa(msg, palabra) {
    var pelar = function (s) { return String(s || "").toLowerCase().replace(/[^a-záéíóúñ]/g, ""); };
    return pelar(msg) === pelar(palabra);
  }

  /**
   * Cuánto tardó un trabajo terminado, de punta a punta.
   *
   * El bueno es `_totalMs`, que es tiempo de pared. La suma de las etapas es el
   * respaldo y NO es lo mismo —entre el diseño y el render el job puede haber
   * esperado un carril libre, y colocar el clip va después—, así que da de menos;
   * existe para los trabajos que quedaron en un `queue.json` escrito por una
   * versión anterior a la 1.6.0, que guardaba las etapas y no el total. Sin el
   * respaldo, esos trabajos se quedaban sin tiempo en el encabezado justo después
   * de que el tiempo pasó a ser lo único que el encabezado muestra.
   */
  function tiempoTotal(j) {
    if (j && j._totalMs > 0) return j._totalMs;
    return ((j && j._modelMs) || 0) + ((j && j._renderMs) || 0);
  }

  function tickLive() {
    for (var i = 0; i < liveRows.length; i++) {
      var r = liveRows[i], j = r.job;
      // El reloj: sólo el TEXTO se reescribe. El dibujo es un hermano suyo y se
      // queda quieto (era un ⏱ tipeado; ver cep/js/iconos.js), y la caja entera se
      // esconde mientras no haya de cuándo contar, así no queda un icono solo.
      if (r.clkTxt) {
        var t = j.startedAt ? fmtDuration((Date.now() - j.startedAt) / 1000) : "";
        r.clkTxt.textContent = t;
        if (r.clk) r.clk.setAttribute("data-hidden", t ? "false" : "true");
      }
      if (r.fill) r.fill.style.width = (j.pct || 0) + "%";
      if (r.act) {
        var txt = liveDetail(j);
        r.act.textContent = txt;
        r.act.setAttribute("data-hidden", txt ? "false" : "true");
      }
    }
  }

  // Arranca el tic si hay algo vivo que mirar y lo apaga si no: un intervalo
  // corriendo sobre nodos que ya no están en el DOM es una fuga silenciosa.
  function syncLiveClock() {
    if (liveRows.length && !liveTimer) liveTimer = setInterval(tickLive, 1000);
    if (!liveRows.length && liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    if (liveRows.length) tickLive(); // que el primer dibujo ya salga con la hora puesta
  }

  /**
   * Un botón de la cola. `icono` es el nombre del dibujo de HPIconos, o "" si no
   * lleva ninguno.
   *
   * El `preventDefault` es de la 1.6.x y hace falta desde que la fila es un
   * `<details>`: un clic en un botón que vive adentro del `<summary>` también
   * pliega la tarjeta, así que sin esto «Reintentar» y «Colocar» abrían o cerraban
   * la ronda de feedback de paso. Lo que abre y cierra es el chevron, el nombre y
   * el botón que lo dice.
   */
  function iconBtn(txt, title, cb, icono) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "qbtn"; b.textContent = txt; b.title = title;
    if (icono) HPIconos.enBoton(b, icono);
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
      cb();
    });
    return b;
  }

  /**
   * El número de plata de un trabajo, en el encabezado: lo que COSTÓ si ya
   * terminó, lo que se ESTIMA si todavía no.
   *
   * Es el mismo dato en sus dos tiempos y va en el mismo lugar del encabezado
   * donde la ficha de un marcador dice su `≈ 41k tok`. Y son dos nodos —el
   * número, que no se cae nunca, y el desglose, que el CSS esconde en el panel
   * angosto— por lo mismo que allá: CSS no puede esconder media palabra de un
   * nodo de texto.
   *
   * Con `costUsd` manda el costo, porque es lo que se paga; sin él (Cursor va por
   * suscripción y no informa ninguno) manda la entrada, que es lo que sí se sabe.
   * Un renglón que dijera «$0.00» con Cursor sería una mentira barata.
   */
  function pintarPlata(el, j) {
    el.textContent = "";
    el.setAttribute("data-hidden", "true");
    var corto = document.createElement("span"); corto.className = "hp-dato-corto";
    var largo = document.createElement("span"); largo.className = "hp-dato-largo";
    if (j.usage) {
      var entrada = HPStore.totalInput(j.usage);
      var salida = Number(j.usage.outputTokens) || 0;
      var costo = Number(j.usage.costUsd) || 0;
      corto.textContent = costo > 0
        ? "$" + (costo < 0.1 ? costo.toFixed(4) : costo.toFixed(2))
        : HPUtil.fmtTokens(entrada) + "↑";
      largo.textContent = costo > 0
        ? " · " + HPUtil.fmtTokens(entrada) + "↑"
        : " " + HPUtil.fmtTokens(salida) + "↓";
      el.title = "Lo que gastó este pedido: " + addThousands(entrada) + " tokens de entrada · " +
        addThousands(salida) + " de salida" +
        (costo > 0 ? " · $" + costo.toFixed(4) : " · este proveedor no informa el costo");
    } else if (typeof j._tokEst === "number" && j._tokEst > 0) {
      corto.textContent = "≈ " + HPUtil.fmtTokens(j._tokEst);
      largo.textContent = " tok";
      el.title = "Estimado de tokens de ENTRADA de este pedido: " + addThousands(j._tokEst) +
        ". Se arma con el mismo cuerpo que se le manda al modelo.";
    } else {
      return; // todavía no hay nada que decir: el encabezado no muestra un hueco
    }
    el.setAttribute("data-hidden", "false");
    el.appendChild(corto);
    el.appendChild(largo);
  }

  // ── Limpieza de versiones viejas ──────────────────────────────────────

  // Ejecuta la limpieza REAL (ya confirmada): secuencia → proyecto → disco.
  // Cada `target` es { projectPath, sequenceName } y, si la limpieza es de un
  // solo recurso, además markerSlug. El orden importa y no es negociable: si se
  // borrara del disco primero, Premiere se queda con clips apuntando a archivos
  // que no están y te recibe con el cartel de "Link Media".
  function performCleanup(targets) {
    deps.setOutput("🧹 Limpiando versiones viejas…", false);
    hpLog("Limpiando versiones viejas en " + targets.length + " secuencia(s)…");
    var listPromises = targets.map(function (t) {
      return HPEngine.call("listOldVersions", t).then(function (r) { return (r && r.ok) ? (r.files || []) : []; }).catch(function () { return []; });
    });
    Promise.all(listPromises).then(function (lists) {
      // Rutas completas, no nombres: es la identidad del clip (ver purgeClipsByPath).
      var rutas = [];
      lists.forEach(function (files) { files.forEach(function (f) { if (f && f.path) rutas.push(f.path); }); });
      if (!rutas.length) { deps.setOutput("🧹 No hay versiones viejas para limpiar.", false); return; }
      // Paso 2: sacarlos de secuencia + proyecto ANTES de borrar (evita re-vincular).
      HPHost.purgeClipsByPath(rutas, function (purge) {
        hpLog("purge en Premiere: " + purge + " (" + rutas.length + " archivo(s))");
        var totalDeleted = 0, totalBytes = 0, pending = targets.length, errs = [];
        targets.forEach(function (t) {
          HPEngine.call("cleanOldVersions", t).then(function (res) {
            if (res && res.ok) { totalDeleted += res.deleted || 0; totalBytes += res.freedBytes || 0; }
            else errs.push((res && res.error) || "error");
          }).catch(function (e) { errs.push((e && e.message) || "error"); })
            .then(function () {
              if (--pending === 0) {
                var mb = (totalBytes / (1024 * 1024)).toFixed(1);
                var okPurge = String(purge || "").indexOf("ok|") === 0;
                var msg = "🧹 Limpieza lista: " + totalDeleted + " video(s) borrados · " + mb + " MB liberados." +
                  (okPurge ? " Quitados de la secuencia y del proyecto." : " (No pude quitarlos del proyecto: " + purge + ")") +
                  " Los HTMLs se conservan.";
                if (errs.length) msg += " · " + errs.length + " error(es) al borrar";
                deps.setOutput(msg, errs.length > 0 || !okPurge);
                hpLog(msg);
              }
            });
        });
      });
    });
  }

  /**
   * Muestra el detalle (qué se borra ↔ qué se conserva) y pide confirmación;
   * recién al aceptar borra. El detalle lo arma el MOTOR mirando el disco, así
   * que la pregunta dice lo mismo trate de una secuencia entera o de un solo
   * recurso: lo que cambia es qué targets se le pasan.
   * `nada` = qué decir cuando no hay nada viejo que borrar.
   */
  function confirmAndClean(targets, titulo, nada) {
    var previewPromises = targets.map(function (t) {
      return HPEngine.call("cleanupPreview", t)
        .then(function (r) { return (r && r.ok) ? r : { groups: [], totalDeletes: 0, totalBytes: 0, sequenceName: t.sequenceName }; })
        .catch(function () { return { groups: [], totalDeletes: 0, totalBytes: 0, sequenceName: t.sequenceName }; });
    });
    Promise.all(previewPromises).then(function (previews) {
      var totalDeletes = 0, totalBytes = 0;
      previews.forEach(function (p) { totalDeletes += p.totalDeletes || 0; totalBytes += p.totalBytes || 0; });
      if (!totalDeletes) { deps.setOutput(nada, false); return; }
      HPWidgets.confirmOverlay(titulo, function (body) {
        var intro = document.createElement("p");
        var strong = document.createElement("strong"); strong.textContent = totalDeletes + " video(s)";
        intro.appendChild(document.createTextNode("Se van a borrar "));
        intro.appendChild(strong);
        intro.appendChild(document.createTextNode(" viejos (" + (totalBytes / 1048576).toFixed(1) + " MB) del disco y de las " +
          "secuencias donde estén. Se conserva la última versión. Los HTMLs no se tocan: podés volver sobre una versión vieja desde Corrections."));
        body.appendChild(intro);
        previews.forEach(function (p) {
          if (!p.groups || !p.groups.length) return;
          var sh = document.createElement("div"); sh.className = "section-label"; sh.textContent = p.sequenceName || "secuencia";
          body.appendChild(sh);
          p.groups.forEach(function (g) {
            g.deletes.forEach(function (d) {
              var row = document.createElement("div"); row.className = "cleanup-row";
              var del = document.createElement("span"); del.className = "cl-del"; del.textContent = "🗑 " + d.name;
              var keep = document.createElement("span"); keep.className = "cl-keep"; keep.textContent = "conserva: " + (g.keep ? g.keep.name : "?");
              row.appendChild(del); row.appendChild(keep);
              body.appendChild(row);
            });
          });
        });
      }, "Borrar " + totalDeletes + " video(s)", function () { performCleanup(targets); });
    });
  }

  /**
   * "🧹 Limpiar previas" de un job terminado: borra las versiones ANTERIORES de
   * ESE recurso y deja la que el editor acaba de aprobar. Es el momento real de
   * fin de clase — quedaste conforme con la v5 y las cuatro anteriores son
   * cientos de MB que además Premiere sigue mostrando en el proyecto—, y va por
   * marcador porque los otros pueden estar a medio revisar.
   */
  function cleanJobPrevious(job) {
    confirmAndClean([{
      projectPath: job.projectPath,
      // La carpeta del recurso es la de la secuencia donde NACIÓ: en una
      // corrección no es la que estás mirando.
      sequenceName: job.storeSeqName || job.seqName,
      markerSlug: job.markerKey
    }], "Limpiar las versiones previas de " + job.markerKey,
      "🧹 " + job.markerKey + " no tiene versiones anteriores: no hay nada que borrar.");
  }

  // Botón "limpiar versiones viejas": lo mismo para TODAS las secuencias de la cola.
  function cleanOldVersions() {
    var seen = {}, targets = [];
    function addTarget(pp, sn) {
      if (!sn) return;
      var k = String(pp) + "::" + String(sn);
      if (seen[k]) return; seen[k] = true;
      targets.push({ projectPath: pp, sequenceName: sn });
    }
    var jobs = HPQueue.jobs();
    for (var i = 0; i < jobs.length; i++) addTarget(jobs[i].projectPath, jobs[i].seqName);
    var ctx = HPStore.getContext();
    addTarget(ctx.projectPath, ctx.sequenceName);
    if (!targets.length) { deps.setOutput("No hay secuencias en la cola para limpiar.", false); return; }
    confirmAndClean(targets, "Limpiar versiones viejas", "🧹 No hay versiones viejas para limpiar.");
  }

  // Costo estimado de la cola, auto-calibrado con lo REAL de esta sesión.
  //
  // Se calibra por GENERACIÓN, no por token, y eso arregla dos cosas. La
  // primera: el $/token salía de dividir el costo por `inputTokens`, que en los
  // CLI de agente es el pedacito sin cachear —así que la tarifa daba cientos de
  // dólares por millón y el estimado de la cola era un disparate—. La segunda:
  // aunque se cuente la entrada completa, sumar los tokens de los proveedores
  // que NO informan costo (Cursor por suscripción) contra los dólares de los que
  // sí, mezcla dos cosas distintas. El promedio se saca solo de las generaciones
  // que informaron costo, que es la única muestra con las dos mitades.
  // Local = gratis; sin muestra todavía = se calcula al correr.
  function estimateCostLabel(aiJobCount) {
    if (HPConfigUI.isLocalProvider()) return "gratis (local)";
    var u = HPStore.getSessionUsage();
    if (u && u.costUsd > 0 && u.costGenerations > 0) {
      var est = aiJobCount * (u.costUsd / u.costGenerations);
      return "≈ $" + (est < 0.1 ? est.toFixed(4) : est.toFixed(2));
    }
    return "s/d (se calcula al procesar)";
  }

  // Footer con estimación de la cola (marcadores en espera): tiempo y tokens de
  // entrada estimados para procesar TODO lo pendiente, así se decide antes de lanzar.
  function renderQueueEstimate(panel, jobs) {
    var pend = jobs.filter(function (j) { return HPQueue.isPending(j.status); });
    if (!pend.length) return;
    var genCount = 0, compSec = 0;
    for (var k = 0; k < pend.length; k++) {
      var j = pend[k];
      if (j.kind === "generate" || j.kind === "feedback") genCount++;
      compSec += Number(j.markerDuration) || 0;
    }
    // La cola sabe cuántos diseños y cuántos renders corren en paralelo, así que
    // la cuenta la hace ella (ver timing.estimateSec).
    var timeSec = HPQueue.timing.estimateSec(genCount, compSec);

    var foot = document.createElement("div"); foot.className = "queue-estimate";
    var line1 = document.createElement("div"); line1.className = "qe-line";
    line1.textContent = "⏳ Pendiente: " + pend.length + " marcador(es) · vídeo total " + fmtDuration(compSec) +
      " · tiempo ≈ " + fmtDuration(timeSec) + (HPQueue.timing.calibrated() ? "" : " (aprox.)");
    foot.appendChild(line1);
    var line2 = document.createElement("div"); line2.className = "qe-line qe-tok";
    line2.textContent = "Tokens del prompt: calculando…";
    // Lo que se puede estimar es NUESTRO prompt, porque lo armamos nosotros. La
    // entrada real que después informa el contador es bastante mayor: los CLI de
    // agente le suman su propio contexto (~30k tokens) y lo releen en cada
    // llamada. Decirlo acá evita que los dos números parezcan contradecirse.
    line2.setAttribute("title", "Es el tamaño de lo que le mandamos (objetivo, guion, " +
      "instrucciones, imágenes). Con los CLI de agente, la entrada que termina contando el " +
      "medidor de sesión es mayor: cada llamada arrastra el contexto del propio agente.");
    foot.appendChild(line2);
    panel.appendChild(foot);

    // Tokens: sumar estimateTokens de cada job de IA pendiente (cacheado por job).
    var aiJobs = pend.filter(function (j) { return j.kind === "generate" || j.kind === "feedback"; });
    if (!aiJobs.length) { line2.textContent = "Sin llamadas a la IA pendientes (solo render)."; return; }
    Promise.all(aiJobs.map(function (j) {
      if (typeof j._tokEst === "number") return Promise.resolve(j._tokEst);
      // NO se estima `j.payload` a secas: mientras el job está en cola, ese
      // objeto todavía no tiene el material ni los niveles del estilo (los
      // resuelve la cola justo antes de llamar al modelo). Una corrección recién
      // encolada se estimaba así sin ningún nivel de contexto y sin sus
      // imágenes, y el número se corregía solo recién cuando el job arrancaba.
      return HPQueue.payloadForEstimate(j).then(function (body) {
        return HPEngine.call("estimateTokens", body);
      }).then(function (r) {
        j._tokEst = (r && r.ok) ? (r.inputTokensEst || 0) : 0; return j._tokEst;
      }).catch(function () { return 0; });
    })).then(function (vals) {
      var total = vals.reduce(function (a, b) { return a + (b || 0); }, 0);
      line2.textContent = "Tokens del prompt (toda la cola): ≈ " + addThousands(total) +
        " · " + aiJobs.length + " llamada(s) a la IA · costo " + estimateCostLabel(aiJobs.length);
      // Y el mismo número, por trabajo, en su encabezado: es el único momento en
      // que se sabe, y redibujar la cola para mostrarlo borraría lo que el editor
      // esté escribiendo en una ronda de feedback.
      estNodes.forEach(function (n) { pintarPlata(n.el, n.job); });
    }).catch(function () { line2.textContent = ""; });
  }

  // Cerrar la caja y olvidar lo que había: se llama al mandar, por cualquiera de
  // los dos caminos.
  function closeFeedback(id) {
    feedbackOpen[id] = false;
    feedbackDraft[id] = "";
    HPStills.fbClear(id);
  }

  /**
   * La ronda de feedback de un job terminado, que es EL CUERPO DE UNA FICHA.
   *
   * Hasta la 1.6.0 era un layout propio: campo, barra de micrófono, dos botones,
   * un renglón de ayuda, el botón «📸 Capturar del programa» de ancho completo y
   * una zona de arrastre de 52 px. O sea el layout que la etapa 2 sacó de la
   * ficha del marcador, todavía vivo acá. Y no era un descuido de nadie: es el
   * MISMO problema —un campo de texto, un inventario de referencias y unas
   * herramientas— resuelto dos veces.
   *
   * Ahora es `HPPromptCard` con otras acciones (cep/js/prompt-card.js), igual
   * que la instrucción de un marcador y que los dos bloques de estilo. Lo que
   * viene de arriba y no estaba: los chips que muestran las menciones, el aviso
   * de la mención colgada y la canonización del ✨. Las tres sirven acá desde el
   * primer día y nadie las había cableado: el motor traduce las menciones del
   * campo `adjustment` igual que las de `instruction` (ver CAMPOS_CON_MENCIONES
   * en bridge/engine.js), así que un `@[curso/logo.svg]` escrito en esta caja
   * viajaba traducido y el panel no lo pintaba ni lo revisaba.
   *
   * Lo que sigue siendo de acá: que la tira lleve el 📤 de cada miniatura
   * (`fbJobId`), que las dos salidas sean «aplicar el ajuste» y «desde cero», y
   * que el material salga de la secuencia DEL JOB y no de la que el editor tenga
   * abierta.
   */
  function buildFeedbackBox(j) {
    // Sobre qué secuencia trabaja el material de este marcador. Es la del job,
    // NO la que el editor tenga abierta: con la cola de varias clases, o
    // corrigiendo algo generado en el corte anterior, no coinciden.
    var stillsOpts = {
      fbJobId: j.id, projectPath: j.projectPath,
      sequenceName: j.storeSeqName || j.seqName
    };
    HPStills.fbInit(j.id); // selección de reenvío: todas activas, 📤 apaga
    var ficha = null;

    function guardar(texto) { feedbackDraft[j.id] = texto; }

    // El campo lo CREA la ficha y no esta función: es un `contenteditable` con
    // chips de mención (ver cep/js/campo.js), así que no se puede armar acá y
    // pasarlo hecho. Lo que era del campo y sigue siendo de acá —el borrador de esta
    // ronda y que un clic adentro no pliegue la fila— se le cuelga DESPUÉS de
    // montar, sobre `ficha.campo`.

    // Al refinar las imágenes viajan otra vez, y el 📤 es para dejar alguna
    // afuera a propósito. El renglón va ARRIBA de la tira porque explica lo que
    // se está por ver, no lo que quedó atrás.
    var hint = document.createElement("div"); hint.className = "qj-fb-hint";
    // Y el renglón nombra el botón como se ve ahora: el 📤 era un emoji del
    // sistema y pasó a ser un icono de trazo, así que un texto que dijera «usá
    // 📤» estaría señalando un dibujo que ya no está.
    hint.textContent = "Al refinar, las imágenes se envían otra vez: el modelo no recuerda la generación anterior. " +
      "Tocá “reenviar” en una miniatura si querés que ésa NO viaje. Las ✓ usar se incrustan igual.";

    // Las DOS salidas de una ronda de feedback, las mismas que ofrece la ficha
    // del marcador: refinar sobre lo que hay, o tirarlo y rediseñar. Antes acá
    // había un solo botón que hacía una cosa o la otra según si el cuadro tenía
    // texto, y para rediseñar desde cero había que irse a la pestaña Marcadores.
    //
    // Van en el PIE de la ficha, que es el mismo lugar y la misma regla que en la
    // ficha de un marcador: lo que se aprieta a la derecha, lo que descarta
    // trabajo hecho a la izquierda y lejos.
    //
    // Dice "Aplicar el ajuste" y no "Refinar" por dos razones. La primera es que
    // el ✨ Refinar del dictado queda a 6 px de acá y hace otra cosa —reescribe
    // el TEXTO del pedido, no la animación—, así que dos botones con la misma
    // palabra pegados eran una trampa. La segunda es que "aplicar el ajuste" se
    // lee como lo contrario de "regenerar desde cero", que es lo que son; con
    // "refinar" eran dos palabras parecidas para dos acciones opuestas, y de ahí
    // salía el error de puntería que la confirmación de abajo tiene que atajar.
    var go = document.createElement("button"); go.type = "button"; go.className = "qbtn qbtn-react"; go.textContent = "Aplicar el ajuste";
    // Los dos glifos que tenía esta caja —↻ y ⟲— eran EL MISMO DIBUJO con otro
    // punto de partida, para las dos acciones más distintas que hay acá: una sigue
    // el diseño anterior y la otra lo tira. A 12 px no se distinguen. Ahora
    // "aplicar el ajuste" son dos rieles con su perilla (calibrar algo que ya
    // existe) y "desde cero" es el lazo que vuelve al principio.
    HPIconos.enBoton(go, "ajustar");
    go.title = "Ajusta sobre la última versión con tu feedback (mantiene lo que funciona y retoma el mismo puesto en la cola)";
    go.addEventListener("click", function (e) {
      e.stopPropagation();
      var t = (feedbackDraft[j.id] || "").trim();
      // Sin texto no hay refinamiento posible: antes esto salía como una
      // regeneración total y el editor se enteraba al ver el resultado.
      if (!t) {
        deps.setOutput("Escribí qué ajustar, o usá “Regenerar desde cero”.", true);
        return;
      }
      // Índices de las imágenes que el usuario dejó activas (📤) para reenviar.
      var sendIdx = HPStills.fbCollect(j.id, j.markerKey, stillsOpts);
      closeFeedback(j.id);
      HPQueue.regenerate(j.id, t, sendIdx);
    });
    var fresh = document.createElement("button"); fresh.type = "button"; fresh.className = "qbtn qbtn-fresh"; fresh.textContent = "Regenerar desde cero";
    HPIconos.enBoton(fresh, "desdeCero");
    fresh.title = "Descarta el diseño anterior y vuelve a diseñar con la instrucción y el material de hoy. " +
      "No usa el texto de este cuadro. Pregunta antes.";
    // SIEMPRE pregunta. Está en la misma fila que el ajuste, así que el error de
    // puntería es esperable: sin confirmación, un
    // clic de más tira una animación que estaba bien y arranca una generación
    // entera. Que se vea apagado ayuda a no elegirlo por error, pero no protege
    // de nada: lo que protege es la pregunta.
    fresh.addEventListener("click", function (e) {
      e.stopPropagation();
      var t = (feedbackDraft[j.id] || "").trim();
      HPWidgets.confirmOverlay("Regenerar desde cero", function (body) {
        var p = document.createElement("p");
        p.textContent = "¿Seguro querés generar esta animación desde cero? " +
          "Se descarta el diseño anterior y se vuelve a diseñar con la instrucción del marcador " +
          "y el material de hoy — es una generación completa, con su costo y su espera.";
        body.appendChild(p);
        if (t) {
          var q = document.createElement("p");
          q.textContent = "El feedback que escribiste NO se usa: desde cero no parte de la versión previa. " +
            "Si lo que querés es aplicarlo, cerrá esto y dale “Aplicar el ajuste”.";
          body.appendChild(q);
        }
      }, "Regenerar desde cero", function () { closeFeedback(j.id); HPQueue.regenerateFresh(j.id); });
    });

    ficha = HPPromptCard.montar({
      camposClase: "qj-fb-input",
      placeholder: "Qué ajustar… (se regenera manteniendo el puesto en la cola). " +
        "Arrastrá una imagen acá para adjuntarla y mencionarla.",
      micId: "cola:" + j.id,
      onChange: function (texto) { guardar(texto); },
      antes: [hint],
      // La tira, el inventario, el 📸, el clip, el arrastre y la canonización los
      // arma la ficha (ver cep/js/prompt-card.js): son los mismos que en la ficha
      // del marcador y en la fila de Corrections, y lo único que cambia es sobre
      // qué marcador y qué secuencia trabajan, que es lo que dice `stillsOpts`.
      //
      // Lo que esta ronda NO lleva es «Con fondo»: una regeneración tiene que salir
      // en el mismo formato que el original, o convertiría un clip opaco en uno
      // transparente.
      stills: { clave: j.markerKey, opts: stillsOpts },
      acciones: { izquierda: [fresh], derecha: [go] }
    });
    // El borrador de esta ronda se escribe DESPUÉS de montar, y por eso hay que
    // volver a revisar: `montar` ya revisó con el campo vacío.
    ficha.campo.value = feedbackDraft[j.id] || "";
    ficha.revisar();
    ficha.campo.addEventListener("input", function () { guardar(ficha.campo.value); });
    // Un clic adentro del campo no puede plegar la fila: la fila es un `<details>`
    // y el campo vive en su cuerpo.
    ficha.campo.addEventListener("click", function (e) { e.stopPropagation(); });
    ficha.el.classList.add("qj-feedback-wrap");
    return ficha.el;
  }

  /**
   * LA TARJETA DE UN TRABAJO de la cola.
   *
   * Es la misma gramática que la ficha de un marcador y que la fila de
   * Corrections: encabezado que se lee plegado y, adentro, lo que se mira de
   * cerca. Lo propio de acá es qué va en cada mitad, y eso lo decide el ESTADO:
   * mientras avanza, el progreso va en el encabezado (un `<details>` esconde
   * todo lo que viene después de su resumen); cuando terminó, al revés.
   *
   * `sitio` es lo que la tarjeta no puede saber sola porque es de la lista que
   * la contiene: `prepSeq` —qué secuencia se está transcribiendo ahora mismo—, y
   * el `puesto` que ocupa entre los que ESPERAN de su secuencia junto con cuántos
   * son (`enCola`), que es lo que decide si se le ofrece subir, bajar, las dos o
   * ninguna. Un trabajo que no está en cola no se puede mover y su puesto es -1.
   */
  function tarjetaDeTrabajo(j, sitio) {
    // ── La fila es una TARJETA con la gramática de la ficha de un
    //    marcador: encabezado plegado y, adentro, la ronda de feedback ──
    //
    // Un `<details>` sólo donde hay algo que abrir: un trabajo en cola o
    // fallado no tiene ronda de feedback, así que ahí la tarjeta es un `div`
    // y su encabezado lleva la marca `sin-abrir`, que reserva la columna del
    // chevron para que el nombre de todas las filas siga arrancando en la
    // misma x (ver `.hp-sumario::before` en la sección 9 del CSS).
    //
    // La palabra, el color y las tres preguntas que dirigen el dibujo las
    // contesta HPUtil, que es de donde las pide también la ficha del marcador:
    // el mismo trabajo no puede llamarse "⏳" en una pestaña y "sin cupo" en la
    // otra, ni estar «activo» en una y no en la otra. Lo único que agrega la
    // cola es su propio juicio sobre un trabajo terminado —si el clip entró al
    // timeline o quedó afuera—, que es lo que `needsPlacing` sabe.
    //
    // Las veintiséis interrogaciones al estado que tenía este cuerpo son esta
    // línea y nada más. `estado.terminado` era `j.status === "done"` seis veces
    // bajo cuatro nombres distintos, dos de ellos a diez líneas de distancia.
    var estado = HPUtil.estadoDeTrabajo(j.status, HPQueue.needsPlacing(j));
    var puedeAbrir = estado.terminado && (j.kind === "generate" || j.kind === "feedback");
    var row = document.createElement(puedeAbrir ? "details" : "div");
    // `is-<status>` se conserva además de la clase de estado: es el estado
    // CRUDO de la máquina y lo leen la maqueta y los tests; `es-<algo>` es lo
    // que el editor tiene que distinguir de un vistazo, que son cinco cosas y
    // no siete.
    row.className = "queue-job hp-tarjeta " + estado.clase + " is-" + j.status;
    // Nodos de este job que se refrescan solos (reloj, estado del modelo,
    // barra). Se llena abajo y solo se registra si el job está activo.
    var liveJob = { job: j, clk: null, clkTxt: null, act: null, fill: null };
    var line = document.createElement(puedeAbrir ? "summary" : "div");
    line.className = "qj-line hp-sumario" + (puedeAbrir ? "" : " sin-abrir");
    // El nombre del clip terminado lleva al timeline y nada más: abre su
    // secuencia y para el cursor donde está el recurso, para poder verlo.
    // Antes también cambiaba a la pestaña Marcadores y la recargaba, y eso
    // era un viaje de ida: por mirar un clip de cinco segundos se perdía la
    // cola. A Marcadores se sigue llegando con "Editar HTML".
    //
    // Va por `nombreQueLleva` porque lo clickeable tiene que ser las PALABRAS
    // y no la caja elástica: el nombre se lleva todo el hueco del encabezado,
    // así que con el manejador en la caja el clic en ese vacío no abría la
    // ronda de feedback y encima movía el cursor de Premiere. El mismo bug
    // estaba en Corrections; el motivo entero está en `HPUtil.nombreQueLleva`.
    var top = HPUtil.nombreQueLleva(j.label, {
      clase: "qj-title",
      titulo: !estado.terminado ? "" :
        "Ver en el timeline: abre “" + j.seqName + "” y lleva el cursor a este punto",
      alHacerClic: !estado.terminado ? null : (function (job) {
        return function () { deps.showJobInTimeline(job); };
      })(j)
    });
    // El estado se fue del título: era un glifo pegado adelante (✓ ✎ ▶ ◔ •
    // ⏳ ⚠) más el color del propio título, o sea el estado dicho dos veces en
    // el único lugar donde estorba —el nombre es lo que se lee para saber DE
    // QUÉ trabajo es la fila—. Ahora va en su pastilla, a la derecha, con
    // palabras (ver `HPQueue.estadoDe`).
    line.appendChild(top);
    // El cronómetro de la corrida, al lado del nombre: es el dato que faltaba
    // para saber si un marcador que lleva tres minutos es normal o se colgó.
    // Lo actualiza tickLive. Va en la mitad IZQUIERDA del encabezado, que es
    // la de identificación, porque es del trabajo que está pasando ahora.
    if (estado.activo) {
      var clk = document.createElement("span"); clk.className = "qj-clock hp-dato";
      clk.setAttribute("data-hidden", "true");
      clk.title = "Lo que lleva este trabajo desde que arrancó.";
      clk.appendChild(HPIconos.el("reloj"));
      var clkTxt = document.createElement("span");
      clk.appendChild(clkTxt);
      line.appendChild(clk);
      liveJob.clk = clk;
      liveJob.clkTxt = clkTxt;
    } else if (estado.terminado && tiempoTotal(j) > 0) {
      // El mismo reloj, en el mismo lugar, cuando ya terminó: lo que TARDÓ.
      // Es el único dato del detalle que se queda arriba, y lo pidió el editor
      // así —"dejemos en el cabezal solo el tiempo al lado del botón de
      // Feedback"—. Tiene sentido que sea ése: con la fila plegada, el tiempo
      // es lo que se compara entre marcadores para decidir el siguiente; la
      // versión y los tokens se miran de a uno, y para eso ya hay que abrir.
      var hecho = document.createElement("span"); hecho.className = "qj-clock hp-dato";
      hecho.title = "Lo que tardó este recurso de punta a punta. El desglose está adentro.";
      hecho.appendChild(HPIconos.el("reloj"));
      var hechoTxt = document.createElement("span");
      hechoTxt.textContent = HPUtil.fmtDuration(tiempoTotal(j) / 1000);
      hecho.appendChild(hechoTxt);
      line.appendChild(hecho);
    }

    // ── Las acciones, en el encabezado ─────────────────────────────
    // Acá sí van arriba y no en el pie, y es la diferencia honesta con la
    // ficha de un marcador: se aprietan con la fila PLEGADA (reintentar el
    // que falló, colocar el que no entró, reordenar los que esperan), sin
    // abrir nada.
    var ctrl = document.createElement("span"); ctrl.className = "qj-ctrls";
    if (j.status === "queued") {
      if (sitio.puesto > 0) ctrl.appendChild(iconBtn("", "Priorizar este marcador", function () { HPQueue.moveJob(j.id, -1); }, "subir"));
      if (sitio.puesto < sitio.enCola - 1) ctrl.appendChild(iconBtn("", "Posponer este marcador", function () { HPQueue.moveJob(j.id, 1); }, "bajar"));
      ctrl.appendChild(iconBtn("", "Quitar de la cola", function () { HPQueue.remove(j.id); }, "quitar"));
    } else if (j.status === "waiting") {
      // REACTIVAR no es reintentar: este trabajo no falló, se quedó sin cupo
      // y está en pausa. Vuelve a la cola tal como estaba, y por eso su
      // dibujo es la flecha que entra a la lista (ver cep/js/iconos.js).
      var rb = iconBtn("Reactivar", "Reencolar este marcador (cuando tengas tokens de nuevo)",
        (function (id) { return function () { HPQueue.reactivate(id); }; })(j.id), "reactivar");
      rb.className = "qbtn qbtn-react";
      ctrl.appendChild(rb);
      ctrl.appendChild(iconBtn("", "Descartar", (function (id) { return function () { HPQueue.remove(id); }; })(j.id), "quitar"));
    } else if (estado.activo) {
      // Job activo: se puede cancelar (lo en vuelo termina en 2º plano y se descarta).
      ctrl.appendChild(iconBtn("cancelar", "Cancelar este marcador (para rehacerlo). Lo que esté en vuelo se descarta.",
        (function (id) { return function () { HPQueue.cancelJob(id); }; })(j.id), "quitar"));
    } else if (j.status === "error") {
      // REINTENTAR es la tercera de la familia y tiene su propio dibujo: se
      // vuelve a intentar LO MISMO, desde donde se cayó (si el modelo ya
      // había terminado, sólo el render). No es «desde cero», que tira el
      // diseño, ni «reactivar», que es salir de una pausa.
      var retryBtn = iconBtn("Reintentar", "Volver a intentar este marcador desde el punto donde falló",
        (function (id) { return function () { HPQueue.retry(id); }; })(j.id), "reintentar");
      retryBtn.className = "qbtn qbtn-react";
      ctrl.appendChild(retryBtn);
      ctrl.appendChild(iconBtn("", "Descartar", (function (id) { return function () { HPQueue.remove(id); }; })(j.id), "quitar"));
    } else if (estado.terminado) {
      // (El "Ver" es clic en el nombre del clip — ver arriba.)
      // Render hecho y clip afuera: lo único que falta es colocarlo, y va
      // primero y destacado. Antes acá solo estaba ✎ Feedback, que gasta
      // otra generación entera para repetir un .mov que ya está en disco.
      if (HPQueue.needsPlacing(j)) {
        var pb = iconBtn("Colocar",
          "El render ya está hecho: colocar el clip en “" + j.seqName + "” sin volver a generar. " +
          "Si falló porque estabas en otro proyecto o la secuencia estaba cerrada, abrilos y probá de nuevo.",
          (function (id) { return function () { HPQueue.placeAgain(id); }; })(j.id), "colocar");
        pb.className = "qbtn qbtn-react"; ctrl.appendChild(pb);
      }
      if (puedeAbrir) {
        // Este botón es el que ABRE la ronda, o sea que hace lo mismo que el
        // chevron. Se queda porque le pone NOMBRE a lo que hay adentro, que
        // es feedback y no «más detalles». Y es el ÚNICO que queda arriba en
        // un trabajo terminado: los otros dos (Editar HTML, Limpiar previas)
        // se fueron al cuerpo. El criterio es el que pidió el editor y se
        // sostiene solo: arriba va lo que se aprieta MIENTRAS se barre la
        // cola con la vista, y eso es «dar feedback». Editar el HTML y
        // limpiar versiones son decisiones que se toman mirando este recurso
        // de cerca, o sea con la fila ya abierta.
        ctrl.appendChild(iconBtn("Feedback", "Dar feedback y regenerar (mantiene el puesto en la cola)",
          (function (id) { return function () {
            var willOpen = !feedbackOpen[id];
            feedbackOpen = {}; // solo una caja de feedback abierta a la vez
            if (willOpen) feedbackOpen[id] = true;
            render(HPQueue.jobs());
          }; })(j.id), "comentar"));
      }
    }
    if (ctrl.childNodes.length) line.appendChild(ctrl);

    // ── Y la mitad derecha: la plata y el estado ───────────────────
    //
    // Y NO el tramo del timeline, que sí llevan las otras dos listas. Acá no
    // hace falta y se paga caro: la fila ya lleva sus acciones en el
    // encabezado, así que un dato más de 70 px la manda a un renglón de más
    // —medido: la fila en espera pasa de 33 a 57 px, y con diez trabajos eso
    // son 240 px de la pantalla que esta pestaña necesita para poder
    // barrerse—. En Marcadores el tramo dice dónde va a caer el recurso que
    // estás escribiendo, y en Corrections es EL dato (es lo que reemplaza al
    // marcador que ya no está); acá lo que se mira es si avanza y cuánto sale.
    var der = document.createElement("span"); der.className = "hp-sumario-der";
    // Lo que cuesta, en el mismo lugar del encabezado donde la ficha de un
    // marcador dice lo que va a costar: antes, el estimado del prompt; ya
    // terminado, lo que de verdad se gastó. Es el mismo dato en sus dos
    // tiempos, y el estimado lo completa `renderQueueEstimate` cuando el
    // motor contesta (ver `estNodes`).
    //
    // Salvo cuando ya TERMINÓ: ahí la plata baja al cuerpo junto con el resto
    // del detalle. Lo que se gastó es un dato para revisar después, no para
    // barrer la cola, y el encabezado del terminado quedó con lo que el editor
    // pidió: el nombre, el tiempo y el estado.
    var plata = document.createElement("span"); plata.className = "marker-estimate hp-dato";
    plata.setAttribute("data-hidden", "true");
    pintarPlata(plata, j);
    if (!estado.terminado) der.appendChild(plata);
    if (estado.pendiente) estNodes.push({ job: j, el: plata });
    var pastilla = document.createElement("span"); pastilla.className = "hp-estado";
    pastilla.textContent = estado.palabra;
    pastilla.title = estado.titulo;
    der.appendChild(pastilla);
    line.appendChild(der);

    // ── Y el renglón de abajo ──────────────────────────────────────
    //
    // Mientras el trabajo AVANZA, el mensaje, lo que el modelo está haciendo y
    // la barra van adentro del `<summary>`: un `<details>` esconde todo lo que
    // viene después de su resumen, y el progreso es justo lo que hay que poder
    // leer sin abrir nada.
    //
    // Cuando ya terminó, al revés, y lo pidió el editor: «los que ya están
    // listos, que mejor esté replegado como los que están en cola. Si
    // despliego, ahí sí que me salga la información completa de versión,
    // subida y bajada». Tenía razón, y el motivo se ve al mirar la lista: con
    // el detalle arriba, la fila terminada mide 53 px contra los 31 de una en
    // espera, o sea que los trabajos ya resueltos —que son los que se
    // acumulan— se quedan con la pantalla que necesitan los que faltan. Y ese
    // renglón sólo se lee cuando uno va a mirar ESE recurso, que es cuando
    // abre la fila.
    var msg = document.createElement("div"); msg.className = "qj-msg";
    // Un job en cola mientras se prepara el contexto de SU secuencia no está
    // simplemente "en cola": espera el transcript. Decirlo evita que parezca
    // que la cola se colgó (el progreso está en el cartel de arriba).
    if (j.status === "queued" && sitio.prepSeq && j.seqName === sitio.prepSeq) {
      msg.textContent = "Esperando el transcript de la secuencia…";
      msg.classList.add("qj-msg-waiting");
      line.appendChild(msg);
    } else if (estado.terminado) {
      msg.textContent = j.msg || j.status;
    } else {
      // Y si el mensaje no dice más que la pastilla («En cola…» contra «en
      // cola»), no se dibuja: son 19 px por fila para repetir la palabra que
      // está tres centímetros a la izquierda, y en una cola de diez trabajos en
      // espera eso es un tercio de la pantalla. Se compara el texto normalizado
      // en vez de un constante para que no haya dos lugares que mantener: el
      // día que HPQueue cambie la frase, esto sigue contestando bien.
      msg.textContent = j.msg || j.status;
      if (!mismaCosa(msg.textContent, estado.palabra)) line.appendChild(msg);
    }
    // Lo que el modelo está haciendo AHORA, debajo de la etapa. Es la línea
    // que resuelve el "no sé si avanza": la etapa ("Diseñando la animación
    // con X…") se escribe una vez y no cambia en varios minutos.
    if (estado.activo) {
      var act = document.createElement("div"); act.className = "qj-act";
      act.setAttribute("data-hidden", "true");
      line.appendChild(act);
      liveJob.act = act;
    }
    if (j.status === "running" || j.status === "modeling") {
      var bar = document.createElement("div"); bar.className = "hp-bar";
      var fill = document.createElement("div"); fill.className = "hp-bar-fill"; fill.style.width = (j.pct || 0) + "%"; bar.appendChild(fill);
      line.appendChild(bar);
      liveJob.fill = fill;
    }
    row.appendChild(line);

    // ── El cuerpo del terminado: lo que se lee cuando se abre ──────
    //
    // Lo que bajó del encabezado: el renglón de detalle (versión, tokens de
    // subida y bajada, el desglose de tiempos), lo que salió, y las dos
    // acciones que se deciden mirando este recurso de cerca.
    //
    // Va ANTES de la ronda de feedback y no después, porque es lo que se lee
    // para decidir si hace falta feedback. Y existe aunque la ronda esté
    // cerrada: abrir con el chevron ahora tiene algo que mostrar por sí solo.
    if (estado.terminado) {
      var detalle = document.createElement("div");
      detalle.className = "qj-detalle";
      detalle.appendChild(msg);
      if (plata.getAttribute("data-hidden") !== "true") {
        var fila = document.createElement("div");
        fila.className = "qj-detalle-datos";
        fila.appendChild(plata);
        detalle.appendChild(fila);
      }
      var mas = document.createElement("div");
      mas.className = "qj-ctrls qj-detalle-acciones";
      if (puedeAbrir) {
        mas.appendChild(iconBtn("Editar HTML", "Editar el HTML de este marcador y renderizarlo de nuevo (en la pestaña Marcadores)",
          (function (job) { return function () { deps.goToJobMarker(job, true); }; })(j), "codigo"));
      }
      // Limpiar las versiones previas de ESTE recurso, cuando el editor ya
      // quedó conforme. No se ofrece en una v1 (no hay nada anterior); si no
      // sabemos la versión —un job que quedó de otra sesión— se ofrece igual
      // y el detalle de la confirmación lo dice.
      if (!(j.version > 0 && j.version < 2)) {
        mas.appendChild(iconBtn("Limpiar previas",
          "Borra las versiones anteriores de este recurso: del disco y de las secuencias donde estén. " +
          "Conserva esta última y los HTMLs.",
          (function (job) { return function () { cleanJobPrevious(job); }; })(j), "limpiar"));
      }
      if (mas.childNodes.length) detalle.appendChild(mas);
      row.appendChild(detalle);
    }

    // La ronda de feedback, adentro de la tarjeta (solo en jobs terminados y
    // si el editor la abrió). El `<details>` la esconde solo: no hace falta
    // no dibujarla, y dibujarla siempre costaría un campo, una tira de
    // miniaturas y un micrófono por fila terminada.
    if (puedeAbrir) {
      if (feedbackOpen[j.id]) {
        row.open = true;
        row.appendChild(buildFeedbackBox(j));
      }
      // Abrir con el chevron tiene que valer lo mismo que abrir con el botón:
      // la cola se redibuja sola muy seguido y el estado de apertura vive en
      // `feedbackOpen`, así que el toggle nativo tiene que escribirlo ahí.
      row.addEventListener("toggle", (function (job, tarjeta) {
        return function () {
          if (!!feedbackOpen[job.id] === !!tarjeta.open) return;
          if (tarjeta.open) feedbackOpen = {}; // una sola ronda abierta a la vez
          feedbackOpen[job.id] = !!tarjeta.open;
          render(HPQueue.jobs());
        };
      })(j, row));
    }
    if (estado.activo) liveRows.push(liveJob);
    return row;
  }

  /**
   * Qué secuencia está abierta, cuántos trabajos son de OTRA, y si el filtro «ver
   * solo esta secuencia» está puesto.
   *
   * El filtro sólo existe cuando hay algo que filtrar: con una sola clase en la
   * cola sería una casilla que no cambia nada. Y la cuenta de las otras se usa dos
   * veces —para decidir si ofrecerlo y para decir cuántas quedaron ocultas—, así
   * que se hace una sola vez y acá.
   */
  function deOtrasSecuencias(jobs) {
    var actual = (deps && deps.currentSequence) ? String(deps.currentSequence() || "") : "";
    var otras = 0;
    for (var i = 0; i < jobs.length; i++) if (jobs[i].seqName !== actual) otras++;
    return {
      actual: actual, otras: otras,
      ofrecible: !!(actual && otras > 0),
      filtrando: !!(actual && otras > 0 && onlyCurrentSeq())
    };
  }

  /**
   * La CABECERA de la pestaña: la cuenta de lo pendiente y los botones que operan
   * sobre la cola entera (filtrar, reactivar todo, pausar/arrancar, limpiar,
   * vaciar).
   *
   * Es de la cola COMPLETA y no de lo que se ve: los contadores y «reactivar
   * todos» siguen siendo de todo aunque el filtro esconda media lista. Filtrar es
   * dejar de dibujar, no cambiar la cola.
   */
  function cabeceraDeCola(pending, waiting, filtro) {
    var head = document.createElement("div"); head.className = "queue-head";
    var title = document.createElement("span");
    title.textContent = "Cola" + (pending ? " · " + pending + " en proceso/espera" : " · sin pendientes")
      + (waiting ? " · " + waiting + " esperando tokens ⏳" : "");
    head.appendChild(title);
    // Filtro "ver solo esta secuencia". La cola junta varias clases a propósito
    // —así se deja trabajando y se va— pero cuando estás sentado en una, lo de
    // las otras es ruido.
    if (filtro.ofrecible) {
      var lab = document.createElement("label"); lab.className = "queue-filter";
      lab.title = "Muestra solo los marcadores de “" + filtro.actual + "”. No cambia la cola: " +
        "los de las otras secuencias siguen ahí y se procesan igual.";
      var cbx = document.createElement("input"); cbx.type = "checkbox"; cbx.checked = filtro.filtrando;
      cbx.addEventListener("change", function () {
        setOnlyCurrentSeq(cbx.checked);
        render(HPQueue.jobs());
      });
      lab.appendChild(cbx);
      lab.appendChild(document.createTextNode(" ver solo esta secuencia"));
      head.appendChild(lab);
    }
    // Reactivar todos: aparece cuando hay jobs pausados por falta de tokens.
    if (waiting) {
      var reactAll = document.createElement("button"); reactAll.type = "button"; reactAll.className = "queue-react";
      reactAll.textContent = "Reactivar todos (" + waiting + ")";
      HPIconos.enBoton(reactAll, "reactivar");
      reactAll.title = "Reencola todo lo que quedó sin tokens (usalo cuando se reinicie tu uso)";
      reactAll.addEventListener("click", function () { HPQueue.reactivateAll(); });
      head.appendChild(reactAll);
    }
    // Toggle Pausar ⇄ Reanudar. Si está pausada, SIEMPRE se muestra "Reanudar"
    // (haya o no un job activo) — antes quedaba trabado sin opción de reanudar.
    //
    // "Reanudar" e "Iniciar cola" llevan EL MISMO dibujo, y eso es a propósito:
    // las dos ponen la cola a andar, y dos triángulos distintos para eso serían
    // dos cosas que aprender (es la misma decisión que `generar` y `encolar`,
    // que se repiten entre la ficha y la barra de arriba).
    if (HPQueue.isPaused()) {
      var resumeBtn = document.createElement("button"); resumeBtn.type = "button"; resumeBtn.className = "queue-start";
      resumeBtn.textContent = "Reanudar";
      HPIconos.enBoton(resumeBtn, "reanudar");
      resumeBtn.title = "Reanuda la cola (sigue procesando los marcadores pendientes)";
      resumeBtn.addEventListener("click", function () { HPQueue.start(); });
      head.appendChild(resumeBtn);
    } else if (HPQueue.hasActive()) {
      var pauseBtn = document.createElement("button"); pauseBtn.type = "button"; pauseBtn.className = "queue-clear";
      pauseBtn.textContent = "pausar";
      HPIconos.enBoton(pauseBtn, "pausar");
      pauseBtn.title = "Pausa la cola: no arranca nuevos marcadores (el que está corriendo termina su etapa). Después reanudás.";
      pauseBtn.addEventListener("click", function () { HPQueue.pause(); });
      head.appendChild(pauseBtn);
    } else if (HPQueue.hasQueued()) {
      var startBtn = document.createElement("button"); startBtn.type = "button"; startBtn.className = "queue-start";
      startBtn.textContent = "Iniciar cola";
      HPIconos.enBoton(startBtn, "reanudar");
      startBtn.title = "Empieza a procesar los marcadores en espera, uno a la vez";
      startBtn.addEventListener("click", function () { HPQueue.start(); });
      head.appendChild(startBtn);
    }
    var clr = document.createElement("button"); clr.type = "button"; clr.className = "queue-clear";
    clr.textContent = "limpiar terminados";
    clr.title = "Quita de la lista los jobs terminados y con error (conserva en cola, en proceso y los que esperan tokens)";
    clr.addEventListener("click", function () { HPQueue.clearFinished(); });
    head.appendChild(clr);
    // Vaciar cola: para TODO (incluido lo activo) y limpia la lista, para rehacer.
    var wipe = document.createElement("button"); wipe.type = "button"; wipe.className = "queue-clear is-danger";
    wipe.textContent = "vaciar cola";
    // Vaciar NO borra archivos: saca todo de la lista. De ahí que su dibujo sea
    // la lista con una ✕ —el contrario exacto de `encolar`, que es la lista con
    // un +— y no el cesto, que en esta pestaña ya quiere decir «borro del disco»
    // (limpiar versiones viejas).
    HPIconos.enBoton(wipe, "vaciar");
    wipe.title = "Para y quita TODOS los marcadores de la cola (incluido el que está corriendo) para rehacer el proceso.";
    wipe.addEventListener("click", function () {
      var n = HPQueue.jobs().length;
      HPWidgets.confirmOverlay("Vaciar la cola", function (body) {
        var p = document.createElement("p");
        p.textContent = "Se van a quitar los " + n + " marcador(es) de la cola, incluido el que esté procesando. " +
          "Lo que ya está en vuelo (IA o render) termina en segundo plano pero su resultado se descarta. No borra archivos ya generados en disco.";
        body.appendChild(p);
      }, "Vaciar (" + n + ")", function () { HPQueue.clearAll(); deps.setOutput("Cola vaciada.", false); });
    });
    head.appendChild(wipe);
    // Limpiar versiones viejas: borra del disco los videos de versiones NO-últimas
    // de cada marcador (conserva HTMLs). Corre sobre todas las secuencias de la cola.
    var cleanBtn = document.createElement("button"); cleanBtn.type = "button"; cleanBtn.className = "queue-clear";
    cleanBtn.textContent = "limpiar versiones viejas";
    // El cesto: esto SÍ borra archivos del disco. Es el mismo dibujo que el
    // "Limpiar previas" de cada trabajo porque es la misma acción con otro
    // alcance (ese, un recurso; éste, todas las secuencias de la cola).
    HPIconos.enBoton(cleanBtn, "limpiar");
    cleanBtn.title = "Borra del disco los videos de versiones anteriores de cada marcador (deja solo la última). Conserva los HTMLs y el historial.";
    cleanBtn.addEventListener("click", function () { cleanOldVersions(); });
    head.appendChild(cleanBtn);
    return head;
  }

  /**
   * El RÓTULO de una secuencia: su nombre, si ya tiene transcript y objetivo, y
   * las flechas que mueven la clase entera dentro de la cola.
   *
   * El estado del contexto va acá y no en cada trabajo porque es de la secuencia:
   * los diez marcadores de una clase esperan el mismo transcript, y decirlo diez
   * veces serían diez renglones para un solo hecho.
   */
  function rotuloDeSecuencia(g, gi, cuantasSecuencias, enCola, prepSeq) {
    var gh = document.createElement("div"); gh.className = "queue-seq";
    var gname = document.createElement("span"); gname.className = "qs-name"; gname.textContent = g.seqName;
    gh.appendChild(gname);
    // Contexto de la secuencia: saber de un vistazo si ya tiene transcript y
    // objetivo, o si va a haber que transcribirla antes de generar.
    var ctx = (deps && deps.sequenceContext) ? deps.sequenceContext(g.seqName) : null;
    if (ctx) {
      var tag = document.createElement("span"); tag.className = "qs-ctx";
      if (ctx.hasTranscript && ctx.hasObjective) {
        tag.classList.add("is-ready");
        tag.textContent = "✓ transcript + objetivo";
        tag.title = "Esta secuencia ya tiene transcript y objetivo: se genera directo, sin transcribir.";
      } else if (ctx.hasTranscript) {
        tag.classList.add("is-ready");
        tag.textContent = "✓ transcript · falta objetivo";
        tag.title = "Ya tiene transcript. El objetivo se saca solo antes de generar.";
      } else if (g.seqName === prepSeq) {
        tag.classList.add("is-working");
        tag.textContent = "◔ transcribiendo…";
        tag.title = "Se está transcribiendo ahora (mirá el progreso arriba).";
      } else {
        tag.classList.add("is-missing");
        tag.textContent = "falta transcript";
        tag.title = "No tiene transcript: antes de generar se transcribe y se saca el objetivo.";
      }
      gh.appendChild(tag);
    }
    var ctrls = document.createElement("span"); ctrls.className = "qs-ctrls";
    // Reordenar la secuencia completa (solo si tiene jobs en cola).
    if (enCola > 0) {
      if (gi > 0) ctrls.appendChild(iconBtn("", "Subir esta secuencia", function () { HPQueue.moveSeq(g.seqName, -1); }, "subir"));
      if (gi < cuantasSecuencias - 1) ctrls.appendChild(iconBtn("", "Bajar esta secuencia", function () { HPQueue.moveSeq(g.seqName, 1); }, "bajar"));
    }
    if (ctrls.childNodes.length) gh.appendChild(ctrls);
    return gh;
  }

  // Panel de cola global: agrupado por secuencia, con reordenamiento
  // (secuencia arriba/abajo y marcador arriba/abajo dentro de su secuencia).
  function render(jobs) {
    var panel = document.getElementById("queue-panel");
    if (!panel) return;
    var prepSeq = (deps && deps.preparingSequence) ? deps.preparingSequence() : null;
    var scroller = document.getElementById("view-queue");
    var savedScroll = scroller ? scroller.scrollTop : 0;
    var pending = 0, waiting = 0, i;
    for (i = 0; i < jobs.length; i++) {
      if (HPQueue.isPending(jobs[i].status)) pending++;
      else if (jobs[i].status === "waiting") waiting++;
    }
    // Badge de la pestaña Cola (incluye los que esperan tokens para que se noten).
    var badge = document.getElementById("tab-queue-count");
    if (badge) {
      var total = pending + waiting;
      if (total) {
        badge.textContent = waiting ? (total + " ⏳") : total;
        badge.setAttribute("data-hidden", "false");
        badge.className = "tab-badge" + (waiting ? " is-waiting" : "");
      } else {
        badge.setAttribute("data-hidden", "true");
        badge.className = "tab-badge";
      }
    }
    // Los nodos vivos del dibujo anterior ya no existen: se re-anotan abajo.
    liveRows = [];
    estNodes = [];
    if (!jobs.length) {
      panel.innerHTML = '<div class="queue-empty">La cola está vacía. Encolá marcadores con “Enviar a la cola” o arrancá con “Generar”.</div>';
      syncLiveClock();
      return;
    }
    panel.innerHTML = "";

    var filtro = deOtrasSecuencias(jobs);
    panel.appendChild(cabeceraDeCola(pending, waiting, filtro));

    var visibles = jobs;
    if (filtro.filtrando) {
      visibles = jobs.filter(function (j) { return j.seqName === filtro.actual; });
      var nota = document.createElement("div"); nota.className = "queue-filter-note";
      nota.textContent = visibles.length
        ? "Filtrado por “" + filtro.actual + "” · " + filtro.otras + " marcador(es) de otras secuencias ocultos"
        : "No hay nada de “" + filtro.actual + "” en la cola · " + filtro.otras + " marcador(es) de otras secuencias ocultos";
      panel.appendChild(nota);
    }

    // Agrupar por secuencia preservando el orden de proceso.
    var groups = [], map = {};
    for (i = 0; i < visibles.length; i++) {
      var jj = visibles[i];
      if (!map[jj.seqName]) { map[jj.seqName] = { seqName: jj.seqName, jobs: [] }; groups.push(map[jj.seqName]); }
      map[jj.seqName].jobs.push(jj);
    }

    groups.forEach(function (g, gi) {
      // Cuántos de esta secuencia ESPERAN: lo miran el rótulo (para ofrecer
      // mover la clase entera) y cada tarjeta (para ofrecer moverse dentro de
      // ella). Sólo los `queued` se pueden mover de lugar.
      var enCola = g.jobs.filter(function (j) { return j.status === "queued"; }).length;
      panel.appendChild(rotuloDeSecuencia(g, gi, groups.length, enCola, prepSeq));

      // Las tarjetas de la secuencia van en su propia lista, que es la que pone
      // la separación: `hp-lista` es el mismo `gap` que separa las fichas de
      // marcador y las filas de Corrections (sección 9 del CSS). El panel entero
      // no puede ser la lista porque adentro viven además la cabecera, los
      // rótulos de secuencia y el pie del estimado.
      var lista = document.createElement("div");
      lista.className = "hp-lista queue-lista";
      panel.appendChild(lista);

      var puesto = 0;
      g.jobs.forEach(function (j) {
        lista.appendChild(tarjetaDeTrabajo(j, {
          prepSeq: prepSeq,
          puesto: j.status === "queued" ? puesto++ : -1,
          enCola: enCola
        }));
      });
    });
    renderQueueEstimate(panel, jobs);
    syncLiveClock();
    // Preservar el scroll de la vista de cola (se refresca seguido durante el proceso).
    if (scroller) scroller.scrollTop = savedScroll;
  }

  global.HPQueueView = {
    /** Cablea las dependencias del panel. Llamar UNA vez antes de renderizar. */
    init: function (d) { deps = d; },
    render: render,
    /**
     * Línea "qué está haciendo ahora" de un job activo ("" si no hay nada que
     * decir). La comparte la tarjeta del marcador (main.js), que muestra lo
     * mismo en otro lugar: dos redacciones del mismo estado envejecerían
     * distinto.
     */
    activityLine: liveDetail
  };
})(typeof window !== "undefined" ? window : this);
