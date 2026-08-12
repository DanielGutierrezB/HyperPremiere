'use strict';

// Con qué reparto de workers rinde mejor ESTA máquina, aprendido de los renders
// que el editor ya hace igual.
//
// Por qué no se deduce del hardware: la cuenta por RAM y cores da un número
// plausible y no hay ninguna garantía de que sea el bueno. Nuestras animaciones
// son DOM con CSS y GSAP, y ahí levantar varios Chrome a veces ahorra y a veces
// cuesta más de lo que ahorra. Depende de la máquina.
//
// Por qué no se mide con una prueba sintética al arrancar: se intentó, y
// midiendo en este mismo Mac dio 58,1s el reparto en paralelo contra 65,2s el de
// un worker — al revés de lo que había dado un banco de pruebas anterior. La
// diferencia entre las dos mediciones fue el estado de la máquina: la segunda se
// tomó con Premiere abierto y la carga en 7, que es exactamente la condición en
// la que un editor renderiza. Una medición de una sola vez, tomada justo en un
// mal momento, queda grabada para siempre y encima le come minutos al editor
// antes de su primer render.
//
// Así que se mide sobre lo real: cada render exitoso deja anotado cuántos
// fotogramas fueron y cuánto tardó. Con eso alcanza, y no le cuesta un segundo a
// nadie. Mientras no haya evidencia clara se sigue con el reparto por hardware,
// que es lo que ya venía haciendo.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Los renders cortos están dominados por el arranque de Chrome y el encode (en
// este Mac, unos 40s fijos contra ~0,1s por fotograma). Comparar un marcador de
// 4s contra uno de 30s no dice nada del reparto: dice cuál marcador era más
// largo. Por eso solo se comparan marcadores de tamaño parecido.
const FOTOGRAMAS_POR_BALDE = 300; // ~10s de video a 30fps

// Cuántos renders hacen falta de cada reparto antes de decidir. Con menos, una
// sola corrida con el disco ocupado alcanza para elegir mal y quedarse así.
const MUESTRAS_MINIMAS = 3;

// Cuánto tiene que ganar para que valga la pena cambiar. Por debajo de esto la
// diferencia se la come el ruido de tener Premiere abierto.
const VENTAJA_MINIMA = 0.10;

function homeDir() { return path.join(os.homedir(), '.hyperpremiere'); }
function filePath() { return path.join(homeDir(), 'render-profile.json'); }

/** Qué máquina es ésta. Si cambia, lo aprendido antes no aplica. */
function fingerprint() {
  return [
    process.platform, process.arch,
    os.cpus().length || 0,
    Math.round(os.totalmem() / 1024 / 1024 / 1024),
  ].join('|');
}

/** Nombre corto de un reparto, que es también su clave en el archivo. */
function nombrePerfil(p) {
  return p.workers + (p.lowMemory ? 'w-pantalla' : 'w-paralelo');
}

function baldeDe(frames) {
  return Math.floor((frames || 0) / FOTOGRAMAS_POR_BALDE);
}

function leerCrudo() {
  try {
    const saved = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    if (!saved || saved.fingerprint !== fingerprint()) return null;
    return saved;
  } catch (e) {
    return null;
  }
}

function guardar(datos) {
  try {
    fs.mkdirSync(homeDir(), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(
      Object.assign({ fingerprint: fingerprint() }, datos), null, 2), 'utf8');
    return true;
  } catch (e) {
    // Si no se puede escribir, se sigue con el reparto por hardware. Molesta, no rompe.
    return false;
  }
}

/**
 * Elige un reparto si los datos alcanzan para afirmarlo, o null si todavía no.
 *
 * Compara SOLO marcadores de tamaño parecido, y dentro de cada tamaño se queda
 * con el mejor tiempo de cada reparto: la interferencia (Premiere exportando, un
 * backup corriendo) solo puede hacer las cosas más lentas, nunca más rápidas,
 * así que el mínimo es el número menos contaminado que tenemos.
 *
 * Para ganar hay que ganar en TODOS los tamaños comparables. Un reparto que es
 * mejor en marcadores cortos y peor en largos no es "el mejor": es un empate con
 * más pasos, y ante un empate conviene no tocar nada.
 *
 * @param {object} muestras  { nombrePerfil: [{ f: fotogramas, ms: milisegundos }] }
 * @returns {string|null} el nombre del reparto ganador.
 */
function elegir(muestras) {
  const nombres = Object.keys(muestras || {});
  if (nombres.length !== 2) return null;
  if (nombres.some(function (n) { return muestras[n].length < MUESTRAS_MINIMAS; })) return null;

  const mejores = {}; // nombre → { balde → ms mínimo }
  nombres.forEach(function (n) {
    mejores[n] = {};
    muestras[n].forEach(function (m) {
      const b = baldeDe(m.f);
      if (mejores[n][b] === undefined || m.ms < mejores[n][b]) mejores[n][b] = m.ms;
    });
  });

  const comparables = Object.keys(mejores[nombres[0]]).filter(function (b) {
    return mejores[nombres[1]][b] !== undefined;
  });
  if (!comparables.length) return null;

  let ganador = null;
  for (const b of comparables) {
    const a = mejores[nombres[0]][b];
    const c = mejores[nombres[1]][b];
    const gana = a < c * (1 - VENTAJA_MINIMA) ? nombres[0]
      : c < a * (1 - VENTAJA_MINIMA) ? nombres[1]
      : null;
    if (!gana) return null;              // empate en este tamaño → no hay caso
    if (ganador && ganador !== gana) return null; // se contradicen entre tamaños
    ganador = gana;
  }
  return ganador;
}

/**
 * Anota lo que tardó un render real y, si ya alcanza, decide el reparto.
 * @returns {string|null} el reparto elegido si se decidió EN ESTA llamada.
 */
function registrar(perfil, frames, ms) {
  if (!(frames > 0) || !(ms > 0)) return null; // sin fotogramas no hay nada que comparar
  const datos = leerCrudo() || { muestras: {}, elegido: null };
  if (datos.elegido) return null;
  const n = nombrePerfil(perfil);
  if (!datos.muestras[n]) datos.muestras[n] = [];
  datos.muestras[n].push({ f: frames, ms: Math.round(ms) });
  // Un tope para que el archivo no crezca sin fin; con los últimos alcanza.
  if (datos.muestras[n].length > 12) datos.muestras[n] = datos.muestras[n].slice(-12);

  const ganador = elegir(datos.muestras);
  if (ganador) {
    datos.elegido = ganador;
    datos.decididoEl = new Date().toISOString();
  }
  guardar(datos);
  return ganador;
}

/**
 * El reparto aprendido, o null si todavía se está juntando evidencia.
 * @param {Array} candidatos  los repartos en discusión.
 */
function elegido(candidatos) {
  const datos = leerCrudo();
  if (!datos || !datos.elegido) return null;
  return candidatos.find(function (c) { return nombrePerfil(c) === datos.elegido; }) || null;
}

/**
 * Cuál de los candidatos toca probar ahora. El que tenga menos corridas: así los
 * dos juntan evidencia pareja, y ante un empate gana el primero de la lista —que
 * es el reparto por hardware, o sea que el día uno no cambia nada.
 */
function siguienteAProbar(candidatos) {
  const datos = leerCrudo();
  const muestras = (datos && datos.muestras) || {};
  let mejor = candidatos[0];
  let menos = (muestras[nombrePerfil(candidatos[0])] || []).length;
  for (const c of candidatos.slice(1)) {
    const cuantas = (muestras[nombrePerfil(c)] || []).length;
    if (cuantas < menos) { menos = cuantas; mejor = c; }
  }
  return mejor;
}

function clear() {
  try { fs.unlinkSync(filePath()); } catch (e) {}
}

module.exports = {
  registrar, elegido, siguienteAProbar, elegir, nombrePerfil, baldeDe,
  clear, fingerprint, filePath, leerCrudo,
  MUESTRAS_MINIMAS, VENTAJA_MINIMA, FOTOGRAMAS_POR_BALDE,
};
