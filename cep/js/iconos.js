/**
 * HPIconos — los iconos del panel, en SVG de líneas y escritos una sola vez.
 *
 * Antes eran EMOJIS tipeados adentro del JS (🎙 ✨ 📸 📄 ⚠ ↻ ⟲ ✕ ✓), y eso trae
 * tres problemas que no son de gusto:
 *
 *  1. Los dibuja la fuente de emoji del sistema, así que el panel se ve distinto
 *     en cada máquina y no hereda el color del texto: un 🎙 no se puede poner en
 *     rojo mientras escucha, ni en gris cuando está apagado.
 *  2. Dos de ellos eran EL MISMO DIBUJO con otro punto de partida: ↻ y ⟲, que
 *     son "aplicar el ajuste sobre lo que hay" y "tirar todo y rediseñar" —o sea
 *     las dos acciones más distintas de la caja— dibujadas las dos como una
 *     flecha en círculo. A 12 px no se distinguen.
 *  3. Su tamaño no se puede controlar. El emoji se dibuja con el `font-size` y
 *     cada uno tiene su propio alto de caja, así que la fila de controles
 *     quedaba desalineada por dentro.
 *
 * Ahora son trazos: 24×24 de caja, `stroke: currentColor` y `fill: none` (los
 * pone `.hp-ico` en style.css), así que HEREDAN el color de quien los contiene y
 * el estado se pinta con CSS, que es donde vive el resto de los estados del
 * panel. Un icono por CONCEPTO: si dos botones hacen cosas distintas, no comparten
 * dibujo.
 *
 * ── Por qué el SVG se pega con `innerHTML` de un `<span>` ─────────────
 *
 * `document.createElement("svg")` NO crea un SVG: crea un elemento HTML
 * desconocido con ese nombre, que el navegador no dibuja. Lo correcto sería
 * `createElementNS`, pero el DOM de mentira con el que corren los tests del panel
 * no lo tiene, y agregárselo a los cinco dobles para poder dibujar un icono es
 * pagar mucho por poco. Así que el icono va adentro de un `<span class="hp-ico">`
 * y se pega con `innerHTML`, que el parser de HTML sí resuelve al namespace de
 * SVG. En el DOM de mentira ese `innerHTML` no hace nada y queda un span vacío:
 * los tests siguen encontrando los botones por su texto y por su clase, que es lo
 * que fijan.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPIconos.
 */
(function (global) {
  "use strict";

  // El cuerpo de cada icono, sin el <svg> de afuera: eso lo pone `markup`, igual
  // para todos, así que un icono es solo su dibujo.
  //
  // Todos están dibujados dentro de la misma caja de 24×24 y con el mismo grosor
  // de trazo, que es lo que hace que se vean de la misma familia al lado del
  // otro. `solido` es la excepción y hay una sola: el cuadrado de PARAR, que a
  // trazo se lee como un contenedor vacío y no como un botón de detener.
  var DIBUJOS = {
    // ── Los tres controles del campo ─────────────────────────────────
    microfono:
      '<path d="M12 3.2a2.9 2.9 0 0 1 2.9 2.9v4.8a2.9 2.9 0 0 1-5.8 0V6.1A2.9 2.9 0 0 1 12 3.2z"/>' +
      '<path d="M5.8 10.9a6.2 6.2 0 0 0 12.4 0"/>' +
      '<path d="M12 17.1v3.7"/><path d="M9.2 20.8h5.6"/>',
    parar:
      '<rect class="solido" x="7" y="7" width="10" height="10" rx="2.2"/>',
    refinar:
      '<path d="M9.8 3.4l1.5 3.4 3.4 1.5-3.4 1.5-1.5 3.4-1.5-3.4L4.9 8.3l3.4-1.5z"/>' +
      '<path d="M17.3 13.6l.9 2 2 .9-2 .9-.9 2-.9-2-2-.9 2-.9z"/>',
    capturar:
      '<rect x="3" y="7.2" width="18" height="12.6" rx="3"/>' +
      '<circle cx="12" cy="13.5" r="3.6"/>' +
      '<path d="M8.9 7.2l1.3-2.6h3.6l1.3 2.6"/>',
    adjuntar:
      '<path d="M19.6 10.6l-8.3 8.3a4.1 4.1 0 0 1-5.8-5.8l7.8-7.8a2.7 2.7 0 0 1 3.9 3.9l-7.8 7.8a1.4 1.4 0 0 1-1.9-1.9l7.1-7.1"/>',

    // ── Las dos formas de rehacer, que NO son la misma ────────────────
    // "Aplicar el ajuste" trabaja SOBRE lo que ya hay: dos rieles con su perilla,
    // que es el dibujo universal de calibrar algo existente.
    ajustar:
      '<path d="M4 8.5h9"/><path d="M17.5 8.5h2.5"/>' +
      '<path d="M4 15.5h3.5"/><path d="M12 15.5h8"/>' +
      '<path d="M15.2 6v5"/><path d="M9.7 13v5"/>',
    // "Desde cero" TIRA lo que hay y vuelve al principio: el lazo con su flecha
    // de vuelta al punto de partida.
    desdeCero:
      '<path d="M3.2 12a8.8 8.8 0 1 0 2.9-6.5L3.2 8.2"/>' +
      '<path d="M3.2 3.6v4.6h4.6"/>',
    // Y volver al texto original es otra cosa más: deshacer, no rehacer.
    volver:
      '<path d="M9.2 14.4L4.4 9.6l4.8-4.8"/>' +
      '<path d="M4.4 9.6h10.2a5.4 5.4 0 0 1 0 10.8h-3.4"/>',

    // ── Las acciones del pie de la ficha ─────────────────────────────
    // Las dos ya estaban dibujadas en index.html (la barra de acciones de arriba)
    // y se repiten acá tal cual a propósito: es la misma acción, y dos dibujos
    // para "generar" serían dos cosas que aprender.
    generar: '<path d="M13 3 5 13h5l-1 8 8-10h-5z"/>',
    encolar: '<path d="M4 7h16M4 12h16M4 17h10"/><path d="M17 15v6M14 18h6"/>',

    // ── Las otras dos formas de rehacer de la Cola ───────────────────
    //
    // Acá había tres botones con el MISMO glifo (↻ Reintentar, ↻ Reactivar,
    // ↻ Regenerar) para tres cosas que no se parecen, y es el error que la
    // etapa 2 vino a arreglar en la caja de feedback: un dibujo por concepto.
    // Los tres, dichos en una línea:
    //
    //   · REINTENTAR  — el trabajo FALLÓ. Se vuelve a intentar lo mismo, desde
    //     donde se cayó (si el modelo ya había terminado, solo el render).
    //   · REACTIVAR   — el trabajo no falló: se quedó sin cupo y está en pausa.
    //     Vuelve a la cola tal como estaba.
    //   · DESDE CERO  — el trabajo salió bien y no gusta. Se tira el diseño y
    //     se vuelve a diseñar (ese es `desdeCero`, más arriba).
    //
    // "Reintentar" son DOS flechas encadenadas: otra pasada por lo mismo. El
    // lazo de una sola vuelta ya es "desde cero", y a 15 px la diferencia entre
    // una vuelta y dos se ve, que es lo que un punto de partida distinto sobre
    // el mismo círculo no conseguía.
    reintentar:
      '<path d="M4.4 10.2a7.8 7.8 0 0 1 13-2.9l2 2"/>' +
      '<path d="M19.6 4.9v4.4h-4.4"/>' +
      '<path d="M19.6 13.8a7.8 7.8 0 0 1-13 2.9l-2-2"/>' +
      '<path d="M4.4 19.1v-4.4h4.4"/>',
    // "Reactivar" es volver A LA COLA: las mismas tres líneas de `encolar` y
    // `cola`, con la flecha que vuelve a entrar. No lleva el `+` de encolar
    // porque no agrega un trabajo nuevo: devuelve el que ya estaba.
    reactivar:
      '<path d="M10 6.5h10M13.5 12h6.5M10 17.5h10"/>' +
      '<path d="M6.6 8.4v7.2"/>' +
      '<path d="M3.4 12.3l3.2-3.9 3.2 3.9"/>',

    // ── Las acciones de una fila de la Cola ──────────────────────────
    // Colocar: el render ya está y falta meter el clip en la pista. Es un
    // movimiento hacia ABAJO, hacia una pista que está esperando, y por eso no
    // se parece a ninguna de las de rehacer.
    colocar:
      '<path d="M12 3.6v10.6"/><path d="M8.2 10.6l3.8 3.8 3.8-3.8"/>' +
      '<rect x="3.4" y="17.2" width="17.2" height="3.4" rx="1.2"/>',
    // Dar feedback es ESCRIBIR algo sobre el recurso: un globo de diálogo. El ✎
    // que tenía lo compartía con "Editar HTML", que es la otra cosa.
    comentar:
      '<path d="M4 6.2a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7.4a2 2 0 0 1-2 2H9.4L5.2 19.4v-3.8H6a2 2 0 0 1-2-2z"/>' +
      '<path d="M8.2 8.6h7.6M8.2 11.6h4.8"/>',
    // Y editar el HTML a mano es código.
    codigo: '<path d="M9.4 8.4L5 12l4.4 3.6"/><path d="M14.6 8.4L19 12l-4.4 3.6"/>',
    // Limpiar versiones viejas BORRA ARCHIVOS del disco, y eso es un cesto. Va
    // en los dos botones que lo hacen —uno por recurso y otro por secuencia—
    // porque es la misma acción con otro alcance, igual que `generar` y
    // `encolar` se repiten entre la ficha y la barra de arriba.
    limpiar:
      '<path d="M4.6 7.2h14.8"/><path d="M9.4 7.2V4.8h5.2v2.4"/>' +
      '<path d="M6.4 7.2l1 12.2h9.2l1-12.2"/><path d="M10.4 10.6v5.4M13.6 10.6v5.4"/>',
    // Vaciar la cola NO borra ningún archivo: saca todo de la LISTA. Así que es
    // la lista de `encolar` con una ✕ donde el otro tiene el `+`. Que sean el
    // mismo dibujo con el signo cambiado es el punto: son la acción y su
    // contraria.
    vaciar:
      '<path d="M4 7h16M4 12h10M4 17h10"/>' +
      '<path d="M15.6 15.6l5.2 5.2M20.8 15.6l-5.2 5.2"/>',
    // Y los dos controles de la cola que no son de un trabajo sino de la cola
    // entera. `reanudar` es el mismo triángulo para "Iniciar" y para "Reanudar":
    // las dos ponen la cola a andar.
    pausar: '<path d="M9.2 5.4v13.2M14.8 5.4v13.2"/>',
    reanudar: '<path d="M7.4 4.8L19 12 7.4 19.2z"/>',
    // Mover un trabajo de lugar. Es el único par espejado de la casa además del
    // ↩/↪ del dictado, y por el mismo motivo: es la misma acción en los dos
    // sentidos.
    subir: '<path d="M12 19.4V5.2"/><path d="M6.2 11L12 5.2 17.8 11"/>',
    bajar: '<path d="M12 4.6v14.2"/><path d="M6.2 13L12 18.8 17.8 13"/>',
    // El 📤 de cada miniatura: si ESA imagen viaja en este pedido. Es un cuadro
    // (la imagen) con la flecha que sale, y no se parece a `adjuntar` (traer un
    // archivo de afuera) ni a `colocar` (meter un clip en la pista).
    reenviar:
      '<path d="M20.4 12.6v5.6a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8V12.6"/>' +
      '<path d="M12 16.2V4.4"/><path d="M7.8 8.6L12 4.4l4.2 4.2"/>',

    // ── Las etiquetas de una referencia ──────────────────────────────
    quitar: '<path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/>',
    usar: '<path d="M4.8 12.6l4.9 4.9 9.5-10.6"/>',
    documento: '<path d="M6.5 3h6.6l4.4 4.4V21H6.5z"/><path d="M13.1 3v4.4h4.4"/>',
    falta:
      '<path d="M12 4.2l8.6 15.6H3.4z"/>' +
      '<path d="M12 10v4.4"/><path d="M12 17.2v.6"/>',
    reloj:
      '<circle cx="12" cy="13.2" r="7.4"/>' +
      '<path d="M12 9.4v3.8l2.6 1.8"/><path d="M9.6 3.2h4.8"/>',
    // Lo que va a la lista de la cola, en el pie de la ficha.
    cola: '<path d="M4 6.5h16M4 12h16M4 17.5h9"/>'
  };

  /** El `<svg>` entero de un icono, como texto. `''` si el nombre no existe. */
  function markup(nombre) {
    var d = DIBUJOS[nombre];
    if (!d) return "";
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + d + "</svg>";
  }

  /**
   * El `<span class="hp-ico">` con el icono adentro, listo para colgar. `clase`
   * suma clases al span (para pintarlo distinto sin tocar el dibujo).
   */
  function el(nombre, clase) {
    var span = document.createElement("span");
    span.className = "hp-ico" + (clase ? " " + clase : "");
    poner(span, nombre);
    return span;
  }

  /**
   * Le cambia el icono a un span que ya está colgado. Existe porque el 🎙 cambia
   * de dibujo con el estado (micrófono ↔ parar) y volver a crear el span perdería
   * el lugar que ya tiene en la fila.
   */
  function poner(span, nombre) {
    if (!span) return;
    span.innerHTML = markup(nombre);
    // Y QUÉ icono es, escrito en el DOM.
    //
    // No es decoración: el `<svg>` se pega con `innerHTML` (ver arriba) y eso lo
    // vuelve invisible para el DOM de mentira de los tests, que no parsea. Sin este
    // atributo, "el botón pasa al cuadrado de parar cuando el motor dice que está
    // escuchando" no se puede fijar por test —y ese es justamente el estado que el
    // editor pidió que se vea—. De paso sirve para mirar una captura de la maqueta
    // y saber qué dibujo se pintó, sin comparar trazos a ojo.
    if (typeof span.setAttribute === "function") span.setAttribute("data-icono", nombre || "");
  }

  /**
   * Le pone el icono ADELANTE a un botón que ya tiene su texto.
   *
   * El orden importa y por eso se llama después de escribir el texto: en un
   * botón, `textContent` reemplaza los hijos, así que ponerlo después borraría el
   * icono. Y el icono se inserta como primer hijo justamente para que
   * `boton.textContent` siga siendo LA ETIQUETA y nada más —un `<svg>` no aporta
   * texto—, que es con lo que el editor lo busca en pantalla y los tests en el
   * DOM de mentira.
   */
  function enBoton(btn, nombre, clase) {
    if (!btn) return btn;
    var ico = el(nombre, clase);
    // `insertBefore` y `firstChild` los tiene el DOM de verdad; el de mentira de
    // los tests no, y ahí el icono va al final, que da igual: es un span vacío.
    if (typeof btn.insertBefore === "function" && btn.firstChild) btn.insertBefore(ico, btn.firstChild);
    else btn.appendChild(ico);
    return btn;
  }

  global.HPIconos = {
    markup: markup,
    el: el,
    poner: poner,
    enBoton: enBoton,
    // Para el test que fija que no queden emojis sueltos donde ya hay icono.
    nombres: function () { return Object.keys(DIBUJOS); }
  };
})(typeof window !== "undefined" ? window : this);
