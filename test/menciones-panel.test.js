'use strict';

// La mitad del PANEL de las menciones: escribirlas en el campo y avisar antes de
// generar.
//
// La resolución (mención → «imagen N») vive en el motor y está probada en
// `menciones.test.js`. Acá se prueban las dos cosas que el motor no puede hacer:
// insertar la mención donde está el cursor, y decirle al editor —mientras
// escribe, no cuando ya gastó la llamada— que una mención no apunta a nada.
//
// Y una tercera que es la más importante de las tres: que las DOS GRAMÁTICAS
// sigan diciendo lo mismo. La forma del token está escrita dos veces —una en
// Node (`bridge/prompt/menciones.js`) y otra en globales de navegador
// (`cep/js/menciones.js`)— porque el panel no tiene build ni módulos y no puede
// hacer `require`. Duplicar una gramática es exactamente cómo se llega a que el
// panel escriba un token que el motor no reconoce, así que las dos se corren
// sobre el mismo corpus y tienen que contestar igual.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, deepEq, has } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');
const motor = require('../bridge/prompt/menciones');

/** HPMenciones cargado solo, sin DOM: lo que se prueba son funciones. */
function cargarPanel() {
  const ctx = {
    console: console, String: String, Number: Number, Object: Object, Array: Array,
    document: undefined,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(CEP, 'menciones.js'), 'utf8'), ctx, { filename: 'menciones.js' });
  return ctx.HPMenciones;
}

const P = cargarPanel();

// ── 1. Las dos gramáticas dicen lo mismo ─────────────────────────────

// El corpus: lo normal, lo raro y lo roto. Cada uno tiene que partirse igual en
// los dos lados, o el panel escribiría (o marcaría) algo que el motor no ve.
const CORPUS = [
  'sin ninguna mención',
  'poné @[curso/logo.svg] arriba',
  '@[marcador/Captura de pantalla 2026-09-15 a la(s) 11.04.32.png] es la buena',
  'dos: @[curso/a.png] y @[clase/b.pdf]',
  'sin ámbito: @[suelta.png]',
  'ámbito inventado: @[proyecto/x.png]',
  'pegada al texto:@[curso/a.png]y sigue',
  'un corchete suelto @[ sin cerrar',
  'vacía @[] y nada',
  'con salto @[curso/\na.png]',
  'MAYÚSCULAS @[CURSO/A.PNG]',
  'como en la imagen 2, en texto plano',
  'tres seguidas @[curso/a.png]@[clase/b.png]@[marcador/c.png]',
  'anidada @[curso/[a].png]',
];

test('el panel y el motor encuentran las MISMAS menciones en el mismo texto', function () {
  CORPUS.forEach(function (t) {
    const a = P.encontrar(t).map(function (m) { return [m.scope, m.nombre, m.desde]; });
    const b = motor.encontrar(t).map(function (m) { return [m.scope, m.nombre, m.desde]; });
    deepEq(a, b, 'difieren sobre: ' + JSON.stringify(t));
  });
});

test('y las dos escriben el token igual', function () {
  [['marker', 'a b.png'], ['course', 'logo.svg'], ['sequence', 'x.pdf'], ['', 'sin-ambito.png']]
    .forEach(function (par) {
      eq(P.escribir(par[0], par[1]), motor.escribir(par[0], par[1]), par.join('/'));
    });
});

test('el ámbito se escribe en castellano en los dos lados, y son los tres mismos', function () {
  deepEq(P.AMBITOS, motor.AMBITOS,
    'si uno dijera "clase" y el otro "secuencia", el panel escribiría tokens que el motor deja colgados');
});

test('las dos PARTEN el cuerpo del token igual, también los prefijos raros', function () {
  // `partir` es la mitad de la gramática que `encontrar` no cubre: encontrar dice
  // DÓNDE está el token, partir dice qué parte es el ámbito y qué parte el nombre.
  // Un nombre de archivo con una barra adentro, o un prefijo que parece un ámbito y
  // no lo es, se parten distinto si las dos implementaciones no dicen lo mismo — y
  // el resultado no es un error: es una mención que el panel pinta en azul y el
  // motor deja colgada, o al revés.
  const cuerpos = [
    'curso/logo.svg', 'clase/b.pdf', 'marcador/c.png',
    'suelta.png',                    // sin ámbito: el nombre es todo
    'CURSO/A.PNG',                   // el ámbito no distingue mayúsculas
    ' curso / logo.svg ',            // con aire alrededor de las dos mitades
    'proyecto/x.png',                // un prefijo que no es ninguno de los tres
    'course/logo.svg',               // el vocabulario INTERNO no es el del token
    'curso/carpeta/a.png',           // varias barras: manda la primera
    'carpeta/sub/a.png',             // ídem, sin ámbito válido adelante
    'a/b',                           // prefijo de una letra
    '/logo.svg',                     // arranca con la barra
    'curso/',                        // ámbito sin nombre
    'curso',                         // ámbito sin barra: es un nombre
    '',
  ];
  cuerpos.forEach(function (c) {
    deepEq(P.partir(c), motor.partir(c), 'difieren sobre: ' + JSON.stringify(c));
  });

  // Y unos cuantos con la respuesta ESCRITA, no sólo «las dos coinciden»: dos
  // implementaciones pueden coincidir en estar mal, y este archivo entero se
  // apoya en comparar una contra la otra.
  deepEq(motor.partir('proyecto/x.png'), { scope: '', nombre: 'proyecto/x.png' },
    'un prefijo que no es ámbito NO se corta: queda como parte del nombre, y así la ' +
    'mención se ve colgada y se dice, en vez de apuntar a otra cosa en silencio');
  deepEq(motor.partir('course/logo.svg'), { scope: '', nombre: 'course/logo.svg' },
    'el token se escribe en castellano: el vocabulario interno no vale acá');
  deepEq(motor.partir('CURSO/A.PNG'), { scope: 'course', nombre: 'A.PNG' },
    'el ámbito no distingue mayúsculas; el nombre del archivo se conserva tal cual');
  deepEq(motor.partir('curso/carpeta/a.png'), { scope: 'course', nombre: 'carpeta/a.png' },
    'manda la primera barra: un archivo puede tener barras y un ámbito no');
  deepEq(motor.partir(' curso / logo.svg '), { scope: 'course', nombre: 'logo.svg' },
    'el aire se saca de las dos mitades');
});

test('el NOMBRE de una referencia se compara igual en los dos lados', function () {
  // Los dos lados comparan nombres sin distinguir mayúsculas, porque así se tipean,
  // y los dos lo hacen con su propia copia de `mismoNombre` que ninguno exporta. Así
  // que se mira por donde se ve: una mención escrita con otras mayúsculas tiene que
  // apuntar a la misma referencia en el panel (el chip y su número) y en el motor
  // (el texto que le llega al modelo).
  //
  // Si sólo uno distinguiera mayúsculas, el chip diría «imagen 1» en azul y el
  // modelo leería que esa referencia no está adjunta. Es la peor forma del bug: el
  // panel dice que está bien.
  const NOMBRE = 'Logo-Nova.SVG';
  const COMO_SE_TIPEA = '@[curso/logo-nova.svg]';

  const inv = [{ scope: 'course', nombre: NOMBRE, falta: false }];
  eq(P.revisar(COMO_SE_TIPEA, inv).length, 0, 'el panel no lo da por colgado');
  eq(P.etiqueta(P.encontrar(COMO_SE_TIPEA)[0], inv).numero, 1,
    'y le pone el número de la referencia que de verdad es');

  const idx = motor.indice({
    stills: ['datos:png'],
    stillRefs: [{ scope: 'course', name: NOMBRE }],
    resources: [],
  });
  const r = motor.resolver(COMO_SE_TIPEA, idx);
  eq(r.problemas.length, 0, 'y el motor tampoco');
  has(r.texto, 'imagen 1', 'lo traduce al mismo número que muestra el chip');
});

// ── 2. El aviso, mientras se escribe ─────────────────────────────────

const INVENTARIO = [
  { scope: 'marker', nombre: 'captura.png', falta: false },
  { scope: 'course', nombre: 'logo-platzi.svg', falta: false },
  { scope: 'course', nombre: 'manual.pdf', falta: false },
  { scope: 'sequence', nombre: 'paleta.png', falta: true },
];

test('lo que apunta a algo no genera ningún aviso', function () {
  eq(P.revisar('usá @[curso/logo-platzi.svg] con @[marcador/captura.png]', INVENTARIO).length, 0);
  eq(P.renglon([]), null, 'y sin problemas no hay renglón que dibujar');
});

test('una mención colgada se avisa, y se avisa en rojo', function () {
  const p = P.revisar('el logo de @[curso/no-existe.svg]', INVENTARIO);
  eq(p.length, 1);
  eq(p[0].motivo, 'colgada');
  const r = P.renglon(p);
  has(r.texto, '«no-existe.svg»');
  has(r.texto, 'ya no está', 'en singular: "1 mención(es)" se lee como un error del panel');
  eq(r.clase, 'is-error', 'es lo único que no se arregla solo');
});

test('una referencia que el disco no tiene se avisa en ámbar, no en rojo', function () {
  // Es el disco externo desmontado: la referencia está en la lista y el archivo
  // no. Se puede montar el disco y generar; la colgada, no.
  const p = P.revisar('la @[clase/paleta.png]', INVENTARIO);
  eq(p.length, 1);
  eq(p[0].motivo, 'sin-disco');
  const r = P.renglon(p);
  has(r.texto, 'no se puede leer');
  eq(r.clase, 'is-warn');
});

test('dos colgadas se nombran las dos, en plural', function () {
  const r = P.renglon(P.revisar('@[curso/a.png] y @[clase/b.png]', INVENTARIO));
  has(r.texto, '«a.png» y «b.png»');
  has(r.texto, 'ya no están');
});

test('la misma mención repetida se avisa una vez', function () {
  // Se escribe dos veces en la misma instrucción a propósito ("como en X … y en X
  // también"); avisar dos veces del mismo archivo es ruido.
  const p = P.revisar('@[curso/no.png] y otra vez @[curso/no.png]', INVENTARIO);
  eq(p.length, 1);
});

test('el aviso mira el MISMO inventario que le va a llegar al modelo', function () {
  // El del marcador primero, después el curso, después la clase. Si el panel
  // mirara solo el nivel de su propio bloque, una mención al logo del curso escrita
  // en un marcador se marcaría como colgada estando perfecta.
  eq(P.revisar('@[marcador/captura.png]', INVENTARIO).length, 0);
  eq(P.revisar('@[curso/manual.pdf]', INVENTARIO).length, 0);
});

test('el mismo nombre en dos niveles, mencionado sin nivel, se avisa como ambiguo', function () {
  const inv = [
    { scope: 'marker', nombre: 'x.png', falta: false },
    { scope: 'course', nombre: 'x.png', falta: false },
  ];
  const p = P.revisar('@[x.png]', inv);
  eq(p[0].motivo, 'ambigua');
  has(P.renglon(p).texto, 'está en dos niveles');
});

// ── 2.b La ETIQUETA con la que se muestra una mención ────────────────
//
// El editor pidió primero verlas de otro color y después que fueran cortas: «en vez
// de decir "@" y la ruta, que fuera "@Imagen_1"». La disyuntiva la eligió sabiendo
// el costo: el chip MUESTRA el número y GUARDA el nombre, porque el nombre es lo
// único que sobrevive a que la lista se reordene (ver la cabecera de
// bridge/prompt/menciones.js). O sea que el número es capa de presentación —y el
// texto guardado no cambió—, pero mientras se muestra tiene que ser EXACTO.
//
// Acá se fija la etiqueta. Que coincida con la que el motor va a usar al mandar se
// fija en `menciones-campo.test.js`, corriendo las dos cuentas sobre el mismo
// material; y lo que hacen los chips en un navegador de verdad se mide con
// `test/manual/panel-demo/medir-chips.js`.

test('una imagen se muestra con el número que le toca entre las que viajan', function () {
  eq(P.etiqueta(P.encontrar('@[marcador/captura.png]')[0], INVENTARIO).texto, '@Imagen_1');
  eq(P.etiqueta(P.encontrar('@[curso/logo-platzi.svg]')[0], INVENTARIO).texto, '@Imagen_2');
});

test('un documento se muestra como documento, y su número es del panel nomás', function () {
  // El motor NO numera los documentos: los nombra («el documento "manual.pdf"»).
  // Así que este `_1` no viaja a ninguna parte; sirve para que el chip sea corto y
  // para poder repuntarlo con el doble clic.
  const e = P.etiqueta(P.encontrar('@[curso/manual.pdf]')[0], INVENTARIO);
  eq(e.texto, '@Documento_1');
  eq(e.tipo, 'documento');
});

test('cuando no hay número, el chip muestra el NOMBRE del archivo', function () {
  // Es la regla que decide qué se lee cuando algo está roto, y no es un detalle: una
  // mención colgada no tiene a qué apuntar y una imagen que el disco no tiene no
  // ocupa número, así que un «@Imagen_?» no diría nada. El nombre sí: es el archivo
  // que hay que volver a adjuntar. Es el mismo criterio con el que el motor traduce
  // esos dos casos (pone el nombre entre comillas).
  const colgada = P.etiqueta(P.encontrar('@[curso/no-existe.svg]')[0], INVENTARIO);
  eq(colgada.texto, '@no-existe.svg');
  eq(colgada.estado, 'colgada');
  const sinDisco = P.etiqueta(P.encontrar('@[clase/paleta.png]')[0], INVENTARIO);
  eq(sinDisco.texto, '@paleta.png');
  eq(sinDisco.estado, 'sin-disco');
});

test('los tres estados rotos llegan al chip, no sólo al renglón de abajo', function () {
  // El editor tiene que ver CUÁL de las tres menciones que escribió es la que no
  // apunta a nada, ahí mismo donde la escribió.
  eq(P.etiqueta(P.encontrar('@[curso/no-existe.png]')[0], INVENTARIO).estado, 'colgada');
  eq(P.etiqueta(P.encontrar('@[clase/paleta.png]')[0], INVENTARIO).estado, 'sin-disco');
  eq(P.etiqueta(P.encontrar('@[x.png]')[0], [
    { scope: 'marker', nombre: 'x.png', falta: false },
    { scope: 'course', nombre: 'x.png', falta: false },
  ]).estado, 'ambigua');
  eq(P.etiqueta(P.encontrar('@[curso/logo-platzi.svg]')[0], INVENTARIO).estado, '',
    'y la que apunta bien no lleva ninguna marca');
});

test('el chip y el renglón de abajo salen del MISMO juicio', function () {
  // Si se separaran, el campo diría una cosa y el aviso otra sobre la misma mención.
  [
    ['@[curso/no-existe.png]', 'colgada'],
    ['@[clase/paleta.png]', 'sin-disco'],
  ].forEach(function (par) {
    const men = P.encontrar(par[0])[0];
    eq(P.estadoDe(men, INVENTARIO), par[1], par[0]);
    eq(P.etiqueta(men, INVENTARIO).estado, par[1], par[0] + ' (el chip)');
    eq(P.revisar(par[0], INVENTARIO)[0].motivo, par[1], par[0] + ' (el aviso)');
  });
});

// ── 2.c El doble clic: qué referencia es HOY el número N ─────────────
//
// «Si doy doble clic debo poder modificar cómo está escrita, así puedo cambiar
// Imagen_1 por Imagen_2.» Es el punto donde el número se vuelve significado: el
// editor escribe un número y lo que se guarda es el NOMBRE de la referencia que en
// ese momento tiene ese número.

test('el doble clic resuelve el número contra la lista de AHORA', function () {
  eq(P.porNumero('imagen', 1, INVENTARIO).nombre, 'captura.png');
  eq(P.porNumero('imagen', 2, INVENTARIO).nombre, 'logo-platzi.svg');
  eq(P.porNumero('documento', 1, INVENTARIO).nombre, 'manual.pdf');
});

test('un número que no existe devuelve null: no se inventa ninguna referencia', function () {
  // Es el «7 con seis referencias». `porNumero` no elige por el editor: contesta que
  // no hay.
  [0, -1, 3, 7, 99, NaN, null].forEach(function (n) {
    eq(P.porNumero('imagen', n, INVENTARIO), null, 'imagen ' + n);
  });
});

test('y ese número se GUARDA: el chip queda en rojo, no se deshace', function () {
  // Esta prueba decía lo contrario —«el chip queda como estaba y se dice»— y el
  // editor la corrigió: *"si lo modifico a algo que no está, pues debería dejar de
  // aparecer azul ya que no está referenciando nada. O que aparezca rojo avisando
  // que no referencia a nada"*. Deshacerle lo que escribió es peor que mostrárselo
  // mal: lo deja creyendo que quedó el número anterior cuando quería el que tecleó.
  //
  // Así que el estado inválido es representable: se guarda el número, escrito como
  // una referencia que no existe, y el chip se pinta con el rojo que en este panel ya
  // quiere decir «no apunta a nada» (ver `numeroSuelto` en cep/js/menciones.js).
  eq(P.escribirNumero('imagen', 7), '@[Imagen_7]');
  const men = P.encontrar('@[Imagen_7]')[0];
  eq(P.estadoDe(men, INVENTARIO), 'sin-numero');
  const e = P.etiqueta(men, INVENTARIO);
  eq(e.texto, '@Imagen_7', 'muestra el 7, que es lo que escribió y lo que tiene que corregir');
  eq(e.numero, 7);
  eq(e.tipo, 'imagen', 'y de qué lista era, para poder corregirlo entre imágenes');

  // Y el renglón de abajo lo dice con palabras, diciendo cuántas hay: el editor
  // escribió 7 porque creía que había siete.
  const r = P.renglon(P.revisar('@[Imagen_7]', INVENTARIO));
  has(r.texto, 'la imagen 7');
  has(r.texto, 'hay 2');
  has(r.texto, 'de 1 a 2');
  eq(r.clase, 'is-error', 'rojo, igual que la colgada: las dos no apuntan a nada');
});

test('el número de una imagen no puede apuntar a un documento, ni al revés', function () {
  // Son dos listas distintas y el doble clic no cambia de clase: un `@Imagen_2` no
  // se puede volver un documento escribiéndole un número.
  eq(P.porNumero('imagen', 3, INVENTARIO), null, 'sólo viajan dos imágenes');
  eq(P.porNumero('documento', 2, INVENTARIO), null, 'y hay un solo documento');
});

test('una imagen que el disco no tiene no ocupa número, igual que en el motor', function () {
  // «paleta.png» está en el inventario con `falta`, así que no viaja y no cuenta.
  eq(P.imagenes(INVENTARIO).length, 2);
  eq(P.imagenes(INVENTARIO).map(function (it) { return it.nombre; }).join(),
    'captura.png,logo-platzi.svg');
  // Un documento que falta, en cambio, SÍ cuenta: se sigue nombrando igual.
  eq(P.documentos(INVENTARIO.concat([{ scope: 'course', nombre: 'x.pdf', falta: true }]))
    .map(function (it) { return it.nombre; }).join(), 'manual.pdf,x.pdf');
});

test('qué es imagen y qué documento lo DICE el inventario, no la extensión', function () {
  // Las tres listas que lo arman traen `tipo`, porque ahí se sabe sin adivinar. La
  // extensión queda como respaldo para un inventario escrito a mano (los de estos
  // tests) y para uno que venga de un panel más viejo.
  const raro = [
    { scope: 'marker', nombre: 'captura.pdf.png', falta: false, tipo: 'imagen' },
    { scope: 'marker', nombre: 'sin-extension', falta: false, tipo: 'documento' },
  ];
  eq(P.imagenes(raro).length, 1, 'el `.pdf` del medio no la saca de las imágenes');
  eq(P.documentos(raro)[0].nombre, 'sin-extension', 'y un documento sin extensión sigue siéndolo');
  // Sin `tipo`, la extensión decide (es lo que hacía la canonización desde antes).
  eq(P.imagenes([{ nombre: 'a.pdf' }, { nombre: 'b.png' }]).map(function (i) { return i.nombre; }).join(), 'b.png');
});

// ── 2.c CANONIZAR: "imagen 2" pasa a ser la mención del archivo ──────
//
// Lo pidió el editor sobre el botón ✨: "si escribo o dicto «Imagen 1» y le doy al
// botón «refinar», este debería entonces arreglar el formato […] al que referencia
// como tal". Lo hace el PANEL y no el modelo: el orden del pedido lo conoce el panel
// exactamente, y si el modelo lo adivinara mal cambiaría la imagen sin que nada falle.

// El inventario en el orden del pedido: dos del marcador, una del curso, un
// documento y una de la clase que el disco no tiene.
const INV_ORDEN = [
  { scope: 'marker', nombre: 'boceto.png', falta: false },
  { scope: 'marker', nombre: 'captura.png', falta: false },
  { scope: 'course', nombre: 'manual.png', falta: false },
  { scope: 'course', nombre: 'guia.pdf', falta: false },
  { scope: 'sequence', nombre: 'paleta.png', falta: true },
  { scope: 'sequence', nombre: 'encuadre.png', falta: false },
];

test('"imagen 2" pasa a ser la mención de la que de verdad es la 2', function () {
  const r = P.canonizar('Como en la imagen 2, con la paleta de la imagen 3.', INV_ORDEN);
  // El artículo de adelante NO se toca, y eso es lo correcto: la mención se traduce
  // de vuelta a "imagen N" al mandar, así que "la imagen 2" sale como "la imagen 3"
  // —con el número que de verdad le toca— y la frase sigue leyéndose igual.
  eq(r.texto, 'Como en la @[marcador/captura.png], con la paleta de la @[curso/manual.png].');
  eq(r.cambios.length, 2);
  eq(r.sinApuntar.length, 0);
});

test('el número cuenta solo las IMÁGENES que viajan', function () {
  // El documento no se numera y la que el disco no tiene no ocupa lugar: es la misma
  // cuenta que hace el motor al traducir.
  eq(P.canonizar('la imagen 4', INV_ORDEN).texto, 'la @[clase/encuadre.png]',
    'la 4 es la de la clase: el PDF no cuenta y la que falta tampoco');
});

test('mayúsculas, acento y "Imagen" con mayúscula inicial', function () {
  ['imagen 1', 'Imagen 1', 'IMAGEN 1', 'imágen 1'].forEach(function (t) {
    eq(P.canonizar('como en ' + t, INV_ORDEN).texto, 'como en @[marcador/boceto.png]', t);
  });
});

test('un "imagen 9" que no apunta a nada NO se inventa: queda y se dice', function () {
  const r = P.canonizar('poné la imagen 9 arriba', INV_ORDEN);
  eq(r.texto, 'poné la imagen 9 arriba', 'no se toca');
  eq(r.cambios.length, 0);
  eq(r.sinApuntar[0], 9);
  has(P.notaDeCanonizar(r), '«imagen 9» no apunta');
});

test('una enumeración no se toca: reemplazar el primer número dejaría el resto suelto', function () {
  // "las imágenes 1 y 2" en singular o plural: canonizar solo el primero daría
  // «@[marcador/boceto.png] y 2», que es peor que no hacer nada.
  ['imagen 1 y 2', 'imagen 1, 2', 'imagen 1 y la 2', 'imágenes 1 y 2'].forEach(function (t) {
    eq(P.canonizar('mirá ' + t, INV_ORDEN).texto, 'mirá ' + t, t);
  });
});

test('una mención que YA está no se toca, ni aunque su nombre diga "imagen 2"', function () {
  // Es el caso que rompería todo: reescribir POR DENTRO una mención que ya está.
  // El archivo se llama «imagen 2.png» —un nombre perfectamente normal— y hay una
  // segunda imagen, así que ese "imagen 2" de adentro del token SÍ tendría a qué
  // apuntar: sin la protección, la mención queda destruida (`@[marcador/@[…].png]`).
  const inv = [
    { scope: 'marker', nombre: 'imagen 2.png', falta: false },
    { scope: 'marker', nombre: 'otra.png', falta: false },
  ];
  const t = 'como en @[marcador/imagen 2.png], y también en la imagen 1';
  eq(P.canonizar(t, inv).texto, 'como en @[marcador/imagen 2.png], y también en la @[marcador/imagen 2.png]');
});

test('sin nada que canonizar el texto vuelve idéntico', function () {
  ['', 'un cartel con el título', '@[curso/manual.png] y nada más'].forEach(function (t) {
    const r = P.canonizar(t, INV_ORDEN);
    eq(r.texto, t, JSON.stringify(t));
    eq(r.cambios.length, 0);
    eq(P.notaDeCanonizar(r), '', 'y sin nota: no hay nada que decir');
  });
});

test('canonizar se aplica al REFINAR y nada más', function () {
  // Al mandar NO se toca: una instrucción vieja que dice "como en la imagen 2" viaja
  // tal cual, y eso está fijado en menciones.test.js. Reescribirle el texto al editor
  // a espaldas suyas en el camino que gasta tokens es lo que no se puede hacer; acá
  // apretó un botón que dice que le arregle el texto, y el "↩" lo devuelve.
  const dictado = fs.readFileSync(path.join(CEP, 'dictado.js'), 'utf8');
  has(dictado, 'function canonizado(texto)');
  // Se aplica en los DOS caminos que refinan: el ✨ y el dictado al parar.
  eq((dictado.match(/canonizado\(r\.texto\)/g) || []).length, 2,
    'el ✨ y el dictado, los dos');
  // Y el motor no canoniza nada: su regla sigue siendo no tocar el texto.
  const motorSrc = fs.readFileSync(
    path.join(__dirname, '..', 'bridge', 'prompt', 'menciones.js'), 'utf8');
  ok(motorSrc.indexOf('canonizar') === -1, 'el motor no canoniza: solo traduce menciones');
});

// ── 3. Insertar en el campo ──────────────────────────────────────────

/**
 * Un textarea de mentira con su cursor ya ANOTADO, que es la única forma en que
 * `insertar` lo puede saber: para tocar la miniatura hay que sacarle el foco al
 * campo, y ahí `selectionStart` ya no dice nada. Lo anota `seguirCursor` en el
 * `blur`; acá se escribe a mano lo que él habría dejado.
 */
function campo(valor, desde, hasta) {
  const ta = {
    value: valor,
    selectionStart: 0,
    selectionEnd: 0,
    focus: function () {},
    setSelectionRange: function (a, b) { this.selectionStart = a; this.selectionEnd = b; },
  };
  if (desde !== undefined) ta._hpCursor = { desde: desde, hasta: hasta === undefined ? desde : hasta };
  return ta;
}

test('la mención entra DONDE ESTÁ EL CURSOR y no al final', function () {
  // Es la mitad del pedido del editor: "debería poner el texto que lo referencia
  // donde se está escribiendo, o donde se tiene seleccionado el cabezal". Con el
  // token al final, apretar 📸 en medio de una frase la partía en dos ideas.
  const ta = campo('poné el logo  y el título arriba', 13);
  P.insertar(ta, '@[marcador/captura.png]');
  eq(ta.value, 'poné el logo @[marcador/captura.png] y el título arriba');
});

test('y el cursor queda DESPUÉS de la mención, para poder seguir escribiendo', function () {
  const ta = campo('antes  después', 6);
  P.insertar(ta, '@[curso/a.png]');
  eq(ta.value.slice(0, ta.selectionStart), 'antes @[curso/a.png]');
});

test('los espacios se cuidan a mano: ni pegada ni con dos', function () {
  const pegada = campo('el logo', 7);
  P.insertar(pegada, '@[curso/a.png]');
  eq(pegada.value, 'el logo @[curso/a.png]', 'un espacio a la izquierda, porque venía una palabra');

  const conEspacio = campo('el logo ', 8);
  P.insertar(conEspacio, '@[curso/a.png]');
  eq(conEspacio.value, 'el logo @[curso/a.png]', 'y no dos si ya había uno');

  const vacio = campo('', 0);
  P.insertar(vacio, '@[curso/a.png]');
  eq(vacio.value, '@[curso/a.png]', 'con el campo vacío no se agrega nada de más');
});

test('antes de un signo de puntuación no se mete un espacio', function () {
  const ta = campo('el logo, grande', 7);
  P.insertar(ta, '@[curso/a.png]');
  eq(ta.value, 'el logo @[curso/a.png], grande');
});

test('lo seleccionado se reemplaza', function () {
  const ta = campo('poné ESO arriba', 5, 8);
  P.insertar(ta, '@[curso/a.png]');
  eq(ta.value, 'poné @[curso/a.png] arriba');
});

test('un campo que nunca se tocó recibe la mención al FINAL, no al principio', function () {
  // Un textarea sin usar tiene el cursor en 0, así que "donde está el cursor"
  // pondría el token antes de todo lo que había escrito (lo que se recuperó del
  // `localStorage`, por ejemplo). Sin cursor anotado, va al final.
  const ta = campo('lo que venía escrito');
  P.insertar(ta, '@[curso/a.png]');
  eq(ta.value, 'lo que venía escrito @[curso/a.png]');
});

test('el cursor anotado se usa aunque el campo ya no tenga el foco', function () {
  // Es el caso REAL: el editor deja el cursor en medio de la frase, toca la
  // miniatura (el campo pierde el foco) y la mención tiene que caer donde estaba.
  const ta = campo('poné el logo y el título', 12);
  P.insertar(ta, '@[curso/a.png]');
  eq(ta.value, 'poné el logo @[curso/a.png] y el título');
});

test('un cursor anotado que quedó más allá del texto no rompe nada', function () {
  // El editor borró texto por otro camino (el ↩ del dictado, un refinado) y la
  // posición vieja quedó apuntando afuera. Se cae al final en vez de partir el
  // string en un índice que no existe.
  const ta = campo('corto', 400);
  P.insertar(ta, '@[curso/a.png]');
  eq(ta.value, 'corto @[curso/a.png]');
});

test('insertar avisa para que el que llama persista', function () {
  // Sin esto, una mención insertada se pierde al cambiar de pestaña: el `input` de
  // un textarea NO se dispara cuando el valor se pone por código.
  let guardado = null;
  const ta = campo('', 0);
  P.insertar(ta, '@[curso/a.png]', { onChange: function (t) { guardado = t; } });
  eq(guardado, '@[curso/a.png]');
});

// ── 4. Que el panel mande el array paralelo ──────────────────────────

test('el payload lleva quién es cada imagen, o no hay nada que traducir', function () {
  // `stillRefs` es lo único que deja resolver una mención: sin él, el motor tiene
  // una lista de strings y ningún nombre con el que emparejar. Se arma en los DOS
  // lugares donde se decide `stills` —al encolar y al rehidratar antes de correr—
  // y el segundo es el que manda.
  const main = fs.readFileSync(path.join(CEP, 'main.js'), 'utf8');
  has(main, 'stillRefs: HPStore.getMarkerStillRefs(markerKey).concat(gen.refs)',
    'main.js: al armar el pedido del marcador');
  const queue = fs.readFileSync(path.join(CEP, 'queue.js'), 'utf8');
  has(queue, 'dest.stillRefs = mkRefs.concat(gen.refs)',
    'queue.js: y otra vez justo antes de mandar, que es el último lugar donde `stills` se decide');
  // Y en el mismo orden que `stills`: si una lista se filtrara y la otra no, el
  // nombre de la imagen 2 quedaría pegado a la 3.
  ok(queue.indexOf('dest.stills = mkStills.concat(gen.images)') <
     queue.indexOf('dest.stillRefs = mkRefs.concat(gen.refs)'),
    'las dos salen del mismo par de listas, una al lado de la otra');
});

test('el 📤 de la caja de feedback filtra las dos listas de una sola pasada', function () {
  // Apagar una imagen a mano tiene que sacarla de `stills` Y de `stillRefs`.
  // Filtrarlas por separado dejaba el nombre de la imagen 2 pegado a la 3 en cuanto
  // una se caía, y ahí la mención apuntaba a otra imagen sin que nada fallara.
  const queue = fs.readFileSync(path.join(CEP, 'queue.js'), 'utf8');
  has(queue, 'mkStills.push(s);');
  has(queue, 'mkRefs.push(todosRefs[ix]');
});
