'use strict';

// El micrófono del dictado, del lado del panel: la fila de ⚙, el medidor y lo
// que el botón 🎙 dice de él.
//
// Lo que se fija acá es que el editor VEA cuál micrófono se va a usar sin tener
// que adivinarlo: en el desplegable de ⚙ (con el default del sistema marcado y
// el elegido que hoy no está enchufado dicho como tal), en el tooltip del 🎙 y
// en la línea de estado mientras dicta. Y que todo eso quede en el ⬇ Log, que
// es lo único que llega cuando el que tiene el problema está en otra máquina.
//
// El medidor dibujado no se puede probar acá: el DOM de mentira no calcula
// cajas ni pinta. Lo que sí se fija es la geometría (de dBFS a ancho de barra)
// y el color de cada veredicto, que es lo que decide qué se ve. El dibujo se
// mira en la maqueta (test/manual/panel-demo).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const CEP = path.join(__dirname, '..', 'cep', 'js');

// ── DOM de mentira, el mismo de las otras suites del panel ───────────

function elemento(tag) {
  const el = {
    tagName: tag, children: [], listeners: {}, style: {}, className: '',
    textContent: '', value: '', title: '', type: '', disabled: false, atributos: {},
    appendChild: function (h) { this.children.push(h); h.parentNode = this; return h; },
    setAttribute: function (k, v) { this.atributos[k] = v; },
    getAttribute: function (k) { return this.atributos[k] === undefined ? null : this.atributos[k]; },
    removeAttribute: function (k) { delete this.atributos[k]; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    click: function () { (this.listeners.click || []).forEach(function (f) { f({ stopPropagation: function () {}, preventDefault: function () {} }); }); },
    focus: function () {},
    buscar: function (clase) {
      for (const h of this.children) {
        if (String(h.className).split(' ').indexOf(clase) !== -1) return h;
        const hit = h.buscar && h.buscar(clase);
        if (hit) return hit;
      }
      return null;
    },
    texto: function () {
      let t = String(this.textContent || '');
      for (const h of this.children) if (h.texto) t += h.texto();
      return t;
    },
  };
  el.classList = { add: function (c) { el.className = (el.className ? el.className + ' ' : '') + c; }, remove: function () {} };
  Object.defineProperty(el, 'innerHTML', { get: function () { return ''; }, set: function () { el.children.length = 0; } });
  return el;
}

const LISTA = [
  { indice: 0, nombre: 'iPhone de Daniel Microphone', porDefecto: false },
  { indice: 1, nombre: 'OBSBOT Meet 2 Microphone', porDefecto: false },
  { indice: 2, nombre: 'MacBook Pro Microphone', porDefecto: true },
];

/** La respuesta del motor a microfonoListar, según lo elegido. */
function respuestaDeLista(elegido) {
  const hay = LISTA.filter((d) => d.nombre === elegido)[0];
  let usa;
  if (hay) {
    usa = { entrada: ':' + hay.indice, indice: hay.indice, nombre: hay.nombre, elegido, origen: 'elegido', aviso: '' };
  } else if (elegido) {
    usa = {
      entrada: ':default', indice: 2, nombre: 'MacBook Pro Microphone', elegido, origen: 'caida',
      aviso: 'El micrófono elegido, «' + elegido + '», no está conectado ahora. Uso el que macOS tiene por defecto: «MacBook Pro Microphone» (índice 2).',
    };
  } else {
    usa = {
      entrada: ':default', indice: 2, nombre: 'MacBook Pro Microphone', elegido: '', origen: 'default',
      aviso: 'Todavía no elegiste micrófono: uso el que macOS tiene como entrada por defecto, «MacBook Pro Microphone» (índice 2). Se elige en ⚙ → Micrófono.',
    };
  }
  return { ok: true, dispositivos: LISTA, porDefecto: 'MacBook Pro Microphone', elegido, usa };
}

/**
 * Levanta config-ui.js con un DOM y un motor de mentira. `opts.elegido` es lo
 * que el motor tiene guardado; `opts.sinMedidor` no define HPMicMedidor ni
 * HPLog, que es cómo se ve el panel si esos <script> no cargaron.
 */
function armar(opts) {
  opts = opts || {};
  const nodos = {};
  const selects = {};
  const guardados = [];
  const llamadas = [];
  const log = [];
  let elegido = opts.elegido || '';
  const ctx = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, Date: Date, Math: Math, JSON: JSON,
    String: String, Number: Number, Object: Object, Array: Array, Promise: Promise,
    HPQueue: { getModelConcurrency: function () { return 3; }, setModelConcurrency: function (n) { return n; } },
    HPWidgets: {
      select: function (el) {
        const s = {
          nombre: el && el.id, value: '', onChange: null, opciones: [],
          setOptions: function (o, val) { this.opciones = o.slice(); this.value = val != null ? String(val) : ''; },
          elegir: function (v) { const cambio = v !== this.value; this.value = v; if (cambio && this.onChange) this.onChange(v); },
          etiquetas: function () { return this.opciones.map(function (o) { return o.label; }); },
          valores: function () { return this.opciones.map(function (o) { return o.value; }); },
        };
        selects[s.nombre] = s;
        return s;
      },
    },
    HPEngine: {
      call: function (metodo, body) {
        llamadas.push(metodo);
        if (metodo === 'setConfig') { guardados.push(body || {}); if (body && body.microfono !== undefined) elegido = body.microfono; return Promise.resolve({}); }
        if (metodo === 'getConfig') return Promise.resolve({ provider: 'claude-cli', model: 'claude-sonnet-5', effort: 'high', hasSession: true });
        if (metodo === 'microfonoListar') return Promise.resolve(opts.lista ? opts.lista(elegido) : respuestaDeLista(elegido));
        if (metodo === 'claudeSessionStatus') return Promise.resolve({ estado: 'con-sesion', resumen: '✓', detalle: '' });
        if (metodo === 'listClaudeModels') return Promise.resolve({ ok: false });
        return Promise.resolve(null);
      },
      callProg: function (metodo, body, prog) {
        llamadas.push(metodo);
        if (metodo === 'microfonoProbar') return opts.probar(prog);
        return Promise.resolve(null);
      },
    },
    HPDictado: { olvidarEstado: function () { llamadas.push('HPDictado.olvidarEstado'); } },
    document: {
      createElement: elemento,
      createTextNode: function (t) { const n = elemento('#text'); n.textContent = t; return n; },
      getElementById: function (id) { if (!nodos[id]) { nodos[id] = elemento('div'); nodos[id].id = id; } return nodos[id]; },
    },
  };
  if (!opts.sinMedidor) ctx.HPLog = { log: function (m, nivel) { log.push((nivel || 'INFO') + ' ' + m); } };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  // El desplegable en sí vive en mic-select.js desde la v1.4.49 (el mismo
  // control está también en el encabezado): config-ui.js monta esa vista y se
  // queda con lo que es solo de ⚙, la prueba con medidor.
  const archivos = opts.sinMedidor
    ? ['util.js', 'mic-select.js', 'config-ui.js']
    : ['util.js', 'mic-medidor.js', 'mic-select.js', 'config-ui.js'];
  archivos.forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  });
  ctx.HPConfigUI.init();
  return {
    ctx, nodos, guardados, llamadas, log,
    mic: function () { return selects['cfg-mic']; },
    estado: function () { return nodos['mic-status']; },
    medidor: function () { return nodos['mic-meter']; },
  };
}

function asentar(ms) { return new Promise(function (r) { setTimeout(r, ms || 20); }); }

// ── 1. La fila de ⚙ ──────────────────────────────────────────────────

test('la fila de ⚙ lista los micrófonos con el del sistema primero y marcado', async function () {
  const p = armar();
  await asentar();
  const etiquetas = p.mic().etiquetas();
  eq(etiquetas.length, 4, 'el del sistema + los tres de la lista: ' + etiquetas.join(' | '));
  has(etiquetas[0], 'Por defecto del sistema');
  has(etiquetas[0], 'MacBook Pro Microphone', 'con su nombre: "por defecto" a secas no le dice nada al editor');
  has(etiquetas[3], 'MacBook Pro Microphone · por defecto del sistema', 'y en la lista también está marcado');
  eq(p.mic().value, '', 'sin elección, el desplegable muestra "el del sistema"');
});

test('sin elección, la fila dice "todavía no elegiste" y cuál se está usando', async function () {
  const p = armar();
  await asentar();
  has(p.estado().textContent, 'Todavía no elegiste');
  has(p.estado().textContent, 'MacBook Pro Microphone');
  has(p.estado().textContent, 'índice 2');
});

test('con uno elegido, el desplegable lo muestra y la fila dice su índice de ahora', async function () {
  const p = armar({ elegido: 'OBSBOT Meet 2 Microphone' });
  await asentar();
  eq(p.mic().value, 'OBSBOT Meet 2 Microphone');
  has(p.estado().textContent, 'Elegido: «OBSBOT Meet 2 Microphone» (índice 1 ahora)');
});

test('el elegido que hoy no está enchufado se ve igual, dicho como "no conectado", en amarillo', async function () {
  const p = armar({ elegido: 'Auriculares de Daniel (2)' });
  await asentar();
  const etiquetas = p.mic().etiquetas();
  ok(etiquetas.some((e) => e === 'Auriculares de Daniel (2) · no conectado ahora'),
    'si desapareciera de la lista, el editor no vería qué tiene elegido ni podría conservarlo: ' + etiquetas.join(' | '));
  eq(p.mic().value, 'Auriculares de Daniel (2)', 'y sigue siendo la elección');
  has(p.estado().textContent, 'no está conectado ahora');
  has(p.estado().textContent, 'MacBook Pro Microphone', 'con cuál se usa en su lugar');
  has(p.estado().className, 'is-warn', 'en amarillo: no es un error, pero hay que verlo');
});

test('elegir un micrófono lo guarda por NOMBRE en la config del motor', async function () {
  const p = armar();
  await asentar();
  p.mic().elegir('OBSBOT Meet 2 Microphone');
  await asentar();
  const g = p.guardados.filter((x) => x.microfono !== undefined);
  eq(g.length, 1);
  eq(g[0].microfono, 'OBSBOT Meet 2 Microphone', 'el nombre, no "1": los índices cambian al enchufar algo');
  ok(p.llamadas.indexOf('HPDictado.olvidarEstado') !== -1, 'y los botones 🎙 se enteran');
  has(p.estado().textContent, 'Elegido: «OBSBOT Meet 2 Microphone»', 'la fila se refresca con lo guardado');
});

test('volver a "el del sistema" guarda vacío, no lo deja como estaba', async function () {
  const p = armar({ elegido: 'OBSBOT Meet 2 Microphone' });
  await asentar();
  p.mic().elegir('');
  await asentar();
  const g = p.guardados.filter((x) => x.microfono !== undefined);
  eq(g[0].microfono, '', 'vacío es una elección válida: "usá el que macOS tenga"');
});

test('el ↻ vuelve a preguntar por los micrófonos', async function () {
  const p = armar();
  await asentar();
  const antes = p.llamadas.filter((l) => l === 'microfonoListar').length;
  p.nodos['btn-mic-refresh'].click();
  await asentar();
  eq(p.llamadas.filter((l) => l === 'microfonoListar').length, antes + 1);
});

test('si el motor no puede listar, la fila lo dice y la salida cruda va al log', async function () {
  const p = armar({
    lista: function () { return { ok: false, error: 'No pude correr ffmpeg para listar los micrófonos.', crudo: 'spawn ffmpeg ENOENT' }; },
  });
  await asentar();
  has(p.estado().textContent, 'No pude listar los micrófonos');
  has(p.estado().className, 'is-error');
  ok(p.log.some((l) => /^ERROR .*No pude correr ffmpeg/.test(l)));
  ok(p.log.some((l) => /salida cruda de ffmpeg:\nspawn ffmpeg ENOENT/.test(l)), 'lo que ffmpeg escupió, tal cual');
});

// ── 2. Todo en el log ────────────────────────────────────────────────

test('cada vez que se enumera, la lista entera queda en el log con índices', async function () {
  const p = armar({ elegido: 'Auriculares de Daniel (2)' });
  await asentar();
  const linea = p.log.filter((l) => /^INFO Micrófonos \(al abrir el panel\)/.test(l))[0];
  ok(linea, 'la línea de la lista: ' + p.log.join('\n'));
  has(linea, '[0] iPhone de Daniel Microphone');
  has(linea, '[2] MacBook Pro Microphone');
  has(linea, 'por defecto del sistema: «MacBook Pro Microphone»');
  has(linea, 'elegido en ⚙: «Auriculares de Daniel (2)»');
  const uso = p.log.filter((l) => /Micrófono en uso:/.test(l))[0];
  has(uso, 'WARN', 'la caída al del sistema va como advertencia');
  has(uso, 'caida');
  has(uso, 'no está conectado ahora');
});

test('la elección también queda en el log', async function () {
  const p = armar();
  await asentar();
  p.mic().elegir('OBSBOT Meet 2 Microphone');
  await asentar();
  ok(p.log.some((l) => l === 'INFO Micrófono elegido en ⚙: «OBSBOT Meet 2 Microphone»'), p.log.join('\n'));
});

// ── 3. La prueba con medidor ─────────────────────────────────────────

/** Una prueba de mentira: tres niveles y un veredicto, como los manda el motor. */
function pruebaFalsa(estado) {
  return function (prog) {
    prog({ note: 'Prueba de micrófono · dispositivos: [2] MacBook Pro Microphone · por defecto del sistema: «MacBook Pro Microphone»' });
    prog({ msg: 'Abriendo «MacBook Pro Microphone»…', microfono: { nombre: 'MacBook Pro Microphone', indice: 2 } });
    prog({ nivel: { dbfs: -45, picoDbfs: -45, umbralDbfs: -34, pasa: false, segundos: 0.3, duracion: 7 } });
    prog({ nivel: { dbfs: -22, picoDbfs: -22, umbralDbfs: -34, pasa: true, segundos: 1.2, duracion: 7 } });
    prog({ nivel: { dbfs: -30, picoDbfs: -22, umbralDbfs: -34, pasa: true, segundos: 2.1, duracion: 7 } });
    prog({ note: 'Prueba de micrófono · resumen: 7 s de audio · 68 lecturas · mín -45 dBFS · máx -22 dBFS' });
    prog({ note: 'Prueba de micrófono · veredicto (' + estado + '): …', level: estado === 'ok' ? 'INFO' : 'ERROR' });
    return Promise.resolve({
      ok: true, estado: estado,
      titulo: estado === 'ok' ? 'Entra audio por «MacBook Pro Microphone» (índice 2) y pasa la compuerta del dictado.' : '«MacBook Pro Microphone» entrega audio, pero es silencio digital.',
      detalle: estado === 'ok' ? 'Promedio -28.0 dBFS, pico -22.0 dBFS; la compuerta está en -34.0 dBFS. Podés dictar.' : 'Casi siempre es el permiso de micrófono de macOS…',
    });
  };
}

test('apretar "Probar micrófono" corre la prueba, dibuja los niveles y pinta el veredicto', async function () {
  const p = armar({ probar: pruebaFalsa('ok') });
  await asentar();
  p.nodos['btn-mic-test'].click();
  await asentar();
  ok(p.llamadas.indexOf('microfonoProbar') !== -1);
  const meter = p.medidor();
  const fill = meter.buscar('mic-meter-fill');
  ok(fill, 'la barra existe');
  // La última lectura fue -30 dBFS sobre una barra de -60 a 0: la mitad.
  eq(fill.style.width, '50%');
  has(fill.className, 'is-ok', 'y verde, porque pasa la compuerta');
  const peak = meter.buscar('mic-meter-peak');
  eq(peak.style.left, porcentajeDe(-22) + '%', 'el pico sostenido queda donde estuvo el máximo, no donde está el nivel de ahora');
  const gate = meter.buscar('mic-meter-gate');
  eq(gate.style.left, porcentajeDe(-34) + '%', 'la compuerta del dictado, como referencia fija');
  const v = meter.buscar('mic-verdict');
  has(v.texto(), 'pasa la compuerta del dictado');
  has(v.texto(), 'Podés dictar');
  has(v.className, 'is-ok');
  eq(p.nodos['btn-mic-test'].disabled, false, 'el botón vuelve a estar disponible');
});

function porcentajeDe(dbfs) { return Math.max(0, Math.min(100, (dbfs + 60) / 60 * 100)); }

test('un veredicto malo se pinta en rojo, con el texto del motor tal cual', async function () {
  const p = armar({ probar: pruebaFalsa('silencio-digital') });
  await asentar();
  p.nodos['btn-mic-test'].click();
  await asentar();
  const v = p.medidor().buscar('mic-verdict');
  has(v.className, 'is-error');
  has(v.texto(), 'silencio digital');
  has(v.texto(), 'permiso de micrófono de macOS', 'el camino del permiso llega al editor, no se queda en el motor');
});

test('lo que el motor cuenta de la prueba va al log, incluido el veredicto', async function () {
  const p = armar({ probar: pruebaFalsa('ok') });
  await asentar();
  p.nodos['btn-mic-test'].click();
  await asentar();
  ok(p.log.some((l) => /^INFO Prueba de micrófono: arranca desde ⚙/.test(l)));
  ok(p.log.some((l) => /dispositivos: \[2\] MacBook Pro Microphone/.test(l)), 'la lista que vio el motor');
  ok(p.log.some((l) => /resumen: 7 s de audio · 68 lecturas/.test(l)), 'el resumen de niveles');
  ok(p.log.some((l) => /veredicto \(ok\)/.test(l)));
  ok(p.log.some((l) => /terminó con veredicto «ok»/.test(l)));
});

test('si la prueba no pudo correr, se dice en el medidor y en el log', async function () {
  const p = armar({ probar: function () { return Promise.resolve({ ok: false, error: 'Hay un dictado en curso (marcador:Marcador 3).' }); } });
  await asentar();
  p.nodos['btn-mic-test'].click();
  await asentar();
  const v = p.medidor().buscar('mic-verdict');
  has(v.texto(), 'La prueba no pudo correr');
  has(v.texto(), 'dictado en curso');
  ok(p.log.some((l) => /^ERROR Prueba de micrófono: no pudo correr: Hay un dictado en curso/.test(l)));
});

test('sin el módulo del medidor ni el log, la fila se arma igual', async function () {
  // Es la regla de toda esta parte: el dictado y su micrófono son un agregado a
  // ⚙, nunca un requisito. Si mic-medidor.js no cargó, el desplegable tiene
  // que seguir andando y la prueba no puede reventar la configuración.
  const p = armar({ sinMedidor: true, probar: pruebaFalsa('ok') });
  await asentar();
  eq(p.mic().etiquetas().length, 4);
  p.nodos['btn-mic-test'].click();
  await asentar();
  ok(p.llamadas.indexOf('microfonoProbar') !== -1, 'la prueba corre aunque no haya dónde dibujarla');
});

// ── 4. La geometría y el color del medidor ───────────────────────────

function cargarMedidor() {
  const ctx = { console: console, Math: Math, document: { createElement: elemento, createTextNode: function (t) { const n = elemento('#text'); n.textContent = t; return n; } } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(CEP, 'mic-medidor.js'), 'utf8'), ctx, { filename: 'mic-medidor.js' });
  return ctx.HPMicMedidor;
}

test('la barra va de -60 dBFS (vacía) a 0 (llena), y la compuerta cae adentro', function () {
  const M = cargarMedidor();
  eq(M._porcentaje(-60), 0);
  eq(M._porcentaje(0), 100);
  eq(M._porcentaje(-30), 50);
  eq(M._porcentaje(-100), 0, 'el silencio digital no se ve como una barrita negativa');
  eq(M._porcentaje(5), 100, 'ni lo que sature se sale de la barra');
  eq(M._porcentaje(null), 0);
  const compuerta = M._porcentaje(-34);
  ok(compuerta > 35 && compuerta < 50, 'la marca de la compuerta tiene que quedar a la vista, no pegada a un borde: ' + compuerta);
});

test('el color dice si se puede dictar: verde solo con "ok"', function () {
  const M = cargarMedidor();
  eq(M._claseDeVeredicto('ok'), 'is-ok');
  eq(M._claseDeVeredicto('floja'), 'is-warn', 'hay señal y el arreglo es de volumen: amarillo');
  eq(M._claseDeVeredicto('silencio-digital'), 'is-error');
  eq(M._claseDeVeredicto('sin-muestras'), 'is-error');
  eq(M._claseDeVeredicto('no-abre'), 'is-error');
});

test('la línea de números dice nivel, pico, compuerta y si pasa', function () {
  const M = cargarMedidor();
  const t = M._textoNivel({ dbfs: -28.4, picoDbfs: -21, umbralDbfs: -34, pasa: true, segundos: 3.2, duracion: 7 });
  has(t, '−28.4 dBFS');
  has(t, 'pico −21.0');
  has(t, 'compuerta −34.0');
  has(t, '· pasa');
  has(t, '3/7 s');
  has(M._textoNivel({ dbfs: -100, picoDbfs: -100, umbralDbfs: -34, pasa: false }), '−∞ dBFS · pico −∞');
});

// ── 5. El botón 🎙 dice con qué micrófono ─────────────────────────────

function cargarDictado() {
  const ctx = {
    console: console, Date: Date, Math: Math, JSON: JSON, Object: Object, String: String, Number: Number, Array: Array,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: function () { return 0; }, clearInterval: function () {},
    HPLog: { log: function () {} },
    HPEngine: { call: function () { return Promise.resolve({ ok: true, disponible: true }); } },
    HPStore: { addDictadoUsage: function () {} },
    document: { createElement: elemento },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(CEP, 'dictado.js'), 'utf8'), ctx, { filename: 'dictado.js' });
  return ctx.HPDictado;
}

test('el tooltip del 🎙 dice qué micrófono va a abrir, sin ir a ⚙', function () {
  const D = cargarDictado();
  const p = D._pintarBoton('listo', { microfono: { nombre: 'MacBook Pro Microphone', indice: 2, origen: 'default' } });
  has(p.titulo, '«MacBook Pro Microphone»');
  has(p.titulo, 'todavía no elegiste', 'y que es el del sistema porque no eligió, no porque alguien lo decidió por él');
  has(p.titulo, '⚙', 'y dónde se cambia');
  const e = D._pintarBoton('listo', { microfono: { nombre: 'OBSBOT Meet 2 Microphone', indice: 1, origen: 'elegido' } });
  has(e.titulo, '«OBSBOT Meet 2 Microphone» (elegido en ⚙)');
});

test('si el elegido no está, el 🎙 avisa cuál se usa en su lugar', function () {
  const D = cargarDictado();
  const p = D._pintarBoton('listo', {
    microfono: { nombre: 'MacBook Pro Microphone', indice: 2, origen: 'caida', elegido: 'Auriculares de Daniel (2)' },
  });
  has(p.titulo, '⚠');
  has(p.titulo, 'Auriculares de Daniel (2)');
  has(p.titulo, 'MacBook Pro Microphone');
  ok(!p.apagado, 'pero se puede dictar igual: hay un micrófono');
});

test('mientras escucha, la línea de estado nombra el micrófono', function () {
  const D = cargarDictado();
  const l = D._lineaDeEstado({ fase: 'escuchando', segundos: 12, microfono: { nombre: 'MacBook Pro Microphone', origen: 'default' } });
  has(l.texto, 'Escuchando por «MacBook Pro Microphone»');
  has(l.texto, '12 s');
  has(l.texto, 'unos segundos atrás', 'y lo que ya decía sigue estando');
  const c = D._lineaDeEstado({ fase: 'escuchando', segundos: 3, microfono: { nombre: 'MacBook Pro Microphone', origen: 'caida', elegido: 'Auriculares de Daniel (2)' } });
  has(c.texto, 'el elegido, «Auriculares de Daniel (2)», no está conectado');
  has(c.clase, 'is-warn');
  eq(D._lineaDeEstado({ fase: 'escuchando', segundos: 1 }).texto.indexOf('por «'), -1,
    'sin dato de micrófono no se inventa uno');
});

// ── 6. El ⬇ Log exporta lo que se anotó ──────────────────────────────

test('las líneas del micrófono entran en el archivo que baja ⬇ Log', function () {
  const ctx = {
    // HPLog repite cada línea por consola; acá no hace falta leerla dos veces.
    console: { log: function () {} }, Date: Date, String: String, Number: Number, Array: Array, Object: Object,
    document: { getElementById: function () { return { textContent: 'v1.4.49' }; } },
    navigator: { userAgent: 'test' },
    addEventListener: function () {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(CEP, 'log.js'), 'utf8'), ctx, { filename: 'log.js' });
  const L = ctx.HPLog;
  L.log('Micrófonos (al abrir el panel): [0] iPhone de Daniel Microphone · [2] MacBook Pro Microphone · por defecto del sistema: «MacBook Pro Microphone»');
  L.log('Prueba de micrófono · veredicto (silencio-digital): «MacBook Pro Microphone» entrega audio, pero es silencio digital.', 'ERROR');
  L.log('Prueba de micrófono · stderr de ffmpeg, tal cual:\n2026-09-03 21:01:12.842 ffmpeg[54976:233876] CMIOMS: EOSWebcamUtilityMain', 'WARN');
  const texto = L.buildText({ engineLoaded: true, enginePath: '/x/bridge/engine.js' });
  has(texto, '[0] iPhone de Daniel Microphone', 'la lista');
  has(texto, '[ERROR] Prueba de micrófono · veredicto (silencio-digital)', 'el veredicto, con su nivel');
  has(texto, 'CMIOMS: EOSWebcamUtilityMain', 'y el stderr de ffmpeg, tal cual, en su propio renglón');
});
