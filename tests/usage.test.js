import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { pool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

describe('Phase 7 Admin Usage and Test Console Suite', () => {
  let testKeyId = '';

  beforeAll(async () => {
    // 1. Create a key
    const createRes = await request(app)
      .post('/admin/keys')
      .set('Authorization', `Bearer ${env.ADMIN_SECRET}`)
      .send({ name: 'test_usage_key', budget_paise: 50000 });

    testKeyId = createRes.body.id;

    // 2. Insert dummy usage rows for testing
    await pool.query(
      `INSERT INTO usage_logs (
        request_id, api_key_id, provider, model, route_reason,
        tokens_in, tokens_out, cost_paise, status, latency_ms
      ) VALUES 
      ('req_test_1', $1, 'gemini', 'gemini-2.5-flash', 'short_simple_prompt', 10, 50, 15, 'ok', 350),
      ('req_test_2', $1, 'gemini', 'gemini-2.5-pro', 'code_detected', 50, 120, 110, 'ok', 620)`,
      [testKeyId]
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM usage_logs WHERE api_key_id = $1", [testKeyId]);
    await pool.query("DELETE FROM api_keys WHERE id = $1", [testKeyId]);
  });

  it('rejects GET /usage without admin secret with 401', async () => {
    const res = await request(app).get('/usage');
    expect(res.status).toBe(401);
  });

  it('returns aggregated spend and breakdown on GET /usage', async () => {
    const res = await request(app)
      .get('/usage')
      .set('Authorization', `Bearer ${env.ADMIN_SECRET}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
    expect(res.body.summary.total_requests).toBeGreaterThanOrEqual(2);
    expect(Number(res.body.summary.total_spent_paise)).toBeGreaterThanOrEqual(125);
    expect(res.body).toHaveProperty('models');
    expect(res.body).toHaveProperty('recent_logs');
  });

  it('returns specific key usage on GET /usage?key_id=...', async () => {
    const res = await request(app)
      .get(`/usage?key_id=${testKeyId}`)
      .set('Authorization', `Bearer ${env.ADMIN_SECRET}`);

    expect(res.status).toBe(200);
    expect(res.body.key.id).toBe(testKeyId);
    expect(res.body.summary.total_requests).toBe(2);
    expect(res.body.summary.total_spent_paise).toBe(125);
    expect(res.body.summary.total_spent_inr).toBe('1.25');
  });

  it('serves static test console on GET /', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Minimal LLM Gateway Console');
    expect(res.text).toContain('id="adminSecret"');
    expect(res.text).toContain('id="virtualKey"');
  });
});
