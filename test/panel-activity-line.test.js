'use strict';

// La línea de "qué está haciendo ahora" tal como la arma el panel. Es la
// misma función para la pestaña Cola y para la tarjeta del marcador, así que
// probarla acá cubre los dos lugares.
//
// El panel es JS de navegador sin módulos (se carga por <script>), así que se
// evalúa en un contexto de mentira con lo mínimo que necesita.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');

function cargarPanel() {
  const ctx = {
    console: console,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: function () { return 0; }, clearInterval: function () {},
    Date: Date, Math: Math, JSON: JSON, Set: Set,
    HPLog: { log: function () {} },
    // Estimación de la cola: por defecto sin calibrar (máquina nueva).
    HPQueue: {
      timing: { calibrated: function () { return ctx.calibrada; }, estimateSec: function () { return 42; } },
      isActive: function (s) { return s === 'queued' || s === 'modeling' || s === 'ready' || s === 'running'; },
    },
    calibrada: false,
    document: { createElement: function () { return { style: {}, setAttribute: function () {}, appendChild: function () {} }; } },
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  ['util.js', 'queue-view.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  });
  return ctx;
}

const panel = cargarPanel();
const linea = panel.HPQueueView.activityLine;

function job(extra) {
  return Object.assign({
    status: 'modeling', startedAt: Date.now() - 60000, markerDuration: 10,
  }, extra);
}

test('mientras el modelo cuenta lo que hace, eso es lo que se muestra', function () {
  const l = linea(job({ act: { label: 'razonando (1.200 tok) · …dónde poner el título', at: Date.now() } }));
  has(l, 'razonando', 'muestra lo que dijo el modelo');
  has(l, 'dónde poner el título');
});

test('si hace rato que no dice nada, se avisa (colgado ≠ pensando)', function () {
  const l = linea(job({ act: { label: 'leyendo un archivo', at: Date.now() - 5 * 60000 } }));
  has(l, 'leyendo un archivo', 'sigue diciendo lo último que se supo');
  has(l, 'sin novedad hace', 'y avisa que hace rato que no hay noticias');
});

test('un proveedor que no informa el detalle lo dice, en vez de quedar mudo', function () {
  // API directa, Ollama: no hay stream que leer. Callado se confunde con colgado.
  const l = linea(job({ act: null, startedAt: Date.now() - 60000 }));
  has(l, 'no informa el detalle');
});

test('el hueco entre dos llamadas del MISMO proveedor no lo trata de mudo', function () {
  // Entre el diseño y una corrección dirigida no hay actividad por unos
  // segundos; ahí decir "este proveedor no informa" sería falso.
  eq(linea(job({ act: null, _actSeen: true })), '', 'no dice nada, que es la verdad');
});

test('al principio no se apura a juzgar al proveedor', function () {
  eq(linea(job({ act: null, startedAt: Date.now() - 3000 })), '', 'tres segundos no es "no informa"');
});

test('durante el render se muestra cuánto debería tardar, si ya hay con qué calcularlo', function () {
  const j = job({ status: 'running', act: null });
  eq(linea(j), '', 'sin calibrar todavía, no se inventa un número');
  panel.calibrada = true;
  has(linea(j), 'estimado', 'ya con historial, dice cuánto suele tardar');
  panel.calibrada = false;
});

test('un texto larguísimo o con HTML no se cuela crudo en el panel', function () {
  // El texto sale de un modelo. Lo dibuja textContent (nunca innerHTML), así
  // que acá lo que se comprueba es que la línea lo pase tal cual, sin armar
  // marcado: si alguien cambia esto por innerHTML, el test sigue pasando pero
  // el CSS de .qj-act (una línea, con ellipsis) es lo que sostiene el layout.
  const veneno = '<img src=x onerror=alert(1)> ' + 'x'.repeat(500);
  const l = linea(job({ act: { label: veneno, at: Date.now() } }));
  eq(l, '↳ ' + veneno, 'la vista recibe texto plano, sin interpretarlo');
});

test('un job terminado o en espera no muestra ninguna línea de actividad', function () {
  eq(linea(job({ status: 'done', act: null })), '');
  eq(linea(job({ status: 'queued', act: null })), '');
  eq(linea(job({ status: 'error', act: null })), '');
});
