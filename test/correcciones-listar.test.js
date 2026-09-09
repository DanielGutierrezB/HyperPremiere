'use strict';

// Reconstruir lo ya generado mirando el disco (listCorrections).
//
// La pestaña Corrections existe porque volver a abrir los marcadores no siempre
// es posible: el editor manda la clase a revisar y cuando vuelve, los
// marcadores pueden estar borrados, movidos o mezclados con los comentarios de
// Frame.io. Así que la única fuente confiable es la carpeta de la secuencia.
//
// Lo que más importa acá es el TRAMO (en qué segundo entraba y cuánto duraba):
// sin eso la corrección no puede volver a su lugar. Se busca en tres fuentes de
// peor en peor, y los tests recorren esa cascada entera.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq, deepEq } = require('./harness');

const engine = require('../bridge/engine');
const { writeVersionMeta, mergeVersionMeta, readMeta } = require('../bridge/store/project-fs');

function slugify(nombre) {
  return String(nombre).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Escribe en una carpeta de secuencia lo mismo que deja una generación real. */
function escritorDe(dir, nombreSecuencia) {
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    sequenceName: nombreSecuencia,
    version: function (slugMarcador, v, opts) {
      opts = opts || {};
      const base = slugMarcador + ' v' + v + (opts.model ? ' [' + opts.model + ']' : '');
      fs.writeFileSync(path.join(dir, base + '.html'), opts.html || '<div id="stage" data-duration="5"></div>');
      if (opts.video !== false) fs.writeFileSync(path.join(dir, base + '.mov'), 'video');
      if (opts.meta !== false) {
        fs.writeFileSync(path.join(dir, base + '.meta.json'), JSON.stringify(Object.assign({
          version: v, model: opts.model || '', instruction: opts.instruction || '',
          sequenceName: nombreSecuencia, markerSlug: slugMarcador,
          markerName: opts.markerName || '', markerGuid: opts.guid || '',
          marker: opts.marker,
        }, opts.metaExtra || {})));
      }
      return this;
    },
    /** El transcript, que es de donde sale el nombre real de la secuencia. */
    transcript: function () {
      fs.writeFileSync(path.join(dir, 'transcript.json'),
        JSON.stringify({ sequenceName: nombreSecuencia, segments: [] }));
      return this;
    },
  };
}

/** Carpeta de proyecto descartable, con la estructura real que arma el motor. */
function armarProyecto(nombreSecuencia) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-corr-'));
  const proyecto = path.join(raiz, 'Clases.prproj');
  fs.writeFileSync(proyecto, 'x');
  const hp = path.join(raiz, 'HyperPremiere');
  const propia = escritorDe(path.join(hp, slugify(nombreSecuencia)), nombreSecuencia);

  return {
    projectPath: proyecto,
    sequenceName: nombreSecuencia,
    dir: propia.dir,
    raiz,
    version: propia.version,
    /** Otra secuencia del MISMO proyecto (otro corte de la clase, u otra clase). */
    otraSecuencia: function (nombre) {
      return escritorDe(path.join(hp, slugify(nombre)), nombre);
    },
    cola: function (jobs) {
      fs.writeFileSync(path.join(hp, 'queue.json'), JSON.stringify({ version: 1, jobs }));
    },
    /** El prompt general del curso, tal como vive al lado del .prproj. */
    promptDelCurso: function (texto) {
      fs.writeFileSync(path.join(hp, 'prompt-general.md'), texto);
    },
    /** El prompt de una secuencia, en su carpeta. */
    promptDeSecuencia: function (nombre, texto) {
      const d = path.join(hp, slugify(nombre));
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'prompt-secuencia.md'), texto);
    },
    listar: function (folderSlug) {
      return engine.listCorrections({
        projectPath: proyecto, sequenceName: nombreSecuencia, folderSlug: folderSlug || '',
      });
    },
  };
}

test('agrupa por marcador y se queda con la última versión', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { model: 'claude-sonnet-5', marker: { name: 'Intro', start: 10, duration: 5 } });
  p.version('Marcador 1', 2, { model: 'claude-opus-5', marker: { name: 'Intro', start: 10, duration: 5 } });
  p.version('Marcador 3', 1, { model: 'claude-sonnet-5', marker: { name: 'Gráfico', start: 90, duration: 8 } });

  const r = p.listar();
  ok(r.ok, 'contestó bien');
  eq(r.markers.length, 2, 'dos marcadores, no tres archivos');
  eq(r.markers[0].slug, 'Marcador 1');
  eq(r.markers[0].latestVersion, 2, 'la última es la que se corrige por defecto');
  eq(r.markers[0].model, 'claude-opus-5', 'y el modelo es el de ESA versión');
  eq(r.markers[0].versions.length, 2, 'pero las anteriores siguen disponibles para elegir');
});

test('trae el tramo del timeline, que es para lo que existe la pestaña', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { marker: { name: 'Intro', start: 12.5, duration: 6 }, markerName: 'Intro', guid: 'g-1' });

  const m = p.listar().markers[0];
  eq(m.start, 12.5, 'el segundo donde entraba');
  eq(m.duration, 6, 'y cuánto duraba');
  eq(m.timeSource, 'ficha');
  eq(m.markerName, 'Intro');
  eq(m.markerGuid, 'g-1', 'el guid viaja por si el marcador todavía existe');
});

test('los marcadores salen en orden de número, no alfabético', function () {
  // "Marcador 10" antes que "Marcador 2" es exactamente lo que hace ordenar por
  // texto, y deja la lista ilegible en una clase larga.
  const p = armarProyecto('Clase 14');
  [1, 2, 10, 11].forEach(function (n) {
    p.version('Marcador ' + n, 1, { marker: { name: 'x', start: n, duration: 3 } });
  });
  deepEq(p.listar().markers.map(function (m) { return m.slug; }),
    ['Marcador 1', 'Marcador 2', 'Marcador 10', 'Marcador 11']);
});

test('dice qué versiones tienen video y cuáles solo HTML', function () {
  // Un render que se cortó deja el HTML sin el .mov. La fila tiene que poder
  // decirlo en vez de ofrecer corregir algo que nunca llegó al timeline.
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 } });
  p.version('Marcador 1', 2, { marker: { name: 'x', start: 1, duration: 3 }, video: false });

  const vs = p.listar().markers[0].versions;
  eq(vs[0].hasVideo, true);
  eq(vs[1].hasVideo, false, 'esa se quedó sin render');
});

// ── La cascada cuando falta la ficha ─────────────────────────────────

test('sin ficha, el tramo se recupera de la cola del proyecto', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { meta: false });
  p.cola([{ markerKey: 'Marcador 1', seqName: 'Clase 14', markerStart: 33, markerDuration: 7 }]);

  const m = p.listar().markers[0];
  eq(m.start, 33);
  eq(m.duration, 7);
  eq(m.timeSource, 'cola');
});

test('no se toma el tramo de un trabajo de OTRA secuencia', function () {
  // Mismo "Marcador 1" en dos clases del mismo proyecto: agarrar el de la otra
  // pondría el clip corregido en un segundo que no le corresponde.
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { meta: false, html: '<div id="stage"></div>' });
  p.cola([{ markerKey: 'Marcador 1', seqName: 'Clase 09', markerStart: 999, markerDuration: 7 }]);

  const m = p.listar().markers[0];
  eq(m.start, null, 'mejor no saber que saber mal');
  eq(m.timeSource, '');
});

test('sin ficha ni cola, el HTML da la duración pero no dónde iba', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { meta: false, html: '<div id="stage" data-composition-id="m1" data-duration="9"></div>' });

  const m = p.listar().markers[0];
  eq(m.duration, 9, 'la duración está declarada en la composición');
  eq(m.start, null, 'la posición no: eso vivía en el marcador');
  eq(m.timeSource, 'html');
});

test('cuando no hay ninguna fuente, se dice y no se inventa', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { meta: false, html: '<div id="stage"></div>' });

  const m = p.listar().markers[0];
  eq(m.start, null);
  eq(m.duration, null);
  eq(m.timeSource, '', 'la fila va a pedir el tramo a mano');
});

test('una ficha vieja sin tramo no tapa a una nueva que sí lo tiene', function () {
  // Al corregir, la versión más nueva es la que manda; pero si esa se generó
  // antes de que la ficha guardara la posición, hay que seguir bajando.
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { marker: { name: 'Intro', start: 40, duration: 4 } });
  p.version('Marcador 1', 2, { marker: undefined });

  const m = p.listar().markers[0];
  eq(m.start, 40, 'lo sacó de la v1');
  eq(m.latestVersion, 2, 'pero la corrección sigue yendo sobre la v2');
});

test('con fondo o sin fondo se conserva, para no cambiar de opaco a transparente', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 }, metaExtra: { background: true } });
  p.version('Marcador 2', 1, { marker: { name: 'x', start: 9, duration: 3 } });

  const ms = p.listar().markers;
  eq(ms[0].background, true);
  eq(ms[1].background, false);
});

test('una ficha que no habla del fondo no dice "sin fondo": lo busca más atrás', function () {
  // Los renders manuales viejos no anotaban el fondo. Leyendo eso como "sin
  // fondo", corregir un recurso opaco lo devolvía transparente.
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 }, metaExtra: { background: true } });
  p.version('Marcador 1', 2, { marker: { name: 'x', start: 1, duration: 3 } });

  eq(p.listar().markers[0].background, true, 'sigue siendo el opaco que era');
});

test('el encargo del recurso sobrevive a un render manual', function () {
  // "(edición manual)" es el sello de un render sin IA, no un encargo: si se
  // toma como tal, la corrección siguiente le pide al modelo rediseñar algo
  // cuyo propósito ya nadie sabe.
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 }, instruction: 'un gráfico de barras' });
  p.version('Marcador 1', 2, { marker: { name: 'x', start: 1, duration: 3 }, instruction: '(edición manual)' });

  eq(p.listar().markers[0].instruction, 'un gráfico de barras');
});

// ── Con qué contexto se generó cada recurso ──────────────────────────
// El prompt del curso, el de la secuencia y el objetivo viajan en cada llamada
// al modelo, pero hasta acá la ficha guardaba solo la instrucción. O sea: al mes
// no se podía saber con qué estilo se había generado un recurso, y la pestaña de
// correcciones lo más cerca que llegaba era leer los archivos de HOY, que pueden
// haber cambiado veinte veces. Ahora la ficha lo anota, y lo que el listado tiene
// que dejar clarísimo es CUÁL de las dos cosas está entregando.

test('lo que se anota en la ficha es lo que VIAJÓ, ajustes incluidos', function () {
  // Se prueba `promptRecord` directamente porque llegar hasta el `saveMeta` por el
  // camino largo pide un proveedor de verdad (eso está en
  // test/manual/prompt-tres-niveles.js, que lo corre de punta a punta y vuelca la
  // ficha). Lo que se fija acá es la decisión: la ficha anota el texto que entró
  // en la llamada, no el que decía el archivo, y dice que hubo ajuste.
  const r = engine._promptRecord({
    generalInstruction: 'paleta azul institucional',
    sequenceInstruction: 'blanco y negro',
    objective: 'enseñar deep research',
    promptOverride: { course: 'paleta azul institucional, y NADA de degradés' },
  });
  eq(r.course, 'paleta azul institucional, y NADA de degradés', 'lo que se mandó, no lo que decía el archivo');
  eq(r.sequence, 'blanco y negro');
  eq(r.objective, 'enseñar deep research');
  deepEq(r.adjusted, { course: true, sequence: false, objective: false },
    'y CUÁL de los tres se ajustó a mano: es lo único con lo que el panel puede decir ' +
    'por qué esto no coincide con el archivo de hoy');
});

test('el objetivo ajustado a mano también queda anotado como ajuste', function () {
  // Se editaba en la fila igual que los otros dos y la ficha no lo registraba, así
  // que la diferencia con lo que el panel muestra hoy quedaba sin explicación.
  const r = engine._promptRecord({
    generalInstruction: 'paleta azul institucional', sequenceInstruction: '',
    objective: 'enseñar deep research',
    promptOverride: { objective: 'enseñar deep research, foco en el buscador' },
  });
  eq(r.objective, 'enseñar deep research, foco en el buscador', 'viajó el ajustado');
  deepEq(r.adjusted, { course: false, sequence: false, objective: true });
});

test('sin ajuste la ficha no habla de ajustes, y anota lo que dicen los archivos', function () {
  const r = engine._promptRecord({
    generalInstruction: 'paleta azul institucional', sequenceInstruction: '', objective: '',
  });
  eq(r.course, 'paleta azul institucional');
  eq(r.sequence, '');
  eq(r.adjusted, undefined, 'una clave que aparece solo cuando hay algo que contar');
  eq(r.unknownLevel, undefined);
});

test('un job de antes de que hubiera dos niveles se anota como "no se sabe"', function () {
  // Mandaba un solo texto ya resuelto y sin decir de qué nivel era. Ponerlo en
  // `course` sería inventar el único dato por el que se mira esta ficha.
  const r = engine._promptRecord({ generalInstruction: 'un texto de antes' });
  eq(r.unknownLevel, true);
});

test('anotar el tramo a mano no borra el contexto que la ficha ya tenía', function () {
  // Escribir dónde iba el recurso reescribe su ficha. Si se llevara puestos los
  // tres niveles, la fila pasaría de "esto es lo que se mandó" a "esto es una
  // reconstrucción" por haber contestado una pregunta que no tiene nada que ver.
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, {
    marker: null,
    metaExtra: { prompts: { course: 'todo en Inter', sequence: '', objective: 'deep research' } },
  });

  engine.saveCorrectionPosition({
    projectPath: p.projectPath, sequenceName: 'Clase 14', markerSlug: 'Marcador 1',
    start: 55, duration: 9,
  });

  const m = p.listar().markers[0];
  eq(m.start, 55, 'el tramo quedó anotado');
  eq(m.prompts.course, 'todo en Inter', 'y el contexto sigue estando');
});

// ── La ficha, contra archivos de verdad ──────────────────────────────
//
// Estos tres tests mirvaban el TEXTO FUENTE de engine.js —el orden de las
// propiedades de un objeto literal, el espaciado alrededor de una coma y la
// redacción de un comentario— porque la ficha no tenía dónde probarse: cuatro
// call sites armaban su registro a mano y no había ninguna función que escribir
// significara. Ahora la forma vive en project-fs.js y se prueba como se prueba
// la lectura acá abajo: escribiendo en una carpeta descartable y leyendo qué
// quedó.

/** Un `.meta.json` en una carpeta descartable, y su ruta. */
function fichaDescartable() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-ficha-'));
  return path.join(dir, 'marcador-1 v1 [gemini].meta.json');
}

test('escribir la ficha de una generación anota los tres niveles y el tramo', function () {
  // Es la ficha que se anota ANTES de gastar la llamada al modelo: si la
  // generación se cae a mitad, es lo único que sabe a qué tramo de qué secuencia
  // pertenece ese HTML, y con qué contexto se pidió.
  const metaPath = fichaDescartable();
  writeVersionMeta(metaPath, {
    sequenceName: 'Clase 14', markerSlug: 'marcador-1',
    marker: { name: 'Marcador 1', guid: 'abc', start: 12, duration: 4 },
    version: 1, model: 'gemini', provider: 'google', mode: 'generate',
    instruction: 'un gráfico con los tres pasos',
    prompts: { course: 'todo en Inter', sequence: 'blanco y negro', objective: 'deep research' },
    createdAt: '2026-01-01T00:00:00.000Z',
    pending: true,
  });

  const f = readMeta(metaPath);
  eq(f.sequenceName, 'Clase 14');
  eq(f.marker.start, 12, 'el tramo, que es lo que no se puede reconstruir del disco');
  eq(f.markerName, 'Marcador 1', 'el nombre sale del marcador sin que nadie lo copie a mano');
  eq(f.markerGuid, 'abc');
  eq(f.prompts.course, 'todo en Inter');
  eq(f.prompts.sequence, 'blanco y negro');
  eq(f.prompts.objective, 'deep research');
  eq(f.pending, true, 'y que todavía no llegó al final');
});

test('reescribir la ficha al final NO deja el pending de la escritura anterior', function () {
  // La ausencia de `pending` es lo que significa "llegó al final", así que la
  // escritura del final tiene que ser COMPLETA: un campo que sobreviviera de la
  // anterior estaría hablando de un intento que ya no existe.
  const metaPath = fichaDescartable();
  writeVersionMeta(metaPath, { sequenceName: 'Clase 14', markerSlug: 'marcador-1', version: 1, pending: true });
  writeVersionMeta(metaPath, {
    sequenceName: 'Clase 14', markerSlug: 'marcador-1', version: 1,
    prompts: { course: 'todo en Inter', sequence: '', objective: '' },
    timings: { modelMs: 900, renderMs: 300 },
  });

  const f = readMeta(metaPath);
  eq(f.pending, undefined, 'la generación llegó al final');
  eq(f.prompts.course, 'todo en Inter', 'y los tres niveles volvieron a pasar');
  eq(f.timings.renderMs, 300);
});

test('la ficha de un render manual NO se atribuye prompts: no llamó a ningún modelo', function () {
  // Heredarlos como se hereda el encargo sería anotar como "lo que se le mandó"
  // algo que no se mandó nunca. Quien lea la ficha los sigue encontrando: la
  // búsqueda baja por las versiones anteriores y dice de cuál los sacó. Decirlo
  // con `prompts: undefined` es lo que deja que el pedido lo diga en una línea,
  // en vez de que la omisión haya que notarla leyendo qué campos no están.
  const metaPath = fichaDescartable();
  writeVersionMeta(metaPath, {
    sequenceName: 'Clase 14', markerSlug: 'marcador-1', version: 2,
    model: 'manual', provider: 'manual', mode: 'manual-edit',
    instruction: 'un gráfico con los tres pasos',
    prompts: undefined,
  });

  const f = readMeta(metaPath);
  ok(!('prompts' in f), 'la clave no está: no hay ningún prompt que esta versión haya recibido');
  eq(f.instruction, 'un gráfico con los tres pasos', 'pero el ENCARGO sí, que es lo que se vuelve a mandar');
});

test('las dos fichas de una generación anotan los tres niveles', function () {
  // La primera es la que hace que sobrevivan a una generación que se cae; la
  // segunda, la que no los borra al terminar. Las dos salen de la MISMA función,
  // que es lo que hace imposible que una anote algo que la otra pierda: mientras
  // cada write listaba sus campos a mano, esto se vigilaba grepeando el fuente de
  // engine.js —el orden de las propiedades y el espaciado de una coma—, porque la
  // ficha no tenía dónde probarse.
  const pedido = {
    sequenceName: 'Clase 14', markerSlug: 'marcador-1',
    marker: { name: 'Marcador 1', start: 12, duration: 4 },
    version: 3, model: 'gemini', provider: 'google', mode: 'generate',
    instruction: 'un gráfico con los tres pasos',
    prompts: { course: 'todo en Inter', sequence: 'blanco y negro', objective: 'deep research' },
  };

  const antes = engine._fichaDeGeneracion(Object.assign({ pending: true }, pedido));
  const alFinal = engine._fichaDeGeneracion(Object.assign({ videoExt: 'mov' }, pedido), {
    timings: { modelMs: 900, renderMs: 300 },
  });

  deepEq(antes.prompts, pedido.prompts, 'antes de gastar la llamada al modelo');
  deepEq(alFinal.prompts, pedido.prompts, 'y al terminar el render, que reescribe la ficha entera');
  eq(antes.pending, true, 'la primera dice que todavía no llegó al final');
  eq(alFinal.pending, undefined, 'y la del final, que sí: la ausencia es lo que lo significa');
  eq(alFinal.timings.renderMs, 300);
  eq(alFinal.instruction, 'un gráfico con los tres pasos', 'el encargo está en las dos');
});

test('el ajuste solo se anota en la ficha si esa versión fue un refinamiento', function () {
  // `adjustment` es lo que se pidió en ESTA ronda; en una generación de cero no
  // hay ronda anterior y anotar el campo sería inventar una.
  const g = { mode: 'generate', adjustment: 'subí el título', videoExt: 'mov' };
  eq(engine._fichaDeGeneracion(g).adjustment, undefined);
  eq(engine._fichaDeGeneracion(Object.assign({}, g, { mode: 'adjust' })).adjustment, 'subí el título');
});

test('el merge de la ficha conserva lo que el pedido no nombra', function () {
  // Anotar a mano dónde iba un recurso viejo no puede llevarse puesto con qué
  // contexto se generó: la fila pasaría de "esto es lo que se mandó" a "esto es
  // una reconstrucción" por haber contestado una pregunta que no tiene que ver.
  const metaPath = fichaDescartable();
  writeVersionMeta(metaPath, {
    sequenceName: 'Clase 14', markerSlug: 'marcador-1', version: 1,
    prompts: { course: 'todo en Inter', sequence: '', objective: 'deep research' },
    timings: { modelMs: 900, renderMs: 300 },
  });
  mergeVersionMeta(metaPath, {
    sequenceName: 'Clase 14', markerSlug: 'marcador-1',
    marker: { name: 'Marcador 1', start: 55, duration: 9 },
  });

  const f = readMeta(metaPath);
  eq(f.marker.start, 55, 'el tramo quedó anotado');
  eq(f.prompts.course, 'todo en Inter', 'y el contexto sigue estando');
  eq(f.timings.modelMs, 900);
  eq(f.version, 1);
});

test('la ficha guarda con qué contexto se generó, y el listado lo devuelve', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, {
    marker: { name: 'x', start: 1, duration: 3 },
    metaExtra: { prompts: { course: 'todo en Inter', sequence: 'los gráficos entran de abajo', objective: 'enseñar deep research' } },
  });

  const m = p.listar().markers[0];
  eq(m.prompts.course, 'todo en Inter');
  eq(m.prompts.sequence, 'los gráficos entran de abajo');
  eq(m.prompts.objective, 'enseñar deep research');
  eq(m.promptsVersion, 1, 'y de qué versión salió, que es lo que el panel muestra');
});

test('una versión anterior a esto no trae contexto, y eso NO se rellena', function () {
  // El caso honesto: de un recurso viejo no se puede saber qué se le mandó. El
  // listado tiene que devolver `null` para que el panel lo diga; si acá se
  // completara con los archivos de hoy, el panel no tendría forma de distinguir
  // un dato de una suposición, y se rediseña mirando esto.
  const p = armarProyecto('Clase 14');
  p.promptDelCurso('el estilo de hoy, que puede no ser el de entonces');
  p.version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 }, instruction: 'un gráfico' });

  const m = p.listar().markers[0];
  eq(m.prompts, null, 'de esta versión no se sabe, y se dice que no se sabe');
  eq(m.promptsVersion, 0);
});

test('los archivos de hoy viajan aparte, para poder reconstruir lo que no se guardó', function () {
  // Es lo único que se le puede ofrecer a un recurso viejo, y va en otra clave
  // justamente para que no se confunda con lo que recibió.
  const p = armarProyecto('Clase 14');
  p.promptDelCurso('todo en Inter, acento verde');
  p.promptDeSecuencia('Clase 14', 'esta clase habla de deep research');
  p.version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 } });

  const r = p.listar();
  eq(r.promptsNow.course, 'todo en Inter, acento verde');
  eq(r.promptsNow.sequence, 'esta clase habla de deep research');
  eq(r.promptsNow.failed, false);
});

test('los archivos de hoy se leen de la secuencia de ORIGEN, no de la abierta', function () {
  // La clase volvió re-cortada: el recurso nació en "Clase 14" y su prompt de
  // secuencia está en esa carpeta. Leyendo el de la abierta —vacía— la
  // reconstrucción diría que esa clase no agrega nada al estilo del curso, que
  // es exactamente lo contrario de lo que pasa.
  const p = armarProyecto('Clase 14_02');
  p.promptDelCurso('todo en Inter');
  p.promptDeSecuencia('Clase 14', 'esta clase habla de deep research');
  p.otraSecuencia('Clase 14').transcript()
    .version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 } });

  eq(p.listar().promptsNow.sequence, 'esta clase habla de deep research');
});

test('un render manual no se atribuye un contexto: lo hereda de quien lo tenga', function () {
  // Un render de HTML editado a mano no llamó a ningún modelo, así que no recibió
  // ningún prompt. Su ficha no lo anota, y la búsqueda sigue bajando: el contexto
  // que se muestra es el de la última versión que SÍ lo guardó, y se dice cuál.
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, {
    marker: { name: 'x', start: 1, duration: 3 },
    metaExtra: { prompts: { course: 'todo en Inter', sequence: '', objective: 'deep research' } },
  });
  p.version('Marcador 1', 2, { marker: { name: 'x', start: 1, duration: 3 }, metaExtra: { mode: 'manual-edit' } });

  const m = p.listar().markers[0];
  eq(m.latestVersion, 2);
  eq(m.prompts.course, 'todo en Inter');
  eq(m.promptsVersion, 1, 'y se dice que salió de la v1, no de la que se está corrigiendo');
});

test('el contexto que gana es el de la versión más nueva que lo anotó', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, {
    marker: { name: 'x', start: 1, duration: 3 },
    metaExtra: { prompts: { course: 'el estilo viejo', sequence: '', objective: '' } },
  });
  p.version('Marcador 1', 2, {
    marker: { name: 'x', start: 1, duration: 3 },
    metaExtra: { prompts: { course: 'el estilo con el que se generó la v2', sequence: '', objective: '' } },
  });

  const m = p.listar().markers[0];
  eq(m.prompts.course, 'el estilo con el que se generó la v2');
  eq(m.promptsVersion, 2);
});

// ── La clase volvió re-cortada, con otro nombre ──────────────────────
// Este es el caso que rompió en producción: el editor manda la clase, la vuelve
// a cortar como "Clase 14_02" y al pedir las correcciones la pestaña miraba la
// carpeta de ESA secuencia —vacía— y contestaba que no había nada generado,
// mientras los cinco recursos estaban en la carpeta de al lado.

test('si la secuencia abierta no tiene nada, se leen los recursos del otro corte', function () {
  const p = armarProyecto('Clase 14_02');
  p.otraSecuencia('Clase 14').transcript()
    .version('Marcador 1', 1, { marker: { name: 'Intro', start: 12, duration: 5 } })
    .version('Marcador 2', 1, { marker: { name: 'Dato', start: 40, duration: 6 } });

  const r = p.listar();
  eq(r.markers.length, 2, 'encontró lo generado en el corte viejo');
  eq(r.sourceSequenceName, 'Clase 14', 'y dice de dónde salió');
  eq(r.sequenceName, 'Clase 14_02', 'sin perder cuál es la abierta');
  eq(r.guessed, true, 'la elección fue nuestra, así que el panel lo avisa');
  eq(r.markers[0].start, 12, 'con el tramo del corte donde se generó');
});

test('el nombre real de la secuencia sale del transcript, no del nombre de la carpeta', function () {
  // La carpeta es el slug ("clase-14-copia-2"): no sirve para volver a
  // encontrar la secuencia en Premiere ni para mostrárselo al editor.
  const p = armarProyecto('Clase 14_02');
  p.otraSecuencia('Clase 14 · copia 2').transcript()
    .version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 } });

  eq(p.listar().sources[0].sequenceName, 'Clase 14 · copia 2');
});

test('sin transcript, el nombre de la secuencia se saca de la ficha', function () {
  const p = armarProyecto('Clase 14_02');
  p.otraSecuencia('Clase 14').version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 } });

  eq(p.listar().sourceSequenceName, 'Clase 14', 'la ficha lo guarda desde la v1.4.33');
});

test('se ofrecen todas las carpetas con recursos, para poder elegir a mano', function () {
  const p = armarProyecto('Clase 99');
  p.otraSecuencia('Clase 14').transcript().version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 } });
  p.otraSecuencia('Clase 15').transcript().version('Marcador 1', 1, { marker: { name: 'x', start: 2, duration: 3 } });
  p.otraSecuencia('Clase 16').transcript(); // sin recursos: no es una opción

  const r = p.listar();
  const nombres = r.sources.map(function (s) { return s.sequenceName; }).sort();
  deepEq(nombres, ['Clase 14', 'Clase 15'], 'las que tienen algo que corregir');
  eq(r.markers.length, 0, 'ninguna es pariente de la abierta, así que no se adivina');
  eq(r.folderSlug, '', 'y no se elige nada por el editor');
});

test('elegir una carpeta a mano manda sobre la que se hubiera adivinado', function () {
  const p = armarProyecto('Clase 14_02');
  p.otraSecuencia('Clase 14').transcript().version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 } });
  p.otraSecuencia('Clase 23').transcript()
    .version('Marcador 5', 1, { marker: { name: 'x', start: 70, duration: 4 } });

  const r = p.listar(slugify('Clase 23'));
  eq(r.sourceSequenceName, 'Clase 23');
  eq(r.guessed, false, 'lo eligió el editor, no nosotros');
  eq(r.markers[0].slug, 'Marcador 5');
});

test('"Clase 10" no se toma por otro corte de "Clase 1"', function () {
  // El parecido entre slugs solo vale si la parte de más empieza con "-": si no,
  // abrir la Clase 1 traería los recursos de la Clase 10 y el editor corregiría
  // la clase equivocada sin enterarse.
  const p = armarProyecto('Clase 1');
  p.otraSecuencia('Clase 10').transcript()
    .version('Marcador 1', 1, { marker: { name: 'x', start: 5, duration: 3 } });

  const r = p.listar();
  eq(r.markers.length, 0, 'no se adivinó nada');
  eq(r.sources.length, 1, 'pero está ofrecida para elegirla a mano');
});

test('el tramo de la cola se busca por la secuencia de ORIGEN, no por la abierta', function () {
  // Al leer de otro corte, filtrar la cola contra la secuencia abierta descarta
  // justo el trabajo que tiene el tramo que se está buscando.
  const p = armarProyecto('Clase 14_02');
  p.otraSecuencia('Clase 14').transcript()
    .version('Marcador 1', 1, { meta: false, html: '<div id="stage"></div>' });
  p.cola([{ markerKey: 'Marcador 1', seqName: 'Clase 14', markerStart: 33, markerDuration: 7 }]);

  const m = p.listar().markers[0];
  eq(m.start, 33);
  eq(m.timeSource, 'cola');
});

test('las carpetas internas de la herramienta no son secuencias', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 } });
  // `_assets` guarda las imágenes de referencia; `_capturas`, los frames.
  fs.mkdirSync(path.join(p.raiz, 'HyperPremiere', '_assets', 'Marcador 1'), { recursive: true });
  fs.writeFileSync(path.join(p.raiz, 'HyperPremiere', '_assets', 'Marcador 1 v1.html'), '<p>x</p>');

  eq(p.listar().sources.length, 1, 'solo la secuencia de verdad');
});

// ── Anotar el tramo a mano ───────────────────────────────────────────

test('el tramo escrito a mano queda en la ficha y no se vuelve a preguntar', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { meta: false, html: '<div id="stage"></div>' });
  eq(p.listar().markers[0].start, null, 'antes no se sabía');

  const r = engine.saveCorrectionPosition({
    projectPath: p.projectPath, sequenceName: p.sequenceName,
    markerSlug: 'Marcador 1', start: 55, duration: 4,
  });
  ok(r.ok, 'se guardó');

  const m = p.listar().markers[0];
  eq(m.start, 55);
  eq(m.duration, 4);
  eq(m.timeSource, 'ficha', 'ahora sale de la ficha como cualquier otro');
});

test('anotar el tramo no borra lo que la ficha ya tenía', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { instruction: 'un gráfico de barras', model: 'claude-sonnet-5', marker: undefined });

  engine.saveCorrectionPosition({
    projectPath: p.projectPath, sequenceName: p.sequenceName,
    markerSlug: 'Marcador 1', start: 8, duration: 5,
  });
  const m = p.listar().markers[0];
  eq(m.start, 8);
  eq(m.instruction, 'un gráfico de barras', 'la instrucción original sigue ahí');
});

test('un tramo imposible se rechaza en vez de guardarse', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { meta: false });
  const base = { projectPath: p.projectPath, sequenceName: p.sequenceName, markerSlug: 'Marcador 1' };

  eq(engine.saveCorrectionPosition(Object.assign({ start: 5, duration: 0 }, base)).ok, false, 'duración cero');
  eq(engine.saveCorrectionPosition(Object.assign({ start: -3, duration: 5 }, base)).ok, false, 'entra antes de empezar');
  eq(engine.saveCorrectionPosition({ projectPath: p.projectPath, sequenceName: p.sequenceName, start: 1, duration: 2 }).ok,
    false, 'sin marcador');
});

// ── Bordes ───────────────────────────────────────────────────────────

test('una secuencia sin nada generado contesta vacío, sin crear la carpeta', function () {
  // Abrir la pestaña no puede dejar carpetas nuevas al lado del proyecto del
  // editor: es una consulta de solo lectura.
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-corr-'));
  const proyecto = path.join(raiz, 'Clases.prproj');
  fs.writeFileSync(proyecto, 'x');

  const r = engine.listCorrections({ projectPath: proyecto, sequenceName: 'Clase nueva' });
  ok(r.ok);
  eq(r.markers.length, 0);
  eq(fs.existsSync(path.join(raiz, 'HyperPremiere')), false, 'no dejó rastro');
});

test('los archivos que no siguen la nomenclatura se ignoran', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 } });
  fs.writeFileSync(path.join(p.dir, 'transcript.json'), '{}');
  fs.writeFileSync(path.join(p.dir, 'notas del editor.html'), '<p>ojo</p>');

  eq(p.listar().markers.length, 1, 'solo lo versionado por la herramienta');
});

test('una ficha corrupta no tumba el listado', function () {
  const p = armarProyecto('Clase 14');
  p.version('Marcador 1', 1, { marker: { name: 'x', start: 1, duration: 3 } });
  fs.writeFileSync(path.join(p.dir, 'Marcador 1 v1.meta.json'), '{ esto no es json');

  const r = p.listar();
  ok(r.ok, 'sigue contestando');
  eq(r.markers[0].start, null, 'sin la ficha, el tramo se pide a mano');
});
