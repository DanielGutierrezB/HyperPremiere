'use strict';

// El refinador del dictado: la cadena de preferencia y la red que evita que un
// modelo chico le arruine la instrucción al editor.
//
// Los dos requisitos del editor —CONSERVAR todo lo que pidió y NO INVENTAR
// nada— se le piden al modelo en el prompt, pero eso es una intención, no una
// garantía: midiendo esto, `llama3` se comió dónde iba el título y agregó un
// "sin pérdida" que nadie había dicho. Así que lo que vuelve pasa por un
// control antes de llegar al campo, y ese control es lo que se prueba acá.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq, has } = require('./harness');
const refinar = require('../bridge/dictado-refinar');
const { getProvider } = require('../bridge/providers');

const FAKE_CLAUDE = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-claude.js');
// Los CLI de mentira son scripts con shebang: en Windows no arrancan solos.
const saltarEnWindows = process.platform === 'win32';

// Un dictado de verdad, con muletillas y una corrección en voz alta.
const DICTADO = 'eh, que el título entre desde la izquierda con un fade de medio segundo, ' +
  'y los keyframes tienen que ser suaves, o sea con easing, este… y que el logo quede ' +
  'abajo a la derecha todo el tiempo';

// --- 1. Lo que se le pide al modelo ------------------------------------------

test('las dos prohibiciones están en el prompt y en ese orden', function () {
  has(refinar.SISTEMA, 'NO INVENTES NADA', 'la primera, porque lo que agregue termina en el video');
  has(refinar.SISTEMA, 'NO PIERDAS NADA');
  ok(refinar.SISTEMA.indexOf('NO INVENTES') < refinar.SISTEMA.indexOf('NO PIERDAS'),
    'inventar es peor que perder: lo perdido se nota al leer, lo inventado no');
});

test('los términos técnicos se quedan en inglés', function () {
  has(refinar.SISTEMA, 'keyframe');
  has(refinar.SISTEMA, 'fotograma clave', 'nombrado como lo que NO hay que escribir');
});

test('lo escrito y lo dictado viajan marcados, para fundirse en una idea', function () {
  const p = refinar._armarPedido('y que el logo quede abajo', 'título en azul');
  has(p, 'YA ESTABA ESCRITO');
  has(p, 'ACABA DE DICTAR');
  has(p, 'UNA instrucción',
    'pegarlos sin marcar hace que el modelo lea el segundo como una corrección del primero');
});

test('con el campo vacío no se inventa un "ya estaba escrito" vacío', function () {
  const p = refinar._armarPedido('que entre con un fade', '');
  eq(p, 'DICTADO:\nque entre con un fade');
});

test('lo ESCRITO A MANO no se le presenta al modelo como una transcripción', function () {
  // El botón ✨ del panel. El manual arranca diciendo que lo que llega lo
  // transcribió Whisper "sin puntuación confiable, con muletillas", y eso sobre
  // un texto tecleado es una invitación a arreglar una puntuación que ya estaba
  // bien y a leer una palabra elegida a propósito como un error de Whisper.
  const p = refinar._armarPedido('El fondo transparente y el logo más chico.', '', 'escrito');
  has(p, 'ESCRITO A MANO');
  ok(p.indexOf('DICTADO:') === -1, 'no hay ningún dictado en este camino');
  has(p, 'no es una transcripción');
});

test('el manual del refinador viaja IDÉNTICO para los dos orígenes', function () {
  // Lo que cambia es el rótulo del pedido, que es una línea del mensaje de
  // usuario. `SISTEMA` no se toca: son ~1.500 caracteres que se leen de caché en
  // cada llamada, y una variante por origen sería pagar dos cachés distintas
  // para decir lo mismo (las dos prohibiciones valen igual en los dos casos).
  has(refinar.SISTEMA, 'NO INVENTES NADA');
  ok(refinar.SISTEMA.indexOf('ESCRITO A MANO') === -1,
    'el origen es un dato del pedido, no del manual');
});

// --- 2. La red: qué se deja pasar y qué no -----------------------------------

test('un refinado que se comió la mitad del pedido se rechaza', function () {
  // El caso medido con llama3: 45 palabras dictadas, volvieron 9.
  const r = refinar._verificar('El título entra con fade.', DICTADO);
  ok(!r.ok);
  has(r.motivo, 'se comió parte del pedido');
  has(r.motivo, 'palabras contra', 'con los dos números, que es lo que hace verificable el reclamo');
});

test('un refinado que triplica el dictado se rechaza: está inventando', function () {
  const inventado = DICTADO + ' ' + DICTADO + ' ' + DICTADO + ' y además con una paleta cálida ' +
    'y tipografía sans serif y un motion blur sutil en las entradas y salidas';
  const r = refinar._verificar(inventado, DICTADO);
  ok(!r.ok);
  has(r.motivo, 'le agregó detalles que no dijiste');
});

test('un refinado bien hecho pasa, aunque quede más corto', function () {
  // Sacar "eh", "o sea" y "este…" ACORTA: eso es refinar bien, no perder.
  const bueno = 'El título entra desde la izquierda con un fade de medio segundo, con easing ' +
    'suave en los keyframes. El logo queda abajo a la derecha durante toda la animación.';
  ok(refinar._verificar(bueno, DICTADO).ok);
});

test('un dictado de dos palabras no se mide por proporción', function () {
  // "más grande" refinado como "Agrandá el título" duplica el largo y está
  // perfecto. Debajo de ocho palabras la proporción no dice nada.
  ok(refinar._verificar('Agrandá el título.', 'más grande').ok);
  ok(refinar._verificar('Que el logo entre con un fade corto.', 'logo fade').ok);
});

test('un refinador que contesta en vez de refinar se rechaza', function () {
  ok(!refinar._verificar('No puedo ayudarte con eso.', DICTADO).ok);
  ok(!refinar._verificar('Lo siento, no entiendo qué querés que haga con este texto.', DICTADO).ok);
  eq(refinar._verificar('No puedo ayudarte con eso.', DICTADO).motivo,
    'el refinador contestó en vez de refinar');
});

test('un texto vacío nunca llega al campo', function () {
  ok(!refinar._verificar('', DICTADO).ok);
  ok(!refinar._verificar('   \n  ', DICTADO).ok);
});

test('"no" al principio de una instrucción real no la hace sospechosa', function () {
  ok(refinar._verificar('No uses fade: que entre con un corte seco desde la izquierda.', 'sin fade, corte seco').ok,
    'se mira "no puedo", no cualquier negación');
});

// --- 3. La limpieza del preámbulo --------------------------------------------

test('el "Aquí tienes la instrucción:" se saca en vez de rechazar el refinado', function () {
  eq(refinar._limpiar('Aquí tienes la instrucción:\nEl título entra con fade.'),
    'El título entra con fade.',
    'los modelos chicos lo ponen igual por más que se les pida que no');
  eq(refinar._limpiar('Instrucción de diseño: El logo abajo a la derecha.'),
    'El logo abajo a la derecha.');
});

test('el modelo que piensa en voz alta no deja el pensamiento en el campo', function () {
  eq(refinar._limpiar('<think>El usuario quiere un fade…</think>\nEl título entra con fade.'),
    'El título entra con fade.');
});

test('las comillas de afuera se sacan; las del texto en pantalla NO', function () {
  eq(refinar._limpiar('"El título entra con fade."'), 'El título entra con fade.');
  eq(refinar._limpiar('Un título que diga "Configuración inicial" abajo a la izquierda.'),
    'Un título que diga "Configuración inicial" abajo a la izquierda.',
    'esas comillas son el texto que va en pantalla: sacarlas cambia el pedido');
});

// --- 4. Qué modelo local se elige --------------------------------------------

test('entre los instalados se elige uno chico que siga instrucciones', function () {
  eq(refinar._elegirModeloOllama([
    { name: 'qwen3:32b', size: 20e9 },
    { name: 'llama3.2:3b', size: 2e9 },
    { name: 'nomic-embed-text:latest', size: 3e8 },
  ]), 'llama3.2:3b');
});

test('la familia manda sobre la etiqueta: 3b o latest sirven igual', function () {
  eq(refinar._elegirModeloOllama([{ name: 'llama3.2:latest', size: 2e9 }]), 'llama3.2:latest');
});

test('los de embeddings no se eligen: no contestan texto', function () {
  eq(refinar._elegirModeloOllama([
    { name: 'nomic-embed-text:latest', size: 3e8 },
    { name: 'bge-m3:latest', size: 1e9 },
  ]), null);
});

test('un modelo enorme es peor que no refinar', function () {
  // Medido acá: gemma4:31b tardó 103 s en refinar cuatro frases. El editor
  // suelta el botón y espera un minuto y medio mirando el campo.
  eq(refinar._elegirModeloOllama([{ name: 'gemma4:31b', size: 20e9 }]), null);
});

test('sin nada instalado no se inventa un modelo', function () {
  eq(refinar._elegirModeloOllama([]), null);
  eq(refinar._elegirModeloOllama(null), null);
});

// --- 5. La cadena, y que nunca deje al editor sin su dictado -----------------

// --- 5 bis. Quién refina: primero el proveedor que el editor eligió ---------
//
// La regla vieja era una cadena fija que nunca miraba `cfg.provider`, y el
// editor la reportó dos veces: *"si tengo configurado el CLI de Cursor, aún
// siento que el botón de refinar manda el prompt por Claude"*. Tenía razón. Y
// en su máquina no era solo raro: su cuenta de Claude no tenía cupo, así que el
// botón no funcionaba TENIENDO con qué refinar.

test('refina el proveedor que el editor eligió, no el primero de la lista', function () {
  // El caso del reporte: con Cursor elegido, Cursor va primero. Antes ni
  // figuraba, así que ganaba Claude siempre.
  eq(refinar._ordenPara('cursor-cli')[0].id, 'cursor-cli');
  ok(refinar._ordenPara('cursor-cli')[0].esElegido, 'y se sabe que es el elegido, no un respaldo');
});

test('vale para todos, no es un parche para Cursor', function () {
  // La regla es "el elegido refina", así que cada proveedor tiene que ganarse
  // el primer puesto cuando le toca. Un arreglo que solo contemple a Cursor
  // deja el mismo bug para el que elija Ollama.
  ['claude-cli', 'claude-api', 'ollama', 'openai-compat', 'cursor-cli'].forEach(function (p) {
    eq(refinar._ordenPara(p)[0].id, p, 'con ' + p + ' elegido tiene que refinar ' + p);
  });
});

test('el respaldo conserva su orden: API, después CLI, después local', function () {
  // Lo que NO cambió: cuando el elegido no puede, el orden sigue siendo por
  // costo y latencia. La API primero porque es lo único que no paga el arranque
  // de un CLI.
  eq(refinar._ordenPara('').map((r) => r.id).join(','), 'claude-api,claude-cli,ollama');
  eq(refinar._ordenPara('cursor-cli').slice(1).map((r) => r.id).join(','),
    'claude-api,claude-cli,ollama', 'y detrás del elegido, el mismo orden');
});

test('el elegido no se repite abajo como respaldo de sí mismo', function () {
  const orden = refinar._ordenPara('claude-cli');
  eq(orden.filter((r) => r.id === 'claude-cli').length, 1,
    'probarlo dos veces son dos arranques de CLI para el mismo "no"');
  eq(orden.map((r) => r.id).join(','), 'claude-cli,claude-api,ollama');
});

test('Cursor y la API compatible NO entran al respaldo de nadie', function () {
  // Los dos pueden ser el elegido, y ninguno de los dos es un recurso: Cursor
  // porque está medido que cuesta ~6 s y ~9.500 tokens a caché contra los ~2 s
  // de Haiku por la API, y la API compatible porque atrás puede haber cualquier
  // precio y no se le gasta plata al editor por una vía que no pidió.
  ['claude-cli', 'claude-api', 'ollama', ''].forEach(function (p) {
    const respaldo = refinar._ordenPara(p).filter((r) => !r.esElegido).map((r) => r.id);
    ok(respaldo.indexOf('cursor-cli') === -1, 'con ' + (p || 'ninguno') + ' elegido, Cursor no es respaldo');
    ok(respaldo.indexOf('openai-compat') === -1, 'ni la API compatible');
  });
});

test('con Cursor elegido, un refinado que sale bien NO se refinó por Claude', async function () {
  // El reclamo, actuado de punta a punta: el editor eligió Cursor, Cursor puede,
  // y lo que vuelve tiene que decir Cursor. Si acá aparece Claude, es el bug.
  let claudeLlamado = false;
  const r = await conRefinadores([
    falso({
      id: 'cursor-cli', nombre: 'Cursor (Claude Sonnet)',
      complete: async () => ({ text: 'El título entra desde la izquierda con un fade de medio segundo, easing suave en los keyframes, y el logo abajo a la derecha.' }),
    }),
    falso({
      id: 'claude-api', nombre: 'Claude Haiku (API de Anthropic)',
      complete: async () => { claudeLlamado = true; return { text: 'lo refinó Claude' }; },
    }),
  ], () => refinar.refinarDictado({ crudo: DICTADO }, { provider: 'cursor-cli' }));
  ok(r.ok, r.aviso || '');
  has(r.refinador, 'Cursor', 'refinó el que eligió');
  ok(!claudeLlamado, 'y Claude no se enteró de que existía este dictado');
  ok(String(r.refinador).indexOf('respaldo') === -1, 'no es un respaldo: es el elegido');
});

test('si el elegido no puede, refina el respaldo Y SE DICE que fue el respaldo', async function () {
  // El editor tiene derecho a saber quién escribió lo que le apareció en el
  // campo, sobre todo si es otro modelo del que eligió.
  const r = await conRefinadores([
    falso({
      id: 'cursor-cli', nombre: 'Cursor (Claude Sonnet)',
      detectar: async () => ({ disponible: false, motivo: 'el CLI de Cursor está pero sin sesión' }),
    }),
    falso({
      id: 'claude-api', nombre: 'Claude Haiku (API de Anthropic)',
      complete: async () => ({ text: 'El título entra desde la izquierda con un fade de medio segundo, easing suave en los keyframes, y el logo abajo a la derecha.' }),
    }),
  ], () => refinar.refinarDictado({ crudo: DICTADO }, { provider: 'cursor-cli' }));
  ok(r.ok, r.aviso || '');
  has(r.refinador, 'Claude Haiku');
  has(r.refinador, 'respaldo', 'sin esto el editor cree que su elección se respetó');
  has(r.aviso, 'no pudo', 'y se cuenta por qué el suyo quedó afuera');
  has(r.aviso, 'sin sesión');
});

test('cuando el elegido no puede, no se lo manda a arreglar el que NO eligió', async function () {
  // El otro lado del mismo problema: decir que refinó otro es información;
  // pedirle que instale Ollama o que se loguee en Claude a alguien que eligió
  // Cursor es mandarlo a trabajar para nosotros.
  const r = await conRefinadores([
    falso({ id: 'cursor-cli', nombre: 'Cursor (Claude Sonnet)', detectar: async () => ({ disponible: false, motivo: 'el CLI de Cursor está pero sin sesión (corré `cursor-agent login`)' }) }),
    falso({ id: 'claude-api', nombre: 'Claude Haiku (API de Anthropic)', detectar: async () => ({ disponible: false, motivo: 'no hay API key de Anthropic configurada en ⚙' }) }),
    falso({ id: 'ollama', nombre: 'Ollama local', detectar: async () => ({ disponible: false, motivo: 'Ollama no está corriendo en esta máquina' }) }),
  ], () => refinar.refinarDictado({ crudo: DICTADO }, { provider: 'cursor-cli' }));
  ok(!r.ok);
  const suyoPrimero = r.aviso.indexOf('Cursor') < r.aviso.indexOf('Ollama');
  ok(suyoPrimero, 'el problema del proveedor que eligió va primero: es el único que le conviene arreglar');
  has(r.aviso, 'El proveedor que elegiste');
  has(r.aviso, 'cursor-agent login', 'con SU próximo paso');
  has(r.aviso, 'respaldo', 'y lo demás, contado como lo que es');
});

test('a Cursor se le pide el modelo CORTO, no el de diseñar', async function () {
  // Refinar no es diseñar. El editor puede tener elegido un modelo con
  // razonamiento para las animaciones, y pedirle ESO para reordenar dos frases
  // es pagar el razonamiento entero por una tarea que no lo usa.
  const cur = refinar._REFINADORES.filter((r) => r.id === 'cursor-cli')[0];
  const cursorCli = require('../bridge/providers/cursor-cli');
  eq(cur.model(), cursorCli.MODELO_CORTO);
  ok(cur.model() !== cursorCli.DEFAULT_MODEL,
    'el de diseño y el de refinar no pueden ser el mismo: se eligieron midiendo cosas distintas');
  const c = await cur.config({ apiKey: 'k' });
  eq(c.apiKey, 'k', 'la misma credencial que usa la generación, por la misma función');
  ok(c.timeoutMs > 45_000,
    'Cursor necesita más aire: al pedido hay que sumarle el arranque del agente');
});

test('el refinado por Cursor NO pasa por el desenvolver-HTML', async function () {
  // `complete` y `generate` tienen que ser dos cosas distintas. Cuando eran una
  // sola, todo lo que devolvía Cursor pasaba por `stripHtmlFence` — que sobre
  // una composición es lo correcto y sobre una instrucción de diseño es una
  // poda esperando a que alguien mencione un bloque de código.
  if (saltarEnWindows) return console.log('      (se saltea en Windows: el CLI de mentira es un script con shebang)');
  const cursorCli = require('../bridge/providers/cursor-cli');
  const FAKE_CURSOR = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-cursor.js');
  const previo = process.env.FAKE_MODE;
  process.env.FAKE_MODE = 'texto-con-fence';
  try {
    const opts = {
      systemPrompt: 'x', userPrompt: 'y', model: 'claude-sonnet-5',
      config: { cursorBinPath: FAKE_CURSOR, timeoutMs: 20_000 },
    };
    const crudo = await cursorCli.complete(opts);
    has(crudo.text, '```html', 'complete devuelve lo que escribió el modelo, tal cual');
    const compo = await cursorCli.generate(opts);
    ok(compo.text.indexOf('```') === -1, 'y generate sí le saca el fence: es su trabajo');
    eq(compo.text, 'El título entra con un fade.');
  } finally {
    if (previo === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = previo;
  }
});

test('cada refinador nombra a un proveedor de verdad que sabe dar texto crudo', function () {
  // Cursor y la API compatible entraron a la cadena en la 1.5.0, y los dos
  // implementaban solo `generate` (que desenvuelve el HTML de una composición).
  // Sin partirlos, refinar por ellos habría pasado la instrucción del editor
  // por un `stripHtmlFence` que no tiene nada que hacer ahí.
  refinar._REFINADORES.forEach(function (r) {
    eq(typeof getProvider(r.id).complete, 'function',
      r.id + ' tiene que saber devolver texto crudo');
  });
});

test('cada refinador nombra a un proveedor de verdad, y le pide texto crudo', function () {
  // La cadena no reimplementa a nadie: llama a `complete()` del proveedor que
  // se llama igual que la entrada. Si alguien vuelve a escribir el spawn acá
  // adentro, se pierden el `is_error` con código 0, la escalera de reintento
  // por flag desconocido y el system prompt por archivo — que es exactamente lo
  // que había pasado.
  refinar._REFINADORES.forEach(function (r) {
    const p = getProvider(r.id);
    eq(typeof p.complete, 'function', r.id + ' tiene que saber devolver texto crudo');
    eq(typeof r.model, 'function', r.id + ': el modelo es un dato de la entrada, no código adentro');
    eq(typeof r.config, 'function', r.id + ': la config también');
    ok(!r.refinar, r.id + ': una entrada con su propio `refinar` es una reimplementación esperando pasar');
  });
});

test('al CLI se le sacan TODAS las herramientas: refinar texto no lee nada', async function () {
  const cli = refinar._REFINADORES.filter((r) => r.id === 'claude-cli')[0];
  const c = await cli.config({});
  eq(c.tools, '', 'sin esto el CLI se va a buscar archivos por su cuenta y paga turnos que nadie pidió');
  eq(c.timeoutMs, 45_000, 'y no los diez minutos de una generación: acá son dos frases');
});

test('a Ollama se le piden los tres números de un trabajo corto, no los de generar', async function () {
  const o = refinar._REFINADORES.filter((r) => r.id === 'ollama')[0];
  const c = await o.config({});
  eq(c.numCtx, 4096, '32k de contexto para dos frases es memoria reservada al pedo');
  eq(c.keepAlive, '10m');
  eq(c.temperature, 0.2, 'la temperatura alta es por donde se cuela lo que nadie pidió');
  eq(o.model('llama3.2:3b'), 'llama3.2:3b', 'el modelo es el que eligió detectar entre los instalados');
});

/** Corre la cadena con los refinadores reemplazados por los de mentira. */
async function conRefinadores(falsos, fn) {
  const reales = refinar._REFINADORES.splice(0, refinar._REFINADORES.length);
  falsos.forEach((f) => refinar._REFINADORES.push(f));
  refinar.olvidarRefinador();
  try { return await fn(); }
  finally {
    refinar._REFINADORES.splice(0, refinar._REFINADORES.length);
    reales.forEach((r) => refinar._REFINADORES.push(r));
    refinar.olvidarRefinador();
  }
}

/**
 * Una entrada de la cadena de mentira: se detecta como quiera y su proveedor
 * contesta lo que se le diga. Es el gancho `proveedor` (ver dictado-refinar.js),
 * que es lo que permite probar la CADENA —el orden, la caída al siguiente, el
 * control de lo que vuelve— sin CLI, sin red y sin Ollama.
 */
function falso(o) {
  return {
    id: o.id,
    nombre: o.nombre,
    detectar: o.detectar || (async () => ({ disponible: true, detalle: o.detalle || '' })),
    model: (d) => d || 'modelo-de-mentira',
    config: () => ({}),
    proveedor: { complete: o.complete || (async () => ({ text: '' })) },
  };
}

const NINGUNO = [
  falso({ id: 'a', nombre: 'API de Anthropic', detectar: async () => ({ disponible: false, motivo: 'no hay API key configurada' }) }),
  falso({ id: 'b', nombre: 'CLI de Claude', detectar: async () => ({ disponible: false, motivo: 'está pero sin sesión' }) }),
  falso({ id: 'c', nombre: 'Ollama local', detectar: async () => ({ disponible: false, motivo: 'no está corriendo' }) }),
];

test('sin ningún refinador, el dictado igual llega al campo', async function () {
  const r = await conRefinadores(NINGUNO, () => refinar.refinarDictado({ crudo: DICTADO }, {}));
  ok(!r.ok, 'no se refinó');
  eq(r.texto, DICTADO, 'pero el campo queda con el dictado: un dictado sin refinar sirve igual');
  has(r.aviso, 'sin refinar');
});

test('y se dice por qué NO se pudo, uno por uno', async function () {
  const r = await conRefinadores(NINGUNO, () => refinar.refinarDictado({ crudo: DICTADO }, {}));
  has(r.aviso, 'no hay API key configurada');
  has(r.aviso, 'está pero sin sesión');
  has(r.aviso, 'no está corriendo',
    'sin esto el editor no sabe qué le falta instalar para que el dictado mejore');
});

test('lo que el editor ya tenía escrito no se pierde si no hay refinador', async function () {
  const r = await conRefinadores(NINGUNO, () =>
    refinar.refinarDictado({ crudo: 'y el logo abajo', previo: 'título en azul' }, {}));
  has(r.texto, 'título en azul', 'lo suyo, primero');
  has(r.texto, 'y el logo abajo');
});

test('si el primero no está, se usa el que sigue', async function () {
  const r = await conRefinadores([
    NINGUNO[0],
    falso({
      id: 'b', nombre: 'CLI de Claude',
      complete: async () => ({ text: 'El título entra desde la izquierda con fade de 0,5 s, easing suave en los keyframes, y el logo abajo a la derecha.' }),
    }),
    NINGUNO[2],
  ], () => refinar.refinarDictado({ crudo: DICTADO }, {}));
  ok(r.ok);
  has(r.refinador, 'CLI de Claude', 'y se dice con cuál se refinó: es el primer dato cuando algo sale raro');
  ok(r.ms >= 0, 'con cuánto tardó');
});

test('si el refinador elegido se cae, queda el dictado y no un error', async function () {
  const r = await conRefinadores([falso({
    id: 'a', nombre: 'API de Anthropic',
    complete: async () => { throw new Error('HTTP 401: invalid x-api-key'); },
  })], () => refinar.refinarDictado({ crudo: DICTADO }, {}));
  ok(!r.ok);
  eq(r.texto, DICTADO, 'el dictado no se pierde porque la key esté vencida');
  has(r.aviso, '401', 'y el motivo de verdad llega, sin traducirlo a "algo salió mal"');
});

test('un refinado que no pasa el control tampoco pisa el dictado', async function () {
  const r = await conRefinadores([falso({
    id: 'c', nombre: 'Ollama local', detalle: 'llama3:latest',
    complete: async () => ({ text: 'Fade.' }), // se comió todo
  })], () => refinar.refinarDictado({ crudo: DICTADO }, {}));
  ok(!r.ok);
  eq(r.texto, DICTADO, 'entre un refinado que perdió la mitad y el crudo, gana el crudo');
  has(r.aviso, 'se comió parte del pedido');
  has(r.aviso, 'Ollama local', 'nombrando al responsable');
});

test('el gasto del refinado vuelve para el contador, aunque el refinado se descarte', async function () {
  const r = await conRefinadores([falso({
    id: 'c', nombre: 'Ollama local', detalle: 'llama3:latest',
    complete: async () => ({ text: 'Fade.', usage: { inputTokens: 120, outputTokens: 3, costUsd: 0 } }),
  })], () => refinar.refinarDictado({ crudo: DICTADO }, {}));
  ok(!r.ok);
  ok(r.usage, 'los tokens se gastaron igual: no contarlos es mentirle al contador');
  eq(r.usage.inputTokens, 120);
});

test('sin dictado no se llama a nadie', async function () {
  let llamado = false;
  const r = await conRefinadores([falso({
    id: 'a', nombre: 'API', detectar: async () => { llamado = true; return { disponible: true }; },
    complete: async () => ({ text: 'x' }),
  })], () => refinar.refinarDictado({ crudo: '   ', previo: 'lo que ya estaba' }, {}));
  ok(!llamado, 'refinar aire cuesta plata y no arregla nada');
  eq(r.texto, 'lo que ya estaba', 'y lo que estaba escrito se queda como estaba');
});

test('la cadena se resuelve una vez y no en cada dictado', async function () {
  let sondeos = 0;
  await conRefinadores([falso({
    id: 'a', nombre: 'API',
    detectar: async () => { sondeos++; return { disponible: true }; },
    complete: async () => ({ text: 'El título entra desde la izquierda con fade y easing suave, logo abajo a la derecha.' }),
  })], async function () {
    await refinar.refinarDictado({ crudo: DICTADO }, {});
    await refinar.refinarDictado({ crudo: DICTADO }, {});
    await refinar.refinarDictado({ crudo: DICTADO }, {});
  });
  eq(sondeos, 1,
    'preguntarle al CLI de Claude si hay sesión cuesta ~250 ms: pagarlo en cada dictado es media latencia de más');
});

test('guardar la config vuelve a preguntar: puede haber una API key nueva', async function () {
  let sondeos = 0;
  await conRefinadores([falso({
    id: 'a', nombre: 'API',
    detectar: async () => { sondeos++; return { disponible: true }; },
    complete: async () => ({ text: 'El título entra desde la izquierda con fade y easing suave, logo abajo a la derecha.' }),
  })], async function () {
    await refinar.refinarDictado({ crudo: DICTADO }, {});
    refinar.olvidarRefinador(); // es lo que hace saveConfig
    await refinar.refinarDictado({ crudo: DICTADO }, {});
  });
  eq(sondeos, 2, 'sin esto, el editor pega la key y el dictado sigue crudo hasta que cierre Premiere');
});

// --- 5 bis. El mismo camino, para lo que se escribió a mano -----------------
//
// El ✨ del panel no tiene una cadena propia: entra por acá con `origen:
// 'escrito'`. Estos tests fijan que sea EL MISMO camino —la misma cadena, el
// mismo control de tamaño, el mismo gasto informado— y que lo único que cambie
// sea lo que se le DICE al editor, porque "quedó el dictado sin refinar" sobre
// un párrafo que tecleó nombra algo que no pasó.

test('refinar a mano usa la misma cadena y el mismo control de tamaño', async function () {
  const ESCRITO = 'que el lower third entre desde el borde izquierdo con easing suave, se quede tres ' +
    'segundos y se vaya con un fade corto, con el nombre del invitado y su cargo abajo';
  const r = await conRefinadores([falso({
    id: 'c', nombre: 'Ollama local', detalle: 'llama3:latest',
    complete: async () => ({ text: 'Un lower third.' }), // se comió todo
  })], () => refinar.refinarDictado({ crudo: ESCRITO, origen: 'escrito' }, {}));
  ok(!r.ok, 'el control es el mismo: un refinado que perdió la mitad no pasa por escribirse a mano');
  has(r.aviso, 'se comió parte del pedido');
  has(r.aviso, 'Ollama local');
});

test('y el aviso no habla de un dictado que no hubo', async function () {
  const r = await conRefinadores(NINGUNO, () =>
    refinar.refinarDictado({ crudo: 'el fondo transparente y el logo más chico', origen: 'escrito' }, {}));
  ok(!r.ok);
  ok(r.aviso.indexOf('dictado') === -1,
    'nombrar un dictado que nunca hubo hace dudar de si el panel entendió qué se apretó');
  has(r.aviso, 'tu texto quedó como estaba',
    'y decir que su texto está intacto es la mitad del arreglo: eso es lo que se teme al apretar');
  has(r.aviso, 'no está corriendo', 'con el motivo de siempre, uno por uno');
});

test('el campo vacío no le cuesta una llamada a nadie', async function () {
  let llamado = false;
  const r = await conRefinadores([falso({
    id: 'a', nombre: 'API', detectar: async () => { llamado = true; return { disponible: true }; },
    complete: async () => ({ text: 'x' }),
  })], () => refinar.refinarDictado({ crudo: '   \n  ', origen: 'escrito' }, {}));
  ok(!llamado);
  has(r.aviso, 'El campo está vacío');
});

test('un refinado a mano que sale bien vuelve con su gasto y su modelo', async function () {
  const ESCRITO = 'que el titulo vaya arriba a la izquierda y entre con un fade cortito, y el logo chico abajo';
  const r = await conRefinadores([falso({
    id: 'c', nombre: 'Ollama local', detalle: 'llama3.2:3b',
    complete: async () => ({
      text: 'El título arriba a la izquierda, entrando con un fade corto. El logo, chico, abajo.',
      usage: { inputTokens: 210, outputTokens: 48, costUsd: 0 },
    }),
  })], () => refinar.refinarDictado({ crudo: ESCRITO, origen: 'escrito' }, {}));
  ok(r.ok, r.aviso || '');
  has(r.refinador, 'llama3.2:3b', 'el modelo, no solo el proveedor: es lo que va al log');
  eq(r.usage.inputTokens, 210, 'y el gasto, que el panel manda al bolsillo del dictado');
  ok(r.ms >= 0);
});

test('un refinador que revienta al detectarse no rompe la cadena', async function () {
  const r = await conRefinadores([
    falso({ id: 'a', nombre: 'API', detectar: async () => { throw new Error('el CLI no está'); } }),
    falso({
      id: 'c', nombre: 'Ollama local', detalle: 'llama3.2:3b',
      complete: async () => ({ text: 'El título entra desde la izquierda con fade de medio segundo, easing suave en los keyframes, y el logo abajo a la derecha.' }),
    }),
  ], () => refinar.refinarDictado({ crudo: DICTADO }, {}));
  ok(r.ok, 'el que se cayó se descarta y se sigue con el siguiente');
  has(r.refinador, 'Ollama');
  has(r.refinador, 'llama3.2:3b', 'con el modelo, no solo el proveedor');
});

// --- 6. El CLI de verdad, con el binario de mentira --------------------------
//
// Acá NO hay proveedor de mentira: corre `bridge/providers/claude-cli.js`
// entero, con un binario falso que actúa los modos de falla que el CLI de
// verdad tiene en la máquina de un editor. Es lo único que prueba que la
// cadena esté enchufada al proveedor canónico y no a una copia.

/** Corre la cadena con el CLI de mentira como único refinador. */
async function conCliFalso(modo, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-refinar-cli-'));
  const log = path.join(dir, 'recibido.json');
  const previos = { modo: process.env.FAKE_MODE, log: process.env.FAKE_LOG };
  process.env.FAKE_MODE = modo;
  process.env.FAKE_LOG = log;
  // La entrada de verdad, con el binario apuntado al falso: lo que se prueba es
  // el proveedor y la cadena, no el `which claude` de esta máquina.
  const entrada = {
    id: 'claude-cli',
    nombre: 'Claude Haiku (CLI de Claude)',
    detectar: async () => ({ disponible: true }),
    model: () => 'haiku',
    config: () => ({ binPath: FAKE_CLAUDE, timeoutMs: 20_000, tools: '' }),
  };
  try {
    const r = await conRefinadores([entrada], fn);
    return { r, recibido: fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : null };
  } finally {
    ['FAKE_MODE', 'FAKE_LOG'].forEach(function (k, i) {
      const v = [previos.modo, previos.log][i];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('el CLI que cierra con código 0 y is_error NO deja su error en el campo del editor', async function () {
  if (saltarEnWindows) return console.log('      (se saltea en Windows: el CLI de mentira es un script con shebang)');
  // El caso: el CLI arranca, no encuentra con qué autenticarse y cierra en el
  // acto — con CÓDIGO 0 y el motivo adentro de `result`, que es el mismo campo
  // donde viene la respuesta cuando sale bien.
  //
  // Leyendo `result` a secas, "Invalid API key · Please run /login" son seis
  // palabras contra tres dictadas: pasa el control de tamaño (que abajo de ocho
  // palabras no mide proporción) y termina EN EL CAMPO, haciéndose pasar por el
  // prompt refinado del editor. Con un dictado largo no llega al campo, pero se
  // rechaza con el motivo equivocado ("se comió parte del pedido").
  const { r } = await conCliFalso('falla-sin-sesion-code0', () =>
    refinar.refinarDictado({ crudo: 'subí el título' }, {}));

  ok(!r.ok, 'un error del CLI no es un refinado');
  eq(r.texto, 'subí el título', 'lo que queda en el campo es lo que dictó, tal cual');
  ok(r.texto.indexOf('Invalid API key') === -1,
    'el mensaje de error del CLI no puede terminar siendo el prompt del marcador');
  has(r.aviso, 'sin refinar');
  has(r.aviso, 'sesión de Claude', 'y con el diagnóstico del proveedor, que sabe qué es esto');
  has(r.aviso, 'Claude Haiku (CLI de Claude)', 'nombrando al responsable');
});

test('y con un dictado largo tampoco se rechaza con el motivo equivocado', async function () {
  if (saltarEnWindows) return;
  const { r } = await conCliFalso('falla-sin-sesion-code0', () =>
    refinar.refinarDictado({ crudo: DICTADO }, {}));
  ok(!r.ok);
  eq(r.texto, DICTADO);
  ok(r.aviso.indexOf('se comió parte del pedido') === -1,
    'mandar al editor a mirar su dictado cuando el problema es que no hay sesión es peor que no decir nada');
  has(r.aviso, 'sesión de Claude');
});

test('con el CLI andando, el refinado llega al campo y se cuenta lo que gastó', async function () {
  if (saltarEnWindows) return;
  const { r, recibido } = await conCliFalso('texto', () => refinar.refinarDictado({ crudo: DICTADO }, {}));
  ok(r.ok, r.aviso || '');
  has(r.texto, 'fade de medio segundo');
  has(r.texto, 'keyframes');

  eq(recibido.systemPrompt, refinar.SISTEMA,
    'el manual viaja como system prompt, entero y en su canal: pegado al mensaje de usuario, ' +
    'las reglas están pero no donde se obedecen');
  has(recibido.stdinCompleto || recibido.promptPosicional || '', 'DICTADO:', 'y el dictado, como mensaje de usuario');
  eq(recibido.args[recibido.args.indexOf('--tools') + 1], '', 'sin ninguna herramienta');
  eq(recibido.args[recibido.args.indexOf('--allowedTools') + 1], '');
  eq(recibido.args[recibido.args.indexOf('--model') + 1], 'haiku');

  ok(r.usage, 'el refinado tiene que traer su gasto');
  eq(r.usage.provider, 'claude-cli');
  eq(r.usage.totalInputTokens, 180 + 12000,
    'todo lo que entró al modelo: el manual se lee de caché en cada llamada y también se pagó');
  eq(r.usage.costUsd, 0.0004);
});

test('un CLI viejo que no conoce --tools refina igual, sin las herramientas acotadas', async function () {
  if (saltarEnWindows) return;
  // La escalera de reintento del proveedor. Escrito afuera no existía: `--tools`
  // en un CLI viejo era el final del refinado, sin plan B.
  const { r } = await conCliFalso('texto-sin-tools', () => refinar.refinarDictado({ crudo: DICTADO }, {}));
  ok(r.ok, 'nadie se queda sin refinar por un cartelito: ' + (r.aviso || ''));
  has(r.texto, 'fade de medio segundo');
});
