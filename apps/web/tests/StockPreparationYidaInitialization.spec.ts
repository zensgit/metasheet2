import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp } from 'vue'
import * as Vue from 'vue'
import { compileScript, parse as parseSfc } from 'vue/compiler-sfc'
import ts from 'typescript'
import * as principal from '../src/composables/authPrincipal'
import * as explicitSession from '../src/utils/explicitSessionOrg'
import StockPreparationYidaInitializationPanel from '../src/components/integration/stockPreparation/StockPreparationYidaInitializationPanel.vue'
import StockPreparationYidaPreviewPanel from '../src/components/integration/stockPreparation/StockPreparationYidaPreviewPanel.vue'
import * as initializationService from '../src/services/integration/yidaInitialization'
import { createYidaInitializationClient, type YidaInitializationInput, type YidaInitializationMaterial, type YidaInitializationState } from '../src/services/integration/yidaInitialization'
import { createYidaProtocolExample } from '../../../plugins/plugin-integration-core/lib/yida-static-plan.mjs'
import type { YidaOwnerDraftInput } from '../src/services/integration/yidaOwner'

// Mocked HTTP/jsdom evidence only: no real JWT validation, deployment anchor,
// PG durability, native Chromium or external credentials/requests are claimed.
const endpoint = '/api/integration/yida-owner-send/initialization'
const ids = { command: '11111111-1111-4111-8111-111111111111', other: '22222222-2222-4222-8222-222222222222',
  target: '33333333-3333-4333-8333-333333333333', operation: '44444444-4444-4444-8444-444444444444', row: '55555555-5555-4555-8555-555555555555' }
const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTWU4tT1dORVIiLCJ0ZW5hbnRJZCI6IlNZTi1PUkcifQ.c3ludGhldGlj'
function draftInput(): YidaOwnerDraftInput {
  const example = createYidaProtocolExample('primary')
  return { config: example.config, rowsText: example.text, allocation: { mode: 'original' } }
}
function metadata() { return { targetRef: ids.target, operationId: ids.operation, status: 'unverified', identityKind: 'local-unverified',
  canSend: false, canApply: false, tokenIssued: false, externalWriteAttempted: false, rowCount: 1, rows: [{ rowKey: ids.row, index: 0 }], reused: false } }
function ready() { return { commandId: ids.command, status: 'ready', draft: null, canSend: false, tokenIssued: false, externalWriteAttempted: false } }
function initialized() { return { ...ready(), status: 'initialized', draft: metadata() } }
const material: YidaInitializationMaterial = { appKey: ' SYN-KEY\r\n原字节 ', appSecret: ' SYN-SECRET\n原字节 ', systemToken: ' SYN-TOKEN\r\n原字节 ', userId: 'SYN-EXECUTION' }
function payload(): YidaInitializationInput { return { commandId: ids.command, material: { ...material }, draft: draftInput(),
  attestation: { kind: 'owner-reviewed-target', reviewRef: 'SYN-REVIEW', organizationId: 'SYN-ORG', executionIdentity: material.userId } } }
function json(data: unknown, status = 200) { return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } }) }
function error(code: string, status = 503) { return new Response(JSON.stringify({ ok: false, error: { code } }), { status, headers: { 'Content-Type': 'application/json' } }) }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); await nextTick() }
const fetchSpy = vi.fn()
let app: VueApp<Element> | null = null, root: HTMLDivElement | null = null
const currentInput = ref<YidaOwnerDraftInput | null>(null)
const lockedSpy = vi.fn()
function mountPanel() {
  currentInput.value = draftInput(); root = document.createElement('div'); document.body.appendChild(root)
  app = createApp({ render: () => h(StockPreparationYidaInitializationPanel, { draftInput: currentInput.value, 'onLocked-change': lockedSpy }) }); app.mount(root)
}
function q<T extends HTMLElement = HTMLElement>(id: string): T { const node = root?.querySelector<T>(`[data-testid="sp-yida-init-${id}"]`); if (!node) throw new Error('MISSING_TEST_NODE'); return node }
function absent(id: string) { return root?.querySelector(`[data-testid="sp-yida-init-${id}"]`) === null }
async function click(id: string) { q<HTMLButtonElement>(id).click(); await flush() }
async function type(id: string, value: string) { const node = q<HTMLInputElement>(id); node.value = value; node.dispatchEvent(new Event('input')); await flush() }
async function fill() {
  for (const key of ['appKey', 'appSecret', 'systemToken', 'userId'] as const) {
    const paste = new Event('paste', { cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { getData: (format: string) => format === 'text' ? material[key] : '' } })
    q(key).dispatchEvent(paste); expect(paste.defaultPrevented).toBe(true)
  }
  await type('review', 'SYN-REVIEW'); await type('organization', 'SYN-ORG')
  const ack = q<HTMLInputElement>('ack'); ack.checked = true; ack.dispatchEvent(new Event('change')); await flush()
}
async function observeReady() { fetchSpy.mockResolvedValueOnce(json(ready())); await click('refresh') }
function noSecrets() { for (const key of ['appKey', 'appSecret', 'systemToken', 'userId']) expect(q<HTMLInputElement>(key).value === '').toBe(true) }
beforeEach(() => { localStorage.setItem('auth_token', token); fetchSpy.mockReset(); lockedSpy.mockReset(); vi.stubGlobal('fetch', fetchSpy) })
afterEach(() => { app?.unmount(); root?.remove(); app = null; root = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('Yida initialization explicit local management UI', () => {
  it('has no automatic IO or caller UUID, then preserves pasted raw material and clears controls immediately on POST', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem'), remove = vi.spyOn(Storage.prototype, 'removeItem'), uuid = vi.spyOn(crypto, 'randomUUID')
    const log = vi.spyOn(console, 'log'), warn = vi.spyOn(console, 'warn'), consoleError = vi.spyOn(console, 'error')
    const clipboardRead = vi.fn(), clipboardWrite = vi.fn(); vi.stubGlobal('navigator', { clipboard: { readText: clipboardRead, writeText: clipboardWrite } })
    mountPanel(); await fill()
    expect(fetchSpy).not.toHaveBeenCalled(); expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    await observeReady()
    expect(fetchSpy.mock.calls[0]).toMatchObject([endpoint, { method: 'GET', credentials: 'omit', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' }])
    expect(fetchSpy.mock.calls[0][1].body).toBeUndefined()
    noSecrets(); await fill()
    const pending = deferred<Response>(); fetchSpy.mockReturnValueOnce(pending.promise)
    await click('submit'); noSecrets()
    expect(fetchSpy.mock.calls[1][0]).toBe(endpoint)
    const body = JSON.parse(fetchSpy.mock.calls[1][1].body as string)
    expect(JSON.stringify(body) === JSON.stringify(payload())).toBe(true)
    expect(Object.keys(body)).toEqual(['commandId', 'material', 'draft', 'attestation'])
    expect(fetchSpy.mock.calls[1][1]).toMatchObject({ method: 'POST', credentials: 'omit', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' })
    expect(Object.keys(fetchSpy.mock.calls[1][1].headers)).toEqual(['Accept', 'Authorization', 'Content-Type'])
    pending.resolve(json(initialized(), 201)); await flush()
    expect(q('initialized').textContent).toContain('canSend=false'); expect(absent('appKey')).toBe(true)
    const select = q<HTMLSelectElement>('row'); select.value = ids.row; select.dispatchEvent(new Event('change')); await flush()
    expect(q('selected').textContent).toContain(ids.row); expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(lockedSpy).toHaveBeenLastCalledWith(false)
    for (const spy of [set, remove, uuid, log, warn, consoleError, clipboardRead, clipboardWrite]) expect(spy).not.toHaveBeenCalled()
  })

  it('freezes a lost response, permits only manual GET with the same server command, and never auto retries', async () => {
    mountPanel(); await observeReady(); await fill()
    fetchSpy.mockRejectedValueOnce(Object.create(null, { message: { get() { throw new Error('FOREIGN_GETTER_READ') } } }))
    await click('submit'); noSecrets()
    expect(q('error').textContent).toBe('YIDA_INITIALIZATION_UNAVAILABLE')
    expect(q('uncertain').textContent).toContain('禁止重做'); expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    await click('submit'); await flush(); expect(fetchSpy).toHaveBeenCalledTimes(2)
    fetchSpy.mockResolvedValueOnce(json(ready())); await click('refresh')
    expect(fetchSpy.mock.calls[2][1].method).toBe('GET'); expect(q('command').textContent).toContain(ids.command)
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    await fill(); fetchSpy.mockResolvedValueOnce(json(initialized(), 201)); await click('submit')
    expect(JSON.parse(fetchSpy.mock.calls[3][1].body).commandId).toBe(ids.command); expect(fetchSpy).toHaveBeenCalledTimes(4)
  })

  it('does not interpret a failed status GET as an empty slot or permit a POST', async () => {
    mountPanel(); await fill(); fetchSpy.mockResolvedValueOnce(error('YIDA_INITIALIZATION_UNAVAILABLE'))
    await click('refresh'); expect(absent('ready')).toBe(true); expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    await click('submit'); expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it.each(['unavailable', 'invalid', 'lost'] as const)('clears all private inputs before a pending GET and keeps them empty after %s failure', async failure => {
    mountPanel(); await fill()
    const uuid = vi.spyOn(crypto, 'randomUUID'), pending = deferred<Response>()
    fetchSpy.mockReturnValueOnce(pending.promise)
    await click('refresh')
    const assertCleared = () => {
      noSecrets(); expect(q<HTMLInputElement>('review').value === '').toBe(true); expect(q<HTMLInputElement>('organization').value === '').toBe(true)
      expect(q<HTMLInputElement>('ack').checked).toBe(false)
    }
    assertCleared()
    expect(fetchSpy).toHaveBeenCalledTimes(1); expect(fetchSpy.mock.calls[0][1].method).toBe('GET'); expect(fetchSpy.mock.calls[0][1].body).toBeUndefined()
    if (failure === 'unavailable') pending.resolve(error('YIDA_INITIALIZATION_UNAVAILABLE'))
    else if (failure === 'invalid') pending.resolve(json({ ...ready(), material }))
    else pending.reject(Object.create(null, { message: { get() { throw new Error('FOREIGN_GETTER_READ') } } }))
    await flush(); assertCleared()
    expect(q('error').textContent).toBe(failure === 'invalid' ? 'YIDA_INITIALIZATION_RESPONSE_INVALID' : 'YIDA_INITIALIZATION_UNAVAILABLE')
    expect(q('uncertain').textContent).toContain('仅可手动 GET'); expect(absent('ready')).toBe(true)
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true); await click('submit'); await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(1); expect(uuid).not.toHaveBeenCalled()
    fetchSpy.mockResolvedValueOnce(json(ready())); await click('refresh'); assertCleared()
    expect(fetchSpy).toHaveBeenCalledTimes(2); expect(fetchSpy.mock.calls[1][1].method).toBe('GET'); expect(q('command').textContent).toContain(ids.command)
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
  })

  it('rejects a replacement command during manual recovery and keeps uncertainty frozen', async () => {
    mountPanel(); await observeReady(); await fill(); fetchSpy.mockRejectedValueOnce(new Error('PRIVATE'))
    await click('submit'); fetchSpy.mockResolvedValueOnce(json({ ...ready(), commandId: ids.other })); await click('refresh')
    expect(q('error').textContent).toBe('YIDA_INITIALIZATION_RESPONSE_INVALID')
    expect(q('command').textContent).toContain(ids.command); expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
  })

  it('requires permanent single-slot acknowledgement and compatible original userId without normalization', async () => {
    mountPanel(); await observeReady(); await fill()
    const ack = q<HTMLInputElement>('ack'); ack.checked = false; ack.dispatchEvent(new Event('change')); await flush()
    await click('submit'); expect(fetchSpy).toHaveBeenCalledTimes(1)
    ack.checked = true; ack.dispatchEvent(new Event('change')); await type('userId', ' SYN-EXECUTION ')
    await click('submit'); expect(fetchSpy).toHaveBeenCalledTimes(1); noSecrets()
    expect(q('error').textContent).toBe('YIDA_INITIALIZATION_INPUT_INVALID'); expect(q('uncertain')).toBeDefined()
  })

  it.each(['tenantId', 'workspaceId', 'auth_token', explicitSession.EXPLICIT_SESSION_ORG_KEY, null])('clears private material on a storage invalidation (%s)', async key => {
    mountPanel(); await fill(); window.dispatchEvent(new StorageEvent('storage', { key })); await flush(); noSecrets()
    expect(q('error').textContent).toBe('YIDA_INITIALIZATION_SESSION_CHANGED'); expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('clears material before the first GET on actual principal A-B-A notification', async () => {
    mountPanel(); await fill(); principal.notifyAuthPrincipalChange(); localStorage.setItem('auth_token', `${token}B`)
    principal.notifyAuthPrincipalChange(); localStorage.setItem('auth_token', token); await flush(); noSecrets()
    await click('refresh'); expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a missed token change at the material edit boundary', async () => {
    mountPanel(); await fill(); localStorage.setItem('auth_token', `${token}B`); await type('appKey', 'SYN-NEW')
    noSecrets(); expect(q('error').textContent).toBe('YIDA_INITIALIZATION_SESSION_CHANGED'); expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('aborts and drops a late POST across deep parent input A-B-A, keeping the command frozen until GET', async () => {
    mountPanel(); await observeReady(); await fill(); const pending = deferred<Response>(); fetchSpy.mockReturnValueOnce(pending.promise)
    await click('submit'); const signal = fetchSpy.mock.calls[1][1].signal as AbortSignal
    const config = currentInput.value?.config as { target: { appType: string } }; const initial = config.target.appType
    config.target.appType = 'SYN-OTHER'; config.target.appType = initial; await flush()
    expect(signal.aborted).toBe(true); noSecrets()
    pending.resolve(json(initialized(), 201)); await flush(); expect(absent('initialized')).toBe(true)
    expect(q('command').textContent).toContain(ids.command); expect(q('uncertain')).toBeDefined(); expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('aborts an in-flight POST on principal notification and never displays its late metadata', async () => {
    mountPanel(); await observeReady(); await fill(); const pending = deferred<Response>(); fetchSpy.mockReturnValueOnce(pending.promise)
    await click('submit'); principal.notifyAuthPrincipalChange(); await flush()
    expect(fetchSpy.mock.calls[1][1].signal.aborted).toBe(true); noSecrets()
    pending.resolve(json(initialized(), 201)); await flush(); expect(absent('initialized')).toBe(true); expect(absent('command')).toBe(true)
    expect(q('error').textContent).toBe('YIDA_INITIALIZATION_SESSION_CHANGED')
  })

  it('unmount disposes the real pending client and removes private controls without new IO', async () => {
    mountPanel(); await observeReady(); await fill(); const pending = deferred<Response>(); fetchSpy.mockReturnValueOnce(pending.promise)
    await click('submit'); app?.unmount(); app = null
    expect(fetchSpy.mock.calls[1][1].signal.aborted).toBe(true)
    pending.resolve(json(initialized(), 201)); await flush(); expect(root?.textContent).toBe(''); expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('mounts only after valid real v2 static preparation; initialized can manually open old OFF chain and export has no material', async () => {
    root = document.createElement('div'); document.body.appendChild(root); app = createApp(StockPreparationYidaPreviewPanel); app.mount(root)
    const parentClick = async (id: string) => { const button = root?.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`); if (!button) throw new Error('MISSING_PARENT_NODE'); button.click(); await flush() }
    const mode = root.querySelector<HTMLSelectElement>('[data-testid="sp-yida-preview-mode"]')!; mode.value = 'protocol'; mode.dispatchEvent(new Event('change')); await flush()
    await parentClick('sp-yida-protocol-example-primary'); await parentClick('sp-yida-run')
    expect(root.querySelector('[data-testid="stock-prep-yida-initialization-panel"]')).toBeNull(); expect(fetchSpy).not.toHaveBeenCalled()
    await parentClick('sp-yida-initialization-open'); expect(fetchSpy).not.toHaveBeenCalled(); await observeReady(); await fill()
    fetchSpy.mockResolvedValueOnce(json(initialized(), 201)); await click('submit'); await parentClick('sp-yida-owner-open')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    fetchSpy.mockResolvedValueOnce(error('YIDA_OWNER_RUNTIME_DISABLED', 403)); await parentClick('sp-yida-owner-save')
    expect(root.querySelector('[data-testid="sp-yida-owner-disabled"]')?.textContent).toContain('发送开关关闭')
    expect((root.querySelector('[data-testid="sp-yida-owner-save"]') as HTMLButtonElement).disabled).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    await parentClick('sp-yida-rule-export')
    const exported = (root.querySelector('[data-testid="sp-yida-rule-export-text"]') as HTMLTextAreaElement).value
    for (const field of Object.values(material)) expect(exported.includes(field)).toBe(false)
    expect(Object.hasOwn(JSON.parse(exported), 'material')).toBe(false); expect(fetchSpy).toHaveBeenCalledTimes(3)
  })
})

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
    { ...ready(), material }, { ...ready(), draft: metadata() }, { ...initialized(), draft: null },
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

const panelSource = readFileSync(resolve(__dirname, '../src/components/integration/stockPreparation/StockPreparationYidaInitializationPanel.vue'), 'utf8')
function memoryPanel(anchor: string | null, replacement: string, factory: typeof createYidaInitializationClient) {
  if (anchor !== null) expect(panelSource.split(anchor).length - 1).toBe(1)
  const source = anchor === null ? panelSource : panelSource.replace(anchor, replacement)
  const script = compileScript(parseSfc(source, { filename: 'StockPreparationYidaInitializationPanel.vue' }).descriptor, { id: 'init-guard-probe', inlineTemplate: true }).content
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, unknown> = {}
  const require = (id: string) => { if (id === 'vue') return Vue; if (id.endsWith('/yidaInitialization')) return { ...initializationService, createYidaInitializationClient: factory }; throw new Error('MUTATION_IMPORT_OUT_OF_SCOPE') }
  new Function('require', 'exports', code)(require, exports)
  return exports.default as Vue.Component
}
describe('actual component guard-removal probes with an isolated client boundary', () => {
  it('removing only GET-start cleanup retains the same private controls during and after a failed status read', async () => {
    for (const removed of [false, true]) {
      const pending = deferred<YidaInitializationState>()
      const factory = () => ({ dispose() {}, assertCurrentSession() {}, observe: () => pending.promise, initialize: async () => initialized() as YidaInitializationState })
      const anchor = '  const active = generation\n  clearPrivate()\n  busy.value = true; state.value = null;'
      root = document.createElement('div'); document.body.appendChild(root)
      app = createApp(memoryPanel(removed ? anchor : null, '  const active = generation\n  busy.value = true; state.value = null;', factory), { draftInput: draftInput() }); app.mount(root)
      await fill(); await click('refresh')
      const retained = () => {
        for (const field of ['appKey', 'appSecret', 'systemToken', 'userId', 'review', 'organization']) expect(q<HTMLInputElement>(field).value.length > 0).toBe(removed)
        expect(q<HTMLInputElement>('ack').checked).toBe(removed)
      }
      retained(); pending.reject(new initializationService.YidaInitializationClientError('YIDA_INITIALIZATION_UNAVAILABLE')); await flush(); retained()
      expect(q('uncertain')).toBeDefined(); expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
      app.unmount(); root.remove(); app = null; root = null
    }
  })
  it('removing only acknowledgement admits a manual POST with the unchecked single-slot box', async () => {
    const submitted = vi.fn(async () => initialized() as YidaInitializationState)
    const factory = () => ({ dispose() {}, assertCurrentSession() {}, observe: async () => ready() as YidaInitializationState, initialize: submitted })
    for (const removed of [false, true]) {
      root = document.createElement('div'); document.body.appendChild(root)
      app = createApp(memoryPanel(removed ? ' && acknowledged.value' : null, '', factory), { draftInput: draftInput() }); app.mount(root)
      await click('refresh'); await fill(); const ack = q<HTMLInputElement>('ack'); ack.checked = false; ack.dispatchEvent(new Event('change')); await flush()
      expect(q<HTMLButtonElement>('submit').disabled).toBe(!removed); await click('submit')
      expect(submitted).toHaveBeenCalledTimes(removed ? 1 : 0)
      app.unmount(); root.remove(); app = null; root = null
    }
  })
  it('removing the generation acceptance guard displays the same late POST after parent input A-B-A', async () => {
    for (const removed of [false, true]) {
      const pending = deferred<YidaInitializationState>()
      const factory = () => ({ dispose() {}, assertCurrentSession() {}, observe: async () => ready() as YidaInitializationState, initialize: () => pending.promise })
      // The exact return guard appears in GET and POST; remove only the POST span.
      const anchor = '    const result = await pending\n    if (active !== generation) return'
      currentInput.value = draftInput(); root = document.createElement('div'); document.body.appendChild(root)
      const component = memoryPanel(removed ? anchor : null, '    const result = await pending', factory)
      app = createApp({ render: () => h(component, { draftInput: currentInput.value }) }); app.mount(root)
      await click('refresh'); await fill(); await click('submit')
      const config = currentInput.value?.config as { target: { appType: string } }; const original = config.target.appType
      config.target.appType = 'SYN-OTHER'; config.target.appType = original; pending.resolve(initialized() as YidaInitializationState); await flush()
      expect(absent('initialized')).toBe(!removed)
      app.unmount(); root.remove(); app = null; root = null
    }
  })
  it('removing explicit paste prevention allows native transformation instead of raw capture', async () => {
    const factory = () => ({ dispose() {}, assertCurrentSession() {}, observe: async () => ready() as YidaInitializationState, initialize: async () => initialized() as YidaInitializationState })
    for (const removed of [false, true]) {
      root = document.createElement('div'); document.body.appendChild(root)
      app = createApp(memoryPanel(removed ? '  event.preventDefault()' : null, '', factory), { draftInput: draftInput() }); app.mount(root)
      const paste = new Event('paste', { cancelable: true }); Object.defineProperty(paste, 'clipboardData', { value: { getData: () => material.appKey } })
      q('appKey').dispatchEvent(paste); expect(paste.defaultPrevented).toBe(!removed)
      app.unmount(); root.remove(); app = null; root = null
    }
  })
})
