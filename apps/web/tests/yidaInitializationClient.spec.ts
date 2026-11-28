import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import ts from 'typescript'
import * as principal from '../src/composables/authPrincipal'
import * as explicitSession from '../src/utils/explicitSessionOrg'
import { createYidaInitializationClient, type YidaInitializationInput, type YidaInitializationMaterial } from '../src/services/integration/yidaInitialization'
import { createYidaProtocolExample } from '../../../plugins/plugin-integration-core/lib/yida-static-plan.mjs'
import type { YidaOwnerDraftInput } from '../src/services/integration/yidaOwner'

// Mocked HTTP/jsdom evidence only: no real JWT validation, deployment anchor,
// PG durability, native Chromium or external credentials/requests are claimed.
const ids = { command: '11111111-1111-4111-8111-111111111111', other: '22222222-2222-4222-8222-222222222222',
  target: '33333333-3333-4333-8333-333333333333', operation: '44444444-4444-4444-8444-444444444444', row: '55555555-5555-4555-8555-555555555555' }
const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTWU4tT1dORVIiLCJ0ZW5hbnRJZCI6IlNZTi1PUkcifQ.c3ludGhldGlj'
function draftInput(): YidaOwnerDraftInput {
  const example = createYidaProtocolExample('primary')
  return { config: example.config, rowsText: example.text, allocation: { mode: 'original' } }
}
function metadata() { return { targetRef: ids.target, operationId: ids.operation, status: 'unverified', identityKind: 'local-unverified',
  canSend: false, canApply: false, tokenIssued: false, externalWriteAttempted: false, rowCount: 1, rows: [{ rowKey: ids.row, index: 0 }], reused: false } }
// Like the server: connectionTestEnabled is present (true) only while the switch is on, else absent.
function ready(sendEnabled = false, connectionTestEnabled = false) { return { commandId: ids.command, status: 'ready', draft: null, canSend: false, tokenIssued: false, externalWriteAttempted: false, sendEnabled,
  ...(connectionTestEnabled ? { connectionTestEnabled: true } : {}) } }
function initialized(sendEnabled = false, connectionTestEnabled = false) { return { ...ready(sendEnabled, connectionTestEnabled), status: 'initialized', draft: metadata() } }
// What the operator pastes (surrounding blanks and a trailing line break the password box hides) and what is
// sent: the same text with its edges trimmed, inner bytes unchanged. The server refuses the padded form.
const pasted: YidaInitializationMaterial = { appKey: ' SYN-KEY原字节\r\n', appSecret: '\tSYN-SECRET原字节\n', systemToken: '\u00a0SYN-TOKEN原字节\r\n', userId: 'SYN-EXECUTION' }
const material: YidaInitializationMaterial = { appKey: 'SYN-KEY原字节', appSecret: 'SYN-SECRET原字节', systemToken: 'SYN-TOKEN原字节', userId: 'SYN-EXECUTION' }
// Invisible test characters are built from code units at run time, so the source holds neither a raw
// invisible character nor an escape that an editor could rewrite into one.
const codeUnit = (code: number) => String.fromCharCode(code)
function payload(): YidaInitializationInput { return { commandId: ids.command, material: { ...material }, draft: draftInput(),
  attestation: { kind: 'owner-reviewed-target', reviewRef: 'SYN-REVIEW', organizationId: 'SYN-ORG', executionIdentity: material.userId } } }
function json(data: unknown, status = 200) { return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } }) }
function error(code: string, status = 503) { return new Response(JSON.stringify({ ok: false, error: { code } }), { status, headers: { 'Content-Type': 'application/json' } }) }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); await nextTick() }
const fetchSpy = vi.fn()
beforeEach(() => { localStorage.setItem('auth_token', token); fetchSpy.mockReset(); vi.stubGlobal('fetch', fetchSpy) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('Yida initialization actual service boundaries', () => {
  const clients: ReturnType<typeof createYidaInitializationClient>[] = []
  afterEach(() => { for (const client of clients.splice(0)) client.dispose() })
  const client = () => { const value = createYidaInitializationClient(); clients.push(value); return value }
  it('requires explicit ready GET, consumes it once, and blocks concurrent/repeated POST', async () => {
    const value = client(); await expect(value.initialize(payload())).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_STATE_UNCONFIRMED' })
    fetchSpy.mockResolvedValueOnce(json(ready())); await value.observe()
    const pending = deferred<Response>(); fetchSpy.mockReturnValueOnce(pending.promise); const post = value.initialize(payload())
    await expect(value.initialize(payload())).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_STATE_UNCONFIRMED' })
    await expect(value.observe()).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_STATE_UNCONFIRMED' })
    pending.resolve(json(initialized(), 201)); await post
    await expect(value.initialize(payload())).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_STATE_UNCONFIRMED' }); expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
  it.each([
    { ...ready(), canSend: true }, { ...ready(), tokenIssued: true }, { ...ready(), externalWriteAttempted: true },
    { ...ready(), material }, { ...ready(), draft: metadata() }, { ...initialized(), draft: null }, { ...ready(), sendEnabled: 'true' },
    { ...initialized(), draft: { ...metadata(), rows: [{ rowKey: ids.row, index: 1 }] } },
    { ...initialized(), draft: { ...metadata(), rowCount: 2, rows: [{ rowKey: ids.row, index: 0 }, { rowKey: ids.row, index: 1 }] } },
    { ...initialized(), draft: { ...metadata(), canApply: true } },
  ])('rejects non-closed or inconsistent local state before rendering (%#)', async data => {
    fetchSpy.mockResolvedValueOnce(json(data)); await expect(client().observe()).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' })
  })
  it.each([
    { ok: false, error: { code: 'YIDA_INITIALIZATION_UNAVAILABLE', message: 'SYN-PRIVATE' } },
    { ok: false, error: { code: 'SYN-PRIVATE' } },
    { ok: false, error: { code: 'YIDA_INITIALIZATION_INPUT' } },
  ])('does not read or accept foreign error detail/status (%#)', async envelope => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(envelope), { status: 503, headers: { 'Content-Type': 'application/json' } }))
    await expect(client().observe()).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' })
  })
  it('decodes ENCRYPTION_NOT_READY only with its own status 503', async () => {
    const value = client(); fetchSpy.mockResolvedValueOnce(json(ready())); await value.observe()
    fetchSpy.mockResolvedValueOnce(error('YIDA_INITIALIZATION_ENCRYPTION_NOT_READY', 503))
    await expect(value.initialize(payload())).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_ENCRYPTION_NOT_READY' })
    const other = client(); fetchSpy.mockResolvedValueOnce(json(ready())); await other.observe()
    fetchSpy.mockResolvedValueOnce(error('YIDA_INITIALIZATION_ENCRYPTION_NOT_READY', 409))
    await expect(other.initialize(payload())).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' })
  })
  it('uses original reader and rejects a response at EOF after cancellation, even if transport ignores signal', async () => {
    const end = deferred<ReadableStreamReadResult<Uint8Array>>(), release = vi.fn(), caller = new AbortController()
    let reads = 0
    fetchSpy.mockResolvedValueOnce({ status: 200, ok: true, headers: new Headers({ 'Content-Type': 'application/json' }),
      body: { getReader: () => ({ read: () => ++reads === 1 ? Promise.resolve({ done: false, value: new TextEncoder().encode(JSON.stringify({ ok: true, data: ready() })) }) : end.promise, releaseLock: release }) },
      json() { throw new Error('SECOND_BODY_READER') }, text() { throw new Error('SECOND_BODY_READER') } })
    const value = client(), request = value.observe(caller.signal); await flush(); caller.abort(); end.resolve({ done: true, value: undefined })
    await expect(request).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_CANCELLED' }); expect(release).toHaveBeenCalledTimes(1); expect(reads).toBe(2)
  })
  it('rejects a session drift at EOF and disposes notifications without retry', async () => {
    const end = deferred<ReadableStreamReadResult<Uint8Array>>(); let reads = 0
    fetchSpy.mockResolvedValueOnce({ status: 200, ok: true, headers: new Headers({ 'Content-Type': 'application/json' }), body: { getReader: () => ({
      read: () => ++reads === 1 ? Promise.resolve({ done: false, value: new TextEncoder().encode(JSON.stringify({ ok: true, data: ready() })) }) : end.promise, releaseLock() {} }) } })
    const invalidated = vi.fn(), value = createYidaInitializationClient({ onInvalidated: invalidated }); clients.push(value)
    const request = value.observe(); await flush(); localStorage.setItem('auth_token', `${token}B`); end.resolve({ done: true, value: undefined })
    await expect(request).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_SESSION_CHANGED' }); expect(invalidated).toHaveBeenCalledTimes(1)
    principal.notifyAuthPrincipalChange(); expect(invalidated).toHaveBeenCalledTimes(1); expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
  it.each([
    { headers: { 'Content-Type': 'text/plain' }, text: '{}' },
    { headers: { 'Content-Type': 'application/json', 'Content-Length': '1048577' }, text: '{}' },
    { headers: { 'Content-Type': 'application/json', 'Content-Length': '-1' }, text: '{}' },
    { headers: { 'Content-Type': 'application/json' }, text: ' '.repeat(1048577) },
  ])('bounds response metadata and actual streamed bytes (%#)', async sample => {
    const headers = new Headers(Object.entries(sample.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    fetchSpy.mockResolvedValueOnce(new Response(sample.text, { headers })); await expect(client().observe()).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' })
  })
  it('keeps the original 15-second logical cancellation bound without retry', async () => {
    vi.useFakeTimers(); const pending = deferred<Response>(); fetchSpy.mockReturnValueOnce(pending.promise)
    const value = client(), request = value.observe(); await vi.advanceTimersByTimeAsync(15000)
    pending.resolve(json(ready())); await expect(request).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_CANCELLED' }); expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

// These probes compile the actual service source in memory with one exact guard
// removed. They do not rewrite product files or claim native/PG mutation proof.
const serviceSource = readFileSync(resolve(__dirname, '../src/services/integration/yidaInitialization.ts'), 'utf8')
function memoryService(anchor: string, replacement: string) {
  expect(serviceSource.split(anchor).length - 1).toBe(1)
  const code = ts.transpileModule(serviceSource.replace(anchor, replacement), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, unknown> = {}
  const require = (id: string) => { if (id === '../../composables/authPrincipal') return principal; if (id === '../../utils/explicitSessionOrg') return explicitSession; throw new Error('MUTATION_IMPORT_OUT_OF_SCOPE') }
  new Function('require', 'exports', code)(require, exports)
  return exports.createYidaInitializationClient as typeof createYidaInitializationClient
}
describe('actual service guard-removal negative probes', () => {
  it.each([
    { name: 'closed extra fields', anchor: ' || Object.keys(row).some(key => !keys.includes(key))', replacement: '', data: { ...ready(), material } },
    { name: 'canSend false', anchor: 'row.canSend !== false || row.tokenIssued !== false || row.externalWriteAttempted !== false', replacement: 'row.tokenIssued !== false || row.externalWriteAttempted !== false', data: { ...ready(), canSend: true } },
    { name: 'tokenIssued false', anchor: 'row.canSend !== false || row.tokenIssued !== false || row.externalWriteAttempted !== false', replacement: 'row.canSend !== false || row.externalWriteAttempted !== false', data: { ...ready(), tokenIssued: true } },
    { name: 'externalWrite false', anchor: 'row.canSend !== false || row.tokenIssued !== false || row.externalWriteAttempted !== false', replacement: 'row.canSend !== false || row.tokenIssued !== false', data: { ...ready(), externalWriteAttempted: true } },
    { name: 'boolean sendEnabled', anchor: " || typeof row.sendEnabled !== 'boolean'", replacement: '', data: { ...ready(), sendEnabled: 'true' } },
    { name: 'status draft consistency', anchor: " || (row.status === 'ready') !== (row.draft === null)", replacement: '', data: { ...ready(), draft: metadata() } },
    { name: 'exact row index', anchor: '    if (member.index !== index) invalid()', replacement: '', data: { ...initialized(), draft: { ...metadata(), rows: [{ rowKey: ids.row, index: 1 }] } } },
    { name: 'unique member identity', anchor: '  if (new Set(rows.map(member => member.rowKey)).size !== rows.length) invalid()', replacement: '', data: { ...initialized(), draft: { ...metadata(), rowCount: 2, rows: [{ rowKey: ids.row, index: 0 }, { rowKey: ids.row, index: 1 }] } } },
  ])('removing $name makes the same rejected sample accepted (negative assertion red)', async sample => {
    const baseline = createYidaInitializationClient(); fetchSpy.mockResolvedValueOnce(json(sample.data))
    await expect(baseline.observe()).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' }); baseline.dispose()
    const mutant = memoryService(sample.anchor, sample.replacement)(); fetchSpy.mockResolvedValueOnce(json(sample.data))
    await expect(mutant.observe()).resolves.toBeDefined(); mutant.dispose()
  })
  it('removing persistent command binding accepts replacement UUID on the identical recovery GET', async () => {
    const check = async (factory: typeof createYidaInitializationClient, rejects: boolean) => {
      const value = factory(); fetchSpy.mockResolvedValueOnce(json(ready())); await value.observe(); fetchSpy.mockResolvedValueOnce(json({ ...ready(), commandId: ids.other }))
      if (rejects) await expect(value.observe()).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' })
      else await expect(value.observe()).resolves.toMatchObject({ commandId: ids.other })
      value.dispose()
    }
    await check(createYidaInitializationClient, true)
    await check(memoryService('  if (expectedCommand !== null && commandId !== expectedCommand) invalid()', ''), false)
  })
  it('removing ready consumption lets the same second POST through after lost response', async () => {
    const check = async (factory: typeof createYidaInitializationClient, accepts: boolean) => {
      const value = factory(); fetchSpy.mockResolvedValueOnce(json(ready())); await value.observe(); fetchSpy.mockRejectedValueOnce(new Error('PRIVATE'))
      await expect(value.initialize(payload())).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_UNAVAILABLE' })
      if (accepts) { fetchSpy.mockResolvedValueOnce(json(initialized(), 201)); await expect(value.initialize(payload())).resolves.toBeDefined() }
      else await expect(value.initialize(payload())).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_STATE_UNCONFIRMED' })
      value.dispose()
    }
    await check(createYidaInitializationClient, false)
    await check(memoryService('      ready = false\n      const result = await request(\'POST\'', '      const result = await request(\'POST\''), true)
  })
  it('removing explicit observed-ready admission allows a first POST without GET', async () => {
    const baseline = createYidaInitializationClient()
    await expect(baseline.initialize(payload())).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_STATE_UNCONFIRMED' }); baseline.dispose()
    const mutant = memoryService("      if (!ready || commandId === null || value.commandId !== commandId) throw new YidaInitializationClientError('YIDA_INITIALIZATION_STATE_UNCONFIRMED')", '')()
    fetchSpy.mockResolvedValueOnce(json(initialized(), 201)); await expect(mutant.initialize(payload())).resolves.toBeDefined(); mutant.dispose()
  })
  it('removing request exclusivity lets a second concurrent GET consume another response', async () => {
    const check = async (factory: typeof createYidaInitializationClient, accepts: boolean) => {
      const value = factory(), pending = deferred<Response>(); fetchSpy.mockReturnValueOnce(pending.promise); const first = value.observe()
      if (accepts) { fetchSpy.mockResolvedValueOnce(json(ready())); await expect(value.observe()).resolves.toBeDefined() }
      else await expect(value.observe()).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_STATE_UNCONFIRMED' })
      pending.resolve(json(ready())); await first; value.dispose()
    }
    await check(createYidaInitializationClient, false)
    await check(memoryService("    if (pending) throw new YidaInitializationClientError('YIDA_INITIALIZATION_STATE_UNCONFIRMED')", ''), true)
  })
  it('removing method-bound success status accepts a POST 200 response', async () => {
    const check = async (factory: typeof createYidaInitializationClient, accepts: boolean) => {
      const value = factory(); fetchSpy.mockResolvedValueOnce(json(ready())); await value.observe(); fetchSpy.mockResolvedValueOnce(json(initialized()))
      if (accepts) await expect(value.initialize(payload())).resolves.toBeDefined()
      else await expect(value.initialize(payload())).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' })
      value.dispose()
    }
    await check(createYidaInitializationClient, false)
    await check(memoryService("      if (response.status !== (method === 'GET' ? 200 : 201)) invalid()", ''), true)
  })
  it('removing post initialized outcome validation accepts an unsuccessful ready POST DTO', async () => {
    const check = async (factory: typeof createYidaInitializationClient, accepts: boolean) => {
      const value = factory(); fetchSpy.mockResolvedValueOnce(json(ready())); await value.observe(); fetchSpy.mockResolvedValueOnce(json(ready(), 201))
      if (accepts) await expect(value.initialize(payload())).resolves.toMatchObject({ status: 'ready' })
      else await expect(value.initialize(payload())).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' })
      value.dispose()
    }
    await check(createYidaInitializationClient, false)
    await check(memoryService("      if (result.status !== 'initialized') invalid()", ''), true)
  })
  it('removing original execution identity binding admits a different manual identity without trimming', async () => {
    const check = async (factory: typeof createYidaInitializationClient, accepts: boolean) => {
      const value = factory(); fetchSpy.mockResolvedValueOnce(json(ready())); await value.observe()
      const sample = payload(); const changed = { ...sample, attestation: { ...sample.attestation, executionIdentity: 'SYN-OTHER' } }
      if (accepts) { fetchSpy.mockResolvedValueOnce(json(initialized(), 201)); await expect(value.initialize(changed)).resolves.toBeDefined() }
      else await expect(value.initialize(changed)).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_INPUT_INVALID' })
      value.dispose()
    }
    await check(createYidaInitializationClient, false)
    await check(memoryService(' || reviewed.executionIdentity !== material.userId', ''), true)
  })
  it('removing only whitespace prohibition accepts a noncanonical userId original, not a normalized replacement', async () => {
    const check = async (factory: typeof createYidaInitializationClient, accepts: boolean) => {
      const value = factory(); fetchSpy.mockResolvedValueOnce(json(ready())); await value.observe()
      const sample = payload(), userId = ' SYN-EXECUTION '; const changed = { ...sample, material: { ...sample.material, userId }, attestation: { ...sample.attestation, executionIdentity: userId } }
      if (accepts) { fetchSpy.mockResolvedValueOnce(json(initialized(), 201)); await expect(value.initialize(changed)).resolves.toBeDefined(); expect(JSON.parse(fetchSpy.mock.calls.at(-1)![1].body).material.userId === userId).toBe(true) }
      else await expect(value.initialize(changed)).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_INPUT_INVALID' })
      value.dispose()
    }
    await check(createYidaInitializationClient, false)
    await check(memoryService(' || value.trim() !== value', ''), true)
  })
})


describe('Yida connection test client: observed ready command, closed probe DTO', () => {
  const probeView = (outcome = 'ok') => ({ commandId: ids.command, mode: 'candidate', outcome, tokenIssued: outcome === 'ok',
    tokenRetained: false, externalWriteAttempted: false, canSend: false })
  const clients: ReturnType<typeof createYidaInitializationClient>[] = []
  afterEach(() => { for (const value of clients.splice(0)) value.dispose() })
  const client = () => { const value = createYidaInitializationClient(); clients.push(value); return value }
  const request = () => ({ commandId: ids.command, mode: 'candidate' as const, material: { appKey: material.appKey, appSecret: material.appSecret } })
  it('the client requires the observed ready command, does not consume it, and closes the probe DTO', async () => {
    const value = client()
    await expect(value.testConnection(request())).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_STATE_UNCONFIRMED' })
    fetchSpy.mockResolvedValueOnce(json(ready(false, true))); await value.observe()
    await expect(value.testConnection({ ...request(), commandId: ids.other })).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_STATE_UNCONFIRMED' })
    await expect(value.testConnection({ ...request(), material: { appKey: '   ', appSecret: 'SYN' } })).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_INPUT_INVALID' })
    fetchSpy.mockResolvedValueOnce(json(probeView('ok'))); await expect(value.testConnection(request())).resolves.toEqual(probeView('ok'))
    for (const bad of [{ ...probeView(), token: 'SYN-LEAKED-TOKEN' }, { ...probeView(), tokenRetained: true }, { ...probeView(), canSend: true },
      { ...probeView(), externalWriteAttempted: true }, { ...probeView(), tokenIssued: false }, { ...probeView('timeout'), tokenIssued: true },
      { ...probeView(), outcome: 'SYN' }, { ...probeView(), commandId: ids.other }, { ...probeView(), mode: 'stored' }]) {
      fetchSpy.mockResolvedValueOnce(json(bad)); await expect(value.testConnection(request())).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' })
    }
    fetchSpy.mockResolvedValueOnce(json(probeView('ok'), 201)); await expect(value.testConnection(request())).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' })
    fetchSpy.mockResolvedValueOnce(json(initialized(false, true), 201)); await expect(value.initialize(payload())).resolves.toMatchObject({ status: 'initialized' })
    fetchSpy.mockResolvedValueOnce(json({ ...ready(), connectionTestEnabled: 'true' })); await expect(client().observe()).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' })
  })

  it('removing the boolean connectionTestEnabled check accepts the same rejected state (negative assertion red)', async () => {
    const sample = { ...ready(), connectionTestEnabled: 'true' }
    const baseline = createYidaInitializationClient(); fetchSpy.mockResolvedValueOnce(json(sample))
    await expect(baseline.observe()).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' }); baseline.dispose()
    const mutant = memoryService("  if (probeBit && typeof row.connectionTestEnabled !== 'boolean') invalid()", '')(); fetchSpy.mockResolvedValueOnce(json(sample))
    await expect(mutant.observe()).resolves.toBeDefined(); mutant.dispose()
  })
  it('a reply without connectionTestEnabled (switch off, or an older backend) reads false and initialization still works', async () => {
    const value = client()
    expect(Object.hasOwn(ready(), 'connectionTestEnabled')).toBe(false)
    fetchSpy.mockResolvedValueOnce(json(ready())); await expect(value.observe()).resolves.toMatchObject({ status: 'ready', connectionTestEnabled: false })
    fetchSpy.mockResolvedValueOnce(json(initialized(), 201)); await expect(value.initialize(payload())).resolves.toMatchObject({ status: 'initialized', connectionTestEnabled: false })
    for (const [data, expected] of [[{ ...ready(), connectionTestEnabled: false }, false], [ready(false, true), true]] as const) {
      fetchSpy.mockResolvedValueOnce(json(data)); await expect(client().observe()).resolves.toMatchObject({ connectionTestEnabled: expected })
    }
    // Still a closed key set: a wrong type or any other extra key is refused.
    for (const bad of [{ ...ready(), connectionTestEnabled: 'true' }, { ...ready(), connectionTestEnabled: null }, { ...ready(), connectionTestEnabledX: true }]) {
      fetchSpy.mockResolvedValueOnce(json(bad)); await expect(client().observe()).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' })
    }
  })
  it('requiring the key again rejects the same switch-off reply (negative assertion red)', async () => {
    const mutant = memoryService("...(probeBit ? ['connectionTestEnabled'] : [])", "'connectionTestEnabled'")()
    fetchSpy.mockResolvedValueOnce(json(ready())); await expect(mutant.observe()).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' }); mutant.dispose()
  })
  it('removing the closed probe-DTO flags accepts a tokenRetained=true reply (negative assertion red)', async () => {
    const check = async (factory: typeof createYidaInitializationClient, accepts: boolean) => {
      const value = factory(); fetchSpy.mockResolvedValueOnce(json(ready(false, true))); await value.observe()
      fetchSpy.mockResolvedValueOnce(json({ ...probeView(), tokenRetained: true }))
      if (accepts) await expect(value.testConnection(request())).resolves.toBeDefined()
      else await expect(value.testConnection(request())).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' })
      value.dispose()
    }
    await check(createYidaInitializationClient, false)
    await check(memoryService('  if (row.tokenRetained !== false || row.externalWriteAttempted !== false || row.canSend !== false) invalid()', ''), true)
  })
})

describe('Yida pasted credentials: the client refuses padded or invisible characters before any request', () => {
  const clients: ReturnType<typeof createYidaInitializationClient>[] = []
  afterEach(() => { for (const value of clients.splice(0)) value.dispose() })
  it('the client refuses a padded or control-character credential before any request and keeps the ready command', async () => {
    const value = createYidaInitializationClient(); clients.push(value)
    fetchSpy.mockResolvedValueOnce(json(ready(false, true))); await value.observe()
    const probeRequest = (appKey: string, appSecret: string) => ({ commandId: ids.command, mode: 'candidate' as const, material: { appKey, appSecret } })
    for (const [appKey, appSecret] of [[pasted.appKey, material.appSecret], [material.appKey, pasted.appSecret],
      [material.appKey, 'SYN\u0000SECRET'], [`${material.appKey} `, material.appSecret]]) {
      await expect(value.testConnection(probeRequest(appKey, appSecret))).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_INPUT_INVALID' })
    }
    for (const patch of [{ systemToken: pasted.systemToken }, { appKey: pasted.appKey }, { appSecret: `\u3000${material.appSecret}` }, { systemToken: 'SYN\u007fTOKEN' }]) {
      const sample = payload()
      await expect(value.initialize({ ...sample, material: { ...sample.material, ...patch } })).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_INPUT_INVALID' })
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // Refused locally, so the observed ready command is not consumed: the unpadded payload initializes.
    fetchSpy.mockResolvedValueOnce(json(initialized(false, true), 201)); await expect(value.initialize(payload())).resolves.toMatchObject({ status: 'initialized' })
  })
  it('the client refuses a zero-width, bidi, BOM or lone-surrogate credential before any request (J-F1)', async () => {
    const value = createYidaInitializationClient(); clients.push(value)
    fetchSpy.mockResolvedValueOnce(json(ready(false, true))); await value.observe()
    const probeRequest = (appKey: string, appSecret: string) => ({ commandId: ids.command, mode: 'candidate' as const, material: { appKey, appSecret } })
    for (const [appKey, appSecret] of [[`${material.appKey}${codeUnit(0x200b)}`, material.appSecret], [material.appKey, `${codeUnit(0x202a)}${material.appSecret}`],
      [`SYN${codeUnit(0xfeff)}KEY`, material.appSecret], [material.appKey, `SYN${codeUnit(0xd800)}SECRET`]]) {
      await expect(value.testConnection(probeRequest(appKey, appSecret))).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_INPUT_INVALID' })
    }
    for (const patch of [{ systemToken: `${material.systemToken}${codeUnit(0x200b)}` }, { appKey: `${codeUnit(0x200e)}${material.appKey}` },
      { appSecret: `SYN${codeUnit(0x2060)}SECRET` }, { systemToken: `SYN${codeUnit(0xdc00)}TOKEN` }]) {
      const sample = payload()
      await expect(value.initialize({ ...sample, material: { ...sample.material, ...patch } })).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_INPUT_INVALID' })
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // Refused locally, so the observed ready command is not consumed: the unpadded payload initializes.
    fetchSpy.mockResolvedValueOnce(json(initialized(false, true), 201)); await expect(value.initialize(payload())).resolves.toMatchObject({ status: 'initialized' })
  })
})

// ADR adr-yida-connection-test-20261028, addendum 2026-11-23: the form-definition read of the same click.
describe('Yida connection test client: optional form-definition read', () => {
  const clients: ReturnType<typeof createYidaInitializationClient>[] = []
  afterEach(() => { for (const value of clients.splice(0)) value.dispose() })
  const client = () => { const value = createYidaInitializationClient(); clients.push(value); return value }
  const form = { appType: 'APP_SYN01', formUuid: 'FORM-SYN-01', systemToken: 'SYN-TOKEN', userId: 'SYN-EXECUTION' }
  const request = () => ({ commandId: ids.command, mode: 'candidate' as const, material: { appKey: material.appKey, appSecret: material.appSecret }, form: { ...form } })
  const fields = [{ fieldId: 'textField_syn01', label: '项目号', componentName: 'TextField', parentId: null }]
  const view = (formRead: unknown, outcome = 'ok') => ({ commandId: ids.command, mode: 'candidate', outcome, tokenIssued: outcome === 'ok',
    tokenRetained: false, externalWriteAttempted: false, canSend: false, formRead })
  const readyWithBit = () => ({ ...ready(false, true), formFieldsReadEnabled: true })

  it('reads the absent-while-off display bit in a closed key set', async () => {
    fetchSpy.mockResolvedValueOnce(json(ready(false, true))); await expect(client().observe()).resolves.toMatchObject({ formFieldsReadEnabled: false })
    fetchSpy.mockResolvedValueOnce(json(readyWithBit())); await expect(client().observe()).resolves.toMatchObject({ formFieldsReadEnabled: true })
    fetchSpy.mockResolvedValueOnce(json({ ...ready(), formFieldsReadEnabled: 'true' })); await expect(client().observe()).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' })
  })
  it('sends exactly the named form and parses the closed formRead; the ready command is not consumed', async () => {
    const value = client(); fetchSpy.mockResolvedValueOnce(json(readyWithBit())); await value.observe()
    fetchSpy.mockResolvedValueOnce(json(view({ outcome: 'ok', fields })))
    await expect(value.testConnection(request())).resolves.toMatchObject({ outcome: 'ok', formRead: { outcome: 'ok', fields } })
    const body = JSON.parse(fetchSpy.mock.calls[1][1].body as string)
    expect(Object.keys(body)).toEqual(['commandId', 'mode', 'material', 'form'])
    expect(body.form).toEqual(form)
    fetchSpy.mockResolvedValueOnce(json(initialized(false, true), 201)); await expect(value.initialize(payload())).resolves.toMatchObject({ status: 'initialized' })
  })
  it.each([
    ['missing formRead', (() => { const { formRead: _f, ...rest } = view({ outcome: 'ok', fields }); return rest })()],
    ['fields on a failed read', view({ outcome: 'upstream_rejected', fields })],
    ['form read after a rejected pair', view({ outcome: 'ok', fields: [] }, 'upstream_rejected')],
    ['not_attempted after an ok pair', view({ outcome: 'not_attempted', fields: [] })],
    ['field with a value', view({ outcome: 'ok', fields: [{ ...fields[0], value: 'SYN' }] })],
    ['duplicate field ID', view({ outcome: 'ok', fields: [fields[0], fields[0]] })],
    ['bad component name', view({ outcome: 'ok', fields: [{ ...fields[0], componentName: 'x y' }] })],
  ])('refuses a probe reply with %s', async (_name, reply) => {
    const value = client(); fetchSpy.mockResolvedValueOnce(json(readyWithBit())); await value.observe()
    fetchSpy.mockResolvedValueOnce(json(reply)); await expect(value.testConnection(request())).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' })
  })
  it('a reply with formRead to a pair-only request is refused (no field list without asking)', async () => {
    const value = client(); fetchSpy.mockResolvedValueOnce(json(readyWithBit())); await value.observe()
    const { form: _form, ...plain } = request()
    fetchSpy.mockResolvedValueOnce(json(view({ outcome: 'ok', fields }))); await expect(value.testConnection(plain)).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_RESPONSE_INVALID' })
  })
  it.each([
    ['path characters in appType', { ...form, appType: 'APP/x' }],
    ['padded systemToken', { ...form, systemToken: ' SYN-TOKEN' }],
    ['padded userId', { ...form, userId: 'SYN-EXECUTION ' }],
    ['extra key', { ...form, organizationId: 'SYN-ORG' }],
  ])('refuses %s before any request', async (_name, bad) => {
    const value = client(); fetchSpy.mockResolvedValueOnce(json(readyWithBit())); await value.observe()
    await expect(value.testConnection({ ...request(), form: bad as typeof form })).rejects.toMatchObject({ code: 'YIDA_INITIALIZATION_INPUT_INVALID' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
