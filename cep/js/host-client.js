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

  // Cola de UNA sola vía para lo que MODIFICA el proyecto (importar, colocar,
  // agregar pistas, purgar). Leer el proyecto en paralelo no molesta, pero
  // escribirlo sí: dos colocaciones a la vez comparten el bin de la secuencia y
  // las pistas, así que la segunda puede mirar un proyecto a medio cambiar por la
  // primera y colocar el clip equivocado. Desde que el render corre en varios
  // carriles esto dejó de ser teórico. Serializar cuesta ~1s por clip y no toca
  // la ganancia (el render, que es lo caro, sigue en paralelo).
  var mutating = null; // promesa de la escritura en curso, o null
  function callMutating(expr, cb) {
    var prev = mutating || Promise.resolve();
    mutating = prev.then(function () {
      return new Promise(function (resolve) {
        call(expr, function (res) {
          try { if (cb) cb(res); } finally { resolve(); }
        });
      });
    });
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
    /**
     * Renderiza el AUDIO de la secuencia activa completa a `outPath` (.wav mono
     * 16 kHz, con el preset de Premiere). Es la fuente para transcribir: sale
     * la MEZCLA de la secuencia, así que los tiempos ya están alineados al
     * timeline. Devuelve "ok|<ruta>|<preset>" o "error: …".
     */
    exportSequenceAudio: function (outPath, cb) {
      call("hp_exportSequenceAudio(" + JSON.stringify(outPath) + ")", cb);
    },
    /**
     * Duración real de la secuencia (fin del último clip, todas las pistas).
     * Devuelve "ok|<segundos>" o "error: …". Referencia para validar las
     * unidades de tiempo de un transcript importado.
     */
    getSequenceDuration: function (cb) {
      call("hp_getSequenceDuration()", cb);
    },
    /**
     * Importa el video y lo coloca en la secuencia con etiqueta de color.
     * Serializada (ver callMutating): toca el bin y las pistas.
     *
     * `hasAudio` viaja como 1/0 y lo resuelve el motor con ffprobe (mediaHasAudio):
     * es lo que le permite al host agregar pista de audio SOLO cuando el archivo
     * trae sonido. Ante la duda va 0, que es lo que no le mueve las pistas al
     * editor; el audio del clip lo baja Premiere igual si existe.
     */
    placeClip: function (movPath, seqName, startSec, durationSec, colorLabel, hasAudio, cb) {
      callMutating("hp_placeClipInSequence(" + JSON.stringify(movPath) + ", " + JSON.stringify(seqName) + ", " +
        Number(startSec) + ", " + Number(durationSec) + ", " + Number(colorLabel) + ", " +
        (hasAudio ? 1 : 0) + ")", cb);
    },
    /** Recolorea el clip que arranca en startSec (marca "procesado en HQ"). */
    recolorClip: function (seqName, startSec, colorLabel, cb) {
      callMutating("hp_recolorClipAt(" + JSON.stringify(seqName) + ", " + Number(startSec) + ", " + Number(colorLabel) + ")", cb);
    },
    /**
     * Saca clips/ítems del proyecto por nombre de archivo ANTES de borrarlos
     * del disco. `names` = array de nombres; viajan unidos por "\n"
     * (ExtendScript no trae JSON.parse y los nombres nunca tienen saltos).
     */
    purgeClipsByName: function (names, cb) {
      callMutating("hp_purgeClipsByName(" + JSON.stringify((names || []).join("\n")) + ")", cb);
    }
  };
})(typeof window !== "undefined" ? window : this);
