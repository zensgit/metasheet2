import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import { createApp,nextTick,type App } from 'vue'
import PlmBomCompletionWebhookConfig from '../src/components/plm/PlmBomCompletionWebhookConfig.vue'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('../src/utils/api', () => ({ apiFetch }))
const webhooks = { reviewCompleted: { enabled: true,webhookId: 'review',granularity: 'row' },plmChangeApplied: { enabled: true,webhookId: 'plm',source: 'bom_line_writeback' } }
const reply = (data: unknown) => new Response(JSON.stringify({ ok: true,data }))
const deny = (code: string,status: number) => new Response(JSON.stringify({ ok: false,error: { code } }),{ status })
let app: App | undefined,host: HTMLDivElement
const close = vi.fn()
async function flush() { for (let i=0;i<35;i++) { await Promise.resolve(); await nextTick() } }
async function mount(config: unknown = { version: 1,webhooks },targets: Response = reply([{ id: 'review',name: 'ERP review' },{ id: 'plm',name: 'MES change' }])) {
  apiFetch.mockResolvedValueOnce(reply(config)).mockResolvedValueOnce(targets)
  app = createApp(PlmBomCompletionWebhookConfig,{ bindingId: 'binding',onClose: close }); app.mount(host); await flush()
}
async function check(key: string,value: boolean) {
  const el = host.querySelector<HTMLInputElement>(`[data-testid=${key}-enabled]`)!
  el.checked = value; el.dispatchEvent(new Event('change',{ bubbles: true })); await flush()
}
async function save() { host.querySelector('form')!.dispatchEvent(new Event('submit',{ bubbles: true,cancelable: true })); await flush() }
beforeEach(() => { app = undefined; apiFetch.mockReset(); close.mockReset(); localStorage.setItem('auth_token','account-a'); host = document.createElement('div'); document.body.append(host) })
afterEach(() => { app?.unmount(); host.remove(); localStorage.clear() })
describe('BOM completion event selection', () => {
  it('leaves legacy trigger modes unselected and requires explicit choices',async () => {
    await mount({ version: 1,webhooks: { reviewCompleted: { enabled: true,webhookId: 'review' },
      plmChangeApplied: { enabled: true,webhookId: 'plm' } } })
    expect(host.querySelector<HTMLButtonElement>('[data-testid=save-completion]')!.disabled).toBe(true)
    for (const [testId,value] of [['reviewCompleted-granularity','bom'],['plmChangeApplied-source','eco_batch_apply']]) {
      const select = host.querySelector<HTMLSelectElement>(`[data-testid=${testId}]`)!
      expect(select.selectedIndex).toBe(0)
      select.value = value; select.dispatchEvent(new Event('change',{ bubbles: true })); await flush()
    }
    const selected = { reviewCompleted: { enabled: true,webhookId: 'review',granularity: 'bom' },
      plmChangeApplied: { enabled: true,webhookId: 'plm',source: 'eco_batch_apply' } }
    apiFetch.mockResolvedValueOnce(reply({ version: 2,webhooks: selected })); await save()
    expect(JSON.parse(apiFetch.mock.calls[2][1].body as string).webhooks).toEqual(selected)
  })
  it('saves independent targets and labels local completion separately from PLM success',async () => {
    await mount()
    expect(host.textContent).toContain('bom.review.completed'); expect(host.textContent).toContain('bom.plm_change.applied')
    expect(host.textContent).toContain('来源负责人显式开启事件监听')
    expect(host.textContent).toContain('不补发历史')
    await check('reviewCompleted',false)
    const changed = { ...webhooks,reviewCompleted: { enabled: false,webhookId: 'review',granularity: 'row' } }
    apiFetch.mockResolvedValueOnce(reply({ version: 2,webhooks: changed })); await save()
    expect(JSON.parse(apiFetch.mock.calls[2][1].body as string)).toEqual({ expectedVersion: 1,webhooks: changed })
    expect(host.textContent).toContain('完成规则已保存')
  })
  it('never chooses a default destination for a new enabled rule',async () => {
    await mount({ version: 0,webhooks: null }); await check('reviewCompleted',true)
    expect(host.querySelector<HTMLSelectElement>('[data-testid=reviewCompleted-target]')!.selectedOptions[0].textContent).toBe('请选择已有 Webhook')
    expect(host.querySelector<HTMLButtonElement>('[data-testid=save-completion]')!.disabled).toBe(true)
    const select = host.querySelector<HTMLSelectElement>('[data-testid=reviewCompleted-target]')!
    select.value = 'review'; select.dispatchEvent(new Event('change',{ bubbles: true })); await flush()
    expect(host.querySelector<HTMLButtonElement>('[data-testid=save-completion]')!.disabled).toBe(true)
    const mode = host.querySelector<HTMLSelectElement>('[data-testid=reviewCompleted-granularity]')!
    mode.value = 'bom'; mode.dispatchEvent(new Event('change',{ bubbles: true })); await flush()
    expect(host.querySelector<HTMLButtonElement>('[data-testid=save-completion]')!.disabled).toBe(false)
  })
  it('allows explicit shutdown when send permission is revoked, without substituting another target',async () => {
    await mount({ version: 1,webhooks },deny('WEBHOOK_SEND_FORBIDDEN',403))
    expect(host.textContent).toContain('仍可停用已有规则')
    expect(host.querySelector<HTMLButtonElement>('[data-testid=save-completion]')!.disabled).toBe(true)
    await check('reviewCompleted',false); await check('plmChangeApplied',false)
    const off = { reviewCompleted: { enabled: false,webhookId: 'review',granularity: 'row' },plmChangeApplied: { enabled: false,webhookId: 'plm',source: 'bom_line_writeback' } }
    apiFetch.mockResolvedValueOnce(reply({ version: 2,webhooks: off })); await save()
    expect(JSON.parse(apiFetch.mock.calls[2][1].body as string).webhooks).toEqual(off)
  })
  it('retains the draft on CAS conflict and never retries automatically',async () => {
    await mount(); await check('reviewCompleted',false)
    apiFetch.mockResolvedValueOnce(deny('VERSION_CONFLICT',409)); await save(); await flush()
    expect(apiFetch).toHaveBeenCalledTimes(3)
    expect(host.querySelector<HTMLInputElement>('[data-testid=reviewCompleted-enabled]')!.checked).toBe(false)
    expect(host.textContent).toContain('重新加载后重试')
  })
  it('clears all source metadata on management permission loss',async () => {
    await mount(); apiFetch.mockResolvedValueOnce(deny('FORBIDDEN',403)); await save()
    expect(host.textContent).not.toContain('ERP review'); expect(host.textContent).toContain('当前账号无权')
    expect(host.querySelector<HTMLButtonElement>('[data-testid=save-completion]')!.disabled).toBe(true)
  })
  it('does not retain loaded targets when management permission is lost during destination loading',async () => {
    await mount({ version: 1,webhooks },deny('FORBIDDEN',403))
    expect(host.textContent).not.toContain('ERP review')
    expect(host.querySelector<HTMLButtonElement>('[data-testid=save-completion]')!.disabled).toBe(true)
    expect(host.querySelector<HTMLInputElement>('[data-testid=reviewCompleted-enabled]')!.checked).toBe(false)
  })
  it('ignores a late save after switching accounts',async () => {
    await mount()
    let resolve!: (v: Response) => void
    apiFetch.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r }))
    await save(); localStorage.removeItem('auth_token'); notifyAuthPrincipalChange(); await flush()
    resolve(reply({ version: 2,webhooks })); await flush()
    expect(close).toHaveBeenCalledOnce(); expect(host.textContent).not.toContain('完成规则已保存')
    expect(host.querySelector<HTMLButtonElement>('[data-testid=save-completion]')!.disabled).toBe(true)
  })
})
