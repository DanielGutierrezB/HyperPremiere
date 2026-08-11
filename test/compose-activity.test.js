'use strict';

// Que lo que el CLI cuenta llegue efectivamente al sobre que mira el panel, y
// que dos marcadores generándose a la vez no se mezclen el estado. La cola
// corre varios diseños en paralelo (⚙ "Diseños en paralelo"), así que esto no
// es teórico: es el bug de "el marcador 3 mostraba lo que estaba haciendo el 5".

const { test, ok, eq } = require('./harness');
const { composeAnimation } = require('../bridge/compose');

// La composición más chica que pasa el contrato (ver composition.js): no
// interesa el diseño, interesa que compose siga su camino normal.
function html(id) {
  return '<html><body><div id="stage" data-composition-id="' + id + '" data-start="0" ' +
    'data-width="1920" data-height="1080" data-duration="3.00" data-fps="30"></div>' +
    '<script>const tl=1;window.__timelines["' + id + '"]=tl;</script></body></html>';
}

/** Proveedor de mentira que cuenta N pasos antes de contestar. */
function proveedorQueCuenta(id, pasos) {
  return {
    generate: async function (o) {
      for (let i = 0; i < pasos; i++) {
        await new Promise((r) => setTimeout(r, 1));
        o.onActivity({ phase: 'thinking', label: id + ' paso ' + (i + 1), tokens: i * 10, chars: 0 });
      }
      return { text: html(id), usage: { inputTokens: 10, outputTokens: 20 } };
    },
  };
}

/** Proveedor que NO sabe contar nada (API directa, Ollama): ignora onActivity. */
const proveedorMudo = {
  generate: async function () {
    return { text: html('mudo'), usage: { inputTokens: 1, outputTokens: 2 } };
  },
};

function correr(provider, report) {
  return composeAnimation({
    provider: provider,
    config: { model: 'modelo-de-prueba', provider: 'test' },
    systemPrompt: 'sistema', userPrompt: 'usuario', images: [],
    durationSec: 3, markerSlug: 'marcador-1', report: report,
  });
}

test('lo que el modelo va haciendo llega al panel mientras trabaja', async function () {
  const sobres = [];
  const r = await correr(proveedorQueCuenta('A', 3), function (p) { sobres.push(p); });
  ok(r.html.indexOf('id="stage"') > 0, 'la composición vuelve entera');
  const conAct = sobres.filter(function (p) { return p.act; });
  eq(conAct.length, 3, 'los tres pasos llegaron');
  eq(conAct[0].act.label, 'A paso 1');
  // El estado en vivo va en su propio campo: no puede pisar el mensaje de la
  // etapa ("Diseñando la animación con X…") ni el porcentaje de la barra.
  conAct.forEach(function (p) {
    eq(p.msg, undefined, 'no toca el mensaje de la etapa');
    eq(p.pct, undefined, 'no toca la barra');
  });
});

test('al terminar la llamada, la línea se borra en vez de quedar colgada', async function () {
  const sobres = [];
  await correr(proveedorQueCuenta('A', 2), function (p) { sobres.push(p); });
  const ultimoAct = sobres.filter(function (p) {
    return Object.prototype.hasOwnProperty.call(p, 'act');
  }).pop();
  eq(ultimoAct.act, null, 'lo último que se manda es "ya no está haciendo nada"');
});

test('un proveedor que no sabe contar igual genera', async function () {
  const sobres = [];
  const r = await correr(proveedorMudo, function (p) { sobres.push(p); });
  ok(r.html.length > 0, 'la generación sale igual');
  ok(!sobres.some(function (p) { return p.act; }), 'no se inventa ningún estado');
});

test('dos marcadores a la vez no se mezclan el estado', async function () {
  const a = [], b = [];
  await Promise.all([
    correr(proveedorQueCuenta('A', 5), function (p) { if (p.act) a.push(p.act.label); }),
    correr(proveedorQueCuenta('B', 5), function (p) { if (p.act) b.push(p.act.label); }),
  ]);
  eq(a.length, 5, 'el primero vio sus cinco pasos');
  eq(b.length, 5, 'el segundo también');
  ok(a.every(function (l) { return l.charAt(0) === 'A'; }), 'ninguno ajeno se le coló al primero');
  ok(b.every(function (l) { return l.charAt(0) === 'B'; }), 'ni al segundo');
});

test('si la vista falla al dibujar, la generación no se cae', async function () {
  // El estado en vivo es decoración: un error pintando el cartelito no puede
  // tirar abajo un diseño de tres minutos.
  const r = await correr(proveedorQueCuenta('A', 2), function () {
    throw new Error('la vista explotó');
  });
  ok(r.html.length > 0, 'la composición vuelve igual');
});
