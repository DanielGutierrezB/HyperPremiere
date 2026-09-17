'use strict';

// Qué recibe DE VERDAD el modelo cuando el editor menciona una referencia.
//
//   node test/manual/menciones-al-modelo.js [--out archivo.md]
//
// Hermano de `prompt-tres-niveles.js` y `referencias-al-modelo.js`, con la misma
// forma y por el mismo motivo: los tests fijan el contrato pieza por pieza, y
// esto contesta la pregunta que uno se hace mirando un recurso que salió con la
// imagen equivocada — ¿la mención se tradujo, y se tradujo al número correcto?
//
// De punta a punta quiere decir: un proyecto de verdad en un temporal con sus dos
// carpetas `_referencias`, el PANEL de verdad montado como lo carga el navegador
// (HPStore + HPGeneral + HPRefs + HPQueue), la cola releyendo el disco al momento
// de generar, y el MOTOR de verdad armando el pedido. Lo único falso es el
// proveedor: en vez de llamar al modelo, anota lo que le habrían mandado.
//
// Se piden CINCO recursos con el mismo proyecto, porque las cinco preguntas que
// importan no se pueden contestar con un pedido:
//
//   1. Tres menciones —una del marcador, una del curso y una de la clase— en una
//      sola instrucción. ¿Salen como «imagen 1», «imagen 3» y «imagen 5»?
//   2. LA MISMA instrucción después de agregarle una imagen al marcador. Los
//      números se corren; la mención tiene que seguir apuntando a la misma imagen.
//   3. Una mención a una referencia que se BORRÓ de la lista.
//   4. Una mención a una que el manifiesto nombra y el disco no tiene.
//   5. Una instrucción vieja con «como en la imagen 2» en texto plano, que tiene
//      que viajar sin que nadie la toque.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

// La config del modelo vive en ~/.hyperpremiere y este script la escribe, así que
// HOME va a un temporal ANTES de cargar el motor. Sin esto, correr esto le
// cambiaría el proveedor al panel del editor.
const CASA = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-home-'));
process.env.HOME = CASA;
process.env.USERPROFILE = CASA;

const engine = require('../../bridge/engine.js');

const RAIZ = path.join(__dirname, '..', '..');
const CEP = path.join(RAIZ, 'cep', 'js');

const SEQ = 'Clase 12 · Automatizaciones';

const CURSO = 'Marca ACADEMIA NOVA. Paleta cian sobre carbón, todo entra por la derecha.';
const SECUENCIA = 'Esta clase va con los gráficos abajo a la derecha: estoy en cámara chica.';

const COMPOSICION = '<!DOCTYPE html><html><body>' +
  '<div id="stage" data-composition-id="marcador-1" data-start="0" data-width="1920" ' +
  'data-height="1080" data-duration="6" data-fps="30"></div>' +
  '<script>const tl = gsap.timeline({ paused: true }); window.__timelines["marcador-1"] = tl;</script>' +
  '</body></html>';

/** Un PNG mínimo pero válido, para que el motor lo trate como imagen de verdad. */
const PNG_1PX = 'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** El proveedor falso: no llama a nadie y se queda con lo que le pasaron. */
function proveedorEspia(id, anotar) {
  const ruta = path.join(RAIZ, 'bridge', 'providers', id + '.js');
  require.cache[ruta] = {
    exports: {
      generate: async function (arg) {
        anotar(arg);
        return { text: COMPOSICION, usage: { inputTokens: 1, outputTokens: 1, totalInputTokens: 1 } };
      },
      complete: async function (arg) { anotar(arg); return { text: '', usage: {} }; },
    },
    loaded: true, id: ruta, filename: ruta, paths: [], children: [],
  };
}

// ── Un DOM mínimo, solo para poder montar los módulos del panel ──────

function elemento(tag) {
  return {
    tagName: tag, children: [], listeners: {}, style: {},
    className: '', textContent: '', value: '', title: '',
    appendChild: function (h) { this.children.push(h); return h; },
    setAttribute: function () {},
    addEventListener: function () {},
  };
}

/** El panel, con los módulos de verdad y el motor de verdad detrás. */
function montarPanel(proyecto, notas) {
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
    HPConfigUI: { isLocalProvider: function () { return true; }, modelName: function () { return 'falso'; } },
    HPTranscript: { sliceForMarker: function (segs) { return segs || []; } },
    HPHost: { placeClip: function (mov, seq, s, d, c, a, cb) { cb('ok'); } },
    HPEngine: {
      call: function (m, arg) {
        if (typeof engine[m] === 'function') return Promise.resolve(engine[m](arg));
        if (m === 'loadTranscript') return Promise.resolve({ ok: true, found: false });
        if (m === 'mediaHasAudio') return Promise.resolve({ ok: true, hasAudio: false });
        return Promise.resolve({ ok: true });
      },
      callProg: function (m, arg, onP) {
        if (m === 'prepareGenerate' || m === 'prepareFeedback') {
          const fn = m === 'prepareGenerate' ? engine.prepareGenerate : engine.prepareFeedback;
          return fn(arg, function (p) {
            if (p && p.note) notas.push(p.note);
            if (onP) onP(p);
          });
        }
        if (m === 'renderPrepared') return Promise.resolve({ ok: true, movPath: '/tmp/x.mov', version: 1 });
        return Promise.resolve({ ok: true });
      },
    },
    HPStills: { fbInit: function () {}, fbClear: function () {}, fbCollect: function () { return []; } },
  };
  ctx.document = { createElement: elemento, getElementById: function () { return null; } };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  // `menciones.js` entra porque el caso 6 usa la canonización que corre en la ficha:
  // es la MISMA función, no una copia del script.
  for (const f of ['util.js', 'store.js', 'general-prompt.js', 'refs.js', 'menciones.js', 'queue.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  ctx.HPStore.setContext(proyecto, SEQ);
  return ctx;
}

/**
 * Encola un marcador y espera a que el pedido llegue al proveedor falso.
 *
 * El payload se arma con las MISMAS funciones del panel que usa la tarjeta
 * (`getMarkerStillRefs`, `getMarkerDocs`, `HPRefs.forModel`), porque eso es lo que
 * decide qué se puede mencionar. Armarlo a mano acá sería probar otra cosa.
 */
async function pedir(ctx, proyecto, slug, visto) {
  const gen = ctx.HPRefs.forModel(proyecto, SEQ);
  const md = ctx.HPStore.getMarkerData(slug);
  ctx.HPQueue.add({
    kind: 'generate',
    payload: {
      projectPath: proyecto, sequenceName: SEQ, mode: 'generate',
      markerSlug: slug, instruction: md.instruction,
      objective: 'Que el estudiante arme su primera automatización de punta a punta.',
      marker: { name: slug, start: 10, end: 16, duration: 6 },
      markerTranscript: [], transcript: [],
      stills: (md.stills || []).concat(gen.images),
      stillRefs: ctx.HPStore.getMarkerStillRefs(slug).concat(gen.refs),
      assets: ctx.HPStore.getMarkerAssets(slug).concat(gen.assets),
      resources: ctx.HPStore.getMarkerDocs(slug).concat(gen.docs),
    },
    seqName: SEQ, projectPath: proyecto, markerKey: slug,
    label: slug, markerStart: 10, markerDuration: 6,
  });
  for (let i = 0; i < 600 && !visto.arg; i++) await new Promise((r) => setTimeout(r, 25));
  if (!visto.arg) throw new Error('el pedido de ' + slug + ' nunca llegó al proveedor');
  const arg = visto.arg;
  visto.arg = null;
  return arg;
}

/** El bloque de la instrucción del editor tal como quedó en el prompt. */
function bloqueInstruccion(userPrompt) {
  const up = String(userPrompt || '');
  const desde = up.indexOf('## Instrucción del editor');
  if (desde === -1) return '(no está)';
  const hasta = up.indexOf('\n\n## ', desde + 5);
  return up.slice(desde, hasta === -1 ? undefined : hasta).trim();
}

/** El renglón de «Imágenes de referencia», que es el que promete la numeración. */
function bloqueNumeracion(userPrompt) {
  const up = String(userPrompt || '');
  const desde = up.indexOf('## Imágenes de referencia');
  if (desde === -1) return '(no está)';
  const hasta = up.indexOf('\n\n## ', desde + 5);
  return up.slice(desde, hasta === -1 ? undefined : hasta).trim();
}

async function main() {
  const salidaIdx = process.argv.indexOf('--out');
  const salida = salidaIdx !== -1 ? process.argv[salidaIdx + 1] : '';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-menciones-'));
  const proyecto = path.join(dir, 'Curso de automatizaciones.prproj');

  // ── 1. El proyecto: los dos textos y las referencias de los dos niveles ──
  engine.saveGeneralPrompt({ projectPath: proyecto, text: CURSO, scope: 'project' });
  engine.saveGeneralPrompt({ projectPath: proyecto, sequenceName: SEQ, text: SECUENCIA, scope: 'sequence' });

  function agregar(scope, name, dataUrl, use) {
    const r = engine.addReference({
      projectPath: proyecto, sequenceName: scope === 'sequence' ? SEQ : '',
      scope: scope, name: name, dataUrl: dataUrl, use: !!use,
    });
    if (!r.ok) throw new Error(r.error);
    return r;
  }
  const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 guia de estilo', 'utf8').toString('base64');

  agregar('course', 'manual-de-marca-nova.png', PNG_1PX, false);
  agregar('course', 'logo-canal.png', PNG_1PX, true);
  agregar('course', 'paleta-institucional.png', PNG_1PX, false);
  agregar('course', 'Guia_de_estilo_NOVA_v4.pdf', pdf, false);
  agregar('sequence', 'captura-programa-00-03-41.png', PNG_1PX, false);

  const rutas = engine.loadReferences({ projectPath: proyecto, sequenceName: SEQ }).paths;

  const notas = [];
  const visto = {};
  proveedorEspia('ollama', function (arg) { if (!visto.arg) visto.arg = arg; });
  engine.setConfig({ provider: 'ollama', model: 'falso' });
  const ctx = montarPanel(proyecto, notas);

  // Las imágenes del marcador, guardadas como las guarda el panel: con su NOMBRE,
  // que es lo que la mención escribe.
  const S = ctx.HPStore;
  S.addMarkerStill('Marcador 1', PNG_1PX, 'boceto-3-bloques.png');
  S.setMarkerInstruction('Marcador 1',
    'Tres bloques que aparecen de a uno. Copiá la disposición de ' +
    '@[marcador/boceto-3-bloques.png], la tipografía de @[curso/manual-de-marca-nova.png] y el ' +
    'encuadre de @[clase/captura-programa-00-03-41.png]. Incrustá @[curso/logo-canal.png] abajo.');

  const uno = await pedir(ctx, proyecto, 'Marcador 1', visto);
  const notasUno = notas.slice();

  // ── 2. Reordenar: una captura más ADELANTE de las otras ──────────────
  // Es el caso que define si esto sirve. Contando a mano, el manual de marca era
  // «imagen 2»; con una captura nueva en el marcador pasa a ser la 3, y una
  // instrucción escrita ayer quedaba hablando de otra imagen sin que nada falle.
  notas.length = 0;
  S.addMarkerStill('Marcador 1', PNG_1PX, 'captura-programa-12-58.png');
  const dos = await pedir(ctx, proyecto, 'Marcador 1', visto);
  const notasDos = notas.slice();

  // ── 3. Una mención COLGADA: la referencia se borró de la lista ────────
  notas.length = 0;
  S.setMarkerInstruction('Marcador 2',
    'El dato del 68% en grande, con el celeste de @[curso/paleta-modulo-3.png] arriba a la derecha.');
  const tres = await pedir(ctx, proyecto, 'Marcador 2', visto);
  const notasTres = notas.slice();

  // ── 4. Una que el manifiesto nombra y el disco no tiene ──────────────
  // Se borra el ARCHIVO y no el renglón del manifiesto: es el disco externo
  // desmontado, no una referencia que el editor sacó.
  notas.length = 0;
  fs.unlinkSync(path.join(rutas.course, 'paleta-institucional.png'));
  S.setMarkerInstruction('Marcador 3',
    'El embudo en cuatro escalones, con los colores de @[curso/paleta-institucional.png].');
  // La cola relee el disco por cada job (ensureRefs), así que la caché se entera
  // sola; se relee acá también para que `forModel` del payload vea lo mismo.
  await ctx.HPRefs.load(proyecto, SEQ);
  const cuatro = await pedir(ctx, proyecto, 'Marcador 3', visto);
  const notasCuatro = notas.slice();

  // ── 5. Una instrucción vieja, en texto plano ─────────────────────────
  notas.length = 0;
  const VIEJA = 'Un checklist de cinco puntos. Los tildes como en la imagen 2, ' +
    'y la tipografía de la imagen 1.';
  S.setMarkerInstruction('Marcador 4', VIEJA);
  const cinco = await pedir(ctx, proyecto, 'Marcador 4', visto);

  // ── 6. La MISMA instrucción vieja, después de apretar ✨ Refinar ──────
  //
  // Refinar canoniza las referencias escritas a mano: es lo único que reescribe un
  // "imagen N", y lo hace porque el editor apretó un botón que dice que le arregle el
  // texto. Lo hace el PANEL —el mismo módulo que el panel carga— y no el modelo, así
  // que acá se llama exactamente a lo que corre en la ficha, con el mismo inventario
  // que la ficha le pasa, y después se manda el resultado por el camino de siempre.
  //
  // Lo que tiene que cerrar es el círculo: "imagen 2" escrito a mano → la mención del
  // archivo que de verdad es la 2 → y de vuelta "imagen 2" al mandar. Si el número de
  // ida y el de vuelta no coinciden, la canonización le cambió la imagen al editor.
  notas.length = 0;
  const invDeLaFicha = [];
  S.getMarkerStillNames('Marcador 4').forEach((n) => invDeLaFicha.push({ scope: 'marker', nombre: n, falta: false }));
  (S.getMarkerDocs('Marcador 4') || []).forEach((r) => invDeLaFicha.push({ scope: 'marker', nombre: r.name || '', falta: false }));
  const estadoRefs = ctx.HPRefs.state(proyecto, SEQ);
  [['course', estadoRefs.course], ['sequence', estadoRefs.sequence]].forEach((par) => {
    (par[1] || []).forEach((it) => invDeLaFicha.push({
      scope: par[0], nombre: it.fileName || it.name, falta: !!it.missing,
    }));
  });
  const canon = ctx.HPMenciones.canonizar(VIEJA, invDeLaFicha);
  S.setMarkerInstruction('Marcador 4', canon.texto);
  const seis = await pedir(ctx, proyecto, 'Marcador 4', visto);
  S.setMarkerInstruction('Marcador 4', VIEJA);   // se deja como estaba

  // ── El reporte ──────────────────────────────────────────────────────
  const P = [];
  const B = (s) => P.push(s);
  B('# Las menciones que recibe el modelo');
  B('');
  B('Generado por `node test/manual/menciones-al-modelo.js`. Proyecto de verdad en un');
  B('temporal, panel de verdad, motor de verdad; el único doble es el proveedor, que');
  B('anota lo que le habrían mandado en vez de llamar al modelo.');
  B('');
  B('## El material del pedido');
  B('');
  B('```');
  B('_referencias/ del CURSO');
  fs.readdirSync(rutas.course).sort().forEach((f) => B('  ' + f));
  B('_referencias/ de la CLASE');
  fs.readdirSync(rutas.sequence).sort().forEach((f) => B('  ' + f));
  B('del MARCADOR (en el localStorage de esta máquina)');
  S.getMarkerStillNames('Marcador 1').forEach((n) => B('  ' + n));
  B('```');
  B('');

  function caso(titulo, texto, arg, notasDelCaso, opts) {
    opts = opts || {};
    B('## ' + titulo);
    B('');
    B('Lo que el editor escribió en el campo:');
    B('');
    B('```');
    B(texto);
    B('```');
    B('');
    B('Lo que le llegó al modelo:');
    B('');
    B('```');
    B(bloqueInstruccion(arg.userPrompt));
    B('```');
    B('');
    if (!opts.sinNumeracion) {
      B('Y el contrato de numeración del mismo prompt, que es lo que le da sentido a esos números:');
      B('');
      B('```');
      B(bloqueNumeracion(arg.userPrompt));
      B('```');
      B('');
      B('Con ' + (arg.images || []).length + ' imagen(es) adjuntas, en este orden: ' +
        (opts.orden || '(marcador → curso → clase)') + '.');
      B('');
    }
    const relevantes = (notasDelCaso || []).filter((n) => /menci|imagen\(es\) de referencia NO/i.test(n));
    if (relevantes.length) {
      B('Y lo que quedó escrito en el ⬇ Log antes de gastar la llamada:');
      B('');
      B('```');
      relevantes.forEach((n) => B(n));
      B('```');
      B('');
    }
  }

  caso('1. Tres menciones: del marcador, del curso y de la clase',
    S.getMarkerData('Marcador 1').instruction.replace(/@\[curso\/logo-canal\.png\]/, '@[curso/logo-canal.png]'),
    uno, notasUno,
    { orden: 'boceto-3-bloques.png · manual-de-marca-nova · logo-canal · paleta-institucional · captura-programa-00-03-41' });

  B('## 2. La misma instrucción, con una captura más ADELANTE');
  B('');
  B('Se le agregó `captura-programa-12-58.png` al marcador y **no se tocó una coma**');
  B('de la instrucción. Los números de todo lo que viene después se corren uno; las');
  B('menciones siguen apuntando a la misma imagen:');
  B('');
  B('```');
  B(bloqueInstruccion(dos.userPrompt));
  B('```');
  B('');
  B('```');
  B((notasDos || []).filter((n) => /menci/i.test(n)).join('\n') || '(nada)');
  B('```');
  B('');
  B('Escrito a mano, «imagen 2» seguiría diciendo 2 y el modelo habría diseñado con');
  B('la captura nueva en vez del manual de marca. Nada falla: sale distinto.');
  B('');

  caso('3. Una mención COLGADA (la referencia ya no está en la lista)',
    S.getMarkerData('Marcador 2').instruction, tres, notasTres, { sinNumeracion: true });

  caso('4. Una referencia que el manifiesto nombra y el disco NO tiene',
    S.getMarkerData('Marcador 3').instruction, cuatro, notasCuatro, { sinNumeracion: true });

  caso('5. Una instrucción vieja, con «imagen 2» en texto plano', VIEJA, cinco, [],
    { sinNumeracion: true });

  B('## 6. La misma instrucción vieja, después de apretar ✨ Refinar');
  B('');
  B('Refinar CANONIZA las referencias escritas a mano, y es lo único que reescribe un');
  B('«imagen N». Lo hace el panel —el mapeo lo conoce él, no el modelo— y con el mismo');
  B('inventario que le pasa la ficha. Lo que quedó en el campo:');
  B('');
  B('```');
  B(canon.texto);
  B('```');
  B('');
  B('Y lo que le llegó al modelo con ese texto:');
  B('');
  B('```');
  B(bloqueInstruccion(seis.userPrompt));
  B('```');
  B('');
  B('```');
  B((notas || []).filter((n) => /menci/i.test(n)).join('\n') || '(nada)');
  B('```');
  B('');
  B('El círculo cierra: «imagen 2» → la mención del archivo que de verdad es la 2 →');
  B('«imagen 2» otra vez. Lo que ganó el editor es que de ahora en más ese texto');
  B('sobrevive a que alguien reordene las referencias.');
  B('');

  // ── Las comprobaciones ──────────────────────────────────────────────
  B('## Comprobaciones');
  B('');
  const insUno = bloqueInstruccion(uno.userPrompt);
  const insDos = bloqueInstruccion(dos.userPrompt);
  const insTres = bloqueInstruccion(tres.userPrompt);
  const insCuatro = bloqueInstruccion(cuatro.userPrompt);
  const insCinco = bloqueInstruccion(cinco.userPrompt);
  const insSeis = bloqueInstruccion(seis.userPrompt);
  const checks = [
    ['ninguna mención llega sin traducir al prompt',
      [insUno, insDos, insTres, insCuatro].every((s) => s.indexOf('@[') === -1)],
    ['la del marcador es la imagen 1 (van primeras)', insUno.indexOf('imagen 1') !== -1],
    ['la del curso es la imagen 2', /disposición de imagen 1/.test(insUno) && /tipografía de imagen 2/.test(insUno)],
    ['la de la clase es la imagen 5, después de las tres del curso',
      /encuadre de imagen 5/.test(insUno)],
    ['una mención a una imagen ✓ usar dice además su archivo de assets',
      /imagen 3 \(el archivo assets\/asset-01\)/.test(insUno)],
    ['al agregar una imagen antes, la del curso pasa de la 2 a la 3',
      /tipografía de imagen 3/.test(insDos)],
    ['y la de la clase de la 5 a la 6', /encuadre de imagen 6/.test(insDos)],
    ['una mención colgada se dice y NO se le presta el número de otra',
      insTres.indexOf('ya no está adjunta') !== -1 && insTres.indexOf('imagen') === -1],
    ['una referencia que el disco no tiene no recibe número',
      insCuatro.indexOf('no se pudo leer del disco') !== -1],
    ['y el aviso de siempre sobre las que no se pudieron leer sigue saliendo',
      notasCuatro.some((n) => /NO se pudieron leer del disco/.test(n))],
    ['una instrucción vieja con «imagen 2» en texto plano viaja intacta',
      insCinco.indexOf('Los tildes como en la imagen 2') !== -1],
    ['al refinar, «imagen 2» pasa a ser una mención en el campo',
      canon.texto.indexOf('@[') !== -1 && canon.cambios.length === 2],
    ['y el número de ida y el de vuelta son el MISMO: no le cambió la imagen',
      insSeis.indexOf('Los tildes como en la imagen 2') !== -1 &&
      insSeis.indexOf('la tipografía de la imagen 1') !== -1],
    ['el prompt sigue prometiendo la numeración de 1 a N sobre las que VIAJAN',
      bloqueNumeracion(uno.userPrompt).indexOf('NUMERADAS de 1 a ' + (uno.images || []).length) !== -1],
  ];
  checks.forEach((c) => B((c[1] ? '- ✅ ' : '- ❌ ') + c[0]));
  B('');
  const fallaron = checks.filter((c) => !c[1]);
  B(fallaron.length ? '**' + fallaron.length + ' comprobación(es) en rojo.**' : '**Todas en verde.**');

  const texto = P.join('\n') + '\n';
  if (salida) {
    fs.writeFileSync(salida, texto, 'utf8');
    console.log('Escrito en ' + salida);
  } else {
    console.log(texto);
  }
  if (fallaron.length) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(String((e && e.stack) || e));
  process.exitCode = 1;
});
