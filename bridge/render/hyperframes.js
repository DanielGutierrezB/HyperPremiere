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

const RENDER_TIMEOUT_MS = 600 * 1000; // ~600s

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
  fs.writeFileSync(htmlPath, html, 'utf8');
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
  // --workers 1: captura SECUENCIAL. Las composiciones con video (ej. marcadores que
  // reusan el diagrama anterior) revientan con workers en paralelo ("Parallel capture
  // timed out" / "Navigation timeout of 60000 ms exceeded") porque varios Chrome compiten
  // por RAM/GPU. Secuencial es más lento pero estable — es la solución que sugiere el CLI.
  // mov => ProRes 4444 con alpha (overlay transparente).
  // mp4 => H.264 opaco HD 1080p con buen bitrate (crf 18) para lectura, cuando
  //         el marcador se genera CON fondo (no necesita canal alpha).
  const args = baseArgs.concat([
    'render',
    workDir,
    '-o', outMovPath,
    '--format', fmt,
    '--quality', q,
    '--workers', '1',
    // Perfil de baja memoria: encodea de a poco en vez de bufferear todos los
    // frames. Sin esto, marcadores largos (ej. 33s ≈ 1008 frames a 1080p) revientan
    // con "Set maximum size exceeded" (límite de Buffer de Node).
    '--low-memory-mode',
  ]);
  if (fmt === 'mp4') args.push('--crf', q === 'draft' ? '28' : '18');
  void durationSec; // informativo; la duración vive en el HTML.

  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: workDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWin, // Windows: el shim .cmd/npx necesita shell
    });

    let stderr = '';
    let stdout = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`hyperframes: timeout después de ${RENDER_TIMEOUT_MS / 1000}s\n${stderr}`));
    }, RENDER_TIMEOUT_MS);

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

    child.stdout.on('data', (d) => { const s = d.toString(); stdout += s; scan(s); });
    child.stderr.on('data', (d) => { const s = d.toString(); stderr += s; scan(s); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`hyperframes: no se pudo lanzar npx (${err.message})`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(
          `hyperframes salió con código ${code}\nstderr:\n${stderr}\nstdout:\n${stdout}`
        ));
      }
    });
  });

  if (!fs.existsSync(outMovPath)) {
    throw new Error(`hyperframes terminó OK pero no existe el archivo de salida: ${outMovPath}`);
  }

  return { movPath: outMovPath, htmlPath };
}

module.exports = { renderComposition };
