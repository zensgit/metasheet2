import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

// Controllable DataSourceManager mock.
const dsMocks = vi.hoisted(() => ({ getDataSource: vi.fn() }))

// Controllable single-use jti store -- the SAME shared store the write relay uses.
const jtiMocks = vi.hoisted(() => ({ consume: vi.fn() }))
vi.mock('../../src/auth/embed-jti-store', () => ({
  consumeEmbedJti: (...args: unknown[]) => jtiMocks.consume(...args),
  embedJtiKey: (scope: { jti?: unknown }) => `plm-embed:jti:${String(scope.jti)}`,
}))

vi.mock('../../src/db/sharding/tenant-context', () => ({ extractTenantFromHeaders: () => undefined }))
vi.mock('../../src/metrics/metrics', () => ({ metrics: new Proxy({}, { get: () => ({ inc: () => {} }) }) }))
vi.mock('../../src/auth/AuthService', () => ({ authService: {} }))
vi.mock('../../src/routes/data-sources', () => ({
  getDataSourceManager: () => ({ getDataSource: dsMocks.getDataSource }),
}))

import { isWhitelisted } from '../../src/auth/jwt-middleware'
import plmEmbedDiscussionReadRouter from '../../src/routes/plm-embed-discussion-read'

const KID = 'embed-1'
const AUD = 'metasheet2.embed'
const ORIGIN = 'https://plm.example.com'
const DS_ID = 'plm-ds'

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const PUB_B64 = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64')

let jtiCounter = 0
function mint(overrides: Record<string, unknown> = {}, kid = KID): string {
  const now = Math.floor(Date.now() / 1000)
  jtiCounter += 1
  const claims = {
    sub: '7',
    tenant_id: 'default',
    part_id: 'P1',
    feature_key: 'bom_multitable',
    aud: AUD,
    embed_origin: ORIGIN,
    iat: now,
    exp: now + 120,
    jti: `j-${jtiCounter}`,
    typ: 'embed',
    ...overrides,
  }
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const sig = crypto.sign(null, Buffer.from(`${header}.${payload}`, 'ascii'), privateKey).toString('base64url')
  return `${header}.${payload}.${sig}`
}

const READ_TOKEN = 'discussion-read-session-secret-xyz789'
const THREAD_SUMMARY = {
  id: 't1',
  target_type: 'item',
  target_id: 'P1',
  title: 'Discuss',
  status: 'open',
  created_by_id: 1,
  created_at: '2026-07-11T00:00:00Z',
  resolved_by_id: null,
  resolved_at: null,
  last_comment_at: '2026-07-11T00:00:00Z',
  comment_count: 1,
  anchor: null,
}
const THREADS_LIST = { threads: [THREAD_SUMMARY], next_cursor: null }
const THREAD_DETAIL = { ...THREAD_SUMMARY, comments: [] }

function credentialResult(overrides: Record<string, unknown> = {}) {
  return {
    data: [{ access_token: READ_TOKEN, token_type: 'bearer', expires_in: 300, aud: 'discussion', ...overrides }],
    metadata: { totalCount: 1 },
  }
}

// A COMPLETE PlmDiscussionReadAdapter mock (exchange + the two read methods + tenant/connect
// surface). Each read method defaults to a wrapped success; override any via `opts` to simulate a
// provider error / different payload.
function fullAdapter(opts: {
  exchangeDiscussionReadSession?: ReturnType<typeof vi.fn>
  getDiscussionsWithReadToken?: ReturnType<typeof vi.fn>
  getDiscussionThreadWithReadToken?: ReturnType<typeof vi.fn>
  tenant?: string | undefined
  connected?: boolean
  connect?: ReturnType<typeof vi.fn>
} = {}) {
  return {
    exchangeDiscussionReadSession: opts.exchangeDiscussionReadSession ?? vi.fn().mockResolvedValue(credentialResult()),
    getDiscussionsWithReadToken: opts.getDiscussionsWithReadToken ?? vi.fn().mockResolvedValue({ data: [THREADS_LIST], metadata: { totalCount: 1 } }),
    getDiscussionThreadWithReadToken: opts.getDiscussionThreadWithReadToken ?? vi.fn().mockResolvedValue({ data: [THREAD_DETAIL], metadata: { totalCount: 1 } }),
    getEffectiveTenantId: () => ('tenant' in opts ? opts.tenant : 'default'),
    isConnected: () => opts.connected ?? true,
    connect: opts.connect ?? vi.fn().mockResolvedValue(undefined),
  }
}

function providerError(status: number, message = 'rejected') {
  return Object.assign(new Error(message), { response: { status, data: { detail: message } } })
}

function buildApp() {
  const app = express()
  app.use(express.json())
  // Reproduce the REAL global gate (index.ts): whitelisted -> through; else /api/* needs the
  // session JWT (stood in here by a 401, exactly what jwtAuthMiddleware does on a missing token).
  app.use((req, res, next) => {
    if (isWhitelisted(req.path)) return next()
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED' } })
    return next()
  })
  app.use(plmEmbedDiscussionReadRouter())
  return app
}

const THREADS_URL = '/api/plm-embed/discussion/threads'
const THREAD_URL = (threadId = 't1') => `/api/plm-embed/discussion/threads/${threadId}`

describe('PLM embed discussion READ relay (Discussion read-auth line, sub-slice 2)', () => {
  const pinned = usePinnedServer()

  beforeEach(() => {
    dsMocks.getDataSource.mockReset()
    jtiMocks.consume.mockReset()
    jtiMocks.consume.mockResolvedValue(true) // default: first use
    process.env.YUANTUS_EMBED_PUBLIC_KEY = PUB_B64
    process.env.YUANTUS_EMBED_KEY_ID = KID
    process.env.PLM_EMBED_AUDIENCE = AUD
    process.env.PLM_EMBED_ALLOWED_ORIGINS = ORIGIN
    process.env.PLM_EMBED_DATA_SOURCE_ID = DS_ID
    pinned.setApp(buildApp())
  })
  afterEach(() => {
    for (const k of ['YUANTUS_EMBED_PUBLIC_KEYS', 'YUANTUS_EMBED_PUBLIC_KEY', 'YUANTUS_EMBED_KEY_ID', 'PLM_EMBED_AUDIENCE', 'PLM_EMBED_ALLOWED_ORIGINS', 'PLM_EMBED_DATA_SOURCE_ID']) delete process.env[k]
  })

  it('the read routes are whitelisted from the global session gate (same prefix as the write relay)', () => {
    expect(isWhitelisted(THREADS_URL)).toBe(true)
    expect(isWhitelisted(THREAD_URL())).toBe(true)
  })

  // --- happy path + no-credential-leak (load-bearing security tests) ---

  it('happy list: returns threads, exchange used, read credential NEVER in the response body or headers', async () => {
    const getDiscussionsWithReadToken = vi.fn().mockResolvedValue({ data: [THREADS_LIST], metadata: { totalCount: 1 } })
    const exchangeDiscussionReadSession = vi.fn().mockResolvedValue(credentialResult())
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getDiscussionsWithReadToken, exchangeDiscussionReadSession }))

    const res = await request(pinned.url()).get(THREADS_URL).set('X-PLM-Embed-Token', mint())

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual(THREADS_LIST)
    expect(exchangeDiscussionReadSession).toHaveBeenCalledTimes(1)
    expect(getDiscussionsWithReadToken).toHaveBeenCalledWith(READ_TOKEN, { targetType: 'item', targetId: 'P1' })

    const serializedBody = JSON.stringify(res.body)
    expect(serializedBody).not.toContain(READ_TOKEN)
    expect(serializedBody).not.toContain('access_token')
    const serializedHeaders = JSON.stringify(res.headers)
    expect(serializedHeaders).not.toContain(READ_TOKEN)
  })

  it('happy detail: returns the thread, read credential NEVER in the response body or headers', async () => {
    const getDiscussionThreadWithReadToken = vi.fn().mockResolvedValue({ data: [THREAD_DETAIL], metadata: { totalCount: 1 } })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getDiscussionThreadWithReadToken }))

    const res = await request(pinned.url()).get(THREAD_URL('t1')).set('X-PLM-Embed-Token', mint())

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual(THREAD_DETAIL)
    expect(getDiscussionThreadWithReadToken).toHaveBeenCalledWith(READ_TOKEN, 't1')

    const serializedBody = JSON.stringify(res.body)
    expect(serializedBody).not.toContain(READ_TOKEN)
    expect(serializedBody).not.toContain('access_token')
  })

  it('NO CACHING: two sequential list requests (two fresh embed tokens) both call exchangeDiscussionReadSession with THEIR OWN raw token -- no cred is reused/cached', async () => {
    const exchangeDiscussionReadSession = vi.fn().mockResolvedValue(credentialResult())
    const getDiscussionsWithReadToken = vi.fn().mockResolvedValue({ data: [THREADS_LIST], metadata: { totalCount: 1 } })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ exchangeDiscussionReadSession, getDiscussionsWithReadToken }))

    pinned.setApp(buildApp())
    const token1 = mint()
    const token2 = mint()
    const res1 = await request(pinned.url()).get(THREADS_URL).set('X-PLM-Embed-Token', token1)
    const res2 = await request(pinned.url()).get(THREADS_URL).set('X-PLM-Embed-Token', token2)

    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    expect(exchangeDiscussionReadSession).toHaveBeenCalledTimes(2) // fired on BOTH, not cached after the first
    expect(exchangeDiscussionReadSession).toHaveBeenNthCalledWith(1, token1)
    expect(exchangeDiscussionReadSession).toHaveBeenNthCalledWith(2, token2)
    expect(token1).not.toEqual(token2)
  })

  // --- exchange failure -> uniform 401 ---

  it('exchange failure (adapter returns error) -> 401, read method never called', async () => {
    const exchangeDiscussionReadSession = vi.fn().mockResolvedValue({ data: [], error: new Error('exchange rejected') })
    const getDiscussionsWithReadToken = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ exchangeDiscussionReadSession, getDiscussionsWithReadToken }))

    const res = await request(pinned.url()).get(THREADS_URL).set('X-PLM-Embed-Token', mint())

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('EMBED_SESSION_EXCHANGE_FAILED')
    expect(getDiscussionsWithReadToken).not.toHaveBeenCalled()
  })

  it('exchange returns no data (dark-flag-off shape) -> the SAME uniform 401 as a bad token (no oracle)', async () => {
    const exchangeDiscussionReadSession = vi.fn().mockResolvedValue({ data: [] })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ exchangeDiscussionReadSession }))

    const res = await request(pinned.url()).get(THREADS_URL).set('X-PLM-Embed-Token', mint())

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('EMBED_SESSION_EXCHANGE_FAILED')
  })

  // --- provider read errors propagated (no-leak) ---

  it('provider 404 (unreadable/unbound target) on the list route is propagated as 404, no-leak', async () => {
    // A distinctive provider-internal message (NOT the relay's own generic wording, which itself
    // legitimately contains the word "rejected") -- proves the raw upstream detail never echoes.
    const getDiscussionsWithReadToken = vi.fn().mockResolvedValue({ data: [], error: providerError(404, 'sensitive-provider-detail-xyz') })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getDiscussionsWithReadToken }))

    const res = await request(pinned.url()).get(THREADS_URL).set('X-PLM-Embed-Token', mint())

    expect(res.status).toBe(404)
    expect(res.body.ok).toBe(false)
    expect(JSON.stringify(res.body)).not.toContain('sensitive-provider-detail-xyz')
  })

  it('provider 404 (unknown thread / not bound to this part) on the detail route is propagated as 404, no-leak', async () => {
    const getDiscussionThreadWithReadToken = vi.fn().mockResolvedValue({ data: [], error: providerError(404) })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getDiscussionThreadWithReadToken }))

    const res = await request(pinned.url()).get(THREAD_URL('missing-thread')).set('X-PLM-Embed-Token', mint())

    expect(res.status).toBe(404)
  })

  it('a network-level / unrecognized provider failure degrades to 502, never a silent 200', async () => {
    const getDiscussionsWithReadToken = vi.fn().mockResolvedValue({ data: [], error: new Error('fetch failed') })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getDiscussionsWithReadToken }))

    const res = await request(pinned.url()).get(THREADS_URL).set('X-PLM-Embed-Token', mint())

    expect(res.status).toBe(502)
  })

  // --- jti single-use / shared store with the write relay ---

  it('jti reuse (already consumed) -> 401 EMBED_TOKEN_REPLAYED, exchange never attempted', async () => {
    jtiMocks.consume.mockResolvedValue(false)
    const exchangeDiscussionReadSession = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ exchangeDiscussionReadSession }))

    const res = await request(pinned.url()).get(THREADS_URL).set('X-PLM-Embed-Token', mint())

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('EMBED_TOKEN_REPLAYED')
    expect(exchangeDiscussionReadSession).not.toHaveBeenCalled()
  })

  it('a token with no jti -> 401, jti store never consulted, exchange never attempted', async () => {
    const exchangeDiscussionReadSession = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ exchangeDiscussionReadSession }))

    const res = await request(pinned.url()).get(THREADS_URL).set('X-PLM-Embed-Token', mint({ jti: undefined }))

    expect(res.status).toBe(401)
    expect(jtiMocks.consume).not.toHaveBeenCalled()
    expect(exchangeDiscussionReadSession).not.toHaveBeenCalled()
  })

  it('an already-expired embed token -> 401 (rejected fail-closed before any guard runs), read method never called', async () => {
    // verifyEmbedToken itself rejects `now > exp` at the embedTokenAuth middleware layer -- this
    // never even reaches runEmbedReadGuards's own ttl<1 check. Same shape as the write relay: an
    // expired token is a 401 regardless of which layer catches it.
    const exchangeDiscussionReadSession = vi.fn()
    const getDiscussionsWithReadToken = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ exchangeDiscussionReadSession, getDiscussionsWithReadToken }))
    const now = Math.floor(Date.now() / 1000)

    const res = await request(pinned.url()).get(THREADS_URL).set('X-PLM-Embed-Token', mint({ exp: now - 10 }))

    expect(res.status).toBe(401)
    expect(exchangeDiscussionReadSession).not.toHaveBeenCalled()
    expect(getDiscussionsWithReadToken).not.toHaveBeenCalled()
  })

  // --- feature_key / origin / tenant guards (shared with the write relay) ---

  it('a token scoped to a DIFFERENT feature -> 403, nothing downstream called', async () => {
    const exchangeDiscussionReadSession = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ exchangeDiscussionReadSession }))

    const res = await request(pinned.url()).get(THREADS_URL).set('X-PLM-Embed-Token', mint({ feature_key: 'approval_automation' }))

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('EMBED_FEATURE_MISMATCH')
    expect(exchangeDiscussionReadSession).not.toHaveBeenCalled()
  })

  it('embed_origin not in the allowlist -> 403', async () => {
    dsMocks.getDataSource.mockReturnValue(fullAdapter())
    const res = await request(pinned.url()).get(THREADS_URL).set('X-PLM-Embed-Token', mint({ embed_origin: 'https://evil.example.com' }))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('EMBED_ORIGIN_NOT_ALLOWED')
  })

  it('token tenant does not match the served tenant -> 403, jti never consumed, exchange never attempted', async () => {
    const exchangeDiscussionReadSession = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ tenant: 'tenant-b', exchangeDiscussionReadSession }))

    const res = await request(pinned.url()).get(THREADS_URL).set('X-PLM-Embed-Token', mint({ tenant_id: 'tenant-a' }))

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('EMBED_TENANT_MISMATCH')
    expect(jtiMocks.consume).not.toHaveBeenCalled()
    expect(exchangeDiscussionReadSession).not.toHaveBeenCalled()
  })

  it('no embed token -> 401 (embedTokenAuth itself)', async () => {
    const res = await request(pinned.url()).get(THREADS_URL)
    expect(res.status).toBe(401)
  })

  // --- the relay uses the CLAIM's part_id and ignores any client-supplied target ---

  it('list IGNORES a client-supplied target_type/target_id/include_children query and always resolves target from the claim\'s part_id', async () => {
    const getDiscussionsWithReadToken = vi.fn().mockResolvedValue({ data: [THREADS_LIST], metadata: { totalCount: 1 } })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getDiscussionsWithReadToken }))

    const res = await request(pinned.url())
      .get(`${THREADS_URL}?target_type=eco&target_id=EVIL-OTHER-PART&include_children=true&include_resolved=true`)
      .set('X-PLM-Embed-Token', mint({ part_id: 'P1' }))

    expect(res.status).toBe(200)
    // Called with exactly the claim's part_id / a fixed 'item' targetType -- NOT the bogus query values.
    expect(getDiscussionsWithReadToken).toHaveBeenCalledWith(READ_TOKEN, { targetType: 'item', targetId: 'P1' })
    expect(getDiscussionsWithReadToken).not.toHaveBeenCalledWith(READ_TOKEN, expect.objectContaining({ targetId: 'EVIL-OTHER-PART' }))
  })

  it('list with a DIFFERENT embed token part_id resolves target from THAT token\'s part_id, never a query override', async () => {
    const getDiscussionsWithReadToken = vi.fn().mockResolvedValue({ data: [THREADS_LIST], metadata: { totalCount: 1 } })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getDiscussionsWithReadToken }))

    const res = await request(pinned.url())
      .get(`${THREADS_URL}?target_id=someone-elses-part`)
      .set('X-PLM-Embed-Token', mint({ part_id: 'P-mine' }))

    expect(res.status).toBe(200)
    expect(getDiscussionsWithReadToken).toHaveBeenCalledWith(READ_TOKEN, { targetType: 'item', targetId: 'P-mine' })
  })

  // --- per-route dispatch smoke test ---

  it('detail: GET .../threads/:threadId dispatches to getDiscussionThreadWithReadToken with (readToken, threadId)', async () => {
    const getDiscussionThreadWithReadToken = vi.fn().mockResolvedValue({ data: [{ ...THREAD_DETAIL, id: 't9' }], metadata: { totalCount: 1 } })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ getDiscussionThreadWithReadToken }))

    const res = await request(pinned.url()).get(THREAD_URL('t9')).set('X-PLM-Embed-Token', mint())

    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe('t9')
    expect(getDiscussionThreadWithReadToken).toHaveBeenCalledWith(READ_TOKEN, 't9')
  })
})
