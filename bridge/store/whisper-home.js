// Dónde vive el Whisper que instala el panel, y qué quedó instalado.
//
// Por qué una carpeta propia y no "dejalo en el PATH": el PATH que ve el panel
// NO es el del editor (Premiere arranca desde el Explorador/Finder con un
// entorno recortado), así que pedirle que descomprima algo "en el PATH" es
// frágil y encima obliga a reiniciar Premiere. Instalamos en una carpeta
// nuestra, guardamos la RUTA ABSOLUTA del ejecutable y transcribe.js la corre
// directo: no depende del PATH de nadie.
//
// El registro (installed.json) se valida contra el disco cada vez que se lee:
// si el editor borró la carpeta a mano, vuelve a decir "no hay nada instalado"
// en vez de apuntar a un ejecutable fantasma.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Carpeta base de la instalación. Se puede mover con una variable (tests). */
function whisperHome() {
  const override = (process.env.HYPERPREMIERE_WHISPER_HOME || '').trim();
  return override || path.join(os.homedir(), '.hyperpremiere', 'whisper');
}

function recordPath() {
  return path.join(whisperHome(), 'installed.json');
}

/**
 * Lo que instalamos nosotros: { bin, style, fast, path, version, verified,
 * installedAt } o null. Devuelve null si el ejecutable ya no está.
 */
function readInstalled() {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(recordPath(), 'utf8'));
  } catch (e) {
    return null;
  }
  if (!rec || !rec.path || !rec.bin) return null;
  try {
    if (!fs.existsSync(rec.path)) return null;
  } catch (e) {
    return null;
  }
  return rec;
}

/** Anota qué quedó instalado. Solo se llama DESPUÉS de verificar que corre. */
function writeInstalled(rec) {
  const dir = whisperHome();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(recordPath(), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

/** Borra el registro (no la carpeta): "acá no hay nada instalado por nosotros". */
function forgetInstalled() {
  try { fs.rmSync(recordPath(), { force: true }); } catch (e) {}
}

/**
 * Borra un subdirectorio de la instalación (venv a medio armar, extracción
 * fallida). Nunca sale de whisperHome(): un `sub` raro no puede borrar otra cosa.
 */
function wipeSub(sub) {
  const home = whisperHome();
  const target = path.resolve(home, sub);
  if (target !== path.resolve(home) && target.indexOf(path.resolve(home) + path.sep) !== 0) return false;
  try { fs.rmSync(target, { recursive: true, force: true }); } catch (e) {}
  return true;
}

module.exports = { whisperHome, readInstalled, writeInstalled, forgetInstalled, wipeSub };
