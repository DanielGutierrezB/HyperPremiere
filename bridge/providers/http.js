'use strict';

/**
 * hpFetch — reemplazo mínimo de `fetch` respaldado por el stack de red NATIVO
 * de Node (módulos https/http + OpenSSL), NO por el fetch del Chromium embebido
 * del panel CEP.
 *
 * Por qué existe: el motor se carga con window.cep_node.require dentro del panel,
 * así que el `fetch` global es el del Chromium 99 de Premiere. En Windows ese
 * stack obedece proxy del sistema / inspección SSL de antivirus y con TLS viejo
 * devuelve "502 Bad Gateway (cloudflare)" o "Failed to fetch". Usar el https de
 * Node evita todo eso: TLS moderno, independiente del navegador, y con soporte
 * opcional de proxy corporativo vía HTTPS_PROXY / HTTP_PROXY.
 *
 * Implementa el subconjunto de la API fetch que usa este proyecto:
 *   fetch(url, { method, headers, body, signal })
 *   res.ok · res.status · res.statusText · res.headers.get() · res.text() ·
 *   res.json() · res.arrayBuffer()
 * y sigue redirects (necesario para las descargas de GitHub del auto-update).
 */

const https = require('https');
const http = require('http');
const tls = require('tls');
const { URL } = require('url');

const MAX_REDIRECTS = 5;

function proxyFor(target) {
  const env = process.env || {};
  const isHttps = target.protocol === 'https:';
  const raw = isHttps
    ? (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)
    : (env.HTTP_PROXY || env.http_proxy);
  if (!raw) return null;

  const noProxy = env.NO_PROXY || env.no_proxy || '';
  if (noProxy) {
    const host = String(target.hostname || '').toLowerCase();
    const bypass = noProxy.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      .some((p) => p === '*' || host === p || host.endsWith('.' + p.replace(/^\./, '')));
    if (bypass) return null;
  }
  try { return new URL(raw); } catch (_) { return null; }
}

function proxyAuthHeader(proxy) {
  if (!proxy || !proxy.username) return null;
  const user = decodeURIComponent(proxy.username);
  const pass = decodeURIComponent(proxy.password || '');
  return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
}

function makeResponse(res, bodyBuf) {
  const status = res.statusCode;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: res.statusMessage || '',
    headers: {
      get: (name) => {
        const v = res.headers[String(name).toLowerCase()];
        return Array.isArray(v) ? v.join(', ') : (v == null ? null : v);
      },
    },
    text: async () => bodyBuf.toString('utf8'),
    json: async () => JSON.parse(bodyBuf.toString('utf8')),
    arrayBuffer: async () => bodyBuf.buffer.slice(bodyBuf.byteOffset, bodyBuf.byteOffset + bodyBuf.byteLength),
  };
}

// Abre el socket base hacia el destino, tunelizando por proxy si hace falta.
function openSocket(target, proxy, cb) {
  const isHttps = target.protocol === 'https:';
  const targetPort = Number(target.port) || (isHttps ? 443 : 80);

  // Sin proxy: la request normal de http/https abre su propio socket.
  if (!proxy) return cb(null, null);

  // http a través de proxy: no hace falta túnel, se manda la URL absoluta.
  if (!isHttps) return cb(null, 'absolute');

  // https a través de proxy: túnel CONNECT y luego TLS sobre ese socket.
  const proxyLib = proxy.protocol === 'https:' ? https : http;
  const headers = {};
  const auth = proxyAuthHeader(proxy);
  if (auth) headers['Proxy-Authorization'] = auth;

  const connectReq = proxyLib.request({
    host: proxy.hostname,
    port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
    method: 'CONNECT',
    path: target.hostname + ':' + targetPort,
    headers,
  });
  connectReq.once('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      return cb(new Error('proxy CONNECT falló: HTTP ' + res.statusCode));
    }
    const tlsSocket = tls.connect({ socket, servername: target.hostname }, () => cb(null, tlsSocket));
    tlsSocket.once('error', (e) => cb(e));
  });
  connectReq.once('error', (e) => cb(e));
  connectReq.end();
}

function hpFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const signal = opts.signal;

    function request(rawUrl, method, body, redirectsLeft) {
      let target;
      try { target = new URL(rawUrl); } catch (_) { return reject(new Error('URL inválida: ' + rawUrl)); }

      if (signal && signal.aborted) {
        return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      }

      const proxy = proxyFor(target);
      const isHttps = target.protocol === 'https:';
      const lib = isHttps ? https : http;

      openSocket(target, proxy, (err, socketOrMode) => {
        if (err) return reject(new Error('error de red: ' + err.message));

        const headers = Object.assign({}, opts.headers || {});
        if (body != null) {
          const hasLen = Object.keys(headers).some((h) => h.toLowerCase() === 'content-length');
          if (!hasLen) headers['content-length'] = Buffer.byteLength(typeof body === 'string' ? body : String(body));
        }
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'host')) {
          headers['host'] = target.host;
        }

        const reqOpts = { method, headers };
        if (socketOrMode === 'absolute') {
          // http vía proxy: pedir la URL absoluta al proxy.
          reqOpts.host = proxy.hostname;
          reqOpts.port = Number(proxy.port) || 80;
          reqOpts.path = target.href;
          const auth = proxyAuthHeader(proxy);
          if (auth) headers['Proxy-Authorization'] = auth;
        } else {
          reqOpts.host = target.hostname;
          reqOpts.port = Number(target.port) || (isHttps ? 443 : 80);
          reqOpts.path = (target.pathname || '/') + (target.search || '');
          reqOpts.servername = target.hostname;
          if (socketOrMode) { reqOpts.socket = socketOrMode; reqOpts.agent = false; }
        }

        const clientReq = lib.request(reqOpts, (res) => {
          const status = res.statusCode;
          // Redirects.
          if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume(); // descartar cuerpo
            const next = new URL(res.headers.location, target).href;
            // 303 → GET; 301/302 con POST → GET (comportamiento de navegador); 307/308 conservan.
            let nextMethod = method;
            let nextBody = body;
            if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
              nextMethod = 'GET';
              nextBody = undefined;
            }
            return request(next, nextMethod, nextBody, redirectsLeft - 1);
          }
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => resolve(makeResponse(res, Buffer.concat(chunks))));
          res.on('error', (e) => reject(new Error('error de red: ' + e.message)));
        });

        function onAbort() {
          clientReq.destroy(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        }
        if (signal) {
          if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
        }
        clientReq.on('error', (e) => {
          if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
          if (e && e.name === 'AbortError') return reject(e);
          reject(new Error('error de red: ' + e.message));
        });
        clientReq.on('close', () => {
          if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        });

        if (body != null) clientReq.write(body);
        clientReq.end();
      });
    }

    request(url, opts.method || 'GET', opts.body, MAX_REDIRECTS);
  });
}

module.exports = { hpFetch };
