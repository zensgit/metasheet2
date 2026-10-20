import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, generateKeyPairSync, sign, randomUUID } from 'node:crypto'
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
let previewMode = false
const previewBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
function token(overrides: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'managed-test' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ typ: 'embed', aud: 'metasheet2.embed', sub: '42',
    tenant_id: 'native-tenant', org_id: 'native-org', part_id: 'part', feature_key: 'bom_multitable',
    embed_origin: 'https://meta.example.test', exp: Math.floor(Date.now() / 1000) + 120,
    iat: Math.floor(Date.now() / 1000), jti: randomUUID(), ...overrides })).toString('base64url')
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
    if (previewMode && req.url === '/api/v1/auth/embed/visual-preview-session') {
      const input = JSON.parse(raw)
      if (input.action === 'list') {
        res.end(JSON.stringify({ files: [{ file_id: 'file', version_id: 'version', filename: 'owned.png',
          version_is_current: true, storage_key: 'private-storage-key' }], has_more: false })); return
      }
      if (input.preview_token) { res.setHeader('Content-Type', 'image/png'); res.end(previewBytes); return }
      const embed = JSON.parse(Buffer.from(input.embed_token.split('.')[1], 'base64url').toString())
      const claims = { ...embed, typ: 'visual_preview', aud: 'metasheet2.visual-preview', jti: randomUUID(),
        embed_jti: embed.jti, embed_iat: embed.iat, file_id: input.file_id, version_id: input.version_id,
        checksum: 'a'.repeat(64), preview_checksum: createHash('sha256').update(previewBytes).digest('hex'),
        media_type: 'image/png', width: 1, height: 1, page: 0, version_is_current: true }
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'managed-test' })).toString('base64url')
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
      const capability = header + '.' + payload + '.' + sign(null, Buffer.from(header + '.' + payload), keys.privateKey).toString('base64url')
      res.end(JSON.stringify({ render: 'available', preview_token: capability, ...Object.fromEntries(
        ['file_id', 'version_id', 'checksum', 'preview_checksum', 'media_type', 'width', 'height', 'page', 'version_is_current']
          .map(key => [key, claims[key as keyof typeof claims]])) })); return
    }
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
  seen.length = 0; redirect = false; providerStatus = 200; visualReply = false; previewMode = false
  mocks.consume.mockResolvedValue(true)
  mocks.lock.mockResolvedValue({ row: { config: { connection: { url: base },
    options: { apiMode: 'yuantus', tenantId: 'native-tenant', orgId: 'native-org' } }, frozen_origin: base },
    source: { auth_user_id: '42', tenant_id: 'native-tenant', org_id: 'native-org' },
    reg: { origin: 'https://meta.example.test', issuer: base, nativeBaseUrl: base } })
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
it('keeps an independent installation issuer separate from the registered Native API URL', async () => {
  const value = await mocks.lock(); value.reg.issuer = 'https://installation.example.test/plm'
  mocks.lock.mockResolvedValue(value)
  expect(await relayManagedDiscussion(request(), 'source')).toMatchObject({ id: 'native-thread' })
  expect(seen.length).toBe(2)
})
it('refuses a changed Native registration before consuming the token', async () => {
  const value = await mocks.lock(); value.reg.nativeBaseUrl = base + '/other-installation'
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


async function enableManagedVisual(value: unknown = true) {
  vi.stubEnv('PLM_EMBED_VISUAL_PREVIEW_ENABLED', 'true')
  const current = await mocks.lock()
  current.row.config.options.managedVisualReviewEnabled = value
  mocks.lock.mockResolvedValue(current)
  previewMode = true
}
const boundVisual = {
  anchor: { kind: 'cad_2d_markup', file_id: 'file', file_version: 'version', content_checksum: 'a'.repeat(64),
    preview_checksum: createHash('sha256').update(previewBytes).digest('hex'), page: 0 },
  markup: { schema_version: 1, markup_type: 'pin', geometry: { x: .5, y: .5 }, file_id: 'file',
    viewport: { width: 1, height: 1, rotation: 0 } },
}
it.each(['false', 'TRUE', '1', '0', ''])('refuses managed Visual runtime value %j before source/JTI/Native access', async flag => {
  vi.stubEnv('PLM_EMBED_VISUAL_PREVIEW_ENABLED', flag)
  await expect(relayManagedDiscussion(request({ operation: 'preview-files' }), 'source')).rejects.toMatchObject({ status: 404 })
  expect(mocks.lock).not.toHaveBeenCalled(); expect(mocks.consume).not.toHaveBeenCalled(); expect(seen).toEqual([])
})
it.each([false, 'true', 1, null])('requires the persisted boolean Visual source flag, got %j', async value => {
  await enableManagedVisual(value)
  await expect(relayManagedDiscussion(request({ operation: 'preview-files' }), 'source')).rejects.toMatchObject({ status: 403 })
  expect(mocks.consume).not.toHaveBeenCalled(); expect(seen).toEqual([])
})
it('lists Native preview candidates with fresh frame authority and no shared bearer/storage key', async () => {
  await enableManagedVisual()
  const result = await relayManagedDiscussion(request({ operation: 'preview-files' }), 'source')
  expect(result).toEqual({ files: [{ file_id: 'file', version_id: 'version', filename: 'owned.png', version_is_current: true }], has_more: false })
  expect(seen).toHaveLength(1); expect(seen[0].headers.authorization).toBeUndefined()
  expect(seen[0].body).toMatchObject({ action: 'list' })
  expect(JSON.stringify(result)).not.toContain('private-storage-key')
  expect(JSON.stringify(seen)).not.toContain('shared-credential-must-not-appear')
})
it('mints and redeems the existing signed Native preview protocol under managed source admission', async () => {
  await enableManagedVisual()
  const result = await relayManagedDiscussion(request({ operation: 'preview-image', fileId: 'file', versionId: 'version' }), 'source')
  expect(result).toMatchObject({ render: 'available', mediaType: 'image/png', bytes: previewBytes,
    descriptor: { part_id: 'part', file_id: 'file', file_version: 'version', version_is_current: true } })
  expect(seen).toHaveLength(2); expect(seen.every(row => row.headers.authorization === undefined)).toBe(true)
  expect(seen[1].body).toMatchObject({ origin: 'https://meta.example.test' })
})
it('admits validated bound markup only with the separate source/runtime gate and Native write exchange', async () => {
  await enableManagedVisual()
  const body = { target_type: 'item', target_id: 'part', body: 'bound comment', ...boundVisual }
  await relayManagedDiscussion(request({ operation: 'create', body }), 'source')
  expect(seen[0].url).toBe('/api/v1/auth/embed/discussion-session')
  expect(seen[1].headers.authorization).toBe('Bearer native-discussion-write'); expect(seen[1].body).toEqual(body)
})
it('does not turn a valid Visual payload into an ordinary Discussion write when runtime is disabled', async () => {
  await expect(relayManagedDiscussion(request({ operation: 'create', body: {
    target_type: 'item', target_id: 'part', body: 'bound', ...boundVisual } }), 'source')).rejects.toMatchObject({ status: 404 })
  expect(mocks.lock).not.toHaveBeenCalled(); expect(seen).toEqual([])
})
it('reports enabled Visual only from the locked Native-tenant source, keeping the frame parent separate', async () => {
  await enableManagedVisual()
  const result = await relayManagedDiscussion(request({ operation: 'context', parentOrigin: base }), 'source')
  expect(result).toEqual({ sourceId: 'source', partId: 'part', parentOrigin: base, visualPreviewEnabled: true })
  expect(seen).toEqual([])
})
it('refuses a configured Meta tenant substituted for the distinct Native tenant', async () => {
  await enableManagedVisual()
  const current = await mocks.lock(); current.row.config.options.tenantId = 'meta-tenant'
  await expect(relayManagedDiscussion(request({ operation: 'preview-files' }), 'source')).rejects.toMatchObject({ status: 403 })
  expect(seen).toEqual([]); expect(mocks.consume).not.toHaveBeenCalled()
})
it.each([{ anchor: boundVisual.anchor }, { markup: boundVisual.markup },
  { ...boundVisual, markup: { ...boundVisual.markup, geometry: { x: 2, y: .5 } } },
  { ...boundVisual, markup: { ...boundVisual.markup, file_id: 'other-file' } },
])('refuses incomplete/invalid Visual bodies before reading source state: %j', async visual => {
  await expect(relayManagedDiscussion(request({ operation: 'create', body: {
    target_type: 'item', target_id: 'part', body: 'invalid', ...visual } }), 'source')).rejects.toMatchObject({ status: 422 })
  expect(mocks.lock).not.toHaveBeenCalled(); expect(seen).toEqual([])
})
