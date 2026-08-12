'use strict';

// ¿Sirve de verdad repetir el contrato al final del prompt de Cursor?
//
// CONTRA EL CLI DE VERDAD. No entra en `node test/run.js`: gasta cupo de la
// suscripción de Cursor, necesita sesión iniciada y tarda minutos por corrida.
//
//   node test/manual/cursor-contrato.js --n 8
//   node test/manual/cursor-contrato.js --n 4 --modelo composer-2.5 --paralelo 2
//   node test/manual/cursor-contrato.js --n 6 --continuidad /ruta/a/una-composicion.html
//
// EL CASO FÁCIL Y EL CASO DIFÍCIL
// `build-context.js` ya cierra el pedido con "## Contrato obligatorio (verificá
// antes de responder)". Cuando el marcador es simple, eso queda ÚLTIMO y el
// modelo cumple: 11 de 11 corridas base impecables en cuatro modelos distintos.
// El contrato se entierra recién cuando engine.js agrega secciones DESPUÉS: los
// assets, los recursos del editor, el fondo y sobre todo la continuidad, que
// mete el HTML entero de otros marcadores (hasta 12.000 caracteres).
//
// Por eso la medición que dice algo es la del caso difícil: `--continuidad`
// agrega un bloque como el que arma engine.js, con una composición previa de
// verdad. Para conseguir una, corré el banco una vez sin esa opción y usá
// cualquiera de los HTML que deja en la carpeta de salidas.
//
// POR QUÉ EXISTE
// `cursor-agent` no tiene canal de system prompt, así que la PLANTILLA
// OBLIGATORIA viaja adentro del mensaje de usuario — la misma forma degradada
// que en Windows hacía que el CLI de Claude devolviera composiciones sin el
// `<div id="stage">`. La respuesta fue reacomodar el mensaje y repetir el
// andamiaje, corto y tajante, al final. Eso es una hipótesis sobre cómo lee un
// modelo, y una hipótesis sobre un modelo se mide, no se argumenta.
//
// QUÉ MIDE
// Cuántas composiciones cumplen el contrato SIN AYUDA. "Sin ayuda" es
// importante: `inspectComposition()` repara mucho en código (adopta la raíz
// cuando no hay dudas, completa data-*, alinea el registro), así que una
// composición puede terminar renderizable sin que el modelo haya cumplido
// nada. Lo que se cuenta acá es si el modelo cumple solo:
//
//   cumpleSolo = problem === null  Y  no hubo que adoptarle la raíz
//
// Se reporta también "impecable" (ni un solo arreglo), que es más exigente, y
// el desglose de qué faltó en cada corrida.
//
// CÓMO EVITA ENGAÑARSE
// Las dos variantes (con recordatorio y sin) corren INTERCALADAS, no una tanda
// y después la otra: el backend de Cursor rinde distinto según la hora y la
// carga, y dos tandas separadas medirían eso además del prompt.
//
// Y hay una tercera variante, `ciego`, que es el control negativo: se le saca
// al prompt TODO el contrato (system.md entero y la sección de build-context) y
// se pide lo mismo. Sirve para saber si la medición mide algo. Si `ciego`
// también diera 100%, un 100% en las otras dos no probaría nada: querría decir
// que el puntaje se cumple solo y que la instrumentación está rota.
//
//   node test/manual/cursor-contrato.js --solo ciego --n 4

const fs = require('fs');
const os = require('os');
const path = require('path');

const cursor = require('../../bridge/providers/cursor-cli');
const { contractReminder } = require('../../bridge/providers');
const { inspectComposition } = require('../../bridge/composition');
const { buildUserPrompt } = require('../../bridge/prompt/build-context');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '..', '..', 'bridge', 'prompt', 'system.md'), 'utf8');

const DURACION = 8.5;
const MARKER_SLUG = 'marcador-12';

// Un marcador realista: objetivo de clase, transcript de la clase entera y el
// fragmento del marcador con sus timecodes. El tamaño importa — el problema que
// se está midiendo es justamente qué pasa cuando el contrato queda lejos del
// final de un texto largo.
const CONTEXTO = {
  objective:
    'Que el estudiante entienda que el sesgo de un modelo de IA no nace del modelo ' +
    'sino de los datos con los que se lo entrenó, y que pueda reconocer tres formas ' +
    'concretas en que ese sesgo aparece en un producto real.',
  transcriptSegments: [
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
  ],
  marker: { name: 'Marcador 12', start: 90, end: 98.5, duration: DURACION },
  markerTranscript: [
    { start: 90, end: 96, text: 'Entonces el sesgo no es un error del modelo. Es un espejo.' },
    { start: 96, end: 98.5, text: 'Un espejo muy grande y muy rápido.' },
  ],
  instruction:
    'Quiero que quede clarísima la idea del espejo. Que la palabra "espejo" sea el ' +
    'protagonista y aparezca justo cuando la digo. Nada de dibujar un espejo literal.',
  generalInstruction:
    'Curso de ética en IA. Paleta oscura, acento ámbar. Tipografía sobria. ' +
    'Nada de iconos genéricos ni stock. Todos los recursos de la clase tienen que ' +
    'parecer parte de la misma familia visual.',
  stillsCount: 0,
};

const PEDIDO_BASE = buildUserPrompt(CONTEXTO);

/**
 * El pedido tal como sale de engine.js, con la sección de continuidad si la hay.
 *
 * El texto está copiado del propio engine.js (el caso "el editor nombró un
 * recurso"), porque lo que se mide es qué tan lejos del final queda el contrato
 * de build-context.js — y eso depende de cuánto se le agregue ENCIMA.
 */
function armarPedido(htmlPrevio) {
  if (!htmlPrevio) return PEDIDO_BASE;
  return PEDIDO_BASE +
    '\n\n## El diseño que te pidieron seguir (mismo estilo, otro contenido)\n' +
    'El editor nombró este recurso: seguí SU sistema visual —paleta, tipografía, ritmo, ' +
    'tipo de transiciones y disposición— y cambiá solo lo que pida su instrucción y el ' +
    'contenido de este tramo. No lo copies literal: es la misma familia, no el mismo cartel.\n' +
    '### marcador-02\n```html\n' + htmlPrevio + '\n```';
}

// Cuánto cuesta el cambio, contado acá y no en el `usage` del CLI.
//
// Cursor informa tokens de entrada que no son de este mundo (2 y 6 en corridas
// con 15.000 caracteres de prompt): sirve para el conteo de salida, no para
// medir lo que agregamos. Como el prompt lo armamos nosotros, el costo se
// calcula exacto en caracteres y se estima en tokens a ~4 caracteres cada uno,
// que para texto en español es una aproximación conservadora.
const ENCABEZADOS = '# CÓMO SE COMPONE EN ESTE PROYECTO\n\n'.length +
  '\n\n# EL PEDIDO\n\n'.length;

function costos(pedido) {
  const c = {
    // Lo que medía el prompt ANTES del cambio: system + '---' + pedido.
    antes: SYSTEM.trim().length + '\n\n---\n\n'.length + pedido.length,
    encabezados: ENCABEZADOS,
    recordatorio: contractReminder().length,
  };
  c.despues = c.antes + c.encabezados + c.recordatorio;
  c.extra = c.despues - c.antes;
  c.extraPct = Math.round(c.extra / c.antes * 1000) / 10;
  c.tokensAprox = Math.round(c.extra / 4);
  // A cuántos caracteres del final queda el contrato de build-context.js sin el
  // recordatorio: es la distancia que se está tratando de acortar.
  const i = pedido.lastIndexOf('## Contrato obligatorio');
  c.contratoADelFinal = i === -1 ? null : pedido.length - i;
  return c;
}

// ── Cómo se puntúa cada composición ─────────────────────────────────────

// Los arreglos con los que el reparador ADOPTA una raíz que el modelo no marcó.
// Se detecta por texto porque composition.js devuelve frases, no códigos — y a
// propósito con una regex ancha: si mañana se reescribe la frase, es mejor que
// esta medición peque de estricta a que cuente como éxito un rescate.
function esAdopcionDeRaiz(fix) {
  return /ra[íi]z|adopt/i.test(String(fix));
}

function puntuar(html) {
  const r = inspectComposition(html, { durationSec: DURACION, markerSlug: MARKER_SLUG });
  const adopto = r.fixes.some(esAdopcionDeRaiz);
  // Que no haya HTML no es lo mismo que un HTML que incumple: en una corrida el
  // modelo contestó EN PROSA que se negaba a componer. Se cuenta aparte porque
  // se arregla en otro lado (cómo está redactado el pedido, no el contrato).
  const rechazo = !/<html[\s>]|<!doctype html/i.test(html);
  return {
    rechazo: rechazo,
    problem: r.problem,
    fixes: r.fixes,
    adoptoRaiz: adopto,
    // La métrica principal: el modelo cumplió el contrato por su cuenta.
    cumpleSolo: r.problem === null && !adopto,
    // Más exigente: no hubo que tocarle absolutamente nada.
    impecable: r.problem === null && r.fixes.length === 0,
    // Detalles para poder mirar QUÉ falló, no solo cuánto.
    tieneStageLiteral: /id\s*=\s*["']stage["']/.test(html),
    declaraDuracion: /data-duration\s*=\s*["']\s*[0-9]*\.?[0-9]+/.test(html),
    registraTimeline: /__timelines\s*\[/.test(html),
  };
}

// ── Una corrida ─────────────────────────────────────────────────────────

/** El pedido sin ninguna mención del contrato: el control negativo. */
function cegarPedido(pedido) {
  const i = pedido.lastIndexOf('\n## Contrato obligatorio');
  if (i === -1) return pedido;
  const resto = pedido.slice(i);
  const finContrato = resto.indexOf('\nDevolvé SOLO');
  return pedido.slice(0, i) + (finContrato === -1 ? '' : resto.slice(finContrato));
}

/**
 * Qué mensaje recibe el modelo en cada variante.
 *
 * `antes` reproduce el armado ANTERIOR al cambio byte por byte —system pelado,
 * un `---` de separador, el pedido— pasándolo todo como mensaje de usuario con
 * el system vacío, que es lo que el proveedor hacía. Sin esta variante no hay
 * "antes": comparar `sin` contra `con` compara dos versiones nuevas y deja los
 * encabezados sin medir, que es justo la parte que rompió una generación.
 */
function mensajeDe(variante, pedido) {
  if (variante === 'ciego') return { system: '', user: cegarPedido(pedido) };
  if (variante === 'antes') return { system: '', user: SYSTEM.trim() + '\n\n---\n\n' + pedido };
  return { system: SYSTEM, user: pedido };
}

async function unaCorrida(variante, i, opts) {
  const t0 = Date.now();
  const m = mensajeDe(variante, opts.pedido);
  const base = {
    variante: variante, n: i,
    conRecordatorio: variante === 'con',
  };
  try {
    const r = await cursor.generate({
      systemPrompt: m.system,
      userPrompt: m.user,
      images: [],
      model: opts.modelo,
      config: {
        model: opts.modelo,
        timeoutMs: opts.timeoutMs,
        // El interruptor que hace posible la comparación: mismo código, mismo
        // modelo, mismo prompt — la única diferencia es el recordatorio final.
        contractTail: variante === 'con',
      },
    });
    const html = r.text || '';
    const salida = path.join(opts.salida, variante + '-' + String(i).padStart(2, '0') + '.html');
    fs.writeFileSync(salida, html, 'utf8');
    return Object.assign(base, puntuar(html), {
      ok: true,
      archivo: salida,
      chars: html.length,
      inputTokens: (r.usage && r.usage.inputTokens) || 0,
      outputTokens: (r.usage && r.usage.outputTokens) || 0,
      segundos: Math.round((Date.now() - t0) / 100) / 10,
    });
  } catch (e) {
    return Object.assign(base, {
      ok: false,
      error: String((e && e.message) || e).slice(0, 300),
      segundos: Math.round((Date.now() - t0) / 100) / 10,
    });
  }
}

/** Corre `tareas` con un tope de cuántas pueden estar en vuelo a la vez. */
async function conParalelismo(tareas, tope, alTerminar) {
  const resultados = new Array(tareas.length);
  let siguiente = 0;
  async function obrero() {
    while (siguiente < tareas.length) {
      const i = siguiente++;
      resultados[i] = await tareas[i]();
      alTerminar(resultados[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(tope, tareas.length) }, obrero));
  return resultados;
}

// ── Las cuentas ─────────────────────────────────────────────────────────

function resumir(filas) {
  const hechas = filas.filter((f) => f.ok);
  const n = hechas.length;
  const suma = (f) => hechas.reduce((a, x) => a + (Number(x[f]) || 0), 0);
  return {
    pedidas: filas.length,
    completadas: n,
    fallidas: filas.length - n,
    cumpleSolo: hechas.filter((f) => f.cumpleSolo).length,
    impecable: hechas.filter((f) => f.impecable).length,
    adoptoRaiz: hechas.filter((f) => f.adoptoRaiz).length,
    conProblema: hechas.filter((f) => f.problem).length,
    rechazos: hechas.filter((f) => f.rechazo).length,
    inputTokensProm: n ? Math.round(suma('inputTokens') / n) : 0,
    outputTokensProm: n ? Math.round(suma('outputTokens') / n) : 0,
    segundosProm: n ? Math.round(suma('segundos') / n * 10) / 10 : 0,
  };
}

function pct(a, b) {
  return b ? (Math.round(a / b * 1000) / 10).toFixed(1) + '%' : '—';
}

const ROTULO = {
  antes: 'ANTES',
  sin: 'encabez.',
  con: 'encab.+record.',
  ciego: 'CIEGO',
};

function tabla(porVariante, COSTO) {
  const nombres = Object.keys(porVariante);
  const R = (fn) => nombres.map((v) => fn(porVariante[v]));
  const filas = [
    ['corridas completadas'].concat(R((r) => r.completadas + '/' + r.pedidas)),
    ['CUMPLE SOLO (la métrica)'].concat(R((r) => r.cumpleSolo + ' · ' + pct(r.cumpleSolo, r.completadas))),
    ['impecable (cero arreglos)'].concat(R((r) => r.impecable + ' · ' + pct(r.impecable, r.completadas))),
    ['hubo que adoptarle la raíz'].concat(R((r) => String(r.adoptoRaiz))),
    ['irreparable (problem != null)'].concat(R((r) => String(r.conProblema))),
    ['se NEGÓ a componer'].concat(R((r) => String(r.rechazos))),
    ['caracteres de prompt'].concat(nombres.map((v) => String(
      v === 'con' ? COSTO.despues : (v === 'antes' ? COSTO.antes : COSTO.antes + COSTO.encabezados)))),
    ['tokens de salida (prom.)'].concat(R((r) => String(r.outputTokensProm))),
    ['segundos por corrida (prom.)'].concat(R((r) => String(r.segundosProm))),
  ];
  const a = Math.max(...filas.map((f) => f[0].length));
  const b = Math.max(14, ...filas.map((f) => Math.max(...f.slice(1).map((c) => c.length))));
  const linea = (f) => '  ' + f[0].padEnd(a) + f.slice(1).map((c) => '  ' + c.padStart(b)).join('');
  return [linea([''].concat(nombres.map((v) => ROTULO[v] || v))),
    '  ' + '─'.repeat(a + (b + 2) * nombres.length)]
    .concat(filas.map(linea)).join('\n');
}

// ── Programa ────────────────────────────────────────────────────────────

function arg(nombre, porDefecto) {
  const i = process.argv.indexOf('--' + nombre);
  return (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : porDefecto;
}

async function main() {
  const opts = {
    n: Number(arg('n', 8)),
    modelo: arg('modelo', cursor.DEFAULT_MODEL),
    paralelo: Number(arg('paralelo', 3)),
    timeoutMs: Number(arg('timeout', 600000)),
    solo: arg('solo', ''),
    continuidad: arg('continuidad', ''),
    salida: arg('salida', fs.mkdtempSync(path.join(os.tmpdir(), 'hp-contrato-'))),
  };
  fs.mkdirSync(opts.salida, { recursive: true });

  const htmlPrevio = opts.continuidad ? fs.readFileSync(opts.continuidad, 'utf8') : '';
  opts.pedido = armarPedido(htmlPrevio);
  const COSTO = costos(opts.pedido);

  const variantes = arg('variantes', '') ? arg('variantes', '').split(',')
    : (opts.solo ? [opts.solo] : ['antes', 'con']);
  console.log('Medición del recordatorio de contrato · proveedor cursor-cli');
  console.log('  modelo:    ' + opts.modelo);
  console.log('  corridas:  ' + opts.n + ' por variante (' + variantes.join(' y ') + ')' +
    ' = ' + opts.n * variantes.length + ' llamadas al modelo');
  console.log('  paralelo:  ' + opts.paralelo);
  console.log('  prompt:    ' + opts.pedido.length + ' caracteres de pedido + ' +
    SYSTEM.length + ' de system.md' +
    (htmlPrevio ? '  (incluye continuidad: ' + htmlPrevio.length + ' caracteres)' : ''));
  console.log('  contrato de build-context: a ' + COSTO.contratoADelFinal +
    ' caracteres del final del pedido');
  console.log('  salidas:   ' + opts.salida);
  console.log('');

  // INTERCALADAS: sin, con, sin, con… Si el backend rinde distinto a lo largo
  // de la corrida, le pega igual a las dos variantes en vez de a una sola.
  const tareas = [];
  for (let i = 1; i <= opts.n; i++) {
    variantes.forEach((v) => tareas.push(() => unaCorrida(v, i, opts)));
  }

  const t0 = Date.now();
  let hechas = 0;
  const filas = await conParalelismo(tareas, opts.paralelo, function (f) {
    hechas++;
    const marca = !f.ok ? 'ERROR' : (f.cumpleSolo ? 'cumple' : 'NO cumple');
    const detalle = !f.ok ? f.error.slice(0, 90)
      : (f.problem ? 'problem=' + f.problem : (f.fixes.length ? 'arreglos: ' + f.fixes.length : 'impecable'));
    console.log('  [' + String(hechas).padStart(2) + '/' + tareas.length + '] ' +
      f.variante.padEnd(3) + ' #' + f.n + '  ' + marca.padEnd(10) + ' ' +
      String(f.segundos).padStart(6) + 's  ' + detalle);
  });
  const minutos = Math.round((Date.now() - t0) / 6000) / 10;

  const porVariante = {};
  variantes.forEach((v) => { porVariante[v] = resumir(filas.filter((f) => f.variante === v)); });

  console.log('\n' + tabla(porVariante, COSTO));
  console.log('\n  tardó ' + minutos + ' min en total');

  const base = porVariante[variantes[0]];
  const trat = porVariante[variantes[variantes.length - 1]];
  const delta = trat.cumpleSolo - base.cumpleSolo;
  console.log('\n  Diferencia en la métrica (' + variantes[0] + ' → ' +
    variantes[variantes.length - 1] + '): ' + (delta >= 0 ? '+' : '') + delta +
    ' composiciones de ' + Math.max(base.completadas, trat.completadas));
  console.log('  Costo del cambio completo: +' + COSTO.extra + ' caracteres por llamada (~' +
    COSTO.tokensAprox + ' tokens, ' + COSTO.extraPct + '% más de prompt)');
  console.log('    · encabezados de sección: ' + COSTO.encabezados + ' caracteres');
  console.log('    · recordatorio del contrato: ' + COSTO.recordatorio + ' caracteres');
  console.log('  OJO: con estas N, una diferencia de 1 o 2 puede ser ruido. Mirá también');
  console.log('  el desglose por corrida en resumen.json antes de sacar conclusiones.');
  console.log('  (los tokens de ENTRADA que informa cursor-agent son basura —2 y 6 con un');
  console.log('   prompt de 15.000 caracteres—, por eso el costo se cuenta en caracteres.)');

  const resumen = {
    fecha: new Date().toISOString(),
    modelo: opts.modelo,
    nPorVariante: opts.n,
    promptChars: { pedido: opts.pedido.length, system: SYSTEM.length },
    continuidad: opts.continuidad || null,
    costo: COSTO,
    porVariante: porVariante, corridas: filas,
  };
  const jf = path.join(opts.salida, 'resumen.json');
  fs.writeFileSync(jf, JSON.stringify(resumen, null, 2), 'utf8');
  fs.writeFileSync(path.join(opts.salida, 'prompt-del-pedido.txt'), opts.pedido, 'utf8');
  console.log('\n  detalle: ' + jf);
}

main();
