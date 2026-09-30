// EN QUÉ IDIOMA SE ESCRIBE UNA COMPOSICIÓN.
//
// Cinco datos del mismo hecho, en cinco vocabularios distintos: la extensión
// (filesystem), el fence (markdown, para mostrarle al modelo su propio código),
// la gramática de Prism (el editor del panel), cómo se lo nombra en un mensaje
// al editor, y cómo se escribe un comentario.
//
// Estaban planos y sueltos entre los otros diecisiete miembros de cada motor, y
// repetidos: `ext: '.tsx'`, `fence: 'tsx'`, `lenguaje: 'tsx'` tres veces lo
// mismo. Acá se declaran UNA vez por idioma, así la interfaz de un motor se lee
// como dos conceptos —"en qué se escribe" y "cómo se renderiza"— en vez de una
// bolsa de llaves, y un motor nuevo que también emita TSX comparte el descriptor
// en lugar de copiar tres campos y esperar no equivocarse en uno.

'use strict';

const HTML = {
  ext: '.html',
  fence: 'html',
  // Cómo lo resalta Prism en el editor del panel. `markup` cubre el HTML con su
  // CSS y su JavaScript embebidos, que es exactamente lo que es una composición
  // de HyperFrames.
  prism: 'markup',
  // Entra en los mensajes que lee el editor ("contestó en prosa en vez de
  // devolver el HTML"), así que no puede ser una palabra fija: sería mentirle
  // con el nombre del otro idioma.
  comoSeLlama: 'el HTML',
  comentario: (texto) => '<!-- ' + texto + ' -->',
};

const TSX = {
  ext: '.tsx',
  fence: 'tsx',
  prism: 'tsx',
  comoSeLlama: 'el componente',
  comentario: (texto) => '/* ' + texto + ' */',
};

module.exports = { HTML, TSX };
