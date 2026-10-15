import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'

const redis = vi.hoisted(() => ({ consume: vi.fn() }))
vi.mock('../../src/auth/embed-jti-store', () => ({ consumeEmbedJti: (...args: unknown[]) => redis.consume(...args) }))
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
const endpoint = 'https://plm.example.com/api/v1/auth/embed/visual-preview-session'
const origin = 'https://metasheet.example.com'
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const pub = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64')
const now = Math.floor(Date.now() / 1000)
const embedClaims = { sub: '7', tenant_id: 'T1', org_id: 'O1', part_id: 'P1', feature_key: 'bom_multitable',
  aud: 'metasheet2.embed', typ: 'embed', embed_origin: origin, jti: 'embed-image', iat: now, exp: now + 120 }
function jwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'embed-1' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`
}
const embedToken = jwt(embedClaims)
function claims(overrides: Record<string, unknown> = {}) {
  return { ...embedClaims, aud: 'metasheet2.visual-preview', typ: 'visual_preview', jti: 'preview-1',
    embed_jti: embedClaims.jti, embed_iat: now, file_id: 'F1', version_id: 'V1', checksum: 'a'.repeat(64),
    preview_checksum: createHash('sha256').update(PNG).digest('hex'), media_type: 'image/png',
    width: 1, height: 1, page: 0, version_is_current: true, ...overrides }
}
function adapter(enabled: unknown = true): PLMAdapter {
  const instance = new PLMAdapter({ get: vi.fn() } as never, logger as never,
    { id: 'preview', name: 'PLM', type: 'plm', connection: { url: 'https://plm.example.com', headers: { 'x-tenant-id': 'T1', 'x-org-id': 'O1' } },
      options: { apiMode: 'yuantus', tenantId: 'T1', visualReviewEnabled: enabled } } as never)
  ;(instance as unknown as { apiMode: string }).apiMode = 'yuantus'
  return instance
}
function mint(overrides: Record<string, unknown> = {}, unsigned: Record<string, unknown> = {}): Response {
  const c = claims(overrides)
  return Response.json({ render: 'available', preview_token: jwt(c), expires_in: 120,
    file_id: c.file_id, version_id: c.version_id, checksum: c.checksum, preview_checksum: c.preview_checksum,
    media_type: c.media_type, width: c.width, height: c.height, page: c.page, version_is_current: c.version_is_current, ...unsigned })
}
function raster(type = 'image/png', bytes = PNG): Response {
  return new Response(bytes, { headers: { 'Content-Type': type } })
}

describe('PLM visual-preview signed transport', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000)
    vi.stubEnv('YUANTUS_EMBED_PUBLIC_KEY', pub)
    vi.stubEnv('YUANTUS_EMBED_KEY_ID', 'embed-1')
    vi.stubEnv('PLM_EMBED_AUDIENCE', 'metasheet2.embed')
    vi.stubEnv('PLM_EMBED_ALLOWED_ORIGINS', origin)
    fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock)
    redis.consume.mockReset().mockResolvedValue(true)
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

  it('lists with an embed token and exposes only the signed descriptor with raster bytes', async () => {
    const files = [{ file_id: 'F1', version_id: 'V1', filename: 'drawing.png', version_is_current: true }]
    fetchMock.mockResolvedValueOnce(Response.json({ files, has_more: false })).mockResolvedValueOnce(mint()).mockResolvedValueOnce(raster())
    const a = adapter()
    expect((await a.listVisualPreviewFiles(embedToken)).data[0].files).toEqual(files)
    const image = await a.getVisualPreviewImage(embedToken, 'F1', 'V1', origin)
    expect(image).toEqual({ render: 'available', bytes: PNG, mediaType: 'image/png', descriptor: {
      schema_version: 1, part_id: 'P1', file_id: 'F1', file_version: 'V1', content_checksum: 'a'.repeat(64),
      preview_checksum: claims().preview_checksum, page: 0, preview_width: 1, preview_height: 1, version_is_current: true,
    } })
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([endpoint, endpoint, endpoint])
    expect(fetchMock.mock.calls.every((call) => call[1].redirect === 'error')).toBe(true)
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ preview_token: jwt(claims()), origin })
    expect(redis.consume).toHaveBeenCalledWith(expect.stringMatching(/^plm-visual-preview:jti:/), 120)
  })

  it.each([undefined, false, 'true', 1])('source gate %s fails before outbound work', async (enabled) => {
    const a = adapter(enabled === undefined ? null : enabled)
    expect((await a.listVisualPreviewFiles(embedToken)).error).toBeDefined()
    expect(await a.getVisualPreviewImage(embedToken, 'F1', 'V1', origin)).toEqual({ render: 'unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['sub', '8'], ['tenant_id', 'T2'], ['org_id', 'O2'], ['part_id', 'P2'], ['file_id', 'F2'],
    ['version_id', 'V2'], ['embed_origin', 'https://foreign.example'], ['aud', 'metasheet2.embed'],
    ['typ', 'embed'], ['feature_key', 'other'], ['embed_jti', 'other'], ['embed_iat', now - 1],
    ['exp', now], ['checksum', 'bad'], ['preview_checksum', 'bad'], ['page', 1], ['width', 0],
    ['version_is_current', undefined], ['jti', ''],
  ])('rejects signed capability disagreement %s before redeem', async (key, value) => {
    fetchMock.mockResolvedValueOnce(mint({ [key]: value }))
    expect(await adapter().getVisualPreviewImage(embedToken, 'F1', 'V1', origin)).toEqual({ render: 'unavailable' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(redis.consume).not.toHaveBeenCalled()
  })

  it.each(['file_id', 'version_id', 'checksum', 'preview_checksum', 'media_type', 'width', 'height', 'page', 'version_is_current'])
    ('rejects unsigned metadata mismatch %s before Redis and redeem', async (key) => {
      fetchMock.mockResolvedValueOnce(mint({}, { [key]: 'forged' }))
      expect(await adapter().getVisualPreviewImage(embedToken, 'F1', 'V1', origin)).toEqual({ render: 'unavailable' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(redis.consume).not.toHaveBeenCalled()
    })

  it('rejects bad signatures even when JSON metadata claims availability', async () => {
    fetchMock.mockResolvedValueOnce(mint({}, { preview_token: `${jwt(claims()).split('.').slice(0, 2).join('.')}.${Buffer.alloc(64).toString('base64url')}` }))
    expect(await adapter().getVisualPreviewImage(embedToken, 'F1', 'V1', origin)).toEqual({ render: 'unavailable' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(redis.consume).not.toHaveBeenCalled()
  })

  it.each(['replay', 'redis error'])('does not redeem after %s', async (reason) => {
    fetchMock.mockResolvedValueOnce(mint())
    if (reason === 'replay') redis.consume.mockResolvedValue(false)
    else redis.consume.mockRejectedValue(new Error('private-store-down'))
    expect(await adapter().getVisualPreviewImage(embedToken, 'F1', 'V1', origin)).toEqual({ render: 'unavailable' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('independently rejects concurrent replay even when the provider would accept both', async () => {
    const used = new Set<string>()
    redis.consume.mockImplementation(async (key: string) => { if (used.has(key)) return false; used.add(key); return true })
    fetchMock.mockImplementation(async (_url, options) => JSON.parse(options.body).preview_token ? raster() : mint())
    const a = adapter()
    const results = await Promise.all([a.getVisualPreviewImage(embedToken, 'F1', 'V1', origin), a.getVisualPreviewImage(embedToken, 'F1', 'V1', origin)])
    expect(results.map((result) => result.render).sort()).toEqual(['available', 'unavailable'])
    expect(fetchMock.mock.calls.filter((call) => JSON.parse(call[1].body).preview_token)).toHaveLength(1)
  })

  it('retains historical read-only status in the signed descriptor', async () => {
    fetchMock.mockResolvedValueOnce(mint({ version_is_current: false })).mockResolvedValueOnce(raster())
    const image = await adapter().getVisualPreviewImage(embedToken, 'F1', 'V1', origin)
    expect(image.render === 'available' && image.descriptor.version_is_current).toBe(false)
    expect(image.render).toBe('available')
  })

  it('rejects changed raster payload even when its PNG magic, MIME and size are valid', async () => {
    const changed = Buffer.from(PNG)
    changed[changed.length - 1] ^= 1
    expect(changed.subarray(0, 8)).toEqual(PNG.subarray(0, 8))
    expect(changed.length).toBe(PNG.length)
    expect(createHash('sha256').update(changed).digest('hex')).not.toBe(claims().preview_checksum)
    fetchMock.mockResolvedValueOnce(mint()).mockResolvedValueOnce(raster('image/png', changed))
    expect(await adapter().getVisualPreviewImage(embedToken, 'F1', 'V1', origin)).toEqual({ render: 'unavailable' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(redis.consume).toHaveBeenCalledTimes(1)
  })

  it('fails closed on mint/redeem errors, wrong MIME, corrupt bytes, oversized bodies, and post-read expiry', async () => {
    for (const reply of [new Response(null, { status: 403 }), raster('text/html'), raster('image/png', Buffer.from('bad')),
      raster('image/png', Buffer.alloc(8 * 1024 * 1024 + 1))]) {
      fetchMock.mockReset().mockResolvedValueOnce(mint()).mockResolvedValueOnce(reply)
      expect(await adapter().getVisualPreviewImage(embedToken, 'F1', 'V1', origin)).toEqual({ render: 'unavailable' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
    fetchMock.mockReset().mockResolvedValueOnce(new Response(' '.repeat(65 * 1024), { headers: { 'Content-Type': 'application/json' } }))
    expect(await adapter().getVisualPreviewImage(embedToken, 'F1', 'V1', origin)).toEqual({ render: 'unavailable' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockReset().mockResolvedValueOnce(mint()).mockImplementationOnce(async () => {
      vi.mocked(Date.now).mockReturnValue((now + 121) * 1000)
      return raster()
    })
    expect(await adapter().getVisualPreviewImage(embedToken, 'F1', 'V1', origin)).toEqual({ render: 'unavailable' })
  })
})
