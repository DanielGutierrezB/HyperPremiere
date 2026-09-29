// Los módulos de verdad, listos para que el código del modelo los pida.
//
// `permitidos.js` dice QUÉ se puede importar; este archivo trae esos módulos al
// bundle y los mapea por su nombre. Son dos archivos y no uno porque Node
// también necesita la lista (para validar antes de renderizar) y no puede
// cargar esto: acá adentro hay React y Remotion, que solo existen en el
// navegador del render.
//
// El import es ESTÁTICO a propósito. Webpack necesita ver el nombre del módulo
// escrito para meterlo en el bundle; un `import(nombre)` con una variable no se
// puede resolver en tiempo de compilación y el módulo simplemente no viajaría.

import * as React from 'react';
import * as Remotion from 'remotion';
import * as Transitions from '@remotion/transitions';
import * as TransitionFade from '@remotion/transitions/fade';
import * as TransitionWipe from '@remotion/transitions/wipe';
import * as TransitionSlide from '@remotion/transitions/slide';
import * as Shapes from '@remotion/shapes';
import * as Paths from '@remotion/paths';
import * as Noise from '@remotion/noise';
import * as DMSans from '@remotion/google-fonts/DMSans';

export const MODULOS: Record<string, unknown> = {
  react: React,
  remotion: Remotion,
  '@remotion/transitions': Transitions,
  '@remotion/transitions/fade': TransitionFade,
  '@remotion/transitions/wipe': TransitionWipe,
  '@remotion/transitions/slide': TransitionSlide,
  '@remotion/shapes': Shapes,
  '@remotion/paths': Paths,
  '@remotion/noise': Noise,
  '@remotion/google-fonts/DMSans': DMSans,
};
