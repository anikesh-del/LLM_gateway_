import { describe, it, expect } from 'vitest';
import { route } from '../src/router/route.js';

describe('Phase 6 Router Suite (Table-Driven Heuristics)', () => {
  const config = {
    MODEL_CHEAP: 'gemini-2.5-flash',
    MODEL_CAPABLE: 'gemini-2.5-pro',
    ROUTER_LONG_PROMPT_TOKENS: 1500,
    ROUTER_CAPABLE_MAX_TOKENS: 1024
  };

  it('honors explicit model if provided and not "auto"', () => {
    const res = route({ model: 'gemini-2.5-flash' }, config);
    expect(res.model).toBe('gemini-2.5-flash');
    expect(res.reason).toBe('explicit');
    expect(res.tier).toBe('cheap');

    const res2 = route({ model: 'gemini-2.5-pro' }, config);
    expect(res2.model).toBe('gemini-2.5-pro');
    expect(res2.reason).toBe('explicit');
    expect(res2.tier).toBe('capable');
  });

  it('routes short simple prompt to cheap tier', () => {
    const res = route({
      model: 'auto',
      messages: [{ role: 'user', content: 'What is the capital of India?' }]
    }, config);

    expect(res.model).toBe(config.MODEL_CHEAP);
    expect(res.tier).toBe('cheap');
    expect(res.reason).toBe('short_simple_prompt');
  });

  it('routes long prompts (> 1500 tokens) to capable tier', () => {
    // 1501 tokens ~ 6004 characters
    const longContent = 'A'.repeat(6100);
    const res = route({
      messages: [{ role: 'user', content: longContent }]
    }, config);

    expect(res.model).toBe(config.MODEL_CAPABLE);
    expect(res.tier).toBe('capable');
    expect(res.reason).toBe('long_prompt');
  });

  it('routes large max_tokens (> 1024) to capable tier', () => {
    const res = route({
      messages: [{ role: 'user', content: 'Write a quick summary' }],
      max_tokens: 2048
    }, config);

    expect(res.model).toBe(config.MODEL_CAPABLE);
    expect(res.tier).toBe('capable');
    expect(res.reason).toBe('large_max_tokens');
  });

  it('routes multi-turn conversations (> 6 messages) to capable tier', () => {
    const messages = Array.from({ length: 7 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}`
    }));

    const res = route({ messages }, config);
    expect(res.model).toBe(config.MODEL_CAPABLE);
    expect(res.tier).toBe('capable');
    expect(res.reason).toBe('multi_turn_history');
  });

  it('routes code-like content or markdown fences to capable tier', () => {
    const res = route({
      messages: [{ role: 'user', content: 'Here is my function:\n```javascript\nfunction test() {}\n```' }]
    }, config);

    expect(res.model).toBe(config.MODEL_CAPABLE);
    expect(res.tier).toBe('capable');
    expect(res.reason).toBe('code_detected');
  });

  it('routes reasoning keywords (analyze, debug, prove, step by step, design, compare) to capable tier', () => {
    const keywords = ['analyze', 'debug', 'prove', 'step by step', 'design', 'compare'];

    for (const kw of keywords) {
      const res = route({
        messages: [{ role: 'user', content: `Please ${kw} this problem for me.` }]
      }, config);

      expect(res.model).toBe(config.MODEL_CAPABLE);
      expect(res.tier).toBe('capable');
      expect(res.reason).toContain('reasoning_keyword');
    }
  });
});
