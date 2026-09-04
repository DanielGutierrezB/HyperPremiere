'use strict';

// El ⟳ del panel a mitad de un dictado.
//
// Qué se prueba y por qué no se puede probar de otra forma
// --------------------------------------------------------
// El motor corre adentro del panel, y recargar el panel NO reinicia el proceso
// de Node: `cep/js/engine-client.js` borra la caché de `require` de todo
// `bridge/` y vuelve a requerir, y el Node que estaba sigue siendo el mismo. O
// sea que después de un ⟳ hay DOS instancias del módulo de dictado: la vieja,
// con el micrófono abierto y su Whisper transcribiendo, y la nueva, que cree
// que no hay nada corriendo.
//
// Eso es exactamente lo que se reproduce acá: se arranca un dictado, se borra
// la caché igual que el panel y se vuelve a requerir. Sin el arreglo, la
// instancia vieja se queda con ffmpeg y con Whisper hasta el tope de cinco
// minutos, y la nueva deja arrancar un SEGUNDO dictado encima — dos ffmpeg
// sobre el mismo micrófono y dos modelos de ~500 MB en memoria.
//
// El micrófono de verdad no se abre (ver dictado-motor.test.js): ffmpeg y
// Whisper son los de mentira de `fixtures/fake-cli`, que es lo que permite
// afirmar que el proceso MURIÓ y no solo que la variable quedó en null.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { test, ok, eq, has } = require('./harness');
const dictado = require('../bridge/dictado');
const vivos = require('../bridge/vivos');

const FIXTURES = path.join(__dirname, 'fixtures');
const FAKE_FFMPEG = path.join(FIXTURES, 'fake-cli', 'fake-ffmpeg.js');
const FAKE_WORKER = path.join(FIXTURES, 'fake-cli', 'fake-whisper-worker.js');
// Los procesos de mentira son scripts con shebang: en Windows no arrancan solos.
const saltarEnWindows = process.platform === 'win32';
// La captura usa avfoundation: fuera de Mac el dictado se rechaza antes.
const saltarFueraDeMac = process.platform !== 'darwin';

/**
 * Lo mismo que hace el panel en cada ⟳: borrar la caché de `require` de todo
 * `bridge/` y volver a requerir el motor. Copiado de engine-client.js, que es
 * de donde sale el problema.
 *
 * Devuelve la instancia NUEVA del módulo. La de arriba de este archivo sigue
 * siendo la vieja, que es justo lo que hay que poder mirar.
 */
function recargarElPanel() {
  Object.keys(require.cache).forEach(function (k) {
    if (k.replace(/\\/g, '/').indexOf('/bridge/') !== -1) delete require.cache[k];
  });
  return require('../bridge/dictado');
}

/**
 * Corre `fn` y después deja el proceso como estaba.
 *
 * La caja de `vivos` se restaura a mano: las otras suites del repo se quedaron
 * con la instancia VIEJA de los módulos (las requirieron al cargar), así que si
 * el proceso quedara apuntando a la instancia nueva, el que mande y el que se
 * mire serían dos objetos distintos. Es el mismo estado compartido entre suites
 * que ya dio problemas acá, y esta suite es la que lo mueve.
 */
async function conElPanelRecargado(fn) {
  const antes = Object.assign({}, vivos._cajas());
  let nueva = null;
  try {
    return await fn(function () { nueva = recargarElPanel(); return nueva; });
  } finally {
    // Se corta a mano lo que haya quedado en LAS DOS instancias. Con el código
    // bien esto no hace nada (el ⟳ ya bajó lo viejo), pero es lo que evita que
    // una regresión deje al corredor de mutaciones esperando cinco minutos a un
    // dictado huérfano que ya no tiene quién lo pare — que es, literalmente, el
    // bug que esta suite prueba.
    [dictado, nueva].forEach(function (m) {
      if (!m) return;
      try { m.dictadoParar({}); } catch (e) {}
      try { m.bajarMotor('fin del test'); } catch (e) {}
      try { m.olvidarMaquina(); } catch (e) {}
    });
    await esperar(250);
    const cajas = vivos._cajas();
    Object.keys(antes).forEach(function (k) { cajas[k] = antes[k]; });
  }
}

/** ¿Sigue vivo ese hijo? Se mira el proceso, no la variable. */
function murio(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Espera a que un hijo cierre, hasta `ms`. Devuelve si cerró. */
function esperarCierre(child, ms) {
  if (murio(child)) return Promise.resolve(true);
  return new Promise(function (r) {
    const t = setTimeout(function () { r(murio(child)); }, ms);
    child.on('close', function () { clearTimeout(t); r(true); });
  });
}

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** El entorno de mentira (ffmpeg, worker de Whisper) puesto y sacado. */
async function conProcesosFalsos(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-recarga-'));
  const logWhisper = path.join(dir, 'whisper.txt');
  const claves = {
    HYPERPREMIERE_FFMPEG: FAKE_FFMPEG,
    FAKE_FFMPEG_MODO: 'voz',
    FAKE_WHISPER_MODO: 'ok',
    FAKE_WHISPER_LOG: logWhisper,
    // El ocio de verdad son cinco minutos: acá el test no puede esperarlos, y
    // es el mismo camino de código.
    HYPERPREMIERE_DICTADO_INACTIVIDAD_MS: '30000',
  };
  const previos = {};
  Object.keys(claves).forEach(function (k) { previos[k] = process.env[k]; process.env[k] = claves[k]; });
  try {
    return await fn(function () {
      return fs.existsSync(logWhisper) ? fs.readFileSync(logWhisper, 'utf8').trim().split('\n') : [];
    });
  } finally {
    Object.keys(claves).forEach(function (k) {
      if (previos[k] === undefined) delete process.env[k]; else process.env[k] = previos[k];
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** PCM s16le mono de `segundos` a un nivel dado (0..1). */
function pcm(segundos, nivel) {
  const n = Math.round(16000 * segundos);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 4) * nivel * 32767), i * 2);
  return buf;
}

// --- 1. El Whisper que quedaba cargado para nadie ----------------------------

test('recargar el panel BAJA el Whisper de la instancia vieja', async function () {
  if (saltarEnWindows) return console.log('      (se saltea en Windows: los procesos de mentira son scripts con shebang)');
  await conProcesosFalsos(async function (eventos) {
    await conElPanelRecargado(async function (recargar) {
      await dictado._arrancarMotor({ python: FAKE_WORKER });
      await dictado._transcribirBuffer(pcm(2, 0.1));
      ok(dictado._motorVivo(), 'el modelo está cargado, como durante un dictado');

      const nueva = recargar();

      ok(!dictado._motorVivo(),
        'la instancia vieja no puede quedarse con medio giga de modelo residente que nadie puede bajar');
      ok(!nueva._motorVivo(), 'y la nueva arranca sin nada suyo');
      await esperar(150);
      has(eventos().join('\n'), 'chau',
        'y se le pidió que cerrara: sin esto sigue vivo hasta que se aburra, cinco minutos después');
      eq(eventos().filter((l) => l === 'arranque').length, 1,
        'un solo Whisper en todo el episodio; el segundo son otros ~500 MB');
    });
  });
});

// --- 2. El micrófono que quedaba abierto -------------------------------------

test('recargar el panel a mitad de un dictado cierra el micrófono en el acto', async function () {
  if (saltarEnWindows || saltarFueraDeMac) return;
  await conProcesosFalsos(async function (eventos) {
    await conElPanelRecargado(async function (recargar) {
      dictado._fijarMaquina({ plataforma: 'darwin', whisper: { style: 'mlx' }, python: FAKE_WORKER, ffmpeg: true });
      const enCurso = dictado.dictadoArrancar({ id: 'marcador:Marcador 1' }, function () {}, {});
      enCurso.catch(function () {}); // nadie lo espera si algo sale mal
      await esperar(700); // que abra el micrófono y empiece a entrar audio

      const sesion = vivos._cajas().dictado.sesion;
      ok(sesion, 'hay un dictado en curso');
      const ff = sesion.ff;
      ok(ff && !murio(ff), 'con su ffmpeg abierto sobre el micrófono');
      eq(dictado.dictadoEnCurso(), 'marcador:Marcador 1');

      const nueva = recargar();

      ok(await esperarCierre(ff, 2000),
        'el ffmpeg del dictado viejo tiene que morir con el ⟳: si no, el micrófono queda tomado ' +
        'hasta el tope de cinco minutos y la prueba de ⚙ tampoco puede usarlo');
      eq(nueva.dictadoEnCurso(), '', 'y el panel recargado arranca sin ningún dictado');

      // El dictado viejo TIENE que terminar. Si se quedara colgado esperando, la
      // promesa nunca resolvería y el buffer se acumularía para nadie.
      const r = await Promise.race([enCurso, esperar(3000).then(() => ({ colgado: true }))]);
      ok(!r.colgado, 'el dictado huérfano termina en vez de seguir hasta el tope de cinco minutos');
      ok(!r.ok, 'y termina sin resultado: el panel que lo pidió ya no existe');
      eq(dictado.dictadoEnCurso(), '', 'y la instancia vieja tampoco se queda creyendo que dicta');

      await esperar(150);
      has(eventos().join('\n'), 'chau', 'el Whisper también se bajó');
      ok(!nueva._motorVivo());
    });
  });
});

test('después del ⟳ el editor puede volver a dictar, y sigue habiendo UN micrófono', async function () {
  if (saltarEnWindows || saltarFueraDeMac) return;
  await conProcesosFalsos(async function (eventos) {
    await conElPanelRecargado(async function (recargar) {
      dictado._fijarMaquina({ plataforma: 'darwin', whisper: { style: 'mlx' }, python: FAKE_WORKER, ffmpeg: true });
      const viejo = dictado.dictadoArrancar({ id: 'marcador:Marcador 1' }, function () {}, {});
      viejo.catch(function () {});
      await esperar(700);
      const ffViejo = vivos._cajas().dictado.sesion.ff;

      const nueva = recargar();
      nueva._fijarMaquina({ plataforma: 'darwin', whisper: { style: 'mlx' }, python: FAKE_WORKER, ffmpeg: true });
      await esperarCierre(ffViejo, 2000);

      // El editor vuelve a tocar el 🎙 en el panel recargado.
      const nuevoDictado = nueva.dictadoArrancar({ id: 'marcador:Marcador 1' }, function () {}, {});
      await esperar(700);
      const ffNuevo = vivos._cajas().dictado.sesion.ff;
      ok(ffNuevo && !murio(ffNuevo), 'el dictado nuevo abrió su micrófono');
      ok(ffNuevo !== ffViejo);
      ok(murio(ffViejo), 'y el de antes ya no está: dos ffmpeg sobre el mismo micrófono es la falla que se arregló');

      nueva.dictadoParar({ id: 'marcador:Marcador 1' });
      await nuevoDictado;
      nueva.bajarMotor('fin del test');
      await esperar(100);
      eq(eventos().filter((l) => l === 'arranque').length, 2,
        'dos dictados, dos Whisper — pero uno por vez, no dos a la vez');
    });
  });
});

// --- 3. La transcripción de clases, que tenía el mismo agujero ---------------

test('la transcripción en curso tampoco queda huérfana al recargar', async function () {
  if (saltarEnWindows) return;
  await conElPanelRecargado(async function (recargar) {
    const transcribe = require('../bridge/transcribe');
    const caja = vivos._cajas().transcribe;
    ok(caja, 'transcribe también deja su proceso en curso donde el ⟳ lo pueda encontrar');
    eq(typeof caja.bajarTodo, 'function', 'con cómo bajarlo, que es lo que mira la instancia siguiente');
    eq(typeof transcribe.cancelTranscription, 'function');

    // Un hijo de mentira que se deja matar: alcanza para afirmar que la caja se
    // baja de verdad y no solo que la variable se pone en null. Va `unref` para
    // que, si el arreglo se rompe, el test FALLE en vez de quedarse esperando a
    // un huérfano que ya nadie va a matar.
    const hijo = spawn(process.execPath, ['-e', 'setInterval(function(){}, 1000)'], { detached: true });
    hijo.unref();
    caja.child = hijo;

    try {
      recargar();
      ok(await esperarCierre(hijo, 2000),
        'una clase entera transcribiéndose son minutos de CPU y medio giga de modelo: ' +
        'después del ⟳ nadie podía cancelarla, porque la instancia nueva no la veía');
    } finally {
      try { hijo.kill('SIGKILL'); } catch (e) {}
    }
  });
});
