// INSTALAR REMOTION, a pedido y fuera del panel.
//
// ── Por qué no viaja en el ZXP ───────────────────────────────────────
//
// Remotion son varios cientos de MB con su Chrome Headless Shell. Meterlo en
// `bridge/package.json` se lo haría bajar a TODOS los editores —incluidos los
// que nunca lo van a elegir— y engordaría el paquete y cada actualización. Así
// que vive en `~/.hyperpremiere/remotion/`, se instala cuando alguien lo elige
// en ⚙, y el que sigue en HyperFrames no baja un byte.
//
// Es el mismo trato que ya tiene Whisper en este panel: una pieza pesada y
// opcional se instala desde la interfaz, no viene adentro.
//
// ── DÓNDE guarda Remotion su Chrome, que no es donde uno cree ────────
//
// `ensureBrowser()` no lo pone al lado de Remotion: `getDownloadsCacheDir()`
// SUBE desde `process.cwd()` hasta encontrar un `package.json` y deja el
// navegador en el `node_modules/.remotion` de ESA carpeta; si no encuentra
// ninguno, en un `.remotion` del cwd a secas.
//
// O sea que el destino lo decide el directorio de trabajo del proceso que lo
// llama. Y el proceso que lo llama acá es el panel, que arranca con el cwd que
// le haya dejado Premiere. La primera vez que se corrió esto, los 175 MB del
// navegador aterrizaron en la raíz del repositorio de HyperPremiere.
//
// Por eso la descarga va en un PROCESO APARTE con `cwd` en la carpeta de
// instalación —que tiene su propio package.json, escrito tres líneas más
// arriba—. Es el mismo cwd con el que después corre el worker del render (ver
// motor-remotion.js), y tiene que serlo: si los dos no coinciden, el navegador
// se baja en un lugar y se busca en otro.
//
// ── Y el bug de Node 26 que no avisa ─────────────────────────────────
//
// Remotion descomprime con `extract-zip`, que en Node 26.1+ ABANDONA la
// extracción a mitad y NO tira error (extract-zip#154, remotion#7409): la
// promesa resuelve, el proceso sale con código 0, y en el disco quedan unos
// archivos de metadata sin el binario. El primer render falla después, con un
// mensaje que habla de otra cosa.
//
// Se ataca por los dos lados, y los dos hacen falta:
//
//  1. `overrides: { yauzl: 3.3.1 }` en el package.json de la instalación —la
//     versión donde el upstream arregló el ciclo de vida del stream—. Eso
//     alcanza en la mayoría de los casos.
//  2. Y DESPUÉS se VERIFICA que el ejecutable exista. Esto es lo que de verdad
//     importa: con una falla silenciosa, confiar en que el paso anterior salió
//     bien es exactamente el error. Si no está, se extrae el .zip con el
//     descompresor del sistema y se vuelve a mirar.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/** Dónde vive la instalación. Fuera del panel: sobrevive a actualizar el ZXP. */
function dirDeInstalacion() {
  return path.join(os.homedir(), '.hyperpremiere', 'remotion');
}

// Las versiones se fijan a propósito: una instalación que se mueve sola es una
// instalación que un día renderiza distinto sin que nadie haya cambiado nada.
// Subirlas es un cambio del panel, con su prueba.
const VERSION_REMOTION = '4.0.410';

/**
 * El package.json de la instalación.
 *
 * `@babel/standalone` está acá y no en el panel porque es quien transpila el
 * TSX del modelo a JavaScript, y solo hace falta si se usa Remotion.
 */
function packageJson() {
  return {
    name: 'hyperpremiere-remotion',
    private: true,
    version: '1.0.0',
    description: 'Motor de render Remotion para HyperPremiere. Lo instala el panel; no se edita a mano.',
    dependencies: {
      remotion: VERSION_REMOTION,
      '@remotion/bundler': VERSION_REMOTION,
      '@remotion/renderer': VERSION_REMOTION,
      '@remotion/cli': VERSION_REMOTION,
      '@remotion/transitions': VERSION_REMOTION,
      '@remotion/shapes': VERSION_REMOTION,
      '@remotion/paths': VERSION_REMOTION,
      '@remotion/noise': VERSION_REMOTION,
      '@remotion/google-fonts': VERSION_REMOTION,
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      '@babel/standalone': '^7.26.0',
    },
    // Ver la cabecera: sin esto, en Node 26.1+ el Chrome de Remotion queda a
    // medio extraer y nada lo dice.
    overrides: {
      yauzl: '3.3.1',
    },
  };
}

/** El ejecutable del navegador, si de verdad está extraído. null si no. */
function ejecutableDeChrome(dir) {
  const raiz = path.join(dir, 'node_modules', '.remotion');
  const nombre = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  // Se BUSCA en vez de armar la ruta: el layout que usa Remotion para guardar
  // el navegador cambió entre versiones (plataforma, versión y nombre de
  // carpeta), y una ruta escrita a mano acá se rompe en silencio la próxima vez
  // que la cambien — que es justo el modo de falla que este módulo persigue.
  const pendientes = [raiz];
  while (pendientes.length) {
    const actual = pendientes.pop();
    let entradas;
    try {
      entradas = fs.readdirSync(actual, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const e of entradas) {
      const p = path.join(actual, e.name);
      if (e.isDirectory()) pendientes.push(p);
      else if (e.name === nombre) {
        // Un archivo de 3 KB no es Chrome: la extracción rota deja restos con
        // el nombre correcto. El binario real pesa decenas de MB.
        try {
          if (fs.statSync(p).size > 1024 * 1024) return p;
        } catch (e2) { /* sigue buscando */ }
      }
    }
  }
  return null;
}

/** Los .zip que quedaron sin extraer adentro de `.remotion` (la firma del bug). */
function zipsSinExtraer(dir) {
  const raiz = path.join(dir, 'node_modules', '.remotion');
  const out = [];
  const pendientes = [raiz];
  while (pendientes.length) {
    const actual = pendientes.pop();
    let entradas;
    try {
      entradas = fs.readdirSync(actual, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const e of entradas) {
      const p = path.join(actual, e.name);
      if (e.isDirectory()) pendientes.push(p);
      else if (/\.zip$/i.test(e.name)) out.push(p);
    }
  }
  return out;
}

/**
 * Descomprime con la herramienta del SISTEMA, que es la que no tiene este bug.
 *
 * `ditto` en macOS (conserva permisos y atributos de los binarios firmados),
 * `unzip` en Linux, y `tar -xf` en Windows (viene con el sistema desde Win10 y
 * entiende zip). Devuelve true si alguna pudo.
 */
function descomprimirConElSistema(zip, destino) {
  const intentos = process.platform === 'darwin'
    ? [['ditto', ['-x', '-k', zip, destino]], ['unzip', ['-o', '-q', zip, '-d', destino]]]
    : process.platform === 'win32'
      ? [['tar', ['-xf', zip, '-C', destino]]]
      : [['unzip', ['-o', '-q', zip, '-d', destino]], ['tar', ['-xf', zip, '-C', destino]]];

  for (const [bin, args] of intentos) {
    try {
      const r = spawnSync(bin, args, { stdio: 'ignore' });
      if (r.status === 0) return true;
    } catch (e) { /* probamos la siguiente */ }
  }
  return false;
}

/** Corre un comando mostrando su salida por `onLinea`. Resuelve con el código. */
function correr(bin, args, opts, onLinea) {
  return new Promise((resolve, reject) => {
    const hijo = spawn(bin, args, Object.assign({
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    }, opts || {}));
    let ultimo = '';
    const leer = (d) => {
      const s = d.toString();
      ultimo = (ultimo + s).slice(-4000);
      String(s).split('\n').forEach((l) => { if (l.trim()) onLinea(l.trim()); });
    };
    hijo.stdout.on('data', leer);
    hijo.stderr.on('data', leer);
    hijo.on('error', (e) => reject(new Error(bin + ': no se pudo lanzar (' + e.message + ')')));
    hijo.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(bin + ' salió con código ' + code + '\n' + ultimo));
    });
  });
}

/**
 * Baja el navegador del render, en un proceso con el cwd que corresponde.
 *
 * El cwd es TODO el punto de que esto sea un proceso aparte y no una llamada
 * directa: ver la cabecera. Cambiar `process.chdir()` en el panel sería la otra
 * forma, y es peor —el panel atiende la cola y el dictado al mismo tiempo, y
 * moverle el directorio de trabajo mientras otra cosa resuelve una ruta
 * relativa es un bug que aparece en otro lado y no se explica desde acá—.
 *
 * El progreso sale por stdout, un número por línea: es un proceso hijo de tres
 * líneas y armarle un protocolo sería más código que el que corre.
 */
function bajarNavegador(dir, onPct) {
  const guion = [
    'const r = require("@remotion/renderer");',
    'r.ensureBrowser({ onBrowserDownload: () => ({ version: null,',
    '  onProgress: (p) => process.stdout.write((p.percent || 0) + "\\n") }) })',
    '  .then(() => process.exit(0))',
    '  .catch((e) => { process.stderr.write(String((e && e.message) || e)); process.exit(1); });',
  ].join('\n');
  return correr(process.execPath, ['-e', guion], { cwd: dir, shell: false }, (l) => {
    const pc = parseFloat(l);
    if (pc >= 0 && pc <= 1) onPct(pc);
  });
}

/** Copia el proyecto huésped (src + tsconfig + config) a la instalación. */
function copiarHuesped(dir) {
  const origen = path.join(__dirname, '..', 'remotion-host');
  const destinoSrc = path.join(dir, 'src');
  fs.rmSync(destinoSrc, { recursive: true, force: true });
  fs.mkdirSync(destinoSrc, { recursive: true });
  for (const f of fs.readdirSync(path.join(origen, 'src'))) {
    fs.copyFileSync(path.join(origen, 'src', f), path.join(destinoSrc, f));
  }
  // `remotion.config.ts` es SOLO para el CLI, o sea para la vista previa: el
  // render del panel usa la API y le pasa sus ajustes explícitos. Lo que hace es
  // que el botón Render que Studio trae en su interfaz —que no podemos sacar y
  // que alguien va a apretar— no salga en H.264 aplastando el alfa. Ver la
  // cabecera de ese archivo.
  for (const f of ['tsconfig.json', 'remotion.config.ts']) {
    fs.copyFileSync(path.join(origen, f), path.join(dir, f));
  }
}

/**
 * ¿Está instalado y usable?
 *
 * Las tres cosas que tienen que estar, y se preguntan por separado porque cada
 * una falla distinto y el editor necesita saber CUÁL: las dependencias, el
 * proyecto huésped y el navegador. La del navegador es la que el bug de Node 26
 * rompe sin avisar.
 */
function estado() {
  const dir = dirDeInstalacion();
  if (!fs.existsSync(path.join(dir, 'node_modules', 'remotion'))) {
    return { instalado: false, motivo: 'Remotion todavía no está instalado en esta máquina.', dir: dir };
  }
  if (!fs.existsSync(path.join(dir, 'src', 'index.ts'))) {
    return { instalado: false, motivo: 'La instalación de Remotion está incompleta (falta el proyecto base).', dir: dir };
  }
  if (!ejecutableDeChrome(dir)) {
    return {
      instalado: false,
      dir: dir,
      motivo: 'Remotion está instalado pero le falta su navegador (Chrome Headless Shell). ' +
        'Volvé a tocar "Instalar": se baja y se verifica que haya quedado completo.',
    };
  }
  return { instalado: true, motivo: '', dir: dir };
}

/**
 * Instala (o repara) Remotion. Best-effort con mensajes: cada paso cuenta qué
 * está haciendo, porque son varios minutos y un botón mudo parece colgado.
 */
async function instalar(onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  const dir = dirDeInstalacion();
  const nota = (t, level) => report({ note: t, level: level });

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(packageJson(), null, 2), 'utf8');

  report({ pct: 5, msg: 'Bajando Remotion (son varios cientos de MB)…' });
  nota('Instalando Remotion ' + VERSION_REMOTION + ' en ' + dir);
  await correr('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir }, (l) => {
    if (/^(added|changed|removed|npm warn|npm error)/i.test(l)) nota('npm: ' + l);
  });

  report({ pct: 60, msg: 'Preparando el proyecto base…' });
  copiarHuesped(dir);

  report({ pct: 70, msg: 'Bajando el navegador del render…' });
  try {
    await bajarNavegador(dir, (pc) => {
      report({ pct: 70 + Math.round(pc * 20), msg: 'Bajando el navegador del render…' });
    });
  } catch (e) {
    nota('La descarga del navegador tiró: ' + ((e && e.message) || e) + '. Reviso qué quedó en el disco.', 'WARN');
  }

  // LO QUE DE VERDAD DECIDE. Ver la cabecera: en Node 26 el paso anterior puede
  // haber "salido bien" y no haber dejado el binario.
  report({ pct: 92, msg: 'Verificando que el navegador haya quedado completo…' });
  if (!ejecutableDeChrome(dir)) {
    const zips = zipsSinExtraer(dir);
    nota('El navegador no quedó extraído (Node ' + process.versions.node + '). ' +
      'Lo descomprimo con la herramienta del sistema.', 'WARN');
    for (const zip of zips) {
      descomprimirConElSistema(zip, path.dirname(zip));
    }
  }

  const bin = ejecutableDeChrome(dir);
  if (!bin) {
    throw new Error(
      'Remotion quedó instalado pero su navegador no: el archivo de Chrome Headless Shell no está en\n' +
      path.join(dir, 'node_modules', '.remotion') + '\n' +
      'Es un problema conocido de Node ' + process.versions.node + ' (la descompresión se corta sin avisar).\n' +
      'Qué hacer: corré a mano `cd ' + dir + ' && npx remotion browser ensure`, o instalá Node 24 LTS.'
    );
  }
  nota('Navegador listo: ' + bin);
  report({ pct: 100, msg: 'Remotion listo.' });
  return { ok: true, dir: dir, chrome: bin, mensaje: 'Remotion ' + VERSION_REMOTION + ' quedó listo.' };
}

module.exports = {
  dirDeInstalacion, estado, instalar, packageJson, VERSION_REMOTION,
  // Para los tests: la verificación del navegador y la lectura del layout son
  // las dos decisiones que tienen consecuencias silenciosas.
  ejecutableDeChrome, zipsSinExtraer,
};
