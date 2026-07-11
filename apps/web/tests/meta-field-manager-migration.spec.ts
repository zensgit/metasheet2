import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import { useLocale } from '../src/composables/useLocale'
import type { DryRunResult } from '../src/multitable/api/client'

// UI-P2-1c batch-3: MetaFieldManager's footer/dryrun slice — 10 bespoke <button>s → shared MtButton
// primitive; zero behavior change (@click / :disabled / v-if / data-* / :title bindings byte-identical).
//
// - config-panel footer (Cancel/Save-or-Apply): both `meta-field-mgr__btn-cancel` sharers (config-panel +
//   delete-confirm) and both `meta-field-mgr__btn-add` sharers (config-panel save + add-section add-field)
//   migrated at once (full sharer sets) — bespoke #409eff/border CSS removed (no double-styling), normalized
//   to --ms-color-primary / default ghost.
// - delete-confirm footer: `meta-field-mgr__btn-delete` (its only sharer) → variant="danger", bespoke
//   #f56c6c fill normalized to --ms-color-danger.
// - rollup filter "Add filter": `meta-field-mgr__add-btn` (its only sharer) → default ghost. Carried NO
//   bespoke CSS (plain unstyled button) — nothing to remove.
// - dry-run panel Test / Test-with-record, AI-shortcut preview, AI-bulk-fill trigger: 4 of the 8
//   `meta-field-mgr__dryrun-btn` sharers → default ghost. These 4 are each a SINGLE-HOP action (click →
//   fn call). Carried NO bespoke CSS. The remaining 4 dryrun-btn sharers (NL-formula-suggest
//   generate/accept/reject/regenerate) are deferred as behind-flow: accept/reject/regenerate only render
//   after generate's async fn resolves with a candidate (2-hop), so they stay bespoke <button> — the class
//   is unmigrated in full, so no CSS could be removed here anyway (none existed).
// - untouched: the __action glyph row (rename/configure/move/delete icons), __btn-inline (T3-GATED:
//   reload-latest/dismiss/add-filter/add-sort/add-option), __icon-btn (glyph "×" rollup-filter remove).
//
// Deep regression anchors (unchanged, must stay green): multitable-field-manager.spec.ts,
// multitable-formula-dryrun-panel.spec.ts, multitable-formula-suggest-field-manager.spec.ts,
// multitable-ai-shortcut-field-manager.spec.ts — all query these buttons by the SAME class names / data-test
// attributes, which are kept as additive classes/attrs on the MtButton root.

let app: App | null = null
let container: HTMLDivElement | null = null
afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  useLocale().setLocale('en')
})

function mount(props: Record<string, unknown>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({ render: () => h(MetaFieldManager, { visible: true, sheetId: 'sheet_1', sheets: [], ...props } as never) })
  app.mount(container)
}

async function flush(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const configureBtn = (nth = 0) =>
  (Array.from(container!.querySelectorAll('.meta-field-mgr__action[title="Configure"]')) as HTMLButtonElement[])[nth]
const configCancelBtn = () => container!.querySelector('.meta-field-mgr__config .meta-field-mgr__btn-cancel') as HTMLButtonElement | null
const saveBtn = () =>
  (Array.from(container!.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
    .find((b) => b.closest('.meta-field-mgr__config')) as HTMLButtonElement | undefined
const addFieldBtn = () => container!.querySelector('.meta-field-mgr__add-row .meta-field-mgr__btn-add') as HTMLButtonElement | null
const deleteGlyphBtn = () => container!.querySelector('.meta-field-mgr__action--danger') as HTMLButtonElement | null
const confirmCancelBtn = () => container!.querySelector('.meta-field-mgr__confirm .meta-field-mgr__btn-cancel') as HTMLButtonElement | null
const confirmDeleteBtn = () => container!.querySelector('.meta-field-mgr__btn-delete') as HTMLButtonElement | null
const rollupAddBtn = () => container!.querySelector('.meta-field-mgr__add-btn') as HTMLButtonElement | null

describe('MetaFieldManager — MtButton migration (UI-P2-1c batch-3, config-panel footer)', () => {
  it('Cancel and Save render as native <button>s; Cancel closes the config panel', async () => {
    mount({ fields: [{ id: 'fld_name', name: 'Name', type: 'string', property: {} }] })
    await nextTick()
    configureBtn().click() // openConfig(field) → configTarget set
    await nextTick()

    expect(configCancelBtn()).not.toBeNull()
    expect(configCancelBtn()!.tagName).toBe('BUTTON')
    expect(saveBtn()).not.toBeUndefined()
    expect(saveBtn()!.tagName).toBe('BUTTON')

    configCancelBtn()!.click() // closeConfig()
    await nextTick()
    expect(container!.querySelector('.meta-field-mgr__config')).toBeNull()
  })

  it('clicking Save still emits `update-field` with the same fieldId and property payload (unchanged)', async () => {
    const onUpdateField = vi.fn()
    mount({
      fields: [{ id: 'fld_files', name: 'Docs', type: 'attachment', property: { maxFiles: 1 } }],
      onUpdateField,
    })
    await nextTick()
    configureBtn().click()
    await nextTick()

    const maxFilesInput = container!.querySelector('.meta-field-mgr__config .meta-field-mgr__input') as HTMLInputElement
    maxFilesInput.value = '5'
    maxFilesInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    expect(saveBtn()!.disabled).toBe(false) // fieldConfigBlockingReason is '' — no background schema change
    saveBtn()!.click() // saveConfig() → emit('update-field', configTarget.value.id, { property })
    expect(onUpdateField).toHaveBeenCalledTimes(1)
    expect(onUpdateField).toHaveBeenCalledWith('fld_files', expect.objectContaining({ property: expect.objectContaining({ maxFiles: 5 }) }))
  })
})

describe('MetaFieldManager — MtButton migration (UI-P2-1c batch-3, add-field + delete-confirm)', () => {
  it('add-section Add renders as a native <button>, disabled until a name is typed, and emits `create-field`', async () => {
    const onCreateField = vi.fn()
    mount({ fields: [], onCreateField })
    await nextTick()
    expect(addFieldBtn()!.tagName).toBe('BUTTON')
    expect(addFieldBtn()!.disabled).toBe(true) // :disabled="!newFieldName.trim() || addNameConflict"

    const nameInput = container!.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
    nameInput.value = 'Status'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(addFieldBtn()!.disabled).toBe(false)

    addFieldBtn()!.click() // onAddField() → emit('create-field', ...)
    expect(onCreateField).toHaveBeenCalledTimes(1)
    expect(onCreateField).toHaveBeenCalledWith(expect.objectContaining({ sheetId: 'sheet_1', name: 'Status', type: 'string' }))
  })

  it('delete-confirm Cancel/Delete render as native <button>s; Cancel dismisses, Delete emits `delete-field`', async () => {
    const onDeleteField = vi.fn()
    mount({ fields: [{ id: 'fld_name', name: 'Name', type: 'string', property: {} }], onDeleteField })
    await nextTick()
    deleteGlyphBtn()!.click() // onDeleteField(field) → deleteTargetId set → confirm row renders
    await nextTick()

    expect(confirmCancelBtn()).not.toBeNull()
    expect(confirmCancelBtn()!.tagName).toBe('BUTTON')
    expect(confirmDeleteBtn()).not.toBeNull()
    expect(confirmDeleteBtn()!.tagName).toBe('BUTTON')

    confirmCancelBtn()!.click() // deleteTargetId = null
    await nextTick()
    expect(container!.querySelector('.meta-field-mgr__confirm')).toBeNull()

    deleteGlyphBtn()!.click()
    await nextTick()
    confirmDeleteBtn()!.click() // confirmDelete() → emit('delete-field', deleteTarget.value.id)
    expect(onDeleteField).toHaveBeenCalledTimes(1)
    expect(onDeleteField).toHaveBeenCalledWith('fld_name')
  })
})

describe('MetaFieldManager — MtButton migration (UI-P2-1c batch-3, rollup filter Add)', () => {
  it('the rollup "Add filter" control renders as a native <button> and clicking it adds another filter row', async () => {
    mount({
      fields: [
        { id: 'fld_rollup', name: 'Roll', type: 'rollup', property: { linkFieldId: 'fld_link', targetFieldId: 'fld_status', aggregation: 'concatenate' } },
        { id: 'fld_link', name: 'Link', type: 'link', property: { foreignSheetId: 'sheet_foreign' } },
      ],
    })
    await nextTick()
    configureBtn().click() // the rollup field (first field, first Configure)
    await flush()

    expect(rollupAddBtn()).not.toBeNull()
    expect(rollupAddBtn()!.tagName).toBe('BUTTON')
    expect(container!.querySelectorAll('.meta-field-mgr__rollup-cond').length).toBe(0)

    rollupAddBtn()!.click() // addRollupFilter() → rollupDraft.filters.push(...)
    await nextTick()
    expect(container!.querySelectorAll('.meta-field-mgr__rollup-cond').length).toBe(1)
  })
})

describe('MetaFieldManager — MtButton migration (UI-P2-1c batch-3, dry-run panel)', () => {
  async function mountFormulaConfig(
    dryRunFn: (p: { sheetId: string; expression: string; sampleValues: Record<string, unknown>; recordId?: string }) => Promise<DryRunResult>,
    currentRecordId: string | null = null,
  ) {
    mount({
      fields: [{ id: 'fld_price', name: 'Price', type: 'number' }, { id: 'fld_total', name: 'Total', type: 'formula', property: { expression: '' } }],
      dryRunFn,
      currentRecordId,
    })
    await nextTick()
    configureBtn(1).click() // the formula field (2nd field, 2nd Configure button)
    await nextTick()
  }

  const testBtn = () => container!.querySelector('.meta-field-mgr__dryrun-btn') as HTMLButtonElement | null
  const recordBtn = () => container!.querySelector('.meta-field-mgr__dryrun-btn--record') as HTMLButtonElement | null

  it('Test renders as a native <button>, :disabled until an expression is set, and calls dryRunFn on click', async () => {
    const dryRunFn = vi.fn().mockResolvedValue({ success: true, result: 1, resultType: 'number', referencedFields: [], diagnostics: [] } satisfies DryRunResult)
    await mountFormulaConfig(dryRunFn)

    expect(testBtn()).not.toBeNull()
    expect(testBtn()!.tagName).toBe('BUTTON')
    expect(testBtn()!.disabled).toBe(true) // dryRunCanEvaluate: expression is empty

    const textarea = container!.querySelector('.meta-field-mgr__textarea') as HTMLTextAreaElement
    textarea.value = '={fld_price}+1'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(testBtn()!.disabled).toBe(false)

    testBtn()!.click() // runDryRun() → executeDryRun()
    await flush()
    expect(dryRunFn).toHaveBeenCalledTimes(1)
    expect(dryRunFn.mock.calls[0][0]).toEqual(expect.objectContaining({ sheetId: 'sheet_1', expression: '={fld_price}+1' }))
  })

  it('Test-with-record is absent without a current record, renders as a native <button> and forwards recordId when present', async () => {
    const dryRunFn = vi.fn().mockResolvedValue({ success: true, result: 1, resultType: 'number', referencedFields: [], diagnostics: [] } satisfies DryRunResult)
    await mountFormulaConfig(dryRunFn) // no currentRecordId
    expect(recordBtn()).toBeNull() // v-if="dryRunHasRecord"

    // remount with a current record
    app!.unmount(); container!.remove()
    await mountFormulaConfig(dryRunFn, 'rec_42')
    expect(recordBtn()).not.toBeNull()
    expect(recordBtn()!.tagName).toBe('BUTTON')
    expect(recordBtn()!.title.length).toBeGreaterThan(0) // :title="ml('field.formulaDryRun.recordHint')" survives

    const textarea = container!.querySelector('.meta-field-mgr__textarea') as HTMLTextAreaElement
    textarea.value = '={fld_price}+1'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    recordBtn()!.click() // runDryRunWithRecord() → executeDryRun(props.currentRecordId)
    await flush()
    expect(dryRunFn).toHaveBeenCalledTimes(1)
    expect(dryRunFn.mock.calls[0][0].recordId).toBe('rec_42')
  })
})

describe('MetaFieldManager — MtButton migration (UI-P2-1c batch-3, AI preview + bulk-fill)', () => {
  const AI_CONFIG = { kind: 'classify', sourceFieldIds: ['fld_src'], params: { options: ['A', 'B'], instruction: 'pick one' } }
  function aiFields() {
    return [
      { id: 'fld_target', name: 'Summary', type: 'string', property: { aiShortcut: structuredClone(AI_CONFIG) } },
      { id: 'fld_src', name: 'Notes', type: 'string', property: {} },
    ]
  }

  it('AI-preview renders as a native <button>, :disabled without a record, and calls aiPreviewFn with the record', async () => {
    const aiPreviewFn = vi.fn().mockResolvedValue({ data: { output: 'ok' } })
    mount({ fields: aiFields(), aiPreviewFn, currentRecordId: 'rec_1' })
    await nextTick()
    configureBtn().click() // fld_target (persisted aiShortcut)
    await nextTick()

    const btn = container!.querySelector('[data-test="ai-shortcut-preview-btn"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-field-mgr__dryrun-btn')).toBe(true)
    expect(btn.disabled).toBe(false) // aiPreviewCanRun: aiPreviewFn + currentRecordId + aiDraft.enabled

    btn.click() // runAiPreview()
    await flush()
    expect(aiPreviewFn).toHaveBeenCalledTimes(1)
    expect(aiPreviewFn.mock.calls[0][0]).toEqual(expect.objectContaining({ recordId: 'rec_1' }))
  })

  it('AI-bulk-fill trigger renders as a native <button> and clicking it emits `bulk-fill` with the fieldId', async () => {
    const onBulkFill = vi.fn()
    mount({ fields: aiFields(), onBulkFill })
    await nextTick()
    configureBtn().click() // fld_target (persisted aiShortcut → aiBulkFillVisible true)
    await nextTick()

    const btn = container!.querySelector('[data-test="ai-bulk-fill-trigger"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-field-mgr__dryrun-btn')).toBe(true)
    expect(btn.disabled).toBe(false) // aiBulkFillEnabled: visible + not dirty

    btn.click() // onBulkFill() → emit('bulk-fill', { fieldId: configTarget.value.id })
    expect(onBulkFill).toHaveBeenCalledTimes(1)
    expect(onBulkFill).toHaveBeenCalledWith({ fieldId: 'fld_target' })
  })
})
