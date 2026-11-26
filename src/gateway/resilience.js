import { env } from '../config/env.js';
import { callOpenAICompatible } from '../providers/openaiCompatible.js';
import { estimateWorstCaseCostPaise } from '../budget/estimate.js';
import { reserveBudget } from '../budget/reserve.js';

/**
 * Check if an error or HTTP status code is retryable per ARCHITECTURE.md section 7:
 * Retry only on timeout, network error, HTTP 5xx, or HTTP 429.
 * Never retry caller-caused 4xx (400, 401, 403, 404).
 */
export function isRetryable(status, err) {
  if (err) {
    // Retry on timeout, abort, or network errors
    return !!(err.isTimeout || err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.name === 'FetchError' || err.message?.includes('fetch failed'));
  }

  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
  }

  return false;
}

/**
 * Execute call with resilience policy:
 * - Deadline check (overall REQUEST_DEADLINE_MS)
 * - Per-attempt timeout (PROVIDER_TIMEOUT_MS)
 * - Max 1 retry with small jittered backoff
 * - If cheap model fails after retry, fallback to capable model
 * - Top up reservation if capable model worst-case cost is higher
 * 
 * @param {Object} options
 * @param {string} options.keyId
 * @param {string} options.initialModel
 * @param {Array} options.messages
 * @param {number} [options.max_tokens]
 * @param {number} [options.temperature]
 * @param {number} options.currentReservedPaise
 * @returns {Promise<{
 *   success: boolean,
 *   result?: any,
 *   servingModel: string,
 *   attempts: number,
 *   totalReservedPaise: number,
 *   errorStatus?: number,
 *   errorCode?: string,
 *   isBudgetExceededOnFallback?: boolean
 * }>}
 */
export async function executeWithResilience({
  keyId,
  initialModel,
  messages,
  max_tokens,
  temperature,
  currentReservedPaise
}) {
  const deadline = Date.now() + env.REQUEST_DEADLINE_MS;
  let attempts = 0;
  let totalReservedPaise = currentReservedPaise;
  let currentModel = initialModel;
  let lastErrorStatus = null;
  let lastErrorCode = null;

  // Tier 1: Try initial model (up to 1 initial try + 1 retry)
  const maxInitialAttempts = 2;
  for (let i = 0; i < maxInitialAttempts; i++) {
    // Check deadline
    if (Date.now() >= deadline) {
      return {
        success: false,
        servingModel: currentModel,
        attempts,
        totalReservedPaise,
        errorStatus: 504,
        errorCode: 'REQUEST_DEADLINE_EXCEEDED'
      };
    }

    attempts++;

    try {
      const remainingTime = Math.max(1000, deadline - Date.now());
      const timeoutMs = Math.min(env.PROVIDER_TIMEOUT_MS, remainingTime);

      const res = await callOpenAICompatible({
        model: currentModel,
        messages,
        max_tokens,
        temperature,
        provider: env.DEFAULT_PROVIDER,
        timeoutMs
      });

      if (res.status >= 200 && res.status < 300 && res.data) {
        return {
          success: true,
          result: res.data,
          servingModel: currentModel,
          attempts,
          totalReservedPaise
        };
      }

      lastErrorStatus = res.status;
      lastErrorCode = `HTTP_${res.status}`;

      // Check if retryable
      if (!isRetryable(res.status, null)) {
        // Map caller format errors (400, 422) to caller 400; map upstream auth/not found (401, 403, 404) to gateway 502
        const mappedStatus = (res.status === 400 || res.status === 422) ? 400 : 502;
        return {
          success: false,
          servingModel: currentModel,
          attempts,
          totalReservedPaise,
          errorStatus: mappedStatus,
          errorCode: lastErrorCode
        };
      }
    } catch (err) {
      lastErrorStatus = err.isTimeout ? 504 : 502;
      lastErrorCode = err.isTimeout ? 'PROVIDER_TIMEOUT' : (err.code || 'NETWORK_ERROR');

      if (!isRetryable(null, err)) {
        return {
          success: false,
          servingModel: currentModel,
          attempts,
          totalReservedPaise,
          errorStatus: lastErrorStatus,
          errorCode: lastErrorCode
        };
      }
    }

    // Small jittered backoff before retry (50ms - 150ms)
    if (i < maxInitialAttempts - 1) {
      const jitter = 50 + Math.floor(Math.random() * 100);
      await new Promise(r => setTimeout(r, jitter));
    }
  }

  // Tier 2: Fallback logic (only if initial model was cheap tier and failed)
  if (currentModel === env.MODEL_CHEAP && env.MODEL_CAPABLE !== env.MODEL_CHEAP) {
    const fallbackModel = env.MODEL_CAPABLE;
    const fallbackWorstCase = estimateWorstCaseCostPaise(fallbackModel, messages, max_tokens);

    // If fallback model has higher worst-case cost, top up reservation atomically
    if (fallbackWorstCase > totalReservedPaise) {
      const topUpPaise = fallbackWorstCase - totalReservedPaise;
      const topUpResult = await reserveBudget(keyId, topUpPaise);

      if (!topUpResult.success) {
        // Cannot afford fallback model -> return 402 with budget exceeded
        return {
          success: false,
          servingModel: currentModel,
          attempts,
          totalReservedPaise,
          errorStatus: 402,
          errorCode: 'BUDGET_EXCEEDED_FALLBACK',
          isBudgetExceededOnFallback: true
        };
      }

      totalReservedPaise += topUpPaise;
    }

    currentModel = fallbackModel;

    // Try fallback model once (or fail)
    if (Date.now() < deadline) {
      attempts++;
      try {
        const remainingTime = Math.max(1000, deadline - Date.now());
        const timeoutMs = Math.min(env.PROVIDER_TIMEOUT_MS, remainingTime);

        const res = await callOpenAICompatible({
          model: currentModel,
          messages,
          max_tokens,
          temperature,
          provider: env.DEFAULT_PROVIDER,
          timeoutMs
        });

        if (res.status >= 200 && res.status < 300 && res.data) {
          return {
            success: true,
            result: res.data,
            servingModel: currentModel,
            attempts,
            totalReservedPaise
          };
        }

        lastErrorStatus = res.status;
        lastErrorCode = `HTTP_${res.status}`;
      } catch (err) {
        lastErrorStatus = err.isTimeout ? 504 : 502;
        lastErrorCode = err.isTimeout ? 'PROVIDER_TIMEOUT' : (err.code || 'NETWORK_ERROR');
      }
    }
  }

  // All attempts failed -> return clean 502 or 504
  return {
    success: false,
    servingModel: currentModel,
    attempts,
    totalReservedPaise,
    errorStatus: lastErrorStatus === 504 ? 504 : 502,
    errorCode: lastErrorCode
  };
}
