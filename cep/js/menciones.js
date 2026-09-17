/**
 * HPMenciones — la mitad del panel de las MENCIONES de referencias.
 *
 * La otra mitad, y la que manda, es `bridge/prompt/menciones.js`: ahí está
 * escrito qué es una mención, por qué se guarda con el NOMBRE del archivo y no
 * con el número, y cómo se traduce a «imagen N» al momento de mandar. Leelo
 * antes de tocar esto.
 *
 * Acá está solo lo que el panel necesita y el motor no puede hacer:
 *
 *  1. ESCRIBIR la mención en el campo, en la posición del cursor. Es la mitad de
 *     todo el cambio: el editor arrastra un archivo, o aprieta 📸, o toca una
 *     referencia de la tira, y en el texto le queda la mención escrita donde
 *     estaba escribiendo.
 *  2. AVISAR antes de generar. El motor avisa en el ⬇ Log cuando ya está armando
 *     la llamada; acá se avisa mientras se escribe, que es donde se arregla.
 *  3. NUMERAR: con qué número se muestra una mención en el campo. El motor traduce
 *     al mandar y el panel tiene que mostrar el MISMO número o el chip miente
 *     (ver `etiqueta` y `porNumero`, y el chip en cep/js/campo.js).
 *  4. OFRECER: cuándo se abre el menú del `@` y qué referencias ofrece para lo que
 *     se está tecleando (`disparo` y `candidatos`). El menú lo dibuja el campo; acá
 *     está la parte que se decide sin DOM, que es la que se puede fijar por test.
 *
 * Lo que NO está acá es resolver la mención a un número. Eso es del motor y de
 * nadie más: el único que sabe qué imágenes llegaron al disco —y por lo tanto
 * cuál es la 2— es el que arma la llamada. El chequeo de acá mira lo que el panel
 * tiene delante (las tres listas y su marca de faltante) y es la capa de "antes
 * de gastar la llamada", no la verdad.
 *
 * La GRAMÁTICA (cómo se escribe el token y cómo se encuentra) está en los dos
 * archivos, porque uno es Node y el otro son globales de navegador sin build. Que
 * las dos digan lo mismo lo fija la sección 1 de `test/menciones-panel.test.js`,
 * que corre las dos sobre el mismo corpus de lo normal, lo raro y lo roto.
 *
 * Vanilla JS, sin ES modules: se expone como window.HPMenciones.
 */
(function (global) {
  "use strict";

  // Igual que RE_MENCION en bridge/prompt/menciones.js.
  var RE = /@\[([^[\]\n]{1,200})\]/g;

  var AMBITOS = { marker: "marcador", course: "curso", sequence: "clase" };
  var AMBITOS_INV = { marcador: "marker", curso: "course", clase: "sequence" };

  function escribir(scope, nombre) {
    var amb = AMBITOS[scope] || "";
    return "@[" + (amb ? amb + "/" : "") + String(nombre || "") + "]";
  }

  function partir(cuerpo) {
    var txt = String(cuerpo || "").trim();
    var i = txt.indexOf("/");
    if (i === -1) return { scope: "", nombre: txt };
    var pref = txt.slice(0, i).trim().toLowerCase();
    if (!AMBITOS_INV[pref]) return { scope: "", nombre: txt };
    return { scope: AMBITOS_INV[pref], nombre: txt.slice(i + 1).trim() };
  }

  function encontrar(texto) {
    var out = [];
    var t = String(texto == null ? "" : texto);
    RE.lastIndex = 0;
    var m;
    while ((m = RE.exec(t)) !== null) {
      var p = partir(m[1]);
      if (!p.nombre) continue;
      out.push({ raw: m[0], scope: p.scope, nombre: p.nombre, desde: m.index });
    }
    return out;
  }

  function mismoNombre(a, b) {
    return String(a || "").toLowerCase() === String(b || "").toLowerCase();
  }

  /**
   * En qué estado está UNA mención contra el inventario: '' si apunta bien, o el
   * mismo motivo que usan el aviso y el motor.
   *
   * Está aparte de `revisar` porque tiene dos lectores que preguntan distinto: el
   * aviso quiere la lista de problemas del texto entero, y el CHIP quiere saber,
   * mención por mención, de qué color pintarse.
   */
  function estadoDe(men, inventario) {
    var inv = inventario || [];
    var candidatos = inv.filter(function (it) {
      return mismoNombre(it.nombre, men.nombre) && (!men.scope || it.scope === men.scope);
    });
    // El número que el editor escribió y que no apunta a nada va PRIMERO: es un caso
    // de "no apunta a nada" igual que la colgada, pero no es el mismo y no se
    // arregla igual (ver `numeroSuelto`).
    if (!candidatos.length && numeroSuelto(men)) return "sin-numero";
    if (!candidatos.length) return "colgada";
    if (!men.scope && candidatos.length > 1) return "ambigua";
    if (candidatos[0].falta) return "sin-disco";
    return "";
  }

  // ── Un NÚMERO que el editor escribió y que no apunta a nada ─────────
  //
  // Sale del doble clic sobre un chip: el editor escribe «7» y en el pedido hay seis
  // referencias. La primera versión de esto deshacía lo escrito —el chip volvía al
  // número anterior y se decía en el renglón de abajo— con el argumento de no
  // inventar nada, y el editor lo corrigió con razón: *"si lo modifico a algo que no
  // está, pues debería dejar de aparecer azul ya que no está referenciando nada. O
  // que aparezca rojo avisando que no referencia a nada"*. Deshacerle lo que escribió
  // es peor que mostrárselo mal: el chip volviendo solo al 3 se siente como que el
  // panel le pelea el teclado, y lo deja creyendo que quedó el 3 cuando quería el 7.
  //
  // Así que el estado inválido pasó a ser REPRESENTABLE, y para eso hay que poder
  // guardarlo. Lo que se guarda es el número, escrito como el nombre de una
  // referencia que no existe:
  //
  //   @[Imagen_7]      ← el editor pidió la imagen 7 y no hay ninguna imagen 7
  //   @[Documento_4]
  //
  // Y esto NO contradice por qué se guarda el nombre y no el número. Se guarda el
  // nombre para que una mención VÁLIDA sobreviva a que la lista se reordene; una que
  // no apunta a nada no tiene nombre que guardar, y ahí el número es el único
  // registro fiel de lo que el editor pidió —y lo único que puede corregir—.
  //
  // El motor ya trata bien este token sin saber nada de esto: no encuentra ninguna
  // referencia que se llame «Imagen_7», así que lo resuelve como una mención colgada
  // y el modelo lee que falta, no otra imagen en su lugar (está fijado en
  // `menciones.test.js`). Y se LEE, que es el otro requisito de siempre: un
  // `@[Imagen_7]` sin traducir dice exactamente lo que el editor quiso pedir.
  var RE_NUMERO_SUELTO = /^(Imagen|Documento)_([0-9]{1,3})$/;

  /**
   * Si esta mención es un número suelto, de qué clase y cuál. Null si no.
   *
   * Se reconoce por la FORMA del nombre y eso es seguro porque es una forma que
   * escribe este mismo módulo (`escribirNumero`), sin extensión y con el número
   * pegado: un archivo de verdad llamado «Imagen_7.png» no matchea, y sin extensión
   * sería un documento llamado «Imagen_7» — que si además existiera en la lista,
   * gana él, porque `estadoDe` sólo pregunta esto cuando NO hay candidatos.
   */
  function numeroSuelto(men) {
    var m = RE_NUMERO_SUELTO.exec(String((men && men.nombre) || ""));
    if (!m || (men && men.scope)) return null;
    return { tipo: m[1] === "Documento" ? "documento" : "imagen", numero: parseInt(m[2], 10) };
  }

  /** El token de un número que no apunta a nada. */
  function escribirNumero(tipo, n) {
    return "@[" + (tipo === "documento" ? "Documento_" : "Imagen_") + Math.round(Number(n) || 0) + "]";
  }

  // ── El NÚMERO, que tiene que ser el mismo que el del motor ──────────
  //
  // El campo muestra `@Imagen_1` y guarda `@[curso/manual-de-marca-nova.png]`, así
  // que el número es capa de presentación y nada más (ver la cabecera de
  // cep/js/campo.js, donde está escrito por qué esa disyuntiva se resolvió así).
  // Pero mientras se muestra tiene que ser EXACTO: un chip que dice «Imagen_2»
  // sobre lo que al modelo le va a llegar como «imagen 3» es peor que el token
  // largo, porque el token largo no miente.
  //
  // La cuenta la manda `indice()` en bridge/prompt/menciones.js: una imagen se
  // numera por su posición entre las que DE VERDAD viajan, en el orden del pedido
  // (marcador → curso → clase). Acá está la misma cuenta, sobre el inventario que
  // el panel tiene delante, y `test/menciones-campo.test.js` corre las dos sobre el
  // mismo material para que no se puedan separar.

  // Qué extensiones NO son una imagen. Es el respaldo de `esImagen` para un
  // inventario que no trae `tipo` —el de un panel más viejo, o el de un test que
  // arma la lista a mano—; los tres que lo arman de verdad sí lo traen, y ahí no se
  // adivina por el nombre del archivo.
  var RE_DOC = /\.(pdf|md|markdown|txt|csv|json|docx?)$/i;

  function esImagen(it) {
    if (it && it.tipo) return it.tipo === "imagen";
    return !RE_DOC.test(String((it && it.nombre) || ""));
  }

  /**
   * Las imágenes que VIAJAN, en el orden en que le llegan al modelo: es la lista
   * contra la que se numera, y la numeración es la posición + 1.
   *
   * Una que el disco no tiene (`falta`) no ocupa número, igual que en el motor: el
   * prompt dice "de 1 a N" contando las que llegaron, así que contarla acá
   * inventaría un número que el modelo no tiene.
   */
  function imagenes(inventario) {
    return (inventario || []).filter(function (it) { return esImagen(it) && !it.falta; });
  }

  /**
   * Los documentos del pedido, en orden.
   *
   * El motor NO los numera: los NOMBRA («el documento "manual.pdf"»), y el prompt
   * está verificado así. O sea que el `_3` de `@Documento_3` es un identificador del
   * PANEL y de nadie más: sirve para que el chip sea corto y para poder repuntarlo
   * con el doble clic, y no viaja a ninguna parte. Por eso también cuenta las que el
   * disco no tiene: un documento que falta se sigue nombrando.
   */
  function documentos(inventario) {
    return (inventario || []).filter(function (it) { return !esImagen(it); });
  }

  /**
   * Con qué se MUESTRA una mención en el campo: `{ texto, tipo, numero, estado }`.
   *
   * La regla es de TRES casos y no de dos, porque son tres cosas distintas de
   * arreglar. El chip muestra **lo que el editor tiene que corregir**:
   *
   *  · apunta bien → el NÚMERO (`@Imagen_3`), que es lo que el modelo va a leer.
   *  · el archivo está en la lista pero no en el disco, o la referencia ya no está
   *    adjunta → el NOMBRE DEL ARCHIVO, porque es lo que hay que volver a adjuntar
   *    (o montar el disco). Un «@Imagen_?» no diría nada. Es el mismo criterio con
   *    el que el motor traduce esos dos casos: pone el nombre entre comillas.
   *  · el editor escribió un número que no existe → ESE NÚMERO (`@Imagen_7`), en
   *    rojo. Acá el nombre no sirve —no hay archivo— y lo que hay que corregir es
   *    justamente el 7. Primero estuvo en la misma bolsa que la colgada y el editor
   *    lo separó: *"si lo modifico a algo que no está, debería dejar de aparecer
   *    azul"* (ver `numeroSuelto`).
   */
  function etiqueta(men, inventario) {
    var inv = inventario || [];
    var estado = estadoDe(men, inv);
    var candidatos = inv.filter(function (it) {
      return mismoNombre(it.nombre, men.nombre) && (!men.scope || it.scope === men.scope);
    });
    var it = candidatos[0];
    if (!it) {
      var suelto = numeroSuelto(men);
      // `tipo` se conserva para que el doble clic siga moviéndose entre las imágenes
      // o entre los documentos según de dónde venía el chip, y `numero` es el que el
      // editor escribió: es el que el campo le vuelve a ofrecer para corregir.
      if (suelto) {
        return {
          texto: "@" + men.nombre, tipo: suelto.tipo, numero: suelto.numero, estado: "sin-numero"
        };
      }
      return { texto: "@" + men.nombre, tipo: "", numero: 0, estado: "colgada" };
    }
    if (!esImagen(it)) {
      var d = indiceEn(documentos(inv), it);
      return { texto: "@Documento_" + d, tipo: "documento", numero: d, estado: estado };
    }
    if (it.falta) return { texto: "@" + it.nombre, tipo: "imagen", numero: 0, estado: estado };
    var n = indiceEn(imagenes(inv), it);
    return { texto: "@Imagen_" + n, tipo: "imagen", numero: n, estado: estado };
  }

  /**
   * Qué referencia es HOY el número `n` de su clase, que es lo que contesta el doble
   * clic sobre un chip: el editor escribe «2» y el chip tiene que repuntar a la que
   * en este momento es la 2, y guardar SU NOMBRE.
   *
   * Devuelve null si ese número no existe (un «7» con seis referencias). No se
   * inventa nada y tampoco se deshace lo escrito: el que llama guarda ESE número
   * como un token que no apunta a nada, y el chip pasa a rojo (ver `numeroSuelto`).
   */
  function porNumero(tipo, n, inventario) {
    var lista = tipo === "documento" ? documentos(inventario) : imagenes(inventario);
    var i = Math.round(Number(n));
    if (!(i >= 1) || i > lista.length) return null;
    return lista[i - 1] || null;
  }

  /** La posición de un item DENTRO de una lista ya filtrada, en base 1. */
  function indiceEn(lista, it) {
    for (var i = 0; i < lista.length; i++) if (lista[i] === it) return i + 1;
    return 0;
  }

  // ── El menú que se abre al escribir `@` ──────────────────────────────
  //
  // El editor lo pidió así: *"al escribir a mano '@' debería salir un menú de
  // selección de las referencias. Así puedo solo seleccionar lo que deseo
  // rápidamente"*. Es el complemento de la tira: para mencionar tocando una
  // miniatura hay que sacar la mano del teclado en medio de una frase.
  //
  // Acá está la parte que se puede decidir sin DOM —cuándo se abre, qué se filtra y
  // qué lista sale—, que es justo la que se puede fijar por test. El menú en sí
  // (dibujarlo, moverse con las flechas, que no quede cortado) es de
  // `cep/js/campo.js`.

  /**
   * Cómo se nombra un ámbito en una FRASE, que es distinto de cómo se escribe en el
   * token (`curso/`).
   *
   * Los dos de los niveles generales son textualmente los que ya usa la tira de
   * referencias heredadas de la ficha (`refs-view.js`), y un test los corre juntos:
   * si el menú dijera "de la clase" y la tira "de esta clase", serían dos nombres
   * para el mismo nivel a diez píxeles de distancia.
   */
  var ROTULOS = { marker: "de este marcador", course: "del curso", sequence: "de esta clase" };

  function rotulo(scope) {
    return ROTULOS[scope] || "";
  }

  /**
   * El texto con el que se compara al filtrar: sin mayúsculas y sin acentos.
   *
   * Sin acentos no es un lujo: hay archivos que se llaman «Guía de estilo» y
   * «Captura de pantalla», y tener que acertarle al acento para encontrar el
   * archivo es peor que abrir la tira con el mouse. Se usa `normalize("NFD")`
   * —Chromium lo tiene desde siempre— y se tiran las marcas diacríticas.
   */
  function plegar(s) {
    var t = String(s == null ? "" : s).toLowerCase();
    try { t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (e) {}
    return t;
  }

  // Hasta dónde se busca el `@` hacia atrás. El tope existe para que el menú no se
  // abra por un `@` que quedó diez palabras antes: lo que se teclea después del `@`
  // es un nombre de archivo a medio escribir, no un párrafo.
  var TOPE_CONSULTA = 60;

  /**
   * ¿Hay que abrir el menú con el cursor acá? Devuelve `{ desde, consulta }` —el
   * offset del `@` y lo tecleado después— o null.
   *
   * Las dos reglas, y las dos son del pedido:
   *
   *  · El `@` tiene que estar AL PRINCIPIO del campo o después de un espacio.
   *    Pegado a una palabra no se abre, porque eso es un mail o un handle
   *    («escribile a dani@nova.com», «como dice @marcelo») y abrir un menú ahí
   *    convierte cada dirección de correo en un tropiezo.
   *  · Lo tecleado después no puede tener espacios ni corchetes. Sin espacios,
   *    porque al terminar la palabra el editor siguió escribiendo la frase y el menú
   *    ya no viene al caso; sin corchetes, porque `@[curso/logo.svg]` es una mención
   *    YA escrita —o pegada— y reabrir el menú adentro de un token sería ofrecerle
   *    reemplazar lo que acaba de elegir.
   *
   * Es una función pura sobre `(texto, cursor)` y no sobre el DOM a propósito: así
   * el disparo se fija por test sobre los veinte casos raros, que es donde vive el
   * problema.
   */
  function disparo(texto, cursor) {
    var t = String(texto == null ? "" : texto);
    var c = Math.max(0, Math.min(Number(cursor) || 0, t.length));
    var desde = -1;
    for (var i = c - 1; i >= 0 && c - i <= TOPE_CONSULTA + 1; i--) {
      var ch = t.charAt(i);
      if (ch === "@") { desde = i; break; }
      // Un espacio, un salto o un corchete corta la búsqueda: el `@` que hubiera
      // más atrás ya no es el de esta palabra.
      if (/\s/.test(ch) || ch === "[" || ch === "]") return null;
    }
    if (desde === -1) return null;
    var antes = desde === 0 ? "" : t.charAt(desde - 1);
    if (antes && !/\s/.test(antes)) return null;
    return { desde: desde, consulta: t.slice(desde + 1, c) };
  }

  /**
   * Las referencias que el menú ofrece para una consulta, en el orden en que le
   * llegan al modelo y con lo MISMO que va a decir el chip.
   *
   * Cada fila trae la referencia entera más su `etiqueta` (`@Imagen_3`), su
   * `numero`, su `tipo`, su `token` y el `rotulo` de su ámbito. O sea que el menú no
   * vuelve a calcular nada: lo que se ve en la lista es, carácter por carácter, lo
   * que va a quedar en el campo al elegir. Si el menú numerara por su cuenta,
   * tendríamos dos cuentas que se pueden separar — que es el modo de falla que todo
   * esto vino a matar.
   *
   * Las que el disco NO tiene también salen, marcadas con `falta`. Esconderlas es
   * peor: el editor sabe que agregó ese archivo y no lo vería en la lista, así que
   * buscaría por qué en el lugar equivocado. Elegirla deja la mención con el mismo
   * aviso de siempre.
   */
  function candidatos(inventario, consulta) {
    var q = plegar(consulta);
    var inv = inventario || [];
    var out = [];
    inv.forEach(function (it) {
      var nombre = String(it.nombre || "");
      if (!nombre) return;
      if (q && plegar(nombre).indexOf(q) === -1) return;
      var e = etiqueta({ scope: it.scope, nombre: nombre }, inv);
      out.push({
        scope: it.scope,
        nombre: nombre,
        falta: !!it.falta,
        tipo: e.tipo,
        src: it.src || "",
        numero: e.numero,
        etiqueta: e.texto,
        rotulo: rotulo(it.scope),
        token: escribir(it.scope, nombre)
      });
    });
    return out;
  }

  /**
   * Qué menciones del texto no van a poder apuntar a nada, contra el inventario
   * que el panel tiene delante.
   *
   * `inventario` = [{ scope, nombre, falta }] — las tres listas concatenadas en el
   * orden en que le llegan al modelo (marcador → curso → clase), con `falta` en
   * las que el manifiesto nombra y el disco no tiene.
   *
   * Devuelve [{ nombre, motivo }] con los tres motivos que el motor también conoce
   * (`colgada`, `sin-disco`, `ambigua`) más uno que es sólo del panel
   * (`sin-numero`: el número que el editor escribió en un chip y que no apunta a
   * nada). Y por el mismo criterio: ninguno frena nada, todos se dicen. Es una
   * función pura para poder fijarla por test sin montar el panel.
   */
  function revisar(texto, inventario) {
    var inv = inventario || [];
    var out = [];
    var vistos = {};
    encontrar(texto).forEach(function (men) {
      if (vistos[men.raw]) return;
      vistos[men.raw] = true;
      var candidatos = inv.filter(function (it) {
        return mismoNombre(it.nombre, men.nombre) && (!men.scope || it.scope === men.scope);
      });
      if (!candidatos.length) {
        // El número que no apunta a nada se dice APARTE de la colgada: las dos están
        // en rojo porque las dos no apuntan a nada, pero una se arregla volviendo a
        // adjuntar el archivo y la otra escribiendo otro número. Un aviso que dijera
        // «volvé a adjuntar «Imagen_7»» mandaría a buscar un archivo que no existe.
        var suelto = numeroSuelto(men);
        if (suelto) {
          out.push({
            nombre: men.nombre, scope: "", motivo: "sin-numero",
            tipo: suelto.tipo, numero: suelto.numero,
            // Cuántas hay, que es la mitad del aviso: el editor escribió 7 porque
            // creía que había siete.
            de: (suelto.tipo === "documento" ? documentos(inv) : imagenes(inv)).length
          });
          return;
        }
        out.push({ nombre: men.nombre, scope: men.scope, motivo: "colgada" });
        return;
      }
      if (!men.scope && candidatos.length > 1) {
        out.push({ nombre: men.nombre, scope: "", motivo: "ambigua", eligio: candidatos[0].scope });
      }
      if (candidatos[0].falta) {
        out.push({ nombre: men.nombre, scope: candidatos[0].scope, motivo: "sin-disco" });
      }
    });
    return out;
  }

  // `revisar` y `estadoDe` contestan lo mismo con distinta forma, y se comprueba por
  // test sobre el mismo inventario: si se separaran, el color del campo diría una
  // cosa y el renglón de abajo otra.

  /**
   * QUÉ LE PASA a una mención, redactado. Devuelve `{ corto, largo }`.
   *
   * Los dos dicen lo MISMO y se leen en dos lugares:
   *
   *  · `corto` es lo que va después de «Mencionás » en el renglón de abajo del
   *    campo. No nombra la referencia porque ese renglón AGRUPA —«Mencionás
   *    «logo.svg» y «fondo.png» ya no están en la lista: …»— y los nombres los
   *    pone el que arma la frase, con las dos juntas y una sola vez.
   *  · `largo` es la frase completa del globo del chip, que habla de UNA mención
   *    (la que tenés debajo del cursor, ya nombrada por el propio chip) y en
   *    cambio tiene que decir cómo se arregla, porque ahí se arregla.
   *
   * ── Por qué existe ───────────────────────────────────────────────────
   *
   * Porque el mismo diagnóstico estaba redactado en TRES lugares: el globo del
   * chip (cep/js/campo.js), este renglón, y el ⬇ Log del motor
   * (bridge/prompt/menciones.js). Y ya habían divergido: acá quedó un ternario
   * MUERTO cuyas dos ramas decían lo mismo, cicatriz de haber copiado el bloque
   * del chip —donde sí decían cosas distintas, «hay 3 documentos» contra «hay 3
   * imágenes»— y haberlo editado de un lado nomás. O sea que el chip decía «hay 3
   * imágenes» y el renglón dos centímetros más abajo decía «hay 3».
   *
   * El tercero, el del motor, SIGUE APARTE, y no por olvido: es Node y esto son
   * globales de navegador sin build, así que compartir la redacción pide que
   * HPMenciones dependa de que Node esté en el panel (el `require` del bridge que
   * ya resuelve cep/js/engine-client.js). Eso mueve etiquetas `<script>` y se
   * decidió dejarlo para después de publicar. Lo que el motor dice además es de
   * él: habla de «la instrucción» porque en el Log no hay campo que mirar, y no
   * conoce `sin-numero` —el motor resuelve por NOMBRE, así que un número que no
   * existe es una pregunta que sólo el panel se hace—.
   *
   * `plural` es para que el renglón pueda decir «ya no están» cuando agrupa
   * varias: aparece arriba de un campo que se está escribiendo, y «1 mención(es)»
   * se lee como un error del panel.
   */
  function explicar(problema, plural) {
    var p = problema || {};
    if (p.motivo === "colgada") {
      return {
        corto: (plural ? "ya no están" : "ya no está") +
          " en la lista: el modelo va a leer que falta, no otra imagen en su lugar",
        largo: "esta referencia ya no está adjunta al pedido: el modelo va a leer que falta, " +
          "no otra imagen en su lugar. Volvé a adjuntarla o borrá la mención."
      };
    }
    if (p.motivo === "sin-numero") {
      // CUÁNTAS HAY es la mitad del aviso: el editor escribió 7 porque creía que
      // había siete, así que lo que le falta saber es hasta dónde llega el número.
      // Y dice de qué —imágenes o documentos— porque son dos cuentas distintas:
      // los documentos no entran en la numeración de las imágenes.
      var hay = p.de
        ? "hay " + p.de + " " + (p.tipo === "documento" ? "documentos" : "imágenes") +
          ", así que el número va de 1 a " + p.de
        : "todavía no hay ninguna referencia";
      return {
        // Acá sí se nombra sola, y con el número: una mención que no apunta a nada
        // no tiene nombre que poner adelante, tiene el número que se escribió mal.
        corto: (p.tipo === "documento" ? "el documento " : "la imagen ") + p.numero +
          " y en este pedido " + hay + ". El modelo va a leer que falta, no otra en su lugar",
        largo: "escribiste " + p.numero + " y en este pedido " + hay +
          ". Como está, el modelo va a leer que esa referencia falta, no otra en su lugar. " +
          "Doble clic para corregir el número."
      };
    }
    if (p.motivo === "sin-disco") {
      return {
        corto: (plural ? "no se pueden leer" : "no se puede leer") +
          " del disco, así que no viaja ni ocupa número",
        largo: "el archivo no está en el disco, así que no viaja ni ocupa número " +
          "(si el proyecto está en un disco externo, revisá que esté montado)."
      };
    }
    if (p.motivo === "ambigua") {
      // Cuál se eligió se nombra SÓLO si el que pregunta lo sabe. El renglón lo
      // sabe —`revisar` le pone `eligio`— y el globo del chip no: la etiqueta de un
      // chip no dice contra qué candidato se resolvió, y hacérsela decir es
      // cambiarle el contrato a `etiqueta`, que está fijado por unas treinta
      // aserciones y ese pinneo es bueno. Los dos dicen el mismo hecho; el que sabe
      // más, además, dice cuál.
      var cual = p.eligio ? ": va la de " + (AMBITOS[p.eligio] || "?") : "";
      return {
        corto: "está en dos niveles y la mención no dice de cuál" + cual,
        largo: "el nombre está en dos niveles y la mención no dice de cuál" + cual + "."
      };
    }
    return { corto: "", largo: "" };
  }

  /**
   * El renglón que se le muestra al editor.
   *
   * Devuelve `{ texto, clase }`, o null si no hay nada que decir.
   */
  function renglon(problemas) {
    var p = problemas || [];
    if (!p.length) return null;
    var colgadas = p.filter(function (x) { return x.motivo === "colgada"; });
    var sinNumero = p.filter(function (x) { return x.motivo === "sin-numero"; });
    var sinDisco = p.filter(function (x) { return x.motivo === "sin-disco"; });
    var ambiguas = p.filter(function (x) { return x.motivo === "ambigua"; });
    // Cada grupo se redacta UNA vez, con los nombres adelante y el diagnóstico —el
    // mismo que dice el globo del chip— detrás (ver `explicar`).
    var partes = [];
    if (colgadas.length) {
      partes.push(nombres(colgadas) + " " + explicar(colgadas[0], colgadas.length > 1).corto);
    }
    // El número que no existe no lleva nombres adelante: lo que se escribió mal ES
    // el número, así que `explicar` lo nombra solo y va uno por mención.
    sinNumero.forEach(function (x) { partes.push(explicar(x).corto); });
    if (sinDisco.length) {
      partes.push(nombres(sinDisco) + " " + explicar(sinDisco[0], sinDisco.length > 1).corto);
    }
    if (ambiguas.length) {
      partes.push(nombres(ambiguas) + " " + explicar(ambiguas[0]).corto);
    }
    return {
      texto: "Mencionás " + partes.join(". Y mencionás ") + ".",
      // Rojo cuando algo NO APUNTA A NADA —una colgada o un número que no existe—,
      // que son los dos casos sin arreglo automático. Ámbar para lo que va a llegar
      // distinto de lo que el editor cree.
      clase: (colgadas.length || sinNumero.length) ? "is-error" : "is-warn"
    };
  }

  function nombres(lista) {
    return lista.map(function (x) { return "«" + x.nombre + "»"; }).join(" y ");
  }

  // Acá vivía `renglonSinNumero`, el renglón que se decía UNA VEZ cuando el doble
  // clic pedía un número que no existía, porque entonces el chip se deshacía y no
  // quedaba nada en el texto que contara lo que había pasado. Se fue cuando el estado
  // inválido pasó a ser representable: el token `@[Imagen_7]` queda escrito, así que
  // lo dice el renglón de siempre (`revisar` + `renglon`, el mismo que las colgadas)
  // y lo sigue diciendo después de cambiar de pestaña y volver. Un aviso transitorio
  // para un estado permanente era la mitad del problema que el editor señaló.

  /**
   * Recuerda dónde quedó el cursor de un campo.
   *
   * Hace falta y no es un detalle: el editor pidió que la referencia quede escrita
   * "donde se tiene seleccionado el cabezal de escritura", y para insertarla hay
   * que tocar un botón o una miniatura — o sea, sacarle el foco al campo. Cuando
   * el clic llega, `selectionStart` ya no dice nada útil.
   *
   * Lo que sí dice la verdad es el momento del `blur`: ahí el campo todavía tiene
   * su cursor donde el editor lo dejó. Así que se guarda ahí, y también al soltar
   * una tecla o el mouse adentro del campo, que es cuando se mueve.
   */
  function seguirCursor(ta) {
    if (!ta || !ta.addEventListener) return;
    var anotar = function () {
      ta._hpCursor = { desde: ta.selectionStart || 0, hasta: ta.selectionEnd || 0 };
    };
    ["blur", "keyup", "mouseup", "select", "input"].forEach(function (ev) {
      ta.addEventListener(ev, anotar);
    });
  }

  // "imagen 2" escrito a mano: singular, con o sin acento, y el número pegado.
  //
  // SOLO EL SINGULAR, y no es un olvido. Con el plural ("las imágenes 1 y 2") habría
  // que reescribir la lista entera, y reemplazar el primer número dejaría
  // «las @[marcador/a.png] y 2» — peor que no tocar nada. Lo mismo con un singular
  // que enumera ("imagen 1 y 2"), y para eso está la guarda de `canonizar`.
  var RE_PLANA = /\bim[áa]gen\s+(\d{1,3})\b/gi;

  /**
   * Convierte las referencias escritas a mano en MENCIONES: "imagen 2" pasa a ser
   * `@[curso/logo.svg]`, la que de verdad es la 2 de este pedido.
   *
   * ── Por qué esto lo hace el panel y no el modelo ────────────────────
   *
   * El editor lo pidió sobre el botón ✨: "si escribo o dicto «Imagen 1» […] este
   * debería entonces arreglar el formato […] al que referencia como tal". Se podría
   * pedirle al refinador que lo haga, y sería un error: el orden del pedido
   * —marcador → curso → clase, salteando lo que no viaja— lo conoce el panel
   * EXACTAMENTE, y el modelo tendría que adivinarlo. Si adivina mal, la mención
   * apunta a otra imagen y el gráfico sale distinto sin que nada falle, que es el
   * modo de falla que todo este mecanismo vino a matar. El modelo sigue haciendo lo
   * suyo (ordenar y aclarar el pedido); el mapeo lo hace quien lo sabe.
   *
   * ── Por qué solo al refinar ─────────────────────────────────────────
   *
   * Al MANDAR no se toca: una instrucción vieja que dice "como en la imagen 2" viaja
   * tal cual, y eso está fijado por test. Reescribirle el texto al editor a espaldas
   * suyas, en el camino que gasta tokens, es lo que no se puede hacer. Acá es al
   * revés: apretó un botón que dice que le arregle el texto, el cambio queda a la
   * vista en el campo y el "↩" lo devuelve carácter por carácter.
   *
   * `inventario` es el mismo que mira el aviso: [{ scope, nombre, falta }] en el
   * orden en que le llegan al modelo. El número cuenta solo las IMÁGENES que
   * VIAJAN —los documentos no se numeran y una que el disco no tiene no ocupa
   * lugar—, que es la misma cuenta que hace el motor.
   *
   * Devuelve `{ texto, cambios: [{ de, a }], sinApuntar: [n] }`. Si un "imagen 5" no
   * tiene a qué apuntar porque solo viajan tres, NO se inventa nada: queda como
   * estaba y se dice.
   */
  function canonizar(texto, inventario) {
    var t = String(texto == null ? "" : texto);
    var cambios = [];
    var sinApuntar = [];
    if (!t) return { texto: t, cambios: cambios, sinApuntar: sinApuntar };

    // La MISMA lista con la que el chip se pone su número (`etiqueta`), y no una
    // cuenta paralela: si se separaran, el ✨ convertiría un "imagen 2" escrito a
    // mano en una mención y el chip que aparece en su lugar diría otro número.
    var viajan = imagenes(inventario);

    /** Canoniza UN tramo de texto que no es una mención. */
    function tramo(s) {
      RE_PLANA.lastIndex = 0;
      return s.replace(RE_PLANA, function (crudo, num, pos, todo) {
        // Enumeración ("imagen 1 y 2", "imagen 1, 2", "imagen 1 y la 2"): reemplazar
        // solo el primer número dejaría el resto suelto y sin referencia, o sea peor
        // que no hacer nada. Se deja como está.
        var resto = todo.slice(pos + crudo.length);
        if (/^\s*(?:y|e|o|,|\/|-|and)\s+(?:la|el|las|los)?\s*\d/i.test(resto)) return crudo;
        if (/^\s*[,/-]\s*\d/.test(resto)) return crudo;
        var n = parseInt(num, 10);
        var it = viajan[n - 1];
        if (!it || !it.nombre) {
          if (sinApuntar.indexOf(n) === -1) sinApuntar.push(n);
          return crudo;
        }
        var token = escribir(it.scope, it.nombre);
        cambios.push({ de: crudo, a: token });
        return token;
      });
    }

    // Se recorre partiendo por las menciones que YA están: un nombre de archivo
    // puede decir "imagen 2.png", y reescribir adentro de una mención la rompería.
    var out = "";
    var ultimo = 0;
    RE.lastIndex = 0;
    var m;
    while ((m = RE.exec(t)) !== null) {
      out += tramo(t.slice(ultimo, m.index)) + m[0];
      ultimo = m.index + m[0].length;
    }
    out += tramo(t.slice(ultimo));
    return { texto: out, cambios: cambios, sinApuntar: sinApuntar };
  }

  /**
   * El renglón que se le dice al editor después de canonizar, o '' si no hubo nada
   * que decir. Va pegado al "Refinado con X en Y s" de la barra del micrófono.
   */
  function notaDeCanonizar(r) {
    var partes = [];
    if (r && r.cambios && r.cambios.length) {
      var vistos = {};
      var nombres = [];
      r.cambios.forEach(function (c) {
        if (vistos[c.de.toLowerCase()]) return;
        vistos[c.de.toLowerCase()] = true;
        nombres.push("«" + c.de + "»");
      });
      partes.push(nombres.join(" y ") + (nombres.length > 1 ? " ahora nombran" : " ahora nombra") +
        " el archivo");
    }
    if (r && r.sinApuntar && r.sinApuntar.length) {
      partes.push("«imagen " + r.sinApuntar.join("» y «imagen ") + "» no apunta a ninguna de las " +
        "que viajan, así que quedó como estaba");
    }
    return partes.join(" · ");
  }

  /**
   * Escribe la mención en el campo, donde quedó el cursor, y deja el cursor
   * después. Devuelve el texto nuevo.
   *
   * Los espacios se cuidan a mano y no con un `trim` porque el editor escribe
   * alrededor: "poné el logo" + mención tiene que dar "poné el logo @[…]" y no
   * "poné el logo@[…]", y con el cursor en medio de una frase no se puede pegar
   * al carácter de la izquierda. Y si el campo nunca se tocó, la mención va al
   * FINAL: un textarea sin usar tiene el cursor en 0, así que "donde está el
   * cursor" pondría el token antes de todo lo que había escrito.
   *
   * Esta función NO sabe que el campo dejó de ser un `<textarea>`, y eso es la
   * prueba de que la fachada de `cep/js/campo.js` está completa: sigue hablando en
   * `value` / `selectionStart` / `setSelectionRange` sobre el TEXTO CANÓNICO, y el
   * campo se encarga de que esas coordenadas signifiquen lo mismo con chips adentro.
   * Si alguna vez hay que tocar acá para que los chips anden, lo que falta está
   * allá.
   */
  function insertar(ta, token, opts) {
    if (!ta) return "";
    var valor = String(ta.value || "");
    var o = opts || {};
    var cur = ta._hpCursor;
    var enFoco = (typeof document !== "undefined" && document && document.activeElement === ta);
    var pos, fin;
    if (enFoco) { pos = ta.selectionStart || 0; fin = ta.selectionEnd || pos; }
    else if (cur) { pos = cur.desde; fin = cur.hasta; }
    else { pos = valor.length; fin = pos; }
    if (pos > valor.length) { pos = valor.length; fin = pos; }
    var antes = valor.slice(0, pos);
    var despues = valor.slice(fin);
    var izq = (antes && !/\s$/.test(antes)) ? " " : "";
    var der = (despues && !/^[\s.,;:)]/.test(despues)) ? " " : "";
    var trozo = izq + token + der;
    ta.value = antes + trozo + despues;
    var cursor = (antes + izq + token).length;
    ta._hpCursor = { desde: cursor, hasta: cursor };
    try { ta.focus(); ta.setSelectionRange(cursor, cursor); } catch (e) {}
    if (typeof o.onChange === "function") o.onChange(ta.value);
    return ta.value;
  }

  global.HPMenciones = {
    escribir: escribir,
    partir: partir,
    encontrar: encontrar,
    revisar: revisar,
    estadoDe: estadoDe,
    // El número del chip, y su vuelta: la misma cuenta que hace el motor al mandar.
    imagenes: imagenes,
    documentos: documentos,
    etiqueta: etiqueta,
    porNumero: porNumero,
    // El número que el editor escribió y que no apunta a nada: cómo se guarda y cómo
    // se reconoce.
    numeroSuelto: numeroSuelto,
    escribirNumero: escribirNumero,
    // El menú del `@`: cuándo se abre, qué se filtra y con qué se nombra cada nivel.
    disparo: disparo,
    candidatos: candidatos,
    plegar: plegar,
    rotulo: rotulo,
    // Qué le pasa a una mención, redactado una sola vez para los dos lugares
    // donde se lee: el globo del chip y el renglón de abajo del campo.
    explicar: explicar,
    renglon: renglon,
    canonizar: canonizar,
    notaDeCanonizar: notaDeCanonizar,
    insertar: insertar,
    seguirCursor: seguirCursor,
    AMBITOS: AMBITOS
  };
})(typeof window !== "undefined" ? window : this);
