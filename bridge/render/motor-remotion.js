// El motor REMOTION: un componente de React que se dibuja cuadro por cuadro.
//
// ── Qué es distinto de HyperFrames, y por qué importa ────────────────
//
// No es "el mismo pipeline con otro renderer": cambia lo que el modelo escribe
// (TSX en vez de HTML), cómo se valida y de dónde sale la duración.
//
// Lo último es la diferencia que más se nota en la práctica. En HyperFrames la
// duración la DECLARA el modelo (`data-duration`) y hay que verificar que le
// haya puesto un número mayor que cero: cuando no, el render sale congelado o
// corta con "zero duration", y son dos de los seis problemas que el contrato
// tiene que perseguir. Acá la duración viaja por `inputProps` desde el marcador
// de Premiere y el componente la LEE con `useVideoConfig()`. El modelo no
// puede equivocarse en un dato que no escribe.
//
// ── Por qué se transpila en Node y no en el navegador ────────────────
//
// Remotion documenta compilar el código del modelo con Babel DENTRO del
// navegador del render. Acá se hace antes, en Node, por tres razones:
//
//  1. Un error de compilación se atrapa sin levantar Chrome. Eso lo convierte
//     en un problema más de la escalera de arreglo (compose.js), igual que un
//     `#stage` que falta: el modelo recibe el mensaje del compilador y corrige
//     su propio código. Compilando adentro, el error aparece a mitad del
//     render, con el minuto ya gastado.
//  2. La lista de imports se valida sobre el mismo texto que se va a compilar.
//  3. El bundle de webpack no tiene que llevar Babel adentro (son megas que se
//     empaquetan una vez y se cargan en cada render).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { registrar } = require('./motores');
const lenguajes = require('./lenguajes');
const { systemPrompt } = require('../prompt/system');
const instalacion = require('./remotion-instalar');
const studio = require('./remotion-studio');
const { permitido, PERMITIDOS } = require('../remotion-host/src/permitidos');
const { killTree } = require('../exec');

// Mismo watchdog que el otro motor: matamos el render solo si pasa este lapso
// sin NINGUNA señal de vida, no si tarda.
const IDLE_TIMEOUT_MS = 300 * 1000;

const PROBLEMA = {
  SIN_EXPORT_DEFAULT: 'sin-export-default',
  IMPORT_PROHIBIDO: 'import-prohibido',
  NO_COMPILA: 'no-compila',
};

const TEXTO = {
  [PROBLEMA.SIN_EXPORT_DEFAULT]: 'falta el `export default` del componente',
  [PROBLEMA.IMPORT_PROHIBIDO]: 'importa un módulo que no está disponible en el render',
  [PROBLEMA.NO_COMPILA]: 'el código no compila',
};

/**
 * ¿Esto es código, aunque esté incompleto?
 *
 * Hace falta preguntarlo antes que nada porque un modelo puede contestar EN
 * PROSA: negarse, pedir una aclaración, explicar lo que haría. Sin esta
 * pregunta esa prosa entraba por la misma puerta que un componente mal escrito
 * y salía "falta el export default" — cierto y completamente engañoso, porque
 * no hay componente ninguno. Es el mismo razonamiento que `looksLikeHtml` en el
 * otro motor.
 */
function pareceCodigo(txt) {
  const t = String(txt || '');
  if (!t.trim()) return false;
  if (/^\s*(import\s|\/\*|\/\/|export\s|const\s|function\s)/.test(t)) return true;
  return /export\s+default/.test(t) && /</.test(t);
}

/**
 * Los módulos que el código pide importar.
 *
 * Se leen con una expresión regular y no con un parser, y tiene un límite que
 * conviene saber: un `import` adentro de un comentario o de un string también
 * cuenta. El costo de ese falso positivo es un mensaje de más pidiéndole al
 * modelo que saque un import que no estaba usando; el costo de NO mirar sería
 * levantar Chrome para descubrir que falta un módulo. La validación de verdad
 * la hace Babel un paso después, cuando compila.
 */
function importsDe(codigo) {
  const out = [];
  const re = /(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(codigo))) out.push(m[1]);
  return out;
}

/**
 * Babel, desde la instalación de Remotion (es donde vive esa dependencia).
 *
 * Al cargarse escribe una vez en stderr `ExperimentalWarning: localStorage is
 * not available`: `@babel/standalone` está pensado para el navegador y tantea
 * ese global, que en Node 26 avisa cuando se lo toca. No es un problema —el
 * protocolo con el worker del render va por stdout en JSON— pero aparece en la
 * cola de salida que se adjunta a un error de render, y ahí puede mandar a
 * buscar del lado equivocado. Silenciarlo pediría apagar los avisos de Node
 * para todo el proceso, que es peor que la línea.
 */
function babel(dir) {
  return require(path.join(dir, 'node_modules', '@babel', 'standalone'));
}

/**
 * TSX → JavaScript de CommonJS.
 *
 * `transform-modules-commonjs` es la pieza clave: convierte los `import` en
 * `require(...)`, y eso es lo que le deja al huésped darle al código del modelo
 * un `require` que solo conoce la lista permitida. La alternativa que Remotion
 * muestra en su documentación —borrar las líneas de import con una expresión
 * regular e inyectar los nombres como parámetros— se rompe con cualquier forma
 * que no sea la esperada (import por defecto, namespace, renombrado).
 */
function compilar(dir, codigo) {
  const Babel = babel(dir);
  const r = Babel.transform(codigo, {
    filename: 'composicion.tsx',
    presets: [['react', { runtime: 'classic' }], 'typescript'],
    plugins: ['transform-modules-commonjs'],
    sourceMaps: false,
  });
  if (!r || typeof r.code !== 'string') throw new Error('Babel no devolvió código');
  return r.code;
}

/** Una línea por evento del hijo; lo que no sea JSON es ruido y se ignora. */
function leerEventos(texto, alEvento) {
  texto.split('\n').forEach((l) => {
    const s = l.trim();
    if (!s || s[0] !== '{') return;
    try { alEvento(JSON.parse(s)); } catch (e) { /* no era un evento nuestro */ }
  });
}

module.exports = registrar({
  id: 'remotion',
  nombre: 'Remotion (React)',
  lenguaje: lenguajes.TSX,

  PROBLEMA,

  esCodigo: pareceCodigo,

  systemPrompt() {
    return systemPrompt('system-remotion.md');
  },

  textoDeProblema(problema) {
    return TEXTO[problema] || 'el componente no cumple el contrato';
  },

  /**
   * El contrato, como DATOS. Los tres lugares donde se le dice al modelo se
   * componen de esta lista (ver prompt/contrato.js).
   */
  reglas: [
    'UN archivo `.tsx` con `export default` del componente.',
    'Imports SOLO de: ' + PERMITIDOS.join(', ') + '.',
    'Sin `Math.random`, sin animación por CSS, sin timers: todo sale de `useCurrentFrame()`.',
    "`interpolate` siempre con `extrapolateLeft: 'clamp'` y `extrapolateRight: 'clamp'`.",
  ],

  /**
   * Cómo se le pide la duración: acá NO se escribe, se LEE.
   *
   * Es la diferencia estructural con el otro motor y elimina dos de sus modos de
   * falla: el modelo no puede olvidarse un dato que no escribe ni ponerlo en
   * cero. Decirle el número igual sirve para que calcule sus tiempos.
   */
  duracionEnElPedido(durationSec) {
    return 'Esta composición dura ' + durationSec.toFixed(2) + ' s. NO la escribas en el código: ' +
      'leela con `useVideoConfig()` (`durationInFrames`, `fps`) y calculá tus tiempos contra eso. ' +
      'La duración la fija el marcador de Premiere, así que un número escrito a mano acá se ' +
      'desincroniza en cuanto el marcador se mueva.';
  },

  bloqueDeAssets(infos) {
    if (!infos.length) return '';
    return '\n\n## Imágenes provistas disponibles como ARCHIVO (para incrustar)\n' +
      'Estas imágenes están en la carpeta pública del proyecto ' +
      '(con sus dimensiones reales en px — respetá el aspect ratio al usarlas):\n' +
      infos.map((a) => '- assets/' + a.name + (a.w && a.h ? ' (' + a.w + '×' + a.h + ' px)' : '')).join('\n') +
      '\nSi la instrucción pide USAR o incluir una imagen provista (un logo, icono, foto o marca), ' +
      'INCRUSTALA con `<Img src={staticFile("assets/NOMBRE")} />` (`Img` y `staticFile` vienen de `remotion`) — ' +
      'NO la recrees ni dibujes una aproximación. Escalala manteniendo su proporción (usá las dimensiones de arriba). ' +
      'Si son solo referencia visual (por ej. un frame del video para leer composición/paleta), usalas como contexto y NO las incrustes.';
  },

  bloqueDeFondo() {
    return '\n\n## Fondo (esta composición LLEVA FONDO — NO es transparente)\n' +
      '- Cubrí TODO el lienzo (1920×1080) con un fondo OPACO: un `<AbsoluteFill>` de base con su color.\n' +
      '- Estilo MINIMALISTA con algo de TEXTURA sutil (grano fino, gradiente suave, patrón geométrico tenue). Nada recargado.\n' +
      '- La temática del fondo debe relacionarse con el OBJETIVO de la clase y el tema de este tramo del transcript (evocá el concepto, no lo hagas literal).\n' +
      '- CONTRASTE: lo que va al frente debe leerse con claridad sobre el fondo; si hace falta, poné un velo detrás del texto.\n' +
      '- Paleta sobria y coherente; el fondo NO debe competir con la información del frente.';
  },

  /**
   * Valida el componente sin renderizar nada.
   *
   * No "completa el andamiaje en código" como hace el otro motor, y es a
   * propósito: allá lo que falta son atributos de un contenedor (se pueden
   * escribir sin tocar el diseño), acá lo que falta es código de React. Meterle
   * un `export default` a un archivo que no lo tiene es adivinar cuál de las
   * funciones que escribió el modelo era el componente.
   */
  revisar(code, opts) {
    const txt = String(code || '');

    const prohibidos = importsDe(txt).filter((n) => !permitido(n));
    if (prohibidos.length) {
      return {
        code: txt, fixes: [],
        problema: PROBLEMA.IMPORT_PROHIBIDO,
        detalle: 'importa ' + prohibidos.map((p) => '`' + p + '`').join(', ') +
          ', y el render solo tiene: ' + PERMITIDOS.join(', '),
      };
    }

    if (!/export\s+default/.test(txt)) {
      return { code: txt, fixes: [], problema: PROBLEMA.SIN_EXPORT_DEFAULT };
    }

    // Compilar es la única validación que de verdad dice si esto anda. Se hace
    // acá —y no al renderizar— para que el error del compilador alimente la
    // escalera de arreglo en vez de aparecer con Chrome ya levantado.
    const st = instalacion.estado();
    if (st.instalado) {
      try {
        compilar(st.dir, txt);
      } catch (e) {
        return {
          code: txt, fixes: [],
          problema: PROBLEMA.NO_COMPILA,
          detalle: String((e && e.message) || e).split('\n').slice(0, 3).join(' '),
        };
      }
    }

    return { code: txt, fixes: [], problema: null };
  },

  renderizar(o) {
    const st = instalacion.estado();
    if (!st.instalado) throw new Error('Remotion no está listo: ' + st.motivo);

    const report = typeof o.onProgress === 'function' ? o.onProgress : function () {};
    const conFondo = o.format === 'mp4';
    const duracionEnCuadros = Math.max(1, Math.round((Number(o.durationSec) || 0) * 30));

    const pedido = {
      dirInstalacion: st.dir,
      versionRemotion: instalacion.VERSION_REMOTION,
      codigoJs: compilar(st.dir, o.code),
      conFondo: conFondo,
      duracionEnCuadros: duracionEnCuadros,
      outPath: o.outPath,
      assetsDir: o.assetsDir || '',
      workers: o.workers || null,
    };

    const trabajo = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperpremiere-remotion-pedido-'));
    const pedidoPath = path.join(trabajo, 'pedido.json');
    fs.writeFileSync(pedidoPath, JSON.stringify(pedido), 'utf8');
    fs.mkdirSync(path.dirname(o.outPath), { recursive: true });

    return new Promise((resolve, reject) => {
      const hijo = spawn(process.execPath, [path.join(__dirname, 'remotion-worker.js'), pedidoPath], {
        cwd: st.dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });

      let listo = false;
      let errorDelHijo = '';
      let ultimaSalida = '';
      let idle = null;

      const limpiar = () => {
        clearTimeout(idle);
        try { fs.rmSync(trabajo, { recursive: true, force: true }); } catch (e) {}
      };
      const armarIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          if (listo) return;
          listo = true;
          killTree(hijo);
          limpiar();
          reject(new Error('Remotion: sin actividad por ' + (IDLE_TIMEOUT_MS / 1000) + 's — parece colgado\n' +
            ultimaSalida.slice(-500)));
        }, IDLE_TIMEOUT_MS);
      };
      armarIdle();

      hijo.stdout.on('data', (d) => {
        const s = d.toString();
        ultimaSalida = (ultimaSalida + s).slice(-4000);
        armarIdle();
        leerEventos(s, (ev) => {
          if (ev.error) { errorDelHijo = ev.error; return; }
          if (ev.ok) return;
          report(ev);
        });
      });
      hijo.stderr.on('data', (d) => {
        const s = d.toString();
        ultimaSalida = (ultimaSalida + s).slice(-4000);
        armarIdle();
      });

      hijo.on('error', (e) => {
        if (listo) return;
        listo = true;
        limpiar();
        reject(new Error('Remotion: no se pudo lanzar el render (' + e.message + ')'));
      });

      hijo.on('close', (code) => {
        if (listo) return;
        listo = true;
        limpiar();
        if (code === 0 && fs.existsSync(o.outPath)) return resolve();
        if (code === 0) {
          return reject(new Error('Remotion terminó OK pero no existe el archivo de salida: ' + o.outPath));
        }
        reject(new Error('Remotion falló (código ' + code + ')\n' +
          (errorDelHijo || ultimaSalida.slice(-800) || '(sin salida)')));
      });
    });
  },

  /**
   * La vista previa: Studio reproduciendo esta composición, en vivo.
   *
   * Es OPCIONAL en la interfaz de motores —HyperFrames no la tiene, y por un
   * motivo que no es pereza: su contrato pide la timeline pausada para poder
   * capturarla cuadro por cuadro, así que abrir ese HTML muestra el primer
   * cuadro y nada más—. Quien la ofrece en el panel pregunta si existe.
   *
   * El código se compila igual que para renderizar, y eso importa: si no
   * compila, el editor se entera acá, con el mensaje del compilador, y no
   * mirando una pantalla en blanco.
   */
  vistaPrevia(o) {
    const st = instalacion.estado();
    if (!st.instalado) throw new Error('Remotion no está listo: ' + st.motivo);
    return studio.mostrar({
      codigoJs: compilar(st.dir, o.code),
      conFondo: o.format === 'mp4',
      duracionEnCuadros: Math.max(1, Math.round((Number(o.durationSec) || 0) * 30)),
      etiqueta: o.etiqueta || '',
    });
  },

  cerrarVistaPrevia() {
    return studio.apagar('lo pidió el panel');
  },

  estadoDeVistaPrevia() {
    return studio.estado();
  },

  estado() {
    return instalacion.estado();
  },

  instalar(onProgress) {
    return instalacion.instalar(onProgress);
  },

  // Para los tests: las dos decisiones que se toman sin levantar nada.
  _pareceCodigo: pareceCodigo,
  _importsDe: importsDe,
});
