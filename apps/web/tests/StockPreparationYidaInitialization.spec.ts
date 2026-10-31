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
// Like the server: connectionTestEnabled is present (true) only while the switch is on, else absent.
function ready(sendEnabled = false, connectionTestEnabled = false) { return { commandId: ids.command, status: 'ready', draft: null, canSend: false, tokenIssued: false, externalWriteAttempted: false, sendEnabled,
  ...(connectionTestEnabled ? { connectionTestEnabled: true } : {}) } }
function initialized(sendEnabled = false, connectionTestEnabled = false) { return { ...ready(sendEnabled, connectionTestEnabled), status: 'initialized', draft: metadata() } }
// What the operator pastes (surrounding blanks and a trailing line break the password box hides) and what is
// sent: the same text with its edges trimmed, inner bytes unchanged. The server refuses the padded form.
const pasted: YidaInitializationMaterial = { appKey: ' SYN-KEY原字节\r\n', appSecret: '\tSYN-SECRET原字节\n', systemToken: '\u00a0SYN-TOKEN原字节\r\n', userId: 'SYN-EXECUTION' }
const material: YidaInitializationMaterial = { appKey: 'SYN-KEY原字节', appSecret: 'SYN-SECRET原字节', systemToken: 'SYN-TOKEN原字节', userId: 'SYN-EXECUTION' }
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
    Object.defineProperty(paste, 'clipboardData', { value: { getData: (format: string) => format === 'text' ? pasted[key] : '' } })
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

  it('mounts only after valid real v2 static preparation; switch OFF shows no CREATE entry and export has no material', async () => {
    root = document.createElement('div'); document.body.appendChild(root); app = createApp(StockPreparationYidaPreviewPanel); app.mount(root)
    const parentClick = async (id: string) => { const button = root?.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`); if (!button) throw new Error('MISSING_PARENT_NODE'); button.click(); await flush() }
    const mode = root.querySelector<HTMLSelectElement>('[data-testid="sp-yida-preview-mode"]')!; mode.value = 'protocol'; mode.dispatchEvent(new Event('change')); await flush()
    await parentClick('sp-yida-protocol-example-primary'); await parentClick('sp-yida-run')
    expect(root.querySelector('[data-testid="stock-prep-yida-initialization-panel"]')).toBeNull(); expect(fetchSpy).not.toHaveBeenCalled()
    // No server read yet: the single-row CREATE entry is not even rendered.
    expect(root.querySelector('[data-testid="sp-yida-owner-open"]')).toBeNull(); expect(root.textContent).not.toContain('CREATE')
    await parentClick('sp-yida-initialization-open'); expect(fetchSpy).not.toHaveBeenCalled(); await observeReady(); await fill()
    expect(root.querySelector('[data-testid="sp-yida-owner-open"]')).toBeNull()
    fetchSpy.mockResolvedValueOnce(json(initialized(), 201)); await click('submit')
    // The owner-authorized replies said OFF: still no entry, no owner panel, no owner request.
    expect(root.querySelector('[data-testid="sp-yida-owner-open"]')).toBeNull()
    expect(root.querySelector('[data-testid="stock-prep-yida-owner-send-panel"]')).toBeNull(); expect(root.textContent).not.toContain('CREATE')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    await parentClick('sp-yida-rule-export')
    const exported = (root.querySelector('[data-testid="sp-yida-rule-export-text"]') as HTMLTextAreaElement).value
    for (const field of Object.values(material)) expect(exported.includes(field)).toBe(false)
    expect(Object.hasOwn(JSON.parse(exported), 'material')).toBe(false); expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('switch ON reported by the owner-authorized GET reveals the CREATE entry; a cleared state hides it again', async () => {
    root = document.createElement('div'); document.body.appendChild(root); app = createApp(StockPreparationYidaPreviewPanel); app.mount(root)
    const parentClick = async (id: string) => { const button = root?.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`); if (!button) throw new Error('MISSING_PARENT_NODE'); button.click(); await flush() }
    const owner = () => root?.querySelector('[data-testid="sp-yida-owner-open"]') ?? null
    const mode = root.querySelector<HTMLSelectElement>('[data-testid="sp-yida-preview-mode"]')!; mode.value = 'protocol'; mode.dispatchEvent(new Event('change')); await flush()
    await parentClick('sp-yida-protocol-example-primary'); await parentClick('sp-yida-run'); await parentClick('sp-yida-initialization-open')
    expect(owner()).toBeNull()
    fetchSpy.mockResolvedValueOnce(json(ready(true))); await click('refresh')
    expect(owner()).not.toBeNull(); expect(owner()?.textContent).toContain('打开单行 CREATE 确认')
    // An explicit GET clears the observed state first; a pending or OFF reply never keeps the entry.
    const pending = deferred<Response>(); fetchSpy.mockReturnValueOnce(pending.promise); await click('refresh')
    expect(owner()).toBeNull()
    pending.resolve(json(ready(false))); await flush(); expect(owner()).toBeNull()
    fetchSpy.mockResolvedValueOnce(json(ready(true))); await click('refresh'); expect(owner()).not.toBeNull()
    await parentClick('sp-yida-owner-open')
    expect(root.querySelector('[data-testid="stock-prep-yida-owner-send-panel"]')).not.toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it.each(['YIDA_INITIALIZATION_DENIED', 'YIDA_OWNER_HTTP_DENIED'])('a server %s shows its own code and keeps the panel closed', async code => {
    mountPanel(); await fill()
    fetchSpy.mockResolvedValueOnce(error(code, 403)); await click('refresh')
    expect(q('error').textContent).toBe(code)
    expect(q<HTMLButtonElement>('refresh').disabled).toBe(true); expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    expect(absent('ready')).toBe(true); noSecrets(); expect(fetchSpy).toHaveBeenCalledTimes(1)
    await click('refresh'); expect(fetchSpy).toHaveBeenCalledTimes(1); expect(q('error').textContent).toBe(code)
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

// Owner-run token-only 测试连接 (ADR adr-yida-connection-test-20261028). Mocked HTTP/jsdom only: the
// server bit, the probe DTO and the refusals are synthetic; no DingTalk request exists here.
describe('Yida owner connection test behind the server display bit', () => {
  const probeEndpoint = `${endpoint}/connection-test`
  const probeView = (outcome = 'ok') => ({ commandId: ids.command, mode: 'candidate', outcome, tokenIssued: outcome === 'ok',
    tokenRetained: false, externalWriteAttempted: false, canSend: false })
  async function observe(enabled: boolean) { fetchSpy.mockResolvedValueOnce(json(ready(false, enabled))); await click('refresh') }
  async function probe(response: Response) { fetchSpy.mockResolvedValueOnce(response); await click('connection-test') }
  // Paste keeps the exact bytes (an input event would strip the newline).
  async function pasteInto(field: string, value: string) {
    const event = new Event('paste', { cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { getData: (format: string) => format === 'text' ? value : '' } })
    q(field).dispatchEvent(event); await flush()
  }
  const clients: ReturnType<typeof createYidaInitializationClient>[] = []
  afterEach(() => { for (const value of clients.splice(0)) value.dispose() })
  const client = () => { const value = createYidaInitializationClient(); clients.push(value); return value }
  const request = () => ({ commandId: ids.command, mode: 'candidate' as const, material: { appKey: material.appKey, appSecret: material.appSecret } })

  it('is not rendered while the server bit is false; rendered (with the anchor prerequisite) when true', async () => {
    mountPanel(); await observe(false); await fill()
    expect(absent('connection')).toBe(true); expect(absent('connection-test')).toBe(true)
    await observe(true)
    expect(q('connection').textContent).toContain('bootstrap-yida-initialization-owner')
    expect(q('connection').textContent).toContain('只证明 appKey/appSecret')
    expect(q<HTMLButtonElement>('connection-test').disabled).toBe(true)
    await fill(); expect(q<HTMLButtonElement>('connection-test').disabled).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('POSTs exactly commandId, mode and the raw appKey/appSecret with Bearer only; keeps every input byte; never uncertain', async () => {
    mountPanel(); await observe(true); await fill()
    // The click itself: no storage write, no console output, no crypto use of any kind.
    const storage = (['setItem', 'removeItem', 'clear'] as const).map(name => vi.spyOn(Storage.prototype, name))
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map(name => vi.spyOn(console, name))
    const subtleProto = Object.getPrototypeOf(crypto.subtle) as Record<string, unknown>
    const subtle = ['digest', 'encrypt', 'decrypt', 'sign', 'verify', 'importKey', 'exportKey', 'generateKey', 'deriveKey', 'deriveBits', 'wrapKey', 'unwrapKey']
      .map(name => vi.spyOn(subtleProto as never, name as never))
    const random = [vi.spyOn(crypto, 'randomUUID'), vi.spyOn(crypto, 'getRandomValues')]
    await probe(json(probeView('ok')))
    for (const spy of [...storage, ...consoles, ...subtle, ...random]) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore() }
    const [url, init] = fetchSpy.mock.calls[1]
    expect(url).toBe(probeEndpoint)
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' })
    expect(Object.keys(init.headers)).toEqual(['Accept', 'Authorization', 'Content-Type'])
    expect(init.headers.Authorization === `Bearer ${token}`).toBe(true)
    const body = JSON.parse(init.body as string)
    expect(Object.keys(body)).toEqual(['commandId', 'mode', 'material']); expect(Object.keys(body.material)).toEqual(['appKey', 'appSecret'])
    expect(body.commandId === ids.command && body.mode === 'candidate').toBe(true)
    expect(body.material.appKey === material.appKey && body.material.appSecret === material.appSecret).toBe(true)
    expect(absent('uncertain')).toBe(true); expect(absent('connection-mismatch')).toBe(true)
    expect(q('connection-result').textContent).toContain('令牌已在服务器丢弃')
    // The probe neither cleared the private inputs nor consumed the ready command: the same bytes initialize.
    expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
    fetchSpy.mockResolvedValueOnce(json(initialized(false, true), 201)); await click('submit')
    expect(fetchSpy.mock.calls[2][0]).toBe(endpoint)
    expect(JSON.stringify(JSON.parse(fetchSpy.mock.calls[2][1].body as string)) === JSON.stringify(payload())).toBe(true)
    expect(q('initialized').textContent).toContain('canSend=false'); expect(absent('connection')).toBe(true)
  })

  // Each substring is unique to its own copy, so swapping two copies turns a row red.
  const outcomeRows = [
    ['ok', '令牌已在服务器丢弃'],
    ['upstream_rejected', '网络中间设备的拦截页'],
    ['unreachable', '连不上钉钉'],
    ['timeout', '已连上但 12 秒内钉钉没有应答'],
  ] as const
  it.each(outcomeRows.slice(1))('renders %s as a class only, and initialization stays possible', async (outcome, copy) => {
    mountPanel(); await observe(true); await fill()
    await probe(json(probeView(outcome)))
    const text = q('connection-result').textContent ?? ''
    expect(text).toContain(copy)
    for (const [other, otherCopy] of outcomeRows) if (other !== outcome) expect(text).not.toContain(otherCopy)
    // This version's fetch ignores HTTP(S)_PROXY: no copy may suggest that configuring a proxy helps.
    for (const misleading of ['代理问题', '未配置代理', '代理拦截页']) expect(text).not.toContain(misleading)
    expect(absent('connection-mismatch')).toBe(true); expect(absent('uncertain')).toBe(true)
    expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
  })
  it('unreachable says a silent firewall drop lands there and that no proxy is used; timeout is only connected-then-silent', async () => {
    mountPanel(); await observe(true); await fill()
    await probe(json(probeView('unreachable')))
    expect(q('connection-result').textContent).toContain('防火墙静默丢弃也显示为这一类')
    expect(q('connection-result').textContent).toContain('不走代理')
    await vi.waitFor(() => expect(q<HTMLButtonElement>('connection-test').disabled).toBe(false))
    await probe(json(probeView('timeout')))
    expect(q('connection-result').textContent).not.toContain('防火墙')
  })

  it('a refusal shows its closed code; DENIED closes the panel and clears private inputs', async () => {
    mountPanel(); await observe(true); await fill()
    await probe(error('YIDA_CONNECTION_TEST_THROTTLED', 429))
    expect(q('error').textContent).toBe('YIDA_CONNECTION_TEST_THROTTLED'); expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
    await probe(error('YIDA_CONNECTION_TEST_DENIED', 403))
    expect(q('error').textContent).toBe('YIDA_CONNECTION_TEST_DENIED'); noSecrets()
    expect(q('error-hint').textContent).toContain('本页材料已清空')
    expect(q<HTMLButtonElement>('refresh').disabled).toBe(true); expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
  })

  it('403 YIDA_CONNECTION_TEST_DISABLED (switch turned off after the GET) shows its code, keeps every input and leaves initialization open', async () => {
    mountPanel(); await observe(true); await fill()
    await probe(error('YIDA_CONNECTION_TEST_DISABLED', 403))
    expect(q('error').textContent).toBe('YIDA_CONNECTION_TEST_DISABLED')
    expect(q('error-hint').textContent).toContain('开关现在是关的')
    for (const key of ['appKey', 'appSecret', 'systemToken', 'userId', 'review', 'organization']) expect(q<HTMLInputElement>(key).value.length > 0).toBe(true)
    expect(q<HTMLInputElement>('ack').checked).toBe(true)
    expect(q<HTMLButtonElement>('refresh').disabled).toBe(false); expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
    expect(absent('uncertain')).toBe(true); expect(absent('connection-result')).toBe(true)
  })

  it.each([
    ['YIDA_CONNECTION_TEST_DISABLED', 403, '未向钉钉发出请求'],
    ['YIDA_CONNECTION_TEST_CONFLICT', 409, '请手动 GET 刷新后再试'],
    ['YIDA_CONNECTION_TEST_THROTTLED', 429, '约 5 秒'],
    ['YIDA_CONNECTION_TEST_INPUT', 400, '请求格式'],
    ['YIDA_CONNECTION_TEST_INACTIVE', 503, 'lib/yida-connection-probe.cjs'],
    ['YIDA_CONNECTION_TEST_CANCELLED', 409, '无法确定钉钉是否已收到请求'],
    ['YIDA_CONNECTION_TEST_UNAVAILABLE', 503, '无法确定钉钉是否已收到请求'],
  ] as const)('%s keeps the code text and adds a Chinese hint beside it', async (code, status, hint) => {
    mountPanel(); await observe(true); await fill()
    await probe(error(code, status))
    expect(q('error').textContent).toBe(code)
    expect(q('error-hint').textContent).toContain(hint)
    // Only a refusal before any exchange may claim that nothing was sent.
    const beforeExchange = ['DISABLED', 'CONFLICT', 'THROTTLED', 'INPUT'].some(name => code === `YIDA_CONNECTION_TEST_${name}`)
    expect((q('error-hint').textContent ?? '').includes('未向钉钉发出请求')).toBe(beforeExchange)
  })

  it('a lost or late probe reply gets a probe hint; the same code from a status GET gets none', async () => {
    mountPanel(); await observe(true); await fill()
    fetchSpy.mockRejectedValueOnce(new Error('SYN-PRIVATE')); await click('connection-test')
    expect(q('error').textContent).toBe('YIDA_INITIALIZATION_UNAVAILABLE')
    expect(q('error-hint').textContent).toContain('无法确定钉钉是否已收到请求')
    fetchSpy.mockResolvedValueOnce(error('YIDA_INITIALIZATION_UNAVAILABLE')); await click('refresh')
    expect(q('error').textContent).toBe('YIDA_INITIALIZATION_UNAVAILABLE'); expect(absent('error-hint')).toBe(true)
    await observe(true); await fill()
    vi.useFakeTimers()
    const late = deferred<Response>(); fetchSpy.mockReturnValueOnce(late.promise); await click('connection-test')
    await vi.advanceTimersByTimeAsync(15000); late.resolve(json(probeView('ok'))); await flush()
    expect(q('error').textContent).toBe('YIDA_INITIALIZATION_CANCELLED')
    expect(q('error-hint').textContent).toContain('15 秒内没有收到服务器答复')
    expect(absent('connection-result')).toBe(true)
  })

  it('a shown outcome belongs to the exact pair that was sent: an edit hides it, the same bytes show it again', async () => {
    mountPanel(); await observe(true); await fill()
    await probe(json(probeView('unreachable')))
    expect(q('connection-result').textContent).toContain('连不上钉钉')
    await type('appSecret', 'SYN-SECRET-EDITED')
    expect(absent('connection-result')).toBe(true); expect(absent('connection-mismatch')).toBe(true)
    await pasteInto('appSecret', material.appSecret)
    expect(q('connection-result').textContent).toContain('连不上钉钉')
    await type('appKey', 'SYN-KEY-EDITED'); expect(absent('connection-result')).toBe(true)
    await pasteInto('appKey', material.appKey)
    await probe(json(probeView('ok')))
    expect(q('connection-result').textContent).toContain('令牌已在服务器丢弃')
    // After ok, an edit hides the ok text and shows the mismatch notice instead.
    await type('appSecret', 'SYN-SECRET-EDITED')
    expect(absent('connection-result')).toBe(true); expect(absent('connection-mismatch')).toBe(false)
  })

  it('tested-pair check covers appKey alone: changing only appKey after ok is a mismatch and blocks initialization', async () => {
    mountPanel(); await observe(true); await fill()
    await probe(json(probeView('ok')))
    expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
    await type('appKey', 'SYN-KEY-EDITED')
    expect(q('connection-mismatch').textContent).toBe('已测试的凭据与当前输入不一致，请重新测试')
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    await pasteInto('appKey', material.appKey)
    expect(absent('connection-mismatch')).toBe(true); expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
  })

  it('works with crypto.subtle unavailable (a page served over plain HTTP) and never reads it', async () => {
    const real = globalThis.crypto, subtleRead = vi.fn()
    vi.stubGlobal('crypto', Object.create(null, {
      getRandomValues: { value: real.getRandomValues.bind(real) }, randomUUID: { value: real.randomUUID.bind(real) },
      subtle: { get() { subtleRead(); return undefined } },
    }))
    expect(globalThis.crypto.subtle).toBeUndefined(); subtleRead.mockClear()
    mountPanel(); await observe(true); await fill()
    await probe(json(probeView('ok')))
    expect(absent('error')).toBe(true); expect(q('connection-result').textContent).toContain('令牌已在服务器丢弃')
    expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
    await type('appSecret', 'SYN-SECRET-EDITED'); expect(absent('connection-mismatch')).toBe(false)
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    expect(subtleRead).not.toHaveBeenCalled()
  })

  it('tested-pair check: an edit after ok blocks initialization until a re-test or the explicit owner override', async () => {
    mountPanel(); await observe(true); await fill()
    await probe(json(probeView('ok')))
    expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
    await type('appSecret', 'SYN-SECRET-EDITED')
    expect(q('connection-mismatch').textContent).toBe('已测试的凭据与当前输入不一致，请重新测试')
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    const override = q<HTMLInputElement>('connection-override'); override.checked = true; override.dispatchEvent(new Event('change')); await flush()
    expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
    override.checked = false; override.dispatchEvent(new Event('change')); await flush()
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    await probe(json(probeView('ok')))
    expect(JSON.parse(fetchSpy.mock.calls[2][1].body as string).material.appSecret === 'SYN-SECRET-EDITED').toBe(true)
    expect(absent('connection-mismatch')).toBe(true); expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
    // Editing back to the tested bytes also clears the notice; a non-ok re-test forgets the tested pair.
    await type('appSecret', 'SYN-SECRET-OTHER'); expect(absent('connection-mismatch')).toBe(false)
    await type('appSecret', 'SYN-SECRET-EDITED'); expect(absent('connection-mismatch')).toBe(true)
    await type('appKey', 'SYN-KEY-EDITED'); await probe(json(probeView('upstream_rejected')))
    expect(absent('connection-mismatch')).toBe(true)
  })

  it('tested-pair override is spent once the inputs match the tested pair again; a third value needs a fresh tick', async () => {
    mountPanel(); await observe(true); await fill()
    await probe(json(probeView('ok')))
    await type('appSecret', 'SYN-SECRET-EDITED')
    const override = q<HTMLInputElement>('connection-override'); override.checked = true; override.dispatchEvent(new Event('change')); await flush()
    expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
    // Paste the exact tested bytes back (an input event would strip the newline): the mismatch clears.
    const back = new Event('paste', { cancelable: true })
    Object.defineProperty(back, 'clipboardData', { value: { getData: (format: string) => format === 'text' ? material.appSecret : '' } })
    q('appSecret').dispatchEvent(back); await flush()
    expect(absent('connection-mismatch')).toBe(true); expect(absent('connection-override')).toBe(true)
    expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
    await type('appSecret', 'SYN-SECRET-THIRD')
    expect(absent('connection-mismatch')).toBe(false)
    expect(q<HTMLInputElement>('connection-override').checked).toBe(false)
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    const again = q<HTMLInputElement>('connection-override'); again.checked = true; again.dispatchEvent(new Event('change')); await flush()
    expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('tested-pair override answers only the inputs it was ticked for: A ok → B → tick → C clears it without passing back through A', async () => {
    mountPanel(); await observe(true); await fill()
    await probe(json(probeView('ok')))
    await type('appSecret', 'SYN-SECRET-B')
    const override = q<HTMLInputElement>('connection-override'); override.checked = true; override.dispatchEvent(new Event('change')); await flush()
    expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
    // B → C: still a mismatch, but the tick was for B, so it is gone and C cannot be submitted.
    await type('appSecret', 'SYN-SECRET-C')
    expect(absent('connection-mismatch')).toBe(false)
    expect(q<HTMLInputElement>('connection-override').checked).toBe(false)
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    // appKey counts too, and so does a paste.
    for (const edit of [() => type('appKey', 'SYN-KEY-D'), () => pasteInto('appSecret', 'SYN-SECRET-E')]) {
      const tick = q<HTMLInputElement>('connection-override'); tick.checked = true; tick.dispatchEvent(new Event('change')); await flush()
      expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
      await edit()
      expect(absent('connection-mismatch')).toBe(false)
      expect(q<HTMLInputElement>('connection-override').checked).toBe(false)
      expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

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
    const mutant = memoryService("probeBit ? [...stateKeys, 'connectionTestEnabled'] : stateKeys", "[...stateKeys, 'connectionTestEnabled']")()
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

// Pasted credentials (finding F9 on onprem-r78): a paste often carries a trailing line break or blanks the
// password box hides. appKey/appSecret/systemToken go out with their edges trimmed, so the pair tested is the
// pair L4 seals; text with whitespace or a control character inside is not sent at all.
describe('Yida pasted credentials: edges trimmed before the test and L4, inner blanks refused locally', () => {
  const okView = () => ({ commandId: ids.command, mode: 'candidate', outcome: 'ok', tokenIssued: true, tokenRetained: false, externalWriteAttempted: false, canSend: false })
  async function pasteInto(field: string, value: string) {
    const event = new Event('paste', { cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { getData: (format: string) => format === 'text' ? value : '' } })
    q(field).dispatchEvent(event); await flush()
  }
  async function openWithProbe() { mountPanel(); fetchSpy.mockResolvedValueOnce(json(ready(false, true))); await click('refresh'); await fill() }
  const sent = (call: number) => JSON.parse(fetchSpy.mock.calls[call][1].body as string) as { material: Record<string, string> }
  const clients: ReturnType<typeof createYidaInitializationClient>[] = []
  afterEach(() => { for (const value of clients.splice(0)) value.dispose() })

  it('a paste with a trailing CR/LF reaches the connection test and L4 trimmed: the tested pair is the sealed pair', async () => {
    await openWithProbe()
    expect(absent('material-hint')).toBe(true)
    fetchSpy.mockResolvedValueOnce(json(okView())); await click('connection-test')
    const probed = sent(1).material
    expect(probed.appKey === 'SYN-KEY原字节' && probed.appSecret === 'SYN-SECRET原字节').toBe(true)
    expect(absent('connection-mismatch')).toBe(true); expect(q('connection-result').textContent).toContain('令牌已在服务器丢弃')
    expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
    fetchSpy.mockResolvedValueOnce(json(initialized(false, true), 201)); await click('submit')
    const sealed = sent(2).material
    expect(sealed.appKey === probed.appKey && sealed.appSecret === probed.appSecret).toBe(true)
    expect(sealed.systemToken === 'SYN-TOKEN原字节' && sealed.userId === 'SYN-EXECUTION').toBe(true)
    expect(q('initialized').textContent).toContain('canSend=false'); expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('after an ok test, the same text with or without the line break is the same pair; a changed inner byte is a mismatch', async () => {
    await openWithProbe()
    fetchSpy.mockResolvedValueOnce(json(okView())); await click('connection-test')
    // Typed (an input event strips the line break) and re-pasted with other padding: still the tested pair.
    await type('appSecret', 'SYN-SECRET原字节'); await pasteInto('appKey', '  SYN-KEY原字节 \n')
    expect(absent('connection-mismatch')).toBe(true); expect(q('connection-result').textContent).toContain('令牌已在服务器丢弃')
    expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
    await type('appSecret', 'SYN-SECRET原字节X')
    expect(q('connection-mismatch').textContent).toBe('已测试的凭据与当前输入不一致，请重新测试')
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true); expect(absent('connection-result')).toBe(true)
  })

  it.each([
    ['appKey', 'an inner space', 'SYN-KEY 原字节'], ['appSecret', 'an inner line break', 'SYN-SECRET\n原字节'],
    ['systemToken', 'an inner TAB', 'SYN-TOKEN\t原字节'], ['appSecret', 'a C1 control', 'SYN-SECRET原字节\u0085'],
  ] as const)('%s with %s: a hint naming only the field, and nothing is sent', async (key, _label, value) => {
    await openWithProbe(); await pasteInto(key, value)
    const hint = q('material-hint').textContent ?? ''
    expect(hint.includes(key) && hint.includes('本页不会发送')).toBe(true)
    for (const secret of [value, value.trim(), ...Object.values(material)]) expect(hint.includes(secret)).toBe(false)
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    // The connection test sends appKey/appSecret only, so a blocked systemToken leaves it available.
    expect(q<HTMLButtonElement>('connection-test').disabled).toBe(key !== 'systemToken')
    await click('submit'); if (key !== 'systemToken') await click('connection-test')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await pasteInto(key, pasted[key])
    expect(absent('material-hint')).toBe(true)
    expect(q<HTMLButtonElement>('submit').disabled).toBe(false); expect(q<HTMLButtonElement>('connection-test').disabled).toBe(false)
  })

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
})
