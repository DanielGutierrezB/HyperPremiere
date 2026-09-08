'use strict';

// ¿Cuánto cuesta refinar un dictado con Cursor, de verdad?
//
// No corre en CI: gasta suscripción de Cursor y necesita una máquina con
// sesión.   node test/manual/cursor-refinado.js
//
// Existe porque la decisión de qué modelo se le pide a Cursor para refinar no
// se puede tomar de memoria: el CLI de Cursor arrastra su propio contexto de
// agente en CADA llamada (decenas de miles de tokens a caché) sin importar lo
// corto que sea el pedido, así que el modelo elegido cambia menos de lo que uno
// esperaría y lo que domina es el piso de arranque. Esto lo mide.
//
// `--modelos a,b,c` cambia la lista · `--vueltas 3` repite cada uno.

const dictado = require('../../bridge/dictado-refinar');
const cursor = require('../../bridge/providers/cursor-cli');

function arg(nombre, porDefecto) {
  const i = process.argv.indexOf(nombre);
  return (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : porDefecto;
}

const MODELOS = arg('--modelos', 'composer-2.5,auto,claude-sonnet-5-thinking-high').split(',');
const VUELTAS = Number(arg('--vueltas', '2'));

// Un dictado de verdad: con muletillas, una corrección en voz alta y términos
// técnicos en inglés. Es el caso para el que está escrito el manual.
const CRUDO = 'eh a ver quiero un lower third que entre desde la izquierda con un fade ' +
  'de medio segundo este con easing suave en los keyframes y que el nombre del invitado ' +
  'vaya en azul no mejor en blanco sobre un fondo oscuro semitransparente';

async function unaVuelta(model) {
  const t0 = Date.now();
  const r = await cursor.complete({
    systemPrompt: dictado.SISTEMA,
    userPrompt: dictado._armarPedido(CRUDO, '', 'dictado'),
    model: model,
    config: { timeoutMs: 120_000 },
  });
  const ms = Date.now() - t0;
  const u = (r && r.usage) || {};
  return {
    ms: ms,
    entrada: u.inputTokens || 0,
    salida: u.outputTokens || 0,
    cacheLee: u.cacheReadTokens || 0,
    cacheEscribe: u.cacheCreationTokens || 0,
    texto: String((r && r.text) || '').trim(),
  };
}

(async function () {
  for (const model of MODELOS) {
    console.log('\n═══ ' + model + ' ═══');
    for (let i = 1; i <= VUELTAS; i++) {
      try {
        const m = await unaVuelta(model);
        // El control de tamaño es el que decide si esto llega al campo del
        // editor o se descarta: medir la latencia sin medir eso sería elegir
        // por velocidad un modelo cuyo refinado el panel va a tirar.
        const limpio = dictado._limpiar(m.texto);
        const v = dictado._verificar(limpio, CRUDO);
        console.log('  vuelta ' + i + ': ' + (m.ms / 1000).toFixed(1) + ' s · ' +
          'entrada ' + m.entrada + ' · salida ' + m.salida +
          ' · caché lee ' + m.cacheLee + ' / escribe ' + m.cacheEscribe +
          ' · control ' + (v.ok ? 'PASA' : 'RECHAZA (' + v.motivo + ')'));
        console.log('  → ' + limpio.replace(/\n/g, ' '));
      } catch (e) {
        console.log('  vuelta ' + i + ': FALLÓ — ' + ((e && e.message) || e).slice(0, 300));
      }
    }
  }
})();
