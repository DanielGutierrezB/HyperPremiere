/**
 * HPHost — frontera ÚNICA con ExtendScript (cep/jsx/host.jsx), simétrica a
 * HPEngine para el motor Node: acá se arma cada llamada a evalScript con su
 * encodeo correcto, en vez de concatenar strings por todo el panel.
 *
 * Todas las funciones toman un callback estilo CEP (recibe el string crudo
 * que devuelve el host: "ok", "ok|...", JSON, o "error: ...").
 *
 * Vanilla JS, sin ES modules: se expone como window.HPHost.
 */
(function (global) {
  "use strict";

  var csInterface = new CSInterface();

  // CEP NO re-evalúa el ScriptPath (host.jsx) al recargar el panel: mantiene el
  // motor ExtendScript viejo en memoria. Lo recargamos explícitamente en cada
  // apertura para que los cambios del .jsx siempre tomen efecto.
  try {
    var ext = csInterface.getSystemPath(SystemPath.EXTENSION);
    csInterface.evalScript('$.evalFile("' + ext + '/jsx/host.jsx")');
  } catch (e) {}

  function call(expr, cb) {
    csInterface.evalScript(expr, cb || function () {});
  }

  global.HPHost = {
    getProjectPath: function (cb) { call("hp_getProjectPath()", cb); },
    getActiveSequenceName: function (cb) { call("hp_getActiveSequenceName()", cb); },
    /** Devuelve el JSON (string) de los marcadores de la secuencia activa. */
    getMarkers: function (cb) { call("hp_getMarkers()", cb); },
    seekTo: function (seconds, cb) { call("hp_seekToTime(" + Number(seconds) + ")", cb); },
    openSequenceAndSeek: function (seqName, seconds, cb) {
      call("hp_openSequenceAndSeek(" + JSON.stringify(seqName) + ", " + Number(seconds) + ")", cb);
    },
    /** Exporta el frame del monitor de programa. Devuelve "ok|<ruta>" o "error: …". */
    captureProgramFrame: function (tmpPath, cb) {
      call("hp_captureProgramFrame(" + JSON.stringify(tmpPath) + ")", cb);
    },
    /**
     * Info del clip principal de la secuencia (JSON string):
     * { ok, offset, mediaPath, clipName } — para el desfase del transcript
     * y para transcribir el medio original con Whisper local.
     */
    getPrimaryClipInfo: function (cb) {
      call("hp_getPrimaryClipInfo()", cb);
    },
    /** Importa el video y lo coloca en la secuencia con etiqueta de color. */
    placeClip: function (movPath, seqName, startSec, durationSec, colorLabel, cb) {
      call("hp_placeClipInSequence(" + JSON.stringify(movPath) + ", " + JSON.stringify(seqName) + ", " +
        Number(startSec) + ", " + Number(durationSec) + ", " + Number(colorLabel) + ")", cb);
    },
    /** Recolorea el clip que arranca en startSec (marca "procesado en HQ"). */
    recolorClip: function (seqName, startSec, colorLabel, cb) {
      call("hp_recolorClipAt(" + JSON.stringify(seqName) + ", " + Number(startSec) + ", " + Number(colorLabel) + ")", cb);
    },
    /**
     * Saca clips/ítems del proyecto por nombre de archivo ANTES de borrarlos
     * del disco. `names` = array de nombres; viajan unidos por "\n"
     * (ExtendScript no trae JSON.parse y los nombres nunca tienen saltos).
     */
    purgeClipsByName: function (names, cb) {
      call("hp_purgeClipsByName(" + JSON.stringify((names || []).join("\n")) + ")", cb);
    }
  };
})(typeof window !== "undefined" ? window : this);
