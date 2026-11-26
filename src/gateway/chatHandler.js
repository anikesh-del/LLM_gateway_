import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { calculateCostPaise, estimateInputTokens, estimateWorstCaseCostPaise, resolveOutputTokensLimit } from '../budget/estimate.js';
import { reserveBudget } from '../budget/reserve.js';
import { settleBudget } from '../budget/settle.js';
import { executeWithResilience } from './resilience.js';
import { route } from '../router/route.js';
import { geminiBreaker } from './circuitBreaker.js';

// OpenAI-compatible chat completion body schema
// Note: max_tokens is deliberately gateway-controlled and estimated internally;
// callers cannot inflate or manipulate reservations.
const chatCompletionSchema = z.object({
  model: z.string().optional().default('auto'),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string()
    })
  ).min(1, 'messages must contain at least 1 message'),
  stream: z.literal(false).optional(),
  temperature: z.number().min(0).max(2).optional()
}).passthrough();

/**
 * Handle POST /v1/chat/completions
 */
export async function chatHandler(req, res) {
  const requestId = `req_${crypto.randomBytes(12).toString('hex')}`;
  const startTime = Date.now();

  // 1. Check Circuit Breaker (Fail-fast protection against cascading failures)
  const wasHalfOpenBefore = geminiBreaker.state === 'HALF_OPEN';
  if (geminiBreaker.isOpen()) {
    res.setHeader('Retry-After', '15');
    return res.status(503).json({
      error: {
        code: 'circuit_open',
        message: 'Upstream provider is temporarily unavailable. Circuit breaker is OPEN. Please retry later.'
      }
    });
  }

  // If breaker entered HALF_OPEN during isOpen(), this request is the designated probe
  const isProbe = geminiBreaker.state === 'HALF_OPEN' && !wasHalfOpenBefore;
  const abortIfProbe = () => {
    if (isProbe) {
      geminiBreaker.releaseProbe();
    }
  };

  // 2. Validate stream rejection
  if (req.body && req.body.stream === true) {
    abortIfProbe();
    return res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'Streaming (stream: true) is not supported by this gateway'
      }
    });
  }

  // 3. Validate request body schema
  const parsed = chatCompletionSchema.safeParse(req.body);
  if (!parsed.success) {
    abortIfProbe();
    return res.status(400).json({
      error: {
        code: 'invalid_request',
        message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')
      }
    });
  }

  const { messages, temperature } = parsed.data;
  const apiKey = req.apiKey; // Injected by requireVirtualKey middleware

  // 4. Determine routed model and routing reason
  let routedModel;
  let routeReason;
  try {
    const routing = route(req.body, env);
    routedModel = routing.model;
    routeReason = routing.reason;
  } catch (routingErr) {
    abortIfProbe();
    return res.status(routingErr.statusCode || 400).json({
      error: {
        code: routingErr.code || 'invalid_request',
        message: routingErr.message
      }
    });
  }

  // Resolve gateway-owned output tokens budget for the routed model
  const gatewayMaxTokens = resolveOutputTokensLimit(routedModel);

  // 5. Estimate worst-case cost using the ROUTED model and atomically reserve budget.
  const reservedPaise = estimateWorstCaseCostPaise(routedModel, messages, gatewayMaxTokens);
  const reservation = await reserveBudget(apiKey.id, reservedPaise);

  if (!reservation.success) {
    abortIfProbe();
    // Return 402 immediately without inserting a log row to prevent table bloat and high write amplification
    return res.status(402).json({
      error: {
        code: 'budget_exceeded',
        message: 'Key monetary budget exceeded. Please add funds to proceed.'
      }
    });
  }

  let providerStatus = 'ok';
  let errorCode = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let actualCostPaise = 0;
  let responsePayload = null;
  let responseStatusCode = 200;
  let finalModel = routedModel;
  let attemptsCount = 1;
  let activeReservationPaise = reservedPaise;

  try {
    // 5. Call provider through resilience layer (timeout, retry, fallback, top-up)
    const exec = await executeWithResilience({
      keyId: apiKey.id,
      initialModel: routedModel,
      messages,
      max_tokens: gatewayMaxTokens,
      temperature,
      currentReservedPaise: reservedPaise
    });

    finalModel = exec.servingModel;
    attemptsCount = exec.attempts;
    activeReservationPaise = exec.totalReservedPaise;

    if (exec.success && exec.result) {
      geminiBreaker.recordSuccess();
      responsePayload = exec.result;
      responseStatusCode = 200;

      // Extract usage or fallback to estimate if missing from provider
      if (exec.result.usage) {
        tokensIn = exec.result.usage.prompt_tokens ?? estimateInputTokens(messages);
        tokensOut = exec.result.usage.completion_tokens ?? gatewayMaxTokens;
      } else {
        tokensIn = estimateInputTokens(messages);
        tokensOut = gatewayMaxTokens;
      }

      actualCostPaise = calculateCostPaise(finalModel, tokensIn, tokensOut);
    } else {
      providerStatus = exec.isBudgetExceededOnFallback
        ? 'budget_rejected'
        : (exec.errorStatus === 504 ? 'timeout' : 'provider_error');
      errorCode = exec.errorCode || 'UNKNOWN_ERROR';
      responseStatusCode = exec.errorStatus || 502;
      actualCostPaise = 0; // Full refund on failure

      if (exec.errorStatus === 502 || exec.errorStatus === 504) {
        geminiBreaker.recordFailure();
      } else {
        abortIfProbe();
      }

      if (exec.isBudgetExceededOnFallback) {
        responsePayload = {
          error: {
            code: 'budget_exceeded',
            message: 'Insufficient budget to execute fallback model'
          }
        };
      } else if (responseStatusCode === 504) {
        responsePayload = {
          error: {
            code: 'provider_timeout',
            message: 'Upstream provider timed out'
          }
        };
      } else if (responseStatusCode === 400) {
        responsePayload = {
          error: {
            code: 'invalid_request',
            message: 'Upstream provider rejected the request format'
          }
        };
      } else {
        responsePayload = {
          error: {
            code: 'provider_error',
            message: 'Upstream provider returned an error'
          }
        };
      }
    }
  } catch (err) {
    actualCostPaise = 0; // Refund reservation
    providerStatus = err.isTimeout ? 'timeout' : 'provider_error';
    errorCode = err.code || 'UNKNOWN_ERROR';
    responseStatusCode = err.isTimeout ? 504 : 502;
    geminiBreaker.recordFailure();
    responsePayload = {
      error: {
        code: err.isTimeout ? 'provider_timeout' : 'provider_error',
        message: 'Error communicating with upstream provider'
      }
    };
  } finally {
    const latencyMs = Date.now() - startTime;

    // 6. Settle budget atomically in PostgreSQL transaction
    try {
      await settleBudget({
        keyId: apiKey.id,
        reservedPaise: activeReservationPaise,
        actualCostPaise,
        usageLog: {
          requestId,
          provider: env.DEFAULT_PROVIDER,
          model: finalModel,
          routeReason,
          tokensIn,
          tokensOut,
          status: providerStatus,
          attempts: attemptsCount,
          latencyMs,
          errorCode
        }
      });
    } catch (settleErr) {
      req.log?.error({ err: settleErr }, 'Failed to settle budget and insert usage_log');
    }
  }

  // 7. Send HTTP response outside finally block
  res.setHeader('x-gateway-request-id', requestId);
  res.setHeader('x-gateway-model', finalModel);
  res.setHeader('x-gateway-route-reason', routeReason);
  res.setHeader('x-gateway-cost-paise', String(actualCostPaise));

  return res.status(responseStatusCode).json(responsePayload);
}
