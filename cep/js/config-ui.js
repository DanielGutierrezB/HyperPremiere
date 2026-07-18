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
  var currentHasSession = false;

  var cfgProviderSel = null;
  var cfgModelSel = null;
  var cfgModelCustom, cfgApiKey, cfgBaseUrl, btnSaveConfig, configStatus, cfgSummary;
  var btnLoginClaude, loginStatus;

  // Modelos compatibles por proveedor. Claude corre por CLI o API; los demás
  // por API compatible (OpenAI/Gemini/OpenRouter) o local (Ollama).
  var CLAUDE_MODELS = [
    { v: "claude-sonnet-5", t: "Sonnet 5 — rápido (recomendado)" },
    { v: "claude-opus-4-8", t: "Opus 4.8 — máxima calidad (lento)" },
    { v: "claude-haiku-4-5-20251001", t: "Haiku 4.5 — el más rápido" },
    { v: "claude-fable-5", t: "Fable 5" }
  ];
  var MODELS = {
    "claude-cli": CLAUDE_MODELS,
    "claude-api": CLAUDE_MODELS,
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

  // Rellena el desplegable de modelos según el proveedor y marca el activo.
  function populateModels(provider, selected) {
    var list = MODELS[provider] || CLAUDE_MODELS;
    var matched = false;
    for (var i = 0; i < list.length; i++) if (list[i].v === selected) matched = true;
    var opts = list.map(function (o) { return { value: o.v, label: o.t }; });
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
  function effectiveModel() {
    if (cfgModelSel.value === "__custom__") return (cfgModelCustom.value || "").trim();
    return cfgModelSel.value;
  }

  function modelLabel(id) {
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
    showRow("row-login", p === "claude-cli");
    showRow("row-apikey", p === "claude-api" || p === "openai-compat");
    showRow("row-baseurl", p === "openai-compat" || p === "ollama");
    showRow("row-model-custom", cfgModelSel.value === "__custom__");
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
      } else {
        noteEl.setAttribute("data-hidden", "true");
      }
    }
  }

  // Semáforo del resumen: verde si el proveedor está listo, aviso si falta algo.
  function updateSummary() {
    if (!cfgSummary) return;
    var p = cfgProviderSel.value;
    var model = effectiveModel();
    var ok = true, warn = "";
    if (p === "claude-cli" && !currentHasSession) { ok = false; warn = "iniciá sesión en Claude"; }
    if (p === "claude-api" && !(cfgApiKey.value.trim() || cfgApiKey.getAttribute("data-has") === "1")) { ok = false; warn = "falta API key"; }
    if (p === "openai-compat" && !cfgBaseUrl.value.trim()) { ok = false; warn = "falta Base URL"; }
    if (!model) { ok = false; warn = "falta el modelo"; }
    if (ok) {
      cfgSummary.textContent = "✓ " + (PROVIDER_LABEL[p] || p) + " · " + modelLabel(model);
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
        if (r && r.ok) {
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
    currentHasSession = Boolean(cfg.hasSession);
    cfgBaseUrl.value = cfg.baseUrl || "";
    cfgApiKey.value = "";
    if (cfg.apiKey) { cfgApiKey.setAttribute("data-has", "1"); cfgApiKey.setAttribute("placeholder", "•••• (guardada)"); }
    else { cfgApiKey.removeAttribute("data-has"); cfgApiKey.setAttribute("placeholder", "Pegá tu API key"); }
    if (cfg.hasSession && loginStatus) { loginStatus.textContent = "✓ Sesión de Claude activa"; loginStatus.className = "muted login-ok"; }
    // cfg.model viene del motor, que ya aplica el default por proveedor.
    populateModels(cfgProviderSel.value, cfg.model);
    applyProviderUI();
    updateSummary();
    if (cfgProviderSel.value === "ollama") refreshOllamaModels(cfg.model);
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

  function init() {
    cfgProviderSel = HPWidgets.select(document.getElementById("cfg-provider"));
    cfgModelSel = HPWidgets.select(document.getElementById("cfg-model"));
    cfgModelCustom = document.getElementById("cfg-model-custom");
    cfgApiKey = document.getElementById("cfg-apikey");
    cfgBaseUrl = document.getElementById("cfg-baseurl");
    btnSaveConfig = document.getElementById("btn-save-config");
    configStatus = document.getElementById("config-status");
    cfgSummary = document.getElementById("cfg-summary");
    btnLoginClaude = document.getElementById("btn-login-claude");
    loginStatus = document.getElementById("login-status");

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
      applyProviderUI();
      autoSave();
    };
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
      currentHasSession = true;
      populateModels(cfgProviderSel.value, effectiveModel());
      applyProviderUI();
      autoSave();
      verifyProvider();
    }
    function loginErr(msg, isCliMissing) {
      loginStatus.textContent = (isCliMissing
        ? "No encontré el CLI de Claude. Instalalo (claude.ai/download) o pegá el token directamente abajo. "
        : "Error: ") + (msg || "login falló");
      loginStatus.className = "muted login-err";
    }

    if (btnLoginClaude) {
      btnLoginClaude.addEventListener("click", function () {
        btnLoginClaude.disabled = true;
        loginStatus.textContent = "Abriendo la autorización de Claude…";
        loginStatus.className = "muted";
        hpCall("loginClaudeStart")
          .then(function (data) {
            if (!data || !data.ok) { loginErr(data && data.error, data && data.needCli); return; }
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

    loadConfig();
  }

  global.HPConfigUI = {
    init: init,
    /** true si el proveedor activo corre en esta máquina (Ollama). */
    isLocalProvider: function () { return providerIsLocal; },
    /** Nombre del modelo activo (para el log de diagnóstico). */
    modelName: function () { return modelNameValue; }
  };
})(typeof window !== "undefined" ? window : this);
