import { readFileSync } from 'node:fs'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import Panel from '../src/components/integration/stockPreparation/StockPreparationYidaAutomationPanel.vue'
import { createYidaAutomationClient, type YidaAutomationConsent } from '../src/services/integration/yidaAutomation'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'

const prefix = '/api/integration/yida-automation-authorizations'
const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTWU4tT1dORVIiLCJ0ZW5hbnRJZCI6IlNZTi1PUkcifQ.c3ludGhldGlj'
const ids = { grant: '11111111-1111-4111-8111-111111111111', operation: '22222222-2222-4222-8222-222222222222',
  row1: '33333333-3333-4333-8333-333333333333', row2: '44444444-4444-4444-8444-444444444444',
  target: '55555555-5555-4555-8555-555555555555', draftTarget: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: '66666666-6666-4666-8666-666666666666',
  command: '77777777-7777-4777-8777-777777777777', request: '88888888-8888-4888-8888-888888888888', admission: '99999999-9999-4999-8999-999999999999' }
const ruleDto = (slot = 'synthetic-slot') => ({ id: 'synthetic-rule', sheetId: 'synthetic-sheet', name: 'Synthetic', enabled: true,
  actionType: 'integration_yida_send_authorized', actionConfig: { authorizationSlot: slot }, actions: null, conditions: null,
  triggerType: 'schedule.interval', triggerConfig: { intervalMs: 60000 }, executionMode: 'legacy', integrationAuthorityRevision: ids.revision })
const draft = () => ({ targetRef: ids.draftTarget, operationId: ids.operation, status: 'unverified', identityKind: 'local-unverified',
  canSend: false, canApply: false, tokenIssued: false, externalWriteAttempted: false, rowCount: 2,
  rows: [{ rowKey: ids.row1, index: 0 }, { rowKey: ids.row2, index: 1 }], reused: false })
const initialized = () => ({ commandId: ids.command, status: 'initialized', draft: draft(), canSend: false, tokenIssued: false, externalWriteAttempted: false })
const preview = (rowKey: string) => ({ operationId: ids.operation, rowKey, planDigest: 'a'.repeat(64), rowPayloadDigest: 'b'.repeat(64),
  target: { targetRef: ids.target, identityKind: 'owner-attested-single-target', evidenceVersion: 1, reviewRef: 'SYN-REVIEW', organizationId: 'SYN-ORG', appType: 'SYN-APP', formUuid: 'SYN-FORM' },
  payload: { project: 'DEMO-P1', line: rowKey === ids.row1 ? 'L1' : 'L2' },
  policy: { intent: 'create', maxAttempts: 1, maxTtlMs: 900000, requiresExplicitConfirmation: true, unknownMustNotRetry: true }, canSend: false, externalWriteAttempted: false })
const summary = () => ({ grantId: ids.grant, usedExecutions: 0, maxExecutions: 2, expiresAt: Date.now() + 600000,
  activeRequestId: null as string | null, status: 'recorded', revoked: false, canSend: false, externalWriteAttempted: false, liveEligibilityChecked: false })
const observation = () => ({ ...summary(), requests: [] as unknown[], serialBlocked: false })
function input(): YidaAutomationConsent { return { confirmationId: ids.command, ruleId: 'synthetic-rule', expectedRuleRevision: ids.revision,
  actionId: 'synthetic-slot', projectNo: 'DEMO-P1', operationId: ids.operation, rowKeys: [ids.row1, ids.row2], allowedTriggers: ['manual','schedule.interval'], maxExecutions: 2, ttlMs: 900000 } }
function json(data: unknown, status = 200) { return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } }) }
function error(code: string, status: number) { return new Response(JSON.stringify({ ok: false, error: { code } }), { status, headers: { 'Content-Type': 'application/json' } }) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const fetchSpy = vi.fn(), locked = vi.fn()
let app: App | null = null, root: HTMLElement | null = null
const context = ref({ sheetId: 'synthetic-sheet', projectNo: 'DEMO-P1', scopeKey: '{}' })
let readback: ReturnType<typeof observation>, previewDisabled: boolean
function mountPanel() { root = document.createElement('div'); document.body.appendChild(root); app = createApp(() => h(Panel, { ...context.value, onLockedChange: locked })); app.mount(root) }
function q<T extends HTMLElement = HTMLButtonElement>(name: string): T { const node = root?.querySelector(`[data-testid="sp-yida-auto-${name}"]`); expect(node).toBeTruthy(); return node as T }
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); await nextTick() }
async function click(name: string) { q<HTMLButtonElement>(name).click(); await flush() }
async function check(name: string) { const node = q<HTMLInputElement>(name); node.checked = true; node.dispatchEvent(new Event('change')); await flush() }
async function prepare() { await click('load'); q<HTMLSelectElement>('rule').value = 'synthetic-rule'; q('rule').dispatchEvent(new Event('change')); await flush(); await check('row-0'); await check('row-1'); await click('preview'); await check('manual'); await check('schedule'); await check('ack') }
const posts = (url: string) => fetchSpy.mock.calls.filter(([path, init]) => path === url && init?.method === 'POST')
beforeEach(() => {
  context.value = { sheetId: 'synthetic-sheet', projectNo: 'DEMO-P1', scopeKey: '{}' }; previewDisabled = false; readback = observation()
  localStorage.setItem('auth_token', token); fetchSpy.mockReset(); locked.mockReset()
  fetchSpy.mockImplementation(async (url: string, init: RequestInit) => {
    if (url === '/api/multitable/sheets/synthetic-sheet/automations' && init.method === 'GET') return json({ rules: [ruleDto()] })
    if (url === '/api/integration/yida-owner-send/initialization' && init.method === 'GET') return json(initialized())
    if (url === '/api/integration/yida-owner-send/preview' && init.method === 'POST') return previewDisabled ? error('YIDA_OWNER_RUNTIME_DISABLED', 403) : json(preview(JSON.parse(String(init.body)).rowKey))
    if (url === prefix && init.method === 'POST') return json({ ...summary(), reused: false }, 201)
    if (url === `${prefix}/${ids.grant}` && init.method === 'GET') return json(readback)
    if (url === `${prefix}/${ids.grant}/requests` && init.method === 'POST') return json({ requestId: ids.request, rowOrdinal: 0, reused: false, deliveryQueued: true, canSend: false, externalWriteAttempted: false }, 202)
    if (url === `${prefix}/${ids.grant}/revoke` && init.method === 'POST') return json({ ...summary(), status: 'revoked', revoked: true })
    throw new Error('SYNTHETIC_UNEXPECTED_ROUTE')
  })
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => { app?.unmount(); root?.remove(); app = null; root = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('SA06D current Vue UI with the actual clients, mocked fetch boundary only', () => {
  it('mounts without IO, automatic consent, request or vendor call', () => { mountPanel(); expect(fetchSpy).not.toHaveBeenCalled(); expect(root?.textContent).toContain('默认不发送') })
  it('gets the actual rule version, server draft and two row previews before explicit finite consent; never auto requests', async () => {
    expect(ids.draftTarget).not.toBe(ids.target) // Distinct production identity domains, not a shared fixture alias.
    localStorage.setItem('tenantId', 'UNTRUSTED-SCOPE-HINT')
    mountPanel(); await prepare(); expect(posts(prefix)).toHaveLength(0)
    await click('approve'); expect(posts(prefix)).toHaveLength(1)
    const [path, options] = posts(prefix)[0], body = JSON.parse(options.body)
    expect(body).toEqual({ ...input(), confirmationId: expect.any(String) }); expect(path).toBe(prefix)
    expect(Object.keys(options.headers).sort()).toEqual(['Accept','Authorization','Content-Type'].sort())
    expect(options).toMatchObject({ credentials: 'omit', mode: 'same-origin', redirect: 'error', cache: 'no-store' })
    expect(posts(`${prefix}/${ids.grant}/requests`)).toHaveLength(0)
    expect(q('grant').textContent).not.toContain('定时已启动'); expect(q('grant').textContent).toContain('历史回执不恢复')
  })
  it.each(['targetRef', 'reviewRef', 'organizationId', 'appType', 'formUuid', 'planDigest'] as const)(
    'refuses differing approved preview %s even when both selected members are valid', async field => {
      const original = fetchSpy.getMockImplementation()!
      fetchSpy.mockImplementation(async (url: string, init: RequestInit) => {
        if (url === '/api/integration/yida-owner-send/preview' && init.method === 'POST'
          && JSON.parse(String(init.body)).rowKey === ids.row2) {
          const value = preview(ids.row2)
          return json(field === 'planDigest' ? { ...value, planDigest: 'c'.repeat(64) }
            : { ...value, target: { ...value.target, [field]: field === 'targetRef' ? ids.draftTarget : 'SYN-DIFFERENT' } })
        }
        return original(url, init)
      })
      mountPanel(); await click('load')
      q<HTMLSelectElement>('rule').value = 'synthetic-rule'; q('rule').dispatchEvent(new Event('change')); await flush()
      await check('row-0'); await check('row-1'); await click('preview')
      expect(q('error').textContent).toBe('YIDA_AUTOMATION_RESPONSE_INVALID')
      expect(root?.querySelector('[data-testid="sp-yida-auto-previews"]')).toBeNull()
      expect(posts(prefix)).toHaveLength(0)
    })
  it('a closed owner preview gate stays closed: local rows never substitute for all server previews', async () => {
    previewDisabled = true; mountPanel(); await click('load'); await check('row-0'); await click('preview')
    expect(q('error').textContent).toBe('YIDA_OWNER_RUNTIME_DISABLED'); expect(root?.querySelector('[data-testid="sp-yida-auto-approve"]')).toBeNull()
    expect(posts(prefix)).toHaveLength(0)
  })
  it('context A -> B -> A invalidates old work even when the old fetch ignores abort', async () => {
    const wait = deferred<Response>(); fetchSpy.mockReturnValueOnce(wait.promise)
    mountPanel(); q('load').click(); await flush()
    context.value = { ...context.value, projectNo: 'DEMO-P2' }; await nextTick()
    context.value = { ...context.value, projectNo: 'DEMO-P1' }; await nextTick()
    wait.resolve(json({ rules: [ruleDto()] })); await flush()
    expect(root?.querySelector('[data-testid="sp-yida-auto-draft"]')).toBeNull(); expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
  it('lost approval response keeps exactly the same command; no automatic retry or replacement budget', async () => {
    mountPanel(); await prepare(); fetchSpy.mockRejectedValueOnce(new Error('PRIVATE_MESSAGE_MUST_NOT_RENDER'))
    await click('approve'); const first = posts(prefix)[0][1].body
    expect(q('error').textContent).toBe('YIDA_AUTOMATION_UNAVAILABLE'); expect(root?.textContent).not.toContain('PRIVATE_MESSAGE')
    expect(posts(prefix)).toHaveLength(1)
    fetchSpy.mockResolvedValueOnce(json({ ...summary(), reused: true }))
    const button = q<HTMLElement>('approval-uncertain').querySelector('button')!; button.click(); await flush()
    expect(posts(prefix)).toHaveLength(2); expect(posts(prefix)[1][1].body).toBe(first)
    expect(posts(`${prefix}/${ids.grant}/requests`)).toHaveLength(0)
  })
  it('session invalidation clears a pending approval and rejects a late successful response', async () => {
    mountPanel(); await prepare(); const wait = deferred<Response>(); fetchSpy.mockReturnValueOnce(wait.promise)
    q('approve').click(); await flush(); notifyAuthPrincipalChange(); await flush()
    wait.resolve(json({ ...summary(), reused: false }, 201)); await flush()
    expect(root?.querySelector('[data-testid="sp-yida-auto-grant"]')).toBeNull()
    expect(q('error').textContent).toBe('YIDA_AUTOMATION_SESSION_CHANGED')
  })
  it('manual request uncertainty reuses the original key and freezes new requests once queued', async () => {
    mountPanel(); await prepare(); await click('approve'); await click('refresh')
    fetchSpy.mockRejectedValueOnce(new Error('PRIVATE')); await click('request')
    const url = `${prefix}/${ids.grant}/requests`, original = posts(url)[0][1].body
    fetchSpy.mockResolvedValueOnce(json({ requestId: ids.request, rowOrdinal: 0, reused: true, deliveryQueued: true, canSend: false, externalWriteAttempted: false }))
    await click('request'); expect(posts(url)).toHaveLength(2); expect(posts(url)[1][1].body).toBe(original)
    expect(q<HTMLButtonElement>('request').disabled).toBe(true)
  })
  it('a real unconfirmed/dispatching history is not ACK or business success and cannot gain a second request', async () => {
    mountPanel(); await prepare(); await click('approve')
    readback = { ...summary(), usedExecutions: 1, activeRequestId: ids.request, serialBlocked: true, requests: [{ requestId: ids.request, rowOrdinal: 0,
      status: 'admitted', admissionId: ids.admission, ledgerStatus: 'dispatching', durable: true, canSend: false }] }
    await click('refresh'); expect(q('result-0').textContent).toContain('结果未确认，禁止再次 CREATE')
    expect(q<HTMLButtonElement>('request').disabled).toBe(true); expect(posts(`${prefix}/${ids.grant}/requests`)).toHaveLength(0)
  })
  it('protocol ACK remains explicitly business-unverified; finite next-row requests remain possible only after observation', async () => {
    mountPanel(); await prepare(); await click('approve')
    readback = { ...summary(), usedExecutions: 1, serialBlocked: false, requests: [{ requestId: ids.request, rowOrdinal: 0,
      status: 'closed_observed', admissionId: ids.admission, ledgerStatus: 'acknowledged', durable: true, canSend: false }] }
    await click('refresh'); expect(q('result-0').textContent).toBe('第 1 行：已收到协议 ACK，业务成功尚未核验')
    expect(q<HTMLButtonElement>('request').disabled).toBe(false)
  })
  it('a lost generic rule-create response retains its slot and only reconciles by a unique GET result', async () => {
    mountPanel(); fetchSpy.mockRejectedValueOnce(new Error('PRIVATE')); await click('create-rule')
    const url = '/api/multitable/sheets/synthetic-sheet/automations', calls = posts(url)
    expect(calls).toHaveLength(1); const slot = JSON.parse(calls[0][1].body).actionConfig.authorizationSlot
    expect(JSON.parse(calls[0][1].body)).not.toHaveProperty('createdBy')
    fetchSpy.mockResolvedValueOnce(json({ rules: [ruleDto(slot)] }))
    q<HTMLElement>('rule-uncertain').querySelector('button')!.click(); await flush()
    expect(posts(url)).toHaveLength(1); expect(q<HTMLSelectElement>('rule').value).toBe('synthetic-rule')
  })
  it('restoring a historical grant is read/revoke only and never restores automatic or manual execution eligibility', async () => {
    mountPanel(); const field = q<HTMLInputElement>('restore-id'); field.value = ids.grant; field.dispatchEvent(new Event('input')); await flush()
    await click('restore'); expect(q('grant').textContent).toContain(ids.grant)
    expect(root?.querySelector('[data-testid="sp-yida-auto-request"]')).toBeNull()
    expect(posts(prefix)).toHaveLength(0); expect(posts(`${prefix}/${ids.grant}/requests`)).toHaveLength(0)
  })
})

describe('SA06D fixed client transport and fail-closed DTOs', () => {
  it('matches the actual production router prefix, not a fake test-only URL', () => {
    const source = readFileSync(fileURLToPath(new NodeURL('../../../packages/core-backend/src/integration/yida-owner-http-observation.ts', import.meta.url)), 'utf8')
    expect(source.match(/^export const YIDA_AUTOMATION_HTTP_PREFIX = '([^']+)'/mu)?.[1]).toBe(prefix)
  })
  it('rejects extra scope before IO and never serializes a principal from localStorage', async () => {
    const client = createYidaAutomationClient()
    try { await expect(client.createApproval({ ...input(), tenantId: 'forged' } as never)).rejects.toThrow('YIDA_AUTOMATION_INPUT_INVALID') }
    finally { client.dispose() }
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('rejects cross-grant readback and unallowlisted error text', async () => {
    const client = createYidaAutomationClient()
    try {
      fetchSpy.mockResolvedValueOnce(json({ ...observation(), grantId: ids.target }))
      await expect(client.inspect(ids.grant)).rejects.toThrow('YIDA_AUTOMATION_RESPONSE_INVALID')
      fetchSpy.mockResolvedValueOnce(error('PRIVATE_UNKNOWN_CODE', 503))
      await expect(client.inspect(ids.grant)).rejects.toThrow('YIDA_AUTOMATION_RESPONSE_INVALID')
    } finally { client.dispose() }
  })
  it('enforces streaming byte budget without content-length and aborts the original signal', async () => {
    const client = createYidaAutomationClient()
    try {
      fetchSpy.mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }))
      await expect(client.inspect(ids.grant)).rejects.toThrow('YIDA_AUTOMATION_RESPONSE_INVALID')
      expect(fetchSpy.mock.calls[0][1].signal.aborted).toBe(true)
    } finally { client.dispose() }
  })
  it('refuses late readback after a token change without fetching with a replacement identity', async () => {
    const client = createYidaAutomationClient(), wait = deferred<Response>(); fetchSpy.mockReturnValueOnce(wait.promise)
    const pending = client.inspect(ids.grant); localStorage.setItem('auth_token', `${token}B`)
    wait.resolve(json(observation())); await expect(pending).rejects.toThrow('YIDA_AUTOMATION_SESSION_CHANGED')
    expect(fetchSpy).toHaveBeenCalledTimes(1); client.dispose()
  })
  it('rejects a timestamp outside the Date domain before a template can render it', async () => {
    const client = createYidaAutomationClient()
    try { fetchSpy.mockResolvedValueOnce(json({ ...observation(), expiresAt: Number.MAX_SAFE_INTEGER })); await expect(client.inspect(ids.grant)).rejects.toThrow('YIDA_AUTOMATION_RESPONSE_INVALID') }
    finally { client.dispose() }
  })
})
