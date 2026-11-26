import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import { app } from '../src/server.js';
import { pool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

describe('Phase 5 Resilience Suite (Mock Provider)', () => {
  let mockServer;
  let mockPort;
  let testKey = '';
  let testKeyId = '';
  let callCounts = {};

  beforeAll(async () => {
    // Setup Mock Server simulating errors, timeouts, retries and fallbacks
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        const prompt = parsed.messages?.[0]?.content || '';
        const model = parsed.model;

        callCounts[prompt] = (callCounts[prompt] || 0) + 1;

        if (prompt === 'RETRY_THEN_SUCCEED') {
          if (callCounts[prompt] === 1) {
            // First attempt: 500 error
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Transient 500' } }));
            return;
          }
          // Second attempt: succeeds
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Recovered after retry!' } }],
            usage: { prompt_tokens: 10, completion_tokens: 10 }
          }));
          return;
        }

        if (prompt === 'FALLBACK_TO_CAPABLE') {
          if (model === env.MODEL_CHEAP) {
            // Cheap model fails both tries with 503
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Cheap model overloaded' } }));
            return;
          }
          if (model === env.MODEL_CAPABLE) {
            // Fallback capable model succeeds
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              choices: [{ message: { role: 'assistant', content: 'Served by capable fallback!' } }],
              usage: { prompt_tokens: 10, completion_tokens: 20 }
            }));
            return;
          }
        }

        if (prompt === 'CALLER_400_ERROR') {
          // Caller bad request -> non-retryable
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid parameter from caller' } }));
          return;
        }

        if (prompt === 'RATE_LIMIT_429_RETRY') {
          if (callCounts[prompt] === 1) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Recovered after 429 retry!' } }],
            usage: { prompt_tokens: 10, completion_tokens: 10 }
          }));
          return;
        }

        if (prompt === 'TRIGGER_TIMEOUT') {
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Too late' } }] }));
          }, 250);
          return;
        }

        if (prompt === 'FALLBACK_TOPUP_FAIL') {
          // Cheap tier fails so gateway attempts fallback to capable tier
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Cheap tier unavailable' } }));
          return;
        }

        if (prompt === 'MISSING_USAGE') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Response without usage metadata' } }]
          }));
          return;
        }

        if (prompt === 'ALL_ATTEMPTS_FAIL') {
          // Both initial and fallback fail with 502
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Provider total collapse' } }));
          return;
        }

        // Default response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Default response' } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 }
        }));
      });
    });

    await new Promise(resolve => mockServer.listen(0, resolve));
    mockPort = mockServer.address().port;
    env.GEMINI_BASE_URL = `http://127.0.0.1:${mockPort}/`;

    // Create test key with ample budget
    const createRes = await request(app)
      .post('/admin/keys')
      .set('Authorization', `Bearer ${env.ADMIN_SECRET}`)
      .send({ name: 'test_resilience_key', budget_paise: 100000 });

    testKey = createRes.body.key;
    testKeyId = createRes.body.id;
  });

  afterAll(async () => {
    if (mockServer) {
      await new Promise(resolve => mockServer.close(resolve));
    }
    await pool.query("DELETE FROM usage_logs WHERE api_key_id IN (SELECT id FROM api_keys WHERE name LIKE 'test_resilience_%')");
    await pool.query("DELETE FROM api_keys WHERE name LIKE 'test_resilience_%'");
  });

  it('retries once on 5xx and succeeds on 2nd attempt', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${testKey}`)
      .send({
        model: env.MODEL_CHEAP,
        messages: [{ role: 'user', content: 'RETRY_THEN_SUCCEED' }]
      });

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('Recovered after retry!');
    expect(callCounts['RETRY_THEN_SUCCEED']).toBe(2);
  });

  it('never retries caller 400 error (fails immediately without retry)', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${testKey}`)
      .send({
        model: env.MODEL_CHEAP,
        messages: [{ role: 'user', content: 'CALLER_400_ERROR' }]
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(callCounts['CALLER_400_ERROR']).toBe(1); // Exactly 1 attempt
  });

  it('falls back to capable model when cheap model exhausts retries', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${testKey}`)
      .send({
        model: env.MODEL_CHEAP,
        messages: [{ role: 'user', content: 'FALLBACK_TO_CAPABLE' }]
      });

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('Served by capable fallback!');
    expect(res.headers['x-gateway-model']).toBe(env.MODEL_CAPABLE);

    // Verify usage log records the model that actually served it
    const reqId = res.headers['x-gateway-request-id'];
    const logCheck = await pool.query('SELECT * FROM usage_logs WHERE request_id = $1', [reqId]);
    expect(logCheck.rows[0].model).toBe(env.MODEL_CAPABLE);
    expect(logCheck.rows[0].status).toBe('ok');
  });

  it('returns clean 502 and refunds reservation when all attempts fail', async () => {
    const beforeKey = await pool.query('SELECT spent_paise FROM api_keys WHERE id = $1', [testKeyId]);
    const initialSpent = Number(beforeKey.rows[0].spent_paise);

    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${testKey}`)
      .send({
        model: env.MODEL_CHEAP,
        messages: [{ role: 'user', content: 'ALL_ATTEMPTS_FAIL' }]
      });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('provider_error');

    // Verify reservation was fully refunded
    const afterKey = await pool.query('SELECT spent_paise FROM api_keys WHERE id = $1', [testKeyId]);
    expect(Number(afterKey.rows[0].spent_paise)).toBe(initialSpent);

    // Verify error row in usage_logs
    const reqId = res.headers['x-gateway-request-id'];
    const logCheck = await pool.query('SELECT * FROM usage_logs WHERE request_id = $1', [reqId]);
    expect(logCheck.rows[0].status).toBe('provider_error');
    expect(Number(logCheck.rows[0].cost_paise)).toBe(0);
  });

  it('retries on upstream 429 and succeeds on retry', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${testKey}`)
      .send({
        model: env.MODEL_CHEAP,
        messages: [{ role: 'user', content: 'RATE_LIMIT_429_RETRY' }]
      });

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('Recovered after 429 retry!');
    expect(callCounts['RATE_LIMIT_429_RETRY']).toBe(2);
  });

  it('maps upstream provider timeout to 504 provider_timeout', async () => {
    const origTimeout = env.PROVIDER_TIMEOUT_MS;
    env.PROVIDER_TIMEOUT_MS = 60; // 60ms timeout

    try {
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${testKey}`)
        .send({
          model: env.MODEL_CAPABLE, // Use capable so it retries capable rather than falling back
          messages: [{ role: 'user', content: 'TRIGGER_TIMEOUT' }]
        });

      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('provider_timeout');
    } finally {
      env.PROVIDER_TIMEOUT_MS = origTimeout;
    }
  });

  it('returns 504 when request deadline is exceeded', async () => {
    const origDeadline = env.REQUEST_DEADLINE_MS;
    env.REQUEST_DEADLINE_MS = 0; // Deadline immediately reached upon invocation

    try {
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${testKey}`)
        .send({
          model: env.MODEL_CHEAP,
          messages: [{ role: 'user', content: 'DEADLINE_PROMPT' }]
        });

      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('provider_timeout');
    } finally {
      env.REQUEST_DEADLINE_MS = origDeadline;
    }
  });

  it('returns 402 budget_exceeded when fallback model top-up exceeds key budget', async () => {
    // Create key with exactly enough budget for cheap model (5 paise), but not capable fallback (~54 paise)
    const createRes = await request(app)
      .post('/admin/keys')
      .set('Authorization', `Bearer ${env.ADMIN_SECRET}`)
      .send({ name: 'test_resilience_fallback_tight', budget_paise: 5 });

    const tightKey = createRes.body.key;
    const tightKeyId = createRes.body.id;

    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${tightKey}`)
      .send({
        model: env.MODEL_CHEAP,
        messages: [{ role: 'user', content: 'FALLBACK_TOPUP_FAIL' }]
      });

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('budget_exceeded');
    expect(res.body.error.message).toContain('fallback model');

    // Verify initial reservation was refunded
    const keyCheck = await pool.query('SELECT spent_paise FROM api_keys WHERE id = $1', [tightKeyId]);
    expect(Number(keyCheck.rows[0].spent_paise)).toBe(0);
  });

  it('uses gateway default estimate for output tokens when usage is missing from provider response', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${testKey}`)
      .send({
        model: env.MODEL_CHEAP,
        messages: [{ role: 'user', content: 'MISSING_USAGE' }]
      });

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('Response without usage metadata');

    const reqId = res.headers['x-gateway-request-id'];
    const logCheck = await pool.query('SELECT * FROM usage_logs WHERE request_id = $1', [reqId]);
    expect(logCheck.rows.length).toBe(1);
    const row = logCheck.rows[0];
    expect(row.status).toBe('ok');
    // tokens_out must be the gateway default (1000 for cheap flash-lite), NOT 0
    expect(row.tokens_out).toBe(1000);
    expect(Number(row.cost_paise)).toBeGreaterThan(0);
  });
});
