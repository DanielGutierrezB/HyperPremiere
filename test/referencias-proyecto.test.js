'use strict';

// Las REFERENCIAS de los dos niveles generales: dónde quedan, cómo viajan y qué
// pasa con lo que ya estaba guardado en el localStorage de cada máquina.
//
// El caso real es el mismo de siempre, un escalón más abajo. Dos editores
// comparten un .prproj. Uno arrastra el manual de marca y tres cuadros de
// referencia al bloque de estilo; el otro abre la misma clase y genera sin
// verlos. El texto ya viajaba desde la 1.5.0 —eso lo arregló poner los .md al
// lado del proyecto— pero las imágenes seguían siendo base64 en el localStorage
// de la máquina que las arrastró, y el bloque de arriba prometía con todas las
// letras "Viaja con el .prproj". O sea: la caja mentía en su propio renglón.
//
// Y el peso lo hacía urgente aparte de incorrecto: un cuadro de 1920×1080 en
// base64 pesa ~1,5 MB, el panel reescribía la entrada entera del localStorage en
// cada tecleo del campo de texto, y el localStorage de CEP tiene un techo que al
// pasarse falla EN SILENCIO.
//
// Se prueba lo que no falla solo: dónde queda cada nivel, que el manifiesto
// sostenga el orden y la etiqueta, que la otra máquina las vea, que la migración
// no pierda nada y pregunte en vez de pisar, que una corrección de otro corte
// mire las de SU secuencia de origen, que las dos listas lleguen al pedido, y
// que un PDF llegue o se avise que no llega.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');

const engine = require('../bridge/engine.js');
const proveedores = require('../bridge/providers');
const projectFs = require('../bridge/store/project-fs');
const claudeCli = require('../bridge/providers/claude-cli');
const cursorCli = require('../bridge/providers/cursor-cli');
const CEP = path.join(__dirname, '..', 'cep', 'js');

const FAKE_CLAUDE = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-claude.js');
const FAKE_CURSOR = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-cursor.js');
// Los CLI de mentira son scripts con shebang: en Windows no arrancan solos.
const saltarEnWindows = process.platform === 'win32';

// Un PNG de 1×1, que es una imagen de verdad y pesa lo que pesa.
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// Otro distinto (un pixel de otro color): sirve para que "no es la misma" sea un
// hecho y no una suposición del test.
const OTRA_IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function b64(dataUrl) {
  return Buffer.from(String(dataUrl).split(',')[1], 'base64');
}

// El filesystem es de verdad a propósito: lo que se prueba es dónde quedan los
// archivos y que sobrevivan a cambiar de máquina, y un fs de mentira contestaría
// lo que le pidamos.
function proyectoNuevo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-refs-'));
  return path.join(dir, 'Curso de IA.prproj');
}

/** Dónde deberían quedar, según la convención de carpetas del proyecto. */
function rutas(projectPath, slugSecuencia) {
  const raiz = path.join(path.dirname(projectPath), 'HyperPremiere');
  return {
    curso: path.join(raiz, '_referencias'),
    secuencia: path.join(raiz, slugSecuencia, '_referencias'),
  };
}

function agregar(projectPath, sequenceName, scope, extra) {
  return engine.addReference(Object.assign({
    projectPath: projectPath, sequenceName: sequenceName, scope: scope,
  }, extra));
}

function nombres(items) {
  return (items || []).map(function (i) { return i.name; }).join(', ');
}

// ── Dónde se guarda cada nivel ───────────────────────────────────────

test('las del curso van al lado del .prproj, no adentro de una secuencia', function () {
  // El alcance es el del bloque: el manual de marca vale para todas las clases.
  // Guardarlo dentro de la carpeta de una es el bug de alcance que la 1.5.1
  // acaba de matar en los prompts, con otra ropa.
  const prproj = proyectoNuevo();
  const r = agregar(prproj, 'Clase 14', 'course', { name: 'marca.png', dataUrl: IMG });
  ok(r.ok, 'se guardó');
  eq(path.dirname(r.path), rutas(prproj, 'clase-14').curso, 'en la carpeta del proyecto');
  ok(!fs.existsSync(rutas(prproj, 'clase-14').secuencia), 'y no en la de la secuencia');
});

test('las de una secuencia van adentro de su carpeta y no tocan las del curso', function () {
  const prproj = proyectoNuevo();
  const r = agregar(prproj, 'Clase 14', 'sequence', { name: 'cuadro.png', dataUrl: IMG });
  eq(path.dirname(r.path), rutas(prproj, 'clase-14').secuencia);
  ok(!fs.existsSync(rutas(prproj, 'clase-14').curso), 'la carpeta del curso ni se creó');
});

test('el archivo que queda en disco es la imagen, no su base64', function () {
  // Todo el punto: un PNG que el editor puede abrir con el Finder, y que pesa lo
  // que pesa un PNG y no un tercio más.
  const prproj = proyectoNuevo();
  const r = agregar(prproj, '', 'course', { name: 'marca.png', dataUrl: IMG });
  const enDisco = fs.readFileSync(r.path);
  ok(enDisco.equals(b64(IMG)), 'byte por byte, la imagen original');
  eq(enDisco.slice(1, 4).toString('latin1'), 'PNG', 'con su cabecera de PNG');
});

test('sin nombre de secuencia no se puede guardar una de secuencia, y se dice', function () {
  const prproj = proyectoNuevo();
  const r = agregar(prproj, '', 'sequence', { name: 'x.png', dataUrl: IMG });
  ok(!r.ok, 'no se guarda a ciegas');
  has(r.error, 'nombre');
});

// ── El manifiesto: orden, nombre y "✓ usar" ──────────────────────────

test('el manifiesto guarda el ORDEN, que es cómo el editor las nombra en la instrucción', function () {
  // El prompt las numera "imagen 1, imagen 2…" y el editor escribe "en la imagen
  // 2 fijate la tipografía". Listar la carpeta devuelve lo que el sistema de
  // archivos quiera; el orden hay que anotarlo.
  const prproj = proyectoNuevo();
  ['a.png', 'b.png', 'c.png'].forEach(function (n) {
    agregar(prproj, '', 'course', { name: n, dataUrl: IMG });
  });
  const r = engine.loadReferences({ projectPath: prproj });
  eq(nombres(r.course), 'a.png, b.png, c.png', 'en el orden en que se agregaron');
});

test('la etiqueta "✓ usar" sobrevive: es la diferencia entre mirar e incrustar', function () {
  const prproj = proyectoNuevo();
  agregar(prproj, '', 'course', { name: 'logo.png', dataUrl: IMG, use: true });
  agregar(prproj, '', 'course', { name: 'cuadro.png', dataUrl: IMG });
  const r = engine.loadReferences({ projectPath: prproj });
  eq(r.course[0].use, true, 'el logo se incrusta');
  eq(r.course[1].use, false, 'el cuadro es solo referencia');
});

test('marcarla y desmarcarla no toca el archivo ni el orden', function () {
  const prproj = proyectoNuevo();
  agregar(prproj, '', 'course', { name: 'logo.png', dataUrl: IMG });
  agregar(prproj, '', 'course', { name: 'cuadro.png', dataUrl: IMG });
  engine.setReferenceUse({ projectPath: prproj, scope: 'course', index: 1, use: true });
  const r = engine.loadReferences({ projectPath: prproj });
  eq(nombres(r.course), 'logo.png, cuadro.png', 'el orden es el mismo');
  eq(r.course[1].use, true);
});

test('dos archivos con el mismo nombre no se pisan: la segunda captura sigue estando', function () {
  // Dos capturas del programa del mismo día se llaman igual, y la segunda se
  // comía a la primera sin que nada fallara: el panel mostraba dos miniaturas y
  // el disco tenía un archivo.
  const prproj = proyectoNuevo();
  const a = agregar(prproj, '', 'course', { name: 'captura.png', dataUrl: IMG });
  const b = agregar(prproj, '', 'course', { name: 'captura.png', dataUrl: OTRA_IMG });
  ok(a.path !== b.path, 'quedaron en dos archivos distintos');
  eq(engine.loadReferences({ projectPath: prproj }).course.length, 2);
  ok(fs.readFileSync(a.path).equals(b64(IMG)), 'la primera sigue siendo la primera');
  ok(fs.readFileSync(b.path).equals(b64(OTRA_IMG)), 'y la segunda es la segunda');
});

test('un PNG que alguien dejó en la carpeta desde el Finder aparece en el panel', function () {
  // La carpeta viaja al lado del .prproj y alguien le va a soltar un archivo a
  // mano. Esconderlo sería una carpeta que promete y no cumple.
  const prproj = proyectoNuevo();
  agregar(prproj, '', 'course', { name: 'marca.png', dataUrl: IMG });
  fs.writeFileSync(path.join(rutas(prproj, 'x').curso, 'a-mano.png'), b64(IMG));
  const r = engine.loadReferences({ projectPath: prproj });
  eq(nombres(r.course), 'marca.png, a-mano.png', 'adoptada, al final de la lista');
  eq(r.course[1].kind, 'image');
});

test('una referencia que el manifiesto nombra y no está se REPORTA, no se saltea', function () {
  // El proyecto en un disco externo desmontado. Dibujar una lista más corta sin
  // explicación es el modo de falla mudo de siempre: el editor no se entera y el
  // modelo diseña sin ella.
  const prproj = proyectoNuevo();
  const r0 = agregar(prproj, '', 'course', { name: 'marca.png', dataUrl: IMG });
  agregar(prproj, '', 'course', { name: 'cuadro.png', dataUrl: IMG });
  fs.unlinkSync(r0.path);
  const r = engine.loadReferences({ projectPath: prproj });
  eq(r.course.length, 2, 'siguen siendo dos');
  eq(r.course[0].missing, true, 'y la que falta lo dice');
  eq(r.course[1].missing, false);
});

test('quitar una borra el ARCHIVO, para que no vuelva sola en la próxima lectura', function () {
  // Si solo se borrara el renglón del manifiesto, la próxima lectura la
  // adoptaría de vuelta: la referencia que el editor sacó volvería sola.
  const prproj = proyectoNuevo();
  const a = agregar(prproj, '', 'course', { name: 'vieja.png', dataUrl: IMG });
  agregar(prproj, '', 'course', { name: 'nueva.png', dataUrl: IMG });
  engine.removeReference({ projectPath: prproj, scope: 'course', index: 0 });
  ok(!fs.existsSync(a.path), 'el archivo ya no está');
  eq(nombres(engine.loadReferences({ projectPath: prproj }).course), 'nueva.png');
});

test('borrar una del curso no toca las de la clase, y al revés tampoco', function () {
  const prproj = proyectoNuevo();
  agregar(prproj, 'Clase 14', 'course', { name: 'marca.png', dataUrl: IMG });
  agregar(prproj, 'Clase 14', 'sequence', { name: 'cuadro.png', dataUrl: IMG });
  engine.removeReference({ projectPath: prproj, sequenceName: 'Clase 14', scope: 'course', index: 0 });
  const r = engine.loadReferences({ projectPath: prproj, sequenceName: 'Clase 14' });
  eq(r.course.length, 0, 'la del curso se fue');
  eq(nombres(r.sequence), 'cuadro.png', 'la de la clase sigue entera');
});

test('cada clase tiene las suyas: agregar en una no le aparece a la otra', function () {
  const prproj = proyectoNuevo();
  agregar(prproj, 'Clase 14', 'sequence', { name: 'de-la-14.png', dataUrl: IMG });
  agregar(prproj, 'Clase 15', 'sequence', { name: 'de-la-15.png', dataUrl: IMG });
  eq(nombres(engine.loadReferences({ projectPath: prproj, sequenceName: 'Clase 14' }).sequence), 'de-la-14.png');
  eq(nombres(engine.loadReferences({ projectPath: prproj, sequenceName: 'Clase 15' }).sequence), 'de-la-15.png');
});

test('una captura del programa se COPIA por su ruta, sin pasar por base64', function () {
  // Es el camino que ya existía a medias: "Capturar del programa" guardaba una
  // ruta desde antes de esto. Recodificarla a base64 para volver a escribirla en
  // disco sería el viaje que este cambio vino a sacar.
  const prproj = proyectoNuevo();
  const suelto = path.join(path.dirname(prproj), 'cuadro-suelto.png');
  fs.writeFileSync(suelto, b64(OTRA_IMG));
  const r = agregar(prproj, '', 'course', { path: suelto });
  ok(r.ok, 'se guardó desde la ruta');
  eq(path.basename(r.path), 'cuadro-suelto.png', 'con su nombre');
  ok(fs.readFileSync(r.path).equals(b64(OTRA_IMG)), 'y el mismo contenido');
  ok(fs.existsSync(suelto), 'el original queda donde estaba: se copia, no se mueve');
});

test('un PDF se guarda como documento y no se confunde con una imagen', function () {
  const prproj = proyectoNuevo();
  agregar(prproj, '', 'course', {
    name: 'manual-de-marca.pdf', mediaType: 'application/pdf',
    dataUrl: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 falso').toString('base64'),
  });
  const it = engine.loadReferences({ projectPath: prproj }).course[0];
  eq(it.kind, 'doc', 'es documentación, no algo para mirar');
  eq(it.mediaType, 'application/pdf');
});

// ── El panel, con el disco de verdad detrás ──────────────────────────

function montarPanel(opts) {
  opts = opts || {};
  const disco = opts.localStorage || {};
  const espia = { logs: [], llamadas: [] };
  const ctx = {
    console: console, JSON: JSON, Math: Math, Date: Date, String: String,
    Number: Number, Object: Object, Array: Array, isNaN: isNaN,
    parseInt: parseInt, parseFloat: parseFloat, Promise: Promise,
    setTimeout: setTimeout, clearTimeout: clearTimeout, Buffer: Buffer,
    // Con `length` y `key()`, como el de un navegador: el barrido de lo que
    // quedó sin migrar en OTRAS clases recorre las claves, y un doble sin ellas
    // dejaría ese camino sin probar.
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(disco, k) ? disco[k] : null; },
      setItem: function (k, v) { disco[k] = String(v); },
      removeItem: function (k) { delete disco[k]; },
      key: function (i) { var ks = Object.keys(disco); return i < ks.length ? ks[i] : null; },
    },
    HPLog: { log: function (m, nivel) { espia.logs.push((nivel || 'INFO') + ' ' + m); } },
    HPConfigUI: { isLocalProvider: function () { return false; }, modelName: function () { return 'falso'; } },
    HPTranscript: { sliceForMarker: function (segs) { return segs || []; } },
    HPHost: { placeClip: function (mov, seq, s, d, c, a, cb) { cb('ok'); } },
    HPEngine: {
      call: function (metodo, arg) {
        espia.llamadas.push(metodo);
        if (opts.motorRoto) return Promise.reject(new Error('el disco del proyecto no responde'));
        if (metodo === 'loadReferences') return Promise.resolve(engine.loadReferences(arg));
        // El proyecto se deja LEER pero no escribir: el disco lleno, el .prproj
        // en una carpeta de solo lectura, el externo que se desmontó en el medio.
        if (metodo === 'addReference' && opts.guardarRoto) {
          return Promise.resolve({ ok: false, error: 'no hay espacio en el disco' });
        }
        if (metodo === 'addReference') return Promise.resolve(engine.addReference(arg));
        if (metodo === 'removeReference') return Promise.resolve(engine.removeReference(arg));
        if (metodo === 'setReferenceUse') return Promise.resolve(engine.setReferenceUse(arg));
        if (metodo === 'loadGeneralPrompt') return Promise.resolve(engine.loadGeneralPrompt(arg));
        if (metodo === 'saveGeneralPrompt') return Promise.resolve(engine.saveGeneralPrompt(arg));
        if (metodo === 'loadTranscript') return Promise.resolve({ ok: true, found: false });
        if (metodo === 'mediaHasAudio') return Promise.resolve({ ok: true, hasAudio: false });
        return Promise.resolve({ ok: true });
      },
      callProg: function (m, arg) {
        if (m === 'prepareGenerate' || m === 'prepareFeedback') {
          espia.preparado = arg;
          return Promise.resolve({ ok: true, version: 1, usage: {} });
        }
        return Promise.resolve({ ok: true, version: 1, movPath: '/tmp/x.mov' });
      },
    },
  };
  Object.defineProperty(ctx.localStorage, 'length', {
    get: function () { return Object.keys(disco).length; },
  });
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'store.js', 'general-prompt.js', 'refs.js', 'queue.js']) {
    vm.runInContext(fs.readFileSync(path.join(CEP, f), 'utf8'), ctx, { filename: f });
  }
  return { ctx: ctx, disco: disco, espia: espia };
}

/**
 * Deja en el localStorage del panel lo que esta máquina tenía guardado antes de
 * que las referencias fueran archivos: imágenes en `stills` y documentos en
 * `resources`, contra la clave del prompt general de ESA secuencia.
 */
function conRefsLocales(panel, projectPath, sequenceName, lista) {
  panel.ctx.HPStore.withContext(projectPath, sequenceName, function () {
    lista.forEach(function (r) {
      if (r.doc) {
        panel.ctx.HPStore.addMarkerResource(panel.ctx.HPStore.GENERAL_KEY, {
          name: r.doc, dataUrl: r.dataUrl, mediaType: r.mediaType || '',
        });
      } else {
        panel.ctx.HPStore.addMarkerStill(panel.ctx.HPStore.GENERAL_KEY, r.dataUrl);
      }
    });
  });
}

function refsLocalesDe(panel, projectPath, sequenceName) {
  return panel.ctx.HPStore.withContext(projectPath, sequenceName, function () {
    const d = panel.ctx.HPStore.getMarkerData(panel.ctx.HPStore.GENERAL_KEY);
    return { stills: d.stills.length, resources: d.resources.length };
  });
}

// ── El caso del compañero ────────────────────────────────────────────

test('el compañero abre el proyecto SIN nada en su localStorage y las referencias le llegan', async function () {
  // Este es el bug entero, de punta a punta, y es la promesa que el bloque hace
  // en su renglón: "Viaja con el .prproj".
  const prproj = proyectoNuevo();

  const maquinaA = montarPanel();
  await maquinaA.ctx.HPRefs.load(prproj, 'Clase 14');
  await maquinaA.ctx.HPRefs.add(prproj, 'Clase 14', 'course', { name: 'marca.png', dataUrl: IMG });
  await maquinaA.ctx.HPRefs.add(prproj, 'Clase 14', 'sequence', { name: 'cuadro.png', dataUrl: IMG });

  const maquinaB = montarPanel(); // localStorage propio, vacío
  const st = await maquinaB.ctx.HPRefs.load(prproj, 'Clase 14');

  eq(nombres(st.course), 'marca.png', 'la del curso llegó a la otra máquina');
  eq(nombres(st.sequence), 'cuadro.png', 'y la de la clase también');
});

test('las del curso se ven desde CUALQUIER clase; las de la clase, solo desde la suya', async function () {
  const prproj = proyectoNuevo();
  const p = montarPanel();
  await p.ctx.HPRefs.load(prproj, 'Clase 14');
  await p.ctx.HPRefs.add(prproj, 'Clase 14', 'course', { name: 'marca.png', dataUrl: IMG });
  await p.ctx.HPRefs.add(prproj, 'Clase 14', 'sequence', { name: 'de-la-14.png', dataUrl: IMG });

  const st = await p.ctx.HPRefs.load(prproj, 'Clase 15');
  eq(nombres(st.course), 'marca.png', 'el manual de marca vale para todo el curso');
  eq(st.sequence.length, 0, 'y lo de la 14 no se le aparece a la 15');
});

test('guardar en un nivel NO da por leído el otro: las cachés están partidas', async function () {
  // Es el bug de alcance que la 1.5.1 mató en los prompts, con otra ropa: una
  // entrada fabricada que dice "esto ya se leyó" sobre un nivel que nadie leyó.
  // El precio no es un error, es una generación sin la marca.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  await p.ctx.HPRefs.add(prproj, 'Clase 14', 'course', { name: 'marca.png', dataUrl: IMG });
  eq(p.ctx.HPRefs.state(prproj, 'Clase 14').loaded, false,
    'de la secuencia todavía no se sabe nada, así que del contexto tampoco');
  eq(p.ctx.HPRefs.count(prproj, 'Clase 14', 'course'), 1, 'pero lo del curso sí está');
});

test('si el proyecto no se puede leer, se avisa y no se inventa una lista vacía', async function () {
  const prproj = proyectoNuevo();
  const p = montarPanel({ motorRoto: true });
  const st = await p.ctx.HPRefs.load(prproj, 'Clase 14');
  eq(st.loaded, false, 'no se hace pasar por leído');
  eq(st.failed, true);
  ok(p.espia.logs.some(function (l) { return l.indexOf('WARN') === 0 && l.indexOf('no las pude leer') !== -1; }),
    'y queda dicho en el log: ' + p.espia.logs.join(' | '));
});

// ── La migración de lo que había en cada máquina ─────────────────────

test('lo que tenía esta máquina sube a la carpeta de SU secuencia, con nombre y todo', async function () {
  // A la de la secuencia y no a la del curso: es lo que ese material decía ser.
  // El bloque se llamaba "Referencias de esta secuencia" y la clave del
  // localStorage lleva el nombre de la clase. Promoverlo al curso sería decidir
  // por el editor que el manual de una clase es el de todas, y eso le llega a
  // los dos editores.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  conRefsLocales(p, prproj, 'Clase 14', [
    { dataUrl: IMG },
    { doc: 'manual.pdf', dataUrl: 'data:application/pdf;base64,' + Buffer.from('%PDF').toString('base64'), mediaType: 'application/pdf' },
  ]);

  const st = await p.ctx.HPRefs.migrate(prproj, 'Clase 14');
  eq(st.sequence.length, 2, 'las dos subieron');
  eq(st.course.length, 0, 'y ninguna se promovió al curso');
  eq(st.sequence[1].name, 'manual.pdf', 'el documento conserva su nombre');
  eq(st.sequence[1].kind, 'doc');

  const enDisco = engine.loadReferences({ projectPath: prproj, sequenceName: 'Clase 14' });
  eq(enDisco.sequence.length, 2, 'y están en el disco, no solo en la caché');
});

test('después de migrar, el localStorage queda vacío (y no antes)', async function () {
  // El orden importa: si se vaciara primero y la escritura fallara, se pierden.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }, { dataUrl: OTRA_IMG }]);
  eq(refsLocalesDe(p, prproj, 'Clase 14').stills, 2, 'antes estaban acá');

  await p.ctx.HPRefs.migrate(prproj, 'Clase 14');
  eq(refsLocalesDe(p, prproj, 'Clase 14').stills, 0, 'y ahora ya no');
  eq(engine.loadReferences({ projectPath: prproj, sequenceName: 'Clase 14' }).sequence.length, 2,
    'porque están en el proyecto');
});

test('si el proyecto no se pudo leer, la migración NO mueve nada', async function () {
  // No hay contra qué comparar, y mover material con la mitad de la información
  // es la forma más cara de equivocarse.
  const prproj = proyectoNuevo();
  const p = montarPanel({ motorRoto: true });
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }]);
  await p.ctx.HPRefs.migrate(prproj, 'Clase 14');
  eq(refsLocalesDe(p, prproj, 'Clase 14').stills, 1, 'lo de esta máquina sigue donde estaba');
});

test('si la escritura en el proyecto falla, lo de esta máquina NO se borra', async function () {
  // El orden es todo: primero confirma el proyecto y recién ahí se vacía acá. Al
  // revés —el disco lleno, el externo desmontado en el medio— las referencias no
  // quedarían en ningún lado, que es la misma forma de perder trabajo que el bug
  // del prompt general.
  const prproj = proyectoNuevo();
  const p = montarPanel({ guardarRoto: true });
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }, { dataUrl: OTRA_IMG }]);

  try { await p.ctx.HPRefs.migrate(prproj, 'Clase 14'); } catch (e) { /* falló, como tenía que fallar */ }

  eq(refsLocalesDe(p, prproj, 'Clase 14').stills, 2, 'las dos siguen guardadas en esta máquina');
  eq(engine.loadReferences({ projectPath: prproj, sequenceName: 'Clase 14' }).sequence.length, 0,
    'y en el proyecto no quedó nada a medias');
});

test('migrar dos veces no las duplica: la segunda no encuentra nada que mover', async function () {
  const prproj = proyectoNuevo();
  const p = montarPanel();
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }]);
  await p.ctx.HPRefs.migrate(prproj, 'Clase 14');
  const st = await p.ctx.HPRefs.migrate(prproj, 'Clase 14');
  eq(st.sequence.length, 1, 'sigue habiendo una');
});

test('si el proyecto YA tiene la misma, la copia local se descarta sin molestar', async function () {
  // Mismo nombre y mismo tamaño: es la que esta máquina ya subió antes, o la que
  // subió el compañero desde el mismo archivo. Preguntar acá sería un cartel que
  // no decide nada.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  agregar(prproj, 'Clase 14', 'sequence', { name: 'referencia-1.png', dataUrl: IMG });
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }]);

  const st = await p.ctx.HPRefs.migrate(prproj, 'Clase 14');
  eq(st.sequence.length, 1, 'no se duplicó');
  eq(st.pending.length, 0, 'ni quedó nada esperando una decisión');
  eq(refsLocalesDe(p, prproj, 'Clase 14').stills, 0, 'y el localStorage quedó limpio');
});

test('si son DISTINTAS, no se pisa ninguna: se pregunta', async function () {
  // Ya hubo un bug de pérdida de datos en esta familia. De un lado está lo que
  // arrastró este editor, del otro lo que puso su compañero. Elegir por ellos es
  // tirar el trabajo de alguno de los dos sin decírselo.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  agregar(prproj, 'Clase 14', 'sequence', { name: 'del-companiero.png', dataUrl: OTRA_IMG });
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }]);

  const st = await p.ctx.HPRefs.migrate(prproj, 'Clase 14');
  eq(nombres(st.sequence), 'del-companiero.png', 'lo del proyecto sigue intacto');
  eq(st.pending.length, 1, 'y lo de esta máquina quedó esperando');
  ok(p.espia.logs.some(function (l) { return l.indexOf('WARN') === 0 && l.indexOf('No se pisó') !== -1; }),
    'con el aviso en el log: ' + p.espia.logs.join(' | '));
});

test('en el conflicto, "son de esta clase" SUMA y no reemplaza', async function () {
  const prproj = proyectoNuevo();
  const p = montarPanel();
  agregar(prproj, 'Clase 14', 'sequence', { name: 'del-companiero.png', dataUrl: OTRA_IMG });
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }]);
  await p.ctx.HPRefs.migrate(prproj, 'Clase 14');

  const st = await p.ctx.HPRefs.resolvePending(prproj, 'Clase 14', 'sequence');
  eq(st.sequence.length, 2, 'quedaron las dos: la del compañero y la de acá');
  eq(st.pending.length, 0, 'y el limbo quedó vacío');
  eq(refsLocalesDe(p, prproj, 'Clase 14').stills, 0);
});

test('en el conflicto, "son del curso" las promueve —a pedido, nunca sola', async function () {
  const prproj = proyectoNuevo();
  const p = montarPanel();
  agregar(prproj, 'Clase 14', 'sequence', { name: 'del-companiero.png', dataUrl: OTRA_IMG });
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }]);
  await p.ctx.HPRefs.migrate(prproj, 'Clase 14');

  const st = await p.ctx.HPRefs.resolvePending(prproj, 'Clase 14', 'course');
  eq(st.course.length, 1, 'subió al curso');
  eq(st.sequence.length, 1, 'y la de la clase quedó como estaba');
  ok(p.espia.logs.some(function (l) { return l.indexOf('CURSO') !== -1; }),
    'y el log dice que eso le llega a todas las clases');
});

test('en el conflicto, descartar borra lo de esta máquina y deja el proyecto igual', async function () {
  const prproj = proyectoNuevo();
  const p = montarPanel();
  agregar(prproj, 'Clase 14', 'sequence', { name: 'del-companiero.png', dataUrl: OTRA_IMG });
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }]);
  await p.ctx.HPRefs.migrate(prproj, 'Clase 14');

  const st = await p.ctx.HPRefs.resolvePending(prproj, 'Clase 14', 'discard');
  eq(nombres(st.sequence), 'del-companiero.png');
  eq(st.pending.length, 0);
  eq(refsLocalesDe(p, prproj, 'Clase 14').stills, 0);
});

test('lo que quedó esperando SOBREVIVE a cerrar el panel', async function () {
  // Si el limbo viviera en memoria, cerrar el panel sin contestar el cartel
  // tiraría el material que se apartó justamente para no perderlo.
  const prproj = proyectoNuevo();
  const almacen = {};
  const uno = montarPanel({ localStorage: almacen });
  agregar(prproj, 'Clase 14', 'sequence', { name: 'del-companiero.png', dataUrl: OTRA_IMG });
  conRefsLocales(uno, prproj, 'Clase 14', [{ dataUrl: IMG }]);
  await uno.ctx.HPRefs.migrate(prproj, 'Clase 14');

  const otro = montarPanel({ localStorage: almacen }); // el panel se reabrió
  const st = await otro.ctx.HPRefs.load(prproj, 'Clase 14');
  eq(st.pending.length, 1, 'el cartel vuelve a aparecer');
  const fin = await otro.ctx.HPRefs.resolvePending(prproj, 'Clase 14', 'sequence');
  eq(fin.sequence.length, 2, 'y todavía se puede decidir sin haber perdido nada');
});

test('sin secuencia abierta no se migra nada: no hay carpeta donde ponerlo', async function () {
  const prproj = proyectoNuevo();
  const p = montarPanel();
  conRefsLocales(p, prproj, '', [{ dataUrl: IMG }]);
  const st = await p.ctx.HPRefs.migrate(prproj, '');
  eq(st.course.length, 0, 'y sobre todo: no se promueve al curso por descarte');
});

// ── Que lleguen al modelo ────────────────────────────────────────────

/**
 * El pedazo de main.js que arma el pedido de una tarjeta, con su texto original.
 * Es el mismo truco que usa el test del estimado: si se copiara acá, el test
 * seguiría en verde el día que el de verdad deje de mandar las referencias.
 */
function funcionDeMain(nombre) {
  const src = fs.readFileSync(path.join(CEP, 'main.js'), 'utf8');
  const desde = src.indexOf('\n  function ' + nombre + '(');
  if (desde === -1) throw new Error('no encontré ' + nombre + ' en main.js');
  let i = src.indexOf('{', desde), nivel = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') nivel++;
    else if (src[j] === '}' && --nivel === 0) return src.slice(desde, j + 1);
  }
  throw new Error('no pude cerrar ' + nombre);
}

test('el pedido de un marcador sale con las del CURSO y las de la CLASE', async function () {
  const prproj = proyectoNuevo();
  const p = montarPanel();
  p.ctx.HPStore.setContext(prproj, 'Clase 14');
  await p.ctx.HPRefs.add(prproj, 'Clase 14', 'course', { name: 'marca.png', dataUrl: IMG });
  await p.ctx.HPRefs.add(prproj, 'Clase 14', 'sequence', { name: 'cuadro.png', dataUrl: IMG });
  await p.ctx.HPGeneral.load(prproj, 'Clase 14');

  vm.runInContext(
    'var currentProjectPath = ' + JSON.stringify(prproj) + ';\n' +
    'var currentSequenceName = "Clase 14";\n' +
    funcionDeMain('markerKeyFor') + '\n' +
    funcionDeMain('buildMarkerPayload') + '\n' +
    'this.armar = function (m) { return buildMarkerPayload(m, "generate"); };',
    p.ctx, { filename: 'main.js (extracto)' });

  const clave = 'Marcador ' + p.ctx.HPStore.assignMarkerNumber('g-1');
  p.ctx.HPStore.addMarkerStill(clave, IMG); // la del marcador, que sigue siendo local
  const body = p.ctx.armar({ name: 'M1', start: 10, duration: 6, guid: 'g-1', index: 0 });

  eq(body.stills.length, 3, 'las tres: la del marcador, la del curso y la de la clase');
  ok(body.stills[1].indexOf('_referencias') !== -1, 'y las generales viajan como RUTA, no como base64');
  ok(body.stills[1].indexOf(path.join('HyperPremiere', '_referencias')) !== -1,
    'la del curso, desde la carpeta del proyecto');
  ok(body.stills[2].indexOf(path.join('clase-14', '_referencias')) !== -1,
    'la de la clase, desde la carpeta de su secuencia');
});

test('las marcadas "✓ usar" salen además como assets, para INCRUSTARSE', async function () {
  const prproj = proyectoNuevo();
  const p = montarPanel();
  p.ctx.HPStore.setContext(prproj, 'Clase 14');
  await p.ctx.HPRefs.add(prproj, 'Clase 14', 'course', { name: 'logo.png', dataUrl: IMG, use: true });
  await p.ctx.HPRefs.add(prproj, 'Clase 14', 'course', { name: 'cuadro.png', dataUrl: IMG });
  const gen = p.ctx.HPRefs.forModel(prproj, 'Clase 14');
  eq(gen.images.length, 2, 'las dos se miran');
  eq(gen.assets.length, 1, 'y solo el logo se incrusta');
  has(gen.assets[0], 'logo.png');
});

test('los documentos salen aparte de las imágenes, con su nombre', async function () {
  const prproj = proyectoNuevo();
  const p = montarPanel();
  await p.ctx.HPRefs.add(prproj, 'Clase 14', 'course', {
    name: 'manual-de-marca.pdf', mediaType: 'application/pdf',
    dataUrl: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4').toString('base64'),
  });
  const gen = p.ctx.HPRefs.forModel(prproj, 'Clase 14');
  eq(gen.images.length, 0);
  eq(gen.docs.length, 1);
  eq(gen.docs[0].name, 'manual-de-marca.pdf');
  eq(gen.docs[0].mediaType, 'application/pdf');
});

test('primero las del curso y después las de la clase, que es el orden de los textos', async function () {
  const prproj = proyectoNuevo();
  const p = montarPanel();
  await p.ctx.HPRefs.add(prproj, 'Clase 14', 'sequence', { name: 'de-la-clase.png', dataUrl: IMG });
  await p.ctx.HPRefs.add(prproj, 'Clase 14', 'course', { name: 'del-curso.png', dataUrl: IMG });
  const gen = p.ctx.HPRefs.forModel(prproj, 'Clase 14');
  has(gen.images[0], 'del-curso.png', 'el curso primero, como el prompt');
  has(gen.images[1], 'de-la-clase.png');
});

// ── La cola y las correcciones de otro corte ─────────────────────────

function job(extra) {
  return Object.assign({
    kind: 'feedback',
    payload: { projectPath: '', sequenceName: '', mode: 'adjust', markerSlug: 'Marcador 3' },
    seqName: '', projectPath: '', markerKey: 'Marcador 3',
    label: 'Marcador 3', markerStart: 10, markerDuration: 6,
  }, extra);
}

test('una corrección de OTRO corte ve las referencias de su secuencia de origen', async function () {
  // El caso: el recurso nació en "Clase 14" y el editor está parado en el corte
  // nuevo, "Clase 14_02". El material de referencia vive en la vieja, y leer la
  // abierta sería rediseñar sin lo que hizo bueno al original.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  agregar(prproj, 'Clase 14', 'sequence', { name: 'del-corte-viejo.png', dataUrl: IMG });
  agregar(prproj, 'Clase 14_02', 'sequence', { name: 'del-corte-nuevo.png', dataUrl: IMG });
  agregar(prproj, '', 'course', { name: 'marca.png', dataUrl: IMG });
  p.ctx.HPStore.setContext(prproj, 'Clase 14_02');

  const j = job({
    projectPath: prproj, seqName: 'Clase 14_02', storeSeqName: 'Clase 14',
    payload: { projectPath: prproj, sequenceName: 'Clase 14_02', mode: 'adjust', markerSlug: 'Marcador 3' },
  });
  p.ctx.HPQueue.addStaged(j);
  const body = await p.ctx.HPQueue.payloadForEstimate(p.ctx.HPQueue.jobs()[0]);

  eq(body.stills.length, 2, 'la del curso y la del corte donde NACIÓ el recurso');
  ok(body.stills.some(function (s) { return s.indexOf('del-corte-viejo.png') !== -1; }),
    'la de su origen: ' + body.stills.join(' | '));
  ok(!body.stills.some(function (s) { return s.indexOf('del-corte-nuevo.png') !== -1; }),
    'y NO la del corte que el editor tiene abierto');
});

test('la cola NO migra: encolar no le sube al proyecto lo que estaba en esta máquina', async function () {
  // Es la regla que sostiene todo lo demás. Si migrar viviera adentro de la
  // lectura, encolar una corrección de un corte que el editor no tiene adelante
  // subiría —para los dos editores— material de una sola máquina, desde un
  // camino que nadie mira.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }]);
  p.ctx.HPStore.setContext(prproj, 'Clase 14');

  const j = job({
    projectPath: prproj, seqName: 'Clase 14',
    payload: { projectPath: prproj, sequenceName: 'Clase 14', mode: 'adjust', markerSlug: 'Marcador 3' },
  });
  p.ctx.HPQueue.addStaged(j);
  await p.ctx.HPQueue.payloadForEstimate(p.ctx.HPQueue.jobs()[0]);

  eq(engine.loadReferences({ projectPath: prproj, sequenceName: 'Clase 14' }).sequence.length, 0,
    'el proyecto sigue sin referencias');
  eq(refsLocalesDe(p, prproj, 'Clase 14').stills, 1, 'y lo de esta máquina sigue acá');
});

test('si el proyecto no se puede leer, NO se vacían las referencias que el job traía', async function () {
  // Un recurso generado sin la marca no falla: sale distinto y se descubre
  // viendo el video. Rehidratar existe para completar, no para vaciar.
  const prproj = proyectoNuevo();
  const p = montarPanel({ motorRoto: true });
  p.ctx.HPStore.setContext(prproj, 'Clase 14');
  const j = job({
    projectPath: prproj, seqName: 'Clase 14',
    payload: {
      projectPath: prproj, sequenceName: 'Clase 14', mode: 'adjust', markerSlug: 'Marcador 3',
      stills: ['/p/HyperPremiere/_referencias/marca.png'],
    },
  });
  p.ctx.HPQueue.addStaged(j);
  const body = await p.ctx.HPQueue.payloadForEstimate(p.ctx.HPQueue.jobs()[0]);
  eq(body.stills.length, 1, 'lo que traía sigue estando');
  has(body.stills[0], 'marca.png');
});

// ── El chequeo previo: que no salga en silencio sin el material ──────
//
// La migración la dispara el bloque general al abrirse, y hasta que su promesa
// resuelve —o si quedó esperando que el editor conteste el cartel del
// conflicto— `forModel` devuelve solo lo que hay en el proyecto: nada. Generar
// en esa ventana sale sin la marca, se ve presentable y no lo dice nadie: el
// motor no puede avisar porque no sabe que hay material en el limbo, y el único
// que lo sabe es el panel. Es la ventana de la PRIMERA generación después de
// actualizar, que es justo la que nadie mira con desconfianza.
//
// Lo que se prueba acá es el chequeo previo de la cola de verdad, con el texto
// original de main.js: que frene, que explique, que se pueda insistir, que
// espere sola cuando alcanza con esperar, y que a quien no tiene nada guardado
// no le aparezca ningún cartel.

/**
 * El panel con el chequeo previo de main.js instalado en la cola de verdad.
 *
 * La otra mitad del chequeo —transcript y objetivo— contesta que ya está: acá se
 * mide la de las referencias, y una clase sin transcript ya tiene sus tests.
 */
function conChequeoPrevio(p, prproj, seqName) {
  const salidas = [];
  p.ctx.__salidas = salidas;
  vm.runInContext(
    'var currentProjectPath = ' + JSON.stringify(prproj) + ';\n' +
    'var currentSequenceName = ' + JSON.stringify(seqName) + ';\n' +
    'var hpLog = HPLog.log;\n' +
    'function setOutput(t, e) { __salidas.push({ texto: String(t), error: !!e }); }\n' +
    'var refsDecidido = {};\n' +
    'function contextIsReadyFor() { return true; }\n' +
    'function prepareContextFor() { return Promise.resolve(true); }\n' +
    'function markContextChanged() {}\n' +
    'var contextPrepFailed = {}, contextPrepared = {};\n' +
    funcionDeMain('refsListasPara') + '\n' +
    funcionDeMain('modelPreflight') + '\n' +
    'HPQueue.setModelPreflight(modelPreflight);',
    p.ctx, { filename: 'main.js (extracto)' });
  return salidas;
}

function jobDeGenerar(prproj, seqName, extra) {
  return Object.assign({
    kind: 'generate',
    payload: {
      projectPath: prproj, sequenceName: seqName, mode: 'generate',
      markerSlug: 'Marcador 1', instruction: 'Un cartel con el título.',
      markerStart: 10, markerDuration: 6, stills: [],
    },
    seqName: seqName, projectPath: prproj, markerKey: 'Marcador 1',
    label: 'Marcador 1', markerStart: 10, markerDuration: 6,
  }, extra);
}

/** Le da tiempo a la cola a resolver sus promesas (o a frenarse). */
function correrLaCola(p) {
  p.ctx.HPQueue.start();
  return new Promise(function (listo) {
    let vueltas = 0;
    (function ver() {
      const q = p.ctx.HPQueue;
      const quieta = q.isPaused() || (!q.hasQueued() && !q.hasActive());
      if ((quieta && vueltas > 2) || vueltas > 400) return listo();
      vueltas++;
      setTimeout(ver, 5);
    })();
  });
}

function loQueLlego(p) {
  return p.espia.preparado || null;
}

test('con referencias sin migrar, la cola FRENA antes de gastar tokens', async function () {
  // El defecto entero: tres referencias guardadas en esta máquina, el proyecto
  // sin carpeta, y una generación que salía igual y sin la marca.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  p.ctx.HPStore.setContext(prproj, 'Clase 14');
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }, { dataUrl: OTRA_IMG }]);
  const salidas = conChequeoPrevio(p, prproj, 'Clase 14');

  p.ctx.HPQueue.addStaged(jobDeGenerar(prproj, 'Clase 14'));
  await correrLaCola(p);

  eq(loQueLlego(p), null, 'no se le mandó nada al modelo');
  eq(p.ctx.HPQueue.isPaused(), true, 'y la cola quedó pausada');
  ok(salidas.some(function (s) { return s.error && s.texto.indexOf('No generé nada') !== -1; }),
    'el panel lo dice en la pantalla: ' + JSON.stringify(salidas));
  ok(p.espia.logs.some(function (l) { return l.indexOf('WARN') === 0 && l.indexOf('FRENADA') !== -1; }),
    'y queda en el log: ' + p.espia.logs.join(' | '));
});

test('el cartel dice cuántas son, de qué clase y cómo se sueltan', async function () {
  // Un cartel que dice "falta algo" sin decir qué hacer manda al editor a
  // adivinar, y adivinando lo que hace es apretar Generar otra vez.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  p.ctx.HPStore.setContext(prproj, 'Clase 14');
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }]);
  const salidas = conChequeoPrevio(p, prproj, 'Clase 14');

  p.ctx.HPQueue.addStaged(jobDeGenerar(prproj, 'Clase 14'));
  await correrLaCola(p);

  const t = salidas.map(function (s) { return s.texto; }).join('\n');
  has(t, '1 referencia', 'cuántas');
  has(t, 'Clase 14', 'de qué clase');
  has(t, 'Iniciar cola', 'y cómo generar igual si eso es lo que quiere');
});

test('si el editor insiste, se genera SIN ellas y el log lo deja escrito', async function () {
  // La decisión es del editor: puede tener el material en otra máquina y querer
  // el gráfico igual. Lo que no puede es que salga callado.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  p.ctx.HPStore.setContext(prproj, 'Clase 14');
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }]);
  conChequeoPrevio(p, prproj, 'Clase 14');

  p.ctx.HPQueue.addStaged(jobDeGenerar(prproj, 'Clase 14'));
  await correrLaCola(p);
  eq(loQueLlego(p), null, 'la primera vez frenó');

  await correrLaCola(p); // ▶ Iniciar cola otra vez
  ok(loQueLlego(p), 'ahora sí se generó');
  ok(p.espia.logs.some(function (l) {
    return l.indexOf('WARN') === 0 && l.indexOf('SIN 1 referencia') !== -1 &&
      l.indexOf('decisión del editor') !== -1;
  }), 'y el log dice qué salió sin qué: ' + p.espia.logs.join(' | '));
});

test('si la migración está EN VUELO, se espera y el material VIAJA', async function () {
  // El caso normal del día de la actualización: la ventana dura lo que tarda el
  // disco y se resuelve sola. Nadie tiene que ver ningún cartel por esto, y
  // sobre todo la generación tiene que salir CON la marca.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  p.ctx.HPStore.setContext(prproj, 'Clase 14');
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }]);
  const salidas = conChequeoPrevio(p, prproj, 'Clase 14');

  p.ctx.HPRefs.migrate(prproj, 'Clase 14'); // arrancó y NO se espera: como en el panel
  p.ctx.HPQueue.addStaged(jobDeGenerar(prproj, 'Clase 14'));
  await correrLaCola(p);

  const body = loQueLlego(p);
  ok(body, 'se generó');
  ok((body.stills || []).some(function (s) { return s.indexOf('_referencias') !== -1; }),
    'y la referencia viajó, ya desde la carpeta del proyecto: ' + JSON.stringify(body.stills));
  eq(salidas.length, 0, 'sin un solo cartel: esperar alcanzaba');
});

test('sin nada guardado en esta máquina no se espera ni aparece ningún cartel', async function () {
  // El caso de todo el mundo, todos los días. Un chequeo que le empieza a
  // mostrar carteles a quien no tiene nada pendiente es peor que el bug.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  p.ctx.HPStore.setContext(prproj, 'Clase 14');
  const salidas = conChequeoPrevio(p, prproj, 'Clase 14');

  p.ctx.HPQueue.addStaged(jobDeGenerar(prproj, 'Clase 14'));
  await correrLaCola(p);

  ok(loQueLlego(p), 'se generó de una');
  eq(salidas.length, 0, 'sin carteles');
  ok(!p.espia.logs.some(function (l) { return l.indexOf('referencia') !== -1; }),
    'y sin renglones hablando de referencias: ' + p.espia.logs.join(' | '));
});

test('el material que quedó ESPERANDO UNA DECISIÓN también frena la cola', async function () {
  // El conflicto: el proyecto ya tenía otras y no se pisó ninguna. Ahí no hay
  // nada que esperar —la migración ya terminó— y el material sigue sin viajar.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  p.ctx.HPStore.setContext(prproj, 'Clase 14');
  agregar(prproj, 'Clase 14', 'sequence', { name: 'del-companiero.png', dataUrl: OTRA_IMG });
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }]);
  await p.ctx.HPRefs.migrate(prproj, 'Clase 14');
  const salidas = conChequeoPrevio(p, prproj, 'Clase 14');

  p.ctx.HPQueue.addStaged(jobDeGenerar(prproj, 'Clase 14'));
  await correrLaCola(p);

  eq(loQueLlego(p), null, 'no se generó');
  has(salidas.map(function (s) { return s.texto; }).join('\n'), 'de quién son',
    'y el cartel manda a contestar el otro cartel');
});

test('contestado el conflicto, la cola arranca sola y con el material adentro', async function () {
  const prproj = proyectoNuevo();
  const p = montarPanel();
  p.ctx.HPStore.setContext(prproj, 'Clase 14');
  agregar(prproj, 'Clase 14', 'sequence', { name: 'del-companiero.png', dataUrl: OTRA_IMG });
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }]);
  await p.ctx.HPRefs.migrate(prproj, 'Clase 14');
  const salidas = conChequeoPrevio(p, prproj, 'Clase 14');

  await p.ctx.HPRefs.resolvePending(prproj, 'Clase 14', 'sequence');
  p.ctx.HPQueue.addStaged(jobDeGenerar(prproj, 'Clase 14'));
  await correrLaCola(p);

  const body = loQueLlego(p);
  ok(body, 'se generó');
  eq((body.stills || []).length, 2, 'con las dos: la del compañero y la que estaba en esta máquina');
  eq(salidas.length, 0, 'y sin frenar a nadie: ya no había nada pendiente');
});

test('una corrección de OTRO corte se frena por el material de SU secuencia', async function () {
  // El material de un job sale de la secuencia donde NACIÓ el recurso, no de la
  // que el editor tiene abierta. Mirar la abierta dejaría pasar en silencio
  // justo el pedido más caro: la clase ya salió y se está corrigiendo.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  p.ctx.HPStore.setContext(prproj, 'Clase 14_02');
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }]); // en el corte VIEJO
  const salidas = conChequeoPrevio(p, prproj, 'Clase 14_02');

  p.ctx.HPQueue.addStaged(jobDeGenerar(prproj, 'Clase 14_02', {
    kind: 'feedback', storeSeqName: 'Clase 14',
  }));
  await correrLaCola(p);

  eq(loQueLlego(p), null, 'la corrección no salió sin el material de su origen');
  has(salidas.map(function (s) { return s.texto; }).join('\n'), 'Clase 14',
    'y el cartel nombra la clase de la que sale el material');
});

test('el material de OTRAS clases se cuenta al abrir el panel, aunque no se sepa de cuál', async function () {
  // El riesgo aparte: quien guardó referencias contra seis clases y abre una deja
  // las otras cinco esperando, y nada las nombraba. De QUÉ clase es cada una no
  // se puede saber (el namespace del localStorage es un hash y no se invierte),
  // así que lo honesto es contarlas y decir qué las suelta.
  const prproj = proyectoNuevo();
  const p = montarPanel();
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }]);
  conRefsLocales(p, prproj, 'Clase 15', [{ dataUrl: IMG }, { dataUrl: OTRA_IMG }]);

  p.ctx.HPStore.setContext(prproj, 'Clase 14');
  const otras = p.ctx.HPStore.countUnmigratedGeneralRefs();
  eq(otras.contexts, 1, 'la 15, que es la que no está abierta');
  eq(otras.refs, 2, 'con sus dos referencias');

  p.ctx.HPStore.setContext(prproj, 'Clase 15');
  eq(p.ctx.HPStore.countUnmigratedGeneralRefs().contexts, 1, 'y visto desde la 15, la 14');
});

test('sin nada pendiente en otras clases, el barrido no cuenta nada', async function () {
  const prproj = proyectoNuevo();
  const p = montarPanel();
  p.ctx.HPStore.setContext(prproj, 'Clase 14');
  conRefsLocales(p, prproj, 'Clase 14', [{ dataUrl: IMG }]);
  const otras = p.ctx.HPStore.countUnmigratedGeneralRefs();
  eq(otras.contexts, 0, 'lo de la clase abierta no es "otra clase"');
  eq(otras.refs, 0);
});

// ── Los PDFs y la documentación, de verdad ───────────────────────────

/**
 * Corre un proveedor de CLI contra su ejecutable de mentira, que anota en un
 * archivo lo que recibió. Es el último eslabón antes de la nube: lo que se lee
 * de ahí es literalmente lo que se paga.
 */
async function correrCli(mod, bin, cfg) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hp-cli-')), 'recibido.json');
  const antes = { modo: process.env.FAKE_MODE, log: process.env.FAKE_LOG };
  process.env.FAKE_MODE = 'plano';
  process.env.FAKE_LOG = log;
  try {
    await mod.generate({
      systemPrompt: 'Sé breve.',
      userPrompt: '## Instrucción del editor\nUn cartel con los tres componentes.',
      images: [], model: 'modelo-de-prueba',
      config: Object.assign({ binPath: bin, cursorBinPath: bin, timeoutMs: 30000 }, cfg),
    });
  } catch (e) { /* lo que interesa es lo que recibió, no lo que contestó */ }
  const d = JSON.parse(fs.readFileSync(log, 'utf8'));
  process.env.FAKE_MODE = antes.modo === undefined ? '' : antes.modo;
  process.env.FAKE_LOG = antes.log === undefined ? '' : antes.log;
  return {
    args: d.args || [],
    prompt: d.promptPosicional !== null && d.promptPosicional !== undefined
      ? d.promptPosicional : (d.stdinCompleto || ''),
    workspace: d.workspace || '',
  };
}

function correrClaude(cfg) { return correrCli(claudeCli, FAKE_CLAUDE, cfg); }
function correrCursor(cfg) { return correrCli(cursorCli, FAKE_CURSOR, cfg); }

test('guardar un recurso acepta las dos formas: base64 del marcador y ruta de los generales', function () {
  // El de un marcador se arrastra a su tarjeta y sigue viniendo en base64. El de
  // los dos niveles generales YA es un archivo del proyecto: copiarlo en vez de
  // re-decodificarlo evita el viaje de ida y vuelta por base64 de un PDF de
  // varios MB, que era todo el punto de sacarlos del localStorage.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-res-'));
  const suelto = path.join(dir, 'ficha.txt');
  fs.writeFileSync(suelto, 'contenido', 'utf8');
  const out = projectFs.saveResources(path.join(dir, 'destino'), [
    { name: 'del-marcador.txt', dataUrl: 'data:text/plain;base64,' + Buffer.from('hola').toString('base64') },
    { name: 'del-curso.txt', path: suelto },
  ]);
  eq(out.length, 2, 'las dos se guardaron');
  eq(fs.readFileSync(out[0], 'utf8'), 'hola');
  eq(fs.readFileSync(out[1], 'utf8'), 'contenido');
});

test('solo DOS de los cinco proveedores pueden abrir un archivo', function () {
  // No es un detalle de implementación: es lo que decide si el PDF que el editor
  // arrastró le llega al modelo. Los dos CLI de agente tienen herramienta de
  // lectura; los otros tres hablan por HTTP con un modelo que no tiene disco.
  eq(proveedores.leeArchivos('claude-cli'), true);
  eq(proveedores.leeArchivos('cursor-cli'), true);
  eq(proveedores.leeArchivos('claude-api'), false, 'la API de Claude no ve el disco de esta máquina');
  eq(proveedores.leeArchivos('openai-compat'), false);
  eq(proveedores.leeArchivos('ollama'), false);
});

test('el renglón que nombra los documentos dice que están en el DISCO, no adjuntos', function () {
  // Es la diferencia entre "abrí este archivo" y "mirá lo que te mandé": si el
  // modelo cree que ya lo tiene, no lo abre y compone sin él.
  const nota = proveedores.docsAsFilesNote(['/p/HyperPremiere/_referencias/manual-de-marca.pdf']);
  has(nota, 'manual-de-marca.pdf');
  has(nota, 'en disco');
  has(nota, 'ANTES');
  eq(proveedores.docsAsFilesNote([]), '', 'sin documentos no se dice nada');
});

test('el PDF le llega a claude-cli nombrado por su ruta del proyecto', async function () {
  if (saltarEnWindows) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-doc-'));
  const pdf = path.join(dir, 'manual-de-marca.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4 falso');

  const { args, prompt } = await correrClaude({ docFiles: [pdf], readDirs: [dir] });
  has(prompt, pdf, 'el prompt le dice dónde está');
  // Nombrar la ruta no alcanza: el CLI solo lee sin preguntar adentro de las
  // carpetas que tiene declaradas, y ésta vive en el disco del proyecto (que en
  // Windows puede ser otra unidad entera).
  const i = args.indexOf('--add-dir');
  ok(i !== -1 && args[i + 1] === dir, 'y la carpeta va autorizada: ' + args.join(' '));
});

test('a cursor-agent el PDF se le COPIA adentro de su workspace, que es lo único que ve', async function () {
  if (saltarEnWindows) return;
  // Este agente trabaja encerrado en un --workspace temporal. La ruta del
  // proyecto le queda AFUERA: el PDF aparecía nombrado en el pedido y fuera de
  // su alcance, y componía igual. La copia adentro es lo que lo arregla.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-doc-'));
  const pdf = path.join(dir, 'manual-de-marca.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4 falso');

  const { prompt, workspace } = await correrCursor({ docFiles: [pdf] });
  has(prompt, 'manual-de-marca.pdf');
  ok(prompt.indexOf(dir) === -1, 'NO se le nombra la ruta del proyecto, que no puede abrir');
  has(prompt, workspace, 'sino la copia que quedó adentro de su workspace');
});
