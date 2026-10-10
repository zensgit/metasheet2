import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp } from 'vue'
import StockPreparationYidaOwnerSendPanel from '../src/components/integration/stockPreparation/StockPreparationYidaOwnerSendPanel.vue'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { EXPLICIT_SESSION_ORG_KEY } from '../src/utils/explicitSessionOrg'
import { createYidaOwnerClient, type YidaOwnerApproval, type YidaOwnerDraftInput } from '../src/services/integration/yidaOwner'

// These mocked HTTP checks prove client/UI controls only. Actual JWT, ACL,
// transaction admission and durable delivery require the host/real-DB lane.
const ids = {
  operation: '11111111-1111-4111-8111-111111111111',
  localTarget: '22222222-2222-4222-8222-222222222222',
  target: '33333333-3333-4333-8333-333333333333',
  rowA: '44444444-4444-4444-8444-444444444444',
  rowB: '55555555-5555-4555-8555-555555555555',
  grant: '66666666-6666-4666-8666-666666666666',
  admission: '77777777-7777-4777-8777-777777777777',
  ledger: '88888888-8888-4888-8888-888888888888',
  confirmation: '99999999-9999-4999-8999-999999999999',
  submission: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}
const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTWU4tT1dORVIiLCJ0ZW5hbnRJZCI6IlNZTi1PUkcifQ.c3ludGhldGlj'
function input(): YidaOwnerDraftInput {
  return { config: { version: 2, intent: 'create', appType: 'SYN-APP', formUuid: 'SYN-FORM' },
    rowsText: JSON.stringify([{ name: 'BROWSER-FIRST' }, { name: 'BROWSER-SECOND' }]), allocation: { mode: 'original' } }
}
function serverDraft() {
  return { targetRef: ids.localTarget, operationId: ids.operation, status: 'unverified', identityKind: 'local-unverified',
    canSend: false, canApply: false, tokenIssued: false, externalWriteAttempted: false, rowCount: 2,
    rows: [{ rowKey: ids.rowB, index: 0 }, { rowKey: ids.rowA, index: 1 }], reused: true }
}
function serverPreview(rowKey = ids.rowA) {
  return { operationId: ids.operation, rowKey, planDigest: 'a'.repeat(64), rowPayloadDigest: 'b'.repeat(64),
    target: { targetRef: ids.target, identityKind: 'owner-attested-single-target', evidenceVersion: 1,
      reviewRef: 'SYN-OWNER-REVIEW', organizationId: 'SYN-ORG', appType: 'SYN-APP', formUuid: 'SYN-FORM' },
    payload: { serverField: 'SERVER-SELECTED-MEMBER', quantity: 0, enabled: false },
    policy: { intent: 'create', maxAttempts: 1, maxTtlMs: 900000, requiresExplicitConfirmation: true, unknownMustNotRetry: true },
    canSend: false, externalWriteAttempted: false }
}
function serverApproval(overrides: Partial<YidaOwnerApproval> = {}): YidaOwnerApproval {
  const now = Date.now()
  return { grantId: ids.grant, operationId: ids.operation, rowKey: ids.rowA, targetRef: ids.target,
    approvedAt: now, expiresAt: now + 900000, maxAttempts: 1, remainingAttempts: 1, status: 'approved', revoked: false,
    admissionId: null, ledgerId: null, canSend: false, externalWriteAttempted: false, ...overrides }
}
function admitted() { return serverApproval({ status: 'admitted', remainingAttempts: 0, admissionId: ids.admission, ledgerId: ids.ledger }) }
function observation(status: string) { return { approval: admitted(), delivery: { id: ids.ledger, status, durable: true } } }
function submitted(status = 'outcome_unknown') {
  return { ...observation(status), reused: false, status, externalWriteAttempted: true, businessVerified: false, durable: true }
}
function json(data: unknown, status = 200): Response { return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } }) }
function error(code: string, status = 503): Response { return new Response(JSON.stringify({ ok: false, error: { code } }), { status, headers: { 'Content-Type': 'application/json' } }) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

describe('StockPreparationYidaOwnerSendPanel explicit owner controls', () => {
  let app: VueApp<Element> | null = null
  let root: HTMLDivElement | null = null
  const draftInput = ref<YidaOwnerDraftInput | null>(null)
  const fetchSpy = vi.fn()
  const lockedSpy = vi.fn()
  let uuidSpy: ReturnType<typeof vi.spyOn>
  let storageSetSpy: ReturnType<typeof vi.spyOn>
  let storageRemoveSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    localStorage.setItem('auth_token', token)
    fetchSpy.mockReset(); lockedSpy.mockReset()
    vi.stubGlobal('fetch', fetchSpy)
    uuidSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(ids.confirmation).mockReturnValueOnce(ids.submission)
    storageSetSpy = vi.spyOn(Storage.prototype, 'setItem')
    storageRemoveSpy = vi.spyOn(Storage.prototype, 'removeItem')
    draftInput.value = input()
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp({ render: () => h(StockPreparationYidaOwnerSendPanel, { draftInput: draftInput.value, 'onLocked-change': lockedSpy }) })
    app.mount(root)
  })
  afterEach(() => { app?.unmount(); root?.remove(); app = null; root = null; vi.unstubAllGlobals(); vi.restoreAllMocks() })
  async function flush(): Promise<void> { for (let i = 0; i < 16; i++) await Promise.resolve(); await nextTick() }
  function q<T extends HTMLElement = HTMLElement>(id: string): T { const node = root?.querySelector<T>(`[data-testid="sp-yida-owner-${id}"]`); if (!node) throw new Error(`missing ${id}`); return node }
  function absent(id: string) { return root?.querySelector(`[data-testid="sp-yida-owner-${id}"]`) === null }
  function body(index: number) { return JSON.parse(fetchSpy.mock.calls[index][1].body as string) as Record<string, unknown> }
  async function click(id: string) { q<HTMLButtonElement>(id).click(); await flush() }
  async function save() { fetchSpy.mockResolvedValueOnce(json(serverDraft(), 201)); await click('save') }
  async function selectRow(rowKey = ids.rowA) { const select = q<HTMLSelectElement>('row'); select.value = rowKey; select.dispatchEvent(new Event('change')); await flush() }
  async function preview() { await save(); await selectRow(); fetchSpy.mockResolvedValueOnce(json(serverPreview())); await click('preview') }
  async function acknowledge() { const ack = q<HTMLInputElement>('ack'); ack.checked = true; ack.dispatchEvent(new Event('change')); await flush() }
  async function approve() { await preview(); await acknowledge(); fetchSpy.mockResolvedValueOnce(json({ ...serverApproval(), reused: false }, 201)); await click('approve') }

  it('does no HTTP on mount and saving an unverified draft never sends or grants', async () => {
    expect(fetchSpy).not.toHaveBeenCalled()
    await save()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/integration/yida-owner-send/drafts')
    expect(body(0)).toEqual(input())
    expect(q('draft').textContent).toContain('目标仍未核验')
    expect(q<HTMLSelectElement>('row').value).toBe('')
    expect(absent('grant')).toBe(true)
    expect(uuidSpy).not.toHaveBeenCalled()
    expect(storageSetSpy).not.toHaveBeenCalled()
    expect(storageRemoveSpy).not.toHaveBeenCalled()
  })

  it('uses returned reused membership and server payload, then requires two separate explicit clicks', async () => {
    await preview()
    expect(body(1)).toEqual({ operationId: ids.operation, rowKey: ids.rowA })
    expect(JSON.parse(q('payload').textContent ?? '')).toEqual(serverPreview().payload)
    expect(root?.textContent).not.toContain('BROWSER-FIRST')
    expect(root?.textContent).not.toContain('BROWSER-SECOND')
    expect(q('target').textContent).toContain(ids.target)
    expect(q('policy').textContent).toContain('15 分钟')
    expect(q<HTMLButtonElement>('approve').disabled).toBe(true)
    await acknowledge()
    fetchSpy.mockResolvedValueOnce(json({ ...serverApproval(), reused: false }, 201))
    await click('approve')
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(body(2)).toEqual({ operationId: ids.operation, rowKey: ids.rowA, confirmationId: ids.confirmation, acknowledgeOnce: true, ttlMs: 900000 })
    expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
    expect(q<HTMLSelectElement>('row').disabled).toBe(true)
    expect(lockedSpy).toHaveBeenLastCalledWith(true)
    fetchSpy.mockResolvedValueOnce(json(submitted('acknowledged')))
    await click('submit')
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    expect(body(3)).toEqual({ grantId: ids.grant, submissionId: ids.submission })
    expect(q('acknowledged').textContent).toBe('仅收到协议应答，尚未核验业务创建成功。')
    for (const [url, options] of fetchSpy.mock.calls) {
      expect(String(url)).toMatch(/^\/api\/integration\/yida-owner-send\//u)
      expect(options).toMatchObject({ credentials: 'omit', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' })
      expect(Object.keys(options.headers)).toEqual(['Accept', 'Authorization', 'Content-Type'])
      expect(options.headers.Authorization).toBe(`Bearer ${token}`)
      expect(options.signal).toBeInstanceOf(AbortSignal)
    }
    expect(storageSetSpy).not.toHaveBeenCalled()
  })

  it('rejects a server preview for a different member before rendering or confirming it', async () => {
    await save(); await selectRow()
    fetchSpy.mockResolvedValueOnce(json(serverPreview(ids.rowB)))
    await click('preview')
    expect(q('error').textContent).toBe('YIDA_OWNER_RESPONSE_INVALID')
    expect(absent('payload')).toBe(true)
    expect(absent('approve')).toBe(true)
  })

  it('clears a preview when another server row is selected without requesting automatically', async () => {
    await preview(); await acknowledge()
    await selectRow(ids.rowB)
    expect(absent('payload')).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(uuidSpy).not.toHaveBeenCalled()
  })

  it('freezes CREATE after an unknown response and history refresh uses GET without a fresh key', async () => {
    await approve()
    fetchSpy.mockResolvedValueOnce(json(submitted()))
    await click('submit')
    expect(q('delivery').textContent).toContain('outcome_unknown')
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    await click('submit'); await click('save')
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    fetchSpy.mockResolvedValueOnce(json(observation('dispatching')))
    await click('refresh')
    expect(fetchSpy).toHaveBeenCalledTimes(5)
    expect(fetchSpy.mock.calls[4][0]).toBe(`/api/integration/yida-owner-send/approvals/${ids.grant}`)
    expect(fetchSpy.mock.calls[4][1].method).toBe('GET')
    expect(fetchSpy.mock.calls[4][1].body).toBeUndefined()
    expect(q('delivery').textContent).toContain('dispatching')
    expect(uuidSpy).toHaveBeenCalledTimes(2)
  })

  it('keeps a failed submission frozen and permits only explicit observation recovery', async () => {
    await approve()
    fetchSpy.mockRejectedValueOnce(new Error('SYN-PRIVATE-REMOTE-MESSAGE'))
    await click('submit')
    expect(q('error').textContent).toBe('YIDA_OWNER_UNAVAILABLE')
    expect(root?.textContent).not.toContain('SYN-PRIVATE-REMOTE-MESSAGE')
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    expect(q('frozen').textContent).toContain('保留原提交标识')
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    fetchSpy.mockResolvedValueOnce(json(observation('prepared')))
    await click('refresh')
    expect(fetchSpy.mock.calls[4][1].method).toBe('GET')
    expect(uuidSpy).toHaveBeenCalledTimes(2)
  })

  it('rechecks the 15-minute bound on the explicit submission click without polling', async () => {
    await approve()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 900001)
    await click('submit')
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(q('error').textContent).toBe('YIDA_SEND_APPROVAL_EXPIRED')
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    expect(uuidSpy).toHaveBeenCalledTimes(1)
  })

  it('retains the exact confirmation command after uncertainty and never auto-approves', async () => {
    await preview(); await acknowledge()
    fetchSpy.mockRejectedValueOnce(new Error('SYN-UNCERTAIN'))
    await click('approve')
    expect(absent('grant')).toBe(true)
    expect(q('approval-pending').textContent).toContain('同一确认标识')
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    fetchSpy.mockResolvedValueOnce(json({ ...serverApproval(), reused: true }, 201))
    await click('approve')
    expect(body(3)).toEqual(body(2))
    expect(uuidSpy).toHaveBeenCalledTimes(1)
    expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })

  it('shows the default-OFF failure without a grant or submission', async () => {
    fetchSpy.mockResolvedValueOnce(error('YIDA_OWNER_RUNTIME_DISABLED', 403))
    await click('save')
    expect(q('error').textContent).toBe('YIDA_OWNER_RUNTIME_DISABLED')
    expect(q('disabled').textContent).toContain('发送开关关闭')
    expect(q<HTMLButtonElement>('save').disabled).toBe(true)
    expect(absent('grant')).toBe(true)
    expect(uuidSpy).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('allows explicit read and revoke for an existing grant when sending is later disabled', async () => {
    await approve()
    fetchSpy.mockResolvedValueOnce(error('YIDA_OWNER_RUNTIME_DISABLED', 403))
    await click('submit')
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    expect(q('disabled').textContent).toContain('仅可手动查看或撤销')
    fetchSpy.mockResolvedValueOnce(json({ approval: serverApproval(), delivery: null }))
    await click('refresh')
    expect(fetchSpy.mock.calls[4][1].method).toBe('GET')
    fetchSpy.mockResolvedValueOnce(json({ ...serverApproval({ status: 'revoked', remainingAttempts: 0, revoked: true }), reused: false }))
    await click('revoke')
    expect(q('revoked').textContent).toContain('仍可能在途')
    expect(uuidSpy).toHaveBeenCalledTimes(2)
  })

  it.each([
    { ok: false, error: { code: 'YIDA_OWNER_RUNTIME_DISABLED', message: 'SYN-PRIVATE-CREDENTIAL' } },
    { ok: false, error: { code: 'SYN-PRIVATE-CREDENTIAL' } },
    { ok: true, data: { ...serverDraft(), credentials: 'SYN-PRIVATE-CREDENTIAL' } },
  ])('never displays raw or unexpected error/metadata properties: $ok', async envelope => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(envelope), { status: envelope.ok ? 201 : 403, headers: { 'Content-Type': 'application/json' } }))
    await click('save')
    expect(q('error').textContent).toBe('YIDA_OWNER_RESPONSE_INVALID')
    expect(root?.textContent).not.toContain('SYN-PRIVATE-CREDENTIAL')
    expect(absent('draft')).toBe(true)
    expect(absent('grant')).toBe(true)
  })

  it('aborts a pending save and discards its late response across a deep input A-B-A edit', async () => {
    const pending = deferred<Response>()
    fetchSpy.mockReturnValueOnce(pending.promise)
    await click('save')
    const signal = fetchSpy.mock.calls[0][1].signal as AbortSignal
    const config = draftInput.value?.config as Record<string, unknown>
    config.appType = 'SYN-OTHER'; config.appType = 'SYN-APP'
    await flush()
    expect(signal.aborted).toBe(true)
    pending.resolve(json(serverDraft(), 201)); await flush()
    expect(absent('draft')).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(q<HTMLButtonElement>('save').disabled).toBe(false)
  })

  it('clears approved display and confirmation keys when parent input is reset', async () => {
    await approve()
    draftInput.value = null; await flush()
    expect(absent('draft')).toBe(true)
    expect(absent('payload')).toBe(true)
    expect(absent('grant')).toBe(true)
    expect(absent('approval-pending')).toBe(true)
    expect(lockedSpy).toHaveBeenLastCalledWith(false)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('closes a pending preview across a notified session A-B-A and drops its late payload', async () => {
    await save(); await selectRow()
    const pending = deferred<Response>()
    fetchSpy.mockReturnValueOnce(pending.promise)
    await click('preview')
    const signal = fetchSpy.mock.calls[1][1].signal as AbortSignal
    notifyAuthPrincipalChange()
    localStorage.setItem('auth_token', `${token}B`)
    notifyAuthPrincipalChange()
    localStorage.setItem('auth_token', token)
    await flush()
    expect(signal.aborted).toBe(true)
    pending.resolve(json(serverPreview())); await flush()
    expect(absent('payload')).toBe(true)
    expect(absent('draft')).toBe(true)
    expect(q('error').textContent).toBe('YIDA_OWNER_SESSION_CHANGED')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it.each(['tenantId', 'workspaceId', 'auth_token', EXPLICIT_SESSION_ORG_KEY])('invalidates rendered owner data on cross-tab %s changes even after ABA', async key => {
    await approve()
    window.dispatchEvent(new StorageEvent('storage', { key }))
    await flush()
    expect(absent('payload')).toBe(true)
    expect(absent('grant')).toBe(true)
    expect(q('error').textContent).toBe('YIDA_OWNER_SESSION_CHANGED')
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('revoke remains explicit and warns that admitted delivery may already be in flight', async () => {
    await approve()
    fetchSpy.mockResolvedValueOnce(json({ ...admitted(), revoked: true, reused: false }))
    await click('revoke')
    expect(fetchSpy.mock.calls[3][0]).toBe(`/api/integration/yida-owner-send/approvals/${ids.grant}/revoke`)
    expect(body(3)).toEqual({})
    expect(q('revoked').textContent).toContain('仍可能在途')
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
  })
})

describe('Yida owner client cancellation and disposal', () => {
  const fetchSpy = vi.fn()
  beforeEach(() => { localStorage.setItem('auth_token', token); fetchSpy.mockReset(); vi.stubGlobal('fetch', fetchSpy) })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('aborts and discards a transport response after caller cancellation without a retry', async () => {
    const pending = deferred<Response>(), controller = new AbortController()
    fetchSpy.mockReturnValueOnce(pending.promise)
    const client = createYidaOwnerClient()
    const request = client.prepareDraft(input(), controller.signal)
    controller.abort()
    pending.resolve(json(serverDraft(), 201))
    await expect(request).rejects.toMatchObject({ code: 'YIDA_OWNER_CANCELLED' })
    expect(fetchSpy.mock.calls[0][1].signal.aborted).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    client.dispose()
  })

  it('removes subscriptions, aborts on disposal and does not notify a removed callback', async () => {
    const pending = deferred<Response>(), invalidated = vi.fn()
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    fetchSpy.mockReturnValueOnce(pending.promise)
    const client = createYidaOwnerClient({ onInvalidated: invalidated })
    const request = client.prepareDraft(input())
    client.dispose()
    pending.resolve(json(serverDraft(), 201))
    await expect(request).rejects.toMatchObject({ code: 'YIDA_OWNER_SESSION_CHANGED' })
    expect(fetchSpy.mock.calls[0][1].signal.aborted).toBe(true)
    expect(removeSpy).toHaveBeenCalledWith('storage', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('focus', expect.any(Function))
    notifyAuthPrincipalChange(); window.dispatchEvent(new StorageEvent('storage', { key: 'workspaceId' }))
    expect(invalidated).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
