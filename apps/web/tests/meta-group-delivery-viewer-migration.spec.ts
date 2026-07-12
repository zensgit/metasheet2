import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaAutomationGroupDeliveryViewer from '../src/multitable/components/MetaAutomationGroupDeliveryViewer.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaAutomationGroupDeliveryViewer's toolbar Refresh control was migrated from a bespoke <button>
// to the shared MtButton primitive (ghost — it was a neutral bordered-white secondary action). Its class is
// unique, so the bespoke hex CSS was removed. Behavior-preservation proof: it stays a native <button>; the
// :disabled binding survives; clicking it still runs loadData → props.client.getAutomationDingTalkGroupDeliveries.
//
// UI-P2-1c T1 batch-4 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T1, RATIFIED,
// "各 manager header" remainder): the header close-× (`.meta-group-delivery__close`) was additionally
// migrated from a bespoke <button>&times;</button> to the shared MtIconButton primitive — the &times;
// glyph passes through MtIconButton's default-slot icon fallback (glyph char preserved, size
// token-normalized to the icon control). Behavior-preservation proof: it stays a native, keyboard-
// operable <button>, and clicking it still fires the SAME `$emit('close')` (no aria-label existed
// pre-migration — none was invented). This is the only sharer of `.meta-group-delivery__close` — its
// bespoke CSS was removed outright, no double-styling risk. The bespoke `type="button"` attribute was
// dropped (redundant — MtButton's own template already hardcodes `type="button"` on its root native
// <button>).

const flush = () => new Promise((r) => setTimeout(r, 0))
let app: App | null = null; let container: HTMLDivElement | null = null
afterEach(() => {
  app?.unmount(); container?.remove(); app = null; container = null
  expect(document.querySelectorAll('.meta-group-delivery__overlay').length).toBe(0) // residue guard
  useLocale().setLocale('en')
})

function mount(client: Record<string, unknown>, extraProps: Record<string, unknown> = {}) {
  container = document.createElement('div'); document.body.appendChild(container)
  app = createApp({ render: () => h(MetaAutomationGroupDeliveryViewer, { visible: true, sheetId: 's1', ruleId: 'r1', client, ...extraProps }) })
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

describe('MetaAutomationGroupDeliveryViewer — close-× MtIconButton migration (UI-P2-1c T1 batch-4)', () => {
  it('renders the header close-× as a native <button> (MtIconButton) keeping the class + glyph', async () => {
    mount({ getAutomationDingTalkGroupDeliveries: vi.fn().mockResolvedValue([]) })
    await flush()
    const btn = container!.querySelector('.meta-group-delivery__close') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-group-delivery__close')).toBe(true)
    expect(btn.textContent?.trim()).toBe('×') // × glyph char preserved (size token-normalized)
  })

  it('clicking the header close-× emits `close` (unchanged — same $emit(\'close\'))', async () => {
    const onClose = vi.fn()
    mount({ getAutomationDingTalkGroupDeliveries: vi.fn().mockResolvedValue([]) }, { onClose })
    await flush()
    const btn = container!.querySelector('.meta-group-delivery__close') as HTMLButtonElement
    btn.click()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith()
  })
})
