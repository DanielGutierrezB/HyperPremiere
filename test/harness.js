'use strict';

// Corredor de tests mínimo.
//
// El motor no tiene dependencias (el ZXP viaja sin node_modules) y no va a
// tener una por los tests: acá alcanza con juntar funciones, correrlas y
// devolver 1 si alguna falla, que es lo que mira cualquiera que los corra.
//
//   node test/run.js

// LOS TESTS NO CORREN EN LA CASA DEL EDITOR.
//
// `~/.hyperpremiere/config.json` es la configuración del panel del editor que
// está corriendo la suite, y los tests la tocaban por los dos lados:
//
//  - ESCRIBIENDO. Tres tests llamaban a `engine.setConfig` y le dejaban al
//    editor un `apiKey: "sk-nueva"` y un modelo `"falso"`. No falla nada: pasa
//    en verde y deja el panel generando con otra cosa.
//  - LEYENDO, que es lo que apareció después y es peor. Desde que ⚙ elige el
//    motor de animación, cinco tests que ni hablan de motores empezaron a
//    fallar en cuanto el editor eligió Remotion: le mandaban al modelo de
//    mentira un HTML de GSAP y el motor —Remotion, porque así decía la config—
//    contestaba "esto no es un componente de React". Cinco fallas que no tenían
//    nada que ver con lo que esos tests prueban, y ninguna reproducible en otra
//    máquina.
//
// Los dos son el mismo problema: un test que mira la config del editor mide
// distinto en cada máquina. Y los archivos que lo sufrieron ya se habían
// esforzado en lo contrario —reemplazan los CINCO proveedores para no depender
// de cuál diga la config— así que el arreglo no es parchear esos cinco tests,
// es que la casa que ven los tests no sea la del editor.
//
// Va acá y no en `run.js` porque el corredor de mutaciones arma su propio guion
// y no pasa por ahí; por `harness` pasan los dos. Y va al CARGAR el módulo,
// antes de que se requiera un solo archivo de test, porque algunos leen cosas
// al cargarse.
//
// Un test que necesite una casa propia se la sigue armando (varios lo hacen):
// guardan HOME, lo cambian y lo restauran, y lo que restauran es esta.
(function casaDeJuguete() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-tests-home-'));
  process.env.HOME = casa;
  process.env.USERPROFILE = casa;
})();

const tests = [];
let grupo = '';

/** El corredor avisa qué archivo está cargando, para agrupar la salida. */
function group(name) { grupo = name; }

function test(name, fn) { tests.push({ grupo: grupo, name: name, fn: fn }); }

function fail(what, detail) {
  const e = new Error(what + (detail ? '\n      ' + detail : ''));
  e.assertion = true;
  throw e;
}

function ok(cond, what) {
  if (!cond) fail(what || 'se esperaba algo verdadero');
}

function eq(actual, expected, what) {
  if (actual !== expected) {
    fail(what || 'valores distintos',
      'esperado: ' + JSON.stringify(expected) + '\n      obtenido: ' + JSON.stringify(actual));
  }
}

function deepEq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(what || 'estructuras distintas', 'esperado: ' + b + '\n      obtenido: ' + a);
}

/** `haystack` contiene `needle` (para textos que se muestran al editor). */
function has(haystack, needle, what) {
  if (String(haystack).indexOf(needle) === -1) {
    fail(what || 'falta el texto', 'buscado: ' + JSON.stringify(needle) +
      '\n      en: ' + JSON.stringify(String(haystack).slice(0, 200)));
  }
}

async function runAll() {
  let pass = 0;
  let ultimoGrupo = null;
  const fails = [];
  for (const t of tests) {
    if (t.grupo !== ultimoGrupo) { ultimoGrupo = t.grupo; console.log('\n' + t.grupo); }
    try {
      await t.fn();
      pass++;
      console.log('  ok   ' + t.name);
    } catch (e) {
      fails.push(t.name);
      console.log('  FALLA ' + t.name);
      console.log('      ' + (e && e.assertion ? e.message : (e && e.stack) || e));
    }
  }
  console.log('\n' + pass + '/' + tests.length + ' tests OK');
  if (fails.length) {
    console.log('Fallaron: ' + fails.join(', '));
    process.exitCode = 1;
  }
}

module.exports = { test, group, runAll, ok, eq, deepEq, has };
