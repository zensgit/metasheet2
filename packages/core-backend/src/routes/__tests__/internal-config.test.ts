import request from 'supertest';
import express from 'express';
import { setupServer } from '../../index';

describe('/internal/config sanitization', () => {
  let app: express.Express;
  beforeAll(() => {
    app = setupServer?.() || express();
    process.env.JWT_SECRET = 'dev-secret';
  });
  it('does not leak JWT_SECRET', async () => {
    const res = await request(app).get('/internal/config');
    expect(res.status).toBeLessThan(500);
    expect(JSON.stringify(res.body || res.text)).not.toContain('JWT_SECRET');
  });
});

