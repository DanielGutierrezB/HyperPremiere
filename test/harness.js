'use strict';

// Corredor de tests mínimo.
//
// El motor no tiene dependencias (el ZXP viaja sin node_modules) y no va a
// tener una por los tests: acá alcanza con juntar funciones, correrlas y
// devolver 1 si alguna falla, que es lo que mira cualquiera que los corra.
//
//   node test/run.js

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
