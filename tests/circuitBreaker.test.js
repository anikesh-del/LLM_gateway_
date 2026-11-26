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

  it('does not get stuck in HALF_OPEN when releaseProbe() is called on client error (400/402)', async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('OPEN');

    // Wait for cooldown
    await new Promise(r => setTimeout(r, 120));

    // First request is granted the probe
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.state).toBe('HALF_OPEN');

    // Concurrent requests are blocked while probe is in flight
    expect(breaker.isOpen()).toBe(true);

    // Probe request is rejected caller-side (e.g. 400 validation or 402 budget exceeded)
    breaker.releaseProbe();

    // Circuit immediately allows the next caller to probe rather than locking in HALF_OPEN forever
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.state).toBe('HALF_OPEN');
  });

  it('expires HALF_OPEN after cooldown if probe was abandoned without recording', async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('OPEN');

    await new Promise(r => setTimeout(r, 120));
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.state).toBe('HALF_OPEN');

    // Probe leaked or died without calling recordSuccess, recordFailure, or releaseProbe
    // Wait for cooldown duration to expire
    await new Promise(r => setTimeout(r, 120));

    // The breaker must NOT remain stuck in HALF_OPEN returning true forever; it allows a fresh probe
    expect(breaker.isOpen()).toBe(false);
  });
});
