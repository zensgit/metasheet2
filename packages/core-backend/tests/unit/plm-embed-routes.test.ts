import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Controllable DataSourceManager mock.
const dsMocks = vi.hoisted(() => ({ getDataSource: vi.fn() }))

// Stub jwt-middleware's heavy deps so importing the REAL isWhitelisted is cheap. We do NOT mock
// jwt-middleware itself -- we want the REAL whitelist (it must include /api/plm-embed/).
vi.mock('../../src/db/sharding/tenant-context', () => ({ extractTenantFromHeaders: () => undefined }))
vi.mock('../../src/metrics/metrics', () => ({ metrics: new Proxy({}, { get: () => ({ inc: () => {} }) }) }))
vi.mock('../../src/auth/AuthService', () => ({ authService: {} }))
vi.mock('../../src/routes/data-sources', () => ({
  getDataSourceManager: () => ({ getDataSource: dsMocks.getDataSource }),
}))

import { isWhitelisted } from '../../src/auth/jwt-middleware'
import plmEmbedRouter from '../../src/routes/plm-embed'

const KID = 'embed-1'
const AUD = 'metasheet2.embed'
const ORIGIN = 'https://plm.example.com'
const DS_ID = 'plm-ds'

// A node-side Ed25519 minter that mirrors the Yuantus wire format (sign over header_b64.payload_b64,
// unpadded base64url). Cross-language correctness vs the Python minter is proven separately in
// embed-token-verify.test.ts; here we need freshly-minted, non-expired tokens to drive the route.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const PUB_B64 = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64')

function mint(overrides: Record<string, unknown> = {}, kid = KID): string {
  const now = Math.floor(Date.now() / 1000)
  const claims = { sub: '7', tenant_id: 'default', part_id: 'P1', feature_key: 'bom_multitable', aud: AUD, embed_origin: ORIGIN, iat: now, exp: now + 120, jti: 'j1', typ: 'embed', ...overrides }
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const sig = crypto.sign(null, Buffer.from(`${header}.${payload}`, 'ascii'), privateKey).toString('base64url')
  return `${header}.${payload}.${sig}`
}

const CONTEXT = { part: { part_id: 'P1', item_number: 'P-001', name: 'A', state: 'Released', generation: 3 }, lines: [], source_version: 3, source_updated_at: '2026', sync_status: 'snapshot', template_key: 'bom_review' }

function buildApp() {
  const app = express()
  app.use(express.json())
  // Reproduce the REAL global gate (index.ts:927): whitelisted -> through; else /api/* needs the
  // session JWT (stood in here by a 401, exactly what jwtAuthMiddleware does on a missing token).
  app.use((req, res, next) => {
    if (isWhitelisted(req.path)) return next()
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED' } })
    return next()
  })
  app.use(plmEmbedRouter())
  return app
}

const URL = '/api/plm-embed/bom-review/context'

describe('PLM embed relay (PLM-COLLAB-P3-D2)', () => {
  beforeEach(() => {
    dsMocks.getDataSource.mockReset()
    process.env.YUANTUS_EMBED_PUBLIC_KEY = PUB_B64
    process.env.YUANTUS_EMBED_KEY_ID = KID
    process.env.PLM_EMBED_AUDIENCE = AUD
    process.env.PLM_EMBED_ALLOWED_ORIGINS = ORIGIN
    process.env.PLM_EMBED_DATA_SOURCE_ID = DS_ID
  })
  afterEach(() => {
    for (const k of ['YUANTUS_EMBED_PUBLIC_KEY', 'YUANTUS_EMBED_KEY_ID', 'PLM_EMBED_AUDIENCE', 'PLM_EMBED_ALLOWED_ORIGINS', 'PLM_EMBED_DATA_SOURCE_ID']) delete process.env[k]
  })

  it('the embed path is whitelisted from the global session gate (else it would 401 before embedTokenAuth)', () => {
    expect(isWhitelisted('/api/plm-embed/bom-review/context')).toBe(true)
    expect(isWhitelisted('/api/plm-embed/config')).toBe(true)
    expect(isWhitelisted('/api/other/thing')).toBe(false)
  })

  it('REAL CHAIN: an embed-token-only request (no session Bearer) reaches the route -> 200', async () => {
    const getBomMultitableContext = vi.fn().mockResolvedValue({ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: CONTEXT })
    dsMocks.getDataSource.mockReturnValue({ getBomMultitableContext })
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(200)
    expect(res.body.data.entitled).toBe(true)
    expect(res.body.data.context).toEqual(CONTEXT)
    expect(res.body.data.part_id).toBe('P1')
    // part is TOKEN-BOUND: the adapter was called with the claim's part, not any request input
    expect(getBomMultitableContext).toHaveBeenCalledWith('P1')
  })

  it('a non-whitelisted /api/* path with no session is 401 (proves the stand-in gate is real)', async () => {
    const res = await request(buildApp()).get('/api/other/thing')
    expect(res.status).toBe(401)
  })

  it('no embed token -> 401', async () => {
    const res = await request(buildApp()).get(URL)
    expect(res.status).toBe(401)
  })

  it('invalid embed token -> 401', async () => {
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', 'not.a.valid.jwt')
    expect(res.status).toBe(401)
  })

  it('no Yuantus public key configured -> 503 fail-closed (not 401)', async () => {
    delete process.env.YUANTUS_EMBED_PUBLIC_KEY
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(503)
  })

  it('embed_origin not in the allowlist -> 403', async () => {
    dsMocks.getDataSource.mockReturnValue({ getBomMultitableContext: vi.fn() })
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint({ embed_origin: 'https://evil.example.com' }))
    expect(res.status).toBe(403)
  })

  it('a token scoped to a DIFFERENT feature -> 403 (must be bom_multitable)', async () => {
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue({ getBomMultitableContext })
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint({ feature_key: 'approval_automation' }))
    expect(res.status).toBe(403)
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })

  it('a token with NO exp -> 401 (exp is required; never mint a non-expiring token)', async () => {
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint({ exp: undefined }))
    expect(res.status).toBe(401)
  })

  it('a token with a non-numeric exp -> 401', async () => {
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint({ exp: 'soon' }))
    expect(res.status).toBe(401)
  })

  it('data source not configured -> 503', async () => {
    delete process.env.PLM_EMBED_DATA_SOURCE_ID
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(503)
  })

  it('provider throws -> degrades (context:null), never 500', async () => {
    dsMocks.getDataSource.mockReturnValue({ getBomMultitableContext: vi.fn().mockRejectedValue(new Error('boom')) })
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(200)
    expect(res.body.data.context).toBeNull()
    expect(res.body.data.reason).toBe('unavailable')
  })

  it('/config serves the single-source allowlist + frame-ancestors (public, no token)', async () => {
    const res = await request(buildApp()).get('/api/plm-embed/config')
    expect(res.status).toBe(200)
    expect(res.body.data.allowed_origins).toEqual([ORIGIN])
    expect(res.body.data.frame_ancestors).toBe(`frame-ancestors ${ORIGIN}`)
  })

  it('/config frame-ancestors fails CLOSED to none when unconfigured', async () => {
    delete process.env.PLM_EMBED_ALLOWED_ORIGINS
    const res = await request(buildApp()).get('/api/plm-embed/config')
    expect(res.body.data.allowed_origins).toEqual([])
    expect(res.body.data.frame_ancestors).toBe("frame-ancestors 'none'")
  })

  it('a literal * in the allowlist is dropped (never allow-all)', async () => {
    process.env.PLM_EMBED_ALLOWED_ORIGINS = '*'
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(403) // origin no longer matches an empty allowlist
  })
})
