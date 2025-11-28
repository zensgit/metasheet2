import request from 'supertest';
import express from 'express';
import { setupServer } from '../../index';

describe('Production Guards', () => {
  let app: express.Express;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_UNSAFE_ADMIN = 'false';
    process.env.ENABLE_FALLBACK_TEST = 'false';
    app = setupServer?.() || express();
  });

  it('hides fallback test route in production when disabled', async () => {
    const res = await request(app)
      .post('/internal/test/fallback')
      .send({ mode: 'http_error' });
    expect([404, 403]).toContain(res.status);
  });
});

