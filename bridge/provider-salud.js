'use strict';

// Lo que ya nos pasó con cada proveedor en ESTA sesión del panel.
//
// El caso real, del mismo editor de las capturas de Cursor: el indicador de ⚙
// en verde arriba —hay credencial, el CLI contesta que sí— y abajo, en la cola,
// `Credit balance is too low`. Las dos cosas eran ciertas: el chequeo de sesión
// pregunta si hay CON QUÉ autenticarse, y eso no dice nada del saldo. Pero
// juntas le mienten al editor, porque lo único que mira antes de apretar
// "Generar" es el semáforo, y el semáforo no se enteraba de nada.
//
// Enterarse es gratis: cuando una generación o un refinado se cae, el motivo ya
// está clasificado (`cliErrors.causa` devuelve 'cuota' para "usage limit
// reached", 429, "credit balance is too low"…). Lo único que faltaba era que
// alguien se acordara. Eso es este archivo.
//
// Tres decisiones, y las tres son sobre CUÁNDO OLVIDAR, que es la parte que
// convierte esto de una ayuda en un cartel pegado:
//
//   1. Vive en RAM y nada más. Reiniciar el panel olvida. Un problema de cupo
//      se arregla afuera —cargando crédito, esperando que se renueve el mes— y
//      nosotros no nos vamos a enterar; lo que no puede pasar es que el editor
//      cargue crédito y el panel siga en ámbar hasta la próxima versión.
//   2. Se olvida al guardar la config de ese proveedor. Pegar una API key nueva
//      es exactamente "probá de nuevo", y hacerle repetir el error para
//      convencer al panel sería absurdo.
//   3. Es POR PROVEEDOR. Que Claude no tenga cupo no dice nada de Cursor, y el
//      indicador de cada uno mira el suyo. Sin esto, el editor que se cambia a
//      Cursor porque Claude se quedó sin cupo se encontraría con el ámbar de
//      Claude puesto sobre Cursor, que es la peor forma de sugerirle que se
//      quede quieto.
//
// Lo que NO hace: no persiste, no cuenta reintentos, no expira por tiempo. Un
// TTL suena prolijo y no lo es —¿cuánto dura "sin cupo"? hasta que el editor
// haga algo, y eso ya está cubierto por (1) y (2)—.

// provider -> { causa, motivo, desde }
const notas = {};

// Los modos de falla que vale la pena recordar. El resto —un modelo que no
// existe, un timeout, una composición rota— o se arregla en el acto o no
// vuelve a pasar igual, así que recordarlos solo agrega ruido.
//
// 'sesion' está porque una credencial vencida se comporta igual que una que
// falta, y el chequeo de sesión no la puede distinguir (dice "hay con qué
// autenticarse", no "sirve"). Cuando la generación demuestra que no sirve, el
// indicador tiene que poder dejar de decir que sí.
const RECORDABLES = {
  cuota: {
    resumen: 'hay credencial, pero la cuenta no tiene cupo',
    queHacer: 'Qué hacer: esperá a que se renueve, cargá crédito, o cambiá de proveedor en ⚙.',
  },
  sesion: {
    resumen: 'hay credencial, pero el proveedor la rechazó',
    queHacer: 'Qué hacer: revisá la credencial en ⚙ (puede haber vencido) o volvé a iniciar sesión.',
  },
};

/**
 * Anota que este proveedor falló por un motivo que conviene recordar.
 * Ignora en silencio las causas que no están en RECORDABLES, así quien llama
 * puede pasarle cualquier fallo sin filtrar.
 *
 * @param {string} provider - 'claude-cli' | 'cursor-cli' | …
 * @param {string} causa - lo que devuelve cliErrors.causa()
 * @param {string} [detalle] - la frase del proveedor, para poder citarla
 */
function anotar(provider, causa, detalle) {
  const p = String(provider || '').trim();
  const c = String(causa || '').trim();
  if (!p || !RECORDABLES[c]) return;
  notas[p] = {
    causa: c,
    motivo: RECORDABLES[c].resumen,
    queHacer: RECORDABLES[c].queHacer,
    detalle: String(detalle || '').slice(0, 300),
    desde: Date.now(),
  };
}

/**
 * Lo que sabemos de este proveedor, o null si no hay nada anotado.
 * @returns {{causa:string, motivo:string, queHacer:string, detalle:string, desde:number}|null}
 */
function estado(provider) {
  return notas[String(provider || '').trim()] || null;
}

/**
 * Le suma a un estado de sesión lo que ya sabemos de ese proveedor.
 *
 * Los dos datos son ciertos y contestan preguntas distintas: el chequeo de
 * sesión dice si hay CON QUÉ autenticarse —y para eso está bien que una cuenta
 * sin saldo dé verde, porque la credencial existe— y la nota dice si la última
 * vez que lo usamos nos rechazó. Juntos son lo que el editor necesita antes de
 * apretar "Generar"; separados, el semáforo le dice que sí y la cola le dice
 * `Credit balance is too low` treinta segundos después.
 *
 * Vive acá y no en el motor por una razón que costó una mutación sobreviviente:
 * en el motor solo se la podía probar levantando los CLI de verdad de esta
 * máquina, así que no se la probaba. Acá es una función pura sobre dos objetos.
 *
 * Solo degrada el verde: un 'sin-sesion' o un 'sin-cli' ya tienen su propio
 * mensaje y son problemas anteriores a éste.
 */
function aplicarA(provider, s) {
  const nota = estado(provider);
  if (!nota || !s || s.estado !== 'con-sesion') return s;
  return Object.assign({}, s, {
    estado: 'sin-cupo',
    resumen: '⚠ ' + nota.motivo + '.',
    detalle: [
      String(s.resumen || '').replace(/^✓\s*/, 'La credencial está: ') + '.',
      'Pero la última generación de esta sesión del panel rebotó por eso.',
      nota.queHacer,
      nota.detalle ? 'Lo que dijo el proveedor: ' + nota.detalle : '',
    ].filter(Boolean).join('\n'),
  });
}

/** Olvidar lo de un proveedor (se guardó su config: puede haber cambiado). */
function olvidar(provider) {
  delete notas[String(provider || '').trim()];
}

/** Olvidar todo (los tests, y nada más: el panel olvida reiniciándose). */
function olvidarTodo() {
  for (const k of Object.keys(notas)) delete notas[k];
}

module.exports = { anotar, estado, aplicarA, olvidar, olvidarTodo, _RECORDABLES: RECORDABLES };
