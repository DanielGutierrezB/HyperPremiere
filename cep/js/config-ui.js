/**
 * HPConfigUI — sección "Configuración del modelo": proveedor, modelo,
 * credenciales (API key / login de Claude / base URL), semáforo de estado y
 * prueba real de credenciales contra el motor.
 *
 * Es la dueña del estado "proveedor activo" del panel: el resto consulta
 * isLocalProvider() (la cola no solapa modelo+render en local) y modelName().
 *
 * Vanilla JS, sin ES modules: se expone como window.HPConfigUI.
 */
(function (global) {
  "use strict";

  var DEBOUNCE_MS = 300;
  var debounce = HPUtil.debounce;
  var hpCall = HPEngine.call;

  // Estado del proveedor activo (lo consultan la cola y el estimador de costo).
  var providerIsLocal = false;
  var modelNameValue = ""; // para el log de diagnóstico
  // Sesión del CLI del proveedor activo (Claude o Cursor): TRES valores, no
  // dos. "?" es "todavía no se sabe", y con eso NO se avisa nada. El cartel de
  // "falta iniciar sesión" salía de mirar si el panel tenía un token guardado, y
  // ése es apenas uno de los caminos: el CLI puede tener su propia sesión
  // (`claude auth login`, `cursor-agent login`) y generar sin token nuestro.
  // Había editores generando perfecto con el cartel puesto — pasó de verdad.
  // Quien contesta ahora es el CLI (ver bridge/claude-session.js y
  // bridge/cursor-session.js, que dan la misma respuesta de tres valores).
  // "si" | "no" | "cupo" | "?"
  //
  // "cupo" es el cuarto y llegó después: hay credencial —el CLI contesta que
  // sí— pero la última generación rebotó porque la cuenta no tiene saldo. No es
  // "no" (no falta configurar nada) y no puede ser "si" (no va a poder
  // generar). Es el caso que mandó un editor: semáforo en verde arriba y
  // `Credit balance is too low` en la cola. Lo recuerda bridge/provider-salud.js
  // y se olvida al guardar credenciales o al reiniciar el panel.
  var currentSession = "?";
  // Lo escribe `aplicarSesion` con la marca del proveedor que se chequeó. Vacío
  // y no "iniciá sesión en Claude": un texto de Claude puesto por omisión en una
  // variable que comparten los dos proveedores es cómo termina apareciéndole
  // Claude a alguien que eligió Cursor.
  var currentSessionWarn = "";
  // CON QUÉ credencial entra el CLI de Claude ('api_key' | 'claude.ai' |
  // 'oauth_token' | "" mientras no se sepa). No es un detalle de diagnóstico:
  // es lo que decide qué ventana de contexto se puede prometer, porque por API
  // key el CLI va por la API y por suscripción nadie dice cuánto te entra.
  var currentAuthMethod = "";

  var cfgProviderSel = null;
  var cfgModelSel = null;
  var cfgEffortSel = null;
  var cfgModelCustom, cfgApiKey, cfgBaseUrl, btnSaveConfig, configStatus, cfgSummary;
  var btnLoginClaude, loginStatus, modelsHint, cfgContext;
  // Los de Cursor son otros nodos, no los mismos: los dos proveedores pueden
  // estar configurados a la vez y el renglón de uno no puede pisar al del otro.
  var cursorStatus, apikeyHint;

  // Nivel de pensamiento (esfuerzo) de Claude: es la palanca de CALIDAD, no de
  // velocidad nada más. Diseñar una animación es razonamiento, así que subirlo
  // mejora el diseño a costa de tiempo y tokens. "high" es el default del modelo.
  var EFFORT_LEVELS = [
    { v: "low", t: "Bajo — el más rápido y barato (diseños simples)" },
    { v: "medium", t: "Medio — equilibrio" },
    { v: "high", t: "Alto — recomendado (default)" },
    { v: "xhigh", t: "Muy alto — diseños exigentes, más lento" },
    { v: "max", t: "Máximo — la mejor calidad posible, el más lento y caro" }
  ];

  // Respaldo de modelos Claude si no se puede consultar a Anthropic (sin red o
  // sin credenciales). La lista REAL la trae listClaudeModels() del motor, así
  // que un modelo nuevo aparece solo, sin tocar código. Haiku queda afuera a
  // propósito (rápido pero no da buenos diseños).
  var CLAUDE_MODELS = [
    { v: "claude-opus-5", t: "Claude Opus 5" },
    { v: "claude-sonnet-5", t: "Claude Sonnet 5" },
    { v: "claude-fable-5", t: "Claude Fable 5" },
    { v: "claude-opus-4-8", t: "Claude Opus 4.8" }
  ];
  // Respaldo para Cursor si no se puede consultar el CLI. La lista real la trae
  // listCursorModels() del motor (cursor-agent --list-models), ya curada: fuera
  // las variantes "-fast" (pagan prioridad con más consumo, justo lo que se
  // quiere evitar), las "-none" (sin razonamiento) y la gama chica.
  //
  // `family` y `effort` vienen del motor y son lo que permite mostrar el nivel
  // de pensamiento como un desplegable aparte, igual que en Claude (ver
  // cursorGroups). En el respaldo van a mano.
  var CURSOR_MODELS = [
    { v: "claude-sonnet-5-thinking-high", t: "Claude Sonnet 5 1M Thinking", family: "claude-sonnet-5", effort: "high" },
    { v: "claude-sonnet-5-thinking-xhigh", t: "Claude Sonnet 5 1M Extra High Thinking", family: "claude-sonnet-5", effort: "xhigh" },
    { v: "claude-opus-5-thinking-high", t: "Claude Opus 5 Thinking", family: "claude-opus-5", effort: "high" },
    { v: "claude-fable-5-thinking-high", t: "Claude Fable 5 Thinking", family: "claude-fable-5", effort: "high" },
    { v: "composer-2.5", t: "Composer 2.5", family: "composer-2.5", effort: "" },
    { v: "auto", t: "Auto (que elija Cursor)", family: "auto", effort: "" }
  ];
  var MODELS = {
    "claude-cli": CLAUDE_MODELS,
    "claude-api": CLAUDE_MODELS,
    "cursor-cli": CURSOR_MODELS,
    "openai-compat": [
      { v: "gpt-4o", t: "OpenAI · GPT-4o" },
      { v: "gpt-4o-mini", t: "OpenAI · GPT-4o mini" },
      { v: "gemini-2.0-flash", t: "Google · Gemini 2.0 Flash" },
      { v: "gemini-1.5-pro", t: "Google · Gemini 1.5 Pro" },
      { v: "__custom__", t: "Otro (escribir ID)…" }
    ],
    "ollama": [
      { v: "qwen3-coder:30b", t: "qwen3-coder:30b" },
      { v: "llama3.2-vision", t: "llama3.2-vision (con imágenes)" },
      { v: "__custom__", t: "Otro (escribir ID)…" }
    ]
  };
  var PROVIDER_LABEL = {
    "claude-cli": "Claude (suscripción)",
    "claude-api": "Claude (API)",
    "cursor-cli": "Cursor (suscripción)",
    "openai-compat": "API compatible",
    "ollama": "Ollama local"
  };
  var BASEURL_HINT = {
    "openai-compat": "OpenAI: https://api.openai.com/v1 · Gemini: https://generativelanguage.googleapis.com/v1beta/openai · OpenRouter: https://openrouter.ai/api/v1",
    "ollama": "opcional — por defecto http://localhost:11434"
  };

  function showRow(id, show) {
    var el = document.getElementById(id);
    if (el) el.setAttribute("data-hidden", show ? "false" : "true");
  }

  // ── Cursor: el mismo selector que Claude ──────────────────────────────
  //
  // Cursor no tiene flag de esfuerzo: el nivel viene DENTRO del ID del modelo
  // (claude-sonnet-5-thinking-high, -xhigh…). Mientras eso se mostraba tal
  // cual, el editor tenía que saber leer el ID para elegir cuánto piensa el
  // modelo — y en la máquina de otro editor la conclusión fue la obvia: "no me
  // deja elegir bien la exigencia". Estaba, pero disfrazada de modelo.
  //
  // Acá las variantes se agrupan por familia: el desplegable de modelo muestra
  // "Claude Sonnet 5 · 1M" y el de pensamiento, los niveles que esa familia
  // tiene. Al guardar se vuelve a armar el ID real, así que el motor y la
  // config no cambian una línea. El nombre sale del que pone Cursor, para que
  // el "1M" del contexto largo llegue tal como él lo escribe.
  var FAM = "fam:";
  var cursorGroups = [];

  /** Las palabras que estos nombres tienen en común, desde el principio. */
  function commonWords(names) {
    if (!names.length) return [];
    var parts = names.map(function (n) { return String(n || "").trim().split(/\s+/); });
    var out = [];
    for (var i = 0; i < parts[0].length; i++) {
      var w = parts[0][i];
      for (var j = 1; j < parts.length; j++) if (parts[j][i] !== w) return out;
      out.push(w);
    }
    return out;
  }

  function familyLabel(family, names, tieneNiveles) {
    var label = commonWords(names).join(" ");
    // "Thinking" lo dice el desplegable de al lado; repetirlo es ruido.
    if (tieneNiveles) label = label.replace(/\s+thinking$/i, "");
    // El "1M" es la única razón por la que alguien elige estas variantes: si el
    // recorte se lo llevó, se vuelve a poner.
    if (/\b1m\b/i.test(names.join(" ")) && !/\b1M\b/i.test(label)) label += " · 1M";
    return label.trim() || family;
  }

  // OJO con una consecuencia: en una familia que tiene niveles, la variante
  // PELADA (claude-sonnet-5, la que no razona) queda fuera del alcance, porque
  // el desplegable de niveles solo ofrece los que existen. Es a propósito y es
  // la misma política que ya venía: las variantes "-none" se filtran en el
  // motor porque para diseñar una animación son la herramienta equivocada.
  function buildCursorGroups(list) {
    var groups = [];
    var byFamily = {};
    (list || []).forEach(function (m) {
      var id = m.v;
      if (!id) return;
      // Un modelo sin familia (o el "auto") es su propio grupo, sin niveles.
      var fam = m.family || id;
      var g = byFamily[fam];
      if (!g) {
        g = byFamily[fam] = { family: fam, names: [], byEffort: {}, plain: "" };
        groups.push(g);
      }
      g.names.push(m.t || id);
      if (!m.effort) { if (!g.plain) g.plain = id; }
      else if (!g.byEffort[m.effort]) g.byEffort[m.effort] = id;
    });
    groups.forEach(function (g) {
      var niveles = 0;
      for (var k in g.byEffort) if (g.byEffort.hasOwnProperty(k)) niveles++;
      g.label = familyLabel(g.family, g.names, niveles > 0);
    });
    return groups;
  }

  function cursorGroupBy(family) {
    for (var i = 0; i < cursorGroups.length; i++) {
      if (cursorGroups[i].family === family) return cursorGroups[i];
    }
    return null;
  }

  /** El grupo que está elegido en el desplegable ahora mismo. */
  function currentCursorGroup() {
    var v = String(cfgModelSel.value || "");
    if (v.indexOf(FAM) !== 0) return cursorGroups[0] || null;
    return cursorGroupBy(v.slice(FAM.length)) || cursorGroups[0] || null;
  }

  /**
   * De familia + nivel al ID que hay que pedirle a Cursor.
   * Si el nivel exacto no existe en esa familia se baja al vecino de abajo y,
   * si tampoco, se sube: es mejor el nivel de al lado que un modelo que no es
   * el que el editor eligió.
   */
  function cursorIdFor(g, effort) {
    if (!g) return "";
    var order = EFFORT_LEVELS.map(function (o) { return o.v; });
    function primero() {
      for (var k = 0; k < order.length; k++) if (g.byEffort[order[k]]) return g.byEffort[order[k]];
      return "";
    }
    if (!effort) return g.plain || primero();
    if (g.byEffort[effort]) return g.byEffort[effort];
    var i = order.indexOf(effort);
    for (var d = i - 1; d >= 0; d--) if (g.byEffort[order[d]]) return g.byEffort[order[d]];
    for (var u = i + 1; u < order.length; u++) if (g.byEffort[order[u]]) return g.byEffort[order[u]];
    return g.plain || primero();
  }

  /** El camino de vuelta: de un ID guardado, qué familia y qué nivel es. */
  function cursorPick(id) {
    if (!id) return null;
    for (var i = 0; i < cursorGroups.length; i++) {
      var g = cursorGroups[i];
      if (g.plain === id) return { group: g, effort: "" };
      for (var e in g.byEffort) {
        if (g.byEffort.hasOwnProperty(e) && g.byEffort[e] === id) return { group: g, effort: e };
      }
    }
    return null;
  }

  /**
   * Niveles del desplegable de pensamiento. En Claude son todos; en Cursor,
   * solo los que la familia elegida tiene de verdad — ofrecer un "Máximo" que
   * se resuelve calladamente a otra cosa es mentirle al editor.
   */
  function populateEfforts(selected) {
    if (!cfgEffortSel) return;
    var disponibles = EFFORT_LEVELS;
    if (cfgProviderSel.value === "cursor-cli") {
      var g = currentCursorGroup();
      var niveles = g ? g.byEffort : {};
      disponibles = EFFORT_LEVELS.filter(function (o) { return !!niveles[o.v]; });
      if (!disponibles.length) {
        cfgEffortSel.setOptions([{ value: "", label: "No aplica — este modelo no ofrece niveles" }], "");
        return;
      }
    }
    var val = selected;
    var hay = false;
    for (var i = 0; i < disponibles.length; i++) if (disponibles[i].v === val) hay = true;
    if (!hay) {
      // El que se venía usando no existe acá: se queda el más alto que haya, que
      // es el criterio con el que se eligió "high" como default.
      val = disponibles[disponibles.length - 1].v;
    }
    cfgEffortSel.setOptions(disponibles.map(function (o) {
      return { value: o.v, label: o.t };
    }), val);
  }

  // Rellena el desplegable de modelos según el proveedor y marca el activo.
  function populateModels(provider, selected) {
    if (provider === "cursor-cli") {
      cursorGroups = buildCursorGroups(MODELS["cursor-cli"]);
      var pick = cursorPick(selected);
      var g = pick ? pick.group : cursorGroups[0];
      cfgModelSel.setOptions(cursorGroups.map(function (x) {
        return { value: FAM + x.family, label: x.label };
      }), FAM + (g ? g.family : ""));
      // El nivel que manda es el del ID guardado: es el que se venía usando de
      // verdad. Si el ID no traía ninguno, se respeta lo elegido en el panel.
      populateEfforts(pick && pick.effort ? pick.effort : (cfgEffortSel ? cfgEffortSel.value : "high"));
      return;
    }
    var list = MODELS[provider] || CLAUDE_MODELS;
    var matched = false;
    for (var i = 0; i < list.length; i++) if (list[i].v === selected) matched = true;
    var opts = list.map(function (o) { return { value: o.v, label: modelOptionLabel(o) }; });
    var val;
    if (selected && !matched && provider !== "claude-cli" && provider !== "claude-api") {
      // ID personalizado que no está en la lista → seleccionar "Otro" y precargar.
      val = "__custom__";
      if (cfgModelCustom) cfgModelCustom.value = selected;
    } else if (matched) {
      val = selected;
    } else {
      val = list[0].v;
    }
    cfgModelSel.setOptions(opts, val);
  }

  // Modelo efectivo: el del desplegable, o el texto libre si eligió "Otro".
  // En Cursor el desplegable tiene la FAMILIA, así que el ID se arma con el
  // nivel de pensamiento elegido (ver cursorIdFor).
  function effectiveModel() {
    if (cfgModelSel.value === "__custom__") return (cfgModelCustom.value || "").trim();
    if (String(cfgModelSel.value || "").indexOf(FAM) === 0) {
      return cursorIdFor(currentCursorGroup(), cfgEffortSel ? cfgEffortSel.value : "");
    }
    return cfgModelSel.value;
  }

  // ── Cuánto le entra, y cuánto le metemos ──────────────────────────────
  //
  // Las dos decisiones —qué ventana corresponde y cómo se cuenta el consumo—
  // son funciones puras de HPUtil, probadas sin DOM. Acá solo se juntan los
  // datos que están desperdigados en el panel (proveedor, catálogo, credencial
  // del CLI, contador de la sesión) y se pinta.

  /** La entrada del catálogo del proveedor activo para este ID, o null. */
  function catalogEntry(id) {
    var list = MODELS[cfgProviderSel.value] || [];
    for (var i = 0; i < list.length; i++) if (list[i].v === id) return list[i];
    return null;
  }

  /**
   * La ventana del modelo que está elegido ahora, o null si no se sabe.
   * En Cursor el dato está en el NOMBRE que devolvió el CLI (que es de donde
   * sale el "· 1M" de la etiqueta); en Claude, en el ID más la credencial.
   */
  function activeWindow() {
    var p = cfgProviderSel.value;
    if (p === "cursor-cli") {
      var g = currentCursorGroup();
      return HPUtil.ventanaDeContexto({ provider: p, model: effectiveModel(), nombre: g ? g.label : "" });
    }
    var id = effectiveModel();
    var e = catalogEntry(id);
    return HPUtil.ventanaDeContexto({
      provider: p, model: id, nombre: e ? e.t : "",
      autenticacion: currentAuthMethod, reportado: e ? e.ventana : 0
    });
  }

  /** La etiqueta de una opción del desplegable: el nombre y, si la sabemos, la ventana. */
  function modelOptionLabel(o) {
    var v = HPUtil.ventanaDeContexto({
      provider: cfgProviderSel.value, model: o.v, nombre: o.t,
      autenticacion: currentAuthMethod, reportado: o.ventana
    });
    // Un nombre que ya la dice (los de Cursor traen el 1M puesto) no la repite.
    if (!v || String(o.t).indexOf(v.texto) !== -1) return o.t;
    return o.t + " · " + v.texto;
  }

  /** El renglón de abajo del selector: la ventana y lo que gasta de verdad. */
  function updateContextNote() {
    if (!cfgContext) return;
    var uso = (typeof HPStore !== "undefined" && HPStore) ? HPStore.getSessionUsage() : null;
    cfgContext.textContent = HPUtil.lineaDeContexto({
      ventana: activeWindow(),
      consumo: HPUtil.consumoTipico(uso, cfgProviderSel.value),
      proveedor: PROVIDER_LABEL[cfgProviderSel.value] || cfgProviderSel.value,
      provider: cfgProviderSel.value
    });
  }

  function modelLabel(id) {
    // Un mismo ID puede existir en dos catálogos (Cursor también ofrece
    // "claude-sonnet-5"), así que primero manda el proveedor activo.
    if (cfgProviderSel.value === "cursor-cli") {
      var pick = cursorPick(id);
      if (pick) return pick.group.label;
    }
    for (var p in MODELS) {
      for (var i = 0; i < MODELS[p].length; i++) {
        if (MODELS[p][i].v === id) return MODELS[p][i].t.replace(/ —.*$/, "").replace(/\s*·.*$/, " ").trim() || id;
      }
    }
    return id;
  }

  // Muestra/oculta campos según el proveedor y actualiza pistas.
  function applyProviderUI() {
    var p = cfgProviderSel.value;
    var isClaude = (p === "claude-cli" || p === "claude-api");
    var isCursor = (p === "cursor-cli");
    showRow("row-login", p === "claude-cli");
    showRow("row-login-cursor", isCursor);
    // Cursor entra en la fila de API key. El motor SIEMPRE supo usarla (le pone
    // CURSOR_API_KEY al proceso hijo), pero desde el panel no había manera de
    // pegarla: la fila se escondía justo con Cursor elegido. Un editor sin
    // sesión de CLI no tenía ningún camino desde acá.
    showRow("row-apikey", p === "claude-api" || p === "openai-compat" || isCursor);
    showRow("row-baseurl", p === "openai-compat" || p === "ollama");
    showRow("row-model-custom", cfgModelSel.value === "__custom__");
    // El nivel de pensamiento se elige igual en los dos: en Claude es un flag
    // (--effort) y en Cursor está dentro del ID del modelo, pero eso es asunto
    // nuestro (ver cursorGroups). El editor ve el mismo control.
    showRow("row-effort", isClaude || isCursor);
    if (modelsHint) modelsHint.setAttribute("data-hidden", (isClaude || isCursor) ? "false" : "true");
    // CUÁL de las dos cosas se espera en ese campo. Con Cursor hay que decirlo:
    // el CLI nombra dos variables (CURSOR_API_KEY y CURSOR_AUTH_TOKEN) y no son
    // dos formas de pasar lo mismo — el token de `login` el CLI lo GUARDA en el
    // llavero del sistema, o sea que pisaría la sesión de la máquina. Acá va la
    // key, que es la que no tiene efectos, y se aclara para que nadie pegue la
    // otra y se quede esperando (ver bridge/cursor-session.js).
    if (apikeyHint) {
      apikeyHint.textContent = isCursor
        ? "API key de Cursor (empieza con key_…), de cursor.com → Dashboard → Integrations → API Keys. " +
          "No es el token de `cursor-agent login`: si ya iniciaste sesión en la terminal, dejá esto vacío."
        : "";
    }
    var hintEl = document.getElementById("baseurl-hint");
    if (hintEl) hintEl.textContent = BASEURL_HINT[p] || "";
    // Aviso de lentitud para modelos locales.
    var noteEl = document.getElementById("provider-note");
    if (noteEl) {
      if (p === "ollama") {
        var m = effectiveModel();
        var dense = /vl:32b|:32b|coder:30b|gemma4/i.test(m);
        noteEl.textContent = "⏳ Modelo local: cada marcador puede tardar " +
          (dense ? "10–20+ min (modelo denso/pesado)" : "2–4 min") +
          ". No cierres el panel mientras genera.";
        noteEl.setAttribute("data-hidden", "false");
      } else if (isCursor) {
        // Honesto por adelantado: Cursor gasta TU cupo de Cursor, arrastra el
        // contexto del agente (~30k tokens por generación) y va más lento.
        noteEl.textContent = "Gasta tu suscripción de Cursor en vez de la de Claude. " +
          "Cada marcador tarda ~1,5–3 min y arrastra ~30k tokens de contexto del agente. " +
          "Requiere el CLI de Cursor instalado y con sesión en esta máquina.";
        noteEl.setAttribute("data-hidden", "false");
      } else {
        noteEl.setAttribute("data-hidden", "true");
      }
    }
    updateContextNote();
  }

  // Semáforo del resumen: verde si el proveedor está listo, aviso si falta algo.
  function updateSummary() {
    if (!cfgSummary) return;
    var p = cfgProviderSel.value;
    var model = effectiveModel();
    var ok = true, warn = "";
    // Los dos proveedores de CLI se miran igual, y con los mismos valores: solo
    // se avisa cuando se SABE que falta. "?" no dibuja nada.
    var esCli = (p === "claude-cli" || p === "cursor-cli");
    if (esCli && currentSession === "no") { ok = false; warn = currentSessionWarn; }
    // Sin cupo puede pasarle a cualquiera de los proveedores de cuenta, no solo
    // a los de CLI: una API key con saldo agotado es el mismo problema.
    var sinCupo = (currentSession === "cupo") &&
      (esCli || p === "claude-api" || p === "openai-compat");
    if (p === "claude-api" && !(cfgApiKey.value.trim() || cfgApiKey.getAttribute("data-has") === "1")) { ok = false; warn = "falta API key"; }
    if (p === "openai-compat" && !cfgBaseUrl.value.trim()) { ok = false; warn = "falta Base URL"; }
    if (!model) { ok = false; warn = "falta el modelo"; }
    if (ok && sinCupo) {
      // Todo configurado y aun así no va a poder. Se dice en ámbar y no en rojo
      // porque no hay nada que arreglar acá adentro: se arregla en la cuenta.
      cfgSummary.textContent = "⚠ " + (PROVIDER_LABEL[p] || p) + " · " + currentSessionWarn;
      cfgSummary.className = "cfg-summary is-cupo";
    } else if (ok) {
      // El nivel de pensamiento pesa tanto como el modelo en el resultado, así
      // que va en el resumen. Vale para los dos proveedores que lo tienen.
      var tieneEsfuerzo = (p === "claude-cli" || p === "claude-api" || p === "cursor-cli");
      var effortTxt = (tieneEsfuerzo && cfgEffortSel && cfgEffortSel.value)
        ? " · pensamiento " + cfgEffortSel.value : "";
      cfgSummary.textContent = "✓ " + (PROVIDER_LABEL[p] || p) + " · " + modelLabel(model) + effortTxt;
      cfgSummary.className = "cfg-summary is-ok";
    } else {
      cfgSummary.textContent = "⚠ " + warn;
      cfgSummary.className = "cfg-summary is-warn";
    }
    return ok;
  }

  // Prueba REAL las credenciales del proveedor activo contra el motor y refleja
  // el resultado honesto en el semáforo (verde = probado y funciona; rojo = falló).
  // No prueba ollama/openai-compat (el motor las marca como "sin prueba").
  function verifyProvider() {
    var p = cfgProviderSel.value;
    if (p === "ollama" || p === "openai-compat") return;
    if (!cfgSummary) return;
    cfgSummary.textContent = "⏳ Probando credenciales…";
    cfgSummary.className = "cfg-summary is-warn";
    hpCall("testProvider")
      .then(function (r) {
        if (r && r.ok && r.unknown) {
          // Ni sí ni no. Decirlo como cualquiera de los dos es peor que decirlo
          // como lo que es (el mismo criterio que el botón ⟳ de actualizar).
          cfgSummary.textContent = "· " + (r.detail || "no pude comprobarlo");
          cfgSummary.className = "cfg-summary is-warn";
        } else if (r && r.ok) {
          cfgSummary.textContent = "✓ Probado y funciona" + (r.detail ? " — " + r.detail : "");
          cfgSummary.className = "cfg-summary is-ok";
        } else {
          cfgSummary.textContent = "✗ " + ((r && r.error) || "credenciales no válidas");
          cfgSummary.className = "cfg-summary is-warn";
        }
      })
      .catch(function (e) {
        cfgSummary.textContent = "✗ No se pudo probar: " + ((e && e.message) || "");
        cfgSummary.className = "cfg-summary is-warn";
      });
  }

  function autoSave() {
    var body = { provider: cfgProviderSel.value, model: effectiveModel() };
    if (cfgEffortSel) body.effort = cfgEffortSel.value;
    // El log de diagnóstico lee esto para decir con qué se generó cada
    // marcador. Sin refrescarlo acá se quedaba con el modelo que había al abrir
    // el panel, y en el log de otra máquina eso es lo primero que se mira.
    if (body.model) modelNameValue = body.model;
    if (cfgApiKey.value.trim()) body.apiKey = cfgApiKey.value.trim();
    if (cfgBaseUrl.value.trim()) body.baseUrl = cfgBaseUrl.value.trim();
    if (!body.model) { updateSummary(); return; }
    configStatus.textContent = "Guardando…";
    hpCall("setConfig", body)
      .then(function () {
        configStatus.textContent = "✓ Guardado";
        if (cfgApiKey.value.trim()) { cfgApiKey.setAttribute("data-has", "1"); cfgApiKey.value = ""; cfgApiKey.setAttribute("placeholder", "•••• (guardada)"); }
        if (updateSummary()) verifyProvider();
      })
      .catch(function (e) {
        configStatus.textContent = "Error al guardar: " + ((e && e.message) || "");
      });
  }

  // Autopobla la lista de Claude con los modelos que la cuenta tiene DE VERDAD
  // (el motor consulta /v1/models de Anthropic). Así un modelo nuevo aparece sin
  // tocar código. Si falla, se queda la lista de respaldo y se avisa.
  function refreshClaudeModels(selected) {
    hpCall("listClaudeModels")
      .then(function (r) {
        if (!r || !r.ok || !r.models || !r.models.length) {
          // El motivo, no solo "no pude": esta lista se consulta con la sesión
          // guardada, así que casi siempre el motivo es que todavía no hay
          // sesión — y eso ya se está diciendo dos renglones más abajo. Sin el
          // detalle, parecía una segunda falla misteriosa.
          if (modelsHint) {
            modelsHint.textContent = "lista de respaldo — " +
              ((r && r.error) ? r.error : "no pude consultar los modelos de tu cuenta");
          }
          return;
        }
        // `ventana` es el max_input_tokens que informa la API. Cuando viene, el
        // selector le hace caso antes que a nuestra tabla: es el número de la
        // cuenta de verdad. Cuando no (la respuesta lo admite en null), queda 0
        // y manda la tabla.
        var list = r.models.map(function (m) {
          return { v: m.id, t: m.name || m.id, ventana: Number(m.maxInputTokens) || 0 };
        });
        // Los dos proveedores Claude comparten catálogo: hay que reasignar los dos.
        MODELS["claude-cli"] = list;
        MODELS["claude-api"] = list;
        if (modelsHint) modelsHint.textContent = list.length + " modelos de tu cuenta" + (r.cached ? "" : " · al día");
        var p = cfgProviderSel.value;
        if (p === "claude-cli" || p === "claude-api") {
          populateModels(p, selected || effectiveModel());
          applyProviderUI();
          updateSummary();
        }
      })
      .catch(function () {
        if (modelsHint) modelsHint.textContent = "lista de respaldo (motor no disponible)";
      });
  }

  // Autopobla la lista de Cursor con los modelos que la suscripción tiene de
  // verdad (el motor corre `cursor-agent --list-models` y la cura).
  function refreshCursorModels(selected) {
    if (modelsHint) modelsHint.textContent = "consultando modelos de Cursor…";
    hpCall("listCursorModels")
      .then(function (r) {
        if (!r || !r.ok || !r.models || !r.models.length) {
          if (modelsHint) {
            modelsHint.textContent = "lista de respaldo — " +
              ((r && r.error) ? "revisá que tengas el CLI de Cursor con sesión" : "no pude consultar tu cuenta");
          }
          return;
        }
        MODELS["cursor-cli"] = r.models.map(function (m) {
          // family/effort los separa el motor (cursor-cli.js). Un modelo que
          // llegue sin ellos —Cursor renombró todo y el filtro no reconoció
          // nada— queda como su propia familia sin niveles: se sigue pudiendo
          // elegir, que es lo que importa.
          return { v: m.id, t: m.name || m.id, family: m.family || m.id, effort: m.effort || "" };
        });
        if (modelsHint) modelsHint.textContent = r.models.length + " modelos de tu cuenta de Cursor" + (r.cached ? "" : " · al día");
        if (cfgProviderSel.value === "cursor-cli") {
          populateModels("cursor-cli", selected || effectiveModel());
          applyProviderUI();
          updateSummary();
        }
      })
      .catch(function () {
        if (modelsHint) modelsHint.textContent = "lista de respaldo (motor no disponible)";
      });
  }

  // Autopobla la lista de Ollama con los modelos realmente instalados.
  function refreshOllamaModels(selected) {
    var base = (cfgBaseUrl.value || "").trim();
    hpCall("listOllamaModels", base)
      .then(function (r) {
        if (r && r.ok && r.models && r.models.length) {
          var list = r.models.map(function (m) {
            // Marcar los modelos con visión (pueden leer los stills).
            var vision = /(-vl|vision|llava)/i.test(m);
            return { v: m, t: m + (vision ? "  👁 visión" : "") };
          });
          list.push({ v: "__custom__", t: "Otro (escribir ID)…" });
          MODELS["ollama"] = list;
          if (cfgProviderSel.value === "ollama") { populateModels("ollama", selected || effectiveModel()); applyProviderUI(); updateSummary(); }
        }
      })
      .catch(function () {});
  }

  // Vuelca una config (del motor) a los controles del panel.
  function applyConfigToUI(cfg) {
    if (!cfg) return;
    if (cfg.provider) cfgProviderSel.value = cfg.provider;
    providerIsLocal = (cfg.provider === "ollama");
    modelNameValue = cfg.model || "";
    // Provisorio: con credencial nuestra guardada ya sabemos que sí; sin ella NO
    // sabemos nada todavía, así que "?" y no "no". La respuesta buena la trae
    // refreshClaudeSession()/refreshCursorSession() un cuarto de segundo después.
    //
    // `hasSession` es el token OAuth de Claude, así que solo vale para Claude:
    // leerlo con Cursor elegido pintaría verde por la credencial de otro
    // proveedor. Lo que cuenta en Cursor es la API key de su propio slot.
    if (cfg.provider === "cursor-cli") currentSession = cfg.apiKey ? "si" : "?";
    else currentSession = cfg.hasSession ? "si" : "?";
    cfgBaseUrl.value = cfg.baseUrl || "";
    cfgApiKey.value = "";
    if (cfg.apiKey) { cfgApiKey.setAttribute("data-has", "1"); cfgApiKey.setAttribute("placeholder", "•••• (guardada)"); }
    else { cfgApiKey.removeAttribute("data-has"); cfgApiKey.setAttribute("placeholder", "Pegá tu API key"); }
    if (cfg.hasSession && loginStatus) { loginStatus.textContent = "✓ Sesión de Claude activa"; loginStatus.className = "muted login-ok"; }
    if (cfgEffortSel) cfgEffortSel.value = cfg.effort || "high";
    // cfg.model viene del motor, que ya aplica el default por proveedor.
    populateModels(cfgProviderSel.value, cfg.model);
    applyProviderUI();
    updateSummary();
    if (cfgProviderSel.value === "ollama") refreshOllamaModels(cfg.model);
    if (cfgProviderSel.value === "claude-cli" || cfgProviderSel.value === "claude-api") refreshClaudeModels(cfg.model);
    if (cfgProviderSel.value === "cursor-cli") refreshCursorModels(cfg.model);
    if (cfgProviderSel.value === "claude-cli") refreshClaudeSession();
    if (cfgProviderSel.value === "cursor-cli") refreshCursorSession();
  }

  // Le pregunta al motor si el CLI de Claude puede autenticarse acá (él se lo
  // pregunta al CLI: gratis, sin red y en un cuarto de segundo). Es lo ÚNICO
  // que puede afirmar que falta la sesión. Si no se pudo averiguar, queda en
  // "?" y el resumen no dice nada: asustar sin motivo manda al editor a
  // "arreglar" algo que le venía funcionando.
  /**
   * Qué hace el panel con la respuesta del chequeo de sesión.
   *
   * Es UNA sola función para los dos proveedores de CLI a propósito: la regla
   * —solo se avisa cuando se SABE que falta— es la misma, y tenerla escrita dos
   * veces es cómo se arregla en una y se olvida en la otra. Cursor nació sin
   * nada de esto justamente porque el arreglo de Claude no era compartible.
   */
  function aplicarSesion(s, opts) {
    if (s.estado === "con-sesion") {
      currentSession = "si";
    } else if (s.estado === "sin-cupo") {
      currentSession = "cupo"; currentSessionWarn = "sin cupo en tu cuenta de " + opts.marca;
    } else if (s.estado === "sin-sesion") {
      currentSession = "no"; currentSessionWarn = "iniciá sesión en " + opts.marca;
    } else if (s.estado === "sin-cli") {
      currentSession = "no"; currentSessionWarn = "falta el CLI de " + opts.marca;
    } else {
      currentSession = "?";
    }
    if (opts.linea && s.resumen) {
      opts.linea.textContent = s.resumen + (s.detalle ? "\n" + s.detalle : "");
      opts.linea.className = "muted " +
        (currentSession === "si" ? "login-ok"
          : currentSession === "cupo" ? "login-warn"
            : currentSession === "no" ? "login-err" : "");
    }
  }

  function refreshClaudeSession() {
    hpCall("claudeSessionStatus")
      .then(function (s) {
        if (!s || cfgProviderSel.value !== "claude-cli") return;
        // Con qué credencial entra decide qué ventana se puede prometer, así
        // que las etiquetas del desplegable se rearman cuando cambia: hasta que
        // llega esta respuesta, el panel no sabe y muestra el piso.
        var antes = currentAuthMethod;
        currentAuthMethod = (s.estado === "con-sesion") ? String(s.metodo || "") : "";
        aplicarSesion(s, { marca: "Claude", linea: loginStatus });
        if (antes !== currentAuthMethod) populateModels("claude-cli", effectiveModel());
        updateSummary();
        updateContextNote();
      })
      .catch(function () { /* sin motor no se sabe, y no saber no es un problema */ });
  }

  // Lo mismo para Cursor. Hasta la 1.5.0 esto no existía: con Cursor elegido, el
  // panel no preguntaba nada y el editor solo se enteraba de que le faltaba la
  // sesión cuando una generación se caía con el error crudo del proceso.
  function refreshCursorSession() {
    hpCall("cursorSessionStatus")
      .then(function (s) {
        if (!s || cfgProviderSel.value !== "cursor-cli") return;
        aplicarSesion(s, { marca: "Cursor", linea: cursorStatus });
        updateSummary();
        updateContextNote();
      })
      .catch(function () { /* sin motor no se sabe, y no saber no es un problema */ });
  }

  function loadConfig() {
    hpCall("getConfig")
      .then(function (cfg) {
        applyConfigToUI(cfg);
        updateSummary();
      })
      .catch(function (e) {
        if (configStatus) configStatus.textContent = (e && e.message) || "Motor no disponible";
      });
  }

  // ── Micrófono del dictado ─────────────────────────────────────────────
  //
  // El DESPLEGABLE ya no vive acá: es de HPMicSelect (cep/js/mic-select.js),
  // porque desde la v1.4.49 el mismo control está también en el encabezado del
  // panel y dos copias se desincronizarían en el primer cambio. Lo que queda en
  // ⚙ es lo que es SOLO de ⚙: la línea de estado larga, el ↻ y "Probar
  // micrófono", que abre el elegido con el MISMO comando que el dictado y
  // muestra el nivel en vivo (HPMicMedidor).
  //
  // Todo lo que pasa acá queda en el ⬇ Log: la lista cada vez que se enumera,
  // la elección, y lo que el motor va contando de la prueba (que llega por
  // `note`). Es lo que hace falta para diagnosticar un micrófono desde lejos.

  function initMicrofono() {
    var status = document.getElementById("mic-status");
    var btnTest = document.getElementById("btn-mic-test");
    var meterBox = document.getElementById("mic-meter");
    if (typeof HPMicSelect === "undefined" || !HPMicSelect || !status) return;
    var hpLog = (typeof HPLog !== "undefined" && HPLog && HPLog.log) ? HPLog.log : function () {};
    var medidor = (typeof HPMicMedidor !== "undefined" && HPMicMedidor && meterBox) ? HPMicMedidor.crear(meterBox) : null;

    var vista = HPMicSelect.montar(document.getElementById("cfg-mic"), {
      status: status,
      refresh: document.getElementById("btn-mic-refresh"),
    });
    if (!vista) return;

    if (btnTest) btnTest.addEventListener("click", function () {
      btnTest.disabled = true;
      if (medidor) medidor.arrancar();
      hpLog("Prueba de micrófono: arranca desde ⚙.");
      HPEngine.callProg("microfonoProbar", {}, function (p) {
        if (!p) return;
        if (p.note) hpLog(p.note, p.level || "INFO");
        if (medidor && p.msg) medidor.mensaje(p.msg);
        if (medidor && p.nivel) medidor.nivel(p.nivel);
      }).then(function (r) {
        btnTest.disabled = false;
        if (!r || !r.ok) {
          var motivo = (r && r.error) || "el motor no devolvió nada";
          if (medidor) medidor.veredicto({ estado: "error", titulo: "La prueba no pudo correr.", detalle: motivo });
          hpLog("Prueba de micrófono: no pudo correr: " + motivo, "ERROR");
          return;
        }
        if (medidor) medidor.veredicto(r);
        hpLog("Prueba de micrófono: terminó con veredicto «" + r.estado + "».", r.estado === "ok" ? "INFO" : "WARN");
      }).catch(function (e) {
        btnTest.disabled = false;
        var motivo = (e && e.message) || String(e);
        if (medidor) medidor.veredicto({ estado: "error", titulo: "La prueba se cayó.", detalle: motivo });
        hpLog("Prueba de micrófono: se cayó: " + motivo, "ERROR");
      });
    });

    HPMicSelect.refrescar("al abrir el panel");
  }

  function init() {
    cfgProviderSel = HPWidgets.select(document.getElementById("cfg-provider"));
    cfgModelSel = HPWidgets.select(document.getElementById("cfg-model"));
    cfgEffortSel = HPWidgets.select(document.getElementById("cfg-effort"));
    modelsHint = document.getElementById("models-hint");
    cfgContext = document.getElementById("cfg-context");
    cfgModelCustom = document.getElementById("cfg-model-custom");
    cfgApiKey = document.getElementById("cfg-apikey");
    cfgBaseUrl = document.getElementById("cfg-baseurl");
    btnSaveConfig = document.getElementById("btn-save-config");
    configStatus = document.getElementById("config-status");
    cfgSummary = document.getElementById("cfg-summary");
    btnLoginClaude = document.getElementById("btn-login-claude");
    loginStatus = document.getElementById("login-status");
    cursorStatus = document.getElementById("cursor-status");
    apikeyHint = document.getElementById("apikey-hint");

    // Overlay de configuración: se abre con el botón ⚙ del header (antes era
    // un desplegable incómodo al fondo del panel).
    var overlay = document.getElementById("config-overlay");
    var btnOpen = document.getElementById("btn-config");
    var btnClose = document.getElementById("btn-config-close");
    function showConfig(show) {
      if (overlay) overlay.setAttribute("data-hidden", show ? "false" : "true");
    }
    if (btnOpen) btnOpen.addEventListener("click", function () {
      showConfig(overlay && overlay.getAttribute("data-hidden") !== "false");
    });
    if (btnClose) btnClose.addEventListener("click", function () { showConfig(false); });
    if (overlay) overlay.addEventListener("click", function (e) { if (e.target === overlay) showConfig(false); });

    // Diseños en paralelo (concurrencia del carril de modelo de la cola).
    var cfgConcurrency = document.getElementById("cfg-concurrency");
    if (cfgConcurrency) {
      cfgConcurrency.value = String(HPQueue.getModelConcurrency());
      cfgConcurrency.addEventListener("change", function () {
        var n = HPQueue.setModelConcurrency(cfgConcurrency.value);
        cfgConcurrency.value = String(n);
      });
    }

    // Opciones fijas del proveedor.
    cfgProviderSel.setOptions([
      { value: "claude-cli", label: "Claude (CLI / suscripción)" },
      { value: "claude-api", label: "Claude (API key)" },
      { value: "cursor-cli", label: "Cursor (CLI / suscripción)" },
      { value: "openai-compat", label: "API compatible (OpenAI / Gemini / OpenRouter…)" },
      { value: "ollama", label: "Local (Ollama)" }
    ], "claude-cli");

    // Cambiar de proveedor: guarda el proveedor activo y RESTAURA las credenciales
    // guardadas de ese proveedor (no se pierden al saltar entre modelos).
    cfgProviderSel.onChange = function () {
      configStatus.textContent = "Cambiando…";
      hpCall("setConfig", { provider: cfgProviderSel.value })
        .then(function (cfg) { applyConfigToUI(cfg); configStatus.textContent = "✓ Guardado"; if (updateSummary()) verifyProvider(); })
        .catch(function (e) { configStatus.textContent = "Error: " + ((e && e.message) || ""); });
    };
    cfgModelSel.onChange = function () {
      // En Cursor, cambiar de familia puede cambiar los niveles disponibles
      // (no todas ofrecen los mismos), así que el desplegable de al lado se
      // rearma antes de guardar: lo que se guarda es el ID que sale de los dos.
      if (cfgProviderSel.value === "cursor-cli") {
        populateEfforts(cfgEffortSel ? cfgEffortSel.value : "high");
      }
      applyProviderUI();
      autoSave();
    };

    // Nivel de pensamiento: se guarda solo al cambiarlo.
    if (cfgEffortSel) {
      cfgEffortSel.setOptions(EFFORT_LEVELS.map(function (o) {
        return { value: o.v, label: o.t };
      }), "high");
      cfgEffortSel.onChange = function () { autoSave(); };
    }
    if (cfgModelCustom) cfgModelCustom.addEventListener("input", debounce(function () { updateSummary(); }, DEBOUNCE_MS));
    if (cfgApiKey) cfgApiKey.addEventListener("input", function () { updateSummary(); });
    if (cfgBaseUrl) cfgBaseUrl.addEventListener("input", debounce(function () { updateSummary(); }, DEBOUNCE_MS));
    if (btnSaveConfig) btnSaveConfig.addEventListener("click", autoSave);

    // ── Login de Claude en dos fases ────────────────────────────────
    // Fase 1: el motor arranca `claude setup-token` y devuelve la URL a
    // autorizar → la abrimos en el navegador y mostramos el campo del código.
    // Fase 2: el usuario pega el código → el motor lo envía y guarda el token.
    // También hay pegado directo del token (camino universal).
    var loginCodeRow = document.getElementById("login-code-row");
    var loginCodeInput = document.getElementById("login-code");
    var btnLoginCode = document.getElementById("btn-login-code");
    var loginUrlLink = document.getElementById("login-url-link");
    var loginTokenInput = document.getElementById("login-token");
    var btnLoginToken = document.getElementById("btn-login-token");
    var loginUrl = "";

    function openInBrowser(url) {
      try { new CSInterface().openURLInDefaultBrowser(url); return; } catch (e) {}
      try { window.open(url, "_blank"); } catch (e) {}
    }
    function onLoginSuccess() {
      loginStatus.textContent = "✓ Sesión de Claude activa";
      loginStatus.className = "muted login-ok";
      if (loginCodeRow) loginCodeRow.setAttribute("data-hidden", "true");
      cfgProviderSel.value = "claude-cli";
      currentSession = "si";
      populateModels(cfgProviderSel.value, effectiveModel());
      applyProviderUI();
      autoSave();
      verifyProvider();
    }
    // El motor ya devuelve un diagnóstico completo y en renglones (qué falló,
    // dónde está el CLI, qué versión, qué hacer): se muestra TAL CUAL. Antes se
    // le anteponía un cartel fijo que muchas veces contradecía al mensaje real.
    function loginErr(msg) {
      loginStatus.textContent = msg || "El login falló y el motor no dijo por qué.";
      loginStatus.className = "muted login-err";
      // Cualquiera sea la falla del CLI, pegar el token a mano sigue andando:
      // dejamos ese camino a la vista en vez de que quede escondido.
      var manual = document.getElementById("login-manual");
      if (manual) manual.open = true;
    }

    if (btnLoginClaude) {
      btnLoginClaude.addEventListener("click", function () {
        btnLoginClaude.disabled = true;
        loginStatus.textContent = "Abriendo la autorización de Claude…";
        loginStatus.className = "muted";
        hpCall("loginClaudeStart")
          .then(function (data) {
            if (!data || !data.ok) { loginErr(data && data.error); return; }
            if (data.provider) { onLoginSuccess(); return; } // ya estaba logueado
            // Fase 2: abrir la URL y pedir el código.
            loginUrl = data.url || "";
            if (loginUrl) openInBrowser(loginUrl);
            if (loginCodeRow) loginCodeRow.setAttribute("data-hidden", "false");
            loginStatus.textContent = "Autorizá en el navegador y pegá acá el código que te muestra la página.";
            loginStatus.className = "muted";
            if (loginCodeInput) loginCodeInput.focus();
          })
          .catch(function (e) { loginErr((e && e.message)); })
          .then(function () { btnLoginClaude.disabled = false; });
      });
    }
    // Diagnóstico a pedido: la misma ficha que viaja en los errores, pero sin
    // tener que fallar primero. Es lo que le pedimos al editor por captura
    // cuando el login no anda en su máquina y no la tenemos adelante.
    var btnLoginDoctor = document.getElementById("btn-login-doctor");
    if (btnLoginDoctor) btnLoginDoctor.addEventListener("click", function () {
      btnLoginDoctor.disabled = true;
      loginStatus.textContent = "Revisando el CLI de Claude…";
      loginStatus.className = "muted";
      hpCall("claudeCliStatus")
        .then(function (r) {
          loginStatus.textContent = (r && r.report) || "No pude armar el diagnóstico.";
          loginStatus.className = "muted " + (r && r.ok ? "login-ok" : "login-err");
        })
        .catch(function (e) { loginErr("No pude correr el diagnóstico: " + ((e && e.message) || "")); })
        .then(function () { btnLoginDoctor.disabled = false; });
    });

    // El mismo Diagnóstico, para Cursor. Es el botón que le pedimos al editor
    // que apriete cuando algo no anda en su máquina y no la tenemos adelante:
    // contesta si el CLI está, en qué ruta, qué versión y con qué credencial
    // entra, todo en un texto que entra en una captura.
    var btnCursorDoctor = document.getElementById("btn-cursor-doctor");
    if (btnCursorDoctor) btnCursorDoctor.addEventListener("click", function () {
      btnCursorDoctor.disabled = true;
      cursorStatus.textContent = "Revisando el CLI de Cursor…";
      cursorStatus.className = "muted";
      hpCall("cursorCliStatus")
        .then(function (r) {
          cursorStatus.textContent = (r && r.report) || "No pude armar el diagnóstico.";
          cursorStatus.className = "muted " + (r && r.ok ? "login-ok" : "login-err");
        })
        .catch(function (e) {
          cursorStatus.textContent = "No pude correr el diagnóstico: " + ((e && e.message) || "");
          cursorStatus.className = "muted login-err";
        })
        .then(function () { btnCursorDoctor.disabled = false; });
    });

    if (loginUrlLink) loginUrlLink.addEventListener("click", function (e) {
      e.preventDefault(); if (loginUrl) openInBrowser(loginUrl);
    });
    if (btnLoginCode) btnLoginCode.addEventListener("click", function () {
      var code = (loginCodeInput && loginCodeInput.value || "").trim();
      if (!code) { loginErr("pegá el código primero"); return; }
      btnLoginCode.disabled = true;
      loginStatus.textContent = "Validando el código…"; loginStatus.className = "muted";
      hpCall("loginClaudeCode", { code: code })
        .then(function (r) { if (r && r.ok) onLoginSuccess(); else loginErr(r && r.error); })
        .catch(function (e) { loginErr(e && e.message); })
        .then(function () { btnLoginCode.disabled = false; });
    });
    if (btnLoginToken) btnLoginToken.addEventListener("click", function () {
      var token = (loginTokenInput && loginTokenInput.value || "").trim();
      if (!token) { loginErr("pegá el token primero"); return; }
      btnLoginToken.disabled = true;
      loginStatus.textContent = "Guardando el token…"; loginStatus.className = "muted";
      hpCall("loginClaudeToken", { token: token })
        .then(function (r) { if (r && r.ok) { if (loginTokenInput) loginTokenInput.value = ""; onLoginSuccess(); } else loginErr(r && r.error); })
        .catch(function (e) { loginErr(e && e.message); })
        .then(function () { btnLoginToken.disabled = false; });
    });

    // El promedio de consumo sale del contador de la sesión, así que después de
    // cada generación el renglón dice otro número. Se escucha en vez de
    // recalcularlo al abrir ⚙: el overlay puede quedar abierto mientras la cola
    // trabaja.
    if (typeof HPStore !== "undefined" && HPStore && HPStore.onUsageChange) {
      HPStore.onUsageChange(updateContextNote);
    }

    loadConfig();
    initMicrofono();
  }

  global.HPConfigUI = {
    init: init,
    /** true si el proveedor activo corre en esta máquina (Ollama). */
    isLocalProvider: function () { return providerIsLocal; },
    /** Nombre del modelo activo (para el log de diagnóstico). */
    modelName: function () { return modelNameValue; },
    /**
     * Nivel de pensamiento activo, o '' si el proveedor no tiene ninguno.
     *
     * Va al log junto con el modelo porque es la otra mitad de "con qué se
     * generó esto": dos corridas con el mismo modelo y distinto nivel dan
     * resultados distintos, y sin este dato el log de otra máquina no alcanza
     * para comparar contra la propia.
     */
    effortName: function () {
      var p = cfgProviderSel && cfgProviderSel.value;
      if (p !== "claude-cli" && p !== "claude-api" && p !== "cursor-cli") return "";
      return (cfgEffortSel && cfgEffortSel.value) || "";
    }
  };
})(typeof window !== "undefined" ? window : this);
