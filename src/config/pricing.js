/**
 * Provider model pricing definitions directly in Indian Rupees (INR) per million tokens.
 * Source: Official Google AI Studio pricing converted at benchmark rate (~₹86 / USD).
 * 
 * Rates (INR per 1M tokens):
 * Gemini 2.5 Flash:
 *   - Input: ₹25.80 per 1M tokens ($0.30 * 86)
 *   - Output: ₹215.00 per 1M tokens ($2.50 * 86)
 * 
 * Gemini 2.5 Pro:
 *   - Input: ₹107.50 per 1M tokens ($1.25 * 86)
 *   - Output: ₹860.00 per 1M tokens ($10.00 * 86)
 * 
 * Gemini 2.0 Flash:
 *   - Input: ₹8.60 per 1M tokens ($0.10 * 86)
 *   - Output: ₹34.40 per 1M tokens ($0.40 * 86)
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
  'gemini-2.5-flash': {
    inputPriceInrPerMillion: 25.80,
    outputPriceInrPerMillion: 215.00
  },
  'gemini-2.5-pro': {
    inputPriceInrPerMillion: 107.50,
    outputPriceInrPerMillion: 860.00
  }
};

export const MODEL_CONFIGS = {
  'gemini-3.5-flash-lite': {
    defaultOutputTokens: 1000,
    maxOutputTokensCap: 2048
  },
  'gemini-3.5-flash': {
    defaultOutputTokens: 2500, // reasoning models need ~1000 tokens for thinking + room for response
    maxOutputTokensCap: 4096
  },
  'gemini-2.5-flash': {
    defaultOutputTokens: 1000,
    maxOutputTokensCap: 2048
  },
  'gemini-2.5-pro': {
    defaultOutputTokens: 2500,
    maxOutputTokensCap: 4096
  }
};

/**
 * Get pricing in INR for a model or fallback to capable model pricing for safety.
 * @param {string} model 
 * @returns {{ inputPriceInrPerMillion: number, outputPriceInrPerMillion: number }}
 */
export function getModelPricing(model) {
  if (MODEL_PRICING_INR[model]) {
    return MODEL_PRICING_INR[model];
  }
  // Default to conservative/capable rate if unknown model is specified
  return MODEL_PRICING_INR['gemini-3.5-flash'];
}

