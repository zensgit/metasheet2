import { webcrypto } from 'node:crypto'
import { createApp, h, nextTick, type App } from 'vue'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import Panel from '../src/components/integration/stockPreparation/StockPreparationYidaReconciliationPanel.vue'
import { createYidaAutomationClient } from '../src/services/integration/yidaAutomation'
import { parseYidaReconciliationInput, parseYidaReconciliationRecord, type YidaReconciliationInput } from '../src/services/integration/yidaReconciliation'
import { openYidaReconciliationPending } from '../src/services/integration/yidaReconciliationPending'

const id = '11111111-1111-4111-8111-111111111111', entry = '22222222-2222-4222-8222-222222222222'
const recordId = '33333333-3333-4333-8333-333333333333'
const endpoint = `/api/integration/yida-automation-authorizations/${id}/requests/${entry}/observations`
const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTWU4tT1dORVIiLCJ0ZW5hbnRJZCI6IlNZTi1PUkcifQ.c3ludGhldGlj'
const input = (): YidaReconciliationInput => ({ commandKey: recordId, expectedHeadSequence: 0, conclusion: 'inconclusive',
  reason: 'NO_OBSERVATION', evidenceKind: null, evidenceSha256: null, evidenceRef: null, claimedObservedAt: null, supersedesObservationId: null })
const record = (body = input()) => ({ ...body, id: recordId, sequence: body.expectedHeadSequence + 1, authorId: 'SYN-OWNER',
  recordedAt: '2026-10-21T01:00:00.000Z', evidenceOrigin: 'operator-supplied', evidenceVerified: false, canSend: false, canRetry: false })
const page = (records: unknown[] = [], headSequence = 0, nextAfterId: string | null = null) => ({ records, headSequence, nextAfterId, canSend: false, canRetry: false })
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'content-type': 'application/json' } })
const fetchSpy = vi.fn()
let app: App | null = null, root: HTMLDivElement | null = null
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
async function flush() { for (let i = 0; i < 20; i++) { await pause(); await nextTick() } }
function mount() { root = document.createElement('div'); document.body.append(root); app = createApp(() => h(Panel,
  { grantId: id, requestId: entry, ledgerStatus: 'outcome_unknown', scopeKey: 'synthetic' })); app.mount(root) }
function button(text: string) { const node = [...root!.querySelectorAll('button')].find(item => item.textContent!.includes(text)); expect(node).toBeTruthy(); return node! }
async function click(text: string) { button(text).click(); await flush() }
async function confirm() { const node = root!.querySelector<HTMLInputElement>('input[type=checkbox]')!; node.checked = true; node.dispatchEvent(new Event('change')); await flush() }
beforeEach(() => {
  sessionStorage.clear(); localStorage.setItem('auth_token', token); fetchSpy.mockReset()
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => { app?.unmount(); app = null; root?.remove(); root = null; vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('strict evidence declarations reject array coercion, secrets, URL and false proof flags', () => {
  expect(parseYidaReconciliationInput(input())).toEqual(input())
  for (const patch of [{ token: 'forbidden' }, { conclusion: 'observed_match' },
    { evidenceKind: ['operator_receipt'], evidenceSha256: 'a'.repeat(64), evidenceRef: 'synthetic' },
    { evidenceKind: 'operator_receipt', evidenceSha256: 'a'.repeat(64), evidenceRef: 'https://invalid.test' }]) {
    expect(() => parseYidaReconciliationInput({ ...input(), ...patch })).toThrow()
  }
  for (const patch of [{ canRetry: true }, { canSend: true }, { evidenceVerified: true }, { evidenceOrigin: 'system-verified' }]) {
    expect(() => parseYidaReconciliationRecord({ ...record(), ...patch })).toThrow()
  }
})
it('reason remains a string enum without coercing arrays or invoking user conversion', () => {
  const toString = vi.fn(() => 'NO_OBSERVATION')
  for (const reason of [['NO_OBSERVATION'], { toString }]) {
    expect(() => parseYidaReconciliationInput({ ...input(), reason })).toThrow()
  }
  expect(toString).not.toHaveBeenCalled()
})
it.each(['constructor', 'toString', '__proto__'])('rejects inherited conclusion %s with the closed validation error', conclusion => {
  expect(() => parseYidaReconciliationInput({ ...input(), conclusion }))
    .toThrowError(new Error('YIDA_RECONCILIATION_INVALID'))
})
it('accepts each own conclusion enum under the existing evidence rules', () => {
  for (const [conclusion, reason] of [['observed_match', 'OPERATOR_RECORDED_MATCH'],
    ['observed_mismatch', 'FIELD_MISMATCH'], ['inconclusive', 'NO_OBSERVATION']]) {
    const candidate = { ...input(), conclusion, reason, evidenceKind: 'operator_receipt',
      evidenceSha256: 'a'.repeat(64), evidenceRef: 'SYN-RECEIPT' }
    expect(parseYidaReconciliationInput(candidate)).toEqual(candidate)
  }
})
it('actual client sends only the fixed history endpoint with JWT and validates the exact replayed body', async () => {
  fetchSpy.mockResolvedValue(json({ record: record(), reused: false }, 201))
  const client = createYidaAutomationClient()
  try {
    expect((await client.appendObservation(id, entry, input())).reused).toBe(false)
    expect(fetchSpy.mock.calls[0][0]).toBe(endpoint)
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store' })
    expect(Object.keys(fetchSpy.mock.calls[0][1].headers).sort()).toEqual(['Accept','Authorization','Content-Type'])
    fetchSpy.mockResolvedValue(json({ record: { ...record(), commandKey: id }, reused: false }, 201))
    await expect(client.appendObservation(id, entry, input())).rejects.toThrow()
  } finally { client.dispose() }
})
it('journal survives remount and token refresh, stores no token, rejects overwriting an unresolved command', async () => {
  const a = await openYidaReconciliationPending(id, entry); a.save(input())
  const raw = JSON.stringify(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)]))
  expect(raw).not.toContain(token)
  localStorage.setItem('auth_token', token.replace('c3ludGhldGlj', 'bmV3U2lnbmF0dXJl'))
  const b = await openYidaReconciliationPending(id, entry); expect(b.read()).toEqual(input())
  expect(() => b.save({ ...input(), commandKey: id })).toThrow()
  b.remove(input().commandKey); expect(b.read()).toBe(null)
})
it('Vue is inert on mount and unknown receipts preserve the identical command across remount', async () => {
  fetchSpy.mockImplementation(async (_url, options) => { if (options.method === 'GET') return json(page()); throw new Error('SYNTHETIC_RESPONSE_LOST') })
  mount(); expect(fetchSpy).not.toHaveBeenCalled()
  await click('读取核验历史'); await confirm(); await click('追加人工声明')
  const first = fetchSpy.mock.calls.find(([, options]) => options.method === 'POST')![1].body
  expect(root!.textContent).toContain('原命令'); app!.unmount(); root!.remove(); mount()
  await click('读取核验历史'); await click('按原命令')
  const posts = fetchSpy.mock.calls.filter(([, options]) => options.method === 'POST')
  expect(posts).toHaveLength(2); expect(posts[1][1].body).toBe(first)
  expect(root!.textContent).toContain('outcome_unknown'); expect(root!.textContent).toContain('不允许重发')
})
it('Vue conflict requires reread and explicit acknowledgement before a new command can be built', async () => {
  fetchSpy.mockImplementation(async (_url, options) => options.method === 'GET' ? json(page())
    : new Response(JSON.stringify({ ok: false, error: { code: 'YIDA_RECONCILIATION_CONFLICT' } }),
      { status: 409, headers: { 'content-type': 'application/json' } }))
  mount(); await click('读取核验历史'); await confirm(); await click('追加人工声明')
  expect(root!.textContent).not.toContain('放弃此冲突命令')
  await click('读取核验历史'); await click('放弃此冲突命令')
  expect(button('追加人工声明').disabled).toBe(true)
  expect(fetchSpy.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1)
})
it('Vue cannot append while a newer history page remains unread', async () => {
  const records = Array.from({ length: 50 }, (_, index) => ({ ...record({ ...input(), expectedHeadSequence: index }), id: index === 49 ? recordId : id }))
  fetchSpy.mockResolvedValue(json(page(records, 51, recordId)))
  mount(); await click('读取核验历史'); await confirm()
  expect(button('追加人工声明').disabled).toBe(true); expect(button('下一页').disabled).toBe(false)
  expect(fetchSpy.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
})
it('rereading history invalidates an earlier human confirmation', async () => {
  fetchSpy.mockResolvedValue(json(page()))
  mount(); await click('读取核验历史'); await confirm()
  expect(button('追加人工声明').disabled).toBe(false)
  await click('读取核验历史')
  expect(button('追加人工声明').disabled).toBe(true)
  expect(root!.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false)
})
it('storage failure blocks the first write instead of submitting an unrecoverable command', async () => {
  fetchSpy.mockResolvedValue(json(page()))
  mount(); await click('读取核验历史'); await confirm()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('SYNTHETIC_STORAGE_FULL') })
  await click('追加人工声明')
  expect(fetchSpy.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
  expect(root!.textContent).toContain('YIDA_RECONCILIATION_RECOVERY_REQUIRED')
})
it('a different subject cannot recover another owner journal through the UI partition', async () => {
  const a = await openYidaReconciliationPending(id, entry); a.save(input())
  const foreignPayload = btoa(JSON.stringify({ sub: 'SYN-OTHER', tenantId: 'SYN-ORG' })).replace(/=/g, '')
  localStorage.setItem('auth_token', 'eyJhbGciOiJIUzI1NiJ9.' + foreignPayload + '.c3ludGhldGlj')
  expect((await openYidaReconciliationPending(id, entry)).read()).toBe(null)
})
