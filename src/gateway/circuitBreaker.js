/**
 * Zero-dependency Circuit Breaker implementation for upstream LLM providers.
 * 
 * States:
 * - CLOSED: Normal operation. All requests pass through.
 * - OPEN: Provider degraded/down. Fails fast in 0ms with 503, preserving resources and budget.
 * - HALF_OPEN: Cooldown expired. Allows a single probe request to test provider recovery.
 */

export class CircuitBreaker {
  /**
   * @param {Object} options
   * @param {number} [options.failureThreshold=5] Consecutive transient failures before tripping OPEN
   * @param {number} [options.cooldownMs=15000] Milliseconds to wait before entering HALF_OPEN
   * @param {string} [options.name='provider'] Name for logging/identification
   */
  constructor({ failureThreshold = 5, cooldownMs = 15000, name = 'gemini' } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.name = name;
    
    this.state = 'CLOSED'; // 'CLOSED' | 'OPEN' | 'HALF_OPEN'
    this.consecutiveFailures = 0;
    this.nextAttempt = Date.now();
  }

  /**
   * Check if requests should be blocked immediately.
   * @returns {boolean} true if circuit is OPEN and request should fail fast
   */
  isOpen() {
    if (this.state === 'OPEN') {
      if (Date.now() >= this.nextAttempt) {
        this.state = 'HALF_OPEN';
        return false; // Allow probe request
      }
      return true; // Still open, fail fast
    }
    return false;
  }

  /**
   * Record a successful response from the provider.
   * Closes circuit and resets failure counter.
   */
  recordSuccess() {
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
  }

  /**
   * Record a transient failure (5xx, timeout, network error).
   * Trips circuit to OPEN if threshold reached or if probe failed in HALF_OPEN.
   */
  recordFailure() {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold || this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.cooldownMs;
    }
  }

  /**
   * Manual reset helper (useful for tests)
   */
  reset() {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.nextAttempt = Date.now();
  }
}

// Global circuit breaker instance for Gemini upstream
export const geminiBreaker = new CircuitBreaker({
  failureThreshold: 5,
  cooldownMs: 15000,
  name: 'gemini'
});
