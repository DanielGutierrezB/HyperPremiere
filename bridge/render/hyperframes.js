// Renderiza una composición HTML a ProRes 4444 con alpha usando el CLI de hyperframes.
//
// Requisitos del entorno:
// - ffmpeg arm64 disponible en PATH (ya presente en esta máquina).
// - hyperframes descarga su propio Chromium arm64 en la primera ejecución.

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { killTree, quoteForShell } = require('../exec');

// Watchdog de INACTIVIDAD (no un tope total): matamos el render solo si pasa
// este lapso sin NINGUNA salida del CLI. Así un render lento pero vivo (marcador
// largo en máquina modesta, captura por software) no se mata por tardar; solo
// muere si de verdad se colgó. Antes era un tope fijo de 600s que mataba renders
// que iban bien (un marcador de 33s ≈ 1000 frames en serial no cabe en 600s).
const IDLE_TIMEOUT_MS = 300 * 1000; // 5 min sin salida => colgado

/**
 * Presupuesto TOTAL de la máquina: cuántos workers de captura aguanta entre
 * todos los renders juntos, y si hay que ir en modo seguro.
 *
 * El cuello del paralelismo es la RAM (cada worker es un Chrome capturando
 * frames + buffers de encode), no los cores. Por eso el techo sale de los GB.
 *
 *  - ≤ 10 GB (ej. Mac mini M1 8GB): modo seguro. `--low-memory-mode` encodea
 *    incremental (evita el "Set maximum size exceeded" en marcadores largos) y
 *    fija 1 worker. Es el comportamiento estable de siempre.
 *  - > 10 GB: ~1 worker por cada 4 GB, con techo por cores y máximo 6.
 *
 * Es el ÚNICO lugar donde se mira el hardware: los carriles (renderLanes) y los
 * workers por render (pickRenderProfile) se reparten ESTE presupuesto, en vez de
 * ser dos diales independientes gastando los mismos cores.
 */
function hardwareBudget() {
  const gb = os.totalmem() / 1024 / 1024 / 1024;
  const cpus = os.cpus().length || 4;
  if (gb <= 10) return { workers: 1, lowMemory: true, ramGb: gb, cpus: cpus };
  const byRam = Math.floor(gb / 4);
  return { workers: Math.max(2, Math.min(byRam, cpus, 6)), lowMemory: false, ramGb: gb, cpus: cpus };
}

/**
 * Cuántos renders puede correr la cola A LA VEZ en esta máquina.
 *
 * Medido en un M3 Max (48 GB, 16 cores) con dos marcadores reales de 54s y 20s:
 * en serie 69.3s, en paralelo 46.9s (-32%), y NINGUNO de los dos se ralentizó.
 * Los .mov salieron idénticos byte a byte (mismo SHA-256): el carril extra
 * acelera el lote y no toca la calidad.
 *
 * Se queda en 2 a propósito: es lo que está medido. Las máquinas flojas (perfil
 * low-memory, ej. la mini de 8 GB) siguen en 1 — ahí un segundo Chromium es
 * justo lo que dispara el "Set maximum size exceeded".
 *
 * Override: HYPERPREMIERE_RENDER_LANES=N.
 */
function renderLanes() {
  const forced = parseInt(process.env.HYPERPREMIERE_RENDER_LANES, 10);
  if (Number.isFinite(forced) && forced > 0) return Math.min(forced, 4);
  const hw = hardwareBudget();
  if (hw.lowMemory) return 1;
  return (hw.cpus >= 8 && hw.ramGb >= 24) ? 2 : 1;
}

/**
 * Perfil de UN render: el presupuesto de la máquina repartido entre los carriles
 * que pueden estar corriendo. Así el total de workers no cambia por abrir un
 * segundo carril — antes eran dos diales independientes y en una máquina justa
 * (24 GB / 8 cores) dos renders pedían 12 workers sobre 8 cores.
 *
 * Repartir además salió GRATIS y encima más rápido: medido en el M3 Max (mismo
 * HTML, salida idéntica byte a byte), bajar de 6 a 3 workers por render dio
 * 51.1s → 37.8s en el marcador de 54s (-26%) y 19.0s → 18.5s en el de 20s. La
 * captura no era el cuello: cada worker extra es otro Chrome que arrancar.
 *
 * Overrides manuales por env var:
 *   HYPERPREMIERE_WORKERS=N    → fija los workers de cada render (sin repartir).
 *   HYPERPREMIERE_LOW_MEMORY=1 → fuerza low-memory-mode (1 worker).
 */
function pickRenderProfile() {
  const hw = hardwareBudget();
  let workers = hw.lowMemory ? 1 : Math.max(1, Math.floor(hw.workers / renderLanes()));
  let lowMemory = hw.lowMemory;

  const forcedWorkers = parseInt(process.env.HYPERPREMIERE_WORKERS, 10);
  if (Number.isFinite(forcedWorkers) && forcedWorkers > 0) {
    workers = forcedWorkers;
    lowMemory = false;
  }
  if (process.env.HYPERPREMIERE_LOW_MEMORY === '1') {
    workers = 1;
    lowMemory = true;
  }

  return { workers: workers, lowMemory: lowMemory, ramGb: hw.ramGb, cpus: hw.cpus };
}

/**
 * Modo de GPU del BROWSER (captura WebGL/GSAP), independiente del encode.
 * hyperframes usa la GPU del host por defecto (rápido). En v1.0.47 la forzamos a
 * 'software' (SwiftShader) porque el backend ANGLE Metal crasheaba el Chromium
 * dentro del contexto de Premiere en Apple Silicon → estable pero LENTO (la
 * captura pasa a CPU). Este modo es lo que más pesa en el tiempo de render.
 *
 * Prioridad: env HYPERPREMIERE_BROWSER_GPU > config.json { browserGpu } > 'auto'.
 * Valores: 'hardware' (fuerza GPU), 'software' (fuerza CPU/SwiftShader), 'auto'
 * (intenta GPU y, si el Chromium crashea, reintenta el mismo render por software).
 * 'auto' es el default: cada máquina usa la GPU cuando funciona (rápido) y cae sola
 * a software cuando ese contexto crashea (ej. dentro de Premiere) — sin tocar nada.
 */
function browserGpuMode() {
  const VALID = ['hardware', 'software', 'auto'];
  const envMode = process.env.HYPERPREMIERE_BROWSER_GPU;
  if (VALID.includes(envMode)) return envMode;
  try {
    const p = path.join(os.homedir(), '.hyperpremiere', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (cfg && VALID.includes(cfg.browserGpu)) return cfg.browserGpu;
  } catch (e) {}
  return 'auto';
}

/**
 * Sanea una composición generada por IA antes de renderizar. La salida del modelo
 * es una frontera no confiable: aunque el prompt lo prohíbe, a veces devuelve
 * patrones que ROMPEN el motor de captura determinista. Corregimos dos aquí:
 *
 *  1) Repeticiones INFINITAS de GSAP (`repeat: -1` / `repeat: Infinity`). Hacen
 *     que la timeline dure Infinito, y el motor —que busca cada frame por tiempo
 *     exacto— arma un set de tiempos sin cota y revienta con "Set maximum size
 *     exceeded" a los pocos segundos (no es falta de RAM: pasa aun con
 *     --low-memory-mode + streaming). Las bajamos a un conteo finito grande: el
 *     loop se ve continuo dentro de la ventana capturada (data-duration) pero la
 *     timeline queda acotada.
 *  2) Fragmento sin documento HTML (sin <!DOCTYPE html>/<html>/<body>). El
 *     navegador entra en quirks mode y el bundler no puede inyectar el runtime.
 *     Lo envolvemos en un documento mínimo.
 *
 * Devuelve { html, fixes } con la lista de arreglos aplicados (para loguear).
 */
function sanitizeComposition(html) {
  const fixes = [];
  let out = String(html);

  // (comparar el resultado del replace evita el footgun de .test() con /g,
  // que muta lastIndex y rompe en la segunda llamada)
  const finite = out.replace(/(\brepeat\s*:\s*)(-\s*1|Infinity)\b/g, '$1999');
  if (finite !== out) {
    out = finite;
    fixes.push('repeat infinito → 999 (finito)');
  }

  if (!/<!doctype\s+html|<html[\s>]|<body[\s>]/i.test(out)) {
    out =
      '<!DOCTYPE html>\n<html lang="es">\n<head>\n<meta charset="UTF-8">\n</head>\n<body>\n' +
      out.trim() +
      '\n</body>\n</html>\n';
    fixes.push('fragmento envuelto en documento HTML');
  }

  return { html: out, fixes: fixes };
}

/**
 * Borra ghost files de macOS (._*) dentro de un directorio.
 * Estos archivos confunden al CLI de hyperframes al escanear el dir.
 */
function removeGhostFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith('._')) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Renderiza un HTML a un .mov ProRes 4444 (con canal alpha).
 *
 * @param {object} opts
 * @param {string} opts.html        Contenido HTML de la composición.
 * @param {string} opts.outMovPath  Ruta absoluta del .mov de salida.
 * @param {number} [opts.durationSec] Duración deseada en segundos (informativa;
 *                                    la duración real la define la composición HTML).
 * @returns {Promise<{movPath: string, htmlPath: string}>}
 */
async function renderComposition({ html, outMovPath, durationSec, onProgress, format, quality, assetsDir }) {
  var report = typeof onProgress === 'function' ? onProgress : function () {};
  if (!html || typeof html !== 'string') {
    throw new Error('renderComposition: falta el HTML de la composición');
  }
  if (!outMovPath) {
    throw new Error('renderComposition: falta outMovPath');
  }
  var fmt = format === 'mp4' ? 'mp4' : 'mov';
  var q = quality === 'draft' ? 'draft' : 'high'; // borrador rápido vs alta calidad

  // Directorio temporal propio para esta render (cwd del CLI).
  // hyperframes espera un PROYECTO: index.html + hyperframes.json en la raíz.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperpremiere-render-'));
  const htmlPath = path.join(workDir, 'index.html');
  const sanitized = sanitizeComposition(html);
  if (sanitized.fixes.length) {
    console.error('[hyperpremiere] composición saneada: ' + sanitized.fixes.join(' · '));
  }
  fs.writeFileSync(htmlPath, sanitized.html, 'utf8');
  // Proyecto mínimo de hyperframes para que reconozca la carpeta.
  fs.writeFileSync(
    path.join(workDir, 'hyperframes.json'),
    JSON.stringify({ paths: { blocks: '.', assets: 'assets' } }, null, 2),
    'utf8'
  );
  // Copiar los assets embebibles (imágenes provistas por el editor) al workDir/assets
  // para que el HTML pueda referenciarlos con <img src="assets/asset-01.png">.
  try {
    if (assetsDir && fs.existsSync(assetsDir)) {
      const dst = path.join(workDir, 'assets');
      fs.mkdirSync(dst, { recursive: true });
      for (const f of fs.readdirSync(assetsDir)) {
        try { fs.copyFileSync(path.join(assetsDir, f), path.join(dst, f)); } catch (e) {}
      }
    }
  } catch (e) {}

  fs.mkdirSync(path.dirname(outMovPath), { recursive: true });

  // Limpiar ghost files antes de que hyperframes escanee el dir.
  removeGhostFiles(workDir);

  // Usar el binario LOCAL de hyperframes (evita que npx lo re-descargue).
  // En Windows el shim es .cmd (requiere shell:true al lanzar).
  const isWin = process.platform === 'win32';
  const localBin = path.join(__dirname, '..', 'node_modules', '.bin', isWin ? 'hyperframes.cmd' : 'hyperframes');
  const bin = fs.existsSync(localBin) ? localBin : 'npx';
  const baseArgs = bin === 'npx' ? ['hyperframes'] : [];

  // hyperframes 0.7.x: --format mov => MOV con transparencia (alpha real, ProRes 4444).
  // Sin -c: renderiza el index.html del proyecto. La duración vive en el HTML (data-duration).
  // Workers/low-memory se eligen según el hardware (ver pickRenderProfile): la mini de
  // 8GB va en modo seguro (1 worker + low-memory), y una máquina con más RAM paraleliza.
  // mov => ProRes 4444 con alpha (overlay transparente).
  // mp4 => H.264 opaco HD 1080p con buen bitrate (crf 18) para lectura, cuando
  //         el marcador se genera CON fondo (no necesita canal alpha).
  const profile = pickRenderProfile();
  const gpuMode = browserGpuMode();
  console.error(
    '[hyperpremiere] hardware: RAM ' + profile.ramGb.toFixed(1) + 'GB, ' +
    profile.cpus + ' cores → ' + profile.workers + ' worker(s) por render × ' +
    renderLanes() + ' carril(es), low-memory=' + profile.lowMemory + ', browser-gpu=' + gpuMode
  );
  void durationSec; // informativo; la duración vive en el HTML.

  // Construye los args del CLI para UN intento concreto (gpu/workers/lowMemory).
  function buildArgs(attempt) {
    const a = baseArgs.concat([
      'render',
      workDir,
      '-o', outMovPath,
      '--format', fmt,
      '--quality', q,
      '--workers', String(attempt.workers),
    ]);
    if (attempt.lowMemory) {
      // Perfil de baja memoria: encodea de a poco en vez de bufferear todos los
      // frames. Sin esto, marcadores largos (ej. 33s ≈ 1008 frames a 1080p) revientan
      // con "Set maximum size exceeded" (límite de Buffer de Node). Fija 1 worker.
      a.push('--low-memory-mode');
    } else {
      // Paralelo (RAM alta): acotamos el chunk de frames para que los marcadores
      // largos no revienten el Buffer de Node aun sin low-memory-mode.
      a.push('--target-chunk-frames', '300');
    }
    if (fmt === 'mp4') {
      a.push('--crf', q === 'draft' ? '28' : '18');
      // Encode H.264 por hardware (VideoToolbox). En Apple Silicon esto usa el
      // motor de media dedicado, que es INDEPENDIENTE del GPU del browser (ANGLE
      // Metal, el que crasheaba) → seguro y bastante más rápido en la etapa de
      // codificación. Solo aplica a mp4/H.264: el ProRes .mov siempre encodea por
      // software (prores_ks), ahí --gpu no cambia nada.
      a.push('--gpu');
    }
    return a;
  }

  // Una corrida del CLI con una config de intento concreta.
  function runOnce(attempt) {
    const args = buildArgs(attempt);
    return new Promise((resolve, reject) => {
      // 'software' fuerza SwiftShader (estable pero lento); 'hardware' deja que
      // hyperframes use la GPU por defecto (rápido, pero puede crashear en Premiere).
      const childEnv = Object.assign({}, process.env);
      if (attempt.gpu === 'software') {
        childEnv.PRODUCER_BROWSER_GPU_MODE = 'software';
      } else {
        delete childEnv.PRODUCER_BROWSER_GPU_MODE;
      }
      // Windows: el shim .cmd/npx necesita shell, y con shell spawn concatena
      // sin escapar. La ruta de salida SIEMPRE trae espacios ("Marcador 1 v2
      // [modelo].mov"), así que sin entrecomillar el CLI recibiría el nombre
      // partido en pedazos y ningún render terminaría bien.
      const child = spawn(
        isWin ? quoteForShell(bin) : bin,
        isWin ? args.map(quoteForShell) : args,
        {
          cwd: workDir,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: isWin,
          // Líder de grupo en POSIX → killTree se lleva también los Chromium.
          detached: !isWin,
        }
      );

      let stderr = '';
      let stdout = '';
      let settled = false;

      let idleTimer = null;
      let lastOutputAt = Date.now();
      function armIdle() {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          // killTree y no child.kill: con shell el hijo directo es cmd.exe, y
          // matarlo a él deja vivos el Node del CLI y sus Chromium.
          killTree(child);
          const idleSec = Math.round((Date.now() - lastOutputAt) / 1000);
          reject(Object.assign(new Error(
            `hyperframes: sin actividad por ${idleSec}s (watchdog ${IDLE_TIMEOUT_MS / 1000}s) — ` +
            `parece colgado\n${stderr}`
          ), { code: 'IDLE' }));
        }, IDLE_TIMEOUT_MS);
      }
      function bumpIdle() { lastOutputAt = Date.now(); armIdle(); }
      armIdle();

      function scan(text) {
        // "Capturing frame 30/150" → progreso real del render (mapeado a 55–90%).
        const fm = text.match(/frame\s+(\d+)\s*\/\s*(\d+)/i);
        if (fm) {
          const cur = parseInt(fm[1], 10), tot = parseInt(fm[2], 10) || 1;
          const pct = 55 + Math.round((cur / tot) * 33);
          report({ pct: pct, msg: 'Renderizando fotograma ' + cur + '/' + tot + '…' });
          return;
        }
        if (/encoding/i.test(text)) report({ pct: 90, msg: 'Codificando el video…' });
        else if (/assembling/i.test(text)) report({ pct: 93, msg: 'Ensamblando el video final…' });
      }

      child.stdout.on('data', (d) => { const s = d.toString(); stdout += s; bumpIdle(); scan(s); });
      child.stderr.on('data', (d) => { const s = d.toString(); stderr += s; bumpIdle(); scan(s); });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        reject(Object.assign(new Error(`hyperframes: no se pudo lanzar npx (${err.message})`), { code: 'SPAWN' }));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        if (code === 0) {
          resolve();
        } else {
          reject(Object.assign(new Error(
            `hyperframes salió con código ${code}\nstderr:\n${stderr}\nstdout:\n${stdout}`
          ), { code: code }));
        }
      });
    });
  }

  // Escalera de intentos: del más rápido (GPU + paralelo) al más estable
  // (software + 1 worker + low-memory, el perfil probado de la mini). Si un
  // escalón crashea, bajamos al siguiente en vez de morir. Cada máquina termina
  // usando el escalón más rápido que le funcione — sin configurar nada.
  //
  // Clave del fix v1.0.53: el fallback ya NO solo cambia la GPU (hardware→software);
  // también BAJA los workers a 1. El crash "[Parallel] Capture failed: Worker N…"
  // es el path paralelo reventando dentro del CEF de Premiere (browser que muere
  // mid-captura o presión de memoria con varios Chrome + Premiere). Antes ambos
  // intentos seguían en paralelo → ambos crasheaban → el error llegaba a Daniel.
  function buildAttempts() {
    const key = (x) => x.gpu + '/' + x.workers + '/' + x.lowMemory;
    const seen = new Set();
    const list = [];
    const add = (x) => { if (!seen.has(key(x))) { seen.add(key(x)); list.push(x); } };

    // Perfil universal probado-estable (el de la mini 8GB): serial + software.
    const safe = { gpu: 'software', workers: 1, lowMemory: true };

    if (gpuMode === 'software') {
      // Forzado a software: paralelo-software (si hay RAM) → serial seguro.
      if (profile.workers > 1) {
        add({ gpu: 'software', workers: profile.workers, lowMemory: profile.lowMemory });
      }
      add(safe);
      return list;
    }

    // 'hardware' o 'auto': arrancamos con GPU.
    // 1) Lo más rápido que permita el hardware (paralelo si hay RAM alta).
    add({ gpu: 'hardware', workers: profile.workers, lowMemory: profile.lowMemory });
    // 2) GPU pero SERIAL: si lo que crashea es el paralelo, conservamos la
    //    velocidad de la GPU (la palanca real, 10-30× vs software) sin la
    //    fragilidad de varios workers. low-memory evita el buffer overflow.
    add({ gpu: 'hardware', workers: 1, lowMemory: true });
    // 3) Red de seguridad universal (solo en 'auto'): software + serial. Lento
    //    pero no crashea; es el modo estable de siempre.
    if (gpuMode === 'auto') add(safe);
    return list;
  }

  const attempts = buildAttempts();
  let lastErr = null;
  // Lo que pasó de verdad va a los DOS lados: a la consola (para depurar con el
  // proceso a la vista) y al ⬇ Log del panel (que es lo único que tiene el editor).
  // Sin esto no había forma de saber, desde el panel, si un render lento fue
  // porque cayó al modo software —3-4× más lento— o si el marcador era largo.
  function trace(text, level) {
    console.error('[hyperpremiere] ' + text);
    report({ note: text, level: level });
  }
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const isLast = i === attempts.length - 1;
    const intento = 'intento ' + (i + 1) + '/' + attempts.length;
    const cfg = 'browser-gpu=' + attempt.gpu + ', workers=' + attempt.workers +
      ', low-memory=' + attempt.lowMemory;
    console.error('[hyperpremiere] ' + intento + ': ' + cfg);
    const t0 = Date.now();
    try {
      await runOnce(attempt);
      lastErr = null;
      trace('Render OK en ' + ((Date.now() - t0) / 1000).toFixed(1) + 's · ' + fmt + '/' + q +
        ' · ' + intento + ' · ' + cfg);
      break;
    } catch (e) {
      lastErr = e;
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const why = String(e.message).split('\n')[0];
      if (isLast) {
        trace('Render FALLÓ tras ' + attempts.length + ' intento(s) · último: ' + cfg +
          ' · ' + secs + 's · ' + why, 'ERROR');
        break;
      }
      // Limpiar salida parcial antes de reintentar.
      try { if (fs.existsSync(outMovPath)) fs.unlinkSync(outMovPath); } catch (_) {}
      const next = attempts[i + 1];
      report({ pct: 55, msg: 'Ese modo falló, reintentando en modo más estable…' });
      trace(intento + ' (' + cfg + ') falló a los ' + secs + 's: ' + why +
        ' → bajo a browser-gpu=' + next.gpu + ', workers=' + next.workers, 'WARN');
    }
  }
  if (lastErr) throw lastErr;

  if (!fs.existsSync(outMovPath)) {
    throw new Error(`hyperframes terminó OK pero no existe el archivo de salida: ${outMovPath}`);
  }

  return { movPath: outMovPath, htmlPath };
}

module.exports = { renderComposition, renderLanes };
