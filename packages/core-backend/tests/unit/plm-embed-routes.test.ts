import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Controllable DataSourceManager mock.
const dsMocks = vi.hoisted(() => ({ getDataSource: vi.fn() }))

// Controllable single-use jti store. Default (set in beforeEach) is "first use" -> true, so the
// existing happy-path tests keep reaching getBomMultitableContext; replay/unavailable are per-test.
const jtiMocks = vi.hoisted(() => ({ consume: vi.fn() }))
vi.mock('../../src/auth/embed-jti-store', () => ({
  consumeEmbedJti: (...args: unknown[]) => jtiMocks.consume(...args),
  embedJtiKey: (scope: { jti?: unknown }) => `plm-embed:jti:${String(scope.jti)}`,
}))

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
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'

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

// A COMPLETE PlmBomAdapter mock: the relay's duck-type now also requires the tenant/connect surface
// (getEffectiveTenantId/isConnected/connect). Default served tenant = 'default' to match the default
// minted token's tenant_id, so existing happy-path tests keep passing the cross-check.
function fullAdapter(opts: {
  getBomMultitableContext?: ReturnType<typeof vi.fn>
  tenant?: string | undefined
  connected?: boolean
  connect?: ReturnType<typeof vi.fn>
} = {}) {
  return {
    getBomMultitableContext:
      opts.getBomMultitableContext ??
      vi.fn().mockResolvedValue({ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: CONTEXT }),
    getEffectiveTenantId: () => ('tenant' in opts ? opts.tenant : 'default'),
    isConnected: () => opts.connected ?? true,
    connect: opts.connect ?? vi.fn().mockResolvedValue(undefined),
  }
}

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
    jtiMocks.consume.mockReset()
    jtiMocks.consume.mockResolvedValue(true) // default: first use; replay/unavailable overridden per test
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
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext }))
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
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext: vi.fn().mockRejectedValue(new Error('boom')) }))
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

  // --- tenant cross-check (slice A): claims.tenant_id must equal the tenant actually served ---

  it('token tenant matches the served (effective) tenant -> 200', async () => {
    const getBomMultitableContext = vi.fn().mockResolvedValue({ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: CONTEXT })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext, tenant: 'tenant-b' }))
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint({ tenant_id: 'tenant-b' }))
    expect(res.status).toBe(200)
    expect(getBomMultitableContext).toHaveBeenCalledWith('P1')
  })

  it('FALSE-CLOSURE GUARD: served tenant B (e.g. global wins over options A) but token tenant A -> 403, BOM never queried', async () => {
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext, tenant: 'tenant-b' }))
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint({ tenant_id: 'tenant-a' }))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('EMBED_TENANT_MISMATCH')
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })

  it('absent served tenant -> 403 fail-closed, BOM never queried', async () => {
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext, tenant: undefined }))
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('EMBED_TENANT_MISMATCH')
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })

  it('an unconnected adapter is connected before its tenant is read', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ connected: false, connect }))
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(connect).toHaveBeenCalled()
    expect(res.status).toBe(200)
  })

  it('an adapter missing the tenant/connect surface -> 503 (stricter duck-type)', async () => {
    dsMocks.getDataSource.mockReturnValue({ getBomMultitableContext: vi.fn() })
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(503)
  })

  it('END-TO-END (real adapter): global tenant B but a hand-set connection x-tenant-id A, token B -> 403, BOM never queried', async () => {
    for (const k of ['PLM_TENANT_ID', 'PLM_BASE_URL', 'PLM_URL']) delete process.env[k]
    // global config says tenant-b, but the data source hand-sets x-tenant-id: tenant-a (served value)
    const adapter = new PLMAdapter(
      { get: async (key: string) => (key === 'plm.tenantId' ? 'tenant-b' : undefined) } as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      { id: DS_ID, name: 'PLM', type: 'plm', connection: { url: '', headers: { 'x-tenant-id': 'tenant-a' } } } as never,
    )
    await adapter.connect() // no URL -> mock mode -> no network; serves x-tenant-id: tenant-a
    const spy = vi.spyOn(adapter, 'getBomMultitableContext')
    dsMocks.getDataSource.mockReturnValue(adapter)
    // a token for tenant-b must NOT be able to read tenant-a's served data
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint({ tenant_id: 'tenant-b' }))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('EMBED_TENANT_MISMATCH')
    expect(spy).not.toHaveBeenCalled()
    // ordering: the jti is consumed only AFTER the tenant check passes -> a 403 here never consumes it
    expect(jtiMocks.consume).not.toHaveBeenCalled()
  })

  it('END-TO-END (real adapter): per-source options tenant/org serve the embed route when the token tenant matches', async () => {
    for (const k of ['PLM_TENANT_ID', 'PLM_ORG_ID', 'PLM_BASE_URL', 'PLM_URL']) delete process.env[k]
    const adapter = new PLMAdapter(
      { get: async () => undefined } as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      {
        id: DS_ID,
        name: 'PLM',
        type: 'plm',
        connection: { url: '' },
        options: { tenantId: 'tenant-a', orgId: 'org-a' },
      } as never,
    )
    await adapter.connect() // no URL -> mock mode -> no network; options populate served tenant/org headers
    const getBomMultitableContext = vi
      .spyOn(adapter, 'getBomMultitableContext')
      .mockResolvedValue({ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: CONTEXT })
    dsMocks.getDataSource.mockReturnValue(adapter)

    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint({ tenant_id: 'tenant-a' }))

    expect(res.status).toBe(200)
    expect(getBomMultitableContext).toHaveBeenCalledWith('P1')
    expect(adapter.getEffectiveTenantId()).toBe('tenant-a')
    expect(((adapter as unknown as { config: { connection: { headers?: Record<string, string> } } }).config.connection.headers)).toMatchObject({
      'x-tenant-id': 'tenant-a',
      'x-org-id': 'org-a',
    })
  })

  // --- single-use jti consume (slice B / B1): consume AFTER all checks, BEFORE the BOM query ---

  it('first use: consumes the (scoped) jti and serves -> 200', async () => {
    const getBomMultitableContext = vi.fn().mockResolvedValue({ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: CONTEXT })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext }))
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint({ jti: 'j-abc' }))
    expect(res.status).toBe(200)
    expect(jtiMocks.consume).toHaveBeenCalledWith('plm-embed:jti:j-abc', expect.any(Number))
    expect(getBomMultitableContext).toHaveBeenCalledWith('P1')
  })

  it('replay (jti already consumed) -> 401 EMBED_TOKEN_REPLAYED, BOM never queried', async () => {
    jtiMocks.consume.mockResolvedValue(false)
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext }))
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('EMBED_TOKEN_REPLAYED')
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })

  it('shared replay store unavailable -> 503 fail-closed, BOM never queried', async () => {
    jtiMocks.consume.mockRejectedValue(new Error('redis down'))
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext }))
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(503)
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })

  it('a token with no jti -> 401 (cannot be tracked for single-use)', async () => {
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext }))
    const res = await request(buildApp()).get(URL).set('X-PLM-Embed-Token', mint({ jti: undefined }))
    expect(res.status).toBe(401)
    expect(jtiMocks.consume).not.toHaveBeenCalled()
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })
})
