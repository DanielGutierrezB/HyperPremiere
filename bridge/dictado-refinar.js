'use strict';

// El refinador del dictado: convierte lo que salió del micrófono en una
// instrucción de diseño que se pueda leer.
//
// Quién refina: PRIMERO el proveedor que el editor eligió
// -------------------------------------------------------
// Durante un tiempo esto fue una cadena fija —API de Anthropic, CLI de Claude,
// Ollama— que nunca miraba `cfg.provider`. El razonamiento era de costo:
// refinar dos frases es una llamada de segundos que pasa cada vez que alguien
// suelta el botón del micrófono, así que conviene la vía más barata que haya en
// la máquina, sea cual sea.
//
// El razonamiento estaba bien y la conclusión estaba mal, y lo dijo el mismo
// editor dos veces: *"si tengo configurado el CLI de Cursor, aún siento que el
// botón de refinar manda el prompt por Claude, no por el que tengo
// seleccionado"*. Tenía razón. Y en su máquina no era solo raro: la cuenta de
// Claude no tenía cupo, así que el botón NO FUNCIONABA teniendo la máquina con
// qué refinar. Elegir un proveedor en ⚙ y que el panel hable con otro es un
// bug de coherencia, y encima le costaba la función entera.
//
// La regla ahora es una sola:
//
//   Si el proveedor elegido en ⚙ puede refinar, refina él.
//
// La cadena vieja queda como RESPALDO, y solo se usa cuando el elegido no puede
// (sin sesión, sin cupo, sin credencial). Ahí su orden sigue siendo el de
// antes, que sigue siendo por costo y latencia:
//
//   1. API de Anthropic (`claude-api`) — si hay una API key configurada. Es
//      HTTP directo: no arranca ningún CLI, así que no paga el piso de
//      arranque que hace absurdo todo lo demás.
//   2. CLI de Claude con Haiku — si esta máquina tiene con qué autenticarse.
//      Paga el arranque del CLI, que medido acá domina el número.
//   3. Ollama local — gratis y sin red, pero con la advertencia de abajo.
//   4. Ninguno — el dictado NO se rompe: queda el texto crudo en el campo y se
//      dice por qué no se pudo refinar. Un dictado sin refinar es útil; un
//      botón que no hace nada, no.
//
// Cuando refina el respaldo se DICE cuál fue: el editor tiene que saber con qué
// se escribió lo que le apareció en el campo. Lo que no se hace es mandarlo a
// instalar ni a arreglar el proveedor que no eligió.
//
// Por qué `cursor-cli` entra ahora, y por qué NO está en el respaldo
// ------------------------------------------------------------------
// Entra porque puede ser el elegido, y la coherencia con lo elegido es la regla.
// No está en el respaldo por lo que se midió (test/manual/cursor-refinado.js,
// mismo dictado de 40 palabras, dos vueltas): refinar por Cursor cuesta 5,7-7,1
// s y ~9.500 tokens escritos a caché, porque el CLI arrastra su propio contexto
// de agente en CADA llamada por corto que sea el pedido. Por la API de
// Anthropic, lo mismo son ~2 s y el prompt pelado. Como respaldo sería elegir
// lo más caro habiendo alternativa; como elegido es lo que el editor pidió,
// sabiendo lo que cuesta —y se lo decimos, con `aviso`—. Las dos cosas a la vez
// y sin contradicción: se usa cuando lo eligieron, no se prefiere cuando hay
// con qué comparar.
//
// La red de abajo: `verificar`
// ----------------------------
// El requisito del editor es que el refinado CONSERVE todo lo que pidió y NO
// INVENTE nada. Eso se le pide al modelo en el prompt, y con los modelos
// grandes alcanza. Con uno chico corriendo local, no siempre: medido con
// `llama3` sobre un dictado de 45 palabras, se comió dónde iba el título y
// agregó un "sin pérdida" que nadie dijo. Por eso lo que vuelve pasa por un
// control de tamaño antes de llegar al campo, y si no lo pasa se conserva el
// crudo con el motivo escrito. Vale para todos los refinadores, no solo para
// el local: es más barato desconfiar que explicarle a un editor por qué su
// instrucción perdió la mitad.

const { hpFetch } = require('./providers/http');
const claudeApi = require('./providers/claude-api');
const cursorCli = require('./providers/cursor-cli');
const claudeSession = require('./claude-session');
const claudeDoctor = require('./claude-doctor');
const cursorSession = require('./cursor-session');
const providerSalud = require('./provider-salud');
const cliErrors = require('./providers/cli-errors');
const { getProvider } = require('./providers');

// Alias del CLI: "haiku" resuelve al Haiku más nuevo que tenga la cuenta, así
// que un modelo nuevo entra sin tocar código. Si la cuenta no tiene ninguno, el
// CLI falla y la cadena baja al escalón siguiente, que es lo que corresponde.
const MODELO_CLI = process.env.HYPERPREMIERE_DICTADO_MODELO || 'haiku';
// Por la API hay que nombrarlo entero (no acepta alias).
const MODELO_API = process.env.HYPERPREMIERE_DICTADO_MODELO_API || 'claude-haiku-4-5';

// Refinar es una llamada corta. Si tarda más que esto, algo se colgó y es
// preferible devolver el crudo que dejar al editor mirando un botón.
const TIMEOUT_MS = Number(process.env.HYPERPREMIERE_DICTADO_TIMEOUT_MS) || 45_000;
const TIMEOUT_OLLAMA_MS = Number(process.env.HYPERPREMIERE_DICTADO_TIMEOUT_OLLAMA_MS) || 60_000;
// Cursor necesita más aire que los otros: al pedido hay que sumarle el arranque
// del agente, que es el que pone el piso (medido en test/manual/cursor-refinado.js).
const TIMEOUT_CURSOR_MS = Number(process.env.HYPERPREMIERE_DICTADO_TIMEOUT_CURSOR_MS) || 120_000;

const OLLAMA_URL = process.env.HYPERPREMIERE_OLLAMA_URL || 'http://localhost:11434';

// Modelos locales que sirven para esto, en orden de preferencia. El criterio no
// es "el más grande": es el más chico que siga instrucciones en español sin
// ponerse a razonar en voz alta. Los de razonamiento (qwen3, deepseek-r1)
// quedan afuera a propósito — medido acá, `qwen3:4b` tardó 14 y 23 s en
// refinar cuatro frases porque piensa antes de contestar, y para esto el
// pensamiento no agrega nada.
//
// Se elige de lo que el editor YA tenga instalado; no se baja nada.
const OLLAMA_PREFERIDOS = [
  'llama3.2', 'llama3.1', 'llama3', 'mistral-small3.1', 'mistral', 'gemma3', 'gemma2', 'phi4',
];

// El manual del refinador. Es lo único que separa "una transcripción" de "una
// instrucción de diseño", así que está escrito con las mismas dos prohibiciones
// que pidió el editor y en el orden en que importan.
const SISTEMA = [
  'Sos un editor de texto. Recibís lo que un editor de video DICTÓ por micrófono para pedirle',
  'una animación a un diseñador, transcrito por Whisper: sin puntuación confiable, con',
  'muletillas y con correcciones dichas en voz alta. Devolvés esa misma pedido convertido en',
  'UNA instrucción de diseño clara.',
  '',
  'REGLAS, en orden de importancia:',
  '1. NO INVENTES NADA. Si no lo dijo, no está. Ni colores, ni tipografías, ni tiempos, ni',
  '   textos en pantalla, ni efectos, ni "de forma elegante". Es una instrucción de trabajo,',
  '   no una propuesta: lo que agregues lo va a terminar viendo en el video.',
  '2. NO PIERDAS NADA de lo que pidió. Podés reordenar, agrupar y estructurar; descartar no.',
  '3. Los términos técnicos que se dicen en inglés SE QUEDAN EN INGLÉS: keyframe, fade,',
  '   easing, loop, overlay, stroke, lower third, timeline, motion blur. Nadie quiere leer',
  '   "fotograma clave".',
  '4. Sacá muletillas ("eh", "o sea", "este"), repeticiones y arranques abandonados. Si se',
  '   corrigió en voz alta ("azul… no, mejor rojo"), vale lo último que dijo.',
  '5. Español. Si el dictado viene con texto que el editor ya tenía escrito, es LA MISMA idea:',
  '   se refina todo junto en una sola instrucción, no se pega uno abajo del otro.',
  '',
  'Devolvés SOLO la instrucción. Sin preámbulo, sin comillas, sin listas de qué cambiaste,',
  'sin preguntas.',
].join('\n');

/**
 * El pedido, tal como lo ve el modelo.
 *
 * Lo dictado y lo que ya estaba escrito viajan MARCADOS y separados, no
 * pegados: el modelo tiene que poder distinguirlos para fundirlos en una idea
 * sola (que es lo que pidió el editor) en vez de tratar al segundo como una
 * corrección del primero.
 *
 * `origen === 'escrito'` es el botón ✨ del panel: refinar lo que el editor
 * TECLEÓ, sin micrófono de por medio. Cambia UNA línea, el rótulo del bloque, y
 * no el manual: `SISTEMA` viaja idéntico byte por byte, que es lo que deja que
 * se lea de caché en cada llamada. Pero el rótulo importa igual: el manual
 * arranca diciendo que lo que llega lo transcribió Whisper "sin puntuación
 * confiable, con muletillas", y eso sobre un texto tecleado es una invitación a
 * arreglar una puntuación que ya estaba bien y a leer una palabra elegida a
 * propósito como un error de transcripción.
 */
function armarPedido(crudo, previo, origen) {
  const dictado = String(crudo || '').trim();
  const escrito = String(previo || '').trim();
  if (origen === 'escrito') {
    return 'ESCRITO A MANO (no es una transcripción: la puntuación y las palabras son las que eligió):\n' + dictado;
  }
  if (!escrito) return 'DICTADO:\n' + dictado;
  return [
    'YA ESTABA ESCRITO EN EL CAMPO:',
    escrito,
    '',
    'Y ACABA DE DICTAR:',
    dictado,
    '',
    'Las dos cosas son el mismo pedido. Fundilas en UNA instrucción.',
  ].join('\n');
}

// Los modelos chicos arrancan con un "Aquí tienes la instrucción:" por más que
// se les pida que no. Sacarlo es una línea; rechazar la respuesta entera por
// eso sería tirar un refinado que estaba bien.
const PREAMBULOS = /^\s*(aqu[íi] (?:tien(?:es|e)|va|est[áa])[^\n:]*:|la instrucci[óo]n[^\n:]*:|instrucci[óo]n(?: de dise[ñn]o)?:|resultado:|texto refinado:)\s*/i;

function limpiar(texto) {
  let t = String(texto || '').trim();
  // Algunos modelos locales piensan en voz alta dentro de <think>…</think>.
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  t = t.replace(PREAMBULOS, '').trim();
  // Comillas envolviendo TODO el texto (no las de adentro, que suelen ser el
  // texto que va en pantalla: 'un título que diga "Configuración inicial"').
  const m = t.match(/^["“'](.*)["”']$/s);
  if (m && m[1].indexOf('"') === -1) t = m[1].trim();
  return t;
}

function palabras(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * ¿Se puede confiar en lo que volvió? Función pura y aparte para poder probar
 * cada caso sin un modelo al lado.
 *
 * No pretende verificar que el sentido se conserve —para eso haría falta otro
 * modelo, y entonces habría que verificar a ése—. Ataca los dos modos de falla
 * que de verdad aparecieron midiendo: que el refinador se coma la mitad del
 * pedido, y que conteste otra cosa en vez de refinar.
 *
 * @returns {{ok:boolean, motivo:string}}
 */
function verificar(refinado, crudo) {
  const r = palabras(refinado);
  const c = palabras(crudo);
  if (!r) return { ok: false, motivo: 'el refinador devolvió un texto vacío' };
  // Esto va ANTES que las medidas de tamaño y no es un detalle de orden: un
  // "No puedo ayudarte con eso" son cinco palabras contra cuarenta, así que la
  // medida de tamaño lo agarra igual — pero le dice al editor que el refinador
  // se comió su pedido, y lo manda a mirar el dictado cuando el problema es
  // que el modelo se negó. El motivo correcto vale más que el rechazo.
  if (/^(no puedo|lo siento|como (?:modelo|asistente|ia)\b|i (?:can(?:'|no)t|am unable))/i.test(refinado.trim())) {
    return { ok: false, motivo: 'el refinador contestó en vez de refinar' };
  }
  if (c >= 8 && r < Math.ceil(c * 0.35)) {
    return {
      ok: false,
      motivo: 'el refinado quedó en ' + r + ' palabras contra ' + c + ' dictadas: se comió parte del pedido',
    };
  }
  // Sacar muletillas ACORTA. Un refinado que triplica el dictado está
  // agregando cosas que nadie dijo, que es lo único que no se puede permitir.
  if (c >= 8 && r > c * 3) {
    return {
      ok: false,
      motivo: 'el refinado tiene ' + r + ' palabras contra ' + c + ' dictadas: le agregó detalles que no dijiste',
    };
  }
  return { ok: true, motivo: '' };
}

// ---------------------------------------------------------------------------
// Los tres refinadores. Cada uno dice lo mismo: si está y cómo se llama, y con
// qué modelo y qué configuración hay que llamar a SU proveedor. Nadie de acá
// adentro sabe que existen los otros.
//
// Lo que NO hay acá es una sola línea de spawn, de HTTP ni de parseo: el
// proveedor es el de `bridge/providers/`, el mismo que genera las animaciones,
// llamado por `complete()` —que devuelve el texto crudo en vez de leerlo como
// HTML—. Estuvo escrito al revés y costó caro: el CLI de Claude puede cerrar
// con CÓDIGO 0 y `is_error: true`, con el error adentro del campo `result`.
// Leyendo `result` a secas, ese mensaje de error entraba a `limpiar` y a
// `verificar` como si fuera el refinado, y con un dictado corto terminaba EN EL
// CAMPO DEL EDITOR haciéndose pasar por su prompt. Con el proveedor canónico
// eso lanza, y lanzar acá quiere decir "queda el crudo y se dice por qué".
// De paso vienen la escalera de reintento por flag desconocido, el
// `--append-system-prompt-file` (que en Windows es la diferencia entre un
// system prompt y un mensaje de usuario gigante) y el diagnóstico de "sin
// sesión / sin cuota / modelo inexistente".
// ---------------------------------------------------------------------------

function apiKeyDe(cfg) {
  const perProv = (cfg && cfg.perProvider && cfg.perProvider['claude-api']) || {};
  const cruda = claudeApi.normalizeApiKey(perProv.apiKey || cfg.apiKey || process.env.ANTHROPIC_API_KEY || '');
  // Un token de suscripción (sk-ant-oat…) NO sirve contra la API: devuelve 401.
  // El proveedor ya lo sabe distinguir; acá se descarta antes de elegirlo, que
  // es lo que evita elegir un refinador que va a fallar seguro.
  return /^sk-ant-api/i.test(cruda) ? cruda : '';
}

const REFINADORES = [
  {
    id: 'claude-api',
    nombre: 'Claude Haiku (API de Anthropic)',
    async detectar(cfg) {
      return apiKeyDe(cfg)
        ? { disponible: true }
        : { disponible: false, motivo: 'no hay API key de Anthropic configurada en ⚙' };
    },
    model: () => MODELO_API,
    config: (cfg) => ({ apiKey: apiKeyDe(cfg), maxTokens: 1500, timeoutMs: TIMEOUT_MS }),
  },

  {
    id: 'claude-cli',
    nombre: 'Claude Haiku (CLI de Claude)',
    async detectar(cfg) {
      const s = await claudeSession.estadoDeSesion(cfg, { timeoutMs: 15_000 });
      if (s.estado === 'con-sesion') return { disponible: true };
      if (s.estado === 'sin-cli') return { disponible: false, motivo: 'no está el CLI de Claude en esta máquina' };
      if (s.estado === 'sin-sesion') return { disponible: false, motivo: 'el CLI de Claude está pero sin sesión (corré `claude auth login`)' };
      return { disponible: false, motivo: 'no pude comprobar la sesión de Claude' };
    },
    model: () => MODELO_CLI,
    // Async porque hay que ubicar el binario, que es lo único que este
    // refinador hace distinto de la generación: el CLI se invoca por ruta
    // absoluta, no por el PATH que herede Premiere.
    config: async (cfg) => ({
      binPath: (await claudeDoctor.locate()).path || 'claude',
      timeoutMs: TIMEOUT_MS,
      // Ninguna herramienta: refinar texto no necesita leer ni escribir NADA.
      // Sin esto el CLI puede irse a buscar archivos por su cuenta y pagar
      // turnos que no hacen falta, que es justo lo que se trata de no pagar.
      tools: '',
      // Con qué se autentica el CLI (ver claudeSession.envParaClaude, que el
      // proveedor llama con esta misma config).
      oauthToken: (cfg && cfg.oauthToken) || '',
      apiKey: (cfg && cfg.apiKey) || '',
    }),
  },

  {
    id: 'cursor-cli',
    nombre: 'Cursor (Claude Sonnet)',
    // Se usa cuando el editor lo eligió, y NO como respaldo: medido, cuesta
    // ~6 s y ~9.500 tokens a caché contra los ~2 s de Haiku por la API (ver la
    // cabecera). Coherencia con lo elegido sí; preferirlo habiendo alternativa
    // más barata, no.
    soloSiLoEligen: true,
    async detectar(cfg) {
      const s = await cursorSession.estadoDeSesion(cfg, { timeoutMs: 15_000 });
      if (s.estado === 'con-sesion') return { disponible: true };
      if (s.estado === 'sin-cli') return { disponible: false, motivo: 'no está el CLI de Cursor en esta máquina' };
      if (s.estado === 'sin-sesion') return { disponible: false, motivo: 'el CLI de Cursor está pero sin sesión (corré `cursor-agent login`)' };
      return { disponible: false, motivo: 'no pude comprobar la sesión de Cursor' };
    },
    // Composer y no el modelo de diseño que el editor tenga elegido: refinar no
    // es diseñar, y los `-thinking-` se ponen a razonar antes de contestar dos
    // frases (ver MODELO_CORTO en providers/cursor-cli.js).
    model: () => cursorCli.MODELO_CORTO,
    config: (cfg) => ({
      timeoutMs: TIMEOUT_CURSOR_MS,
      // La misma key que usa la generación, por la misma función (envParaCursor).
      apiKey: (cfg && cfg.apiKey) || '',
    }),
    // Lo que el editor paga por la coherencia, dicho antes de que se note. El
    // panel lo muestra al lado del refinador para que la demora no parezca que
    // algo se colgó, y para que se sepa que ese gasto va al cupo de Cursor y no
    // al contador de la sesión.
    aviso: 'Cursor tarda unos segundos más y gasta tu cupo de Cursor.',
  },

  {
    id: 'openai-compat',
    nombre: 'API compatible (la que configuraste)',
    // Igual que Cursor: solo si lo eligieron. Atrás puede haber cualquier cosa
    // —OpenAI, Gemini, OpenRouter, un servidor propio— con cualquier precio, y
    // meter en el respaldo una llamada cuyo costo no podemos ni estimar sería
    // gastarle plata al editor por una vía que no pidió.
    soloSiLoEligen: true,
    async detectar(cfg) {
      const key = String((cfg && cfg.apiKey) || '').trim();
      const base = String((cfg && cfg.baseUrl) || '').trim();
      if (!base) return { disponible: false, motivo: 'falta la Base URL en ⚙' };
      if (!key) return { disponible: false, motivo: 'falta la API key en ⚙' };
      return { disponible: true, detalle: String((cfg && cfg.model) || '') };
    },
    // El mismo modelo que el editor configuró, y no uno "chico" elegido por
    // nosotros: acá atrás puede haber OpenAI, Gemini, OpenRouter o un servidor
    // propio, y el ID de un hermano más barato (gpt-4o-mini) no existe en la
    // mitad de ellos. Pedir un modelo que no está es fallar seguro; usar el que
    // ya funciona es, además, lo que el editor eligió.
    model: (detalle) => detalle,
    config: (cfg) => ({
      apiKey: (cfg && cfg.apiKey) || '',
      baseUrl: (cfg && cfg.baseUrl) || '',
      maxTokens: 1500,
      timeoutMs: TIMEOUT_MS,
    }),
  },

  {
    id: 'ollama',
    nombre: 'Ollama local',
    async detectar() {
      let lista;
      try {
        const res = await hpFetch(OLLAMA_URL + '/api/tags', { signal: abortar(4000) });
        if (!res.ok) return { disponible: false, motivo: 'Ollama contestó HTTP ' + res.status };
        lista = JSON.parse(await res.text());
      } catch (e) {
        return { disponible: false, motivo: 'Ollama no está corriendo en esta máquina' };
      }
      const modelo = elegirModeloOllama((lista && lista.models) || []);
      if (!modelo) {
        return {
          disponible: false,
          motivo: 'Ollama está corriendo pero no tiene ningún modelo chico de texto instalado (probá `ollama pull llama3.2`)',
        };
      }
      return { disponible: true, detalle: modelo };
    },
    // El modelo lo eligió `detectar` entre los que el editor tiene instalados.
    model: (detalle) => detalle,
    config: () => ({
      baseUrl: OLLAMA_URL,
      timeoutMs: TIMEOUT_OLLAMA_MS,
      // Dos frases entran de sobra en 4k, y pedir 32k de contexto para esto es
      // memoria reservada al pedo.
      numCtx: 4096,
      // Residente diez minutos: el dictado siguiente no vuelve a pagar la carga
      // del modelo. (Generar pide media hora; un dictado no dura tanto.)
      keepAlive: '10m',
      // Refinar no es escribir: la temperatura alta es exactamente por donde se
      // cuela lo que nadie pidió.
      temperature: 0.2,
    }),
  },
];

/**
 * El proveedor de una entrada de la cadena.
 *
 * En producción es siempre `getProvider(id)`: la entrada se llama igual que el
 * proveedor a propósito. `proveedor` es el gancho de los tests, que corren la
 * cadena entera —el orden, la caída al siguiente, el control de lo que vuelve—
 * sin CLI, sin red y sin Ollama. No cambia ningún camino: en el módulo no hay
 * nadie que lo escriba.
 */
function proveedorDe(entrada) {
  return (entrada && entrada.proveedor) || getProvider(entrada.id);
}

function abortar(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/**
 * Cuál de los modelos instalados en Ollama sirve para refinar.
 *
 * Se compara por FAMILIA (lo de antes de los dos puntos), porque el editor
 * puede tener `llama3.2:3b` o `llama3.2:latest` y las dos sirven igual. Si no
 * hay ninguno de la lista, se cae al más chico que haya: es una conjetura, pero
 * un modelo de 30B refinando dos frases tarda minutos (medido: `gemma4:31b`,
 * 103 s en caliente) y eso no es refinar, es esperar.
 */
function elegirModeloOllama(instalados) {
  const utiles = (instalados || []).filter((m) => {
    const n = String((m && m.name) || '');
    if (!n) return false;
    // Los de embeddings no contestan texto, y los de visión son enormes.
    if (/embed|bge-|nomic/i.test(n)) return false;
    return true;
  });
  for (const fam of OLLAMA_PREFERIDOS) {
    const hit = utiles.filter((m) => String(m.name).split(':')[0] === fam)[0];
    if (hit) return hit.name;
  }
  const chico = utiles.slice().sort((a, b) => (a.size || 0) - (b.size || 0))[0];
  // Más de ~10 GB refinando dos frases es peor que no refinar: el editor
  // suelta el botón y espera un minuto y medio mirando el campo.
  if (chico && (chico.size || 0) > 10e9) return null;
  return chico ? chico.name : null;
}

// ---------------------------------------------------------------------------
// La cadena
// ---------------------------------------------------------------------------

// Averiguar quién está cuesta una llamada al CLI de Claude (~250 ms) y una
// consulta a Ollama. Se hace una vez y se guarda: entre dictado y dictado no
// aparece un proveedor nuevo. Se tira al guardar la config, que es lo único
// que puede cambiar la respuesta sin reiniciar el panel.
let elegido = null;

function olvidarRefinador() { elegido = null; }

function refinadorPorId(id) {
  return REFINADORES.filter((r) => r.id === id)[0] || null;
}

/**
 * En qué orden se prueban los refinadores para ESTA configuración.
 *
 * Primero el proveedor que el editor eligió en ⚙ —si tiene refinador—, y
 * después el respaldo, salteando al que ya se probó.
 *
 * El respaldo NO es una lista aparte: es el propio orden de `REFINADORES` sin
 * los que están marcados `soloSiLoEligen`. Tenerlo como una segunda lista de
 * ids era una copia que había que acordarse de mantener, y que además se
 * desincronizaba de cualquiera que reemplazara la cadena (los tests lo hacen).
 * El orden del array ES la política de costo y latencia, escrita una vez.
 *
 * Función pura y aparte porque es LA decisión de este archivo y se puede probar
 * sin CLI, sin red y sin Ollama.
 *
 * @param {string} provider - `cfg.provider`
 * @returns {Array<{id:string, esElegido:boolean}>}
 */
function ordenPara(provider) {
  const elegidoId = String(provider || '').trim();
  const orden = [];
  if (refinadorPorId(elegidoId)) orden.push({ id: elegidoId, esElegido: true });
  REFINADORES.forEach((r) => {
    if (r.id === elegidoId || r.soloSiLoEligen) return;
    orden.push({ id: r.id, esElegido: false });
  });
  return orden;
}

/**
 * El refinador que corresponde en esta máquina, o null.
 *
 * `esElegido` dice si el que salió es el proveedor de ⚙ o un respaldo. No es
 * decorativo: es lo que decide si el panel dice "refinó otro" y, sobre todo, lo
 * que evita mandar a arreglar un proveedor que el editor no eligió.
 *
 * @returns {Promise<{id:string, nombre:string, detalle:string, aviso:string,
 *                    esElegido:boolean, elegidoEra:string, descartados:Array}|null>}
 */
async function elegirRefinador(cfg, opts) {
  if (elegido && !(opts && opts.forzar)) return elegido.ok ? elegido : null;
  const elegidoEra = String((cfg && cfg.provider) || '').trim();
  const descartados = [];
  for (const paso of ordenPara(elegidoEra)) {
    const r = refinadorPorId(paso.id);
    let d;
    try { d = await r.detectar(cfg); }
    catch (e) { d = { disponible: false, motivo: (e && e.message) || String(e) }; }
    // Una cuenta sin cupo tiene credencial y contesta que sí a la detección: el
    // "no puedo" recién aparece al llamar. Si ya nos pasó en esta sesión, el
    // respaldo lo saltea en vez de volver a chocar contra la misma pared —son
    // segundos de latencia por un fallo garantizado— y sigue con el siguiente.
    //
    // SOLO por cupo, y no por credencial rechazada: un 401 puede ser de otra
    // cosa (un modelo que esa cuenta no tiene, una key recién rotada) y dejar a
    // un refinador afuera del respaldo por una sospecha es peor que gastar los
    // segundos. Y solo el RESPALDO: al elegido se lo vuelve a intentar siempre,
    // porque es el que el editor pidió y porque es así como el panel se entera
    // de que ya cargó crédito.
    const enfermo = paso.esElegido ? null : providerSalud.estado(paso.id);
    if (d && d.disponible && enfermo && enfermo.causa === 'cuota') {
      d = { disponible: false, motivo: enfermo.motivo };
    }
    if (d && d.disponible) {
      elegido = {
        ok: true, id: r.id, nombre: r.nombre, detalle: d.detalle || '',
        aviso: r.aviso || '',
        esElegido: paso.esElegido, elegidoEra: elegidoEra,
        descartados: descartados,
      };
      return elegido;
    }
    descartados.push({
      id: r.id, nombre: r.nombre, esElegido: paso.esElegido,
      motivo: (d && d.motivo) || 'no disponible',
    });
  }
  elegido = { ok: false, elegidoEra: elegidoEra, descartados: descartados };
  return null;
}

/**
 * Por qué no hay refinador, en una frase que se pueda mostrar.
 *
 * El del editor va PRIMERO y con su nombre, porque es el único sobre el que
 * tiene sentido pedirle que haga algo. Los demás se cuentan como lo que son
 * —los que se probaron después— y no como una lista de deberes: mandar a
 * instalar Ollama o a loguearse en Claude a alguien que eligió Cursor es
 * exactamente lo que no hay que hacer.
 */
function porQueNoHayRefinador() {
  if (!elegido || elegido.ok) return '';
  const suyo = elegido.descartados.filter((d) => d.esElegido)[0];
  const otros = elegido.descartados.filter((d) => !d.esElegido);
  const partes = [];
  if (suyo) partes.push('El proveedor que elegiste (' + suyo.nombre + ') no puede: ' + suyo.motivo + '.');
  if (otros.length) {
    partes.push('Tampoco pudo el respaldo (' + otros.map((d) => d.nombre + ': ' + d.motivo).join(' · ') + ').');
  }
  return partes.join(' ');
}

/**
 * Cómo se nombra al que refinó.
 *
 * Cuando NO es el proveedor elegido hay que decirlo: al editor le apareció un
 * texto en el campo y tiene derecho a saber quién lo escribió, sobre todo si es
 * otro modelo del que eligió. Lo que no se hace acá es sugerirle que arregle
 * nada: que el respaldo haya entrado es información, no una tarea.
 */
function comoSeLlamaElQueRefino(cual) {
  const base = cual.nombre + (cual.detalle ? ' · ' + cual.detalle : '');
  return cual.esElegido ? base : base + ' (respaldo)';
}

/**
 * Cómo arranca el aviso de "no se pudo".
 *
 * Es lo único que se dice distinto según de dónde salió el texto, y hace falta
 * decirlo distinto: "quedó el dictado sin refinar" sobre un párrafo que el
 * editor tecleó nombra algo que no pasó, y encima suena a que se perdió lo
 * suyo, que es exactamente lo que NO ocurre (el panel no le toca el campo).
 */
function noSePudo(origen) {
  return origen === 'escrito'
    ? 'No se pudo refinar lo que escribiste (tu texto quedó como estaba): '
    : 'Quedó el dictado sin refinar: ';
}

/**
 * Refina un dictado —o lo que el editor escribió a mano, con `origen:
 * 'escrito'`—. NUNCA lanza y NUNCA devuelve un campo vacío: si no se pudo
 * refinar, vuelve el crudo con el motivo, que es lo que hace que el dictado
 * siga sirviendo en una máquina sin ningún proveedor.
 *
 * El camino es UNO solo para los dos orígenes a propósito: la cadena de
 * refinadores, el control de tamaño y el gasto que se informa son los mismos.
 * Refinar es refinar, lo haya escrito una persona o Whisper.
 *
 * @param {{crudo:string, previo?:string, origen?:string}} body
 * @param {object} cfg - la config plana del motor
 * @returns {Promise<{ok:boolean, texto:string, crudo:string, refinador:string, ms:number, usage?:object, aviso?:string}>}
 */
async function refinarDictado(body, cfg) {
  const crudo = String((body && body.crudo) || '').trim();
  const previo = String((body && body.previo) || '').trim();
  const origen = String((body && body.origen) || '') === 'escrito' ? 'escrito' : 'dictado';
  const juntos = previo ? (previo + ' ' + crudo).trim() : crudo;
  if (!crudo) {
    return {
      ok: false, texto: previo, crudo: '', refinador: '', ms: 0,
      aviso: origen === 'escrito' ? 'El campo está vacío: no hay nada que refinar.' : 'No se dictó nada.',
    };
  }

  const cual = await elegirRefinador(cfg);
  if (!cual) {
    return {
      ok: false, texto: juntos, crudo: crudo, refinador: '', ms: 0,
      aviso: noSePudo(origen) + 'no hay ningún refinador disponible en esta máquina. ' +
        porQueNoHayRefinador(),
    };
  }

  const quien = REFINADORES.filter((r) => r.id === cual.id)[0];
  const t0 = Date.now();
  let salida;
  try {
    salida = await proveedorDe(quien).complete({
      systemPrompt: SISTEMA,
      userPrompt: armarPedido(crudo, previo, origen),
      model: quien.model(cual.detalle),
      config: await quien.config(cfg, cual.detalle),
    });
  } catch (e) {
    // Que se sepa para la próxima. Un "sin cupo" no se arregla reintentando, y
    // el indicador de ⚙ tiene que dejar de decir que ese proveedor está listo
    // (ver provider-salud.js): es el caso del editor con el semáforo en verde y
    // `Credit balance is too low` abajo.
    providerSalud.anotar(cual.id, cliErrors.causa(String((e && e.message) || e)),
      String((e && e.message) || e));
    return {
      ok: false, texto: juntos, crudo: crudo,
      refinador: comoSeLlamaElQueRefino(cual), ms: Date.now() - t0,
      // El motivo llega entero del proveedor y puede ser largo (el del CLI trae
      // el "Qué hacer" y después lo que escribió el proceso). Se corta porque
      // esto se lee en una línea abajo del micrófono, y lo que importa —el
      // diagnóstico y el próximo paso— va adelante.
      aviso: noSePudo(origen) + comoSeLlamaElQueRefino(cual) + ' falló (' +
        String((e && e.message) || e).slice(0, 400) + ').',
    };
  }
  const ms = Date.now() - t0;
  const texto = limpiar(salida.text);
  const control = verificar(texto, juntos);
  if (!control.ok) {
    return {
      ok: false, texto: juntos, crudo: crudo,
      refinador: comoSeLlamaElQueRefino(cual), ms: ms, usage: salida.usage,
      aviso: noSePudo(origen) + control.motivo + ' (' + comoSeLlamaElQueRefino(cual) + ').',
    };
  }
  return {
    ok: true, texto: texto, crudo: crudo,
    refinador: comoSeLlamaElQueRefino(cual),
    ms: ms, usage: salida.usage,
    // Solo cuando hay algo que aclarar: que refinó otro (y cuál era el elegido),
    // o lo que este refinador cuesta. Es un dato, no una advertencia.
    aviso: cual.esElegido
      ? (cual.aviso || '')
      : ('Refinó el respaldo: el proveedor que elegiste no pudo. ' + porQueNoPudoElElegido()).trim(),
  };
}

/** El motivo del elegido, y solo el suyo, para contarlo en una línea. */
function porQueNoPudoElElegido() {
  if (!elegido || !elegido.descartados) return '';
  const suyo = elegido.descartados.filter((d) => d.esElegido)[0];
  return suyo ? '(' + suyo.nombre + ': ' + suyo.motivo + ')' : '';
}

module.exports = {
  refinarDictado,
  elegirRefinador,
  olvidarRefinador,
  porQueNoHayRefinador,
  SISTEMA,
  // Expuestos para los tests: son las decisiones puras de este archivo.
  _ordenPara: ordenPara,
  _verificar: verificar,
  _limpiar: limpiar,
  _armarPedido: armarPedido,
  _elegirModeloOllama: elegirModeloOllama,
  _REFINADORES: REFINADORES,
};
