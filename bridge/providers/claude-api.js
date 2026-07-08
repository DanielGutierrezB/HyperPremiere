'use strict';

/**
 * Proveedor: Anthropic Messages API (https://api.anthropic.com/v1/messages).
 *
 * Usa fetch global (Node 18+). Autenticacion via header x-api-key
 * (config.apiKey) y version fija del API "2023-06-01".
 * Las imagenes viajan como bloques `image` base64 dentro del mensaje user.
 */

const { stripHtmlFence, parseImageDataUrl, makeUsage } = require('./index');
// Usamos el fetch de Node (https nativo), NO el del Chromium del panel CEP:
// en Windows ese Chromium viejo devuelve 502/Failed to fetch tras proxy/AV.
const { hpFetch } = require('./http');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-4-8';
const DEFAULT_MAX_TOKENS = 16000;
const DEFAULT_TIMEOUT_MS = 240_000;

// El portapapeles de Windows suele arrastrar \r, espacios o comillas al pegar.
// Limpiamos para que el header x-api-key no se rompa por ruido invisible.
function normalizeApiKey(raw) {
  return String(raw || '').trim().replace(/^["']|["']$/g, '').trim();
}

// Un token de suscripción (sk-ant-oat…) NO es una API key: el endpoint de la API
// lo rechaza con 401. Lo detectamos antes de gastar la llamada y explicamos qué hacer.
function assertNotOAuthToken(apiKey) {
  if (/^sk-ant-oat/i.test(apiKey)) {
    throw new Error('claude-api: pegaste un token de suscripción (sk-ant-oat…), no una API key. Cambiá el proveedor a "Claude (CLI / suscripción)" y usá el botón de login, o pegá una API key real (sk-ant-api03-…) de console.anthropic.com.');
  }
}

/**
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {string[]} [opts.images] - data URLs de stills
 * @param {string} opts.model
 * @param {object} opts.config - { apiKey (requerido), maxTokens?, timeoutMs? }
 * @returns {Promise<string>} HTML de la composicion
 */
async function generate({ systemPrompt, userPrompt, images, model, config }) {
  const cfg = config || {};
  const apiKey = normalizeApiKey(cfg.apiKey);
  if (!apiKey) {
    throw new Error('claude-api: falta config.apiKey (API key de Anthropic)');
  }
  assertNotOAuthToken(apiKey);
  if (!userPrompt || typeof userPrompt !== 'string') {
    throw new Error('claude-api: userPrompt es requerido');
  }

  // Bloques de imagen primero, luego el texto (orden recomendado por Anthropic).
  const content = [];
  for (const dataUrl of Array.isArray(images) ? images : []) {
    const img = parseImageDataUrl(dataUrl);
    if (!img) continue; // data URL malformado: lo omitimos en vez de romper todo
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    });
  }
  content.push({ type: 'text', text: userPrompt });

  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: Number.isFinite(cfg.maxTokens) ? cfg.maxTokens : DEFAULT_MAX_TOKENS,
    messages: [{ role: 'user', content }],
  };
  if (systemPrompt) body.system = systemPrompt;

  const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
    ? cfg.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await hpFetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`claude-api: timeout tras ${timeoutMs}ms`);
    }
    throw new Error(`claude-api: error de red: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  if (!res.ok) {
    // El API devuelve JSON de error, pero lo pasamos crudo por si no lo es.
    if (res.status === 401) {
      throw new Error('claude-api: HTTP 401 — API key inválida. Revisá que sea una key real de console.anthropic.com (empieza con sk-ant-api03-…), de una cuenta activa con saldo, y sin espacios de más.');
    }
    if (res.status === 404 || (res.status === 400 && /model/i.test(raw))) {
      throw new Error(`claude-api: HTTP ${res.status} — el modelo "${model || DEFAULT_MODEL}" no existe en la API de Anthropic. Elegí otro modelo en la config. Detalle: ${raw.slice(0, 300)}`);
    }
    throw new Error(`claude-api: HTTP ${res.status}: ${raw.slice(0, 2000)}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    throw new Error('claude-api: respuesta no es JSON valido');
  }

  // stop_reason "refusal" llega como HTTP 200 — chequear antes de leer content.
  if (data.stop_reason === 'refusal') {
    throw new Error('claude-api: el modelo rechazo la solicitud (stop_reason: refusal)');
  }

  // Concatenar todos los bloques de texto (puede haber thinking u otros antes).
  const text = (Array.isArray(data.content) ? data.content : [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');

  const html = stripHtmlFence(text);
  if (!html) throw new Error('claude-api: la respuesta no contiene texto');

  const u = data.usage || {};
  const usage = makeUsage('claude-api', model || DEFAULT_MODEL, {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens,
    cacheCreationTokens: u.cache_creation_input_tokens,
    costUsd: null, // Anthropic no devuelve costo en el body
  });
  return { text: html, usage };
}

module.exports = { generate, normalizeApiKey, assertNotOAuthToken, API_URL, API_VERSION, DEFAULT_MODEL };
