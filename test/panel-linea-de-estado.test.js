'use strict';

// La línea de estado aparece cuando pide acción, y no ocupa lugar cuando no.
//
// `#output` es la región `aria-live` del panel y estaba ocupada
// permanentemente: 47 px medidos a 400×700, arriba de todo, escritos siempre
// —de arranque con un "Pulsá Cargar marcadores…" que repetía el botón que está
// tres centímetros más arriba—. De los 23 avisos que la escriben, 20 son
// informativos y tres paran y piden que decidas algo.
//
// Desde la v1.6.0:
//   · sin nada que atender NO OCUPA LUGAR (`data-hidden` → `display: none`);
//   · lo informativo se muestra un rato y se esconde solo;
//   · lo que paró y espera una decisión queda, en ámbar;
//   · lo que falló queda, en rojo;
//   · y TODO pasa por el ⬇ Log, también lo que se esconde solo: la franja es un
//     aviso, el log es el registro.
//
// Y se mudó al final del `<body>`, afuera de las tres vistas, por dos motivos
// medidos: arriba, aparecer empujaba 30 px hacia abajo todo el contenido (los
// tres bloques de contexto, el rótulo y la lista), mientras que abajo lo único
// que cambia de tamaño es la vista, que es `flex: 1` con `min-height: 0`; y
// adentro de `#view-markers` los mensajes que escribe la Cola se pintaban en
// una vista ESCONDIDA, así que no los veía nadie.
//
// Lo que estos tests NO hacen: medir cajas. El DOM de mentira del repo no tiene
// motor de layout, así que un test que dijera "no salta" acá estaría fingiendo.
// Se fija la regla de CSS, la estructura del HTML y el comportamiento del código
// de producción. La medición se rehace con la maqueta (`medir-botones.js`).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const RAIZ = path.join(__dirname, '..');
const CEP = path.join(RAIZ, 'cep', 'js');
const HTML = fs.readFileSync(path.join(RAIZ, 'cep', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(RAIZ, 'cep', 'css', 'style.css'), 'utf8');
const MAIN = fs.readFileSync(path.join(CEP, 'main.js'), 'utf8');

function reglas(css) {
  const limpio = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const abiertos = [];
  let selDesde = 0;
  for (let i = 0; i < limpio.length; i++) {
    if (limpio[i] === '{') {
      abiertos.push({ selector: limpio.slice(selDesde, i).trim(), desde: i + 1, prof: abiertos.length });
      selDesde = i + 1;
    } else if (limpio[i] === '}') {
      const b = abiertos.pop();
      if (b) {
        const cuerpo = limpio.slice(b.desde, i);
        if (cuerpo.indexOf('{') === -1) {
          out.push({ selector: b.selector.replace(/\s+/g, ' '), cuerpo: cuerpo, dentroDeMedia: b.prof > 0 });
        }
      }
      selDesde = i + 1;
    }
  }
  return out;
}
const REGLAS = reglas(CSS);

function declaraciones(selector) {
  const d = {};
  REGLAS.filter((r) => r.selector === selector && !r.dentroDeMedia).forEach((r) => {
    r.cuerpo.split(';').forEach((par) => {
      const i = par.indexOf(':');
      if (i !== -1) d[par.slice(0, i).trim()] = par.slice(i + 1).trim();
    });
  });
  return d;
}

// ── 1. No ocupa lugar, y eso es `display: none` ───────────────────────

test('escondida es `display: none`, no transparente ni de alto cero', function () {
  // Es la diferencia entre "no ocupa lugar" y "no se ve": con `opacity: 0` o
  // `visibility: hidden` la franja sigue reservando sus 30 px, que es
  // exactamente lo que había que recuperar. Y con `height: 0` + `overflow`
  // seguirían contando sus márgenes.
  const d = declaraciones('.output[data-hidden="true"]');
  eq(d.display, 'none', 'sacarla del layout es la única forma de no ocupar lugar');
  eq(d.opacity, undefined, 'sin trucos de opacidad');
  eq(d.visibility, undefined, 'ni de visibilidad');
});

test('no es un cartel flotante: sigue en el flujo', function () {
  // La otra manera de "no ocupar lugar" sería sacarla del flujo (un toast
  // `position: fixed`), y ahí tapa contenido y se pierde en una captura. Acá la
  // franja se lleva su alto y la vista de arriba lo cede: es `flex: 1` con
  // `min-height: 0`, así que lo que se encoge es el área que scrollea y nada de
  // lo de arriba cambia de lugar.
  const d = declaraciones('.output');
  ok(d.position === undefined || d.position === 'static', 'en flujo: ' + d.position);
  eq(d.flex, 'none', 'y se lleva su alto natural, sin estirarse ni encogerse');
  ['.panel-body', '.queue-view', '.corrections-view'].forEach(function (sel) {
    const v = declaraciones(sel);
    eq(v['min-height'], '0', sel + ' tiene que poder encogerse, o el que se mueve es el contenido');
  });
});

test('los tres niveles se ven distinto, y dos de ellos no son sólo color', function () {
  // WCAG 1.4.1: no depender del color solo. Informativo, "paré" y "falló"
  // difieren además por lo que hacen —los dos últimos se quedan— y por el
  // borde, no sólo por la tinta del texto.
  const warn = declaraciones('.output.is-warn');
  const error = declaraciones('.output.is-error');
  eq(warn.color, 'var(--warn)', 'paré y hay que decidir: el ámbar de «atención» de todo el panel');
  eq(error.color, 'var(--error)', 'falló: rojo');
  ok(warn['border-color'] && error['border-color'], 'y los dos cambian el borde, no sólo el texto');
  ok(warn['background-color'] !== error['background-color'], 'con su propio tinte de fondo');
});

// ── 2. El HTML: afuera de las vistas y sin texto de arranque ──────────

test('la franja vive afuera de las tres vistas, al final del panel', function () {
  const iOut = HTML.indexOf('id="output"');
  ok(iOut !== -1, 'la franja tiene que existir');
  ['<main id="view-markers"', 'id="view-queue"', 'id="view-corrections"'].forEach(function (v) {
    const i = HTML.indexOf(v);
    ok(i !== -1 && i < iOut, 'la franja va DESPUÉS de ' + v + ': adentro de una vista escondida no la ve nadie');
  });
  ok(iOut < HTML.indexOf('<script src="js/CSInterface.js">'), 'y antes de los scripts, o sea dentro del body');
});

test('arranca escondida y sin texto de relleno', function () {
  // El "Pulsá Cargar marcadores para leer la secuencia activa" repetía el botón
  // primario de la barra de acciones, que está arriba y es el único acento
  // relleno de la vista. Reservaba 47 px para decir lo que ya decía un botón.
  const tag = /<div id="output"([^>]*)>([\s\S]*?)<\/div>/.exec(HTML);
  ok(tag, 'la franja es un div propio');
  has(tag[1], 'data-hidden="true"', 'escondida hasta que haya algo que atender');
  eq(tag[2].trim(), '', 'y vacía: sin placeholder');
  eq(HTML.indexOf('class="placeholder"'), -1, 'el placeholder no vuelve por otra puerta');
});

test('sigue siendo la región `aria-live` del panel', function () {
  const tag = /<div id="output"([^>]*)>/.exec(HTML);
  has(tag[1], 'aria-live="polite"', 'lo que se muestre se tiene que anunciar');
});

// ── 3. El comportamiento, con el código de producción ─────────────────

/** El texto real de una función de main.js (ver estimado-tokens.test.js). */
function funcionDeMain(nombre) {
  const m = new RegExp('\\n([ \\t]*)function ' + nombre + '\\(').exec(MAIN);
  if (!m) throw new Error('no encontré ' + nombre + ' en main.js');
  const cierre = '\n' + m[1] + '}\n';
  const fin = MAIN.indexOf(cierre, m.index);
  if (fin === -1) throw new Error('no encontré el final de ' + nombre);
  return MAIN.slice(m.index + 1, fin + cierre.length);
}

/** `setOutput` de verdad, con un nodo de mentira y el reloj en la mano. */
function montar() {
  const orden = [];          // en qué orden se escribió y se mostró
  const timers = [];
  const nodo = {
    clases: {},
    // Arranca escondida, como la deja el HTML.
    atributos: { 'data-hidden': 'true' },
    get textContent() { return this._t || ''; },
    set textContent(v) { this._t = v; orden.push('texto:' + v); },
    setAttribute: function (k, v) { this.atributos[k] = String(v); if (k === 'data-hidden') orden.push('hidden:' + v); },
    getAttribute: function (k) { return this.atributos[k] === undefined ? null : this.atributos[k]; },
    classList: {
      toggle: function (c, on) { nodo.clases[c] = Boolean(on); },
      contains: function (c) { return Boolean(nodo.clases[c]); },
    },
  };
  const log = [];
  const ctx = {
    console: console, Math: Math, String: String, Number: Number, Boolean: Boolean,
    setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
    clearTimeout: function (id) { if (timers[id - 1]) timers[id - 1].cancelado = true; },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  // Las constantes del temporizador y el handle se copian TAL CUAL del archivo:
  // si alguien cambia los números, estos tests siguen midiendo lo que el panel
  // hace y no lo que hacía el día que se escribieron.
  const consts = /var OUTPUT_MIN_MS = (\d+);\s*\n\s*var OUTPUT_POR_CARACTER_MS = (\d+);\s*\n\s*var OUTPUT_MAX_MS = (\d+);/.exec(MAIN);
  ok(consts, 'las constantes del temporizador tienen que estar nombradas en main.js');
  vm.runInContext(
    'var output = this.nodo;\n' +
    'var hpLog = this.hpLog;\n' +
    'var outputTimer = null;\n' +
    'var OUTPUT_MIN_MS = ' + consts[1] + ';\n' +
    'var OUTPUT_POR_CARACTER_MS = ' + consts[2] + ';\n' +
    'var OUTPUT_MAX_MS = ' + consts[3] + ';\n' +
    funcionDeMain('hideOutput') + '\n' +
    funcionDeMain('setOutput') + '\n' +
    'this.setOutput = setOutput;',
    Object.assign(ctx, {
      nodo: nodo,
      hpLog: function (txt, nivel) { log.push((nivel || 'INFO') + ' ' + txt); },
    }),
    { filename: 'main.js (extracto)' });
  return {
    setOutput: ctx.setOutput,
    nodo: nodo,
    log: log,
    orden: orden,
    timers: timers,
    /** Corre el temporizador pendiente, si quedó alguno vivo. */
    correrReloj: function () {
      const vivos = timers.filter(function (t) { return !t.cancelado && !t.corrido; });
      vivos.forEach(function (t) { t.corrido = true; t.fn(); });
      return vivos.length;
    },
    visible: function () { return nodo.getAttribute('data-hidden') === 'false'; },
    espera: function () {
      const vivos = timers.filter(function (t) { return !t.cancelado && !t.corrido; });
      return vivos.length ? vivos[vivos.length - 1].ms : 0;
    },
  };
}

test('sin mensaje, escondida', function () {
  const p = montar();
  p.setOutput('');
  eq(p.visible(), false);
  p.setOutput(null);
  eq(p.visible(), false, 'ni con null: hay call sites que pasan lo que vino del motor');
});

test('lo informativo se muestra y se esconde solo', function () {
  const p = montar();
  p.setOutput('7 marcador(es) cargados · estado guardado ✓', false);
  eq(p.visible(), true, 'se ve: un clic sin respuesta visible se lee como un panel colgado');
  eq(p.nodo.clases['is-error'], false);
  eq(p.nodo.clases['is-warn'], false);
  ok(p.espera() > 0, 'con un temporizador andando');
  eq(p.correrReloj(), 1, 'y cuando se cumple…');
  eq(p.visible(), false, '…se esconde sola y devuelve el lugar');
  eq(p.nodo.textContent, '', 'sin dejar el texto adentro, que volvería a aparecer al mostrarla');
});

test('lo que PARÓ y espera una decisión se queda', function () {
  // Son los tres del inventario: "no generé nada todavía, hay N referencias
  // en esta máquina", "cancelaste la transcripción, así que no generé nada" y
  // "la secuencia activa no tiene marcadores". Los tres terminan en una
  // pregunta para el editor, así que esconderlos a los 8 segundos sería
  // esconder la pregunta.
  const p = montar();
  p.setOutput('No generé nada todavía: hay 3 referencias…', 'accion');
  eq(p.visible(), true);
  eq(p.nodo.clases['is-warn'], true, 'en ámbar: es «atención», no un error');
  eq(p.nodo.clases['is-error'], false);
  eq(p.espera(), 0, 'y sin temporizador: se va cuando la resolvés, no cuando se aburre');
});

test('un error se queda, en rojo', function () {
  const p = montar();
  p.setOutput('No pude preparar el contexto de la secuencia “Clase 14”', true);
  eq(p.visible(), true);
  eq(p.nodo.clases['is-error'], true);
  eq(p.nodo.clases['is-warn'], false);
  eq(p.espera(), 0, 'nada que se esconda solo');
  has(p.log[0], 'ERROR', 'y al log entra como error');
});

test('un mensaje nuevo cancela el temporizador del anterior', function () {
  // "Cargando marcadores…" y el resultado llegan con dos segundos de
  // diferencia. Si el reloj del primero siguiera vivo, escondería el segundo.
  const p = montar();
  p.setOutput('Cargando marcadores…', false);
  p.setOutput('7 marcador(es) cargados', false);
  eq(p.correrReloj(), 1, 'queda UN temporizador vivo, el del último mensaje');
  eq(p.visible(), false);
});

test('el rato alcanza para leer, y tiene techo', function () {
  const p1 = montar();
  p1.setOutput('Cola vaciada.', false);
  const corto = p1.espera();
  const p2 = montar();
  p2.setOutput('x'.repeat(400), false);
  const largo = p2.espera();
  ok(corto >= 4000, 'lo más corto se ve al menos cuatro segundos: ' + corto);
  ok(largo > corto, 'un texto largo se queda más: ' + largo);
  ok(largo <= 15000, 'pero con techo, o una frase larga bloquea la franja: ' + largo);
  // ~17 letras por segundo es la lectura corrida; el panel da bastante más.
  ok(corto / 'Cola vaciada.'.length > 60, 'y sobra margen por carácter');
});

test('el texto se escribe DESPUÉS de mostrarla, para que el aria-live lo anuncie', function () {
  // Una región `aria-live` escondida no anuncia lo que le cambia adentro. Si se
  // escribiera primero y se mostrara después, el lector de pantalla se perdería
  // justo los mensajes que sí se muestran.
  const p = montar();
  p.setOutput('La secuencia activa no tiene marcadores.', 'accion');
  const iMostrar = p.orden.indexOf('hidden:false');
  const iTexto = p.orden.findIndex(function (x) { return x.indexOf('texto:La secuencia') === 0; });
  ok(iMostrar !== -1 && iTexto !== -1, 'las dos cosas tienen que pasar');
  ok(iMostrar < iTexto, 'primero se muestra, después se escribe');
});

test('todo lo que pasa por la franja queda en el ⬇ Log', function () {
  // Es lo que hace que esconder lo informativo no pierda nada: el log es el
  // registro, la franja es el aviso. Y los saltos de línea se aplanan, porque el
  // log es un renglón por entrada.
  const p = montar();
  p.setOutput('Log descargado en:\n/Users/dani/Downloads/x.md\nMandámelo para revisar la falla.', false);
  eq(p.log.length, 1);
  has(p.log[0], 'INFO');
  has(p.log[0], 'Log descargado en: · /Users/dani/Downloads/x.md');
  eq(p.log[0].indexOf('\n'), -1, 'en un solo renglón');
});

// ── 4. Los tres marcados, en el código ────────────────────────────────

test('los mensajes que paran están marcados como tales en main.js', function () {
  const marcados = (MAIN.match(/setOutput\([\s\S]{0,600}?"accion"\)/g) || []).length;
  ok(marcados >= 3, 'tienen que estar marcados los tres que piden una decisión, hay ' + marcados);
  // Y los que sí son errores siguen siendo errores: la bisagra vieja
  // (`setOutput(txt, true)`) no cambió de significado, así que ningún módulo de
  // afuera (queue-view.js, general-view.js) tuvo que enterarse de nada.
  ok(/setOutput\([^;]*, true\)/.test(MAIN), 'el `true` de siempre sigue queriendo decir error');
});
