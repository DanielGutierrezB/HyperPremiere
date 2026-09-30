'use strict';

// HyperFrames contra Remotion, sobre los MISMOS marcadores.
//
// CONTRA EL MODELO Y EL RENDER DE VERDAD. No entra en `node test/run.js`: gasta
// cupo del proveedor configurado y tarda minutos por corrida.
//
//   node test/manual/motores-comparar.js
//   node test/manual/motores-comparar.js --n 3 --marcadores espejo,tres-formas
//   node test/manual/motores-comparar.js --solo remotion --fondo
//   node test/manual/motores-comparar.js --out /tmp/comparacion.md
//
// ── Por qué existe ───────────────────────────────────────────────────
//
// El pedido fue "revisá sus limitaciones, sus oportunidades, sus resultados en
// general". Eso no se contesta leyendo documentación: los dos motores reciben el
// MISMO contexto —mismo objetivo, mismo transcript, misma instrucción— y lo que
// cambia es el lenguaje en el que se les pide componer. Si uno tarda el doble o
// necesita más vueltas de la escalera de arreglos, se ve acá o no se ve.
//
// ── Qué mide, y por qué cada cosa ────────────────────────────────────
//
//   tiempo del MODELO    Lo que tarda en diseñar. Se mide aparte del render
//                        porque son dos trabajos distintos —la nube pensando vs.
//                        esta máquina capturando cuadros— y sumados no dicen
//                        nada útil: si un recurso tardó ocho minutos, la
//                        pregunta es si bajo el pensamiento o acorto el
//                        marcador, y para eso hay que saber cuál de los dos fue.
//   llamadas al modelo   Los peldaños de la escalera de arreglos (compose.js).
//                        Es el número que más importa y el más fácil de pasar
//                        por alto: un motor que "anda" pero necesita dos
//                        llamadas por marcador cuesta el doble y no falla nunca.
//                        1 = el modelo cumplió el contrato de una.
//   arreglos en código   Lo que el motor pudo completar sin gastar una llamada.
//                        Cero es lo ideal; muchos avisan que el contrato no se
//                        está entendiendo, aunque el resultado salga bien.
//   tiempo del RENDER    Capturar los cuadros y escribir el video.
//   tamaño del archivo   Dos ProRes 4444 de la misma duración tendrían que
//                        pesar parecido; una diferencia grande dice que uno está
//                        escribiendo otra cosa (otro perfil, otro submuestreo).
//   alpha                Lo pregunta ffprobe, no se supone. Es el modo de falla
//                        más callado de los dos motores: un .mov sin canal alfa
//                        se abre, se ve bien solo, y en Premiere tapa el video
//                        con un rectángulo negro. Nadie se entera hasta que el
//                        clip está en el timeline.
//   cuadros              La duración REAL del video en cuadros, contra la
//                        pedida. Un motor que escribe un video más corto (o una
//                        animación congelada del largo justo) pasa cualquier
//                        chequeo que solo mire que el archivo exista.
//
// ── Qué NO mide ──────────────────────────────────────────────────────
//
// Si la animación está LINDA. Eso se mira, y para eso el script deja los .mov y
// el código de cada corrida en la carpeta de salida, con sus nombres al lado en
// el reporte. Un puntaje automático de calidad visual sería inventar un número.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// La config del modelo vive en ~/.hyperpremiere. Acá NO se manda el HOME a un
// temporal —al revés que en los otros arneses—: este script necesita el
// proveedor que el editor tiene configurado de verdad, y la instalación de
// Remotion, que vive en esa misma carpeta y pesa 400 MB.

const motores = require('../../bridge/render');
const { composeAnimation } = require('../../bridge/compose');
const { getProvider } = require('../../bridge/providers');
const { buildUserPrompt } = require('../../bridge/prompt/build-context');
const engine = require('../../bridge/engine.js');

// ── Los marcadores de prueba ────────────────────────────────────────
//
// Tres, elegidos para que pidan cosas distintas y no tres veces la misma:
// un concepto con una palabra protagonista, una lista de tres que aparecen en
// orden, y un número que crece. Es el reparto de lo que el panel genera todos
// los días, y cada uno estresa otra parte del contrato: el tercero es el que
// obliga a interpolar contra el cuadro actual en vez de animar "algo".

const TRANSCRIPT = [
  { start: 0, end: 9, text: 'Bueno, arrancamos con el tema que más ruido hace y menos se entiende: el sesgo.' },
  { start: 9, end: 21, text: 'Cuando alguien dice "este modelo está sesgado", en general lo dice como si el modelo tuviera una opinión. Y no tiene ninguna.' },
  { start: 21, end: 34, text: 'Un modelo es un promedio muy sofisticado de lo que vio. Si lo que vio está torcido, el promedio sale torcido.' },
  { start: 34, end: 48, text: 'Les doy el caso clásico: un sistema de selección de personal entrenado con diez años de contrataciones de una empresa.' },
  { start: 48, end: 62, text: 'Si en esos diez años esa empresa contrató casi solo varones para los puestos técnicos, el modelo aprende que "técnico" y "varón" van juntos.' },
  { start: 62, end: 75, text: 'Nadie programó eso. Nadie escribió una regla. Salió del promedio.' },
  { start: 75, end: 90, text: 'Y acá está la parte incómoda: el modelo funciona bien. Predice con mucha precisión a quién habría contratado esa empresa. El problema es que esa empresa contrataba mal.' },
  { start: 90, end: 104, text: 'Entonces el sesgo no es un error del modelo. Es un espejo. Un espejo muy grande y muy rápido.' },
  { start: 104, end: 118, text: 'Vamos a ver tres formas en que esto aparece en productos que ustedes usan todos los días.' },
  { start: 118, end: 132, text: 'La primera es la de representación: qué aparece y qué no aparece cuando le pedís algo genérico.' },
  { start: 132, end: 147, text: 'La segunda es la de medición: qué decidiste contar como éxito, porque eso define hacia dónde empuja el sistema.' },
  { start: 147, end: 160, text: 'Y la tercera es la de despliegue: el modelo se entrenó en un contexto y se usa en otro completamente distinto.' },
  { start: 160, end: 174, text: 'Un dato para cerrar: en la auditoría que hicimos el año pasado, el 68% de los casos que encontramos eran de medición. No de datos. De medición.' },
];

const OBJETIVO =
  'Que el estudiante entienda que el sesgo de un modelo de IA no nace del modelo ' +
  'sino de los datos con los que se lo entrenó, y que pueda reconocer tres formas ' +
  'concretas en que ese sesgo aparece en un producto real.';

const ESTILO_DEL_CURSO =
  'Curso de ética en IA. Paleta oscura, acento ámbar. Tipografía sobria. ' +
  'Nada de iconos genéricos ni stock. Todos los recursos de la clase tienen que ' +
  'parecer parte de la misma familia visual.';

const MARCADORES = [
  {
    id: 'espejo',
    nombre: 'Marcador 12',
    start: 90, duration: 8.5,
    tramo: [
      { start: 90, end: 96, text: 'Entonces el sesgo no es un error del modelo. Es un espejo.' },
      { start: 96, end: 98.5, text: 'Un espejo muy grande y muy rápido.' },
    ],
    instruccion:
      'Quiero que quede clarísima la idea del espejo. Que la palabra "espejo" sea el ' +
      'protagonista y aparezca justo cuando la digo. Nada de dibujar un espejo literal.',
  },
  {
    id: 'tres-formas',
    nombre: 'Marcador 14',
    start: 118, duration: 12,
    tramo: [
      { start: 118, end: 132, text: 'La primera es la de representación: qué aparece y qué no aparece cuando le pedís algo genérico.' },
      { start: 132, end: 147, text: 'La segunda es la de medición: qué decidiste contar como éxito.' },
      { start: 147, end: 160, text: 'Y la tercera es la de despliegue: se entrenó en un contexto y se usa en otro.' },
    ],
    instruccion:
      'Las tres formas, una por una, entrando a medida que las nombro: representación, ' +
      'medición, despliegue. Que al final se vean las tres juntas.',
  },
  {
    id: 'sesenta-y-ocho',
    nombre: 'Marcador 17',
    start: 160, duration: 6,
    tramo: [
      { start: 160, end: 166, text: 'El 68% de los casos que encontramos eran de medición. No de datos. De medición.' },
    ],
    instruccion:
      'El 68% grande, contando desde cero hasta 68 mientras lo digo, y abajo ' +
      '"casos de medición". Que el número sea lo único que se mueva.',
  },
];

// ── ffprobe: lo que el archivo dice de sí mismo ─────────────────────

function correr(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => resolve({ code: -1, out: '', err: 'no se pudo ejecutar ' + cmd }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

/**
 * Qué escribió de verdad el render: formato de píxel, cuadros y tamaño.
 *
 * Se le pregunta a ffprobe y no se deduce de lo que el motor dijo que iba a
 * hacer. La diferencia importó de entrada: en Remotion, el ProRes con alfa
 * necesita CUATRO ajustes juntos (codec prores, perfil 4444, imageFormat png y
 * pixelFormat yuva444p10le) y con el imageFormat por defecto el alfa se pierde
 * EN SILENCIO — el archivo sale, pesa lo que tiene que pesar, y el canal no
 * está. Mirar el pix_fmt es la única forma de saberlo sin abrir Premiere.
 *
 * `nb_read_frames` cuenta los cuadros LEYÉNDOLOS, no confiando en la cabecera:
 * un contenedor puede declarar una duración que el contenido no tiene.
 */
async function inspeccionar(file) {
  const st = fs.statSync(file);
  const r = await correr('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=pix_fmt,codec_name,width,height,nb_read_frames,r_frame_rate',
    '-of', 'default=nw=1', file,
  ]);
  const campo = (k) => {
    const m = r.out.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].trim() : '';
  };
  const pix = campo('pix_fmt');
  return {
    mb: st.size / 1024 / 1024,
    codec: campo('codec_name'),
    pix: pix,
    ancho: parseInt(campo('width'), 10) || 0,
    alto: parseInt(campo('height'), 10) || 0,
    cuadros: parseInt(campo('nb_read_frames'), 10) || 0,
    // Los formatos con alfa de ffmpeg se nombran todos igual: una `a` en el
    // medio (yuva444p10le) o el sufijo de los RGB (rgba, argb). Preguntar por la
    // lista exacta de nombres sería tener que ampliarla cada vez que un motor
    // elija otro perfil; el patrón es estable desde que ffmpeg existe.
    alpha: /^(yuva|argb|rgba|abgr|bgra)|a(?:64)?le$|yuva/.test(pix),
    ffprobe: r.code === 0 ? '' : (r.err.trim() || 'ffprobe no contestó'),
  };
}

// ── Una corrida: un marcador con un motor, de punta a punta ─────────

async function unaCorrida(motor, marcador, opts) {
  const durationSec = marcador.duration;
  const res = {
    motor: motor.id, marcador: marcador.id,
    modelSeg: 0, renderSeg: 0, llamadas: 0, arreglos: [],
    error: '', archivo: '', codigo: '',
  };

  const userPrompt = buildUserPrompt({
    motor: motor,
    objective: OBJETIVO,
    transcriptSegments: TRANSCRIPT,
    marker: {
      name: marcador.nombre, start: marcador.start,
      end: marcador.start + durationSec, duration: durationSec,
    },
    markerTranscript: marcador.tramo,
    instruction: marcador.instruccion,
    generalInstruction: ESTILO_DEL_CURSO,
    sequenceInstruction: '',
    stillsCount: 0,
  }) + (opts.fondo ? motor.bloqueDeFondo() : '');

  const cfg = engine.loadConfig();
  const t0 = Date.now();
  let html;
  try {
    const r = await composeAnimation({
      provider: getProvider(cfg.provider),
      config: Object.assign({}, cfg, { motor: motor }),
      motor: motor,
      systemPrompt: motor.systemPrompt(),
      userPrompt: userPrompt,
      images: [],
      durationSec: durationSec,
      markerSlug: marcador.id,
      report: function (p) {
        if (p && p.note) res.arreglos.push(p.note);
      },
    });
    html = r.html;
    res.llamadas = (r.usage && r.usage.calls) || 0;
  } catch (e) {
    res.modelSeg = (Date.now() - t0) / 1000;
    // Un error de la escalera trae el código pagado cuando lo hay: se guarda
    // igual, que es lo único con lo que se puede ver QUÉ contestó el modelo.
    res.error = 'modelo: ' + ((e && e.message) || e).split('\n')[0];
    res.llamadas = (e && e.usage && e.usage.calls) || 0;
    if (e && e.html) res.codigo = guardar(opts.salida, motor, marcador, e.html);
    return res;
  }
  res.modelSeg = (Date.now() - t0) / 1000;
  res.codigo = guardar(opts.salida, motor, marcador, html);

  const ext = opts.fondo ? 'mp4' : 'mov';
  const out = path.join(opts.salida, marcador.id + ' [' + motor.id + '].' + ext);
  const t1 = Date.now();
  try {
    await motor.renderizar({
      code: html, outPath: out, durationSec: durationSec,
      format: ext, onProgress: function () {},
    });
  } catch (e) {
    res.renderSeg = (Date.now() - t1) / 1000;
    res.error = 'render: ' + ((e && e.message) || e).split('\n')[0];
    return res;
  }
  res.renderSeg = (Date.now() - t1) / 1000;
  res.archivo = out;
  res.video = await inspeccionar(out);
  res.cuadrosEsperados = Math.round(durationSec * 30);
  return res;
}

function guardar(salida, motor, marcador, code) {
  const file = path.join(salida, marcador.id + ' [' + motor.id + ']' + motor.lenguaje.ext);
  fs.writeFileSync(file, code, 'utf8');
  return file;
}

// ── El reporte ──────────────────────────────────────────────────────

function fmt(n, dec) {
  return Number(n).toFixed(dec === undefined ? 1 : dec);
}

/** Cómo salió UNA corrida, en un renglón. */
function renglon(r) {
  if (r.error) return '  ✗ ' + r.error;
  const v = r.video || {};
  const problemas = [];
  if (!r.archivo) problemas.push('sin video');
  else {
    if (v.ffprobe) problemas.push('ffprobe: ' + v.ffprobe);
    // El alfa solo se exige cuando se pidió sin fondo: un mp4 opaco no lo tiene
    // que tener, y marcarlo como falta sería un falso positivo por diseño.
    if (r.esperaAlpha && !v.alpha) problemas.push('SIN ALPHA (pix_fmt=' + v.pix + ')');
    if (v.cuadros && Math.abs(v.cuadros - r.cuadrosEsperados) > 2) {
      problemas.push(v.cuadros + ' cuadros en vez de ' + r.cuadrosEsperados);
    }
    if (v.ancho && (v.ancho !== 1920 || v.alto !== 1080)) {
      problemas.push(v.ancho + '×' + v.alto + ' en vez de 1920×1080');
    }
  }
  return '  modelo ' + fmt(r.modelSeg) + 's (' + r.llamadas + ' llamada' +
    (r.llamadas === 1 ? '' : 's') + ')' +
    ' · render ' + fmt(r.renderSeg) + 's' +
    ' · ' + fmt(v.mb) + ' MB · ' + v.codec + '/' + v.pix +
    ' · ' + v.cuadros + ' cuadros' +
    (r.arreglos.length ? '\n  arreglos: ' + r.arreglos.join(' | ') : '') +
    (problemas.length ? '\n  ⚠ ' + problemas.join(' · ') : '');
}

/** El promedio de un campo entre las corridas que llegaron al final. */
function promedio(lista, campo) {
  const buenas = lista.filter((r) => !r.error);
  if (!buenas.length) return null;
  let suma = 0;
  buenas.forEach((r) => { suma += Number(campo(r)) || 0; });
  return suma / buenas.length;
}

function tabla(porMotor) {
  const ids = Object.keys(porMotor);
  const filas = [
    ['', 'recursos OK', 'modelo (s)', 'llamadas', 'render (s)', 'MB', 'alpha'],
  ];
  ids.forEach((id) => {
    const lista = porMotor[id];
    const ok = lista.filter((r) => !r.error && r.archivo);
    const conAlpha = ok.filter((r) => r.video && r.video.alpha).length;
    filas.push([
      motores.motor(id).nombre,
      ok.length + '/' + lista.length,
      promedio(lista, (r) => r.modelSeg) === null ? '—' : fmt(promedio(lista, (r) => r.modelSeg)),
      promedio(lista, (r) => r.llamadas) === null ? '—' : fmt(promedio(lista, (r) => r.llamadas), 2),
      promedio(lista, (r) => r.renderSeg) === null ? '—' : fmt(promedio(lista, (r) => r.renderSeg)),
      promedio(lista, (r) => (r.video || {}).mb) === null ? '—' : fmt(promedio(lista, (r) => (r.video || {}).mb)),
      conAlpha + '/' + ok.length,
    ]);
  });
  const ancho = filas[0].map((_, i) => Math.max.apply(null, filas.map((f) => String(f[i]).length)));
  return filas.map((f, fi) => {
    const linea = '| ' + f.map((c, i) => String(c).padEnd(ancho[i])).join(' | ') + ' |';
    if (fi !== 0) return linea;
    return linea + '\n|' + ancho.map((a) => '-'.repeat(a + 2)).join('|') + '|';
  }).join('\n');
}

// ── Main ────────────────────────────────────────────────────────────

function arg(nombre, def) {
  const i = process.argv.indexOf('--' + nombre);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

(async function () {
  const opts = {
    n: parseInt(arg('n', '1'), 10) || 1,
    solo: arg('solo', ''),
    fondo: arg('fondo', false) === true,
    salida: arg('out-dir', fs.mkdtempSync(path.join(os.tmpdir(), 'hp-motores-'))),
    reporte: arg('out', ''),
  };
  fs.mkdirSync(opts.salida, { recursive: true });

  const pedidos = String(arg('marcadores', '')).split(',').map((s) => s.trim()).filter(Boolean);
  const cuales = pedidos.length
    ? MARCADORES.filter((m) => pedidos.indexOf(m.id) !== -1)
    : MARCADORES;
  if (!cuales.length) {
    console.error('No conozco esos marcadores. Los que hay: ' + MARCADORES.map((m) => m.id).join(', '));
    process.exitCode = 1;
    return;
  }

  const ids = opts.solo ? [opts.solo] : motores.ids();
  // Un motor que no está instalado se salta ANTES de gastar la primera llamada
  // al modelo: si no, se pagan tres diseños y los tres se caen en el render.
  const usables = [];
  for (const id of ids) {
    if (!motores.existe(id)) { console.error('No conozco el motor "' + id + '".'); continue; }
    const m = motores.motor(id);
    const st = m.estado ? m.estado() : { instalado: true, motivo: '' };
    if (st.instalado) usables.push(m);
    else console.error('Salteo ' + m.nombre + ': ' + st.motivo);
  }
  if (!usables.length) {
    console.error('Ningún motor instalado: no hay nada que comparar.');
    process.exitCode = 1;
    return;
  }

  const cfg = engine.loadConfig();
  console.log('Comparación de motores de animación');
  console.log('  proveedor:  ' + cfg.provider + ' · modelo ' + (cfg.model || '(el que elija el proveedor)'));
  console.log('  motores:    ' + usables.map((m) => m.nombre).join('  vs  '));
  console.log('  marcadores: ' + cuales.map((m) => m.id + ' (' + m.duration + 's)').join(', '));
  console.log('  corridas:   ' + opts.n + ' por marcador y motor = ' +
    opts.n * cuales.length * usables.length + ' llamadas al modelo + otros tantos renders');
  console.log('  salida:     ' + (opts.fondo ? 'mp4 con fondo' : 'mov con alpha') + ' en ' + opts.salida);
  console.log('');

  const porMotor = {};
  usables.forEach((m) => { porMotor[m.id] = []; });

  // Los motores se ALTERNAN por marcador, no se corre una tanda entera y después
  // la otra: el backend del proveedor rinde distinto según la hora y la carga, y
  // dos tandas separadas medirían eso además del motor. Es la misma precaución
  // que toma cursor-contrato.js, y por el mismo motivo.
  for (let vuelta = 1; vuelta <= opts.n; vuelta++) {
    for (const marcador of cuales) {
      for (const m of usables) {
        const etiqueta = marcador.id + ' · ' + m.nombre +
          (opts.n > 1 ? ' · vuelta ' + vuelta + '/' + opts.n : '');
        console.log(etiqueta);
        const r = await unaCorrida(m, marcador, opts);
        r.esperaAlpha = !opts.fondo;
        porMotor[m.id].push(r);
        console.log(renglon(r));
        console.log('');
      }
    }
  }

  const lineas = [];
  lineas.push('# HyperFrames vs Remotion');
  lineas.push('');
  lineas.push('Proveedor `' + cfg.provider + '`, modelo `' + (cfg.model || '—') + '`. ' +
    opts.n + ' vuelta(s) sobre ' + cuales.length + ' marcador(es), ' +
    (opts.fondo ? 'mp4 con fondo' : 'mov con alpha') + '.');
  lineas.push('');
  lineas.push(tabla(porMotor));
  lineas.push('');
  lineas.push('Promedios sobre las corridas que llegaron al final. ' +
    '`llamadas` son los peldaños de la escalera de arreglos: 1 = el modelo cumplió el contrato de una.');
  lineas.push('');
  lineas.push('## Corrida por corrida');
  usables.forEach((m) => {
    lineas.push('');
    lineas.push('### ' + m.nombre);
    porMotor[m.id].forEach((r) => {
      lineas.push('');
      lineas.push('**' + r.marcador + '** — ' + renglon(r).trim().replace(/\n\s*/g, '  \n'));
      if (r.codigo) lineas.push('');
      if (r.codigo) lineas.push('Código: `' + path.basename(r.codigo) + '`' +
        (r.archivo ? ' · video: `' + path.basename(r.archivo) + '`' : ''));
    });
  });
  lineas.push('');
  lineas.push('Los archivos quedaron en `' + opts.salida + '`. Miralos: esto no puntúa el diseño.');
  const md = lineas.join('\n') + '\n';

  if (opts.reporte) {
    fs.writeFileSync(opts.reporte, md, 'utf8');
    console.log('Reporte en ' + opts.reporte);
  } else {
    console.log(md);
  }
})().catch(function (e) {
  console.error('\n  FALLÓ: ' + ((e && e.stack) || e));
  process.exitCode = 1;
});
