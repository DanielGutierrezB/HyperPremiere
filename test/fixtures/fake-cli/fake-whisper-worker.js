#!/usr/bin/env node
'use strict';

// El proceso persistente de Whisper, de mentira.
//
// Habla el mismo protocolo que `bridge/dictado-whisper.py` —JSON por líneas
// sobre stdin/stdout— sin cargar medio giga de modelo. Se lo pasa como si fuera
// el intérprete de Python: `spawn(python, [guion, modelo, idioma])`, y este
// ignora los tres argumentos.
//
// Es la única forma de probar de verdad lo que importa del proceso persistente:
// que se levante UNA vez y no una por frase, que se baje solo por inactividad,
// y que un buffer más grande no sea una llamada nueva sino la misma ventana
// otra vez. Con el Whisper real eso serían minutos de test y una máquina con
// mlx instalado.
//
// FAKE_WHISPER_LOG: archivo donde deja una línea por evento (arranque,
//   cada transcripción, el chau). Contar líneas de "arranque" ES el test.
// FAKE_WHISPER_MODO:
//   'ok'          (por defecto) transcribe: devuelve el largo del PCM en texto.
//   'muere'       se cierra sin decir que está listo (Whisper que no carga).
//   'falla-una'   la primera transcripción devuelve error, las demás andan.
//   'alucina'     devuelve "¡Suscríbete!", que es lo que inventa en el silencio.

const fs = require('fs');

const modo = process.env.FAKE_WHISPER_MODO || 'ok';
const log = process.env.FAKE_WHISPER_LOG;

function anotar(linea) {
  if (log) { try { fs.appendFileSync(log, linea + '\n'); } catch (e) {} }
}

anotar('arranque');

if (modo === 'muere') {
  process.stderr.write('no pude importar mlx_whisper\n');
  process.exit(1);
}

process.stdout.write(JSON.stringify({ listo: true, ms: 42 }) + '\n');

let pedidos = 0;
let resto = '';

process.stdin.on('data', (c) => {
  resto += c;
  let i;
  while ((i = resto.indexOf('\n')) !== -1) {
    const linea = resto.slice(0, i);
    resto = resto.slice(i + 1);
    if (!linea.trim()) continue;
    let msg;
    try { msg = JSON.parse(linea); } catch (e) { continue; }

    if (msg.cmd === 'chau') { anotar('chau'); process.exit(0); }

    pedidos++;
    const bytes = fs.existsSync(msg.pcm) ? fs.statSync(msg.pcm).size : 0;
    anotar('transcribir ' + bytes);

    if (modo === 'falla-una' && pedidos === 1) {
      process.stdout.write(JSON.stringify({ id: msg.id, error: 'se cayó esta pasada' }) + '\n');
      continue;
    }
    const texto = modo === 'alucina'
      ? '¡Suscríbete!'
      // El texto crece con el buffer, como el de verdad: así el test puede
      // afirmar que se manda la ventana ENTERA y no solo lo nuevo.
      : 'palabra'.repeat(1) + ' ' + bytes;
    process.stdout.write(JSON.stringify({ id: msg.id, texto: texto, ms: 7, segundos: bytes / 32000 }) + '\n');
  }
});
