// EL HUÉSPED: la composición fija que ejecuta el componente que escribió el
// modelo.
//
// ── Por qué el proyecto es fijo y el componente viaja como dato ──────
//
// Lo obvio habría sido escribir el `.tsx` del modelo en un proyecto nuevo y
// empaquetarlo con webpack por cada render. Empaquetar tarda entre varios
// segundos y medio minuto —es webpack arrancando de cero, con React y Remotion
// adentro— y hay que pagarlo POR CLIP. Con una clase de veinte marcadores eso
// son veinte bundles idénticos salvo por un archivo.
//
// Así que el bundle es UNO y se hace una sola vez: el código del modelo llega
// por `inputProps`, ya transpilado a JavaScript por Node, y acá se evalúa. Es
// el patrón que Remotion documenta para código generado por IA ("Just-in-time
// compilation of Remotion code"), con una diferencia: ellos transpilan en el
// navegador con Babel y nosotros lo hacemos antes, en Node. Ver `motor-remotion.js`
// para el porqué (resumen: así un error de compilación se atrapa sin levantar
// Chrome, y alimenta la escalera de arreglo como cualquier otro problema).
//
// Eso vale para el render del panel. En Studio es al revés, y a propósito: el
// componente es un ARCHIVO de verdad, el que el editor abre y edita (ver
// RaizStudio.tsx). Lo que comparten las dos es el `Marco`.
//
// ── Por qué `new Function` y no `eval` ──────────────────────────────
//
// `new Function` compila en el ámbito global: el código del modelo no ve —ni
// puede pisar— las variables de este archivo. No es una caja fuerte (nada que
// corra en el mismo proceso lo es), y no pretende serlo: el código lo escribió
// el modelo al que ya le estamos confiando el diseño, y la lista de módulos
// disponibles es cerrada.

import React from 'react';
import {AbsoluteFill, continueRender, delayRender} from 'remotion';
import {MODULOS} from './modulos';

export type PropsDeComposicion = {
  /** El componente del modelo, ya transpilado a JS por Node. */
  codigoJs: string;
  /** Con fondo: el clip se renderiza opaco (mp4) y el huésped pinta la base. */
  conFondo: boolean;
  /**
   * Cuánto dura el marcador, en cuadros.
   *
   * Lo consume `calculateMetadata` en Root, no este componente: adentro la
   * duración se lee con `useVideoConfig()`, que es lo que hace que el código
   * del modelo no dependa de cómo se la pasamos. Viaja igual por los props
   * porque `inputProps` es el único canal que hay hacia una composición.
   */
  duracionEnCuadros: number;
};

/** El `require` que ve el código del modelo: solo la lista cerrada. */
function requerir(nombre: string): unknown {
  const mod = MODULOS[nombre];
  if (!mod) {
    // No debería llegar acá nunca: Node valida los imports antes de renderizar.
    // Si igual pasa, el mensaje tiene que decir qué módulo y que la lista es
    // cerrada, porque el que lo lea va a estar mirando un render que falló.
    throw new Error(
      'La composición importa "' +
        nombre +
        '", que no está disponible en el render. ' +
        'Los módulos permitidos son: ' +
        Object.keys(MODULOS).join(', ') +
        '.',
    );
  }
  return mod;
}

/**
 * Evalúa el código y devuelve su `export default`.
 *
 * El código ya viene en CommonJS (Node lo transpiló con
 * `transform-modules-commonjs`), así que lo que hay que darle es lo que un
 * módulo de CommonJS espera encontrar: `require`, `module` y `exports`.
 */
function componenteDe(codigoJs: string): React.ComponentType {
  const module_ = {exports: {} as Record<string, unknown>};
  // eslint-disable-next-line no-new-func
  const fabrica = new Function('require', 'module', 'exports', 'React', codigoJs);
  fabrica(requerir, module_, module_.exports, React);

  const exportado = module_.exports;
  const Componente = (exportado.default || exportado) as React.ComponentType;
  if (typeof Componente !== 'function') {
    throw new Error(
      'La composición no exporta un componente: se esperaba `export default` con una función de React.',
    );
  }
  return Componente;
}

/**
 * Lo que rodea a la animación, venga de donde venga: la base cuando el clip
 * lleva fondo, y la espera de las fuentes.
 */
export const Marco: React.FC<{conFondo: boolean; children: React.ReactNode}> = ({conFondo, children}) => {
  // La tipografía puede tardar en estar lista. Sin esto, los primeros cuadros
  // se capturan con la fuente de reemplazo y el texto salta de tipo a mitad del
  // clip — un defecto que solo se ve reproduciendo el video.
  const [espera] = React.useState(() => delayRender('Esperando las fuentes'));
  React.useEffect(() => {
    const listo = () => continueRender(espera);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(listo, listo);
    } else {
      listo();
    }
  }, [espera]);

  return (
    <AbsoluteFill style={conFondo ? {backgroundColor: '#0B0B0C'} : undefined}>
      {children}
    </AbsoluteFill>
  );
};

export const Composicion: React.FC<PropsDeComposicion> = ({codigoJs, conFondo}) => {
  // Un error del código del modelo tiene que llegar al log del render con su
  // mensaje, no como una pantalla en blanco. Remotion corta el render cuando el
  // componente tira, que es exactamente lo que queremos: un clip negro de la
  // duración pedida es el peor resultado posible (no falla, se descubre
  // mirándolo).
  const Componente = React.useMemo(() => componenteDe(codigoJs), [codigoJs]);
  return (
    <Marco conFondo={conFondo}>
      <Componente />
    </Marco>
  );
};
