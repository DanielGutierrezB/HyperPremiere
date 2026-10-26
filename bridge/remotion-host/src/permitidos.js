// QUÉ PUEDE IMPORTAR una composición de Remotion escrita por el modelo.
//
// CommonJS a propósito, y es lo único de este proyecto que no es TSX: esta
// lista la leen DOS mundos. Node la usa para rechazar un import prohibido antes
// de gastar un render —la validación cuesta microsegundos y un render cuesta
// minutos— y webpack la mete en el bundle para que el evaluador arme el `require`
// del navegador con exactamente los mismos nombres.
//
// Tenerla dos veces sería el bug obvio: se agrega un módulo del lado del
// navegador, el validador de Node no se entera y lo rechaza; o al revés, el
// validador lo acepta y en el render explota con "módulo no disponible" después
// de haber levantado Chrome.
//
// ── Por qué esta lista y no "lo que el modelo quiera" ────────────────
//
// Cada módulo que entra acá hay que INSTALARLO (pesa) y BUNDLEARLO (tarda), así
// que la lista no es una restricción de seguridad sino el inventario de lo que
// de verdad está disponible en el bundle. Un import de algo que no está no
// falla en la validación por capricho: falla porque en el navegador no existe.
//
// Los dos que quedaron AFUERA y por qué:
//
//  - `three` / `@remotion/three`: son decenas de MB y el 3D no es lo que este
//    panel hace (recursos editoriales sobre el video de una clase). El día que
//    haga falta, entra acá y a la instalación.
//  - Cualquier cosa que baje algo en tiempo de render que no sea la tipografía.
//    Un render que depende de la red es un render que falla distinto cada vez.
//
// La tipografía no se importa: la carga el proyecto (ver fuentes.js y `Marco`
// en Composicion.tsx), con el mismo pedido a Google Fonts que la plantilla de
// HyperFrames, y la composición la usa por su nombre. Es lo único que baja algo
// en tiempo de render, y es a conciencia: el día que se quiera cortar la red en
// el render hay que resolverlo para los dos motores, no para éste.

'use strict';

// Lo que se le ofrece al modelo (ver `reglas` en motor-remotion.js).
const PERMITIDOS = [
  'react',
  'remotion',
  '@remotion/transitions',
  '@remotion/transitions/fade',
  '@remotion/transitions/wipe',
  '@remotion/transitions/slide',
  '@remotion/shapes',
  '@remotion/paths',
  '@remotion/noise',
];

// Lo que ya no se le ofrece pero se sigue aceptando: DM Sans fue la tipografía
// del sistema de diseño hasta la 1.9.2, y las versiones hechas con ella la
// importan. Sacarla de acá dejaría sin poder re-renderizarlas, corregirlas ni
// abrirlas en Studio.
const HEREDADOS = [
  '@remotion/google-fonts/DMSans',
];

/** ¿Este especificador de import está disponible en el bundle? */
function permitido(nombre) {
  const n = String(nombre || '').trim();
  return PERMITIDOS.indexOf(n) !== -1 || HEREDADOS.indexOf(n) !== -1;
}

module.exports = { PERMITIDOS, HEREDADOS, permitido };
