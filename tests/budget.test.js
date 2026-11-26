import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import { app } from '../src/server.js';
import { pool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { estimateWorstCaseCostPaise } from '../src/budget/estimate.js';

describe('Phase 4 Budget Enforcement & Concurrency Suite', () => {
  let mockServer;
  let mockPort;

  beforeAll(async () => {
    // 1. Setup mock upstream provider server
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        // Small delay to simulate processing and induce concurrency window
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-mock-budget',
            choices: [{ message: { role: 'assistant', content: 'Mock response' } }],
            usage: { prompt_tokens: 10, completion_tokens: 20 }
          }));
        }, 80);
      });
    });

    await new Promise(resolve => mockServer.listen(0, resolve));
    mockPort = mockServer.address().port;
    env.GEMINI_BASE_URL = `http://127.0.0.1:${mockPort}/`;
  });

  afterAll(async () => {
    if (mockServer) {
      await new Promise(resolve => mockServer.close(resolve));
    }
    await pool.query("DELETE FROM usage_logs WHERE api_key_id IN (SELECT id FROM api_keys WHERE name LIKE 'test_budget_%')");
    await pool.query("DELETE FROM api_keys WHERE name LIKE 'test_budget_%'");
  });

  it('blocks request with 402 budget_exceeded when key has zero balance', async () => {
    // Create key with 0 paise budget
    const createRes = await request(app)
      .post('/admin/keys')
      .set('Authorization', `Bearer ${env.ADMIN_SECRET}`)
      .send({ name: 'test_budget_zero', budget_paise: 1 });

    const key = createRes.body.key;
    const keyId = createRes.body.id;

    // First exhaust the key by setting spent = budget
    await pool.query('UPDATE api_keys SET spent_paise = 1 WHERE id = $1', [keyId]);

    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${key}`)
      .send({
        model: 'gemini-3.5-flash-lite',
        messages: [{ role: 'user', content: 'Should fail with 402' }]
      });

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('budget_exceeded');

    // Verify usage log is NOT inserted on 402 rejection
    const log = await pool.query('SELECT * FROM usage_logs WHERE api_key_id = $1', [keyId]);
    expect(log.rows.length).toBe(0);
  });

  it('concurrency test: exactly 1 request succeeds when key has budget for exactly 1 request', async () => {
    const messages = [{ role: 'user', content: 'Short prompt' }];
    const model = 'gemini-3.5-flash-lite';
    const singleReqWorstCase = estimateWorstCaseCostPaise(model, messages);

    // Create key with budget for EXACTLY 1 request
    const createRes = await request(app)
      .post('/admin/keys')
      .set('Authorization', `Bearer ${env.ADMIN_SECRET}`)
      .send({ name: 'test_budget_concurrency', budget_paise: singleReqWorstCase });

    const key = createRes.body.key;
    const keyId = createRes.body.id;

    // Fire 5 concurrent requests simultaneously
    const requests = Array.from({ length: 5 }).map(() =>
      request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${key}`)
        .send({
          model,
          messages
        })
    );

    const responses = await Promise.all(requests);

    const successes = responses.filter(r => r.status === 200);
    const budgetRejections = responses.filter(r => r.status === 402);

    // Exactly 1 succeeds, other 4 are 402
    expect(successes.length).toBe(1);
    expect(budgetRejections.length).toBe(4);

    // Verify DB state: spent_paise MUST NEVER exceed budget_paise
    const keyRow = await pool.query('SELECT spent_paise, budget_paise FROM api_keys WHERE id = $1', [keyId]);
    const { spent_paise, budget_paise } = keyRow.rows[0];

    expect(Number(spent_paise)).toBeLessThanOrEqual(Number(budget_paise));
  });
});
