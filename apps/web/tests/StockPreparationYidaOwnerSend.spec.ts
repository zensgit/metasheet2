import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp } from 'vue'
import StockPreparationYidaOwnerSendPanel from '../src/components/integration/stockPreparation/StockPreparationYidaOwnerSendPanel.vue'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { EXPLICIT_SESSION_ORG_KEY } from '../src/utils/explicitSessionOrg'
import { createYidaOwnerClient, type YidaOwnerApproval, type YidaOwnerDraftInput } from '../src/services/integration/yidaOwner'
import * as yidaSendBudget from '../src/services/integration/yidaSendBudget'
import { createYidaTransformExample, yidaTransformSourceColumns } from '../../../plugins/plugin-integration-core/lib/yida-static-plan.mjs'

// Gate 4: the plugin module is the single definition; the web bundle only carries a constants mirror.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pluginSendBudget = require('../../../plugins/plugin-integration-core/lib/yida-send-budget.cjs') as Record<string, unknown>

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
// A transport that never answers on its own and fails only when the client aborts it.
function hang(_url: unknown, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
}
// Only the client wait timers are faked; Date, microtasks and the Response streams stay real.
function fakeWaitTimers() { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) }

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
  afterEach(() => { app?.unmount(); root?.remove(); app = null; root = null; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
  async function flush(): Promise<void> { for (let i = 0; i < 16; i++) await Promise.resolve(); await nextTick() }
  function q<T extends HTMLElement = HTMLElement>(id: string): T { const node = root?.querySelector<T>(`[data-testid="sp-yida-owner-${id}"]`); if (!node) throw new Error(`missing ${id}`); return node }
  function absent(id: string) { return root?.querySelector(`[data-testid="sp-yida-owner-${id}"]`) === null }
  function body(index: number) { return JSON.parse(fetchSpy.mock.calls[index][1].body as string) as Record<string, unknown> }
  async function click(id: string) { q<HTMLButtonElement>(id).click(); await flush() }
  async function type(id: string, value: string) { const field = q<HTMLInputElement>(id); field.value = value; field.dispatchEvent(new Event('input')); await flush() }
  async function lookup(id: string = ids.grant) { await type('lookup-id', id); await click('lookup-run') }
  function signal(index: number) { return fetchSpy.mock.calls[index][1].signal as AbortSignal }
  function submissionPosts() { return fetchSpy.mock.calls.filter(([url, options]) => String(url).endsWith('/submissions') && options?.method === 'POST').length }
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

  it('uses secure fallback keys in a non-secure context and still requires separate explicit commands', async () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto)
    uuidSpy.mockRestore()
    vi.stubGlobal('crypto', { getRandomValues })
    const insecureRandom = vi.spyOn(Math, 'random')
    await approve()
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    const confirmationId = body(2).confirmationId
    expect(confirmationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(q<HTMLButtonElement>('submit').disabled).toBe(false)
    fetchSpy.mockResolvedValueOnce(json(submitted()))
    await click('submit')
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    const submissionId = body(3).submissionId
    expect(submissionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(submissionId).not.toBe(confirmationId)
    await click('submit')
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    expect(insecureRandom).not.toHaveBeenCalled()
  })

  it('does not request authorization when no secure random source is available', async () => {
    await preview(); await acknowledge()
    uuidSpy.mockRestore()
    vi.stubGlobal('crypto', {})
    const insecureRandom = vi.spyOn(Math, 'random')
    await click('approve')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(absent('grant')).toBe(true)
    expect(insecureRandom).not.toHaveBeenCalled()
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

  it('shows a server DENIED refusal by its own code rather than as a session change', async () => {
    fetchSpy.mockResolvedValueOnce(error('YIDA_OWNER_HTTP_DENIED', 403))
    await click('save')
    expect(q('error').textContent).toBe('YIDA_OWNER_HTTP_DENIED')
    expect(absent('draft')).toBe(true)
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

  // R-71 ⑦.1 PR-B: the 60 s submission wait, the read-only lookup by grant id and the two notices.
  it('waits 60 s (not 15 s) for the one submission, then stops waiting, keeps the freeze and re-enables manual refresh', async () => {
    fakeWaitTimers()
    await approve()
    fetchSpy.mockImplementationOnce(hang)
    await click('submit')
    expect(submissionPosts()).toBe(1)
    const submitted = signal(3)
    expect(q<HTMLButtonElement>('refresh').disabled).toBe(true)
    await vi.advanceTimersByTimeAsync(15000); await flush()
    expect(submitted.aborted).toBe(false)
    expect(q<HTMLButtonElement>('refresh').disabled).toBe(true)
    expect(absent('error')).toBe(true)
    await vi.advanceTimersByTimeAsync(44999); await flush()
    expect(submitted.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await flush()
    expect(submitted.aborted).toBe(true)
    expect(q('error').textContent).toBe('YIDA_OWNER_CANCELLED')
    expect(q<HTMLButtonElement>('refresh').disabled).toBe(false)
    expect(q('frozen').textContent).toContain('保留原提交标识')
    expect(q('submit-uncertain').textContent).toContain('服务器可能已经完成创建')
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    await click('submit')
    expect(submissionPosts()).toBe(1)
    // No automatic retry or refresh after the budget runs out.
    await vi.advanceTimersByTimeAsync(120000); await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    expect(uuidSpy).toHaveBeenCalledTimes(2)
  })

  it('looks a durable record up by grant id with one GET, lowercased, with no draft input, and shows only the protocol ACK wording', async () => {
    draftInput.value = null; await flush()
    expect(q('input-required').textContent).toContain('请先完成')
    fetchSpy.mockResolvedValueOnce(json(observation('acknowledged')))
    await lookup(`  ${ids.grant.toUpperCase()}  `)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe(`/api/integration/yida-owner-send/approvals/${ids.grant}`)
    expect(fetchSpy.mock.calls[0][1].method).toBe('GET')
    expect(fetchSpy.mock.calls[0][1].body).toBeUndefined()
    expect(q('lookup-result').textContent).toContain(ids.grant)
    expect(q('lookup-result').textContent).toContain('状态 admitted')
    expect(q('lookup-result').textContent).toContain('剩余尝试数 0')
    expect(q('lookup-delivery').textContent).toBe('持久记录状态：acknowledged。')
    expect(q('lookup-acknowledged').textContent).toBe('仅收到协议应答，尚未核验业务创建成功。')
    expect(absent('lookup-unverified')).toBe(true)
    expect(absent('grant')).toBe(true)
    expect(absent('submit')).toBe(true)
    expect(lockedSpy).toHaveBeenLastCalledWith(false)
    expect(uuidSpy).not.toHaveBeenCalled()
    expect(storageSetSpy).not.toHaveBeenCalled()
  })

  it.each(['not-a-grant', '', `${ids.grant}0`, ids.grant.replaceAll('-', ''), `${ids.grant}\n${ids.grant}`])('refuses an invalid grant id %j locally without any request', async id => {
    await lookup(id)
    expect(q('lookup-error').textContent).toBe('YIDA_OWNER_INPUT_INVALID')
    expect(absent('lookup-result')).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still looks up while the send switch is off and reports a grant with no delivery yet', async () => {
    fetchSpy.mockResolvedValueOnce(error('YIDA_OWNER_RUNTIME_DISABLED', 403))
    await click('save')
    expect(q('disabled').textContent).toContain('发送开关关闭')
    fetchSpy.mockResolvedValueOnce(json({ approval: serverApproval(), delivery: null }))
    await lookup()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[1][1].method).toBe('GET')
    expect(q('lookup-delivery').textContent).toBe('尚无发送记录。')
    expect(absent('lookup-acknowledged')).toBe(true)
    expect(absent('lookup-unverified')).toBe(true)
    expect(q('error').textContent).toBe('YIDA_OWNER_RUNTIME_DISABLED')
  })

  it.each(['no grant on this page', 'a frozen submission on this page'])('a looked-up approved grant with one remaining attempt cannot be submitted (%s): clicking submit sends no POST', async stage => {
    if (stage !== 'no grant on this page') {
      await approve()
      fetchSpy.mockRejectedValueOnce(new Error('SYN-UNCERTAIN'))
      await click('submit')
      expect(q('frozen').textContent).toContain('保留原提交标识')
    }
    const before = submissionPosts(), calls = fetchSpy.mock.calls.length
    fetchSpy.mockResolvedValueOnce(json({ approval: serverApproval(), delivery: null }))
    await lookup()
    expect(fetchSpy).toHaveBeenCalledTimes(calls + 1)
    expect(q('lookup-result').textContent).toContain('状态 approved')
    expect(q('lookup-result').textContent).toContain('剩余尝试数 1')
    // Really try to send: whatever submit control the page shows after the lookup is clicked.
    root?.querySelector<HTMLButtonElement>('[data-testid="sp-yida-owner-submit"]')?.click(); await flush()
    expect(submissionPosts()).toBe(before)
    expect(fetchSpy).toHaveBeenCalledTimes(calls + 1)
    if (stage === 'no grant on this page') { expect(absent('grant')).toBe(true); expect(lockedSpy).toHaveBeenLastCalledWith(false) }
    else { expect(q<HTMLButtonElement>('submit').disabled).toBe(true); expect(q('frozen').textContent).toContain('保留原提交标识') }
  })

  it('looks up while the 60 s submission is pending, on its own signal, without changing the submission outcome', async () => {
    fakeWaitTimers()
    await approve()
    const pending = deferred<Response>()
    fetchSpy.mockReturnValueOnce(pending.promise)
    await click('submit')
    expect(q<HTMLButtonElement>('refresh').disabled).toBe(true)
    fetchSpy.mockResolvedValueOnce(json(observation('dispatching')))
    await vi.advanceTimersByTimeAsync(20000)
    await lookup()
    expect(fetchSpy).toHaveBeenCalledTimes(5)
    expect(fetchSpy.mock.calls[4][1].method).toBe('GET')
    expect(signal(4)).not.toBe(signal(3))
    expect(signal(3).aborted).toBe(false)
    expect(q('lookup-delivery').textContent).toBe('持久记录状态：dispatching。')
    expect(q('lookup-unverified').textContent).toContain('不可重试创建')
    expect(absent('delivery')).toBe(true)
    expect(q<HTMLButtonElement>('refresh').disabled).toBe(true)
    expect(q('frozen').textContent).toContain('保留原提交标识')
    pending.resolve(json(submitted('acknowledged'))); await flush()
    expect(q('acknowledged').textContent).toBe('仅收到协议应答，尚未核验业务创建成功。')
    expect(q('lookup-delivery').textContent).toBe('持久记录状态：dispatching。')
    expect(absent('error')).toBe(true)
    expect(absent('submit-uncertain')).toBe(true)
    expect(submissionPosts()).toBe(1)
  })

  it.each([
    { name: 'a DENIED refusal', reply: () => Promise.resolve(error('YIDA_OWNER_HTTP_DENIED', 403)), code: 'YIDA_OWNER_HTTP_DENIED' },
    { name: 'an unavailable store', reply: () => Promise.resolve(error('YIDA_SEND_APPROVAL_UNAVAILABLE', 503)), code: 'YIDA_SEND_APPROVAL_UNAVAILABLE' },
    { name: 'a transport failure', reply: () => Promise.reject(new Error('SYN-PRIVATE-REMOTE-MESSAGE')), code: 'YIDA_OWNER_UNAVAILABLE' },
  ])('a lookup failure ($name) never lifts the submission freeze', async ({ reply, code }) => {
    await approve()
    fetchSpy.mockRejectedValueOnce(new Error('SYN-UNCERTAIN'))
    await click('submit')
    fetchSpy.mockImplementationOnce(reply)
    await lookup()
    expect(q('lookup-error').textContent).toBe(code)
    expect(root?.textContent).not.toContain('SYN-PRIVATE-REMOTE-MESSAGE')
    expect(q('frozen').textContent).toContain('保留原提交标识')
    expect(q('error').textContent).toBe('YIDA_OWNER_UNAVAILABLE')
    expect(q('submit-uncertain').textContent).toContain('请先手动刷新持久记录')
    expect(q<HTMLButtonElement>('submit').disabled).toBe(true)
    await click('submit')
    expect(submissionPosts()).toBe(1)
    expect(lockedSpy).toHaveBeenLastCalledWith(true)
    // The send flow keeps its own session: the manual refresh still reads with GET.
    fetchSpy.mockResolvedValueOnce(json(observation('prepared')))
    await click('refresh')
    expect(fetchSpy).toHaveBeenCalledTimes(6)
    expect(fetchSpy.mock.calls[5][1].method).toBe('GET')
    expect(q('delivery').textContent).toContain('prepared')
    expect(uuidSpy).toHaveBeenCalledTimes(2)
  })

  it.each(['tenantId', 'workspaceId', 'auth_token', EXPLICIT_SESSION_ORG_KEY, 'principal'])('drops a late lookup answer and a shown lookup result after a %s change', async key => {
    const change = () => { if (key === 'principal') notifyAuthPrincipalChange(); else window.dispatchEvent(new StorageEvent('storage', { key })) }
    const pending = deferred<Response>()
    fetchSpy.mockReturnValueOnce(pending.promise)
    await lookup()
    expect(q<HTMLButtonElement>('lookup-run').disabled).toBe(true)
    await click('lookup-run')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    change(); await flush()
    expect(signal(0).aborted).toBe(true)
    expect(q('lookup-error').textContent).toBe('YIDA_OWNER_SESSION_CHANGED')
    pending.resolve(json(observation('acknowledged'))); await flush()
    expect(absent('lookup-result')).toBe(true)
    expect(q('lookup-error').textContent).toBe('YIDA_OWNER_SESSION_CHANGED')
    expect(q<HTMLButtonElement>('lookup-run').disabled).toBe(false)
    // A fresh lookup binds the current session; a later change clears what it showed.
    fetchSpy.mockResolvedValueOnce(json(observation('acknowledged')))
    await click('lookup-run')
    expect(q('lookup-acknowledged').textContent).toBe('仅收到协议应答，尚未核验业务创建成功。')
    change(); await flush()
    expect(absent('lookup-result')).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('keeps a shown lookup result across a draft input change but drops it on unmount', async () => {
    fetchSpy.mockResolvedValueOnce(json(observation('outcome_unknown')))
    await lookup()
    expect(q('lookup-unverified').textContent).toContain('不可重试创建')
    draftInput.value = null; await flush()
    expect(q('lookup-delivery').textContent).toBe('持久记录状态：outcome_unknown。')
    const pending = deferred<Response>()
    fetchSpy.mockReturnValueOnce(pending.promise)
    await click('lookup-run')
    app?.unmount(); app = null
    expect(signal(1).aborted).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('gate 4: an approval refused with 422 YIDA_SEND_APPROVAL_LIMIT shows only that fixed code and offers no submit', async () => {
    await preview(); await acknowledge()
    fetchSpy.mockResolvedValueOnce(error('YIDA_SEND_APPROVAL_LIMIT', 422))
    await click('approve')
    expect(q('error').textContent).toBe('YIDA_SEND_APPROVAL_LIMIT')
    expect(absent('grant')).toBe(true)
    expect(absent('submit')).toBe(true)
    expect(submissionPosts()).toBe(0)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    // The same code on any other status is not this refusal: the client calls the reply invalid.
    fetchSpy.mockResolvedValueOnce(error('YIDA_SEND_APPROVAL_LIMIT', 503))
    await click('approve')
    expect(q('error').textContent).toBe('YIDA_OWNER_RESPONSE_INVALID')
    expect(absent('submit')).toBe(true)
  })

  it('identity fence (D16): an approval refused with 409 YIDA_SEND_APPROVAL_IDENTITY_RESERVED shows the fixed code and its copy, no grant, no submit', async () => {
    await preview(); await acknowledge()
    fetchSpy.mockResolvedValueOnce(error('YIDA_SEND_APPROVAL_IDENTITY_RESERVED', 409))
    await click('approve')
    expect(q('error').textContent).toBe('YIDA_SEND_APPROVAL_IDENTITY_RESERVED')
    expect(q('identity-reserved').textContent).toBe('此物料行在该目标已经创建过，不再新建；请到宜搭核对。')
    expect(absent('grant')).toBe(true)
    expect(absent('submit')).toBe(true)
    expect(absent('limit')).toBe(true)
    expect(submissionPosts()).toBe(0)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    // The same code on any other status is not this refusal: the client calls the reply invalid.
    fetchSpy.mockResolvedValueOnce(error('YIDA_SEND_APPROVAL_IDENTITY_RESERVED', 503))
    await click('approve')
    expect(q('error').textContent).toBe('YIDA_OWNER_RESPONSE_INVALID')
    expect(absent('identity-reserved')).toBe(true)
    expect(absent('submit')).toBe(true)
  })

  it('generated-layout seal (P1): an approval refused with 409 YIDA_SEND_APPROVAL_GENERATED_LAYOUT_CONFLICT shows the fixed code and its copy, no grant, no submit', async () => {
    await preview(); await acknowledge()
    fetchSpy.mockResolvedValueOnce(error('YIDA_SEND_APPROVAL_GENERATED_LAYOUT_CONFLICT', 409))
    await click('approve')
    expect(q('error').textContent).toBe('YIDA_SEND_APPROVAL_GENERATED_LAYOUT_CONFLICT')
    expect(q('generated-layout-conflict').textContent).toBe('该目标的编码模板布局已在首次授权时封存，本草稿的模板布局与之不同（或不含编码模板）；这次请求没有保存草稿、授权或发送任何内容。请改回已封存的模板，或由管理员另建目标。')
    expect(absent('grant')).toBe(true)
    expect(absent('submit')).toBe(true)
    expect(absent('identity-reserved')).toBe(true)
    expect(absent('limit')).toBe(true)
    expect(submissionPosts()).toBe(0)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    // The same code on any other status is not this refusal: the client calls the reply invalid.
    fetchSpy.mockResolvedValueOnce(error('YIDA_SEND_APPROVAL_GENERATED_LAYOUT_CONFLICT', 503))
    await click('approve')
    expect(q('error').textContent).toBe('YIDA_OWNER_RESPONSE_INVALID')
    expect(absent('generated-layout-conflict')).toBe(true)
    expect(absent('submit')).toBe(true)
  })

  it('the frozen notice names the grant id and the durable record; the uncertain hint needs a submission and an error', async () => {
    await save(); await selectRow()
    fetchSpy.mockResolvedValueOnce(error('YIDA_OWNER_RUNTIME_UNAVAILABLE', 503))
    await click('preview')
    expect(q('error').textContent).toBe('YIDA_OWNER_RUNTIME_UNAVAILABLE')
    expect(absent('submit-uncertain')).toBe(true)
    fetchSpy.mockResolvedValueOnce(json(serverPreview())); await click('preview')
    await acknowledge()
    fetchSpy.mockResolvedValueOnce(json({ ...serverApproval(), reused: false }, 201)); await click('approve')
    fetchSpy.mockResolvedValueOnce(json(submitted('acknowledged')))
    await click('submit')
    const frozen = q('frozen').textContent ?? ''
    expect(frozen).toContain('保留原提交标识')
    expect(frozen).toContain('结果以服务器持久记录为准')
    expect(frozen).toContain(`请记下授权号 ${ids.grant}`)
    expect(frozen).toContain('按授权号查看')
    expect(absent('submit-uncertain')).toBe(true)
    fetchSpy.mockResolvedValueOnce(error('YIDA_SEND_APPROVAL_UNAVAILABLE', 503))
    await click('refresh')
    expect(q('submit-uncertain').textContent).toBe('这次提交的应答不确定或被拒绝，服务器可能已经完成创建。请先手动刷新持久记录，不要换页面重试。本页提交最多等待 60 秒，这只是本页的等待时限，不代表服务器已经停止或完成。')
    expect(q('error').textContent).toBe('YIDA_SEND_APPROVAL_UNAVAILABLE')
    expect(root?.textContent).not.toMatch(/(?<!尚未)核验业务创建成功|已创建成功|已经创建成功/u)
  })
})

describe('Yida send budget client mirror', () => {
  it('equals the plugin single definition, constant for constant', () => {
    const mirrored = Object.keys(yidaSendBudget).sort()
    expect(mirrored).toEqual(Object.keys(pluginSendBudget).filter(key => key.startsWith('YIDA_SEND_')).sort())
    expect(mirrored.length).toBe(6)
    for (const key of mirrored) expect((yidaSendBudget as Record<string, unknown>)[key]).toBe(pluginSendBudget[key])
    expect(yidaSendBudget.YIDA_SEND_REQUEST_MAX_BYTES).toBe(262144)
  })
})

describe('Yida owner client cancellation and disposal', () => {
  const fetchSpy = vi.fn()
  beforeEach(() => { localStorage.setItem('auth_token', token); fetchSpy.mockReset(); vi.stubGlobal('fetch', fetchSpy) })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('only POST /submissions waits 60 s; drafts, targets, preview, approval, observation and revocation stop waiting at 15 s', async () => {
    fakeWaitTimers()
    fetchSpy.mockImplementation(hang)
    const client = createYidaOwnerClient()
    const selected = { operationId: ids.operation, rowKey: ids.rowA }
    const calls = [
      client.prepareDraft(input()), client.targets(), client.preview(selected),
      client.approve({ ...selected, confirmationId: ids.confirmation, acknowledgeOnce: true }),
      client.observe(ids.grant), client.revoke(ids.grant), client.submit({ grantId: ids.grant, submissionId: ids.submission }),
    ]
    const settled = calls.map(call => call.then(() => 'resolved', (failure: { code?: string }) => failure.code ?? 'unknown'))
    expect(fetchSpy.mock.calls.map(([url]) => String(url).replace('/api/integration/yida-owner-send', ''))).toEqual([
      '/drafts', '/targets', '/preview', '/approvals', `/approvals/${ids.grant}`, `/approvals/${ids.grant}/revoke`, '/submissions'])
    const aborted = () => fetchSpy.mock.calls.map(([, options]) => (options.signal as AbortSignal).aborted)
    await vi.advanceTimersByTimeAsync(14999)
    expect(aborted()).toEqual([false, false, false, false, false, false, false])
    await vi.advanceTimersByTimeAsync(1)
    expect(aborted()).toEqual([true, true, true, true, true, true, false])
    await vi.advanceTimersByTimeAsync(44999)
    expect(aborted()[6]).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(aborted()[6]).toBe(true)
    expect(await Promise.all(settled)).toEqual(Array(7).fill('YIDA_OWNER_CANCELLED'))
    expect(fetchSpy).toHaveBeenCalledTimes(7)
    client.dispose()
  })

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

// Y2: target picker and 粘贴 / 从表格 source, only while the server reports its multi-target switch ON.
describe('StockPreparationYidaOwnerSendPanel multi-target controls (Y2)', () => {
  const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  let app: VueApp<Element> | null = null
  let root: HTMLDivElement | null = null
  const fetchSpy = vi.fn()
  const mapped = (): YidaOwnerDraftInput => ({ config: { version: 2, intent: 'create', target: { appType: 'SYN-APP', formUuid: 'SYN-FORM-2' },
    fieldMap: [{ source: 'projectNo', target: 'project', type: 'string', required: true }, { source: 'quantity', target: 'qty', type: 'number', required: true }] },
  rowsText: JSON.stringify([{ projectNo: 'SYN-P1', quantity: 2 }]), allocation: { mode: 'original' } })
  function mount(multiTarget: boolean | undefined) {
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp({ render: () => h(StockPreparationYidaOwnerSendPanel, { draftInput: mapped(), ...(multiTarget === undefined ? {} : { multiTarget }) }) })
    app.mount(root)
  }
  beforeEach(() => {
    localStorage.setItem('auth_token', token)
    fetchSpy.mockReset(); vi.stubGlobal('fetch', fetchSpy)
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(ids.confirmation).mockReturnValueOnce(ids.submission)
  })
  afterEach(() => { app?.unmount(); root?.remove(); app = null; root = null; vi.unstubAllGlobals(); vi.restoreAllMocks() })
  async function flush(): Promise<void> { for (let i = 0; i < 16; i++) await Promise.resolve(); await nextTick() }
  function q<T extends HTMLElement = HTMLElement>(id: string): T { const node = root?.querySelector<T>(`[data-testid="sp-yida-owner-${id}"]`); if (!node) throw new Error(`missing ${id}`); return node }
  function absent(id: string) { return root?.querySelector(`[data-testid="sp-yida-owner-${id}"]`) === null }
  function body(index: number) { return JSON.parse(fetchSpy.mock.calls[index][1].body as string) as Record<string, unknown> }
  async function click(id: string) { q<HTMLButtonElement>(id).click(); await flush() }
  async function choose(id: string, value: string) { const select = q<HTMLSelectElement>(id); select.value = value; select.dispatchEvent(new Event('change')); await flush() }
  async function type(id: string, value: string) { const field = q<HTMLInputElement>(id); field.value = value; field.dispatchEvent(new Event('input')); await flush() }
  const targetList = () => ({ targets: [{ slot: 1, targetRef: ids.target, appType: 'SYN-APP', formUuid: 'SYN-FORM' },
    { slot: 2, targetRef: second, appType: 'SYN-APP', formUuid: 'SYN-FORM-2' }], registered: null,
  canSend: false, tokenIssued: false, externalWriteAttempted: false })
  async function pickSecond() {
    fetchSpy.mockResolvedValueOnce(json(targetList()))
    await click('targets-load')
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/integration/yida-owner-send/targets')
    expect(fetchSpy.mock.calls[0][1].method).toBe('GET')
    await choose('target-select', second)
  }

  it('switch OFF (prop absent or false): no picker, no source chooser, the original closed draft body', async () => {
    for (const value of [undefined, false]) {
      fetchSpy.mockReset()
      mount(value)
      expect(absent('multi')).toBe(true); expect(absent('target-select')).toBe(true); expect(absent('source-sheet')).toBe(true)
      expect(fetchSpy).not.toHaveBeenCalled()
      fetchSpy.mockResolvedValueOnce(json(serverDraft(), 201))
      await click('save')
      expect(body(fetchSpy.mock.calls.length - 1)).toEqual(mapped())
      app?.unmount(); root?.remove(); app = null; root = null
    }
  })

  it('switch ON, 粘贴: the picked target rides on draft, preview and approval; nothing is fetched until an explicit click', async () => {
    mount(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(q('multi').textContent).toContain('只绑定这一个目标')
    await pickSecond()
    fetchSpy.mockResolvedValueOnce(json(serverDraft(), 201))
    await click('save')
    expect(body(1)).toEqual({ targetRef: second, config: mapped().config, allocation: mapped().allocation, rowsText: mapped().rowsText })
    expect(q('draft-target').textContent).toContain(second)
    expect(q<HTMLSelectElement>('target-select').disabled).toBe(true)
    await choose('row', ids.rowA)
    const preview = serverPreview(); preview.target.targetRef = second
    fetchSpy.mockResolvedValueOnce(json(preview))
    await click('preview')
    expect(body(2)).toEqual({ operationId: ids.operation, rowKey: ids.rowA, targetRef: second })
    const ack = q<HTMLInputElement>('ack'); ack.checked = true; ack.dispatchEvent(new Event('change')); await flush()
    fetchSpy.mockResolvedValueOnce(json({ ...serverApproval({ targetRef: second }), reused: false }, 201))
    await click('approve')
    expect(body(3)).toEqual({ operationId: ids.operation, rowKey: ids.rowA, confirmationId: ids.confirmation,
      acknowledgeOnce: true, ttlMs: 900000, targetRef: second })
    expect(q('grant').textContent).toContain(ids.grant)
  })

  it('switch ON, 从表格: the server reads the sheet/view by mapping; no rowsText is sent; a target is required first', async () => {
    mount(true)
    await click('save')
    expect(q('error').textContent).toBe('YIDA_OWNER_TARGET_REQUIRED')
    expect(fetchSpy).not.toHaveBeenCalled()
    await pickSecond()
    q<HTMLInputElement>('source-sheet').click(); await flush()
    await click('save')
    expect(q('error').textContent).toBe('YIDA_OWNER_SHEET_SOURCE_REQUIRED')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await type('sheet-id', 'sheet_synthetic')
    await type('view-id', 'view_synthetic')
    await type('column-projectNo', 'fld_project')
    await type('column-quantity', 'fld_qty')
    fetchSpy.mockResolvedValueOnce(json(serverDraft(), 201))
    await click('save')
    expect(body(1)).toEqual({ targetRef: second, config: mapped().config, allocation: mapped().allocation,
      source: { kind: 'sheet', sheetId: 'sheet_synthetic', viewId: 'view_synthetic',
        columns: [{ fieldId: 'fld_project', source: 'projectNo' }, { fieldId: 'fld_qty', source: 'quantity' }] } })
    expect(JSON.stringify(body(1)).includes('rowsText')).toBe(false)
  })

  it('a preview or approval answered for another target is refused by the client binding check', async () => {
    mount(true)
    await pickSecond()
    fetchSpy.mockResolvedValueOnce(json(serverDraft(), 201))
    await click('save')
    await choose('row', ids.rowA)
    fetchSpy.mockResolvedValueOnce(json(serverPreview()))
    await click('preview')
    expect(q('error').textContent).toBe('YIDA_OWNER_RESPONSE_INVALID')
    expect(absent('confirmation')).toBe(true)
  })

  it('a sheet refusal from the server is shown as its fixed code', async () => {
    mount(true)
    await pickSecond()
    q<HTMLInputElement>('source-sheet').click(); await flush()
    await type('sheet-id', 'sheet_synthetic'); await type('column-projectNo', 'fld_project')
    fetchSpy.mockResolvedValueOnce(error('YIDA_SHEET_SOURCE_DENIED', 403))
    await click('save')
    expect(q('error').textContent).toBe('YIDA_SHEET_SOURCE_DENIED')
    expect(absent('draft')).toBe(true)
  })
})

// R-71 ⑦.3: a v3 draft goes to the server exactly as previewed; a draft-time 422 LIMIT is shown with its
// hint and leaves no draft; the sheet column mapping lists every column the v3 mapping reads.
describe('StockPreparationYidaOwnerSendPanel v3 drafts (R-71 ⑦.3)', () => {
  let app: VueApp<Element> | null = null
  let root: HTMLDivElement | null = null
  const fetchSpy = vi.fn()
  const transform = (): YidaOwnerDraftInput => {
    const example = createYidaTransformExample()
    return { config: example.config, rowsText: example.text, allocation: { ...example.allocation, projects: ['DEMO-P1'] } }
  }
  function mount(multiTarget: boolean) {
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp({ render: () => h(StockPreparationYidaOwnerSendPanel, { draftInput: transform(), multiTarget }) })
    app.mount(root)
  }
  beforeEach(() => { localStorage.setItem('auth_token', token); fetchSpy.mockReset(); vi.stubGlobal('fetch', fetchSpy) })
  afterEach(() => { app?.unmount(); root?.remove(); app = null; root = null; vi.unstubAllGlobals(); vi.restoreAllMocks() })
  async function flush(): Promise<void> { for (let i = 0; i < 16; i++) await Promise.resolve(); await nextTick() }
  function q<T extends HTMLElement = HTMLElement>(id: string): T { const node = root?.querySelector<T>(`[data-testid="sp-yida-owner-${id}"]`); if (!node) throw new Error(`missing ${id}`); return node }
  function absent(id: string) { return root?.querySelector(`[data-testid="sp-yida-owner-${id}"]`) === null }

  it('saves the v3 draft input verbatim and shows a draft-time 422 LIMIT with its hint and no draft', async () => {
    mount(false)
    expect(absent('input-required')).toBe(true)
    fetchSpy.mockResolvedValueOnce(error('YIDA_SEND_APPROVAL_LIMIT', 422))
    q<HTMLButtonElement>('save').click(); await flush()
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/integration/yida-owner-send/drafts')
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body as string)).toEqual(transform())
    expect(q('error').textContent).toBe('YIDA_SEND_APPROVAL_LIMIT')
    expect(q('limit').textContent).toContain('没有保存、授权或发送任何内容')
    expect(absent('draft')).toBe(true)
    fetchSpy.mockResolvedValueOnce(json(serverDraft(), 201))
    q<HTMLButtonElement>('save').click(); await flush()
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body as string)).toEqual(transform())
    expect(absent('limit')).toBe(true)
    expect(q('draft').textContent).toContain('目标仍未核验')
  })

  // Slice YE (2026-11-08): the four deterministic source-validation refusals and the draft-time sealed-layout refusal are
  // fixed codes with their own plain copy; no draft is shown; the same code on 503 is not this refusal.
  it.each([
    ['YIDA_SEND_APPROVAL_SOURCE_UNBOUND', 422, 'source-unbound', '此映射含编码模板，只能用服务端从已登记项目表格读取的行创建草稿；粘贴的行没有来源绑定。未保存草稿，原样再试仍会被拒绝。请改用“从表格”读取已登记的项目表格。'],
    ['YIDA_SEND_APPROVAL_SOURCE_PROJECT_MISMATCH', 422, 'source-project-mismatch', '表格中有行的项目号与该表格登记的项目不一致，生成的编码会对应到别的项目。未保存草稿，原样再试仍会被拒绝。请在表格中改正这些行的项目号后重新读取。'],
    ['YIDA_SEND_APPROVAL_SOURCE_KEY_MISMATCH', 422, 'source-key-mismatch', '编码模板读到的行标识与服务端读取的行键不一致。未保存草稿，原样再试仍会被拒绝。请检查表格的行键列与模板的行标识后重新读取。'],
    ['YIDA_SEND_APPROVAL_SOURCE_KEY_FIELD_MISMATCH', 422, 'source-key-field-mismatch', '编码模板的行标识没有指向表格的行键列（另一列即使内容相同也不行）。未保存草稿，原样再试仍会被拒绝。请把模板的行标识改为行键列对应的字段后重新预演。'],
    ['YIDA_SEND_APPROVAL_GENERATED_LAYOUT_CONFLICT', 409, 'generated-layout-conflict', '该目标的编码模板布局已在首次授权时封存，本草稿的模板布局与之不同（或不含编码模板）；这次请求没有保存草稿、授权或发送任何内容。请改回已封存的模板，或由管理员另建目标。'],
  ] as const)('a draft refused with %s (%i) shows the fixed code and its copy, no draft; the same code on 503 is invalid', async (code, status, id, copy) => {
    mount(false)
    fetchSpy.mockResolvedValueOnce(error(code, status))
    q<HTMLButtonElement>('save').click(); await flush()
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/integration/yida-owner-send/drafts')
    expect(q('error').textContent).toBe(code)
    expect(q(id).textContent).toBe(copy)
    expect(absent('draft')).toBe(true)
    for (const other of ['source-unbound', 'source-project-mismatch', 'source-key-mismatch', 'source-key-field-mismatch',
      'generated-layout-conflict', 'limit'].filter(name => name !== id)) expect(absent(other)).toBe(true)
    fetchSpy.mockResolvedValueOnce(error(code, 503))
    q<HTMLButtonElement>('save').click(); await flush()
    expect(q('error').textContent).toBe('YIDA_OWNER_RESPONSE_INVALID')
    expect(absent(id)).toBe(true)
    expect(absent('draft')).toBe(true)
  })

  it('the sheet column mapping of a v3 draft lists every column the mapping reads, concat-only ones included', async () => {
    mount(true)
    q<HTMLInputElement>('source-sheet').click(); await flush()
    const listed = Array.from(root!.querySelectorAll('[data-testid^="sp-yida-owner-column-"]'))
      .map(node => node.getAttribute('data-testid')!.slice('sp-yida-owner-column-'.length))
    expect(listed).toEqual([...yidaTransformSourceColumns(transform().config)])
    expect(listed).toEqual(expect.arrayContaining(['ext_blankLength', 'ext_blankWidth', 'ext_blankThickness']))
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
