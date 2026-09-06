import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import MetaBulkEditDialog from '../src/multitable/components/MetaBulkEditDialog.vue'
import type { MetaField } from '../src/multitable/types'

const baseFields: MetaField[] = [
  { id: 'fld_name', name: 'Name', type: 'string', property: {} },
  { id: 'fld_notes', name: 'Notes', type: 'longText', property: {} },
  { id: 'fld_amount', name: 'Amount', type: 'number', property: {} },
  { id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'Open' }, { value: 'Closed' }], property: {} },
  { id: 'fld_link', name: 'Linked', type: 'link', property: {} },
  { id: 'fld_attach', name: 'Files', type: 'attachment', property: {} },
  { id: 'fld_formula', name: 'Calc', type: 'formula', property: {} },
  { id: 'fld_lookup', name: 'Lookup', type: 'lookup', property: {} },
  { id: 'fld_rollup', name: 'Rollup', type: 'rollup', property: {} },
  { id: 'fld_locked', name: 'Locked', type: 'string', property: { readonly: true } },
  { id: 'fld_hidden', name: 'Hidden', type: 'string', property: { hidden: true } },
  { id: 'fld_auto', name: 'AutoNum', type: 'autoNumber', property: {} },
  { id: 'fld_created', name: 'Created', type: 'createdTime', property: {} },
]

function mountDialog(propsOverride: Partial<{
  mode: 'set' | 'clear'
  visible: boolean
  fields: MetaField[]
  canEdit: boolean
  fieldPermissions: Record<string, { readOnly?: boolean }>
  recordIds: string[]
  busy: boolean
  error: string | null
  resultMessage: string | null
  onApply: (...args: unknown[]) => unknown
  onCancel: (...args: unknown[]) => unknown
}> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const props = {
    visible: true,
    mode: 'set' as const,
    fields: baseFields,
    canEdit: true,
    fieldPermissions: {},
    recordIds: ['rec_1', 'rec_2', 'rec_3'],
    busy: false,
    error: null as string | null,
    resultMessage: null as string | null,
    onApply: vi.fn(),
    onCancel: vi.fn(),
    ...propsOverride,
  }
  const app = createApp({
    render() {
      return h(MetaBulkEditDialog, props)
    },
  })
  app.mount(container)
  return { app, container, props, root: document.body }
}

describe('MetaBulkEditDialog', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    useLocale().setLocale('en')
    vi.restoreAllMocks()
  })

  it('shows the set-mode title and summary when mode is set', async () => {
    const { app, root } = mountDialog({ mode: 'set' })
    await nextTick()
    expect(root.querySelector('.meta-bulk-edit__header strong')?.textContent).toBe('Set field for selected records')
    expect(root.querySelector('.meta-bulk-edit__hint')?.textContent).toContain('Pick a field and a value')
    app.unmount()
  })

  it('shows the clear-mode title when mode is clear', async () => {
    const { app, root } = mountDialog({ mode: 'clear' })
    await nextTick()
    expect(root.querySelector('.meta-bulk-edit__header strong')?.textContent).toBe('Clear field for selected records')
    app.unmount()
  })

  it('renders bulk edit chrome in zh-CN while preserving raw field names', async () => {
    useLocale().setLocale('zh-CN')
    const { app, root } = mountDialog({ mode: 'clear' })
    await nextTick()

    expect(root.querySelector('.meta-bulk-edit__header strong')?.textContent).toBe('清空所选记录的字段')
    expect(root.querySelector('.meta-bulk-edit__close')?.getAttribute('aria-label')).toBe('关闭')
    expect(root.textContent).toContain('字段')
    expect(root.textContent).toContain('（选择字段）')
    expect(root.textContent).toContain('选择要在 3 条所选记录中清空的字段。')

    const select = root.querySelector('.meta-bulk-edit__select') as HTMLSelectElement
    expect(select.getAttribute('aria-label')).toBe('要更新的字段')
    select.value = 'fld_notes'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(root.textContent).toContain('操作')
    expect(root.textContent).toContain('将在 3 条记录中清空 Notes。')
    expect(root.textContent).toContain('取消')
    expect(root.textContent).toContain('清空')
    app.unmount()
  })

  it('preserves English bulk edit chrome by default', async () => {
    const { app, root } = mountDialog({ mode: 'clear' })
    await nextTick()

    expect(root.querySelector('.meta-bulk-edit__header strong')?.textContent).toBe('Clear field for selected records')
    expect(root.querySelector('.meta-bulk-edit__close')?.getAttribute('aria-label')).toBe('Close')

    const select = root.querySelector('.meta-bulk-edit__select') as HTMLSelectElement
    select.value = 'fld_notes'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(root.textContent).toContain('Will clear Notes on 3 records.')
    app.unmount()
  })

  it('field picker excludes system, derived, link, attachment, hidden, and readonly fields', async () => {
    const { app, root } = mountDialog()
    await nextTick()
    const options = Array.from(root.querySelectorAll('.meta-bulk-edit__select option'))
      .map((option) => (option as HTMLOptionElement).value)
      .filter((value) => value.length > 0)
    expect(options).toEqual(['fld_name', 'fld_notes', 'fld_amount', 'fld_status'])
    expect(options).not.toContain('fld_link')
    expect(options).not.toContain('fld_attach')
    expect(options).not.toContain('fld_formula')
    expect(options).not.toContain('fld_lookup')
    expect(options).not.toContain('fld_rollup')
    expect(options).not.toContain('fld_locked')
    expect(options).not.toContain('fld_hidden')
    expect(options).not.toContain('fld_auto')
    expect(options).not.toContain('fld_created')
    app.unmount()
  })

  it('field picker also respects explicit fieldPermissions readOnly map', async () => {
    const { app, root } = mountDialog({
      fieldPermissions: { fld_name: { readOnly: true } },
    })
    await nextTick()
    const options = Array.from(root.querySelectorAll('.meta-bulk-edit__select option'))
      .map((option) => (option as HTMLOptionElement).value)
      .filter((value) => value.length > 0)
    expect(options).not.toContain('fld_name')
    expect(options).toContain('fld_notes')
    app.unmount()
  })

  it('field picker is empty when canEdit is false', async () => {
    const { app, root } = mountDialog({ canEdit: false })
    await nextTick()
    const options = Array.from(root.querySelectorAll('.meta-bulk-edit__select option'))
      .map((option) => (option as HTMLOptionElement).value)
      .filter((value) => value.length > 0)
    expect(options).toEqual([])
    expect(root.querySelector('.meta-bulk-edit__hint--muted')?.textContent).toContain('No bulk-editable fields')
    app.unmount()
  })

  it('emits apply with set-mode payload after picking a field and value', async () => {
    const onApply = vi.fn()
    const { app, root } = mountDialog({ mode: 'set', onApply })
    await nextTick()

    const select = root.querySelector('.meta-bulk-edit__select') as HTMLSelectElement
    select.value = 'fld_name'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const input = root.querySelector('.meta-bulk-edit__value-wrap input[type=text]') as HTMLInputElement
    input.value = 'Alpha'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    const submit = Array.from(root.querySelectorAll('.meta-bulk-edit__btn--primary'))[0] as HTMLButtonElement
    submit.click()
    await nextTick()

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith({
      mode: 'set',
      fieldId: 'fld_name',
      value: 'Alpha',
      recordIds: ['rec_1', 'rec_2', 'rec_3'],
    })
    app.unmount()
  })

  it('emits apply with clear-mode payload (value: null) without a value editor', async () => {
    const onApply = vi.fn()
    const { app, root } = mountDialog({ mode: 'clear', onApply })
    await nextTick()

    const select = root.querySelector('.meta-bulk-edit__select') as HTMLSelectElement
    select.value = 'fld_notes'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(root.querySelector('.meta-bulk-edit__value-wrap input')).toBeNull()

    const submit = Array.from(root.querySelectorAll('.meta-bulk-edit__btn--primary'))[0] as HTMLButtonElement
    submit.click()
    await nextTick()

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith({
      mode: 'clear',
      fieldId: 'fld_notes',
      value: null,
      recordIds: ['rec_1', 'rec_2', 'rec_3'],
    })
    app.unmount()
  })

  it('Apply is disabled in set mode until a value is entered', async () => {
    const { app, root } = mountDialog({ mode: 'set' })
    await nextTick()

    const select = root.querySelector('.meta-bulk-edit__select') as HTMLSelectElement
    select.value = 'fld_name'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const submit = Array.from(root.querySelectorAll('.meta-bulk-edit__btn--primary'))[0] as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    app.unmount()
  })

  it('renders an error message when the parent passes a conflict / failure', async () => {
    const onApply = vi.fn()
    const { app, root } = mountDialog({
      mode: 'set',
      error: 'Some records were modified elsewhere. Reload and retry.',
      onApply,
    })
    await nextTick()

    const errorBlock = root.querySelector('.meta-bulk-edit__error')
    expect(errorBlock).not.toBeNull()
    expect(errorBlock?.textContent).toContain('modified elsewhere')
    app.unmount()
  })

  it('disables Apply while busy is true (re-entrancy guard)', async () => {
    const { app, root } = mountDialog({ mode: 'set', busy: true })
    await nextTick()

    const select = root.querySelector('.meta-bulk-edit__select') as HTMLSelectElement
    select.value = 'fld_name'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const input = root.querySelector('.meta-bulk-edit__value-wrap input[type=text]') as HTMLInputElement
    input.value = 'Alpha'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    const submit = Array.from(root.querySelectorAll('.meta-bulk-edit__btn--primary'))[0] as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    app.unmount()
  })

  it('does NOT auto-submit when a select-typed editor fires its native change (regression: Codex review on PR #1451)', async () => {
    // MetaCellEditor emits `confirm` on select/boolean `@change` for ergonomic
    // single-cell edits. The bulk dialog must NOT bind that to onApply, or
    // opening the dropdown would silently bulk-patch every selected record
    // without the explicit "Set value" click.
    const onApply = vi.fn()
    const { app, root } = mountDialog({ mode: 'set', onApply })
    await nextTick()

    const fieldSelect = root.querySelector('.meta-bulk-edit__select') as HTMLSelectElement
    fieldSelect.value = 'fld_status'
    fieldSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const valueSelect = root.querySelector('.meta-bulk-edit__value-wrap select') as HTMLSelectElement | null
    expect(valueSelect).not.toBeNull()
    valueSelect!.value = 'Open'
    valueSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(onApply).not.toHaveBeenCalled()

    const submit = Array.from(root.querySelectorAll('.meta-bulk-edit__btn--primary'))[0] as HTMLButtonElement
    submit.click()
    await nextTick()

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith({
      mode: 'set',
      fieldId: 'fld_status',
      value: 'Open',
      recordIds: ['rec_1', 'rec_2', 'rec_3'],
    })
    app.unmount()
  })

  it('does NOT auto-submit when a boolean editor fires its native change', async () => {
    const onApply = vi.fn()
    const { app, root } = mountDialog({
      mode: 'set',
      fields: [{ id: 'fld_done', name: 'Done', type: 'boolean', property: {} }],
      onApply,
    })
    await nextTick()

    const fieldSelect = root.querySelector('.meta-bulk-edit__select') as HTMLSelectElement
    fieldSelect.value = 'fld_done'
    fieldSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const checkbox = root.querySelector('.meta-bulk-edit__value-wrap input[type=checkbox]') as HTMLInputElement | null
    expect(checkbox).not.toBeNull()
    checkbox!.checked = true
    checkbox!.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(onApply).not.toHaveBeenCalled()
    app.unmount()
  })

  // grid-commit-reliability regression: MetaCellEditor's D2 Tab-commit feature is scoped to grid
  // hosts via the `host-commit-policy` opt-in prop (MetaGridTable passes `'grid'`; MetaBulkEditDialog
  // does not set it, so it defaults to `'none'`). Without that gate, Tab pressed in the value input
  // would call preventDefault() unconditionally — and since this dialog never listens for
  // `tab-commit`, the keydown would be silently swallowed with nothing consuming it, trapping
  // keyboard focus inside the input (Tab could never reach "Set value" / Cancel). MUTATION: removing
  // the `props.hostCommitPolicy !== 'grid'` guard in MetaCellEditor's onTextTab makes this go red
  // (defaultPrevented flips to true).
  it('does not intercept Tab in the value editor (hostCommitPolicy is not wired here)', async () => {
    const { app, root } = mountDialog({ mode: 'set' })
    await nextTick()

    const select = root.querySelector('.meta-bulk-edit__select') as HTMLSelectElement
    select.value = 'fld_name'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const input = root.querySelector('.meta-bulk-edit__value-wrap input[type=text]') as HTMLInputElement
    expect(input).not.toBeNull()
    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    input.dispatchEvent(tabEvent)

    expect(tabEvent.defaultPrevented).toBe(false)
    app.unmount()
  })

  // grid-commit-reliability P2-1: MetaCellEditor's number branch wires `@blur="onScalarBlur"`, and
  // `onScalarBlur` can emit `cancel` on its own (the P3-C invalid-numeric-draft discard path) even
  // when the host never opted into commit-on-blur at all. Before P2-1, that blur handler was gated
  // on nothing — only the Tab handlers checked the opt-in prop — so blurring a number input while
  // mid-typing a negative/decimal (e.g. a lone '-', which the WHATWG number-input value-sanitization
  // algorithm reports as '' from `.value` while still mid-edit) reached `onScalarBlur`, hit the
  // invalid-draft branch, and emitted `cancel` — which THIS dialog's `@cancel="onCancel"` on
  // MetaCellEditor reads as "dismiss the whole bulk-edit dialog".
  //
  // Round-4 note (P2, this file's own P2 test below): since `onNumberInput` now ALSO gates
  // `numberInvalidRawDraft` on `hostCommitPolicy === 'grid'` (it never sets that flag at all under
  // 'none'), `onScalarBlur`'s invalid-draft branch can no longer be REACHED on this dialog even if
  // its own `hostCommitPolicy !== 'grid'` guard were deleted — so that specific mutation no longer
  // reds THIS test via `onCancel` (it instead emits an unlistened `blur-commit`, harmlessly, from
  // this dialog's perspective). Removing `onScalarBlur`'s own guard is still independently
  // discriminating — just no longer through this dialog: see
  // "round 4 (P3-4): hostCommitPolicy guards with a mutation-tested probe" in
  // multitable-yjs-cell-editor.spec.ts, which spies the full emit surface directly on MetaCellEditor
  // and catches it via `blur-commit` firing instead. This test is KEPT as-is (still a real,
  // independently-useful regression guard for the ORIGINAL pre-P2-1 defect it was written for —
  // a corrupted/reverted `onNumberInput` that went back to setting `numberInvalidRawDraft`
  // unconditionally would immediately reawaken the `cancel` path this asserts against).
  it('does not dismiss the dialog when a number input is blurred mid-typing a negative number (hostCommitPolicy is not wired here)', async () => {
    const onCancel = vi.fn()
    const { app, root } = mountDialog({ mode: 'set', onCancel })
    await nextTick()

    const select = root.querySelector('.meta-bulk-edit__select') as HTMLSelectElement
    select.value = 'fld_amount'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const input = root.querySelector('.meta-bulk-edit__value-wrap input[type=number]') as HTMLInputElement
    expect(input).not.toBeNull()
    input.value = '-' // sanitizes to '' on the getter — an in-progress, not-yet-resolved draft
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '-', inputType: 'insertText' }))
    await nextTick()

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    input.dispatchEvent(new FocusEvent('blur', { relatedTarget: outside, bubbles: true }))
    await nextTick()

    expect(onCancel).not.toHaveBeenCalled()
    // The value editor for the selected field is still mounted — the dialog's own state never reset.
    expect(root.querySelector('.meta-bulk-edit__value-wrap input[type=number]')).not.toBeNull()
    outside.remove()
    app.unmount()
  })

  // P2 (round 4): the numberInvalidRawDraft / numberHasValidDraft "retain the last valid draft"
  // tracking MetaCellEditor's onNumberInput grew in round 3 is opt-in state for the SAME
  // `hostCommitPolicy === 'grid'` host that reads it (MetaGridTable's blur/Tab-commit discard-vs-
  // commit-last-valid decision). Before this fix, `onNumberInput` applied that tracking
  // UNCONDITIONALLY — so on THIS dialog ('none' policy, never wired), a valid draft ('7', committed
  // immediately) followed by an in-progress invalid keystroke ('.', which the WHATWG number-input
  // value-sanitization algorithm reports as '' from `.value` while still mid-edit) hit the
  // `numberInvalidRawDraft` early-return and skipped `commitScalar` entirely for that keystroke —
  // leaving the dialog's `value` ref stuck at the STALE last-valid 7 (and "Set value" stayed
  // ENABLED) instead of the byte-identical-to-main behaviour: main's `onNumberInput` (no draft
  // tracking at all) commits `v === '' ? null : Number(v)` on EVERY keystroke unconditionally, so
  // the same '7' → '.' sequence commits `null` and disables the button. `value.value` itself isn't
  // readable from outside the dialog; the submit button's `disabled` state is the only externally
  // observable proxy for it, so that's what this asserts. MUTATION: removing the
  // `props.hostCommitPolicy !== 'grid'` guard from the top of `onNumberInput` reds this (`submit.
  // disabled` stays `false`, reflecting the retained stale `7`). Scope: `onNumberInput` is the
  // SAME shared handler for the number/currency/percent branches (identical `<input type="number">`
  // wiring, see the template) — this fixture exercises the `number` field type; currency/percent
  // are not separately re-verified here. The 'grid'-policy counterpart of this exact sequence
  // (blur commits the retained 7, not null) is unaffected by this fix and is already covered by
  // multitable-grid-cell-edit-commit-round2.spec.ts's "NIT: number blur/Tab commits the last valid
  // draft instead of discarding the whole session" tests.
  it('P2: "Set value" is disabled with value null after a valid draft (7) is followed by an in-progress invalid keystroke (.), matching main byte-for-byte (hostCommitPolicy is not wired here)', async () => {
    const { app, root } = mountDialog({ mode: 'set' })
    await nextTick()

    const select = root.querySelector('.meta-bulk-edit__select') as HTMLSelectElement
    select.value = 'fld_amount'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const input = root.querySelector('.meta-bulk-edit__value-wrap input[type=number]') as HTMLInputElement
    expect(input).not.toBeNull()

    input.value = '7'
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '7', inputType: 'insertText' }))
    await nextTick()

    const submitAfterValid = Array.from(root.querySelectorAll('.meta-bulk-edit__btn--primary'))[0] as HTMLButtonElement
    expect(submitAfterValid.disabled).toBe(false) // sanity: 7 is a meaningful value, button is enabled

    input.value = '' // '.': sanitizes to '' on the getter — an in-progress, not-yet-resolved draft
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '.', inputType: 'insertText' }))
    await nextTick()

    const submitAfterInvalid = Array.from(root.querySelectorAll('.meta-bulk-edit__btn--primary'))[0] as HTMLButtonElement
    expect(submitAfterInvalid.disabled).toBe(true) // main: value committed to null, button disabled
    app.unmount()
  })

  it('emits cancel when the close button is clicked', async () => {
    const onCancel = vi.fn()
    const { app, root } = mountDialog({ onCancel })
    await nextTick()

    const close = root.querySelector('.meta-bulk-edit__close') as HTMLButtonElement
    close.click()
    await nextTick()

    expect(onCancel).toHaveBeenCalledTimes(1)
    app.unmount()
  })
})
