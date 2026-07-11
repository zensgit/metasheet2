import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import ResetToPointPicker from '../src/multitable/components/ResetToPointPicker.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: ResetToPointPicker's Refresh control was migrated from a bespoke <button> to the shared
// MtButton primitive (ghost). Its class `reset-picker__refresh` is unique, so the bespoke hex CSS was
// removed. Behavior-preservation proof: it stays a native, keyboard-operable <button>; the :disabled
// binding survives; clicking it still runs loadHistoryBatches → props.listHistoryEvents (same handler).

const flush = () => new Promise((r) => setTimeout(r, 0))

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.reset-picker').length).toBe(0) // residue guard
  useLocale().setLocale('en')
})

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(ResetToPointPicker, props) })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

const enablingProps = (listHistoryEvents: unknown) => ({
  pitResetEnabled: true,
  baseId: 'b1',
  sheetId: 's1',
  listHistoryEvents,
  resetPreview: vi.fn(),
  resetExecute: vi.fn(),
})
const refreshBtn = (r: HTMLElement) => r.querySelector('[data-test="reset-picker-history-refresh"]') as HTMLButtonElement

describe('ResetToPointPicker — MtButton migration (UI-P2-1c)', () => {
  it('renders Refresh as a native <button> and enables it once history can load', async () => {
    const listHistoryEvents = vi.fn().mockResolvedValue({ batches: [] })
    const root = mount(enablingProps(listHistoryEvents))
    await flush()
    const btn = refreshBtn(root)
    expect(btn).toBeTruthy()
    expect(btn.tagName).toBe('BUTTON') // keyboard-operable, not a bare div
    expect(btn.disabled).toBe(false) // :disabled="historyLoading || !canLoadHistory" — enabled after load settles
  })

  it('clicking Refresh re-runs loadHistoryBatches → props.listHistoryEvents (handler unchanged)', async () => {
    const listHistoryEvents = vi.fn().mockResolvedValue({ batches: [] })
    const root = mount(enablingProps(listHistoryEvents))
    await flush() // the immediate watch already called it once on mount
    listHistoryEvents.mockClear()
    refreshBtn(root).click()
    await flush()
    expect(listHistoryEvents).toHaveBeenCalledTimes(1) // the click, post-clear
    expect(listHistoryEvents).toHaveBeenCalledWith('b1', expect.objectContaining({ sheetId: 's1' }))
  })
})
