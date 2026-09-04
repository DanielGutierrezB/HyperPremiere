'use strict';

// Habla con el refinador de VERDAD (gasta tokens si el elegido es Claude) y
// dice cuál salió elegido, cuánto tardó y qué devolvió.
//
//   node test/manual/dictado-refinar-real.js            # el que elija la cadena
//   node test/manual/dictado-refinar-real.js --todos    # prueba los tres, uno por uno
//
// Es el equivalente de test/manual/live-providers.js para el dictado: hay que
// correrlo cuando cambia un CLI, cuando cambia el prompt del refinador o cuando
// alguien duda de los números del README. Los tests de la suite no llaman a
// ningún modelo — comprueban las decisiones, no las respuestas.

const path = require('path');
const refinador = require(path.join(__dirname, '..', '..', 'bridge', 'dictado-refinar.js'));
const engine = require(path.join(__dirname, '..', '..', 'bridge', 'engine.js'));

// Un dictado como sale de verdad del micrófono: sin puntuación, con muletillas,
// con una corrección en voz alta y con dos términos técnicos en inglés que NO
// se pueden traducir.
const CRUDO = 'eh a ver quiero un título arriba a la izquierda que diga configuración inicial ' +
  'este con la tipografía de la marca y que entre con un fade no perdón que entre con un fade ' +
  'y un leve movimiento hacia arriba y abajo una línea fina que se dibuje de izquierda a derecha ' +
  'y los keyframes suaves nada de rebotes';

// Lo que el editor ya tenía escrito en el campo: se refina JUNTO con lo dictado.
const PREVIO = 'Fondo transparente, duración 6 segundos.';

// Lo que no se puede perder ni traducir. No es un test automático: es la lista
// que hay que mirar a ojo en la salida.
const NO_SE_PUEDE_PERDER = ['configuración inicial', 'keyframe', 'fade', 'izquierda', '6 segundos'];

function revisar(texto) {
  const bajo = String(texto).toLowerCase();
  return NO_SE_PUEDE_PERDER.map(function (t) {
    return (bajo.indexOf(t.toLowerCase()) !== -1 ? '  ✓ ' : '  ✗ FALTA ') + t;
  }).join('\n');
}

async function unRefinador(cfg, id) {
  const quien = refinador._REFINADORES.filter(function (r) { return r.id === id; })[0];
  const d = await quien.detectar(cfg);
  if (!d.disponible) {
    console.log('\n=== ' + quien.nombre + ' → NO DISPONIBLE: ' + d.motivo);
    return;
  }
  const t0 = Date.now();
  let r;
  try {
    r = await quien.refinar(refinador._armarPedido(CRUDO, PREVIO), cfg, d.detalle);
  } catch (e) {
    console.log('\n=== ' + quien.nombre + ' → FALLÓ: ' + ((e && e.message) || e));
    return;
  }
  const ms = Date.now() - t0;
  const texto = refinador._limpiar(r.texto);
  const control = refinador._verificar(texto, PREVIO + ' ' + CRUDO);
  console.log('\n=== ' + quien.nombre + (d.detalle ? ' · ' + d.detalle : '') + ' → ' + (ms / 1000).toFixed(2) + ' s');
  console.log(texto);
  console.log(revisar(texto));
  console.log('  control de tamaño: ' + (control.ok ? 'pasa' : 'RECHAZA — ' + control.motivo));
  if (r.usage) {
    console.log('  tokens: ' + r.usage.totalInputTokens + '↑ ' + r.usage.outputTokens + '↓' +
      (typeof r.usage.costUsd === 'number' ? ' · $' + r.usage.costUsd.toFixed(4) : ' · costo no informado'));
  }
}

(async function () {
  const cfg = engine.getConfig();
  console.log('proveedor del panel: ' + cfg.provider + '  (el dictado NO lo usa: elige el suyo)');

  if (process.argv.indexOf('--todos') !== -1) {
    for (const r of refinador._REFINADORES) await unRefinador(cfg, r.id);
    return;
  }

  const cual = await refinador.elegirRefinador(cfg, { forzar: true });
  if (!cual) {
    console.log('\nNo hay refinador en esta máquina.');
    console.log(refinador.porQueNoHayRefinador());
    console.log('\nEl dictado igual funciona: deja el texto crudo en el campo.');
    return;
  }
  console.log('elegido: ' + cual.nombre + (cual.detalle ? ' · ' + cual.detalle : ''));
  cual.descartados.forEach(function (d) { console.log('  descartado ' + d.nombre + ': ' + d.motivo); });

  // Dos corridas: la primera puede pagar arranque (CLI, carga del modelo local).
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    const r = await refinador.refinarDictado({ crudo: CRUDO, previo: PREVIO }, cfg);
    console.log('\n--- corrida ' + (i + 1) + ' · ' + ((Date.now() - t0) / 1000).toFixed(2) + ' s' +
      (r.ok ? '' : '  (NO REFINÓ)'));
    console.log(r.texto);
    if (r.aviso) console.log('aviso: ' + r.aviso);
    console.log(revisar(r.texto));
    if (r.usage) {
      console.log('tokens: ' + r.usage.totalInputTokens + '↑ ' + r.usage.outputTokens + '↓' +
        (typeof r.usage.costUsd === 'number' ? ' · $' + r.usage.costUsd.toFixed(4) : ' · costo no informado'));
    }
  }
})().catch(function (e) { console.error(e); process.exit(1); });
