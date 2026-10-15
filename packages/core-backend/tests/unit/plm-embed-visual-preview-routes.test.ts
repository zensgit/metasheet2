import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const ds = vi.hoisted(() => ({ get: vi.fn(), current: vi.fn() }))
const jti = vi.hoisted(() => ({ consume: vi.fn() }))
vi.mock('../../src/routes/data-sources', () => ({ getDataSourceManager: () => ({ getDataSource: ds.get, isVisualReviewSourceCurrent: ds.current }) }))
vi.mock('../../src/auth/embed-jti-store', () => ({
  consumeEmbedJti: (...args: unknown[]) => jti.consume(...args),
  embedJtiKey: (scope: { jti: string }) => scope.jti,
}))
vi.mock('../../src/db/sharding/tenant-context', () => ({ extractTenantFromHeaders: () => undefined }))
vi.mock('../../src/metrics/metrics', () => ({ metrics: new Proxy({}, { get: () => ({ inc: () => {} }) }) }))
vi.mock('../../src/auth/AuthService', () => ({ authService: {} }))

import plmEmbedVisualPreviewRouter from '../../src/routes/plm-embed-visual-preview'

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const pub = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64')
let serial = 0
function token(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'embed-1' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    sub: '7', tenant_id: 'default', org_id: 'org-1', part_id: 'P1', feature_key: 'bom_multitable',
    aud: 'metasheet2.embed', embed_origin: 'https://plm.example.com', typ: 'embed',
    jti: `j-${++serial}`, iat: now, exp: now + 120, ...overrides,
  })).toString('base64url')
  const signature = crypto.sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')
  return `${header}.${payload}.${signature}`
}

function adapter() {
  return {
    listVisualPreviewFiles: vi.fn().mockResolvedValue({ data: [{ files: [{ file_id: 'F1', version_id: 'V1', filename: 'real.png', version_is_current: true }], has_more: false }] }),
    getVisualPreviewImage: vi.fn().mockResolvedValue({ render: 'unavailable' }),
    isVisualReviewEnabled: vi.fn().mockReturnValue(true), getEffectiveTenantId: () => 'default',
    getEffectiveOrgId: (): string | undefined => 'org-1', isConnected: () => true, connect: vi.fn(),
  }
}

describe('visual-preview embed relay', () => {
  const pinned = usePinnedServer()
  beforeEach(() => {
    process.env.YUANTUS_EMBED_PUBLIC_KEY = pub
    process.env.YUANTUS_EMBED_KEY_ID = 'embed-1'
    process.env.PLM_EMBED_AUDIENCE = 'metasheet2.embed'
    process.env.PLM_EMBED_ALLOWED_ORIGINS = 'https://plm.example.com'
    process.env.PLM_EMBED_DATA_SOURCE_ID = 'plm-ds'
    delete process.env.PLM_EMBED_VISUAL_PREVIEW_ENABLED
    ds.current.mockReset().mockResolvedValue(true)
    ds.get.mockReset()
    jti.consume.mockReset().mockResolvedValue(true)
    ds.get.mockReturnValue(adapter())
    const app = express()
    app.use(express.json())
    app.use(plmEmbedVisualPreviewRouter())
    pinned.setApp(app)
  })
  afterEach(() => {
    for (const name of ['YUANTUS_EMBED_PUBLIC_KEY', 'YUANTUS_EMBED_KEY_ID', 'PLM_EMBED_AUDIENCE',
      'PLM_EMBED_ALLOWED_ORIGINS', 'PLM_EMBED_DATA_SOURCE_ID', 'PLM_EMBED_VISUAL_PREVIEW_ENABLED']) delete process.env[name]
  })

  it.each(['/files', '/image'])('durable source revocation refuses %s before connect, nonce or provider', async suffix => {
    process.env.PLM_EMBED_VISUAL_PREVIEW_ENABLED = 'true'
    const a = adapter()
    a.isConnected = () => false
    ds.get.mockReturnValue(a)
    ds.current.mockResolvedValue(false)
    const response = await request(pinned.url()).post(`/api/plm-embed/visual-preview${suffix}`)
      .set('X-PLM-Embed-Token', token()).send(suffix === '/image' ? { file_id: 'F1', version_id: 'V1' } : {})
    expect(response.status).toBe(503)
    expect(a.connect).not.toHaveBeenCalled()
    expect(jti.consume).not.toHaveBeenCalled()
    expect(a.listVisualPreviewFiles).not.toHaveBeenCalled()
    expect(a.getVisualPreviewImage).not.toHaveBeenCalled()
  })

  it('revocation during provider work suppresses the fetched listing', async () => {
    process.env.PLM_EMBED_VISUAL_PREVIEW_ENABLED = 'true'
    ds.current.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false)
    const response = await request(pinned.url()).post('/api/plm-embed/visual-preview/files')
      .set('X-PLM-Embed-Token', token())
    expect(response.status).toBe(503)
    expect(response.body.data).toBeUndefined()
    expect(ds.get.mock.results[0].value.listVisualPreviewFiles).toHaveBeenCalledOnce()
  })

  it('stays off unless the flag is exactly true, before source lookup', async () => {
    for (const value of [undefined, '1', 'TRUE']) {
      if (value) process.env.PLM_EMBED_VISUAL_PREVIEW_ENABLED = value
      else delete process.env.PLM_EMBED_VISUAL_PREVIEW_ENABLED
      const response = await request(pinned.url()).post('/api/plm-embed/visual-preview/files').set('X-PLM-Embed-Token', token())
      expect(response.status).toBe(404)
    }
    expect(ds.get).not.toHaveBeenCalled()
  })

  it('lists actual provider file/version pairs with one consumed embed token', async () => {
    process.env.PLM_EMBED_VISUAL_PREVIEW_ENABLED = 'true'
    const a = adapter()
    ds.get.mockReturnValue(a)
    const t = token()
    const response = await request(pinned.url()).post('/api/plm-embed/visual-preview/files').set('X-PLM-Embed-Token', t)
    expect(response.status).toBe(200)
    expect(response.body.data.files).toEqual([{ file_id: 'F1', version_id: 'V1', filename: 'real.png', version_is_current: true }])
    expect(a.listVisualPreviewFiles).toHaveBeenCalledWith(t)
    expect(jti.consume).toHaveBeenCalledTimes(1)
  })

  it('rejects wrong tenant and replay before provider calls', async () => {
    process.env.PLM_EMBED_VISUAL_PREVIEW_ENABLED = 'true'
    const a = adapter()
    ds.get.mockReturnValue(a)
    const wrong = await request(pinned.url()).post('/api/plm-embed/visual-preview/files').set('X-PLM-Embed-Token', token({ tenant_id: 'foreign' }))
    expect(wrong.status).toBe(403)
    jti.consume.mockResolvedValue(false)
    const replay = await request(pinned.url()).post('/api/plm-embed/visual-preview/files').set('X-PLM-Embed-Token', token())
    expect(replay.status).toBe(401)
    expect(a.listVisualPreviewFiles).not.toHaveBeenCalled()
  })

  it.each([{ org_id: 'org-2' }, { org_id: undefined }])('rejects a token outside the served org (%o) before nonce or provider calls', async (claims) => {
    process.env.PLM_EMBED_VISUAL_PREVIEW_ENABLED = 'true'
    const a = adapter()
    ds.get.mockReturnValue(a)
    const response = await request(pinned.url()).post('/api/plm-embed/visual-preview/files').set('X-PLM-Embed-Token', token(claims))
    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('EMBED_ORG_MISMATCH')
    expect(jti.consume).not.toHaveBeenCalled()
    expect(a.listVisualPreviewFiles).not.toHaveBeenCalled()
  })

  it('rejects an absent served org before nonce or provider calls', async () => {
    process.env.PLM_EMBED_VISUAL_PREVIEW_ENABLED = 'true'
    const a = adapter()
    a.getEffectiveOrgId = () => undefined
    ds.get.mockReturnValue(a)
    const response = await request(pinned.url()).post('/api/plm-embed/visual-preview/image')
      .set('X-PLM-Embed-Token', token()).send({ file_id: 'F1', version_id: 'V1' })
    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('EMBED_ORG_MISMATCH')
    expect(jti.consume).not.toHaveBeenCalled()
    expect(a.getVisualPreviewImage).not.toHaveBeenCalled()
  })

  it('returns only raster bytes and never a preview capability', async () => {
    process.env.PLM_EMBED_VISUAL_PREVIEW_ENABLED = 'true'
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const a = adapter()
    const descriptor = { schema_version: 1, part_id: 'P1', file_id: 'F1', file_version: 'V1',
      content_checksum: 'a'.repeat(64), preview_checksum: 'b'.repeat(64), page: 0,
      preview_width: 1, preview_height: 1, version_is_current: true }
    a.getVisualPreviewImage.mockResolvedValue({ render: 'available', bytes, mediaType: 'image/png', descriptor })
    ds.get.mockReturnValue(a)
    const t = token()
    const response = await request(pinned.url()).post('/api/plm-embed/visual-preview/image')
      .set('X-PLM-Embed-Token', t).send({ file_id: 'F1', version_id: 'V1' })
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toMatch(/^image\/png/)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toEqual(bytes)
    expect(JSON.parse(Buffer.from(response.headers['x-plm-preview-descriptor'], 'base64url').toString())).toEqual(descriptor)
    expect(response.headers['access-control-expose-headers']).toContain('X-PLM-Preview-Descriptor')
    expect(a.getVisualPreviewImage).toHaveBeenCalledWith(t, 'F1', 'V1', 'https://plm.example.com')
  })

  it('keeps provider failure and stale selections unavailable without returning a capability', async () => {
    process.env.PLM_EMBED_VISUAL_PREVIEW_ENABLED = 'true'
    const a = adapter()
    a.getVisualPreviewImage.mockResolvedValue({ render: 'unavailable' })
    ds.get.mockReturnValue(a)
    const response = await request(pinned.url()).post('/api/plm-embed/visual-preview/image')
      .set('X-PLM-Embed-Token', token()).send({ file_id: 'F1', version_id: 'V1' })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, data: { render: 'unavailable' } })
    expect(a.getVisualPreviewImage).toHaveBeenCalledTimes(1)

    const malformed = await request(pinned.url()).post('/api/plm-embed/visual-preview/image')
      .set('X-PLM-Embed-Token', token()).send({ file_id: 'F1' })
    expect(malformed.status).toBe(400)
    expect(a.getVisualPreviewImage).toHaveBeenCalledTimes(1)
  })
  it('disabled source rejects before connect, consume, or provider work', async () => {
    process.env.PLM_EMBED_VISUAL_PREVIEW_ENABLED = 'true'
    const a = adapter()
    a.isVisualReviewEnabled.mockReturnValue(false)
    ds.get.mockReturnValue(a)
    const response = await request(pinned.url()).post('/api/plm-embed/visual-preview/files').set('X-PLM-Embed-Token', token())
    expect(response.status).toBe(503)
    expect(a.connect).not.toHaveBeenCalled()
    expect(jti.consume).not.toHaveBeenCalled()
    expect(a.listVisualPreviewFiles).not.toHaveBeenCalled()
  })

  it.each([{ file_id: 'F1', version_id: 'V1', part_id: 'P2' }, { file_id: [], version_id: 'V1' },
    { file_id: ' F1', version_id: 'V1' }, ['F1', 'V1']])('rejects malformed selection before source lookup', async (body) => {
    process.env.PLM_EMBED_VISUAL_PREVIEW_ENABLED = 'true'
    const response = await request(pinned.url()).post('/api/plm-embed/visual-preview/image')
      .set('X-PLM-Embed-Token', token()).send(body)
    expect(response.status).toBe(400)
    expect(ds.get).not.toHaveBeenCalled()
    expect(jti.consume).not.toHaveBeenCalled()
  })

})
