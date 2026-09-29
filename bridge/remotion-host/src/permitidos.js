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
// `@remotion/google-fonts/DMSans` SÍ está, y es la excepción consciente: baja la
// tipografía al renderizar. No es una dependencia nueva del panel —el motor de
// HyperFrames ya carga DM Sans desde Google Fonts con un `<link>` en cada
// composición—, así que el día que se quiera cortar la red en el render hay que
// resolverlo para los dos motores, no para éste.

'use strict';

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
  '@remotion/google-fonts/DMSans',
];

/** ¿Este especificador de import está disponible en el bundle? */
function permitido(nombre) {
  return PERMITIDOS.indexOf(String(nombre || '').trim()) !== -1;
}

module.exports = { PERMITIDOS, permitido };
