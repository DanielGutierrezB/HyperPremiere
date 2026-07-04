'use strict';

/**
 * Registro de proveedores de generacion.
 *
 * Interfaz comun que implementa cada proveedor:
 *   async generate({ systemPrompt, userPrompt, images, model, config }) -> Promise<string>
 * donde `images` es un array de data URLs ("data:image/png;base64,....")
 * y el retorno es SOLO el HTML de la composicion (sin fences de markdown).
 */

const PROVIDERS = {
  'claude-cli': './claude-cli',
  'claude-api': './claude-api',
  'openai-compat': './openai-compat',
  'ollama': './ollama',
};

/**
 * Devuelve el modulo del proveedor pedido.
 * Carga perezosa (require dentro de la funcion) para evitar requires circulares:
 * los proveedores importan stripHtmlFence desde este mismo archivo.
 *
 * @param {string} name - 'claude-cli' | 'claude-api' | 'openai-compat' | 'ollama'
 * @returns {{ generate: Function }}
 */
function getProvider(name) {
  const key = String(name || '').trim().toLowerCase();
  const modPath = PROVIDERS[key];
  if (!modPath) {
    const known = Object.keys(PROVIDERS).join(', ');
    throw new Error(`Proveedor desconocido: "${name}". Validos: ${known}`);
  }
  return require(modPath);
}

/**
 * Extrae el HTML de una respuesta de modelo.
 *
 * Los modelos suelen envolver el resultado en fences de markdown:
 *   ```html\n<html>...</html>\n```
 * Esta funcion quita el fence (```html o ``` generico) y devuelve solo el
 * contenido. Si hay varios fences, prefiere el primero etiquetado como html;
 * si no hay ninguno, devuelve el texto recortado tal cual.
 *
 * @param {string} text
 * @returns {string}
 */
function stripHtmlFence(text) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';

  // Fence etiquetado como html (case-insensitive), con o sin salto final.
  const htmlFence = trimmed.match(/```html\s*\n([\s\S]*?)```/i);
  if (htmlFence) return htmlFence[1].trim();

  // Fence generico: solo lo usamos si el contenido parece HTML,
  // para no comernos texto que tenga fences de otro lenguaje.
  const anyFence = trimmed.match(/```[a-zA-Z0-9-]*\s*\n([\s\S]*?)```/);
  if (anyFence && /<\s*(!doctype|html|div|body|section|svg)/i.test(anyFence[1])) {
    return anyFence[1].trim();
  }

  // Caso borde: la respuesta ENTERA es un fence sin cierre (respuesta cortada).
  if (trimmed.startsWith('```')) {
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline !== -1) {
      return trimmed
        .slice(firstNewline + 1)
        .replace(/```\s*$/, '')
        .trim();
    }
  }

  return trimmed;
}

/**
 * Parsea un data URL de imagen en sus partes.
 * Utilidad compartida por los proveedores que mandan imagenes base64.
 *
 * @param {string} dataUrl - "data:image/png;base64,AAAA..."
 * @returns {{ mediaType: string, base64: string } | null} null si no es un data URL valido
 */
function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (!m) return null;
  return { mediaType: m[1], base64: m[2].replace(/\s+/g, '') };
}

/**
 * Normaliza el uso de tokens a una forma común para todos los proveedores.
 * Los campos ausentes quedan en 0; costUsd es null cuando el proveedor no lo
 * reporta (Anthropic API) y 0 cuando es local (Ollama).
 *
 * @param {string} provider
 * @param {string} model
 * @param {object} raw - { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd }
 * @returns {{ inputTokens:number, outputTokens:number, cacheReadTokens:number, cacheCreationTokens:number, costUsd:number|null, provider:string, model:string }}
 */
function makeUsage(provider, model, raw) {
  raw = raw || {};
  const n = function (v) { v = Number(v); return Number.isFinite(v) ? v : 0; };
  return {
    inputTokens: n(raw.inputTokens),
    outputTokens: n(raw.outputTokens),
    cacheReadTokens: n(raw.cacheReadTokens),
    cacheCreationTokens: n(raw.cacheCreationTokens),
    costUsd: (raw.costUsd === null || raw.costUsd === undefined || !Number.isFinite(Number(raw.costUsd)))
      ? (raw.costUsd === 0 ? 0 : null)
      : Number(raw.costUsd),
    provider: provider || '',
    model: model || '',
  };
}

module.exports = { getProvider, stripHtmlFence, parseImageDataUrl, makeUsage };
