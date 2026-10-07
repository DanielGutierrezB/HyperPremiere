// `React` en el ámbito global, ANTES de que cargue el archivo del marcador.
//
// El render del panel compila el código del modelo con el JSX clásico y le pasa
// `React` como parámetro (ver Composicion.tsx), así que el modelo no lo importa:
// el ejemplo del contrato no lo hace. En Studio ese mismo código es un archivo
// de verdad que compila esbuild, también con el JSX clásico (sin TypeScript
// instalado no lee el `jsx` de tsconfig), y sin esto fallaría con "React is not
// defined" en la primera etiqueta.
//
// Va en su propio módulo, importado primero en studio.ts, porque los imports se
// evalúan antes que el cuerpo del archivo que los importa.

import React from 'react';

(globalThis as unknown as {React: typeof React}).React = React;
