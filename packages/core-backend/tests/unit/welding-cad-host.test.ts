import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({ verifyToken: vi.fn(), readTokenPayload: vi.fn(), resolveSessionTenantId: vi.fn(), query: vi.fn() }))
const fileReads = vi.hoisted(() => ({ readFile: vi.fn(), open: vi.fn() }))
vi.mock('../../src/auth/AuthService', () => ({ authService: mocks }))
vi.mock('../../src/db/pg', () => ({ query: mocks.query }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: (...args: Parameters<typeof actual.open>) => {
    fileReads.open(args[0])
    return actual.open(...args)
  }, readFile: (path: Parameters<typeof actual.readFile>[0]) => {
    fileReads.readFile(path)
    return actual.readFile(path)
  } }
})
import { WELDING_CAD_PIN, weldingCadPreflight, weldingCadRawBody, weldingCadHostRouter } from '../../src/routes/welding-cad-host'

const fixture = mkdtempSync(join(tmpdir(), 'welding-cad-test-'))
const key = join(fixture, 'key.pem')
writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
const bundleRoot = join(fixture, 'bundle')
mkdirSync(join(bundleRoot, 'bridge'), { recursive: true })
mkdirSync(join(bundleRoot, 'scripts'), { recursive: true })
const fixtureFiles = {
  'welding-frame.html': '<!doctype html><title>CAD fixture</title>',
  'welding-frame.js': 'export {}',
  'welding-history.html': '<!doctype html><title>History fixture</title>',
  'welding-history.js': 'export {}',
  'welding-history.css': 'body{}',
  'style.css': 'body{color:black}',
  'bridge/welding_readonly_bridge.js': 'export {}',
  'scripts/validate_welding_source.js': 'export {}',
  'package.json': '{"type":"module"}\n',
}
for (const [name, value] of Object.entries(fixtureFiles)) writeFileSync(join(bundleRoot, name), value)
const manifest = JSON.stringify({ schema: 'yuantus.welding_cad_web/v1', adapter_schema: 'vemcad-weld-source/1',
  files: Object.fromEntries(Object.entries(fixtureFiles).map(([name, value]) =>
    [name, createHash('sha256').update(value).digest('hex')])) })
writeFileSync(join(bundleRoot, 'manifest.json'), manifest)
const testPin = createHash('sha256').update(manifest).digest('hex')
const installedRoot = process.env.WELDING_CAD_WEB_TEST_ROOT
const legacyInstalledRoot = process.env.WELDING_CAD_WEB_LEGACY_TEST_ROOT
function writable(path: string): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) return
  chmodSync(path, info.isDirectory() ? 0o700 : 0o600)
  if (info.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name))
}
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); writable(fixture); rmSync(fixture, { recursive: true, force: true }) })
const fetchMock = vi.fn()
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
const authority = { schema: 'yuantus.welding_generation_authority/1', owner: { tenant_id: 'yt', org_id: 'yo', auth_user_id: 71, rbac_user_id: 102 } }
const drawing = { item_id: 'di', version_id: 'dv', file_id: 'f', file_role: 'drawing', expected_checksum: 'a'.repeat(64) }
const source = { item_id: 'di', version_id: 'dv', file_id: 'f', file_role: 'drawing', checksum: 'a'.repeat(64), fingerprint: 'f'.repeat(64) }
const origin = { schema: 'yuantus.welding_plan_cad_origin/1', context_id: 'c', owner_auth_user_id: 71, rbac_user_id: 102,
  basis: { product: { item_id: 'product', version_id: 'product-v1' }, drawing }, source,
  input: { sha256: 'a'.repeat(64), bytes: 42 }, document: { sha256: 'b'.repeat(64), bytes: 42 }, unit: 'mm', bundle_sha256: testPin }
const context = () => ({ context_id: 'c', plan_id: 'p', item_version_id: 'v', draft_seq: 1,
  expires_at: '2026-10-09T00:00:00+00:00', source, input_sha256: 'a'.repeat(64), document_sha256: 'b'.repeat(64),
  cadgf_document: {}, unit: 'mm', origin, editor_url: `/welding-cad/${testPin}/welding-frame.html` })
const document = () => ({ schema: 'yuantus.welding_source_document/1', change_id: 'change', side: 'before',
  payload: { drawing }, cadgf_document: {}, origin, view_bundle_sha256: testPin })
function prepared() {
  const value = structuredClone(context())
  const oldDrawing = { ...drawing, item_id: 'old-di', version_id: 'old-dv', file_id: 'old-f', expected_checksum: 'd'.repeat(64) }
  const oldSource = { ...source, ...oldDrawing, checksum: oldDrawing.expected_checksum }
  const oldOrigin = { ...origin, context_id: 'old-c', owner_auth_user_id: 88, rbac_user_id: 99,
    basis: { product: origin.basis.product, drawing: oldDrawing }, source: oldSource,
    input: { sha256: oldDrawing.expected_checksum, bytes: 42 }, bundle_sha256: '9'.repeat(64) }
  const before = { product: origin.basis.product, drawing: oldDrawing, welds: [] }
  return structuredClone({ ...value, source_change: { expected_content_hash: 'd'.repeat(64), preparation_digest: 'e'.repeat(64),
    before: { payload: before, sources: { product: before.product, drawing: oldSource, overlay_origin: oldOrigin },
      document: { cadgf_document: {}, origin: oldOrigin, view_bundle_sha256: testPin } },
    after: { payload: { ...before, drawing }, sources: { product: before.product, drawing: source, overlay_origin: value.origin },
      document: { cadgf_document: {}, origin: value.origin, view_bundle_sha256: testPin } } } })
}
function upstream(result: unknown = context(), owner = authority) {
  fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
    .mockResolvedValueOnce(json({ access_token: 'y-secret', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
    .mockResolvedValueOnce(json(owner)).mockResolvedValueOnce(json(result))
}
function app(pin = testPin) {
  const server = express()
  server.use(weldingCadPreflight)
  server.use(weldingCadRawBody)
  server.use(express.json())
  server.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next()
    if (!req.headers.authorization) return res.sendStatus(401)
    req.authenticatedTenantId = 'mt'; next()
  })
  server.use(weldingCadHostRouter(pin))
  return server
}
const editor = { purpose: 'editor', plan_id: 'p', version_id: 'v', context_id: 'c' }
const history = { purpose: 'history', plan_id: 'p', version_id: 'v', change_id: 'change', side: 'before' }
const preparation = { purpose: 'preparation', plan_id: 'p', version_id: 'v', context_id: 'c', side: 'before' }
const asset = (name: string) => `/welding-cad/${testPin}/${name}`
const ticket = (server: ReturnType<typeof app>, body: unknown = editor) => request(server).post('/api/welding/cad-assets/tickets')
  .set('Authorization', 'Bearer ms-session').set('Content-Type', 'application/json').send(JSON.stringify(body))
beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllEnvs(); fetchMock.mockReset()
  for (const [name, value] of Object.entries({ WELDING_READ_ENABLED: 'true', WELDING_WRITE_ENABLED: 'false', WELDING_CAD_ASSET_ROOT: bundleRoot,
    WELDING_METASHEET_TENANT_ID: 'mt', WELDING_YUANTUS_ORIGIN: 'https://welding.invalid', WELDING_YUANTUS_PROVIDER: 'ms',
    WELDING_YUANTUS_TENANT_ID: 'yt', WELDING_YUANTUS_ORG_ID: 'yo', WELDING_SSO_ISSUER: 'https://issuer.invalid',
    WELDING_SSO_CLIENT_ID: 'welding', WELDING_SSO_KID: 'key-1', WELDING_SSO_PRIVATE_KEY_FILE: key, RBAC_TOKEN_TRUST: '', RBAC_BYPASS: '' })) vi.stubEnv(name, value)
  mocks.verifyToken.mockResolvedValue({ id: 'u1', tenantId: 'mt' })
  mocks.readTokenPayload.mockReturnValue({ userId: 'u1', tenantId: 'mt', sid: 'sid1',
    iat: Math.floor(Date.now() / 1000) - 10, exp: Math.floor(Date.now() / 1000) + 300 })
  mocks.resolveSessionTenantId.mockResolvedValue('mt')
  mocks.query.mockResolvedValue({ rows: [{ id: 'sid1' }] })
  vi.stubGlobal('fetch', fetchMock)
})

describe('pinned welding CAD host', () => {
  it.each(['before', 'after'])('serves readonly preparation %s with historical origin pin retained', async side => {
    const server = app(); upstream(prepared())
    const issued = await ticket(server, { ...preparation, side })
    expect(issued.status).toBe(201)
    expect(issued.body.asset_url).toBe(asset('welding-history.html'))
    expect(fetchMock.mock.calls[3][0]).toBe('https://welding.invalid/api/v1/plugins/welding/plans/p/versions/v/source-change-preparations/c')
    expect(fetchMock.mock.calls[3][1].method).toBe('GET')
    const cookie = issued.headers['set-cookie'][0]
    upstream(prepared())
    expect((await request(server).get(asset('welding-history.html')).set('Cookie', cookie)).status).toBe(200)
    expect(fetchMock.mock.calls[7][0]).toBe(fetchMock.mock.calls[3][0])
    expect((await request(server).get(asset('welding-frame.html')).set('Cookie', cookie)).status).toBe(403)
    expect((await request(server).get(asset('welding-history.js')).set('Cookie', cookie)).status).toBe(401)
  })
  it.each([
    { ...preparation, side: 'other' }, { ...preparation, context_id: 'c/other' },
    { ...preparation, change_id: 'change' }, { ...preparation, side: undefined },
  ])('rejects invalid preparation scope before authentication %#', async scope => {
    expect((await ticket(app(), scope)).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(fileReads.open).not.toHaveBeenCalled()
  })
  it.each(['before', 'after'])('checks preparation %s viewer pin before issuing a cookie', async side => {
    const value = prepared()
    value.source_change[side as 'before' | 'after'].document.view_bundle_sha256 = '0'.repeat(64)
    upstream(value)
    const response = await ticket(app(), { ...preparation, side })
    expect(response.status).toBe(502)
    expect(response.headers['set-cookie']).toBeUndefined()
  })
  it.each([403, 404, 409])('revokes preparation assets after upstream rejection %s', async status => {
    const server = app(); upstream(prepared())
    const issued = await ticket(server, preparation)
    expect(issued.status).toBe(201)
    const cookie = issued.headers['set-cookie'][0]
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'y-secret', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json(authority)).mockResolvedValueOnce(new Response('{}', { status, headers: { 'content-type': 'application/json' } }))
    expect((await request(server).get(asset('welding-history.js')).set('Cookie', cookie)).status).toBe(status)
    expect((await request(server).get(asset('welding-history.js')).set('Cookie', cookie)).status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
  it.each(['owner', 'pin'])('drops a preparation ticket when its %s changes before asset delivery', async changed => {
    const server = app(); upstream(prepared())
    const issued = await ticket(server, preparation)
    expect(issued.status).toBe(201)
    const cookie = issued.headers['set-cookie'][0], value = prepared()
    const owner = structuredClone(authority)
    if (changed === 'owner') {
      owner.owner.rbac_user_id = 103
      value.origin.rbac_user_id = 103
      value.source_change.after.document.origin.rbac_user_id = 103
      value.source_change.after.sources.overlay_origin.rbac_user_id = 103
    } else value.source_change.before.document.view_bundle_sha256 = '0'.repeat(64)
    upstream(value, owner)
    expect((await request(server).get(asset('welding-history.js')).set('Cookie', cookie)).status).toBe(changed === 'owner' ? 403 : 502)
    expect((await request(server).get(asset('welding-history.js')).set('Cookie', cookie)).status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(8)
  })
  it.each([
    ['plan_id', '\u0085p'], ['version_id', 'v\u0085'],
    ['context_id', '\u001cc'], ['change_id', 'change\u001f'],
  ] as const)('rejects Python whitespace at the %s edge before module IO', async (field, value) => {
    const server = app(), scope = field === 'change_id' ? history : editor
    const response = await ticket(server, { ...scope, [field]: value })
    expect(response.status).toBe(400)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(fileReads.open).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('preserves a legal interior NEL in a fixed plan ID', async () => {
    const server = app(), planId = 'p\u0085q'
    upstream({ ...context(), plan_id: planId })
    const response = await ticket(server, { ...editor, plan_id: planId })
    expect(response.status).toBe(201)
    expect(fetchMock.mock.calls[3][0]).toBe(`https://welding.invalid/api/v1/plugins/welding/plans/${encodeURIComponent(planId)}/versions/v/cad-contexts/c`)
  })
  it.each(['plan_id', 'version_id', 'context_id', 'change_id'] as const)(
    'rejects an escaped lone surrogate %s before module session, bundle or Y IO', async field => {
      const server = app(), scope = field === 'change_id' ? history : editor
      const response = await ticket(server, { ...scope, [field]: '\ud800' })
      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('WELDING_INVALID_REQUEST')
      expect(mocks.verifyToken).not.toHaveBeenCalled()
      expect(fileReads.open).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })
  it('accepts a 40-codepoint paired astral plan ID through the fixed context read', async () => {
    const server = app(), planId = '😀'.repeat(40)
    upstream({ ...context(), plan_id: planId })
    const response = await ticket(server, { ...editor, plan_id: planId })
    expect(response.status).toBe(201)
    expect(fetchMock.mock.calls[3][0]).toBe(`https://welding.invalid/api/v1/plugins/welding/plans/${encodeURIComponent(planId)}/versions/v/cad-contexts/c`)
  })
  it('read OFF denies ticket and static before authentication or upstream IO', async () => {
    vi.stubEnv('WELDING_READ_ENABLED', 'false'); const server = app()
    expect((await ticket(server)).status).toBe(503)
    expect((await request(server).get(asset('welding-frame.html'))).status).toBe(503)
    expect((await request(server).post('/api/welding/cad-assets/tickets/extra').send({})).status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled(); expect(mocks.verifyToken).not.toHaveBeenCalled()
  })
  it('issues secure ticket and serves installed frame after a second personal SSO/source read', async () => {
    const server = app(); upstream()
    const issued = await ticket(server)
    expect(issued.status).toBe(201)
    expect(issued.body.asset_url).toBe(asset('welding-frame.html'))
    const cookie = issued.headers['set-cookie'][0]
    expect(cookie).toMatch(/^welding_cad_ticket=[0-9a-f]{64};/)
    for (const property of [`Path=/welding-cad/${testPin}/`, 'HttpOnly', 'Secure', 'SameSite=Strict']) expect(cookie).toContain(property)
    expect(cookie).not.toContain('ms-session'); expect(cookie).not.toContain('y-secret')
    expect((await request(server).get(asset('welding-frame.html'))).status).toBe(401)
    expect((await request(server).get('/api/welding/authority').set('Cookie', cookie)).status).toBe(401)
    upstream()
    const served = await request(server).get(asset('welding-frame.html')).set('Cookie', cookie)
    expect(served.status).toBe(200)
    expect(createHash('sha256').update(served.text).digest('hex')).toBe(createHash('sha256').update(readFileSync(join(bundleRoot, 'welding-frame.html'))).digest('hex'))
    expect(served.headers['content-security-policy']).toContain("connect-src 'none'")
    expect(served.headers['content-security-policy']).toContain("font-src 'self' data:")
    expect(served.headers['content-security-policy']).toContain("script-src 'self';")
    expect(served.headers['content-security-policy']).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(served.headers['cache-control']).toBe('no-store')
    expect(served.headers['content-type']).toMatch(/^text\/html/)
    expect(served.headers['content-length']).toBe(String(readFileSync(join(bundleRoot, 'welding-frame.html')).length))
    expect(served.headers['x-content-type-options']).toBe('nosniff')
    expect(fetchMock.mock.calls[3][0]).toBe(fetchMock.mock.calls[7][0])
  })
  it('binds history to its fixed source-document side and readonly entry', async () => {
    const server = app(); upstream(document())
    const issued = await ticket(server, history)
    expect(issued.status).toBe(201)
    expect(issued.body.asset_url).toBe(asset('welding-history.html'))
    expect(fetchMock.mock.calls[3][0]).toBe('https://welding.invalid/api/v1/plugins/welding/plans/p/versions/v/source-changes/change/documents/before')
    const cookie = issued.headers['set-cookie'][0]
    upstream(document())
    expect((await request(server).get(asset('welding-history.js')).set('Cookie', cookie)).status).toBe(200)
    expect((await request(server).get(asset('welding-frame.html')).set('Cookie', cookie)).status).toBe(403)
    upstream({ ...document(), side: 'after' })
    const after = await ticket(server, { ...history, side: 'after' })
    expect(after.status).toBe(201)
    expect(fetchMock.mock.calls[11][0]).toBe('https://welding.invalid/api/v1/plugins/welding/plans/p/versions/v/source-changes/change/documents/after')
  })
  it.each(['before', 'after'])('serves historical %s via the current readonly viewer, then revokes on viewer pin change', async side => {
    const server = app(), value = { ...document(), side, origin: { ...origin, bundle_sha256: '9'.repeat(64), owner_auth_user_id: 88, rbac_user_id: 99 } }
    upstream(value)
    const issued = await ticket(server, { ...history, side })
    expect(issued.status).toBe(201); expect(issued.body.asset_url).toBe(asset('welding-history.html'))
    const cookie = issued.headers['set-cookie'][0]
    upstream(value)
    expect((await request(server).get(asset('welding-history.html')).set('Cookie', cookie)).status).toBe(200)
    upstream({ ...value, view_bundle_sha256: '0'.repeat(64) })
    expect((await request(server).get(asset('welding-history.js')).set('Cookie', cookie)).status).toBe(502)
    expect((await request(server).get(asset('welding-history.js')).set('Cookie', cookie)).status).toBe(401)
  })
  it.each(['origin', 'viewer'])('refuses invalid historical %s pin before issuing a cookie', async damage => {
    const server = app(), value = { ...document(), origin: { ...origin, bundle_sha256: '9'.repeat(64) } }
    if (damage === 'origin') value.origin.bundle_sha256 = 'invalid'
    else value.view_bundle_sha256 = '0'.repeat(64)
    upstream(value); const result = await ticket(server, history)
    expect(result.status).toBe(502); expect(result.headers['set-cookie']).toBeUndefined()
  })
  it('closes bad descriptor, method, query, pin and private asset before identity IO', async () => {
    const server = app()
    for (const body of [{ ...editor, plan_id: 'p/q' }, { ...editor, extra: true }, { ...editor, context_id: 'c%2Fd' }])
      expect((await ticket(server, body)).status).toBe(400)
    for (const path of [asset('package.json'), asset('scripts/validate_welding_source.js'),
      `/welding-cad/${'0'.repeat(64)}/welding-frame.html`, `${asset('welding-frame.html')}?x=1`,
      asset('unknown.js'), asset('adapters%2Fwelding_source_adapter.js'), asset('..%2Fpackage.json')])
      expect([400, 401, 404]).toContain((await request(server).get(path)).status)
    expect((await request(server).post(asset('welding-frame.html'))).status).toBe(400)
    expect((await ticket(server).query({ x: 1 })).status).toBe(400)
    expect((await ticket(server, { ...editor, padding: 'x'.repeat(1024) })).status).toBe(413)
    expect((await request(server).post('/api/welding/cad-assets/tickets/extra').send({})).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled(); expect(mocks.verifyToken).not.toHaveBeenCalled()
  })
  it('drops a ticket when owner changes, and does not re-exchange SSO for the dropped ticket', async () => {
    const server = app(); upstream()
    const cookie = (await ticket(server)).headers['set-cookie'][0]
    upstream({ ...context(), origin: { ...origin, rbac_user_id: 103 } }, { ...authority, owner: { ...authority.owner, rbac_user_id: 103 } })
    expect((await request(server).get(asset('style.css')).set('Cookie', cookie)).status).toBe(403)
    expect((await request(server).get(asset('style.css')).set('Cookie', cookie)).status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(8)
  })
  it('rejects a changed source pin before bytes and drops the ticket', async () => {
    const server = app(); upstream()
    const cookie = (await ticket(server)).headers['set-cookie'][0]
    upstream({ ...context(), origin: { ...origin, bundle_sha256: '0'.repeat(64) }, editor_url: `/welding-cad/${'0'.repeat(64)}/welding-frame.html` })
    expect((await request(server).get(asset('style.css')).set('Cookie', cookie)).status).toBe(502)
    expect((await request(server).get(asset('style.css')).set('Cookie', cookie)).status).toBe(401)
  })
  it('rejects revoked sid, changed target and read OFF without asset bytes', async () => {
    const server = app(); upstream()
    const cookie = (await ticket(server)).headers['set-cookie'][0]
    mocks.query.mockResolvedValue({ rows: [] })
    expect((await request(server).get(asset('style.css')).set('Cookie', cookie)).status).toBe(401)
    mocks.query.mockResolvedValue({ rows: [{ id: 'sid1' }] })
    upstream()
    const second = (await ticket(server)).headers['set-cookie'][0]
    vi.stubEnv('WELDING_YUANTUS_ORG_ID', 'other')
    expect((await request(server).get(asset('style.css')).set('Cookie', second)).status).toBe(401)
    vi.stubEnv('WELDING_READ_ENABLED', 'false')
    expect((await request(server).get(asset('style.css')).set('Cookie', second)).status).toBe(503)
  })
  it('expires a ticket lazily and does not exchange SSO after expiry', async () => {
    const server = app(); upstream()
    const cookie = (await ticket(server)).headers['set-cookie'][0]
    const now = Date.now(), calls = fetchMock.mock.calls.length
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61000)
    try {
      expect((await request(server).get(asset('style.css')).set('Cookie', cookie)).status).toBe(401)
      expect(fetchMock).toHaveBeenCalledTimes(calls)
    } finally { clock.mockRestore() }
  })
  it('does not issue a cookie if the native sid or read gate changes while its domain read awaits', async () => {
    const server = app()
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'y-secret', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json(authority)).mockImplementationOnce(async () => { mocks.query.mockResolvedValue({ rows: [] }); return json(context()) })
    const revoked = await ticket(server)
    expect(revoked.status).toBe(401)
    expect(revoked.headers['set-cookie']).toBeUndefined()
    mocks.query.mockResolvedValue({ rows: [{ id: 'sid1' }] })
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'y-secret', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json(authority)).mockImplementationOnce(async () => { vi.stubEnv('WELDING_READ_ENABLED', 'false'); return json(context()) })
    const disabled = await ticket(server)
    expect(disabled.status).toBe(503)
    expect(disabled.headers['set-cookie']).toBeUndefined()
  })
  it('does not issue a cookie if the original native token expires during the awaited domain read', async () => {
    const server = app(), now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
        .mockResolvedValueOnce(json({ access_token: 'y-secret', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
        .mockResolvedValueOnce(json(authority)).mockImplementationOnce(async () => { clock.mockReturnValue(now + 301000); return json(context()) })
      const expired = await ticket(server)
      expect(expired.status).toBe(401)
      expect(expired.headers['set-cookie']).toBeUndefined()
    } finally { clock.mockRestore() }
  })
  it('stops the awaited SSO chain on client disconnect without a late domain dispatch', async () => {
    let answer!: (value: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { answer = resolve }))
    const server = app().listen(0)
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw Error('missing test listener')
      const body = JSON.stringify(editor)
      const client = httpRequest({ port: address.port, path: '/api/welding/cad-assets/tickets', method: 'POST',
        headers: { Authorization: 'Bearer ms-session', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } })
      client.on('error', () => {})
      client.end(body)
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      client.destroy()
      await new Promise(resolve => setTimeout(resolve, 10))
      answer(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('denies plugin/source 403 or 404 after fresh personal SSO and removes the ticket', async () => {
    for (const [scope, record] of [[editor, context()], [history, document()]] as const) for (const status of [403, 404]) {
      const server = app(); upstream(record)
      const cookie = (await ticket(server, scope)).headers['set-cookie'][0]
      fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
        .mockResolvedValueOnce(json({ access_token: 'y-secret', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
        .mockResolvedValueOnce(json(authority)).mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'private' }), { status }))
      const denied = await request(server).get(asset('style.css')).set('Cookie', cookie)
      expect(denied.status).toBe(status)
      expect(denied.text).not.toContain('private')
      expect((await request(server).get(asset('style.css')).set('Cookie', cookie)).status).toBe(401)
    }
  })
  it('does not evict an existing ticket when process capacity reaches 256', async () => {
    const server = app().listen(0)
    const issue = () => request(server).post('/api/welding/cad-assets/tickets')
      .set('Authorization', 'Bearer ms-session').set('Content-Type', 'application/json').send(JSON.stringify(editor))
    try {
      let first = ''
      for (let i = 0; i < 256; i++) {
        upstream()
        const issued = await issue()
        expect(issued.status, `ticket ${i}`).toBe(201)
        if (i === 0) first = issued.headers['set-cookie'][0]
      }
      const calls = fetchMock.mock.calls.length
      expect((await issue()).status).toBe(429)
      expect(fetchMock).toHaveBeenCalledTimes(calls)
      upstream()
      expect((await request(server).get(asset('style.css')).set('Cookie', first)).status).toBe(200)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  }, 30000)
  it('rejects corrupt installed bytes before domain SSO', async () => {
    const copy = mkdtempSync(join(fixture, 'bundle-'))
    cpSync(bundleRoot, copy, { recursive: true })
    writable(copy)
    writeFileSync(join(copy, 'welding-frame.js'), 'changed')
    vi.stubEnv('WELDING_CAD_ASSET_ROOT', copy)
    expect((await ticket(app())).status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each(['manifest', 'file'] as const)('bounds the %s read before allocating the oversized installed bytes', async target => {
    const copy = mkdtempSync(join(fixture, `oversize-${target}-`))
    cpSync(bundleRoot, copy, { recursive: true }); writable(copy)
    if (target === 'manifest') truncateSync(join(copy, 'manifest.json'), 128 * 1024 + 1)
    else truncateSync(join(copy, 'welding-frame.js'), 4 * 1024 * 1024 + 1)
    vi.stubEnv('WELDING_CAD_ASSET_ROOT', copy)
    expect((await ticket(app())).status).toBe(503)
    expect(fileReads.readFile.mock.calls.filter(([path]) => String(path).startsWith(copy))).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('rejects a symlink in the installed bundle before domain SSO', async () => {
    const copy = mkdtempSync(join(fixture, 'symlink-'))
    cpSync(bundleRoot, copy, { recursive: true }); writable(copy)
    unlinkSync(join(copy, 'welding-frame.js'))
    symlinkSync(join(bundleRoot, 'welding-frame.js'), join(copy, 'welding-frame.js'))
    vi.stubEnv('WELDING_CAD_ASSET_ROOT', copy)
    expect((await ticket(app())).status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('rejects a different installed root after issue even when it has the same verified pin', async () => {
    const server = app(); upstream()
    const cookie = (await ticket(server)).headers['set-cookie'][0]
    const copy = mkdtempSync(join(fixture, 'reconfigured-'))
    cpSync(bundleRoot, copy, { recursive: true }); writable(copy)
    vi.stubEnv('WELDING_CAD_ASSET_ROOT', copy)
    expect((await request(server).get(asset('style.css')).set('Cookie', cookie)).status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
  it.each(['read-flag', 'provider', 'root'] as const)(
    'denies asset bytes when %s changes during the final native session await', async changed => {
      const server = app(); upstream()
      const cookie = (await ticket(server)).headers['set-cookie'][0]
      upstream()
      let afterDomainChecks = 0
      mocks.query.mockImplementation(async () => {
        if (fetchMock.mock.calls.length === 8 && ++afterDomainChecks === 2) {
          if (changed === 'read-flag') vi.stubEnv('WELDING_READ_ENABLED', 'false')
          if (changed === 'provider') vi.stubEnv('WELDING_YUANTUS_ORG_ID', 'other')
          if (changed === 'root') vi.stubEnv('WELDING_CAD_ASSET_ROOT', join(fixture, 'replacement'))
        }
        return { rows: [{ id: 'sid1' }] }
      })
      const response = await request(server).get(asset('style.css')).set('Cookie', cookie)
      expect(afterDomainChecks).toBe(2)
      expect(response.status).toBe(changed === 'read-flag' ? 503 : 401)
      expect(response.text).not.toBe(fixtureFiles['style.css'])
      expect(fetchMock).toHaveBeenCalledTimes(8)
    })
  it.skipIf(!installedRoot)('verifies and serves the actual installed fixed-pin bundle when explicitly supplied', async () => {
    vi.stubEnv('WELDING_CAD_ASSET_ROOT', installedRoot!)
    const server = app(WELDING_CAD_PIN)
    const actualContext = { ...context(), origin: { ...origin, bundle_sha256: WELDING_CAD_PIN },
      editor_url: `/welding-cad/${WELDING_CAD_PIN}/welding-frame.html` }
    upstream(actualContext)
    const issued = await ticket(server)
    expect(issued.status).toBe(201)
    expect(issued.body.bundle_sha256).toBe(WELDING_CAD_PIN)
    upstream(actualContext)
    const served = await request(server).get(`/welding-cad/${WELDING_CAD_PIN}/welding-frame.html`)
      .set('Cookie', issued.headers['set-cookie'][0])
    expect(served.status).toBe(200)
    expect(createHash('sha256').update(readFileSync(join(installedRoot!, 'manifest.json'))).digest('hex')).toBe(WELDING_CAD_PIN)
    expect(createHash('sha256').update(served.text).digest('hex'))
      .toBe(createHash('sha256').update(readFileSync(join(installedRoot!, 'welding-frame.html'))).digest('hex'))
  })
  it.skipIf(!legacyInstalledRoot)('rejects the old 69b6ad installed bundle under the current production pin', async () => {
    vi.stubEnv('WELDING_CAD_ASSET_ROOT', legacyInstalledRoot!)
    expect(createHash('sha256').update(readFileSync(join(legacyInstalledRoot!, 'manifest.json'))).digest('hex'))
      .toBe('69b6adcc23c0123e64571242c70819be89ef0a6048235e4ffabcd48c7c5761bd')
    const server = app(WELDING_CAD_PIN)
    const anonymous = await request(server).get(`/welding-cad/${WELDING_CAD_PIN}/welding-frame.html`)
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers['set-cookie']).toBeUndefined()
    const issued = await ticket(server)
    expect(issued.status).toBe(503)
    expect(issued.headers['set-cookie']).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
