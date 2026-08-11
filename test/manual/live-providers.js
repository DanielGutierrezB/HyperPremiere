'use strict';

// Prueba CONTRA LOS CLI DE VERDAD. No entra en `node test/run.js` porque
// gasta tokens, necesita sesión iniciada y tarda: se corre a mano cuando se
// toca el estado en vivo o cuando un CLI se actualiza y hay que ver si sigue
// hablando el mismo idioma.
//
//   node test/manual/live-providers.js            (los dos proveedores)
//   node test/manual/live-providers.js claude     (uno solo)
//
// Imprime, en orden, cada cosa que el proveedor fue contando mientras trabajaba
// —que es exactamente lo que va a leer el editor en la barra— y al final si la
// respuesta y el conteo de tokens llegaron enteros.
//
// Corre cada proveedor DOS veces: con el prompt por argumento (mac/Linux) y por
// stdin (lo que se usa en Windows, donde cmd.exe corta la línea a 8191). Las
// dos formas tienen que dar lo mismo: el prompt entra por un lado y el estado
// en vivo sale por el otro.

const PROMPT = 'Devolvé SOLO un HTML mínimo: un div con el texto "hola" centrado en negro. ' +
  'Sin explicaciones antes ni después.';

async function probar(nombre, mod, config) {
  const acts = [];
  const t0 = Date.now();
  process.stdout.write('\n── ' + nombre + ' ──\n');
  let r;
  try {
    r = await mod.generate({
      systemPrompt: 'Sos un generador de HTML. Contestá corto.',
      userPrompt: PROMPT,
      images: [],
      model: config.model,
      config: config,
      onActivity: function (a) {
        acts.push(a);
        process.stdout.write('   [' + String((Date.now() - t0) / 1000).slice(0, 4) + 's] ' + a.label + '\n');
      },
    });
  } catch (e) {
    console.log('   ERROR: ' + ((e && e.message) || e));
    return false;
  }
  const html = typeof r === 'string' ? r : r.text;
  const usage = (r && r.usage) || null;
  console.log('   avisos de estado: ' + acts.length);
  console.log('   respuesta: ' + (html ? html.length + ' caracteres' : 'VACÍA'));
  console.log('   tokens: ' + (usage ? usage.inputTokens + '↑ ' + usage.outputTokens + '↓' : 'NO LLEGARON'));
  console.log('   tardó: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  const ok = acts.length > 0 && !!html && !!usage;
  console.log('   → ' + (ok ? 'OK' : 'ALGO FALTÓ'));
  return ok;
}

async function main() {
  const cual = (process.argv[2] || '').toLowerCase();
  const resultados = [];
  if (!cual || cual === 'claude') {
    const claude = require('../../bridge/providers/claude-cli');
    resultados.push(await probar('claude-cli · prompt por argumento', claude,
      { model: 'claude-sonnet-4-5', effort: 'low', promptViaStdin: false, timeoutMs: 300000 }));
    resultados.push(await probar('claude-cli · prompt por STDIN (camino de Windows)', claude,
      { model: 'claude-sonnet-4-5', effort: 'low', promptViaStdin: true, timeoutMs: 300000 }));
  }
  if (!cual || cual === 'cursor') {
    const cursor = require('../../bridge/providers/cursor-cli');
    resultados.push(await probar('cursor-cli · prompt por argumento', cursor,
      { model: 'claude-sonnet-5-thinking-high', promptViaStdin: false, timeoutMs: 600000 }));
    resultados.push(await probar('cursor-cli · prompt por STDIN (camino de Windows)', cursor,
      { model: 'claude-sonnet-5-thinking-high', promptViaStdin: true, timeoutMs: 600000 }));
  }
  const malas = resultados.filter((x) => !x).length;
  console.log('\n' + (resultados.length - malas) + '/' + resultados.length + ' corridas completas');
  if (malas) process.exitCode = 1;
}

main();
