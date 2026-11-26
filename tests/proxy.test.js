import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import { app } from '../src/server.js';
import { pool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { calculateCostPaise, estimateInputTokens, estimateWorstCaseCostPaise } from '../src/budget/estimate.js';

describe('Phase 3 Proxy and Logging Suite', () => {
  let mockServer;
  let mockServerPort;
  let testKey = '';
  let testKeyId = '';

  beforeAll(async () => {
    // 1. Setup mock upstream provider HTTP server
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};

        // Simulate upstream error
        if (parsed.messages?.[0]?.content === 'TRIGGER_500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Internal provider explosion' } }));
          return;
        }

        // Standard OpenAI-compatible response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-mock-123',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: parsed.model || 'gemini-2.5-flash',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hello from mock LLM!' },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 15,
            completion_tokens: 25,
            total_tokens: 40
          }
        }));
      });
    });

    await new Promise(resolve => mockServer.listen(0, resolve));
    mockServerPort = mockServer.address().port;

    // Temporarily point GEMINI_BASE_URL to mock server
    env.GEMINI_BASE_URL = `http://127.0.0.1:${mockServerPort}/`;

    // 2. Create test virtual key
    const res = await request(app)
      .post('/admin/keys')
      .set('Authorization', `Bearer ${env.ADMIN_SECRET}`)
      .send({ name: 'test_proxy_key', budget_paise: 50000 });

    testKey = res.body.key;
    testKeyId = res.body.id;
  });

  afterAll(async () => {
    if (mockServer) {
      await new Promise(resolve => mockServer.close(resolve));
    }
    await pool.query("DELETE FROM usage_logs WHERE api_key_id = $1", [testKeyId]);
    await pool.query("DELETE FROM api_keys WHERE id = $1", [testKeyId]);
  });

  describe('Cost Estimation Logic', () => {
    it('estimates tokens based on characters (ceil(chars / 4))', () => {
      const messages = [{ role: 'user', content: 'Hello world! 1234' }]; // 17 chars -> ceil(17/4) = 5
      expect(estimateInputTokens(messages)).toBe(5);
    });

    it('calculates integer paise correctly', () => {
      // gemini-3.5-flash: ₹25.80/1M in, ₹215.00/1M out.
      // 1000 in (₹0.02580) + 1000 out (₹0.21500) = ₹0.24080 = 24.08 paise -> ceil = 25 paise
      const paise = calculateCostPaise('gemini-3.5-flash', 1000, 1000);
      expect(paise).toBe(25);
    });

    it('bounds worst-case cost by max_tokens', () => {
      const messages = [{ role: 'user', content: 'Test' }];
      const worstCase = estimateWorstCaseCostPaise('gemini-3.5-flash', messages, 500);
      expect(worstCase).toBeGreaterThan(0);
      expect(Number.isInteger(worstCase)).toBe(true);
    });
  });

  describe('Proxy POST /v1/chat/completions', () => {
    it('rejects stream: true with 400', async () => {
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${testKey}`)
        .send({
          model: 'gemini-3.5-flash',
          messages: [{ role: 'user', content: 'Hi' }],
          stream: true
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
      expect(res.body.error.message).toContain('Streaming');
    });

    it('proxies successful chat completion and logs usage to PostgreSQL', async () => {
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${testKey}`)
        .send({
          model: 'gemini-3.5-flash',
          messages: [{ role: 'user', content: 'Hello mock' }]
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('choices');
      expect(res.body.choices[0].message.content).toBe('Hello from mock LLM!');
      expect(res.headers['x-gateway-request-id']).toMatch(/^req_/);
      expect(res.headers['x-gateway-model']).toBe('gemini-3.5-flash');
      expect(res.headers['x-gateway-route-reason']).toBe('explicit');
      expect(res.headers).toHaveProperty('x-gateway-cost-paise');
      expect(Number(res.headers['x-gateway-cost-paise'])).toBeGreaterThanOrEqual(1);

      // Verify usage log record was inserted in Postgres
      const reqId = res.headers['x-gateway-request-id'];
      const logCheck = await pool.query('SELECT * FROM usage_logs WHERE request_id = $1', [reqId]);
      expect(logCheck.rows.length).toBe(1);
      const row = logCheck.rows[0];
      expect(row.status).toBe('ok');
      expect(row.tokens_in).toBe(15);
      expect(row.tokens_out).toBe(25);
      expect(Number(row.cost_paise)).toBeGreaterThanOrEqual(1);
    });

    it('handles provider 500 without leaking raw provider body', async () => {
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${testKey}`)
        .send({
          model: 'gemini-3.5-flash',
          messages: [{ role: 'user', content: 'TRIGGER_500' }]
        });

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('provider_error');
      // Must NOT leak "Internal provider explosion"
      expect(JSON.stringify(res.body)).not.toContain('Internal provider explosion');

      // Verify failed log status in database
      const reqId = res.headers['x-gateway-request-id'];
      const logCheck = await pool.query('SELECT * FROM usage_logs WHERE request_id = $1', [reqId]);
      expect(logCheck.rows[0].status).toBe('provider_error');
    });
  });
});
