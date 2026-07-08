'use strict';

/**
 * Proveedor: cualquier API compatible con OpenAI Chat Completions.
 * (OpenAI, OpenRouter, LM Studio, vLLM, etc.)
 *
 * POST `${config.baseUrl}/chat/completions` con Authorization: Bearer.
 * Las imagenes viajan como bloques `image_url` con el data URL tal cual
 * (el formato data:...;base64,... es aceptado por el estandar de OpenAI).
 */

const { stripHtmlFence, makeUsage } = require('./index');
const { hpFetch } = require('./http');

const DEFAULT_TIMEOUT_MS = 240_000;

/**
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {string[]} [opts.images] - data URLs de stills
 * @param {string} opts.model
 * @param {object} opts.config - { baseUrl (requerido), apiKey?, timeoutMs?, maxTokens? }
 * @returns {Promise<string>} HTML de la composicion
 */
async function generate({ systemPrompt, userPrompt, images, model, config }) {
  const cfg = config || {};
  if (!cfg.baseUrl) {
    throw new Error('openai-compat: falta config.baseUrl (ej: https://api.openai.com/v1)');
  }
  if (!userPrompt || typeof userPrompt !== 'string') {
    throw new Error('openai-compat: userPrompt es requerido');
  }
  if (!model) {
    throw new Error('openai-compat: falta el model');
  }

  const url = `${String(cfg.baseUrl).replace(/\/+$/, '')}/chat/completions`;

  // user message: texto + imagenes como image_url (data URLs directos).
  const userContent = [{ type: 'text', text: userPrompt }];
  for (const dataUrl of Array.isArray(images) ? images : []) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) continue;
    userContent.push({ type: 'image_url', image_url: { url: dataUrl } });
  }

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userContent });

  const body = { model, messages };
  if (Number.isFinite(cfg.maxTokens)) body.max_tokens = cfg.maxTokens;

  const headers = { 'content-type': 'application/json' };
  // Algunos servidores locales (LM Studio, vLLM) no exigen key.
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
    ? cfg.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await hpFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`openai-compat: timeout tras ${timeoutMs}ms`);
    }
    throw new Error(`openai-compat: error de red contra ${url}: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`openai-compat: HTTP ${res.status}: ${raw.slice(0, 2000)}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    throw new Error('openai-compat: respuesta no es JSON valido');
  }

  const contentText = data
    && Array.isArray(data.choices)
    && data.choices[0]
    && data.choices[0].message
    && data.choices[0].message.content;

  if (typeof contentText !== 'string' || !contentText.trim()) {
    throw new Error('openai-compat: respuesta sin choices[0].message.content');
  }

  const u = data.usage || {};
  const usage = makeUsage('openai-compat', model, {
    inputTokens: u.prompt_tokens,
    outputTokens: u.completion_tokens,
    costUsd: null,
  });
  return { text: stripHtmlFence(contentText), usage };
}

module.exports = { generate };
