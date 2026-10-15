import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import PlmBomNotificationConfig from '../src/components/plm/PlmBomNotificationConfig.vue'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('../src/utils/api', () => ({ apiFetch }))
const path = '/api/plm-bom-reviews/binding/notifications'
const notifications = {
  issue: { enabled: true, recipientStrategy: 'event_owner' },
  reminder: { enabled: false, recipientStrategy: null, leadMinutes: null },
  escalation: { enabled: false, slaMinutes: null, recipientUserIds: [] },
}
const reply = (data: unknown) => new Response(JSON.stringify({ ok: true, data }))
let app: App | undefined, host: HTMLDivElement
const close = vi.fn()
async function flush() { for (let i=0;i<35;i++) { await Promise.resolve(); await nextTick() } }
async function mount() { app = createApp(PlmBomNotificationConfig,{ bindingId: 'binding', onClose: close }); app.mount(host); await flush() }
async function input(selector: string, value: string | boolean) {
  const el = host.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!
  if (typeof value === 'boolean') (el as HTMLInputElement).checked = value
  else el.value = value
  el.dispatchEvent(new Event(el.tagName === 'SELECT' || typeof value === 'boolean' ? 'change' : 'input',{ bubbles: true })); await flush()
}
beforeEach(() => {
  app = undefined; close.mockReset(); apiFetch.mockReset(); localStorage.setItem('auth_token','account-a')
  host = document.createElement('div'); document.body.appendChild(host)
  apiFetch.mockResolvedValue(reply({ version: 0, notifications: null }))
})
afterEach(() => { app?.unmount(); host.remove(); localStorage.clear() })
describe('BOM notification configuration', () => {
  it('starts disabled with no timing defaults and requires an explicit enabled-rule strategy', async () => {
    await mount()
    expect(apiFetch).toHaveBeenCalledTimes(1)
    await input('[data-testid=issue-enabled]',true)
    expect(host.querySelector<HTMLButtonElement>('[data-testid=save-notifications]')!.disabled).toBe(true)
    await input('[data-testid=issue-strategy]','event_owner')
    apiFetch.mockResolvedValueOnce(reply({ version: 1, notifications }))
    host.querySelector('form')!.dispatchEvent(new Event('submit',{ bubbles: true, cancelable: true })); await flush()
    expect(apiFetch.mock.calls[1][0]).toBe(path)
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toEqual({ expectedVersion: 0, notifications })
    expect(host.textContent).toContain('规则已保存；后台任务启用后按规则处理站内通知')
  })
  it('requires positive SLA and an explicitly searched recipient without silently granting access', async () => {
    await mount(); await input('[data-testid=escalation-enabled]',true)
    await input('[data-testid=sla-minutes]','0')
    expect(host.querySelector<HTMLButtonElement>('[data-testid=save-notifications]')!.disabled).toBe(true)
    await input('[data-testid=sla-minutes]','30'); await input('[data-testid=recipient-search]','Reviewer')
    apiFetch.mockResolvedValueOnce(reply({ items: [{ id: 'reader',name: 'Reviewer' }] }))
    Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '搜索')!.click(); await flush()
    Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Reviewer · 选择'))!.click(); await flush()
    expect(host.querySelector<HTMLButtonElement>('[data-testid=save-notifications]')!.disabled).toBe(false)
    expect(host.textContent).toContain('选择不会授予权限')
    expect(apiFetch.mock.calls[1][0]).toContain('notification-recipients?q=Reviewer')
  })
  it('does not reapply a late save after an account switch', async () => {
    apiFetch.mockResolvedValueOnce(reply({ version: 1, notifications })); await mount()
    let resolve!: (value: Response) => void
    apiFetch.mockImplementationOnce(() => new Promise<Response>((r) => { resolve = r }))
    host.querySelector('form')!.dispatchEvent(new Event('submit',{ bubbles: true, cancelable: true })); await flush()
    localStorage.removeItem('auth_token'); notifyAuthPrincipalChange(); await flush()
    resolve(reply({ version: 2, notifications })); await flush()
    expect(close).toHaveBeenCalledOnce()
    expect(host.textContent).not.toContain('规则已保存')
    expect(host.querySelector<HTMLButtonElement>('[data-testid=save-notifications]')!.disabled).toBe(true)
  })
  it('clears configuration on permission loss', async () => {
    apiFetch.mockResolvedValueOnce(reply({ version: 1, notifications })); await mount()
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false,error: { code: 'FORBIDDEN' } }),{ status: 403 }))
    host.querySelector('form')!.dispatchEvent(new Event('submit',{ bubbles: true, cancelable: true })); await flush()
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(host.querySelector<HTMLButtonElement>('[data-testid=save-notifications]')!.disabled).toBe(true)
    expect(host.querySelector<HTMLInputElement>('[data-testid=issue-enabled]')!.checked).toBe(false)
  })
  it('preserves edits on a version conflict and requires manual reload', async () => {
    apiFetch.mockResolvedValueOnce(reply({ version: 1, notifications })); await mount()
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false,error: { code: 'VERSION_CONFLICT' } }),{ status: 409 }))
    host.querySelector('form')!.dispatchEvent(new Event('submit',{ bubbles: true, cancelable: true })); await flush()
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('请重新加载配置后重试')
    expect(host.querySelector<HTMLInputElement>('[data-testid=issue-enabled]')!.checked).toBe(true)
  })
})
