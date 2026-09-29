// El SYSTEM PROMPT, armado en dos mitades.
//
// Hasta la 1.7.0 era un solo archivo (`system.md`) porque había un solo motor.
// Con dos, la mitad de ese texto seguía valiendo igual —la filosofía de diseño,
// las reglas de layout, la coreografía, el protocolo PLAN → CÓDIGO → AUDITORÍA—
// y la otra mitad hablaba de `#stage`, `data-duration` y GSAP.
//
// Copiar la parte común en los dos archivos habría sido la peor salida: son ~60
// líneas de criterio de diseño que se ajustan seguido (cada vez que un recurso
// sale feo se toca algo de ahí), y tenerlas dos veces garantiza que un día
// alguien mejore una y deje la otra vieja. El motor de Remotion saldría
// diseñando distinto que el de HyperFrames sin que nadie lo haya decidido.
//
// Así que: `system-comun.md` + `system-<motor>.md`, y el orden importa. Primero
// el criterio (qué es un buen recurso) y después el contrato (cómo se escribe en
// este motor): el modelo lee el porqué antes que el cómo.

'use strict';

const fs = require('fs');
const path = require('path');

const COMUN = path.join(__dirname, 'system-comun.md');

/** El system prompt completo de un motor: lo común + su contrato. */
function systemPrompt(archivoDelMotor) {
  const comun = fs.readFileSync(COMUN, 'utf8').trim();
  const propio = fs.readFileSync(path.join(__dirname, archivoDelMotor), 'utf8').trim();
  return comun + '\n\n' + propio + '\n';
}

module.exports = { systemPrompt, COMUN };
