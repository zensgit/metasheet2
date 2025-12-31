import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestApp, TestRequest } from '../utils/test-server'
import { federationRouter } from '../../src/routes/federation'
import { IPLMAdapter, IAthenaAdapter } from '../../src/di/identifiers'

vi.mock('../../src/rbac/service', () => ({
  userHasPermission: vi.fn().mockResolvedValue(true),
  isAdmin: vi.fn().mockResolvedValue(true),
  listUserPermissions: vi.fn().mockResolvedValue(['federation:read']),
}))

describe('Federation PLM (Yuantus) product detail', () => {
  const prevRbacBypass = process.env.RBAC_BYPASS

  beforeEach(() => {
    process.env.RBAC_BYPASS = 'true'
  })

  afterEach(() => {
    if (prevRbacBypass === undefined) {
      delete process.env.RBAC_BYPASS
    } else {
      process.env.RBAC_BYPASS = prevRbacBypass
    }
  })

  it('passes itemType to adapter and maps product response', async () => {
    const calls: Array<{ id: string; itemType?: string }> = []
    const plmAdapter = {
      isConnected: () => true,
      connect: vi.fn().mockResolvedValue(undefined),
      getProductById: vi.fn(async (id: string, options?: { itemType?: string }) => {
        calls.push({ id, itemType: options?.itemType })
        return {
          id,
          name: 'Test Assembly',
          code: 'ASM-001',
          version: 'A',
          status: 'Draft',
          description: 'Assembly description',
          itemType: 'Assembly',
          properties: { item_number: 'ASM-001', material: 'Al' },
          created_at: '2025-01-01T00:00:00.000Z',
          updated_at: '2025-01-01T00:00:00.000Z',
        }
      }),
    }

    const injector = {
      get: (token: unknown) => {
        if (token === IPLMAdapter) return plmAdapter
        if (token === IAthenaAdapter) return null
        return null
      },
    }

    const app = createTestApp(true)
    app.use(federationRouter(injector as any))
    const request = new TestRequest(app)

    const res = await request.get('/api/federation/plm/products/abc123?itemType=Assembly')

    expect(res.status).toBe(200)
    expect(res.body?.ok).toBe(true)
    expect(calls).toEqual([{ id: 'abc123', itemType: 'Assembly' }])
    expect(res.body?.data?.partNumber).toBe('ASM-001')
    expect(res.body?.data?.description).toBe('Assembly description')
    expect(res.body?.data?.updatedAt).toBe('2025-01-01T00:00:00.000Z')
    expect(res.body?.data?.code).toBe('ASM-001')
    expect(res.body?.data?.version).toBe('A')
    expect(res.body?.data?.itemType).toBe('Assembly')
    expect(res.body?.data?.properties).toEqual({ item_number: 'ASM-001', material: 'Al' })
  })
})
