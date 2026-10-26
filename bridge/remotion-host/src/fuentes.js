// LA TIPOGRAFÍA DE LAS ANIMACIONES, pedida igual en los dos motores.
//
// Bricolage Grotesque para titulares y frases destacadas, Plus Jakarta Sans para
// el resto (ver prompt/system-comun.md). Las dos se bajan de Google Fonts al
// renderizar, y éste es EL pedido: la plantilla de HyperFrames lo trae escrito en
// su `<link>` (prompt/system-hyperframes.md; un test verifica que sea idéntico) y
// el proyecto de Remotion lo carga antes del primer cuadro (ver `Marco` en
// Composicion.tsx). CommonJS por lo mismo que permitidos.js: lo leen Node y el
// bundle.
//
// Con TODOS los ejes, y no es un detalle: Bricolage Grotesque tiene un eje de
// tamaño óptico (`opsz`) que en tamaños grandes cierra y aprieta las letras —es
// su corte de titular—. `@remotion/google-fonts` baja el archivo sin ese eje, y
// el mismo titular de 120 px salía en Remotion con el corte de texto, más ancho
// que en HyperFrames (medido con test/manual/tipografia-render.js).

'use strict';

const CSS_FUENTES =
  'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,200..800' +
  '&family=Plus+Jakarta+Sans:ital,wght@0,200..800;1,200..800&display=swap';

// Lo que se espera antes del primer cuadro. Un peso de cada una alcanza: son
// variables, un archivo para todos los pesos de cada alfabeto.
const FAMILIAS = ['Bricolage Grotesque', 'Plus Jakarta Sans'];

// La que hereda todo lo que no diga otra cosa, igual que el `body` de la
// plantilla de HyperFrames.
const TEXTO = "'Plus Jakarta Sans', sans-serif";

module.exports = { CSS_FUENTES, FAMILIAS, TEXTO };
