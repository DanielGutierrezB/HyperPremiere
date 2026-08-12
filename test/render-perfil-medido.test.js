'use strict';

// Con qué reparto de workers conviene renderizar en CADA máquina.
//
// Antes salía de una cuenta sobre la RAM y los cores. La cuenta da un número
// plausible y nadie había comprobado que fuera el bueno.
//
// El primer intento de comprobarlo fue medir con una composición de prueba antes
// del primer render. Se descartó por lo que mostró la propia medición: en este
// Mac dio 58,1s el reparto en paralelo contra 65,2s el de un worker, al revés de
// lo que había dado un banco de pruebas anterior en la misma máquina. La
// diferencia entre ambas fue el estado del equipo — la segunda con Premiere
// abierto y la carga en 7, que es justo cómo trabaja un editor. Una medición de
// una sola vez, tomada en un mal momento, queda grabada para siempre, y además
// le cuesta al editor minutos de espera antes de su primer render.
//
// Lo que quedó: aprender de los renders que el editor pide igual. Sale gratis,
// se mide sobre trabajo real, y ante la duda no se cambia nada.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq } = require('./harness');

const store = require('../bridge/store/render-profile');

const RAPIDO = { workers: 1, lowMemory: true };
const PARALELO = { workers: 3, lowMemory: false };
const CANDIDATOS = [PARALELO, RAPIDO]; // el orden importa: primero el de la cuenta vieja

/**
 * Corre algo con un HOME aparte, para no pisar lo aprendido en esta máquina —
 * que es justo el archivo del que depende la velocidad de los renders de quien
 * esté corriendo los tests.
 */
async function conHomeAparte(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-home-'));
  const antes = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  try {
    return await fn(tmp);
  } finally {
    if (antes.HOME === undefined) delete process.env.HOME; else process.env.HOME = antes.HOME;
    if (antes.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = antes.USERPROFILE;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

/** Anota N renders de un reparto, todos del mismo tamaño y duración. */
function anotar(perfil, veces, frames, ms) {
  let ganador = null;
  for (let i = 0; i < veces; i++) ganador = store.registrar(perfil, frames, ms) || ganador;
  return ganador;
}

// --- Qué se compara con qué ---------------------------------------------------

test('no se comparan marcadores de tamaños distintos', function () {
  // Un render corto está dominado por el arranque de Chrome y el encode: en este
  // Mac, ~40s fijos contra ~0,1s por fotograma. Comparar 120 fotogramas contra
  // 900 no dice cuál reparto es mejor, dice cuál marcador era más largo.
  ok(store.baldeDe(120) !== store.baldeDe(900), 'caen en grupos distintos');
  eq(store.baldeDe(120), store.baldeDe(280), 'y dos marcadores parecidos, en el mismo');
});

test('con datos de un solo reparto no se elige nada', function () {
  eq(store.elegir({ '3w-paralelo': [{ f: 400, ms: 50000 }] }), null);
});

test('con pocas corridas tampoco: una casualidad no es una medición', function () {
  const pocas = {
    '3w-paralelo': [{ f: 400, ms: 90000 }, { f: 400, ms: 90000 }],
    '1w-pantalla': [{ f: 400, ms: 30000 }, { f: 400, ms: 30000 }],
  };
  eq(store.elegir(pocas), null, 'con 2 de cada uno todavía no');
  pocas['3w-paralelo'].push({ f: 400, ms: 90000 });
  pocas['1w-pantalla'].push({ f: 400, ms: 30000 });
  eq(store.elegir(pocas), '1w-pantalla', 'con 3 y una diferencia así de clara, sí');
});

test('si los dos repartos nunca hicieron un marcador parecido, no se opina', function () {
  eq(store.elegir({
    '3w-paralelo': [{ f: 100, ms: 40000 }, { f: 100, ms: 41000 }, { f: 100, ms: 40500 }],
    '1w-pantalla': [{ f: 900, ms: 90000 }, { f: 900, ms: 91000 }, { f: 900, ms: 92000 }],
  }), null, 'no hay nada comparable, aunque haya muestras de sobra');
});

test('se compara el mejor tiempo de cada uno, no el promedio', function () {
  // Un backup corriendo o Premiere exportando solo pueden hacer las cosas más
  // lentas, nunca más rápidas: el mínimo es el número menos contaminado que hay.
  const conUnPicoDeCarga = {
    '3w-paralelo': [{ f: 400, ms: 30000 }, { f: 400, ms: 300000 }, { f: 400, ms: 310000 }],
    '1w-pantalla': [{ f: 400, ms: 50000 }, { f: 400, ms: 51000 }, { f: 400, ms: 52000 }],
  };
  eq(store.elegir(conUnPicoDeCarga), '3w-paralelo',
    'sus dos corridas malas no lo hunden: en su mejor momento fue más rápido');
});

test('una diferencia chica no alcanza para cambiar nada', function () {
  const casiIgual = {
    '3w-paralelo': [{ f: 400, ms: 58000 }, { f: 400, ms: 58500 }, { f: 400, ms: 59000 }],
    '1w-pantalla': [{ f: 400, ms: 62000 }, { f: 400, ms: 63000 }, { f: 400, ms: 62500 }],
  };
  eq(store.elegir(casiIgual), null,
    'un 7% se lo come el ruido de tener Premiere abierto: no es motivo para tocar nada');
});

test('un reparto que gana en cortos y pierde en largos no gana', function () {
  const contradictorio = {
    '3w-paralelo': [
      { f: 100, ms: 20000 }, { f: 100, ms: 21000 }, { f: 100, ms: 20500 },
      { f: 900, ms: 200000 },
    ],
    '1w-pantalla': [
      { f: 100, ms: 40000 }, { f: 100, ms: 41000 }, { f: 100, ms: 40500 },
      { f: 900, ms: 100000 },
    ],
  };
  eq(store.elegir(contradictorio), null,
    'eso no es "el mejor reparto", es un empate con más pasos');
});

test('para ganar hay que ganar en todos los tamaños comparables', function () {
  const parejo = {
    '3w-paralelo': [
      { f: 100, ms: 40000 }, { f: 100, ms: 41000 }, { f: 100, ms: 40500 },
      { f: 900, ms: 200000 },
    ],
    '1w-pantalla': [
      { f: 100, ms: 20000 }, { f: 100, ms: 21000 }, { f: 100, ms: 20500 },
      { f: 900, ms: 100000 },
    ],
  };
  eq(store.elegir(parejo), '1w-pantalla', 'gana en los dos: eso sí es una respuesta');
});

// --- Cómo junta los datos mientras trabaja ------------------------------------

test('mientras aprende, alterna los dos repartos', async function () {
  await conHomeAparte(function () {
    eq(store.siguienteAProbar(CANDIDATOS), PARALELO,
      'el primer render del día uno usa el reparto de siempre: nadie nota nada');
    store.registrar(PARALELO, 400, 90000);
    eq(store.siguienteAProbar(CANDIDATOS), RAPIDO, 'el segundo prueba el otro');
    store.registrar(RAPIDO, 400, 30000);
    eq(store.siguienteAProbar(CANDIDATOS), PARALELO, 'y así, para que junten evidencia pareja');
  });
});

test('una vez decidido, se usa siempre ése y se deja de probar', async function () {
  await conHomeAparte(function () {
    anotar(PARALELO, 3, 400, 90000);
    const ganador = anotar(RAPIDO, 3, 400, 30000);
    eq(ganador, '1w-pantalla', 'la tercera corrida cierra la comparación');

    const elegido = store.elegido(CANDIDATOS);
    ok(elegido, 'y queda elegido');
    eq(elegido.workers, 1);
    eq(elegido.lowMemory, true);

    const antes = JSON.stringify(store.leerCrudo().muestras);
    store.registrar(PARALELO, 400, 10000);
    eq(JSON.stringify(store.leerCrudo().muestras), antes,
      'lo que pase después ya no cambia la decisión: no se vuelve atrás sola');
  });
});

test('lo aprendido sobrevive al cierre de Premiere', async function () {
  await conHomeAparte(function () {
    anotar(PARALELO, 3, 400, 90000);
    anotar(RAPIDO, 3, 400, 30000);
    // Leer de nuevo es exactamente lo que pasa en la sesión siguiente.
    eq(store.leerCrudo().elegido, '1w-pantalla');
    ok(store.leerCrudo().decididoEl, 'con la fecha, para saber de cuándo es');
  });
});

test('lo aprendido en otra máquina no se usa acá', async function () {
  await conHomeAparte(function (tmp) {
    anotar(PARALELO, 3, 400, 90000);
    anotar(RAPIDO, 3, 400, 30000);
    const p = path.join(tmp, '.hyperpremiere', 'render-profile.json');
    const datos = JSON.parse(fs.readFileSync(p, 'utf8'));
    datos.fingerprint = 'otra-maquina|arm64|64|128';
    fs.writeFileSync(p, JSON.stringify(datos), 'utf8');
    eq(store.elegido(CANDIDATOS), null,
      'si el editor cambia de equipo o le suma RAM, se aprende de nuevo');
  });
});

test('un render sin fotogramas contados no ensucia la medición', async function () {
  await conHomeAparte(function () {
    store.registrar(PARALELO, 0, 50000);
    eq(store.leerCrudo(), null, 'sin saber el tamaño, ese tiempo no se puede comparar con nada');
  });
});

test('el archivo no crece para siempre', async function () {
  await conHomeAparte(function () {
    for (let i = 0; i < 20; i++) store.registrar(PARALELO, 400, 90000 + i);
    ok(store.leerCrudo().muestras['3w-paralelo'].length <= 12, 'se queda con las últimas');
  });
});

test('si no se puede escribir el archivo, el render no se cae', async function () {
  await conHomeAparte(function (tmp) {
    // Un HOME que no se puede escribir: pasa con perfiles corporativos.
    fs.writeFileSync(path.join(tmp, '.hyperpremiere'), 'esto no es una carpeta', 'utf8');
    store.registrar(PARALELO, 400, 90000);
    eq(store.elegido(CANDIDATOS), null, 'no aprende, pero tampoco explota');
  });
});

// --- Cómo lo usa el render ----------------------------------------------------

test('el reparto que se usa sale de lo aprendido, no de la RAM', async function () {
  await conHomeAparte(function () {
    delete require.cache[require.resolve('../bridge/render/hyperframes')];
    const hf = require('../bridge/render/hyperframes');
    const candidatos = [
      { workers: hf.workersPorHardware(), lowMemory: false },
      { workers: 1, lowMemory: true },
    ];
    if (candidatos[0].workers === 1) return; // máquina que solo aguanta uno: nada que decidir

    const primero = hf.pickRenderProfile();
    eq(primero.workers, candidatos[0].workers, 'arranca como siempre');
    ok(primero.midiendo, 'pero sabiendo que está midiendo');

    anotar(candidatos[0], 3, 400, 90000);
    anotar(candidatos[1], 3, 400, 30000);

    const despues = hf.pickRenderProfile();
    eq(despues.workers, 1, 'y después usa el que ganó en ESTA máquina');
    ok(despues.aprendido, 'sin volver a probar');
    ok(!despues.midiendo);
  });
});

test('los carriles no se mueven mientras se está midiendo', async function () {
  await conHomeAparte(function () {
    delete require.cache[require.resolve('../bridge/render/hyperframes')];
    const hf = require('../bridge/render/hyperframes');
    const durante = hf.renderLanes();
    anotar({ workers: hf.workersPorHardware(), lowMemory: false }, 3, 400, 90000);
    eq(hf.renderLanes(), durante,
      'si cambiaran de render en render, cada muestra se habría tomado con otra ' +
      'cantidad de Chrome al lado y no habría con qué comparar');
  });
});

test('un override a mano no se confunde con una medición', async function () {
  await conHomeAparte(function () {
    delete require.cache[require.resolve('../bridge/render/hyperframes')];
    const hf = require('../bridge/render/hyperframes');
    process.env.HYPERPREMIERE_WORKERS = '5';
    try {
      const p = hf.pickRenderProfile();
      eq(p.workers, 5, 'manda lo que pidió el editor');
      ok(!p.midiendo, 'y ese tiempo no se anota: no habla de ninguno de los candidatos');
    } finally {
      delete process.env.HYPERPREMIERE_WORKERS;
    }
  });
});
