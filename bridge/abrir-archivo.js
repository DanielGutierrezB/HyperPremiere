'use strict';

// ABRIR UN ARCHIVO con lo que el sistema tenga para él.
//
// Para «Abrir Remotion»: el `.tsx` del marcador tiene que aparecer en el editor
// de código de cada uno, y "cada uno" incluye editores de video que no tienen
// ninguno. Studio tiene su propio «Open in editor», pero solo aparece si
// encuentra un VS Code o un Cursor YA abierto (lo busca entre los procesos), y
// abre la carpeta entera del proyecto en vez del archivo.
//
// Así que se le pide al sistema, que respeta la elección de cada máquina: el
// que tenga Cursor o VS Code lo abre con ese (los dos se registran para los
// `.tsx`), y el que no:
//
//   - en macOS, `open` falla —nadie abre `.tsx`— y entra el editor de texto
//     del sistema (`open -t`), que para un archivo de texto alcanza;
//   - en Windows, el Explorador pregunta con qué abrirlo, que es la pregunta
//     correcta.

const { execFile } = require('child_process');

/**
 * Corre un comando y espera a que termine.
 *
 * Con `cualquierSalida`, un código de salida distinto de cero no cuenta como
 * falla —el Explorador de Windows sale con 1 aun cuando abrió el archivo—; que
 * el comando no exista, sí.
 */
function correr(cmd, args, cualquierSalida) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err) => {
      if (err && !(cualquierSalida && typeof err.code === 'number')) return reject(err);
      resolve();
    });
  });
}

/**
 * Abre `archivo` con la aplicación del sistema. Devuelve `{ ok, con, error }`:
 * nunca tira, porque no poder abrir el archivo no es razón para que no se abra
 * Studio —el panel dice dónde está, y se abre a mano—.
 *
 * `o.plataforma` y `o.correr` son para los tests.
 */
async function abrirArchivo(archivo, o) {
  const opciones = o || {};
  const plataforma = opciones.plataforma || process.platform;
  const ejecutar = opciones.correr || correr;
  try {
    if (plataforma === 'darwin') {
      try {
        await ejecutar('open', [archivo]);
        return { ok: true, con: 'la aplicación del sistema' };
      } catch (e) {
        await ejecutar('open', ['-t', archivo]);
        return { ok: true, con: 'el editor de texto' };
      }
    }
    if (plataforma === 'win32') {
      await ejecutar('explorer.exe', [archivo], true);
      return { ok: true, con: 'la aplicación del sistema' };
    }
    await ejecutar('xdg-open', [archivo]);
    return { ok: true, con: 'la aplicación del sistema' };
  } catch (e) {
    return { ok: false, con: '', error: (e && e.message) || String(e) };
  }
}

module.exports = { abrirArchivo };
