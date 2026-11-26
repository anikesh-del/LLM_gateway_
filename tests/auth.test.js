import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { pool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

describe('Phase 2 Keys and Auth Suite', () => {
  let createdKeyId = '';
  let fullVirtualKey = '';

  beforeAll(async () => {
    // Clean test table keys specific to auth suite
    await pool.query("DELETE FROM usage_logs WHERE api_key_id IN (SELECT id FROM api_keys WHERE name LIKE 'test_auth_%')");
    await pool.query("DELETE FROM api_keys WHERE name LIKE 'test_auth_%'");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM usage_logs WHERE api_key_id IN (SELECT id FROM api_keys WHERE name LIKE 'test_auth_%')");
    await pool.query("DELETE FROM api_keys WHERE name LIKE 'test_auth_%'");
  });

  describe('Admin Authentication', () => {
    it('rejects missing admin secret on POST /admin/keys with 401', async () => {
      const res = await request(app)
        .post('/admin/keys')
        .send({ name: 'test_auth_key', budget_paise: 5000 });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
    });

    it('rejects wrong admin secret with 401', async () => {
      const res = await request(app)
        .post('/admin/keys')
        .set('Authorization', 'Bearer wrong_admin_secret')
        .send({ name: 'test_auth_key', budget_paise: 5000 });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
    });

    it('creates virtual key with valid admin secret and returns key once', async () => {
      const res = await request(app)
        .post('/admin/keys')
        .set('Authorization', `Bearer ${env.ADMIN_SECRET}`)
        .send({ name: 'test_auth_client_key', budget_paise: 10000 });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body).toHaveProperty('key');
      expect(res.body.key).toMatch(/^gw_[a-f0-9]{48}$/);
      expect(res.body.budget_paise).toBe(10000);
      expect(res.body.key_prefix).toBe(res.body.key.slice(0, 8));

      createdKeyId = res.body.id;
      fullVirtualKey = res.body.key;

      // Verify DB stores hash, never full plaintext key
      const dbCheck = await pool.query('SELECT key_hash FROM api_keys WHERE id = $1', [createdKeyId]);
      expect(dbCheck.rows[0].key_hash).not.toBe(fullVirtualKey);
      expect(dbCheck.rows[0].key_hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('Virtual Key Authentication', () => {
    it('rejects request with no virtual key with 401', async () => {
      const res = await request(app).get('/v1/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
    });

    it('rejects unknown virtual key with 401', async () => {
      const res = await request(app)
        .get('/v1/me')
        .set('Authorization', 'Bearer gw_000000000000000000000000000000000000000000000000');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
    });

    it('authenticates valid virtual key successfully', async () => {
      const res = await request(app)
        .get('/v1/me')
        .set('Authorization', `Bearer ${fullVirtualKey}`);

      expect(res.status).toBe(200);
      expect(res.body.authenticated).toBe(true);
      expect(res.body.key.id).toBe(createdKeyId);
      expect(res.body.key.budget_paise).toBe(10000);
    });

    it('revokes key and immediately blocks future calls with 401', async () => {
      // Revoke the key
      const revokeRes = await request(app)
        .post(`/admin/keys/${createdKeyId}/revoke`)
        .set('Authorization', `Bearer ${env.ADMIN_SECRET}`);

      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.message).toContain('revoked successfully');

      // Now virtual key must be rejected
      const authRes = await request(app)
        .get('/v1/me')
        .set('Authorization', `Bearer ${fullVirtualKey}`);

      expect(authRes.status).toBe(401);
      expect(authRes.body.error.message).toContain('revoked');
    });

    it('returns 400 when revoking with non-UUID id', async () => {
      const res = await request(app)
        .post('/admin/keys/not-a-valid-uuid/revoke')
        .set('Authorization', `Bearer ${env.ADMIN_SECRET}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
      expect(res.body.error.message).toContain('UUID');
    });
  });
});
