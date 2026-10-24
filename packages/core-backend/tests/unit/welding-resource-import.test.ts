import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { usePinnedServer } from '../utils/pinned-server'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { resolve } from 'node:path'

const mocks = vi.hoisted(() => ({ verifyToken: vi.fn(), readTokenPayload: vi.fn(), resolveSessionTenantId: vi.fn(), query: vi.fn() }))
vi.mock('../../src/auth/AuthService', () => ({ authService: mocks }))
vi.mock('../../src/db/pg', () => ({ query: mocks.query }))
import { weldingPreflight, weldingPlanRawBody, weldingRouter } from '../../src/routes/welding'

const pinned = usePinnedServer()

const fixture = resolve('../../artifacts/welding-f02/resource-import-unit')
mkdirSync(fixture, { recursive: true })
writeFileSync(`${fixture}/key.pem`, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(fixture, { recursive: true, force: true }) })

const fetchMock = vi.fn()
const bytes = Buffer.from([0, 255, 10, 13, 128, 0, 42])
const sha = createHash('sha256').update(bytes).digest('hex')
const digest = 'd'.repeat(64)
const importId = 'batch-1'
const previewPath = '/api/welding/resources/import/preview?format=csv'
const commitPath = `/api/welding/resources/import/commit?format=csv&import_id=${importId}&preview_digest=${digest}`
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
})
const authority = { schema: 'yuantus.welding_generation_authority/1', owner: {
  tenant_id: 'yt', org_id: 'yo', auth_user_id: 71, rbac_user_id: 102,
} }
const payload = { schema_version: 1, kind: 'material', suggested_fields: { material_a: 'steel' } }
const rows = (n: number) => Array.from({ length: n }, (_, index) => ({
  row: index + 2, row_key: `key-${index}`, name: `Material ${index}`, number: `M-${index}`, payload,
  sources: {},
}))
const preview = (n: number, ready = true) => ({ schema: 'yuantus.welding_resource_import/1', format: 'csv',
  raw_sha256: sha, normalized_sha256: 'a'.repeat(64), preview_digest: ready ? digest : null,
  total_rows: n, ready, rows: rows(n), errors: [] as unknown[],
})
const receipt = (n: number) => ({ schema: 'yuantus.welding_resource_import/1', import_id: importId,
  raw_sha256: sha, normalized_sha256: 'a'.repeat(64), preview_digest: digest, total_rows: n,
  items: rows(n).map(row => ({ row: row.row, row_key: row.row_key, resource_id: `resource-${row.row}`,
    item_version_id: `version-${row.row}`, version_label: '1.A', content_hash: 'c'.repeat(64),
    name: row.name, number: row.number, kind: 'material', state: 'Draft' })),
})
function queue(response: Response) {
  fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
    .mockResolvedValueOnce(json({ access_token: 'personal-bearer', token_type: 'bearer', expires_in: 3600,
      tenant_id: 'yt', user_id: 71 }))
    .mockResolvedValueOnce(json(authority)).mockResolvedValueOnce(response)
}
function app() {
  const server = express()
  server.use(weldingPreflight)
  server.use(weldingPlanRawBody)
  server.use(express.json({ limit: '10mb' }))
  server.use((req, _res, next) => { req.authenticatedTenantId = 'mt'; next() })
  server.use(weldingRouter())
  return server
}
const post = (path: string, body: Buffer = bytes) => (pinned.setApp(app()), request(pinned.url())).post(path)
  .set('Authorization', 'Bearer ms-session').set('Content-Type', 'application/octet-stream').send(body)
const get = (path: string) => (pinned.setApp(app()), request(pinned.url())).get(path).set('Authorization', 'Bearer ms-session')
async function until(ready: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (ready()) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error('Expected asynchronous stage was not entered')
}
function paddedJson(value: unknown, length: number): Buffer {
  const original = Buffer.from(JSON.stringify(value))
  if (original.length > length) throw new Error('Fixture exceeds boundary')
  return Buffer.concat([original, Buffer.alloc(length - original.length, 0x20)])
}

beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllEnvs(); fetchMock.mockReset()
  for (const [name, value] of Object.entries({ WELDING_READ_ENABLED: 'true', WELDING_WRITE_ENABLED: 'true',
    WELDING_METASHEET_TENANT_ID: 'mt', WELDING_YUANTUS_ORIGIN: 'https://welding.invalid',
    WELDING_YUANTUS_PROVIDER: 'ms', WELDING_YUANTUS_TENANT_ID: 'yt', WELDING_YUANTUS_ORG_ID: 'yo',
    WELDING_SSO_ISSUER: 'https://issuer.invalid', WELDING_SSO_CLIENT_ID: 'welding',
    WELDING_SSO_KID: 'key-1', WELDING_SSO_PRIVATE_KEY_FILE: `${fixture}/key.pem`,
    RBAC_TOKEN_TRUST: '', RBAC_BYPASS: '' })) vi.stubEnv(name, value)
  mocks.verifyToken.mockResolvedValue({ id: 'u1', tenantId: 'mt' })
  mocks.readTokenPayload.mockReturnValue({ userId: 'u1', tenantId: 'mt', sid: 'sid1',
    iat: Math.floor(Date.now() / 1000) - 10, exp: Math.floor(Date.now() / 1000) + 3600 })
  mocks.resolveSessionTenantId.mockResolvedValue('mt')
  mocks.query.mockResolvedValue({ rows: [{ id: 'sid1' }] })
  vi.stubGlobal('fetch', fetchMock)
})

describe('fixed resource import binary relay', () => {
  it('forwards identical non-UTF8 bytes and accepts the complete 100th preview row', async () => {
    queue(json(preview(100)))
    const result = await post(previewPath)
    expect(result.status).toBe(200)
    expect(result.body.rows).toHaveLength(100)
    expect(result.body.rows.at(-1).row).toBe(101)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(result.headers['x-content-type-options']).toBe('nosniff')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const [url, options] = fetchMock.mock.calls[3]
    expect(url).toBe('https://welding.invalid/api/v1/plugins/welding/resources/import/preview?format=csv')
    expect(options.method).toBe('POST')
    expect(options.headers['Content-Type']).toBe('application/octet-stream')
    expect(Buffer.from(options.body)).toEqual(bytes)
    expect(mocks.query.mock.calls.length).toBeGreaterThan(3)
  })

  it('keeps all validated late and file-level issues with ready=false', async () => {
    const value = { ...preview(100, false), rows: rows(99), errors: [
      { row: null, column: '', code: 'file', message: 'File issue' },
      { row: 101, column: 'number', code: 'duplicate', message: 'Last row issue' },
    ] }
    queue(json(value))
    const result = await post(previewPath)
    expect(result.status).toBe(200)
    expect(result.body.ready).toBe(false)
    expect(result.body.errors).toEqual(value.errors)
  })

  it('accepts a zero-data-row ready=false preview only with its complete file-level issue', async () => {
    const value = { ...preview(0, false), errors: [{ row: null, column: '', code: 'empty',
      message: 'Import requires at least one data row' }] }
    queue(json(value))
    const result = await post(previewPath)
    expect(result.status).toBe(200)
    expect(result.body).toEqual(value)
    queue(json({ ...value, ready: true, preview_digest: digest, errors: [] }))
    expect((await post(previewPath)).body.error.code).toBe('WELDING_UPSTREAM_REJECTED')
  })

  it('returns exact template binary bytes and rejects a full stream beyond 1 MiB', async () => {
    const original = Buffer.alloc(1024 * 1024, 255)
    queue(new Response(original, { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': String(original.length),
      'Content-Disposition': 'attachment; filename="welding-resource-import-v1.csv"' } }))
    const okay = await get('/api/welding/resources/import/templates/csv').buffer(true)
      .parse((incoming, callback) => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
        incoming.on('end', () => callback(null, Buffer.concat(chunks)))
        incoming.on('error', callback)
      })
    expect(okay.status).toBe(200)
    expect(okay.body).toEqual(original)
    expect(okay.headers['content-disposition']).toBe('attachment; filename="welding-resource-import-v1.csv"')
    queue(new Response(Buffer.alloc(original.length + 1), { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="welding-resource-import-v1.csv"' } }))
    expect((await get('/api/welding/resources/import/templates/csv')).status).toBe(502)
  })

  it.each([
    ['/api/welding/resources/import/preview?format=csv&format=csv', 'post'],
    ['/api/welding/resources/import/preview?format=csv&extra=1', 'post'],
    ['/api/welding/resources/import/commit?format=csv&import_id=x&preview_digest=BAD', 'post'],
    ['/api/welding/resources/import/preview?format=csv?extra=1', 'post'],
    ['/api/welding/resources/import/templates/csv?format=csv', 'get'],
    ['/api/welding/resources/import/templates/csv', 'post'],
  ] as const)('rejects unlisted %s before identity or Y IO', async (path, method) => {
    const result = method === 'get' ? await get(path) : await post(path)
    expect(result.status).toBe(400)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(result.headers['x-content-type-options']).toBe('nosniff')
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects compressed, JSON and over-5-MiB declared upload before identity', async () => {
    for (const build of [() => post(previewPath).set('Content-Encoding', 'gzip'),
      () => post(previewPath).set('Content-Type', 'application/json')]) {
      const result = await build()
      expect(result.status).toBe(400)
    }
    const oversized = await post(previewPath).set('Content-Length', String(5 * 1024 * 1024 + 1))
    expect(oversized.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.verifyToken).not.toHaveBeenCalled()
  })

  it('counts actual chunked ingress beyond 5 MiB without trusting a declared length', async () => {
    const server = createServer(app())
    await new Promise<void>(resolve => server.listen(0, resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing local address')
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = httpRequest({ port: address.port, method: 'POST', path: previewPath,
          headers: { Authorization: 'Bearer ms-session', 'Content-Type': 'application/octet-stream',
            'Transfer-Encoding': 'chunked' } }, incoming => {
          incoming.resume()
          incoming.on('end', () => resolve(incoming.statusCode || 0))
        })
        outgoing.on('error', reject)
        outgoing.write(Buffer.alloc(5 * 1024 * 1024))
        outgoing.end(Buffer.from([1]))
      })
      expect(status).toBe(413)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(mocks.verifyToken).not.toHaveBeenCalled()
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it('expires a slow chunked upload on the same 300-second import deadline', async () => {
    const server = createServer(app())
    await new Promise<void>(resolve => server.listen(0, resolve))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    let outgoing: ReturnType<typeof httpRequest> | undefined
    let delivered = 0
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing local address')
      const status = new Promise<number>((resolve, reject) => {
        outgoing = httpRequest({ port: address.port, method: 'POST', path: previewPath,
          headers: { Authorization: 'Bearer ms-session', 'Content-Type': 'application/octet-stream',
            'Transfer-Encoding': 'chunked' } }, incoming => {
          incoming.resume()
          incoming.on('end', () => { delivered = incoming.statusCode || 0; resolve(delivered) })
        })
        outgoing.on('error', reject)
        outgoing.write(Buffer.from([1]))
      })
      void status.catch(() => {})
      await until(() => timerSpy.mock.calls.some(([, delay]) => delay === 300000))
      expect(delivered).toBe(0)
      await vi.advanceTimersByTimeAsync(300000)
      await until(() => delivered !== 0)
      expect(delivered).toBe(502)
      outgoing?.destroy()
      expect(await status).toBe(502)
      expect(mocks.verifyToken).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      outgoing?.destroy()
      timerSpy.mockRestore()
      vi.useRealTimers()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('keeps preview/read available while commit/write is off', async () => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    queue(json(preview(1)))
    expect((await post(previewPath)).status).toBe(200)
    const blocked = await post(commitPath)
    expect(blocked.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(mocks.verifyToken).toHaveBeenCalled()
  })

  it('rejects a wrong personal Y owner before import dispatch', async () => {
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'personal-bearer', token_type: 'bearer', expires_in: 3600,
        tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json({ ...authority, owner: { ...authority.owner, auth_user_id: 99 } }))
    const result = await post(commitPath)
    expect(result.body.error.code).toBe('WELDING_UPSTREAM_REJECTED')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('checks the read flag after the final awaited native sid query before preview dispatch', async () => {
    let queriesAfterAuthority = 0
    mocks.query.mockImplementation(async () => {
      if (fetchMock.mock.calls.length === 3 && ++queriesAfterAuthority === 2)
        vi.stubEnv('WELDING_READ_ENABLED', 'false')
      return { rows: [{ id: 'sid1' }] }
    })
    queue(json(preview(1)))
    const result = await post(previewPath)
    expect(result.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('accepts only a complete 201 receipt, including the last row, and preserves UNKNOWN on a bad ACK', async () => {
    queue(json(receipt(100), 201))
    const okay = await post(commitPath)
    expect(okay.status).toBe(201)
    expect(okay.body.items).toHaveLength(100)
    expect(Buffer.from(fetchMock.mock.calls[3][1].body)).toEqual(bytes)
    const invalid = receipt(100)
    invalid.items[99].row_key = 'wrong'
    invalid.items[99].row = 100
    queue(json(invalid, 201))
    const bad = await post(commitPath)
    expect(bad.status).toBe(502)
    expect(bad.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('keeps each malformed or incomplete dispatched receipt UNKNOWN', async () => {
    const changes = [
      (value: ReturnType<typeof receipt>) => { value.preview_digest = 'f'.repeat(64) },
      (value: ReturnType<typeof receipt>) => { value.raw_sha256 = 'f'.repeat(64) },
      (value: ReturnType<typeof receipt>) => { value.normalized_sha256 = 'BAD' },
      (value: ReturnType<typeof receipt>) => { value.items[1].resource_id = value.items[0].resource_id },
      (value: ReturnType<typeof receipt>) => { value.items[1].item_version_id = value.items[0].item_version_id },
      (value: ReturnType<typeof receipt>) => { value.items[1].state = 'Released' },
      (value: ReturnType<typeof receipt>) => { value.items.pop() },
    ]
    for (const change of changes) {
      const value = receipt(2)
      change(value)
      queue(json(value, 201))
      const result = await post(commitPath)
      expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
    }
    queue(new Response(Uint8Array.from([0xff]), { status: 201,
      headers: { 'Content-Type': 'application/json' } }))
    expect((await post(commitPath)).body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('forwards complete bounded structured issues but never partial ones', async () => {
    const issues = Array.from({ length: 250 }, (_, i) => ({ row: i % 100 + 2, column: 'number',
      code: 'duplicate', message: `Issue ${i}` }))
    queue(json({ detail: { message: 'Invalid resource import', errors: issues } }, 422))
    const known = await post(commitPath)
    expect(known.status).toBe(422)
    expect(known.body.error).toEqual({ code: 'WELDING_UPSTREAM_REJECTED', message: 'Invalid resource import', issues })
    queue(json({ detail: { message: 'Invalid resource import', errors: issues, extra: true } }, 422))
    const invalid = await post(commitPath)
    expect(invalid.status).toBe(502)
    expect(invalid.body.error).toEqual({ code: 'WELDING_RESULT_UNKNOWN' })
    queue(json({ detail: 'Resource import setup unavailable' }, 503))
    const plain = await post(commitPath)
    expect(plain.status).toBe(503)
    expect(plain.body.error).toEqual({ code: 'WELDING_UPSTREAM_REJECTED' })
    queue(new Response(Buffer.alloc(1024 * 1024 + 1), { status: 422,
      headers: { 'Content-Type': 'application/json' } }))
    const oversized = await post(commitPath)
    expect(oversized.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('rejects whole preview beyond 32 MiB and keeps oversized receipt UNKNOWN', async () => {
    queue(new Response(Buffer.alloc(32 * 1024 * 1024 + 1), { status: 200,
      headers: { 'Content-Type': 'application/json' } }))
    const previewResult = await post(previewPath)
    expect(previewResult.body.error.code).toBe('WELDING_UPSTREAM_REJECTED')
    queue(new Response(Buffer.alloc(1024 * 1024 + 1), { status: 201,
      headers: { 'Content-Type': 'application/json' } }))
    const receiptResult = await post(commitPath)
    expect(receiptResult.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('accepts exact declared JSON response caps without truncating the payload', async () => {
    const previewBytes = paddedJson(preview(1), 32 * 1024 * 1024)
    queue(new Response(previewBytes, { status: 200, headers: {
      'Content-Type': 'application/json', 'Content-Length': String(previewBytes.length),
    } }))
    const checked = await post(previewPath)
    expect(checked.status).toBe(200)
    expect(checked.body.rows).toHaveLength(1)
    const receiptBytes = paddedJson(receipt(1), 1024 * 1024)
    queue(new Response(receiptBytes, { status: 201, headers: {
      'Content-Type': 'application/json', 'Content-Length': String(receiptBytes.length),
    } }))
    const committed = await post(commitPath)
    expect(committed.status).toBe(201)
    expect(committed.body.items).toHaveLength(1)
  })

  it('rejects malformed or mismatched declared response lengths as whole-result failures', async () => {
    queue(new Response(JSON.stringify(preview(1)), { status: 200, headers: {
      'Content-Type': 'application/json', 'Content-Length': '1',
    } }))
    expect((await post(previewPath)).body.error.code).toBe('WELDING_UPSTREAM_REJECTED')
    queue(new Response(JSON.stringify(receipt(1)), { status: 201, headers: {
      'Content-Type': 'application/json', 'Content-Length': '0001',
    } }))
    expect((await post(commitPath)).body.error.code).toBe('WELDING_RESULT_UNKNOWN')
    queue(new Response(Buffer.alloc(1), { status: 200, headers: {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': String(1024 * 1024 + 1),
      'Content-Disposition': 'attachment; filename="welding-resource-import-v1.csv"',
    } }))
    expect((await get('/api/welding/resources/import/templates/csv')).body.error.code).toBe('WELDING_UPSTREAM_REJECTED')
  })

  it('keeps commit UNKNOWN after an ACK arrives but native sid is revoked', async () => {
    queue(json(receipt(1), 201))
    mocks.query.mockImplementation(async () => ({ rows: fetchMock.mock.calls.length === 4 ? [] : [{ id: 'sid1' }] }))
    const result = await post(commitPath)
    expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('applies one 300-second deadline across a slow native session and a hung Y response', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let enteredNative!: () => void, enteredUpstream!: () => void
      const nativeStarted = new Promise<void>(resolve => { enteredNative = resolve })
      const upstreamStarted = new Promise<void>(resolve => { enteredUpstream = resolve })
      mocks.query.mockImplementationOnce(() => new Promise(resolve => {
        setTimeout(() => resolve({ rows: [{ id: 'sid1' }] }), 200000); enteredNative()
      }))
        .mockResolvedValue({ rows: [{ id: 'sid1' }] })
      fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
        .mockResolvedValueOnce(json({ access_token: 'personal-bearer', token_type: 'bearer', expires_in: 3600,
          tenant_id: 'yt', user_id: 71 }))
        .mockResolvedValueOnce(json(authority)).mockImplementationOnce(() => { enteredUpstream(); return new Promise(() => {}) })
      const pending = post(commitPath).then(result => result)
      await nativeStarted
      expect(fetchMock).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(200000)
      await upstreamStarted
      expect(fetchMock).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(100000)
      const result = await pending
      expect(result.status).toBe(502)
      expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
    } finally { vi.useRealTimers() }
  })

  it('expires a stalled Y body reader after commit dispatch without leaking a partial ACK', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      queue(new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 201,
        headers: { 'Content-Type': 'application/json' } }))
      const pending = post(commitPath).then(result => result)
      await until(() => fetchMock.mock.calls.length === 4)
      await vi.advanceTimersByTimeAsync(300000)
      const result = await pending
      expect(result.status).toBe(502)
      expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
    } finally { vi.useRealTimers() }
  })

  it('expires a hung final sid recheck and ignores its late completion after UNKNOWN', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let finishCheck: ((value: { rows: Array<{ id: string }> }) => void) | undefined
    try {
      mocks.query.mockImplementation(() => fetchMock.mock.calls.length === 4 ?
        new Promise(resolve => { finishCheck = resolve }) : Promise.resolve({ rows: [{ id: 'sid1' }] }))
      queue(json(receipt(1), 201))
      const pending = post(commitPath).then(result => result)
      await until(() => finishCheck !== undefined)
      await vi.advanceTimersByTimeAsync(300000)
      const result = await pending
      expect(result.status).toBe(502)
      expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
      finishCheck?.({ rows: [{ id: 'sid1' }] })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(fetchMock).toHaveBeenCalledTimes(4)
      expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
    } finally { vi.useRealTimers() }
  })
})
