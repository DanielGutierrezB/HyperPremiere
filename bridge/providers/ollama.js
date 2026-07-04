'use strict';

/**
 * Proveedor: Ollama local (API /api/chat).
 *
 * POST `${config.baseUrl || 'http://localhost:11434'}/api/chat` con
 * stream:false. Las imagenes van en el campo `images` del mensaje user como
 * base64 PELADO (sin el prefijo "data:image/...;base64,") — asi lo espera
 * Ollama para modelos con vision (llava, llama3.2-vision, etc.).
 */

const { stripHtmlFence, parseImageDataUrl, makeUsage } = require('./index');

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_TIMEOUT_MS = 240_000;

/**
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {string[]} [opts.images] - data URLs de stills
 * @param {string} opts.model
 * @param {object} [opts.config] - { baseUrl?, timeoutMs? }
 * @returns {Promise<string>} HTML de la composicion
 */
async function generate({ systemPrompt, userPrompt, images, model, config }) {
  const cfg = config || {};
  if (!userPrompt || typeof userPrompt !== 'string') {
    throw new Error('ollama: userPrompt es requerido');
  }
  if (!model) {
    throw new Error('ollama: falta el model (ej: "llama3.2-vision")');
  }

  const baseUrl = String(cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/api/chat`;

  // base64 sin prefijo data: — Ollama no acepta data URLs completos.
  const bareImages = (Array.isArray(images) ? images : [])
    .map(parseImageDataUrl)
    .filter(Boolean)
    .map((img) => img.base64);

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

  const userMessage = { role: 'user', content: userPrompt };
  if (bareImages.length > 0) userMessage.images = bareImages;
  messages.push(userMessage);

  const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
    ? cfg.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`ollama: timeout tras ${timeoutMs}ms`);
    }
    throw new Error(
      `ollama: no se pudo conectar a ${url} (¿esta corriendo ollama?): ${e.message}`
    );
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  if (!res.ok) {
    // Error típico al mandar stills a un modelo sin visión (ej: qwen3-coder).
    if (/multimodal/i.test(raw)) {
      throw new Error(
        `El modelo "${model}" no soporta imágenes. Elegí un modelo con visión ` +
        `(ej: qwen3-vl:30b) o quitá los stills de este marcador.`
      );
    }
    throw new Error(`ollama: HTTP ${res.status}: ${raw.slice(0, 2000)}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    throw new Error('ollama: respuesta no es JSON valido (¿stream activado por error?)');
  }

  const contentText = data && data.message && data.message.content;
  if (typeof contentText !== 'string' || !contentText.trim()) {
    throw new Error('ollama: respuesta sin message.content');
  }

  const usage = makeUsage('ollama', model, {
    inputTokens: data.prompt_eval_count,
    outputTokens: data.eval_count,
    costUsd: 0, // local = gratis
  });
  return { text: stripHtmlFence(contentText), usage };
}

module.exports = { generate };
