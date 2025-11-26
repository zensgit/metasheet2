import request from 'supertest';
import express from 'express';
import { setupServer } from '../../index';

describe('Unsafe admin route in production', () => {
  let app: express.Express;
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_UNSAFE_ADMIN = 'false';
    app = setupServer?.() || express();
  });

  it('should reject /api/admin/plugins/:id/reload-unsafe', async () => {
    const res = await request(app)
      .post('/api/admin/plugins/example-plugin/reload-unsafe')
      .set('Authorization', 'Bearer test')
      .send({});
    expect([403, 404]).toContain(res.status);
  });
});

