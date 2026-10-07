// LAS VERSIONES DE UN MARCADOR: abrirlas, mirarlas, renderizarlas.
//
// ── Por qué es su propio módulo ──────────────────────────────────────
//
// Todo esto vivía en `engine.js`, en un bloque contiguo de 330 líneas, y era la
// única parte de ese archivo que ya era un módulo esperando el corte: las nueve
// funciones contestan la MISMA pregunta —dada una versión de un marcador, qué se
// puede hacer con ella— y ninguna la comparte con el resto del orquestador.
//
// El corte se hizo cuando agregar el segundo motor de animación le sumó a ese
// bloque cinco funciones más. Un archivo de 3149 líneas creciendo justo donde
// más fácil era partirlo es la señal, no el tamaño en sí.
//
// ── Qué NO está acá ──────────────────────────────────────────────────
//
// Generar. Pedirle una composición al modelo es otra cosa: necesita el
// transcript, los tres niveles del prompt, las referencias, la cola y el
// contador de tokens, y sigue en `engine.js` porque de verdad es orquestación.
// Acá está lo que se hace con lo que YA está en disco.
//
// El motor de cada versión sale siempre de su ficha, nunca del selector de ⚙ ni
// de la extensión del archivo (ver `composicionDeVersion` en store/project-fs.js
// y `motorDeFicha` en render/motores.js). Ésa es la regla que hace que un
// recurso hecho la semana pasada se siga abriendo y re-renderizando igual.

'use strict';

const fs = require('fs');
const path = require('path');

const motores = require('./render');
const abrir = require('./abrir-archivo');
const {
  slugify, ensureOutputDir, outputDirPath, paths, readMeta,
  writeVersionMeta, mergeVersionMeta, composicionDeVersion,
} = require('./store/project-fs');
const { versionFile, nextVersion, listVersions } = require('./store/versions');

/**
 * El encargo del recurso según la versión anterior. Lo usa el render de un HTML
 * editado a mano, que no trae instrucción propia: sin esto, la ficha nueva
 * quedaba sin el encargo y la corrección siguiente salía sin él.
 */
function inheritedInstruction(baseDir, markerSlug, version) {
  for (let v = version - 1; v >= 1; v--) {
    const p = versionFile(baseDir, markerSlug, v, '.meta.json');
    const meta = p ? readMeta(p) : null;
    const txt = meta && typeof meta.instruction === 'string' ? meta.instruction.trim() : '';
    if (txt && txt !== '(edición manual)') return txt;
  }
  return '';
}

// Historia acumulada de instrucciones: lee la meta de la versión anterior y
// devuelve su history + su propia entrada. [] para v1 o si no hay meta previa.
function buildHistory(baseDir, markerSlug, version) {
  if (!(version > 1)) return [];
  const prevMetaPath = versionFile(baseDir, markerSlug, version - 1, '.meta.json');
  const prevMeta = prevMetaPath ? readMeta(prevMetaPath) : null;
  if (!prevMeta) return [];
  const history = Array.isArray(prevMeta.history) ? prevMeta.history.slice() : [];
  history.push({ version: prevMeta.version, instruction: prevMeta.instruction, createdAt: prevMeta.createdAt });
  return history;
}

// Lista las versiones ya generadas de un marcador (escaneo del baseDir).
// Devuelve { ok, versions: [{ version, model, engine }] } ordenado por versión.
//
// El motor va por versión porque de él depende qué se le ofrece al editor: una
// ficha cuya última versión es de Remotion muestra «Abrir Remotion». Sale de la
// ficha de cada versión, como en todo el panel, y no de la extensión.
function listMarkerVersions(body) {
  try {
    body = body || {};
    const markerSlug = String(body.markerSlug || '').trim();
    if (!markerSlug) return { ok: false, error: 'falta markerSlug', versions: [] };
    // Escaneo, no escritura: una tarjeta de marcador la pide al dibujarse, antes
    // de que ese marcador haya generado nada. Sin carpeta la lista es vacía, que
    // es la misma respuesta que daba con la carpeta recién creada.
    const baseDir = outputDirPath(body.projectPath, body.sequenceName);
    const versions = listVersions(baseDir, markerSlug, motores.extensiones()).map((v) => {
      const metaPath = versionFile(baseDir, markerSlug, v.version, '.meta.json');
      return Object.assign({}, v, { engine: motores.motorDeFicha(metaPath ? readMeta(metaPath) : null).id });
    });
    return { ok: true, versions: versions };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), versions: [] };
  }
}

/**
 * Guarda a mano el tramo de un recurso al que le falta la ficha, para no
 * volver a preguntarlo. Se escribe sobre la meta de la última versión.
 */
function saveCorrectionPosition(body) {
  try {
    body = body || {};
    const markerSlug = String(body.markerSlug || '').trim();
    const start = Number(body.start);
    const duration = Number(body.duration);
    if (!markerSlug) return { ok: false, error: 'falta markerSlug' };
    if (!(duration > 0)) return { ok: false, error: 'la duración tiene que ser mayor a 0' };
    if (!(start >= 0)) return { ok: false, error: 'el segundo de entrada no puede ser negativo' };

    const baseDir = outputDirPath(body.projectPath, body.sequenceName);
    const versions = listVersions(baseDir, markerSlug, motores.extensiones());
    if (!versions.length) return { ok: false, error: 'no hay versiones de ' + markerSlug };
    const version = versions[versions.length - 1].version;
    const metaPath = versionFile(baseDir, markerSlug, version, '.meta.json') ||
      paths(baseDir, markerSlug, version, versions[versions.length - 1].model).meta;
    const prev = readMeta(metaPath) || {};
    const marker = Object.assign({}, prev.marker, {
      name: prev.markerName || (prev.marker || {}).name || markerSlug,
      start, duration, end: start + duration,
    });
    // Merge y no reescritura: contestar dónde iba no puede llevarse puesto con
    // qué contexto se generó, ni el encargo, ni la historia de versiones.
    mergeVersionMeta(metaPath, { sequenceName: body.sequenceName, markerSlug, marker });
    return { ok: true, version, start, duration };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * El código de una versión concreta de un marcador, para el editor del panel.
 *
 * Devuelve además el MOTOR: de eso depende con qué lo resalta Prism y con qué
 * se va a renderizar cuando el editor le dé a guardar. Sin ese dato el panel
 * tendría que adivinarlo de la extensión, que es la única otra pista que tiene.
 */
function readMarkerHtml(body) {
  try {
    body = body || {};
    const markerSlug = String(body.markerSlug || '').trim();
    const version = parseInt(body.version, 10);
    if (!markerSlug || !version) return { ok: false, error: 'faltan markerSlug/version' };
    // Abrir una composición ya guardada: si la carpeta no está, no hay versión
    // que abrir.
    const baseDir = outputDirPath(body.projectPath, body.sequenceName);
    const c = composicionDeVersion(baseDir, markerSlug, version);
    if (!c) return { ok: false, error: 'no se encontró la versión ' + version };
    return {
      ok: true, html: c.code, version,
      engine: c.motor.id, lenguaje: c.motor.lenguaje.prism,
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * Abre la VISTA PREVIA de una composición: reproducirla en vivo, sin renderizar.
 *
 * Es la respuesta a "¿puedo ver esto antes de pagar un render?". Hasta acá la
 * única forma de mirar una animación era renderizarla —ocho segundos por
 * mirada, y otros ocho si el timing no cerraba—. Lo que se abre es un
 * reproductor con timeline: se scrubea, se pone en loop, se marca un tramo.
 *
 * Abrirla NO renderiza, NO llama al modelo y NO escribe una versión. Lo que sí
 * puede escribir una es el botón Render de Studio, después (ver
 * `guardarRenderDeStudio`).
 *
 * Si `code` viene en el cuerpo, se mira ESO y no lo que hay en disco: es lo que
 * convierte al editor de código y a la ventana de vista previa en un par
 * —editás, apretás vista previa, y lo que estaba en pantalla cambia— sin tener
 * que guardar una versión por cada mirada.
 *
 * Con `abrirArchivo`, además, el archivo que muestra la vista previa —en
 * Remotion, el `.tsx` del marcador— se abre con el editor del sistema: es lo
 * que hace «Abrir Remotion» de la ficha.
 *
 * No todos los motores pueden: HyperFrames pide su timeline PAUSADA para que el
 * capturador la posicione cuadro por cuadro, así que abrir ese HTML muestra el
 * primer cuadro y nada más. Cuando el motor no la ofrece se dice CON el motivo,
 * porque "no se puede" a secas suena a que algo está roto.
 */
async function previewComposition(body) {
  try {
    body = body || {};
    const markerSlug = String(body.markerSlug || '').trim();
    const version = parseInt(body.version, 10);
    if (!markerSlug) return { ok: false, error: 'falta markerSlug' };

    const baseDir = outputDirPath(body.projectPath, body.sequenceName);
    const enDisco = version ? composicionDeVersion(baseDir, markerSlug, version) : null;
    // El código puede venir del editor sin guardar; el MOTOR siempre sale de la
    // ficha, que es el único lugar donde está declarado. Sin versión en disco
    // —previsualizar algo recién pegado— manda el que diga el cuerpo.
    const motor = enDisco ? enDisco.motor : motores.motor(body.engine);

    // El motivo lo escribe el MOTOR y acá se relaya sin saber qué dice. La regla
    // queda legible de un lado y del otro: un motor tiene vista previa, o tiene
    // un motivo por escrito.
    if (!motor.vistaPrevia) {
      return {
        ok: false, engine: motor.id,
        error: motor.nombre + ' no tiene vista previa: ' + motor.motivoSinVistaPrevia,
      };
    }

    const delEditor = String(body.code || '').trim();
    const code = delEditor || (enDisco ? enDisco.code : '');
    if (!code) return { ok: false, error: 'no encontré la versión ' + (version || '') + ' para previsualizar' };
    // El editor del panel manda lo que tiene SIEMPRE, aunque sea la versión tal
    // cual la abrió. Solo cuenta como pedido explícito si es otra cosa: si no,
    // mirar la versión desde el editor del panel le pisaría al archivo de Studio
    // los cambios que el editor le hizo en su editor (ver remotion-editables.js).
    const explicito = !!delEditor && !(enDisco && delEditor === String(enDisco.code || '').trim());

    // La duración: la del marcador si el panel la manda (es la verdad de
    // Premiere), y si no la que anotó la ficha de esa versión. Sin ninguna de
    // las dos no hay vista previa posible: es el largo de la composición.
    const ficha = enDisco ? enDisco.ficha : {};
    const durationSec = Number((body.marker || {}).duration) ||
      Number((ficha.marker || {}).duration) || 0;
    if (!(durationSec > 0)) {
      return { ok: false, error: 'no sé cuánto dura este marcador, así que no puedo armar la vista previa' };
    }
    // Con fondo se ve opaco y sin fondo con el damero de transparencia, igual
    // que saldría el render: mirar un clip con alfa sobre negro esconde
    // justamente los problemas de contraste que el alfa vuelve a traer.
    const conFondo = body.background !== undefined
      ? body.background === true
      : ficha.background === true;

    // Qué se está mirando. Dice "editado" cuando el código vino del editor y no
    // del disco, porque son dos cosas distintas y la ventana es la misma: sin
    // eso, un editor que probó un cambio y no lo guardó no tiene manera de saber
    // si está mirando su cambio o la versión de antes.
    const etiqueta = markerSlug + (version ? ' v' + version : '') +
      (String(body.code || '').trim() ? ' (editado, sin guardar)' : '');
    // Dónde iba: lo que mande el panel (el marcador de Premiere hoy) y, si no lo
    // trae, lo que anotó la ficha. Hace falta para colocar el render de Studio
    // si el clip ya no está en la secuencia.
    const marker = Object.assign({}, ficha.marker || {}, body.marker || {});
    const r = await motor.vistaPrevia({
      code: code,
      explicito: explicito,
      durationSec: durationSec,
      format: conFondo ? 'mp4' : 'mov',
      etiqueta: etiqueta,
      // A qué clip va lo que se renderice desde la vista previa (el botón
      // Render de Studio): este marcador, con ESTE código —el del editor si vino
      // de ahí—, que es el que se va a guardar como versión.
      destino: {
        projectPath: body.projectPath, sequenceName: body.sequenceName,
        markerSlug: markerSlug, version: version || 0, etiqueta: etiqueta,
        marker: {
          name: marker.name || markerSlug,
          start: Number(marker.start) || 0,
          duration: durationSec,
        },
        background: conFondo, code: code,
        // Dónde va el clip si no hay ninguno que reemplazar, cuando no es la
        // secuencia de la carpeta: una corrección de una clase re-cortada
        // guarda las versiones en el corte de origen y coloca en el abierto.
        colocarEn: String(body.colocarEn || ''),
      },
      assetsDir: path.join(baseDir, '_assets', markerSlug),
      alTerminar: guardarRenderDeStudio,
    });
    // No poder abrir el archivo no deshace lo demás: Studio ya está abierto, y
    // el panel dice dónde está el archivo para abrirlo a mano.
    const editor = body.abrirArchivo && r && r.archivo ? await abrir.abrirArchivo(r.archivo) : null;
    return Object.assign({ ok: true, engine: motor.id }, r, { editor: editor });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * Un render hecho con el botón Render de Studio, guardado como VERSIÓN NUEVA
 * del marcador al que pertenece.
 *
 * Versión nueva y no pisar la anterior, por tres motivos: en Windows Premiere
 * tiene abierto el archivo del clip y no deja reescribirlo; la versión de antes
 * sigue en disco por si el render nuevo salió peor; y la versión nueva guarda
 * el código que Studio renderizó —lo que tenía el archivo del marcador cuando
 * arrancó el render, con lo que el editor le haya cambiado—, así que la próxima
 * corrección parte de lo que de verdad está en la secuencia.
 *
 * Devuelve lo que el panel necesita para reemplazar el clip en Premiere: el
 * archivo nuevo y los de las versiones anteriores, de la más nueva a la más
 * vieja (reemplaza la más nueva que encuentre puesta).
 *
 * @param {{archivo:string, destino:object, codigo?:string}} r — lo que manda
 *   remotion-studio.js. Sin `codigo` (no se pudo leer el archivo), el que se
 *   mostró al abrir.
 */
function guardarRenderDeStudio(r) {
  const archivo = r && r.archivo;
  const destino = (r && r.destino) || {};
  let st = null;
  try { st = fs.statSync(archivo); } catch (e) { st = null; }
  if (!st || !st.size) throw new Error('Studio dijo que terminó, pero no encuentro el video en ' + archivo);
  const ext = path.extname(archivo).slice(1).toLowerCase();
  if (ext !== 'mov' && ext !== 'mp4') {
    throw new Error('Studio renderizó un .' + ext + ', y Premiere necesita el clip en ProRes (.mov) o ' +
      'H.264 (.mp4). Volvé a renderizar dejando el formato que trae por defecto.');
  }

  const markerSlug = destino.markerSlug;
  const baseDir = ensureOutputDir(destino.projectPath, destino.sequenceName);
  const anteriores = listVersions(baseDir, markerSlug, ['.mov', '.mp4'])
    .reverse()
    .map((v) => path.join(baseDir, v.name));
  const version = nextVersion(baseDir, markerSlug);
  const motor = motores.motor('remotion');
  const outPaths = paths(baseDir, markerSlug, version, 'studio', ext, motor.lenguaje.ext);
  fs.copyFileSync(archivo, outPaths.mov);
  const codigo = r && typeof r.codigo === 'string' ? r.codigo : String(destino.code || '');
  fs.writeFileSync(outPaths.code, codigo, 'utf8');
  writeVersionMeta(outPaths.meta, {
    sequenceName: destino.sequenceName, markerSlug: markerSlug, marker: destino.marker,
    version: version, model: 'studio', provider: 'remotion-studio', mode: 'studio-render',
    engine: motor.id,
    instruction: inheritedInstruction(baseDir, markerSlug, version) || '(render de Remotion Studio)',
    background: !!destino.background, format: ext,
    createdAt: new Date().toISOString(),
    // Sin IA de por medio; el render lo pagó Studio, y su tiempo no llega acá.
    timings: { modelMs: 0, renderMs: 0 },
    history: buildHistory(baseDir, markerSlug, version),
  });
  return {
    projectPath: destino.projectPath, sequenceName: destino.sequenceName,
    colocarEn: destino.colocarEn || destino.sequenceName,
    markerSlug: markerSlug, version: version, desde: destino.version || 0,
    etiqueta: markerSlug + ' v' + version,
    archivo: outPaths.mov, anteriores: anteriores,
    marker: destino.marker, background: !!destino.background,
  };
}

/**
 * Lo que escucha el panel: cada render hecho desde la vista previa, ya guardado
 * como versión (`prog({ renderDeStudio })`), hasta que la vista previa se
 * cierre. Hay un solo oyente por vista previa (ver `escuchar` en
 * remotion-studio.js): suscribirse de nuevo suelta al anterior.
 */
function escucharRendersDeStudio(body, prog) {
  const avisar = typeof prog === 'function' ? prog : function () {};
  return motores.motor('remotion').escucharVistaPrevia(function (aviso) {
    avisar({ renderDeStudio: aviso });
  });
}

/**
 * Apaga la vista previa de todos los motores que tengan una.
 *
 * Lo llama el panel al cerrarse. No alcanza con el watchdog de inactividad de
 * media hora: cerrar Premiere y dejar un webpack en watch comiendo memoria es
 * exactamente la clase de cosa que se descubre una semana después.
 */
function closePreview() {
  // Sin `typeof` y sin try/catch por motor: el que no tiene vista previa
  // contesta `{ andaba: false }` desde el default de `registrar`, y un default
  // que no hace nada no puede tirar.
  const apagados = motores.ids()
    .filter((id) => motores.motor(id).cerrarVistaPrevia().andaba);
  return { ok: true, apagados };
}

// Renderiza una composición editada a mano por el editor como una NUEVA
// versión, SIN llamar al modelo. Se marca como [manual] en el nombre.
async function renderManualHtml(body, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  body = body || {};
  const { projectPath, sequenceName, marker } = body;
  if (!marker || typeof marker !== 'object') throw new Error('Falta "marker"');
  const durationSec = Number(marker.duration) || 0;
  if (durationSec <= 0) throw new Error('marker.duration debe ser > 0');
  // `code`, y `html` como respaldo: un trabajo encolado por un panel anterior a
  // la 1.7.0 quedó persistido en queue.json con el nombre viejo, y esos trabajos
  // tienen que poder seguir corriendo después de actualizar. Leer los dos es
  // toda la migración que hace falta — el campo es el mismo string.
  let cleanHtml = String(body.code || body.html || '').trim();
  const markerSlug = String(body.markerSlug || '').trim() || slugify(marker.name);
  // El motor de la versión que el editor ABRIÓ, que el panel devuelve con el
  // código (ver readMarkerHtml). Guardar a mano es seguir tocando esa versión,
  // no empezar una nueva: lo que hay en el editor está escrito en el lenguaje
  // de SU motor, y validarlo o renderizarlo con el otro no puede salir bien.
  const motor = motores.motor(body.engine);
  if (!cleanHtml) throw new Error('La composición está vacía');
  // Si lo que pegaron no es código, no hay nada que reparar ni que renderizar:
  // saldría un clip de la duración pedida en negro después de esperarlo. Suele
  // ser un copiar-pegar de la respuesta de un chat en vez de la composición. Se
  // pregunta ANTES de revisar el contrato: revisar prosa da un diagnóstico sobre
  // algo que no existe ("falta el export default" cuando no hay componente).
  if (!motor.esCodigo(cleanHtml)) {
    throw new Error('Lo que hay en el editor no es una composición de ' + motor.nombre + '.\n' +
      'Pegá ' + motor.lenguaje.comoSeLlama + ' completo de la composición, no el texto de una respuesta.');
  }
  // Acá no hay modelo al que volver: si al editar a mano se desalinea el id o se
  // pierde la duración, el render sale CONGELADO y sin explicación. Se completa
  // el andamiaje igual que en la generación, y se avisa en el log.
  const manual = motor.revisar(cleanHtml, { durationSec, markerSlug });
  cleanHtml = manual.code;
  if (manual.fixes.length) {
    report({ note: 'Edición manual: andamiaje completado en código · ' + manual.fixes.join(' · ') });
  }
  if (manual.problema) {
    report({
      note: 'OJO, esta edición manual puede renderizar congelada: ' +
        motor.textoDeProblema(manual.problema) + '.',
      level: 'WARN',
    });
  }

  const baseDir = ensureOutputDir(projectPath, sequenceName);
  const version = nextVersion(baseDir, markerSlug);
  // Con fondo => mp4 opaco; sin fondo => mov con alpha. Antes esto salía siempre
  // en mov: un recurso opaco cambiaba de formato al editarlo a mano.
  const withBackground = body.background === true;
  const videoExt = withBackground ? 'mp4' : 'mov';
  const outPaths = paths(baseDir, markerSlug, version, 'manual', videoExt, motor.lenguaje.ext);

  report({ pct: 20, msg: 'Guardando la edición…' });
  fs.writeFileSync(outPaths.code, cleanHtml, 'utf8');

  report({ pct: 40, msg: withBackground ? 'Renderizando video HD (con fondo)…' : 'Renderizando el video con alpha…' });
  const renderStartedAt = Date.now();
  await motor.renderizar({
    code: cleanHtml, outPath: outPaths.mov, durationSec, onProgress: report,
    format: videoExt,
    assetsDir: path.join(baseDir, '_assets', markerSlug),
  });

  writeVersionMeta(outPaths.meta, {
    sequenceName, markerSlug, marker,
    version, model: 'manual', provider: 'manual', mode: 'manual-edit',
    engine: motor.id,
    // La instrucción de la ficha es el ENCARGO del recurso, no lo último que se
    // le hizo: es lo que se le vuelve a mandar al modelo la próxima vez que se
    // corrija. Escribir acá "(edición manual)" borraba el encargo original, y a
    // partir de ahí las correcciones se pedían sin saber qué era ese gráfico.
    instruction: inheritedInstruction(baseDir, markerSlug, version) || '(edición manual)',
    // Los tres niveles del contexto NO van, y se dice acá en vez de dejarlo como
    // una ausencia que haya que notar: este render no llamó a ningún modelo, así
    // que no hay ningún prompt que haya recibido. Heredarlos de la versión
    // anterior —como se hereda el encargo— sería anotar como "lo que se le
    // mandó" algo que no se mandó nunca. Quien lea la ficha los sigue
    // encontrando: la búsqueda baja por las versiones anteriores y dice de cuál
    // los sacó (ver findMarkerPosition).
    prompts: undefined,
    background: withBackground, format: videoExt,
    createdAt: new Date(Date.now()).toISOString(),
    // Sin IA de por medio: acá el tiempo del modelo es cero de verdad.
    timings: { modelMs: 0, renderMs: Date.now() - renderStartedAt },
    history: buildHistory(baseDir, markerSlug, version),
  });

  return { ok: true, movPath: outPaths.mov, codePath: outPaths.code, version, markerSlug };
}

// Re-renderiza la ÚLTIMA versión de un marcador (la composición ya diseñada en
// disco) SIN volver a llamar a la IA: es el "reintentar render" de la cola, para
// cuando el modelo ya había terminado y lo que falló fue el render. Si el video
// no llegó a escribirse, usa la ruta nueva de esa versión.
async function rerenderLatest(body, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  body = body || {};
  const markerSlug = String(body.markerSlug || '').trim();
  if (!markerSlug) throw new Error('re-render: falta markerSlug');
  const durationSec = Number((body.marker || {}).duration) || 0;
  if (durationSec <= 0) throw new Error('re-render: marker.duration debe ser > 0');

  // Re-render lee antes de escribir, y lo que lee decide si hay algo que hacer:
  // sin composición previa esto se corta acá, y crear la carpeta para después
  // tirar dejaba un directorio vacío por un reintento imposible. El video sí se
  // escribe adentro, pero ahí la carpeta ya existe —de ella salió el código— y
  // el render crea la del archivo de salida igual.
  const baseDir = outputDirPath(body.projectPath, body.sequenceName);
  const versions = listVersions(baseDir, markerSlug, motores.extensiones());
  if (!versions.length) throw new Error('No hay versiones para re-renderizar de ' + markerSlug);
  const latest = versions[versions.length - 1];
  // El motor con el que NACIÓ esta versión, no el de ⚙. Re-renderizar es volver
  // a capturar un código que ya está escrito: el selector no lo reinterpreta.
  const previa = composicionDeVersion(baseDir, markerSlug, latest.version);
  if (!previa || !previa.code) {
    throw new Error('La composición de la última versión (v' + latest.version + ') no se pudo leer');
  }
  const motor = previa.motor;

  const withBackground = body.background === true;
  const videoExt = withBackground ? 'mp4' : 'mov';
  // Video existente de esa versión, tolerando que la extensión haya cambiado.
  let movPath = versionFile(baseDir, markerSlug, latest.version, '.' + videoExt) ||
    versionFile(baseDir, markerSlug, latest.version, '.mov') ||
    versionFile(baseDir, markerSlug, latest.version, '.mp4');
  if (!movPath) movPath = paths(baseDir, markerSlug, latest.version, latest.model || 'x', videoExt).mov;

  report({ pct: 30, msg: 'Re-render de v' + latest.version + ' (sin re-diseñar)…' });
  await motor.renderizar({
    code: previa.code, outPath: movPath, durationSec, onProgress: report, format: videoExt,
    assetsDir: path.join(baseDir, '_assets', markerSlug),
  });
  return { ok: true, movPath, codePath: previa.file, version: latest.version, markerSlug, background: withBackground };
}

module.exports = {
  // Qué versiones hay y dónde iba el recurso.
  listMarkerVersions,
  saveCorrectionPosition,
  // Abrir una versión en el editor del panel, y mirarla sin renderizarla.
  readMarkerHtml,
  previewComposition,
  closePreview,
  // Y lo que se renderiza DESDE esa vista previa (el botón Render de Studio).
  escucharRendersDeStudio,
  guardarRenderDeStudio,
  // Renderizar: lo editado a mano, o de nuevo lo que ya estaba.
  renderManualHtml,
  rerenderLatest,
  // Lo que una versión hereda de la anterior. Lo usa además `renderPrepared`,
  // en engine.js, cuando termina de escribir la ficha de una generación.
  inheritedInstruction,
  buildHistory,
};
