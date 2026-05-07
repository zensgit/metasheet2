import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authServiceMocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

vi.mock('../../src/auth/AuthService', () => ({
  authService: authServiceMocks,
}))

describe('PLM disable switch', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('PRODUCT_MODE', 'platform')
    vi.stubEnv('ENABLE_PLM', '0')
    authServiceMocks.verifyToken.mockReset()
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      name: 'Admin',
      role: 'admin',
      permissions: ['attendance:admin'],
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns 404 for plm workbench routes when plm is disabled', async () => {
    const { MetaSheetServer } = await import('../../src/index')
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1' })
    const app = (server as unknown as { app: Parameters<typeof request>[0] }).app

    const response = await request(app)
      .get('/api/plm-workbench/views/team?kind=documents')
      .set('Authorization', 'Bearer live-token')

    expect(response.status).toBe(404)
    expect(response.body?.error?.code).toBe('FEATURE_DISABLED')
  })

  it('returns 404 for plm federation routes when plm is disabled', async () => {
    const { MetaSheetServer } = await import('../../src/index')
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1' })
    const app = (server as unknown as { app: Parameters<typeof request>[0] }).app

    const response = await request(app)
      .post('/api/federation/plm/query')
      .set('Authorization', 'Bearer live-token')
      .send({ operation: 'searchProducts' })

    expect(response.status).toBe(404)
    expect(response.body?.error?.code).toBe('FEATURE_DISABLED')
  })

  it('returns 404 for plm import routes when plm is disabled', async () => {
    const { MetaSheetServer } = await import('../../src/index')
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1' })
    const app = (server as unknown as { app: Parameters<typeof request>[0] }).app

    const response = await request(app)
      .post('/api/federation/import/plm')
      .set('Authorization', 'Bearer live-token')
      .send({ productId: 'prod-1', includeDocuments: true, includeBOM: true })

    expect(response.status).toBe(404)
    expect(response.body?.error?.code).toBe('FEATURE_DISABLED')
  })
})
