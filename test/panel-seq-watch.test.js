'use strict';

// El vigilante de "cambiaste de secuencia en Premiere" (cep/js/seq-watch.js).
//
// El bug que originó esto: en Windows el panel va acoplado adentro de la
// ventana de Premiere, así que `window.focus` NUNCA se dispara y el panel se
// quedaba creyendo que seguías en la secuencia anterior. Por eso el test más
// importante de acá es el primero: enterarse SIN que llegue un solo focus.
//
// El panel es JS de navegador sin módulos (se carga por <script>), así que se
// evalúa en un contexto de mentira con lo mínimo que necesita. Los timers son
// falsos: el test decide cuándo pasa el tiempo, en vez de esperarlo.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, deepEq } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');

function cargarPanel() {
  const ctx = {
    console: console,
    Date: Date, Math: Math, JSON: JSON, String: String,
    // Reloj y timers manuales.
    _tick: null,
    setInterval: function (fn) { ctx._tick = fn; return 7; },
    clearInterval: function () { ctx._tick = null; },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(CEP, 'seq-watch.js'), 'utf8'), ctx, { filename: 'seq-watch.js' });
  return ctx;
}

const panel = cargarPanel();

/**
 * Arma un vigilante con Premiere de mentira.
 *  premiere.responder(nombre) → contesta la consulta que quedó en vuelo
 *  premiere.avisos            → lo que se le fue diciendo al cartel
 */
function armar(opts) {
  opts = opts || {};
  const premiere = { pendiente: null, avisos: [], oculto: false, ahora: 0, panelSeq: 'Clase 01' };
  premiere.watch = panel.HPSeqWatch.create({
    ask: function (cb) { premiere.pendiente = cb; },
    panelSequence: function () { return premiere.panelSeq; },
    onResult: function (otra) { premiere.avisos.push(otra); },
    hidden: function () { return premiere.oculto; },
    now: function () { return premiere.ahora; },
    lostMs: opts.lostMs || 60000,
  });
  premiere.responder = function (nombre) {
    const cb = premiere.pendiente;
    premiere.pendiente = null;
    if (cb) cb(nombre);
  };
  // Una vuelta del sondeo (lo que haría el setInterval real).
  premiere.sondear = function () { panel._tick(); };
  premiere.watch.start();
  return premiere;
}

test('se entera del cambio de secuencia SIN que llegue nunca un focus (el caso Windows)', function () {
  const p = armar();
  ok(panel._tick, 'el sondeo quedó andando solo, sin depender de ningún evento');

  p.sondear();
  p.responder('Clase 02');
  deepEq(p.avisos, ['Clase 02'], 'avisa que en Premiere está activa la otra secuencia');
});

test('si el sondeo anterior no volvió, el siguiente se saltea (no se encola otro)', function () {
  // Es lo que pasa mientras Premiere exporta el audio para transcribir:
  // ExtendScript queda bloqueado y las llamadas se apilarían justo cuando la
  // máquina está más ocupada.
  const p = armar();
  p.sondear();                       // pregunta y se queda esperando
  p.sondear();
  p.sondear();
  eq(p.watch.stats.asked, 1, 'una sola consulta en vuelo');
  eq(p.watch.stats.skippedBusy, 2, 'las otras dos se saltearon');

  p.responder('Clase 01');           // Premiere se liberó
  p.sondear();
  eq(p.watch.stats.asked, 2, 'liberado, vuelve a preguntar normal');
});

test('con el panel oculto no se le pregunta nada a Premiere', function () {
  const p = armar();
  p.oculto = true;
  p.sondear();
  p.sondear();
  eq(p.watch.stats.asked, 0, 'panel en otra pestaña o minimizado: no hay a quién avisarle');
  eq(p.watch.stats.skippedHidden, 2);

  p.oculto = false;
  p.sondear();
  eq(p.watch.stats.asked, 1, 'al volver a verse, retoma');
});

test('el aviso se limpia solo cuando volvés a la secuencia del panel', function () {
  const p = armar();
  p.sondear(); p.responder('Clase 02');
  p.sondear(); p.responder('Clase 01');
  deepEq(p.avisos, ['Clase 02', ''], 'el "" es el cartel yéndose sin que el editor haga nada');
});

test('una respuesta que no vuelve nunca no deja el vigilante muerto', function () {
  // Un evalScript perdido (recarga del panel a mitad de camino) dejaría el
  // "hay una consulta en vuelo" prendido para siempre: sin esto, el panel
  // volvía a quedarse ciego, que es el bug original con otro disfraz.
  const p = armar({ lostMs: 60000 });
  p.sondear();
  p.pendiente = null;                // la respuesta se perdió en el camino
  p.ahora = 30000;
  p.sondear();
  eq(p.watch.stats.asked, 1, 'medio minuto todavía no es "perdida": sigue esperando');

  p.ahora = 61000;
  p.sondear();
  eq(p.watch.stats.asked, 2, 'pasado el límite la da por perdida y revive');
  p.responder('Clase 02');
  deepEq(p.avisos, ['Clase 02']);
});

test('una respuesta atrasada de una consulta perdida no habla por la de ahora', function () {
  const p = armar({ lostMs: 1000 });
  p.sondear();
  const vieja = p.pendiente;
  p.ahora = 5000;
  p.sondear();                       // arranca una consulta nueva
  vieja('Clase 09');                 // la vieja contesta tarde
  deepEq(p.avisos, [], 'lo que dijo llegó tarde: no se muestra como si fuera de ahora');
  p.responder('Clase 02');
  deepEq(p.avisos, ['Clase 02'], 'manda la consulta vigente');
});

test('un error del host o un proyecto sin secuencia no arman aviso', function () {
  const p = armar();
  p.sondear(); p.responder('Error: no such element');
  p.sondear(); p.responder('(sin secuencia activa)');
  p.sondear(); p.responder('');
  deepEq(p.avisos, [], 'callarse es mejor que avisar cualquier cosa');
});

test('dejar de vigilar corta el sondeo', function () {
  const p = armar();
  p.watch.stop();
  eq(panel._tick, null, 'sin panel no queda un timer preguntándole a Premiere');
});
