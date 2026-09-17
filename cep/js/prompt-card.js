/**
 * HPPromptCard — el CUERPO de una ficha donde se le pide algo al modelo.
 *
 * Lo usan los tres lugares donde el editor escribe un pedido con referencias
 * adjuntas: la ficha de cada marcador, "Estilo del curso" y "Estilo de esta
 * secuencia". No es una maqueta pegada a los marcadores: es UNA gramática, y los
 * tres la hablan. Lo único que cambia entre ellos es qué botones lleva el pie —
 * los dos bloques de estilo no generan nada, así que no tienen ninguno.
 *
 * ── La forma, y por qué es ésa ────────────────────────────────────────
 *
 * De arriba a abajo:
 *
 *   1. LA TIRA DE REFERENCIAS, arriba del campo y pegada a él. Están arriba y no
 *      abajo porque van CON el prompt: el editor escribe mirándolas. Y no hay
 *      zona de arrastre: se suelta el archivo sobre el campo, como en cualquier
 *      editor de texto de 2026, y lo que queda escrito es la MENCIÓN de esa
 *      referencia (ver cep/js/menciones.js). Los 52 px que ocupaba el "Arrastrá
 *      imágenes, PDFs o referencias aquí" son los que ahora tiene el campo. Con
 *      la tira vacía no ocupa NADA.
 *   2. EL CAMPO, alto desde el arranque. Es lo único que se escribe en esta
 *      pantalla y era lo más chico de la tarjeta. Y con las menciones dibujadas
 *      como CHIPS: `@Imagen_1` a la vista, `@[curso/manual.png]` guardado (ver
 *      cep/js/campo.js).
 *   3. EL AVISO DE LAS MENCIONES, entre el campo y los controles: es donde se
 *      está mirando cuando se escribe, y lo que dice se arregla ahí mismo.
 *   4. LA BARRA DE CONTROLES: dictar, refinar, capturar el cuadro del programa,
 *      adjuntar. Todo lo que ES una herramienta del campo, junto y en un solo
 *      renglón, con iconos de trazo (HPIconos) y no emojis del sistema.
 *   5. UN DESPLEGABLE "Avanzado" con lo que se mira una vez cada tanto: el
 *      transcript del tramo y el editor de HTML.
 *   6. EL PIE con las acciones, y ahí la posición ES la jerarquía: a la derecha
 *      lo que se aprieta siempre (Generar, y a su izquierda Enviar a la cola), a
 *      la izquierda lo destructivo (Regenerar desde cero). Separados a propósito:
 *      eran tres botones en fila y el que tira el trabajo anterior estaba pegado
 *      al que lo continúa.
 *
 * Lo que NO está acá son los METADATOS —lo que tardó la última versión y lo que
 * va a costar mandarla—. Estuvieron un rato en un renglón arriba del todo y se
 * fueron al `<summary>` de la ficha del marcador: ahí se ven también con la ficha
 * PLEGADA, y no cuestan una fila de alto. Es un dato del marcador y no del cuerpo
 * del pedido, así que el cuerpo compartido no tiene por qué conocerlo.
 *
 * ── La barra de controles ES la barra del micrófono ──────────────────
 *
 * Y no una fila nueva al lado. Si fueran dos, la línea de estado del dictado
 * —que reclama su ancho y se lleva el sobrante— empujaría 📸 y el clip al
 * renglón de abajo SIEMPRE. Así que los controles propios de la ficha entran
 * como `extras` de `HPDictado.attachMic`, entre el ✨ y la línea de estado.
 *
 * Cuando NO se puede dictar —Windows, sin ffmpeg, sin Whisper, o `dictado.js` sin
 * cargar— `HPUtil.micOpcional` devuelve null y esta función arma la MISMA barra
 * con los extras solos. Es la guarda de siempre y acá se paga entera: el campo,
 * sus referencias y sus controles se dibujan igual, porque el dictado es un
 * agregado y nunca un requisito.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPPromptCard.
 */
(function (global) {
  "use strict";

  /**
   * Un botón de solo icono para la barra de controles.
   *
   * Lleva `title` Y `aria-label` con lo mismo: sin texto adentro, el tooltip es
   * lo único que lo nombra para quien ve y el aria-label lo único para quien
   * escucha. Y la clase es `.hp-ico-btn` y no `.btn-ico`, que se ESCONDE a 320 px
   * para dejarle el ancho al texto del botón: acá el icono es el botón entero, y
   * esconderlo dejaría un cuadrado vacío.
   */
  function botonIcono(icono, titulo, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "mic-btn hp-ico-btn";
    b.title = titulo;
    b.setAttribute("aria-label", titulo);
    b.appendChild(HPIconos.el(icono));
    if (onClick) b.addEventListener("click", function () { onClick(b); });
    return b;
  }

  /**
   * Lo que el panel ofrece adjuntar, en UN solo lugar.
   *
   * El dueño de verdad de esta lista es el MOTOR: qué se puede ingerir lo decide
   * el mapa de extensiones de bridge/store/references.js, y qué se pega en el
   * prompt en vez de viajar como imagen lo decide bridge/engine.js. Esto es el
   * reflejo de esa decisión del lado del panel, y es un reflejo y no la fuente
   * porque leer el bridge desde acá pide el `require` de engine-client.js —o sea
   * que HPMenciones y compañía dependan de que Node esté en el panel—.
   *
   * Lo que sí no puede volver a pasar es que el reflejo esté cuatro veces, una
   * por pestaña, que es como estaba. El día que entre `.rtf`, olvidarse de un
   * archivo no rompe nada visible: esa pestaña simplemente no deja adjuntar un
   * formato que las otras tres sí, sin error, sin log y sin nada que lo note.
   */
  var FORMATOS = "image/*,application/pdf,.pdf,.txt,.md,.csv,.json,.doc,.docx";

  /**
   * El clip de adjuntar: el botón y su selector de archivos escondido, que van
   * los DOS a la barra de controles (un `<input type=file>` fuera del árbol no se
   * puede abrir por código en CEP).
   *
   * No estaba en la lista de controles que pidió el editor y va igual: al sacar
   * la zona de arrastre —que era lo único que abría el selector— quedaba solo el
   * arrastre, y arrastrar no sirve para un archivo que no está en una ventana del
   * Finder ya abierta.
   *
   * Devuelve `[boton, input]`, en ese orden, que es el que llevan en la barra.
   */
  function adjuntar(titulo, ingerir) {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = FORMATOS;
    input.multiple = true;
    input.style.display = "none";
    input.addEventListener("change", function () {
      ingerir(input.files);
      input.value = "";
    });
    return [botonIcono("adjuntar", titulo, function () { input.click(); }), input];
  }

  /**
   * El cableado de las REFERENCIAS DE UN MARCADOR, armado acá y no en cada
   * pestaña que lo necesita.
   *
   * Las tres fichas que le escriben al modelo sobre un marcador —la del marcador,
   * la ronda de feedback de la Cola y la fila de Corrections— quieren exactamente
   * lo mismo: el inventario que le llega al modelo, la tira que lo muestra, el 📸,
   * el clip, el arrastre y la canonización del ✨. Y estaba escrito entero en las
   * tres, idéntico carácter por carácter, títulos largos incluidos. No era un
   * problema de estética: la lista de formatos del clip vivía ahí adentro, así que
   * eran cuatro copias de lo que el motor puede ingerir (ver `FORMATOS`).
   *
   * Todo eso se escribe solo a partir de `stills`:
   *
   *   clave     — sobre qué marcador trabaja.
   *   opts      — sobre qué secuencia, y con qué job se cuentan los 📤. Es la del
   *               JOB y no la abierta en Premiere: con la cola de varias clases, o
   *               corrigiendo algo del corte anterior, no coinciden.
   *   enLaLista — si esta ficha ES la tarjeta del marcador en la pestaña
   *               Marcadores. Marca dos cosas a la vez porque son la misma: sólo
   *               ella dibuja además las referencias HEREDADAS (por eso se pasa su
   *               propio `tira`, que las agrega), y sólo ella NO necesita decirle a
   *               HPStills cómo repintarse, porque HPStills la encuentra en el DOM
   *               por su `markerKey` (ver `refresh` en cep/js/stills.js). Pasarle
   *               las dos cosas la repintaría —y le recalcularía el estimado, que
   *               es una llamada al motor— dos veces por cada archivo que entra.
   *
   * `laFicha` es cómo se llega a la ficha que todavía no existe: `montar` lo
   * rellena a medida que la arma. Hace falta porque la tira se dibuja ARRIBA del
   * campo, o sea antes de que el campo exista, y los cinco callbacks se escriben
   * todos en términos del campo y de lo que hay que repintar cuando algo cambia.
   */
  function cablearStills(stills, laFicha) {
    var clave = stills.clave;
    var sOpts = stills.opts || {};

    /**
     * Escribe la mención de una referencia donde está el cursor.
     *
     * Lo que la dispara cambia entre las tres: en la ficha del marcador es también
     * tocar una miniatura, y en las dos rondas de feedback no, porque ahí el clic
     * de la miniatura ya está tomado por el 📤 que decide si esa imagen viaja. Lo
     * que no cambia es que soltar un archivo o capturar un cuadro deja escrita la
     * mención de lo que acaba de entrar.
     */
    function mencionar(scope, nombre) {
      if (!nombre || !laFicha.campo) return;
      HPMenciones.insertar(laFicha.campo, HPMenciones.escribir(scope, nombre), {
        onChange: function (texto) { laFicha.cambiar(texto); }
      });
    }

    /**
     * Las opciones con las que se le habla a HPStills. Se arma en cada llamada y
     * no una vez: el contexto se resuelve en cada lectura porque el editor puede
     * cambiar de secuencia en Premiere con la ficha abierta.
     */
    function hoja() {
      return {
        fbJobId: sOpts.fbJobId || null,
        projectPath: sOpts.projectPath || "",
        sequenceName: sOpts.sequenceName || "",
        mencionar: mencionar,
        refrescar: stills.enLaLista ? null : function () { laFicha.refrescar(); }
      };
    }

    function inventario() { return HPStills.inventario(clave, hoja()); }

    // El renglón donde el 📸 dice qué pasó. Va debajo de la barra de controles
    // —o sea al lado del botón que lo escribe— y no adentro de la tira: la tira
    // se esconde entera cuando está vacía, y ése es justo el momento en que este
    // error aparece, con el marcador todavía sin imágenes. Las dos rondas de
    // feedback lo tenían adentro de la tira, donde no se veía.
    var estado = document.createElement("div");
    estado.className = "still-status";

    var capturarBtn = botonIcono("capturar",
      "Capturar del programa: toma el cuadro actual del monitor, lo adjunta a este marcador y lo menciona donde estés escribiendo",
      function (b) { HPStills.capturar(clave, hoja(), b, estado); });
    var clip = adjuntar(
      "Elegir imágenes, PDFs o documentos para adjuntar a este marcador (también se pueden arrastrar sobre el campo)",
      function (files) { HPStills.ingerir(files, clave, hoja()); });

    return {
      mencionar: mencionar,
      inventario: inventario,
      estado: estado,
      controles: [capturarBtn].concat(clip),
      tira: function (cont) {
        cont.innerHTML = "";
        cont.appendChild(HPStills.crearTira(clave, hoja()).el);
      },
      soltar: function (files) { HPStills.ingerir(files, clave, hoja()); },
      canonizar: function (texto) { return HPMenciones.canonizar(texto, inventario()); }
    };
  }

  /**
   * El cuerpo de una ficha. Devuelve `{ el, campo, tira, aviso, revisar }`.
   *
   * `opts`:
   *   campo        — el `<textarea>` del HTML al que este campo REEMPLAZA (los dos
   *                  bloques de estilo tienen el suyo en index.html, con su id, su
   *                  placeholder y su rótulo, y de ahí los hereda) o null para que
   *                  se cree de cero. No se conserva el textarea: un campo con
   *                  chips no puede ser un textarea (ver cep/js/campo.js).
   *   camposClase  — clases del campo cuando lo crea esta función.
   *   placeholder  — idem.
   *   rotulo       — el id del `<label>` que lo nombra. Un `contenteditable` no es
   *                  un control de formulario, así que lo nombra `aria-labelledby`
   *                  y no el `for=` del rótulo.
   *   micId        — el id del campo para el dictado (el motor no deja dos a la vez).
   *   onChange     — se llama cuando algo de acá escribe en el campo, para que el
   *                  que llama persista como ya lo hace.
   *   stills       — { clave, opts, enLaLista }: la ficha arma ELLA toda la barra
   *                  de referencias del marcador (ver `cablearStills`). Lo pasan
   *                  las tres fichas que le escriben al modelo sobre un marcador;
   *                  los dos bloques de estilo no, porque su material es de HPRefs
   *                  y no de HPStills, y traen los suyos.
   *   tira(cont, m)— dibuja la tira de referencias adentro de `cont`. La dibuja el
   *                  dueño del material (HPStills o HPRefsView), no esto: uno
   *                  escribe sincrónico contra el localStorage y el otro
   *                  asincrónico contra el disco. Con `stills` no hace falta,
   *                  salvo para agregarle algo: `m` es el `mencionar` de la ficha,
   *                  que es lo que esa tira necesita y todavía no puede pedirle a
   *                  nadie (el campo no existe cuando la tira se dibuja).
   *   inventario() — [{ scope, nombre, falta }] en el orden en que le llegan al
   *                  modelo. Lo miran el resaltado, el aviso y la canonización.
   *                  Con `stills` sale solo; se pasa a mano donde el inventario es
   *                  deliberadamente OTRO (los dos bloques de estilo nombran sólo
   *                  lo suyo, ver `inventarioDe` en cep/js/general-view.js).
   *   canonizar(t) — convierte las referencias escritas a mano ("imagen 2") en
   *                  menciones. Se aplica al REFINAR y nada más (ver abajo).
   *   estado       — el renglón donde la tira dice qué pasó (el 📸). Va debajo de
   *                  la barra de controles y no adentro de la tira, que se
   *                  esconde cuando está vacía.
   *   antes        — elementos que van ARRIBA DE TODO, antes de la tira. Es el
   *                  hermano de `pie` y lo usa una sola de las cuatro fichas: la
   *                  fila de Corrections, que abre con lo que se le pidió al
   *                  recurso cuando nació y con el contexto que recibió. Eso es
   *                  material de lectura y va antes de escribir, no después
   *                  («¿qué era este gráfico?» se contesta antes de decir qué
   *                  está mal). Las otras tres no le pasan nada.
   *   soltar(files)— qué hacer con lo que se arrastra sobre el campo.
   *   controles    — los controles PROPIOS de esta ficha ("Con fondo", el selector
   *                  de versión). Van después del 📸 y el clip, que con `stills`
   *                  los pone esta función.
   *   avanzado     — [{ titulo, el }] para el desplegable, o null.
   *   acciones     — { izquierda: [], derecha: [] } para el pie, o null.
   *   pie          — elementos que van al final, tal cual (el estado, la barra).
   */
  function montar(opts) {
    opts = opts || {};
    var caja = document.createElement("div");
    caja.className = "hp-ficha";

    // El cableado de las referencias del marcador, si esta ficha trabaja sobre uno.
    // `laFicha` se rellena abajo: `cablearStills` lo necesita antes de que el campo
    // exista, porque la tira se dibuja arriba del campo (ver `cablearStills`).
    var laFicha = {
      campo: null,
      cambiar: function (texto) { alCambiar(texto); },
      refrescar: function () { pintarTira(); revisar(); }
    };
    var refs = opts.stills ? cablearStills(opts.stills, laFicha) : null;

    // 0. Lo que se lee antes de escribir (sólo la fila de Corrections).
    (opts.antes || []).forEach(function (e) { if (e) caja.appendChild(e); });

    // 1. La tira de referencias. La DIBUJA su dueño (HPStills para un marcador,
    // HPRefsView para los dos niveles generales): uno escribe sincrónico contra el
    // localStorage y el otro asincrónico contra el disco, y meter las dos cosas en
    // la misma función es pedir que alguna vez una escritura del marcador termine
    // en la carpeta del proyecto.
    //
    // Lo que sí dejó de estar en cada llamador es PEDÍRSELO: con `stills`, llamar a
    // HPStills lo hace esta función (ver `cablearStills`), que no es lo mismo que
    // dibujar. La delegación sigue entera; lo que se fue son las tres copias de esa
    // misma delegación.
    var tira = document.createElement("div");
    tira.className = "hp-tira";
    caja.appendChild(tira);

    /**
     * Redibuja la tira y marca si quedó VACÍA, para que no ocupe nada.
     *
     * La marca la pone acá y no el dueño porque los dos dueños dibujan cosas
     * distintas (miniaturas y chips uno, referencias heredadas el otro) y la
     * pregunta es la misma: ¿hay algo? Y `:empty` de CSS no sirve: la tira siempre
     * tiene sus contenedores adentro, aunque estén vacíos.
     */
    function pintarTira() {
      var dibujar = typeof opts.tira === "function" ? opts.tira : (refs && refs.tira);
      if (dibujar) dibujar(tira, refs && refs.mencionar);
      marcarVacia();
    }

    /**
     * ¿La tira tiene algo? Si no, se esconde entera (`.hp-tira[data-vacia="true"]`).
     *
     * Va aparte de `pintarTira` porque hay dos maneras de que la tira cambie y sólo
     * una pasa por acá: la ficha la redibuja entera, pero los DUEÑOS del material
     * (`HPStills` y `HPRefsView`) también escriben adentro por su cuenta —una
     * captura del programa, un archivo soltado, una miniatura borrada— y ésos no
     * la vuelven a dibujar, la actualizan.
     *
     * Con la marca calculada una sola vez al montar, esa segunda manera dejaba la
     * tira marcada como vacía para siempre: el material se guardaba —la insignia
     * del bloque hasta lo contaba— y la miniatura quedaba en el DOM adentro de un
     * contenedor con `display: none`. Lo reportó el editor sobre los dos bloques de
     * estilo, que son donde más se nota porque ahí la tira suele arrancar vacía:
     * "al darle captura en el área de Estilo del curso como de secuencia, no
     * aparecen"; y después, mirando el disco, "sí los trae pero no aparecen en sus
     * interfaces".
     *
     * Se recalcula mirando el DOM y no llevando una cuenta: la cuenta sería un
     * tercer lugar donde el mismo hecho puede quedar viejo.
     */
    function marcarVacia() {
      var hay = !!(tira.querySelector && tira.querySelector(".still-thumb, .resource-chip, .hp-heredada"));
      tira.setAttribute("data-vacia", hay ? "false" : "true");
    }
    pintarTira();

    // 2. El campo, que pinta las menciones como CHIPS.
    //
    // Es un `contenteditable` que imita la interfaz de un textarea en coordenadas
    // del texto canónico, y toda esa maquinaria vive en `cep/js/campo.js` — con el
    // por qué escrito ahí. Acá sólo se lo cuelga: desde afuera sigue siendo un campo
    // con `.value`, `selectionStart` y su evento `input`, que es lo que el dictado,
    // el ✨, el control de alto y el guardado de cada pestaña ya sabían usar.
    //
    // Hubo un ESPEJO —un `<div>` detrás pintando el mismo texto con las menciones en
    // `<span>`— y andaba, porque decía exactamente los mismos caracteres que el
    // campo. Un chip dice OTROS (`@Imagen_1` donde el texto tiene 38 caracteres), o
    // sea que no hay nada que alinear: el campo tiene que pintarlos de verdad.
    var envoltorio = document.createElement("div");
    envoltorio.className = "hp-campo";
    var aviso = document.createElement("div");
    aviso.className = "hp-aviso";
    aviso.setAttribute("data-hidden", "true");

    function inventario() {
      var propio = typeof opts.inventario === "function" ? opts.inventario : (refs && refs.inventario);
      return (propio && propio()) || [];
    }

    var campo = HPCampo.crear({
      desde: opts.campo || null,
      // Sin clase propia el campo se dibuja igual: todo lo que lo hace un campo de
      // prompt está en `.hp-campo-input`, que se le agrega abajo. La clase de cada
      // uno es para lo que tiene de propio (el alto de arranque, casi siempre), y
      // los dos bloques de estilo no la necesitan porque lo suyo cuelga de su id.
      clase: opts.camposClase || "",
      placeholder: opts.placeholder || "",
      rotulo: opts.rotulo || "",
      inventario: inventario
    });
    campo.classList.add("hp-campo-input");
    envoltorio.appendChild(campo);
    caja.appendChild(envoltorio);
    laFicha.campo = campo;

    // 3. El aviso de las menciones.
    caja.appendChild(aviso);

    function pintarAviso(r) {
      if (!r) {
        aviso.setAttribute("data-hidden", "true");
        aviso.textContent = "";
        aviso.className = "hp-aviso";
        return;
      }
      aviso.setAttribute("data-hidden", "false");
      aviso.textContent = r.texto;
      aviso.className = "hp-aviso " + r.clase;
    }

    /**
     * El renglón de abajo, contra el inventario de ahora. Cuelga del `input`, o sea
     * de cada tecla: es texto y nada más, no toca el DOM del campo.
     */
    function avisar() {
      pintarAviso(HPMenciones.renglon(HPMenciones.revisar(campo.value, inventario())));
    }

    /**
     * Los CHIPS, redibujados, más el aviso.
     *
     * Ésta es la que NO puede colgar del `input`: redibujar un `contenteditable` con
     * el foco adentro se come el undo nativo (el cursor sí se conserva, lo repone la
     * fachada). Y no hace falta que cuelgue, porque tecleando los chips no cambian:
     * lo que los cambia es que se cargue otro texto o que se mueva la LISTA DE
     * REFERENCIAS —y una mención se vuelve inválida por los dos lados, escribiendo
     * mal el nombre o sacando la referencia que nombraba—. Por eso los llamadores de
     * siempre (`mencionar`, la tira que se refresca, la hidratación de los bloques
     * de estilo) siguen llamando a `revisar()` y les alcanza.
     */
    function revisar() {
      campo.repintar();
      avisar();
      // Y si la tira pasó de vacía a tener algo (o al revés), que deje de estar
      // escondida. Va acá y no sólo en `pintarTira` porque los dueños del material
      // escriben adentro de la tira sin redibujarla: ver `marcarVacia`.
      marcarVacia();
    }
    campo.addEventListener("input", avisar);
    // Dónde quedó el cursor. Insertar una mención pide tocar una miniatura o un
    // botón, o sea sacarle el foco al campo: cuando llega el clic, el cursor ya no
    // se puede preguntar (ver seguirCursor en cep/js/menciones.js).
    HPMenciones.seguirCursor(campo);

    // Arrastrar sobre el CAMPO. Reemplaza la zona de arrastre, que ocupaba 52 px
    // permanentes para decir una instrucción que se aprende la primera vez.
    // La marca va en el ENVOLTORIO y no en el campo, así el acento envuelve la caja
    // entera sin competir con el fondo de la selección de texto ni con el de los
    // chips rotos.
    var soltar = typeof opts.soltar === "function" ? opts.soltar : (refs && refs.soltar);
    if (soltar) {
      var sobre = function (e) { e.preventDefault(); envoltorio.classList.add("is-over"); };
      var fuera = function () { envoltorio.classList.remove("is-over"); };
      campo.addEventListener("dragover", sobre);
      campo.addEventListener("dragleave", fuera);
      campo.addEventListener("drop", function (e) {
        e.preventDefault();
        fuera();
        soltar(e.dataTransfer && e.dataTransfer.files);
      });
      // Y sobre la tira también: es donde el editor mira las referencias, así que
      // es donde va a soltar la siguiente.
      tira.addEventListener("dragover", sobre);
      tira.addEventListener("dragleave", fuera);
      tira.addEventListener("drop", function (e) {
        e.preventDefault();
        fuera();
        soltar(e.dataTransfer && e.dataTransfer.files);
      });
    }

    /**
     * Algo de acá escribió en el campo (el dictado, el ✨, una mención insertada).
     * El que llama persiste como ya lo hacía y los chips se repintan: son las dos
     * cosas que hay que hacer siempre, y por eso las tres fichas pedían lo mismo
     * en su `mencionar` (ver `cablearStills`).
     */
    function alCambiar(texto) {
      if (typeof opts.onChange === "function") opts.onChange(texto);
      revisar();
    }

    var canonizar = typeof opts.canonizar === "function" ? opts.canonizar : (refs && refs.canonizar);

    // 4. La barra de controles = la barra del micrófono, con los extras adentro.
    // Primero las herramientas de las referencias (el 📸 y el clip, iguales en las
    // tres fichas de marcador) y después lo propio de cada una.
    var extras = (refs ? refs.controles : []).concat(opts.controles || []).filter(Boolean);
    var barra = HPUtil.micOpcional(campo, {
      id: opts.micId || "campo",
      extras: extras,
      // Refinar CANONIZA las referencias escritas a mano: "imagen 2" pasa a ser la
      // mención del archivo que de verdad es la 2 en este pedido. Lo hace el panel
      // y no el modelo, porque el orden lo conoce el panel exactamente; el modelo
      // tendría que adivinarlo y si adivina mal cambia la imagen sin que nada falle
      // (ver `canonizar` en cep/js/menciones.js).
      canonizar: canonizar ? function (texto) {
        var r = canonizar(texto) || {};
        return { texto: r.texto, nota: HPMenciones.notaDeCanonizar(r) };
      } : null,
      onChange: alCambiar
    });
    if (!barra) {
      // Sin dictado, la MISMA barra con los extras solos: la ficha no cambia de
      // forma porque a esta máquina le falte ffmpeg.
      barra = document.createElement("div");
      barra.className = "mic-bar";
      extras.forEach(function (e) { barra.appendChild(e); });
    }
    barra.classList.add("hp-controles");
    caja.appendChild(barra);

    // El renglón de estado de la tira (lo que dice el 📸 cuando falla o cuando
    // guardó el cuadro) va JUSTO DEBAJO de la barra, o sea al lado del botón que lo
    // escribe, y no adentro de la tira: la tira se esconde entera cuando está
    // vacía, y ahí un error de captura habría quedado invisible — que es
    // exactamente el momento en que aparece, con el marcador todavía sin imágenes.
    var estado = opts.estado || (refs && refs.estado);
    if (estado) caja.appendChild(estado);

    // 5. El desplegable de lo que se mira una vez cada tanto.
    if (opts.avanzado && opts.avanzado.length) {
      var adv = document.createElement("details");
      adv.className = "hp-avanzado";
      var s = document.createElement("summary");
      s.textContent = "Avanzado";
      s.title = "El transcript de este tramo y el editor de HTML";
      adv.appendChild(s);
      var cuerpo = document.createElement("div");
      cuerpo.className = "hp-avanzado-body";
      opts.avanzado.forEach(function (x) { if (x && x.el) cuerpo.appendChild(x.el); });
      adv.appendChild(cuerpo);
      caja.appendChild(adv);
      caja._avanzado = adv;
    }

    // 6. El pie: lo destructivo a la izquierda, lo que se aprieta a la derecha.
    if (opts.acciones) {
      var pie = document.createElement("div");
      pie.className = "hp-acciones";
      var izq = document.createElement("div");
      izq.className = "hp-acciones-izq";
      (opts.acciones.izquierda || []).forEach(function (b) { if (b) izq.appendChild(b); });
      var der = document.createElement("div");
      der.className = "hp-acciones-der";
      (opts.acciones.derecha || []).forEach(function (b) { if (b) der.appendChild(b); });
      pie.appendChild(izq);
      pie.appendChild(der);
      caja.appendChild(pie);
    }

    (opts.pie || []).forEach(function (e) { if (e) caja.appendChild(e); });

    // Y se revisa una vez al montar: la instrucción puede venir del `localStorage`
    // con una mención que quedó colgada desde la sesión pasada, y ese es justo el
    // caso donde el editor no se acuerda de que la escribió.
    revisar();
    montadas.push({ el: caja, revisar: revisar });

    return {
      el: caja, campo: campo, tira: tira, aviso: aviso,
      revisar: revisar,
      /** Redibuja la tira (y vuelve a decidir si ocupa lugar o no). */
      pintarTira: pintarTira
    };
  }

  /**
   * Las fichas que están montadas, para poder repintarlas todas cuando cambia el
   * material.
   *
   * Hace falta una lista y no un llamado directo porque el que cambia el material
   * (una miniatura que se borra) no sabe qué campos lo están mostrando, y son
   * varios: el material del curso y el de la clase entran en la cuenta de TODAS
   * las fichas abiertas, así que sacar una imagen del curso corre los números en
   * las tres pestañas a la vez.
   */
  var montadas = [];

  /**
   * Repinta los chips y el aviso de todas las fichas que siguen en pantalla.
   *
   * La barrida de las que ya no están es la parte que no se puede olvidar: la Cola
   * y Corrections se redibujan enteras muy seguido, así que sin esto la lista
   * crecería sin techo con fichas muertas y cada cambio de material las recorrería
   * todas. Se pregunta por `isConnected`, que es lo que de verdad contesta si el
   * nodo sigue colgado del documento; una ficha desmontada no tiene a nadie que
   * avise.
   *
   * Y se descarta SÓLO con un `false` explícito, no con cualquier valor falso: los
   * DOM de mentira de los tests no implementan `isConnected`, así que un
   * `if (!el.isConnected)` las daba a todas por muertas y no repintaba ninguna —o
   * sea que el arreglo andaba en Premiere y los tests no podían verlo, que es la
   * peor combinación—.
   */
  function repintarTodas() {
    montadas = montadas.filter(function (f) { return f.el && f.el.isConnected !== false; });
    montadas.forEach(function (f) { try { f.revisar(); } catch (e) {} });
  }

  global.HPPromptCard = {
    montar: montar,
    botonIcono: botonIcono,
    adjuntar: adjuntar,
    repintarTodas: repintarTodas,
    /** Cuántas fichas vivas quedan (lo mira el test de la barrida). */
    _montadas: function () { return montadas.length; }
  };
})(typeof window !== "undefined" ? window : this);
