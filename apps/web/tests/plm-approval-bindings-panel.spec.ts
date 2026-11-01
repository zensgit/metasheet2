import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import PlmApprovalBindingsPanel from '../src/components/plm/PlmApprovalBindingsPanel.vue'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('../src/utils/api', () => ({ apiFetch }))
const base = '/api/me/plm-approval-bindings'
const bound = {
  id: 'binding-1', connectionId: 'plm', subjectId: 'verified-user', tenantId: 'tenant', orgId: 'org',
  grantId: 'grant-1', expiresAt: '2030-01-01T00:00:00Z', bound: true, unresolvedCount: 2, canUse: true,
}
function reply(data: unknown, status = 200) { return new Response(JSON.stringify({ ok: true, data }), { status }) }
function state(bindings: unknown[] = [bound]) { return { connection: { id: 'plm', label: '公司 Yuantus', grantManagementUrl: 'https://yuantus.test/personal-approval-grants' }, bindings } }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
let app: App<Element> | null
let host: HTMLDivElement
async function flush() { for (let i = 0; i < 32; i++) { await Promise.resolve(); await nextTick() } }
async function mount() { app = createApp(PlmApprovalBindingsPanel); app.mount(host); await flush() }
function button(label: string) {
  const node = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label))
  if (!node) throw new Error(`Missing button: ${label}`)
  return node
}
async function enter(value: string) {
  const input = host.querySelector('input')!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}
async function submit() { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush() }
beforeEach(() => {
  apiFetch.mockReset()
  localStorage.clear()
  localStorage.setItem('auth_token', 'fixture-account-a')
  host = document.createElement('div')
  document.body.appendChild(host)
  app = null
})
afterEach(() => { app?.unmount(); host.remove(); vi.restoreAllMocks(); localStorage.clear() })

describe('personal Yuantus settings panel with real client API', () => {
  it('renders verified scope/expiry and unresolved recovery instructions without credentials', async () => {
    apiFetch.mockResolvedValue(reply(state()))
    await mount()
    expect(host.textContent).toContain('公司 Yuantus')
    expect(host.textContent).toContain('verified-user')
    expect(host.textContent).toContain('tenant / org')
    expect(host.textContent).toContain('还有 2 项操作')
    expect(host.textContent).toContain('同一 Yuantus 账号')
    const input = host.querySelector('input')!
    expect(input.type).toBe('password')
    expect(input.autocomplete).toBe('new-password')
    const link = host.querySelector('a')!
    expect(link.href).toBe('https://yuantus.test/personal-approval-grants')
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noopener noreferrer')
    expect(button('验证并绑定').disabled).toBe(true)
  })

  it('submits the fixed connection once and clears the grant before the response without storage or query writes', async () => {
    const pending = deferred<Response>()
    apiFetch.mockResolvedValueOnce(reply(state([]))).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(reply(state()))
    await mount()
    const stored = vi.spyOn(Storage.prototype, 'setItem')
    const oldUrl = window.location.href
    await enter('fixture-personal-secret')
    await submit()
    expect(host.querySelector('input')!.value).toBe('')
    expect(button('验证并绑定').disabled).toBe(true)
    expect(apiFetch.mock.calls[1]).toEqual([base, expect.objectContaining({ method: 'POST', body: JSON.stringify({ connectionId: 'plm', grant: 'fixture-personal-secret' }) })])
    await submit()
    expect(apiFetch).toHaveBeenCalledTimes(2)
    pending.resolve(reply(bound, 201))
    await flush()
    expect(host.textContent).toContain('个人授权已验证并绑定')
    expect(host.textContent).not.toContain('fixture-personal-secret')
    expect(host.querySelector('input')!.value).toBe('')
    expect(stored).not.toHaveBeenCalled()
    expect(window.location.href).toBe(oldUrl)
  })

  it('clears a rejected grant and shows only fixed refusal copy', async () => {
    apiFetch.mockResolvedValueOnce(reply(state([]))).mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { code: 'PLM_BINDING_CONFLICT', message: 'fixture-personal-secret' } }), { status: 409 }))
    await mount()
    await enter('fixture-personal-secret')
    await submit()
    expect(host.textContent).toContain('原 Yuantus 账号')
    expect(host.textContent).not.toContain('fixture-personal-secret')
    expect(host.querySelector('input')).toBeNull()
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it('shows disabled or unauthorized state without inventing a binding', async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { code: 'PLM_CARD_DISABLED' } }), { status: 404 }))
    await mount()
    expect(host.textContent).toContain('尚未启用')
    expect(host.querySelector('form')).toBeNull()
  })

  it('unbinds but retains unresolved history and blocks task/receipt requests until rebound', async () => {
    apiFetch.mockResolvedValueOnce(reply(state())).mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(reply(state([{ ...bound, bound: false, canUse: false }])))
    await mount()
    await enter('draft-secret')
    button('解除 Yuantus').click()
    await flush()
    expect(apiFetch.mock.calls[1]).toEqual([`${base}/binding-1`, expect.objectContaining({ method: 'DELETE' })])
    expect(host.textContent).toContain('已解绑')
    expect(host.textContent).toContain('还有 2 项操作')
    expect(host.querySelector('input')!.value).toBe('')
    expect(button('同步我的').disabled).toBe(true)
    expect(button('查询未结').disabled).toBe(true)
  })

  it('syncs tasks and only reads receipts for reconciliation, without approving an absent receipt', async () => {
    apiFetch.mockResolvedValueOnce(reply(state()))
      .mockResolvedValueOnce(reply({ taskCount: 3, retiredCount: 1 })).mockResolvedValueOnce(reply(state()))
      .mockResolvedValueOnce(reply({ settled: 1, pending: 0, admissionRequired: 1 })).mockResolvedValueOnce(reply(state([{ ...bound, unresolvedCount: 1 }])))
    await mount()
    button('同步我的').click(); await flush()
    expect(host.textContent).toContain('已同步 3 个待办')
    button('查询未结').click(); await flush()
    expect(host.textContent).toContain('1 项须回到当前审批页面重新确认')
    expect(host.textContent).toContain('未发起新的审批')
    const posts = apiFetch.mock.calls.filter((call) => call[1].method === 'POST')
    expect(posts.map((call) => [call[0], call[1].body])).toEqual([[`${base}/binding-1/sync`, '{}'], [`${base}/binding-1/reconcile`, '{}']])
  })

  it('clears a draft on account switch and ignores an old account response', async () => {
    const pending = deferred<Response>()
    apiFetch.mockReturnValueOnce(pending.promise)
    await mount()
    localStorage.setItem('auth_token', 'fixture-account-b')
    notifyAuthPrincipalChange()
    await flush()
    expect(apiFetch.mock.calls[0][1].signal.aborted).toBe(true)
    pending.resolve(reply(state()))
    await flush()
    expect(host.textContent).not.toContain('verified-user')
    expect(host.textContent).toContain('登录账号已变更')
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it('does not submit a stale draft under a switched session even before its storage notification', async () => {
    apiFetch.mockResolvedValueOnce(reply(state([])))
    await mount()
    await enter('fixture-personal-secret')
    localStorage.setItem('auth_token', 'fixture-account-b')
    await submit()
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(host.querySelector('input')).toBeNull()
    expect(host.textContent).not.toContain('fixture-personal-secret')
  })

  it('does not follow a stale mutation with a metadata request under another account', async () => {
    const pending = deferred<Response>()
    apiFetch.mockResolvedValueOnce(reply(state([]))).mockReturnValueOnce(pending.promise)
    await mount()
    await enter('fixture-personal-secret'); await submit()
    localStorage.setItem('auth_token', 'fixture-account-b')
    pending.resolve(reply(bound, 201)); await flush()
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(host.textContent).not.toContain('verified-user')
    expect(host.textContent).toContain('登录账号已变更')
  })

  it('aborts on unmount and never refetches after an in-flight bind finishes', async () => {
    const pending = deferred<Response>()
    apiFetch.mockResolvedValueOnce(reply(state([]))).mockReturnValueOnce(pending.promise)
    await mount(); await enter('fixture-personal-secret'); await submit()
    const signal = apiFetch.mock.calls[1][1].signal
    app!.unmount(); app = null
    expect(signal.aborted).toBe(true)
    pending.resolve(reply(bound, 201)); await flush()
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it('keeps owned cleanup when the management URL is absent and blocks sync, reconcile, and bind', async () => {
    const hidden = {
      connection: { id: 'current-plm', label: '公司 Yuantus', grantManagementUrl: null },
      bindings: [{ ...bound, connectionId: 'saved-connection', canUse: false }],
    }
    const after = {
      connection: hidden.connection,
      bindings: [{ ...bound, connectionId: 'saved-connection', bound: false, canUse: false }],
    }
    apiFetch.mockResolvedValueOnce(reply(hidden))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(reply(after))
    await mount()
    expect(host.textContent).toContain('current-plm')
    expect(host.textContent).toContain('saved-connection')
    expect(host.textContent).toContain('只能解除保存的绑定')
    expect(host.querySelector('a')).toBeNull()
    expect(host.querySelector('form')).toBeNull()
    expect(button('同步我的').disabled).toBe(true)
    expect(button('查询未结').disabled).toBe(true)
    expect(button('解除 Yuantus').disabled).toBe(false)
    button('同步我的').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    button('查询未结').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(apiFetch).toHaveBeenCalledTimes(1)
    button('解除 Yuantus').click()
    await flush()
    expect(apiFetch.mock.calls[1]).toEqual([`${base}/binding-1`, expect.objectContaining({ method: 'DELETE' })])
    expect(apiFetch.mock.calls[2][0]).toBe(base)
    expect(apiFetch.mock.calls[2][1].method).toBe('GET')
    expect(host.textContent).toContain('已解绑')
    expect(JSON.stringify(apiFetch.mock.calls)).not.toContain('fixture-personal-secret')
  })

  it('shows an old connection as cleanup-only and does not sync or reconcile it', async () => {
    const legacy = state([{ ...bound, connectionId: 'saved-connection', canUse: false }])
    const after = state([{ ...bound, connectionId: 'saved-connection', bound: false, canUse: false }])
    apiFetch.mockResolvedValueOnce(reply(legacy))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(reply(after))
    await mount()
    expect(host.textContent).toContain('（plm）')
    expect(host.textContent).toContain('saved-connection')
    expect(host.textContent).toContain('只能解除保存的绑定')
    expect(host.querySelector('a')).not.toBeNull()
    expect(button('同步我的').disabled).toBe(true)
    expect(button('查询未结').disabled).toBe(true)
    expect(button('解除 Yuantus').disabled).toBe(false)
    button('同步我的').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    button('查询未结').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(apiFetch).toHaveBeenCalledTimes(1)
    button('解除 Yuantus').click()
    await flush()
    expect(apiFetch.mock.calls[1]).toEqual([`${base}/binding-1`, expect.objectContaining({ method: 'DELETE' })])
    expect(apiFetch.mock.calls[2][0]).toBe(base)
    expect(apiFetch.mock.calls[2][1].method).toBe('GET')
    expect(host.textContent).toContain('已解绑')
  })

  it('clears an unsent draft before a refreshed connection id can be submitted', async () => {
    const pending = deferred<Response>()
    const refreshed = {
      connection: { id: 'plm-b', label: '公司 Yuantus', grantManagementUrl: 'https://yuantus.test/personal-approval-grants' },
      bindings: [{ ...bound, connectionId: 'saved-connection', canUse: false }],
    }
    apiFetch.mockResolvedValueOnce(reply(state())).mockReturnValueOnce(pending.promise)
    await mount()
    const stored = vi.spyOn(Storage.prototype, 'setItem')
    const oldUrl = window.location.href
    await enter('fixture-personal-secret')
    button('刷新连接').click()
    await flush()
    expect(host.querySelector('input')!.value).toBe('')
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(apiFetch.mock.calls[1][1].method).toBe('GET')
    pending.resolve(reply(refreshed))
    await flush()
    expect(host.querySelector('input')!.value).toBe('')
    expect(host.textContent).toContain('plm-b')
    expect(host.textContent).toContain('saved-connection')
    expect(host.textContent).toContain('只能解除保存的绑定')
    await submit()
    expect(apiFetch.mock.calls.filter((call) => call[1].method === 'POST')).toEqual([])
    expect(JSON.stringify(apiFetch.mock.calls)).not.toContain('fixture-personal-secret')
    expect(stored).not.toHaveBeenCalled()
    expect(window.location.href).toBe(oldUrl)
  })
})
