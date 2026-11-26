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
        // Reset nextAttempt into the future to ensure ONLY ONE single probe request
        // passes through while in HALF_OPEN before it trips or closes
        this.nextAttempt = Date.now() + this.cooldownMs;
        return false; // Allow the single probe
      }
      return true; // Still open, fail fast
    }
    if (this.state === 'HALF_OPEN') {
      if (Date.now() >= this.nextAttempt) {
        // Probe timed out or was abandoned without reporting; allow a fresh probe
        this.nextAttempt = Date.now() + this.cooldownMs;
        return false;
      }
      return true; // Already probing; block concurrent callers until probe finishes or cooldown expires
    }
    return false;
  }

  /**
   * Release an in-flight probe if the probe request was rejected caller-side
   * (e.g., 400 validation, 402 budget exceeded) before contacting the upstream provider.
   * Immediately resets to OPEN with expired cooldown so the next incoming request can probe.
   */
  releaseProbe() {
    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.nextAttempt = Date.now();
    }
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
