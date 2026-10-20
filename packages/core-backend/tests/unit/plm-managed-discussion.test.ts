import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto'
import type { Request } from 'express'

const mocks = vi.hoisted(() => ({ lock: vi.fn(), consume: vi.fn(), query: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ transaction: async (fn: (client: unknown) => unknown) => fn({ query: mocks.query }) }))
vi.mock('../../src/services/plm-managed-bom-authority', () => ({ lockManagedBomAuthority: mocks.lock }))
vi.mock('../../src/auth/embed-jti-store', () => ({ consumeEmbedJti: mocks.consume, embedJtiKey: () => 'owned-jti' }))
import { managedRequestContext } from '../../src/services/plm-managed-request-context'
import { relayManagedDiscussion } from '../../src/services/plm-managed-discussion'

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ format: 'jwk' }).x!
const seen: { url: string; method: string; headers: Record<string, unknown>; body: unknown }[] = []
let server: Server
let base: string
let providerStatus = 200
let redirect = false
let read = false
let visualReply = false
function token(overrides: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'managed-test' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ typ: 'embed', aud: 'metasheet2.embed', sub: '42',
    tenant_id: 'native-tenant', org_id: 'native-org', part_id: 'part', feature_key: 'bom_multitable',
    embed_origin: 'https://meta.example.test', exp: Math.floor(Date.now() / 1000) + 120,
    jti: randomUUID(), ...overrides })).toString('base64url')
  return header + '.' + body + '.' + sign(null, Buffer.from(header + '.' + body), keys.privateKey).toString('base64url')
}
function request(body: unknown = { operation: 'list' }, overrides: Record<string, unknown> = {}) {
  return { body, headers: { 'content-type': 'application/json', origin: 'https://meta.example.test',
    'x-plm-embed-token': token(overrides) } } as Request
}
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    seen.push({ url: req.url!, method: req.method!, headers: req.headers, body: raw ? JSON.parse(raw) : null })
    res.setHeader('Content-Type', 'application/json')
    if (redirect) { res.writeHead(307, { Location: base + '/credential-sink' }); res.end(); return }
    if (req.url?.includes('/auth/embed/')) {
      read = req.url.includes('discussion-read-session')
      res.end(JSON.stringify({ access_token: read ? 'native-discussion-read' : 'native-discussion-write',
        token_type: 'bearer', expires_in: 300, aud: 'discussion' })); return
    }
    res.statusCode = providerStatus
    res.end(JSON.stringify(providerStatus === 200 ? { id: 'native-thread', comments: [{ author_user_id: 42, body: 'text', ...(visualReply ? { markup: { geometry: ['private-visual-marker'] } } : {}) }] }
      : { detail: 'provider-internal-secret' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
})
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
beforeEach(() => {
  vi.unstubAllGlobals()
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('YUANTUS_EMBED_KEY_ID', 'managed-test')
  vi.stubEnv('YUANTUS_EMBED_PUBLIC_KEY', Buffer.from(publicKey, 'base64url').toString('base64'))
  vi.stubEnv('PLM_API_TOKEN', 'shared-credential-must-not-appear')
  seen.length = 0; redirect = false; providerStatus = 200; visualReply = false
  mocks.consume.mockResolvedValue(true)
  mocks.lock.mockResolvedValue({ row: { config: { connection: { url: base },
    options: { apiMode: 'yuantus', tenantId: 'native-tenant', orgId: 'native-org' } }, frozen_origin: base },
    source: { auth_user_id: '42', tenant_id: 'native-tenant', org_id: 'native-org' },
    reg: { origin: 'https://meta.example.test', issuer: base } })
})
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

it('uses a fresh independent read exchange and only its credential on actual HTTP', async () => {
  expect(await relayManagedDiscussion(request(), 'source')).toMatchObject({ id: 'native-thread' })
  expect(seen).toHaveLength(2)
  expect(seen[0].url).toBe('/api/v1/auth/embed/discussion-read-session')
  expect(seen[0].headers.authorization).toBeUndefined()
  expect(seen[1].headers.authorization).toBe('Bearer native-discussion-read')
  expect(seen[1].url).toBe('/api/v1/discussions?target_type=item&target_id=part&include_resolved=true')
  expect(JSON.stringify(seen)).not.toContain('shared-credential-must-not-appear')
})
it('uses the write session engine, preserving the Native author and purpose boundary', async () => {
  const result = await relayManagedDiscussion(request({ operation: 'create', body: {
    target_type: 'item', target_id: 'part', body: 'Personal comment' } }), 'source')
  expect(result).toMatchObject({ comments: [{ author_user_id: 42 }] })
  expect(seen[0].url).toBe('/api/v1/auth/embed/discussion-session')
  expect(seen[1].headers.authorization).toBe('Bearer native-discussion-write')
})
it.each([{ sub: 'meta-owner' }, { tenant_id: 'meta-tenant' }, { org_id: 'meta-org' },
  { embed_origin: 'https://foreign.example.test' }, { feature_key: 'approval' }])('refuses signed foreign scope %j before any request', async overrides => {
  await expect(relayManagedDiscussion(request(undefined, overrides), 'source')).rejects.toMatchObject({ status: 403 })
  expect(seen).toEqual([]); expect(mocks.consume).not.toHaveBeenCalled()
})
it('keeps live identity/source refusal ahead of JTI consumption', async () => {
  mocks.lock.mockRejectedValue(new Error('identity changed'))
  await expect(relayManagedDiscussion(request(), 'source')).rejects.toThrow('identity changed')
  expect(mocks.consume).not.toHaveBeenCalled(); expect(seen).toEqual([])
})
it('refuses an invalid signature before reading protected source state', async () => {
  const req = request(); req.headers['x-plm-embed-token'] += 'corrupt'
  await expect(relayManagedDiscussion(req, 'source')).rejects.toMatchObject({ status: 401 })
  expect(mocks.lock).not.toHaveBeenCalled(); expect(seen).toEqual([])
})
it('refuses replay without exchanging or invoking Native', async () => {
  mocks.consume.mockResolvedValue(false)
  await expect(relayManagedDiscussion(request(), 'source')).rejects.toMatchObject({ status: 401 })
  expect(seen).toEqual([])
})
it('refuses Redis failure without in-process fallback', async () => {
  mocks.consume.mockRejectedValue(new Error('offline'))
  await expect(relayManagedDiscussion(request(), 'source')).rejects.toMatchObject({ status: 503 })
  expect(seen).toEqual([])
})
it('does not follow a redirect carrying an embed token or derived credential', async () => {
  redirect = true
  await expect(relayManagedDiscussion(request(), 'source')).rejects.toMatchObject({ status: 502 })
  expect(seen).toHaveLength(1)
})
it('returns a generic Native refusal without provider text', async () => {
  providerStatus = 403
  await expect(relayManagedDiscussion(request(), 'source')).rejects.toMatchObject({
    status: 403, code: 'PLM_MANAGED_DISCUSSION_REJECTED' })
})
it('does not silently enable Visual markup through this plain Discussion relay', async () => {
  const req = request({ operation: 'create', body: { target_type: 'item', target_id: 'part', body: 'x', markup: {} } })
  await expect(relayManagedDiscussion(req, 'source')).rejects.toMatchObject({ status: 422 })
  expect(mocks.lock).not.toHaveBeenCalled(); expect(seen).toEqual([])
})

it.each([
  [{ operation: 'thread', threadId: 'thread' }, 'GET', '/api/v1/discussions/thread', true],
  [{ operation: 'comment', threadId: 'thread', body: { body: 'reply' } }, 'POST', '/api/v1/discussions/thread/comments', false],
  [{ operation: 'edit', threadId: 'thread', commentId: 'comment', body: { body: 'edit' } }, 'PATCH', '/api/v1/discussions/thread/comments/comment', false],
  [{ operation: 'delete', threadId: 'thread', commentId: 'comment' }, 'DELETE', '/api/v1/discussions/thread/comments/comment', false],
  [{ operation: 'resolve', threadId: 'thread', body: {} }, 'POST', '/api/v1/discussions/thread/resolve', false],
  [{ operation: 'reopen', threadId: 'thread', body: {} }, 'POST', '/api/v1/discussions/thread/reopen', false],
] as const)('uses only the purpose-specific credential for %j', async (input, method, path, isRead) => {
  await relayManagedDiscussion(request(input), 'source')
  expect(seen).toHaveLength(2)
  expect(seen[1].method).toBe(method); expect(seen[1].url).toBe(path)
  expect(seen[1].headers.authorization).toBe(isRead ? 'Bearer native-discussion-read' : 'Bearer native-discussion-write')
  expect(seen[1].body).toEqual('body' in input ? input.body : null)
})
it('refuses persisted URL aliases that would redirect the current source', async () => {
  const value = await mocks.lock()
  value.row.config.connection.baseURL = base + '/other-installation'
  mocks.lock.mockResolvedValue(value)
  await expect(relayManagedDiscussion(request(), 'source')).rejects.toMatchObject({ status: 403, code: 'PLM_MANAGED_DISCUSSION_SOURCE_CHANGED' })
  expect(mocks.consume).not.toHaveBeenCalled(); expect(seen).toEqual([])
})
it('refuses a changed Native registration before consuming the token', async () => {
  const value = await mocks.lock(); value.reg.issuer = base + '/other-installation'
  mocks.lock.mockResolvedValue(value)
  await expect(relayManagedDiscussion(request(), 'source')).rejects.toMatchObject({ status: 403 })
  expect(mocks.consume).not.toHaveBeenCalled(); expect(seen).toEqual([])
})
it('requires the Meta browser origin separately from the Native signed recipient', async () => {
  const req = request(); req.headers.origin = 'https://foreign.example.test'
  await expect(relayManagedDiscussion(req, 'source')).rejects.toMatchObject({ status: 403 })
  expect(mocks.consume).not.toHaveBeenCalled(); expect(seen).toEqual([])
})
it('refuses other-purpose opaque grants instead of authenticating with a shared account', async () => {
  const req = request(); req.headers['x-plm-embed-token'] = 'yua_' + 'a'.repeat(32) + '_' + 'x'.repeat(43)
  await expect(relayManagedDiscussion(req, 'source')).rejects.toMatchObject({ status: 401 })
  expect(mocks.lock).not.toHaveBeenCalled(); expect(seen).toEqual([])
})

it.each(['false', 'true', 'TRUE', '1', ''])('redacts visual metadata in the plain relay regardless of ambient flag %s', async flag => {
  vi.stubEnv('PLM_EMBED_VISUAL_PREVIEW_ENABLED', flag); visualReply = true
  const reply = await relayManagedDiscussion(request({ operation: 'thread', threadId: 'native-thread' }), 'source')
  expect(reply).toMatchObject({ comments: [{ author_user_id: 42, body: 'text', markup: null }] })
  expect(JSON.stringify(reply)).not.toContain('private-visual-marker')
})


it('discovers only the current managed session source, with a separately verified Native parent', async () => {
  mocks.query.mockResolvedValue({ rows: [{ data_source_id: 'current-owned-source' }] })
  const req = request({ operation: 'context', parentOrigin: base }); req.user = { id: 'meta-owner' } as Request['user']
  const result = await managedRequestContext.run({ sessionId: 'current-session', userId: 'meta-owner', conflict: false }, () => relayManagedDiscussion(req))
  expect(result).toEqual({ sourceId: 'current-owned-source', partId: 'part', parentOrigin: base })
  expect(mocks.query).toHaveBeenCalledWith('SELECT data_source_id FROM plm_managed_sessions WHERE id=$1 AND meta_user_id=$2', ['current-session', 'meta-owner'])
  expect(mocks.lock.mock.calls[0][2]).toBe('current-owned-source')
  expect(mocks.consume).toHaveBeenCalledOnce(); expect(seen).toHaveLength(0)
})
it('rejects a forged frame parent before spending the token or touching Native', async () => {
  await expect(relayManagedDiscussion(request({ operation: 'context', parentOrigin: 'https://forged.example.test' }), 'owned-source')).rejects.toMatchObject({ status: 403 })
  expect(mocks.consume).not.toHaveBeenCalled(); expect(seen).toHaveLength(0)
})
it('does not accept a caller source selector or implicit non-context fallback', async () => {
  await expect(relayManagedDiscussion(request({ operation: 'context', parentOrigin: base, sourceId: 'other' }))).rejects.toMatchObject({ status: 422 })
  await expect(relayManagedDiscussion(request())).rejects.toMatchObject({ status: 422 })
  expect(mocks.lock).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.consume).not.toHaveBeenCalled()
})
