'use strict';

// El cartel de "falta iniciar sesión" cuando la sesión está.
//
// El caso real: un editor en mac, panel v1.4.46, proveedor claude-cli. Su log
// de diagnóstico tiene TRES generaciones seguidas con `claude-sonnet-5` que
// terminaron y se colocaron en el timeline (`Job DONE … ✓ Listo y colocado`)
// mientras el panel le decía que le faltaba iniciar sesión. No era la sesión:
// era el indicador, que miraba si NOSOTROS teníamos un token guardado y no si
// el CLI podía autenticarse. Se había logueado con `claude auth login` en su
// terminal, que es el camino normal, y por ahí el panel no miraba nunca.
//
// Lo que se fija acá es que el indicador diga la verdad en los dos sentidos:
// que NO avise cuando el editor puede generar (que es el bug, y el que más
// duele: manda a arreglar algo que funciona), y que SÍ avise —con el próximo
// paso escrito— cuando de verdad no hay con qué autenticarse.
//
// Todo se actúa con un `claude` de mentira (fixtures/fake-cli/fake-claude-auth.js)
// que copia la salida real del CLI 2.1.201. Sin red y sin tokens.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, ok, eq, has } = require('./harness');
const sesion = require('../bridge/claude-session');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-cli', 'fake-claude-auth.js');
// El CLI de mentira es un script con shebang: en Windows no corre así.
const saltarEnWindows = process.platform === 'win32';

const ENV_TOCADAS = ['PATH', 'HOME', 'FAKE_AUTH_MODE', 'FAKE_AUTH_SESSION',
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'HYPERPREMIERE_CLAUDE_BIN'];

/** Un ejecutable llamado `claude` que en realidad es el fixture. */
function crearShim() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-auth-'));
  const dir = path.join(base, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, 'claude');
  fs.writeFileSync(shim, '#!/bin/sh\nexec "' + process.execPath + '" "' + FIXTURE + '" "$@"\n');
  fs.chmodSync(shim, 0o755);
  return dir;
}

/**
 * Corre `fn` con el CLI de mentira en el PATH.
 *
 * El HOME se muda a una carpeta vacía a propósito: si no, las "rutas conocidas"
 * del diagnóstico encuentran el claude REAL de esta máquina y el test dejaría
 * de probar lo que dice probar. Por lo mismo se limpian las variables de
 * autenticación del entorno de quien corre los tests.
 */
async function conFake(opts, fn) {
  opts = opts || {};
  const previo = {};
  for (const k of ENV_TOCADAS) previo[k] = process.env[k];
  const homeVacio = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-home-'));
  try {
    process.env.HOME = homeVacio;
    process.env.PATH = (opts.sinCli ? '' : crearShim() + ':') + '/usr/bin:/bin';
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.HYPERPREMIERE_CLAUDE_BIN;
    process.env.FAKE_AUTH_SESSION = opts.sesion || 'none';
    if (opts.modo) process.env.FAKE_AUTH_MODE = opts.modo;
    else delete process.env.FAKE_AUTH_MODE;
    if (opts.envToken) process.env.CLAUDE_CODE_OAUTH_TOKEN = opts.envToken;
    return await fn();
  } finally {
    for (const k of ENV_TOCADAS) {
      if (previo[k] === undefined) delete process.env[k];
      else process.env[k] = previo[k];
    }
  }
}

// ── El bug ──────────────────────────────────────────────────────────

test('el editor logueado por su terminal TIENE sesión, aunque el panel no guarde ningún token', async function () {
  if (saltarEnWindows) return console.log('      (se saltea en Windows: el CLI de mentira es un script con shebang)');
  // Éste es exactamente el caso del log: `claude auth login` hecho a mano, la
  // config del panel vacía, y tres generaciones que salieron bien.
  const s = await conFake({ sesion: 'claude.ai' }, function () {
    return sesion.estadoDeSesion({ provider: 'claude-cli', oauthToken: '', apiKey: '' });
  });
  eq(s.estado, 'con-sesion', 'no se le puede decir que le falta iniciar sesión');
  eq(s.metodo, 'claude.ai', 'y se sabe por qué camino entra');
  has(s.resumen, 'Sesión de Claude activa', 'el cartel dice lo que pasa');
  has(s.resumen, 'sesión del CLI de esta máquina', 'y con qué credencial, que es la que no veíamos');
});

test('con el token guardado en el panel también hay sesión, y se distingue del otro camino', async function () {
  if (saltarEnWindows) return;
  // El CLI de mentira contesta según el ENTORNO, igual que el de verdad: si
  // esto da 'con-sesion' es porque el token viajó de la config al proceso hijo.
  // O sea que la detección pregunta con el mismo entorno con el que se genera.
  const s = await conFake({ sesion: 'none' }, function () {
    return sesion.estadoDeSesion({ provider: 'claude-cli', oauthToken: 'sk-ant-oat01-loquesea' });
  });
  eq(s.estado, 'con-sesion', 'la máquina no tiene sesión propia, pero el token la da');
  eq(s.metodo, 'oauth_token', 'por el camino del token');
  has(s.resumen, 'token guardado en el panel', 'y se dice cuál de los dos tokens es');
});

test('una API key en el entorno también cuenta: el CLI la usa y nosotros no la vemos', async function () {
  if (saltarEnWindows) return;
  const s = await conFake({ sesion: 'none' }, function () {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-loquesea';
    return sesion.estadoDeSesion({ provider: 'claude-cli' });
  });
  eq(s.estado, 'con-sesion', 'puede generar, así que no se le avisa nada');
  eq(s.metodo, 'api_key');
});

// ── Cuando de verdad falta ──────────────────────────────────────────

test('sin ninguna sesión sí se avisa, y con el próximo paso escrito', async function () {
  if (saltarEnWindows) return;
  const s = await conFake({ sesion: 'none' }, function () {
    return sesion.estadoDeSesion({ provider: 'claude-cli' });
  });
  eq(s.estado, 'sin-sesion', 'acá el cartel corresponde');
  has(s.resumen, 'no tiene sesión de Claude');
  has(s.detalle, 'claude auth login', 'el camino corto, que ahora el panel reconoce solo');
  has(s.detalle, 'claude setup-token', 'y el que siempre funciona, pegando el token');
});

test('sin CLI se dice que falta el CLI, no que falta la sesión', async function () {
  if (saltarEnWindows) return;
  // Son dos problemas con dos arreglos distintos: mandar a iniciar sesión a
  // alguien que no tiene el binario es hacerle perder el rato.
  const s = await conFake({ sinCli: true }, function () {
    return sesion.estadoDeSesion({ provider: 'claude-cli' });
  });
  eq(s.estado, 'sin-cli', 'el modo de falla tiene nombre propio');
  has(s.detalle, 'Busqué con', 'dice dónde miró');
  has(s.detalle, 'claude.ai/install', 'y cómo instalarlo');
});

// ── Cuando no se sabe (que NO es "no hay") ──────────────────────────

test('un CLI viejo que no conoce el comando no es una máquina sin sesión', async function () {
  if (saltarEnWindows) return;
  // `claude auth status` no existió siempre. Si su ausencia se leyera como
  // "no hay sesión", el arreglo traería de vuelta el mismo cartel mentiroso
  // que vino a sacar, ahora en las máquinas con el CLI atrasado.
  const s = await conFake({ modo: 'viejo', sesion: 'claude.ai' }, function () {
    return sesion.estadoDeSesion({ provider: 'claude-cli' });
  });
  eq(s.estado, 'no-se-sabe', 'no se afirma nada');
  ok(s.estado !== 'sin-sesion', 'y sobre todo no se afirma lo que no se sabe');
  has(s.resumen, 'No pude comprobar', 'se dice tal cual');
  has(s.detalle, 'si venís generando bien, está todo en orden', 'sin asustar a quien está trabajando');
});

test('si el CLI contesta cualquier cosa, tampoco se inventa un diagnóstico', async function () {
  if (saltarEnWindows) return;
  const s = await conFake({ modo: 'basura' }, function () {
    return sesion.estadoDeSesion({ provider: 'claude-cli' });
  });
  eq(s.estado, 'no-se-sabe');
  has(s.resumen, 'no supe leer', 'y se cita qué fue lo que contestó');
});


test('un CLI que se cuelga no cuelga el panel', async function () {
  if (saltarEnWindows) return;
  const t0 = Date.now();
  const s = await conFake({ modo: 'muda' }, function () {
    return sesion.estadoDeSesion({ provider: 'claude-cli' }, { timeoutMs: 1200 });
  });
  eq(s.estado, 'no-se-sabe', 'se rinde sin acusar a nadie');
  ok(Date.now() - t0 < 15000, 'y en el tiempo que se le dio');
  has(s.resumen, 'no contestó en 1.2s');
});

test('un CLI viejo CON token guardado sigue contando como sesión', async function () {
  if (saltarEnWindows) return;
  // La compatibilidad hacia atrás: el token lo ponemos nosotros en el entorno,
  // así que se sabe que la generación va a arrancar con credencial sin tener
  // que preguntarle a nadie. Es lo único que el indicador viejo hacía bien.
  const s = await conFake({ modo: 'viejo' }, function () {
    return sesion.estadoDeSesion({ provider: 'claude-cli', oauthToken: 'sk-ant-oat01-loquesea' });
  });
  eq(s.estado, 'con-sesion', 'no se pierde nada de lo que ya andaba');
  has(s.resumen, 'token guardado en el panel');
});

// ── El entorno compartido con el proveedor ──────────────────────────

test('sin token nuestro, el entorno del CLI no se toca', function () {
  // Es la clave de todo el asunto: si acá se pusiera CLAUDE_CODE_OAUTH_TOKEN
  // en vacío, el CLI dejaría de caer en SU sesión y el editor del caso real
  // pasaría de "genera con el cartel puesto" a no generar nada.
  const previo = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    const env = sesion.envParaClaude({ provider: 'claude-cli', oauthToken: '', apiKey: '' });
    ok(!('CLAUDE_CODE_OAUTH_TOKEN' in env), 'la variable no aparece ni vacía');
  } finally {
    if (previo === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previo;
  }
});

test('el token de la config le gana al del entorno, y la API key es el respaldo', function () {
  const previo = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'del-entorno';
  try {
    eq(sesion.envParaClaude({ oauthToken: 'de-la-config' }).CLAUDE_CODE_OAUTH_TOKEN, 'de-la-config',
      'lo que eligió el editor en el panel manda');
    eq(sesion.envParaClaude({ apiKey: 'la-key' }).CLAUDE_CODE_OAUTH_TOKEN, 'la-key',
      'sin token, sirve lo que haya en el slot');
    eq(sesion.envParaClaude({}).CLAUDE_CODE_OAUTH_TOKEN, 'del-entorno',
      'y si el panel no tiene nada, lo del entorno sigue viajando');
  } finally {
    if (previo === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previo;
  }
});

// ── La lectura de la respuesta, sin CLI de por medio ────────────────

test('cada forma de autenticarse se cuenta con sus palabras', function () {
  const leer = function (json, hayToken) {
    return sesion._interpretar({ code: 0, out: JSON.stringify(json) }, !!hayToken);
  };
  eq(leer({ loggedIn: true, authMethod: 'claude.ai' }).como, 'con la sesión del CLI de esta máquina');
  eq(leer({ loggedIn: true, authMethod: 'api_key' }).como, 'con una API key del entorno');
  eq(leer({ loggedIn: true, authMethod: 'oauth_token' }, true).como, 'con el token guardado en el panel');
  eq(leer({ loggedIn: true, authMethod: 'oauth_token' }, false).como, 'con un token de suscripción',
    'el que ya estaba en la máquina no es el nuestro');
  eq(leer({ loggedIn: false, authMethod: 'none' }).estado, 'sin-sesion');
});

test('un método que todavía no existe no se lee como falta de sesión', function () {
  // El CLI puede agregar caminos de autenticación (Bedrock, Vertex, lo que
  // venga). Mientras diga que está logueado, está logueado.
  const s = sesion._interpretar({ code: 0, out: '{"loggedIn":true,"authMethod":"algo-nuevo"}' }, false);
  eq(s.estado, 'con-sesion');
  has(s.como, 'credenciales que ya tenía');
});

test('la respuesta se lee aunque venga con ruido alrededor', function () {
  // Los CLI escriben avisos de actualización antes del JSON. Un parse directo
  // de todo el stdout se rompe con eso y caería en "no se sabe".
  const s = sesion._interpretar({
    code: 0,
    out: 'Nueva versión disponible\n{\n "loggedIn": true,\n "authMethod": "claude.ai"\n}\n',
  }, false);
  eq(s.estado, 'con-sesion', 'el JSON se encuentra igual');
});
