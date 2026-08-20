'use strict';

// Un test que no falla cuando rompés el código no está probando nada.
//
// Este script mete a propósito cada regresión que los tests nuevos dicen cubrir,
// corre la suite, y avisa si alguna pasó igual. No corre en CI: se usa a mano
// cuando se toca esta parte.   node test/manual/mutaciones-render.js

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const raiz = path.join(__dirname, '..', '..');

const MUTACIONES = [
  {
    nombre: 'el render se manda igual con la composición rota',
    archivo: 'bridge/compose.js',
    de: '  if (best.problem) {\n    throw Object.assign(new Error(',
    a:  '  if (false && best.problem) {\n    throw Object.assign(new Error(',
  },
  {
    nombre: 'un error de composición se toma como problema de máquina',
    archivo: 'bridge/render/hyperframes.js',
    de: "  return /zero duration|this is permanent|root_missing_|missing `?data-composition-id/i\n    .test(String(salida || ''));",
    a:  "  return false;",
  },
  {
    nombre: 'la escalera reintenta igual un error permanente',
    archivo: 'bridge/render/hyperframes.js',
    de: '      if (esErrorDeComposicion(e.message)) {',
    a:  '      if (false) {',
  },
  {
    nombre: 'el perfil de otra máquina se usa igual',
    archivo: 'bridge/store/render-profile.js',
    de: "    if (!saved || saved.fingerprint !== fingerprint()) return null;",
    a:  "    if (!saved) return null;",
  },
  {
    nombre: 'el perfil de 1 worker no pide captura por pantalla',
    archivo: 'bridge/render/hyperframes.js',
    de: "    a.push('--low-memory-mode');",
    a:  "    a.push('--target-chunk-frames', '300');",
  },
  {
    nombre: 'se comparan marcadores de cualquier tamaño entre sí',
    archivo: 'bridge/store/render-profile.js',
    de: '  return Math.floor((frames || 0) / FOTOGRAMAS_POR_BALDE);',
    a:  '  return 0;',
  },
  {
    nombre: 'alcanza con una sola corrida de cada reparto',
    archivo: 'bridge/store/render-profile.js',
    de: 'const MUESTRAS_MINIMAS = 3;',
    a:  'const MUESTRAS_MINIMAS = 1;',
  },
  {
    nombre: 'cualquier diferencia, por chica que sea, cambia el reparto',
    archivo: 'bridge/store/render-profile.js',
    de: 'const VENTAJA_MINIMA = 0.10;',
    a:  'const VENTAJA_MINIMA = 0;',
  },
  {
    nombre: 'se compara el promedio en vez del mejor tiempo',
    archivo: 'bridge/store/render-profile.js',
    de: '      if (mejores[n][b] === undefined || m.ms < mejores[n][b]) mejores[n][b] = m.ms;',
    a:  '      if (mejores[n][b] === undefined || m.ms > mejores[n][b]) mejores[n][b] = m.ms;',
  },
  {
    nombre: 'gana el que ganó en un tamaño aunque pierda en otro',
    archivo: 'bridge/store/render-profile.js',
    de: '    if (ganador && ganador !== gana) return null; // se contradicen entre tamaños',
    a:  '    if (ganador && ganador !== gana) return ganador;',
  },
  {
    nombre: 'un render sin fotogramas contados se anota igual',
    archivo: 'bridge/store/render-profile.js',
    de: '  if (!(frames > 0) || !(ms > 0)) return null;',
    a:  '  if (false) return null;',
  },
  {
    nombre: 'los dos repartos no se alternan: siempre se prueba el mismo',
    archivo: 'bridge/store/render-profile.js',
    de: '    if (cuantas < menos) { menos = cuantas; mejor = c; }',
    a:  '    void cuantas;',
  },
  {
    nombre: 'los carriles se mueven en medio de la medición',
    archivo: 'bridge/render/hyperframes.js',
    de: '  if (p.aprendido && p.workers === 1) {',
    a:  '  if (p.workers === 1) {',
  },
  // El contador de tokens es el peor lugar para una regresión: sale un número
  // más chico y no hay nada que falle. Estas son las cinco formas de perderlo.
  {
    nombre: 'la entrada vuelve a ser solo el pedazo sin cachear',
    archivo: 'bridge/providers/index.js',
    de: '    totalInputTokens: entrada + cacheLeida + cacheEscrita,',
    a:  '    totalInputTokens: entrada,',
  },
  {
    nombre: 'a Cursor le renombran el campo de caché y nadie se entera',
    archivo: 'bridge/providers/cursor-cli.js',
    de: '        cacheCreationTokens: u.cacheWriteTokens,',
    a:  '        cacheCreationTokens: u.cacheCreationTokens,',
  },
  {
    nombre: 'un proveedor sin el total deja la entrada en cero',
    archivo: 'bridge/compose.js',
    de: '    usage.totalInputTokens += Number(u.totalInputTokens) ||\n' +
        '      // Un proveedor de otra versión puede no traerlo: se recompone.\n' +
        '      ((Number(u.inputTokens) || 0) + (Number(u.cacheReadTokens) || 0) + (Number(u.cacheCreationTokens) || 0));',
    a:  '    usage.totalInputTokens += Number(u.totalInputTokens) || 0;',
  },
  {
    nombre: 'el panel deja de acumular la caché escrita',
    archivo: 'cep/js/store.js',
    de: '      cur.cacheCreationTokens += Number(usage.cacheCreationTokens) || 0;',
    a:  '      void usage.cacheCreationTokens;',
  },
  {
    nombre: 'las generaciones sin costo cuentan como si lo hubieran informado',
    archivo: 'cep/js/store.js',
    de: "      if (typeof usage.costUsd === 'number') {",
    a:  '      if (true) {',
  },
  {
    nombre: 'la línea de la sesión vuelve a mostrar la entrada a medias',
    archivo: 'cep/js/util.js',
    de: '    var entrada = (u.inputTokens || 0) + cache;',
    a:  '    var entrada = (u.inputTokens || 0);',
  },
  {
    nombre: 'el acumulado viejo pasa por bien contado',
    archivo: 'cep/js/store.js',
    de: '          legacyMix: !!u.legacyMix || (Number(u.generations) > 0 && Number(u.rule) !== 2)',
    a:  '          legacyMix: false',
  },
  {
    nombre: 'con dólares y sin repartos se muestra "en 0 de 164"',
    archivo: 'cep/js/util.js',
    de: '    var reparto = u.costGenerations > 0 && u.costGenerations < gens;',
    a:  '    var reparto = u.costGenerations < gens;',
  },
  // Buscar la secuencia y, si no entró, poder colocarla después.
  {
    nombre: 'una secuencia ilegible vuelve a cortar la búsqueda',
    archivo: 'cep/jsx/host.jsx',
    de: '        } catch (eI) {\n            HP_SEQ_SCAN.ilegibles++;\n        }',
    a:  '        } catch (eI) { return null; }',
  },
  {
    nombre: 'con dos candidatas parecidas se elige una al azar',
    archivo: 'cep/jsx/host.jsx',
    de: '    if (casi && cuantasCasi === 1) return casi;',
    a:  '    if (casi) return casi;',
  },
  {
    nombre: 'no se avisa que la secuencia está en otro proyecto abierto',
    archivo: 'cep/jsx/host.jsx',
    de: '    HP_SEQ_SCAN.otroProyecto = hp_seqInOtherProject(want);',
    a:  '    HP_SEQ_SCAN.otroProyecto = "";',
  },
  {
    nombre: 'un render que no entró no queda marcado para colocarse',
    archivo: 'cep/js/queue.js',
    de: '      job.notPlaced = true;\n      job._movPath = res.movPath;',
    a:  '      job.notPlaced = false;\n      job._movPath = res.movPath;',
  },
  {
    nombre: 'la marca de "sin colocar" no se guarda y muere al cerrar el panel',
    archivo: 'cep/js/queue.js',
    de: '      notPlaced: j.notPlaced, _movPath: j._movPath, _placeColor: j._placeColor,',
    a:  '',
  },
  {
    nombre: 'los comentarios de Frame.io se vuelven a buscar solo por el nombre',
    archivo: 'cep/js/util.js',
    de: '    if (FRAMEIO_COMMENT_ID.test(comment) || FRAMEIO_COMMENT_ID.test(name)) return true;',
    a:  '',
  },
  {
    nombre: 'el filtro de Frame.io se pasa de listo y mira la palabra suelta',
    archivo: 'cep/js/util.js',
    de: '  var FRAMEIO_COMMENT_ID = /frame\\.?io[\\s_-]*comment[\\s_-]*id\\s*:/i;',
    a:  '  var FRAMEIO_COMMENT_ID = /frame\\.?io/i;',
  },
  {
    nombre: 'un recurso sin colocar de una versión anterior del panel no se reconoce',
    archivo: 'cep/js/queue.js',
    de: '    return /NO lo coloqu/.test(String(job.msg || ""));',
    a:  '    return false;',
  },
  {
    nombre: 'el video no se busca en el disco cuando el job no trae la ruta',
    archivo: 'cep/js/queue.js',
    de: '      if (r && r.ok && r.movPath) { job._movPath = r.movPath; return r.movPath; }',
    a:  '      if (false) { return ""; }',
  },
  {
    nombre: 'al recolocar, el color de la corrección se pierde',
    archivo: 'cep/js/queue.js',
    de: '      return hostPlace(job, mov, job._placeColor || COLOR_MAGENTA).then(function (place) {',
    a:  '      return hostPlace(job, mov, COLOR_MAGENTA).then(function (place) {',
  },
  // ── Mirar y rehacer desde la Cola (v1.4.45) ────────────────────────
  {
    nombre: 'el clic en el nombre vuelve a arrastrar el panel a Marcadores',
    archivo: 'cep/js/queue-view.js',
    de: 'top.addEventListener("click", (function (job) { return function (e) { e.stopPropagation(); deps.showJobInTimeline(job); }; })(j));',
    a:  'top.addEventListener("click", (function (job) { return function (e) { e.stopPropagation(); deps.goToJobMarker(job); }; })(j));',
  },
  {
    nombre: 'refinar con el cuadro vacío vuelve a rediseñar sin avisar',
    archivo: 'cep/js/queue-view.js',
    de: '      if (!t) {\n        deps.setOutput("Escribí qué ajustar para refinar, o usá “Regenerar desde cero”.", true);\n        return;\n      }',
    a:  '      if (false) { return; }',
  },
  {
    nombre: 'desde cero vuelve a dispararse de una, sin preguntar',
    archivo: 'cep/js/queue-view.js',
    de: '      }, "Regenerar desde cero", function () { closeFeedback(j.id); HPQueue.regenerateFresh(j.id); });',
    a:  '      }, "Regenerar desde cero", function () {});\n      closeFeedback(j.id); HPQueue.regenerateFresh(j.id);',
  },
  {
    nombre: 'la confirmación no aclara que el feedback escrito no se usa',
    archivo: 'cep/js/queue-view.js',
    de: '        if (t) {\n          var q = document.createElement("p");',
    a:  '        if (false) {\n          var q = document.createElement("p");',
  },
  {
    nombre: 'rediseñar desde cero arrastra la versión previa',
    archivo: 'cep/js/queue.js',
    de: '        delete j.payload.previousHtml;\n        delete j.payload.adjustment;\n        delete j.payload.stillsSend;\n        j.payload.mode = "regen";',
    a:  '        j.payload.mode = "regen";',
  },
  {
    nombre: 'al reencolar queda ofreciéndose el “Colocar” del render viejo',
    archivo: 'cep/js/queue.js',
    de: '    job.notPlaced = false; job._movPath = "";',
    a:  '    job.pct = 0;',
  },
  {
    nombre: 'el filtro de la cola muestra igual las otras secuencias',
    archivo: 'cep/js/queue-view.js',
    de: '      visibles = jobs.filter(function (j) { return j.seqName === actual; });',
    a:  '      visibles = jobs;',
  },
  {
    nombre: 'la preferencia del filtro no se recuerda',
    archivo: 'cep/js/queue-view.js',
    de: '    try { global.localStorage.setItem(ONLY_CURRENT_KEY, v ? "1" : "0"); } catch (e) {}',
    a:  '    try { void v; } catch (e) {}',
  },
];

// Solo los tests de esta parte: si corriera la suite entera, cualquier falla
// ajena haría parecer que la mutación fue atrapada.
const SUITES = ['render-no-imposible', 'render-perfil-medido', 'composicion-raiz',
  'rescate-composicion', 'contador-uso', 'colocar-secuencia-no-encontrada',
  'marcadores-frameio', 'cola-mirar-y-rehacer', 'correcciones-encolar'];

function correrSuite() {
  const guion = "const {runAll,group}=require('./test/harness');" +
    SUITES.map(function (s) { return "group('" + s + "');require('./test/" + s + ".test.js');"; }).join('') +
    'runAll();';
  try {
    const out = execFileSync('node', ['-e', guion], { cwd: raiz, encoding: 'utf8', stdio: 'pipe' });
    const m = out.match(/^Fallaron: (.+)$/m);
    return m ? m[1] : null; // runAll no corta el proceso: hay que mirar la salida
  } catch (e) {
    const salida = String(e.stdout || '') + String(e.stderr || '');
    const m = salida.match(/^Fallaron: (.+)$/m);
    return m ? m[1] : '(falló sin decir cuál)';
  }
}

let sobrevivientes = 0;
for (const mut of MUTACIONES) {
  const p = path.join(raiz, mut.archivo);
  const original = fs.readFileSync(p, 'utf8');
  if (original.indexOf(mut.de) === -1) {
    console.log('  ??   ' + mut.nombre + '  → el código cambió, esta mutación ya no aplica');
    continue;
  }
  fs.writeFileSync(p, original.replace(mut.de, mut.a), 'utf8');
  let atrapada;
  try {
    atrapada = correrSuite();
  } finally {
    fs.writeFileSync(p, original, 'utf8');
  }
  if (atrapada) {
    console.log('  ok   ' + mut.nombre + '\n         la atrapa: ' + atrapada);
  } else {
    sobrevivientes++;
    console.log('  SOBREVIVE  ' + mut.nombre + '  → nadie se dio cuenta');
  }
}

console.log('\n' + (MUTACIONES.length - sobrevivientes) + '/' + MUTACIONES.length + ' mutaciones atrapadas');
process.exitCode = sobrevivientes ? 1 : 0;
