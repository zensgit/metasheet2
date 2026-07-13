// UI-P2-1c batch4: MetaAutomationLogViewer's Refresh, Retry, and both support-packet (copy/download)
// controls were migrated from bespoke <button>s to the shared MtButton primitive (all ghost — same family
// as the MERGED GDV/PDV Refresh migrations #3869/#3870; Refresh was already a neutral bordered-white
// secondary action, Retry's pink/red accent and the support buttons' smaller padding/font-size were both
// dropped in favor of MtButton's uniform styling, the same sanctioned normalization already applied to
// MetaChartLoadError's retry control #3823). Behavior-preservation proof: each stays a native <button>,
// keeps its data-action attribute, and clicking it still runs the SAME handler (loadData /
// copySupportPacket / downloadSupportPacket) — including the copy/download buttons' `.stop` modifier, which
// still works because MtButton re-emits the real native MouseEvent.
//
// UI-P2-1c T1 batch-4 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T1, RATIFIED,
// "各 manager header" remainder): the header close-× (`.meta-log-viewer__close`) was additionally
// migrated from a bespoke <button>&times;</button> to the shared MtIconButton primitive — the &times;
// glyph passes through MtIconButton's default-slot icon fallback (glyph char preserved, size
// token-normalized to the icon control). Behavior-preservation proof: it stays a native, keyboard-
// operable <button>, and clicking it still fires the SAME `$emit('close')` (no aria-label existed
// pre-migration — none was invented). This is the only sharer of `.meta-log-viewer__close` — its
// bespoke CSS was removed outright, no double-styling risk. The bespoke `type="button"` attribute
// was dropped (redundant — MtButton's own template already hardcodes `type="button"` on its root
// native <button>, so the DOM type stays "button" either way).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

import MetaAutomationLogViewer from '../src/multitable/components/MetaAutomationLogViewer.vue'
import type { AutomationExecution, AutomationStats } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

interface MockClientOptions {
  logs?: AutomationExecution[]
  stats?: AutomationStats
  logsError?: Error
}

function makeMockClient(options: MockClientOptions = {}) {
  const defaultStats: AutomationStats = { total: 1, success: 1, failed: 0, skipped: 0, avgDuration: 32 }
  return {
    getAutomationLogs: vi.fn(async (_sheetId: string, _ruleId: string, _limit?: number) => {
      if (options.logsError) throw options.logsError
      return options.logs ?? []
    }),
    getAutomationStats: vi.fn(async (_sheetId: string, _ruleId: string) => options.stats ?? defaultStats),
  }
}

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaAutomationLogViewer, props) })
  app.mount(container)
  return { container, app }
}

const PASS_EXECUTION: AutomationExecution = {
  id: 'exec-pass', ruleId: 'rule-1', status: 'success', triggeredBy: 'event',
  triggeredAt: '2026-05-15T10:00:00Z', duration: 42,
  steps: [{ actionType: 'send_email', status: 'success', durationMs: 30, output: { ok: true } }],
}

let mounted: { container: HTMLDivElement; app: ReturnType<typeof createApp> } | null = null

beforeEach(() => { mounted = null })
afterEach(() => {
  if (mounted) { mounted.app.unmount(); mounted.container.remove(); mounted = null }
  useLocale().setLocale('en')
})

describe('MetaAutomationLogViewer — MtButton migration (UI-P2-1c batch4)', () => {
  it('renders Refresh, Retry, and both support-packet controls as native <button>s (MtButton)', async () => {
    const client = makeMockClient({ logsError: new Error('boom'), logs: [PASS_EXECUTION] })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    expect(mounted.container.querySelector('[data-action="refresh"]')!.tagName).toBe('BUTTON')
    expect(mounted.container.querySelector('[data-action="retry"]')!.tagName).toBe('BUTTON')
  })

  it('clicking Refresh re-runs loadData → client.getAutomationLogs/getAutomationStats (@click unchanged)', async () => {
    const client = makeMockClient({ logs: [PASS_EXECUTION] })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises() // the on-show watch already called it once
    client.getAutomationLogs.mockClear(); client.getAutomationStats.mockClear()

    ;(mounted.container.querySelector('[data-action="refresh"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(client.getAutomationLogs).toHaveBeenCalledTimes(1)
    expect(client.getAutomationLogs).toHaveBeenCalledWith('s', 'rule-1', 50)
    expect(client.getAutomationStats).toHaveBeenCalledTimes(1)
    expect(client.getAutomationStats).toHaveBeenCalledWith('s', 'rule-1')
  })

  it('clicking Retry (in the error alert) re-runs loadData → the same client calls (@click unchanged)', async () => {
    const client = makeMockClient({ logsError: new Error('Network unreachable') })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    expect(mounted.container.querySelector('[data-error="true"]')).not.toBeNull()
    client.getAutomationLogs.mockClear()

    ;(mounted.container.querySelector('[data-action="retry"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(client.getAutomationLogs).toHaveBeenCalledTimes(1)
    expect(client.getAutomationLogs).toHaveBeenCalledWith('s', 'rule-1', 50)
  })

  it('clicking copy-support-packet still calls copySupportPacket (writeText) — @click.stop survives the MtButton re-emit', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const client = makeMockClient({ logs: [PASS_EXECUTION] })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()

    const item = mounted.container.querySelector('[data-log-id="exec-pass"]') as HTMLElement
    item.click() // expand
    await nextTick()

    const copyBtn = item.querySelector('[data-action="copy-support-packet"]') as HTMLButtonElement
    expect(copyBtn.tagName).toBe('BUTTON')
    copyBtn.click()
    await flushPromises()

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(item.querySelector('[data-field="support-packet-status"]')).not.toBeNull()
    // .stop must have prevented this click from also bubbling to the log-item's own @click="toggleExpand" —
    // clicking the button must NOT collapse the row.
    expect(item.querySelector('[data-detail="true"]')).not.toBeNull()
  })

  it('clicking download-support-packet still calls downloadSupportPacket (anchor download) — @click.stop survives the MtButton re-emit', async () => {
    // jsdom doesn't implement URL.createObjectURL/revokeObjectURL — stub both so downloadSupportPacket's
    // real code path (create blob URL -> synthetic <a download> click -> revoke) runs to completion, same
    // as it would in a real browser; this is an environment shim, not a change to the component under test.
    const createObjectURL = vi.fn(() => 'blob:mock-url')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const client = makeMockClient({ logs: [PASS_EXECUTION] })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()

    const item = mounted.container.querySelector('[data-log-id="exec-pass"]') as HTMLElement
    item.click() // expand
    await nextTick()

    const downloadBtn = item.querySelector('[data-action="download-support-packet"]') as HTMLButtonElement
    expect(downloadBtn.tagName).toBe('BUTTON')
    downloadBtn.click()
    await flushPromises()

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1) // downloadSupportPacket() created + clicked the <a download>
    expect(item.querySelector('[data-field="support-packet-status"]')).not.toBeNull()
    // .stop must have prevented this click from also bubbling to the log-item's own @click="toggleExpand".
    expect(item.querySelector('[data-detail="true"]')).not.toBeNull()

    clickSpy.mockRestore()
  })
})

describe('MetaAutomationLogViewer — close-× MtIconButton migration (UI-P2-1c T1 batch-4)', () => {
  it('renders the header close-× as a native <button> (MtIconButton) keeping the class + glyph', async () => {
    const client = makeMockClient()
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    const btn = mounted.container.querySelector('.meta-log-viewer__close') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-log-viewer__close')).toBe(true)
    expect(btn.textContent?.trim()).toBe('×') // × glyph char preserved (size token-normalized)
  })

  it('clicking the header close-× emits `close` (unchanged — same $emit(\'close\'))', async () => {
    const client = makeMockClient()
    const onClose = vi.fn()
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client, onClose })
    await flushPromises()
    const btn = mounted.container.querySelector('.meta-log-viewer__close') as HTMLButtonElement
    btn.click()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith()
  })
})
