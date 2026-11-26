import { env } from '../config/env.js';
import { estimateInputTokens } from '../budget/estimate.js';
import { ALLOWED_MODELS } from '../config/pricing.js';

// Keywords that indicate complex reasoning, analysis, or technical work
const REASONING_KEYWORDS = [
  'step by step',
  'analyze',
  'prove',
  'debug',
  'design',
  'compare'
];

/**
 * Pure routing function: route(reqBody, config) -> { model, tier, reason }
 * Decides whether to route to the cheap tier or capable tier based on deterministic heuristics.
 * Zero LLM overhead in the routing path.
 * 
 * @param {Object} body Incoming request body
 * @param {Object} [config] Optional config override (defaults to env)
 * @returns {{ model: string, tier: 'cheap' | 'capable', reason: string }}
 */
export function route(body = {}, config = env) {
  const explicitModel = body.model;

  // 1. Explicit model provided and not "auto"
  if (explicitModel && explicitModel !== 'auto') {
    if (!ALLOWED_MODELS.includes(explicitModel)) {
      const err = new Error(`Model '${explicitModel}' is not allowed. Allowed models: ${ALLOWED_MODELS.join(', ')}`);
      err.statusCode = 400;
      err.code = 'invalid_model';
      throw err;
    }

    const isCapable = explicitModel === config.MODEL_CAPABLE;
    return {
      model: explicitModel,
      tier: isCapable ? 'capable' : 'cheap',
      reason: 'explicit'
    };
  }

  const messages = body.messages || [];
  const estTokens = estimateInputTokens(messages);
  const maxTokens = body.max_tokens;

  // 2. Rule: High input tokens (> ROUTER_LONG_PROMPT_TOKENS)
  if (estTokens > config.ROUTER_LONG_PROMPT_TOKENS) {
    return {
      model: config.MODEL_CAPABLE,
      tier: 'capable',
      reason: 'long_prompt'
    };
  }

  // 3. Rule: Large max_tokens requested (> ROUTER_CAPABLE_MAX_TOKENS)
  if (maxTokens && maxTokens > config.ROUTER_CAPABLE_MAX_TOKENS) {
    return {
      model: config.MODEL_CAPABLE,
      tier: 'capable',
      reason: 'large_max_tokens'
    };
  }

  // 4. Rule: Multi-turn conversation (> 6 messages)
  if (messages.length > 6) {
    return {
      model: config.MODEL_CAPABLE,
      tier: 'capable',
      reason: 'multi_turn_history'
    };
  }

  // Combine message contents for text pattern analysis
  let combinedText = '';
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      combinedText += ' ' + msg.content.toLowerCase();
    }
  }

  // 5. Rule: Code blocks or code-like content
  if (combinedText.includes('```') || combinedText.includes('function ') || combinedText.includes('class ') || combinedText.includes('import ')) {
    return {
      model: config.MODEL_CAPABLE,
      tier: 'capable',
      reason: 'code_detected'
    };
  }

  // 6. Rule: Reasoning keywords
  for (const kw of REASONING_KEYWORDS) {
    if (combinedText.includes(kw)) {
      return {
        model: config.MODEL_CAPABLE,
        tier: 'capable',
        reason: `reasoning_keyword_${kw.replace(/\s+/g, '_')}`
      };
    }
  }

  // 7. Default: Cheap tier for short, simple prompts
  return {
    model: config.MODEL_CHEAP,
    tier: 'cheap',
    reason: 'short_simple_prompt'
  };
}
