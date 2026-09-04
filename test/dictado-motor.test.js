'use strict';

// El dictado, del lado del motor: la compuerta de silencio y el proceso
// persistente de Whisper.
//
// Lo que NO se prueba acá, y por qué
// ----------------------------------
// El micrófono. Abrir avfoundation necesita un micrófono de verdad y el permiso
// de macOS, así que un test que lo intente falla en cualquier máquina que no
// sea ésta y no prueba nada de lo que puede romperse. Se probó a mano, con
// audio real, y el número está en el reporte. Lo que sí se prueba es todo lo
// que hay ALREDEDOR: qué se decide con el audio que entra, qué se le manda al
// modelo y qué pasa cuando el modelo no está.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq, has } = require('./harness');
const dictado = require('../bridge/dictado');
// Las referencias a los procesos vivos no están en variables de módulo: viven
// en `process`, para que sobrevivan al ⟳ del panel (ver bridge/vivos.js).
const vivos = require('../bridge/vivos');

const FAKE_WORKER = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-whisper-worker.js');
// Los procesos de mentira son scripts con shebang: en Windows no arrancan solos.
const saltarEnWindows = process.platform === 'win32';

/** PCM s16le mono de `segundos` a un nivel dado (0..1). */
function pcm(segundos, nivel) {
  const n = Math.round(16000 * segundos);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    // Una onda, no un valor fijo: el RMS de una constante no se parece al de
    // una señal, y acá lo que se mide es el RMS.
    buf.writeInt16LE(Math.round(Math.sin(i / 4) * nivel * 32767), i * 2);
  }
  return buf;
}

// --- 1. La compuerta de silencio ---------------------------------------------
// Es la decisión que evita el "! las las las las" en la instrucción del editor.

test('no se manda a transcribir una sala en silencio', function () {
  // El nivel medido en esta sala con nadie hablando: -40 dBFS.
  const r = dictado._convieneTranscribir({
    rmsTotal: 0.01, rmsNuevo: 0.01, segundosNuevos: 2, hayTexto: false,
  });
  ok(!r.transcribir, 'sobre el silencio Whisper inventa frases: no se lo llama');
  has(r.motivo, 'silencio');
  has(r.motivo, 'dBFS', 'y se dice el nivel, que es lo que el editor puede corregir');
});

test('el habla pasa la compuerta con margen', function () {
  // Medido acá hablándole al micrófono: RMS 0,078 a 0,089.
  ok(dictado._convieneTranscribir({
    rmsTotal: 0.078, rmsNuevo: 0.078, segundosNuevos: 2, hayTexto: false,
  }).transcribir, 'el habla más floja que se midió tiene que entrar');
});

test('el silencio de alguien pensando no rehace la transcripción', function () {
  // Ya habló, ahora se quedó callado. El texto volvería idéntico: la vuelta se
  // ahorra entera, que es la mitad del presupuesto de inferencia de un dictado.
  const r = dictado._convieneTranscribir({
    rmsTotal: 0.08, rmsNuevo: 0.003, segundosNuevos: 2, hayTexto: true,
  });
  ok(!r.transcribir);
  has(r.motivo, 'el texto no cambiaría');
});

test('pero si todavía no hay texto, el silencio nuevo no alcanza para saltear', function () {
  // Sin texto todavía, saltear la vuelta es dejar el campo vacío mientras el
  // editor ya habló: si lo acumulado suena, se transcribe aunque el último
  // pedazo sea la pausa entre dos frases.
  ok(dictado._convieneTranscribir({
    rmsTotal: 0.08, rmsNuevo: 0.003, segundosNuevos: 2, hayTexto: false,
  }).transcribir);
});

test('sin audio nuevo no se gasta una pasada', function () {
  const r = dictado._convieneTranscribir({
    rmsTotal: 0.08, rmsNuevo: 0.08, segundosNuevos: 0.2, hayTexto: true,
  });
  ok(!r.transcribir, 'con dos décimas de audio nuevo el texto vuelve igual');
  has(r.motivo, 'audio nuevo');
});

test('el umbral está donde se midió y no en cualquier lado', function () {
  // No es un número de adorno: entre el ruido de sala más fuerte que se midió
  // (0,0144) y el habla más floja (0,078) hay un factor de cinco, y el umbral
  // tiene que caer adentro de esa ventana. Si alguien lo baja "para que agarre
  // más", vuelve el "¡Suscríbete!".
  ok(dictado.RMS_MINIMO > 0.0144, 'tiene que rechazar el ruido de sala medido');
  ok(dictado.RMS_MINIMO < 0.078, 'y aceptar el habla medida');
});

// --- 2. Las alucinaciones que igual se cuelan --------------------------------

test('se descarta lo que Whisper inventa sobre el silencio', function () {
  ok(dictado._esAlucinacionDeSilencio('¡Suscríbete!'), 'la que apareció probando esto');
  ok(dictado._esAlucinacionDeSilencio('Gracias por ver el video.'));
  ok(dictado._esAlucinacionDeSilencio('Subtítulos realizados por la comunidad de Amara.org'));
  ok(dictado._esAlucinacionDeSilencio('! las las las las las las'),
    'una palabra sola repetida: la otra forma que tiene de alucinar');
});

test('un dictado de verdad que dice "gracias" no se pierde', function () {
  ok(!dictado._esAlucinacionDeSilencio('gracias por el dato, ponelo abajo a la derecha'),
    'descartar por CONTENER la palabra se llevaría puesto un dictado real');
  ok(!dictado._esAlucinacionDeSilencio('no no no, mejor que entre de la izquierda'),
    'repetir tres veces es alguien corrigiéndose, no una alucinación');
  ok(!dictado._esAlucinacionDeSilencio(''), 'lo vacío no es una alucinación, es nada');
});

// --- 3. Windows y las dependencias que faltan --------------------------------

test('en Windows el botón se apaga DICIENDO por qué', function () {
  const v = dictado._veredicto({ plataforma: 'win32', ffmpeg: true, whisper: { style: 'mlx' }, python: 'p' });
  ok(!v.disponible);
  has(v.motivo, 'solo para Mac');
  has(v.motivo, 'avfoundation', 'con el motivo técnico: no es un capricho');
  has(v.motivo, 'a mano', 'y qué hacer mientras tanto');
});

test('sin ffmpeg se dice cómo instalarlo, no "error"', function () {
  const v = dictado._veredicto({ plataforma: 'darwin', ffmpeg: false, whisper: { style: 'mlx' }, python: 'p' });
  ok(!v.disponible);
  has(v.motivo, 'brew install ffmpeg');
});

test('con el Whisper de las clases pero sin mlx, el dictado no se prende', function () {
  // `faster-whisper` sirve para transcribir una clase entera, pero no se puede
  // dejar cargado entre frase y frase, que es de lo que depende esto.
  const v = dictado._veredicto({ plataforma: 'darwin', ffmpeg: true, whisper: { style: 'faster' }, python: 'p' });
  ok(!v.disponible);
  has(v.motivo, 'mlx-whisper');
  has(v.motivo, 'Instalar Whisper', 'con el botón que ya existe en ⚙');
});

test('con todo en su lugar, se puede dictar', function () {
  const v = dictado._veredicto({ plataforma: 'darwin', ffmpeg: true, whisper: { style: 'mlx' }, python: '/usr/bin/python3' });
  ok(v.disponible);
  eq(v.motivo, '');
});

// --- 4. El permiso de macOS, que es el error que más se va a ver -------------

test('el error de permiso explica que el diálogo dice "Adobe Premiere Pro"', function () {
  const m = dictado._leerErrorDeFfmpeg('[avfoundation @ 0x14] Input/output error');
  has(m, 'Privacidad y seguridad');
  has(m, 'Adobe Premiere Pro',
    'el permiso lo pide Premiere: buscando "HyperPremiere" no lo va a encontrar nunca');
  has(m, 'reiniciá Premiere');
});

// --- 5. El Python de mlx_whisper --------------------------------------------

test('el intérprete se saca del shebang, no de adivinar', function () {
  // El PATH del panel adentro de Premiere no es el del editor, así que un
  // `which python3` puede devolver uno que no tenga el paquete instalado.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-test-'));
  const falso = path.join(dir, 'mlx_whisper');
  fs.writeFileSync(falso, '#!' + process.execPath + '\n# -*- coding: utf-8 -*-\n');
  eq(dictado._pythonDeWhisper(falso), process.execPath);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('un shebang que apunta a un Python que ya no está no se devuelve', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-test-'));
  const falso = path.join(dir, 'mlx_whisper');
  fs.writeFileSync(falso, '#!/no/existe/python3.14\n');
  eq(dictado._pythonDeWhisper(falso), '', 'devolverlo sería spawnear algo que no existe');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- 6. El proceso persistente ----------------------------------------------
// Lo que hace que esto funcione: cada invocación del CLI de Whisper tiene un
// piso de ~1,2 s que no baja aunque el audio dure tres segundos.

/** Corre `fn` con el worker de mentira, y devuelve las líneas que dejó. */
async function conWorker(modo, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-worker-'));
  const log = path.join(dir, 'eventos.txt');
  const previos = {
    modo: process.env.FAKE_WHISPER_MODO,
    log: process.env.FAKE_WHISPER_LOG,
    ocio: process.env.HYPERPREMIERE_DICTADO_INACTIVIDAD_MS,
  };
  process.env.FAKE_WHISPER_MODO = modo;
  process.env.FAKE_WHISPER_LOG = log;
  // 250 ms en vez de los cinco minutos de verdad: es el mismo camino de código.
  process.env.HYPERPREMIERE_DICTADO_INACTIVIDAD_MS = '250';
  try {
    await fn({ python: FAKE_WORKER });
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  } finally {
    dictado.bajarMotor('fin del test');
    Object.keys(previos).forEach(function (k) {
      const env = { modo: 'FAKE_WHISPER_MODO', log: 'FAKE_WHISPER_LOG', ocio: 'HYPERPREMIERE_DICTADO_INACTIVIDAD_MS' }[k];
      if (previos[k] === undefined) delete process.env[env]; else process.env[env] = previos[k];
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('el proceso de Whisper se levanta UNA vez, no una por frase', async function () {
  if (saltarEnWindows) return console.log('      (se saltea en Windows: el worker de mentira es un script con shebang)');
  const eventos = await conWorker('ok', async function (maquina) {
    await dictado._arrancarMotor(maquina);
    await dictado._transcribirBuffer(pcm(2, 0.1));
    await dictado._arrancarMotor(maquina);
    await dictado._transcribirBuffer(pcm(4, 0.1));
    await dictado._transcribirBuffer(pcm(6, 0.1));
  });
  eq(eventos.filter((l) => l === 'arranque').length, 1,
    'tres transcripciones, un solo arranque: es toda la razón de ser del proceso persistente');
  eq(eventos.filter((l) => l.startsWith('transcribir')).length, 3);
});

test('se le manda el buffer ENTERO cada vez, no lo nuevo', async function () {
  if (saltarEnWindows) return;
  const eventos = await conWorker('ok', async function (maquina) {
    await dictado._arrancarMotor(maquina);
    await dictado._transcribirBuffer(pcm(2, 0.1));
    await dictado._transcribirBuffer(pcm(4, 0.1));
  });
  const bytes = eventos.filter((l) => l.startsWith('transcribir')).map((l) => Number(l.split(' ')[1]));
  eq(bytes[0], 2 * 32000, 'dos segundos');
  eq(bytes[1], 4 * 32000,
    'cuatro, no dos: la ventana completa es lo que hace que la frase se auto-corrija');
});

test('sin usarse un rato, el proceso se baja solo', async function () {
  if (saltarEnWindows) return;
  const eventos = await conWorker('ok', async function (maquina) {
    await dictado._arrancarMotor(maquina);
    await dictado._transcribirBuffer(pcm(1, 0.1));
    ok(dictado._motorVivo(), 'recién usado, sigue arriba');
    await esperar(600); // el ocio está en 250 ms
    ok(!dictado._motorVivo(), 'son ~500 MB de modelo residentes por algo que se usa a ráfagas');
  });
  has(eventos.join('\n'), 'chau', 'y se le pide que cierre, no se lo mata de entrada');
});

test('usarlo rearma el reloj: no se baja en la mitad de un dictado', async function () {
  if (saltarEnWindows) return;
  await conWorker('ok', async function (maquina) {
    await dictado._arrancarMotor(maquina);
    for (let i = 0; i < 4; i++) {
      await esperar(150); // menos que los 250 de ocio, cuatro veces seguidas
      await dictado._transcribirBuffer(pcm(1 + i, 0.1));
    }
    ok(dictado._motorVivo(), 'seiscientos milisegundos de uso continuo y sigue arriba');
  });
});

test('si Whisper no carga, se dice y no se cuelga esperando', async function () {
  if (saltarEnWindows) return;
  let error = '';
  await conWorker('muere', async function (maquina) {
    try { await dictado._arrancarMotor(maquina); } catch (e) { error = (e && e.message) || String(e); }
  });
  has(error, 'Whisper', 'el motivo tiene que llegar al panel: es lo que se muestra en el botón');
});

test('una pasada que falla no se lleva puesto el dictado', async function () {
  if (saltarEnWindows) return;
  await conWorker('falla-una', async function (maquina) {
    await dictado._arrancarMotor(maquina);
    let fallo = false;
    try { await dictado._transcribirBuffer(pcm(2, 0.1)); } catch (e) { fallo = true; }
    ok(fallo, 'la primera falla');
    const r = await dictado._transcribirBuffer(pcm(4, 0.1));
    ok(r.texto, 'y la siguiente sigue andando: el buffer no se perdió');
  });
});

test('el proceso de Whisper se lanza como LÍDER DE GRUPO, o killTree no lo mata entero', async function () {
  if (saltarEnWindows) return;
  await conWorker('ok', async function (maquina) {
    await dictado._arrancarMotor(maquina);
    const proc = vivos._cajas().dictado.motor.proc;
    // `killTree` mata el GRUPO (`process.kill(-pid)`), y en POSIX un grupo con
    // ese id existe solo si el hijo es su líder — o sea, si se lo lanzó con
    // `detached`. Sin eso, ese kill falla y killTree degrada en silencio a
    // `child.kill()`: muere el intérprete y quedan vivos los workers que mlx
    // levanta abajo, con el modelo en memoria.
    let hayGrupo = true;
    try { process.kill(-proc.pid, 0); } catch (e) { hayGrupo = false; }
    ok(hayGrupo, 'el hijo tiene que ser líder de su propio grupo de procesos');
  });
});

test('bajar el proceso rechaza lo que estaba esperando, no lo deja colgado', async function () {
  if (saltarEnWindows) return;
  await conWorker('ok', async function (maquina) {
    await dictado._arrancarMotor(maquina);
    ok(dictado._motorVivo());
    dictado.bajarMotor('a mano');
    ok(!dictado._motorVivo());
    let error = '';
    try { await dictado._transcribirBuffer(pcm(1, 0.1)); } catch (e) { error = e.message; }
    has(error, 'no está levantado', 'una promesa que nunca resuelve deja el botón en "…" para siempre');
  });
});
