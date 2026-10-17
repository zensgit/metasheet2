import { describe, it, expect, vi, afterEach } from 'vitest'
import { PlmBomReviewService } from '../../src/multitable/plm-bom-review-service'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
afterEach(() => vi.unstubAllEnvs())
describe('BOM review bounded provider and runtime', () => {
  it.each(['false', 'TRUE', '1', ''])(
    'disabled %s constructs inert and rejects before SQL/network',
    async (flag) => {
      vi.stubEnv('PLM_BOM_REVIEW_ENABLED', flag)
      const query = vi.fn(),
        transaction = vi.fn(async (fn) => fn({ query })),
        getDataSource = vi.fn()
      const service = new PlmBomReviewService({
        pool: { query, transaction },
        dataSourceManager: { getDataSource },
      })
      expect(query).not.toHaveBeenCalled()
      await expect(service.bases('owner')).rejects.toMatchObject({
        code: 'PLM_BOM_REVIEW_DISABLED',
      })
      expect(query).not.toHaveBeenCalled()
      expect(getDataSource).not.toHaveBeenCalled()
    },
  )
  it('needs both native runtime gates before schema/data access', async () => {
    vi.stubEnv('PLM_BOM_REVIEW_ENABLED', 'true')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'false')
    const query = vi.fn(),
      service = new PlmBomReviewService({
        pool: { query, transaction: async (fn) => fn({ query }) },
        dataSourceManager: {} as never,
      })
    await expect(service.bases('owner')).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
    expect(query).not.toHaveBeenCalled()
  })
  it('transport rejects implicit credentials, unsafe endpoints and mismatched scope', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    const a = new PLMAdapter(
      { get: vi.fn() } as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    )
    const config = {
      id: 'ds',
      name: 'Y',
      type: 'plm',
      connection: { url: 'https://synthetic.invalid' },
      options: { apiMode: 'yuantus', tenantId: 't', orgId: 'o' },
      credentials: { token: 'synthetic' },
    }
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          entitled: true,
          source: { tenant_id: 'other', org_id: 'o' },
        }),
        { status: 200 },
      ),
    )
    try {
      await expect(
        a.getBomShareContext('P', { ...config, credentials: {} } as never),
      ).rejects.toMatchObject({ response: { status: 403 } })
      for (const url of [
        'http://example.com',
        'https://user:pass@example.com',
        'https://example.com?token=x',
      ])
        await expect(
          a.getBomShareContext('P', {
            ...config,
            connection: { url },
          } as never),
        ).rejects.toThrow()
      expect(fetch).not.toHaveBeenCalled()
      await expect(a.getBomShareContext('P', config as never)).rejects.toThrow()
      expect(fetch).toHaveBeenCalledOnce()
      fetch.mockResolvedValue(new Response('', { status: 401 }))
      await expect(
        a.getBomShareContext('P', config as never),
      ).rejects.toMatchObject({ response: { status: 401 } })
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(fetch.mock.calls[1][1]).toMatchObject({
        redirect: 'error',
        headers: {
          Authorization: 'Bearer synthetic',
          'x-tenant-id': 't',
          'x-org-id': 'o',
        },
      })
    } finally {
      fetch.mockRestore()
    }
  })
})

describe('BOM native return provenance', () => {
  it.each(['false', 'TRUE', '1', ''])('flag %s omits navigation before SQL', async (flag) => {
    const { loadPlmBomSourceNavigation } = await import('../../src/multitable/plm-bom-source-navigation')
    vi.stubEnv('PLM_BOM_REVIEW_ENABLED', flag)
    const query = vi.fn()
    expect(await loadPlmBomSourceNavigation(query, 'owner', 'sheet')).toBeUndefined()
    expect(query).not.toHaveBeenCalled()
  })
  it('preserves the original persisted source fingerprint including opaque encrypted credential bytes', async () => {
    const { bomReviewSourceFingerprint } = await import('../../src/multitable/plm-bom-source-navigation')
    const row = {
      id: 'old-source', type: 'plm',
      config: { credentials: { token: 'encrypted:opaque' }, connection: { url: 'https://fixture.invalid' }, options: {} },
      owner_id: 'owner', is_active: true, workspace_id: null, tenant_id: null, scope_kind: 'user',
    }
    // Fixed digest of the pre-extraction source() persisted-key contract; not a new binding format.
    expect(bomReviewSourceFingerprint(row)).toBe('784e7940bdce1d6970eb0a6aa91e57457bd8dcb88b31919e275784588a0602dc')
    for (const [key, value] of Object.entries({ id: 'other', type: 'sql', owner_id: 'other', is_active: false, workspace_id: 'w', tenant_id: 't', scope_kind: 'org', config: {} })) {
      expect(bomReviewSourceFingerprint({ ...row, [key]: value })).not.toBe(bomReviewSourceFingerprint(row))
    }
    expect(bomReviewSourceFingerprint({ ...row, name: 'Renamed display label' } as typeof row)).toBe(bomReviewSourceFingerprint(row))
  })
  it('missing or inactive actors never reach source metadata and query errors omit the optional hint', async () => {
    const { loadPlmBomSourceNavigation } = await import('../../src/multitable/plm-bom-source-navigation')
    vi.stubEnv('PLM_BOM_REVIEW_ENABLED', 'true')
    for (const rows of [[], [{ is_active: false, role: 'admin' }]]) {
      const query = vi.fn(async () => ({ rows }))
      expect(await loadPlmBomSourceNavigation(query, 'owner', 'sheet')).toBeUndefined()
      expect(query).toHaveBeenCalledOnce()
    }
    const query = vi.fn(async () => { throw new Error('unavailable') })
    expect(await loadPlmBomSourceNavigation(query, 'owner', 'sheet')).toBeUndefined()
  })
})
