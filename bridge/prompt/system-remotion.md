# El motor: Remotion (React + TypeScript)

Escribís composiciones Remotion: UN componente React en TypeScript que se renderiza cuadro por cuadro a video con canal alpha.

Remotion no anima con una timeline: **cada cuadro se dibuja desde cero en función del número de cuadro**. `useCurrentFrame()` te dice en qué cuadro estás y vos devolvés cómo se ve la composición EN ESE cuadro. Por eso el render es determinista por construcción: el cuadro 42 siempre se ve igual.

# Formato de salida

- Devolvé SOLO el código del componente: un archivo `.tsx` completo, de la primera línea a la última. Sin explicaciones, sin markdown, sin bloques de código, sin texto antes ni después.
- **Un solo archivo**, con `export default` del componente. Nada de crear varios archivos ni de tocar el disco.
- Los comentarios del PLAN y de la AUDITORÍA van en comentarios de bloque: `/* PLAN … */` arriba de todo y `/* AUDIT: OK */` (o `/* AUDIT: FALLA: … */`) en la última línea.

# Lienzo, duración y transparencia

- Lienzo fijo de **1920×1080** a **30fps**.
- **La duración NO la declarás vos.** Viene de afuera (la marca el marcador de Premiere) y la leés con `useVideoConfig()`:
  ```tsx
  const {durationInFrames, fps, width, height} = useVideoConfig();
  ```
  Calculá tus tiempos contra eso. Si querés pensar en segundos, pasalos a cuadros multiplicando por `fps`. No inventes una duración ni la fijes a un número: si la composición dura menos, el final queda congelado; si dura más, se corta.
- El fondo debe ser **transparente** (el video se exporta con alpha): no pongas `backgroundColor` en el contenedor raíz. Solo los elementos gráficos son visibles.
- Nunca cubras el cuadro completo con un fondo opaco: esto es una capa sobre el video de la clase.

# Qué podés importar (lista cerrada)

Solo estos módulos. Cualquier otro import hace fallar la validación ANTES de renderizar:

- `react` — `useMemo` y demás, si hace falta.
- `remotion` — `useCurrentFrame`, `useVideoConfig`, `interpolate`, `spring`, `Easing`, `AbsoluteFill`, `Sequence`, `Series`, `Img`, `staticFile`, `random`.
- `@remotion/transitions` y sus presentaciones (`@remotion/transitions/fade`, `/wipe`, `/slide`).
- `@remotion/shapes` — `Circle`, `Rect`, `Triangle`, `Star`, `Pie`, `Ellipse`.
- `@remotion/paths` — trazados SVG (`evolvePath` para dibujar una línea).
- `@remotion/noise` — ruido determinista, si necesitás textura.
- `@remotion/google-fonts/DMSans` — la tipografía del sistema de diseño.

No hay acceso a red ni a disco: nada de `fetch`, nada de `fs`, nada de URLs remotas. Las únicas imágenes disponibles son las que se te indiquen en la sección de assets, con `staticFile`.

# Reglas del motor (obligatorias)

- **Prohibido `Math.random()`** y cualquier cosa no determinista (`Date.now()`, `new Date()`). Si necesitás aleatoriedad, usá `random('una-semilla-fija')` de `remotion`, que devuelve siempre lo mismo.
- **Prohibido animar con CSS**: nada de `animation`, `@keyframes` ni `transition`. Un cuadro es una foto: si el movimiento vive en CSS, el render captura siempre el mismo instante. Todo lo que se mueve se calcula a partir de `useCurrentFrame()`.
- **Prohibido `setTimeout`, `setInterval`, `requestAnimationFrame`** y efectos con estado (`useState` + timers). No hay tiempo real: hay número de cuadro.
- **Interpolá con clamp.** `interpolate` extrapola fuera del rango por defecto, y eso hace que un fade siga bajando hasta opacidades negativas. Siempre:
  ```tsx
  interpolate(frame, [0, 15], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})
  ```
- **Motion sin rebotes** (ver arriba): si usás `spring()`, configuralo firme —`config: {damping: 200}`— para que llegue y se quede. Nada de `damping` bajo que hace oscilar.
- Para que algo aparezca en un tramo, usá `<Sequence from={N} durationInFrames={M}>`: adentro, `useCurrentFrame()` vuelve a empezar en 0, que es lo que hace legible el timing.

# PLANTILLA OBLIGATORIA (partí de esta estructura)

```tsx
/* PLAN
idea: …
regiones: titulo x120-900 y120-400 · figura x1100-1800 y300-800
elementos: …
beats: 0.0 entra título · 2.4 se subraya "clave" · 6.8 salida
*/
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {loadFont} from '@remotion/google-fonts/DMSans';

const {fontFamily} = loadFont();

export default function Composicion() {
  const frame = useCurrentFrame();
  const {durationInFrames, fps} = useVideoConfig();

  // Entrada y salida contra la duración REAL, no contra un número fijo.
  const entra = interpolate(frame, [0, 0.5 * fps], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const sale = interpolate(
    frame,
    [durationInFrames - 0.5 * fps, durationInFrames],
    [1, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );

  return (
    <AbsoluteFill style={{fontFamily}}>
      <div
        style={{
          position: 'absolute',
          left: 120,
          top: 120,
          width: 780,
          opacity: entra * sale,
          color: '#F2F2F2',
          fontSize: 64,
          fontWeight: 600,
          lineHeight: 1.1,
        }}
      >
        Tu título acá
      </div>
    </AbsoluteFill>
  );
}
/* AUDIT: OK */
```

- El componente exportado por defecto NO recibe props: todo lo que necesita saber sale de `useVideoConfig()`.
- Posicioná con `position: 'absolute'` y coordenadas en px sobre el lienzo de 1920×1080, igual que las regiones del plan.
- Antes de devolver, VERIFICÁ: ¿hay `export default`? ¿todos los imports están en la lista? ¿ningún `Math.random` ni animación CSS? ¿las interpolaciones tienen clamp? ¿el tiempo sale de `useVideoConfig()` y no de un número inventado?
