import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaAutomationPersonDeliveryViewer from '../src/multitable/components/MetaAutomationPersonDeliveryViewer.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaAutomationPersonDeliveryViewer's toolbar Refresh control was migrated from a bespoke <button>
// to the shared MtButton primitive (ghost — neutral bordered-white secondary). Unique class → bespoke hex CSS
// removed. Behavior-preservation proof: native <button>; :disabled survives; clicking still runs loadData →
// props.client.getAutomationDingTalkPersonDeliveries. The header close-× glyph stays bespoke.

const flush = () => new Promise((r) => setTimeout(r, 0))
let app: App | null = null; let container: HTMLDivElement | null = null
afterEach(() => {
  app?.unmount(); container?.remove(); app = null; container = null
  expect(document.querySelectorAll('.meta-person-delivery__overlay').length).toBe(0) // residue guard
  useLocale().setLocale('en')
})

function mount(client: Record<string, unknown>) {
  container = document.createElement('div'); document.body.appendChild(container)
  app = createApp({ render: () => h(MetaAutomationPersonDeliveryViewer, { visible: true, sheetId: 's1', ruleId: 'r1', client }) })
  app.mount(container)
}
const refreshBtn = () => container!.querySelector('[data-action="refresh"]') as HTMLButtonElement

describe('MetaAutomationPersonDeliveryViewer — MtButton migration (UI-P2-1c)', () => {
  it('renders Refresh as a native <button> (MtButton)', async () => {
    mount({ getAutomationDingTalkPersonDeliveries: vi.fn().mockResolvedValue([]) })
    await flush()
    expect(refreshBtn().tagName).toBe('BUTTON') // keyboard-operable
  })

  it('clicking Refresh re-runs loadData → client.getAutomationDingTalkPersonDeliveries (@click unchanged)', async () => {
    const get = vi.fn().mockResolvedValue([])
    mount({ getAutomationDingTalkPersonDeliveries: get })
    await flush()
    get.mockClear()
    refreshBtn().click()
    await flush()
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('s1', 'r1', 50)
  })

  it('PR #4046 Phase B: an outcome_unknown delivery renders its own badge + reason (not folded into failed) and the filter offers the state', async () => {
    const delivery = {
      id: 'd1',
      localUserId: 'u1',
      dingtalkUserId: 'dd1',
      sourceType: 'automation',
      subject: 'S',
      content: 'C',
      success: false,
      status: 'outcome_unknown',
      errorMessage: 'dingtalk_send_outcome_unknown: fetch failed',
      createdAt: new Date().toISOString(),
      localUserIsActive: true,
    }
    mount({ getAutomationDingTalkPersonDeliveries: vi.fn().mockResolvedValue([delivery]) })
    await flush()
    const badge = container!.querySelector('.meta-person-delivery__badge') as HTMLElement
    expect(badge.getAttribute('data-status')).toBe('outcome_unknown')
    expect(badge.textContent?.trim()).toBe('outcome unknown') // en locale label, NOT 'failed'
    // the send-uncertainty reason stays visible (status !== success renders the error line)
    expect(container!.querySelector('.meta-person-delivery__error')?.textContent).toContain('outcome_unknown')
    // admin-side list filter: the new state is selectable, not silently excluded by the IN-list
    const options = Array.from(container!.querySelectorAll('[data-field="statusFilter"] option')).map((o) => (o as HTMLOptionElement).value)
    expect(options).toContain('outcome_unknown')
  })
})
