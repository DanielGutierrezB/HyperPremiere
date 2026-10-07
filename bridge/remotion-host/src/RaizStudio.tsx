// La raíz de Remotion Studio: la misma composición que renderiza el panel, con
// el componente sacado de un ARCHIVO de verdad.
//
// En el render del panel el código del modelo viaja como texto en las props y
// se evalúa (ver Composicion.tsx). En Studio eso dejaba al editor mirando una
// animación que no podía tocar: lo que había para abrir era este envoltorio. Acá
// el componente es `marcadores/<secuencia>/<marcador>.tsx`, que el editor abre
// con su editor y edita como quiera: al guardar, Studio se actualiza solo, y su
// botón Render guarda lo que haya en ese archivo como versión nueva.
//
// `marcadores/abierto.ts` dice cuál de esos archivos se muestra, y lo escribe el
// panel al abrir un marcador (ver bridge/render/remotion-editables.js).

import React from 'react';
import Animacion from '../marcadores/abierto';
import {Marco} from './Composicion';
import {ComposicionDelMarcador, FPS} from './Root';

type PropsEnStudio = {
  conFondo: boolean;
  duracionEnCuadros: number;
  /**
   * De qué marcador es lo que se está mostrando. La composición no lo usa;
   * viaja en las props porque Studio guarda con cada render las props con que
   * arrancó, y así el render dice solo a qué clip de Premiere reemplazar (ver
   * bridge/render/remotion-studio.js).
   */
  destino: string;
};

const VACIO: PropsEnStudio = {conFondo: false, duracionEnCuadros: FPS * 8, destino: ''};

const EnStudio: React.FC<PropsEnStudio> = ({conFondo}) => (
  <Marco conFondo={!!conFondo}>
    <Animacion />
  </Marco>
);

export const RaizStudio: React.FC = () => {
  return <ComposicionDelMarcador componente={EnStudio} vacio={VACIO} />;
};
