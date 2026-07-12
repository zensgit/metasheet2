import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import RestoreBatchDialog from '../src/multitable/components/RestoreBatchDialog.vue'
import type { RestoreBatchPreviewRecord, RestoreBatchExecuteRecord } from '../src/multitable/api/client'

// UI-P2-1c: RestoreBatchDialog's three footer action controls — Cancel (ghost), Confirm (primary)
// and Done (primary) — were migrated from bespoke <button>s to the shared MtButton primitive.
// Behavior-preservation proof: they stay native, keyboard-operable <button>s; the `:disabled="!canConfirm"`
// binding still reflects onto the DOM; and clicking them still emits the SAME `cancel` / `confirm` / `done`
// events. The Advanced disclosure toggle stays bespoke (not migrated). The dialog
// Teleports to <body>, so queries hit `document`, not the mount container. `isZh` is a prop (no useLocale).
//
// UI-P2-1c T1 batch-4 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T1, RATIFIED): the
// header close-× (`.restore-batch__close`) was additionally migrated from a bespoke <button>&times;</button>
// to the shared MtIconButton primitive — the &times; glyph passes through MtIconButton's default-slot icon
// fallback (glyph char preserved, size token-normalized to the icon control, consistent with the existing
// glyph-MtIconButton controls already on main). Behavior-preservation proof: it stays a native,
// keyboard-operable <button>, keeps the SAME aria-label (`l('record.batchRestoreCancel')`), and clicking it
// still calls the SAME onCancel() → emits the SAME `cancel` event (identical to the footer Cancel button's
// handler). This is the only sharer of `.restore-batch__close` (single button, single file) — its bespoke
// CSS was removed outright, no double-styling risk. The footer Confirm/Done buttons were NOT touched by
// this migration — see the pre-existing tests below (kept as the positive control).

type Props = {
  visible: boolean; phase: 'preview' | 'result'; loading: boolean; targetVersion: number
  previewRecords: RestoreBatchPreviewRecord[]; restorableCount: number; skippedCount: number; executable: boolean
  resultRecords: RestoreBatchExecuteRecord[]; restoredCount: number
  recordLabelOf: (id: string) => string; isZh: boolean
  onPreviewVersion: (v: number) => void; onConfirm: () => void; onCancel: () => void; onDone: () => void
}

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.restore-batch-overlay').length).toBe(0) // teleport residue guard
})

function mount(overrides: Partial<Props>): Props {
  const props: Props = {
    visible: true, phase: 'preview', loading: false, targetVersion: 1,
    previewRecords: [], restorableCount: 0, skippedCount: 0, executable: false,
    resultRecords: [], restoredCount: 0, recordLabelOf: (id) => `rec:${id}`, isZh: false,
    onPreviewVersion: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(), onDone: vi.fn(), ...overrides,
  }
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp(RestoreBatchDialog, props as unknown as Record<string, unknown>)
  app.mount(container)
  mounts.push({ app, container })
  return props
}

// preview props with an executable, non-empty restorable set → confirm is enabled.
const executablePreview = (): Partial<Props> => ({
  executable: true, restorableCount: 1, skippedCount: 0,
  previewRecords: [{ recordId: 'A', status: 'restorable', previewVersion: 2 }],
})

const cancelBtn = () => document.querySelectorAll('.restore-batch__btn')[0] as HTMLButtonElement
const confirmBtn = () => document.querySelector('[data-test="batch-restore-confirm"]') as HTMLButtonElement
const doneBtn = () => document.querySelector('[data-test="batch-restore-done"]') as HTMLButtonElement

describe('RestoreBatchDialog — MtButton migration (UI-P2-1c)', () => {
  it('preview footer renders Cancel + Confirm as native <button>s (keyboard-operable, not divs)', () => {
    mount(executablePreview())
    const btns = Array.from(document.querySelectorAll('.restore-batch__btn')) as HTMLElement[]
    expect(btns.length).toBe(2)
    expect(btns.every((b) => b.tagName === 'BUTTON')).toBe(true)
    expect(cancelBtn().tagName).toBe('BUTTON')
    expect(confirmBtn().tagName).toBe('BUTTON')
  })

  it('Confirm reflects :disabled="!canConfirm" — blocked when restorableCount===0, enabled when executable & >0', async () => {
    mount({ executable: false, restorableCount: 0, previewRecords: [{ recordId: 'A', status: 'skipped', skipReason: 'unavailable' }] })
    await nextTick()
    expect(confirmBtn().disabled).toBe(true) // !canConfirm → disabled attribute reflects onto the native button

    mounts.pop()!.app.unmount(); document.body.innerHTML = ''
    mount(executablePreview())
    await nextTick()
    expect(confirmBtn().disabled).toBe(false)
  })

  it('clicking Cancel emits `cancel` (proves the @click handler survived migration)', () => {
    const props = mount(executablePreview())
    cancelBtn().click()
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('clicking the enabled Confirm emits `confirm` (same handler, same payload — none)', async () => {
    const props = mount(executablePreview())
    await nextTick()
    expect(confirmBtn().disabled).toBe(false) // precondition driven so the click actually fires
    confirmBtn().click()
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('result phase: clicking Done emits `done` (proves the @click handler survived migration)', async () => {
    const props = mount({
      phase: 'result', restoredCount: 1, skippedCount: 0,
      resultRecords: [{ recordId: 'A', status: 'restored', newVersion: 3 }],
    })
    await nextTick()
    expect(doneBtn().tagName).toBe('BUTTON')
    doneBtn().click()
    expect(props.onDone).toHaveBeenCalledTimes(1)
  })

  it('renders the header close-× as a native <button> (MtIconButton) keeping the class + aria-label + glyph', () => {
    mount(executablePreview())
    const btn = document.querySelector('.restore-batch__close') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('restore-batch__close')).toBe(true)
    expect(btn.getAttribute('aria-label')).toBe('Cancel')
    expect(btn.textContent?.trim()).toBe('×') // × glyph char preserved (size token-normalized)
  })

  it('clicking the header close-× emits `cancel` (unchanged — same onCancel as the footer Cancel button)', () => {
    const props = mount(executablePreview())
    const btn = document.querySelector('.restore-batch__close') as HTMLButtonElement
    btn.click()
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })
})
