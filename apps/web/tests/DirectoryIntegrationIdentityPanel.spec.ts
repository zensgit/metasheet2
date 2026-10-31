import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import Panel from '../src/components/directory/DirectoryIntegrationIdentityPanel.vue'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('../src/utils/api', () => ({ apiFetch }))
const integration = { id: 'synthetic-integration', corpId: 'synthetic-corp', config: { appKey: 'synthetic-app' } }
const props = () => ({ integration, corpName: '合成企业', appName: '合成应用', configurationChanged: false })
let container: HTMLDivElement
let app: ReturnType<typeof createApp>
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
function fill(testId: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!
  input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }))
}
beforeEach(() => { apiFetch.mockReset(); container = document.createElement('div'); document.body.append(container) })
afterEach(() => { app?.unmount(); container.remove() })

describe('administrator identity confirmation', () => {
  it('makes no writes on mount and saves only names unless confirmation is explicit', async () => {
    app = createApp(Panel, props()); app.mount(container); await flush()
    expect(apiFetch).not.toHaveBeenCalled()
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { integration } }) })
    container.querySelector('button')!.click(); await flush()
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch.mock.calls[0][0]).toBe('/api/admin/directory/integrations/synthetic-integration/identity')
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ corpId: integration.corpId, appKey: integration.config.appKey, corpName: '合成企业', appName: '合成应用', confirm: false })
  })

  it('requires independent owner fields and explicit confirmation, without supplying attribution', async () => {
    app = createApp(Panel, props()); app.mount(container); await flush()
    const check = container.querySelector<HTMLInputElement>('[data-testid="identity-confirm"]')!
    check.click(); await flush()
    expect(container.querySelector('button')!.disabled).toBe(true)
    fill('identity-owner-id', 'other-synthetic-corp'); fill('identity-owner-name', '另一个合成企业'); await flush()
    expect(check.checked).toBe(false)
    check.click(); await flush()
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { integration } }) })
    container.querySelector('button')!.click(); await flush()
    const body = JSON.parse(apiFetch.mock.calls[0][1].body)
    expect(body).toMatchObject({ confirm: true, appCorpId: 'other-synthetic-corp', appCorpName: '另一个合成企业' })
    expect(body).not.toHaveProperty('checkedBy'); expect(body).not.toHaveProperty('checkedAt')
    expect(body).not.toHaveProperty('syncEnabled'); expect(body).not.toHaveProperty('appSecret')
  })

  it('blocks metadata confirmation while credential edits are unsaved', async () => {
    app = createApp(Panel, { ...props(), configurationChanged: true }); app.mount(container); await flush()
    expect(container.querySelector('button')!.disabled).toBe(true)
    container.querySelector('button')!.click(); await flush()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('reports a conflict without automatic retry', async () => {
    app = createApp(Panel, props()); app.mount(container); await flush()
    apiFetch.mockResolvedValue({ ok: false, status: 409 })
    container.querySelector('button')!.click(); await flush()
    expect(container.textContent).toContain('身份配置已变化')
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })
})
