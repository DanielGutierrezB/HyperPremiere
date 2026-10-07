// La config del proyecto huésped. La lee el CLI de Remotion — o sea, SOLO la
// vista previa (`remotion studio`).
//
// ── Por qué existe ──────────────────────────────────────────────────
//
// El render del panel NO pasa por acá: usa la API (`renderMedia`) y le pasa sus
// ajustes explícitos, así que este archivo no puede cambiar lo que sale del
// botón "Guardar y renderizar". Ver `remotion-worker.js`.
//
// Existe por el botón **Render** que Studio trae en su propia interfaz, abajo a
// la derecha. Desde la 1.9.0 ese botón es parte del circuito: lo que renderiza
// se guarda como versión nueva del marcador y reemplaza su clip en Premiere
// (ver bridge/render/remotion-studio.js). Así que tiene que salir en el mismo
// formato que el render del panel.
//
// Con los valores por defecto de Remotion, ese clic daba lo peor posible: se
// midió abriendo el diálogo, y venía en **H.264** hacia `out/marcador.mp4`. O
// sea que de un clip pensado para ir como overlay sobre el video salía un mp4
// OPACO —el alfa aplastado contra negro, sin ningún error de por medio—.

import path from 'path';
import {Config} from '@remotion/cli/config';

// Los CUATRO ajustes del alfa van juntos y ninguno es opcional: con el
// `imageFormat` por defecto (jpeg) el canal se pierde ANTES de encodear. Es el
// mismo cuarteto que usa el worker del render, y por el mismo motivo.
Config.setCodec('prores');
Config.setProResProfile('4444');
Config.setVideoImageFormat('png');
Config.setPixelFormat('yuva444p10le');

// Verificado abriendo el diálogo de Studio antes y después: pasa de «H.264 ·
// out/marcador.mp4» a «ProRes · 4444 · out/marcador.mov».
//
// Lo que NO se pudo: cambiarle el nombre del archivo. `Config.setOutputLocation`
// no llega al diálogo —Studio lo deriva del id de la composición— así que el
// archivo sigue saliendo como `out/marcador.mov`. No importa: el panel lo copia
// a la carpeta del proyecto con el nombre de su versión. Se probó y no funciona;
// queda dicho acá en vez de dejar una línea de config que parece hacer algo.

// ── Lo que el editor escribe en un marcador que Studio no está mostrando ──
//
// Studio muestra UN archivo de `marcadores/` a la vez (ver
// bridge/render/remotion-editables.js), y webpack solo vigila los que está
// mostrando. Si el editor le cambia algo a otro y después lo abre, webpack lo
// lee de su caché de archivos —que solo se vacía para los que el vigilante vio
// cambiar— y Studio muestra el contenido de antes. Medido con
// test/manual/studio-render.js: el archivo decía violeta y Studio, amarillo.
// Así que en cada recompilación se vacía esa caché para `marcadores/`, que es
// lo mismo que webpack hace con los archivos que sí ve cambiar.
const MARCADORES = path.join(process.cwd(), 'marcadores');

type ConCache = {purge?: (que: string) => void};
type Compilador = {
  inputFileSystem: unknown;
  hooks: {watchRun: {tap: (nombre: string, fn: () => void) => void}};
};

Config.overrideWebpackConfig((config) => ({
  ...config,
  plugins: [
    ...(config.plugins || []),
    {
      apply(compiler: Compilador) {
        compiler.hooks.watchRun.tap('hyperpremiere-marcadores', () => {
          const cache = compiler.inputFileSystem as ConCache;
          if (cache && typeof cache.purge === 'function') cache.purge(MARCADORES);
        });
      },
    },
  ],
}));
