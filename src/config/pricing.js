/**
 * Provider model pricing and token configurations.
 * Date: 2026-11-26
 * Source: https://ai.google.dev/pricing
 * 
 * NOTE ON ESTIMATES & PRICING HONESTY:
 * Google AI Studio publishes rates for its Flash-Lite and Flash tier classes:
 * - Flash-Lite tier: $0.10 input / $0.40 output per 1M tokens (~₹8.60 in / ~₹34.40 out at ₹86/USD)
 * - Flash tier: $0.30 input / $2.50 output per 1M tokens (~₹25.80 in / ~₹215.00 out at ₹86/USD)
 * 
 * The gateway targets active model identifiers 'gemini-3.5-flash-lite' and 'gemini-3.5-flash'.
 * Because Google has not yet published standalone, distinct 3.5-specific rate cards, the
 * pricing below explicitly uses the official Flash-Lite and Flash tier rates as estimated proxies.
 * 
 * Rates (INR per 1M tokens):
 * Gemini 3.5 Flash-Lite (Estimated surrogate based on Google Flash-Lite tier):
 *   - Input: ₹8.60 per 1M tokens
 *   - Output: ₹34.40 per 1M tokens
 * 
 * Gemini 3.5 Flash (Estimated surrogate based on Google Flash tier):
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
  },
  'gemini-3-flash-preview': {
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
  },
  'gemini-3-flash-preview': {
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
