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
// la derecha. No lo podemos sacar, y un editor al que le dijimos "abrí la vista
// previa" lo va a apretar — es el botón grande y azul de la ventana.
//
// Con los valores por defecto de Remotion, ese clic daba lo peor posible: se
// midió abriendo el diálogo, y venía en **H.264** hacia `out/marcador.mp4`. O
// sea que de un clip pensado para ir como overlay sobre el video salía un mp4
// OPACO —el alfa aplastado contra negro, sin ningún error de por medio— con un
// nombre genérico, en una carpeta que el editor no sabe que existe.
//
// Acá se cambia lo único que se puede cambiar de ese botón: que si se aprieta,
// al menos salga el mismo formato que saca el panel. Lo que sigue sin hacer —y
// no hay config que lo arregle— es versionar el archivo, escribir su ficha,
// importarlo al proyecto y colocarlo en el segundo del marcador. Eso lo hace el
// botón del panel, que es el único que sabe de qué marcador de qué secuencia se
// trata.

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
// archivo sigue saliendo como `out/marcador.mov`, un nombre que no se distingue
// de un entregable. Se probó y no funciona; queda dicho acá en vez de dejar una
// línea de config que parece hacer algo.
