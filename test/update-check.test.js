'use strict';

// El chequeo de versión del botón ⟳, probado contra un GitHub de mentira.
//
// El bug que motivó estos tests: la versión publicada se leía de
// raw.githubusercontent.com, que se sirve por un CDN que cachea POR RUTA e
// IGNORA el "?t=<ahora>" que le colgábamos para esquivarlo. Con la 1.4.27 ya en
// main, raw seguía devolviendo 1.4.25 durante minutos y el panel lo mostraba
// como "estás al día". Nadie se enteró en semanas porque "no pude consultar" y
// "no hay nada nuevo" se veían EXACTAMENTE IGUAL.
//
// Así que lo que más se prueba acá es que esas dos cosas no se vuelvan a
// confundir, ni en el motor ni en lo que ve el editor.

const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { test, ok, eq, has } = require('./harness');
const engine = require('../bridge/engine');

// GitHub de mentira. Sirve dos rutas con los formatos REALES de cada fuente:
//   /api → la API de contenidos, que devuelve el archivo en base64;
//   /raw → el version.json crudo, tal cual.
// `guion` dice qué contesta cada una: { version } para responder bien,
// { sinCupo:true } para el límite de la API, { status } para un HTTP feo, o
// nada para cortar la conexión.
function githubFalso(guion) {
  const pedidos = [];
  const srv = http.createServer((req, res) => {
    const fuente = req.url.indexOf('/api') === 0 ? 'api' : 'raw';
    pedidos.push({ fuente, ua: req.headers['user-agent'] || '' });
    const g = guion[fuente];

    if (!g) { res.destroy(); return; }  // la conexión se cae

    if (g.sinCupo) {
      res.writeHead(403, { 'content-type': 'application/json', 'x-ratelimit-remaining': '0' });
      res.end(JSON.stringify({ message: 'API rate limit exceeded for 1.2.3.4' }));
      return;
    }
    if (g.status) { res.writeHead(g.status); res.end('no'); return; }

    // GitHub rechaza con 403 cualquier pedido a la API sin User-Agent. El de
    // mentira hace lo mismo, para que el día que ese header se caiga del código
    // los tests lo canten en vez de dejarnos otra detección ciega.
    if (fuente === 'api' && !req.headers['user-agent']) {
      res.writeHead(403);
      res.end('Request forbidden by administrative rules. Please make sure your request has a User-Agent header');
      return;
    }

    const cuerpo = fuente === 'api'
      ? JSON.stringify({
          encoding: 'base64',
          // La API parte el base64 en líneas: si alguien lo decodifica a mano
          // sin contemplarlo, se rompe acá y no en la máquina del editor.
          content: Buffer.from(JSON.stringify({ version: g.version })).toString('base64') + '\n',
        })
      : JSON.stringify({ version: g.version });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(cuerpo);
  });

  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + srv.address().port;
      resolve({
        urls: { apiUrl: base + '/api/version.json', rawUrl: base + '/raw/version.json' },
        pedidos,
        cerrar: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

/** Corre el chequeo de la instalación empaquetada contra el GitHub de mentira. */
async function chequear(instalada, guion, fn) {
  const s = await githubFalso(guion);
  try {
    return await fn(await engine._checkPackagedUpdate(instalada, s.urls), s.pedidos);
  } finally {
    await s.cerrar();
  }
}

// ── Detección ───────────────────────────────────────────────────────────

test('una versión nueva publicada se detecta', async function () {
  await chequear('1.4.28', { api: { version: '1.4.30' } }, function (r, pedidos) {
    eq(r.ok, true, 'se pudo consultar');
    eq(r.changed, true, 'hay update');
    eq(r.remote, '1.4.30', 'y dice cuál');
    eq(r.source, 'api', 'leída de la fuente fresca');
    has(pedidos[0].ua, 'HyperPremiere', 'con User-Agent, que la API exige sí o sí');
  });
});

test('la fuente cacheada y vieja NO hace perder la actualización', async function () {
  // El caso exacto del bug: raw atrasado en 1.4.25 mientras main ya tiene 1.4.30.
  await chequear('1.4.28', { api: { version: '1.4.30' }, raw: { version: '1.4.25' } }, function (r, pedidos) {
    eq(r.changed, true, 'gana la fuente fresca');
    eq(r.remote, '1.4.30', 'y no la cacheada');
    eq(pedidos.length, 1, 'al respaldo ni se lo consulta si la API contestó');
    eq(pedidos[0].fuente, 'api', 'la API es la fuente principal, no el respaldo');
  });
});

// ── Cuando no se puede averiguar ────────────────────────────────────────

test('quedarse sin cupo de la API se reporta como "no pude averiguar", no como "estás al día"', async function () {
  // Sin cupo, contesta el respaldo con la misma versión instalada. Es
  // TENTADOR leer eso como "al día": es justo la mentira que hay que evitar.
  await chequear('1.4.28', { api: { sinCupo: true }, raw: { version: '1.4.28' } }, function (r) {
    eq(r.changed, false, 'no anuncia un update que no vio');
    ok(r.verified !== true, 'pero NO afirma que estés al día');
    has(r.error, 'No pude confirmar', 'y lo dice con todas las letras');
    has(r.error, 'limitó las consultas', 'explicando que fue el límite de GitHub');
  });
});

test('si fallan las dos fuentes, se avisa; no se inventa un "al día"', async function () {
  await chequear('1.4.28', {}, function (r) {
    eq(r.ok, false, 'el chequeo no se pudo hacer');
    eq(r.changed, false, 'no hay nada que proponer');
    eq(r.verified, false, 'y tampoco se confirma que estemos al día');
    has(r.error, 'No se pudo consultar GitHub', 'con un motivo mostrable');
  });
});

test('un HTTP feo de la API tampoco pasa por "estás al día"', async function () {
  await chequear('1.4.28', { api: { status: 500 }, raw: { version: '1.4.28' } }, function (r, pedidos) {
    eq(pedidos.length, 2, 'se cae al respaldo');
    ok(r.verified !== true, 'pero el resultado queda marcado como no confirmado');
  });
});

// ── Respaldo ────────────────────────────────────────────────────────────

test('si la API falla, el respaldo sirve igual para avisar de una versión nueva', async function () {
  // Una fuente cacheada puede estar ATRASADA, nunca adelantada: si dice que hay
  // versión nueva, es verdad. Mejor un aviso posiblemente viejo que ninguno.
  await chequear('1.4.28', { raw: { version: '1.4.30' } }, function (r) {
    eq(r.ok, true, 'contestó el respaldo');
    eq(r.changed, true, 'y el aviso vale');
    eq(r.source, 'raw', 'aunque venga del respaldo');
    eq(r.verified, true, 'un "hay versión nueva" es confiable venga de donde venga');
  });
});

test('la respuesta de la API se decodifica bien (viene en base64)', async function () {
  await chequear('0.0.1', { api: { version: '1.4.28' } }, function (r) {
    eq(r.remote, '1.4.28', 'el número sale entero, sin base64 ni saltos de línea');
  });
});

// ── Nunca para atrás ────────────────────────────────────────────────────

test('nunca se propone "actualizar" a una versión más vieja que la instalada', async function () {
  await chequear('1.4.28', { api: { version: '1.4.20' } }, function (r) {
    eq(r.changed, false, 'una instalación adelantada no se "baja"');
    eq(r.verified, true, 'y eso sí es una respuesta confirmada');
  });
  await chequear('1.4.28', { api: { version: '1.4.28' } }, function (r) {
    eq(r.changed, false, 'la misma versión no es un update');
    eq(r.verified, true, 'confirmado contra la fuente fresca');
  });
  // 1.4.9 vs 1.4.10: comparando como texto, "9" > "1" y propondría bajar.
  await chequear('1.4.10', { api: { version: '1.4.9' } }, function (r) {
    eq(r.changed, false, 'se compara por número, no alfabéticamente');
  });
});

// ── Lo que ve el editor ─────────────────────────────────────────────────

// El panel es JS de navegador sin módulos: se evalúa suelto, como en los
// demás tests del panel.
function cargarUtil() {
  const ctx = { console, setTimeout, clearTimeout, Date, Math, JSON };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'cep', 'js', 'util.js'), 'utf8'), ctx, { filename: 'util.js' });
  return ctx.HPUtil;
}

test('el botón ⟳ muestra TRES estados distintos, no dos', function () {
  const badge = cargarUtil().updateBadge;

  const hay = badge({ ok: true, current: '1.4.28', remote: '1.4.30', changed: true, verified: true });
  eq(hay.state, 'update', 'hay versión nueva');
  has(hay.label, '1.4.30', 'y se ve cuál en el botón');

  const alDia = badge({ ok: true, current: '1.4.28', remote: '1.4.28', changed: false, verified: true });
  eq(alDia.state, 'ok', 'al día, confirmado');

  const noSe = badge({ ok: true, current: '1.4.28', remote: '1.4.28', changed: false, verified: false, error: 'GitHub limitó las consultas' });
  eq(noSe.state, 'unknown', 'no se pudo confirmar');
  ok(noSe.label !== alDia.label, 'y NO se ve igual que "al día": ' + noSe.label);
  has(noSe.title, 'NO sé si hay una versión nueva', 'el texto lo dice sin vueltas');
  has(noSe.title, 'GitHub limitó las consultas', 'con el motivo real');
});

test('si el motor ni contesta, el panel tampoco dice "al día"', function () {
  const noSe = cargarUtil().updateBadge({ ok: false, error: 'sin internet' }, '1.4.28');
  eq(noSe.state, 'unknown', 'queda en "no se pudo averiguar"');
  has(noSe.label, '1.4.28', 'igual muestra la versión instalada');
  has(noSe.title, 'sin internet', 'y por qué falló');
});
