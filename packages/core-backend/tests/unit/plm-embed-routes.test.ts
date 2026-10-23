import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

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
import {
  MANAGED_SESSION_COOKIE,
  setManagedBindingReaderForTests,
  type ManagedBindingRow,
  type ManagedSourceClass,
} from '../../src/services/plm-managed-companion'

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
  const claims = { sub: '7', tenant_id: 'default', org_id: 'org-1', part_id: 'P1', feature_key: 'bom_multitable', aud: AUD, embed_origin: ORIGIN, iat: now, exp: now + 120, jti: 'j1', typ: 'embed', ...overrides }
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const sig = crypto.sign(null, Buffer.from(`${header}.${payload}`, 'ascii'), privateKey).toString('base64url')
  return `${header}.${payload}.${sig}`
}

const CONTEXT = { part: { part_id: 'P1', item_number: 'P-001', name: 'A', state: 'Released', generation: 3 }, lines: [], source_version: 3, source_updated_at: '2026', sync_status: 'snapshot', template_key: 'bom_review' }

// A COMPLETE PlmBomAdapter mock: the relay's duck-type also requires the tenant/org/connect surface
// (getEffectiveTenantId/getEffectiveOrgId/isConnected/connect). Default served tenant/org match the
// default minted token's tenant_id/org_id, so existing happy-path tests keep passing the cross-check.
function fullAdapter(opts: {
  getBomMultitableContext?: ReturnType<typeof vi.fn>
  tenant?: string | undefined
  org?: string | undefined
  connected?: boolean
  connect?: ReturnType<typeof vi.fn>
} = {}) {
  return {
    getBomMultitableContext:
      opts.getBomMultitableContext ??
      vi.fn().mockResolvedValue({ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: CONTEXT }),
    getEffectiveTenantId: () => ('tenant' in opts ? opts.tenant : 'default'),
    getEffectiveOrgId: () => ('org' in opts ? opts.org : 'org-1'),
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

// Proven unbound without a database. Missing DATABASE_URL is unavailable in the product,
// so these route tests pin the reader instead of treating a missing URL as legacy.
const UNBOUND: ManagedSourceClass = { kind: 'unbound' }
const BOUND_ROW = {
  native_auth_user_id: 'native-subject',
  native_tenant_id: 'native-tenant',
  native_org_id: 'native-org',
  root_part_id: 'P1',
  frozen_root_part_id: 'P1',
  client_origin: ORIGIN,
  frozen_origin: ORIGIN,
  meta_user_id: 'meta-user',
  meta_tenant_id: 'meta-tenant',
  meta_org_id: 'meta-org',
} as ManagedBindingRow

describe('PLM embed relay (PLM-COLLAB-P3-D2)', () => {
  const pinned = usePinnedServer()

  beforeEach(() => {
    dsMocks.getDataSource.mockReset()
    jtiMocks.consume.mockReset()
    jtiMocks.consume.mockResolvedValue(true) // default: first use; replay/unavailable overridden per test
    setManagedBindingReaderForTests(async () => UNBOUND)
    delete process.env.PLM_MANAGED_COMPANION_ENABLED
    process.env.YUANTUS_EMBED_PUBLIC_KEY = PUB_B64
    process.env.YUANTUS_EMBED_KEY_ID = KID
    process.env.PLM_EMBED_AUDIENCE = AUD
    process.env.PLM_EMBED_ALLOWED_ORIGINS = ORIGIN
    process.env.PLM_EMBED_DATA_SOURCE_ID = DS_ID
    pinned.setApp(buildApp())
  })
  afterEach(() => {
    setManagedBindingReaderForTests(null)
    delete process.env.PLM_MANAGED_COMPANION_ENABLED
    for (const k of ['YUANTUS_EMBED_PUBLIC_KEYS', 'YUANTUS_EMBED_PUBLIC_KEY', 'YUANTUS_EMBED_KEY_ID', 'PLM_EMBED_AUDIENCE', 'PLM_EMBED_ALLOWED_ORIGINS', 'PLM_EMBED_DATA_SOURCE_ID']) delete process.env[k]
  })

  it('the embed path is whitelisted from the global session gate (else it would 401 before embedTokenAuth)', () => {
    expect(isWhitelisted('/api/plm-embed/bom-review/context')).toBe(true)
    expect(isWhitelisted('/api/plm-embed/config')).toBe(true)
    expect(isWhitelisted('/api/other/thing')).toBe(false)
  })

  it('REAL CHAIN: an embed-token-only request (no session Bearer) reaches the route -> 200', async () => {
    const getBomMultitableContext = vi.fn().mockResolvedValue({ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: CONTEXT })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext }))
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(200)
    expect(res.body.data.entitled).toBe(true)
    expect(res.body.data.context).toEqual(CONTEXT)
    expect(res.body.data.part_id).toBe('P1')
    // part is TOKEN-BOUND: the adapter was called with the claim's part, not any request input
    expect(getBomMultitableContext).toHaveBeenCalledWith('P1')
  })

  it('REAL CHAIN: accepts a rotated kid from YUANTUS_EMBED_PUBLIC_KEYS', async () => {
    process.env.YUANTUS_EMBED_PUBLIC_KEYS = JSON.stringify({
      'embed-old': 'unused-old-public-key',
      'embed-new': PUB_B64,
    })
    delete process.env.YUANTUS_EMBED_PUBLIC_KEY
    delete process.env.YUANTUS_EMBED_KEY_ID
    const getBomMultitableContext = vi.fn().mockResolvedValue({ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: CONTEXT })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext }))

    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({}, 'embed-new'))

    expect(res.status).toBe(200)
    expect(getBomMultitableContext).toHaveBeenCalledWith('P1')
  })

  it('a non-whitelisted /api/* path with no session is 401 (proves the stand-in gate is real)', async () => {
    const res = await request(pinned.url()).get('/api/other/thing')
    expect(res.status).toBe(401)
  })

  it('no embed token -> 401', async () => {
    const res = await request(pinned.url()).get(URL)
    expect(res.status).toBe(401)
  })

  it('invalid embed token -> 401', async () => {
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', 'not.a.valid.jwt')
    expect(res.status).toBe(401)
  })

  it('no Yuantus public key configured -> 503 fail-closed (not 401)', async () => {
    delete process.env.YUANTUS_EMBED_PUBLIC_KEY
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(503)
  })

  it('malformed YUANTUS_EMBED_PUBLIC_KEYS -> 503 fail-closed (not a server error)', async () => {
    process.env.YUANTUS_EMBED_PUBLIC_KEYS = '{not-json'
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(503)
  })

  it('embed_origin not in the allowlist -> 403', async () => {
    dsMocks.getDataSource.mockReturnValue({ getBomMultitableContext: vi.fn() })
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({ embed_origin: 'https://evil.example.com' }))
    expect(res.status).toBe(403)
  })

  it('a token scoped to a DIFFERENT feature -> 403 (must be bom_multitable)', async () => {
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue({ getBomMultitableContext })
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({ feature_key: 'approval_automation' }))
    expect(res.status).toBe(403)
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })

  it('a token with NO exp -> 401 (exp is required; never mint a non-expiring token)', async () => {
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({ exp: undefined }))
    expect(res.status).toBe(401)
  })

  it('a token with a non-numeric exp -> 401', async () => {
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({ exp: 'soon' }))
    expect(res.status).toBe(401)
  })

  it('data source not configured -> 503', async () => {
    delete process.env.PLM_EMBED_DATA_SOURCE_ID
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(503)
  })

  it('provider throws -> degrades (context:null), never 500', async () => {
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext: vi.fn().mockRejectedValue(new Error('boom')) }))
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(200)
    expect(res.body.data.context).toBeNull()
    expect(res.body.data.reason).toBe('unavailable')
  })

  it('/config serves the single-source allowlist + frame-ancestors (public, no token)', async () => {
    const res = await request(pinned.url()).get('/api/plm-embed/config')
    expect(res.status).toBe(200)
    expect(res.body.data.allowed_origins).toEqual([ORIGIN])
    expect(res.body.data.frame_ancestors).toBe(`frame-ancestors ${ORIGIN}`)
  })

  it('/config frame-ancestors fails CLOSED to none when unconfigured', async () => {
    delete process.env.PLM_EMBED_ALLOWED_ORIGINS
    const res = await request(pinned.url()).get('/api/plm-embed/config')
    expect(res.body.data.allowed_origins).toEqual([])
    expect(res.body.data.frame_ancestors).toBe("frame-ancestors 'none'")
  })

  it('a literal * in the allowlist is dropped (never allow-all)', async () => {
    process.env.PLM_EMBED_ALLOWED_ORIGINS = '*'
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(403) // origin no longer matches an empty allowlist
  })

  // --- tenant cross-check (slice A): claims.tenant_id must equal the tenant actually served ---

  it('token tenant matches the served (effective) tenant -> 200', async () => {
    const getBomMultitableContext = vi.fn().mockResolvedValue({ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: CONTEXT })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext, tenant: 'tenant-b' }))
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({ tenant_id: 'tenant-b' }))
    expect(res.status).toBe(200)
    expect(getBomMultitableContext).toHaveBeenCalledWith('P1')
  })

  it('FALSE-CLOSURE GUARD: served tenant B (e.g. global wins over options A) but token tenant A -> 403, BOM never queried', async () => {
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext, tenant: 'tenant-b' }))
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({ tenant_id: 'tenant-a' }))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('EMBED_TENANT_MISMATCH')
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })

  it('absent served tenant -> 403 fail-closed, BOM never queried', async () => {
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext, tenant: undefined }))
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('EMBED_TENANT_MISMATCH')
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })

  it('an unconnected adapter is connected before its tenant is read', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ connected: false, connect }))
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(connect).toHaveBeenCalled()
    expect(res.status).toBe(200)
  })

  it('an adapter missing the tenant/connect surface -> 503 (stricter duck-type)', async () => {
    dsMocks.getDataSource.mockReturnValue({ getBomMultitableContext: vi.fn() })
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(503)
  })

  // --- org cross-check: the relay reads with the SOURCE's credentials, so the served org must be the token's ---

  it('token org matches the served (effective) org -> 200', async () => {
    const getBomMultitableContext = vi.fn().mockResolvedValue({ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: CONTEXT })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext, org: 'org-b' }))
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({ org_id: 'org-b' }))
    expect(res.status).toBe(200)
    expect(getBomMultitableContext).toHaveBeenCalledWith('P1')
  })

  it('CROSS-ORG: same tenant, token org A but served org B -> 403, BOM never queried, jti never consumed', async () => {
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext, org: 'org-b' }))
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({ org_id: 'org-a' }))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('EMBED_ORG_MISMATCH')
    expect(getBomMultitableContext).not.toHaveBeenCalled()
    expect(jtiMocks.consume).not.toHaveBeenCalled()
  })

  it('a token without org_id -> 403 fail-closed, BOM never queried', async () => {
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext }))
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({ org_id: undefined }))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('EMBED_ORG_MISMATCH')
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })

  it('absent or ambiguous served org -> 403 fail-closed, BOM never queried', async () => {
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext, org: undefined }))
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('EMBED_ORG_MISMATCH')
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })

  it('an adapter without the served-org surface -> 503 (never read without proving the org)', async () => {
    const adapter: Record<string, unknown> = fullAdapter()
    delete adapter.getEffectiveOrgId
    dsMocks.getDataSource.mockReturnValue(adapter)
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(503)
    expect(jtiMocks.consume).not.toHaveBeenCalled()
  })

  it('END-TO-END (real adapter): hand-set x-org-id org-a, token org-b in the same tenant -> 403, BOM never queried', async () => {
    for (const k of ['PLM_TENANT_ID', 'PLM_ORG_ID', 'PLM_BASE_URL', 'PLM_URL']) delete process.env[k]
    const adapter = new PLMAdapter(
      { get: async () => undefined } as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      { id: DS_ID, name: 'PLM', type: 'plm', connection: { url: '', headers: { 'x-tenant-id': 'default', 'x-org-id': 'org-a' } } } as never,
    )
    await adapter.connect()
    const spy = vi.spyOn(adapter, 'getBomMultitableContext')
    dsMocks.getDataSource.mockReturnValue(adapter)
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({ org_id: 'org-b' }))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('EMBED_ORG_MISMATCH')
    expect(spy).not.toHaveBeenCalled()
    expect(jtiMocks.consume).not.toHaveBeenCalled()
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
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({ tenant_id: 'tenant-b' }))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('EMBED_TENANT_MISMATCH')
    expect(spy).not.toHaveBeenCalled()
    // ordering: the jti is consumed only AFTER the tenant check passes -> a 403 here never consumes it
    expect(jtiMocks.consume).not.toHaveBeenCalled()
  })

  // --- single-use jti consume (slice B / B1): consume AFTER all checks, BEFORE the BOM query ---

  it('first use: consumes the (scoped) jti and serves -> 200', async () => {
    const getBomMultitableContext = vi.fn().mockResolvedValue({ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: CONTEXT })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext }))
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({ jti: 'j-abc' }))
    expect(res.status).toBe(200)
    expect(jtiMocks.consume).toHaveBeenCalledWith('plm-embed:jti:j-abc', expect.any(Number))
    expect(getBomMultitableContext).toHaveBeenCalledWith('P1')
  })

  it('replay (jti already consumed) -> 401 EMBED_TOKEN_REPLAYED, BOM never queried', async () => {
    jtiMocks.consume.mockResolvedValue(false)
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext }))
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('EMBED_TOKEN_REPLAYED')
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })

  it('shared replay store unavailable -> 503 fail-closed, BOM never queried', async () => {
    jtiMocks.consume.mockRejectedValue(new Error('redis down'))
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext }))
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint())
    expect(res.status).toBe(503)
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })

  it('a token with no jti -> 401 (cannot be tracked for single-use)', async () => {
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext }))
    const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({ jti: undefined }))
    expect(res.status).toBe(401)
    expect(jtiMocks.consume).not.toHaveBeenCalled()
    expect(getBomMultitableContext).not.toHaveBeenCalled()
  })

  // Managed success, native-vs-Meta identity, and real cookie verification are PostgreSQL tests.
  // These cases stop before jwtAuthMiddleware, or they reach it only with a cookie that fails verify.

  it.each([undefined, '', 'false', 'TRUE', '1', 'true'])(
    'proven unbound token-only read stays on the adapter when the managed flag is %s',
    async (flag) => {
      if (flag === undefined) delete process.env.PLM_MANAGED_COMPANION_ENABLED
      else process.env.PLM_MANAGED_COMPANION_ENABLED = flag
      const getBomMultitableContext = vi.fn().mockResolvedValue({ feature_key: 'bom_multitable', entitled: true, upgrade: { available: false }, context: CONTEXT })
      dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext }))
      const res = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({ jti: `legacy-${String(flag)}` }))
      expect(res.status).toBe(200)
      expect(res.body.data.context).toEqual(CONTEXT)
      expect(res.body.data.part_id).toBe('P1')
      expect(getBomMultitableContext).toHaveBeenCalledWith('P1')
    },
  )

  it('proven unbound refuses Authorization and a managed cookie before the adapter and before jti consume', async () => {
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext }))
    const bearer = await request(pinned.url()).get(URL)
      .set('X-PLM-Embed-Token', mint({ jti: 'unbound-bearer' }))
      .set('Authorization', 'Bearer same-user')
    expect(bearer.status).toBe(403)
    expect(bearer.body.error.code).toBe('PLM_MANAGED_BEARER_REFUSED')
    const cookie = await request(pinned.url()).get(URL)
      .set('X-PLM-Embed-Token', mint({ jti: 'unbound-cookie' }))
      .set('Cookie', `${MANAGED_SESSION_COOKIE}=present`)
    expect(cookie.status).toBe(403)
    expect(cookie.body.error.code).toBe('PLM_MANAGED_READ_REFUSED')
    const mixed = await request(pinned.url()).get(URL)
      .set('X-PLM-Embed-Token', mint({ jti: 'unbound-mixed' }))
      .set('Authorization', 'Bearer same-user')
      .set('Cookie', `${MANAGED_SESSION_COOKIE}=present`)
    expect(mixed.status).toBe(403)
    expect(mixed.body.error.code).toBe('PLM_MANAGED_BEARER_REFUSED')
    expect(getBomMultitableContext).not.toHaveBeenCalled()
    expect(jtiMocks.consume).not.toHaveBeenCalled()
    expect(dsMocks.getDataSource).not.toHaveBeenCalled()
  })

  it('schema-missing and unavailable stay closed and never reach the adapter', async () => {
    const getBomMultitableContext = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getBomMultitableContext }))
    setManagedBindingReaderForTests(async () => ({ kind: 'schema-missing' }))
    const missing = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({ jti: 'schema' }))
    expect(missing.status).toBe(403)
    expect(missing.body.error.code).toBe('PLM_MANAGED_SCHEMA_MISSING')
    setManagedBindingReaderForTests(async () => ({ kind: 'unavailable' }))
    const unavailable = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({ jti: 'unavailable' }))
    expect(unavailable.status).toBe(403)
    expect(unavailable.body.error.code).toBe('PLM_MANAGED_BINDING_UNAVAILABLE')
    expect(getBomMultitableContext).not.toHaveBeenCalled()
    expect(jtiMocks.consume).not.toHaveBeenCalled()
    expect(dsMocks.getDataSource).not.toHaveBeenCalled()
  })

  it.each([undefined, '', 'false', 'TRUE', '1'])(
    'a bound source with flag %s refuses before middleware and does not call the adapter',
    async (flag) => {
      if (flag === undefined) delete process.env.PLM_MANAGED_COMPANION_ENABLED
      else process.env.PLM_MANAGED_COMPANION_ENABLED = flag
      setManagedBindingReaderForTests(async () => ({ kind: 'bound', row: BOUND_ROW }))
      const res = await request(pinned.url()).get(URL)
        .set('X-PLM-Embed-Token', mint({ jti: `bound-flag-${String(flag)}` }))
        .set('Cookie', `${MANAGED_SESSION_COOKIE}=not-a-jwt`)
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('PLM_MANAGED_DISABLED')
      expect(jtiMocks.consume).not.toHaveBeenCalled()
      expect(dsMocks.getDataSource).not.toHaveBeenCalled()
    },
  )

  it('a bound source refuses token-only, ordinary bearer, and mixed credentials before jti consume', async () => {
    setManagedBindingReaderForTests(async () => ({ kind: 'bound', row: BOUND_ROW }))
    process.env.PLM_MANAGED_COMPANION_ENABLED = 'true'
    const tokenOnly = await request(pinned.url()).get(URL).set('X-PLM-Embed-Token', mint({ jti: 'bound-token-only' }))
    expect(tokenOnly.status).toBe(403)
    expect(tokenOnly.body.error.code).toBe('PLM_MANAGED_SESSION_REQUIRED')
    const bearer = await request(pinned.url()).get(URL)
      .set('X-PLM-Embed-Token', mint({ jti: 'bound-bearer' }))
      .set('Authorization', 'Bearer same-user')
    expect(bearer.status).toBe(403)
    expect(bearer.body.error.code).toBe('PLM_MANAGED_BEARER_REFUSED')
    const mixed = await request(pinned.url()).get(URL)
      .set('X-PLM-Embed-Token', mint({ jti: 'bound-mixed' }))
      .set('Authorization', 'Bearer same-user')
      .set('Cookie', `${MANAGED_SESSION_COOKIE}=not-a-jwt`)
    expect(mixed.status).toBe(403)
    expect(mixed.body.error.code).toBe('PLM_MANAGED_BEARER_REFUSED')
    expect(jtiMocks.consume).not.toHaveBeenCalled()
    expect(dsMocks.getDataSource).not.toHaveBeenCalled()
  })

  it('a bound source with the flag on and an unverified cookie is 401 from jwtAuthMiddleware and does not consume jti', async () => {
    setManagedBindingReaderForTests(async () => ({ kind: 'bound', row: BOUND_ROW }))
    process.env.PLM_MANAGED_COMPANION_ENABLED = 'true'
    const res = await request(pinned.url()).get(URL)
      .set('X-PLM-Embed-Token', mint({ jti: 'bound-garbage-cookie' }))
      .set('Cookie', `${MANAGED_SESSION_COOKIE}=not-a-jwt`)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHORIZED')
    expect(res.headers.location).toBeUndefined()
    expect(jtiMocks.consume).not.toHaveBeenCalled()
    expect(dsMocks.getDataSource).not.toHaveBeenCalled()
  })
})
