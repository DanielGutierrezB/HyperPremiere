'use strict';

// LAS MENCIONES: `@[curso/logo.svg]` en la instrucción → «imagen 2» en el prompt.
//
// Es la promesa nueva de la 1.6.0 y toca el camino más caro que tiene el
// proyecto: las referencias que le llegan al modelo, con su orden y su
// numeración, verificadas de punta a punta. Así que lo que se fija acá no es que
// "ande": es cada uno de los casos donde una traducción mal hecha le manda al
// modelo un número que apunta a OTRA imagen, que es exactamente el modo de falla
// mudo que este proyecto ya pagó tres veces.
//
// Lo que NO se toca y también se fija: el contrato del prompt (N imágenes
// numeradas de 1 a N, marcador → curso → clase) y las instrucciones viejas que
// dicen "como en la imagen 2" en texto plano.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq, deepEq, has } = require('./harness');
const men = require('../bridge/prompt/menciones');

/**
 * Un pedido de mentira: `stills` con su array paralelo de quién es cada una.
 * `viaja` contesta lo único que el panel no puede saber: si el archivo está.
 */
function pedido(refs, opts) {
  opts = opts || {};
  const noViajan = opts.noViajan || [];
  return men.indice({
    stills: refs.map((r, i) => 'ruta/' + i + '.png'),
    stillRefs: refs,
    resources: opts.docs || [],
    viaja: (s, i) => noViajan.indexOf(i) === -1,
  });
}

const CURSO = { scope: 'course', name: 'logo-platzi.svg', use: false };
const CLASE = { scope: 'sequence', name: 'paleta.png', use: false };
const MIA = { scope: 'marker', name: 'captura 3.png', use: false };

// ── 1. La traducción, y el orden del pedido ───────────────────────────

test('una mención se traduce al número que le toca en el pedido', function () {
  // El orden es el del pedido y no el de la pantalla: marcador → curso → clase.
  const idx = pedido([MIA, CURSO, CLASE]);
  eq(men.resolver('poné @[curso/logo-platzi.svg] arriba', idx).texto,
    'poné imagen 2 arriba');
  eq(men.resolver('la @[clase/paleta.png] manda', idx).texto, 'la imagen 3 manda');
  eq(men.resolver('mirá @[marcador/captura 3.png]', idx).texto, 'mirá imagen 1');
});

test('el nombre puede tener espacios, que es lo que escribe macOS', function () {
  // «Captura de pantalla 2026-09-15 a la(s) 11.04.32.png» es un nombre real. Por
  // eso la mención va DELIMITADA con @[…] y no como un @nombre a la Cursor: sin
  // cierre no hay dónde termina el nombre y empieza la frase.
  const nombre = 'Captura de pantalla 2026-09-15 a la(s) 11.04.32.png';
  const idx = pedido([{ scope: 'marker', name: nombre, use: false }]);
  eq(men.resolver('como en @[marcador/' + nombre + '], pero más chico', idx).texto,
    'como en imagen 1, pero más chico');
});

test('dos menciones en la misma frase, una del curso y otra de su clase', function () {
  // Es el caso que el editor pidió ver en la maqueta, y el que más se equivocaba a
  // mano: hay que contar dos listas concatenadas para saber que una es la 3 y la
  // otra la 4.
  const idx = pedido([MIA, MIA, CURSO, CLASE]);
  const r = men.resolver(
    'usá el logo de @[curso/logo-platzi.svg] con la paleta de @[clase/paleta.png]', idx);
  eq(r.texto, 'usá el logo de imagen 3 con la paleta de imagen 4');
  eq(r.problemas.length, 0);
});

test('la mención de una imagen ✓ usar dice además cuál es su archivo', function () {
  // El bloque de assets del prompt LISTA los archivos embebibles pero no dice cuál
  // es cuál: con dos logos, "usá la imagen 3" dejaba al modelo eligiendo entre
  // asset-01 y asset-02. La mención sabe exactamente cuál, así que lo dice.
  const idx = pedido([
    { scope: 'marker', name: 'fondo.png', use: false },
    { scope: 'course', name: 'logo.svg', use: true },
  ]);
  eq(men.resolver('incrustá @[curso/logo.svg] abajo', idx).texto,
    'incrustá imagen 2 (el archivo assets/asset-01) abajo');
});

// ── 2. Reordenar: el caso que define si esto sirve ────────────────────

test('agregar una imagen antes NO mueve la mención: sigue apuntando a la misma', function () {
  // Es el corazón del cambio. Escrita a mano, "imagen 1" apuntaba al logo del
  // curso; agregar una captura al marcador la convertía en la 2 y la instrucción
  // quedaba hablando de otra imagen, sin que nada fallara.
  const texto = 'el logo de @[curso/logo-platzi.svg], grande';
  eq(men.resolver(texto, pedido([CURSO])).texto, 'el logo de imagen 1, grande');
  eq(men.resolver(texto, pedido([MIA, CURSO])).texto, 'el logo de imagen 2, grande');
  eq(men.resolver(texto, pedido([MIA, MIA, MIA, CURSO])).texto, 'el logo de imagen 4, grande');
});

test('sacar una imagen de antes también la corre, y la mención la sigue', function () {
  const texto = 'sobre @[clase/paleta.png]';
  eq(men.resolver(texto, pedido([MIA, CURSO, CLASE])).texto, 'sobre imagen 3');
  eq(men.resolver(texto, pedido([CURSO, CLASE])).texto, 'sobre imagen 2');
  eq(men.resolver(texto, pedido([CLASE])).texto, 'sobre imagen 1');
});

test('dos referencias con el mismo nombre en niveles distintos no se confunden', function () {
  const idx = pedido([
    { scope: 'marker', name: 'captura.png', use: false },
    { scope: 'course', name: 'captura.png', use: false },
  ]);
  eq(men.resolver('@[marcador/captura.png]', idx).texto, 'imagen 1');
  eq(men.resolver('@[curso/captura.png]', idx).texto, 'imagen 2');
});

// ── 3. Los casos borde, uno por uno ──────────────────────────────────

test('una mención COLGADA se dice, y no se inventa otra imagen en su lugar', function () {
  // El editor menciona una referencia y después la borra de la lista. Lo que NO
  // puede pasar es que el número se lo quede la siguiente: sería el modelo
  // trabajando sobre la imagen equivocada sin que nada avise.
  const idx = pedido([MIA]);
  const r = men.resolver('poné el logo de @[curso/logo-platzi.svg] arriba', idx);
  has(r.texto, 'ya no está adjunta', 'el modelo lee que falta, no un número prestado');
  ok(r.texto.indexOf('imagen') === -1, 'y NINGÚN número: no hay ninguno que le corresponda');
  eq(r.problemas.length, 1);
  eq(r.problemas[0].motivo, 'colgada');
  eq(r.problemas[0].nombre, 'logo-platzi.svg');
  has(men.aviso(r.problemas), 'logo-platzi.svg', 'y el aviso la nombra');
});

test('la frase de alrededor no se rompe cuando la mención queda colgada', function () {
  // Borrar el token dejaría "poné el arriba". Se reemplaza por el nombre entre
  // comillas con su aclaración, que es lo único que se lee como una frase.
  const r = men.resolver('poné el @[curso/logo.svg] arriba a la derecha', pedido([]));
  has(r.texto, '«logo.svg»');
  has(r.texto, 'arriba a la derecha', 'lo que venía después sigue estando');
});

test('una referencia que el disco no tiene NO recibe número, y se dice', function () {
  // El disco externo desmontado. Esa imagen no viaja, así que no ocupa número: el
  // prompt promete "de 1 a N" contando las que llegan. Darle un número sería
  // nombrarle al modelo algo que no va a recibir.
  const idx = pedido([MIA, CURSO, CLASE], { noViajan: [1] });
  eq(men.resolver('@[clase/paleta.png]', idx).texto, 'imagen 2',
    'la de atrás sube de número, porque el modelo la va a ver segunda');
  const r = men.resolver('mirá @[curso/logo-platzi.svg]', idx);
  has(r.texto, 'no se pudo leer del disco');
  eq(r.problemas[0].motivo, 'sin-disco');
  has(men.aviso(r.problemas), 'disco externo', 'y el aviso dice qué revisar');
});

test('mencionar una imagen que no está no tapa el aviso de que falta', function () {
  // El aviso de siempre (`stillsMissing` en engine.js) sale por su cuenta y no
  // depende de esto: son dos avisos del mismo hecho, y el de la mención se suma.
  const idx = pedido([CURSO], { noViajan: [0] });
  const r = men.resolver('@[curso/logo-platzi.svg]', idx);
  eq(r.problemas.length, 1, 'la mención tiene su propio problema, aparte');
  eq(r.cambios.length, 0, 'y no cuenta como traducida: no hay número que anotar');
});

test('un DOCUMENTO mencionado se nombra como lo nombra el prompt, sin numerar', function () {
  // Los documentos no se numeran: los de texto se pegan en el prompt bajo su
  // nombre y los binarios llegan como archivo. Darles un número los mezclaría con
  // las imágenes y correría la numeración de todas.
  const idx = pedido([MIA], {
    docs: [{ scope: 'course', fileName: 'manual-de-marca.pdf', name: 'manual-de-marca.pdf' }],
  });
  eq(men.resolver('seguí @[curso/manual-de-marca.pdf]', idx).texto,
    'seguí el documento «manual-de-marca.pdf»');
  eq(men.resolver('la @[marcador/captura 3.png]', idx).texto, 'la imagen 1',
    'y el documento no le corrió el número a la imagen');
});

test('una mención sin nivel se resuelve por nombre, y la ambigüedad se dice', function () {
  // Escrita a mano: el panel siempre escribe el ámbito. Se elige la primera en el
  // orden del pedido —que es el mismo orden que ve el modelo— y se avisa cuál.
  const soloUna = pedido([MIA, CURSO]);
  eq(men.resolver('@[logo-platzi.svg]', soloUna).texto, 'imagen 2', 'sin ambigüedad, resuelve igual');

  const dos = pedido([
    { scope: 'marker', name: 'captura.png', use: false },
    { scope: 'course', name: 'captura.png', use: false },
  ]);
  const r = men.resolver('@[captura.png]', dos);
  eq(r.texto, 'imagen 1', 'la primera del pedido');
  eq(r.problemas[0].motivo, 'ambigua');
  has(men.aviso(r.problemas), 'marcador', 'y se dice cuál se eligió');
});

test('el nombre se compara sin distinguir mayúsculas, que es como se tipea', function () {
  const idx = pedido([{ scope: 'course', name: 'Logo-Platzi.SVG', use: false }]);
  eq(men.resolver('@[curso/logo-platzi.svg]', idx).texto, 'imagen 1');
});

// ── 4. Lo que ya estaba escrito sigue andando ────────────────────────

test('una instrucción vieja que dice "imagen 2" en texto plano sale igual', function () {
  // Es la promesa que sostiene todo lo demás: acá NO se busca "imagen N" para
  // reescribirlo. Un texto sin menciones vuelve idéntico, byte por byte.
  const idx = pedido([MIA, CURSO, CLASE]);
  const viejo = 'Un título como en la imagen 2, con la paleta de la imagen 3.\n' +
    'Ojo: la imagen 1 es solo referencia (no la incrustes).';
  const r = men.resolver(viejo, idx);
  eq(r.texto, viejo, 'sale exactamente como entró');
  eq(r.cambios.length, 0);
  eq(r.problemas.length, 0);
});

test('un texto sin ningún @[ no se toca ni se recorre', function () {
  const r = men.resolver('poné un cartel con el título de la clase', pedido([MIA]));
  eq(r.texto, 'poné un cartel con el título de la clase');
});

test('un corchete suelto no se come media instrucción', function () {
  // El tope de 200 caracteres del token existe para esto: un `@[` sin cierre en un
  // párrafo largo se queda como texto y no arrastra el resto.
  const texto = '@[ sin cerrar y después ' + 'x'.repeat(300) + ' final';
  eq(men.resolver(texto, pedido([MIA])).texto, texto);
});

test('un ámbito que no existe se trata como parte del nombre', function () {
  // `@[proyecto/logo.svg]` no es un ámbito nuestro: el nombre es todo eso, y como
  // no está en el pedido queda colgado y se dice. Inventarle un nivel sería
  // adivinar cuál de los tres quiso decir.
  const r = men.resolver('@[proyecto/logo.svg]', pedido([{ scope: 'course', name: 'logo.svg', use: false }]));
  eq(r.problemas[0].motivo, 'colgada');
  eq(r.problemas[0].nombre, 'proyecto/logo.svg');
});

// ── 5. Lo que se escribe, y lo que se lee ────────────────────────────

test('el token se escribe con el ámbito en castellano y el nombre entero', function () {
  eq(men.escribir('marker', 'captura 3.png'), '@[marcador/captura 3.png]');
  eq(men.escribir('course', 'logo.svg'), '@[curso/logo.svg]');
  eq(men.escribir('sequence', 'paleta.png'), '@[clase/paleta.png]');
});

test('lo que se escribe es lo que se lee: escribir y partir cierran el círculo', function () {
  [['marker', 'a b c.png'], ['course', 'logo-2.svg'], ['sequence', 'x.pdf']].forEach(function (par) {
    const t = men.escribir(par[0], par[1]);
    const p = men.partir(t.slice(2, -1));
    eq(p.scope, par[0], t);
    eq(p.nombre, par[1], t);
  });
});

test('el renglón del log dice el par entero, nombre → número', function () {
  // "Se tradujeron 3 menciones" no sirve para nada cuando un recurso sale
  // apuntando a la imagen equivocada: lo que hace falta es qué fue a qué.
  const idx = pedido([MIA, CURSO]);
  const r = men.resolver('@[marcador/captura 3.png] y @[curso/logo-platzi.svg]', idx);
  const nota = men.nota(r.cambios);
  has(nota, 'captura 3.png → imagen 1');
  has(nota, 'logo-platzi.svg → imagen 2');
});

test('sin menciones no hay renglón ni aviso: no se escribe ruido en el log', function () {
  eq(men.nota([]), '');
  eq(men.aviso([]), '');
});

// ── 6. El índice, que es de dónde sale todo ──────────────────────────

test('el índice numera SOLO lo que viaja, en el orden en que viaja', function () {
  const idx = pedido([MIA, CURSO, CLASE], { noViajan: [1] });
  deepEq(idx.map((i) => [i.scope, i.numero]),
    [['marker', 1], ['course', 0], ['sequence', 2]],
    'la que no viaja no gasta número');
});

test('los assets se numeran entre las ✓ usar que viajan, como los escribe el motor', function () {
  const idx = men.indice({
    stills: ['a', 'b', 'c', 'd'],
    stillRefs: [
      { scope: 'marker', name: 'a.png', use: true },
      { scope: 'marker', name: 'b.png', use: false },
      { scope: 'course', name: 'c.png', use: true },
      { scope: 'course', name: 'd.png', use: true },
    ],
    viaja: (s, i) => i !== 2,
  });
  deepEq(idx.map((i) => i.asset), ['asset-01', '', '', 'asset-02'],
    'la que no viaja tampoco se guarda como asset, así que no gasta lugar');
});

test('sin el array paralelo no se resuelve nada, y no se rompe nada', function () {
  // Es un job encolado por un panel anterior a la 1.6.0: no puede traer menciones
  // (no existían), pero si trajera una tiene que quedar colgada y dicha, no
  // traducida contra un índice vacío.
  const idx = men.indice({ stills: ['a', 'b'] });
  eq(idx.length, 2);
  eq(idx[0].nombre, '', 'sin nombre no hay con qué emparejar');
  eq(men.resolver('@[curso/logo.svg]', idx).problemas[0].motivo, 'colgada');
});

// ── 7. Y que la traducción LLEGUE al prompt de verdad ─────────────────
//
// Todo lo de arriba prueba la pieza. Esto prueba el cable: que el motor le pase a
// `buildUserPrompt` el texto TRADUCIDO y no el que escribió el editor. Es un
// cambio de una palabra en engine.js y no lo atrapa ninguno de los tests de
// arriba: la mención se traduce igual, se anota igual en el ⬇ Log, y lo único que
// pasa es que al modelo le llega un `@[curso/logo.svg]` que no significa nada
// para él. Se descubrió con `test/manual/mutaciones-render.js`, que fue lo único
// que lo vio.

const COMPOSICION = '<!DOCTYPE html><html><body>' +
  '<div id="stage" data-composition-id="marcador-1" data-start="0" data-width="1920" ' +
  'data-height="1080" data-duration="6" data-fps="30"></div>' +
  '<script>const tl = gsap.timeline({ paused: true }); window.__timelines["marcador-1"] = tl;</script>' +
  '</body></html>';

const PNG_1PX = 'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PROVEEDORES = ['claude-cli', 'cursor-cli', 'claude-api', 'openai-compat', 'ollama'];

/**
 * Corre `fn` con los cinco proveedores reemplazados por uno que anota lo que le
 * habrían mandado. Se restauran siempre: el `require.cache` es global y dejarlo
 * pisado le rompería el resto de la suite a cualquiera.
 */
async function conProveedorEspia(fn) {
  const previos = {};
  const visto = {};
  PROVEEDORES.forEach(function (id) {
    const ruta = require.resolve('../bridge/providers/' + id + '.js');
    previos[ruta] = require.cache[ruta];
    require.cache[ruta] = {
      exports: {
        generate: async function (arg) {
          if (!visto.arg) visto.arg = arg;
          return { text: COMPOSICION, usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
      loaded: true, id: ruta, filename: ruta, paths: [], children: [],
    };
  });
  try {
    await fn(visto);
  } finally {
    Object.keys(previos).forEach(function (ruta) {
      if (previos[ruta]) require.cache[ruta] = previos[ruta];
      else delete require.cache[ruta];
    });
  }
  return visto;
}

test('el prompt que sale del motor lleva la mención TRADUCIDA, no el token', async function () {
  // El HOME va a un temporal antes de cargar el motor: la config del modelo vive
  // en ~/.hyperpremiere y este test la escribe.
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-home-men-'));
  const prevHome = process.env.HOME;
  const prevUser = process.env.USERPROFILE;
  process.env.HOME = casa;
  process.env.USERPROFILE = casa;
  const engine = require('../bridge/engine.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-men-'));
  const proyecto = path.join(dir, 'Curso.prproj');
  try {
    engine.setConfig({ provider: 'ollama', model: 'falso' });
    const visto = await conProveedorEspia(function () {
      return engine.prepareGenerate({
        projectPath: proyecto, sequenceName: 'Clase 1',
        marker: { name: 'Marcador 1', start: 0, end: 6, duration: 6 },
        markerSlug: 'Marcador 1',
        instruction: 'Copiá la paleta de @[curso/manual.png] y el encuadre de @[marcador/captura.png].',
        transcript: [],
        stills: [PNG_1PX, PNG_1PX],
        stillRefs: [
          { scope: 'marker', name: 'captura.png', use: false },
          { scope: 'course', name: 'manual.png', use: false },
        ],
      }, function () {});
    });
    const up = String(visto.arg && visto.arg.userPrompt);
    ok(up.indexOf('@[') === -1, 'no puede quedar ni un token crudo en el prompt: ' + up.slice(0, 200));
    has(up, 'Copiá la paleta de imagen 2 y el encuadre de imagen 1.',
      'y los números tienen que ser los del pedido: el marcador va primero');
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUser;
  }
});

// ── Dos documentos que se llaman igual ───────────────────────────────
//
// Lo señaló el editor: «cada nombre debe ser único para que no se dañe la
// claridad de los prompts». Las imágenes no tienen el problema porque van
// numeradas de 1 a N; los documentos se NOMBRAN, y `guia.pdf` del curso y
// `guia.pdf` de la clase son dos archivos distintos que llegaban al modelo con
// el mismo nombre: dos encabezados idénticos y una mención que podía ser
// cualquiera de los dos.

test('dos documentos con el mismo nombre se desempatan por su ámbito', function () {
  const nombres = men.nombresDeRecursos([
    { scope: 'course', fileName: 'guia.pdf' },
    { scope: 'sequence', fileName: 'guia.pdf' },
  ]);
  eq(nombres[0], 'guia.pdf (del curso)');
  eq(nombres[1], 'guia.pdf (de esta clase)');
});

test('y el que no choca con nadie se queda con su nombre pelado', function () {
  // El desempate es para el caso raro: agregárselo a todos sería ensuciar el
  // prompt de siempre para resolver el que casi nunca pasa.
  const nombres = men.nombresDeRecursos([
    { scope: 'course', fileName: 'guia.pdf' },
    { scope: 'course', fileName: 'tipografias.md' },
  ]);
  eq(nombres[0], 'guia.pdf');
  eq(nombres[1], 'tipografias.md');
});

test('la mención sigue emparejando por el nombre del ARCHIVO, no por el desempatado', function () {
  // El desempate es para leer; emparejar sigue siendo por el nombre pelado, que
  // es lo que trae el token. Si se mezclaran, `@[curso/guia.pdf]` no encontraría
  // nada y saldría colgada: el editor vería rojo donde no hay ningún problema.
  const items = men.indice({
    stills: [], stillRefs: [],
    resources: [
      { scope: 'course', fileName: 'guia.pdf' },
      { scope: 'sequence', fileName: 'guia.pdf' },
    ],
  });
  eq(items[0].nombre, 'guia.pdf', 'empareja por el nombre real');
  eq(items[0].comoSeDice, 'guia.pdf (del curso)', 'y se dice con el desempate');

  const r = men.resolver('mirá @[curso/guia.pdf] y @[clase/guia.pdf]', items);
  has(r.texto, 'el documento «guia.pdf (del curso)»');
  has(r.texto, 'el documento «guia.pdf (de esta clase)»');
  ok(r.texto.indexOf('@[') === -1, 'ninguna quedó sin traducir');
});
