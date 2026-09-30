// LAS TRES VECES QUE SE LE DICE EL CONTRATO AL MODELO, armadas de una sola lista.
//
// ── Por qué existe ───────────────────────────────────────────────────
//
// El contrato de un motor se le repite en tres registros distintos, y cada uno
// va en otro lugar del pedido:
//
//   1. `bloqueDeContrato`  — al final del prompt de usuario, como checklist.
//   2. `recordatorioFinal` — después de todo, corto y tajante, para los
//      proveedores que no tienen canal de system prompt (ver providers/index.js).
//   3. `promptDeArreglo`   — cuando el modelo ya falló y hay que pedirle que
//      corrija SOLO el andamiaje sin rediseñar.
//
// Los tres estaban escritos a mano dentro de cada motor, así que las mismas
// cuatro reglas estaban tipeadas seis veces en total (tres por motor). El modo
// de falla es mudo y caro: agregás una regla al contrato, la escribís en el
// checklist, te olvidás del recordatorio, y los proveedores que MÁS lo necesitan
// —justo los que no tienen system prompt— reciben un contrato incompleto. Nada
// falla, nada avisa, y el síntoma aparece como "con Cursor sale peor que con
// Claude".
//
// Ahora cada motor declara `reglas` (una lista de imperativos cortos) y los tres
// bloques se COMPONEN de ahí. Agregar una regla es agregar un renglón, y aparece
// en los tres lugares o en ninguno.
//
// ── Por qué acá y no en render/ ──────────────────────────────────────
//
// Porque es prosa para el modelo, igual que `build-context.js` y que el
// `auditFixPrompt` de `compose.js`. Ése ya era la prueba de que el patrón
// funciona: es un pedido de corrección compartido por los dos motores que solo
// les pide `comoSeLlama` y `fence`, y anda sin una línea duplicada.

'use strict';

/** Las reglas numeradas, para leerlas de arriba abajo. */
function numeradas(reglas) {
  return reglas.map((r, i) => (i + 1) + '. ' + r).join('\n');
}

/** Las reglas como viñetas, que es como se leen dentro de un checklist. */
function enViñetas(reglas) {
  return reglas.map((r) => '- ' + r).join('\n');
}

/**
 * El bloque que CIERRA el prompt de usuario: cuánto tiene que durar y qué tiene
 * que cumplir. Va último porque termina en "devolvé SOLO…", que es lo que el
 * modelo tiene que leer al final.
 */
function bloqueDeContrato(motor, durationSec) {
  return '\n## Duración objetivo\n' +
    motor.duracionEnElPedido(Number(durationSec) || 0) + '\n' +
    '\n## Contrato obligatorio (verificá antes de responder)\n' +
    enViñetas(motor.reglas) + '\n' +
    '\nDevolvé SOLO ' + motor.lenguaje.comoSeLlama + ' completo de la composición.';
}

/**
 * El contrato repetido al final de todo, para los proveedores sin canal de
 * system prompt.
 *
 * Va apagado por defecto: se midió contra el CLI de verdad y no cambia nada
 * (ver `contractReminder` en providers/index.js, que tiene la medición entera).
 * El código queda para volver a medirlo cuando cambie el modelo por defecto.
 */
function recordatorioFinal(motor) {
  return '\n\n---\n\n' +
    '# ANTES DE RESPONDER — el contrato que no se negocia\n\n' +
    'Esto va último porque es lo único sin lo cual el render NO EXISTE. ' +
    'Repasá estos puntos sobre tu propio código antes de mandarlo:\n\n' +
    numeradas(motor.reglas) + '\n' +
    (motor.reglas.length + 1) + '. Devolvé SOLO ' + motor.lenguaje.comoSeLlama + '. Nada antes, nada después.\n\n' +
    'Si falta cualquiera, la composición no se puede renderizar y el trabajo se pierde entero.';
}

/**
 * "Arreglá el andamiaje y NO rediseñes."
 *
 * Es la segunda llamada de la escalera (ver compose.js) y la más delicada de
 * redactar: el diseño ya se pagó y lo que hay que conseguir es que el modelo
 * toque lo mínimo. Por eso repite las reglas y dice explícitamente que lo demás
 * está aprobado.
 */
function promptDeArreglo(motor, userPrompt, code, problema, durationSec) {
  return userPrompt +
    '\n\n## Arreglo de estructura (NO rediseñes)\n' +
    'Generaste la composición de abajo, pero ' + motor.textoDeProblema(problema) + '.\n' +
    'Devolvé LO MISMO —mismo diseño, mismos estilos, mismos tiempos— con SOLO el andamiaje corregido:\n' +
    enViñetas(motor.reglas) + '\n' +
    motor.duracionEnElPedido(Number(durationSec) || 0) + '\n' +
    'No cambies nada más: sin esto el render falla, pero el diseño ya está aprobado.\n' +
    '\n### Tu versión a corregir\n```' + motor.lenguaje.fence + '\n' + code + '\n```';
}

module.exports = { bloqueDeContrato, recordatorioFinal, promptDeArreglo };
