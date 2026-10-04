'use strict';

// QUÉ OFRECE EL SELECTOR DE CLAUDE POR EL CLI, sin lanzar nada.
//
// El selector de ⚙ ofrecía Opus 5, Sonnet 5, Fable 5 y Opus 4.8 con Opus 5.5
// ya publicado: una lista escrita en el panel, que envejecía sin que nada lo
// dijera. Ahora todo sale del CLI instalado y de medir con la cuenta. Lo que
// se fija acá es lo que decide esa mitad pura (bridge/claude-modelos.js):
//
//   1. Cómo se lee y se escribe cada `--model`, incluidos los IDs que había
//      guardados antes de este selector.
//   2. Cómo se lee el menú /model que viene adentro del binario del CLI.
//   3. Quién contestó una llamada, y cuándo responder NO es estar disponible.
//   4. Qué se ofrece: las versiones medidas, las ventanas medidas, y que sin
//      medir no se afirme ningún número.
//
// Los datos de abajo son los que contestó el CLI de verdad (Claude Code
// 2.1.288, octubre de 2026), copiados de la medición.

const { test, ok, eq, deepEq, has } = require('./harness');
const CM = require('../bridge/claude-modelos');

/** Las opciones del menú tal como vienen escritas en el binario 2.1.288. */
const MENU_CRUDO = [
  '{value:!id()?BS().sonnet46:"claude-sonnet-4-6",label:"Sonnet 4.6",description:"Sonnet 4.6 \\xB7 Legacy",descriptionForModel:"Sonnet 4.6 - previous Sonnet version"',
  '{value:!id()?BS().sonnet5:"claude-sonnet-5",label:"Sonnet 5",description:"Sonnet 5 \\xB7 Previous Sonnet version",descriptionForModel:"Sonnet 5 - previous Sonnet version"',
  '{value:BS().opus41,label:"Opus 4.1",description:"Opus 4.1 \\xB7 Legacy",descriptionForModel:"Opus 4.1 - legacy version"',
  '{value:!id()?BS().opus46:"claude-opus-4-6",label:"Opus 4.6",description:"Opus 4.6 \\xB7 Legacy",descriptionForModel:"Opus 4.6 - previous Opus version"',
  '{value:!id()?BS().opus48:"claude-opus-4-8",label:"Opus 4.8",description:"Opus 4.8 \\xB7 Legacy",descriptionForModel:"Opus 4.8 - previous Opus version"',
  '{value:!id()?BS().opus5:"claude-opus-5",label:"Opus 5",description:"Opus 5 \\xB7 Previous Opus version",descriptionForModel:"Opus 5 - previous Opus version"',
];
const MENU = MENU_CRUDO.map(CM.opcionDelMenu).filter(Boolean);

function contesto(id, ventana, salida) {
  return { contesto: { id: id, ventana: ventana, salida: salida || 64000 }, error: '' };
}

/** Lo que contestó cada llamada en la medición real, en el formato de claude-medir. */
const CRUDOS = {
  fable: contesto('claude-fable-5-1', 1000000),
  opus: contesto('claude-opus-5-5', 1000000, 128000),
  sonnet: contesto('claude-sonnet-5-5', 1000000, 128000),
  haiku: contesto('claude-haiku-4-5-20251001', 200000, 32000),
  'claude-sonnet-5': contesto('claude-sonnet-5', 1000000),
  'claude-sonnet-4-6': contesto('claude-sonnet-4-6', 200000),
  'claude-opus-4-1': contesto('claude-opus-5-5', 1000000),
  'claude-opus-4-6': contesto('claude-opus-4-6', 200000),
  'claude-opus-4-8': contesto('claude-opus-4-8', 1000000),
  'claude-opus-5': contesto('claude-opus-5', 1000000),
  'haiku[1m]': { contesto: null, error: 'API Error: 400 The long context beta is not yet available for this subscription.' },
  'claude-sonnet-4-6[1m]': contesto('claude-sonnet-4-6[1m]', 1000000),
  'claude-opus-4-6[1m]': contesto('claude-opus-4-6[1m]', 1000000),
};
const MEDIDA = CM.registrarMedicion('2.1.288', CRUDOS, '2026-10-03T12:00:00.000Z');

function catalogo(modelo, extra) {
  return CM.catalogo(Object.assign({
    menu: MENU, medicion: MEDIDA, cli: '2.1.288', modelo: modelo, esfuerzo: 'high',
  }, extra || {}));
}

/** La opción de un valor, buscando en todos los grupos. */
function opcion(cat, valor) {
  const todas = [cat.predeterminado].concat(cat.propio ? [cat.propio] : []);
  cat.grupos.forEach((g) => g.opciones.forEach((o) => todas.push(o)));
  return todas.find((o) => o.valor === valor) || null;
}

// ── 1. El `--model` ───────────────────────────────────────────────────

test('un alias, una versión fija, con y sin 1M, y lo de antes', function () {
  deepEq(CM.leer('opus'), { familia: 'opus', version: '', extendida: false, propio: '' });
  deepEq(CM.leer('opus[1m]'), { familia: 'opus', version: '', extendida: true, propio: '' });
  deepEq(CM.leer('claude-opus-4-6[1m]'), { familia: 'opus', version: 'claude-opus-4-6', extendida: true, propio: '' });
  // Lo que había guardado ANTES de este selector: era "el último" cuando se
  // eligió y hoy es una versión anterior. Se lee como lo que es, fija.
  deepEq(CM.leer('claude-sonnet-5'), { familia: 'sonnet', version: 'claude-sonnet-5', extendida: false, propio: '' });
  deepEq(CM.leer(''), { familia: '', version: '', extendida: false, propio: '' });
  deepEq(CM.leer('default'), { familia: '', version: '', extendida: false, propio: '' });
});

test('lo que no se reconoce se conserva tal cual, no se pierde', function () {
  eq(CM.leer('mi-modelo-raro').propio, 'mi-modelo-raro');
  const cat = catalogo('mi-modelo-raro');
  ok(cat.propio, 'tiene que aparecer en el selector');
  eq(cat.actual.valor, 'mi-modelo-raro');
  eq(opcion(cat, 'mi-modelo-raro').ventanas[0].modelo, 'mi-modelo-raro', 'y va al CLI tal cual');
});

test('el nombre de cada versión, con y sin fecha pegada', function () {
  eq(CM.etiquetaDeVersion('claude-opus-5-5'), 'Opus 5.5');
  eq(CM.etiquetaDeVersion('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  eq(CM.etiquetaDeVersion('claude-opus-4-6[1m]'), 'Opus 4.6');
  eq(CM.etiquetaDeVersion('opus'), '', 'un alias no es una versión');
});

test('las versiones se ordenan como números, no como texto', function () {
  ok(CM.compararVersiones('Opus 4.10', 'Opus 4.8') > 0, 'como texto, 4.10 iría antes que 4.8');
  ok(CM.compararVersiones('2.1.288', '2.1.289') < 0, 'y sirve igual para la versión del CLI');
  eq(CM.compararVersiones('Opus 5', 'Opus 5.0'), 0);
});

// ── 2. El menú del binario ────────────────────────────────────────────

test('del menú salen las versiones anteriores, con el ID del literal', function () {
  const ids = MENU.map((o) => o.id);
  deepEq(ids, ['claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-1', 'claude-opus-4-6', 'claude-opus-4-8', 'claude-opus-5']);
});

test('una opción sin ID escrito lo saca de la etiqueta', function () {
  // `value:BS().opus41` no trae el string: el ID solo está en la etiqueta.
  const o = CM.opcionDelMenu(MENU_CRUDO[2]);
  eq(o.id, 'claude-opus-4-1');
});

test('"legacy" es lo que Claude Code le MUESTRA al editor, no solo lo que le dice al modelo', function () {
  // descriptionForModel dice "previous Sonnet version" para la 4.6; lo que se
  // ve en el /model del CLI es "Sonnet 4.6 · Legacy". El selector dice lo mismo.
  eq(MENU.find((o) => o.id === 'claude-sonnet-4-6').legacy, true);
  eq(MENU.find((o) => o.id === 'claude-opus-5').legacy, false, 'Opus 5 es "previous", no legacy');
});

test('las variantes "(1M context)" no son versiones aparte: la ventana tiene su propio selector', function () {
  const variante = '{value:!id()?BS().opus46+"[1m]":"claude-opus-4-6[1m]",label:"Opus 4.6 (1M context)",' +
    'description:"Opus 4.6 para sesiones largas",descriptionForModel:"Opus 4.6 with 1M context window - previous Opus version"';
  eq(CM.opcionDelMenu(variante), null);
});

test('la opción del alias (la última de la familia) no entra como versión anterior', function () {
  const alias = '{value:"sonnet",label:"Sonnet 5.5",description:"Rápido",descriptionForModel:"Sonnet 5.5 - best for everyday tasks"';
  eq(CM.opcionDelMenu(alias), null, 'no dice "previous" ni "legacy"');
});

// ── 3. Quién contestó ─────────────────────────────────────────────────

test('el Haiku que el CLI usa por dentro no se confunde con el que contestó', function () {
  // Editor Pro lo pagó: tomar la primera clave de modelUsage decía "Haiku"
  // para todo, porque el CLI lo usa para títulos y resúmenes.
  const uso = {
    'claude-haiku-4-5-20251001': { inputTokens: 300, outputTokens: 20, contextWindow: 200000 },
    'claude-opus-5-5': { inputTokens: 2, outputTokens: 9, contextWindow: 1000000, maxOutputTokens: 128000 },
  };
  deepEq(CM.cualContesto(uso, 'opus'), { id: 'claude-opus-5-5', ventana: 1000000, salida: 128000 });
});

test('pedir Haiku sí devuelve Haiku, aunque otro modelo haya movido más tokens', function () {
  // El caso que la familia pedida resuelve y "el que más gastó" no: si el CLI
  // usó otro modelo de fondo, el que contestó lo pedido es el de la familia.
  const uso = {
    'claude-sonnet-5-5': { inputTokens: 900, outputTokens: 40, contextWindow: 1000000 },
    'claude-haiku-4-5-20251001': { inputTokens: 2, outputTokens: 9, contextWindow: 200000 },
  };
  eq(CM.cualContesto(uso, 'haiku').id, 'claude-haiku-4-5-20251001');
  eq(CM.cualContesto(uso, 'claude-haiku-4-5').id, 'claude-haiku-4-5-20251001', 'y pidiendo la versión fija, igual');
});

test('UNA VERSIÓN RETIRADA NO DA ERROR: la contesta la actual, y eso no es estar disponible', function () {
  // Medido: pedir claude-opus-4-1 lo contestó Opus 5.5, sin ningún error.
  const r = MEDIDA.resultados['claude-opus-4-1'];
  ok(!r.resuelto, 'contar esto como disponible es decirle al editor que genera con Opus 4.1');
  eq(r.noDisponible, 'Retirada: la contesta Opus 5.5');
});

test('un alias que contesta otra familia tampoco cuenta', function () {
  const med = CM.registrarMedicion('2.1.288', { sonnet: contesto('claude-opus-5-5', 1000000) }, '');
  has(med.resultados.sonnet.noDisponible, 'otra familia');
});

test('un error del modelo queda como motivo, recortado', function () {
  eq(MEDIDA.resultados['haiku[1m]'].noDisponible,
    'API Error: 400 The long context beta is not yet available for this subscription.');
  const largo = CM.registrarMedicion('x', { opus: { contesto: null, error: 'a'.repeat(500) } }, '');
  eq(largo.resultados.opus.noDisponible.length, 200);
});

test('si no contestó NADA, la medición no sirve: es la sesión o la red, no los modelos', function () {
  const nada = CM.registrarMedicion('2.1.288', {
    opus: { contesto: null, error: 'getaddrinfo ENOTFOUND api.anthropic.com' },
    sonnet: { contesto: null, error: 'getaddrinfo ENOTFOUND api.anthropic.com' },
  }, '');
  eq(CM.sirve(nada), false, 'guardarla deshabilitaría el selector entero por un corte de Wi-Fi');
  eq(CM.sirve(MEDIDA), true);
});

// ── 4. Qué se mide, y cuándo deja de valer ────────────────────────────

test('primero los cuatro alias y las versiones del menú', function () {
  deepEq(CM.objetivosAMedir(MENU), ['fable', 'opus', 'sonnet', 'haiku',
    'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-1', 'claude-opus-4-6', 'claude-opus-4-8', 'claude-opus-5']);
});

test('el [1m] se pregunta SOLO a los que contestaron con menos de 1M', function () {
  // A Opus 5.5 no: ya trae 1M. A Opus 4.1 tampoco: está retirada.
  const primera = CM.registrarMedicion('2.1.288', {
    opus: CRUDOS.opus, haiku: CRUDOS.haiku, 'claude-opus-4-6': CRUDOS['claude-opus-4-6'],
    'claude-opus-4-1': CRUDOS['claude-opus-4-1'],
  }, '');
  deepEq(CM.objetivosDe1M(primera).sort(), ['claude-opus-4-6[1m]', 'haiku[1m]']);
});

test('lo medido deja de valer cuando cambia el CLI', function () {
  eq(CM.vencida(MEDIDA, '2.1.288'), false);
  eq(CM.vencida(MEDIDA, '2.1.289'), true, 'cada CLI trae su tabla de alias');
  eq(CM.vencida(MEDIDA, ''), false, 'no saber qué CLI hay no borra lo que sí se sabe');
  eq(CM.vencida(null, '2.1.288'), true);
  eq(CM.vencida(Object.assign({}, MEDIDA, { formato: 99 }), '2.1.288'), true, 'otro formato se vuelve a medir');
});

// ── 5. Lo que se ofrece ───────────────────────────────────────────────

test('el último de cada familia dice QUÉ versión es hoy', function () {
  const cat = catalogo('opus');
  eq(opcion(cat, 'opus').etiqueta, 'Opus 5.5 · último');
  eq(opcion(cat, 'fable').etiqueta, 'Fable 5.1 · último');
  has(opcion(cat, 'opus').acerca, 'Siempre el último Opus de tu Claude Code (hoy Opus 5.5).');
});

test('SIN MEDIR no se afirma ninguna versión: "Opus", no un "Opus 4.8" que envejece', function () {
  const cat = catalogo('opus', { medicion: null });
  eq(opcion(cat, 'opus').etiqueta, 'Opus · último');
  eq(opcion(cat, 'opus').acerca.indexOf('(hoy'), -1);
  has(cat.estado, 'Verificar');
});

test('lo medido con OTRO CLI se descarta entero, y se dice con cuál se había medido', function () {
  const cat = catalogo('opus', { cli: '2.1.289' });
  eq(cat.vencida, true);
  eq(opcion(cat, 'opus').etiqueta, 'Opus · último', 'con el CLI nuevo, `opus` puede ser otro modelo');
  has(cat.estado, 'Claude Code 2.1.288');
});

test('las versiones anteriores van debajo del último, de la más nueva a la más vieja', function () {
  const opus = catalogo('opus').grupos.find((g) => g.familia === 'opus').opciones.map((o) => o.etiqueta);
  deepEq(opus, ['Opus 5.5 · último', 'Opus 5', 'Opus 4.8 · legacy', 'Opus 4.6 · legacy', 'Opus 4.1 · legacy']);
});

test('una versión retirada se muestra con su motivo, no se esconde', function () {
  const o = opcion(catalogo('opus'), 'claude-opus-4-1');
  eq(o.noDisponible, 'Retirada: la contesta Opus 5.5');
});

test('la versión que hoy contesta el alias no se repite como "anterior"', function () {
  const menu = MENU.concat([{ familia: 'opus', id: 'claude-opus-5-5', etiqueta: 'Opus 5.5', legacy: false }]);
  const opus = CM.catalogo({ menu: menu, medicion: MEDIDA, cli: '2.1.288', modelo: 'opus' })
    .grupos.find((g) => g.familia === 'opus').opciones;
  eq(opus.filter((o) => /5\.5/.test(o.etiqueta)).length, 1);
});

test('una versión elegida que el CLI ya no ofrece se sigue viendo en su familia', function () {
  // Si desapareciera, el desplegable mostraría otra y el editor no sabría qué tiene puesto.
  const cat = catalogo('claude-opus-4-5');
  eq(cat.actual.valor, 'claude-opus-4-5');
  ok(opcion(cat, 'claude-opus-4-5'), 'tiene que estar entre las opciones de Opus');
});

test('lo guardado ANTES de este selector abre como versión fija, sin cambiar el modelo', function () {
  // Es la config de esta máquina: `claude-opus-5`, elegido cuando era el último.
  const cat = catalogo('claude-opus-5');
  eq(cat.actual.valor, 'claude-opus-5');
  has(opcion(cat, 'claude-opus-5').acerca, 'Fijado en Opus 5');
  const celda = opcion(cat, 'claude-opus-5').ventanas.find((v) => v.id === cat.actual.ventana);
  eq(celda.modelo, 'claude-opus-5', 'abrir ⚙ no puede cambiar con qué se genera');
});

// ── 6. Las ventanas, medidas ──────────────────────────────────────────

test('un modelo que ya trae 1M tiene UNA ventana: no se le ofrece un 200k que no tiene', function () {
  const v = opcion(catalogo('opus'), 'opus').ventanas;
  eq(v.length, 1);
  eq(v[0].etiqueta, '1M (de serie)');
  eq(v[0].modelo, 'opus', 'y el --model va sin el sufijo, que no cambiaría nada');
});

test('un modelo de 200k ofrece el 1M que contestó su propia llamada', function () {
  const v = opcion(catalogo('claude-opus-4-6'), 'claude-opus-4-6').ventanas;
  deepEq(v.map((x) => x.etiqueta), ['200k', '1M']);
  deepEq(v.map((x) => x.modelo), ['claude-opus-4-6', 'claude-opus-4-6[1m]']);
  has(v[1].acerca, 'créditos extra');
});

test('un 1M que el plan no tiene se ve deshabilitado con el motivo que dio el CLI', function () {
  const v = opcion(catalogo('haiku'), 'haiku').ventanas;
  eq(v.length, 2);
  has(v[1].noDisponible, 'not yet available for this subscription');
});

test('sin medir, las ventanas no llevan números: "La de serie" y no un "200k" inventado', function () {
  const cat = catalogo('claude-opus-4-6', { medicion: null });
  deepEq(opcion(cat, 'claude-opus-4-6').ventanas.map((v) => v.etiqueta), ['La de serie', '1M']);
  eq(opcion(cat, 'claude-opus-4-6').ventanas[0].tokens, 0);
  deepEq(opcion(cat, 'haiku').ventanas.map((v) => v.etiqueta), ['La de serie'], 'Haiku no admite el 1M');
});

test('un "opus[1m]" guardado cuando opus ya trae 1M cae en la única ventana que hay', function () {
  const cat = catalogo('opus[1m]');
  eq(cat.actual.valor, 'opus');
  eq(cat.actual.ventana, 'serie');
});

test('la ventana elegida se encuentra por el --model exacto', function () {
  const cat = catalogo('claude-opus-4-6[1m]');
  eq(cat.actual.valor, 'claude-opus-4-6');
  eq(cat.actual.ventana, '1m');
});

// ── 7. El pensamiento y el resumen ────────────────────────────────────

test('seis niveles: el que no manda nada y los cinco de --effort', function () {
  deepEq(catalogo('opus').esfuerzos.map((e) => e.id), ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
  eq(catalogo('opus', { esfuerzo: 'cualquiera' }).actual.esfuerzo, 'high', 'lo que no se conoce vuelve al recomendado');
});

test('el resumen dice qué versión, qué ventana medida y qué nivel', function () {
  eq(CM.resumen(catalogo('opus')), 'Opus 5.5 · 1M · pensamiento Alto');
  eq(CM.resumen(catalogo('claude-opus-4-6', { esfuerzo: 'max' })), 'Opus 4.6 · 200k · pensamiento Máximo');
  eq(CM.resumen(catalogo('opus', { medicion: null })), 'Opus · pensamiento Alto', 'sin medir, ni versión ni ventana');
});

test('Haiku se ve, y dice que diseñando rinde menos', function () {
  // Antes se escondía. El pedido fue ver TODOS los modelos; lo honesto es mostrarlo con su límite.
  has(opcion(catalogo('haiku'), 'haiku').acerca, 'el que peor rinde');
});
