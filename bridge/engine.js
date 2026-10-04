'use strict';

/**
 * Motor "todo en uno" de HyperPremiere.
 *
 * Contiene la orquestación (generar / feedback / derivar objetivo / config /
 * login) SIN servidor HTTP, para poder ejecutarse directamente DENTRO del panel
 * CEP (que tiene Node.js habilitado). Reusa los mismos módulos probados que el
 * puente: providers, prompt, render y store.
 *
 * Cada función devuelve una Promise y no depende de ningún proceso externo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getProvider, leeArchivos } = require('./providers');
// fetch respaldado por el https nativo de Node (no el Chromium del panel CEP).
const { hpFetch } = require('./providers/http');
// Spawn de procesos externos (git, claude, npm, unzip): nunca lanza.
const { run, salidaDe } = require('./exec');
// Transcripción local de la secuencia con Whisper (sin nube, sin tokens).
const { transcribeMedia, cancelTranscription, whisperStatus, hasAudioStream } = require('./transcribe');
// Instalar Whisper desde el panel (parte del mismo flujo de "preparar motor").
const { whisperInstallPlan, installWhisper, cancelWhisperInstall } = require('./whisper-install');
// Dictado por voz: micrófono → texto en el campo. Usa OTRO Whisper (small, en
// un proceso que queda vivo) para no competir con la transcripción de clases.
const dictado = require('./dictado');
const dictadoRefinar = require('./dictado-refinar');
// El micrófono del dictado: qué dispositivos hay y la prueba con medidor de ⚙.
const microfono = require('./dictado-microfono');
// Login de Claude en dos fases (URL + código) o token pegado directo.
const claudeLogin = require('./claude-login');
// Dónde está el CLI de Claude y qué versión es (diagnóstico para el editor).
const claudeDoctor = require('./claude-doctor');
// Si el CLI puede autenticarse acá y ahora: lo que mira el cartel de ⚙.
const claudeSession = require('./claude-session');
// Qué modelos, ventanas y niveles ofrece el CLI de Claude, y la medición que lo
// sabe (ver claude-modelos.js, la mitad que decide, y claude-medir.js).
const claudeModelos = require('./claude-modelos');
const claudeMedir = require('./claude-medir');
// Lo mismo para Cursor, que hasta la 1.5.0 no tenía nada de esto: un editor que
// elegía Cursor y fallaba veía el error crudo del proceso y ningún camino.
const cursorSession = require('./cursor-session');
// Lo que ya nos pasó con cada proveedor en esta sesión (sin cupo, credencial
// rechazada): el semáforo de ⚙ no puede seguir en verde después de eso.
const providerSalud = require('./provider-salud');
const cliErrors = require('./providers/cli-errors');
const {
  buildUserPrompt, generalPromptLabel, promptLevels, objectiveLabel,
} = require('./prompt/build-context');
// Las MENCIONES de una referencia dentro de lo que escribió el editor
// (`@[curso/logo.svg]`) y su traducción al número que el modelo ya entiende.
const menciones = require('./prompt/menciones');
const { buildObjectivePrompt } = require('./prompt/objective');
const { renderLanes } = require('./render/hyperframes');
// Los MOTORES de animación. Este archivo ya no habla de GSAP ni de React: le
// pide al motor que corresponda su prompt, su contrato y su render.
//
// Cuál corresponde depende de QUÉ se está haciendo, y la distinción importa:
//   - lo NUEVO (Generar, Regenerar desde cero) usa el motor de ⚙;
//   - lo que YA EXISTE (refinar, corregir, re-renderizar, editar a mano) usa el
//     motor con el que nació esa versión, que viaja en su ficha.
// Cambiar el selector no reinterpreta el trabajo hecho: un HTML de la semana
// pasada no se vuelve React porque hoy el editor eligió Remotion.
const motores = require('./render');
// Conseguir una composición renderizable (escalera de llamadas al modelo).
const { composeAnimation } = require('./compose');
// Qué se puede hacer con una versión que YA está en disco: abrirla en el editor,
// mirarla sin renderizar, renderizar lo editado a mano, o re-renderizarla. Era
// un bloque contiguo de este archivo y es su propio módulo (ver versiones.js).
const versiones = require('./versiones');
const {
  slugify,
  ensureOutputDir,
  outputDirPath,
  projectRootPath,
  paths,
  readMeta,
  // La ficha de cada versión (.meta.json). Su forma la declara project-fs una
  // sola vez: acá se dice QUÉ va en cada caso, no cómo se escribe.
  writeVersionMeta,
  mergeVersionMeta,
  // El estilo del curso: dos archivos de texto al lado del .prproj. Acá solo se
  // registran como handlers; el I/O vive con el resto del de esa carpeta.
  loadGeneralPrompt,
  saveGeneralPrompt,
  // Las referencias de esos dos niveles, también en archivos del proyecto: el
  // bloque del curso promete "viaja con el .prproj" y eso incluye lo que se le
  // arrastra adentro.
  referencesDirPath,
  loadReferences,
  addReference,
  removeReference,
  setReferenceUse,
  lastComposition,
  composicionDeVersion,
  saveStills,
  saveResources,
  // Con qué nombre queda un adjunto en el disco. Lo necesita el estimado, que
  // tiene que clasificarlo por su extensión sin escribirlo.
  resourceFileName,
} = require('./store/project-fs');
// Nomenclatura versionada ("<slug> vN [modelo].ext"): parse/format canónicos.
const { versionFile, nextVersion, listVersions, groupBySlug } = require('./store/versions');

const IS_WIN = process.platform === 'win32';

// CEP corre Node con un PATH mínimo (apps de GUI no heredan el shell).
// Las apps de GUI arrancan con un PATH mínimo, así que el panel no ve los
// binarios que el editor sí tiene (ffmpeg, node/npm, git, claude, whisper).
// Pasa igual en mac y en Windows: la idea de que "en Windows el instalador ya
// los deja en el PATH" no se sostiene — pip mete sus scripts en un directorio
// con el número de versión adentro y npm en %APPDATA%\npm, y ninguno de los dos
// llega al proceso de Premiere de forma confiable.
//
// Diferencia entre plataformas: en mac las rutas van ADELANTE (son las
// canónicas de Homebrew y compañía); en Windows van ATRÁS, porque son conjeturas
// sobre dónde pudo instalarse cada cosa y no queremos tapar lo que el editor
// eligió a propósito.

// Directorios donde Windows suele dejar lo que necesitamos. Solo conjeturas:
// se filtran por existencia antes de entrar al PATH.
function windowsExtraPaths() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const out = [
    // El instalador nativo de Claude Code (el recomendado hoy: `irm
    // https://claude.ai/install.ps1 | iex`) deja claude.exe ACÁ, no en npm.
    // Faltaba, y es justo el binario del que depende el login.
    path.join(home, '.local', 'bin'),
    path.join(appData, 'npm'),                              // binarios globales de npm (claude.cmd)
    path.join(programFiles, 'nodejs'),
    path.join(programFiles, 'Git', 'cmd'),
    path.join(localAppData, 'Programs', 'cursor-agent'),
    path.join(localAppData, 'Microsoft', 'WindowsApps'),
    'C:\\ProgramData\\chocolatey\\bin',                     // choco
    path.join(home, 'scoop', 'shims'),                      // scoop
    'C:\\ffmpeg\\bin',                                      // la descarga manual de siempre
  ];
  // pip deja los ejecutables en un directorio con la versión en el nombre
  // (…\Python313\Scripts), así que hay que mirar qué hay en vez de adivinar.
  for (const base of [path.join(localAppData, 'Programs', 'Python'), path.join(appData, 'Python')]) {
    try {
      for (const d of fs.readdirSync(base)) {
        if (/^Python\d+/i.test(d)) out.push(path.join(base, d, 'Scripts'));
      }
    } catch (e) {}
  }
  return out;
}

(function ensurePath() {
  const home = os.homedir();
  const sep = IS_WIN ? ';' : ':';
  const extra = IS_WIN
    ? windowsExtraPaths().filter((p) => { try { return fs.existsSync(p); } catch (e) { return false; } })
    : ['/opt/homebrew/bin', path.join(home, '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const current = (process.env.PATH || '').split(sep).filter(Boolean);
  const ordered = IS_WIN ? current.concat(extra) : extra.concat(current);
  const merged = [];
  for (const p of ordered) if (p && merged.indexOf(p) === -1) merged.push(p);
  process.env.PATH = merged.join(sep);
})();

/**
 * Dónde vive la config de esta máquina.
 *
 * Se resuelve CADA VEZ y no una sola al cargar el módulo. Parece un detalle y no
 * lo es: varios tests mueven `process.env.HOME` a un temporal justo para no
 * escribirle la config al editor que esté corriéndolos, y con la ruta calculada
 * al cargar, ese `HOME` no cambiaba nada — el primer archivo de la suite que
 * pedía el motor la fijaba con el HOME real y los demás escribían ahí igual.
 *
 * No era teórico: en el `~/.hyperpremiere/config.json` de esta máquina había un
 * `apiKey: "sk-nueva"` puesto por `test/dictado-refinar.test.js` y el modelo
 * cambiado a `falso` por `test/menciones.test.js`. Correr los tests le cambiaba
 * el proveedor y el modelo al panel, y ninguno fallaba por eso.
 *
 * Que cueste dos `path.join` por lectura no se mide: la config se toca una vez
 * por generación, no por cuadro.
 */
function configDir() { return path.join(os.homedir(), '.hyperpremiere'); }
function configPath() { return path.join(configDir(), 'config.json'); }
const DEFAULT_PROVIDER = 'claude-cli';

// Modelo por defecto por proveedor. Vacío = el editor lo define (API compat / Ollama).
function defaultModelFor(provider) {
  // Por el CLI, el ALIAS y no un ID: "claude-sonnet-5" era el último Sonnet
  // cuando se escribió y hoy es una versión anterior fija. El alias avanza solo
  // con el CLI (ver claude-modelos.js). La API no entiende alias: ahí va el ID.
  if (provider === 'claude-cli') return 'sonnet';
  if (provider === 'claude-api') return 'claude-sonnet-5';
  // En Cursor el nivel de pensamiento va DENTRO del ID del modelo.
  if (provider === 'cursor-cli') return 'claude-sonnet-5-thinking-high';
  return '';
}

// Proveedores donde el esfuerzo es un flag aparte. En Cursor no: viene en el ID
// del modelo, así que el selector de esfuerzo no aplica y el panel lo esconde.
// ¿El nivel de pensamiento viaja como FLAG aparte? Solo en Claude. En Cursor el
// nivel existe igual, pero va dentro del ID del modelo, así que el panel lo
// ofrece por su cuenta (ver cursorGroups en config-ui.js): esto no dice "no
// tiene esfuerzo", dice "no se manda por este canal".
function usesEffortFlag(provider) {
  return provider === 'claude-cli' || provider === 'claude-api';
}

// Nivel de pensamiento (esfuerzo) de los modelos Claude. Es el control de
// calidad: con "adaptive thinking" el modelo decide cuánto razonar y esto es el
// techo. En el CLI va como `--effort`; en la API como `output_config.effort`.
// `budget_tokens` (el mecanismo viejo) da 400 en Opus 4.7+.
//
// 'default' no es un nivel: es "no lo mandes y que decida el modelo". Tiene
// nombre propio porque el vacío ya significaba otra cosa —"nunca se eligió",
// que se resuelve a 'high'— y los dos tienen que poder guardarse distinto.
const EFFORT_LEVELS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_EFFORT = 'high'; // el default de Anthropic

function normalizeEffort(value) {
  const v = String(value || '').trim().toLowerCase();
  return EFFORT_LEVELS.indexOf(v) === -1 ? DEFAULT_EFFORT : v;
}

// Lee la config CRUDA del disco y la normaliza a la forma v2 (por proveedor):
//   { provider, oauthToken, perProvider: { <name>: { model, apiKey, baseUrl } } }
// Migra el formato viejo plano (model/apiKey/baseUrl arriba) sin perder nada.
function loadRawConfig() {
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(configPath(), 'utf8')) || {}; } catch (e) {}

  const raw = {
    provider: stored.provider && String(stored.provider).trim() ? stored.provider : DEFAULT_PROVIDER,
    oauthToken: stored.oauthToken || '',
    // Compartido por los dos proveedores Claude (CLI y API): es "cuánto querés
    // que piense", no una credencial de un slot.
    effort: normalizeEffort(stored.effort),
    // El micrófono del dictado, por NOMBRE ('' = el del sistema). Es de la
    // máquina, como el resto de este archivo, no del proyecto ni del proveedor.
    microfono: String(stored.microfono || '').trim(),
    // El MOTOR de animación con el que se genera lo nuevo. Está al lado del
    // micrófono y no adentro de `perProvider` porque no es del proveedor:
    // cualquier modelo puede escribir para cualquiera de los dos motores, y
    // cambiar de Claude a Cursor no tiene por qué cambiar el lenguaje en el que
    // se compone. Un id que este panel no conoce se resuelve al de siempre, no
    // tira (ver motor() en render/motores.js).
    renderEngine: String(stored.renderEngine || '').trim() || motores.PREDETERMINADO,
    perProvider: (stored.perProvider && typeof stored.perProvider === 'object') ? stored.perProvider : {},
  };

  // Migración del formato viejo: campos planos → slot del proveedor activo.
  if (!stored.perProvider && (stored.model || stored.apiKey || stored.baseUrl)) {
    raw.perProvider[raw.provider] = {
      model: stored.model || defaultModelFor(raw.provider),
      apiKey: stored.apiKey || '',
      baseUrl: stored.baseUrl || '',
    };
  }
  return raw;
}

function saveRawConfig(raw) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(raw, null, 2), 'utf8');
}

// Vista PLANA del proveedor activo (lo que consumen los providers): incluye
// model/apiKey/baseUrl del slot activo + oauthToken (compartido por Claude).
function loadConfig() {
  const raw = loadRawConfig();
  const slot = raw.perProvider[raw.provider] || {};
  const model = (slot.model && String(slot.model).trim()) ? slot.model : defaultModelFor(raw.provider);
  return {
    provider: raw.provider,
    model,
    apiKey: slot.apiKey || '',
    baseUrl: slot.baseUrl || '',
    oauthToken: raw.oauthToken || '',
    effort: raw.effort,
    microfono: raw.microfono || '',
    renderEngine: raw.renderEngine,
    perProvider: raw.perProvider,
  };
}

// Guarda SOLO el slot del proveedor indicado (no toca los otros → cambiar de
// modelo/proveedor nunca borra las credenciales del anterior).
function saveConfig(patch) {
  patch = patch || {};
  const raw = loadRawConfig();
  const provider = (patch.provider && String(patch.provider).trim()) ? patch.provider : raw.provider;
  raw.provider = provider;
  const slot = Object.assign({ model: '', apiKey: '', baseUrl: '' }, raw.perProvider[provider] || {});

  if (patch.model !== undefined && patch.model !== null && String(patch.model).trim()) {
    slot.model = String(patch.model);
  }
  if (patch.apiKey !== undefined && patch.apiKey !== null) {
    const v = String(patch.apiKey);
    if (v && !v.startsWith('••••')) slot.apiKey = v; // no pisar con la máscara
  }
  if (patch.baseUrl !== undefined && patch.baseUrl !== null) {
    slot.baseUrl = String(patch.baseUrl);
  }
  if (patch.effort !== undefined && patch.effort !== null && String(patch.effort).trim()) {
    raw.effort = normalizeEffort(patch.effort);
  }
  // '' es una elección válida: "volvé al del sistema". Por eso no se filtra el vacío.
  if (patch.microfono !== undefined && patch.microfono !== null) {
    raw.microfono = String(patch.microfono).trim();
  }
  // El motor solo se guarda si el panel LO CONOCE. No es defensa contra el
  // editor —el desplegable ofrece los que hay— sino contra dejar escrito en el
  // disco un id que no existe: el que lee tolera eso cayendo al motor de
  // siempre, y entonces ⚙ mostraría "HyperFrames" mientras el archivo dice otra
  // cosa, y el próximo que lo lea no sabría cuál de los dos le está mintiendo.
  if (patch.renderEngine !== undefined && motores.existe(patch.renderEngine)) {
    raw.renderEngine = String(patch.renderEngine).trim().toLowerCase();
  }
  raw.perProvider[provider] = slot;
  saveRawConfig(raw);
  // Guardar la config es lo único que puede cambiar QUÉ refina el dictado sin
  // reiniciar el panel (pegar una API key, por ejemplo). Sin esto, el editor
  // configura la key y el dictado sigue refinando con lo de antes hasta que
  // cierre Premiere.
  dictadoRefinar.olvidarRefinador();
  // Y se olvida lo que sabíamos de ese proveedor: pegar una API key nueva o
  // cambiar de modelo es "probá de nuevo". Hacerle repetir el error para
  // convencer al panel de que ya cargó crédito sería absurdo.
  providerSalud.olvidar(provider);
  return maskConfig(loadConfig());
}

function maskConfig(cfg) {
  return {
    provider: cfg.provider,
    model: cfg.model,
    baseUrl: cfg.baseUrl || '',
    apiKey: cfg.apiKey ? '••••' : '',
    hasSession: Boolean(cfg.oauthToken),
    effort: cfg.effort || DEFAULT_EFFORT,
    usesEffort: usesEffortFlag(cfg.provider),
    microfono: cfg.microfono || '',
    // Qué motor está elegido y qué motores hay, con su estado de instalación.
    // Los dos juntos porque el desplegable de ⚙ necesita las dos cosas para
    // dibujarse una vez, y porque el estado es lo que decide si al lado va el
    // botón de instalar: preguntarlo por separado dejaba un parpadeo en el que
    // Remotion aparecía como disponible antes de saber si estaba.
    renderEngine: cfg.renderEngine || motores.PREDETERMINADO,
    motores: motores.catalogo(),
  };
}

function getConfig() {
  return maskConfig(loadConfig());
}

// Prueba REAL de las credenciales del proveedor activo. A diferencia del semáforo
// del panel (que solo mira si hay algo guardado), esto verifica de verdad:
//   - claude-api: llamada mínima (max_tokens:1) al endpoint → distingue key mala (401)
//     de modelo inexistente (404) de key OK (200).
//   - claude-cli: le pregunta al CLI si puede autenticarse (`claude auth status`).
// Devuelve { ok, error?, detail?, unknown? } y nunca lanza.
async function testProvider() {
  const cfg = loadConfig();
  const provider = cfg.provider;
  try {
    if (provider === 'claude-cli') {
      // No alcanza con mirar si NOSOTROS guardamos un token: el CLI puede tener
      // su propia sesión (`claude auth login` en la terminal) y generar sin el
      // nuestro. Se le pregunta a él, con el entorno con el que va a generar.
      const s = await claudeSession.estadoDeSesion(cfg);
      if (s.estado === 'con-sesion') return { ok: true, detail: s.resumen.replace(/^✓\s*/, '') };
      // "No pude averiguarlo" no es ni un sí ni un no, y decirlo como si fuera
      // cualquiera de los dos es peor que decirlo como lo que es.
      if (s.estado === 'no-se-sabe') return { ok: true, unknown: true, detail: s.resumen };
      return { ok: false, error: s.resumen + '\n' + s.detalle };
    }

    if (provider === 'cursor-cli') {
      // La prueba real es listar modelos: eso solo funciona si el binario está
      // y la máquina tiene sesión de Cursor (o CURSOR_API_KEY).
      const cursorCli = require('./providers/cursor-cli');
      const r = await cursorCli.listModels(cfg);
      if (!r.ok) {
        // El mensaje sale de preguntarle a la máquina, no de un texto fijo: "no
        // está instalado", "está pero sin sesión" y "está, con sesión, y falló
        // por otra cosa" son tres problemas con tres próximos pasos distintos, y
        // durante mucho tiempo los tres se contaron con el mismo cartel y los
        // dos comandos pegados (ver cursor-session.mensajeDeFalla).
        return { ok: false, error: await cursorSession.mensajeDeFalla(cfg, r.error) };
      }
      const has = r.models.some((m) => m.id === cfg.model);
      return {
        ok: true,
        detail: 'Sesión de Cursor activa · ' + r.models.length + ' modelos disponibles' +
          (cfg.model && !has ? ' (ojo: "' + cfg.model + '" no está en la lista)' : ''),
      };
    }

    if (provider === 'claude-api') {
      const claudeApi = require('./providers/claude-api');
      const key = claudeApi.normalizeApiKey(cfg.apiKey);
      if (!key) return { ok: false, error: 'Falta la API key.' };
      if (/^sk-ant-oat/i.test(key)) {
        return { ok: false, error: 'Eso es un token de suscripción (sk-ant-oat…), no una API key. Cambiá el proveedor a "Claude (CLI / suscripción)" o pegá una API key real (sk-ant-api03-…).' };
      }

      const model = cfg.model || claudeApi.DEFAULT_MODEL;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      let res;
      try {
        res = await hpFetch(claudeApi.API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': claudeApi.API_VERSION,
          },
          body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) return { ok: true, detail: 'API key válida · modelo "' + model + '" OK.' };
      const raw = await res.text();
      if (res.status === 401) {
        return { ok: false, error: 'API key inválida (401). Revisá que sea correcta, de una cuenta activa y con saldo.' };
      }
      if (res.status === 404 || (res.status === 400 && /model/i.test(raw))) {
        return { ok: false, error: 'La API key es válida, pero el modelo "' + model + '" no existe en la API. Elegí otro modelo.' };
      }
      return { ok: false, error: 'HTTP ' + res.status + ': ' + raw.slice(0, 200) };
    }

    // openai-compat / ollama: no hacemos prueba profunda acá.
    return { ok: true, skipped: true, detail: 'Sin prueba automática para este proveedor.' };
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? 'timeout (15s) — ¿hay conexión?' : ((e && e.message) || String(e));
    return { ok: false, error: 'No se pudo probar: ' + msg };
  }
}

// ── Transcript persistido por secuencia ──────────────────────────────
// El disco es la FUENTE DE VERDAD, no el localStorage del panel: así el
// transcript sobrevive a cerrar Premiere, a que se limpie la caché de CEP y a
// mover el proyecto de máquina. Un archivo por secuencia, siempre el mismo
// nombre: generar de nuevo o importar otro JSON lo reemplaza.
const TRANSCRIPT_FILE = 'transcript.json';
// Nombre que se usaba antes (solo lo escribía Whisper). Se sigue leyendo para no
// perder los transcripts de las secuencias que ya existen.
const TRANSCRIPT_FILE_LEGACY = 'transcript-whisper.json';

// Dónde VA el transcript de una secuencia. Son dos funciones y no una porque la
// ruta la piden los dos lados y no quieren lo mismo: el que va a escribir
// necesita la carpeta creada, y el que solo viene a mirar si hay algo no puede
// dejarla hecha al pasar. Mientras fue una sola —la que crea, que usaban los
// dos—, abrir el panel sobre un proyecto donde nunca se generó nada dejaba la
// carpeta de la secuencia vacía al lado del .prproj, y esa carpeta viaja con el
// proyecto a las otras máquinas.

/** Los dos nombres posibles, del nuevo al viejo, sin crear nada. */
function transcriptCandidates(projectPath, sequenceName) {
  const dir = outputDirPath(projectPath, sequenceName);
  return [
    { file: path.join(dir, TRANSCRIPT_FILE), legacy: false },
    { file: path.join(dir, TRANSCRIPT_FILE_LEGACY), legacy: true },
  ];
}

/** El nombre canónico con la carpeta ya creada: solo para escribir. */
function ensureTranscriptPath(projectPath, sequenceName) {
  return path.join(ensureOutputDir(projectPath, sequenceName), TRANSCRIPT_FILE);
}

/**
 * Guarda el transcript de una secuencia. `body` = { projectPath, sequenceName,
 * segments, offset?, language?, tool?, source? }.
 * Devuelve { ok, path, count } y no lanza.
 */
function saveTranscript(body) {
  body = body || {};
  const segments = Array.isArray(body.segments) ? body.segments : [];
  if (!segments.length) return { ok: false, error: 'no hay segmentos que guardar' };
  try {
    const file = ensureTranscriptPath(body.projectPath, body.sequenceName);
    fs.writeFileSync(file, JSON.stringify({
      sequenceName: String(body.sequenceName || ''),
      source: String(body.source || ''),
      language: String(body.language || ''),
      tool: String(body.tool || ''),
      // El desfase es parte del estado: sin él, al recargar habría que volver a
      // calibrarlo a mano.
      offset: Number(body.offset) || 0,
      savedAt: new Date().toISOString(),
      segments,
    }, null, 2), 'utf8');
    return { ok: true, path: file, count: segments.length };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * Lee el transcript guardado de una secuencia, si hay.
 * Devuelve { ok:true, found:false } cuando no existe (no es un error).
 */
function loadTranscript(body) {
  body = body || {};
  try {
    // Consulta de solo lectura: el panel la hace al abrir cada secuencia, así
    // que va por el camino que no crea la carpeta.
    for (const c of transcriptCandidates(body.projectPath, body.sequenceName)) {
      if (!fs.existsSync(c.file)) continue;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(c.file, 'utf8'));
      } catch (e) {
        continue; // archivo corrupto: probamos el siguiente candidato
      }
      const segments = Array.isArray(data && data.segments) ? data.segments : [];
      if (!segments.length) continue;
      return {
        ok: true, found: true, segments,
        offset: Number(data.offset) || 0,
        language: data.language || '',
        tool: data.tool || '',
        source: data.source || '',
        savedAt: data.savedAt || '',
        path: c.file,
        legacy: c.legacy,
      };
    }
    return { ok: true, found: false };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * Cuáles de estas secuencias ya tienen transcript en disco. Liviano a propósito
 * (no devuelve los segmentos): la vista de la Cola lo usa para marcar con ✓ las
 * secuencias listas, y puede haber muchas.
 * `body` = { projectPath, sequenceNames: string[] }.
 */
function transcriptSummary(body) {
  body = body || {};
  const names = Array.isArray(body.sequenceNames) ? body.sequenceNames : [];
  const byName = {};
  for (const name of names) {
    try {
      // Sin crear la carpeta: esto es una consulta, y muchas de las secuencias
      // preguntadas pueden no tener nada generado todavía.
      const dir = outputDirPath(body.projectPath, name);
      let found = null;
      for (const file of [TRANSCRIPT_FILE, TRANSCRIPT_FILE_LEGACY]) {
        const p = path.join(dir, file);
        if (fs.existsSync(p)) { found = p; break; }
      }
      if (!found) { byName[name] = { found: false, count: 0 }; continue; }
      const data = JSON.parse(fs.readFileSync(found, 'utf8'));
      const segs = Array.isArray(data && data.segments) ? data.segments : [];
      byName[name] = { found: segs.length > 0, count: segs.length };
    } catch (e) {
      byName[name] = { found: false, count: 0, error: (e && e.message) || String(e) };
    }
  }
  return { ok: true, byName };
}

/**
 * Modelos que la suscripción de Cursor tiene disponibles, para el selector del
 * panel. Se cachea igual que la lista de Claude: llamar al CLI cuesta ~1s.
 */
let cursorModelsCache = { at: 0, models: [] };

async function listCursorModels(opts) {
  const force = Boolean(opts && opts.force);
  const now = Date.now();
  if (!force && cursorModelsCache.models.length && (now - cursorModelsCache.at) < MODELS_TTL_MS) {
    return { ok: true, models: cursorModelsCache.models, cached: true };
  }
  const cursorCli = require('./providers/cursor-cli');
  const r = await cursorCli.listModels(loadConfig());
  if (!r.ok) return r;
  cursorModelsCache = { at: now, models: r.models };
  return { ok: true, models: r.models };
}

// Ruta temporal para el audio que exporta Premiere antes de transcribirlo.
// La da el motor (no el panel) para que sea correcta también en Windows; el
// archivo se borra solo al terminar la transcripción.
function newTempAudioPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-seqaudio-'));
  return { ok: true, path: path.join(dir, 'sequence.wav') };
}

// ¿El video que estamos por colocar trae audio? Lo pregunta el panel JUSTO antes
// de mandarlo a Premiere: el host usa la respuesta para agregar pista de audio
// solo cuando hace falta (una animación con alpha es muda, y agregarle una pista
// le reacomoda la secuencia al editor). Se responde acá porque ExtendScript no
// puede abrir el archivo y ffprobe sí — es el mismo hasAudioStream que usa la
// transcripción. Si no se puede saber (sin ffprobe), `ok: false` y el panel
// asume mudo, que es lo que no toca nada.
async function mediaHasAudio(body) {
  const p = (body && body.path) || '';
  if (!p) return { ok: false, hasAudio: false, error: 'falta la ruta del archivo' };
  const has = await hasAudioStream(p);
  return { ok: has !== null, hasAudio: has === true };
}

// ── Modelos de Anthropic disponibles de verdad ───────────────────────
// Antes la lista estaba hardcodeada en el panel: cada modelo nuevo (Opus 5…)
// había que agregarlo a mano y no aparecía. Ahora se pregunta a Anthropic.
const CLAUDE_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100';
// Header beta que habilita el token de suscripción (sk-ant-oat…) contra la API.
const OAUTH_BETA = 'oauth-2025-04-20';
const MODELS_TTL_MS = 10 * 60 * 1000;
let claudeModelsCache = { at: 0, models: [] };

// Haiku queda fuera a propósito: es el más rápido pero no da buenos diseños.
function isUsableClaudeModel(id) {
  return !/haiku/i.test(String(id || ''));
}

/**
 * Modelos Claude disponibles para la cuenta activa (GET /v1/models).
 * Autentica con la API key si hay, o con el token de suscripción (Bearer +
 * header beta). Devuelve { ok, models: [{ id, name, maxInputTokens }], cached? }
 * y no lanza. Si falla (sin red, sin credenciales), devuelve ok:false y el panel
 * se queda con su lista de respaldo.
 *
 * `maxInputTokens` es la ventana de contexto que informa la propia API
 * (`max_input_tokens`). Viaja porque es el único lugar de todo el panel donde
 * ese número llega de la fuente en vez de una tabla nuestra: cuando está, el
 * selector de ⚙ le hace caso. Puede venir null o 0 —la respuesta lo admite— y
 * ahí el panel se cae a la tabla, que es el caso normal por CLI.
 */
async function listClaudeModels(opts) {
  const force = Boolean(opts && opts.force);
  const now = Date.now();
  if (!force && claudeModelsCache.models.length && (now - claudeModelsCache.at) < MODELS_TTL_MS) {
    return { ok: true, models: claudeModelsCache.models, cached: true };
  }

  const cfg = loadConfig();
  const apiKey = String(cfg.apiKey || '').trim();
  const headers = { 'anthropic-version': '2023-06-01' };
  // La API key es una credencial de API real; el token OAuth necesita el beta.
  if (apiKey && !/^sk-ant-oat/i.test(apiKey)) {
    headers['x-api-key'] = apiKey;
  } else if (cfg.oauthToken) {
    headers.authorization = 'Bearer ' + cfg.oauthToken;
    headers['anthropic-beta'] = OAUTH_BETA;
  } else {
    return { ok: false, error: 'No hay sesión de Claude ni API key para consultar los modelos.', models: [] };
  }

  try {
    const res = await hpFetch(CLAUDE_MODELS_URL, { headers });
    if (!res.ok) {
      const raw = await res.text();
      return { ok: false, error: 'HTTP ' + res.status + ': ' + raw.slice(0, 200), models: [] };
    }
    const data = await res.json();
    const models = (Array.isArray(data.data) ? data.data : [])
      .filter((m) => m && m.id && isUsableClaudeModel(m.id))
      .map((m) => ({
        id: String(m.id),
        name: String(m.display_name || m.id),
        maxInputTokens: Number.isFinite(Number(m.max_input_tokens)) ? Number(m.max_input_tokens) : 0,
      }));
    if (!models.length) return { ok: false, error: 'La API no devolvió modelos usables.', models: [] };
    claudeModelsCache = { at: now, models };
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), models: [] };
  }
}

// Lista los modelos instalados en Ollama (GET <baseUrl>/api/tags).
// Devuelve { ok, models: [name, ...] } o { ok:false, error }.
async function listOllamaModels(baseUrl) {
  const base = String(baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  try {
    const res = await hpFetch(base + '/api/tags');
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status, models: [] };
    const data = await res.json();
    const models = (Array.isArray(data.models) ? data.models : [])
      .map((m) => (m && m.name) ? m.name : null)
      .filter(Boolean)
      // Los modelos de embeddings no generan texto: no sirven acá.
      .filter((name) => !/(embed|bge-|nomic)/i.test(name));
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), models: [] };
  }
}

// Etapa 1 (MODELO): arma el prompt, llama al modelo y escribe el HTML.
// NO renderiza. Devuelve un "prepared" que renderPrepared() consume después.
// Separar modelo/render permite solapar (generar el siguiente mientras renderiza el actual).
/**
 * ¿Esta imagen VA A VIAJAR?
 *
 * Una still puede venir como data URL (arrastrada al panel) o como RUTA —una
 * captura del programa, una referencia del proyecto—, y una ruta que en el disco
 * no está no viaja: el panel la sigue dibujando desde su propia caché y el
 * modelo diseña sin ella. Es el caso del proyecto en un disco externo
 * desmontado, y por eso al lado hay un WARN.
 *
 * La pregunta la contesta UNA función porque hay dos que tienen que dar la misma
 * respuesta: el que arma la llamada (que además la convierte, abajo) y el que la
 * ESTIMA, que solo necesita contarlas. Contarlas por el largo del array era
 * cobrar 1.200 tokens por una imagen que el WARN de al lado ya decía que no
 * está: medido con una referencia borrada, el semáforo decía 3 imágenes,
 * viajaban 2, y sobraban 2.064 tokens.
 */
function imagenViaja(s) {
  const v = String(s || '');
  if (/^data:/i.test(v)) return true;
  const p = v.replace(/^file:\/\//, '');
  if (!p) return false;
  try { return fs.existsSync(p); } catch (e) { return false; }
}

// Convierte un still (data URL o ruta a archivo) a data URL. Devuelve null si no
// se puede leer. Permite guardar capturas como ruta en el panel (sin base64 en
// localStorage) y aun así mandarlas al modelo como imagen.
function stillToDataUrl(s) {
  s = String(s || '');
  if (/^data:/i.test(s)) return s;
  const p = s.replace(/^file:\/\//, '');
  try {
    if (imagenViaja(s)) {
      const ext = (path.extname(p).slice(1) || 'png').toLowerCase();
      const mt = ext === 'jpg' ? 'jpeg' : ext;
      return 'data:image/' + mt + ';base64,' + fs.readFileSync(p).toString('base64');
    }
  } catch (e) {}
  return null;
}

// Los cuatro campos donde el editor puede mencionar una referencia. Son los
// mismos cuatro que tienen la tira de referencias arriba en el panel; el objetivo
// de la clase queda afuera porque ahí no hay referencias que mencionar.
const CAMPOS_CON_MENCIONES = ['instruction', 'adjustment', 'generalInstruction', 'sequenceInstruction'];

/**
 * Los textos del editor con las MENCIONES ya traducidas a «imagen N».
 *
 * Se hace acá, en el motor, y no en el panel: el número de una imagen es su
 * posición entre las que DE VERDAD llegan al modelo, y el único que sabe si un
 * archivo se pudo leer del disco es el que está armando la llamada. El panel
 * avisa mientras se escribe (ver cep/js/menciones.js), pero la traducción que
 * viaja se decide una sola vez y es ésta.
 *
 * `viaja(still, i)` la pone quien llama, porque el que arma el pedido ya
 * convirtió cada imagen (y sabe cuáles fallaron) y el que estima solo mira si el
 * archivo existe. Las dos respuestas tienen que salir de la misma cuenta que
 * decide `stillsCount`, o el número traducido apuntaría a otra imagen.
 *
 * NO toca el cuerpo del pedido ni la ficha de la versión: devuelve los textos
 * aparte. Lo que se guarda en el `.meta.json` y lo que muestra Corrections es lo
 * que el editor ESCRIBIÓ —con su `@[curso/logo.svg]`—, porque dentro de seis meses
 * "imagen 2" no dice qué imagen era y el nombre del archivo sí.
 */
function traducirMenciones(body, viaja) {
  const idx = menciones.indice({
    stills: body.stills,
    stillRefs: body.stillRefs,
    resources: body.resources,
    viaja: viaja,
  });
  const textos = {};
  const cambios = [];
  const problemas = [];
  const pasar = (v) => {
    if (typeof v !== 'string' || v.indexOf('@[') === -1) return v;
    const r = menciones.resolver(v, idx);
    r.cambios.forEach((c) => cambios.push(c));
    r.problemas.forEach((p) => problemas.push(p));
    return r.texto;
  };
  CAMPOS_CON_MENCIONES.forEach((k) => { textos[k] = pasar(body[k]); });
  // El ajuste local de una corrección REEMPLAZA el nivel que toca (ver
  // promptLevels), así que si se resolviera solo el campo original la mención
  // escrita en la fila de Corrections viajaría sin traducir.
  const ov = body.promptOverride;
  if (ov && typeof ov === 'object') {
    textos.promptOverride = Object.assign({}, ov);
    ['course', 'sequence'].forEach((k) => {
      if (typeof ov[k] === 'string') textos.promptOverride[k] = pasar(ov[k]);
    });
  } else {
    textos.promptOverride = ov;
  }
  return { textos, cambios, problemas };
}

// Cuánto de un documento de texto se pega en el prompt. Es contexto de estilo,
// no la clase: un manual de marca entero son unos pocos kB y entra; una
// transcripción de doscientas páginas pegada acá se lleva el presupuesto de
// entrada de la generación sin mejorar el diseño.
const DOC_TEXTO_MAX = 20000;
const DOC_TEXTO_EXT = /\.(txt|md|markdown|csv|json|ya?ml|html?|xml|log|rtf)$/i;

/**
 * El contenido de un documento si es TEXTO, o null si es binario. `nombre` es de
 * donde sale la extensión y `buf` son los bytes, que pueden venir de un archivo
 * del proyecto o del data URL que el editor arrastró a una tarjeta.
 *
 * Los que son texto (.md, .txt, .csv, .json) se pegan en el prompt y así llegan
 * por CUALQUIER proveedor, incluidos los tres que no pueden abrir archivos. Es
 * la mitad de "o se resuelve o se deja de prometer" que sí se puede resolver.
 *
 * Se mira la extensión Y el contenido: un archivo sin extensión conocida puede
 * ser texto igual, y uno con extensión .txt puede haber quedado binario. El byte
 * cero es el corte de siempre para eso.
 */
function textoDeDocumento(nombre, buf) {
  if (!DOC_TEXTO_EXT.test(String(nombre || ''))) return null;
  if (!buf) return null;
  if (buf.indexOf(0) !== -1) return null; // binario disfrazado
  const texto = buf.toString('utf8').trim();
  if (!texto) return null;
  return texto.length > DOC_TEXTO_MAX
    ? texto.slice(0, DOC_TEXTO_MAX) + '\n…(recortado: el documento sigue)'
    : texto;
}

/** De dónde salen el nombre y los bytes de un adjunto: una ruta o un data URL. */
function fuenteDeDocumento(r, i) {
  if (typeof r === 'string') {
    const p = r.replace(/^file:\/\//, '');
    return { nombre: path.basename(p), file: p, dataUrl: '' };
  }
  const p = r && typeof r.path === 'string' ? r.path.replace(/^file:\/\//, '') : '';
  if (p) return { nombre: path.basename(p), file: p, dataUrl: '' };
  // Con el nombre que va a tener EN EL DISCO, que es el que decide su
  // extensión y con eso cómo viaja (ver resourceFileName en project-fs).
  return { nombre: resourceFileName(r, i), file: '', dataUrl: String((r && r.dataUrl) || '') };
}

/** Los bytes de un adjunto, esté en el disco o en un data URL. null si no se pueden leer. */
function bytesDeDocumento(f) {
  try {
    if (f.file) return fs.readFileSync(f.file);
    const m = /^data:[^;,]*;base64,([\s\S]+)$/.exec(f.dataUrl);
    if (m) return Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  } catch (e) {}
  return null;
}

/**
 * CÓMO va a viajar cada documento adjunto, que son tres cosas distintas y no
 * una: los de TEXTO se pegan en el prompt (y llegan por los cinco proveedores),
 * los BINARIOS solo llegan por un agente que abra archivos, y con las otras tres
 * puertas no llegan de ninguna forma.
 *
 * La contesta UNA función porque hay dos que tienen que decir lo mismo: el que
 * arma el pedido y el que lo ESTIMA. Multiplicar por 1.500 fijos era decir el
 * mismo número para un `.md` de marca de 26.600 caracteres —que se pega entero
 * hasta DOC_TEXTO_MAX, o sea 5.000 tokens— que para un PDF que con `ollama` no
 * viaja y no cuesta nada. Medido: el semáforo decía 5.131 y se mandaban 8.679,
 * un 41% corto. Es la misma forma del bug que la 1.5.1 mató en los prompts
 * generales, entrando por la otra puerta: un fijo donde había que mirar el
 * contenido.
 */
function repartirDocumentos(lista, provider) {
  const textuales = [];
  const binarios = [];
  const sinLlegar = [];
  // Con qué nombre se ANUNCIA cada uno, desempatado cuando dos se llaman igual.
  // Sale del mismo lugar que el de la mención (`menciones.nombresDeRecursos`) y
  // no de `fuenteDeDocumento`, que da el nombre del archivo a secas: si el
  // encabezado dijera «guia.pdf» y la mención «guia.pdf (del curso)», el modelo
  // tendría que adivinar que son el mismo documento.
  const dichos = menciones.nombresDeRecursos(lista);
  (Array.isArray(lista) ? lista : []).forEach((r, i) => {
    const f = fuenteDeDocumento(r, i);
    const dicho = dichos[i] || f.nombre;
    // El texto se extrae con el nombre REAL del archivo, que es el que tiene la
    // extensión: el desempate es para leer, no para decidir si esto es un `.md`.
    const texto = textoDeDocumento(f.nombre, bytesDeDocumento(f));
    if (texto !== null) { textuales.push({ nombre: dicho, texto: texto }); return; }
    if (leeArchivos(provider)) binarios.push(f); else sinLlegar.push(dicho);
  });
  return { textuales, binarios, sinLlegar };
}

/** La sección de los documentos de texto, tal cual se le pega al prompt. */
function bloqueDeDocumentos(textuales) {
  if (!textuales.length) return '';
  return '\n\n## Documentación de referencia que subió el editor\n' +
    'Es contexto para diseñar, no contenido para copiar tal cual a la pantalla:\n' +
    textuales.map((d) => '\n### ' + d.nombre + '\n```\n' + d.texto + '\n```').join('\n');
}

// Lee ancho×alto de un buffer PNG o JPEG sin dependencias (parseo de cabecera).
// Devuelve {w,h} o null.
function imageDims(buf) {
  try {
    if (!buf || buf.length < 24) return null;
    // PNG: firma 89 50 4E 47; IHDR → ancho en offset 16, alto en 20 (big-endian).
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // JPEG: firma FF D8; recorrer marcadores hasta un SOF (C0–CF salvo C4/C8/CC).
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        const len = buf.readUInt16BE(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
        }
        off += 2 + len;
      }
    }
  } catch (e) {}
  return null;
}

/**
 * Con qué nombre queda en assets/ la imagen número i. Lo comparten el que las
 * escribe y el que estima el pedido: el nombre entra en el prompt, así que es
 * parte de lo que se cuenta.
 */
function nombreDeAsset(mime, i) {
  const ext = mime === 'jpeg' ? 'jpg' : String(mime || '').replace(/[^a-z0-9]/gi, '') || 'png';
  return 'asset-' + String(i + 1).padStart(2, '0') + '.' + ext;
}

/**
 * Con qué media type se va a guardar una imagen, venga como data URL o como
 * ruta. Es la misma cuenta que hace stillToDataUrl al convertirla.
 */
function mimeDeImagen(s) {
  const v = String(s || '');
  const m = /^data:image\/([a-z0-9.+-]+);base64,/i.exec(v);
  if (m) return m[1].toLowerCase();
  const ext = (path.extname(v.replace(/^file:\/\//, '')).slice(1) || 'png').toLowerCase();
  return ext === 'jpg' ? 'jpeg' : ext;
}

/**
 * El bloque que le dice al modelo que las imágenes a incrustar también están
 * como ARCHIVO en assets/.
 *
 * Se arma acá y no adentro de prepareGeneration porque el estimado tiene que
 * contarlo: son ~710 caracteres que se agregan DESPUÉS de buildUserPrompt, y el
 * semáforo quedaba 177 tokens corto justo cuando hay un logo para incrustar.
 *
 * Las dimensiones van solo si quien llama las tiene. El que arma el pedido ya
 * decodificó la imagen para escribirla, así que las sabe; el que estima no las
 * lee a propósito —abrir los píxeles de una captura de 3,5 MB para acertarle a
 * diecisiete caracteres es pagar mucho más de lo que informa—.
 *
 * El TEXTO es del motor —cómo se incrusta una imagen es `<img src="assets/…">`
 * en HyperFrames y `<Img src={staticFile('assets/…')}/>` en Remotion—, así que
 * acá no queda función ninguna: se le pide a `motor.bloqueDeAssets(infos)` y a
 * `motor.bloqueDeFondo()` en los dos lugares que los agregan al pedido (armar la
 * generación y estimar los tokens). Hubo dos envoltorios acá que no hacían más
 * que reenviar la llamada, y uno era la identidad pura.
 */

// Guarda las imágenes provistas como ARCHIVOS embebibles (asset-01.png, …) en
// `dir`; se copian al workDir/assets del render para que el HTML pueda
// referenciarlas con <img src="assets/asset-01.png">. Devuelve [{name, w, h}]
// (dimensiones cuando se pudieron leer) para informarle al modelo.
function saveAssets(dir, dataUrls) {
  const list = Array.isArray(dataUrls) ? dataUrls : [];
  // Limpiar SIEMPRE el dir (aunque no haya assets) para no arrastrar imágenes de
  // una generación anterior que ya no están marcadas "usar".
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  if (!list.length) return [];
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  list.forEach((du, i) => {
    const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(String(du || ''));
    if (!m) return;
    const name = nombreDeAsset(m[1], i);
    try {
      const buf = Buffer.from(m[2], 'base64');
      fs.writeFileSync(path.join(dir, name), buf);
      const d = imageDims(buf);
      out.push({ name, w: d ? d.w : null, h: d ? d.h : null });
    } catch (e) {}
  });
  return out;
}

async function prepareGeneration(body, mode, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  const { projectPath, sequenceName, objective, transcript, marker, markerTranscript,
    instruction, stills, adjustment, previousHtml } = body || {};

  if (!marker || typeof marker !== 'object') throw new Error('Falta "marker"');
  const durationSec = Number(marker.duration) || 0;
  if (durationSec <= 0) throw new Error('marker.duration debe ser > 0');

  const markerSlug = String(body.markerSlug || '').trim() || slugify(marker.name);
  // Los stills pueden venir como data URL (arrastrados) o como RUTA a archivo
  // (capturas guardadas en _capturas — así no revientan la cuota de localStorage).
  // Normalizamos todo a data URL para que providers/saveStills funcionen igual.
  const stillsGiven = Array.isArray(stills) ? stills : [];
  // Se convierte UNA vez y se guarda el resultado por índice, no filtrado: quién
  // se cayó es lo que decide qué número le toca a cada una de las que quedaron, y
  // es lo que las menciones necesitan saber.
  const stillsConvertidos = stillsGiven.map(stillToDataUrl);
  const stillsList = stillsConvertidos.filter(Boolean);
  const stillsMissing = stillsGiven.length - stillsList.length;
  const resourcesList = Array.isArray(body.resources) ? body.resources : [];

  // Las menciones del editor, traducidas contra las imágenes que de verdad van a
  // viajar. Lo que sigue usa `dicho.*` para armar el prompt y `body`/`instruction`
  // para la ficha: la una es lo que ve el modelo, la otra lo que escribió el editor.
  const men = traducirMenciones(body, (s, i) => !!stillsConvertidos[i]);
  const dicho = men.textos;

  report({ pct: 5, msg: 'Armando el contexto…' });

  // Config activa. Se lee ACÁ arriba y no más abajo porque de ella sale el
  // motor, y del motor sale el system prompt: todo lo que se arma después
  // depende de con qué se va a renderizar esto.
  const config = loadConfig();
  // Fondo opcional: con fondo => mp4 opaco HD; sin fondo => mov con alpha.
  const withBackground = body.background === true;
  const videoExt = withBackground ? 'mp4' : 'mov';
  const baseDir = ensureOutputDir(projectPath, sequenceName);
  const version = nextVersion(baseDir, markerSlug);

  // La versión previa, para refinar. Se lee ACÁ —antes de resolver el motor—
  // porque de ella sale CON QUÉ MOTOR se hizo, y eso manda sobre el selector de
  // ⚙: refinar es pedirle al modelo "tomá esto y mejoralo", y lo que le
  // mostramos como base está escrito en el lenguaje de un motor. Mandarle un
  // HTML con GSAP pidiéndole React no es refinar, es rehacerlo de cero
  // mintiéndole sobre la base; y el resultado tampoco se podría renderizar como
  // la versión anterior.
  //
  // Si el panel mandó el código previo lo usamos (es lo que el editor está
  // mirando), pero el MOTOR siempre sale del disco: la ficha es el único lugar
  // donde ese dato está escrito.
  const previa = mode === 'adjust' && version > 1
    ? lastComposition(baseDir, markerSlug, version)
    : null;
  const motor = previa && previa.engine
    ? motores.motor(previa.engine)
    : motores.motor(config.renderEngine);
  const systemPrompt = motor.systemPrompt();
  // Refinamiento (adjust): prompt lean — no reenviar el transcript completo (ya
  // tiene el código previo + el fragmento del marcador). Ahorra tokens en feedback.
  const leanPrompt = mode === 'adjust';
  let userPrompt = buildUserPrompt({
    motor: motor,
    objective, transcriptSegments: transcript, marker, markerTranscript,
    instruction: dicho.instruction, stillsCount: stillsList.length,
    // Los dos niveles generales viajan por separado hasta acá: quién le gana a
    // quién se le dice al modelo en el prompt, no se resuelve antes.
    generalInstruction: dicho.generalInstruction,
    sequenceInstruction: dicho.sequenceInstruction,
    generalSource: body.generalSource,
    // El ajuste que el editor escribió en la fila de correcciones para ESTE
    // pedido. Se aplica adentro de build-context, que es el único lugar donde el
    // contexto se combina: así el ajuste no puede quedar decorativo (llega al
    // texto que se manda, al conteo de tokens y a la ficha) ni pisar la
    // relectura del disco de la cola, que sigue siendo la fuente de lo que el
    // editor no tocó.
    promptOverride: dicho.promptOverride,
    lean: leanPrompt,
  });

  const outPaths = paths(baseDir, markerSlug, version, config.model, videoExt, motor.lenguaje.ext);

  // La ficha de DÓNDE VA este recurso se escribe ANTES de gastar el modelo, no
  // al final. Es el único dato que no se puede reconstruir mirando el disco: el
  // segundo del timeline vive en el marcador de Premiere, y el marcador puede
  // no existir cuando vuelvas de la revisión. Si la generación se cae a mitad,
  // el HTML igual queda guardado y sin esta ficha nadie sabría a qué tramo de
  // qué secuencia pertenece. Al terminar se reescribe completa.
  // Los tres niveles del contexto se anotan acá por el mismo motivo que el
  // tramo: es lo que se le está por mandar al modelo, y escribirlo antes de
  // gastar la llamada es lo que hace que sobreviva a una generación que se cae.
  const prompts = promptRecord(body);
  writeVersionMeta(outPaths.meta, fichaDeGeneracion({
    sequenceName, markerSlug, marker,
    version, model: config.model, provider: config.provider, mode,
    // Con qué motor se hizo. Se anota junto con el modelo y por el mismo
    // motivo: es lo que hace falta para volver a tocar esta versión más
    // adelante, cuando el selector de ⚙ ya diga otra cosa.
    engine: motor.id,
    instruction, prompts,
    // Se termina de escribir cuando el render sale bien; si esto queda en
    // true, la generación no llegó al final.
    pending: true,
  }));

  // Modo "ajustar": toma como REFERENCIA la última versión ya generada.
  // Si el panel no mandó el código previo, usamos el que ya leímos del disco.
  if (mode === 'adjust') {
    const prevCode = String(previousHtml || '').trim() || (previa ? previa.code : '');
    userPrompt += [
      '', '## Refinamiento sobre la versión previa',
      'Ya generaste una versión de este recurso (abajo). Tomala como REFERENCIA:',
      'mantené lo que funciona y aplicá la nueva instrucción del editor sobre esa base.',
      '', '### Nueva instrucción', (dicho.adjustment || dicho.instruction || '').trim() || '(sin detalle)',
      '', '### Versión previa', '```' + motor.lenguaje.fence, prevCode || '(no disponible)', '```',
      '', 'Devolvé SOLO ' + motor.lenguaje.comoSeLlama + ' completo de la versión refinada.',
    ].join('\n');
  }
  saveStills(outPaths.stillsDir, stillsList);

  // Imágenes provistas también disponibles como ARCHIVO para INCRUSTAR (logo/icono/
  // foto). Se guardan en <base>/_assets/<slug> y se copian al render; el modelo las
  // referencia con <img src="assets/asset-NN.ext"> si la instrucción pide usarlas.
  // Assets a INCRUSTAR = solo las imágenes que el editor marcó "usar" (body.assets),
  // normalizadas a data URL. Las demás stills quedan solo como referencia visual.
  const assetList = (Array.isArray(body.assets) ? body.assets : []).map(stillToDataUrl).filter(Boolean);
  const assetsDir = path.join(baseDir, '_assets', markerSlug);
  const assetInfos = saveAssets(assetsDir, assetList);
  userPrompt += motor.bloqueDeAssets(assetInfos);

  // Recursos de referencia (PDFs, docs) subidos por el editor: se guardan al
  // lado de la render y se le pasan al modelo por el camino que su proveedor
  // sepa leer, que NO es el mismo para los cinco.
  //
  // Los que son TEXTO se pegan en el prompt. Eso vale para todos: un .md o un
  // .txt es lo mismo que escribir su contenido en el campo, y así llega igual
  // por una API que por un CLI. Los BINARIOS (un PDF) solo pueden llegar por un
  // agente que abra archivos, y nombrar la ruta no alcanza: los CLI leen sin
  // preguntar únicamente dentro de las carpetas que tienen declaradas, y ésta
  // vive en el disco del proyecto (que en Windows puede ser otra unidad entera).
  // Por eso la carpeta viaja aparte, en `readDirs`, y el proveedor se la declara.
  //
  // Y cuando el proveedor no puede abrir archivos —la API de Claude, una API
  // compatible con OpenAI, Ollama— el PDF NO LLEGA. Eso antes pasaba en
  // silencio: el panel aceptaba el archivo, el prompt escribía su ruta y el
  // modelo, que no tiene disco, componía sin él. Ahora se dice antes de gastar
  // la llamada. Ver `leeArchivos` en providers/index.js.
  const readDirs = [];
  const docFiles = [];
  const docsSinLlegar = [];
  if (resourcesList.length) {
    // Los del MARCADOR vienen en base64 y hay que escribirlos a disco para poder
    // nombrarlos; los de los dos niveles generales YA son archivos del proyecto
    // y se usan donde están. Esa diferencia no es cosmética: los generales
    // entran en TODOS los marcadores de la clase, y copiar un PDF de 8 MB al
    // lado de cada versión de cada uno son cientos de MB de la misma cosa —
    // veinte marcadores por tres versiones ya son 480 MB de un archivo.
    const docPaths = [];
    const enBase64 = [];
    resourcesList.forEach((r) => {
      const suyo = r && typeof r.path === 'string' ? r.path.replace(/^file:\/\//, '') : '';
      if (suyo) docPaths.push(suyo); else enBase64.push(r);
    });
    if (enBase64.length) saveResources(outPaths.resourcesDir, enBase64).forEach((p) => docPaths.push(p));

    // Quién se pega en el prompt, quién viaja como archivo y quién no llega: lo
    // reparte la misma función que usa el estimado, así el semáforo no puede
    // cobrar un documento que no viaja ni un fijo por uno que se pega entero.
    const reparto = repartirDocumentos(docPaths, config.provider);
    userPrompt += bloqueDeDocumentos(reparto.textuales);
    // El renglón que le dice al modelo DÓNDE abrirlos lo escribe el proveedor,
    // igual que el de las imágenes: la ruta que sirve depende de dónde corra el
    // agente. claude-cli lee la carpeta del proyecto con --add-dir;
    // cursor-agent trabaja encerrado en un workspace temporal y necesita una
    // copia adentro. Escribir una ruta acá, sin saber cuál de los dos atiende,
    // es lo que hacía que con Cursor el PDF quedara nombrado en el prompt y
    // fuera de su alcance.
    reparto.binarios.forEach((f) => {
      docFiles.push(f.file);
      const dir = path.dirname(f.file);
      if (readDirs.indexOf(dir) === -1) readDirs.push(dir);
    });
    reparto.sinLlegar.forEach((n) => docsSinLlegar.push(n));
  }

  // Fondo: si el marcador se genera CON fondo, instruir un fondo opaco de
  // pantalla completa (minimalista, con textura, temático y con buen contraste).
  if (withBackground) userPrompt += motor.bloqueDeFondo();

  // Continuidad: SOLO inyectar el HTML de otros marcadores si la instrucción
  // realmente pide continuar/retomar/mantener estilo (ahorra tokens y latencia;
  // antes se mandaba siempre, hasta 12k chars por generación).
  //
  // Nombrar un marcador ya ES pedir continuidad: "basate en el marcador 2" no
  // tiene ninguna de las palabras de la lista y es el pedido más explícito que
  // existe. Antes eso no disparaba nada, y cuando sí disparaba mandaba los dos
  // primeros marcadores por orden alfabético, que rara vez eran el que pediste.
  // Sobre el texto YA TRADUCIDO, no sobre el que escribió el editor: una
  // referencia que se llame «Marcador 3.png» habría disparado la continuidad con
  // el Marcador 3 por su nombre de archivo, y le habría metido al pedido un HTML
  // entero que nadie pidió.
  const contHint = ((dicho.instruction || '') + ' ' + (dicho.adjustment || '')).toLowerCase();
  const nombrados = referencedMarkerNumbers(contHint);
  const wantsContinuity = nombrados.length > 0 ||
    /(retom|continu|anterior|sigu|mism[oa]|coheren|igual que|como (el|la)|estilo|empalm|coincid|en línea con|misma línea)/.test(contHint);
  let continuidadNota = 'sin continuidad';
  let continuidadFaltan = [];
  if (wantsContinuity) {
    const others = listOtherResources(baseDir, markerSlug, nombrados);
    if (others.items.length) {
      const dirigido = nombrados.length > 0;
      userPrompt += '\n\n## ' + (dirigido
        ? 'El diseño que te pidieron seguir (mismo estilo, otro contenido)\n' +
          'El editor nombró este recurso: seguí SU sistema visual —paleta, tipografía, ritmo, ' +
          'tipo de transiciones y disposición— y cambiá solo lo que pida su instrucción y el ' +
          'contenido de este tramo. No lo copies literal: es la misma familia, no el mismo cartel.\n'
        : 'Otros recursos ya generados en esta clase (referencia de continuidad y estilo)\n' +
          'Mantené coherencia con estos (tu instrucción pide continuar/retomar):\n') +
        // Cada recurso se marca con el fence del motor con el que se hizo, no
        // con el de este pedido: si la clase arrancó en HyperFrames y hoy se
        // genera con Remotion, lo que se le muestra al modelo sigue siendo HTML
        // y decirle que es TSX lo haría leer React donde hay markup. El pedido
        // es "seguí ese sistema visual", que se lee igual en los dos lenguajes.
        others.items.map((o) => '### ' + o.slug + '\n```' + motores.motor(o.engine).lenguaje.fence +
          '\n' + o.html + '\n```').join('\n\n');
      continuidadNota = (dirigido ? 'sigue el diseño de ' : 'continuidad con ') +
        others.items.map((o) => o.slug).join(' + ');
    }
    continuidadFaltan = others.missing;
  }

  const provider = getProvider(config.provider);
  const verbo = mode === 'regen' ? 'desde cero' : mode === 'adjust' ? '(refinando)' : '';
  const localHint = config.provider === 'ollama' ? ' — modelo local, puede tardar varios minutos' : '';
  report({ pct: 15, msg: 'Diseñando la animación con ' + config.model + ' ' + verbo + '…' + localHint });

  // Qué entra REALMENTE en esta llamada, escrito antes de gastarla. Cuando un
  // recurso sale distinto de lo que el editor esperaba, la primera pregunta es
  // siempre qué vio el modelo; sin esta línea había que deducirlo del resultado.
  report({ note: 'Entra al modelo: ' + [
    stillsList.length + ' img de referencia',
    assetInfos.length + ' img a incrustar',
    (Array.isArray(transcript) ? transcript.length : 0) + ' segmentos de clase' + (leanPrompt ? ' (no se reenvían)' : ''),
    (Array.isArray(markerTranscript) ? markerTranscript.length : 0) + ' del marcador',
    'objetivo ' + objectiveLabel(body),
    'instrucción ' + ((instruction || '').trim() ? 'sí' : 'NO'),
    // Qué niveles del estilo viajaron. "prompt general no" fue la línea que dejó
    // ver que el segundo editor generaba sin nada; decir SÍ y callar cuáles
    // entraron dejaría el mismo agujero un escalón más arriba, ahora que el del
    // curso y el de la secuencia van los dos y pueden contradecirse.
    'prompt general ' + generalPromptLabel(body),
    resourcesList.length + ' recursos',
    continuidadNota,
  ].join(' · ') });
  // Qué mención se tradujo a qué número. Es el renglón que contesta la pregunta
  // que va a aparecer la primera vez que un recurso salga apuntando a la imagen
  // equivocada: no "hubo 3 menciones" sino el par entero, nombre → número.
  if (men.cambios.length) {
    report({ note: 'Menciones del editor traducidas: ' + menciones.nota(men.cambios) });
  }
  // Y lo que no se pudo traducir bien. Ninguno frena la generación —no se puede
  // no generar por un typo— pero los tres cambian lo que el modelo va a leer, así
  // que ninguno puede pasar callado.
  if (men.problemas.length) {
    report({ level: 'WARN', note: 'OJO con las menciones: ' + menciones.aviso(men.problemas) + '.' });
  }
  // Pediste seguir un marcador que todavía no tiene nada generado: sin este
  // aviso, la generación sale igual y parece que la referencia no se respetó.
  if (continuidadFaltan.length) {
    report({
      level: 'WARN',
      note: 'Pediste seguir el diseño del Marcador ' + continuidadFaltan.join(' y el ') +
        ', pero todavía no tiene ninguna versión generada en esta secuencia: se diseña sin esa referencia.',
    });
  }
  // Una referencia que el editor adjuntó y no llegó es un modo de falla mudo: el
  // panel muestra la miniatura (la sacó de su propia caché) y el modelo diseña
  // sin ella. Pasa cuando el disco del proyecto no está montado o se movió.
  if (stillsMissing > 0) {
    report({
      level: 'WARN',
      note: 'OJO: ' + stillsMissing + ' imagen(es) de referencia NO se pudieron leer del disco y el ' +
        'modelo va a diseñar sin ellas. Si el proyecto vive en un disco externo, revisá que esté montado.',
    });
  }
  // Un documento adjunto que no le llega al proveedor elegido. La interfaz
  // acepta PDFs y hasta acá se los tragaba en silencio con las tres puertas que
  // no pueden abrir archivos: el editor adjuntaba el manual de marca, el modelo
  // componía sin verlo, y el resultado se veía presentable.
  if (docsSinLlegar.length) {
    report({
      level: 'WARN',
      note: 'OJO: ' + docsSinLlegar.length + ' documento(s) NO le llegan a ' + config.provider +
        ' (' + docsSinLlegar.join(', ') + '): esta puerta habla con el modelo por HTTP y solo le ' +
        'entran texto e imágenes, así que un PDF no viaja de ninguna forma. Qué hacer: pasá a ' +
        'Claude o Cursor por CLI en Configuración (esos SÍ abren el archivo), exportá el documento ' +
        'a .md o .txt (eso se pega en el pedido y llega con cualquier proveedor), o pegá una ' +
        'captura de la página que importa como imagen de referencia.',
    });
  }

  // Hasta tres llamadas al modelo con la regla "nunca empeorar", más el andamiaje
  // completado en código. La política vive en compose.js; acá solo se orquesta.
  //
  // Se cronometra: MODELO y RENDER son dos trabajos distintos (la nube pensando
  // vs. esta máquina capturando frames) y sumados en un solo número no dicen
  // nada. Separados, contestan la pregunta útil: si un recurso tardó ocho
  // minutos, ¿bajo el nivel de pensamiento o acorto el marcador?
  const modelStartedAt = Date.now();
  let html, usage;
  try {
    ({ html, usage } = await composeAnimation({
      provider, config: Object.assign({}, config, { readDirs, docFiles, motor: motor }),
      motor, systemPrompt, userPrompt, images: stillsList,
      durationSec, markerSlug, report,
    }));
  } catch (e) {
    // Que el semáforo de ⚙ se entere. Una cuenta sin cupo tiene credencial, así
    // que el chequeo de sesión la ve verde y la seguiría viendo verde hasta que
    // alguien recargue el panel — que es justo lo que le pasó al editor que
    // mandó la captura del indicador en verde con `Credit balance is too low`
    // abajo. Acá es donde el motor se entera; provider-salud.js lo recuerda.
    providerSalud.anotar(config.provider, cliErrors.causa(String((e && e.message) || e)),
      String((e && e.message) || e));
    // compose corta cuando la composición no es renderizable. El código igual se
    // guarda: ya se pagó, y es con lo que el editor puede ver qué pasó o
    // arreglarlo a mano y darle a "Renderizar código".
    if (e && e.noRenderizable && e.html) {
      try {
        fs.writeFileSync(outPaths.code, e.html, 'utf8');
        e.message += '\nEl código quedó guardado en: ' + outPaths.code;
      } catch (e2) {}
    }
    throw e;
  }
  const modelMs = Date.now() - modelStartedAt;

  fs.writeFileSync(outPaths.code, html, 'utf8');
  report({
    pct: 55,
    // ↑ es la entrada COMPLETA, con la caché: `inputTokens` a secas es apenas lo
    // que no estaba cacheado y este aviso mostraba "↑6" (ver makeUsage).
    msg: 'Composición lista · Tokens: ↑' + usage.totalInputTokens + ' ↓' + usage.outputTokens,
    usage: usage,
  });

  // "prepared": todo lo que renderPrepared necesita para renderizar + guardar meta.
  return {
    ok: true, html, outMovPath: outPaths.mov, codePath: outPaths.code, metaPath: outPaths.meta,
    durationSec, videoExt, version, markerSlug, baseDir,
    usage, background: withBackground, instruction, prompts, marker, assetsDir, sequenceName,
    model: config.model, provider: config.provider, mode, adjustment, modelMs,
    // Con qué se renderiza y con qué se anota en la ficha. Viaja en el paquete
    // en vez de volver a leerse de ⚙ en renderPrepared: entre el momento en que
    // el modelo compone y el momento en que esto se renderiza pasan minutos, y
    // el editor puede haber cambiado el selector mientras tanto. Lo que se
    // renderiza tiene que ser lo que se compuso.
    engine: motor.id,
  };
}

/**
 * Los TRES NIVELES que este pedido le mandó al modelo, guardados tal como
 * salieron: el prompt del curso, el de la secuencia y el objetivo de la clase.
 * (El cuarto —la instrucción del marcador— ya vive en `instruction`.)
 *
 * Existe para poder contestar, dentro de un mes, con qué contexto se generó
 * este recurso. Hasta acá la ficha guardaba solo la instrucción, así que la
 * pestaña de correcciones no tenía manera de mostrar lo que el marcador recibió:
 * lo más cerca que podía llegar era leer los archivos de HOY, que pueden haber
 * cambiado veinte veces desde entonces. Con esto guardado, "esto es lo que se
 * mandó" pasa a ser un dato y no una reconstrucción, y el panel puede decir cuál
 * de las dos cosas está mostrando.
 *
 * Se escribe con lo que devuelve `promptLevels`, o sea DESPUÉS del ajuste local
 * de una corrección: lo que se anota es lo que viajó, no lo que decía el
 * archivo. Que hubo ajuste queda dicho aparte, en `adjusted`, y eso NO es
 * decoración: es lo único con lo que el panel puede distinguir por qué lo que se
 * mandó no coincide con el archivo de hoy. Sin ese dato la fila le echaba la
 * culpa al archivo ("dice otra cosa hoy") de una diferencia que había puesto el
 * editor a mano, sobre un archivo que nunca se tocó.
 */
function promptRecord(body) {
  body = body || {};
  const levels = promptLevels(body);
  const rec = {
    course: levels.course,
    sequence: levels.sequence,
    objective: levels.objective,
  };
  // Un job encolado por un panel anterior a la 1.5.0 mandaba un solo texto ya
  // resuelto y sin decir de qué nivel era. Queda anotado como lo que es: no se
  // sabe. Ponerlo en `course` a secas sería inventar el único dato por el que se
  // mira esta ficha.
  if (levels.unknown) rec.unknownLevel = true;
  const a = levels.adjusted;
  // El objetivo entra en la cuenta igual que los otros dos: también se ajusta en
  // la fila y también termina no coincidiendo con lo que el panel dice hoy.
  if (a.course || a.sequence || a.objective) {
    rec.adjusted = { course: a.course, sequence: a.sequence, objective: a.objective };
  }
  return rec;
}

/**
 * La ficha de una generación, con los campos que salen de ELLA y no del render.
 *
 * La escriben los dos momentos de una generación: antes de gastar la llamada al
 * modelo (con `pending: true`, para que sobreviva a que se caiga a mitad) y
 * cuando el render salió bien (que la reemplaza entera). Los dos escriben lo
 * mismo, porque es la misma versión; lo que cambia es lo que recién se sabe al
 * final, y eso entra por `extra`.
 *
 * Está en una función y no repetida en los dos lugares porque los tres niveles
 * del contexto tienen que estar en las DOS: mientras cada write listaba sus
 * campos a mano, olvidarse de repetir uno al final lo borraba al terminar, y de
 * una generación exitosa dejaba de saberse con qué se hizo. Nada falla cuando
 * eso pasa: se descubre un mes después, abriendo la fila que iba a decirlo.
 *
 * `g` habla el vocabulario de la generación (lo que devuelve `prepareGenerate`);
 * la forma del archivo la pone `writeVersionMeta`, que es su dueña.
 */
function fichaDeGeneracion(g, extra) {
  g = g || {};
  return Object.assign({
    sequenceName: g.sequenceName, markerSlug: g.markerSlug, marker: g.marker,
    version: g.version,
    model: g.model, provider: g.provider, mode: g.mode,
    instruction: g.instruction,
    adjustment: g.mode === 'adjust' ? g.adjustment : undefined,
    prompts: g.prompts,
    engine: g.engine,
    background: g.background,
    // Antes de renderizar todavía no hay archivo de video: el formato lo pone el
    // que ya lo escribió.
    format: g.format || g.videoExt,
    createdAt: new Date(Date.now()).toISOString(),
    pending: g.pending,
  }, extra || {});
}



// Etapa 2 (RENDER): renderiza la composición preparada y guarda la metadata.
async function renderPrepared(prepared, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  if (!prepared || !prepared.ok) throw new Error('renderPrepared: prepared inválido');
  report({ pct: 60, msg: prepared.background ? 'Renderizando video HD (con fondo)…' : 'Renderizando el video con alpha…' });
  const renderStartedAt = Date.now();
  // El motor que COMPUSO esto, que viaja en el paquete. Ver `engine` en
  // prepareGeneration: leerlo de ⚙ acá renderizaría con otro motor del que
  // escribió el código si el editor tocó el selector mientras la cola avanzaba.
  await motores.motor(prepared.engine).renderizar({
    code: prepared.html, outPath: prepared.outMovPath, durationSec: prepared.durationSec,
    onProgress: report, format: prepared.videoExt,
    assetsDir: prepared.assetsDir,
  });
  const renderMs = Date.now() - renderStartedAt;

  // La ficha se reescribe COMPLETA acá, así que se arma del mismo `prepared` que
  // se anotó antes de llamar al modelo: lo único que se le suma es lo que recién
  // ahora se sabe (que llegó al final, cuánto tardó, y qué había antes). Mientras
  // los dos registros se escribían campo por campo cada uno, olvidarse de repetir
  // uno acá lo borraba al terminar, y solo las generaciones que se caían quedaban
  // auditables — que es exactamente al revés.
  writeVersionMeta(prepared.metaPath, fichaDeGeneracion(prepared, {
    // Cuánto costó hacer ESTA versión, por etapa y en ms. Vive en la meta y no
    // solo en la cola porque acá sobrevive a cerrar Premiere: dentro de un mes
    // el recurso sigue sabiendo lo que tardó. `modelMs` es 0 en los renders que
    // no llaman a la IA (re-render, HTML editado a mano).
    timings: { modelMs: prepared.modelMs || 0, renderMs: renderMs },
    history: versiones.buildHistory(prepared.baseDir, prepared.markerSlug, prepared.version),
  }));

  return { ok: true, movPath: prepared.outMovPath, codePath: prepared.codePath, version: prepared.version, markerSlug: prepared.markerSlug, usage: prepared.usage, background: prepared.background, renderMs: renderMs };
}

/**
 * Estimación aproximada de tokens de ENTRADA para un marcador, sin llamar al
 * modelo ni escribir nada. Es el semáforo de antes de gastar: el `≈ N tokens de
 * entrada` de la tarjeta y el del pie de la Cola.
 *
 * La cuenta es ~4 chars/token del prompt que se va a mandar, más un fijo por
 * imagen. Lo que NO es un fijo es CUÁNTAS imágenes y CUÁNTOS documentos: eso se
 * le pregunta a las mismas funciones que arman la llamada (`imagenViaja`,
 * `repartirDocumentos`, `bloqueDeDocumentos`, `bloqueDeAssets`, `bloqueDeFondo`)
 * en vez de multiplicar el largo de un array por un número. Multiplicar era
 * cobrar imágenes que el disco no tiene —3 contadas, 2 viajando, 2.064 tokens de
 * más— y cobrar 1.500 fijos por un `.md` que se pega entero, que con un manual
 * de marca de 26.600 caracteres dejaba el semáforo 41% corto.
 *
 * Lo único que sigue siendo un fijo es el documento BINARIO que sí viaja: lo
 * abre el agente y cuánto lea de un PDF no se puede saber de antemano. El que no
 * viaja cuesta cero, que es lo que cuesta.
 *
 * Sigue siendo un estimado y hay dos pedazos que no se pueden prever: el HTML de
 * la versión previa que se le suma al refinado (el panel no lo tiene en el
 * payload de la tarjeta) y el de los marcadores que entran por continuidad, que
 * salen del disco recién al generar.
 */
function estimateTokens(body) {
  try {
    body = body || {};
    const marker = body.marker || {};
    const transcript = Array.isArray(body.transcript) ? body.transcript : [];
    const markerTranscript = Array.isArray(body.markerTranscript) ? body.markerTranscript : [];
    const stills = Array.isArray(body.stills) ? body.stills : [];
    const resources = Array.isArray(body.resources) ? body.resources : [];
    const assets = Array.isArray(body.assets) ? body.assets : [];

    // Lo que de verdad va a viajar de este pedido, contestado por quien lo arma.
    const imagenes = stills.filter(imagenViaja);
    // Las menciones también se traducen para estimar: «@[curso/logo-platzi.svg]»
    // y «imagen 2» no miden lo mismo, y este número promete ser el del cuerpo que
    // se manda. Se resuelve contra la MISMA pregunta que usa la generación (¿está
    // el archivo?), así que el número que se le muestra al editor sale de la misma
    // cuenta que el que va a leer el modelo.
    const men = traducirMenciones(body, (s) => imagenViaja(s));
    const dicho = men.textos;
    const assetInfos = assets.filter(imagenViaja)
      .map((s, i) => ({ name: nombreDeAsset(mimeDeImagen(s), i), w: null, h: null }));
    // El proveedor decide si un PDF viaja o no, así que decide cuánto cuesta.
    // Sale de la config, que es la puerta que va a atender la llamada; el cuerpo
    // lo puede traer para preguntar por OTRA (¿y si mandara esto por Claude?).
    const docs = repartirDocumentos(resources, body.provider || loadConfig().provider);
    // El motor cambia el tamaño del pedido: el system prompt de Remotion y el de
    // HyperFrames no miden lo mismo, y tampoco el contrato ni el bloque de
    // assets. El cuerpo lo puede traer para preguntar por OTRO motor, igual que
    // con el proveedor.
    const motor = motores.motor(body.engine || loadConfig().renderEngine);

    let systemPrompt = '';
    try { systemPrompt = motor.systemPrompt(); } catch (e) {}

    let userPrompt = '';
    try {
      userPrompt = buildUserPrompt({
        motor: motor,
        objective: body.objective || '',
        transcriptSegments: transcript,
        marker,
        markerTranscript,
        instruction: dicho.instruction || '',
        // Los prompts generales entran en la llamada de verdad, así que entran
        // acá: el semáforo de tokens que los omitía quedaba corto justo en los
        // proyectos que más contexto mandan.
        generalInstruction: dicho.generalInstruction || '',
        // Tal cual vinieron, sin coercionar: que el nivel de la secuencia FALTE
        // —y no que esté vacío— es lo que delata a un job anterior a la 1.5.0, y
        // el prompt de ésos sale distinto (ver promptLevels en build-context).
        // Rellenarlo con "" acá era estimar un pedido que no es el que viaja.
        sequenceInstruction: dicho.sequenceInstruction,
        generalSource: body.generalSource,
        // Un ajuste local cambia el tamaño del pedido, así que también cambia el
        // semáforo: el estimado tiene que contar el prompt que se va a mandar.
        promptOverride: dicho.promptOverride,
        // Las que VIAJAN: el prompt numera "imagen 1, imagen 2…" y numerar una
        // que no está sería nombrarle al modelo algo que no va a recibir.
        stillsCount: imagenes.length,
        lean: body.mode === 'adjust',
      });
    } catch (e) {
      userPrompt = String(body.objective || '') + ' ' + String(body.instruction || '');
    }
    // Los tres bloques que prepareGeneration le agrega DESPUÉS de armar el
    // cuerpo, con las mismas funciones que los escriben.
    userPrompt += motor.bloqueDeAssets(assetInfos) +
      bloqueDeDocumentos(docs.textuales) +
      (body.background === true ? motor.bloqueDeFondo() : '');

    const promptChars = systemPrompt.length + userPrompt.length;
    const inputTokensEst = Math.ceil(promptChars / 4) +
      imagenes.length * 1200 +
      // Un binario que sí viaja: lo abre el agente y cuánto lea no se sabe.
      docs.binarios.length * 1500;
    return {
      ok: true,
      inputTokensEst,
      breakdown: {
        promptChars,
        images: imagenes.length,
        // Los documentos que viajan de alguna forma: pegados o como archivo.
        resources: docs.textuales.length + docs.binarios.length,
        // Y lo que se quedó afuera, para que el que muestre el número pueda
        // decir por qué es más chico de lo que el editor adjuntó.
        imagesMissing: stills.length - imagenes.length,
        docsPasted: docs.textuales.length,
        docsAsFiles: docs.binarios.length,
        docsNotTraveling: docs.sinLlegar.length,
      },
      // Lo que le pasó a cada mención EN ESTE CUERPO, el que se acaba de contar.
      //
      // Va acá y no en una llamada propia porque la tarjeta ya pregunta el estimado
      // con cada tecla: preguntar aparte sería una segunda llamada por el mismo
      // cuerpo, y una segunda cuenta que se podría desincronizar de la primera.
      //
      // Y viene YA REDACTADO (`nota` y `aviso`, las mismas dos frases del ⬇ Log)
      // porque el consumidor es el globo del estimado en la ficha del marcador, que
      // no puede redactarlo: la gramática de las menciones del panel vive en
      // globales de navegador y ésta en Node (ver `aviso` en prompt/menciones.js).
      // Son las dos mitades de la promesa del estimado —«se arma con el mismo
      // cuerpo que se le manda al modelo»—: con qué número le llega cada mención, y
      // cuál no le va a llegar.
      //
      // Lo que NO hace el panel con esto es un segundo renglón de aviso: el fuerte
      // ya existe y sale mientras se escribe, sin esperar al motor
      // (`HPMenciones.revisar`). Dos redacciones del mismo hecho en la misma ficha,
      // llegando en momentos distintos, es el bug que se acaba de sacar de encima.
      menciones: {
        traducidas: men.cambios.map((c) => ({ nombre: c.nombre, en: c.en })),
        problemas: men.problemas,
        nota: menciones.nota(men.cambios),
        aviso: menciones.aviso(men.problemas),
      },
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), inputTokensEst: 0 };
  }
}

async function deriveObjective(body) {
  const transcriptText =
    typeof body.transcriptText === 'string' && body.transcriptText.trim()
      ? body.transcriptText
      : (Array.isArray(body.transcript) ? body.transcript : [])
          .map((s) => ((s && s.text) || '').trim()).filter(Boolean).join(' ');
  const { system, user } = buildObjectivePrompt(transcriptText);
  const config = loadConfig();
  const provider = getProvider(config.provider);
  const gen = await provider.generate({
    systemPrompt: system, userPrompt: user, images: [], model: config.model, config,
  });
  return { ok: true, objective: String((gen && gen.text) || '').trim(), usage: (gen && gen.usage) || null };
}

// Guarda un token OAuth de suscripción (sk-ant-oat…) en la config y activa
// claude-cli. Usado por el flujo interactivo Y por el pegado manual del token.
function persistClaudeToken(token) {
  const t = String(token || '').trim();
  const m = t.match(claudeLogin.TOKEN_RE);
  if (!m) return { ok: false, error: 'Eso no parece un token de Claude (sk-ant-oat…). Pegá el token completo.' };
  const raw = loadRawConfig();
  raw.oauthToken = m[0];
  raw.provider = 'claude-cli';
  saveRawConfig(raw);
  return { ok: true, provider: 'claude-cli' };
}

// Fase 1 del login: arranca `claude setup-token` y devuelve la URL a abrir en
// el navegador (o { done:true } si claude ya estaba logueado y dio el token).
async function loginClaudeStart() {
  const r = await claudeLogin.start();
  if (!r.ok) return r;
  if (r.done && r.token) return persistClaudeToken(r.token);
  return { ok: true, url: r.url }; // el panel abre la URL y pide el código
}

// Fase 2: recibe el código que el usuario pegó desde la página de autorización.
async function loginClaudeCode(body) {
  const r = await claudeLogin.submitCode((body || {}).code);
  if (!r.ok) return r;
  return persistClaudeToken(r.token);
}

// Pegado manual del token (camino universal: el usuario corrió
// `claude setup-token` a mano, o lo tiene de otro lado).
function loginClaudeToken(body) {
  return persistClaudeToken((body || {}).token);
}

function loginClaudeCancel() {
  return claudeLogin.cancel();
}

// Ficha del CLI de Claude en ESTA máquina (ruta, versión, dónde se buscó), para
// que el editor pueda mandárnosla por captura sin tener que fallar primero.
function claudeCliStatus() {
  return claudeDoctor.diagnose();
}

// Lo que mira el cartel de sesión de ⚙. Es una pregunta al CLI, no a nuestra
// config: el editor puede estar logueado por la terminal y generar bien sin
// que nosotros tengamos ningún token guardado (ver claude-session.js).
// El chequeo de sesión dice si hay CON QUÉ autenticarse; `aplicarA` le suma lo
// que ya sabemos que le pasó a ese proveedor en esta sesión del panel (sin
// cupo, credencial rechazada). Ver bridge/provider-salud.js.
async function claudeSessionStatus() {
  const cfg = loadConfig();
  return providerSalud.aplicarA('claude-cli', await claudeSession.estadoDeSesion(cfg));
}

// ── El selector de modelos de Claude por el CLI ──────────────────────

/**
 * La config plana de "Claude (CLI)" aunque el activo sea otro proveedor. El
 * selector siempre pregunta por ESE slot: medir con la credencial de otro
 * proveedor sería medir otra cuenta.
 */
function configDeClaudeCli() {
  const cfg = loadConfig();
  if (cfg.provider === 'claude-cli') return cfg;
  const slot = (cfg.perProvider && cfg.perProvider['claude-cli']) || {};
  return Object.assign({}, cfg, {
    provider: 'claude-cli',
    model: (slot.model && String(slot.model).trim()) ? slot.model : defaultModelFor('claude-cli'),
    apiKey: slot.apiKey || '',
    baseUrl: slot.baseUrl || '',
  });
}

/**
 * Todo lo que necesita ⚙ para dibujar el selector (ver claude-modelos.catalogo).
 * No llama a ningún modelo: lee el CLI instalado (`--version` y su menú) y lo
 * último que se midió. Con `{ model?, effort? }` ubica ESA elección en vez de la
 * guardada: el panel le pasa la que tiene en pantalla.
 */
async function catalogoClaude(body) {
  const cfg = configDeClaudeCli();
  const inst = await claudeMedir.instalado();
  const cat = claudeModelos.catalogo({
    menu: inst.bin ? claudeMedir.menu(inst.bin) : [],
    medicion: claudeMedir.leerMedicion(),
    cli: inst.version,
    modelo: (body && body.model) || cfg.model,
    esfuerzo: (body && body.effort) || cfg.effort,
  });
  return Object.assign({ ok: true, instalado: Boolean(inst.bin) }, cat);
}

/**
 * Mide qué contesta cada modelo y devuelve el catálogo con lo medido. Es la que
 * corre sola al abrir ⚙ cuando el CLI cambió de versión desde la última vez.
 * El progreso va por `prog({ msg })`.
 */
async function medirModelosClaude(body, prog) {
  const avisar = typeof prog === 'function' ? prog : function () {};
  const r = await claudeMedir.medir(configDeClaudeCli(), {
    alAvanzar: (n, total) => avisar({ msg: 'Comprobando qué versiones ofrece tu plan… ' + n + '/' + total }),
  });
  const cat = await catalogoClaude(body);
  if (!r.ok) cat.estado = 'No pude comprobar las versiones: ' + r.error;
  else avisar({ note: 'Modelos de Claude medidos con Claude Code ' + r.cli + ': ' + resumenDeMedicion(r.medicion) });
  return Object.assign(cat, { medida: r.ok });
}

/** Una línea para el ⬇ Log: "opus → Opus 5.5 (1M) · claude-opus-4-1 ✗ …". */
function resumenDeMedicion(med) {
  const res = (med && med.resultados) || {};
  return Object.keys(res).map((k) => {
    const r = res[k];
    if (!r.resuelto) return k + ' ✗ ' + r.noDisponible;
    return k + ' → ' + (claudeModelos.etiquetaDeVersion(r.resuelto) || r.resuelto) +
      (r.ventana ? ' (' + claudeModelos.fmtVentana(r.ventana) + ')' : '');
  }).join(' · ');
}

/**
 * "Verificar": que el CLI esté al día y que lo elegido conteste.
 *
 * Los pasos, en orden, y por qué ese orden:
 *   1. Versión instalada y última de su canal, en paralelo.
 *   2. Si está atrasado, `claude update` — sin preguntar, como en Editor Pro:
 *      los modelos nuevos llegan con el CLI nuevo y no hay otra forma de que
 *      aparezcan. Actualiza también el Claude Code de la terminal, y se dice.
 *   3. La medición de todos los modelos (ver claude-medir.medir).
 *   4. Una llamada con la combinación ELEGIDA —modelo, ventana y pensamiento—,
 *      que es la que de verdad va a usar la generación.
 *
 * Si un paso falla se anota y se sigue: sin red no se pueden comparar versiones,
 * pero sí comprobar que la sesión contesta.
 */
async function verificarClaude(body, prog) {
  const avisar = typeof prog === 'function' ? prog : function () {};
  const cfg = configDeClaudeCli();
  const notas = [];

  avisar({ msg: 'Comprobando la versión de Claude Code…' });
  const [inst, ultima] = await Promise.all([claudeMedir.instalado(), claudeMedir.ultimaDelCanal()]);
  if (!inst.bin) {
    return { ok: false, error: inst.error || 'No encontré el CLI de Claude en esta máquina.', notas: notas, catalogo: await catalogoClaude(body) };
  }
  if (ultima.error) notas.push('no pude consultar la última versión (' + ultima.error + ')');

  let cli = inst.version;
  let actualizado = false;
  if (cli && ultima.version && claudeModelos.compararVersiones(cli, ultima.version) < 0) {
    const desde = cli;
    const paso = 'Actualizando Claude Code ' + desde + ' → ' + ultima.version + '…';
    // Se dice al empezar, no al primer segundo: un update que tarda menos que
    // eso pasaba sin que el editor se enterara de que su CLI cambió.
    avisar({ msg: paso });
    const r = await claudeMedir.actualizar(inst.bin, (s) => avisar({ msg: paso + ' ' + s + ' s' }));
    if (r.error) notas.push(r.error);
    else if (r.despues === desde) notas.push('Claude Code dice que ' + desde + ' es la última de su canal (' + ultima.canal + ')');
    else { cli = r.despues; actualizado = true; }
    avisar({ note: actualizado ? 'Claude Code actualizado: ' + desde + ' → ' + cli : 'No se actualizó Claude Code: ' + notas[notas.length - 1], level: actualizado ? 'INFO' : 'WARN' });
  }

  const m = await claudeMedir.medir(cfg, {
    otraVez: true,
    instalado: { bin: inst.bin, version: cli },
    alAvanzar: (n, total) => avisar({ msg: 'Comprobando qué versiones responden… ' + n + '/' + total }),
  });
  if (!m.ok) notas.push('no pude comprobar las versiones (' + m.error + ')');
  else avisar({ note: 'Modelos de Claude medidos con Claude Code ' + m.cli + ': ' + resumenDeMedicion(m.medicion) });

  avisar({ msg: 'Probando el modelo elegido…' });
  const s = await claudeMedir.sondear(inst.bin, cfg.model, cfg, { esfuerzo: cfg.effort });
  const cat = await catalogoClaude(body);
  if (!m.ok) cat.estado = 'No pude comprobar las versiones: ' + m.error;
  const base = { cli: cli, actualizado: actualizado, ultima: ultima.version, notas: notas, catalogo: cat };
  if (!s.contesto) return Object.assign({ ok: false, error: 'Claude no contestó con lo elegido: ' + s.error }, base);
  return Object.assign({ ok: true, resumen: claudeModelos.resumen(cat) }, base);
}

// Los dos de arriba, para Cursor. Mismo contrato y mismos tres estados, porque
// del lado del panel el cartel es el mismo y no tiene por qué saber con cuál de
// los dos proveedores está hablando (ver cursor-session.js).
function cursorCliStatus() {
  return cursorSession.diagnose(loadConfig());
}

async function cursorSessionStatus() {
  const cfg = loadConfig();
  return providerSalud.aplicarA('cursor-cli', await cursorSession.estadoDeSesion(cfg));
}

const REPO_ROOT = path.join(__dirname, '..');

// Números de marcador que el editor nombró en su instrucción ("seguí el estilo
// del marcador 3", "como los marcadores 2 y 5"). Se exige la palabra "marcador"
// pegada al número: un número suelto casi siempre es del contenido de la clase
// ("los 3 pasos"), no una referencia.
function referencedMarkerNumbers(text) {
  const out = [];
  const re = /marcador(?:es)?\s*(?:n[°ºo]\.?\s*)?(\d+(?:\s*(?:,|y|&)\s*\d+)*)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    for (const n of m[1].split(/\s*(?:,|y|&)\s*/)) {
      const v = parseInt(n, 10);
      if (v > 0 && out.indexOf(v) === -1) out.push(v);
    }
  }
  return out;
}

// Qué slug de los que hay en disco es "el marcador n". Lo normal es que la
// herramienta los haya nombrado ella ("Marcador 3"); un marcador renombrado en
// Premiere puede traer otro texto, y ahí alcanza con que termine en ese número
// ("Paso 3"). El nombre canónico gana siempre, para que "Marcador 3" no pierda
// contra un "Paso 3" que estaba antes en la lista.
function findMarkerSlug(slugs, n) {
  const canonico = new RegExp('^marcador\\s*0*' + n + '$', 'i');
  const termina = new RegExp('(^|[^0-9])0*' + n + '$');
  return slugs.find((s) => canonico.test(String(s).trim())) ||
    slugs.find((s) => termina.test(String(s).trim()));
}

// Junta el HTML de la última versión de OTROS marcadores de esta clase, para dar
// continuidad. Dos modos:
//
// - Con marcadores NOMBRADOS (`wanted`): van esos y nada más, y van ENTEROS. Si
//   pediste el estilo del 3, mandarle además el 1 y el 2 no es contexto, es
//   ruido caro; y recortarlo a la mitad le esconde justo el final del script,
//   que es donde vive el movimiento que querés repetir.
// - Sin nombrar ninguno ("mantené el mismo estilo", a secas): los primeros que
//   entren en un presupuesto chico, como antes.
//
// Devuelve { items, missing }: `missing` son los números que pediste y todavía
// no tienen ningún diseño generado, para poder avisarlo en vez de ignorarlo.
function listOtherResources(baseDir, currentSlug, wanted) {
  const bySlug = groupBySlug(baseDir, motores.extensiones());
  const slugs = Object.keys(bySlug).filter((s) => s !== currentSlug);
  const items = [];
  const missing = [];

  function push(slug, maxChars) {
    const latest = bySlug[slug][bySlug[slug].length - 1]; // orden ascendente → última
    const c = composicionDeVersion(baseDir, slug, latest.version);
    if (!c) return 0;
    // El aviso del recorte se escribe con el comentario del LENGUAJE del
    // archivo: un `<!-- … -->` pegado al final de un .tsx es un error de
    // sintaxis, y lo que el modelo ve a continuación es código roto.
    let html = c.code;
    if (html.length > maxChars) html = html.slice(0, maxChars) + '\n' + c.motor.lenguaje.comentario('…(recortado)…');
    items.push({ slug: slug + ' v' + latest.version, html: html, engine: c.motor.id });
    return html.length;
  }

  const pedidos = Array.isArray(wanted) ? wanted : [];
  if (pedidos.length) {
    for (const n of pedidos) {
      // Nombrarse a sí mismo ("el marcador 3" estando en el 3) no es continuidad
      // ni es un error: su propio HTML ya viaja aparte en el refinamiento.
      if (findMarkerSlug([currentSlug], n)) continue;
      const slug = findMarkerSlug(slugs, n);
      if (slug) push(slug, 12000); // tope alto: que entre entero, pero acotado
      else missing.push(n);
    }
    return { items: items, missing: missing };
  }

  let budget = 6000; // tope total de chars para no inflar tokens
  for (const slug of slugs) {
    if (budget <= 0) break;
    budget -= push(slug, 4000);
  }
  return { items: items, missing: missing };
}

// Lee un PNG (el frame capturado por host.jsx) y lo devuelve como dataURL.
// Borra el archivo temporal después. Lo hace Node (fiable), no la API de CEP.
// Guarda una captura del programa en la carpeta de la secuencia (para tener todo
// el contexto en disco) y devuelve su dataUrl para usarla como still. Mueve el
// PNG temporal a "<seq>/_capturas/<marcador>-<stamp>.png".
function saveCapture(body) {
  try {
    body = body || {};
    const tmpPath = body.tmpPath;
    if (!tmpPath || !fs.existsSync(tmpPath)) return { ok: false, error: 'no existe la captura: ' + tmpPath };
    const baseDir = ensureOutputDir(body.projectPath, body.sequenceName);
    const capDir = path.join(baseDir, '_capturas');
    fs.mkdirSync(capDir, { recursive: true });
    const slug = String(body.markerSlug || 'general').replace(/[^a-zA-Z0-9._-]+/g, '-') || 'general';
    const stamp = (path.basename(tmpPath).match(/\d+/) || [String(Date.now())])[0];
    const dest = path.join(capDir, slug + '-' + stamp + '.png');
    fs.copyFileSync(tmpPath, dest);
    try { fs.unlinkSync(tmpPath); } catch (e) {}
    const b64 = fs.readFileSync(dest).toString('base64');
    if (!b64) return { ok: false, error: 'la captura quedó vacía' };
    return { ok: true, dataUrl: 'data:image/png;base64,' + b64, savedPath: dest };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

function getVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'version.json'), 'utf8')).version || '0.0.0';
  } catch (e) { return '0.0.0'; }
}

// Corre un comando git dentro del repo. Devuelve { code, out, err } (nunca lanza).
function gitRun(args) {
  return run('git', ['-C', REPO_ROOT].concat(args), { timeoutMs: 90_000, shell: IS_WIN });
}

// ── Auto-update INDEPENDIENTE DE GIT ────────────────────────────────────────
// El botón ⟳ debe funcionar para CUALQUIER instalación (ZXP empaquetado o dev
// con git), sin exigir git ni un checkout al usuario final. Estrategia:
//   - Instalación dev (hay .git en REPO_ROOT) → seguimos con git (fetch+reset).
//   - Instalación empaquetada (sin .git)      → bajamos el zip público de GitHub
//     y reemplazamos los archivos en su lugar, preservando bridge/node_modules
//     (410 MB, se instala una sola vez) y con respaldo para poder revertir.
const GH_OWNER = 'DanielGutierrezB';
const GH_REPO = 'HyperPremiere';
const GH_BRANCH = 'main';
// De dónde se lee la versión publicada, y por qué en ese orden:
//
// raw.githubusercontent.com se sirve por un CDN que cachea POR RUTA (5 min o
// más) e IGNORA el "?t=<ahora>" que le colgábamos para esquivarlo. Resultado:
// durante minutos devolvía la versión ANTERIOR y el panel concluía "estás al
// día". Ese fue el bug: la detección quedaba ciega sin que se notara.
//
// La API de contenidos lee el archivo del commit actual de la rama, sin esa
// capa de caché. Es la fuente principal. `raw` queda de RESPALDO: si la API no
// contesta, una respuesta posiblemente vieja sirve más que ninguna — pero se
// marca como tal (ver decideUpdate) para no volver a mentir "estás al día".
const API_VERSION_URL = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/version.json?ref=${GH_BRANCH}`;
const RAW_VERSION_URL = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/version.json`;
const ZIP_URL = `https://codeload.github.com/${GH_OWNER}/${GH_REPO}/zip/refs/heads/${GH_BRANCH}`;

function isGitRepo() {
  try { return fs.existsSync(path.join(REPO_ROOT, '.git')); } catch (e) { return false; }
}

// Compara "1.0.55" vs "1.0.54". >0 si a>b, <0 si a<b, 0 iguales.
function cmpVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Un pedido a una de las dos fuentes. Nunca lanza: devuelve
//   { ok:true, version, source } | { ok:false, error }
// `source` es 'api' (fresca) o 'raw' (puede venir cacheada y atrasada).
async function readVersionFrom(url, source, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // GitHub RECHAZA con 403 cualquier pedido a la API sin User-Agent, así que
    // no es cosmético: sin esto la fuente principal no funciona nunca.
    const headers = source === 'api'
      ? {
          'accept': 'application/vnd.github+json',
          'user-agent': 'HyperPremiere/' + getVersion(),
          'x-github-api-version': '2022-11-28',
        }
      : { 'user-agent': 'HyperPremiere/' + getVersion() };
    const res = await hpFetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      // Sin autenticar son 60 consultas por hora por IP. El panel gasta 2, pero
      // si se agotan (otro programa en la misma red, por ejemplo) hay que
      // DECIRLO: es exactamente el caso que antes se leía como "no hay update".
      if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
        return { ok: false, error: 'GitHub limitó las consultas por un rato (60 por hora sin cuenta); se repone solo.' };
      }
      return { ok: false, error: 'HTTP ' + res.status };
    }
    const data = JSON.parse(await res.text());
    // La API devuelve el archivo en base64; raw lo devuelve tal cual.
    const texto = source === 'api'
      ? Buffer.from(String(data.content || ''), data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
      : null;
    const version = String((texto ? JSON.parse(texto) : data).version || '').trim();
    if (!version) return { ok: false, error: 'la respuesta no traía número de versión' };
    return { ok: true, version, source };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// Lee la versión publicada en GitHub: API primero, raw de respaldo.
// Nunca lanza: { ok:true, version, source } | { ok:false, error }.
async function fetchRemoteVersion(opts) {
  opts = opts || {};
  const api = await readVersionFrom(opts.apiUrl || API_VERSION_URL, 'api', 12_000);
  if (api.ok) return api;

  const raw = await readVersionFrom(opts.rawUrl || RAW_VERSION_URL, 'raw', 8_000);
  if (raw.ok) return Object.assign(raw, { apiError: api.error });
  return { ok: false, error: 'la API dijo "' + api.error + '" y el respaldo "' + raw.error + '"' };
}

// Traduce (versión instalada + respuesta de GitHub) al estado que ve el editor.
//
// La distinción que importa: `changed:false` con `verified:false` significa
// "no pude averiguarlo", NO "estás al día". Una fuente cacheada puede estar
// ATRASADA, nunca adelantada: si dice que hay versión nueva es verdad, pero si
// dice que no hay, puede estar mintiendo. Por eso solo la API (o git) alcanzan
// para afirmar que no hay nada nuevo.
function decideUpdate(current, r) {
  if (!r.ok) {
    return { ok: false, current, changed: false, verified: false, error: 'No se pudo consultar GitHub: ' + r.error };
  }
  const changed = cmpVersions(r.version, current) > 0;
  const out = { ok: true, current, remote: r.version, changed, verified: changed || r.source === 'api', source: r.source };
  if (!out.verified) {
    out.error = 'No pude confirmar si hay una versión nueva: la API de GitHub falló (' +
      (r.apiError || 'sin detalle') + ') y el respaldo puede estar atrasado.';
  }
  return out;
}

// Descarga el zip del branch a un archivo local.
async function downloadZip(destFile) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await hpFetch(ZIP_URL, { signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' al descargar el zip');
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('el zip vino vacío');
    fs.writeFileSync(destFile, buf);
  } finally {
    clearTimeout(timer);
  }
}

// Extrae el zip a destDir usando la herramienta nativa del SO (sin dependencias).
async function extractZip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = IS_WIN
    ? await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${destDir}' -Force`])
    : await run('unzip', ['-o', '-q', zipFile, '-d', destDir]);
  // unzip escribe sus quejas en stdout, así que solo con stderr esto no decía nada.
  if (r.code !== 0) throw new Error('no se pudo descomprimir: ' + salidaDe(r, 'código ' + r.code).slice(0, 200));
}

// Filtro compartido: nunca copiamos node_modules, .git ni basura del SO.
function skipPathForCopy(p) {
  const n = String(p).replace(/\\/g, '/');
  return /\/node_modules(\/|$)/.test(n) || /\/\.git(\/|$)/.test(n) || /\/\.DS_Store$/.test(n);
}

// Aplica la actualización empaquetada: baja el zip, arma el árbol instalable
// (cep/* en la raíz + bridge/ + version.json) y lo escribe SOBRE REPO_ROOT.
// Preserva bridge/node_modules (no lo toca) y respalda el código para revertir
// si la escritura falla a mitad de camino.
async function applyPackagedUpdate() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-update-'));
  const zipFile = path.join(tmpBase, 'src.zip');
  const exDir = path.join(tmpBase, 'extract');
  const stage = path.join(tmpBase, 'stage');
  const backup = path.join(tmpBase, 'backup');
  try {
    await downloadZip(zipFile);
    await extractZip(zipFile, exDir);

    // El zip de un branch se extrae como "<repo>-<branch>/…": tomamos ese dir.
    const rootName = fs.readdirSync(exDir).find((n) => {
      try { return fs.statSync(path.join(exDir, n)).isDirectory(); } catch (e) { return false; }
    });
    if (!rootName) throw new Error('el zip no trajo contenido');
    const srcRoot = path.join(exDir, rootName);
    const srcCep = path.join(srcRoot, 'cep');
    const srcBridge = path.join(srcRoot, 'bridge');
    const srcVer = path.join(srcRoot, 'version.json');
    if (!fs.existsSync(path.join(srcCep, 'index.html')) ||
        !fs.existsSync(path.join(srcBridge, 'engine.js')) ||
        !fs.existsSync(srcVer)) {
      throw new Error('el zip no tiene la estructura esperada (cep/index.html + bridge/engine.js)');
    }

    // Árbol EMPAQUETADO en staging (igual que hace scripts/sign-zxp.js).
    fs.mkdirSync(stage, { recursive: true });
    fs.cpSync(srcCep, stage, { recursive: true, filter: (s) => !skipPathForCopy(s) });
    fs.cpSync(srcBridge, path.join(stage, 'bridge'), { recursive: true, filter: (s) => !skipPathForCopy(s) });
    fs.copyFileSync(srcVer, path.join(stage, 'version.json'));

    // Respaldo del código vivo (sin node_modules) por si la escritura falla.
    fs.cpSync(REPO_ROOT, backup, { recursive: true, filter: (s) => !skipPathForCopy(s) });

    // Escribir SOBRE la instalación viva. No tocamos bridge/node_modules
    // (el stage no lo contiene), así preservamos las deps ya instaladas.
    try {
      fs.cpSync(stage, REPO_ROOT, { recursive: true, force: true });
    } catch (e) {
      // Revertir con el respaldo.
      try { fs.cpSync(backup, REPO_ROOT, { recursive: true, force: true }); } catch (_) {}
      throw new Error('falló la escritura; restauré el respaldo: ' + ((e && e.message) || e));
    }
  } finally {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (e) {}
  }
}

// Chequea GitHub SIN aplicar. Devuelve
// { ok, current, remote, changed, verified, source }.
//   ok:false            → no se pudo consultar (hay `error` para mostrar).
//   changed:false + verified:true  → estás al día, confirmado.
//   changed:false + verified:false → NO SE SABE (respondió el respaldo cacheado).
async function checkUpdate(opts) {
  const current = getVersion();
  if (isGitRepo()) {
    // Instalación de desarrollo: git es la fuente más fresca que hay y no pasa
    // por ningún CDN. Se compara por COMMIT, no por versión, para que se vean
    // también los cambios que todavía no subieron el número.
    const f = await gitRun(['fetch', 'origin', 'main']);
    if (f.code !== 0) return { ok: false, current, changed: false, verified: false, error: 'No se pudo consultar GitHub: ' + salidaDe(f, 'fetch falló').slice(0, 200) };
    const rv = await gitRun(['show', 'origin/main:version.json']);
    let remote = current;
    try { remote = JSON.parse(rv.out).version || remote; } catch (e) {}
    const cnt = await gitRun(['rev-list', '--count', 'HEAD..origin/main']);
    const behind = parseInt((cnt.out || '0').trim(), 10) || 0;
    return { ok: true, current, remote, behind, changed: behind > 0, verified: true, source: 'git' };
  }
  return checkPackagedUpdate(current, opts);
}

// El chequeo de la instalación empaquetada (ZXP), aparte para poder probarlo
// contra un GitHub de mentira sin depender de si esta copia tiene .git.
// Solo hacia ADELANTE: ⟳ nunca "baja" una instalación adelantada respecto de main.
async function checkPackagedUpdate(current, opts) {
  return decideUpdate(current, await fetchRemoteVersion(opts));
}

// Actualiza el plugin a la versión remota. Instalación git → reset --hard;
// instalación empaquetada → descarga+reemplazo. Devuelve
// { ok, changed, version, previous, remoteVersion }.
async function selfUpdate(opts) {
  const before = getVersion();

  // Una sola fuente de verdad para los dos caminos: si ⟳ y el aviso automático
  // usaran criterios distintos, volveríamos a tener un panel que dice una cosa
  // y hace otra.
  const chk = await checkUpdate(opts);
  if (!chk.ok) return { ok: false, error: chk.error };
  if (!chk.changed) {
    return { ok: true, changed: false, verified: chk.verified, version: before, remoteVersion: chk.remote, error: chk.error };
  }

  if (isGitRepo()) {
    const r = await gitRun(['reset', '--hard', 'origin/main']);
    if (r.code !== 0) return { ok: false, error: 'No se pudo aplicar la actualización: ' + salidaDe(r, 'reset falló').slice(0, 200) };
    return { ok: true, changed: true, verified: true, version: getVersion(), previous: before, remoteVersion: chk.remote };
  }

  // Instalación empaquetada (ZXP): descarga + reemplazo, sin git.
  try {
    await applyPackagedUpdate();
    return { ok: true, changed: true, verified: true, version: getVersion(), previous: before, remoteVersion: chk.remote };
  } catch (e) {
    return { ok: false, error: 'No se pudo actualizar: ' + ((e && e.message) || e) };
  }
}


// ── Correcciones: reconstruir lo ya generado mirando el disco ───────────
// La pestaña Corrections trabaja SIN los marcadores de Premiere. Cuando el
// editor vuelve de la revisión, los marcadores pueden estar borrados, movidos o
// mezclados con los comentarios de Frame.io, y volver a abrirlos no es opción.
// Todo lo que hace falta para rediseñar y recolocar sale de la carpeta de la
// secuencia: el HTML de cada versión y la ficha con el tramo del timeline.

/**
 * Dónde iba un recurso, buscando de la fuente más confiable a la más pobre:
 *
 *   ficha → la meta de la versión (`marker.start` / `marker.duration`).
 *   cola  → queue.json, que guarda los tiempos de cada trabajo encolado.
 *   html  → `data-duration` de la composición: da cuánto dura, no dónde iba.
 *
 * Devuelve siempre un objeto; `source` vacío significa "no hay dato en disco",
 * y ahí es el editor quien lo escribe a mano.
 *
 * `ctx` = { folderSlug, queueJobs } — los trabajos de la cola se leen una vez
 * para toda la lista y se pasan ya cargados.
 */
function findMarkerPosition(baseDir, slug, versions, ctx) {
  const out = {
    start: null, duration: null, markerName: '', markerGuid: '', instruction: '',
    history: [], background: false, source: '',
    // Los tres niveles con los que se generó, y de qué versión salió ese
    // registro. 0 = ninguna lo guardó (un recurso generado antes de que la ficha
    // empezara a anotarlo, o una edición manual sin nada atrás): entonces no se
    // puede saber qué se mandó, y eso hay que DECIRLO, no rellenarlo con los
    // archivos de hoy y callarse.
    prompts: null, promptsVersion: 0,
  };

  // 1) La ficha, empezando por la versión más nueva. Se recorren TODAS y no se
  // corta en la primera que tiene el tramo: el encargo y el fondo pueden faltar
  // justo en la más nueva (un render manual viejo no los escribía) y estar
  // guardados en una anterior.
  let fondoLeido = false;
  for (let i = versions.length - 1; i >= 0; i--) {
    const metaPath = versionFile(baseDir, slug, versions[i].version, '.meta.json');
    const meta = metaPath ? readMeta(metaPath) : null;
    if (!meta) continue;
    // "(edición manual)" no es un encargo: es el sello de un render sin IA.
    const encargo = String(meta.instruction || '').trim();
    if (!out.instruction && encargo && encargo !== '(edición manual)') out.instruction = encargo;
    if (!out.history.length && Array.isArray(meta.history)) out.history = meta.history;
    // Se recorre de la versión más nueva a la más vieja, así que la primera que
    // aparece es la última que lo guardó. Un render manual no anota nada (no
    // llamó al modelo), y ésa es justo la razón de seguir bajando en vez de
    // quedarse con la ficha de arriba.
    if (!out.prompts && meta.prompts && typeof meta.prompts === 'object') {
      out.prompts = meta.prompts;
      out.promptsVersion = versions[i].version;
    }
    // Con o sin fondo se decidió cuando se generó; la corrección tiene que
    // salir igual o cambiaría de opaco a transparente sin que nadie lo pida.
    // Una ficha que no lo declara no está diciendo "sin fondo": no sabe, y se
    // sigue buscando en las anteriores.
    if (!fondoLeido && typeof meta.background === 'boolean') { out.background = meta.background; fondoLeido = true; }
    const m = meta.marker || {};
    const dur = Number(m.duration);
    if (!(dur > 0) || out.source) continue;
    out.start = Number(m.start) || 0;
    out.duration = dur;
    out.markerName = meta.markerName || m.name || '';
    out.markerGuid = meta.markerGuid || m.guid || '';
    out.source = 'ficha';
  }
  if (out.source) return out;

  // 2) La cola del proyecto: los trabajos guardan el tramo aunque falte la ficha.
  // Se compara por CARPETA y no por nombre de secuencia: la carpeta es el dato
  // que siempre existe (el nombre real depende de que haya transcript o ficha), y
  // el mismo "Marcador 1" de otra clase daría un segundo que no le corresponde.
  for (const job of ctx.queueJobs) {
    if (!job || job.markerKey !== slug) continue;
    if (job.seqName && slugify(job.seqName) !== ctx.folderSlug) continue;
    const dur = Number(job.markerDuration);
    if (!(dur > 0)) continue;
    out.start = Number(job.markerStart) || 0;
    out.duration = dur;
    out.source = 'cola';
    return out;
  }

  // 3) El código: la duración puede estar declarada en la composición, la
  // posición nunca. Y "puede": en HyperFrames está (`data-duration` en el
  // `#stage`), en Remotion NO está por diseño —el componente la lee de
  // `useVideoConfig()` justamente para no desincronizarse del marcador—. Se le
  // pregunta al motor de CADA versión y el que no la declara contesta 0, que es
  // la verdad; acá había un `motor('hyperframes')` y un `'.html'` escritos a
  // mano, que es exactamente lo que el registro existe para impedir.
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = composicionDeVersion(baseDir, slug, versions[i].version);
    if (!v) continue;
    const dur = v.motor.duracionDeclarada(v.code);
    if (dur > 0) { out.duration = dur; out.source = 'html'; return out; }
  }

  return out;
}

/**
 * El nombre REAL de la secuencia de una carpeta. La carpeta se llama con el
 * slug (sin acentos ni mayúsculas), que no sirve para volver a encontrar la
 * secuencia en Premiere ni para mostrarle al editor.
 */
function sequenceNameOfDir(dir, groups) {
  for (const file of [TRANSCRIPT_FILE, TRANSCRIPT_FILE_LEGACY]) {
    const t = readMeta(path.join(dir, file));
    if (t && t.sequenceName) return String(t.sequenceName);
  }
  // Sin transcript, la ficha lo guarda desde la v1.4.33.
  for (const slug of Object.keys(groups)) {
    for (const v of groups[slug]) {
      const c = composicionDeVersion(dir, slug, v.version);
      if (c && c.ficha.sequenceName) return String(c.ficha.sequenceName);
    }
  }
  return '';
}

/**
 * ¿Son la misma secuencia con distinto sufijo? Se pide que la parte de más
 * empiece con "-" para que "clase-10" no pase por pariente de "clase-1".
 */
function slugsParientes(a, b) {
  if (a === b) return true;
  const largo = a.length > b.length ? a : b;
  const corto = a.length > b.length ? b : a;
  return largo.indexOf(corto) === 0 && largo.charAt(corto.length) === '-';
}

/**
 * Todas las carpetas del proyecto que TIENEN recursos generados.
 *
 * La pestaña no puede limitarse a la carpeta de la secuencia abierta: para
 * cuando llegan las correcciones, la clase suele estar re-cortada o renombrada
 * ("_02", "v2", "copia"), y entonces el editor está parado en una secuencia
 * cuya carpeta está vacía mientras lo generado vive en la de al lado.
 */
function correctionSources(root) {
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    // `_assets`, `_capturas` y los `.DS_Store` de macOS no son secuencias.
    if (name.charAt(0) === '.' || name.charAt(0) === '_') continue;
    const dir = path.join(root, name);
    let st = null;
    try { st = fs.statSync(dir); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    const groups = groupBySlug(dir, motores.extensiones());
    const count = Object.keys(groups).length;
    if (!count) continue;
    // El nombre puede no estar (una clase vieja, sin transcript ni ficha): se
    // deja vacío para que lo resuelva quien sabe cuál es la secuencia abierta.
    out.push({
      slug: name,
      sequenceName: sequenceNameOfDir(dir, groups),
      count: count,
      at: st.mtimeMs || 0,
    });
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

/**
 * Qué carpeta mirar. La de la secuencia abierta si tiene algo; si no, la que
 * sea su misma secuencia con un sufijo distinto —el patrón de la clase
 * re-cortada— y ahí se avisa que la elección fue nuestra. Se exige que un slug
 * sea prefijo del otro: sin eso, "parecido" acabaría eligiendo cualquier cosa.
 */
function pickCorrectionSource(sources, activeSlug, wanted) {
  if (wanted) {
    const exacta = sources.find((s) => s.slug === wanted);
    if (exacta) return { source: exacta, guessed: false };
  }
  const propia = sources.find((s) => s.slug === activeSlug);
  if (propia) return { source: propia, guessed: false };
  const parientes = sources
    .filter((s) => slugsParientes(s.slug, activeSlug))
    .sort((a, b) => b.slug.length - a.slug.length);
  if (parientes.length) return { source: parientes[0], guessed: true };
  return { source: null, guessed: false };
}

/** Los slugs "Marcador N" se ordenan por número; el resto, alfabético. */
function compareSlugs(a, b) {
  const na = /^Marcador (\d+)$/.exec(a);
  const nb = /^Marcador (\d+)$/.exec(b);
  if (na && nb) return parseInt(na[1], 10) - parseInt(nb[1], 10);
  if (na) return -1;
  if (nb) return 1;
  return a < b ? -1 : (a > b ? 1 : 0);
}

/**
 * Todo lo generado, listo para corregir. Por defecto la carpeta de la secuencia
 * abierta; `body.folderSlug` fuerza otra, que es lo que hace falta cuando la
 * clase se volvió a cortar con otro nombre.
 *
 * Devuelve { ok, sequenceName, sourceSequenceName, folderSlug, guessed,
 * sources: [...], markers: [...] }. `sources` viaja siempre: es lo que le
 * permite al panel ofrecer las demás carpetas en vez de decir "no hay nada".
 */
function listCorrections(body) {
  try {
    body = body || {};
    const sequenceName = String(body.sequenceName || '');
    // Consulta de solo lectura: no crear la carpeta por abrir la pestaña.
    const activeDir = outputDirPath(body.projectPath, sequenceName);
    const activeSlug = path.basename(activeDir);
    const root = path.dirname(activeDir);
    const sources = correctionSources(root);
    // La carpeta de la secuencia abierta es la única cuyo nombre real sabemos sin
    // leer nada: es el que mandó Premiere.
    for (const s of sources) {
      if (!s.sequenceName) s.sequenceName = (s.slug === activeSlug) ? sequenceName : s.slug;
    }
    const elegida = pickCorrectionSource(sources, activeSlug, String(body.folderSlug || ''));
    const vacio = {
      ok: true, sequenceName, sourceSequenceName: '', folderSlug: '',
      baseDir: activeDir, guessed: false, sources, markers: [],
      promptsNow: { course: '', sequence: '', failed: false },
    };
    if (!elegida.source) return vacio;

    const folderSlug = elegida.source.slug;
    const baseDir = path.join(root, folderSlug);
    const sourceSequenceName = elegida.source.sequenceName;

    const byHtml = groupBySlug(baseDir, motores.extensiones());
    const byVideo = groupBySlug(baseDir, ['.mov', '.mp4']);
    // La cola se lee una vez para toda la lista: es el respaldo de los recursos
    // a los que les falta la ficha, y son varios en las clases viejas.
    const queueJobs = loadQueue({ projectPath: body.projectPath }).jobs || [];
    // Los dos prompts generales COMO ESTÁN HOY, leídos una sola vez para toda la
    // lista. No son "lo que recibió" ningún recurso: son los archivos de este
    // momento, y sirven para los recursos cuya ficha no guardó nada — ahí es lo
    // único que se puede ofrecer, y el panel lo tiene que mostrar diciendo que es
    // una reconstrucción. Se leen contra la secuencia de ORIGEN, que es la misma
    // contra la que los va a resolver la cola al momento de generar.
    const ahora = loadGeneralPrompt({ projectPath: body.projectPath, sequenceName: sourceSequenceName });
    const markers = Object.keys(byHtml).sort(compareSlugs).map((slug) => {
      const versions = byHtml[slug];
      const videos = byVideo[slug] || [];
      const hasVideo = (v) => videos.some((e) => e.version === v);
      const latest = versions[versions.length - 1];
      const pos = findMarkerPosition(baseDir, slug, versions, { folderSlug, queueJobs });
      // Con qué motor se hizo CADA versión, no solo la última: el editor de
      // código abre la que quiera, y de eso depende con qué resaltarla y con
      // qué re-renderizarla. Una clase puede tener versiones de los dos.
      const motorDe = (v) => {
        const c = composicionDeVersion(baseDir, slug, v.version);
        return c ? c.motor.id : motores.PREDETERMINADO;
      };
      return {
        slug,
        latestVersion: latest.version,
        model: latest.model || '',
        engine: motorDe(latest),
        versions: versions.map((v) => ({
          version: v.version, model: v.model || '', engine: motorDe(v), hasVideo: hasVideo(v.version),
        })),
        start: pos.start,
        duration: pos.duration,
        timeSource: pos.source,
        markerName: pos.markerName,
        markerGuid: pos.markerGuid,
        instruction: pos.instruction,
        history: pos.history,
        background: pos.background,
        // Lo que este marcador recibió DE VERDAD, si su ficha lo guardó, y de
        // qué versión salió. `null` = de este recurso no se puede saber.
        prompts: pos.prompts,
        promptsVersion: pos.promptsVersion,
      };
    });
    return {
      ok: true, sequenceName, sourceSequenceName, folderSlug,
      baseDir, guessed: elegida.guessed, sources, markers,
      promptsNow: {
        course: ahora.projectText || '',
        sequence: ahora.sequenceText || '',
        // Que no se hayan podido leer no es lo mismo que que no haya estilo: el
        // proyecto puede estar en un disco desmontado, y ahí el panel tiene que
        // decir que no sabe en vez de dibujar dos campos vacíos.
        failed: ahora.ok === false,
      },
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), sources: [], markers: [] };
  }
}







// Limpia VIDEOS de versiones viejas de una secuencia —o de UN marcador, si viene
// `markerSlug`—: deja solo el video (.mov/.mp4) de la ÚLTIMA versión y borra los
// anteriores. NO toca las composiciones (historial/editor, y lo que la pestaña
// Corrections necesita para volver sobre una versión vieja) ni stills/recursos:
// el peso está en los videos, esos archivos son kilobytes. Devuelve cuánto liberó.
// Agrupa los archivos de VIDEO por marcador con su versión: { slug: [{name,version,path,size}] }.
function groupMarkerVideos(baseDir) {
  const grouped = groupBySlug(baseDir, ['.mov', '.mp4']);
  const bySlug = {};
  Object.keys(grouped).forEach((slug) => {
    bySlug[slug] = grouped[slug].map((e) => {
      const full = path.join(baseDir, e.name);
      let size = 0; try { size = fs.statSync(full).size; } catch (err) {}
      return { name: e.name, version: e.version, path: full, size };
    });
  });
  return bySlug;
}

// Calcula los VIDEOS de versiones viejas (no-últimas) de una secuencia. SIN borrar.
// Con `markerSlug` se limita a ESE marcador: es la limpieza que se pide desde un
// job terminado, cuando el editor quedó conforme con un recurso y no quiere
// tocar los demás (que pueden estar a medio aprobar).
function oldVersionVideos(projectPath, sequenceName, markerSlug) {
  // Mirar qué hay (y después borrar) nunca necesita la carpeta creada: sin ella
  // no hay videos viejos, que es la lista vacía de siempre.
  const bySlug = groupMarkerVideos(outputDirPath(projectPath, sequenceName));
  const out = [];
  Object.keys(bySlug).forEach((slug) => {
    if (markerSlug && slug !== markerSlug) return;
    const list = bySlug[slug];
    let maxV = 0; list.forEach((x) => { if (x.version > maxV) maxV = x.version; });
    list.forEach((x) => { if (x.version < maxV) out.push({ name: x.name, path: x.path, size: x.size }); });
  });
  return out;
}

// Lista (sin borrar) los videos de versiones viejas → el panel primero saca esos
// ítems de la secuencia/proyecto en Premiere y RECIÉN después borra los archivos.
function listOldVersions(body) {
  try {
    body = body || {};
    return { ok: true, files: oldVersionVideos(body.projectPath, body.sequenceName, body.markerSlug) };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e), files: [] }; }
}

// Vista previa para la confirmación: por marcador, qué se BORRA y cuál se CONSERVA
// (la última versión). Devuelve grupos + totales. No borra nada.
function cleanupPreview(body) {
  try {
    body = body || {};
    const bySlug = groupMarkerVideos(outputDirPath(body.projectPath, body.sequenceName));
    const groups = []; let totalDeletes = 0, totalBytes = 0;
    Object.keys(bySlug).forEach((slug) => {
      if (body.markerSlug && slug !== body.markerSlug) return;
      const list = bySlug[slug].slice().sort((a, b) => a.version - b.version);
      let maxV = 0; list.forEach((x) => { if (x.version > maxV) maxV = x.version; });
      const keep = list.filter((x) => x.version === maxV)[0] || null;
      const deletes = list.filter((x) => x.version < maxV).map((x) => ({ name: x.name, version: x.version, size: x.size }));
      if (deletes.length) {
        deletes.forEach((d) => { totalDeletes++; totalBytes += d.size || 0; });
        groups.push({ slug, keep: keep ? { name: keep.name, version: keep.version } : null, deletes });
      }
    });
    return { ok: true, sequenceName: body.sequenceName, groups, totalDeletes, totalBytes };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e), groups: [] }; }
}

function cleanOldVersions(body) {
  try {
    body = body || {};
    const list = oldVersionVideos(body.projectPath, body.sequenceName, body.markerSlug);
    let deleted = 0, freed = 0; const names = [];
    list.forEach((x) => {
      try { fs.unlinkSync(x.path); deleted++; freed += x.size; names.push(x.name); } catch (e) {}
    });
    return { ok: true, deleted, freedBytes: freed, names };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

// ── Preparación del motor (autocontenido) ───────────────────────────────
// El ZXP trae el CÓDIGO del motor (bridge/) pero NO node_modules (410 MB,
// binarios nativos por plataforma). En la 1ª corrida de una instalación limpia
// instalamos las deps una sola vez con el npm del sistema, dentro de bridge/.
function engineDepsReady() {
  try {
    const bin = path.join(__dirname, 'node_modules', '.bin', IS_WIN ? 'hyperframes.cmd' : 'hyperframes');
    return fs.existsSync(bin);
  } catch (e) { return false; }
}
function engineStatus() {
  return {
    ok: true,
    depsReady: engineDepsReady(),
    bridgeDir: __dirname,
    platform: process.platform,
    // Cuántos renders aguanta esta máquina en paralelo. La decide el módulo de
    // render (que ya perfila RAM/cores) y la cola la usa como techo de su carril.
    renderLanes: renderLanes(),
    // Y en qué estado está cada motor de animación. Va acá además de en la
    // config porque este es el chequeo que el panel corre AL ABRIRSE: si
    // Remotion quedó a medio instalar (un npm install cortado, el Chrome sin
    // extraer), el editor se entera antes de encolar veinte marcadores que van a
    // fallar todos por lo mismo.
    motores: motores.catalogo(),
  };
}

/**
 * Instala un motor a pedido. `{ engine: 'remotion' }`.
 *
 * Es aparte de "Preparar motor" —que instala las dependencias del panel— porque
 * lo que se baja acá es de OTRO tamaño y para OTRA cosa: Remotion son ~400 MB
 * (React, webpack, su Chrome Headless Shell) y solo los necesita quien elija
 * ese motor. Meterlo en la preparación inicial sería cobrarle esa descarga a
 * todos los editores, incluidos los que nunca lo van a usar.
 */
async function installRenderEngine(body, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  const id = String((body || {}).engine || '').trim().toLowerCase();
  if (!motores.existe(id)) return { ok: false, error: 'no conozco el motor "' + id + '"' };
  const motor = motores.motor(id);
  if (!motor.instalar) {
    return { ok: false, error: motor.nombre + ' no se instala aparte: viene con el panel.' };
  }
  try {
    return await motor.instalar(report);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}
// Corre `npm install` en bridge/ (trae hyperframes + su Chromium). Reporta
// progreso por onProgress({ pct, msg }). Devuelve { ok } o { ok:false, error }.
// Poda onnxruntime-node (~258 MB): hyperframes SOLO lo import()-a dinámicamente
// dentro de "remove-background" (que HyperPremiere no usa) → el render nunca lo
// toca. NO tocamos sharp: aunque también es import() dinámico y guardado por
// try/catch, participa en rutas de captions/descripciones que podrían afectar el
// resultado; 16 MB no valen ese riesgo. Devuelve MB liberados.
function pruneUnusedEngineDeps() {
  const nm = path.join(__dirname, 'node_modules');
  const targets = ['onnxruntime-node'];
  let freed = 0; const removed = [];
  for (const t of targets) {
    const dir = path.join(nm, t);
    try {
      if (!fs.existsSync(dir)) continue;
      freed += dirSizeBytes(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(t);
    } catch (e) {}
  }
  return { ok: true, removed, freedBytes: freed };
}
function dirSizeBytes(dir) {
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      let st; try { st = fs.lstatSync(p); } catch (e) { continue; }
      if (st.isDirectory()) total += dirSizeBytes(p);
      else total += st.size;
    }
  } catch (e) {}
  return total;
}

// Lo que el panel necesita saber de Whisper de una sola vez: qué hay instalado
// (transcribe.js) y si el botón "Instalar Whisper" aplica en esta máquina
// (whisper-install.js). Son módulos separados a propósito —uno detecta, el otro
// instala— y el que junta las dos mitades para la UI es el motor.
// `offline`: el arranque del panel no sale a la red por esto; el número exacto
// de la descarga se pide recién cuando el editor aprieta el botón.
async function whisperStatusForPanel() {
  const st = await whisperStatus();
  if (st.available) return st;
  try {
    const plan = await whisperInstallPlan({ offline: true });
    st.canInstall = !!plan.supported;
    st.installLabel = plan.label || '';
    st.installMB = plan.downloadMB || 0;
    st.installReason = plan.reason || '';
    st.manual = plan.manual || st.recommend;
  } catch (e) {
    st.canInstall = false;
    st.manual = st.recommend;
  }
  return st;
}

// ── Dictado por voz ────────────────────────────────────────────────────────
// El motor pone acá las dos mitades: `dictado.js` captura y transcribe,
// `dictado-refinar.js` elige con qué refinar. La única razón por la que pasan
// por el motor y no los llama el panel directo es la CONFIG: el refinador
// necesita las credenciales de verdad (`loadConfig`), no la vista enmascarada
// que devuelve `getConfig` al panel.

// Este handler contesta DOS preguntas distintas, y separarlas es lo que hace
// que refinar a mano exista donde no se puede dictar:
//
//   `disponible`   → ¿se puede DICTAR? Necesita micrófono, ffmpeg, el Whisper de
//                    Apple Silicon y macOS. Lo decide `dictado.veredicto`.
//   `puedeRefinar` → ¿se puede REFINAR? Necesita un refinador y nada más. No
//                    hay micrófono en la lista, ni ffmpeg, ni Whisper, ni
//                    plataforma: es una llamada de texto a texto.
//
// La segunda es verdadera en muchas máquinas donde la primera es falsa —Windows,
// una Mac sin ffmpeg, cualquiera sin Whisper—, y son justo las del editor que
// escribe todo a mano porque no puede dictar. Colgar el ✨ de `disponible` era
// esconderle el botón precisamente a él.
async function dictadoEstado() {
  const cfg = loadConfig();
  const estado = await dictado.dictadoEstado(cfg);
  const cual = await dictadoRefinar.elegirRefinador(cfg).catch(() => null);
  estado.refinador = cual ? (cual.nombre + (cual.detalle ? ' · ' + cual.detalle : '')) : '';
  estado.puedeRefinar = Boolean(cual);
  // Sin refinador el dictado NO se apaga: el texto crudo ya sirve. Pero el
  // panel tiene que poder decir por qué el resultado va a venir en bruto, o el
  // editor va a creer que el refinado falló en silencio. Y es lo mismo que le
  // dice al ✨ qué le falta a esta máquina para prenderse.
  estado.sinRefinador = cual ? '' : (dictadoRefinar.porQueNoHayRefinador() ||
    'no pude averiguar qué refinador hay en esta máquina');
  return estado;
}

function dictadoRefinarTexto(body) {
  return dictadoRefinar.refinarDictado(body, loadConfig());
}

// Instalar Whisper cambia la respuesta de "¿se puede dictar acá?", y el sondeo
// se guarda por sesión (mira el disco y corre `which`). Sin esto, el editor
// instala Whisper con el botón y el micrófono sigue deshabilitado hasta que
// reinicie Premiere.
async function installWhisperYRevisarDictado(body, onProgress) {
  const r = await installWhisper(body, onProgress);
  dictado.olvidarMaquina();
  return r;
}

async function prepareEngine(_arg, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : function () {};
  if (engineDepsReady()) return { ok: true, alreadyReady: true };
  report({ pct: 4, msg: 'Instalando el motor (una sola vez, puede tardar varios minutos)…' });
  let tail = '';
  // timeoutMs: 0 = sin tope — npm baja el Chromium de hyperframes y puede
  // tardar muchos minutos en conexiones lentas.
  const r = await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: __dirname, shell: IS_WIN, timeoutMs: 0,
    onData: (s) => {
      tail = (tail + s).slice(-2000);
      const line = s.split('\n').map((l) => l.trim()).filter(Boolean).pop();
      if (line) report({ msg: line.slice(0, 140) });
    },
  });
  if (r.code === -1) {
    return { ok: false, error: 'No se pudo ejecutar npm (¿Node instalado en el equipo?): ' + salidaDe(r, 'el sistema no dijo por qué') };
  }
  if (r.code !== 0 || !engineDepsReady()) {
    return { ok: false, error: 'npm install terminó con código ' + r.code + '.\n' + tail.slice(-400) };
  }
  report({ pct: 92, msg: 'Podando dependencias que no se usan…' });
  const pr = pruneUnusedEngineDeps();
  report({ pct: 100, msg: 'Motor listo (liberados ' + (pr.freedBytes / 1048576).toFixed(0) + ' MB no usados).' });
  return { ok: true, pruned: pr };
}

// ── Persistencia de la cola por proyecto ────────────────────────────────
// Guardamos la cola (liviana) en "<dir .prproj>/HyperPremiere/queue.json" para
// que al reabrir el proyecto se recargue lo que había. La carpeta la resuelve
// projectRootPath, que es la misma que usan las salidas y la base del prompt.
function saveQueue(body) {
  try {
    const root = projectRootPath(body && body.projectPath);
    const file = path.join(root, 'queue.json');
    const jobs = (body && Array.isArray(body.jobs)) ? body.jobs : [];
    // Cola vacía: NO crear la carpeta solo por abrir el panel. Si ya existía un
    // queue.json (p.ej. limpiaste la cola), lo actualizamos a vacío; si no, nada.
    if (!jobs.length) {
      if (fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: [] }, null, 2), 'utf8');
      return { ok: true, path: file, count: 0, created: false };
    }
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, jobs }, null, 2), 'utf8');
    return { ok: true, path: file, count: jobs.length };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}
/**
 * El video ya renderizado de un recurso: `{ ok, movPath }`, o `{ ok:false }` si
 * no hay ninguno en el disco.
 *
 * Es para volver a colocar en Premiere algo que se renderizó y no entró. El
 * panel se guarda la ruta cuando eso pasa, pero un job que quedó de una sesión
 * ANTERIOR —o de una versión del panel que todavía no la guardaba— no la tiene,
 * y el archivo está ahí igual: sin esto habría que gastar otra generación
 * entera por un `.mov` que ya existe.
 *
 * Tolera que la extensión no sea la esperada (un recurso con fondo sale .mp4).
 */
function findRenderedVideo(body) {
  try {
    body = body || {};
    const markerSlug = String(body.markerSlug || '').trim();
    if (!markerSlug) return { ok: false, error: 'falta markerSlug' };
    // Solo lectura: no crear la carpeta por preguntar.
    const baseDir = outputDirPath(body.projectPath, body.sequenceName);
    if (!fs.existsSync(baseDir)) return { ok: false, error: 'no existe la carpeta ' + baseDir };
    let version = Number(body.version) || 0;
    if (!version) {
      const videos = listVersions(baseDir, markerSlug, '.mov').concat(listVersions(baseDir, markerSlug, '.mp4'));
      if (!videos.length) return { ok: false, error: 'no hay video de ' + markerSlug };
      version = videos.map((v) => v.version).sort((a, b) => b - a)[0];
    }
    const movPath = versionFile(baseDir, markerSlug, version, '.mov') ||
      versionFile(baseDir, markerSlug, version, '.mp4');
    if (!movPath) return { ok: false, error: 'no hay video de ' + markerSlug + ' v' + version };
    return { ok: true, movPath, version };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

function loadQueue(body) {
  try {
    const file = path.join(projectRootPath(body && body.projectPath), 'queue.json');
    if (!fs.existsSync(file)) return { ok: true, jobs: [] };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, jobs: Array.isArray(data.jobs) ? data.jobs : [] };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e), jobs: [] }; }
}

module.exports = {
  // Pipeline de la cola en 2 etapas (solapar modelo/render):
  prepareGenerate: (body, onProgress) => prepareGeneration(body, 'generate', onProgress),
  prepareFeedback: (body, onProgress) => prepareGeneration(body, body && body.mode === 'adjust' ? 'adjust' : 'regen', onProgress),
  renderPrepared,
  // Re-render de la última versión sin IA (reintento del render):
  renderLatest: versiones.rerenderLatest,
  renderManualHtml: versiones.renderManualHtml,
  saveQueue,
  loadQueue,
  // Para volver a colocar en Premiere un recurso que ya está renderizado.
  findRenderedVideo,
  cleanOldVersions,
  listOldVersions,
  cleanupPreview,
  engineStatus,
  prepareEngine,
  installRenderEngine,
  estimateTokens,
  listMarkerVersions: versiones.listMarkerVersions,
  readMarkerHtml: versiones.readMarkerHtml,
  // Pestaña Corrections: lo ya generado, reconstruido desde el disco.
  listCorrections,
  saveCorrectionPosition: versiones.saveCorrectionPosition,
  transcribeMedia,
  cancelTranscription,
  whisperStatus: whisperStatusForPanel,
  whisperInstallPlan,
  installWhisper: installWhisperYRevisarDictado,
  cancelWhisperInstall,
  // Dictado por voz. `dictadoArrancar` va por callProg: el texto parcial viaja
  // por el mismo canal de progreso que ya usa la transcripción larga. La config
  // se le pasa porque ahí está el micrófono elegido en ⚙.
  dictadoEstado,
  dictadoArrancar: (body, prog) => dictado.dictadoArrancar(body, prog, loadConfig()),
  dictadoParar: dictado.dictadoParar,
  dictadoRefinar: dictadoRefinarTexto,
  // El micrófono: la lista para el desplegable de ⚙ (con cuál se usaría ahora)
  // y la prueba con medidor, que va por callProg para mandar el nivel en vivo.
  // El nombre elegido se guarda con `setConfig({ microfono })`.
  microfonoListar: () => microfono.microfonoListar(loadConfig()),
  microfonoProbar: (body, prog) => dictado.probarMicrofono(body, prog, loadConfig()),
  deriveObjective,
  // Mirar una composición en vivo, sin renderizarla, y apagar eso al cerrar el
  // panel. Solo la ofrecen los motores que pueden (ver previewComposition).
  previewComposition: versiones.previewComposition,
  closePreview: versiones.closePreview,
  getConfig,
  setConfig: saveConfig,
  // La config SIN enmascarar. No la usa el panel (que recibe `getConfig`, con la
  // API key tapada): la usan los arneses de test/manual/, que llaman al modelo
  // de verdad y necesitan la credencial entera para pasársela al proveedor.
  loadConfig,
  testProvider,
  listOllamaModels,
  listClaudeModels,
  listCursorModels,
  saveTranscript,
  loadTranscript,
  transcriptSummary,
  // El estilo del curso, que ahora viaja con el .prproj en vez de con la máquina.
  loadGeneralPrompt,
  saveGeneralPrompt,
  // Y sus referencias (capturas, logos, PDFs), por el mismo camino.
  loadReferences,
  addReference,
  removeReference,
  setReferenceUse,
  newTempAudioPath,
  mediaHasAudio,
  loginClaudeStart,
  loginClaudeCode,
  loginClaudeToken,
  loginClaudeCancel,
  claudeCliStatus,
  claudeSessionStatus,
  catalogoClaude,
  medirModelosClaude,
  verificarClaude,
  cursorCliStatus,
  cursorSessionStatus,
  getVersion,
  checkUpdate,
  selfUpdate,
  saveCapture,
  // Expuesto para el test del ⬇ Log: qué niveles generales viajaron. Vive en
  // prompt/build-context.js, que es donde se decide qué le llega al modelo.
  _generalPromptLabel: generalPromptLabel,
  // Expuesto para el test de la ficha: los tres niveles que se anotan al generar.
  // Lo que la ficha guarda decide qué se puede saber de un recurso dentro de un
  // mes, y llegar hasta acá por el camino largo pide un proveedor de verdad.
  _promptRecord: promptRecord,
  // Y la ficha entera de una generación, por lo mismo: es la costura donde se
  // puede probar que los dos momentos de una generación anotan lo mismo, sin
  // gastar una llamada al modelo ni un render.
  _fichaDeGeneracion: fichaDeGeneracion,
  // Expuestos para los tests de continuidad (qué diseño se manda como referencia).
  _referencedMarkerNumbers: referencedMarkerNumbers,
  _listOtherResources: listOtherResources,
  // Expuesto para el test de Windows (dónde busca los binarios que CEP no ve).
  _windowsExtraPaths: windowsExtraPaths,
  // Expuestos para los tests del chequeo de versión (GitHub de mentira local).
  _fetchRemoteVersion: fetchRemoteVersion,
  _checkPackagedUpdate: checkPackagedUpdate,
};
