/**
 * Provider model pricing and token configurations.
 * Date: 2026-11-26
 * 
 * NOTE ON ESTIMATES:
 * Model pricing for Gemini 3.5 generation models below are ESTIMATES based on benchmark
 * Google AI Studio tier structures (~₹86 / USD conversion).
 * 
 * Rates (INR per 1M tokens):
 * Gemini 3.5 Flash-Lite (Estimate based on low-cost high-throughput tier):
 *   - Input: ₹8.60 per 1M tokens
 *   - Output: ₹34.40 per 1M tokens
 * 
 * Gemini 3.5 Flash (Estimate based on standard multimodal flash tier):
 *   - Input: ₹25.80 per 1M tokens
 *   - Output: ₹215.00 per 1M tokens
 */

export const MODEL_PRICING_INR = {
  'gemini-3.5-flash-lite': {
    inputPriceInrPerMillion: 8.60,
    outputPriceInrPerMillion: 34.40
  },
  'gemini-3.5-flash': {
    inputPriceInrPerMillion: 25.80,
    outputPriceInrPerMillion: 215.00
  }
};

export const MODEL_CONFIGS = {
  'gemini-3.5-flash-lite': {
    defaultOutputTokens: 1000,
    maxOutputTokensCap: 2048
  },
  'gemini-3.5-flash': {
    defaultOutputTokens: 2500,
    maxOutputTokensCap: 4096
  }
};

/**
 * Model allowlist for the gateway.
 */
export const ALLOWED_MODELS = Object.keys(MODEL_PRICING_INR);

/**
 * Get pricing in INR for an allowlisted model. Throws if unknown.
 * @param {string} model 
 * @returns {{ inputPriceInrPerMillion: number, outputPriceInrPerMillion: number }}
 */
export function getModelPricing(model) {
  if (MODEL_PRICING_INR[model]) {
    return MODEL_PRICING_INR[model];
  }
  throw new Error(`Model '${model}' is not in the allowed pricing catalog.`);
}
