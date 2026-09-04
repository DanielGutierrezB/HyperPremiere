'use strict';

// Dicta de VERDAD por el micrófono de esta máquina, sin Premiere y sin panel:
// abre el micrófono con el motor, muestra el texto parcial como lo vería el
// editor, para a los N segundos y refina.
//
//   node test/manual/dictado-real.js            # 15 s de dictado
//   node test/manual/dictado-real.js 30         # 30 s
//   node test/manual/dictado-real.js 20 "lo que ya estaba escrito en el campo"
//
// Es la única forma de comprobar la cadena completa (micrófono → ffmpeg →
// Whisper persistente → refinador) sin abrir Premiere. Los tests de la suite
// no tocan el micrófono ni llaman a ningún modelo: prueban las decisiones.

const path = require('path');
const engine = require(path.join(__dirname, '..', '..', 'bridge', 'engine.js'));

const SEGUNDOS = Number(process.argv[2]) || 15;
const PREVIO = process.argv[3] || '';

(async function () {
  const estado = await engine.dictadoEstado();
  console.log('plataforma: ' + estado.plataforma + ' · modelo: ' + estado.modelo);
  console.log('disponible: ' + estado.disponible + (estado.motivo ? ' — ' + estado.motivo : ''));
  console.log('refinador: ' + (estado.refinador || 'NINGUNO — ' + estado.sinRefinador));
  if (estado.faltaBajarModelo) console.log('OJO: el modelo todavía no está bajado, la primera vuelta tarda.');
  if (!estado.disponible) return;
  if (PREVIO) console.log('ya escrito en el campo: ' + JSON.stringify(PREVIO));

  console.log('\n=== HABLÁ AHORA (' + SEGUNDOS + ' s) ===\n');
  const t0 = Date.now();
  setTimeout(function () { engine.dictadoParar({ id: 'prueba' }); }, SEGUNDOS * 1000);

  const r = await engine.dictadoArrancar({ id: 'prueba' }, function (p) {
    if (p.msg) console.log('  · ' + p.msg);
    if (p.note) console.log('  [log] ' + p.note);
    if (p.dictado) {
      console.log('  t+' + ((Date.now() - t0) / 1000).toFixed(1) + 's (' +
        p.dictado.segundos.toFixed(1) + 's de audio, retraso ' +
        (((Date.now() - t0) / 1000) - p.dictado.segundos).toFixed(1) + 's)');
      console.log('     ' + p.dictado.texto);
    }
  });

  if (!r.ok) { console.log('\nNO SE PUDO: ' + r.error); return; }
  console.log('\n=== CRUDO (' + r.segundos.toFixed(1) + ' s · ' + r.vueltas + ' pasadas · ' +
    (r.msInferencia / 1000).toFixed(2) + ' s de inferencia) ===');
  console.log(r.crudo);

  const t1 = Date.now();
  const ref = await engine.dictadoRefinar({ crudo: r.crudo, previo: PREVIO });
  console.log('\n=== REFINADO (' + ((Date.now() - t1) / 1000).toFixed(2) + ' s · ' +
    (ref.refinador || 'sin refinador') + ') ===');
  console.log(ref.texto);
  if (ref.aviso) console.log('\naviso: ' + ref.aviso);
  if (ref.usage) {
    console.log('tokens del refinado: ' + ref.usage.totalInputTokens + '↑ ' + ref.usage.outputTokens + '↓');
  }
  process.exit(0);
})().catch(function (e) { console.error(e); process.exit(1); });
