import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker } from '../src/gateway/circuitBreaker.js';

describe('Circuit Breaker Pattern Suite', () => {
  let breaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 100, // 100ms for fast testing
      name: 'test_breaker'
    });
  });

  it('starts in CLOSED state and allows requests', () => {
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.isOpen()).toBe(false);
  });

  it('trips OPEN after reaching consecutive failure threshold', () => {
    breaker.recordFailure();
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.isOpen()).toBe(false);

    breaker.recordFailure();
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.isOpen()).toBe(false);

    // 3rd failure trips the breaker
    breaker.recordFailure();
    expect(breaker.state).toBe('OPEN');
    expect(breaker.isOpen()).toBe(true);
  });

  it('fails fast while in OPEN state without calling provider', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.isOpen()).toBe(true);
    expect(breaker.consecutiveFailures).toBe(3);
  });

  it('transitions from OPEN to HALF_OPEN after cooldown period', async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);

    // Wait for cooldown (100ms)
    await new Promise(r => setTimeout(r, 120));

    // Next request checks if open: transitions to HALF_OPEN and allows probe
    const blocked = breaker.isOpen();
    expect(blocked).toBe(false);
    expect(breaker.state).toBe('HALF_OPEN');
  });

  it('re-opens circuit if HALF_OPEN probe request fails', async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    await new Promise(r => setTimeout(r, 120));
    breaker.isOpen(); // Enters HALF_OPEN

    // Probe fails
    breaker.recordFailure();
    expect(breaker.state).toBe('OPEN');
    expect(breaker.isOpen()).toBe(true);
  });

  it('closes circuit completely if HALF_OPEN probe request succeeds', async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    await new Promise(r => setTimeout(r, 120));
    breaker.isOpen(); // Enters HALF_OPEN

    // Probe succeeds
    breaker.recordSuccess();
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.consecutiveFailures).toBe(0);
    expect(breaker.isOpen()).toBe(false);
  });
});
