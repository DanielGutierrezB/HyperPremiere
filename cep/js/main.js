(function () {
  "use strict";

  var csInterface = new CSInterface();

  var btnTestConnection = document.getElementById("btn-test-connection");
  var btnLoadMarkers = document.getElementById("btn-load-markers");
  var output = document.getElementById("output");
  var markersContainer = document.getElementById("markers");

  function setOutput(text, isError) {
    output.textContent = text;
    output.classList.toggle("is-error", Boolean(isError));
  }

  function formatTime(seconds) {
    var total = Math.floor(seconds);
    var mm = Math.floor(total / 60);
    var ss = total % 60;
    return (mm < 10 ? "0" + mm : mm) + ":" + (ss < 10 ? "0" + ss : ss);
  }

  function onTestConnection() {
    setOutput("Consultando secuencia activa…", false);

    csInterface.evalScript("hp_getActiveSequenceName()", function (result) {
      if (result === undefined || result === null || result === "EvalScript error.") {
        setOutput("Error al comunicarse con Premiere (EvalScript).", true);
        return;
      }
      setOutput("Secuencia activa: " + result, false);
    });
  }

  function selectCard(card) {
    var cards = markersContainer.querySelectorAll(".marker-card");
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.remove("is-selected");
    }
    card.classList.add("is-selected");
  }

  function onCardClick(card, marker) {
    selectCard(card);
    csInterface.evalScript("hp_seekToTime(" + marker.start + ")", function (result) {
      if (result !== "ok") {
        setOutput("No se pudo mover el playhead: " + result, true);
      }
    });
  }

  function createMarkerCard(marker) {
    var card = document.createElement("div");
    card.className = "marker-card";

    var name = document.createElement("div");
    name.className = "marker-name";
    name.textContent = marker.name || "Marcador " + (marker.index + 1);

    var meta = document.createElement("div");
    meta.className = "marker-meta";
    meta.textContent = formatTime(marker.start) + " · " + marker.duration.toFixed(1) + " s";

    card.appendChild(name);
    card.appendChild(meta);
    card.addEventListener("click", function () {
      onCardClick(card, marker);
    });
    return card;
  }

  function renderMarkers(markers) {
    markersContainer.innerHTML = "";

    if (markers.length === 0) {
      setOutput("La secuencia activa no tiene marcadores.", false);
      return;
    }

    for (var i = 0; i < markers.length; i++) {
      markersContainer.appendChild(createMarkerCard(markers[i]));
    }
    setOutput("Marcadores cargados: " + markers.length, false);
  }

  function onLoadMarkers() {
    setOutput("Cargando marcadores…", false);

    csInterface.evalScript("hp_getMarkers()", function (result) {
      if (result === undefined || result === null || result === "EvalScript error.") {
        setOutput("Error al comunicarse con Premiere (EvalScript).", true);
        return;
      }

      var data;
      try {
        data = JSON.parse(result);
      } catch (e) {
        setOutput("Respuesta inválida del host: " + result, true);
        return;
      }

      if (data && data.error) {
        markersContainer.innerHTML = "";
        setOutput(data.error, true);
        return;
      }

      renderMarkers(data);
    });
  }

  btnTestConnection.addEventListener("click", onTestConnection);
  btnLoadMarkers.addEventListener("click", onLoadMarkers);
})();
