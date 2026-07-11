import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Controllable DataSourceManager mock.
const dsMocks = vi.hoisted(() => ({ getDataSource: vi.fn() }))

// Controllable single-use jti store -- same shared store the read relay uses.
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
import plmEmbedDiscussionWriteRouter from '../../src/routes/plm-embed-discussion'

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

const SESSION_TOKEN = 'discussion-session-secret-abc123'
const THREAD_DETAIL = {
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
  comments: [],
}

function credentialResult(overrides: Record<string, unknown> = {}) {
  return {
    data: [{ access_token: SESSION_TOKEN, token_type: 'bearer', expires_in: 300, aud: 'discussion', ...overrides }],
    metadata: { totalCount: 1 },
  }
}

// A COMPLETE PlmDiscussionWriteAdapter mock (exchange + all 6 write methods + tenant/connect
// surface). Each write method defaults to returning THREAD_DETAIL wrapped success; override any
// via `opts` to simulate a provider error / different payload.
function fullAdapter(opts: {
  exchangeDiscussionSession?: ReturnType<typeof vi.fn>
  createDiscussionThread?: ReturnType<typeof vi.fn>
  addDiscussionComment?: ReturnType<typeof vi.fn>
  editDiscussionComment?: ReturnType<typeof vi.fn>
  deleteDiscussionComment?: ReturnType<typeof vi.fn>
  resolveDiscussionThread?: ReturnType<typeof vi.fn>
  reopenDiscussionThread?: ReturnType<typeof vi.fn>
  tenant?: string | undefined
  connected?: boolean
  connect?: ReturnType<typeof vi.fn>
} = {}) {
  const writeOk = () => vi.fn().mockResolvedValue({ data: [THREAD_DETAIL], metadata: { totalCount: 1 } })
  return {
    exchangeDiscussionSession: opts.exchangeDiscussionSession ?? vi.fn().mockResolvedValue(credentialResult()),
    createDiscussionThread: opts.createDiscussionThread ?? writeOk(),
    addDiscussionComment: opts.addDiscussionComment ?? writeOk(),
    editDiscussionComment: opts.editDiscussionComment ?? writeOk(),
    deleteDiscussionComment: opts.deleteDiscussionComment ?? writeOk(),
    resolveDiscussionThread: opts.resolveDiscussionThread ?? writeOk(),
    reopenDiscussionThread: opts.reopenDiscussionThread ?? writeOk(),
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
  app.use(plmEmbedDiscussionWriteRouter())
  return app
}

const THREADS_URL = '/api/plm-embed/discussion/threads'
const COMMENTS_URL = (threadId = 't1') => `/api/plm-embed/discussion/threads/${threadId}/comments`
const COMMENT_URL = (threadId = 't1', commentId = 'c1') => `/api/plm-embed/discussion/threads/${threadId}/comments/${commentId}`
const RESOLVE_URL = (threadId = 't1') => `/api/plm-embed/discussion/threads/${threadId}/resolve`
const REOPEN_URL = (threadId = 't1') => `/api/plm-embed/discussion/threads/${threadId}/reopen`

const CREATE_BODY = { target_type: 'item', target_id: 'P1', body: 'hello' }

describe('PLM embed discussion WRITE relay (Discussion Phase-3 write-relay, Option A)', () => {
  beforeEach(() => {
    dsMocks.getDataSource.mockReset()
    jtiMocks.consume.mockReset()
    jtiMocks.consume.mockResolvedValue(true) // default: first use
    process.env.YUANTUS_EMBED_PUBLIC_KEY = PUB_B64
    process.env.YUANTUS_EMBED_KEY_ID = KID
    process.env.PLM_EMBED_AUDIENCE = AUD
    process.env.PLM_EMBED_ALLOWED_ORIGINS = ORIGIN
    process.env.PLM_EMBED_DATA_SOURCE_ID = DS_ID
  })
  afterEach(() => {
    for (const k of ['YUANTUS_EMBED_PUBLIC_KEYS', 'YUANTUS_EMBED_PUBLIC_KEY', 'YUANTUS_EMBED_KEY_ID', 'PLM_EMBED_AUDIENCE', 'PLM_EMBED_ALLOWED_ORIGINS', 'PLM_EMBED_DATA_SOURCE_ID']) delete process.env[k]
  })

  it('the write routes are whitelisted from the global session gate (same prefix as the read relay)', () => {
    expect(isWhitelisted(THREADS_URL)).toBe(true)
    expect(isWhitelisted(COMMENTS_URL())).toBe(true)
    expect(isWhitelisted(RESOLVE_URL())).toBe(true)
  })

  // --- happy path + no-credential-leak (load-bearing security test) ---

  it('happy write: create a thread -> 200, exchange used, credential NEVER in the response body or headers', async () => {
    const createDiscussionThread = vi.fn().mockResolvedValue({ data: [THREAD_DETAIL], metadata: { totalCount: 1 } })
    const exchangeDiscussionSession = vi.fn().mockResolvedValue(credentialResult())
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ createDiscussionThread, exchangeDiscussionSession }))

    const res = await request(buildApp()).post(THREADS_URL).set('X-PLM-Embed-Token', mint()).send(CREATE_BODY)

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual(THREAD_DETAIL)
    expect(exchangeDiscussionSession).toHaveBeenCalledTimes(1)
    expect(createDiscussionThread).toHaveBeenCalledWith(SESSION_TOKEN, expect.objectContaining({ target_type: 'item', target_id: 'P1', body: 'hello' }))

    // The credential must not leak anywhere in the response.
    const serializedBody = JSON.stringify(res.body)
    expect(serializedBody).not.toContain(SESSION_TOKEN)
    expect(serializedBody).not.toContain('access_token')
    const serializedHeaders = JSON.stringify(res.headers)
    expect(serializedHeaders).not.toContain(SESSION_TOKEN)
  })

  it('NO CACHING: two sequential requests (two fresh embed tokens) both call exchangeDiscussionSession -- no cred is reused/cached', async () => {
    const exchangeDiscussionSession = vi.fn().mockResolvedValue(credentialResult())
    const createDiscussionThread = vi.fn().mockResolvedValue({ data: [THREAD_DETAIL], metadata: { totalCount: 1 } })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ exchangeDiscussionSession, createDiscussionThread }))

    const app = buildApp()
    const res1 = await request(app).post(THREADS_URL).set('X-PLM-Embed-Token', mint()).send(CREATE_BODY)
    const res2 = await request(app).post(THREADS_URL).set('X-PLM-Embed-Token', mint()).send(CREATE_BODY)

    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    expect(exchangeDiscussionSession).toHaveBeenCalledTimes(2) // fired on BOTH, not cached after the first
    // each exchange used a DIFFERENT raw token (distinct jti-bearing mints), never a reused value
    const [firstArg] = exchangeDiscussionSession.mock.calls[0]
    const [secondArg] = exchangeDiscussionSession.mock.calls[1]
    expect(firstArg).not.toEqual(secondArg)
  })

  // --- exchange failure -> uniform 401 ---

  it('exchange failure (adapter returns error) -> 401, write method never called', async () => {
    const exchangeDiscussionSession = vi.fn().mockResolvedValue({ data: [], error: new Error('exchange rejected') })
    const createDiscussionThread = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ exchangeDiscussionSession, createDiscussionThread }))

    const res = await request(buildApp()).post(THREADS_URL).set('X-PLM-Embed-Token', mint()).send(CREATE_BODY)

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('EMBED_SESSION_EXCHANGE_FAILED')
    expect(createDiscussionThread).not.toHaveBeenCalled()
  })

  it('exchange returns no data (dark-flag-off shape) -> the SAME uniform 401 as a bad token (no oracle)', async () => {
    const exchangeDiscussionSession = vi.fn().mockResolvedValue({ data: [] })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ exchangeDiscussionSession }))

    const res = await request(buildApp()).post(THREADS_URL).set('X-PLM-Embed-Token', mint()).send(CREATE_BODY)

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('EMBED_SESSION_EXCHANGE_FAILED')
  })

  // --- provider write errors propagated ---

  it('provider 403 (write-back entitlement denied) is propagated as 403', async () => {
    const createDiscussionThread = vi.fn().mockResolvedValue({ data: [], error: providerError(403) })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ createDiscussionThread }))

    const res = await request(buildApp()).post(THREADS_URL).set('X-PLM-Embed-Token', mint()).send(CREATE_BODY)

    expect(res.status).toBe(403)
    expect(res.body.ok).toBe(false)
  })

  it('provider 404 (unknown thread) is propagated as 404 on the comment route', async () => {
    const addDiscussionComment = vi.fn().mockResolvedValue({ data: [], error: providerError(404) })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ addDiscussionComment }))

    const res = await request(buildApp()).post(COMMENTS_URL('missing-thread')).set('X-PLM-Embed-Token', mint()).send({ body: 'hi' })

    expect(res.status).toBe(404)
  })

  it('provider 422 (validation failure) is propagated as 422', async () => {
    const editDiscussionComment = vi.fn().mockResolvedValue({ data: [], error: providerError(422) })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ editDiscussionComment }))

    const res = await request(buildApp()).patch(COMMENT_URL()).set('X-PLM-Embed-Token', mint()).send({ body: 'edited' })

    expect(res.status).toBe(422)
  })

  it('a network-level / unrecognized provider failure degrades to 502, never a silent 200', async () => {
    const resolveDiscussionThread = vi.fn().mockResolvedValue({ data: [], error: new Error('fetch failed') })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ resolveDiscussionThread }))

    const res = await request(buildApp()).post(RESOLVE_URL()).set('X-PLM-Embed-Token', mint()).send({})

    expect(res.status).toBe(502)
  })

  // --- jti single-use / Option A ---

  it('jti reuse (already consumed) -> 401 EMBED_TOKEN_REPLAYED, exchange never attempted', async () => {
    jtiMocks.consume.mockResolvedValue(false)
    const exchangeDiscussionSession = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ exchangeDiscussionSession }))

    const res = await request(buildApp()).post(THREADS_URL).set('X-PLM-Embed-Token', mint()).send(CREATE_BODY)

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('EMBED_TOKEN_REPLAYED')
    expect(exchangeDiscussionSession).not.toHaveBeenCalled()
  })

  it('a token with no jti -> 401, exchange never attempted', async () => {
    const exchangeDiscussionSession = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ exchangeDiscussionSession }))

    const res = await request(buildApp()).post(THREADS_URL).set('X-PLM-Embed-Token', mint({ jti: undefined })).send(CREATE_BODY)

    expect(res.status).toBe(401)
    expect(jtiMocks.consume).not.toHaveBeenCalled()
    expect(exchangeDiscussionSession).not.toHaveBeenCalled()
  })

  // --- feature_key / origin / tenant guards (shared with the read relay) ---

  it('a token scoped to a DIFFERENT feature -> 403, nothing downstream called', async () => {
    const exchangeDiscussionSession = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ exchangeDiscussionSession }))

    const res = await request(buildApp()).post(THREADS_URL).set('X-PLM-Embed-Token', mint({ feature_key: 'approval_automation' })).send(CREATE_BODY)

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('EMBED_FEATURE_MISMATCH')
    expect(exchangeDiscussionSession).not.toHaveBeenCalled()
  })

  it('embed_origin not in the allowlist -> 403', async () => {
    dsMocks.getDataSource.mockReturnValue(fullAdapter())
    const res = await request(buildApp()).post(THREADS_URL).set('X-PLM-Embed-Token', mint({ embed_origin: 'https://evil.example.com' })).send(CREATE_BODY)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('EMBED_ORIGIN_NOT_ALLOWED')
  })

  it('token tenant does not match the served tenant -> 403, jti never consumed, exchange never attempted', async () => {
    const exchangeDiscussionSession = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ tenant: 'tenant-b', exchangeDiscussionSession }))

    const res = await request(buildApp()).post(THREADS_URL).set('X-PLM-Embed-Token', mint({ tenant_id: 'tenant-a' })).send(CREATE_BODY)

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('EMBED_TENANT_MISMATCH')
    expect(jtiMocks.consume).not.toHaveBeenCalled()
    expect(exchangeDiscussionSession).not.toHaveBeenCalled()
  })

  it('no embed token -> 401 (embedTokenAuth itself)', async () => {
    const res = await request(buildApp()).post(THREADS_URL).send(CREATE_BODY)
    expect(res.status).toBe(401)
  })

  // --- body validation / whitelisting ---

  it('thread create missing target_type -> 422, nothing downstream called', async () => {
    const exchangeDiscussionSession = vi.fn()
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ exchangeDiscussionSession }))
    const res = await request(buildApp()).post(THREADS_URL).set('X-PLM-Embed-Token', mint()).send({ target_id: 'P1', body: 'hi' })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('EMBED_DISCUSSION_INVALID_BODY')
    expect(exchangeDiscussionSession).not.toHaveBeenCalled()
  })

  it('thread create with an unknown target_type -> 422', async () => {
    dsMocks.getDataSource.mockReturnValue(fullAdapter())
    const res = await request(buildApp()).post(THREADS_URL).set('X-PLM-Embed-Token', mint()).send({ target_type: 'bogus', target_id: 'P1', body: 'hi' })
    expect(res.status).toBe(422)
  })

  it('comment missing body -> 422', async () => {
    dsMocks.getDataSource.mockReturnValue(fullAdapter())
    const res = await request(buildApp()).post(COMMENTS_URL()).set('X-PLM-Embed-Token', mint()).send({})
    expect(res.status).toBe(422)
  })

  it('edit comment missing body -> 422', async () => {
    dsMocks.getDataSource.mockReturnValue(fullAdapter())
    const res = await request(buildApp()).patch(COMMENT_URL()).set('X-PLM-Embed-Token', mint()).send({})
    expect(res.status).toBe(422)
  })

  // --- per-route dispatch smoke tests (each route calls the RIGHT adapter method with the RIGHT args) ---

  it('delete comment: DELETE dispatches to deleteDiscussionComment with (token, threadId, commentId)', async () => {
    const deleteDiscussionComment = vi.fn().mockResolvedValue({ data: [THREAD_DETAIL], metadata: { totalCount: 1 } })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ deleteDiscussionComment }))

    const res = await request(buildApp()).delete(COMMENT_URL('t9', 'c9')).set('X-PLM-Embed-Token', mint())

    expect(res.status).toBe(200)
    expect(deleteDiscussionComment).toHaveBeenCalledWith(SESSION_TOKEN, 't9', 'c9')
  })

  it('resolve: POST .../resolve dispatches to resolveDiscussionThread with an optional transition body', async () => {
    const resolveDiscussionThread = vi.fn().mockResolvedValue({ data: [{ ...THREAD_DETAIL, status: 'resolved' }], metadata: { totalCount: 1 } })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ resolveDiscussionThread }))

    const res = await request(buildApp()).post(RESOLVE_URL('t9')).set('X-PLM-Embed-Token', mint()).send({ comment: 'done' })

    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('resolved')
    expect(resolveDiscussionThread).toHaveBeenCalledWith(SESSION_TOKEN, 't9', expect.objectContaining({ comment: 'done' }))
  })

  it('reopen: POST .../reopen dispatches to reopenDiscussionThread with an empty transition when body omitted', async () => {
    const reopenDiscussionThread = vi.fn().mockResolvedValue({ data: [THREAD_DETAIL], metadata: { totalCount: 1 } })
    dsMocks.getDataSource.mockReturnValue(fullAdapter({ reopenDiscussionThread }))

    const res = await request(buildApp()).post(REOPEN_URL('t9')).set('X-PLM-Embed-Token', mint())

    expect(res.status).toBe(200)
    expect(reopenDiscussionThread).toHaveBeenCalledWith(SESSION_TOKEN, 't9', {})
  })
})
