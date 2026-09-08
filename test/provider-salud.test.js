'use strict';

// Que "sin cupo" se recuerde, y —sobre todo— que se olvide.
//
// El caso que lo pidió llegó en una captura: el indicador de ⚙ en verde arriba
// y `Credit balance is too low` en la cola, abajo. Las dos cosas eran ciertas.
// El chequeo de sesión pregunta si hay CON QUÉ autenticarse, y una cuenta sin
// saldo tiene credencial: contesta que sí y tiene razón. Pero el editor solo
// mira el semáforo antes de apretar "Generar", y el semáforo no se enteraba.
//
// La mitad difícil de esto no es acordarse: es olvidar en el momento justo. Un
// cartel de "sin cupo" que sobrevive a que el editor cargue crédito es peor que
// no tenerlo, porque lo manda a dudar de una configuración que ya está bien.

const { test, ok, eq, has } = require('./harness');
const salud = require('../bridge/provider-salud');
const refinar = require('../bridge/dictado-refinar');

function limpio(fn) {
  salud.olvidarTodo();
  try { return fn(); } finally { salud.olvidarTodo(); }
}

// --- 1. Qué se recuerda ------------------------------------------------------

test('sin nada anotado, no se sabe nada: el semáforo no se toca', function () {
  limpio(function () {
    eq(salud.estado('claude-cli'), null);
    eq(salud.estado('cursor-cli'), null);
  });
});

test('una cuenta sin saldo se recuerda, con lo que dijo el proveedor', function () {
  limpio(function () {
    salud.anotar('claude-api', 'cuota', 'Credit balance is too low');
    const n = salud.estado('claude-api');
    ok(n, 'sin esto el semáforo sigue en verde hasta que alguien recargue el panel');
    eq(n.causa, 'cuota');
    has(n.motivo, 'no tiene cupo');
    has(n.queHacer, 'cargá crédito', 'y qué hacer, que es la mitad que sirve');
    has(n.detalle, 'Credit balance is too low',
      'citarlo textual es lo que deja comparar con lo que el editor ve en la cola');
  });
});

test('lo que se olvida a propósito: lo que no se arregla sabiéndolo', function () {
  // Un modelo que no existe, un timeout, una composición rota: o se arreglan en
  // el acto o no vuelven a pasar igual. Recordarlos solo agrega ruido a un
  // indicador cuyo valor entero es que cuando dice algo, importa.
  limpio(function () {
    ['modelo', 'timeout', 'red', 'desconocida', ''].forEach(function (c) {
      salud.anotar('claude-cli', c, 'algo');
      eq(salud.estado('claude-cli'), null, 'la causa "' + c + '" no se recuerda');
    });
  });
});

test('es por proveedor: que Claude no tenga cupo no dice nada de Cursor', function () {
  // El editor que se cambia a Cursor porque Claude se quedó sin cupo no puede
  // encontrarse el ámbar de Claude puesto sobre Cursor. Sería la peor forma
  // posible de sugerirle que se quede quieto.
  limpio(function () {
    salud.anotar('claude-cli', 'cuota', 'usage limit reached');
    ok(salud.estado('claude-cli'));
    eq(salud.estado('cursor-cli'), null);
  });
});

// --- 2. Cuándo se olvida, que es la parte que importa ------------------------

test('guardar la config de ese proveedor lo olvida: pegar una key es "probá de nuevo"', function () {
  limpio(function () {
    salud.anotar('cursor-cli', 'cuota', 'sin cupo');
    salud.olvidar('cursor-cli'); // es lo que hace saveConfig
    eq(salud.estado('cursor-cli'), null,
      'hacerle repetir el error para convencer al panel de que ya cargó crédito sería absurdo');
  });
});

test('guardar OTRO proveedor no le borra la nota a este', function () {
  limpio(function () {
    salud.anotar('claude-api', 'cuota', 'sin cupo');
    salud.olvidar('cursor-cli');
    ok(salud.estado('claude-api'), 'tocar la config de Cursor no arregla el saldo de Anthropic');
  });
});

test('vive en RAM y nada más: reiniciar el panel olvida', function () {
  // No es una limitación, es la decisión. Un problema de cupo se arregla afuera
  // —cargando crédito, esperando que se renueve el mes— y de eso no nos vamos a
  // enterar nunca. Persistirlo sería dejar el cartel puesto hasta la próxima
  // versión.
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../bridge/provider-salud'), 'utf8');
  ok(src.indexOf('writeFileSync') === -1, 'nada de esto se escribe al disco');
  ok(src.indexOf('readFileSync') === -1);
});

// --- 3. Lo que ve el semáforo de ⚙ -------------------------------------------

const CON_SESION = {
  estado: 'con-sesion', metodo: 'suscripcion',
  resumen: '✓ Sesión de Cursor activa — con la sesión del CLI de esta máquina',
  detalle: '',
};

test('con la cuenta sin cupo, el verde se degrada a ámbar', function () {
  limpio(function () {
    salud.anotar('cursor-cli', 'cuota', 'Credit balance is too low');
    const s = salud.aplicarA('cursor-cli', CON_SESION);
    eq(s.estado, 'sin-cupo', 'seguir en verde es la mentira que se vino a sacar');
    has(s.resumen, 'no tiene cupo');
    has(s.detalle, 'La credencial está', 'las dos cosas son ciertas y se cuentan las dos');
    has(s.detalle, 'cargá crédito');
    has(s.detalle, 'Credit balance is too low', 'con la frase que el editor ya vio en la cola');
  });
});

test('sin nota, el estado pasa intacto', function () {
  limpio(function () {
    eq(salud.aplicarA('cursor-cli', CON_SESION), CON_SESION,
      'no se le agrega ni una coma a lo que contestó el chequeo');
  });
});

test('la nota de OTRO proveedor no le mancha el verde a este', function () {
  limpio(function () {
    salud.anotar('claude-cli', 'cuota', 'usage limit reached');
    eq(salud.aplicarA('cursor-cli', CON_SESION).estado, 'con-sesion');
  });
});

test('solo se degrada el verde: los otros estados ya tienen su propio problema', function () {
  limpio(function () {
    salud.anotar('cursor-cli', 'cuota', 'sin cupo');
    ['sin-sesion', 'sin-cli', 'no-se-sabe'].forEach(function (e) {
      const s = salud.aplicarA('cursor-cli', { estado: e, resumen: 'x', detalle: '' });
      eq(s.estado, e, 'tapar "falta el CLI" con "sin cupo" es cambiarle el problema al editor');
    });
  });
});

// --- 4. Lo que hace con la nota el que refina --------------------------------

/** La cadena con refinadores de mentira (mismo gancho que dictado-refinar.test.js). */
async function conRefinadores(falsos, fn) {
  const reales = refinar._REFINADORES.splice(0, refinar._REFINADORES.length);
  falsos.forEach((f) => refinar._REFINADORES.push(f));
  refinar.olvidarRefinador();
  try { return await fn(); }
  finally {
    refinar._REFINADORES.splice(0, refinar._REFINADORES.length);
    reales.forEach((r) => refinar._REFINADORES.push(r));
    refinar.olvidarRefinador();
    // OJO: acá NO se olvida la salud. Media docena de estos tests existen justo
    // para mirar la nota que dejó el refinado, y borrarla en el camino de vuelta
    // los hacía pasar en verde sin comprobar nada. Cada test limpia lo suyo.
  }
}

function falso(o) {
  return {
    id: o.id,
    nombre: o.nombre,
    soloSiLoEligen: o.soloSiLoEligen || false,
    detectar: o.detectar || (async () => ({ disponible: true })),
    model: () => 'modelo-de-mentira',
    config: () => ({}),
    proveedor: { complete: o.complete || (async () => ({ text: '' })) },
  };
}

const DICTADO = 'eh, que el título entre desde la izquierda con un fade de medio segundo, ' +
  'y los keyframes suaves, o sea con easing, y el logo abajo a la derecha';

test('un refinado que rebota por cupo queda anotado para el semáforo', async function () {
  salud.olvidarTodo();
  await conRefinadores([falso({
    id: 'claude-api', nombre: 'Claude Haiku (API de Anthropic)',
    complete: async () => { throw new Error('HTTP 400: Your credit balance is too low to access the Anthropic API'); },
  })], () => refinar.refinarDictado({ crudo: DICTADO }, { provider: 'claude-api' }));
  const n = salud.estado('claude-api');
  ok(n, 'el motor ya se enteró acá: es el único lugar donde el "no puedo" aparece');
  eq(n.causa, 'cuota');
  salud.olvidarTodo();
});

test('un refinado que falla por cualquier otra cosa NO deja el semáforo en ámbar', async function () {
  salud.olvidarTodo();
  await conRefinadores([falso({
    id: 'claude-api', nombre: 'Claude Haiku (API de Anthropic)',
    complete: async () => { throw new Error('timeout tras 45000ms'); },
  })], () => refinar.refinarDictado({ crudo: DICTADO }, { provider: 'claude-api' }));
  eq(salud.estado('claude-api'), null, 'un timeout no dice nada de la cuenta');
  salud.olvidarTodo();
});

test('el RESPALDO no vuelve a chocar contra una cuenta que ya sabemos sin cupo', async function () {
  // Son segundos de latencia por un fallo garantizado, y el editor los espera
  // mirando el campo.
  salud.olvidarTodo();
  salud.anotar('claude-api', 'cuota', 'Credit balance is too low');
  let apiLlamada = false;
  const r = await conRefinadores([
    falso({ id: 'cursor-cli', nombre: 'Cursor', soloSiLoEligen: true, detectar: async () => ({ disponible: false, motivo: 'sin sesión' }) }),
    falso({ id: 'claude-api', nombre: 'Claude Haiku (API de Anthropic)', complete: async () => { apiLlamada = true; return { text: 'x' }; } }),
    falso({
      id: 'ollama', nombre: 'Ollama local',
      complete: async () => ({ text: 'El título entra desde la izquierda con un fade de medio segundo, easing suave en los keyframes, y el logo abajo a la derecha.' }),
    }),
  ], () => refinar.refinarDictado({ crudo: DICTADO }, { provider: 'cursor-cli' }));
  ok(r.ok, r.aviso || '');
  ok(!apiLlamada, 'ya sabíamos que iba a rebotar');
  has(r.refinador, 'Ollama', 'se siguió con el que sigue en el orden de costo');
  salud.olvidarTodo();
});

test('al proveedor ELEGIDO se lo reintenta igual: es así como el panel se entera de que cargó crédito', async function () {
  // Saltear al elegido sería dejarlo afuera de su propio panel hasta que
  // reinicie Premiere, sin ninguna forma de demostrar que ya está.
  salud.olvidarTodo();
  salud.anotar('claude-api', 'cuota', 'Credit balance is too low');
  let apiLlamada = false;
  const r = await conRefinadores([falso({
    id: 'claude-api', nombre: 'Claude Haiku (API de Anthropic)',
    complete: async () => {
      apiLlamada = true;
      return { text: 'El título entra desde la izquierda con un fade de medio segundo, easing suave en los keyframes, y el logo abajo a la derecha.' };
    },
  })], () => refinar.refinarDictado({ crudo: DICTADO }, { provider: 'claude-api' }));
  ok(apiLlamada, 'el que el editor eligió se intenta siempre');
  ok(r.ok, r.aviso || '');
  salud.olvidarTodo();
});

test('una credencial rechazada no lo deja afuera del respaldo: puede ser otra cosa', async function () {
  // Un 401 puede ser un modelo que esa cuenta no tiene o una key recién rotada.
  // Dejar a un refinador afuera por una sospecha es peor que gastar los
  // segundos: solo el cupo, que es un "no" duro, saltea.
  salud.olvidarTodo();
  salud.anotar('claude-api', 'sesion', 'invalid x-api-key');
  let apiLlamada = false;
  await conRefinadores([
    falso({ id: 'cursor-cli', nombre: 'Cursor', soloSiLoEligen: true, detectar: async () => ({ disponible: false, motivo: 'sin sesión' }) }),
    falso({
      id: 'claude-api', nombre: 'Claude Haiku (API de Anthropic)',
      complete: async () => {
        apiLlamada = true;
        return { text: 'El título entra desde la izquierda con un fade de medio segundo, easing suave en los keyframes, y el logo abajo a la derecha.' };
      },
    }),
  ], () => refinar.refinarDictado({ crudo: DICTADO }, { provider: 'cursor-cli' }));
  ok(apiLlamada, 'se intenta igual');
  salud.olvidarTodo();
});
