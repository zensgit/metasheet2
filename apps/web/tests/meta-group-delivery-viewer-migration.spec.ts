import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaAutomationGroupDeliveryViewer from '../src/multitable/components/MetaAutomationGroupDeliveryViewer.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaAutomationGroupDeliveryViewer's toolbar Refresh control was migrated from a bespoke <button>
// to the shared MtButton primitive (ghost — it was a neutral bordered-white secondary action). Its class is
// unique, so the bespoke hex CSS was removed. Behavior-preservation proof: it stays a native <button>; the
// :disabled binding survives; clicking it still runs loadData → props.client.getAutomationDingTalkGroupDeliveries.
// The header close-× glyph stays bespoke.

const flush = () => new Promise((r) => setTimeout(r, 0))
let app: App | null = null; let container: HTMLDivElement | null = null
afterEach(() => {
  app?.unmount(); container?.remove(); app = null; container = null
  expect(document.querySelectorAll('.meta-group-delivery__overlay').length).toBe(0) // residue guard
  useLocale().setLocale('en')
})

function mount(client: Record<string, unknown>) {
  container = document.createElement('div'); document.body.appendChild(container)
  app = createApp({ render: () => h(MetaAutomationGroupDeliveryViewer, { visible: true, sheetId: 's1', ruleId: 'r1', client }) })
  app.mount(container)
}
const refreshBtn = () => container!.querySelector('[data-action="refresh"]') as HTMLButtonElement

describe('MetaAutomationGroupDeliveryViewer — MtButton migration (UI-P2-1c)', () => {
  it('renders Refresh as a native <button> (MtButton)', async () => {
    mount({ getAutomationDingTalkGroupDeliveries: vi.fn().mockResolvedValue([]) })
    await flush()
    expect(refreshBtn().tagName).toBe('BUTTON') // keyboard-operable, not a bare div
  })

  it('clicking Refresh re-runs loadData → client.getAutomationDingTalkGroupDeliveries (@click unchanged)', async () => {
    const get = vi.fn().mockResolvedValue([])
    mount({ getAutomationDingTalkGroupDeliveries: get })
    await flush() // the on-show watch already called it once
    get.mockClear()
    refreshBtn().click()
    await flush()
    expect(get).toHaveBeenCalledTimes(1) // the click, post-clear
    expect(get).toHaveBeenCalledWith('s1', 'r1', 50)
  })
})
