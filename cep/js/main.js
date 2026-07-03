(function () {
  "use strict";

  var csInterface = new CSInterface();

  var btnTestConnection = document.getElementById("btn-test-connection");
  var output = document.getElementById("output");

  function setOutput(text, isError) {
    output.textContent = text;
    output.classList.toggle("error", Boolean(isError));
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

  btnTestConnection.addEventListener("click", onTestConnection);
})();
