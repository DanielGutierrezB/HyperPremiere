// La raíz del proyecto Remotion: UNA composición, parametrizada.
//
// La duración NO está escrita acá: sale de `inputProps` por `calculateMetadata`,
// que es lo que le deja al marcador de Premiere ser la fuente de la verdad. Es
// la diferencia más grande con el motor de HyperFrames, donde la duración la
// declara el modelo en `data-duration` y hay que verificar que le haya puesto
// un número mayor que cero (cuando no, el render sale congelado o corta con
// "zero duration"). Acá ese modo de falla no existe: el modelo no puede
// equivocarse en un dato que no escribe.

import React from 'react';
import {Composition} from 'remotion';
import {Composicion, PropsDeComposicion} from './Composicion';

// Todo el pipeline del panel es 1080p30, igual que en HyperFrames.
const ANCHO = 1920;
const ALTO = 1080;
const FPS = 30;

export const Root: React.FC = () => {
  return (
    <Composition
      id="marcador"
      component={Composicion}
      width={ANCHO}
      height={ALTO}
      fps={FPS}
      // Se reemplaza por la duración real del marcador (ver calculateMetadata).
      // El valor de acá solo existe para que la composición sea válida si
      // alguien abre el Studio a mano para depurar.
      durationInFrames={FPS * 8}
      defaultProps={{codigoJs: '', conFondo: false, duracionEnCuadros: FPS * 8} as PropsDeComposicion}
      calculateMetadata={({props}) => {
        const cuadros = Math.round(Number(props.duracionEnCuadros) || 0);
        // Sin duración válida se deja la del default en vez de renderizar cero
        // cuadros: un archivo vacío es más difícil de diagnosticar que un clip
        // corto, y el que llama ya valida la duración del marcador.
        return cuadros > 0 ? {durationInFrames: cuadros} : {};
      }}
    />
  );
};
