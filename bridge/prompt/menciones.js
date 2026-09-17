'use strict';

// Las MENCIONES de una referencia dentro de un texto del editor, y su traducción
// al número que el modelo ya entiende.
//
// ── El problema ──────────────────────────────────────────────────────
//
// El contrato con el modelo es viejo, está verificado de punta a punta y no se
// toca: con un pedido viajan N imágenes «NUMERADAS de 1 a N en ese orden», y
// cuando la instrucción dice "imagen 1" es exactamente ésa (ver build-context).
// El orden es marcador → curso → clase.
//
// Lo que estaba mal era del lado del editor, no del modelo: para escribir
// "imagen 2" había que CONTAR en la cabeza, y contar sobre tres listas que se
// concatenan y que cambian solas. Se agrega una captura al marcador y todas las
// del curso se corren un lugar; se borra una y se corren para el otro lado; una
// que el disco no tiene no viaja, así que no ocupa número. La instrucción escrita
// ayer queda apuntando a otra imagen y nada falla: el gráfico sale distinto.
//
// ── La decisión ──────────────────────────────────────────────────────
//
// El editor escribe (o el panel le inserta) una MENCIÓN con el nombre del
// archivo, y acá se traduce al número **en el momento de mandar**, contra la
// lista que de verdad va a viajar. El modelo recibe exactamente lo que ya
// entendía; el editor deja de contar.
//
//   @[curso/logo-platzi.svg]  →  imagen 2
//   @[marcador/captura 3.png] →  imagen 1
//   @[clase/manual.pdf]       →  el documento «manual.pdf»
//
// ── Por qué la mención se guarda así y no de otra forma ──────────────
//
// La instrucción es un STRING y viaja por seis lugares: el `localStorage` del
// panel, el payload del job, el `queue.json` del proyecto, el `.meta.json` de
// cada versión, la pestaña Corrections y el prompt. Cualquier forma que no sea
// texto plano —un array de tramos, un objeto con offsets— habría que enseñársela
// a los seis, y los seis ya guardan strings bien.
//
//  · Lleva el NOMBRE y no el número. Es lo único que sobrevive a que la lista se
//    reordene, que es el caso que hizo falta resolver.
//  · Lleva el ÁMBITO (marcador / curso / clase). Sin él, un `captura.png` del
//    marcador y otro del curso son la misma mención, y el desempate sería la
//    posición — o sea, el número otra vez.
//  · Va DELIMITADA con `@[…]`. Los nombres de archivo tienen espacios («Captura
//    de pantalla 2026-09-15.png» es lo que escribe macOS), así que un `@nombre`
//    a la Cursor no se puede parsear: no hay dónde termina.
//  · Y se LEE. Si un token queda sin traducir —una instrucción vieja, un panel
//    más viejo que el archivo, la fila de Corrections mostrando lo que se
//    escribió— lo que se ve es el nombre de un archivo, no un identificador
//    opaco. Un `[[ref:a3f9]]` en la pestaña Corrections seis meses después no le
//    dice nada a nadie.
//
// Lo que NO se toca: el texto que no es una mención. Una instrucción vieja que
// dice "como en la imagen 2" en texto plano sale igual que entró, y eso está
// fijado por test: acá no se busca "imagen N" para reescribirlo.
//
// ── Dónde vive la gramática ──────────────────────────────────────────
//
// Escribir el token y encontrarlo en un texto está también en `cep/js/menciones.js`,
// que es lo que el panel necesita para insertar la mención y para avisar antes de
// generar. Lo que NO está duplicado es esto: RESOLVER la mención contra lo que va
// a viajar, que se hace una sola vez y acá, porque el único que sabe qué imágenes
// llegaron al disco es el que arma la llamada. Que las dos gramáticas sigan
// diciendo lo mismo lo fija la sección 1 de `test/menciones-panel.test.js`, que
// corre las dos sobre el mismo corpus de lo normal, lo raro y lo roto: encontrar,
// escribir, partir, los tres ámbitos y la comparación de nombres.

// Un token: `@[` + hasta 200 caracteres que no sean corchete ni salto + `]`.
// El tope existe para que un `@[` suelto en un párrafo largo no se coma media
// instrucción buscando su cierre.
const RE_MENCION = /@\[([^[\]\n]{1,200})\]/g;

// Cómo se escribe cada ámbito en el token. En castellano y no en el vocabulario
// interno (`course`/`sequence`) porque esto lo lee el editor en su campo.
const AMBITOS = { marker: 'marcador', course: 'curso', sequence: 'clase' };
const AMBITOS_INV = { marcador: 'marker', curso: 'course', clase: 'sequence' };

/** El token de una referencia, tal como queda escrito en el campo. */
function escribir(scope, nombre) {
  const amb = AMBITOS[scope] || '';
  return '@[' + (amb ? amb + '/' : '') + String(nombre || '') + ']';
}

/**
 * Partir el cuerpo de un token en ámbito y nombre.
 *
 * Sin prefijo el ámbito queda vacío: es una mención escrita a mano, y se resuelve
 * buscando el nombre en los tres niveles (ver `resolver`). El separador es `/`
 * porque es el único carácter que un nombre de archivo no puede tener.
 */
function partir(cuerpo) {
  const txt = String(cuerpo || '').trim();
  const i = txt.indexOf('/');
  if (i === -1) return { scope: '', nombre: txt };
  const pref = txt.slice(0, i).trim().toLowerCase();
  if (!AMBITOS_INV[pref]) return { scope: '', nombre: txt };
  return { scope: AMBITOS_INV[pref], nombre: txt.slice(i + 1).trim() };
}

/** Las menciones de un texto, en orden, con su posición. */
function encontrar(texto) {
  const out = [];
  const t = String(texto == null ? '' : texto);
  RE_MENCION.lastIndex = 0;
  let m;
  while ((m = RE_MENCION.exec(t)) !== null) {
    const p = partir(m[1]);
    if (!p.nombre) continue;
    out.push({ raw: m[0], scope: p.scope, nombre: p.nombre, desde: m.index });
  }
  return out;
}

/**
 * El índice de lo que este pedido le manda al modelo, con el número que le toca a
 * cada imagen.
 *
 * `stills` son los adjuntos tal como van en el payload (data URL o ruta) y
 * `stillRefs` es su array paralelo `{ scope, name, use }`: de dónde salió cada
 * uno y si está marcada ✓ usar. Va paralelo y no adentro porque un still ES un
 * string y lo fue siempre; convertirlo en objeto obligaría a migrar el
 * `localStorage`, el `queue.json` de cada proyecto y los jobs a medio encolar.
 *
 * `viaja(still)` la pone quien llama, y es la clave de todo: el número de una
 * imagen es su posición entre las que DE VERDAD llegan, no entre las que el
 * manifiesto nombra. Una referencia en un disco desmontado no ocupa número (el
 * prompt dice "de 1 a N" contando las que viajan), así que traducir contra la
 * lista completa habría inventado un número que el modelo no tiene.
 */
function indice(o) {
  o = o || {};
  const stills = Array.isArray(o.stills) ? o.stills : [];
  const refs = Array.isArray(o.stillRefs) ? o.stillRefs : [];
  const viaja = typeof o.viaja === 'function' ? o.viaja : function () { return true; };
  const recursos = Array.isArray(o.resources) ? o.resources : [];

  const items = [];
  let numero = 0;
  let asset = 0;
  stills.forEach(function (s, i) {
    const r = refs[i] || {};
    const llega = !!viaja(s, i);
    const it = {
      kind: 'image',
      scope: String(r.scope || ''),
      nombre: String(r.name || ''),
      viaja: llega,
      numero: 0,
      asset: '',
    };
    if (llega) {
      it.numero = ++numero;
      // El nombre del archivo embebible sale de la misma cuenta que `saveAssets`:
      // las ✓ usar que viajan, en orden, numeradas desde 1. Se dice en la
      // traducción porque el bloque de assets lista los archivos y NO dice cuál es
      // cuál: con dos logos, "usá la imagen 3" dejaba al modelo eligiendo entre
      // `asset-01` y `asset-02`.
      if (r.use) it.asset = 'asset-' + String(++asset).padStart(2, '0');
    }
    items.push(it);
  });
  // Los nombres de los documentos salen todos juntos y no de a uno, porque para
  // saber si hace falta desempatar hay que ver la lista entera.
  //
  // Y van en un campo APARTE de `nombre`: `nombre` es con lo que se EMPAREJA una
  // mención (`@[curso/guia.pdf]` trae el nombre del archivo pelado), así que
  // meterle ahí el desempate dejaba colgadas a todas las menciones a documentos.
  // `comoSeDice` es con lo que se ESCRIBE en el prompt. Dos usos distintos que se
  // parecían lo suficiente como para confundirlos.
  const nombresDoc = nombresDeRecursos(recursos);
  recursos.forEach(function (r, i) {
    items.push({
      kind: 'doc',
      scope: String((r && r.scope) || ''),
      nombre: nombreDeRecurso(r),
      comoSeDice: nombresDoc[i],
      viaja: true,
      numero: 0,
      asset: '',
    });
  });
  return items;
}

/**
 * Con qué nombre se menciona un documento, y el orden NO es arbitrario: es el
 * mismo con el que `fuenteDeDocumento` (engine.js) lo nombra en el prompt.
 *
 * Los de los dos niveles generales YA son archivos del proyecto, así que vale el
 * nombre del archivo —el que se ve en la carpeta y el que la otra máquina también
 * ve—; el que el editor arrastró a un marcador es base64 y todavía no tiene
 * archivo, así que vale el nombre con el que lo soltó. Si la mención dijera una
 * cosa y el encabezado del documento en el prompt otra, el modelo tendría que
 * adivinar que son el mismo.
 */
function nombreDeRecurso(r) {
  if (typeof r === 'string') return ultimoTramo(r);
  if (r && typeof r.fileName === 'string' && r.fileName.trim()) return r.fileName.trim();
  if (r && typeof r.path === 'string' && r.path) return ultimoTramo(r.path);
  if (r && typeof r.name === 'string' && r.name.trim()) return r.name.trim();
  return '';
}

function ultimoTramo(p) {
  const partes = String(p || '').replace(/^file:\/\//, '').replace(/\\/g, '/').split('/');
  return partes[partes.length - 1] || '';
}

// Cómo se dice cada ámbito cuando hay que desempatar (ver `nombresDeRecursos`).
const DE_DONDE = { marker: 'de este marcador', course: 'del curso', sequence: 'de esta clase' };

/**
 * De qué nivel salió un documento.
 *
 * Lo dice el objeto cuando lo hay, pero los de los dos niveles generales llegan
 * acá como RUTAS peladas —el panel los resuelve a archivos antes de mandarlos—,
 * así que para ésos lo dice la carpeta, que es donde vive esa información:
 *
 *   …/HyperPremiere/_referencias/notas.md                → del curso
 *   …/HyperPremiere/clase-12-fotografia/_referencias/…   → de esta clase
 *
 * Sin esto el desempate caía en «(el 3º)», que es cierto y no le sirve a nadie:
 * el editor no piensa en el tercer documento, piensa en el del curso.
 */
function ambitoDe(r) {
  if (r && typeof r === 'object' && r.scope) return String(r.scope);
  const ruta = typeof r === 'string' ? r : String((r && r.path) || '');
  if (!ruta) return '';
  const partes = ruta.replace(/^file:\/\//, '').replace(/\\/g, '/').split('/');
  const i = partes.lastIndexOf('_referencias');
  if (i < 1) return '';
  // Lo que está justo arriba de `_referencias`: la carpeta del proyecto (curso)
  // o la de una clase (secuencia).
  return partes[i - 1] === 'HyperPremiere' ? 'course' : 'sequence';
}

/**
 * El nombre con el que viaja CADA documento, garantizando que no haya dos
 * iguales.
 *
 * Las imágenes no tienen este problema porque van numeradas de 1 a N; los
 * documentos se nombran, y dos archivos pueden llamarse igual sin que nada falle:
 * `guia.pdf` en el curso y `guia.pdf` en la clase son distintos y el modelo veía
 * dos encabezados idénticos y una mención que podía ser cualquiera de los dos.
 * Lo señaló el editor: «cada nombre debe ser único para que no se dañe la
 * claridad de los prompts».
 *
 * El desempate se agrega SÓLO cuando hay choque, y eso es a propósito: el caso
 * normal es un documento por nombre, y meterle el ámbito a todos sería ensuciar
 * el prompt de siempre para resolver el raro. Cuando hay choque se agrega de
 * dónde salió, que es lo que el editor ve en la tira y lo que los distingue.
 *
 * Devuelve un array paralelo a la lista. Lo usan las DOS puntas —el encabezado
 * del documento en el prompt y la traducción de la mención— porque si dijeran
 * cosas distintas el modelo tendría que adivinar que son el mismo, que es lo que
 * el comentario de `nombreDeRecurso` viene diciendo desde que existe.
 */
function nombresDeRecursos(lista) {
  const crudos = (Array.isArray(lista) ? lista : []).map(nombreDeRecurso);
  const cuantos = {};
  crudos.forEach((n) => {
    const k = String(n).toLowerCase();
    cuantos[k] = (cuantos[k] || 0) + 1;
  });
  return crudos.map((n, i) => {
    if (cuantos[String(n).toLowerCase()] < 2) return n;
    const r = (Array.isArray(lista) ? lista : [])[i];
    const de = DE_DONDE[ambitoDe(r)];
    // Sin ámbito conocido no se inventa: se desempata por posición, que es feo
    // pero cierto. Un nombre repetido sin nada que lo distinga es peor.
    return n + ' (' + (de || 'el ' + (i + 1) + '\u00ba') + ')';
  });
}

/** Comparación de nombres: sin distinguir mayúsculas, que es como se tipean. */
function mismoNombre(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

/**
 * Traduce las menciones de `texto` contra el índice de este pedido.
 *
 * Devuelve `{ texto, cambios, problemas }`. Los `problemas` son los tres casos
 * que el editor tiene que poder enterarse, y ninguno de los tres frena la
 * generación: se traduce lo mejor que se puede y se DICE. Frenar por una mención
 * mal escrita sería no poder generar por un typo; callarse sería mandarle al
 * modelo un número que apunta a otra imagen, que es el bug que esto vino a
 * matar.
 *
 *  · `colgada`  — el nombre no está en el pedido. La referencia se borró de la
 *    lista y la mención quedó escrita. Se traduce a su nombre entre comillas
 *    DICIENDO que ya no está adjunta: dejar el token crudo le mandaría al modelo
 *    un `@[…]` que no significa nada, y borrarlo dejaría la frase partida
 *    ("poné el arriba").
 *  · `sin-disco` — la referencia está en la lista y el archivo no está (el disco
 *    externo desmontado). Esa imagen NO ocupa número, así que no hay número que
 *    darle. Se dice, y el aviso de siempre (`stillsMissing` en engine.js) sigue
 *    saliendo por su cuenta: son dos avisos del mismo hecho y ninguno depende
 *    del otro.
 *  · `ambigua` — una mención SIN ámbito cuyo nombre está en dos niveles. Solo
 *    puede pasar escribiéndola a mano: el panel siempre escribe el ámbito. Se
 *    resuelve con el primero en el orden del pedido —que es el mismo orden que
 *    ve el modelo— y se dice cuál se eligió.
 */
function resolver(texto, items) {
  const t = String(texto == null ? '' : texto);
  const cambios = [];
  const problemas = [];
  const lista = Array.isArray(items) ? items : [];
  if (!t || t.indexOf('@[') === -1) return { texto: t, cambios: cambios, problemas: problemas };

  const nuevo = t.replace(RE_MENCION, function (raw, cuerpo) {
    const p = partir(cuerpo);
    if (!p.nombre) return raw;
    const candidatos = lista.filter(function (it) {
      return mismoNombre(it.nombre, p.nombre) && (!p.scope || it.scope === p.scope);
    });
    if (!candidatos.length) {
      problemas.push({ raw: raw, nombre: p.nombre, scope: p.scope, motivo: 'colgada' });
      return '«' + p.nombre + '» (referencia que ya no está adjunta a este pedido)';
    }
    if (!p.scope && candidatos.length > 1) {
      problemas.push({ raw: raw, nombre: p.nombre, scope: '', motivo: 'ambigua', eligio: candidatos[0].scope });
    }
    const it = candidatos[0];
    if (it.kind === 'doc') {
      // `comoSeDice` y no `nombre`: es el que desempata cuando dos documentos se
      // llaman igual, y es el MISMO que encabeza su bloque en el prompt.
      const dicho = it.comoSeDice || it.nombre;
      cambios.push({ raw: raw, nombre: it.nombre, en: 'el documento «' + dicho + '»' });
      return 'el documento «' + dicho + '»';
    }
    if (!it.viaja) {
      problemas.push({ raw: raw, nombre: it.nombre, scope: it.scope, motivo: 'sin-disco' });
      return '«' + it.nombre + '» (una imagen de referencia que no se pudo leer del disco)';
    }
    const en = 'imagen ' + it.numero + (it.asset ? ' (el archivo assets/' + it.asset + ')' : '');
    cambios.push({ raw: raw, nombre: it.nombre, numero: it.numero, en: en });
    return en;
  });

  return { texto: nuevo, cambios: cambios, problemas: problemas };
}

/**
 * El renglón del ⬇ Log: qué se tradujo y a qué. Es lo primero que se mira cuando
 * un recurso sale apuntando a la imagen equivocada, y por eso dice el par entero
 * (nombre → número) y no solo cuántas hubo.
 */
function nota(cambios) {
  if (!cambios || !cambios.length) return '';
  const vistos = {};
  const partes = [];
  cambios.forEach(function (c) {
    if (vistos[c.raw]) return;
    vistos[c.raw] = true;
    partes.push(c.nombre + ' → ' + c.en);
  });
  return partes.join(' · ');
}

/**
 * El aviso de los problemas, ya redactado, o '' si no hubo ninguno.
 *
 * Dice lo mismo que `HPMenciones.explicar` del lado del panel (el globo del chip
 * y el renglón de abajo del campo), y aun así está redactado APARTE. No es un
 * olvido, y vale la pena tener escrito el por qué:
 *
 *  · Esto es Node y eso son globales de navegador sin build. Compartir la
 *    redacción se puede —el footer IIFE de cep/js los hace `require`-ables y
 *    cep/js/engine-client.js ya resuelve el `require` del bridge desde el
 *    panel— pero eso mueve etiquetas `<script>` y hace que HPMenciones
 *    dependa de que Node esté en el panel. Queda para después de publicar.
 *  · Y además esta redacción NO es la misma: habla de «la instrucción» porque
 *    en el ⬇ Log no hay un campo que el editor esté mirando, y no conoce
 *    `sin-numero`, porque acá se resuelve por NOMBRE: un número que no existe
 *    es una pregunta que sólo se hace el panel, que es el que dibuja números.
 *
 * O sea que unificarlas no es copiar tres frases a un lugar: es decidir cuál de
 * las dos voces gana. Mientras estén separadas, lo que las mantiene diciendo el
 * mismo HECHO es `menciones-panel.test.js`, que corre las dos gramáticas sobre
 * el mismo corpus.
 */
function aviso(problemas) {
  if (!problemas || !problemas.length) return '';
  const partes = [];
  problemas.forEach(function (p) {
    if (p.motivo === 'colgada') {
      partes.push('la instrucción menciona «' + p.nombre + '» y esa referencia ya no está adjunta: ' +
        'el modelo va a leer que no está, no otra imagen en su lugar');
    } else if (p.motivo === 'sin-disco') {
      partes.push('la instrucción menciona «' + p.nombre + '» y ese archivo no se pudo leer del disco, ' +
        'así que no viaja ni ocupa número (si el proyecto está en un disco externo, revisá que esté montado)');
    } else if (p.motivo === 'ambigua') {
      partes.push('la instrucción menciona «' + p.nombre + '» sin decir de qué nivel es y hay más de una con ' +
        'ese nombre: usé la de ' + (AMBITOS[p.eligio] || p.eligio || '?') + ', que es la primera en llegarle al modelo');
    }
  });
  return partes.join('. ');
}

module.exports = {
  RE_MENCION, AMBITOS, escribir, partir, encontrar, indice, resolver, nota, aviso,
  nombresDeRecursos,
};
