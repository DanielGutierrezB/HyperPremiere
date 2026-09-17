/**
 * HPCampo — el campo donde se escribe un pedido, con las menciones como CHIPS.
 *
 * ── Lo que pidió el editor, y la disyuntiva que eligió ───────────────
 *
 * Una mención se veía en el campo como `@[curso/manual-de-marca-nova.png]`: largo,
 * y ensucia la lectura de la instrucción alrededor. Lo dijo así: *"me gustaría que
 * en vez de decir '@' y la ruta, fuera '@Imagen_1, @Imagen_2', algo más simple"*.
 *
 * Tiene razón, y el costo estaba escrito desde el principio en la cabecera de
 * `bridge/prompt/menciones.js`: la mención lleva el NOMBRE y no el número porque es
 * lo único que sobrevive a que la lista se reordene. Si lo GUARDADO fuera el número,
 * se agrega una captura al marcador, todas las del curso se corren un lugar, y la
 * instrucción escrita ayer queda pidiendo otra imagen **sin que nada falle**: el
 * gráfico sale distinto y nadie se entera.
 *
 * Así que el chip MUESTRA `@Imagen_1` y GUARDA `@[curso/manual-de-marca-nova.png]`.
 * El número es capa de presentación y nada más. La consecuencia buena —y hay que
 * cuidarla— es que el texto en disco, el payload del job, el `queue.json`, los
 * `.meta.json`, el `localStorage` y el prompt NO CAMBIAN: el contrato con el motor
 * queda exactamente donde estaba, y se rehace con
 * `node test/manual/menciones-al-modelo.js`.
 *
 * ── Por qué el campo dejó de ser un `<textarea>` ─────────────────────
 *
 * Hasta la 1.6.0 el resaltado se dibujaba con un ESPEJO: un `<div>` detrás con la
 * misma tipografía pintando el mismo texto con las menciones en `<span>`, y el
 * textarea encima con el texto transparente. Andaba —28 de 28 mediciones
 * alineadas— porque el espejo decía exactamente los mismos caracteres que el
 * campo. Un CHIP no es eso: dice OTROS caracteres (`@Imagen_1` donde el texto tiene
 * 38), así que no hay forma de alinear nada. El campo tiene que pintar los chips
 * de verdad, y para eso tiene que ser `contenteditable`.
 *
 * ── Y por qué el cambio NO se propaga hacia afuera ───────────────────
 *
 * Al campo le hablan seis cosas que existían antes de esto: el dictado
 * (`cep/js/dictado.js`, que lo reescribe entero cada segundo y medio y le maneja el
 * alto), el ✨ Refinar, la inserción de menciones (`HPMenciones.insertar`), el
 * control de alto, el guardado de cada pestaña y el aviso de menciones.
 *
 * Pero las seis NO hablan lo mismo, y conviene tenerlo escrito para poder volver a
 * evaluar la decisión:
 *
 *   · `value` y el evento `input` los usan las seis, y muy seguido: el dictado
 *     reescribe el valor entero cada segundo y medio, más el guardado de cada
 *     pestaña, el ✨ y cuatro hidrataciones desde el `localStorage`.
 *   · `selectionStart`, `selectionEnd` y `setSelectionRange()` tienen UN solo
 *     consumidor en producción: `HPMenciones.insertar` con su `seguirCursor`, que
 *     es el que escribe la mención donde estaba el cursor.
 *
 * O sea que media fachada carga con seis consumidores y la otra media con uno. La
 * media de uno se hace igual, y no es por simetría: es la parte más difícil de las
 * dos (un chip aporta `token.length` caracteres canónicos y cero posiciones
 * internas) y es la que sostiene la promesa de arriba —que insertar una mención no
 * se tocó ni una línea—. Lo que sí hay que saber es que su costo lo paga un solo
 * llamador, y que unas treinta aserciones de `test/menciones-campo.test.js` están
 * fijadas sobre ella: ese pinneo es lo que la hace barata de conservar.
 *
 * Entonces este campo IMITA la interfaz de un textarea, y la imita en coordenadas
 * del TEXTO CANÓNICO —el que se guarda, con los `@[…]` enteros—:
 *
 *   · `value`            — el getter serializa el DOM (los nodos de texto tal cual,
 *                          cada chip como su token); el setter parsea texto canónico
 *                          y redibuja el campo con chips.
 *   · `selectionStart`   — traducen entre offsets del texto canónico y posiciones
 *     `selectionEnd`       del DOM. Un chip es ATÓMICO: el cursor sólo puede estar
 *     `setSelectionRange`   antes o después, nunca adentro, y aporta `token.length`
 *                          caracteres canónicos.
 *   · `input`            — se emite cuando el usuario edita, para que los que ya
 *                          escuchaban sigan andando.
 *
 * `HPMenciones.insertar` no se tocó ni una línea, y eso es la prueba de que la
 * fachada está completa: si algún día hay que tocarla para que los chips anden, lo
 * que falta es de acá.
 *
 * ── La aritmética vive en UN solo lugar ──────────────────────────────
 *
 * `mapa()` recorre los hijos y arma, de una vez, qué texto canónico aporta cada uno
 * y qué rango de offsets ocupa. Las cuatro operaciones (leer el valor, escribirlo,
 * leer la selección, ponerla) salen de ahí. Repartir la cuenta entre cinco lugares
 * es cómo se llega a que el cursor caiga un carácter corrido sólo cuando hay dos
 * chips seguidos.
 *
 * ── Cuándo se redibuja, que es la regla delicada ─────────────────────
 *
 * Un `contenteditable` con el foco adentro no se puede redibujar en cada tecleo: se
 * come el cursor y el undo nativo. Así que los chips se crean al CARGAR el texto, al
 * INSERTAR una mención, al REFINAR y cuando CAMBIA la lista de referencias —todos
 * caminos que pasan por el setter de `value` o por `repintar()`—, y nunca mientras
 * se teclea. Tecleando sólo se editan nodos de texto, que no necesitan redibujado.
 * El cursor se conserva a través de un redibujado (se lee y se vuelve a poner con la
 * fachada); lo que no se puede conservar es el undo, y por eso el redibujado no
 * cuelga del `input`.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPCampo.
 */
(function (global) {
  "use strict";

  // ── El mapa: la única aritmética de offsets de todo el campo ────────

  /** ¿Este nodo es el `<br>` que Chromium mete por su cuenta? */
  function esSalto(n) {
    return String((n && n.tagName) || "").toUpperCase() === "BR";
  }

  /**
   * ¿Es un nodo de TEXTO? Se pregunta por la ausencia de etiqueta y no por
   * `nodeType === 3`: el DOM de mentira con el que corren los tests del panel no
   * tiene `nodeType`, y lo que sí tiene —igual que el de verdad— es que un nodo de
   * texto no es un elemento con nombre.
   */
  function esTexto(n) {
    return !!n && (!n.tagName || String(n.tagName).charAt(0) === "#");
  }

  /**
   * El TOKEN de un chip, que es su identidad: `@[curso/manual-de-marca-nova.png]`.
   *
   * Se guarda en los dos lados —una propiedad del nodo y el atributo
   * `data-token`— y eso no es redundancia por gusto. La propiedad es la que se lee
   * y la que hace que la etiqueta visible (que cambia cuando la lista se reordena) no
   * pueda corromper el valor. El atributo es el que SOBREVIVE: un `contenteditable`
   * tiene caminos que clonan nodos —el undo nativo, arrastrar un pedazo de texto de
   * un lado al otro del campo— y un clon se lleva los atributos pero no las
   * propiedades de JavaScript. Sin el atributo, un chip clonado dejaba de ser un
   * chip y `value` devolvía su ETIQUETA: al modelo le llegaba «@Imagen_3» como texto
   * suelto, que es exactamente la falla que guardar el nombre vino a evitar.
   */
  function tokenDe(n) {
    if (!n) return "";
    if (n._hpToken) return String(n._hpToken);
    var a = typeof n.getAttribute === "function" ? n.getAttribute("data-token") : null;
    return a ? String(a) : "";
  }

  /** A qué referencia apunta un chip: `{ scope, nombre }`, sacado de su token. */
  function menDe(c) {
    return HPMenciones.encontrar(tokenDe(c))[0] || { scope: "", nombre: "" };
  }

  /**
   * El MAPA del campo: un tramo por hijo, con el texto canónico que aporta y el
   * rango de offsets canónicos que ocupa.
   *
   * Un chip aporta su TOKEN (`@[curso/logo.svg]`) y no su etiqueta (`@Imagen_1`):
   * es lo que hace que `value` siga dando el mismo string que daba el textarea y
   * que el cursor se cuente en las coordenadas del texto guardado (ver `tokenDe`).
   *
   * Los `<br>` y cualquier elemento que no sea un chip son la red de seguridad: un
   * `contenteditable` recibe cosas por caminos que no se controlan (un arrastre de
   * texto, un IME). Se los cuenta por su texto para que el valor nunca pierda
   * caracteres, y `normalizar()` los desarma en el próximo `input`.
   */
  function mapa(campo) {
    var out = [];
    var desde = 0;
    var hijos = (campo && campo.childNodes) || [];
    for (var i = 0; i < hijos.length; i++) {
      var n = hijos[i];
      var token = tokenDe(n);
      var chip = !!token;
      var texto;
      if (chip) texto = token;
      else if (esSalto(n)) {
        // El `<br>` final de un `contenteditable` es un fantasma: Chromium lo deja
        // para que la caja no se colapse y no representa ningún salto que el editor
        // haya tecleado. Contarlo dejaría un "\n" de más en `value` cada vez que el
        // campo se vacía, o sea en el caso más común de todos.
        texto = (i === hijos.length - 1) ? "" : "\n";
      } else texto = String((n && n.textContent) || "");
      out.push({ nodo: n, chip: chip, texto: texto, desde: desde, hasta: desde + texto.length });
      desde += texto.length;
    }
    return out;
  }

  /** El texto canónico del campo: lo que `value` devuelve y lo que se guarda. */
  function serializar(m) {
    var t = "";
    for (var i = 0; i < m.length; i++) t += m[i].texto;
    return t;
  }

  /**
   * De una posición del DOM a un offset canónico.
   *
   * `dentro` es el offset del navegador: dentro de un nodo de texto son caracteres,
   * y dentro de un elemento es un índice de hijo. Los dos casos que no son un hijo
   * directo del campo tienen una respuesta y no un error, porque los dos pasan:
   * la selección anclada en el campo mismo (clic en el aire de la última línea) y la
   * selección adentro de un chip (el doble clic, mientras se edita el número).
   */
  function offsetDe(m, campo, nodo, dentro) {
    if (!nodo) return 0;
    if (nodo === campo) {
      var i = Math.max(0, Math.min(Number(dentro) || 0, m.length));
      return i === 0 ? 0 : m[i - 1].hasta;
    }
    for (var k = 0; k < m.length; k++) {
      var t = m[k];
      if (t.nodo === nodo) {
        // Un chip es atómico: adentro no hay offsets, sólo antes y después.
        if (t.chip) return (Number(dentro) || 0) > 0 ? t.hasta : t.desde;
        return t.desde + Math.max(0, Math.min(Number(dentro) || 0, t.texto.length));
      }
    }
    // Adentro de algo que es hijo de un hijo: el chip que lo contiene empieza ahí.
    var p = nodo.parentNode;
    for (var v = 0; p && v < 8; v++) {
      for (var j = 0; j < m.length; j++) if (m[j].nodo === p) return m[j].desde;
      p = p.parentNode;
    }
    return 0;
  }

  /**
   * De un offset canónico a una posición del DOM: `{ indice, dentro }`, donde
   * `indice` es el hijo del campo (el mismo índice del mapa) y `dentro` el offset
   * adentro de ese nodo.
   *
   * Si ese hijo es un CHIP, `dentro` sólo puede valer 0 (antes del chip) o 1
   * (después), porque es lo único que un chip admite. Un offset que cae en el MEDIO
   * de un token —lo pide `insertar` cuando el cursor anotado quedó viejo, y lo pide
   * el dictado— se acerca al borde más cercano en vez de partir la mención: el
   * cursor tiene que quedar en algún lado y la mitad de un token no es un lado.
   *
   * `indice: -1` es el campo vacío: no hay ningún hijo donde poner el cursor.
   */
  function posicionDe(m, offset) {
    var total = m.length ? m[m.length - 1].hasta : 0;
    var o = Math.max(0, Math.min(Number(offset) || 0, total));
    for (var i = 0; i < m.length; i++) {
      var t = m[i];
      if (o > t.hasta) continue;
      if (t.chip) {
        if (o <= t.desde) return { indice: i, dentro: 0 };
        if (o >= t.hasta) return { indice: i, dentro: 1 };
        return { indice: i, dentro: (o - t.desde) * 2 >= t.texto.length ? 1 : 0 };
      }
      return { indice: i, dentro: o - t.desde };
    }
    return m.length ? { indice: m.length - 1, dentro: m[m.length - 1].texto.length } : { indice: -1, dentro: 0 };
  }

  // ── El campo ────────────────────────────────────────────────────────

  /**
   * Un campo de pedido, listo para colgar. Devuelve el elemento, con la fachada de
   * textarea ya puesta encima.
   *
   * `opts`:
   *   desde        — el `<textarea>` del HTML que este campo reemplaza (los dos
   *                  bloques de estilo tienen el suyo en index.html, con su id y su
   *                  placeholder), o null para crearlo de cero.
   *   clase        — clases del campo cuando se crea de cero.
   *   placeholder  — idem.
   *   rotulo       — el id del `<label>` que lo nombra. Un `contenteditable` no es
   *                  un control de formulario, así que el `for=` del rótulo no lo
   *                  alcanza: lo que lo nombra es `aria-labelledby`.
   *   inventario() — [{ scope, nombre, falta, tipo, src }] en el orden en que le
   *                  llegan al modelo. De ahí sale el número de cada chip, su
   *                  estado y la miniatura del hover.
   *
   * Hubo un `decir(r)` para que el campo le contara algo al renglón de avisos de la
   * ficha, y era sólo para el número que no existía: entonces ese número se deshacía
   * y no quedaba nada en el texto que contara lo que había pasado. Se fue cuando ese
   * estado pasó a ser representable (ver `repuntar`): el token queda escrito, así
   * que lo dice el renglón de siempre, que además lo sigue diciendo después de
   * cambiar de pestaña y volver.
   */
  function crear(opts) {
    opts = opts || {};
    var viejo = opts.desde || null;
    var inv = typeof opts.inventario === "function" ? opts.inventario : function () { return []; };

    var campo = document.createElement("div");
    campo.className = (viejo && viejo.className) || opts.clase || "";
    campo.setAttribute("contenteditable", "true");
    // Para quien escucha el panel es un campo de texto de varias líneas, aunque
    // para el DOM sea un `<div>`: sin esto un lector de pantalla lo anuncia como un
    // grupo de contenido y no como algo donde se escribe.
    campo.setAttribute("role", "textbox");
    campo.setAttribute("aria-multiline", "true");
    // Y que se le puede abrir un menú: es lo que hace que un lector de pantalla
    // anuncie la lista de referencias al escribir `@` en vez de quedarse callado.
    campo.setAttribute("aria-haspopup", "listbox");
    campo.setAttribute("aria-expanded", "false");
    if (viejo && viejo.id) campo.id = viejo.id;
    if (opts.rotulo) campo.setAttribute("aria-labelledby", opts.rotulo);
    // El corrector del sistema en un campo con chips subraya los nombres de archivo
    // y, peor, ofrece "corregirlos": un reemplazo adentro de un chip rompería el
    // token. El editor de HTML del panel lo apaga por el mismo motivo.
    campo.setAttribute("spellcheck", "false");
    ponerPlaceholder(campo, (viejo && viejo.placeholder) || opts.placeholder || "");

    // ── La fachada ────────────────────────────────────────────────────

    Object.defineProperty(campo, "value", {
      get: function () { return serializar(mapa(campo)); },
      set: function (v) { pintar(campo, v, inv()); },
      configurable: true
    });
    Object.defineProperty(campo, "selectionStart", {
      get: function () { return seleccion(campo).desde; }, configurable: true
    });
    Object.defineProperty(campo, "selectionEnd", {
      get: function () { return seleccion(campo).hasta; }, configurable: true
    });
    Object.defineProperty(campo, "placeholder", {
      get: function () { return campo.getAttribute("data-placeholder") || ""; },
      set: function (v) { ponerPlaceholder(campo, v); },
      configurable: true
    });
    campo.setSelectionRange = function (a, b) { ponerSeleccion(campo, a, b); };
    /** Redibuja los chips con el inventario de ahora, sin perder el cursor. */
    campo.repintar = function () {
      var s = seleccion(campo);
      pintar(campo, serializar(mapa(campo)), inv());
      if (enFoco(campo)) ponerSeleccion(campo, s.desde, s.hasta);
    };
    // Con qué se dibujan los chips y el hover, colgado del ELEMENTO.
    //
    // Estuvo argumentado como «para que la ficha pueda repintar sin conocer este
    // módulo», y era falso: la ficha repinta con `ficha.revisar()` →
    // `campo.repintar()`, que cierra sobre `inv` directo, y no hay un solo lector
    // de esto afuera de acá.
    //
    // La razón de verdad es estructural: `repuntar` y `normalizar` viven afuera del
    // closure de `crear()` —son de un chip, no de un campo— y necesitan el
    // inventario. Colgarlo del elemento es cómo se lo pasan.
    //
    // Y eso costaba: el que no lo recibía tenía que DEDUCIR su campo del árbol
    // (`c.parentNode`), sobre un invariante que la cabecera de este archivo dice
    // que no se puede garantizar, y de ahí salían tres fallbacks silenciosos —un
    // `|| []` que dibujaba el chip contra un inventario vacío, un `return null` que
    // mataba el preview, y un `_hpEditandoChip` escrito en un elemento
    // cualquiera—. Ahora el campo se PASA: lo tiene el que creó el chip (ver
    // `chip`), así que no hay nada que adivinar y los tres fallbacks no existen.
    campo._hpInventario = inv;

    // ── Lo que el editor hace con el teclado ──────────────────────────

    campo.addEventListener("keydown", function (e) {
      var k = e.key || "";
      // Mientras se le cambia el número a un chip, TODAS las teclas son del chip.
      // La guarda no puede ser el `target` del evento: con el foco en el campo, el
      // navegador se los entrega al campo, y así el Backspace de "borrar el número"
      // se convertía en "borrar el chip" y el Enter de confirmar metía además un
      // salto de línea. Los dos se vieron en `medir-chips.js`.
      // Con un chip en edición, el campo no toca NADA: las teclas son del `<input>`
      // que tiene adentro, que las recibe nativas y las maneja él (ver
      // `editarNumero`). Acá vivía un `teclaDeEdicion` que las leía y se las pasaba
      // al chip, y era la edición simulada que el editor rechazó.
      if (campo._hpEditandoChip) return;
      // Y con el MENÚ DEL `@` abierto, las flechas, el Enter, el Tab y el Escape son
      // del menú. El Enter es el que hay que atajar sí o sí: si se le escapa al
      // campo, elegir una referencia deja además un salto de línea en la
      // instrucción (ver `teclaDeMenu`).
      if (menuCampo === campo && teclaDeMenu(e)) return;
      if (k === "Enter") {
        // El salto entra como un "\n" de verdad en un nodo de texto, y no como el
        // `<div>` o el `<br>` que Chromium arma por su cuenta: así el contenido del
        // campo sigue siendo una lista plana de texto y chips, que es lo que el mapa
        // sabe contar. El `pre-wrap` del CSS es lo que lo dibuja.
        e.preventDefault();
        escribirEnLaSeleccion(campo, "\n");
        return;
      }
      if (k !== "Backspace" && k !== "Delete") return;
      // BORRAR UN CHIP ENTERO. `contenteditable="false"` ya hace casi todo en
      // Chromium, pero "casi" acá no alcanza: lo que no se puede dejar pasar es que
      // quede MEDIO TOKEN suelto en el texto, porque medio token viaja al modelo
      // como texto y el gráfico sale sin la referencia. Con el cursor pegado al chip
      // se borra el tramo entero por la fachada, que es la única que sabe dónde
      // empieza y dónde termina.
      var s = seleccion(campo);
      if (s.desde !== s.hasta) return;   // hay algo seleccionado: lo borra el navegador
      var m = mapa(campo);
      var t = null;
      for (var i = 0; i < m.length; i++) {
        if (!m[i].chip) continue;
        if (k === "Backspace" && m[i].hasta === s.desde) { t = m[i]; break; }
        if (k === "Delete" && m[i].desde === s.desde) { t = m[i]; break; }
      }
      if (!t) return;
      e.preventDefault();
      borrarChip(campo, t);
    });

    // PEGAR entra como TEXTO PLANO. Un `contenteditable` acepta HTML por defecto,
    // así que pegar de un navegador o de un documento metía `<span>` con su estilo
    // adentro del campo — y un elemento que no es un chip es basura que el mapa
    // tiene que adivinar. Y de paso: si lo pegado trae un token escrito, sale con su
    // chip puesto, porque pasa por el setter.
    campo.addEventListener("paste", function (e) {
      var d = e.clipboardData || (global.clipboardData);
      if (!d || typeof d.getData !== "function") return;
      e.preventDefault();
      escribirEnLaSeleccion(campo, String(d.getData("text/plain") || ""));
    });

    // COPIAR se lleva el texto CANÓNICO y no lo que se ve. Sin esto, copiar un
    // pedazo de instrucción con un chip adentro ponía en el portapapeles
    // «@Imagen_3», que no es una mención de nada: pegado en el marcador de al lado
    // le llega al modelo como texto suelto, y ahí el número vuelve a ser el dato
    // —justo lo que guardar el nombre vino a evitar—. Copiando el token, pegar lo
    // devuelve como chip (el `paste` de arriba pasa por el setter), y copiar la
    // instrucción entera afuera del panel da el texto que el motor entiende.
    campo.addEventListener("copy", function (e) { alPortapapeles(campo, e, false); });
    campo.addEventListener("cut", function (e) { alPortapapeles(campo, e, true); });

    // Y lo que el navegador haya metido igual, se desarma acá: un `<br>` en el
    // medio, un `<span>` de un arrastre, un chip que quedó sin etiqueta. No
    // redibuja los chips (eso no puede pasar tecleando); sólo deja el contenido
    // como una lista plana otra vez, y nada más cuando hizo falta.
    campo.addEventListener("input", function () {
      if (!normalizar(campo)) marcarVacio(campo);
      revisarDisparo(campo);
    });

    // El cursor se mueve por tres caminos —tecleando, con las flechas y con el
    // mouse— y el menú del `@` tiene que seguirlo por los tres: con las flechas sin
    // menú abierto el cursor se va del `@`, y con un clic también.
    campo.addEventListener("keyup", function () { revisarDisparo(campo); });
    campo.addEventListener("mouseup", function () { revisarDisparo(campo); });

    // Y si el campo scrollea, lo que está colgado del `<body>` con coordenadas fijas
    // se va: el chip (o el `@`) se le movería por debajo y quedaría señalando otra
    // línea. El dictado scrollea el campo en cada refresco.
    campo.addEventListener("scroll", function () { ocultarPreview(); cerrarMenu(); });

    // Irse del campo cierra el menú del `@`. Elegir con el mouse NO pasa por acá,
    // porque las filas del menú se quedan con el `mousedown` para que el campo no
    // pierda el foco (ver `filaDelMenu`).
    //
    // Y NO cierra la edición de un chip, aunque el campo pierda el foco justo cuando
    // esa edición empieza: el foco se lo lleva el `<input>` del chip, que es un hijo
    // del campo pero un control aparte. Confirmar cuando el campo se queda sin foco
    // habría cerrado la edición en el momento de abrirla. De eso se encarga el
    // `blur` del propio input.
    campo.addEventListener("blur", function () {
      if (menuCampo === campo) cerrarMenu();
    });

    if (viejo && viejo.parentNode && viejo.parentNode.replaceChild) {
      viejo.parentNode.replaceChild(campo, viejo);
    }
    campo.value = (viejo && viejo.value) || "";
    return campo;
  }

  function ponerPlaceholder(campo, texto) {
    campo.setAttribute("data-placeholder", String(texto || ""));
    marcarVacio(campo);
  }

  /**
   * El `placeholder` lo dibuja el CSS con `::before`, y lo que lo prende es este
   * atributo y no `:empty`: un campo "vacío" de un `contenteditable` suele tener
   * adentro el `<br>` fantasma de Chromium, así que `:empty` no matchea nunca y el
   * placeholder no aparecería justo cuando el campo está recién abierto — que es el
   * único momento en que se lee. Y es el texto que dice que se puede arrastrar un
   * archivo: perderlo es perder la última afordancia de la zona de arrastre.
   */
  function marcarVacio(campo) {
    campo.setAttribute("data-vacio", serializar(mapa(campo)) ? "false" : "true");
  }

  function enFoco(campo) {
    return typeof document !== "undefined" && document && document.activeElement === campo;
  }

  function emitir(campo) {
    if (typeof campo.dispatchEvent !== "function" || typeof global.Event !== "function") return;
    try { campo.dispatchEvent(new global.Event("input", { bubbles: true })); } catch (e) {}
  }

  /**
   * Borra un chip entero, y lo hace de manera que el editor lo pueda DESHACER.
   *
   * ── El problema del undo, que es real ────────────────────────────────
   *
   * Un `contenteditable` tiene undo nativo y es el único que hay: la pila la lleva
   * el navegador, con sus propios snapshots, y no se puede empujar nada a mano. Todo
   * lo que este módulo cambia por su cuenta —sacar un nodo, cambiarle el token a un
   * chip— le pasa por al lado: Cmd+Z salta ese paso y deshace el anterior. En un
   * campo donde se escriben instrucciones largas eso no es un detalle.
   *
   * Para el BORRADO sí hay forma sana, y es ésta: en vez de sacar el nodo, se
   * SELECCIONA el chip entero y se le pide al navegador que borre la selección
   * (`execCommand("delete")`). Con eso el paso entra en la pila nativa y el undo lo
   * devuelve. Y la razón por la que acá sí se puede confiar en el navegador es que
   * la ambigüedad se la sacamos: lo que no se podía dejar pasar era "el cursor está
   * pegado a un elemento atómico, adiviná qué quiso borrar" —de ahí salía el medio
   * token de basura—; con la selección puesta exactamente sobre el chip no queda
   * nada que adivinar.
   *
   * Si el comando no existe o no se llevó el nodo, se saca a mano: es mejor un
   * borrado que no se puede deshacer que un chip que no se borra.
   *
   * ── Lo que NO se pudo hacer undoable, y por qué queda así ────────────
   *
   * El doble clic que le cambia el número a un chip (`repuntar`). Ahí no hay nada
   * que borrar ni insertar: cambia el TOKEN de un nodo que se queda donde está, y
   * la pila nativa sólo entiende de texto insertado y borrado. Se podría hacer
   * pasar por un borrado más una inserción, pero lo insertado sería TEXTO
   * (`execCommand` no inserta elementos), así que el chip se convertiría en el token
   * crudo hasta el próximo redibujado —y el redibujado tampoco es undoable—: se
   * cambiaría un paso que el undo saltea por un parpadeo visible en cada cambio de
   * número. No vale.
   *
   * Y no hace tanta falta, que es la otra mitad de la decisión: repuntar un chip es
   * REVERSIBLE CON EL MISMO GESTO. El editor hace doble clic otra vez y escribe el
   * número anterior, que es lo que el chip le estaba mostrando un segundo antes. No
   * es deshacer, pero no pierde nada.
   *
   * Lo que sí NO se puede hacer es volver a `execCommand` para la edición del
   * número: eso pedía volver el chip `contenteditable`, y de ahí salía que Chromium
   * le entregara el Backspace al campo de afuera y "borrar el número" borrara el chip
   * (ver `editarNumero`, donde además está lo que sí funcionó). Está medido en
   * `medir-chips.js`.
   */
  function borrarChip(campo, t) {
    ponerSeleccion(campo, t.desde, t.hasta);
    var listo = false;
    try {
      listo = !!(document.execCommand && document.execCommand("delete", false, null));
    } catch (e) { listo = false; }
    // `execCommand` avisa por su cuenta (dispara `input`); el camino a mano no.
    if (listo && !esHijo(campo, t.nodo)) { marcarVacio(campo); ponerSeleccion(campo, t.desde, t.desde); return; }
    if (esHijo(campo, t.nodo)) campo.removeChild(t.nodo);
    ponerSeleccion(campo, t.desde, t.desde);
    marcarVacio(campo);
    emitir(campo);
  }

  function esHijo(campo, n) {
    var hijos = (campo && campo.childNodes) || [];
    for (var i = 0; i < hijos.length; i++) if (hijos[i] === n) return true;
    return false;
  }

  /**
   * Lo seleccionado, en texto canónico, al portapapeles. `cortar` lo borra además.
   *
   * El cortado se hace por la fachada y no con el comando del navegador, así que ese
   * paso no entra en el undo nativo (ver `borrarChip`): para poder escribir el
   * portapapeles hay que quedarse con el evento, y sin el evento el navegador no
   * corta. Es el único lugar donde se paga ese costo, y se paga por lo mismo que el
   * resto: un portapapeles con la etiqueta adentro es una mención perdida.
   */
  function alPortapapeles(campo, e, cortar) {
    var d = e.clipboardData || global.clipboardData;
    if (!d || typeof d.setData !== "function") return;
    var s = seleccion(campo);
    if (s.desde === s.hasta) return;   // nada seleccionado: que el navegador haga lo suyo
    var v = serializar(mapa(campo));
    try { d.setData("text/plain", v.slice(s.desde, s.hasta)); } catch (err) { return; }
    e.preventDefault();
    if (!cortar) return;
    campo.value = v.slice(0, s.desde) + v.slice(s.hasta);
    ponerSeleccion(campo, s.desde, s.desde);
    emitir(campo);
  }

  /** Escribe `texto` sobre la selección, por la fachada, y avisa. */
  function escribirEnLaSeleccion(campo, texto) {
    var s = seleccion(campo);
    var v = serializar(mapa(campo));
    campo.value = v.slice(0, s.desde) + texto + v.slice(s.hasta);
    ponerSeleccion(campo, s.desde + texto.length, s.desde + texto.length);
    emitir(campo);
  }

  // ── Dibujar ─────────────────────────────────────────────────────────

  /**
   * Redibuja el campo a partir del texto canónico: los tramos que no son una
   * mención como nodos de texto, cada mención como un chip.
   *
   * Los tramos se cortan POR ÍNDICE sobre el texto crudo y el token se guarda TAL
   * CUAL vino, sin reconstruirlo: `partir` recorta espacios, así que un
   * `@[ curso/logo.svg ]` reconstruido mediría dos caracteres menos y `value`
   * devolvería algo distinto de lo que se le puso. Un `@[]` sin nombre no es una
   * mención y queda como texto, que es lo que también hace el motor.
   */
  function pintar(campo, texto, inventario) {
    var t = String(texto == null ? "" : texto);
    campo.innerHTML = "";
    var ultimo = 0;
    HPMenciones.encontrar(t).forEach(function (men) {
      agregarTexto(campo, t.slice(ultimo, men.desde));
      campo.appendChild(chip(campo, men.raw, men, inventario));
      ultimo = men.desde + men.raw.length;
    });
    agregarTexto(campo, t.slice(ultimo));
    marcarVacio(campo);
  }

  function agregarTexto(campo, t) {
    if (!t) return;   // un nodo de texto vacío no se puede recorrer con el cursor
    campo.appendChild(document.createTextNode(t));
  }

  /**
   * UN CHIP. Muestra `@Imagen_1` y guarda `@[curso/manual-de-marca-nova.png]`.
   *
   * `contenteditable="false"` es lo que lo hace atómico para el navegador: el cursor
   * no entra, la selección lo toma entero y Backspace se lo lleva completo. La
   * fachada hace la otra mitad —contarlo como `token.length` caracteres— así que las
   * dos mitades dicen lo mismo.
   *
   * Recibe el `campo` y no lo busca por `parentNode`: el hover y el doble clic
   * necesitan el inventario, y el chip lo conoce porque lo creó el que lo tenía.
   * Deducirlo del árbol era lo que obligaba a `etiquetaDe` e `itemDe` a adivinar su
   * contexto, con un fallback silencioso cada una (ver `_hpInventario`).
   */
  function chip(campo, token, men, inventario) {
    var c = document.createElement("span");
    ponerToken(c, token);
    c.setAttribute("contenteditable", "false");
    pintarChip(c, inventario);
    c.addEventListener("mouseover", function () { verPreview(c, campo); });
    c.addEventListener("mouseout", function () { ocultarPreview(); });
    c.addEventListener("dblclick", function (e) {
      if (e && e.preventDefault) e.preventDefault();
      editarNumero(c, campo);
    });
    return c;
  }

  /**
   * La etiqueta, el estado y el tooltip de un chip, con el inventario de AHORA.
   *
   * El tooltip dice el token entero, y eso no es un detalle de cortesía: el argumento
   * original para guardar el nombre y no un identificador opaco era que la mención
   * SE LEE. Con el chip mostrando un número, el lugar donde se sigue leyendo qué
   * archivo es exactamente es acá.
   */
  function pintarChip(c, inventario) {
    var men = menDe(c);
    var e = HPMenciones.etiqueta(men, inventario);
    c.textContent = e.texto;
    c.className = "hp-chip" + (e.estado ? " is-" + e.estado : "");
    c.setAttribute("data-tipo", e.tipo || "");
    c.title = tooltip(tokenDe(c), men, e, inventario);
  }

  /** Lo que el chip muestra HOY, recalculado: su número, su tipo y su estado. */
  function etiquetaDe(c, campo) {
    return HPMenciones.etiqueta(menDe(c), campo._hpInventario());
  }

  /**
   * El globo de un chip: el token entero y qué le pasa a esta mención.
   *
   * El DIAGNÓSTICO no se redacta acá: lo contesta `HPMenciones.explicar`, que es
   * el mismo que arma el renglón de abajo del campo. Estuvieron redactados en dos
   * lugares y ya habían divergido —el chip decía «hay 3 imágenes» y el renglón dos
   * centímetros más abajo decía «hay 3»—, que es la peor forma de divergir: las
   * dos frases se leen JUNTAS, así que el editor ve el panel contradecirse solo.
   *
   * Lo que sí es de acá son las dos menciones SANAS, que no son un problema y por
   * eso `explicar` no las conoce: lo que dicen es con qué número o con qué nombre
   * le va a llegar al modelo, y eso es lo que el chip existe para contestar.
   */
  function tooltip(token, men, e, inventario) {
    var t = String(token) + " · ";
    // El número que no apunta a nada es el caso donde el globo más hace falta: el
    // chip dice `@Imagen_7` en rojo y el color es lo único que avisa.
    if (e.estado === "sin-numero") {
      var cuantas = (e.tipo === "documento"
        ? HPMenciones.documentos(inventario) : HPMenciones.imagenes(inventario)).length;
      return t + HPMenciones.explicar({
        motivo: "sin-numero", tipo: e.tipo, numero: e.numero, de: cuantas
      }).largo;
    }
    if (e.estado === "colgada" || e.estado === "sin-disco") {
      return t + HPMenciones.explicar({ motivo: e.estado }).largo;
    }
    // Y el desempate de una mención ambigua se le agrega a la mención sana: apunta
    // a algo, sólo que a una de dos con el mismo nombre.
    var ambigua = e.estado === "ambigua"
      ? " Ojo: " + HPMenciones.explicar({ motivo: "ambigua" }).largo
      : "";
    if (e.tipo === "documento") {
      // Con su NOMBRE y no con la etiqueta del chip: es exactamente como lo nombra
      // el prompt, así que el tooltip se puede leer al lado del ⬇ Log y decir lo
      // mismo.
      return t + "al modelo le llega como el documento «" + men.nombre + "» por su nombre: " +
        "los documentos no se numeran, así que este número es del panel nomás." + ambigua;
    }
    return t + "al modelo le llega como «imagen " + e.numero + "», contando las que de verdad viajan. " +
      "Doble clic para cambiarle el número." + ambigua;
  }

  /**
   * Deja el contenido del campo como una lista plana de texto y chips.
   *
   * Devuelve `true` si tuvo que tocar algo, y en ese caso el cursor se restituye por
   * la fachada: normalizar mueve nodos, y mover nodos con el foco adentro tira el
   * cursor al principio. Se hace sólo cuando hizo falta —o sea casi nunca— para no
   * pagar una reescritura del DOM en cada tecla.
   */
  function normalizar(campo) {
    var hijos = [];
    var i;
    for (i = 0; i < campo.childNodes.length; i++) hijos.push(campo.childNodes[i]);
    var sucio = false;
    for (i = 0; i < hijos.length; i++) {
      var n = hijos[i];
      // El chip que se está editando tiene un `<input>` adentro en vez de texto, así
      // que su `textContent` está vacío y parecería un chip roto. Se saltea: lo que
      // se está haciendo con él es justamente escribirle un número.
      if (campo._hpEditandoChip === n) continue;
      // Un chip vacío hay que sacarlo (abajo se explica por qué); uno con su
      // etiqueta está bien.
      if (n._hpToken) { if (!String(n.textContent || "")) sucio = true; continue; }
      // Nodo de texto: está bien. Cualquier otra cosa (un `<br>` en el medio, un
      // `<span>` que entró con un arrastre) no.
      if (esTexto(n)) continue;
      sucio = true;
    }
    if (!sucio) return false;
    var s = seleccion(campo);
    var m = mapa(campo);
    var texto = "";
    for (i = 0; i < m.length; i++) {
      // Un chip sin etiqueta se cayó del texto: se lo llevaron borrando por dentro,
      // y dejarle el token sería mandarle al modelo una mención que en el campo no
      // se ve. Es el "medio token de basura" con otra cara.
      if (m[i].chip && campo._hpEditandoChip !== m[i].nodo &&
        !String(m[i].nodo.textContent || "")) continue;
      texto += m[i].texto;
    }
    pintar(campo, texto, campo._hpInventario());
    if (enFoco(campo)) ponerSeleccion(campo, s.desde, s.hasta);
    return true;
  }

  // ── La selección, en coordenadas del texto canónico ─────────────────

  /**
   * Dónde está el cursor, en offsets canónicos.
   *
   * Cuando la selección del documento NO está en este campo se devuelve la ÚLTIMA
   * que estuvo, que es lo que hace un textarea: conserva su selección al perder el
   * foco. Y hace falta para lo de siempre —para insertar una mención hay que tocar
   * una miniatura, o sea sacarle el foco al campo— aunque `seguirCursor` ya lo
   * cubra por su lado.
   */
  function seleccion(campo) {
    var sel = typeof global.getSelection === "function" ? global.getSelection() : null;
    if (!sel || !sel.anchorNode || !contiene(campo, sel.anchorNode)) {
      return campo._hpSel || { desde: 0, hasta: 0 };
    }
    var m = mapa(campo);
    var a = offsetDe(m, campo, sel.anchorNode, sel.anchorOffset);
    var b = offsetDe(m, campo, sel.focusNode, sel.focusOffset);
    campo._hpSel = { desde: Math.min(a, b), hasta: Math.max(a, b) };
    return campo._hpSel;
  }

  function contiene(campo, nodo) {
    for (var i = 0; nodo && i < 24; i++) {
      if (nodo === campo) return true;
      nodo = nodo.parentNode;
    }
    return false;
  }

  /** Pone el cursor (o la selección) en offsets canónicos. */
  function ponerSeleccion(campo, a, b) {
    var desde = Math.min(Number(a) || 0, Number(b === undefined ? a : b) || 0);
    var hasta = Math.max(Number(a) || 0, Number(b === undefined ? a : b) || 0);
    campo._hpSel = { desde: desde, hasta: hasta };
    var sel = typeof global.getSelection === "function" ? global.getSelection() : null;
    if (!sel || !document.createRange) return;
    var m = mapa(campo);
    try {
      var r = document.createRange();
      colocar(r, "setStart", campo, m, posicionDe(m, desde));
      colocar(r, "setEnd", campo, m, posicionDe(m, hasta));
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) {}
  }

  /**
   * Un borde del rango. Antes o después de un CHIP se apunta al CAMPO con el índice
   * del hijo, y no al chip: un `contenteditable="false"` no tiene offsets propios, y
   * pedirle uno deja el cursor adentro de algo donde no se puede escribir.
   */
  function colocar(rango, cual, campo, m, pos) {
    if (pos.indice === -1) { rango[cual](campo, 0); return; }
    var t = m[pos.indice];
    if (t.chip) rango[cual](campo, pos.indice + pos.dentro);
    else rango[cual](t.nodo, Math.max(0, Math.min(pos.dentro, t.texto.length)));
  }

  // ── El doble clic: cambiarle el número a un chip ────────────────────

  /**
   * Doble clic sobre un chip: se abre como un campo de texto con su número adentro.
   *
   * Es el punto donde el número se vuelve SIGNIFICADO, y por eso está resuelto así:
   * mientras se edita, el chip cambia lo que MUESTRA pero no su token, así que
   * `value` sigue devolviendo el texto canónico de siempre y nada de lo que se
   * guarda se enteró. Recién al confirmar se busca qué referencia es HOY ese número y
   * se guarda SU NOMBRE — que es la única forma de que el chip siga apuntando a la
   * misma imagen cuando la lista se vuelva a mover (o, si ese número no existe, se
   * guarda el número; ver `repuntar`).
   *
   * ── Por qué un `<input>` y no el chip vuelto editable ────────────────
   *
   * Hubo una versión con `contenteditable="true"` en el chip y no funcionó: con el
   * foco puesto ahí, Chromium le entregaba el Backspace y el Enter al campo de
   * AFUERA, así que "borrar el número" borraba el chip entero y "confirmar" metía un
   * salto de línea en la instrucción. Y hubo una segunda que arregló eso emulando —el
   * campo leía las teclas y se las pasaba al chip— que el editor rechazó por lo que
   * le faltaba: *"solo me abre el número pero no me pone sobre el lugar de cambiarlo,
   * que abra completo como si fuera un campo de texto"*. Tenía razón: emulando no hay
   * cursor, no hay selección y no hay flechas.
   *
   * Un `<input>` resuelve las dos cosas de una, y por el mismo motivo que rompía las
   * otras dos: el problema siempre fue que el campo se quedaba con las teclas, y un
   * control de formulario es precisamente el caso en que el navegador DEJA de hacer
   * eso —lo trata como un widget y le enruta el teclado—. Así que el cursor, la
   * selección, las flechas y el Backspace vienen nativos. Medido en `medir-chips.js`
   * en los tres campos y a los cuatro anchos: el input recibe el foco y abre con el
   * número seleccionado (`selectionEnd`, que en algo que no es un control no existe).
   */
  function editarNumero(c, campo) {
    if (campo._hpEditandoChip) return;
    ocultarPreview();
    // El menú del `@` y la edición de un número son los dos modales del campo y se
    // comen las mismas teclas: no pueden estar abiertos a la vez.
    cerrarMenu();
    campo._hpEditandoChip = c;
    c._hpEtiqueta = c.textContent;
    c.classList.add("is-editando");

    // UN `<input>` DE VERDAD adentro del chip. La primera versión de esto emulaba la
    // edición —el campo leía las teclas y las pasaba al chip— y el editor lo dijo
    // enseguida: *"solo me abre el número pero no me pone sobre el lugar de
    // cambiarlo, que abra completo como si fuera un campo de texto"*. Tenía razón:
    // emulando no hay cursor, no hay selección y no hay flechas.
    //
    // Y un `<input>` sí funciona donde el `<span contenteditable="true">` falló, que
    // es lo que hace que esto no sea el mismo error otra vez. El problema de aquella
    // vez fue que el campo se quedaba con las teclas; un control de formulario es
    // precisamente el caso en que el navegador DEJA de hacer eso: lo trata como un
    // widget y le enruta el teclado, con lo cual el cursor, la selección, las flechas
    // y el Backspace vienen gratis y nativos. Medido en `medir-chips.js`, que es el
    // único que lo puede ver.
    var inp = document.createElement("input");
    inp.type = "text";
    // El teclado numérico en vez del alfabético donde haya uno, y ningún autocompletado.
    inp.setAttribute("inputmode", "numeric");
    inp.setAttribute("autocomplete", "off");
    inp.className = "hp-chip-num";
    inp.value = String(etiquetaDe(c, campo).numero || "");
    inp.setAttribute("aria-label", "Número de la referencia");
    c.textContent = "";
    c.appendChild(inp);
    c._hpInput = inp;

    // Sólo dígitos, y tres de tope: más que eso no es un número de referencia. Se
    // filtra en el `input` y no en el `keydown` para no pelearle al teclado —pegar,
    // el dictado del sistema y un teclado numérico entran por acá igual— y para que
    // las flechas y la selección sigan siendo del navegador.
    inp.addEventListener("input", function () {
      var limpio = String(inp.value || "").replace(/[^0-9]/g, "").slice(0, 3);
      if (limpio !== inp.value) inp.value = limpio;
    });
    inp.addEventListener("keydown", function (e) {
      var k = e.key || "";
      if (k !== "Enter" && k !== "Tab" && k !== "Escape") return;
      if (e.preventDefault) e.preventDefault();
      // Que no llegue al campo: un Enter suelto en un campo de prompt mete un salto
      // de línea, y un Escape cerraría otra cosa.
      if (e.stopPropagation) e.stopPropagation();
      cerrarEdicion(c, campo, k !== "Escape");
    });
    // Irse del `<input>` CONFIRMA, que es lo que hace cualquier campo chico: se
    // escribe el número y se sigue con lo suyo. Es además el único camino para el
    // clic en otro lado, porque el foco lo tiene el input y no el campo.
    inp.addEventListener("blur", function () { cerrarEdicion(c, campo, true); });

    // El foco al input y el número SELECCIONADO: así escribir lo reemplaza de una,
    // que es exactamente lo que pidió el editor.
    try { inp.focus(); if (inp.select) inp.select(); } catch (e) {}
  }

  /**
   * Cierra la edición.
   *
   * `confirmar` false es el Escape, y desde que un número inválido se GUARDA
   * (ver `repuntar`) cancelar y confirmar son dos cosas distintas de verdad: antes
   * las dos terminaban dejando el chip como estaba, así que el Escape no se
   * distinguía de nada. Ahora Escape deja el chip apuntando a lo que apuntaba y
   * Enter guarda lo que el editor escribió, aunque no apunte a nada.
   *
   * El número vacío sigue siendo "no pedí nada": no se guarda un `@[Imagen_]`.
   */
  function cerrarEdicion(c, campo, confirmar) {
    if (campo._hpEditandoChip !== c) return;
    var escrito = c._hpInput ? String(c._hpInput.value || "").replace(/[^0-9]/g, "") : "";
    campo._hpEditandoChip = null;
    c._hpInput = null;
    c.classList.remove("is-editando");
    if (!confirmar || !escrito) { c.textContent = c._hpEtiqueta; return; }
    repuntar(c, campo, parseInt(escrito, 10));
  }

  /**
   * El chip apunta a la referencia que HOY es el número `n` de su clase, y si ese
   * número no existe GUARDA EL NÚMERO y se pone rojo.
   *
   * La primera versión deshacía lo escrito —el chip volvía a su número anterior y se
   * decía en un renglón— con el argumento de no inventar nada. El editor la corrigió
   * con razón: *"si lo modifico a algo que no está, pues debería dejar de aparecer
   * azul ya que no está referenciando nada. O que aparezca rojo avisando que no
   * referencia a nada"*. Deshacerle lo que escribió es peor que mostrárselo mal: el
   * chip volviendo solo al 3 se siente como que el panel le pelea el teclado, y lo
   * deja creyendo que quedó el 3 cuando quería el 7.
   *
   * Así que el estado inválido es REPRESENTABLE: se guarda `@[Imagen_7]`, un token
   * que no apunta a ninguna referencia (ver `numeroSuelto` en cep/js/menciones.js,
   * donde está por qué eso no contradice guardar el nombre). Con eso el chip rojo
   * sobrevive a cambiar de pestaña y volver, el renglón de abajo lo dice con
   * palabras porque el token está en el texto, y el modelo lee que falta esa
   * referencia y no otra imagen en su lugar.
   *
   * Y se arregla con el mismo gesto: doble clic, un número que sí existe, y vuelve a
   * azul guardando el nombre.
   */
  function repuntar(c, campo, n) {
    var inventario = campo._hpInventario();
    var tipo = etiquetaDe(c, campo).tipo;
    var it = HPMenciones.porNumero(tipo, n, inventario);
    ponerToken(c, it
      ? HPMenciones.escribir(it.scope, it.nombre)
      : HPMenciones.escribirNumero(tipo, n));
    pintarChip(c, inventario);
    emitir(campo);
  }

  function ponerToken(c, token) {
    c._hpToken = token;
    c.setAttribute("data-token", token);
  }

  // ── El preview del hover ────────────────────────────────────────────

  var preview = null;

  /**
   * La miniatura (o el icono del tipo de documento) al pasar por encima de un chip.
   *
   * Es lo que el chip corto se llevó puesto: `@[curso/manual-de-marca-nova.png]` se
   * leía solo, `@Imagen_2` no dice qué imagen es. Así que el nombre está en el
   * tooltip y la IMAGEN está acá, que es más rápido de leer que cualquiera de los
   * dos.
   *
   * La fuente del `<img>` sale del inventario y no se arma acá, y eso importa: las
   * imágenes de un marcador son data URLs y las de los dos niveles generales son
   * rutas en disco, que hay que CONVERTIR a `file://` (en Windows con la barra extra
   * de la raíz y las barras normales, o Chromium no las carga). Eso ya lo resuelve
   * `stillThumbSrc` en cep/js/stills.js para las miniaturas de la tira, y el
   * inventario lo trae hecho: reusar ese criterio es lo que hace que la tira y el
   * preview no puedan mostrar cosas distintas.
   */
  function verPreview(c, campo) {
    if (campo._hpEditandoChip === c) return;
    var it = itemDe(c, campo);
    if (!it) return;
    if (!preview) {
      preview = document.createElement("div");
      preview.className = "hp-chip-preview";
      preview.setAttribute("aria-hidden", "true");
      if (document.body) document.body.appendChild(preview);
    }
    preview.innerHTML = "";
    preview.appendChild(miniatura(it));
    var pie = document.createElement("span");
    pie.className = "hp-chip-preview-pie";
    pie.textContent = it.nombre;
    preview.appendChild(pie);
    preview.setAttribute("data-hidden", "false");
    colocarPreview(c);
  }

  /**
   * EL DIBUJO de una referencia: su miniatura si es una imagen que está, y el icono
   * de su tipo si no.
   *
   * Una función y no dos, aunque la usen el preview del hover y las filas del menú
   * del `@`: son dos tamaños del mismo dibujo (el tamaño lo pone el CSS de cada
   * contenedor) y la decisión de QUÉ se dibuja es una sola. Con dos, el día que una
   * referencia sin disco deje de tener miniatura en un lado la seguiría teniendo en
   * el otro.
   */
  function miniatura(it) {
    if (it && it.src) {
      var img = document.createElement("img");
      img.src = it.src;
      img.alt = "";
      return img;
    }
    return HPIconos.el(it && it.falta ? "falta" : "documento");
  }

  /** La referencia que este chip nombra, o null si ya no está en la lista. */
  function itemDe(c, campo) {
    var men = menDe(c);
    var candidatos = campo._hpInventario().filter(function (it) {
      return String(it.nombre || "").toLowerCase() === String(men.nombre || "").toLowerCase() &&
        (!men.scope || it.scope === men.scope);
    });
    return candidatos[0] || null;
  }

  /**
   * Pegado al chip y ARRIBA, si hay lugar. Arriba y no abajo porque el renglón de
   * abajo es el que se está escribiendo: un preview que tape lo que se está
   * tecleando obliga a sacar el mouse para poder seguir, o sea que estorba justo
   * mientras se usa. Si el chip está en el primer renglón visible no hay arriba, y
   * ahí sí va abajo.
   */
  function colocarPreview(c) {
    if (!c.getBoundingClientRect || !preview.getBoundingClientRect) return;
    var r = c.getBoundingClientRect();
    var p = preview.getBoundingClientRect();
    var alto = p.height || 96;
    var ancho = p.width || 120;
    var arriba = r.top - alto - 6;
    preview.style.top = (arriba >= 4 ? arriba : r.bottom + 6) + "px";
    var x = Math.max(4, r.left);
    var tope = (Number(global.innerWidth) || 0) - ancho - 4;
    preview.style.left = (tope > 4 ? Math.min(x, tope) : 4) + "px";
  }

  function ocultarPreview() {
    if (preview) preview.setAttribute("data-hidden", "true");
  }

  // ── El menú que se abre al escribir `@` ─────────────────────────────
  //
  // El editor lo pidió así: *"al escribir a mano '@' debería salir un menú de
  // selección de las referencias. Así puedo solo seleccionar lo que deseo
  // rápidamente"*. Es el complemento de la tira de arriba: para mencionar tocando
  // una miniatura hay que sacar la mano del teclado en medio de una frase.
  //
  // Cuándo se abre y qué ofrece lo deciden `disparo` y `candidatos` en
  // cep/js/menciones.js, que son funciones puras y por eso se pueden fijar por test
  // sobre los casos raros (un mail, un `@` pegado a una palabra, una mención ya
  // escrita). Acá está lo que necesita DOM: dibujarlo, moverse con el teclado y que
  // no quede cortado.
  //
  // UNO solo para todo el panel, como el preview y como el tooltip: hay un campo con
  // el foco a la vez, así que un menú por campo serían cuatro elementos esperando
  // para que se use uno.

  var menu = null;
  var menuCampo = null;
  var menuDesde = -1;
  var menuConsulta = null;
  var menuFilas = [];
  var menuSel = 0;

  /**
   * ¿Corresponde tener el menú abierto con el cursor donde está? Se llama en cada
   * `input`, en cada `keyup` y al soltar el mouse, porque el cursor se mueve por los
   * tres caminos y el menú tiene que seguirlo.
   *
   * Es IDEMPOTENTE a propósito: si ya está abierto sobre el mismo `@` y con la misma
   * consulta, no redibuja nada. Sin eso, el `keyup` de la flecha que acaba de mover
   * la selección la devolvería al primero de la lista.
   */
  function revisarDisparo(campo) {
    if (campo._hpEditandoChip) return;
    if (!enFoco(campo)) { if (menuCampo === campo) cerrarMenu(); return; }
    var s = seleccion(campo);
    // Con algo seleccionado no hay un cursor donde escribir: el menú no viene al caso.
    if (s.desde !== s.hasta) { cerrarMenu(); return; }
    var d = HPMenciones.disparo(serializar(mapa(campo)), s.desde);
    if (!d) { cerrarMenu(); return; }
    abrirMenu(campo, d);
  }

  function abrirMenu(campo, d) {
    if (menuCampo === campo && menuDesde === d.desde && menuConsulta === d.consulta) return;
    var inv = campo._hpInventario();
    var filas = HPMenciones.candidatos(inv, d.consulta);
    // Con referencias adjuntas y NINGUNA que coincida, el menú se cierra en vez de
    // quedarse vacío: lo que el editor está escribiendo después del `@` ya no es el
    // nombre de ningún archivo, así que un menú abierto sólo le tapa el texto. Sin
    // ninguna referencia adjunta es distinto y se dice (ver `pintarMenu`): ahí la
    // duda no es cuál elegir, es de dónde salen.
    if (inv.length && !filas.length) { cerrarMenu(); return; }
    menuCampo = campo;
    menuDesde = d.desde;
    menuConsulta = d.consulta;
    menuFilas = filas;
    menuSel = 0;
    pintarMenu(inv.length > 0);
    colocarMenu(campo, d.desde);
    campo.setAttribute("aria-expanded", "true");
    marcarSel();
  }

  function cerrarMenu() {
    if (menu) menu.setAttribute("data-hidden", "true");
    if (menuCampo) {
      menuCampo.setAttribute("aria-expanded", "false");
      if (menuCampo.removeAttribute) menuCampo.removeAttribute("aria-activedescendant");
    }
    menuCampo = null;
    menuDesde = -1;
    menuConsulta = null;
    menuFilas = [];
    menuSel = 0;
  }

  /**
   * El menú dibujado: un rótulo por ámbito y una fila por referencia.
   *
   * Cada fila muestra LO MISMO que va a decir el chip —la miniatura, el número y el
   * nombre del archivo—, y no porque quede lindo: la etiqueta sale de
   * `HPMenciones.candidatos`, que la calcula con la misma función que el chip. Lo
   * que se ve en la lista es, carácter por carácter, lo que va a quedar en el campo.
   */
  function pintarMenu(hayReferencias) {
    if (!menu) {
      menu = document.createElement("div");
      menu.className = "hp-arroba";
      menu.setAttribute("role", "listbox");
      if (document.body) document.body.appendChild(menu);
    }
    menu.innerHTML = "";
    menu.setAttribute("data-hidden", "false");

    if (!hayReferencias) {
      // La duda real de alguien que recién abrió el panel no es cuál elegir: es de
      // dónde salen. Así que en vez de un menú vacío va una línea con los dos
      // caminos, que son los dos que existen.
      var vacio = document.createElement("div");
      vacio.className = "hp-arroba-vacio";
      vacio.textContent = "Todavía no hay referencias para mencionar. Arrastrá una imagen o un " +
        "PDF sobre este campo, o agregalas en «Estilo del curso» para que sirvan en todas las clases.";
      menu.appendChild(vacio);
      return;
    }

    var ambito = null;
    menuFilas.forEach(function (fila, i) {
      if (fila.scope !== ambito) {
        ambito = fila.scope;
        var rot = document.createElement("div");
        rot.className = "hp-arroba-rotulo";
        rot.textContent = fila.rotulo;
        menu.appendChild(rot);
      }
      menu.appendChild(filaDelMenu(fila, i));
    });
  }

  function filaDelMenu(fila, i) {
    var el = document.createElement("div");
    el.className = "hp-arroba-op" + (fila.falta ? " is-sin-disco" : "");
    el.id = "hp-arroba-op-" + i;
    el.setAttribute("role", "option");
    el.setAttribute("data-i", String(i));

    var dibujo = document.createElement("span");
    dibujo.className = "hp-arroba-mini";
    dibujo.appendChild(miniatura(fila));
    el.appendChild(dibujo);

    var etq = document.createElement("span");
    etq.className = "hp-arroba-num";
    etq.textContent = fila.etiqueta;
    el.appendChild(etq);

    var nombre = document.createElement("span");
    nombre.className = "hp-arroba-nombre";
    nombre.textContent = fila.nombre;
    el.appendChild(nombre);

    // Las que el disco no tiene aparecen igual y se dicen. Esconderlas es peor: el
    // editor sabe que agregó ese archivo, no lo vería en la lista y se iría a buscar
    // el motivo al lugar equivocado. Elegirla deja la mención con el aviso de
    // siempre, que es lo que ya sabe leer.
    if (fila.falta) {
      var aviso = document.createElement("span");
      aviso.className = "hp-arroba-falta";
      aviso.textContent = "no está en el disco";
      el.appendChild(aviso);
    }

    // `mousedown` con `preventDefault` es lo que hace que el clic FUNCIONE: sin eso
    // el campo pierde el foco al apretar, el `blur` cierra el menú y el `click`
    // llega a un menú que ya no está.
    el.addEventListener("mousedown", function (e) { if (e.preventDefault) e.preventDefault(); });
    el.addEventListener("click", function (e) {
      if (e.stopPropagation) e.stopPropagation();
      elegirFila(i);
    });
    // Y el mouse mueve la misma selección que las flechas: una sola marca de "esto
    // es lo que va a entrar si aprieto Enter".
    el.addEventListener("mouseover", function () { menuSel = i; marcarSel(); });
    return el;
  }

  function marcarSel() {
    if (!menu || !menuFilas.length) return;
    var ops = menu.querySelectorAll ? menu.querySelectorAll(".hp-arroba-op") : [];
    for (var i = 0; i < ops.length; i++) {
      var sel = String(ops[i].getAttribute("data-i")) === String(menuSel);
      ops[i].className = "hp-arroba-op" + (menuFilas[i] && menuFilas[i].falta ? " is-sin-disco" : "") +
        (sel ? " is-sel" : "");
      ops[i].setAttribute("aria-selected", sel ? "true" : "false");
      if (sel) {
        if (menuCampo) menuCampo.setAttribute("aria-activedescendant", ops[i].id);
        if (ops[i].scrollIntoView) { try { ops[i].scrollIntoView({ block: "nearest" }); } catch (e) {} }
      }
    }
  }

  /**
   * Una tecla con el menú abierto. Devuelve `true` si se la quedó.
   *
   * Las flechas, Enter, Tab y Escape son DEL MENÚ mientras está abierto, y el Enter
   * es el que importa: en un campo de prompt, un Enter que se le escapa al campo
   * mete un salto de línea, así que elegir con Enter dejaría un renglón suelto cada
   * vez. Es la misma familia de problema que la edición del número de un chip, y se
   * mide en el mismo lugar (`medir-chips.js`): un test del repo no puede verlo,
   * porque hace falta que Chromium esté editando de verdad.
   *
   * Todo lo demás pasa de largo a propósito: tecleando se sigue filtrando.
   */
  function teclaDeMenu(e) {
    var k = e.key || "";
    if (k === "Escape") {
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      cerrarMenu();
      return true;
    }
    // El cartel de "todavía no hay referencias" no se navega ni se elige.
    if (!menuFilas.length) return false;
    if (k === "ArrowDown" || k === "ArrowUp") {
      if (e.preventDefault) e.preventDefault();
      menuSel = (menuSel + (k === "ArrowDown" ? 1 : -1) + menuFilas.length) % menuFilas.length;
      marcarSel();
      return true;
    }
    if (k === "Enter" || k === "Tab") {
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      elegirFila(menuSel);
      return true;
    }
    return false;
  }

  /**
   * La referencia elegida queda como chip y el `@` con lo tecleado desaparece.
   *
   * La inserción la hace `HPMenciones.insertar`, el MISMO camino que usa tocar una
   * miniatura de la tira: primero se saca el `@…` y se deja el cursor ahí, y después
   * se inserta. Con eso los espacios de alrededor los cuida quien ya los cuidaba
   * —«copiá @Imagen_1 y…» y no «copiá@Imagen_1y…»— y no hay una segunda regla de
   * espaciado que pueda decir otra cosa.
   */
  function elegirFila(i) {
    var campo = menuCampo;
    var fila = menuFilas[i];
    var desde = menuDesde;
    var hasta = desde + 1 + String(menuConsulta || "").length;
    if (!campo || !fila) return;
    cerrarMenu();
    var v = serializar(mapa(campo));
    campo.value = v.slice(0, desde) + v.slice(hasta);
    ponerSeleccion(campo, desde, desde);
    HPMenciones.insertar(campo, fila.token);
    emitir(campo);
  }

  /**
   * Pegado al `@`, del lado donde haya lugar, y ACOTADO a ese lugar.
   *
   * Va `fixed` y colgado del `<body>` por lo mismo que el preview: el campo puede
   * estar en el medio de la lista de marcadores, que tiene su propio scroll, y
   * cualquier menú en-flujo o absoluto adentro de la ficha lo recortaría ese
   * `overflow`. El ancla es el `@` y no el campo: en un campo de cinco renglones, un
   * menú colgado del borde de abajo aparece lejos de donde se está escribiendo.
   *
   * Elegir el lado no alcanza, y eso lo encontró `medir-chips.js`: a 320×700, con el
   * campo del marcador a media altura, quedaban 132 px abajo y el menú medía 232, así
   * que "hay lugar abajo" era verdad y el menú igual salía 18 px por debajo del
   * borde. Lo que lo arregla es la segunda mitad: el menú se acota al hueco del lado
   * elegido (`max-height` por JS) y scrollea adentro. Con eso no puede quedar
   * cortado, en ningún ancho y con el campo en cualquier posición — y a cambio, en el
   * caso apretado se ven tres filas en vez de seis, que es lo correcto: tres filas
   * que se pueden leer y scrollear valen más que seis de las que dos se cortan.
   *
   * El criterio del lado es el del tooltip del panel (`installTooltips` en
   * widgets.js): abajo si entra, y si no del lado que tenga más.
   */
  function colocarMenu(campo, desde) {
    if (!menu || !menu.getBoundingClientRect) return;
    var r = cajaDelArroba(campo, desde);
    if (!r) return;
    // Se mide con el techo del CSS y sin el límite de la vez anterior, o el menú se
    // iría achicando solo cada vez que se abre en un lugar apretado.
    menu.style.maxHeight = "";
    var natural = menu.getBoundingClientRect();
    var alto = natural.height || 200;
    var ancho = natural.width || 240;
    var margen = 6;
    var abajo = Math.max(0, (Number(global.innerHeight) || 0) - r.bottom - 4 - margen);
    var arriba = Math.max(0, r.top - 4 - margen);
    var vaArriba = alto > abajo && arriba > abajo;
    var lugar = vaArriba ? arriba : abajo;
    menu.style.maxHeight = lugar + "px";
    menu.setAttribute("data-arriba", vaArriba ? "true" : "false");
    var usado = Math.min(alto, lugar);
    menu.style.top = (vaArriba ? Math.max(margen, r.top - usado - 4) : (r.bottom + 4)) + "px";
    var tope = (Number(global.innerWidth) || 0) - ancho - margen;
    menu.style.left = (tope > margen ? Math.max(margen, Math.min(r.left, tope)) : margen) + "px";
  }

  /** La caja del `@` en la pantalla, para colgarle el menú. */
  function cajaDelArroba(campo, desde) {
    if (document.createRange && campo.getBoundingClientRect) {
      try {
        var m = mapa(campo);
        var r = document.createRange();
        colocar(r, "setStart", campo, m, posicionDe(m, desde));
        colocar(r, "setEnd", campo, m, posicionDe(m, desde + 1));
        var caja = r.getBoundingClientRect();
        if (caja && (caja.width || caja.height)) return caja;
      } catch (e) {}
      return campo.getBoundingClientRect();
    }
    return null;
  }

  global.HPCampo = {
    crear: crear,
    /** Repinta los chips de un campo con el inventario de ahora. */
    repintar: function (campo) { if (campo && campo.repintar) campo.repintar(); },
    // La aritmética, expuesta para poder fijarla por test sin montar el panel: es
    // lo único de acá que no necesita un DOM con motor de layout.
    _mapa: mapa,
    _serializar: serializar,
    _offsetDe: offsetDe,
    _posicionDe: posicionDe,
    /** En qué está el menú del `@`, para poder mirarlo desde un test. */
    _menu: function () {
      return { campo: menuCampo, el: menu, filas: menuFilas, sel: menuSel, consulta: menuConsulta };
    },
    /** Lo cierra y lo olvida: un menú abierto no puede sobrevivir a un test. */
    _olvidarMenu: function () { cerrarMenu(); menu = null; }
  };
})(typeof window !== "undefined" ? window : this);
