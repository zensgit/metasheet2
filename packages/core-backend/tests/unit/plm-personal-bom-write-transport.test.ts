import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const grant = `yuw_${'a'.repeat(32)}_${'b'.repeat(43)}`
const shared = 'shared-account-token'
const authority = { origin: 'https://synthetic.invalid', tenantId: 'yt-b', orgId: 'org-1' }
const persisted = {
  type: 'plm',
  connection: { url: 'https://synthetic.invalid', headers: { 'x-tenant-id': 'yt-b', 'x-org-id': 'org-1' } },
  options: { apiMode: 'yuantus', tenantId: 'yt-b', orgId: 'org-1' },
}

function adapter() {
  return new PLMAdapter({ get: async () => undefined } as never, logger as never, {
    id: 'source-1',
    name: 'source-1',
    type: 'plm',
    connection: {
      // Cached adapter path stays non-root. Personal transport must ignore it.
      url: 'https://synthetic.invalid/prefix',
      headers: {
        'x-tenant-id': 'yt-b',
        'x-org-id': 'org-1',
        Authorization: `Bearer ${shared}`,
        'X-Api-Key': 'shared-key',
      },
    },
    options: { apiMode: 'yuantus', tenantId: 'yt-b', orgId: 'org-1' },
    credentials: { token: shared, username: 'service', password: 'service-secret' },
  } as never)
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('personal BOM write transport', () => {
  it('uses the existing grants page hash and a direct personal bearer', async () => {
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const fetch = vi.fn().mockResolvedValue(new Response('{"schema":"yuantus.plm-bom-write-binding.v1"}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const client = adapter()
    expect(client.personalBomWriteManagementUrl(persisted)).toBe(
      'https://synthetic.invalid/personal-approval-grants#bom-write',
    )
    await client.personalBomWriteRequest('verify', grant, 'conn-1', authority)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe('https://synthetic.invalid/api/v1/plm-bom-write-grant/verify')
    expect(init.redirect).toBe('error')
    expect(init.headers).toEqual({
      Authorization: `Bearer ${grant}`,
      'Content-Type': 'application/json',
      'x-tenant-id': 'yt-b',
      'x-org-id': 'org-1',
    })
    expect(JSON.stringify(init)).not.toContain(shared)
    expect(JSON.stringify(init)).not.toContain('shared-key')
    expect(JSON.parse(init.body)).toEqual({ connection_id: 'conn-1' })
  })

  it('sends line and eco-intent on the admitted paths only', async () => {
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const fetch = vi.fn().mockImplementation(async (url: URL) => {
      const path = String(url)
      if (path.endsWith('/grant')) return new Response(null, { status: 204 })
      if (path.endsWith('/eco-intent')) {
        return new Response(
          JSON.stringify({
            eco_id: 'eco-1',
            state: 'open',
            attached: false,
            source_version_id: 'v1',
            target_version_id: null,
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ ok: true, bom_line_id: 'line-1' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const client = adapter()
    const key = 'a'.repeat(64)
    await client.personalBomWriteRequest(
      'line',
      grant,
      'conn-1',
      authority,
      { quantity: 2, token: grant, nested: { password: 'no' } },
      { partId: 'part-1', bomLineId: 'line-1', idempotencyKey: key, ifMatch: '"etag-1"' },
    )
    await client.personalBomWriteRequest('eco-intent', grant, 'conn-1', authority, undefined, {
      partId: 'part-1',
      idempotencyKey: key,
    })
    await client.personalBomWriteRequest('revoke', grant, 'conn-1', authority)
    const paths = fetch.mock.calls.map(([url]) => String(url))
    expect(paths).toEqual([
      'https://synthetic.invalid/api/v1/bom/multitable/part-1/lines/line-1',
      'https://synthetic.invalid/api/v1/bom/multitable/part-1/eco-intent',
      'https://synthetic.invalid/api/v1/plm-bom-write-grant/grant',
    ])
    expect(fetch.mock.calls[0][1].method).toBe('PATCH')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ quantity: 2 })
    expect(fetch.mock.calls[0][1].headers['Idempotency-Key']).toBe(key)
    expect(fetch.mock.calls[0][1].headers['If-Match']).toBe('"etag-1"')
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${grant}`)
    expect(fetch.mock.calls[1][1].method).toBe('POST')
    expect(fetch.mock.calls[1][1].body).toBeUndefined()
    expect(fetch.mock.calls[2][1].method).toBe('DELETE')
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(shared)
  })

  it('preserves a structured native conflict once and drops secret fields', async () => {
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: {
            code: 'lifecycle_locked',
            message: 'Item is locked',
            state: 'Released',
            eco_required: true,
            token: grant,
          },
        }),
        { status: 409 },
      ),
    )
    vi.stubGlobal('fetch', fetch)
    const error = await adapter().personalBomWriteRequest('verify', grant, 'conn-1', authority).then(
      () => {
        throw new Error('expected conflict')
      },
      (caught: unknown) => caught as { status: number; code: string; detail: Record<string, unknown> },
    )
    expect(error.status).toBe(409)
    expect(error.code).toBe('PLM_BOM_WRITE_CONFLICT')
    expect(error.detail).toEqual({
      code: 'lifecycle_locked',
      message: 'Item is locked',
      state: 'Released',
      eco_required: true,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('posts a UTF-8 connection id and still revokes when the flag is off', async () => {
    const fetch = vi.fn().mockImplementation(async (url: URL) => {
      if (String(url).endsWith('/grant')) return new Response(null, { status: 204 })
      return new Response('{"schema":"yuantus.plm-bom-write-binding.v1"}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const client = adapter()
    await client.personalBomWriteRequest('verify', grant, '连接-甲', authority)
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ connection_id: '连接-甲' })
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${grant}`)
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'false')
    await expect(
      client.personalBomWriteRequest('line', grant, '连接-甲', authority, { quantity: 1 }, {
        partId: 'part-1',
        bomLineId: 'line-1',
        idempotencyKey: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_DISABLED' })
    await expect(client.personalBomWriteRequest('verify', grant, '连接-甲', authority)).rejects.toMatchObject({
      code: 'PLM_BOM_WRITE_DISABLED',
    })
    const yua = `yua_${'a'.repeat(32)}_${'b'.repeat(43)}`
    await expect(client.personalBomWriteRequest('revoke', yua, '连接-甲', authority)).rejects.toMatchObject({
      code: 'PLM_BOM_WRITE_FORBIDDEN',
    })
    await client.personalBomWriteRequest('revoke', grant, '连接-甲', authority)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1][1].method).toBe('DELETE')
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${grant}`)
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(shared)
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('shared-key')
  })

  it('sends the native UTF-8 line patch on encoded opaque segments', async () => {
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const partId = '部件-甲'
    const bomLineId = '行-甲'
    const connectionId = '连接-甲'
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, bom_line_id: bomLineId }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetch)
    const result = await adapter().personalBomWriteRequest(
      'line',
      grant,
      connectionId,
      authority,
      { quantity: 2 },
      { partId, bomLineId, idempotencyKey: 'a'.repeat(64) },
    )
    expect(result).toEqual({ ok: true, bom_line_id: bomLineId })
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe(
      `https://synthetic.invalid/api/v1/bom/multitable/${encodeURIComponent(partId)}/lines/${encodeURIComponent(bomLineId)}`,
    )
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ quantity: 2 })
    expect(init.headers.Authorization).toBe(`Bearer ${grant}`)
    expect(JSON.stringify(init)).not.toContain(shared)
  })

  it('sends a 140-character native item id without the header length cap', async () => {
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const partId = 'p'.repeat(140)
    const bomLineId = 'l'.repeat(140)
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, bom_line_id: bomLineId }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetch)
    const result = await adapter().personalBomWriteRequest(
      'line',
      grant,
      'conn-1',
      authority,
      { quantity: 2 },
      { partId, bomLineId, idempotencyKey: 'a'.repeat(64) },
    )
    expect(result).toEqual({ ok: true, bom_line_id: bomLineId })
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe(`https://synthetic.invalid/api/v1/bom/multitable/${partId}/lines/${bomLineId}`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ quantity: 2 })
  })

  it('does not fetch for yua, flag off, or the approval flag alone', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'true')
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'false')
    const yua = `yua_${'a'.repeat(32)}_${'b'.repeat(43)}`
    await expect(adapter().personalBomWriteRequest('verify', yua, 'conn-1', authority)).rejects.toMatchObject({
      code: 'PLM_BOM_WRITE_DISABLED',
    })
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    await expect(adapter().personalBomWriteRequest('verify', yua, 'conn-1', authority)).rejects.toMatchObject({
      code: 'PLM_BOM_WRITE_FORBIDDEN',
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(adapter().personalBomWriteManagementUrl(persisted)).not.toContain('/personal-bom-write')
  })

  it.each(['https://synthetic.invalid', 'https://synthetic.invalid/'])(
    'admits persisted root %s on the management helper',
    (url) => {
      vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
      const fetch = vi.fn()
      vi.stubGlobal('fetch', fetch)
      const config = { ...persisted, connection: { ...persisted.connection, url } }
      expect(adapter().personalBomWriteManagementUrl(config)).toBe(
        'https://synthetic.invalid/personal-approval-grants#bom-write',
      )
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    'https://synthetic.invalid/prefix',
    'https://synthetic.invalid/prefix/',
    'https://synthetic.invalid/%2F',
  ])('rejects persisted pathname %s before any personal fetch', (url) => {
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const config = { ...persisted, connection: { ...persisted.connection, url } }
    expect(() => adapter().personalBomWriteManagementUrl(config)).toThrow(
      expect.objectContaining({ status: 403, code: 'PLM_BOM_WRITE_FORBIDDEN' }),
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})
