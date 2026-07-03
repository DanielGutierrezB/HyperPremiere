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
async function renderComposition({ html, outMovPath, durationSec }) {
  if (!html || typeof html !== 'string') {
    throw new Error('renderComposition: falta el HTML de la composición');
  }
  if (!outMovPath) {
    throw new Error('renderComposition: falta outMovPath');
  }

  // Directorio temporal propio para esta render (cwd del CLI).
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperpremiere-render-'));
  const htmlPath = path.join(workDir, 'composition.html');
  fs.writeFileSync(htmlPath, html, 'utf8');

  fs.mkdirSync(path.dirname(outMovPath), { recursive: true });

  // Limpiar ghost files antes de que hyperframes escanee el dir.
  removeGhostFiles(workDir);

  // hyperframes 0.7.x: --format mov => MOV con transparencia (alpha real, ProRes 4444).
  // La duración NO es un flag: se declara en data-duration del #stage dentro del HTML
  // (el prompt de sistema instruye al modelo a fijarla según la duración del marcador).
  const args = [
    'hyperframes',
    'render',
    workDir,
    '-c', path.basename(htmlPath),
    '-o', outMovPath,
    '--format', 'mov',
    '--quality', 'high',
  ];
  void durationSec; // informativo; la duración vive en el HTML.

  await new Promise((resolve, reject) => {
    const child = spawn('npx', args, {
      cwd: workDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
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

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

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
