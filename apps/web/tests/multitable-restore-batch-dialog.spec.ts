// @vitest-environment jsdom
/**
 * BS-4 — RestoreBatchDialog + the wire-drift guard. The dialog is the per-record batch-restore panel (preview →
 * confirm → result). The load-bearing safety is twofold: `canConfirm` (only an executable, non-empty restorable
 * set commits) and `buildBatchExpectedVersions` (the FE submits each record's PREVIEW-TIME version over the
 * identity's scope — never the current version, never a record outside scope). Mounted via createApp + jsdom;
 * the dialog Teleports to body.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createApp, nextTick } from 'vue'

import RestoreBatchDialog from '../src/multitable/components/RestoreBatchDialog.vue'
import { buildBatchExpectedVersions } from '../src/multitable/utils/batch-restore-expected-versions'
import { resolveSelectionLabels } from '../src/multitable/utils/batch-restore-labels'
import type { RestoreBatchPreviewRecord, RestoreBatchExecuteRecord } from '../src/multitable/api/client'

describe('resolveSelectionLabels — BS-4 off-page title capture', () => {
  const rows = [{ id: 'A', data: { f1: 'Alpha' } }, { id: 'B', data: { f1: 'Beta' } }]
  it('captures the primary-field title for loaded (on-page) records', () => {
    expect(resolveSelectionLabels(['A', 'B'], rows, 'f1', {})).toEqual({ A: 'Alpha', B: 'Beta' })
  })
  it('KEEPS a previously-captured title for a record no longer loaded (off-page / post-reset) — the key property', () => {
    // C is selected but not in the (reset) rows; its title was captured earlier → retained, not lost to the id.
    expect(resolveSelectionLabels(['A', 'C'], rows, 'f1', { C: 'Gamma' })).toEqual({ A: 'Alpha', C: 'Gamma' })
  })
  it('a fresh on-page title OVERRIDES a stale captured one (the live grid wins when loaded)', () => {
    expect(resolveSelectionLabels(['A'], rows, 'f1', { A: 'OldAlpha' })).toEqual({ A: 'Alpha' })
  })
  it('empty (caller falls back to the id) when neither loaded nor previously captured', () => {
    expect(resolveSelectionLabels(['Z'], rows, 'f1', {})).toEqual({ Z: '' })
  })
})

describe('buildBatchExpectedVersions — BS-4 wire-drift guard', () => {
  it('maps ONLY scope records to their previewVersion (skipped records excluded; current version never used)', () => {
    const records: RestoreBatchPreviewRecord[] = [
      { recordId: 'A', status: 'restorable', previewVersion: 2 },
      { recordId: 'B', status: 'skipped', skipReason: 'no_change' },
      { recordId: 'C', status: 'restorable', previewVersion: 5 },
    ]
    expect(buildBatchExpectedVersions(records, ['A', 'C'])).toEqual({ A: 2, C: 5 }) // B (skipped) excluded
  })
  it('excludes a record not in scope even if it carries a previewVersion (scope is canonical)', () => {
    const records: RestoreBatchPreviewRecord[] = [
      { recordId: 'A', status: 'restorable', previewVersion: 2 },
      { recordId: 'B', status: 'restorable', previewVersion: 3 },
    ]
    expect(buildBatchExpectedVersions(records, ['A'])).toEqual({ A: 2 }) // B in records but not scope → excluded
  })
  it('omits a scope record lacking a numeric previewVersion (fail-closed — never a guessed version)', () => {
    const records: RestoreBatchPreviewRecord[] = [{ recordId: 'A', status: 'restorable' }]
    expect(buildBatchExpectedVersions(records, ['A'])).toEqual({})
  })
})

type Props = {
  visible: boolean; phase: 'preview' | 'result'; loading: boolean; targetVersion: number
  previewRecords: RestoreBatchPreviewRecord[]; restorableCount: number; skippedCount: number; executable: boolean
  resultRecords: RestoreBatchExecuteRecord[]; restoredCount: number
  recordLabelOf: (id: string) => string; isZh: boolean
  onPreviewVersion: (v: number) => void; onConfirm: () => void; onCancel: () => void; onDone: () => void
}

const mounted: Array<{ unmount: () => void }> = []
function mountDialog(overrides: Partial<Props>) {
  const props: Props = {
    visible: true, phase: 'preview', loading: false, targetVersion: 1,
    previewRecords: [], restorableCount: 0, skippedCount: 0, executable: false,
    resultRecords: [], restoredCount: 0, recordLabelOf: (id) => `rec:${id}`, isZh: false,
    onPreviewVersion: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(), onDone: vi.fn(), ...overrides,
  }
  const app = createApp(RestoreBatchDialog, props as unknown as Record<string, unknown>)
  const container = document.createElement('div')
  document.body.appendChild(container)
  app.mount(container)
  mounted.push(app)
  return props
}
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); document.body.innerHTML = '' })

describe('RestoreBatchDialog — BS-4 panel', () => {
  it('preview: renders per-record restorable/skipped(reason) + ENABLES confirm when executable & restorable>0', async () => {
    const props = mountDialog({
      executable: true, restorableCount: 1, skippedCount: 1,
      previewRecords: [
        { recordId: 'A', status: 'restorable', previewVersion: 2 },
        { recordId: 'B', status: 'skipped', skipReason: 'no_change' },
      ],
    })
    await nextTick()
    expect(q('[data-test="batch-restore-preview-list"]')).toBeTruthy()
    expect(document.body.textContent).toContain('rec:A')
    expect(q('[data-test="batch-restorable"]')).toBeTruthy()
    expect(q('[data-test="batch-skipped"]')).toBeTruthy()
    expect(document.body.textContent).toContain('No change') // the skip-reason label resolved from the taxonomy
    const confirm = q('[data-test="batch-restore-confirm"]') as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    confirm.click()
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('preview: BLOCKS confirm when restorableCount === 0 (none-restorable) and shows the hint', async () => {
    mountDialog({ executable: false, restorableCount: 0, previewRecords: [{ recordId: 'A', status: 'skipped', skipReason: 'unavailable' }] })
    await nextTick()
    expect(q('[data-test="batch-restore-none"]')).toBeTruthy()
    expect((q('[data-test="batch-restore-confirm"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('advanced: toggling reveals the version input and changing it emits preview-version', async () => {
    const props = mountDialog({ executable: true, restorableCount: 1, previewRecords: [{ recordId: 'A', status: 'restorable', previewVersion: 2 }] })
    await nextTick()
    ;(q('[data-test="batch-restore-advanced"]') as HTMLButtonElement).click()
    await nextTick()
    const input = q('[data-test="batch-restore-version"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(q('[data-test="batch-restore-version-hint"]')).toBeTruthy() // the per-record version-N semantic is explained
    expect(document.body.textContent).toContain('its own version') // the clearer copy
    input.value = '3'
    input.dispatchEvent(new Event('change'))
    expect(props.onPreviewVersion).toHaveBeenCalledWith(3)
  })

  it('result: renders restored/skipped(reason) and Done emits done', async () => {
    const props = mountDialog({
      phase: 'result', restoredCount: 1, skippedCount: 1,
      resultRecords: [
        { recordId: 'A', status: 'restored', newVersion: 3 },
        { recordId: 'B', status: 'skipped', skipReason: 'conflict' },
      ],
    })
    await nextTick()
    expect(q('[data-test="batch-restore-result-list"]')).toBeTruthy()
    expect(q('[data-test="batch-restored"]')).toBeTruthy()
    expect(document.body.textContent).toContain('Version conflict') // execute skip-reason label
    const done = q('[data-test="batch-restore-done"]') as HTMLButtonElement
    done.click()
    expect(props.onDone).toHaveBeenCalledTimes(1)
  })

  it('emits cancel from the cancel button (preview)', async () => {
    const props = mountDialog({ executable: true, restorableCount: 1, previewRecords: [{ recordId: 'A', status: 'restorable', previewVersion: 2 }] })
    await nextTick()
    ;(document.body.querySelectorAll('.restore-batch__btn')[0] as HTMLButtonElement).click()
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })
})
