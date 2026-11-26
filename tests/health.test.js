import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';

describe('Phase 1 Foundation: Health Check', () => {
  it('GET /health returns healthy status when DB is connected', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'healthy');
    expect(res.body).toHaveProperty('database', 'connected');
  });

  it('GET /non-existent returns standard 404 error envelope', async () => {
    const res = await request(app).get('/non-existent');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'not_found',
        message: 'Route GET /non-existent not found'
      }
    });
  });
});
