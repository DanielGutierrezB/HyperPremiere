'use strict';

// Los TRES niveles de lo que escribe el editor, y que los tres lleguen al modelo.
//
// El caso viejo, el que puso el estilo del curso en el proyecto: dos editores
// comparten el mismo .prproj. Uno escribe la marca, la paleta y la tipografía en
// el panel; el otro abre la misma clase y genera con el campo vacío. Mismo
// marcador, contexto distinto, animaciones peores. En su log, las tres
// generaciones decían lo mismo:
//
//     prompt general no
//
// Eso se arregló poniendo el texto al lado del .prproj. Lo que cambió en la
// 1.5.0 es CÓMO se combinan: hay un "Prompt general" del CURSO entero y un
// "Prompt de secuencia" de cada clase, y los DOS viajan, más la instrucción del
// marcador. El de la secuencia ya no reemplaza al del curso: se le suma, y donde
// se contradigan manda el de la secuencia — dicho en el prompt, no dejado al
// criterio del modelo. El caso real: el curso pide paleta azul institucional y
// una clase va en blanco y negro.
//
// Se prueba lo que no falla solo: que los tres lleguen y en qué orden, que la
// precedencia esté ESCRITA, que vaciar un campo no toque el otro archivo, que un
// proyecto con los archivos del formato viejo siga andando, que la cola relea al
// generar, y que el log diga qué niveles entraron.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const engine = require('../bridge/engine.js');
const { buildUserPrompt } = require('../bridge/prompt/build-context');
const CEP = path.join(__dirname, '..', 'cep', 'js');

// ── Un proyecto de verdad en un tmpdir ───────────────────────────────
// El filesystem es de verdad a propósito: lo que se está probando es dónde
// quedan los archivos y que sobrevivan a cambiar de máquina, y un fs de mentira
// contestaría lo que le pidamos.

function proyectoNuevo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-prompt-'));
  return path.join(dir, 'Curso de IA.prproj');
}

/** Dónde deberían quedar los archivos, según la convención del proyecto. */
function rutas(projectPath, slugSecuencia) {
  const raiz = path.join(path.dirname(projectPath), 'HyperPremiere');
  return {
    curso: path.join(raiz, 'prompt-general.md'),
    secuencia: path.join(raiz, slugSecuencia, 'prompt-secuencia.md'),
    // Cómo se llamaba el de la secuencia hasta la 1.4.51.
    secuenciaVieja: path.join(raiz, slugSecuencia, 'prompt-general.md'),
  };
}

function escribir(file, texto) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, texto, 'utf8');
}

// ── Dónde se guarda cada nivel ───────────────────────────────────────

test('el del curso va al lado del .prproj, no adentro de una secuencia', function () {
  const prproj = proyectoNuevo();
  const r = engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14',
    text: 'tipografía Inter, azul de marca', scope: 'project',
  });
  ok(r.ok, 'se guardó');
  eq(r.path, rutas(prproj, 'clase-14').curso, 'en la carpeta del proyecto, junto a queue.json');
  ok(!fs.existsSync(rutas(prproj, 'clase-14').secuencia), 'y no en la de la secuencia');
});

test('el de una secuencia va adentro de su carpeta, con su propio nombre', function () {
  // Los dos se llamaban prompt-general.md y eso dejó de describir al de la
  // clase: ya no es "el general de acá", es el nivel de arriba del marcador.
  const prproj = proyectoNuevo();
  const r = engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: 'esta va en blanco y negro', scope: 'sequence',
  });
  eq(r.path, rutas(prproj, 'clase-14').secuencia);
  ok(!fs.existsSync(rutas(prproj, 'clase-14').curso), 'y no toca el del curso');
});

test('el archivo es texto plano, legible y editable a mano', function () {
  // Es prosa. En un JSON las líneas se escaparían a "\n" y dejaría de ser algo
  // que el editor pueda abrir y arreglar, que es medio punto de guardarlo ahí.
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({
    projectPath: prproj, text: 'tipografía Inter\nazul #1e40af\ntono sobrio', scope: 'project',
  });
  const crudo = fs.readFileSync(rutas(prproj, 'x').curso, 'utf8');
  eq(crudo, 'tipografía Inter\nazul #1e40af\ntono sobrio\n', 'tal cual, con sus saltos de línea');
});

test('lo que se escriba a mano en el archivo se lee igual', function () {
  const prproj = proyectoNuevo();
  escribir(rutas(prproj, 'x').curso, '\n  azul de marca, tipografía Inter  \n\n');
  const r = engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' });
  eq(r.projectText, 'azul de marca, tipografía Inter', 'los espacios de más no cambian el prompt');
});

test('preguntar por los prompts generales no deja carpetas por ahí', function () {
  // La pestaña de correcciones tuvo este mismo bug: abrir el panel creaba la
  // carpeta de cada secuencia que se mirara.
  const prproj = proyectoNuevo();
  const r = engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' });
  eq(r.projectText, '');
  eq(r.sequenceText, '');
  ok(!fs.existsSync(path.join(path.dirname(prproj), 'HyperPremiere')),
    'no se creó nada por consultar');
});

// ── Los dos niveles conviven ─────────────────────────────────────────

test('el del curso y el de la secuencia se leen por separado: ninguno reemplaza al otro', function () {
  // Hasta la 1.4.51 el de la secuencia PISABA al del curso y el del curso no
  // viajaba. Ahora los dos salen enteros y quién manda se resuelve más adelante,
  // en el prompt, con la contradicción nombrada.
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'paleta azul institucional', scope: 'project' });
  engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: 'esta va en blanco y negro', scope: 'sequence',
  });

  const r = engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' });
  eq(r.projectText, 'paleta azul institucional');
  eq(r.sequenceText, 'esta va en blanco y negro');
});

test('el del curso sigue valiendo para las secuencias que no agregan nada', function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'tipografía Inter, azul', scope: 'project' });
  engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: 'blanco y negro', scope: 'sequence',
  });
  const otra = engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 15' });
  eq(otra.projectText, 'tipografía Inter, azul');
  eq(otra.sequenceText, '', 'la clase 15 no agrega nada, y eso no le quita el del curso');
});

test('vaciar el de una secuencia la deja con el del curso: se borra el archivo', function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: 'blanco y negro', scope: 'sequence',
  });
  const r = engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: '', scope: 'sequence',
  });
  ok(r.removed, 'se borró');
  ok(!fs.existsSync(rutas(prproj, 'clase-14').secuencia),
    'sin archivo vacío diciendo "esta clase agrega algo" con nada adentro');
  const leido = engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' });
  eq(leido.sequenceText, '');
  eq(leido.projectText, 'azul de marca', 'y el del curso sigue ahí, intacto');
});

test('vaciar el del curso se anota, pero no crea carpetas por las dudas', function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: '', scope: 'project' });
  ok(!fs.existsSync(rutas(prproj, 'x').curso), 'no había nada: no se escribe nada');

  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul', scope: 'project' });
  engine.saveGeneralPrompt({ projectPath: prproj, text: '', scope: 'project' });
  ok(fs.existsSync(rutas(prproj, 'x').curso), 'lo que ya existía queda, vacío');
  const r = engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' });
  eq(r.projectText, '');
  eq(r.hasProjectFile, true, 'y el proyecto DIJO que no hay: no es lo mismo que no haber decidido');
});

test('guardar el de una secuencia sin decir cuál es un error, no un archivo en la raíz', function () {
  const prproj = proyectoNuevo();
  const r = engine.saveGeneralPrompt({ projectPath: prproj, text: 'algo', scope: 'sequence' });
  eq(r.ok, false);
  has(r.error, 'nombre');
});

// ── Cada campo escribe en SU archivo, y en ninguno más ───────────────
// Ésta es LA regresión de esta parte, y ya mordió una vez. Había un solo campo
// con un botón para cambiarle el destino, el destino se deducía de qué archivo
// existiera en el disco, y vaciar el prompt de una secuencia BORRA su archivo. O
// sea que el editor que seleccionaba todo y borraba para reescribir, en el
// tecleo siguiente estaba escribiendo el estilo de TODO el curso, que les llega
// a los demás. Nada fallaba: el texto se guardaba, en el archivo equivocado.
//
// Con dos campos visibles no hay destino que elegir (el estado `writeScope` se
// fue con el botón), pero la regla es la misma y se prueba igual.

test('vaciar el de una secuencia NO toca el archivo del curso', function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'paleta azul institucional', scope: 'project' });
  engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: 'blanco y negro', scope: 'sequence',
  });

  engine.saveGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14', text: '', scope: 'sequence' });

  eq(fs.readFileSync(rutas(prproj, 'x').curso, 'utf8').trim(), 'paleta azul institucional',
    'el del curso lo comparten todos los editores: reescribirlo no puede ser un efecto de vaciar otro campo');
});

test('vaciar el del curso NO toca el archivo de la secuencia', function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'paleta azul institucional', scope: 'project' });
  engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: 'blanco y negro', scope: 'sequence',
  });

  engine.saveGeneralPrompt({ projectPath: prproj, text: '', scope: 'project' });

  eq(fs.readFileSync(rutas(prproj, 'clase-14').secuencia, 'utf8').trim(), 'blanco y negro',
    'lo de esta clase sigue donde estaba');
});

// ── Los proyectos que ya existen ─────────────────────────────────────
// El de la raíz es el del curso: mismo archivo, mismo significado, nada que
// hacer. El que está adentro de una carpeta de secuencia siempre quiso decir "el
// de esta clase", que es exactamente el nivel nuevo, así que se lee igual con el
// nombre viejo. Nadie tiene que renombrar nada ni enterarse.

test('un proyecto del formato viejo sigue andando: el de la raíz es el del curso', function () {
  const prproj = proyectoNuevo();
  escribir(rutas(prproj, 'x').curso, 'tipografía Inter, azul de marca\n');
  const r = engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' });
  eq(r.projectText, 'tipografía Inter, azul de marca');
});

test('el prompt-general.md que quedó adentro de una secuencia pasa a ser el de esa secuencia', function () {
  const prproj = proyectoNuevo();
  escribir(rutas(prproj, 'x').curso, 'paleta azul institucional\n');
  escribir(rutas(prproj, 'clase-14').secuenciaVieja, 'esta va en blanco y negro\n');

  const r = engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' });
  eq(r.sequenceText, 'esta va en blanco y negro', 'se lee con el nombre viejo, sin pedirle nada al editor');
  eq(r.sequenceLegacy, true, 'y se sabe que viene del formato viejo');
  eq(r.projectText, 'paleta azul institucional',
    'y ahora el del curso TAMBIÉN viaja: antes este archivo lo tapaba');
});

test('el nombre viejo no se lee cuando ya hay uno con el nuevo', function () {
  // Un proyecto a medio migrar no puede resucitar un texto que ya se reemplazó.
  const prproj = proyectoNuevo();
  escribir(rutas(prproj, 'clase-14').secuenciaVieja, 'lo viejo\n');
  escribir(rutas(prproj, 'clase-14').secuencia, 'lo nuevo\n');
  const r = engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' });
  eq(r.sequenceText, 'lo nuevo');
  eq(r.sequenceLegacy, false);
});

test('guardar el de una secuencia consolida el nombre: no quedan dos archivos', function () {
  const prproj = proyectoNuevo();
  escribir(rutas(prproj, 'clase-14').secuenciaVieja, 'lo que ya estaba\n');

  engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: 'lo que ya estaba, y algo más', scope: 'sequence',
  });

  eq(fs.readFileSync(rutas(prproj, 'clase-14').secuencia, 'utf8').trim(), 'lo que ya estaba, y algo más');
  ok(!fs.existsSync(rutas(prproj, 'clase-14').secuenciaVieja),
    'el del nombre viejo se fue: dos archivos diciendo cosas distintas es peor que uno');
});

test('vaciar el de una secuencia del formato viejo lo borra de verdad', function () {
  // Si quedara el archivo del nombre viejo, el texto que el editor acaba de
  // borrar volvería en la próxima lectura, sin que nada falle.
  const prproj = proyectoNuevo();
  escribir(rutas(prproj, 'clase-14').secuenciaVieja, 'lo que el editor quiere sacar\n');

  engine.saveGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14', text: '', scope: 'sequence' });

  eq(engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' }).sequenceText, '',
    'no vuelve');
  ok(!fs.existsSync(rutas(prproj, 'clase-14').secuenciaVieja));
});

test('el log deja el renglón del archivo que cambió de nombre, una sola vez', async function () {
  // No hay nada que el editor tenga que hacer, pero el log es donde en este
  // panel se descubre de dónde salió el contexto de una generación.
  const prproj = proyectoNuevo();
  escribir(rutas(prproj, 'clase-14').secuenciaVieja, 'esta va en blanco y negro\n');

  const p = montarPanel();
  await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');

  const avisos = p.espia.logs.filter((l) => l.indexOf('formato viejo') !== -1);
  eq(avisos.length, 1, 'una vez por secuencia y por sesión, no en cada lectura');
  has(avisos[0], 'prompt-secuencia.md');
  has(avisos[0], 'No tenés que hacer nada');
});

test('la cola, que lee por cualquier job, no repite el aviso del formato viejo', async function () {
  const prproj = proyectoNuevo();
  escribir(rutas(prproj, 'clase-14').secuenciaVieja, 'esta va en blanco y negro\n');

  const p = montarPanel();
  await p.ctx.HPGeneral.load(prproj, 'Clase 14');

  eq(p.espia.logs.filter((l) => l.indexOf('formato viejo') !== -1).length, 0,
    'load es lectura pura: la cola pasa por acá una vez por job');
});

// ── Qué ve el modelo ─────────────────────────────────────────────────
// La otra mitad del cambio: que los tres niveles entren en el pedido, en orden,
// y que la precedencia esté escrita. Con dos textos que pueden contradecirse,
// dejarle elegir al modelo es que el resultado dependa de su humor.

function pedido(extra) {
  return buildUserPrompt(Object.assign({
    objective: 'reconocer los tres componentes',
    transcriptSegments: [{ start: 0, end: 5, text: 'la clase' }],
    marker: { name: 'Marcador 1', start: 10, end: 16, duration: 6 },
    markerTranscript: [{ start: 10, end: 16, text: 'los tres componentes' }],
    instruction: 'un cartel con los tres componentes',
    stillsCount: 0,
  }, extra));
}

test('los tres niveles llegan juntos al modelo, del más general al más específico', function () {
  const p = pedido({
    generalInstruction: 'paleta azul institucional',
    sequenceInstruction: 'esta clase va en blanco y negro',
  });
  has(p, 'paleta azul institucional');
  has(p, 'esta clase va en blanco y negro');
  has(p, 'un cartel con los tres componentes');
  ok(p.indexOf('paleta azul institucional') < p.indexOf('esta clase va en blanco y negro'),
    'el del curso primero: es la base sobre la que se lee el resto');
  ok(p.indexOf('esta clase va en blanco y negro') < p.indexOf('un cartel con los tres componentes'),
    'y la instrucción del marcador al final, que es lo más específico');
});

test('la precedencia está ESCRITA en el prompt, con la contradicción nombrada', function () {
  // El ejemplo real, y por qué no se puede dejar implícito: "azul institucional"
  // y "blanco y negro" son las dos instrucciones válidas, y sin decir cuál gana
  // el modelo elige — a veces bien, a veces no, y nunca se sabe por qué.
  const p = pedido({
    generalInstruction: 'paleta azul institucional',
    sequenceInstruction: 'esta clase va en blanco y negro',
  });
  has(p, 'PRECEDENCIA');
  has(p, 'MANDA ESTO', 'el bloque de la secuencia dice que gana él');
  has(p, 'Lo que no se contradiga, se suma', 'y que lo demás no se descarta');
  has(p, 'MANDA ÉSTA', 'y la instrucción del marcador le gana a los dos');
});

test('con el de la secuencia vacío llega solo el del curso, y sin hablar de precedencia', function () {
  const p = pedido({ generalInstruction: 'paleta azul institucional', sequenceInstruction: '' });
  has(p, 'Prompt general del curso');
  ok(p.indexOf('Prompt de esta secuencia') === -1, 'no se dibuja un bloque vacío');
  ok(p.indexOf('PRECEDENCIA') === -1,
    'sin nada arriba que contradecir, la línea de precedencia es ruido que se paga por generación');
});

test('con el del curso vacío llega solo el de la secuencia, y vale como estilo general', function () {
  const p = pedido({ generalInstruction: '', sequenceInstruction: 'esta clase va en blanco y negro' });
  has(p, 'Prompt de esta secuencia');
  has(p, 'esta clase va en blanco y negro');
  ok(p.indexOf('Prompt general del curso') === -1);
  ok(p.indexOf('PRECEDENCIA') === -1, 'no hay a quién ganarle');
  has(p, 'reglas comunes a todos los marcadores de esta clase',
    'se presenta como lo general de la clase, no como una excepción a algo que no está');
});

test('sin ningún prompt general, la instrucción del marcador no habla de precedencia', function () {
  const p = pedido({ generalInstruction: '', sequenceInstruction: '' });
  ok(p.indexOf('MANDA ÉSTA') === -1, 'no le gana a nada: nombrar la regla sobraría');
  has(p, 'un cartel con los tres componentes');
});

test('el system prompt le dice la regla de precedencia en todos los pedidos', function () {
  // El pedido dice quién gana cuando los dos están; el system prompt dice que la
  // regla existe siempre, para que no la deduzca de un pedido a otro.
  const sys = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'prompt', 'system.md'), 'utf8');
  has(sys, 'tres niveles');
  has(sys, 'Prompt general del curso');
  has(sys, 'Prompt de esta secuencia');
  has(sys, 'manda el más específico');
  has(sys, 'se suma', 'lo que no se contradice no se descarta');
});

// ── El panel, con el disco de verdad detrás ──────────────────────────
// Se monta el panel como lo carga el navegador, pero el motor de mentira llama
// a las funciones DE VERDAD del motor sobre un tmpdir: así lo que se prueba es
// el contrato entero —panel, llamada, archivo— y no dos mitades que se creen
// entre ellas.

function montarPanel(opts) {
  opts = opts || {};
  const disco = opts.localStorage || {};
  const espia = { logs: [], llamadas: [] };
  const ctx = {
    console: console, JSON: JSON, Math: Math, Date: Date, String: String,
    Number: Number, Object: Object, Array: Array, isNaN: isNaN,
    parseInt: parseInt, parseFloat: parseFloat, Promise: Promise,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(disco, k) ? disco[k] : null; },
      setItem: function (k, v) { disco[k] = String(v); },
      removeItem: function (k) { delete disco[k]; },
    },
    HPLog: { log: function (m, nivel) { espia.logs.push((nivel || 'INFO') + ' ' + m); } },
    HPEngine: {
      call: function (metodo, arg) {
        espia.llamadas.push(metodo);
        if (metodo === 'loadGeneralPrompt') return Promise.resolve(engine.loadGeneralPrompt(arg));
        if (metodo === 'saveGeneralPrompt') return Promise.resolve(engine.saveGeneralPrompt(arg));
        return Promise.resolve({ ok: false, error: 'método inesperado: ' + metodo });
      },
    },
  };
  if (opts.sinMotor) {
    ctx.HPEngine.call = function () { return Promise.reject(new Error('el motor no cargó')); };
  }
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'store.js', 'general-prompt.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  return { ctx: ctx, disco: disco, espia: espia };
}

/** Deja escrito en el localStorage del panel el prompt general de una secuencia. */
function conPromptLocal(panel, projectPath, sequenceName, texto) {
  panel.ctx.HPStore.withContext(projectPath, sequenceName, function () {
    panel.ctx.HPStore.setMarkerInstruction(panel.ctx.HPStore.GENERAL_KEY, texto);
  });
}

function promptLocalDe(panel, projectPath, sequenceName) {
  return panel.ctx.HPStore.withContext(projectPath, sequenceName, function () {
    return panel.ctx.HPStore.getMarkerData(panel.ctx.HPStore.GENERAL_KEY).instruction;
  });
}

/** Lo que hace el panel con cada tecleo: guardar ESE campo en SU archivo. */
function tipear(panel, projectPath, sequenceName, scope, texto) {
  return panel.ctx.HPGeneral.save(projectPath, sequenceName, texto, scope);
}

// ── El caso del compañero ────────────────────────────────────────────

test('el compañero abre el proyecto SIN nada en su localStorage y los prompts le llegan igual', async function () {
  // Este es el bug entero, de punta a punta. La máquina A escribe el estilo del
  // curso; la máquina B —localStorage vacío, nunca vio esta clase— tiene que
  // generar con el mismo contexto.
  const prproj = proyectoNuevo();

  const maquinaA = montarPanel();
  conPromptLocal(maquinaA, prproj, 'Clase 14', 'tipografía Inter, azul #1e40af, tono sobrio');
  await maquinaA.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  await tipear(maquinaA, prproj, 'Clase 14', 'sequence', 'esta va en blanco y negro');

  const maquinaB = montarPanel(); // localStorage propio, vacío
  const st = await maquinaB.ctx.HPGeneral.migrate(prproj, 'Clase 14');

  eq(st.projectText, 'tipografía Inter, azul #1e40af, tono sobrio', 'el del curso llegó a la otra máquina');
  eq(st.sequenceText, 'esta va en blanco y negro', 'y el de la clase también');
});

test('en la máquina del compañero, el panel dice qué niveles viajan (y no lo deja adivinar)', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });

  const p = montarPanel();
  await p.ctx.HPGeneral.load(prproj, 'Clase 14');
  const v = p.ctx.HPGeneral.describe(prproj, 'Clase 14');
  has(v.badge, 'del curso');
  has(v.line, 'Viaja con el .prproj');
  eq(v.badgeState, 'ok');
});

test('con los dos, el panel dice que van los dos y quién manda', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'paleta azul institucional', scope: 'project' });
  engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: 'blanco y negro', scope: 'sequence',
  });

  const p = montarPanel();
  await p.ctx.HPGeneral.load(prproj, 'Clase 14');
  const v = p.ctx.HPGeneral.describe(prproj, 'Clase 14');
  has(v.badge, 'curso + esta secuencia');
  has(v.line, 'los DOS', 'ya no hay uno que pise al otro');
  has(v.line, 'MANDA', 'y se dice cuál gana donde se contradigan');
  eq(v.lineState, 'override');
});

test('cada campo muestra su propio archivo, y nunca el del otro nivel', async function () {
  // Es la regla que sostenía el destino de escritura, con la forma nueva: si un
  // campo mostrara el texto del otro, el tecleo siguiente lo estaría
  // reescribiendo creyendo que edita el suyo.
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'paleta azul institucional', scope: 'project' });
  engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: 'blanco y negro', scope: 'sequence',
  });

  const p = montarPanel();
  await p.ctx.HPGeneral.load(prproj, 'Clase 14');
  const v = p.ctx.HPGeneral.describe(prproj, 'Clase 14');
  eq(v.courseText, 'paleta azul institucional');
  eq(v.sequenceText, 'blanco y negro');
});

test('el campo de la secuencia dice de qué secuencia es, por su nombre', async function () {
  // La mitad de "no dudar nunca de dónde estás escribiendo" es que sean dos
  // campos; la otra es que el rótulo nombre la clase que se está editando.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  await p.ctx.HPGeneral.load(prproj, 'Clase 14');
  const v = p.ctx.HPGeneral.describe(prproj, 'Clase 14');
  has(v.sequenceLabel, 'Prompt de secuencia');
  has(v.sequenceLabel, 'Clase 14');
  eq(v.sequenceEnabled, true);
});

test('sin secuencia abierta no se ofrece el campo de secuencia', async function () {
  // No hay carpeta donde guardarlo: el campo escribiría en ningún lado.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  await p.ctx.HPGeneral.load(prproj, '');
  eq(p.ctx.HPGeneral.describe(prproj, '').sequenceEnabled, false);
});

test('sin nada, el panel dice que el proyecto NO lleva el estilo del curso', async function () {
  // El renglón que faltaba: "opcional" hacía pensar en una preferencia de este
  // panel. Lo que pasa de verdad es que quien abra el proyecto genera a ciegas.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  await p.ctx.HPGeneral.load(prproj, 'Clase 14');
  has(p.ctx.HPGeneral.describe(prproj, 'Clase 14').badge, 'no viaja con el proyecto');
});

test('antes de que conteste el disco, el panel NO dice que no hay estilo', function () {
  // "No sé todavía" y "no hay" son cosas distintas, y el badge las decía igual:
  // al abrir el panel acusaba al proyecto de no llevar el estilo del curso
  // mientras la lectura seguía en camino. `loaded` existe justo para separarlas.
  const p = montarPanel();
  const v = p.ctx.HPGeneral.describe(proyectoNuevo(), 'Clase 14');
  has(v.badge, 'leyendo');
  ok(v.badge.indexOf('no viaja con el proyecto') === -1, 'todavía no puede afirmar eso');
});

// ── Vaciar un campo desde el panel ───────────────────────────────────

test('vaciar el de la secuencia para reescribirlo NO reescribe el del curso', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'paleta azul institucional', scope: 'project' });
  engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: 'blanco y negro', scope: 'sequence',
  });

  const p = montarPanel();
  await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  await tipear(p, prproj, 'Clase 14', 'sequence', '');                       // seleccionó todo y borró
  await tipear(p, prproj, 'Clase 14', 'sequence', 'esta va en sepia');       // y volvió a escribir

  eq(fs.readFileSync(rutas(prproj, 'x').curso, 'utf8').trim(), 'paleta azul institucional',
    'el del curso lo comparten todos los editores: reescribirlo no puede ser un efecto de borrar un campo');
  eq(engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' }).sequenceText,
    'esta va en sepia', 'lo tipeado quedó donde el editor lo estaba escribiendo');
});

test('vaciar el del curso deja el de la secuencia donde estaba', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'paleta azul institucional', scope: 'project' });
  engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: 'blanco y negro', scope: 'sequence',
  });

  const p = montarPanel();
  await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  await tipear(p, prproj, 'Clase 14', 'project', '');

  const st = p.ctx.HPGeneral.state(prproj, 'Clase 14');
  eq(st.projectText, '');
  eq(st.sequenceText, 'blanco y negro', 'en la caché');
  eq(engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' }).sequenceText,
    'blanco y negro', 'y en el disco');
});

test('la caché queda igual que releer el disco, campo por campo', async function () {
  const prproj = proyectoNuevo();
  const p = montarPanel();
  await p.ctx.HPGeneral.load(prproj, 'Clase 14');
  await tipear(p, prproj, 'Clase 14', 'project', '  azul de marca  ');
  await tipear(p, prproj, 'Clase 14', 'sequence', 'blanco y negro');

  const enDisco = engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' });
  const enCache = p.ctx.HPGeneral.state(prproj, 'Clase 14');
  eq(enCache.projectText, enDisco.projectText);
  eq(enCache.sequenceText, enDisco.sequenceText);
  eq(enCache.projectText, 'azul de marca', 'los espacios de los bordes los recorta el motor');
});

test('guardar no vuelve a leer el disco', async function () {
  // Por acá pasa CADA tecleo de los campos (con debounce). Releer era una
  // segunda llamada al motor por tecla para enterarse de lo que se acababa de
  // escribir.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  await p.ctx.HPGeneral.load(prproj, 'Clase 14');
  p.espia.llamadas.length = 0;

  await tipear(p, prproj, 'Clase 14', 'project', 'azul de marca');

  eq(p.espia.llamadas.join(','), 'saveGeneralPrompt', 'una escritura, y nada más');
  eq(p.ctx.HPGeneral.state(prproj, 'Clase 14').projectText, 'azul de marca',
    'y la caché quedó al día igual');
});

test('leer los prompts generales no escribe nada', async function () {
  // load() es lectura pura. Lo que sube algo al proyecto es migrate(), y eso lo
  // pide la interfaz: ver el test de la cola, más abajo.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  conPromptLocal(p, prproj, 'Clase 14', 'azul de marca');

  const st = await p.ctx.HPGeneral.load(prproj, 'Clase 14');

  eq(st.projectText, '', 'el proyecto no tiene nada, y leer no se lo inventa');
  ok(!fs.existsSync(rutas(prproj, 'x').curso), 'no se escribió ningún archivo');
  eq(promptLocalDe(p, prproj, 'Clase 14'), 'azul de marca', 'ni se limpió el localStorage');
});

// ── La migración desde el localStorage ───────────────────────────────

test('lo que estaba en el localStorage pasa a ser el prompt general del curso', async function () {
  const prproj = proyectoNuevo();
  const p = montarPanel();
  conPromptLocal(p, prproj, 'Clase 14', 'tipografía Inter, azul de marca');

  const st = await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');

  eq(st.projectText, 'tipografía Inter, azul de marca', 'ahora es del proyecto');
  eq(fs.readFileSync(rutas(prproj, 'clase-14').curso, 'utf8').trim(), 'tipografía Inter, azul de marca');
  has(p.espia.logs.join('\n'), 'viaja con el .prproj', 'y el log lo cuenta');
});

test('migrado, deja de estar en el localStorage: no quedan dos copias', async function () {
  // Con las dos, la próxima apertura vería una diferencia donde no la hay y
  // saldría a preguntar por algo que ya está resuelto.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  conPromptLocal(p, prproj, 'Clase 14', 'azul de marca');
  await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');

  eq(promptLocalDe(p, prproj, 'Clase 14'), '', 'el localStorage quedó limpio');
  const otraVez = await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  eq(otraVez.pending, '', 'y abrir de nuevo no pregunta nada');
});

test('si el local dice lo mismo que el proyecto, se borra sin molestar a nadie', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  const p = montarPanel();
  conPromptLocal(p, prproj, 'Clase 14', 'azul de marca');

  const st = await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  eq(st.pending, '', 'no hay nada que decidir');
  eq(promptLocalDe(p, prproj, 'Clase 14'), '');
});

test('migrar NO pisa lo que el compañero ya había escrito en el proyecto', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'lo que escribió el otro editor', scope: 'project' });
  const p = montarPanel();
  conPromptLocal(p, prproj, 'Clase 14', 'lo que escribí yo acá');

  await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  eq(fs.readFileSync(rutas(prproj, 'x').curso, 'utf8').trim(), 'lo que escribió el otro editor',
    'el archivo del proyecto no se tocó');
});

test('con dos textos distintos no se pisa ninguno: se pregunta cuál vale', async function () {
  // El cartel de conflicto NO era parte del botón de destino: es lo que queda de
  // la migración del localStorage y sigue haciendo falta. De un lado está lo que
  // escribió quien tiene el panel adelante; del otro, lo que puso su compañero
  // en el proyecto. Elegir por ellos es tirar el trabajo de alguno sin decírselo.
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  const p = montarPanel();
  conPromptLocal(p, prproj, 'Clase 14', 'verde, tipografía Roboto');

  const st = await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  eq(st.pending, 'verde, tipografía Roboto', 'el texto de esta máquina quedó entero, apartado');
  eq(st.projectText, 'azul de marca', 'y mientras tanto viaja el del proyecto, que es el que comparten');
  has(p.espia.logs.join('\n'), 'WARN');

  const v = p.ctx.HPGeneral.describe(prproj, 'Clase 14');
  has(v.badge, 'decidí cuál vale');
  eq(v.badgeState, 'warn');
});

test('el conflicto sobrevive a cerrar el panel: no se pierde por no contestar', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  const disco = {};
  const p1 = montarPanel({ localStorage: disco });
  conPromptLocal(p1, prproj, 'Clase 14', 'verde, tipografía Roboto');
  await p1.ctx.HPGeneral.migrate(prproj, 'Clase 14');

  const p2 = montarPanel({ localStorage: disco }); // el mismo panel, reabierto
  const st = await p2.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  eq(st.pending, 'verde, tipografía Roboto');
});

test('“es el de esta clase” lo guarda como prompt de secuencia y deja el del curso intacto', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  const p = montarPanel();
  conPromptLocal(p, prproj, 'Clase 14', 'verde, tipografía Roboto');
  await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');

  const st = await p.ctx.HPGeneral.resolvePending(prproj, 'Clase 14', 'sequence');
  eq(st.sequenceText, 'verde, tipografía Roboto');
  eq(st.projectText, 'azul de marca', 'y ahora los dos viajan: ya no hay uno que pise al otro');
  eq(st.pending, '', 'no se vuelve a preguntar');
  eq(engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 15' }).sequenceText, '',
    'las otras clases no heredan nada');
});

test('“que sea el del curso” lo reemplaza y le llega a todas', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  const p = montarPanel();
  conPromptLocal(p, prproj, 'Clase 14', 'verde, tipografía Roboto');
  await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');

  const st = await p.ctx.HPGeneral.resolvePending(prproj, 'Clase 14', 'project');
  eq(st.projectText, 'verde, tipografía Roboto');
  eq(engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 99' }).projectText,
    'verde, tipografía Roboto');
});

test('descartarlo deja el del proyecto y no vuelve a preguntar', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  const p = montarPanel();
  conPromptLocal(p, prproj, 'Clase 14', 'verde, tipografía Roboto');
  await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');

  const st = await p.ctx.HPGeneral.resolvePending(prproj, 'Clase 14', 'discard');
  eq(st.projectText, 'azul de marca');
  eq(st.pending, '');
  const otraVez = await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  eq(otraVez.pending, '');
});

test('si el proyecto DIJO que no hay prompt del curso, lo local no lo resucita solo', async function () {
  // El archivo existe y está vacío: alguien lo borró a propósito. Volver a
  // llenarlo con lo que quedó en una máquina sería deshacerle el cambio.
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul', scope: 'project' });
  engine.saveGeneralPrompt({ projectPath: prproj, text: '', scope: 'project' });
  const p = montarPanel();
  conPromptLocal(p, prproj, 'Clase 14', 'verde');

  const st = await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  eq(st.pending, 'verde', 'se pregunta');
  eq(fs.readFileSync(rutas(prproj, 'x').curso, 'utf8').trim(), '', 'y sigue vacío');
});

test('sin motor, no se pierde el prompt que tiene esta máquina', async function () {
  // El proyecto puede estar en un disco desmontado. Dar por sentado que no hay
  // estilo sería volver al bug: generar en blanco sin que nada lo diga.
  const prproj = proyectoNuevo();
  const p = montarPanel({ sinMotor: true });
  conPromptLocal(p, prproj, 'Clase 14', 'azul de marca');

  const st = await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  eq(st.projectText, 'azul de marca', 'se sigue generando con lo que hay');
  eq(st.failed, true);
  eq(promptLocalDe(p, prproj, 'Clase 14'), 'azul de marca', 'y no se borró nada');
  has(p.espia.logs.join('\n'), 'WARN');
  has(p.ctx.HPGeneral.describe(prproj, 'Clase 14').line, 'no viaja a la otra');
});

// ── Lo que la cola le manda al modelo ────────────────────────────────

function montarCola(opts) {
  opts = opts || {};
  const espia = { preparados: [], colocados: [] };
  const almacen = {};
  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Object: Object, Array: Array, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(almacen, k) ? almacen[k] : null; },
      setItem: function (k, v) { almacen[k] = String(v); },
      removeItem: function (k) { delete almacen[k]; },
    },
    HPLog: { log: function () {} },
    HPConfigUI: { isLocalProvider: function () { return false; }, modelName: function () { return 'claude-sonnet-5'; } },
    HPTranscript: { sliceForMarker: function () { return []; } },
    HPHost: {
      placeClip: function (mov, seq, start, dur, color, hasAudio, cb) { espia.colocados.push(seq); cb('ok'); },
    },
    HPEngine: {
      call: function (m, arg) {
        if (m === 'mediaHasAudio') return Promise.resolve({ ok: true, hasAudio: false });
        if (m === 'loadTranscript') return Promise.resolve({ ok: true, found: false });
        if (m === 'loadGeneralPrompt') {
          if (opts.sinMotor) return Promise.reject(new Error('el motor no cargó'));
          return Promise.resolve(engine.loadGeneralPrompt(arg));
        }
        if (m === 'saveGeneralPrompt') return Promise.resolve(engine.saveGeneralPrompt(arg));
        return Promise.resolve({ ok: true });
      },
      callProg: function (m, arg) {
        if (m === 'saveQueue') return Promise.resolve({ ok: true });
        if (m === 'prepareFeedback' || m === 'prepareGenerate') {
          espia.preparados.push(arg);
          return Promise.resolve({ ok: true, version: 1, usage: { inputTokens: 1, outputTokens: 1 } });
        }
        return Promise.resolve({ ok: true, version: 1, movPath: '/p/x.mov' });
      },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'store.js', 'general-prompt.js', 'queue.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  return { ctx: ctx, espia: espia };
}

async function dejarCorrer() {
  for (let i = 0; i < 40; i++) await new Promise(function (r) { setTimeout(r, 0); });
}

function jobDe(projectPath, extra) {
  return Object.assign({
    kind: 'generate',
    payload: { projectPath: projectPath, sequenceName: 'Clase 14', mode: 'generate', markerSlug: 'Marcador 1' },
    seqName: 'Clase 14', projectPath: projectPath, markerKey: 'Marcador 1',
    label: 'Marcador 1', markerStart: 10, markerDuration: 5,
  }, extra);
}

test('el marcador que se genera en la otra máquina sale CON los dos niveles', async function () {
  // El final del caso del compañero: no alcanza con que el panel lo lea, tiene
  // que entrar en la llamada al modelo. Es lo que decidía si la animación salía
  // como la del otro editor o genérica.
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'paleta azul institucional', scope: 'project' });
  engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: 'esta va en blanco y negro', scope: 'sequence',
  });

  const c = montarCola(); // localStorage vacío: es otra máquina
  c.ctx.HPStore.setContext(prproj, 'Clase 14');
  c.ctx.HPQueue.add(jobDe(prproj));
  await dejarCorrer();

  eq(c.espia.preparados.length, 1, 'se llamó al modelo');
  eq(c.espia.preparados[0].generalInstruction, 'paleta azul institucional');
  eq(c.espia.preparados[0].sequenceInstruction, 'esta va en blanco y negro');
});

test('la secuencia sin prompt propio manda el del curso y el suyo vacío', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });

  const c = montarCola();
  c.ctx.HPStore.setContext(prproj, 'Clase 14');
  c.ctx.HPQueue.add(jobDe(prproj));
  await dejarCorrer();

  eq(c.espia.preparados[0].generalInstruction, 'azul de marca');
  eq(c.espia.preparados[0].sequenceInstruction, '',
    'vacío EXPLÍCITO: es lo que distingue un job nuevo de uno de antes de la 1.5.0');
});

test('un proyecto del formato viejo genera con los dos niveles, sin migrar nada a mano', async function () {
  const prproj = proyectoNuevo();
  escribir(rutas(prproj, 'x').curso, 'paleta azul institucional\n');
  escribir(rutas(prproj, 'clase-14').secuenciaVieja, 'esta va en blanco y negro\n');

  const c = montarCola();
  c.ctx.HPStore.setContext(prproj, 'Clase 14');
  c.ctx.HPQueue.add(jobDe(prproj));
  await dejarCorrer();

  eq(c.espia.preparados[0].generalInstruction, 'paleta azul institucional');
  eq(c.espia.preparados[0].sequenceInstruction, 'esta va en blanco y negro');
});

test('reintentar después de arreglar el estilo sale con el arreglado', async function () {
  // Si las animaciones salían mal por el prompt, el editor lo corrige y vuelve a
  // mandar. Quedarse con el texto que el job traía pegado sería repetir el error
  // y cobrarlo.
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  const c = montarCola();
  c.ctx.HPStore.setContext(prproj, 'Clase 14');
  c.ctx.HPQueue.add(jobDe(prproj));
  await dejarCorrer();
  eq(c.espia.preparados[0].generalInstruction, 'azul de marca');

  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca, SIN glow', scope: 'project' });
  await c.ctx.HPGeneral.load(prproj, 'Clase 14');
  c.ctx.HPQueue.regenerate(c.ctx.HPQueue.jobs()[0].id, 'sacale el brillo');
  await dejarCorrer();

  eq(c.espia.preparados[1].generalInstruction, 'azul de marca, SIN glow');
});

test('arreglar el prompt DE LA SECUENCIA y reintentar también sale con el arreglado', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: 'blanco y negro', scope: 'sequence',
  });
  const c = montarCola();
  c.ctx.HPStore.setContext(prproj, 'Clase 14');
  c.ctx.HPQueue.add(jobDe(prproj));
  await dejarCorrer();
  eq(c.espia.preparados[0].sequenceInstruction, 'blanco y negro');

  engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: 'blanco y negro, y el logo arriba', scope: 'sequence',
  });
  await c.ctx.HPGeneral.load(prproj, 'Clase 14');
  c.ctx.HPQueue.regenerate(c.ctx.HPQueue.jobs()[0].id, 'movele el logo');
  await dejarCorrer();

  eq(c.espia.preparados[1].sequenceInstruction, 'blanco y negro, y el logo arriba');
  eq(c.espia.preparados[1].generalInstruction, 'azul de marca', 'y el del curso sigue viajando');
});

test('borrar el prompt de la secuencia y reintentar sale SIN él, no con el que traía pegado', async function () {
  // La otra mitad de releer: si el editor sacó lo de esta clase porque quedaba
  // mal, reintentar tiene que salir sin eso.
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: 'blanco y negro', scope: 'sequence',
  });
  const c = montarCola();
  c.ctx.HPStore.setContext(prproj, 'Clase 14');
  c.ctx.HPQueue.add(jobDe(prproj));
  await dejarCorrer();

  engine.saveGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14', text: '', scope: 'sequence' });
  await c.ctx.HPGeneral.load(prproj, 'Clase 14');
  c.ctx.HPQueue.regenerate(c.ctx.HPQueue.jobs()[0].id, 'de nuevo');
  await dejarCorrer();

  eq(c.espia.preparados[1].sequenceInstruction, '');
  eq(c.espia.preparados[1].generalInstruction, 'azul de marca');
});

test('la cola NO promueve al prompt del curso lo que había en esta máquina', async function () {
  // La cola le pide los prompts a la secuencia de CUALQUIER job: uno restaurado
  // de otra sesión, una corrección de un corte que nunca se abrió acá. Mientras
  // leer también migraba, encolar eso podía convertir en el estilo de TODO el
  // curso —para los dos editores— un texto que estaba en una sola máquina, desde
  // un camino que nadie mira. Y cuál ganaba dependía de qué job se hubiera
  // cargado primero.
  const prproj = proyectoNuevo();
  const c = montarCola();
  c.ctx.HPStore.withContext(prproj, 'Clase 99', function () {
    c.ctx.HPStore.setMarkerInstruction(c.ctx.HPStore.GENERAL_KEY, 'verde de la clase invitada');
  });
  c.ctx.HPStore.setContext(prproj, 'Clase 14');

  c.ctx.HPQueue.add(jobDe(prproj, {
    seqName: 'Clase 99', storeSeqName: 'Clase 99',
    payload: { projectPath: prproj, sequenceName: 'Clase 99', mode: 'generate', markerSlug: 'Marcador 1' },
  }));
  await dejarCorrer();

  ok(!fs.existsSync(rutas(prproj, 'x').curso),
    'el proyecto no tiene prompt del curso nuevo: nadie eligió que ese texto lo fuera');
  eq(c.espia.preparados.length, 1, 'y el job igual se generó');
  eq(c.espia.preparados[0].generalInstruction, '', 'sin estilo, que es lo que dice el proyecto');
});

test('si el proyecto no se puede leer, NO se vacía el estilo que el job traía', async function () {
  // Un disco externo desmontado no puede convertir una generación con marca en
  // una genérica sin que nada falle: eso se descubre viendo el video.
  const prproj = proyectoNuevo();
  const c = montarCola({ sinMotor: true });
  c.ctx.HPStore.setContext(prproj, 'Clase 14');
  c.ctx.HPQueue.add(jobDe(prproj, { payload: {
    projectPath: prproj, sequenceName: 'Clase 14', mode: 'generate', markerSlug: 'Marcador 1',
    generalInstruction: 'azul de marca', sequenceInstruction: 'blanco y negro',
  } }));
  await dejarCorrer();

  eq(c.espia.preparados[0].generalInstruction, 'azul de marca');
  eq(c.espia.preparados[0].sequenceInstruction, 'blanco y negro', 'los dos niveles, no medio contexto');
});

// ── La generación normal, desde la tarjeta del marcador ──────────────
// main.js no se puede montar sin un DOM entero, así que lo que se fija es la
// forma del payload que arma: los dos niveles SEPARADOS. Combinarlos acá sería
// resolver la precedencia antes de que el prompt pueda nombrarla.

test('main.js manda los dos niveles por separado, sin combinarlos', function () {
  const main = fs.readFileSync(path.join(CEP, 'main.js'), 'utf8');
  has(main, 'generalInstruction: genTxt.projectText',
    'el del curso va como el nivel del curso');
  has(main, 'sequenceInstruction: genTxt.sequenceText',
    'y el de la clase como el de la clase');
  ok(main.indexOf('genTxt.text') === -1,
    'no queda ningún "el que gana": ese campo se fue con la semántica de reemplazo');
});

// ── La interfaz: dos campos, y ningún destino que elegir ─────────────

test('el panel tiene un campo por nivel, cada uno con su rótulo', function () {
  const html = fs.readFileSync(path.join(__dirname, '..', 'cep', 'index.html'), 'utf8');
  has(html, 'id="general-instruction"', 'el del curso');
  has(html, 'id="general-sequence-instruction"', 'y el de la secuencia');
  has(html, 'Prompt general · TODO el curso');
  has(html, 'id="general-sequence-label"', 'el rótulo del otro lo escribe la vista con el nombre de la clase');
});

test('ya no hay botón de cambiar destino ni caja de "la base que estás pisando"', function () {
  // Existían porque un solo campo tenía que decidir a qué archivo escribía. Con
  // un campo por archivo no hay nada que elegir, y dejarlos sería ofrecer una
  // acción que no hace nada.
  const html = fs.readFileSync(path.join(__dirname, '..', 'cep', 'index.html'), 'utf8');
  ok(html.indexOf('btn-general-scope') === -1, 'sin botón de destino');
  ok(html.indexOf('general-base-text') === -1, 'sin caja de la base pisada');
  const vista = fs.readFileSync(path.join(CEP, 'general-view.js'), 'utf8');
  ok(vista.indexOf('switchScope') === -1, 'y la vista no lo llama');
  const modulo = fs.readFileSync(path.join(CEP, 'general-prompt.js'), 'utf8');
  ok(modulo.indexOf('function switchScope') === -1, 'ni el módulo lo expone');
});

test('el cartel de conflicto SÍ sigue: no era parte del botón de destino', function () {
  // Sacarlo con el botón hubiera tirado en silencio texto escrito por un editor,
  // que es exactamente la clase de pérdida por la que este bug existió.
  const html = fs.readFileSync(path.join(__dirname, '..', 'cep', 'index.html'), 'utf8');
  has(html, 'id="general-conflict"');
  const modulo = fs.readFileSync(path.join(CEP, 'general-prompt.js'), 'utf8');
  has(modulo, 'resolvePending');
});

// ── Lo que dice el ⬇ Log ─────────────────────────────────────────────
// La línea por la que se descubrió todo esto. Que diga "sí" y se calle qué
// niveles entraron dejaría el mismo agujero un escalón más arriba, ahora que el
// del curso y el de la secuencia van los dos y pueden contradecirse.

test('el log dice QUÉ niveles viajaron, no cuál ganó', function () {
  const etiqueta = engine._generalPromptLabel;
  eq(etiqueta({ generalInstruction: 'azul de marca', sequenceInstruction: '' }), 'del curso');
  eq(etiqueta({ generalInstruction: '', sequenceInstruction: 'blanco y negro' }), 'solo de esta secuencia');
  const dos = etiqueta({ generalInstruction: 'azul', sequenceInstruction: 'blanco y negro' });
  has(dos, 'del curso + de esta secuencia');
  has(dos, 'manda la secuencia', 'y con qué precedencia se mandaron');
});

test('sin prompt general el log sigue diciendo exactamente “no”', function () {
  // Es el texto por el que se buscó en el log del editor. Cambiarlo dejaría los
  // logs viejos sin con qué comparar.
  eq(engine._generalPromptLabel({ generalInstruction: '', sequenceInstruction: '' }), 'no');
  eq(engine._generalPromptLabel({ generalInstruction: '   ', sequenceInstruction: '  ' }), 'no',
    'un prompt en blanco es no tener prompt');
  eq(engine._generalPromptLabel({}), 'no');
});

test('un job encolado antes de la 1.5.0 no recibe un nivel inventado', function () {
  // Mandaba un solo texto ya resuelto y su origen aparte. Con el origen se
  // respeta a qué nivel era; sin él se dice que no se sabe.
  const etiqueta = engine._generalPromptLabel;
  has(etiqueta({ generalInstruction: 'azul de marca' }), 'origen desconocido');
  eq(etiqueta({ generalInstruction: 'blanco y negro', generalSource: 'sequence' }), 'solo de esta secuencia');
  eq(etiqueta({ generalInstruction: 'azul de marca', generalSource: 'project' }), 'del curso');
});

test('el texto de un job de antes de la 1.5.0 entra igual en el prompt', function () {
  // Un job restaurado de queue.json en una máquina que no puede leer el
  // proyecto: la cola no lo puede releer, así que sale con lo que traía. Perder
  // el estilo por eso sería el bug original con otra excusa.
  const p = pedido({ generalInstruction: 'blanco y negro', generalSource: 'sequence' });
  has(p, 'blanco y negro');
  has(p, 'Prompt de esta secuencia', 'y en el nivel que su origen decía');
});
