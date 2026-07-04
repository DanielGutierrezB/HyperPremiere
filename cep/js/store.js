/**
 * HPStore — persistencia local del panel HyperPremiere.
 *
 * Guarda todo el estado editable (objetivo, transcript, datos por marcador)
 * en un unico objeto JSON por "contexto" (proyecto + secuencia) dentro de
 * localStorage. La clave de almacenamiento es "hyperpremiere::<ns>", donde
 * <ns> es un hash simple de projectPath + "::" + sequenceName.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPStore.
 */
(function (global) {
  'use strict';

  var STORAGE_PREFIX = 'hyperpremiere::';

  // Clave activa de localStorage; null hasta que se llame a setContext().
  var activeKey = null;

  /**
   * Hash simple (djb2) de una cadena. Suficiente para generar un namespace
   * corto y estable; no necesita ser criptografico.
   */
  function simpleHash(str) {
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0; // hash * 33 + c
    }
    // Valor sin signo en base 36 para una clave compacta.
    return (hash >>> 0).toString(36);
  }

  /**
   * Estructura vacia del estado de un contexto.
   */
  function emptyState() {
    return {
      objective: '',
      transcript: [],
      markers: {} // markerKey -> { instruction: "", stills: [] }
    };
  }

  /**
   * Lee y parsea el estado del contexto activo. Cualquier error (sin
   * contexto, localStorage inaccesible, JSON invalido) devuelve un estado
   * vacio para que el resto del panel nunca reciba null.
   */
  function readState() {
    if (!activeKey) {
      return emptyState();
    }
    try {
      var raw = global.localStorage.getItem(activeKey);
      if (!raw) {
        return emptyState();
      }
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return emptyState();
      }
      // Completar campos que falten (datos viejos o corruptos parcialmente).
      if (typeof parsed.objective !== 'string') parsed.objective = '';
      if (!isArray(parsed.transcript)) parsed.transcript = [];
      if (!parsed.markers || typeof parsed.markers !== 'object') parsed.markers = {};
      return parsed;
    } catch (e) {
      return emptyState();
    }
  }

  /**
   * Serializa y guarda el estado en el contexto activo. Silencioso ante
   * errores (cuota llena, localStorage deshabilitado, etc.).
   */
  function writeState(state) {
    if (!activeKey) {
      return;
    }
    try {
      global.localStorage.setItem(activeKey, JSON.stringify(state));
    } catch (e) {
      // No propagamos: la persistencia es best-effort.
    }
  }

  /**
   * Devuelve la entrada de un marcador dentro del estado, creandola si no
   * existe. Muta `state` — el caller debe llamar a writeState() despues.
   */
  function ensureMarker(state, markerKey) {
    var key = String(markerKey);
    var entry = state.markers[key];
    if (!entry || typeof entry !== 'object') {
      entry = { instruction: '', stills: [] };
      state.markers[key] = entry;
    }
    if (typeof entry.instruction !== 'string') entry.instruction = '';
    if (!isArray(entry.stills)) entry.stills = [];
    return entry;
  }

  function isArray(value) {
    return Object.prototype.toString.call(value) === '[object Array]';
  }

  var HPStore = {
    /**
     * Fija el contexto activo (proyecto + secuencia). Todas las lecturas y
     * escrituras posteriores operan sobre este namespace.
     */
    setContext: function (projectPath, sequenceName) {
      var ns = simpleHash(String(projectPath) + '::' + String(sequenceName));
      activeKey = STORAGE_PREFIX + ns;
    },

    /** Objetivo general de la edicion. */
    getObjective: function () {
      return readState().objective;
    },

    setObjective: function (text) {
      var state = readState();
      state.objective = String(text == null ? '' : text);
      writeState(state);
    },

    /** Transcript: array de segmentos (forma definida por el caller). */
    getTranscript: function () {
      return readState().transcript;
    },

    setTranscript: function (segmentsArray) {
      var state = readState();
      state.transcript = isArray(segmentsArray) ? segmentsArray : [];
      writeState(state);
    },

    /**
     * Datos de un marcador. Nunca devuelve null: si no hay nada guardado,
     * devuelve { instruction: "", stills: [] }.
     */
    getMarkerData: function (markerKey) {
      var state = readState();
      var entry = state.markers[String(markerKey)];
      if (!entry || typeof entry !== 'object') {
        return { instruction: '', stills: [] };
      }
      return {
        instruction: typeof entry.instruction === 'string' ? entry.instruction : '',
        stills: isArray(entry.stills) ? entry.stills : [],
        generated: Boolean(entry.generated)
      };
    },

    /** Marca si el marcador ya tuvo al menos una generación exitosa. */
    setMarkerGenerated: function (markerKey, value) {
      var state = readState();
      var entry = ensureMarker(state, markerKey);
      entry.generated = Boolean(value);
      writeState(state);
    },

    setMarkerInstruction: function (markerKey, text) {
      var state = readState();
      var entry = ensureMarker(state, markerKey);
      entry.instruction = String(text == null ? '' : text);
      writeState(state);
    },

    /** Agrega un still (data URL) al marcador. */
    addMarkerStill: function (markerKey, dataUrl) {
      var state = readState();
      var entry = ensureMarker(state, markerKey);
      entry.stills.push(String(dataUrl));
      writeState(state);
    },

    /** Quita el still en `index` del marcador; ignora indices invalidos. */
    removeMarkerStill: function (markerKey, index) {
      var state = readState();
      var entry = ensureMarker(state, markerKey);
      var i = parseInt(index, 10);
      if (isNaN(i) || i < 0 || i >= entry.stills.length) {
        return;
      }
      entry.stills.splice(i, 1);
      writeState(state);
    },

    /** Estado completo del contexto activo (copia parseada). */
    getAll: function () {
      return readState();
    },

    /** Borra todo lo guardado para el contexto activo. */
    clear: function () {
      if (!activeKey) {
        return;
      }
      try {
        global.localStorage.removeItem(activeKey);
      } catch (e) {
        // Best-effort.
      }
    }
  };

  global.HPStore = HPStore;
})(window);
