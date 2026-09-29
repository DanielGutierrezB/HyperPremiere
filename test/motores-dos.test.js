'use strict';

// DOS MOTORES DE ANIMACIÓN, y que agregar el segundo no se lleve puesto el primero.
//
// El pedido fue "lo demás debería funcionar igual". Eso tiene una traducción
// exacta y verificable: un proyecto lleno de recursos hechos con HyperFrames —
// que es todo lo que hay en los discos de los editores— se tiene que seguir
// abriendo, refinando, corrigiendo y re-renderizando IGUAL, sin que nadie migre
// un archivo. Y lo nuevo se compone con el motor que diga ⚙.
//
// Lo que se prueba acá es la bisagra entre esas dos cosas:
//
//   1. El registro: quién contesta cuando se pide un motor, y qué pasa con un
//      id que este panel no conoce.
//   2. La ficha: que la AUSENCIA de `engine` signifique HyperFrames y no "no sé".
//   3. El ruteo por versión: refinar, re-renderizar y editar a mano usan el
//      motor con el que nació ESA versión, no el del selector.
//   4. La validación de Remotion: qué corta antes de gastar un render.
//   5. Que los dos prompts digan lo suyo y ninguno diga lo del otro.
//
// Lo que NO se prueba acá es que Remotion renderice: eso necesita su
// instalación de 400 MB y vive en `test/manual/motores-comparar.js`, que corre
// los dos motores sobre los mismos marcadores con el modelo de verdad.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq, has } = require('./harness');

const engine = require('../bridge/engine');
const motores = require('../bridge/render');
const studio = require('../bridge/render/remotion-studio');
const vivos = require('../bridge/vivos');
const { paths, writeVersionMeta, readMeta, lastComposition } = require('../bridge/store/project-fs');
const { metaName, listVersions, nextVersion } = require('../bridge/store/versions');

const HF = motores.motor('hyperframes');
const REMO = motores.motor('remotion');

/** La composición de HyperFrames más chica que pasa su contrato. */
function htmlBueno(id) {
  return '<html><body><div id="stage" data-composition-id="' + id + '" data-start="0" ' +
    'data-width="1920" data-height="1080" data-duration="3.00" data-fps="30"></div>' +
    '<script>const tl=gsap.timeline();window.__timelines["' + id + '"]=tl;</script></body></html>';
}

/** El componente de Remotion más chico que pasa su contrato. */
const TSX_BUENO = [
  "import React from 'react';",
  "import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';",
  '',
  'export default function Marcador() {',
  '  const frame = useCurrentFrame();',
  "  const o = interpolate(frame, [0, 15], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });",
  '  return <AbsoluteFill><div style={{ opacity: o }}>hola</div></AbsoluteFill>;',
  '}',
].join('\n');

function carpeta() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hp-motores-'));
}

/**
 * Corre `fn` con la config en un HOME de juguete.
 *
 * Los tests que entran por `prepareFeedback` necesitan que la config diga qué
 * proveedor usar, y `engine.setConfig` escribe en `~/.hyperpremiere`. Sin esto
 * le cambiarían el proveedor y el modelo al panel del editor que esté corriendo
 * la suite — que no es un test que falla, es uno que pasa y deja el panel
 * generando con otra cosa.
 */
async function conConfigDeJuguete(fn) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-motores-home-'));
  const antes = { home: process.env.HOME, user: process.env.USERPROFILE };
  process.env.HOME = casa;
  process.env.USERPROFILE = casa;
  try {
    return await fn(casa);
  } finally {
    if (antes.home === undefined) delete process.env.HOME; else process.env.HOME = antes.home;
    if (antes.user === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = antes.user;
  }
}

/**
 * Un proyecto descartable con la estructura que arma el motor de verdad, para
 * los tests que entran por las funciones que atiende el panel.
 *
 * La estructura importa y no se puede simplificar: las salidas viven en
 * `<dir del .prproj>/HyperPremiere/<slug de la secuencia>/`, y es de ahí de
 * donde `readMarkerHtml` y `listCorrections` sacan todo.
 */
function proyecto() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-motores-proy-'));
  const projectPath = path.join(raiz, 'Clases.prproj');
  fs.writeFileSync(projectPath, 'x');
  const sequenceName = 'Clase 12';
  const dir = path.join(raiz, 'HyperPremiere', 'clase-12');
  fs.mkdirSync(dir, { recursive: true });
  const donde = { projectPath: projectPath, sequenceName: sequenceName };

  return {
    dir: dir,
    escribir: function (slug, v, ext, code, meta) {
      const base = slug + ' v' + v + ' [modelo]';
      fs.writeFileSync(path.join(dir, base + ext), code, 'utf8');
      writeVersionMeta(path.join(dir, base + '.meta.json'), Object.assign({
        sequenceName: sequenceName, markerSlug: slug, version: v, model: 'modelo',
      }, meta || {}));
      return this;
    },
    abrir: function (slug, v) {
      return engine.readMarkerHtml(Object.assign({ markerSlug: slug, version: v }, donde));
    },
    versiones: function (slug) {
      return engine.listMarkerVersions(Object.assign({ markerSlug: slug }, donde));
    },
    corregir: function () {
      return engine.listCorrections(donde);
    },
    previsualizar: function (slug, v, extra) {
      return engine.previewComposition(Object.assign({
        markerSlug: slug, version: v,
      }, donde, extra || {}));
    },
    /**
     * Re-renderizar la última versión, con el render de mentira.
     *
     * Lo que se mide es CUÁL motor atiende, así que el doble se pone en el
     * `renderizar` de cada motor: es el único lugar donde la decisión se vuelve
     * visible, y capturar un video de verdad tardaría veinte segundos para
     * contestar algo que no se está preguntando.
     */
    reRenderizar: function (slug, motorDeAjustes) {
      return conConfigDeJuguete(async function () {
        const visto = {};
        const previos = {};
        motores.ids().forEach(function (id) {
          const m = motores.motor(id);
          previos[id] = m.renderizar;
          m.renderizar = function (o) {
            visto.motor = id;
            visto.code = o.code;
            fs.writeFileSync(o.outPath, 'video', 'utf8');
            return Promise.resolve();
          };
        });
        engine.setConfig({ renderEngine: motorDeAjustes || 'hyperframes' });
        try {
          visto.res = await engine.renderLatest(Object.assign({
            markerSlug: slug, marker: { name: slug, start: 10, end: 16, duration: 6 },
          }, donde), function () {});
        } finally {
          Object.keys(previos).forEach(function (id) { motores.motor(id).renderizar = previos[id]; });
        }
        return visto;
      });
    },
    /**
     * Refinar el marcador de verdad, con el proveedor de mentira.
     *
     * Entra por `prepareFeedback`, que es la puerta que aprieta la cola: es el
     * único camino donde se lee la versión previa del disco para sacarle el
     * motor, y donde un nombre mal importado se ve. Devuelve lo que recibió el
     * proveedor más el `prepared` que sale.
     */
    refinar: function (slug, respuesta, motorDeAjustes) {
      return conConfigDeJuguete(async function () {
        const visto = {};
        const ruta = require.resolve('../bridge/providers/ollama.js');
        const previo = require.cache[ruta];
        require.cache[ruta] = {
          id: ruta, filename: ruta, loaded: true, exports: {
            generate: async function (arg) {
              visto.arg = arg;
              return { text: respuesta, usage: { inputTokens: 1, outputTokens: 1 } };
            },
          },
        };
        engine.setConfig({
          provider: 'ollama', model: 'falso',
          // Lo que diga ⚙ al momento de refinar: lo pone el test cuando lo que
          // está probando es justamente que NO manda.
          renderEngine: motorDeAjustes || 'hyperframes',
        });
        try {
          visto.prepared = await engine.prepareFeedback(Object.assign({
            markerSlug: slug, mode: 'adjust',
            marker: { name: slug, start: 10, end: 16, duration: 6 },
            instruction: 'el encargo', adjustment: 'subilo un poco',
            objective: 'o', transcript: [], markerTranscript: [],
          }, donde), function () {});
        } finally {
          if (previo) require.cache[ruta] = previo; else delete require.cache[ruta];
        }
        return visto;
      });
    },
  };
}

// ── 1. El registro ──────────────────────────────────────────────────

test('los dos motores están registrados y se piden por su id', function () {
  eq(HF.id, 'hyperframes');
  eq(REMO.id, 'remotion');
  ok(motores.ids().indexOf('hyperframes') !== -1, 'HyperFrames está en el catálogo');
  ok(motores.ids().indexOf('remotion') !== -1, 'Remotion también');
});

test('HyperFrames es el que contesta cuando nadie dice cuál', function () {
  eq(motores.motor('').id, 'hyperframes');
  eq(motores.motor(null).id, 'hyperframes');
  eq(motores.motor(undefined).id, 'hyperframes');
  eq(motores.PREDETERMINADO, 'hyperframes');
});

test('un motor que este panel no conoce cae en el de siempre, no tira', function () {
  // Este id viaja en la ficha de cada versión y en la config del disco, así que
  // puede venir de un panel MÁS NUEVO (un editor que probó un motor que después
  // se sacó) o escrito mal a mano. Ninguna de las dos cosas puede dejar a
  // alguien sin poder abrir su propio proyecto.
  eq(motores.motor('blender').id, 'hyperframes');
  eq(motores.motor('REMOTION').id, 'remotion', 'y el id no es sensible a mayúsculas');
});

test('existe() distingue lo que se puede guardar en la config de lo que no', function () {
  // El que LEE tolera un id desconocido cayendo al de siempre; el que ESCRIBE no
  // lo puede guardar, o ⚙ mostraría "HyperFrames" mientras el archivo dice otra
  // cosa y nadie sabría cuál de los dos miente.
  ok(motores.existe('remotion'));
  ok(!motores.existe('blender'));
  ok(!motores.existe(''));
});

test('las extensiones de composición son las de los dos motores', function () {
  const ext = motores.extensiones();
  ok(ext.indexOf('.html') !== -1, 'las de siempre');
  ok(ext.indexOf('.tsx') !== -1, 'y las nuevas');
});

test('el catálogo incluye los que NO están instalados', function () {
  // Esconderlos dejaría al editor sin manera de descubrir que Remotion existe, y
  // el botón de instalarlo vive justo al lado del que falta.
  const cat = motores.catalogo();
  eq(cat.length, motores.ids().length);
  cat.forEach(function (m) {
    ok(m.nombre && m.nombre !== m.id, 'cada uno se presenta con un nombre para un editor: ' + m.id);
    ok(typeof m.instalado === 'boolean', 'y dice si se puede usar acá');
  });
  const remo = cat.filter(function (m) { return m.id === 'remotion'; })[0];
  ok(remo.instalable, 'Remotion se puede instalar desde el panel');
  if (!remo.instalado) ok(remo.motivo, 'y cuando falta, dice por qué en vez de solo decir que no');
});

test('preguntar por un motor no puede tirar aunque su chequeo se caiga', function () {
  // `estado()` toca el disco. Que eso tire no puede dejar sin desplegable a los
  // otros motores: se cuenta como "no instalado, y este es el motivo".
  const roto = { id: 'roto', nombre: 'Roto', ext: '.x', estado: function () { throw new Error('el disco dijo no'); } };
  motores.registrar(roto);
  try {
    const cat = motores.catalogo();
    const suyo = cat.filter(function (m) { return m.id === 'roto'; })[0];
    ok(suyo, 'sigue en la lista');
    eq(suyo.instalado, false);
    has(suyo.motivo, 'el disco dijo no', 'con el motivo que dio el error');
    ok(cat.length > 1, 'y los demás siguen estando');
  } finally {
    motores._olvidar('roto');
  }
});

// ── 2. La ficha de una versión ──────────────────────────────────────

test('una ficha SIN engine es HyperFrames, no "no sé"', function () {
  // Es la regla que hace que todo lo generado hasta la 1.7.0 siga andando sin
  // migrar un solo archivo.
  eq(motores.motorDeFicha(null).id, 'hyperframes');
  eq(motores.motorDeFicha({}).id, 'hyperframes');
  eq(motores.motorDeFicha({ model: 'claude-opus-5' }).id, 'hyperframes');
});

test('una ficha CON engine manda sobre cualquier otra cosa', function () {
  eq(motores.motorDeFicha({ engine: 'remotion' }).id, 'remotion');
});

test('el engine se guarda en la ficha y vuelve a leerse', function () {
  const dir = carpeta();
  const p = paths(dir, 'marcador-1', 1, 'claude-opus-5', 'mov', REMO.ext);
  writeVersionMeta(p.meta, {
    sequenceName: 'Clase 12', markerSlug: 'marcador-1', version: 1,
    model: 'claude-opus-5', engine: 'remotion',
  });
  eq(readMeta(p.meta).engine, 'remotion');
  eq(motores.motorDeFicha(readMeta(p.meta)).id, 'remotion');
});

test('la extensión del archivo de composición la decide el motor', function () {
  const dir = carpeta();
  eq(path.extname(paths(dir, 'm', 1, 'x', 'mov', HF.ext).code), '.html');
  eq(path.extname(paths(dir, 'm', 1, 'x', 'mov', REMO.ext).code), '.tsx');
  eq(path.extname(paths(dir, 'm', 1, 'x', 'mov').code), '.html',
    'y sin decir nada es .html, que es lo que corresponde a todo lo que ya está en disco');
});

test('el .meta.json de una versión se encuentra desde cualquier extensión', function () {
  // El `replace(/\.html$/, …)` que había en tres lugares no tocaba un `.tsx` y
  // devolvía el nombre del archivo de código: la ficha se leía del .tsx, no era
  // JSON, y el motor salía siempre como el de siempre. Nada tiraba.
  eq(metaName('Marcador 1 v2 [claude-opus-5].html'), 'Marcador 1 v2 [claude-opus-5].meta.json');
  eq(metaName('Marcador 1 v2 [claude-opus-5].tsx'), 'Marcador 1 v2 [claude-opus-5].meta.json');
});

// ── 3. Las versiones de los dos motores son UNA sola cadena ─────────

test('las versiones de un marcador se cuentan juntas, sean .html o .tsx', function () {
  // Es un solo recurso con una historia, no dos cadenas paralelas: la v3 en TSX
  // viene después de la v2 en HTML.
  const dir = carpeta();
  fs.writeFileSync(path.join(dir, 'marcador-1 v1 [m].html'), htmlBueno('v1'));
  fs.writeFileSync(path.join(dir, 'marcador-1 v2 [m].html'), htmlBueno('v2'));
  fs.writeFileSync(path.join(dir, 'marcador-1 v3 [m].tsx'), TSX_BUENO);

  const vs = listVersions(dir, 'marcador-1', motores.extensiones());
  eq(vs.length, 3);
  eq(vs[2].version, 3, 'y la última es la última, no la última de su extensión');
  eq(nextVersion(dir, 'marcador-1'), 4);
});

test('refinar toma la versión previa CON el motor que la escribió', function () {
  const dir = carpeta();
  fs.writeFileSync(path.join(dir, 'marcador-1 v1 [m].html'), htmlBueno('v1'));
  fs.writeFileSync(path.join(dir, 'marcador-1 v2 [m].tsx'), TSX_BUENO);
  writeVersionMeta(path.join(dir, 'marcador-1 v2 [m].meta.json'), {
    markerSlug: 'marcador-1', version: 2, engine: 'remotion',
  });

  const previa = lastComposition(dir, 'marcador-1', 3);
  eq(previa.engine, 'remotion', 'la v2 es de Remotion y la v3 se refina sobre ella');
  has(previa.code, 'export default');
});

test('refinar sobre una versión vieja sigue siendo HyperFrames', function () {
  const dir = carpeta();
  fs.writeFileSync(path.join(dir, 'marcador-1 v1 [m].html'), htmlBueno('v1'));
  const previa = lastComposition(dir, 'marcador-1', 2);
  eq(previa.engine, 'hyperframes', 'sin ficha, es lo que había cuando se escribió');
  has(previa.code, 'id="stage"');
});

test('abrir una versión en el editor devuelve su motor y su gramática', function () {
  // Es lo que el panel usa para dos cosas: con qué resalta Prism el código
  // (markup o tsx) y con qué lo va a renderizar cuando el editor dé a guardar.
  // El motor sale de la FICHA, no de la extensión: hoy las dos dicen lo mismo,
  // pero deducirlo del nombre convierte la tabla de extensiones en un segundo
  // registro de motores que nadie mantiene.
  const p = proyecto();
  p.escribir('marcador-1', 1, '.html', htmlBueno('v1'), {});
  p.escribir('marcador-1', 2, '.tsx', TSX_BUENO, { engine: 'remotion' });

  const vieja = p.abrir('marcador-1', 1);
  ok(vieja.ok, 'la versión vieja se abre');
  eq(vieja.engine, 'hyperframes', 'sin engine en la ficha, es el de siempre');
  eq(vieja.lenguaje, 'markup');
  has(vieja.html, 'id="stage"');

  const nueva = p.abrir('marcador-1', 2);
  ok(nueva.ok, 'y la de Remotion también, aunque su archivo sea .tsx');
  eq(nueva.engine, 'remotion');
  eq(nueva.lenguaje, 'tsx');
  has(nueva.html, 'export default');
});

test('refinar lee la versión previa del disco y le muestra SU código al modelo', async function () {
  // Es el camino que se rompió cuando `lastCompositionHtml` pasó a devolver el
  // motor además del código y quedó un nombre viejo importado: nada tiraba hasta
  // que alguien le daba a "Generar (refinar)" sobre un marcador que ya tenía
  // versiones, que es la mitad de lo que hace un editor todos los días.
  const p = proyecto();
  p.escribir('marcador-1', 1, '.html', htmlBueno('v1'), {});
  const r = await p.refinar('marcador-1', htmlBueno('refinado'));
  ok(r.prepared && r.prepared.ok, 'el refinamiento llega hasta el proveedor');
  has(r.arg.userPrompt, 'Refinamiento sobre la versión previa');
  has(r.arg.userPrompt, 'data-composition-id="v1"', 'con el código de la v1 adentro');
  has(r.arg.userPrompt, '```html', 'marcado con el fence de SU motor');
  eq(r.prepared.engine, 'hyperframes', 'y se renderiza con el motor de esa versión');
});

test('refinar una versión de Remotion NO la pasa a HyperFrames, diga lo que diga ⚙', async function () {
  // El selector decide lo NUEVO. Refinar es "tomá esto y mejoralo": mandarle un
  // HTML con GSAP pidiéndole React no es refinar, es rehacerlo de cero
  // mintiéndole sobre la base — y el resultado tampoco se podría renderizar como
  // la versión anterior.
  const p = proyecto();
  p.escribir('marcador-1', 1, '.tsx', TSX_BUENO, { engine: 'remotion' });
  const r = await p.refinar('marcador-1', TSX_BUENO, 'hyperframes');
  ok(r.prepared && r.prepared.ok);
  eq(r.prepared.engine, 'remotion', 'gana la ficha de la versión, no el selector');
  has(r.arg.userPrompt, '```tsx');
  has(r.arg.userPrompt, 'useVideoConfig', 'y el contrato que viaja es el de Remotion');
});

test('re-renderizar usa el motor de la versión en disco, no el de ⚙', async function () {
  // Re-render es el "reintentar" de la cola: el modelo ya terminó y lo que falló
  // fue el render. Volver a capturar un código que ya está escrito no lo
  // reinterpreta — con el motor de ⚙, reintentar un recurso viejo lo manda al
  // motor equivocado y el error habla de compilación cuando el problema es de
  // ruteo.
  const p = proyecto();
  p.escribir('marcador-1', 1, '.tsx', TSX_BUENO, { engine: 'remotion' });
  const r = await p.reRenderizar('marcador-1', 'hyperframes');
  eq(r.motor, 'remotion', 'gana la ficha de la versión');
  has(r.code, 'export default', 'y se le pasa su propio código');
});

test('re-renderizar un recurso viejo sigue yendo a HyperFrames', async function () {
  const p = proyecto();
  p.escribir('marcador-1', 1, '.html', htmlBueno('v1'), {});
  const r = await p.reRenderizar('marcador-1', 'remotion');
  eq(r.motor, 'hyperframes', 'sin engine en la ficha, el de siempre — diga lo que diga ⚙');
});

test('un test que escribe la config NO le toca la del editor', async function () {
  // La ruta de la config se resuelve en cada lectura y no una vez al cargar el
  // motor. Con la ruta fija, mover `HOME` a un temporal —que es lo que hacen
  // este archivo y otros dos, con un comentario que lo dice— no cambiaba nada:
  // el primer archivo de la suite que pedía el motor la fijaba con el HOME real
  // y todos escribían ahí. No era teórico: en esta máquina había una `apiKey`
  // de prueba y el modelo cambiado a `falso`, puestos por la suite.
  const real = path.join(os.homedir(), '.hyperpremiere', 'config.json');
  let antes = null;
  try { antes = fs.readFileSync(real, 'utf8'); } catch (e) { /* no había */ }

  const escrito = await conConfigDeJuguete(function (casa) {
    engine.setConfig({ provider: 'ollama', model: 'de-juguete' });
    return path.join(casa, '.hyperpremiere', 'config.json');
  });

  ok(fs.existsSync(escrito), 'la config se escribió en el HOME de juguete');
  has(fs.readFileSync(escrito, 'utf8'), 'de-juguete');

  let despues = null;
  try { despues = fs.readFileSync(real, 'utf8'); } catch (e) { /* sigue sin haber */ }
  eq(despues, antes, 'y la del editor quedó byte por byte como estaba');
});

test('la config no guarda un motor que el panel no conoce', function () {
  // El que LEE tolera un id desconocido cayendo al de siempre. Si el que ESCRIBE
  // lo aceptara, ⚙ mostraría "HyperFrames" mientras el archivo dice "blender", y
  // el próximo que lo lea no sabría cuál de los dos le está mintiendo.
  return conConfigDeJuguete(function () {
    engine.setConfig({ renderEngine: 'remotion' });
    eq(engine.getConfig().renderEngine, 'remotion', 'uno que existe sí se guarda');
    engine.setConfig({ renderEngine: 'blender' });
    eq(engine.getConfig().renderEngine, 'remotion', 'y uno que no, no pisa al anterior');
    engine.setConfig({ renderEngine: 'HyperFrames' });
    eq(engine.getConfig().renderEngine, 'hyperframes', 'se guarda normalizado');
  });
});

test('listar las versiones de un marcador las trae de los dos motores', function () {
  const p = proyecto();
  p.escribir('marcador-1', 1, '.html', htmlBueno('v1'), {});
  p.escribir('marcador-1', 2, '.tsx', TSX_BUENO, { engine: 'remotion' });
  const r = p.versiones('marcador-1');
  ok(r.ok);
  eq(r.versions.length, 2, 'las dos, no solo las de una extensión');
});

test('Corrections dice con qué motor se hizo cada versión', function () {
  // El editor abre la que quiera para corregirla, y de eso depende con qué se
  // rediseña: una clase puede tener versiones de los dos motores.
  const p = proyecto();
  p.escribir('marcador-1', 1, '.html', htmlBueno('v1'), { marker: { name: 'Marcador 1', start: 10, duration: 5 } });
  p.escribir('marcador-1', 2, '.tsx', TSX_BUENO, { engine: 'remotion', marker: { name: 'Marcador 1', start: 10, duration: 5 } });

  const r = p.corregir();
  ok(r.ok, 'la pestaña lista');
  const m = r.markers.filter(function (x) { return x.slug === 'marcador-1'; })[0];
  ok(m, 'y encuentra el marcador');
  eq(m.engine, 'remotion', 'la última versión es de Remotion');
  eq(m.versions.length, 2);
  eq(m.versions[0].engine, 'hyperframes', 'y cada versión dice la suya');
  eq(m.versions[1].engine, 'remotion');
});

test('una versión que es PROSA se saltea, con el motor que corresponda', function () {
  // "No es una composición" lo contesta el motor que la escribió: es el único
  // que sabe distinguir su propio código de una respuesta en prosa.
  const dir = carpeta();
  fs.writeFileSync(path.join(dir, 'marcador-1 v1 [m].tsx'), TSX_BUENO);
  writeVersionMeta(path.join(dir, 'marcador-1 v1 [m].meta.json'), {
    markerSlug: 'marcador-1', version: 1, engine: 'remotion',
  });
  fs.writeFileSync(path.join(dir, 'marcador-1 v2 [m].tsx'), 'Perdón, no puedo hacer eso.');
  writeVersionMeta(path.join(dir, 'marcador-1 v2 [m].meta.json'), {
    markerSlug: 'marcador-1', version: 2, engine: 'remotion',
  });

  const previa = lastComposition(dir, 'marcador-1', 3);
  eq(previa.version, 1, 'vuelve el último componente de verdad');
  eq(previa.engine, 'remotion');
});

// ── 4. Lo que Remotion corta antes de gastar un render ──────────────

test('prosa se reconoce como "esto no es un componente"', function () {
  // Y no como "falta el export default", que es cierto y completamente
  // engañoso: no hay componente ninguno, así que no hay nada que arreglar.
  const r = REMO.revisar('No puedo generar eso. Cambiá a Agent mode, por favor.', { durationSec: 3 });
  eq(r.problema, motores.PROBLEMA.NO_ES_CODIGO);
  has(REMO.textoDeProblema(r.problema), 'no es un componente');
});

test('una respuesta vacía también', function () {
  eq(REMO.revisar('', {}).problema, motores.PROBLEMA.NO_ES_CODIGO);
  eq(REMO.revisar('   \n  ', {}).problema, motores.PROBLEMA.NO_ES_CODIGO);
});

test('prosa que NOMBRA un import al pasar sigue siendo prosa', function () {
  const txt = 'No puedo. Te falta el import de `remotion` y el export default del componente.';
  eq(REMO.revisar(txt, {}).problema, motores.PROBLEMA.NO_ES_CODIGO);
});

test('un import fuera de la lista se corta ANTES de levantar Chrome', function () {
  const code = TSX_BUENO.replace(
    "import React from 'react';",
    "import React from 'react';\nimport axios from 'axios';"
  );
  const r = REMO.revisar(code, { durationSec: 3 });
  eq(r.problema, REMO.PROBLEMA.IMPORT_PROHIBIDO);
  has(r.detalle, 'axios', 'diciendo CUÁL sobra');
  has(r.detalle, 'remotion', 'y qué sí hay');
});

test('los imports de la lista pasan, incluidos los submódulos', function () {
  const code = [
    "import React from 'react';",
    "import { AbsoluteFill } from 'remotion';",
    "import { TransitionSeries } from '@remotion/transitions';",
    "import { fade } from '@remotion/transitions/fade';",
    "import { Triangle } from '@remotion/shapes';",
    'export default function M() { return <AbsoluteFill><Triangle length={10} /></AbsoluteFill>; }',
  ].join('\n');
  eq(REMO.revisar(code, { durationSec: 3 }).problema, null);
});

test('un componente sin export default no se "arregla" adivinando', function () {
  // El otro motor sí completa su andamiaje en código, porque lo que falta son
  // atributos de un contenedor. Acá lo que falta es código de React: ponerle un
  // `export default` a un archivo que no lo tiene es adivinar cuál de las
  // funciones que escribió el modelo era el componente.
  const r = REMO.revisar(TSX_BUENO.replace('export default function', 'function'), { durationSec: 3 });
  eq(r.problema, REMO.PROBLEMA.SIN_EXPORT_DEFAULT);
  eq(r.fixes.length, 0, 'no se toca el código');
  has(REMO.textoDeProblema(r.problema), 'export default');
});

test('un componente sano pasa derecho y con su duración', function () {
  const r = REMO.revisar(TSX_BUENO, { durationSec: 8.5 });
  eq(r.problema, null);
  eq(r.duration, 8.5, 'la duración es la del marcador: el modelo no la escribe');
  eq(r.fixes.length, 0);
});

test('la duración de Remotion sale del marcador, no del código', function () {
  // Es la diferencia estructural entre los dos motores, y elimina dos de los
  // problemas que el contrato de HyperFrames tiene que perseguir: acá el modelo
  // no puede equivocarse en un dato que no escribe.
  eq(REMO.revisar(TSX_BUENO, { durationSec: 12 }).duration, 12);
  eq(REMO.revisar(TSX_BUENO, { durationSec: 3 }).duration, 3,
    'el mismo código, otra duración: la manda quien llama');
});

// ── 4 bis. La vista previa: mirar sin renderizar ────────────────────
//
// Lo que se prueba acá es el RUTEO y lo que se le dice al editor. Que Studio
// reproduzca de verdad necesita su instalación de 400 MB y se verifica a mano;
// lo que no puede romperse en silencio es a qué motor le toca, qué código se
// mira, y que el que no puede lo DIGA en vez de abrir una ventana vacía.

/** Un motor de juguete que anota qué vista previa le pidieron. */
function motorConVistaPrevia(id) {
  const visto = { pedidos: [], apagados: 0 };
  motores.registrar({
    id: id, nombre: 'De juguete', ext: '.tsx', lenguaje: 'tsx', fence: 'tsx',
    comoSeLlama: 'el componente',
    estado: function () { return { instalado: true, motivo: '' }; },
    vistaPrevia: function (o) {
      visto.pedidos.push(o);
      return Promise.resolve({ ok: true, url: 'http://localhost:1/', arrancado: visto.pedidos.length === 1 });
    },
    cerrarVistaPrevia: function () { visto.apagados++; return { ok: true, andaba: true }; },
  });
  return visto;
}

test('un motor que no puede previsualizar lo DICE, con el motivo', async function () {
  // Y no abre una ventana vacía. HyperFrames pide su timeline pausada para que
  // el capturador la posicione cuadro por cuadro, así que abrir ese HTML muestra
  // el primer cuadro y nada más. Un "no se puede" a secas suena a que algo está
  // roto; con el motivo, el editor sabe que es así por diseño y qué hacer.
  const p = proyecto();
  p.escribir('marcador-1', 1, '.html', htmlBueno('v1'), { marker: { name: 'm', duration: 5 } });
  const r = await p.previsualizar('marcador-1', 1);
  eq(r.ok, false);
  eq(r.engine, 'hyperframes');
  has(r.error, 'no tiene vista previa');
  has(r.error, 'timeline pausada', 'explica POR QUÉ');
  has(r.error, 'renderizala', 'y qué hacer en su lugar');
});

test('la vista previa va al motor de la VERSIÓN y con su código', async function () {
  const visto = motorConVistaPrevia('juguete');
  try {
    const p = proyecto();
    p.escribir('marcador-1', 1, '.tsx', TSX_BUENO, {
      engine: 'juguete', marker: { name: 'm', duration: 8.5 }, background: false,
    });
    const r = await p.previsualizar('marcador-1', 1);
    ok(r.ok, r.error);
    eq(r.engine, 'juguete');
    eq(visto.pedidos.length, 1);
    has(visto.pedidos[0].code, 'export default', 'se le pasa el código de esa versión');
    eq(visto.pedidos[0].durationSec, 8.5, 'y la duración del marcador');
    eq(visto.pedidos[0].format, 'mov', 'sin fondo: con alfa, como saldría el render');
  } finally {
    motores._olvidar('juguete');
  }
});

test('lo que hay en el EDITOR gana sobre lo que hay en disco', async function () {
  // Es lo que hace que editar y mirar sea un ciclo: se toca el código, se
  // aprieta vista previa, y la ventana que ya está abierta cambia — sin guardar
  // una versión por cada mirada.
  const visto = motorConVistaPrevia('juguete');
  try {
    const p = proyecto();
    p.escribir('marcador-1', 1, '.tsx', TSX_BUENO, {
      engine: 'juguete', marker: { name: 'm', duration: 3 },
    });
    const r = await p.previsualizar('marcador-1', 1, { code: '// lo que escribió el editor' });
    ok(r.ok, r.error);
    has(visto.pedidos[0].code, 'lo que escribió el editor');
    ok(visto.pedidos[0].code.indexOf('export default') === -1, 'y NO el de disco');
    has(visto.pedidos[0].etiqueta, 'sin guardar',
      'la etiqueta lo dice: la ventana es la misma y hay que poder saber qué se mira');
  } finally {
    motores._olvidar('juguete');
  }
});

test('el motor de la ficha manda aunque el cuerpo diga otro', async function () {
  // El panel manda `engine` para el caso de código pegado sin versión en disco.
  // Cuando la versión existe, la ficha gana: es el único lugar donde ese dato
  // está declarado.
  const visto = motorConVistaPrevia('juguete');
  try {
    const p = proyecto();
    p.escribir('marcador-1', 1, '.html', htmlBueno('v1'), { marker: { name: 'm', duration: 5 } });
    const r = await p.previsualizar('marcador-1', 1, { engine: 'juguete' });
    eq(r.engine, 'hyperframes', 'la ficha no dice engine: es HyperFrames');
    eq(r.ok, false, 'y por lo tanto no hay vista previa');
    eq(visto.pedidos.length, 0, 'al motor de juguete no le llegó nada');
  } finally {
    motores._olvidar('juguete');
  }
});

test('con fondo la vista previa se pide opaca, como saldría el render', async function () {
  const visto = motorConVistaPrevia('juguete');
  try {
    const p = proyecto();
    p.escribir('marcador-1', 1, '.tsx', TSX_BUENO, {
      engine: 'juguete', marker: { name: 'm', duration: 4 }, background: true,
    });
    await p.previsualizar('marcador-1', 1);
    eq(visto.pedidos[0].format, 'mp4', 'la ficha dice con fondo');
    await p.previsualizar('marcador-1', 1, { background: false });
    eq(visto.pedidos[1].format, 'mov', 'y el panel lo puede pisar con el toggle de la tarjeta');
  } finally {
    motores._olvidar('juguete');
  }
});

test('sin duración no se arma una vista previa que saldría mal', async function () {
  const visto = motorConVistaPrevia('juguete');
  try {
    const p = proyecto();
    p.escribir('marcador-1', 1, '.tsx', TSX_BUENO, { engine: 'juguete' });
    const r = await p.previsualizar('marcador-1', 1);
    eq(r.ok, false);
    has(r.error, 'cuánto dura');
    eq(visto.pedidos.length, 0);
  } finally {
    motores._olvidar('juguete');
  }
});

test('cerrar el panel apaga la vista previa de todos los motores', function () {
  // El panel avisa al cerrarse, pero puede morir sin avisar. Del otro lado hay
  // dos redes más (la adopción al recargar y el watchdog de inactividad); esto
  // prueba la que sí se puede probar acá.
  const visto = motorConVistaPrevia('juguete');
  try {
    const r = engine.closePreview();
    ok(r.ok);
    eq(visto.apagados, 1, 'se le pidió apagar al que tiene vista previa');
    ok(r.apagados.indexOf('juguete') !== -1);
  } finally {
    motores._olvidar('juguete');
  }
});

test('una vista previa que se murió NO se reusa', function () {
  // Es la diferencia entre reusar y levantar. Dándola por viva, el panel abre
  // una ventana en un puerto que ya no contesta y el editor lee "no se puede
  // acceder a este sitio" sin ninguna pista de por qué.
  const viva = studio._sesionViva;
  ok(viva({ hijo: { exitCode: null, killed: false } }), 'un hijo andando cuenta');
  ok(!viva(null), 'no haber sesión no es tener una');
  ok(!viva({}), 'una sesión sin hijo tampoco');
  ok(!viva({ hijo: { exitCode: 0, killed: false } }), 'un hijo que terminó bien está muerto igual');
  ok(!viva({ hijo: { exitCode: 1, killed: false } }), 'y uno que se cayó');
  ok(!viva({ hijo: { exitCode: null, killed: true } }), 'y uno al que matamos');
});

test('la vista previa sobrevive al ⟳ del panel en vez de quedar huérfana', function () {
  // El ⟳ borra la caché de `require` de todo `bridge/` y vuelve a cargarlo, pero
  // el proceso de Node es el mismo. Con la sesión en una variable del módulo, la
  // instancia nueva arranca sin nada y el webpack anterior queda corriendo sin
  // que nadie lo pueda apagar. La sesión cuelga de `process`, como el micrófono
  // del dictado y por el mismo motivo: "hay un solo Studio" tiene que valer por
  // proceso, no por instancia de módulo.
  const cajas = vivos._cajas();
  ok(cajas['remotion-studio'], 'la sesión está en la caja compartida del proceso');
  eq(cajas['remotion-studio'], studio._caja, 'y es la MISMA que usa el módulo');
  eq(typeof cajas['remotion-studio'].bajarTodo, 'function',
    'con bajarTodo, que es lo que la deja apagar desde la instancia siguiente');
});

test('un motor sin vista previa no se rompe cuando se apaga todo', function () {
  // `closePreview` recorre TODOS los motores. HyperFrames no tiene nada que
  // apagar, y preguntarle no puede tirar: esto corre al cerrar el panel.
  const r = engine.closePreview();
  ok(r.ok);
  ok(r.apagados.indexOf('hyperframes') === -1);
});

// ── 5. Cada motor dice lo suyo y nada de lo del otro ────────────────

test('los dos system prompts comparten los criterios de diseño', function () {
  // La parte común está en UN archivo a propósito: duplicar sesenta líneas de
  // criterio en dos prompts es garantizar que se separen sin que nadie lo
  // decida, y que los dos motores empiecen a diseñar distinto.
  const a = HF.systemPrompt();
  const b = REMO.systemPrompt();
  ['menos es más', 'tres niveles', 'zona segura'].forEach(function (frase) {
    has(a, frase, 'HyperFrames dice «' + frase + '»');
    has(b, frase, 'Remotion también');
  });
});

test('y cada uno dice SOLO su propio contrato', function () {
  const hf = HF.systemPrompt();
  const re = REMO.systemPrompt();
  has(hf, 'window.__timelines', 'el de HyperFrames pide registrar la timeline');
  has(hf, 'data-duration', 'y declarar la duración');
  ok(re.indexOf('window.__timelines') === -1, 'el de Remotion NO habla de la timeline de GSAP');
  ok(re.indexOf('data-duration') === -1, 'ni de data-duration: allá la duración se lee');
  has(re, 'useCurrentFrame', 'habla de su propio reloj');
  has(re, 'export default', 'y de su propio contrato');
});

test('el bloque de contrato del pedido lleva la duración del marcador', function () {
  has(HF.bloqueDeContrato(8.5), '8.50', 'HyperFrames se la hace declarar');
  has(HF.bloqueDeContrato(8.5), 'data-duration');
  has(REMO.bloqueDeContrato(8.5), '8.50', 'Remotion se la dice igual…');
  has(REMO.bloqueDeContrato(8.5), 'useVideoConfig', '…pero para que la LEA de ahí');
  has(REMO.bloqueDeContrato(8.5), 'NO la escribas', 'y le prohíbe escribirla a mano');
});

test('cada motor explica cómo se incrusta una imagen EN SU lenguaje', function () {
  const infos = [{ name: 'asset-01.png', w: 800, h: 240 }];
  has(HF.bloqueDeAssets(infos), '<img src="assets/');
  has(REMO.bloqueDeAssets(infos), 'staticFile');
  ok(REMO.bloqueDeAssets(infos).indexOf('<img src="assets/') === -1,
    'y no el del otro: una ruta relativa en React no carga nada');
  eq(HF.bloqueDeAssets([]), '', 'sin imágenes, el bloque no existe');
  eq(REMO.bloqueDeAssets([]), '');
});

test('el recordatorio final repite el andamiaje del motor que se está usando', function () {
  // Va apagado por defecto (se midió y no cambia nada), pero si se prende con
  // Remotion tiene que repetir SU contrato: con el texto escrito en
  // providers/index.js, prenderlo le repetía al modelo el contrato del otro
  // motor, que es peor que no repetir nada.
  has(HF.recordatorioFinal(), '__timelines');
  has(REMO.recordatorioFinal(), 'export default');
  ok(REMO.recordatorioFinal().indexOf('__timelines') === -1);
});

test('el prompt de arreglo le muestra su código en el fence que corresponde', function () {
  has(HF.promptDeArreglo('pedido', htmlBueno('m'), null, 3), '```html');
  has(REMO.promptDeArreglo('pedido', TSX_BUENO, null, 3), '```tsx');
  eq(HF.fence, 'html');
  eq(REMO.fence, 'tsx');
});

test('cada motor comenta en la sintaxis de su lenguaje', function () {
  // Se usa para avisar que un código se recortó. Un `<!-- … -->` pegado al final
  // de un .tsx es un error de sintaxis, y lo que el modelo lee a continuación es
  // código roto.
  has(HF.comentario('recortado'), '<!--');
  has(REMO.comentario('recortado'), '/*');
});

test('cada motor sabe cómo nombrarse en un mensaje al editor', function () {
  // Entra en los errores que lee el editor ("contestó en prosa en vez de
  // devolver el HTML" / "…el componente"), así que no puede ser una palabra
  // fija: sería mentirle con el nombre del otro motor.
  has(HF.comoSeLlama, 'HTML');
  has(REMO.comoSeLlama, 'componente');
  eq(HF.lenguaje, 'markup', 'y con qué lo resalta Prism en el editor del panel');
  eq(REMO.lenguaje, 'tsx');
});
