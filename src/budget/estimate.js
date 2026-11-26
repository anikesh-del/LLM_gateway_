import { getModelPricing, MODEL_CONFIGS } from '../config/pricing.js';
import { env } from '../config/env.js';

/**
 * Calculate cost in paise from token counts and model pricing in INR.
 * Formula: ceil((tokens_in * inputPriceInr + tokens_out * outputPriceInr) / 1e6 * 100 paise)
 * 
 * @param {string} model 
 * @param {number} tokensIn 
 * @param {number} tokensOut 
 * @returns {number} cost in integer paise
 */
export function calculateCostPaise(model, tokensIn, tokensOut) {
  const pricing = getModelPricing(model);
  const inputInr = (tokensIn * pricing.inputPriceInrPerMillion) / 1_000_000;
  const outputInr = (tokensOut * pricing.outputPriceInrPerMillion) / 1_000_000;
  const totalInr = inputInr + outputInr;

  // 1 INR = 100 paise
  return Math.ceil(totalInr * 100);
}

/**
 * Estimate input tokens from request messages.
 * Heuristic: ceil(total characters / 4)
 * @param {Array<{ role: string, content: string }>} messages
 * @returns {number} estimated tokens
 */
export function estimateInputTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let totalChars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      totalChars += msg.content.length;
    }
  }
  return Math.max(1, Math.ceil(totalChars / 4));
}

/**
 * Determine the gateway-owned output token reservation for a model.
 * The client does not control max_tokens; the gateway assigns the standard
 * worst-case token ceiling for the routed model.
 * 
 * @param {string} model
 * @returns {number}
 */
export function resolveOutputTokensLimit(model) {
  const modelConfig = MODEL_CONFIGS[model] || {
    defaultOutputTokens: 1000,
    maxOutputTokensCap: env.MAX_OUTPUT_TOKENS || 4096
  };

  return modelConfig.defaultOutputTokens;
}

/**
 * Estimate worst-case cost in paise for a request before calling provider.
 * Input tokens estimated via ceil(chars / 4).
 * Output tokens resolved via gateway model defaults.
 * 
 * @param {string} model 
 * @param {Array} messages 
 * @param {number} [overrideMaxTokens] 
 * @returns {number} worst-case cost in paise
 */
export function estimateWorstCaseCostPaise(model, messages, overrideMaxTokens) {
  const estIn = estimateInputTokens(messages);
  const effectiveMaxOut = overrideMaxTokens || resolveOutputTokensLimit(model);
  return calculateCostPaise(model, estIn, effectiveMaxOut);
}
