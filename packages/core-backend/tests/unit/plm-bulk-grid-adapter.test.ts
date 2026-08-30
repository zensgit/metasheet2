/**
 * MetaSheet bulk item-property grid — PLMAdapter credential-seam tests.
 *
 * Taskbook: docs/development/DEVELOPMENT_TASK_METASHEET_BULK_GRID_CONSUMER_20260829.md
 *
 * The headline test here is "never falls back to the service account". Taskbook §2 confines
 * the whole grid to Family I (the caller's own full login) and §10's first exclusion forbids
 * "a service account that commits on an engineer's behalf". A silent fallback to the
 * adapter's shared service token would satisfy `require_admin_user` with the WRONG identity
 * and delete the maker-checker property the lane exists for — while every individual HTTP
 * call still looked valid, so Pact could never catch it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'

const CALLER_TOKEN = 'caller.jwt.token'
const SERVICE_TOKEN = 'service.account.token'

function createAdapter(mode: 'yuantus' | 'legacy' = 'yuantus') {
  const configService = { get: vi.fn().mockResolvedValue(undefined) }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const adapter = new PLMAdapter(configService as never, logger as never)
  const internals = adapter as unknown as {
    apiMode: string
    mockMode: boolean
    authToken: string | null
    authTokenExpiresAt: number
    config: { connection: { baseURL: string; url: string; headers: Record<string, string> } }
  }
  internals.apiMode = mode
  internals.mockMode = false
  // A service-account token IS cached on the instance — exactly the state in which a silent
  // fallback would be invisible. Every assertion below runs against this loaded gun.
  internals.authToken = SERVICE_TOKEN
  internals.authTokenExpiresAt = Date.now() + 60 * 60 * 1000
  internals.config.connection.baseURL = 'https://plm.example'
  internals.config.connection.url = 'https://plm.example'
  internals.config.connection.headers = {
    'x-tenant-id': 'tenant-1',
    Authorization: `Bearer ${SERVICE_TOKEN}`,
  }
  return adapter
}

const SUBMISSION = {
  itemTypeId: 'Part',
  matchProperty: 'item_number',
  fileName: 'grid.csv',
  content: 'item_number,name\r\nP-001,Bracket',
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ ready: true, row_errors: [] }))
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('§2/§10 — the caller credential is an argument, never adapter state', () => {
  it('dry-run sends the CALLER token, not the cached service account', async () => {
    const adapter = createAdapter()
    await adapter.bulkImportDryRun(CALLER_TOKEN, SUBMISSION)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://plm.example/api/v1/bulk-import/dry-run')
    expect(init.headers.Authorization).toBe(`Bearer ${CALLER_TOKEN}`)
    expect(init.headers.Authorization).not.toContain(SERVICE_TOKEN)
  })

  it('commit sends the CALLER token, not the cached service account', async () => {
    const adapter = createAdapter()
    await adapter.bulkImportCommit(CALLER_TOKEN, SUBMISSION, 'key-0001')

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://plm.example/api/v1/bulk-import/commit')
    expect(init.headers.Authorization).toBe(`Bearer ${CALLER_TOKEN}`)
    expect(init.headers.Authorization).not.toContain(SERVICE_TOKEN)
  })

  it('the schema read used by the serializer also travels on the CALLER token (§2: one family)', async () => {
    // If the declared-property list were fetched on the service account while the write went
    // out on the user, the grid would straddle two credential families for one screen.
    fetchSpy.mockResolvedValue(jsonResponse({ id: 'Part', properties: [{ name: 'item_number', required: true }] }))
    const adapter = createAdapter()
    await adapter.getItemMetadataAsCaller(CALLER_TOKEN, 'Part')

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://plm.example/api/v1/aml/metadata/Part')
    expect(init.headers.Authorization).toBe(`Bearer ${CALLER_TOKEN}`)
    expect(init.headers.Authorization).not.toContain(SERVICE_TOKEN)
  })

  it('two callers on the SAME adapter instance get their OWN PLM identity', async () => {
    // The live shape of the §2/§10 hazard. DataSourceManager keys adapters by data-source id,
    // so ONE PLMAdapter instance serves every MetaSheet user of that source, and these are
    // instance methods. If the caller token were ever cached onto `this` as an "optimization",
    // the second caller would silently inherit the first caller's PLM identity -- including
    // their admin-ness -- and every individual HTTP call would still look valid, so Pact could
    // never catch it. This is the assertion that survives that refactor.
    const adapter = createAdapter()
    await adapter.bulkImportDryRun('token-A', SUBMISSION)
    await adapter.bulkImportCommit('token-B', SUBMISSION, 'key-1')
    await adapter.getItemMetadataAsCaller('token-C', 'Part')

    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer token-A')
    expect(fetchSpy.mock.calls[1][1].headers.Authorization).toBe('Bearer token-B')
    expect(fetchSpy.mock.calls[2][1].headers.Authorization).toBe('Bearer token-C')
  })

  it('a caller token does not leak onto the adapter for the NEXT caller to inherit', async () => {
    const adapter = createAdapter()
    await adapter.bulkImportCommit('admin-token', SUBMISSION, 'key-1')
    // The instance's own cached credential must be untouched by the call above...
    expect((adapter as unknown as { authToken: string }).authToken).toBe(SERVICE_TOKEN)
    // ...and a subsequent blank-credential call must still fail closed rather than reuse it.
    const result = await adapter.bulkImportCommit('', SUBMISSION, 'key-2')
    expect(result.error!.message).toContain('caller PLM credential is required')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['dry-run', (a: PLMAdapter, t: string) => a.bulkImportDryRun(t, SUBMISSION)],
    ['commit', (a: PLMAdapter, t: string) => a.bulkImportCommit(t, SUBMISSION, 'key-0001')],
    ['metadata', (a: PLMAdapter, t: string) => a.getItemMetadataAsCaller(t, 'Part')],
  ])(
    'NEVER falls back to the service account: %s fails closed on a blank caller credential',
    async (_label, call) => {
      const adapter = createAdapter()
      for (const blank of ['', '   ', undefined as unknown as string, null as unknown as string]) {
        const result = await call(adapter, blank)
        expect(result.error).toBeDefined()
        expect(result.error!.message).toContain('caller PLM credential is required')
        expect(result.data).toEqual([])
      }
      // The decisive assertion: no request was ever issued. A fallback would have sent one
      // bearing the service token and looked, from the provider's side, entirely legitimate.
      expect(fetchSpy).not.toHaveBeenCalled()
    },
  )
})

describe('multipart transport', () => {
  it('sends a FormData body and sets NO Content-Type (fetch must derive the boundary)', async () => {
    const adapter = createAdapter()
    await adapter.bulkImportDryRun(CALLER_TOKEN, SUBMISSION)

    const [, init] = fetchSpy.mock.calls[0]
    expect(init.body).toBeInstanceOf(FormData)
    // A hand-set Content-Type produces a boundary-less header the provider cannot parse.
    const headerKeys = Object.keys(init.headers).map((k) => k.toLowerCase())
    expect(headerKeys).not.toContain('content-type')
  })

  it('carries item_type_id, match_property and the file part', async () => {
    const adapter = createAdapter()
    await adapter.bulkImportDryRun(CALLER_TOKEN, SUBMISSION)

    const form = fetchSpy.mock.calls[0][1].body as FormData
    expect(form.get('item_type_id')).toBe('Part')
    expect(form.get('match_property')).toBe('item_number')
    const file = form.get('file') as File
    expect(file).toBeInstanceOf(Blob)
    expect(await (file as Blob).text()).toBe(SUBMISSION.content)
  })

  it('omits match_property entirely in create-only mode (N3-A fallback)', async () => {
    const adapter = createAdapter()
    await adapter.bulkImportDryRun(CALLER_TOKEN, { ...SUBMISSION, matchProperty: undefined })

    const form = fetchSpy.mock.calls[0][1].body as FormData
    expect(form.has('match_property')).toBe(false)
  })

  it('labels an .xlsx submission with the spreadsheet content type', async () => {
    const adapter = createAdapter()
    await adapter.bulkImportDryRun(CALLER_TOKEN, { ...SUBMISSION, fileName: 'grid.xlsx' })

    const form = fetchSpy.mock.calls[0][1].body as FormData
    expect((form.get('file') as Blob).type).toContain('spreadsheetml.sheet')
  })

  it('forwards the tenant header and the Idempotency-Key on commit', async () => {
    const adapter = createAdapter()
    await adapter.bulkImportCommit(CALLER_TOKEN, SUBMISSION, 'key-0001')

    const [, init] = fetchSpy.mock.calls[0]
    expect(init.headers['x-tenant-id']).toBe('tenant-1')
    expect(init.headers['Idempotency-Key']).toBe('key-0001')
  })

  it('dry-run sends NO Idempotency-Key (it is a commit-only concern)', async () => {
    const adapter = createAdapter()
    await adapter.bulkImportDryRun(CALLER_TOKEN, SUBMISSION)

    const headerKeys = Object.keys(fetchSpy.mock.calls[0][1].headers).map((k) => k.toLowerCase())
    expect(headerKeys).not.toContain('idempotency-key')
  })
})

describe('response handling (§3: branch on `ready`, never on the status code)', () => {
  it('returns a reject-all 200 as DATA, not as an error', async () => {
    // The trap this pins: a total rejection is HTTP 200 with ready:false and writes nothing.
    // Surfacing it as a transport error would make the UI retry; treating the 200 as success
    // would report a write that never happened.
    fetchSpy.mockResolvedValue(
      jsonResponse({
        ready: false,
        row_errors: [{ row_number: 2, property_name: 'name', error_code: 'MISSING_REQUIRED_VALUE', message: 'required' }],
        created_ids: [],
      }),
    )
    const adapter = createAdapter()
    const result = await adapter.bulkImportCommit(CALLER_TOKEN, SUBMISSION, 'key-0001')

    expect(result.error).toBeUndefined()
    expect(result.data[0].ready).toBe(false)
    expect(result.data[0].row_errors).toHaveLength(1)
  })

  it('surfaces a 409 idempotency_conflict with its discriminating detail.code', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ detail: { code: 'idempotency_conflict', message: 'Idempotency-Key reused' } }, 409),
    )
    const adapter = createAdapter()
    const result = await adapter.bulkImportCommit(CALLER_TOKEN, SUBMISSION, 'key-0001')

    expect(result.error).toBeDefined()
    const attached = (result.error as Error & { response?: { status: number; data: unknown } }).response
    expect(attached?.status).toBe(409)
    expect((attached?.data as { detail: { code: string } }).detail.code).toBe('idempotency_conflict')
  })

  it('surfaces a 413 as a real, expected response (BULK_IMPORT_MAX_BYTES may be set)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ detail: 'file too large' }, 413))
    const adapter = createAdapter()
    const result = await adapter.bulkImportDryRun(CALLER_TOKEN, SUBMISSION)

    expect(result.error).toBeDefined()
    expect(
      (result.error as Error & { response?: { status: number } }).response?.status,
    ).toBe(413)
  })

  it('never throws on a network failure', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'))
    const adapter = createAdapter()
    const result = await adapter.bulkImportCommit(CALLER_TOKEN, SUBMISSION, 'key-0001')

    expect(result.error).toBeDefined()
    expect(result.data).toEqual([])
  })

  it('refuses a non-yuantus API mode without issuing a request', async () => {
    const adapter = createAdapter('legacy')
    const result = await adapter.bulkImportCommit(CALLER_TOKEN, SUBMISSION, 'key-0001')

    expect(result.error?.message).toContain('not supported for this PLM API mode')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  /**
   * The other side of §11's double-create hole.
   *
   * A 2xx whose body cannot be read used to come back as `{data: [undefined]}` with no error.
   * The route normalized `undefined` into `{ready: false}` and answered 200, the client read
   * that as a REJECT-ALL — "nothing was written" — and minted a fresh Idempotency-Key. But the
   * provider answered 2xx: on the commit path the write may have LANDED, so the next submission
   * under a new key would create every row a second time. Exactly what the same-key retry
   * exists to prevent, reached from the opposite direction.
   */
  it('treats a 2xx with an UNREADABLE body as unknown, never as an empty report', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected end of JSON input') },
    } as unknown as Response)
    const adapter = createAdapter()
    const result = await adapter.bulkImportCommit(CALLER_TOKEN, SUBMISSION, 'key-0001')

    expect(result.data).toEqual([])
    expect(result.error).toBeDefined()
    expect(result.error!.message).toContain('UNKNOWN')
  })

  it('treats a 2xx carrying a NON-OBJECT body the same way', async () => {
    // `null` is the sharp one: it parses fine, so a truthiness-free check would let it through
    // and reproduce the phantom reject-all.
    for (const body of [null, 'ok', 42]) {
      fetchSpy.mockResolvedValue(jsonResponse(body))
      const adapter = createAdapter()
      const result = await adapter.bulkImportCommit(CALLER_TOKEN, SUBMISSION, 'key-0001')

      expect(result.error, JSON.stringify(body)).toBeDefined()
      expect(result.data, JSON.stringify(body)).toEqual([])
    }
  })

  it('still lets a REAL reject-all report through — the guard must not swallow ready:false', async () => {
    // The failure mode of the fix itself: rejecting too much would turn every total rejection
    // into a retryable "unknown", and §3's whole point is that a reject-all is a valid 200.
    fetchSpy.mockResolvedValue(jsonResponse({ ready: false, row_errors: [], created_ids: [] }))
    const adapter = createAdapter()
    const result = await adapter.bulkImportCommit(CALLER_TOKEN, SUBMISSION, 'key-0001')

    expect(result.error).toBeUndefined()
    expect(result.data[0].ready).toBe(false)
  })
})
