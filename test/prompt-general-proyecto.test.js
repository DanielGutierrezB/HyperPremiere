'use strict';

// El "Prompt general" —el estilo del curso— tiene que viajar con el proyecto.
//
// El caso real: dos editores comparten el mismo .prproj. Uno escribe la marca,
// la paleta y la tipografía en el panel; el otro abre la misma clase y genera
// con el campo vacío. Mismo marcador, contexto distinto, animaciones peores. En
// su log, las tres generaciones decían lo mismo:
//
//     prompt general no
//
// Vivía en el localStorage de cada panel, con una clave por proyecto Y
// secuencia. Ahora vive al lado del .prproj: una BASE del proyecto y, si una
// clase lo necesita, uno propio de la secuencia que la pisa.
//
// Se prueban las tres cosas que pueden salir mal y no fallan solas:
// que el prompt llegue al modelo en la máquina que NO lo escribió, que la
// migración de lo que ya estaba en localStorage no pierda nada, y que el log
// diga de dónde salió.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const engine = require('../bridge/engine.js');
const CEP = path.join(__dirname, '..', 'cep', 'js');

// ── Un proyecto de verdad en un tmpdir ───────────────────────────────
// El filesystem es de verdad a propósito: lo que se está probando es dónde
// quedan los archivos y que sobrevivan a cambiar de máquina, y un fs de mentira
// contestaría lo que le pidamos.

function proyectoNuevo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-prompt-'));
  return path.join(dir, 'Curso de IA.prproj');
}

/** Dónde deberían quedar los dos archivos, según la convención del proyecto. */
function rutas(projectPath, slugSecuencia) {
  const raiz = path.join(path.dirname(projectPath), 'HyperPremiere');
  return {
    base: path.join(raiz, 'prompt-general.md'),
    secuencia: path.join(raiz, slugSecuencia, 'prompt-general.md'),
  };
}

// ── Dónde se guarda ──────────────────────────────────────────────────

test('la base va al lado del .prproj, no adentro de una secuencia', function () {
  const prproj = proyectoNuevo();
  const r = engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14',
    text: 'tipografía Inter, azul de marca', scope: 'project',
  });
  ok(r.ok, 'se guardó');
  eq(r.path, rutas(prproj, 'clase-14').base, 'en la carpeta del proyecto, junto a queue.json');
  ok(!fs.existsSync(rutas(prproj, 'clase-14').secuencia), 'y no en la de la secuencia');
});

test('el archivo es texto plano, legible y editable a mano', function () {
  // Es prosa. En un JSON las líneas se escaparían a "\n" y dejaría de ser algo
  // que el editor pueda abrir y arreglar, que es medio punto de guardarlo ahí.
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({
    projectPath: prproj, text: 'tipografía Inter\nazul #1e40af\ntono sobrio', scope: 'project',
  });
  const crudo = fs.readFileSync(rutas(prproj, 'x').base, 'utf8');
  eq(crudo, 'tipografía Inter\nazul #1e40af\ntono sobrio\n', 'tal cual, con sus saltos de línea');
});

test('lo que se escriba a mano en el archivo se lee igual', function () {
  const prproj = proyectoNuevo();
  const f = rutas(prproj, 'x').base;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '\n  azul de marca, tipografía Inter  \n\n', 'utf8');
  const r = engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' });
  eq(r.text, 'azul de marca, tipografía Inter', 'los espacios de más no cambian el prompt');
  eq(r.source, 'project');
});

test('preguntar por el prompt general no deja carpetas por ahí', function () {
  // La pestaña de correcciones tuvo este mismo bug: abrir el panel creaba la
  // carpeta de cada secuencia que se mirara.
  const prproj = proyectoNuevo();
  const r = engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' });
  eq(r.source, 'none');
  ok(!fs.existsSync(path.join(path.dirname(prproj), 'HyperPremiere')),
    'no se creó nada por consultar');
});

// ── La secuencia que pisa la base ────────────────────────────────────

test('el propio de una secuencia REEMPLAZA la base, no se le suma', function () {
  // Sumarlos deja al modelo con dos indicaciones que pueden contradecirse
  // ("tipografía Inter" + "tipografía Roboto") y eligiendo él. Es exactamente la
  // clase de contexto turbio que este cambio vino a sacar.
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'tipografía Inter, azul', scope: 'project' });
  engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14',
    text: 'tipografía Roboto, verde', scope: 'sequence',
  });

  const r = engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' });
  eq(r.text, 'tipografía Roboto, verde', 'va el de la secuencia, entero y solo');
  eq(r.source, 'sequence');
  eq(r.projectText, 'tipografía Inter, azul', 'la base sigue disponible para mostrarla');
});

test('la base sigue valiendo para las demás secuencias', function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'tipografía Inter, azul', scope: 'project' });
  engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: 'verde', scope: 'sequence',
  });
  const otra = engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 15' });
  eq(otra.text, 'tipografía Inter, azul');
  eq(otra.source, 'project');
});

test('vaciar el de una secuencia es volver a la base: se borra el archivo', function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: 'verde', scope: 'sequence',
  });
  const r = engine.saveGeneralPrompt({
    projectPath: prproj, sequenceName: 'Clase 14', text: '', scope: 'sequence',
  });
  ok(r.removed, 'se borró');
  ok(!fs.existsSync(rutas(prproj, 'clase-14').secuencia),
    'sin archivo vacío diciendo "esta clase tiene el suyo" con nada adentro');
  eq(engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' }).source, 'project');
});

test('vaciar la base se anota, pero no crea carpetas por las dudas', function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: '', scope: 'project' });
  ok(!fs.existsSync(rutas(prproj, 'x').base), 'no había nada: no se escribe nada');

  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul', scope: 'project' });
  engine.saveGeneralPrompt({ projectPath: prproj, text: '', scope: 'project' });
  ok(fs.existsSync(rutas(prproj, 'x').base), 'lo que ya existía queda, vacío');
  const r = engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' });
  eq(r.source, 'none');
  eq(r.hasProjectFile, true, 'y el proyecto DIJO que no hay base: no es lo mismo que no haber decidido');
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

// ── El caso del compañero ────────────────────────────────────────────

test('el compañero abre el proyecto SIN nada en su localStorage y el prompt le llega igual', async function () {
  // Este es el bug entero, de punta a punta. La máquina A escribe el estilo del
  // curso; la máquina B —localStorage vacío, nunca vio esta clase— tiene que
  // generar con el mismo contexto.
  const prproj = proyectoNuevo();

  const maquinaA = montarPanel();
  conPromptLocal(maquinaA, prproj, 'Clase 14', 'tipografía Inter, azul #1e40af, tono sobrio');
  await maquinaA.ctx.HPGeneral.migrate(prproj, 'Clase 14');

  const maquinaB = montarPanel(); // localStorage propio, vacío
  const st = await maquinaB.ctx.HPGeneral.migrate(prproj, 'Clase 14');

  eq(st.text, 'tipografía Inter, azul #1e40af, tono sobrio', 'el estilo del curso llegó a la otra máquina');
  eq(st.source, 'project');
  eq(maquinaB.ctx.HPGeneral.state(prproj, 'Clase 14').text, st.text,
    'y lo que va al payload es lo mismo que se ve en el campo');
});

test('en la máquina del compañero, el panel dice de dónde sale (y no lo deja adivinar)', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });

  const p = montarPanel();
  await p.ctx.HPGeneral.load(prproj, 'Clase 14');
  const v = p.ctx.HPGeneral.describe(prproj, 'Clase 14');
  has(v.badge, 'base del proyecto');
  has(v.line, 'viaja con el .prproj');
  eq(v.badgeState, 'ok');
});

test('sin nada, el panel dice que el proyecto NO lleva el estilo del curso', async function () {
  // El renglón que faltaba: "opcional" hacía pensar en una preferencia de este
  // panel. Lo que pasa de verdad es que quien abra el proyecto genera a ciegas.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  await p.ctx.HPGeneral.load(prproj, 'Clase 14');
  const v = p.ctx.HPGeneral.describe(prproj, 'Clase 14');
  has(v.badge, 'no viaja con el proyecto');
  eq(v.offerOwn, false, 'sin base no hay nada que pisar: no se ofrece uno propio');
});

test('antes de que conteste el disco, el panel NO dice que no hay estilo', function () {
  // "No sé todavía" y "no hay" son cosas distintas, y el badge las decía igual:
  // al abrir el panel acusaba al proyecto de no llevar el estilo del curso
  // mientras la lectura seguía en camino. `loaded` existe justo para separarlas.
  const p = montarPanel();
  const v = p.ctx.HPGeneral.describe(proyectoNuevo(), 'Clase 14');
  has(v.badge, 'leyendo');
  ok(v.badge.indexOf('no viaja con el proyecto') === -1, 'todavía no puede afirmar eso');
  eq(v.offerOwn, false, 'ni ofrecer botones sobre algo que no leyó');
});

test('cuando la secuencia pisa la base, se ve que la está pisando y cuál', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  engine.saveGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14', text: 'verde', scope: 'sequence' });

  const p = montarPanel();
  await p.ctx.HPGeneral.load(prproj, 'Clase 14');
  const v = p.ctx.HPGeneral.describe(prproj, 'Clase 14');
  has(v.line, 'PISA la base del proyecto');
  eq(v.lineState, 'override');
  eq(v.showBase, true, 'y la base está a mano para poder compararla');
  eq(v.baseText, 'azul de marca');
  eq(v.scope, 'sequence', 'lo que se tipee se guarda en el archivo de la secuencia');
  eq(v.ownLabel, 'Volver a la base del proyecto');
});

// ── En qué archivo escribe el campo ──────────────────────────────────
// El destino de escritura se deducía de qué archivo existiera en el disco, y
// vaciar el prompt de una secuencia BORRA su archivo. O sea que el editor que
// seleccionaba todo y borraba para reescribir, en el tecleo siguiente estaba
// escribiendo la base de TODO el proyecto, que le llega a los demás. Nada
// fallaba: el texto se guardaba, en el archivo equivocado.
//
// Ahora el destino es estado, lo mueven solamente las dos acciones del botón, y
// el campo muestra siempre el archivo al que escribe.

/** Lo que hace el panel con cada tecleo: guardar en el destino que tenga el campo. */
function tipear(panel, projectPath, sequenceName, texto) {
  const scope = panel.ctx.HPGeneral.describe(projectPath, sequenceName).scope;
  return panel.ctx.HPGeneral.save(projectPath, sequenceName, texto, scope);
}

test('vaciar el prompt de una secuencia para reescribirlo NO toca la base del proyecto', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  engine.saveGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14', text: 'verde', scope: 'sequence' });

  const p = montarPanel();
  await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  eq(p.ctx.HPGeneral.describe(prproj, 'Clase 14').scope, 'sequence');

  await tipear(p, prproj, 'Clase 14', '');                                  // seleccionó todo y borró
  await tipear(p, prproj, 'Clase 14', 'paleta de esta clase: blanco y negro'); // y volvió a escribir

  eq(fs.readFileSync(rutas(prproj, 'x').base, 'utf8').trim(), 'azul de marca',
    'la base la comparten todos los editores: reescribirla no puede ser un efecto de borrar un campo');
  eq(engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14' }).sequenceText,
    'paleta de esta clase: blanco y negro', 'lo tipeado quedó donde el editor lo estaba escribiendo');
});

test('con el prompt de la secuencia vacío, el campo sigue vacío y no muestra la base', async function () {
  // Si el campo se llenara con la base, el tecleo siguiente la reescribiría
  // creyendo que la está editando. Campo y destino no se pueden separar.
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  engine.saveGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14', text: 'verde', scope: 'sequence' });

  const p = montarPanel();
  await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  await tipear(p, prproj, 'Clase 14', '');

  const v = p.ctx.HPGeneral.describe(prproj, 'Clase 14');
  eq(v.scope, 'sequence', 'sigue escribiendo en la secuencia');
  eq(v.fieldText, '', 'y el campo muestra eso: vacío');
  has(v.line, 'Propio de esta secuencia', 'el renglón dice dónde se está escribiendo');
  has(v.line, 'vale la base del proyecto', 'y que mientras tanto viaja la base');
  eq(p.ctx.HPGeneral.state(prproj, 'Clase 14').text, 'azul de marca',
    'lo que le llega al modelo mientras tanto ES la base');
});

test('volver a la base es el botón, y repinta el campo con lo que va a valer', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  engine.saveGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14', text: 'verde', scope: 'sequence' });

  const p = montarPanel();
  await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  await p.ctx.HPGeneral.switchScope(prproj, 'Clase 14', 'project');

  const v = p.ctx.HPGeneral.describe(prproj, 'Clase 14');
  eq(v.scope, 'project', 'ahora sí se escribe en la base');
  eq(v.fieldText, 'azul de marca', 'y el campo muestra la base, que es lo que se va a editar');
  ok(!fs.existsSync(rutas(prproj, 'clase-14').secuencia), 'el propio de la clase se borró');

  await tipear(p, prproj, 'Clase 14', 'azul de marca, SIN glow');
  eq(fs.readFileSync(rutas(prproj, 'x').base, 'utf8').trim(), 'azul de marca, SIN glow',
    'y lo que se tipea después va a la base, que es lo que se pidió');
});

test('“usar uno propio” arranca con una copia de la base, no en blanco', async function () {
  // Empezar vacío sería volver a generar sin el estilo del curso, que es el bug.
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });

  const p = montarPanel();
  await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  await p.ctx.HPGeneral.switchScope(prproj, 'Clase 14', 'sequence');

  const v = p.ctx.HPGeneral.describe(prproj, 'Clase 14');
  eq(v.scope, 'sequence');
  eq(v.fieldText, 'azul de marca');
  eq(fs.readFileSync(rutas(prproj, 'x').base, 'utf8').trim(), 'azul de marca', 'la base no se toca');
  eq(engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 15' }).text, 'azul de marca',
    'ni les cambia nada a las otras clases');
});

test('guardar no vuelve a leer el disco', async function () {
  // Por acá pasa CADA tecleo del campo (con debounce). Releer era una segunda
  // llamada al motor por tecla para enterarse de lo que se acababa de escribir.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  await p.ctx.HPGeneral.load(prproj, 'Clase 14');
  p.espia.llamadas.length = 0;

  await tipear(p, prproj, 'Clase 14', 'azul de marca');

  eq(p.espia.llamadas.join(','), 'saveGeneralPrompt', 'una escritura, y nada más');
  const st = p.ctx.HPGeneral.state(prproj, 'Clase 14');
  eq(st.text, 'azul de marca', 'y la caché quedó al día igual');
  eq(st.source, 'project');
});

test('leer el prompt general no escribe nada', async function () {
  // load() es lectura pura. Lo que sube algo al proyecto es migrate(), y eso lo
  // pide la interfaz: ver el test de la cola, más abajo.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  conPromptLocal(p, prproj, 'Clase 14', 'azul de marca');

  const st = await p.ctx.HPGeneral.load(prproj, 'Clase 14');

  eq(st.source, 'none', 'el proyecto no tiene nada, y leer no se lo inventa');
  ok(!fs.existsSync(rutas(prproj, 'x').base), 'no se escribió ningún archivo');
  eq(promptLocalDe(p, prproj, 'Clase 14'), 'azul de marca', 'ni se limpió el localStorage');
});

// ── La migración desde el localStorage ───────────────────────────────

test('lo que estaba en el localStorage pasa a ser la base del proyecto', async function () {
  const prproj = proyectoNuevo();
  const p = montarPanel();
  conPromptLocal(p, prproj, 'Clase 14', 'tipografía Inter, azul de marca');

  const st = await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');

  eq(st.source, 'project', 'ahora es del proyecto');
  eq(fs.readFileSync(rutas(prproj, 'clase-14').base, 'utf8').trim(), 'tipografía Inter, azul de marca');
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
  eq(fs.readFileSync(rutas(prproj, 'x').base, 'utf8').trim(), 'lo que escribió el otro editor',
    'el archivo del proyecto no se tocó');
});

test('con dos textos distintos no se pisa ninguno: se pregunta cuál vale', async function () {
  // De un lado está lo que escribió quien tiene el panel adelante; del otro, lo
  // que puso su compañero en el proyecto. Elegir por ellos es tirar el trabajo
  // de alguno sin decírselo.
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  const p = montarPanel();
  conPromptLocal(p, prproj, 'Clase 14', 'verde, tipografía Roboto');

  const st = await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  eq(st.pending, 'verde, tipografía Roboto', 'el texto de esta máquina quedó entero, apartado');
  eq(st.text, 'azul de marca', 'y mientras tanto viaja el del proyecto, que es el que comparten');
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

test('“es el de esta clase” lo guarda como propio y deja la base intacta', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  const p = montarPanel();
  conPromptLocal(p, prproj, 'Clase 14', 'verde, tipografía Roboto');
  await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');

  const st = await p.ctx.HPGeneral.resolvePending(prproj, 'Clase 14', 'sequence');
  eq(st.source, 'sequence');
  eq(st.text, 'verde, tipografía Roboto');
  eq(st.pending, '', 'no se vuelve a preguntar');
  eq(engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 15' }).text, 'azul de marca',
    'las otras clases siguen con la base');
});

test('“que sea la base” reemplaza la del proyecto y le llega a todas', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  const p = montarPanel();
  conPromptLocal(p, prproj, 'Clase 14', 'verde, tipografía Roboto');
  await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');

  const st = await p.ctx.HPGeneral.resolvePending(prproj, 'Clase 14', 'project');
  eq(st.source, 'project');
  eq(engine.loadGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 99' }).text, 'verde, tipografía Roboto');
});

test('descartarlo deja el del proyecto y no vuelve a preguntar', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  const p = montarPanel();
  conPromptLocal(p, prproj, 'Clase 14', 'verde, tipografía Roboto');
  await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');

  const st = await p.ctx.HPGeneral.resolvePending(prproj, 'Clase 14', 'discard');
  eq(st.text, 'azul de marca');
  eq(st.pending, '');
  const otraVez = await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  eq(otraVez.pending, '');
});

test('si el proyecto DIJO que no hay base, lo local no la resucita solo', async function () {
  // El archivo existe y está vacío: alguien lo borró a propósito. Volver a
  // llenarlo con lo que quedó en una máquina sería deshacerle el cambio.
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul', scope: 'project' });
  engine.saveGeneralPrompt({ projectPath: prproj, text: '', scope: 'project' });
  const p = montarPanel();
  conPromptLocal(p, prproj, 'Clase 14', 'verde');

  const st = await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  eq(st.pending, 'verde', 'se pregunta');
  eq(fs.readFileSync(rutas(prproj, 'x').base, 'utf8').trim(), '', 'y la base sigue vacía');
});

test('sin motor, no se pierde el prompt que tiene esta máquina', async function () {
  // El proyecto puede estar en un disco desmontado. Dar por sentado que no hay
  // estilo sería volver al bug: generar en blanco sin que nada lo diga.
  const prproj = proyectoNuevo();
  const p = montarPanel({ sinMotor: true });
  conPromptLocal(p, prproj, 'Clase 14', 'azul de marca');

  const st = await p.ctx.HPGeneral.migrate(prproj, 'Clase 14');
  eq(st.text, 'azul de marca', 'se sigue generando con lo que hay');
  eq(st.source, 'local');
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

test('el marcador que se genera en la otra máquina sale CON el estilo del curso', async function () {
  // El final del caso del compañero: no alcanza con que el panel lo lea, tiene
  // que entrar en la llamada al modelo. Es lo que decidía si la animación salía
  // como la del otro editor o genérica.
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'tipografía Inter, azul #1e40af', scope: 'project' });

  const c = montarCola(); // localStorage vacío: es otra máquina
  c.ctx.HPStore.setContext(prproj, 'Clase 14');
  c.ctx.HPQueue.add(jobDe(prproj));
  await dejarCorrer();

  eq(c.espia.preparados.length, 1, 'se llamó al modelo');
  eq(c.espia.preparados[0].generalInstruction, 'tipografía Inter, azul #1e40af');
  eq(c.espia.preparados[0].generalSource, 'project');
});

test('la secuencia con prompt propio manda el suyo, no la base', async function () {
  const prproj = proyectoNuevo();
  engine.saveGeneralPrompt({ projectPath: prproj, text: 'azul de marca', scope: 'project' });
  engine.saveGeneralPrompt({ projectPath: prproj, sequenceName: 'Clase 14', text: 'verde y serif', scope: 'sequence' });

  const c = montarCola();
  c.ctx.HPStore.setContext(prproj, 'Clase 14');
  c.ctx.HPQueue.add(jobDe(prproj));
  await dejarCorrer();

  eq(c.espia.preparados[0].generalInstruction, 'verde y serif');
  eq(c.espia.preparados[0].generalSource, 'sequence');
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

test('la cola NO promueve a base del proyecto lo que había en esta máquina', async function () {
  // La cola le pide el prompt general a la secuencia de CUALQUIER job: uno
  // restaurado de otra sesión, una corrección de un corte que nunca se abrió
  // acá. Mientras leer también migraba, encolar eso podía convertir en la base
  // de TODO el proyecto —para los dos editores— un texto que estaba en una sola
  // máquina, desde un camino que nadie mira. Y cuál ganaba dependía de qué job
  // se hubiera cargado primero.
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

  ok(!fs.existsSync(rutas(prproj, 'x').base),
    'el proyecto no tiene base nueva: nadie eligió que ese texto lo fuera');
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
    generalInstruction: 'azul de marca', generalSource: 'project',
  } }));
  await dejarCorrer();

  eq(c.espia.preparados[0].generalInstruction, 'azul de marca');
});

// ── Lo que dice el ⬇ Log ─────────────────────────────────────────────
// La línea por la que se descubrió todo esto. Que diga "sí" y se calle de dónde
// vino dejaría el mismo agujero un escalón más arriba, ahora que la base y el
// prompt de la secuencia pueden no coincidir.

test('el log dice de dónde salió el prompt general', function () {
  const etiqueta = engine._generalSourceLabel;
  eq(etiqueta('azul de marca', 'project'), 'de la base del proyecto');
  has(etiqueta('verde', 'sequence'), 'pisa la base del proyecto');
});

test('sin prompt general el log sigue diciendo exactamente “no”', function () {
  // Es el texto por el que se buscó en el log del editor. Cambiarlo dejaría los
  // logs viejos sin con qué comparar.
  eq(engine._generalSourceLabel('', 'none'), 'no');
  eq(engine._generalSourceLabel('   ', 'project'), 'no', 'un prompt en blanco es no tener prompt');
});

test('un job de una versión anterior no recibe un origen inventado', function () {
  // Vino texto pero no de dónde: se dice que hubo, y que no se sabe cuál.
  has(engine._generalSourceLabel('azul de marca', undefined), 'origen desconocido');
});
