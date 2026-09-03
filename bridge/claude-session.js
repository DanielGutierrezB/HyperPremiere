'use strict';

// ¿Puede el CLI de Claude autenticarse en ESTA máquina, tal como lo lanza el
// panel? Es la pregunta del cartel de ⚙, y durante mucho tiempo se contestó
// mirando el lugar equivocado.
//
// El indicador miraba UNA sola cosa: si en la config del panel había un token
// guardado (`oauthToken`, el que deja el botón "Iniciar sesión" o el que se
// pega a mano). Pero el proveedor `claude-cli` no NECESITA ese token: solo lo
// inyecta si existe (`CLAUDE_CODE_OAUTH_TOKEN`), y cuando no está, el CLI usa
// SU PROPIA sesión —la de `claude auth login` (o `/login`) en la terminal—.
// O sea que el panel preguntaba por su cajita y la generación autenticaba por
// otro lado: un editor que se logueó por la terminal generaba perfecto y el
// panel le decía "falta iniciar sesión" para siempre.
//
// No es una hipótesis. En el log de diagnóstico de la máquina de un editor
// (mac, panel v1.4.46) hay tres generaciones seguidas con `claude-sonnet-5`
// que terminaron y se colocaron en el timeline —`Job DONE … ✓ Listo y
// colocado`— con el cartel puesto. Un cartel que asusta sin motivo es un bug:
// manda a "arreglar" algo que funciona.
//
// Ahora se le pregunta AL CLI, con el MISMO entorno con el que va a generar:
//
//     claude auth status   → {"loggedIn":true,"authMethod":"claude.ai",…}
//
// Medido contra el CLI 2.1.201: contesta en ~250 ms, no gasta un token, no
// toca la red y es sensible al entorno (con `CLAUDE_CODE_OAUTH_TOKEN` puesto
// contesta `authMethod: "oauth_token"`). Por eso la respuesta es la del proceso
// hijo que de verdad va a correr, no una conjetura sobre él. Y el entorno lo
// arma esta misma función para los dos —detección y generación— así que no
// pueden opinar distinto: `envParaClaude`.
//
// Lo que NO hace es validar la credencial: con un token inventado igual
// contesta `loggedIn: true`. Es a propósito y es honesto — dice "hay con qué
// autenticarse", que es exactamente la condición desde la que arranca la
// generación. Un token vencido lo va a decir la generación, con su motivo.
//
// La respuesta tiene TRES valores, no dos, y esa es la otra mitad del arreglo:
// "no se sabe" (un CLI viejo que no conoce `auth status`, un binario que no
// contesta) NO es "no hay sesión". Cuando no sabemos, no se asusta a nadie.

const { run } = require('./exec');
const doctor = require('./claude-doctor');

const IS_WIN = process.platform === 'win32';

// Es un comando de lectura que contesta en milisegundos; el tope existe para
// que un binario roto no cuelgue el panel, no porque se espere que tarde.
const STATUS_TIMEOUT_MS = 20_000;

// Un CLI anterior a `claude auth status`: commander contesta esto y cierra.
// Vive acá y no en claude-login porque allá la frase es sobre `setup-token` y
// las dos tienen que poder cambiar por su cuenta.
const NO_CONOCE_RE = /unknown command|unknown option|no such command|invalid command/i;

// Los cuatro valores de `authMethod` que sabe devolver el CLI (están en el
// esquema de su propia salida: none / claude.ai / oauth_token / api_key),
// dichos en el idioma del panel. Lo importante de la distinción es que
// "claude.ai" es la sesión de la terminal, que es justo la que no veíamos.
const COMO_SE_AUTENTICA = {
  'claude.ai': 'con la sesión del CLI de esta máquina',
  'oauth_token': 'con un token de suscripción',
  'api_key': 'con una API key del entorno',
};

/**
 * El entorno con el que se lanza el CLI de Claude.
 *
 * Es la ÚNICA definición: la usa el proveedor para generar y la detección para
 * preguntar. Si se separaran, volveríamos al bug de origen — el panel
 * afirmando algo sobre una corrida que no es la que hace.
 *
 * Cuando no hay token nuestro, no se toca nada: el CLI resuelve con su propia
 * sesión, que es el caso que el indicador no sabía ver.
 */
function envParaClaude(cfg) {
  const env = Object.assign({}, process.env);
  const oauth = (cfg && (cfg.oauthToken || cfg.apiKey)) || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauth) env.CLAUDE_CODE_OAUTH_TOKEN = oauth;
  return env;
}

/**
 * Qué significa lo que contestó `claude auth status`. Función pura y aparte
 * para poder probar cada respuesta posible sin un CLI al lado.
 *
 * @param {{code:number, out?:string, err?:string, timedOut?:boolean}} r
 * @param {boolean} hayToken - si el panel tiene un token guardado para inyectar
 * @param {number} [timeoutMs] - solo para redactar el "no contestó en Ns"
 * @returns {{estado:string, metodo:string, como:string, porQue:string}}
 */
function interpretar(r, hayToken, timeoutMs) {
  const crudo = String((r && r.out) || '') + '\n' + String((r && r.err) || '');

  let datos = null;
  const llave = crudo.indexOf('{');
  if (llave !== -1) {
    try { datos = JSON.parse(crudo.slice(llave, crudo.lastIndexOf('}') + 1)); } catch (e) { datos = null; }
  }

  if (datos && typeof datos.loggedIn === 'boolean') {
    const metodo = String(datos.authMethod || '');
    if (!datos.loggedIn || metodo === 'none') {
      return { estado: 'sin-sesion', metodo: 'none', como: '', porQue: 'el CLI contestó que no tiene con qué autenticarse' };
    }
    // El token del panel y el que ya estaba en el entorno llegan los dos como
    // "oauth_token"; solo nosotros sabemos cuál de los dos es.
    const como = (metodo === 'oauth_token' && hayToken)
      ? 'con el token guardado en el panel'
      : (COMO_SE_AUTENTICA[metodo] || 'con las credenciales que ya tenía');
    return { estado: 'con-sesion', metodo: metodo || 'desconocido', como: como, porQue: '' };
  }

  // De acá para abajo no sabemos. Ninguno de estos casos autoriza a decirle al
  // editor que le falta iniciar sesión.
  if (hayToken) {
    // Salvo éste, que sí se sabe sin preguntarle a nadie: el token lo vamos a
    // poner nosotros en el entorno, así que la generación va a arrancar con
    // credencial. Es exactamente lo que afirmaba el indicador viejo, y para
    // este caso estaba bien.
    return {
      estado: 'con-sesion',
      metodo: 'oauth_token',
      como: 'con el token guardado en el panel',
      porQue: '',
    };
  }
  if (r && r.timedOut) {
    return { estado: 'no-se-sabe', metodo: '', como: '', porQue: 'el CLI no contestó en ' + ((timeoutMs || STATUS_TIMEOUT_MS) / 1000) + 's' };
  }
  if (NO_CONOCE_RE.test(crudo)) {
    return { estado: 'no-se-sabe', metodo: '', como: '', porQue: 'esta versión del CLI no conoce `claude auth status`' };
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

/**
 * Estado de la sesión de Claude en esta máquina, preguntándoselo al CLI.
 *
 * Nunca lanza. Devuelve:
 *   { estado, metodo, resumen, detalle, bin }
 *
 * `estado` es uno de:
 *   'con-sesion'  — puede generar (y `resumen` dice con qué credencial).
 *   'sin-sesion'  — el CLI dijo que no tiene ninguna. Acá SÍ va el cartel.
 *   'sin-cli'     — no hay binario que preguntar.
 *   'no-se-sabe'  — no se pudo averiguar. NO es un problema: no se avisa nada.
 *
 * @param {object} [cfg] - la config plana del motor (oauthToken, apiKey…)
 * @param {object} [opts] - { timeoutMs } (los tests no esperan veinte segundos)
 */
async function estadoDeSesion(cfg, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || STATUS_TIMEOUT_MS;
  const hayToken = Boolean(cfg && (cfg.oauthToken || cfg.apiKey));
  const found = await doctor.locate();

  // `finderBroke` = ni `which`/`where` corrió. Ahí no sabemos si está o no, así
  // que se intenta igual con el nombre pelado, igual que hace el login.
  if (!found.path && !found.finderBroke) {
    return {
      estado: 'sin-cli',
      metodo: '',
      bin: '',
      resumen: 'No encontré el CLI de Claude en esta máquina.',
      detalle: doctor.ficha(found, null) + '\n' +
        'Busqué con ' + doctor.dondeBusque() + '\n' +
        (IS_WIN
          ? 'Qué hacer: instalalo desde PowerShell con  irm https://claude.ai/install.ps1 | iex\n'
          : 'Qué hacer: instalalo con  curl -fsSL https://claude.ai/install.sh | bash\n') +
        doctor.tokenAMano('Una vez instalado,'),
    };
  }

  const bin = found.path || 'claude';
  const r = await run(bin, ['auth', 'status'], {
    timeoutMs: timeoutMs,
    env: envParaClaude(cfg),
    shell: IS_WIN,
  });
  const leido = interpretar(r, hayToken, timeoutMs);

  if (leido.estado === 'con-sesion') {
    return {
      estado: 'con-sesion',
      metodo: leido.metodo,
      bin: bin,
      resumen: '✓ Sesión de Claude activa — ' + leido.como,
      detalle: '',
    };
  }

  if (leido.estado === 'sin-sesion') {
    return {
      estado: 'sin-sesion',
      metodo: 'none',
      bin: bin,
      resumen: 'Esta máquina no tiene sesión de Claude.',
      detalle: 'El CLI está y corre, pero no encontró con qué autenticarse.\n' +
        doctor.ficha(found, null) + '\n' +
        'Qué hacer: abrí una terminal y corré  claude auth login  (el panel se da cuenta solo).\n' +
        doctor.tokenAMano('O, si preferís pegar el token acá:'),
    };
  }

  // No se sabe. Se dice, y no se le pone cara de problema: el editor puede
  // estar generando sin ningún inconveniente.
  return {
    estado: 'no-se-sabe',
    metodo: '',
    bin: bin,
    resumen: 'No pude comprobar la sesión de Claude (' + leido.porQue + ').',
    detalle: 'No quiere decir que falte: si venís generando bien, está todo en orden.\n' +
      doctor.tokenAMano('Si algo falla,'),
  };
}

module.exports = {
  estadoDeSesion,
  envParaClaude,
  // Expuesto para los tests: la lectura de la respuesta es lógica pura.
  _interpretar: interpretar,
};
