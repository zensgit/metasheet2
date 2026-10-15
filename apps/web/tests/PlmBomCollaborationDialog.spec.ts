import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import PlmBomCollaborationDialog from '../src/components/plm/PlmBomCollaborationDialog.vue'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { AppRouteNames } from '../src/router/types'
const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('../src/utils/api', () => ({ apiFetch }))
const root = '/api/plm-bom-reviews'
const preview = { previewId: 'preview', expiresAt: '2099-01-01T00:15:00Z', snapshotHash: 'hash', snapshotAt: '2026-10-01T00:00:00Z', part: { partId: 'part', itemNumber: 'P-1', name: 'Assembly' }, lineCount: 2, occurrenceCount: 3, source: { tenantId: 'tenant', orgId: 'org', authUserId: 'verified-actor', partId: 'part' } }
const binding = { id: 'binding', version: 1, dataSourceId: 'source', partId: 'part', baseId: 'base', sheetId: 'sheet', viewId: 'view', name: 'BOM review', status: 'active', lastSyncedAt: '2026-10-01T00:00:00Z', sourceSnapshotHash: 'hash', lineCount: 2, occurrenceCount: 3, navigationPath: 'https://not-used.invalid/', canRefresh: true, canDisable: true }
function reply(data: unknown, status = 200) { return new Response(JSON.stringify({ ok: true, data }), { status }) }
function failure(code: string) { return new Response(JSON.stringify({ ok: false, error: { code, message: 'private-detail' } }), { status: 409 }) }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
let app: App | null, host: HTMLDivElement, router: Router
let existing: unknown[]
const source = ref('source')
const close = vi.fn()
async function flush() { for (let i = 0; i < 35; i++) { await Promise.resolve(); await nextTick() } }
function button(label: string): HTMLButtonElement {
  const node = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label))
  if (!node) throw new Error(`Missing button: ${label}`)
  return node
}
async function input(selector: string, value: string) {
  const element = host.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!
  element.value = value; element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); await flush()
}
async function target() { await input('select', 'base'); await input('[data-testid="collaboration-name"]', 'BOM review') }
async function showPreview() { await target(); host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush() }
async function consent() { const el = host.querySelector<HTMLInputElement>('[data-testid="collaboration-consent"]')!; el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); await flush() }
async function mount() {
  router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { render: () => null } },
    { path: '/multitable/:sheetId/:viewId', name: AppRouteNames.MULTITABLE, component: { render: () => null } },
  ] })
  await router.push('/'); await router.isReady()
  app = createApp(defineComponent({ setup: () => () => h(PlmBomCollaborationDialog, { dataSourceId: source.value, partId: 'part', onClose: close }) }))
  app.use(router); app.mount(host); await flush()
}
beforeEach(() => {
  app = null; existing = []; source.value = 'source'; close.mockReset(); apiFetch.mockReset()
  localStorage.setItem('auth_token', 'account-a')
  vi.stubGlobal('crypto', { randomUUID: () => '12345678-1234-4123-8123-123456789012' })
  apiFetch.mockImplementation(async (url: string, options: RequestInit) => {
    if (url === `${root}/bases`) return reply({ items: [{ id: 'base', name: 'Engineering' }, { id: 'base-2', name: 'Review team' }] })
    if (options.method === 'GET') return reply({ items: existing })
    if (url === `${root}/preview`) return reply(preview)
    if (url === root) return reply(binding, 201)
    return reply({ ...binding, version: 2, status: url.endsWith('/disable') ? 'disabled' : 'active', canRefresh: !url.endsWith('/disable'), canDisable: !url.endsWith('/disable') })
  })
  host = document.createElement('div'); document.body.appendChild(host)
})
afterEach(() => { app?.unmount(); host.remove(); vi.unstubAllGlobals(); localStorage.clear() })

describe('BOM sharing dialog with real client and native router', () => {
  it('opens notification settings only with a server capability and closes them when that capability is lost', async () => {
    existing = [{ ...binding, canConfigureNotifications: true }]
    await mount()
    apiFetch.mockResolvedValueOnce(reply({ version: 0, notifications: null }))
    button('配置通知规则').click(); await flush()
    expect(host.querySelector('[aria-label="BOM 通知配置"]')).not.toBeNull()
    existing = [{ ...binding, canConfigureNotifications: false }]
    button('重新加载目标').click(); await flush()
    expect(host.querySelector('[aria-label="BOM 通知配置"]')).toBeNull()
    expect([...host.querySelectorAll('button')].some((node) => node.textContent?.includes('配置通知规则'))).toBe(false)
  })
  it('loads only destinations/bindings and requires target choice plus explicit consent', async () => {
    await mount()
    expect(apiFetch.mock.calls.map(([url]) => url)).toEqual([`${root}/bases`, `${root}?dataSourceId=source&partId=part`])
    expect(button('预览分享').disabled).toBe(true)
    expect(host.textContent).toContain('新表并非仅创建者可读')
    expect(host.textContent).toContain('指派责任人不会授予访问权限')
    expect(host.textContent).toContain('问题、临期及 SLA 规则可配置')
    await showPreview()
    expect(apiFetch.mock.calls[2][1].body).toBe(JSON.stringify({ dataSourceId: 'source', partId: 'part', baseId: 'base', name: 'BOM review' }))
    expect(host.textContent).toContain('2 条逻辑 BOM 行，3 次树中出现')
    expect(host.textContent).toContain('tenant / org')
    expect(button('确认分享').disabled).toBe(true)
    await consent(); button('确认分享').click(); await flush()
    expect(apiFetch.mock.calls[3][1].body).toBe(JSON.stringify({ previewId: 'preview', requestId: '12345678-1234-4123-8123-123456789012' }))
    expect(router.currentRoute.value.fullPath).toBe('/multitable/sheet/view?baseId=base')
    expect(host.textContent).not.toContain('not-used.invalid')
  })
  it('invalidates consent when the target changes and creates no sheet from preview alone', async () => {
    await mount(); await showPreview(); await consent()
    await input('select', 'base-2')
    expect(host.querySelector('[data-testid="collaboration-preview"]')).toBeNull()
    expect(apiFetch.mock.calls.filter(([url]) => url === root)).toHaveLength(0)
    await showPreview(); await input('[data-testid="collaboration-name"]', 'Renamed')
    expect(host.querySelector('[data-testid="collaboration-consent"]')).toBeNull()
  })
  it('keeps the same request key after unknown network outcome and blocks double submit', async () => {
    await mount(); await showPreview(); await consent()
    const pending = deferred<Response>()
    apiFetch.mockImplementationOnce(() => pending.promise)
    button('确认分享').click(); await flush(); button('确认分享').click(); await flush()
    expect(apiFetch.mock.calls.filter(([url]) => url === root)).toHaveLength(1)
    pending.resolve(failure('RUNTIME_UNAVAILABLE')); await flush()
    expect(host.textContent).not.toContain('private-detail')
    button('确认分享').click(); await flush()
    const calls = apiFetch.mock.calls.filter(([url]) => url === root)
    expect(calls).toHaveLength(2); expect(calls[0][1].body).toBe(calls[1][1].body)
    expect(router.currentRoute.value.name).toBe(AppRouteNames.MULTITABLE)
  })
  it.each(['SOURCE_CHANGED', 'PREVIEW_EXPIRED'])('requires a new preview after %s', async (code) => {
    await mount(); await showPreview(); await consent()
    apiFetch.mockResolvedValueOnce(failure(code)); button('确认分享').click(); await flush()
    expect(host.querySelector('[data-testid="collaboration-preview"]')).toBeNull()
    expect(router.currentRoute.value.path).toBe('/')
    expect(host.textContent).not.toContain('private-detail')
  })
  it('does not submit an expired preview', async () => {
    await mount(); await target()
    apiFetch.mockResolvedValueOnce(reply({ ...preview, expiresAt: '2020-01-01T00:00:00Z' }))
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush()
    await consent(); button('确认分享').click(); await flush()
    expect(host.textContent).toContain('分享预览已过期')
    expect(apiFetch.mock.calls.filter(([url]) => url === root)).toHaveLength(0)
  })
  it('refreshes with CAS, retains local-data disclosure and can stop future refresh', async () => {
    existing = [binding]; await mount()
    button('刷新来源').click(); await flush()
    expect(apiFetch.mock.calls[2]).toEqual([`${root}/binding/refresh`, expect.objectContaining({ body: '{"expectedVersion":1}' })])
    expect(host.textContent).toContain('本地协作字段保留')
    button('停用后续').click(); await flush()
    expect(apiFetch.mock.calls[3][1].body).toBe('{"expectedVersion":2}')
    expect(host.textContent).toContain('已停用刷新')
    expect(host.textContent).toContain('已有快照和本地协作数据保留')
    expect([...host.querySelectorAll('button')].some((node) => node.textContent?.includes('停用后续刷新'))).toBe(false)
  })
  it('shows readable stale bindings without granting refresh or disable actions', async () => {
    existing = [{ ...binding, status: 'stale', canRefresh: false, canDisable: false }]; await mount()
    expect(host.textContent).toContain('来源待刷新或已失效')
    expect(host.textContent).not.toContain('刷新来源快照')
    button('打开协作表').click(); await flush()
    expect(router.currentRoute.value.path).toBe('/multitable/sheet/view')
  })
  it.each([503, 404])('handles disabled or unmounted routes (%s) without enabling creation', async (status) => {
    apiFetch.mockImplementation(async () => status === 404 ? new Response('Not Found', { status })
      : new Response(JSON.stringify({ ok: false, error: { code: 'PLM_BOM_REVIEW_DISABLED' } }), { status }))
    await mount()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(status === 404 ? '入口当前不可用' : '尚未启用')
    expect(button('预览分享').disabled).toBe(true)
    expect(host.querySelector('[data-binding-id]')).toBeNull()
  })
  it('keeps a shared table accessible after refresh refusal without claiming a refreshed snapshot', async () => {
    existing = [binding]; await mount()
    apiFetch.mockResolvedValueOnce(failure('SOURCE_FORBIDDEN'))
    button('刷新来源').click(); await flush()
    expect(host.textContent).toContain('来源权限已失效')
    expect(host.querySelector('[data-binding-id="binding"]')?.textContent).toContain('刷新失败，保留上次快照')
    expect(host.textContent).not.toContain('来源快照已刷新')
    expect(host.textContent).toContain(binding.lastSyncedAt)
    button('打开协作表').click(); await flush()
    expect(router.currentRoute.value.name).toBe(AppRouteNames.MULTITABLE)
  })
  it('rejects a mismatched created binding without navigating', async () => {
    await mount(); await showPreview(); await consent()
    apiFetch.mockResolvedValueOnce(reply({ ...binding, partId: 'other' }, 201))
    button('确认分享').click(); await flush()
    expect(router.currentRoute.value.path).toBe('/')
    expect(host.querySelector('[data-binding-id]')).toBeNull()
  })
  it('ignores a late preview after source changes and aborts the old request', async () => {
    await mount(); await target()
    const pending = deferred<Response>(); apiFetch.mockImplementationOnce(() => pending.promise)
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush()
    const signal = apiFetch.mock.calls[2][1].signal as AbortSignal
    source.value = 'new-source'; await flush()
    expect(signal.aborted).toBe(true)
    pending.resolve(reply(preview)); await flush()
    expect(host.querySelector('[data-testid="collaboration-preview"]')).toBeNull()
    expect(apiFetch.mock.calls.at(-1)?.[0]).toContain('dataSourceId=new-source')
  })
  it('clears account-specific data and ignores a late confirm after logout', async () => {
    await mount(); await showPreview(); await consent()
    const pending = deferred<Response>(); apiFetch.mockImplementationOnce(() => pending.promise)
    button('确认分享').click(); await flush()
    localStorage.removeItem('auth_token'); notifyAuthPrincipalChange(); await flush()
    expect(close).toHaveBeenCalledOnce()
    pending.resolve(reply(binding, 201)); await flush()
    expect(router.currentRoute.value.path).toBe('/')
    expect(host.querySelector('[data-binding-id]')).toBeNull()
  })
  it('ignores an in-flight result after unmount', async () => {
    const pending = deferred<Response>(); apiFetch.mockImplementationOnce(() => pending.promise)
    await mount(); const signal = apiFetch.mock.calls[0][1].signal as AbortSignal
    app?.unmount(); app = null
    expect(signal.aborted).toBe(true)
    pending.resolve(reply({ items: [] })); await flush()
    expect(router.currentRoute.value.path).toBe('/')
  })
})
