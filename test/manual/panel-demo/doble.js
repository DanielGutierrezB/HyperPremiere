/**
 * doble.js — el doble de Premiere y del motor Node para el panel de demostración.
 *
 * Todo el panel (cep/) habla con el mundo por DOS puertas y nada más:
 *   · ExtendScript, vía `window.__adobe_cep__.evalScript("hp_…()")`  → cep/js/host-client.js
 *   · el motor Node, vía `window.cep_node.require(".../bridge/engine.js")` → cep/js/engine-client.js
 *
 * Este archivo se carga ANTES que CSInterface.js y pone las dos puertas falsas.
 * Con eso, el panel REAL —el mismo HTML, el mismo CSS, el mismo JS— se dibuja
 * solo, creyendo que hay un proyecto abierto con marcadores, cola y todo.
 * No se toca ni una línea de cep/, y por eso lo que se ve acá es lo que se ve
 * en Premiere.
 *
 * Los datos están en datos.js. Acá está el cableado.
 *
 * NO viaja al ZXP: el firmador empaqueta cep/ + bridge/ y nada más
 * (scripts/sign-zxp.js).
 */
(function (global) {
  "use strict";

  var D = global.HPDemoDatos;

  // ── Escenarios por URL (?e=vacio,whisper,…) ───────────────────────────
  var escenarios = {};
  (function () {
    var q = String(global.location.search || "");
    var m = /[?&]e=([^&]*)/.exec(q);
    if (!m) return;
    decodeURIComponent(m[1]).split(",").forEach(function (n) {
      n = n.trim(); if (n) escenarios[n] = true;
    });
  })();
  function esc(n) { return !!escenarios[n]; }

  if (esc("vacio")) {
    D.marcadores = [];
    D.marcadoresFrameIo = [];
    D.cola = [];
    D.transcript = [];
    D.objetivo = "";
    D.promptGeneral.proyecto = "";
    D.imagenesGenerales = [];
    D.recursosGenerales = [];
    D.correcciones.recursos = [];
    D.correcciones.fuentes = [];
    D.uso = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, costGenerations: 0, costInputTokens: 0, generations: 0, rule: 2, legacyMix: false };
  }
  // El cartel amarillo de "estás en otra secuencia" no lo dispara el arranque
  // sino el vigía (seq-watch), cuando ve que Premiere se movió DESPUÉS de que
  // el panel cargó. Por eso se cambia unos segundos más tarde, no de entrada.
  if (esc("otra-secuencia")) {
    setTimeout(function () { D.secuenciaEnPremiere = D.secuenciaOtra; }, 4000);
  }
  // Nunca se generó con este proveedor: ⚙ tiene que decirlo en vez de mostrar
  // el promedio de otro. Es el estado normal recién instalado el panel.
  if (esc("sin-medir")) D.uso.porProveedor = {};
  // Con API key el CLI de Claude va por la API, y ahí el 1M sí es real.
  if (esc("api-key")) {
    D.sesionClaude = {
      estado: "con-sesion", metodo: "api_key",
      resumen: "✓ Sesión de Claude activa · con una API key del entorno",
      detalle: "claude 2.1.201 · /Users/dani/.local/bin/claude · authMethod: api_key"
    };
  }
  if (esc("whisper")) D.whisper = { ok: true, available: false, canInstall: true, installLabel: "mlx-whisper en un entorno propio", installMB: 260 };
  // El micrófono elegido en ⚙ ya no está enchufado: la fila lo dice en amarillo
  // y el dictado cae al del sistema.
  if (esc("mic-perdido")) D.config.microfono = "Interfaz Focusrite Scarlett 2i2";
  // La prueba de micrófono termina mal: el dispositivo abre pero entrega ceros.
  if (esc("mic-mudo")) {
    D.microfonos.niveles = D.microfonos.niveles.map(function () { return -100; });
    D.microfonos.veredicto = {
      estado: "silencio-digital",
      titulo: "«MacBook Pro Microphone» (índice 2) entrega audio, pero es silencio digital: 7.0 s de muestras y todas en cero exacto.",
      detalle: "El dispositivo abrió y no está mandando señal. Casi siempre es el permiso de micrófono de macOS, y tiene una trampa: " +
        "el permiso lo pide PREMIERE, no el panel, así que el diálogo del sistema dice “Adobe Premiere Pro 2026”, y si alguna vez le dijiste que no, " +
        "macOS no vuelve a preguntar. Andá a Ajustes del Sistema → Privacidad y seguridad → Micrófono, prendé Adobe Premiere Pro y reiniciá Premiere. " +
        "También pasa si el micrófono lo tiene tomado otra app, o si es un dispositivo virtual (Zoom, Steam, OBS…) que figura como entrada pero no es un micrófono: elegí otro en ⚙ → Micrófono."
    };
  }
  // En esta máquina no se puede dictar (Windows, sin ffmpeg, sin el Whisper de
  // Apple Silicon). El desplegable de micrófono del ENCABEZADO no se dibuja: es
  // un control de una función que no corre. ⚙ y el 🎙 de cada campo siguen
  // diciendo por qué.
  if (esc("sin-dictado")) D.dictado = { disponible: false, motivo: "El dictado por voz todavía es solo para Mac. La captura usa avfoundation, que es el sistema de audio de macOS, y el equivalente en Windows (dshow) no está probado. Escribí la instrucción a mano por ahora." };
  // Un dictado ANDANDO: cambiar de micrófono no lo toca, y la fila de ⚙ lo dice.
  if (esc("dictando")) D.dictado = { enCurso: "marcador:Marcador 3" };

  // ── localStorage en memoria ───────────────────────────────────────────
  // El panel persiste todo ahí. Se reemplaza por uno en memoria para que cada
  // recarga arranque limpia y sembrada, y para no depender de que el navegador
  // dé almacenamiento a una página file://.
  (function () {
    var mem = {};
    var fake = {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
      setItem: function (k, v) { mem[k] = String(v); },
      removeItem: function (k) { delete mem[k]; },
      clear: function () { mem = {}; },
      key: function (i) { return Object.keys(mem)[i] || null; }
    };
    Object.defineProperty(fake, "length", { get: function () { return Object.keys(mem).length; } });
    try {
      Object.defineProperty(global, "localStorage", { value: fake, configurable: true, writable: true });
    } catch (e) {
      global.localStorage = fake;
    }
    // Estas tres las leen queue.js y main.js AL CARGARSE, antes de que haya
    // proyecto: si se sembraran junto con el resto llegarían tarde y la cola
    // diría "aprox." en vez de dar minutos.
    fake.setItem("hyperpremiere::session-usage", JSON.stringify(D.uso));
    fake.setItem("hyperpremiere::timing-v2", JSON.stringify(D.calibracion));
    fake.setItem("hyperpremiere::model-concurrency", String(D.config.concurrencia));
  })();

  // ── Imágenes falsas dibujadas al vuelo ────────────────────────────────
  // Un PNG con el nombre del archivo escrito encima: se ve como una referencia
  // de verdad en la miniatura y no hay que versionar binarios.
  function pngFalso(etiqueta, color, fondo) {
    try {
      var c = document.createElement("canvas");
      c.width = 320; c.height = 180;
      var x = c.getContext("2d");
      x.fillStyle = fondo || "#12161d";
      x.fillRect(0, 0, 320, 180);
      x.strokeStyle = color || "#35e0d6";
      x.lineWidth = 2;
      x.strokeRect(10, 10, 300, 160);
      x.fillStyle = color || "#35e0d6";
      x.globalAlpha = 0.18;
      x.fillRect(26, 100, 180, 54);
      x.globalAlpha = 1;
      x.font = "600 15px -apple-system, sans-serif";
      x.fillText(String(etiqueta || "imagen"), 26, 48);
      x.globalAlpha = 0.55;
      x.font = "13px -apple-system, sans-serif";
      x.fillText("320 × 180", 26, 72);
      return c.toDataURL("image/png");
    } catch (e) {
      return "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    }
  }

  function dataUrlPdf(nombre) {
    return "data:application/pdf;base64," + btoa("%PDF-1.4 demo " + nombre);
  }

  function slug(nombre) {
    return String(nombre || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }
  function carpetaDe(seq) { return D.carpetaSalida + "/" + slug(seq); }
  function movDe(seq, slugMarcador, v, modelo, conFondo) {
    return carpetaDe(seq) + "/" + slugMarcador + " v" + v + " [" + (modelo || "claude-sonnet-5") + "]" +
      (conFondo ? ".mp4" : ".mov");
  }

  // ── Siembra del estado del panel ──────────────────────────────────────
  // Se hace con la API REAL de HPStore, así que lo que queda guardado es
  // exactamente lo que guardaría el panel trabajando. Corre una sola vez, en
  // cuanto los módulos del panel existen (la primera respuesta del host).
  var sembrado = false;
  function sembrar() {
    if (sembrado) return true;
    if (!global.HPStore || !global.HPQueue) return false;
    sembrado = true;

    var S = global.HPStore;
    S.setContext(D.proyectoPath, D.secuenciaAbierta);

    S.setObjective(D.objetivo);
    S.setTranscript(D.transcript);
    S.setTranscriptOffset(0);

    // Numeración por guid: se queman los números de los marcadores borrados
    // (4, 6, 7, 9, 10) para que los huecos sean los de una secuencia real.
    var maxN = 0;
    D.marcadores.forEach(function (m) { if (m.numero > maxN) maxN = m.numero; });
    for (var n = 1; n <= maxN; n++) {
      var duenio = null;
      D.marcadores.forEach(function (m) { if (m.numero === n) duenio = m; });
      S.assignMarkerNumber(duenio ? duenio.guid : "mk-borrado-" + n);
    }

    D.marcadores.forEach(function (m) {
      var key = "Marcador " + m.numero;
      if (m.instruccion) S.setMarkerInstruction(key, m.instruccion);
      S.setMarkerBackground(key, !!m.background);
      S.setMarkerGenerated(key, !!m.generado);
      if (m.timings) S.setMarkerTimings(key, m.timings);
      (m.imagenes || []).forEach(function (img, i) {
        S.addMarkerStill(key, pngFalso(img.etiqueta, img.color, img.fondo));
        if (img.usar) S.setMarkerStillUse(key, i, true);
      });
    });

    // Prompt general: las IMÁGENES siguen siendo del panel; el TEXTO lo sirve
    // el motor (loadGeneralPrompt), que es donde vive desde que viaja con el
    // .prproj. Con ?e=conflicto se deja además un texto local distinto, que es
    // lo que dispara el cartel de "decidí cuál vale".
    (D.imagenesGenerales || []).forEach(function (img, i) {
      S.addMarkerStill(S.GENERAL_KEY, pngFalso(img.etiqueta, img.color, img.fondo));
      if (img.usar) S.setMarkerStillUse(S.GENERAL_KEY, i, true);
    });
    (D.recursosGenerales || []).forEach(function (r) {
      S.addMarkerResource(S.GENERAL_KEY, { name: r.name, dataUrl: dataUrlPdf(r.name), mediaType: r.mediaType });
    });
    if (esc("conflicto")) S.setMarkerInstruction(S.GENERAL_KEY, D.promptGeneral.pendienteLocal);

    // La otra secuencia de la cola: tiene objetivo pero NO transcript, para que
    // se vea la etiqueta "falta transcript" al lado de su nombre.
    S.withContext(D.proyectoPath, D.secuenciaOtra, function () {
      S.setObjective("Que el estudiante sepa qué tres métricas mirar por semana y cuáles ignorar.");
    });

    return true;
  }

  // ── La cola: los estados que queue.json no sabe guardar ───────────────
  // loadQueue devuelve lo que de verdad se persiste (en cola / terminado /
  // esperando tokens / con error): los estados EN VUELO se normalizan a
  // "queued" al restaurar. Así que los dos que están corriendo se inyectan
  // después, con su barra, su reloj y su línea de "qué está haciendo ahora".
  var vivos = [];
  function inyectarEnVuelo(intento) {
    if (!global.HPQueue) return;
    var jobs = global.HPQueue.jobs();
    // restore() resuelve su propia promesa después de la nuestra: si todavía no
    // pobló la cola, se reintenta un ratito antes de rendirse.
    if (!jobs.length && (intento || 0) < 25) {
      setTimeout(function () { inyectarEnVuelo((intento || 0) + 1); }, 100);
      return;
    }
    var hubo = false;
    D.cola.forEach(function (d) {
      if (d.estado !== "modeling" && d.estado !== "running") return;
      for (var i = 0; i < jobs.length; i++) {
        if (jobs[i].id !== d.id) continue;
        var j = jobs[i];
        j.status = d.estado;
        j.pct = d.pct || 0;
        j.msg = d.msg;
        j.startedAt = Date.now() - (d.corriendoDesdeSeg || 60) * 1000;
        j._modelMs = d.modelMs || 0;
        if (d.actividad) { j.act = { label: d.actividad, phase: "thinking", at: Date.now() }; j._actSeen = true; }
        vivos.push(j);
        hubo = true;
      }
    });
    if (!hubo) return;
    // pause() es lo que emite sin arrancar nada: la cola queda como la deja
    // el panel al reabrir con trabajo pendiente (con ▶ Reanudar arriba).
    global.HPQueue.pause();

    // Que la línea de "razonando…" y la barra no se congelen mientras se mira.
    var frases = [
      "razonando (4.240 tok) · …cómo apilar los tres bloques sin invadir la mitad izquierda",
      "razonando (6.910 tok) · …si el tercero se resalta en cian o solo con peso tipográfico",
      "leyendo un archivo · boceto-3-bloques.jpg",
      "escribiendo la composición · 5.480 caracteres",
      "escribiendo la composición · 9.120 caracteres"
    ];
    var k = 0;
    setInterval(function () {
      vivos.forEach(function (j) {
        if (j.status === "modeling") {
          k = (k + 1) % frases.length;
          j.act = { label: frases[k], phase: "thinking", at: Date.now() };
          j.pct = Math.min(92, (j.pct || 0) + 2);
        } else if (j.status === "running") {
          j.pct = Math.min(97, (j.pct || 0) + 1);
        }
      });
    }, 5000);
  }

  function jobsDeLaCola() {
    return D.cola.map(function (d) {
      var key = "Marcador " + d.marcador;
      var conservado = (d.estado === "modeling" || d.estado === "running") ? "queued" : d.estado;
      return {
        id: d.id,
        status: conservado,
        pct: conservado === "done" ? 100 : 0,
        msg: d.msg,
        kind: d.kind,
        seqName: d.secuencia,
        projectPath: D.proyectoPath,
        markerKey: key,
        label: d.etiqueta,
        markerStart: d.start,
        markerDuration: d.duracion,
        version: d.version,
        usage: d.uso,
        correction: !!d.correccion,
        storeSeqName: d.secuenciaOrigen || "",
        _modelMs: d.modelMs || 0,
        _renderMs: d.renderMs || 0,
        notPlaced: !!d.sinColocar,
        _movPath: d.movPath || "",
        _placeColor: d.correccion ? 15 : -1,
        _failedStage: d.etapaFallada || "",
        payload: {
          projectPath: D.proyectoPath, sequenceName: d.secuenciaOrigen || d.secuencia,
          markerSlug: key, mode: d.kind === "generate" ? "generate" : "adjust",
          background: !!d.conFondo,
          instruction: (function () {
            var out = "";
            D.marcadores.forEach(function (m) { if (m.numero === d.marcador) out = m.instruccion; });
            return out;
          })()
        }
      };
    });
  }

  // ── El motor Node de mentira ──────────────────────────────────────────
  function ok(extra) {
    var r = { ok: true };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) r[k] = extra[k];
    return r;
  }
  function luego(valor, ms) {
    return new Promise(function (res) { setTimeout(function () { res(valor); }, ms || 60); });
  }
  /** Corre una secuencia de [ms, {pct,msg,act}] llamando a prog, y resuelve. */
  function correrEtapas(prog, etapas, resultado) {
    return etapas.reduce(function (cadena, paso) {
      return cadena.then(function () {
        return new Promise(function (res) {
          setTimeout(function () {
            if (prog) {
              try {
                prog({
                  pct: paso.pct, msg: paso.msg,
                  act: paso.act ? { label: paso.act, phase: paso.fase || "thinking" } : (paso.act === null ? null : undefined),
                  note: paso.nota
                });
              } catch (e) {}
            }
            res();
          }, paso.ms);
        });
      });
    }, Promise.resolve()).then(function () {
      return typeof resultado === "function" ? resultado() : resultado;
    });
  }

  var usoFalso = {
    inputTokens: 6, outputTokens: 5940, cacheReadTokens: 78210, cacheCreationTokens: 41880,
    totalInputTokens: 120096, costUsd: 1.21
  };

  // El dictado en curso, si hay: { id, parar }. Uno solo, como en el motor de
  // verdad — hay un micrófono.
  var dictando = null;

  function proximaVersion(markerSlug) {
    var v = 1;
    D.marcadores.forEach(function (m) {
      if ("Marcador " + m.numero === markerSlug) v = (m.versiones.length ? m.versiones[m.versiones.length - 1] : 0) + 1;
    });
    return v;
  }

  var motor = {
    // — arranque —
    getVersion: function () { return D.version; },
    checkUpdate: function () { return luego(ok({ verified: true, changed: false, current: D.version, remote: D.version })); },
    selfUpdate: function () { return luego(ok({ verified: true, changed: false, version: D.version })); },
    engineStatus: function () {
      return luego(ok({ depsReady: !esc("preparar"), renderLanes: D.carrilesDeRender }));
    },
    prepareEngine: function (_a, prog) {
      return correrEtapas(prog, [
        { ms: 400, pct: 10, msg: "Bajando las dependencias del motor…" },
        { ms: 900, pct: 55, msg: "Instalando hyperframes (y su Chromium)…" },
        { ms: 900, pct: 88, msg: "Podando onnxruntime-node (258 MB que no se usan)…" },
        { ms: 500, pct: 100, msg: "Listo." }
      ], ok({}));
    },

    // — Whisper —
    whisperStatus: function () { return luego(ok(D.whisper)); },
    whisperInstallPlan: function () {
      return luego(ok({
        supported: true, tool: "mlx-whisper", bin: "mlx_whisper",
        label: "mlx-whisper en un entorno de Python propio",
        targetDir: "~/.hyperpremiere/whisper", downloadMB: 260, exact: false,
        why: "Usa la GPU de Apple: es lo más rápido en esta máquina y no toca tu Python.",
        manual: "A mano: pip install mlx-whisper"
      }));
    },
    installWhisper: function (_a, prog) {
      return correrEtapas(prog, [
        { ms: 500, pct: 8, msg: "Armando el entorno de Python…" },
        { ms: 900, pct: 46, msg: "Bajando mlx-whisper · 118 de 260 MB" },
        { ms: 900, pct: 82, msg: "Bajando mlx-whisper · 240 de 260 MB" },
        { ms: 600, pct: 95, msg: "Probando que corra (transcripción de 1 segundo)…" }
      ], function () {
        D.whisper = { ok: true, available: true, fast: true, managed: true, tool: "mlx-whisper", model: "large-v3", path: "~/.hyperpremiere/whisper/bin/mlx_whisper" };
        return ok({ tool: "mlx-whisper", path: "~/.hyperpremiere/whisper/bin/mlx_whisper", verified: "un audio de prueba de 1 s" });
      });
    },
    cancelWhisperInstall: function () { return luego(ok({})); },

    // — configuración —
    getConfig: function () { return luego(D.config); },
    setConfig: function (body) {
      for (var k in body) if (Object.prototype.hasOwnProperty.call(body, k)) D.config[k] = body[k];
      return luego(D.config);
    },

    // — el micrófono del dictado (⚙ → Micrófono) —
    // La lista con el default del sistema marcado y cuál se usaría ahora con
    // lo elegido; la misma resolución que hace el motor: nombre → índice de
    // hoy, y si el elegido no está, `:default` avisando.
    microfonoListar: function () {
      var M = D.microfonos;
      var elegido = String(D.config.microfono || "");
      var hay = null;
      M.dispositivos.forEach(function (d) { if (d.nombre === elegido) hay = d; });
      var def = null;
      M.dispositivos.forEach(function (d) { if (d.nombre === M.porDefecto) def = d; });
      var usa;
      if (hay) {
        usa = { entrada: ":" + hay.indice, indice: hay.indice, nombre: hay.nombre, elegido: elegido, origen: "elegido", aviso: "" };
      } else if (elegido) {
        usa = {
          entrada: ":default", indice: def ? def.indice : -1, nombre: M.porDefecto, elegido: elegido, origen: "caida",
          aviso: "El micrófono elegido, «" + elegido + "», no está conectado ahora. Uso el que macOS tiene por defecto: «" + M.porDefecto +
            "» (índice " + (def ? def.indice : "?") + "). Conectalo y refrescá la lista, o elegí otro en ⚙ → Micrófono."
        };
      } else {
        usa = {
          entrada: ":default", indice: def ? def.indice : -1, nombre: M.porDefecto, elegido: "", origen: "default",
          aviso: "Todavía no elegiste micrófono: uso el que macOS tiene como entrada por defecto, «" + M.porDefecto +
            "» (índice " + (def ? def.indice : "?") + "). Se elige en ⚙ → Micrófono."
        };
      }
      return luego(ok({
        dispositivos: M.dispositivos.map(function (d) { return { indice: d.indice, nombre: d.nombre, porDefecto: d.nombre === M.porDefecto }; }),
        porDefecto: M.porDefecto, elegido: elegido, usa: usa
      }), 250);
    },
    // La prueba: siete segundos de niveles que suben y bajan (diez por segundo),
    // con las mismas notas al log que deja el motor, y el veredicto al final.
    microfonoProbar: function (_body, prog) {
      var M = D.microfonos;
      var dur = 7;
      var pico = -100;
      var t0 = Date.now();
      return new Promise(function (res) {
        var avisar = function (p) { if (prog) { try { prog(p); } catch (e) {} } };
        avisar({ msg: "Buscando los micrófonos…" });
        setTimeout(function () {
          avisar({ note: "Prueba de micrófono · dispositivos: " + M.dispositivos.map(function (d) { return "[" + d.indice + "] " + d.nombre; }).join(" · ") + " · por defecto del sistema: «" + M.porDefecto + "»" });
          avisar({ note: "Prueba de micrófono · uso «" + M.porDefecto + "» (índice 2, el del sistema, sin elección en ⚙, entrada :default)" });
          avisar({ msg: "Abriendo «" + M.porDefecto + "»…", microfono: { nombre: M.porDefecto, indice: 2, origen: "default" } });
          avisar({ note: "Prueba de micrófono · comando: ffmpeg -hide_banner -loglevel error -f avfoundation -i :default -ac 1 -ar 16000 -f s16le pipe:1" });
        }, 200);
        var i = 0;
        var reloj = setInterval(function () {
          var seg = (Date.now() - t0) / 1000;
          if (seg >= dur) {
            clearInterval(reloj);
            avisar({ note: "Prueba de micrófono · resumen: 6.9 s de audio (221184 bytes, primer byte a los 412 ms) · 66 lecturas · mín " +
              Math.min.apply(null, M.niveles) + " dBFS · máx " + Math.max.apply(null, M.niveles) + " dBFS · compuerta -34.0 dBFS" });
            avisar({ note: "Prueba de micrófono · veredicto (" + M.veredicto.estado + "): " + M.veredicto.titulo + " " + M.veredicto.detalle,
              level: M.veredicto.estado === "ok" ? "INFO" : "ERROR" });
            res(ok({ estado: M.veredicto.estado, titulo: M.veredicto.titulo, detalle: M.veredicto.detalle,
              dispositivo: { nombre: M.porDefecto, indice: 2, origen: "default" } }));
            return;
          }
          if (seg < 0.8) return; // abriendo…
          if (i === 0) avisar({ msg: "Escuchando por «" + M.porDefecto + "»… hablá normal, como si dictaras." });
          // Cada nivel de la lista dura ~300 ms, con un temblor chico para que
          // la barra respire como la de verdad.
          var base = M.niveles[Math.floor(i / 3) % M.niveles.length];
          var dbfs = base <= -100 ? -100 : Math.round((base + (Math.random() * 3 - 1.5)) * 10) / 10;
          if (dbfs > pico) pico = dbfs;
          avisar({ nivel: { dbfs: dbfs, picoDbfs: pico, umbralDbfs: -34, pasa: dbfs >= -34, segundos: seg, duracion: dur } });
          i++;
        }, 100);
      });
    },

    // — dictado por voz, simulado de punta a punta. No hay micrófono ni
    // Whisper: lo que se reproduce es el SOBRE de progreso que manda el motor
    // (ver el contrato en cep/js/engine-client.js), que es de lo que depende
    // cómo se dibuja el botón. Sobre todo `fase`: es con lo que el 🎙 pasa a
    // "■", o sea lo único con lo que el editor puede frenar el micrófono.
    dictadoEstado: function () {
      var M = D.microfonos;
      var elegido = String(D.config.microfono || "");
      var hay = null;
      M.dispositivos.forEach(function (d) { if (d.nombre === elegido) hay = d; });
      var mic = hay
        ? { nombre: hay.nombre, indice: hay.indice, origen: "elegido", elegido: elegido }
        : { nombre: M.porDefecto, indice: 2, origen: elegido ? "caida" : "default", elegido: elegido };
      var forzado = D.dictado || {};
      return luego(ok({
        disponible: forzado.disponible === false ? false : true,
        motivo: forzado.motivo || "",
        plataforma: "darwin", modelo: "mlx-community/whisper-small-mlx",
        faltaBajarModelo: false, cargado: !!dictando,
        enCurso: dictando ? dictando.id : (forzado.enCurso || ""), maxSegundos: 300,
        refinador: D.dictadoSimulado.refinador, sinRefinador: "", microfono: mic
      }));
    },
    dictadoArrancar: function (body, prog) {
      var avisar = typeof prog === "function" ? prog : function () {};
      var id = String((body && body.id) || "dictado");
      var dic = D.dictadoSimulado;
      var M = D.microfonos;
      var elegido = String(D.config.microfono || "");
      var hay = null;
      M.dispositivos.forEach(function (d) { if (d.nombre === elegido) hay = d; });
      var mic = hay
        ? { nombre: hay.nombre, indice: hay.indice, origen: "elegido", elegido: elegido }
        : { nombre: M.porDefecto, indice: 2, origen: elegido ? "caida" : "default", elegido: elegido };
      // Hay UN micrófono: el motor rechaza el segundo dictado, y la maqueta
      // tiene que rechazarlo igual o el panel se dibuja en un estado imposible.
      if (dictando) {
        return luego({ ok: false, error: "Ya hay un dictado en curso (" + dictando.id + "). Pará ése primero: hay un solo micrófono." });
      }
      return new Promise(function (res) {
        var t0 = Date.now();
        var dicho = 0;      // cuántos parciales se mandaron
        var reloj = null;
        var listo = false;

        function terminar() {
          if (listo) return;
          listo = true;
          clearTimeout(reloj);
          dictando = null;
          avisar({ fase: "cortando", msg: "Cerrando el dictado…" });
          var crudo = dicho ? dic.parciales[dicho - 1] : "";
          if (!crudo) {
            res({ ok: false, error: "No entró nada de audio por «" + mic.nombre + "». Probalo con “Probar micrófono” en ⚙, que dice qué le pasa." });
            return;
          }
          var seg = (Date.now() - t0) / 1000;
          avisar({ note: "Dictado (" + id + "): " + seg.toFixed(1) + " s de audio por «" + mic.nombre + "» (índice " +
            mic.indice + ") · " + dicho + " pasadas de Whisper whisper-small-mlx." });
          res(ok({ crudo: crudo, segundos: seg, rms: 0.08, vueltas: dicho, microfono: mic }));
        }
        dictando = { id: id, parar: terminar };

        // Cada parcial REEMPLAZA al anterior entero: el motor retranscribe el
        // buffer completo en cada refresco, así que la frase se corrige sola.
        function hablar() {
          if (listo) return;
          if (dicho >= dic.parciales.length) { terminar(); return; } // se quedó sin qué decir
          avisar({ dictado: { id: id, texto: dic.parciales[dicho++], segundos: (Date.now() - t0) / 1000, escuchando: true } });
          reloj = setTimeout(hablar, 1200);
        }

        avisar({ fase: "preparando", msg: "Preparando el dictado (cargando Whisper whisper-small-mlx)…" });
        reloj = setTimeout(function () {
          if (listo) return;
          avisar({ fase: "preparando", msg: "Buscando el micrófono…" });
          avisar({ microfono: mic });
          avisar({ note: "Dictado (" + id + "): micrófono «" + mic.nombre + "» (índice " + mic.indice + ", entrada :" + mic.indice + ")" });
          reloj = setTimeout(function () {
            if (listo) return;
            avisar({ fase: "escuchando", msg: "Escuchando por «" + mic.nombre + "»… hablá. Tocá el micrófono otra vez para parar." });
            reloj = setTimeout(hablar, 900);
          }, 500);
        }, 700);
      });
    },
    dictadoParar: function (body) {
      var id = String((body && body.id) || "");
      if (!dictando) return luego({ ok: false, error: "No hay ningún dictado en curso." });
      if (id && dictando.id !== id) return luego({ ok: false, error: "El dictado en curso es de otro campo (" + dictando.id + ")." });
      dictando.parar();
      return luego(ok({}));
    },
    dictadoRefinar: function (body) {
      var dic = D.dictadoSimulado;
      var crudo = String((body && body.crudo) || "").trim();
      var previo = String((body && body.previo) || "").trim();
      if (!crudo) {
        return luego({ ok: false, texto: previo, crudo: "", refinador: "", ms: 0, aviso: "No se dictó nada." });
      }
      // Lo que ya estaba escrito y lo dictado se funden en UNA instrucción, que
      // es lo que hace el refinador de verdad: no se pega uno abajo del otro.
      var texto = previo
        ? previo + " " + dic.refinado.charAt(0).toLowerCase() + dic.refinado.slice(1)
        : dic.refinado;
      return luego(ok({
        texto: texto, crudo: crudo, refinador: dic.refinador, ms: dic.msRefinado, usage: dic.usage
      }), dic.msRefinado);
    },
    testProvider: function () { return luego(ok({ detail: "claude-sonnet-5 contestó en 0,9 s" })); },
    listClaudeModels: function () { return luego(ok({ models: D.modelosClaude, cached: false })); },
    listCursorModels: function () {
      return luego(ok({
        models: [
          { id: "claude-sonnet-5-thinking-high", name: "Claude Sonnet 5 1M Thinking", family: "claude-sonnet-5", effort: "high" },
          { id: "claude-sonnet-5-thinking-xhigh", name: "Claude Sonnet 5 1M Extra High Thinking", family: "claude-sonnet-5", effort: "xhigh" },
          { id: "claude-opus-5-thinking-high", name: "Claude Opus 5 Thinking", family: "claude-opus-5", effort: "high" },
          { id: "composer-2.5", name: "Composer 2.5", family: "composer-2.5", effort: "" }
        ], cached: false
      }));
    },
    listOllamaModels: function () { return luego(ok({ models: ["qwen3-vl:30b", "llama3.2-vision", "qwen3-coder:30b"] })); },
    claudeSessionStatus: function () { return luego(D.sesionClaude); },
    claudeCliStatus: function () { return luego(ok({ report: D.diagnosticoClaude })); },
    loginClaudeStart: function () { return luego(ok({ url: "https://claude.ai/oauth/authorize?code=true&client_id=demo" })); },
    loginClaudeCode: function () { return luego(ok({})); },
    loginClaudeToken: function () { return luego(ok({})); },

    // — contexto de la clase —
    loadTranscript: function (body) {
      var esAbierta = body && body.sequenceName === D.secuenciaAbierta;
      if (!esAbierta || !D.transcript.length) return luego(ok({ found: false }));
      return luego(ok({
        found: true, segments: D.transcript, offset: 0, source: "Whisper local (mlx-whisper, large-v3)",
        language: "es", tool: "mlx-whisper",
        path: carpetaDe(D.secuenciaAbierta) + "/transcript.json"
      }));
    },
    saveTranscript: function () { return luego(ok({ path: carpetaDe(D.secuenciaAbierta) + "/transcript.json" })); },
    transcriptSummary: function (body) {
      var byName = {};
      (body && body.sequenceNames || []).forEach(function (n) {
        byName[n] = { found: n === D.secuenciaAbierta && D.transcript.length > 0 };
      });
      return luego(ok({ byName: byName }));
    },
    newTempAudioPath: function () { return luego(ok({ path: "/tmp/hp-audio-demo.wav" })); },
    transcribeMedia: function (body, prog) {
      return correrEtapas(prog, [
        { ms: 600, pct: 12, msg: "Cargando el modelo large-v3 en la GPU…" },
        { ms: 1200, pct: 44, msg: "Transcribiendo · 18 de 57 min" },
        { ms: 1200, pct: 78, msg: "Transcribiendo · 44 de 57 min" },
        { ms: 700, pct: 96, msg: "Limpiando repeticiones y guardando…" }
      ], ok({
        segments: D.transcript, language: "es", tool: "mlx-whisper", loopsRemoved: 2,
        loops: [{ count: 14, text: "Dejame en los comentarios qué flujo armaste", start: 3380, end: 3416 }],
        savedPath: carpetaDe(D.secuenciaAbierta) + "/transcript.json"
      }));
    },
    cancelTranscription: function () { return luego(ok({})); },
    deriveObjective: function () { return luego(ok({ objective: D.objetivo, usage: usoFalso })); },

    // — prompt general (vive al lado del .prproj) —
    loadGeneralPrompt: function (body) {
      var proj = D.promptGeneral.proyecto;
      // El propio de la clase se devuelve igual que la base: si acá se
      // contestara siempre "" —como se contestaba—, escribir el prompt de una
      // secuencia y volver a leer lo haría desaparecer, que es justo lo que el
      // panel de verdad no hace. Solo lo tiene la secuencia abierta: las demás
      // (las que mira la cola) usan la base.
      var propio = (body && body.sequenceName === D.secuenciaAbierta)
        ? (D.promptGeneral.secuencia || "") : "";
      return luego(ok({
        text: propio || proj, source: propio ? "sequence" : (proj ? "project" : "none"),
        projectText: proj, sequenceText: propio, hasProjectFile: !!proj
      }));
    },
    saveGeneralPrompt: function (body) {
      if (body && body.scope === "sequence") D.promptGeneral.secuencia = body.text || "";
      else D.promptGeneral.proyecto = body ? (body.text || "") : "";
      return luego(ok({ path: D.carpetaSalida + "/prompt-general.md" }));
    },

    // — cola —
    loadQueue: function () {
      setTimeout(function () { inyectarEnVuelo(0); }, 120);
      return luego(ok({ jobs: jobsDeLaCola() }));
    },
    saveQueue: function () { return luego(ok({})); },

    // — estimaciones y versiones —
    estimateTokens: function (body) {
      var texto = JSON.stringify(body || {}).length;
      var imgs = ((body && body.stills) || []).length;
      return luego(ok({
        inputTokensEst: 2400 + Math.round(texto / 3) + imgs * 1600,
        breakdown: { images: imgs, resources: ((body && body.resources) || []).length }
      }));
    },
    listMarkerVersions: function (body) {
      var out = [];
      D.marcadores.forEach(function (m) {
        if ("Marcador " + m.numero !== (body && body.markerSlug)) return;
        m.versiones.forEach(function (v) { out.push({ version: v, model: m.modelo }); });
      });
      return luego(ok({ versions: out }));
    },
    readMarkerHtml: function () { return luego(ok({ html: D.htmlDeEjemplo })); },
    findRenderedVideo: function (body) {
      return luego(ok({ movPath: movDe(body.sequenceName, body.markerSlug, body.version || 1, "claude-opus-5", true) }));
    },
    mediaHasAudio: function () { return luego(ok({ hasAudio: false })); },
    saveCapture: function () {
      return luego(ok({ savedPath: pngFalso("captura-programa.png", "#8b97a8", "#242a34") }));
    },

    // — limpieza de versiones viejas —
    listOldVersions: function (body) {
      return luego(ok({
        files: [
          { name: "Marcador 1 v1 [claude-sonnet-5].mov", path: movDe(body.sequenceName, "Marcador 1", 1, "claude-sonnet-5", false) },
          { name: "Marcador 1 v2 [claude-sonnet-5].mov", path: movDe(body.sequenceName, "Marcador 1", 2, "claude-sonnet-5", false) },
          { name: "Marcador 3 v1 [claude-sonnet-5].mov", path: movDe(body.sequenceName, "Marcador 3", 1, "claude-sonnet-5", false) }
        ]
      }));
    },
    cleanupPreview: function (body) {
      return luego(ok({
        sequenceName: body.sequenceName, totalDeletes: 3, totalBytes: 742 * 1024 * 1024,
        groups: [
          { keep: { name: "Marcador 1 v3 [claude-sonnet-5].mov" }, deletes: [{ name: "Marcador 1 v1 [claude-sonnet-5].mov" }, { name: "Marcador 1 v2 [claude-sonnet-5].mov" }] },
          { keep: { name: "Marcador 3 v2 [claude-sonnet-5].mov" }, deletes: [{ name: "Marcador 3 v1 [claude-sonnet-5].mov" }] }
        ]
      }));
    },
    cleanOldVersions: function () { return luego(ok({ deleted: 3, freedBytes: 742 * 1024 * 1024 })); },

    // — Corrections —
    listCorrections: function (body) {
      var C = D.correcciones;
      var pedida = (body && body.folderSlug) || "";
      var fuente = pedida ? (pedida === slug(D.secuenciaOtra) ? D.secuenciaOtra : C.leidoDe) : C.leidoDe;
      return luego(ok({
        folderSlug: slug(fuente),
        sourceSequenceName: fuente,
        baseDir: carpetaDe(fuente),
        guessed: !pedida && C.elegidoPorNosotros,
        sources: (C.fuentes || []).map(function (f) { return { slug: slug(f.seq), sequenceName: f.seq, count: f.cantidad }; }),
        markers: (C.recursos || []).map(function (r) {
          return {
            slug: r.slug, markerName: r.nombre, markerGuid: "",
            start: r.start, duration: r.duration, timeSource: r.fuenteTramo,
            latestVersion: r.ultima, model: r.modelo,
            versions: r.versiones.map(function (v) { return { version: v, model: r.modelo }; }),
            instruction: r.encargo, background: !!r.conFondo
          };
        })
      }));
    },
    saveCorrectionPosition: function () { return luego(ok({})); },

    // — generar y renderizar (simulado, para poder apretar los botones) —
    prepareGenerate: function (payload, prog) { return simularModelo(payload, prog, "Diseñando"); },
    prepareFeedback: function (payload, prog) { return simularModelo(payload, prog, "Refinando"); },
    renderPrepared: simularRender,
    renderManualHtml: simularRender,
    renderLatest: simularRender
  };

  function simularModelo(payload, prog, verbo) {
    var modelo = D.config.model || "claude-sonnet-5";
    return correrEtapas(prog, [
      { ms: 700, pct: 8, msg: verbo + " la animación con " + modelo + "…", act: "razonando (1.120 tok) · …qué es lo único que tiene que decir esta pantalla" },
      { ms: 2200, pct: 22, act: "razonando (4.980 tok) · …dónde entra sin invadir la mitad izquierda" },
      { ms: 2200, pct: 40, act: "leyendo un archivo · imagen-1.png" },
      { ms: 2400, pct: 62, act: "escribiendo la composición · 6.300 caracteres" },
      { ms: 2400, pct: 84, act: "escribiendo la composición · 11.940 caracteres" },
      { ms: 1200, pct: 95, msg: "Revisando el andamiaje de la composición…", act: null, nota: "Completé en código el data-duration (11.2 s) que el modelo no declaró: no hizo falta otra llamada." }
    ], function () {
      return ok({
        usage: usoFalso,
        markerSlug: payload && payload.markerSlug,
        projectPath: payload && payload.projectPath,
        sequenceName: payload && payload.sequenceName,
        background: !!(payload && payload.background)
      });
    });
  }

  function simularRender(payload, prog) {
    var slugM = (payload && payload.markerSlug) || "Marcador 1";
    var v = proximaVersion(slugM);
    return correrEtapas(prog, [
      { ms: 600, pct: 10, msg: "Levantando el motor de captura…" },
      { ms: 1600, pct: 38, msg: "Capturando fotogramas · 96 de 336" },
      { ms: 1600, pct: 66, msg: "Capturando fotogramas · 244 de 336" },
      { ms: 1400, pct: 90, msg: "Codificando ProRes 4444 con alpha…", nota: "Render con 2 carriles · 3 workers cada uno · GPU por hardware." }
    ], ok({
      version: v,
      movPath: movDe((payload && payload.sequenceName) || D.secuenciaAbierta, slugM, v, D.config.model, !!(payload && payload.background))
    }));
  }

  // ── La puerta del motor: window.cep_node.require ──────────────────────
  global.cep_node = {
    require: function (ruta) {
      var r = String(ruta || "");
      if (/engine\.js$/.test(r)) {
        if (esc("motor")) throw new Error("Cannot find module '" + r + "'");
        return motor;
      }
      // fs / os / path: el panel los pide con try/catch y aguanta que no estén.
      return null;
    }
  };

  // ── La puerta de ExtendScript: window.__adobe_cep__ ───────────────────
  function marcadoresJson() {
    var todos = [];
    D.marcadores.forEach(function (m) {
      todos.push({ guid: m.guid, name: m.name, comment: "", start: m.start, duration: m.duration, end: m.start + m.duration });
    });
    (D.marcadoresFrameIo || []).forEach(function (m) {
      todos.push({ guid: "fio-" + Math.round(m.start), name: m.name, comment: m.comment, start: m.start, duration: 0, end: m.start });
    });
    todos.sort(function (a, b) { return a.start - b.start; });
    todos.forEach(function (m, i) { m.index = i; });
    return JSON.stringify(todos);
  }

  function responder(expr) {
    if (/^\$\.evalFile/.test(expr)) return "";
    var nombre = (/^(hp_[a-zA-Z]+)/.exec(expr) || [])[1] || "";
    switch (nombre) {
      case "hp_getProjectPath": return D.proyectoPath;
      case "hp_getActiveSequenceName": return D.secuenciaEnPremiere;
      case "hp_getMarkers": return marcadoresJson();
      case "hp_seekToTime": return "ok";
      case "hp_openSequenceAndSeek": return "ok";
      case "hp_activateSequence": return "ok";
      case "hp_getSequenceDuration": return "ok|" + D.duracionSecuencia;
      case "hp_captureProgramFrame": return "ok|/tmp/hp-still-demo.png";
      case "hp_exportSequenceAudio":
        return "ok|/tmp/hp-audio-demo.wav|Waveform Audio 16 kHz mono|" + D.secuenciaEnPremiere;
      case "hp_getPrimaryClipInfo":
        return JSON.stringify({ ok: true, offset: 0, mediaPath: "/Volumes/Editorial 04/Rushes/MKA_C12_A001.mov", clipName: "MKA_C12_A001.mov" });
      case "hp_placeClipInSequence": return "ok";
      case "hp_purgeClipsByPath": return "ok|3";
      default: return "ok";
    }
  }

  global.__adobe_cep__ = {
    evalScript: function (script, cb) {
      var expr = String(script || "");
      setTimeout(function () {
        sembrar();
        var res = responder(expr);
        if (cb) { try { cb(res); } catch (e) { if (global.console) console.error("[demo] callback:", e); } }
      }, 25);
    },
    getSystemPath: function () {
      return "/Users/dani/Library/Application%20Support/Adobe/CEP/extensions/HyperPremiere";
    },
    getHostEnvironment: function () {
      return JSON.stringify({
        appName: "PPRO", appVersion: "26.0.0", appLocale: "es_ES", appUILocale: "es_ES",
        appId: "PPRO", isAppOnline: true,
        appSkinInfo: {
          panelBackgroundColor: { color: { red: 18, green: 22, blue: 29, alpha: 255 } },
          baseFontFamily: "DM Sans", baseFontSize: 12
        }
      });
    },
    getHostCapabilities: function () { return JSON.stringify({ EXTENDED_PANEL_MENU: true }); },
    getCurrentApiVersion: function () { return JSON.stringify({ major: 11, minor: 0, micro: 0 }); },
    getExtensionId: function () { return "com.codigo.hyperpremiere"; },
    getScaleFactor: function () { return 1; },
    getMonitorScaleFactor: function () { return 1; },
    getNetworkPreferences: function () { return JSON.stringify({}); },
    initResourceBundle: function () { return JSON.stringify({}); },
    dumpInstallationInfo: function () { return "demo"; },
    addEventListener: function () {},
    removeEventListener: function () {},
    dispatchEvent: function () {},
    setScaleFactorChangedHandler: function () {},
    invokeSync: function () { return ""; },
    invokeAsync: function () {},
    closeExtension: function () {},
    resizeContent: function () {},
    requestOpenExtension: function () {},
    getExtensions: function () { return JSON.stringify({ extensions: [] }); },
    registerInvalidCertificateCallback: function () {},
    registerKeyEventsInterest: function () {}
  };

  global.cep = {
    util: {
      openURLInDefaultBrowser: function (url) { try { global.open(url, "_blank"); } catch (e) {} }
    },
    fs: {}
  };

  global.addEventListener("DOMContentLoaded", function () {
    // En Premiere las tarjetas aparecen cuando tocás "Cargar marcadores", y las
    // correcciones cuando tocás "Cargar secuencia". Acá se tocan solos: si no,
    // la maqueta abre vacía y no se puede opinar de nada.
    // Con ?e=motor no se tocan: lo que hay que mirar ahí es el panel en rojo
    // avisando que el motor no cargó, y cargar marcadores lo taparía.
    if (!esc("motor")) {
      setTimeout(function () {
        var b = document.getElementById("btn-load-markers");
        if (b) b.click();
      }, 300);
    }
    var tabCorr = document.getElementById("tab-corrections");
    if (tabCorr) {
      tabCorr.addEventListener("click", function una() {
        tabCorr.removeEventListener("click", una);
        setTimeout(function () {
          var b = document.getElementById("btn-load-corrections");
          if (b) b.click();
        }, 120);
      });
    }

    // Sello, para que nunca se confunda una captura de la maqueta con una del
    // panel corriendo de verdad en Premiere.
    var s = document.createElement("div");
    s.textContent = "MAQUETA · datos falsos" + (Object.keys(escenarios).length ? " · " + Object.keys(escenarios).join(", ") : "");
    s.style.cssText = "position:fixed;right:0;bottom:0;z-index:9999;font:11px/1 -apple-system,sans-serif;" +
      "padding:5px 9px;color:#0e1116;background:#fbbf24;border-radius:6px 0 0 0;letter-spacing:.04em;opacity:.85;pointer-events:none";
    document.body.appendChild(s);
  });
})(typeof window !== "undefined" ? window : this);
