'use strict';

// ¿Puede el CLI de Cursor autenticarse en ESTA máquina, tal como lo lanza el
// panel?
//
// Es la misma pregunta que contesta claude-session.js, y está acá por el mismo
// motivo, solo que Cursor venía SIN nada de todo esto. Cuando algo fallaba, el
// editor veía el error crudo del proceso y nada más:
//
//     ✕ No pude hablar con Cursor. Revisá que esta máquina tenga el CLI
//       instalado y con sesión: curl https://cursor.com/install -fsS | bash ·
//       cursor-agent login · Detalle: spawn cursor-agent ENOENT
//
// y después, ya con el binario instalado, el mismo cartel con otro detalle:
//
//       Detalle: Error: Authentication required. Run 'agent login', pass
//       --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN.
//
// Dos problemas distintos —falta el programa, falta la credencial— con el mismo
// cartel, los dos comandos juntos y sin decir cuál corresponde.
//
// ── Qué comando sirve ────────────────────────────────────────────────
//
// `cursor-agent` no tiene `auth status` como Claude. Su `--help` no lo lista,
// pero el subcomando EXISTE (`cursor-agent status --help` → "status|whoami ·
// View authentication status") y admite `--format json`. Medido en esta
// máquina, contra el CLI 2026.09.02-c22c1a3:
//
//     $ cursor-agent status --format json          # con sesión
//     { "status": "authenticated", "isAuthenticated": true,
//       "hasAccessToken": true, "hasRefreshToken": true,
//       "userInfo": { "email": "…", "userId": …, "teamId": … } }
//
//     $ HOME=/tmp/vacio cursor-agent status --format json    # sin sesión
//     { "status": "unauthenticated", "isAuthenticated": false,
//       "hasAccessToken": false, "hasRefreshToken": false,
//       "message": "Not logged in" }
//
// Contesta en ~0,4 s, no gasta un token y no necesita red: apuntándole el
// endpoint a un puerto muerto igual contesta `authenticated`, con
// `"message": "Logged in (unable to fetch user details)"`. O sea que la red le
// sirve para adornar el nombre del usuario, no para saber si hay credencial.
//
// ── El detalle que cambia el diseño ──────────────────────────────────
//
// OJO con una diferencia grande contra Claude, y es la que obliga a que este
// archivo no sea una copia del otro: `cursor-agent status` NO MIRA el entorno.
// Medido, con el HOME vacío y la variable puesta:
//
//     $ CURSOR_API_KEY=key_loquesea cursor-agent status --format json
//     { "status": "unauthenticated", … }        ← la ignora
//
// mientras que la MISMA variable sí la usa para trabajar:
//
//     $ CURSOR_API_KEY=key_loquesea cursor-agent --list-models
//     ⚠ Warning: The provided API key is invalid.
//       The API key was loaded from the CURSOR_API_KEY environment variable.
//
// (o sea: la leyó, la mandó y el servidor la rechazó — con una key de verdad
// habría listado.) Entonces `status` puede decir "no hay sesión" en una máquina
// donde la generación funciona perfecto. Tratar esa respuesta como palabra
// final sería reinventar EXACTAMENTE el bug de Claude, con otra excusa: el
// panel afirmando algo sobre una corrida que no es la que hace. Por eso, cuando
// el panel tiene una key guardada, esa key gana sobre el "unauthenticated".
//
// El entorno lo arma una sola función —`envParaCursor`— que comparten la
// detección y el proveedor, así que no pueden opinar distinto.
//
// ── Lo que NO hace ───────────────────────────────────────────────────
//
// No valida la credencial. Dice "hay con qué autenticarse", que es la condición
// desde la que arranca la generación; si esa credencial no sirve, lo va a decir
// la generación con su motivo. Validar de verdad cuesta una llamada a la red en
// cada apertura de ⚙, y para eso ya está el botón de Diagnóstico.
//
// Y la respuesta tiene TRES valores, no dos: "no se pudo averiguar" NO es "no
// hay sesión". Cuando no sabemos, no se asusta a nadie.

const { run } = require('./exec');
const doctor = require('./cursor-doctor');

const IS_WIN = process.platform === 'win32';

// Es un comando de lectura que contesta en menos de un segundo; el tope existe
// para que un binario roto no cuelgue el panel.
const STATUS_TIMEOUT_MS = 20_000;

// Un CLI anterior a `cursor-agent status`: commander contesta esto y cierra.
const NO_CONOCE_RE = /unknown command|unknown option|no such command|invalid command|unknown argument/i;

/**
 * El entorno con el que se lanza el CLI de Cursor.
 *
 * Es la ÚNICA definición: la usa el proveedor para generar y la detección para
 * preguntar.
 *
 * Va SOLO `CURSOR_API_KEY`, y no `CURSOR_AUTH_TOKEN`, aunque el mensaje de
 * error del propio CLI nombre las dos. No son dos formas de pasar lo mismo:
 * medido en esta máquina, con `CURSOR_AUTH_TOKEN` puesto el CLI trata el valor
 * como un LOGIN y trata de GUARDARLO en el llavero del sistema —
 *
 *     ⚠ Cursor couldn't save your credentials…
 *     Error: Cursor couldn't save your login to the macOS keychain.
 *
 * — o sea que pisa la sesión que la máquina ya tenía. Un campo del panel donde
 * el editor pega algo no puede reescribirle el login del sistema de costado, y
 * las dos cosas no se distinguen mirándolas (el CLI no valida por prefijo: le
 * pasamos una key inventada y un JWT inventado y contestó lo mismo para los
 * dos, "The provided API key is invalid", después de preguntarle al servidor).
 * Así que se pasa la que no tiene efectos: la key. Y el panel dice cuál espera.
 *
 * Cuando no hay key nuestra no se toca nada: el CLI resuelve con su propia
 * sesión, que es el camino normal y el que hay que dejar funcionando.
 */
function envParaCursor(cfg) {
  const env = Object.assign({}, process.env);
  const key = (cfg && cfg.apiKey) || '';
  if (key) env.CURSOR_API_KEY = key;
  return env;
}

/** ¿Tenemos una credencial nuestra para inyectarle? */
function hayKeyDe(cfg) {
  return Boolean((cfg && cfg.apiKey) || process.env.CURSOR_API_KEY);
}

/**
 * Con qué binario se habla. `cursorBinPath` es el override explícito (lo usan
 * los tests para apuntar al CLI de mentira); si no viene, lo resuelve el doctor,
 * que mira el PATH, las rutas conocidas y la escotilla HYPERPREMIERE_CURSOR_BIN.
 *
 * Antes esto era `cfg.cursorBinPath || 'cursor-agent'` y nada más: si el
 * binario no estaba en el PATH que ve Premiere, no había forma de encontrarlo.
 */
async function binDe(cfg) {
  if (cfg && cfg.cursorBinPath) return String(cfg.cursorBinPath);
  const found = await doctor.locate();
  return found.path || 'cursor-agent';
}

/**
 * Qué significa lo que contestó `cursor-agent status --format json`. Función
 * pura y aparte para poder probar cada respuesta posible sin un CLI al lado.
 *
 * @param {{code:number, out?:string, err?:string, timedOut?:boolean}} r
 * @param {boolean} hayKey - si el panel tiene una API key para inyectar
 * @param {number} [timeoutMs] - solo para redactar el "no contestó en Ns"
 * @returns {{estado:string, metodo:string, como:string, porQue:string}}
 */
function interpretar(r, hayKey, timeoutMs) {
  const crudo = String((r && r.out) || '') + '\n' + String((r && r.err) || '');

  // El CLI escribe avisos de actualización antes del JSON, así que no se puede
  // parsear el stdout entero: se busca el objeto adentro.
  let datos = null;
  const llave = crudo.indexOf('{');
  if (llave !== -1) {
    try { datos = JSON.parse(crudo.slice(llave, crudo.lastIndexOf('}') + 1)); } catch (e) { datos = null; }
  }

  // El código de salida NO sirve para decidir: medido, `status` sale con 0 en
  // los dos casos, logueado y no. Lo único que habla es el JSON.
  if (datos && typeof datos.isAuthenticated === 'boolean') {
    if (datos.isAuthenticated) {
      const quien = (datos.userInfo && datos.userInfo.email) ? String(datos.userInfo.email) : '';
      return {
        estado: 'con-sesion',
        metodo: 'sesion-cli',
        como: 'con la sesión del CLI de esta máquina' + (quien ? ' (' + quien + ')' : ''),
        porQue: '',
      };
    }
    // Dijo que no, pero `status` no mira el entorno y la generación sí: si le
    // vamos a poner una key, hay con qué autenticarse. Creerle acá sería
    // dibujar "no tenés sesión" en una máquina que genera bien.
    if (hayKey) return conLaKey();
    return { estado: 'sin-sesion', metodo: 'none', como: '', porQue: 'el CLI contestó que no tiene con qué autenticarse' };
  }

  // De acá para abajo no sabemos. Ninguno de estos casos autoriza a decirle al
  // editor que le falta iniciar sesión.
  if (hayKey) return conLaKey();
  if (r && r.timedOut) {
    return { estado: 'no-se-sabe', metodo: '', como: '', porQue: 'el CLI no contestó en ' + ((timeoutMs || STATUS_TIMEOUT_MS) / 1000) + 's' };
  }
  if (NO_CONOCE_RE.test(crudo)) {
    return { estado: 'no-se-sabe', metodo: '', como: '', porQue: 'esta versión del CLI no conoce `cursor-agent status`' };
  }
  if (r && r.code === -1) {
    return { estado: 'no-se-sabe', metodo: '', como: '', porQue: 'no se pudo ejecutar el CLI' };
  }
  return {
    estado: 'no-se-sabe',
    metodo: '',
    como: '',
    porQue: 'el CLI contestó algo que no supe leer' + (crudo.trim() ? ': ' + crudo.trim().slice(0, 120) : ''),
  };
}

function conLaKey() {
  return {
    estado: 'con-sesion',
    metodo: 'api-key',
    como: 'con la API key guardada en el panel',
    porQue: '',
  };
}

/**
 * Estado de la sesión de Cursor en esta máquina, preguntándoselo al CLI.
 *
 * Nunca lanza. Devuelve { estado, metodo, resumen, detalle, bin }.
 *
 * `estado` es uno de:
 *   'con-sesion'  — puede generar (y `resumen` dice con qué credencial).
 *   'sin-sesion'  — el CLI dijo que no tiene ninguna. Acá SÍ va el cartel.
 *   'sin-cli'     — no hay binario que preguntar. Otro problema, otro arreglo.
 *   'no-se-sabe'  — no se pudo averiguar. NO es un problema: no se avisa nada.
 *
 * @param {object} [cfg] - la config plana del motor (apiKey, cursorBinPath…)
 * @param {object} [opts] - { timeoutMs } (los tests no esperan veinte segundos)
 */
async function estadoDeSesion(cfg, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || STATUS_TIMEOUT_MS;
  const hayKey = hayKeyDe(cfg);

  // Con un override explícito no hace falta salir a buscar nada.
  const forzado = cfg && cfg.cursorBinPath ? String(cfg.cursorBinPath) : '';
  const found = forzado
    ? { path: forzado, source: 'ruta indicada', all: [], finderBroke: false }
    : await doctor.locate();

  // `finderBroke` = ni `which`/`where` corrió. Ahí no sabemos si está o no, así
  // que se intenta igual con el nombre pelado.
  if (!found.path && !found.finderBroke) {
    return {
      estado: 'sin-cli',
      metodo: '',
      bin: '',
      resumen: 'No encontré el CLI de Cursor en esta máquina.',
      detalle: doctor.ficha(found, null) + '\n' +
        'Busqué con ' + doctor.dondeBusque() + '\n' +
        doctor.comoInstalar('Qué hacer:'),
    };
  }

  const bin = found.path || 'cursor-agent';
  const r = await run(bin, ['status', '--format', 'json'], {
    timeoutMs: timeoutMs,
    env: envParaCursor(cfg),
    shell: IS_WIN,
  });
  const leido = interpretar(r, hayKey, timeoutMs);

  if (leido.estado === 'con-sesion') {
    return {
      estado: 'con-sesion',
      metodo: leido.metodo,
      bin: bin,
      resumen: '✓ Sesión de Cursor activa — ' + leido.como,
      detalle: '',
    };
  }

  if (leido.estado === 'sin-sesion') {
    return {
      estado: 'sin-sesion',
      metodo: 'none',
      bin: bin,
      resumen: 'Esta máquina no tiene sesión de Cursor.',
      detalle: 'El CLI está y corre, pero no encontró con qué autenticarse.\n' +
        doctor.ficha(found, null) + '\n' +
        doctor.comoIniciarSesion('Qué hacer:'),
    };
  }

  // No se sabe. Se dice, y no se le pone cara de problema: el editor puede
  // estar generando sin ningún inconveniente.
  return {
    estado: 'no-se-sabe',
    metodo: '',
    bin: bin,
    resumen: 'No pude comprobar la sesión de Cursor (' + leido.porQue + ').',
    detalle: 'No quiere decir que falte: si venís generando bien, está todo en orden.\n' +
      doctor.comoIniciarSesion('Si algo falla,'),
  };
}

/**
 * El diagnóstico del botón de ⚙: la ficha del binario MÁS la sesión.
 * Se arma acá y no en cursor-doctor para que el doctor no dependa de este
 * archivo, que ya depende de él.
 */
function diagnose(cfg) {
  return doctor.diagnose(function (bin) {
    return estadoDeSesion(Object.assign({}, cfg, { cursorBinPath: bin }), { timeoutMs: 20_000 });
  });
}

/**
 * El mensaje que ve el editor cuando NO se pudo hablar con Cursor.
 *
 * Antes era uno solo para todo: los dos comandos —instalar y loguearse— pegados
 * uno abajo del otro y el detalle crudo del proceso al final. Con eso, el
 * editor de las capturas tuvo que adivinar en cuál de los dos estaba parado.
 *
 * Ahora se pregunta primero (cuesta ~0,4 s, que al lado de una generación
 * fallida no es nada) y salen tres mensajes distintos, porque son tres
 * problemas con tres próximos pasos:
 *   - no está instalado  → cómo instalarlo, y nada de login.
 *   - está y sin sesión  → `cursor-agent login`, y nada de instalar.
 *   - está y con sesión  → acá el detalle crudo SÍ es lo útil: falló por otra
 *                          cosa y lo que sabemos es lo que dijo el proceso.
 *
 * @param {object} cfg
 * @param {string} detalle - lo que dejó dicho el proceso (ya legible)
 * @returns {Promise<string>}
 */
async function mensajeDeFalla(cfg, detalle) {
  const dijo = detalle ? '\nDetalle: ' + String(detalle).slice(0, 300) : '';
  let s;
  try {
    s = await estadoDeSesion(cfg);
  } catch (e) {
    s = null;
  }

  if (s && s.estado === 'sin-cli') {
    return 'No pude hablar con Cursor: esta máquina no tiene el CLI instalado.\n' +
      doctor.comoInstalar('Qué hacer:') + dijo;
  }
  if (s && s.estado === 'sin-sesion') {
    return 'No pude hablar con Cursor: el CLI está instalado, pero esta máquina no\n' +
      'tiene sesión de Cursor.\n' +
      doctor.comoIniciarSesion('Qué hacer:') + dijo;
  }
  // Con sesión (o sin poder averiguarlo): el motivo no es ni el binario ni la
  // credencial, así que lo que sirve es lo que dijo el proceso. Repetir acá los
  // dos comandos sería mandarlo a arreglar algo que ya está bien.
  const cabeza = (s && s.estado === 'con-sesion')
    ? 'No pude hablar con Cursor, y no es ni el CLI ni la sesión: las dos están bien\n' +
      '(' + s.resumen.replace(/^✓\s*/, '') + ').'
    : 'No pude hablar con Cursor.';
  return cabeza + dijo +
    '\nSi se repite, mandá la captura del botón "Diagnóstico" de ⚙.';
}

module.exports = {
  estadoDeSesion,
  envParaCursor,
  binDe,
  diagnose,
  mensajeDeFalla,
  // Expuesto para los tests: la lectura de la respuesta es lógica pura.
  _interpretar: interpretar,
};
