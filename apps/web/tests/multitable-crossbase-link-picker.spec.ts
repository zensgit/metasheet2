import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import { resolveLinkFieldProperty } from '../src/multitable/utils/field-config'

// Cross-base LINK field picker — config-authoring (read side). Design-lock
// 2026-06-14 §3/§4/§8. Component-level rows #1-7; row #8 (active base unchanged)
// lives in the workbench-level spec because MetaFieldManager has no switchBase.

async function flush() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function mountManager(opts: {
  fields?: unknown[]
  sheets?: unknown[]
  sheetId?: string
  listBasesFn?: () => Promise<unknown[]>
  listForeignSheetsFn?: (baseId: string) => Promise<unknown[]>
  onCreateField?: (...args: unknown[]) => void
  onUpdateField?: (...args: unknown[]) => void
}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaFieldManager, {
        visible: true,
        sheetId: opts.sheetId ?? 'sheet_1',
        sheets: opts.sheets ?? [{ id: 'sheet_1', baseId: 'base_current', name: 'Current' }, { id: 'sheet_2', baseId: 'base_current', name: 'Related' }],
        fields: opts.fields ?? [],
        ...(opts.listBasesFn ? { listBasesFn: opts.listBasesFn } : {}),
        ...(opts.listForeignSheetsFn ? { listForeignSheetsFn: opts.listForeignSheetsFn } : {}),
        ...(opts.onCreateField ? { onCreateField: opts.onCreateField } : {}),
        ...(opts.onUpdateField ? { onUpdateField: opts.onUpdateField } : {}),
      })
    },
  })
  app.mount(container)
  return { container, app }
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

// Drive the new-field add-row to a configured `link` field with the config open.
async function openNewLinkConfig(container: HTMLElement, name = 'Vendor') {
  const nameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
  const typeSelect = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__select') as HTMLSelectElement
  setValue(nameInput, name)
  setValue(typeSelect, 'link')
  await flush()
}

function clickAdd(container: HTMLElement) {
  ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
    .find((button) => button.textContent?.includes('+ Add'))
    ?.click()
}

describe('Cross-base link field picker (MetaFieldManager)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  // Row #1 — round-trip (wire-vs-fixture): the EMITTED property fed back through
  // resolveLinkFieldProperty must preserve foreignBaseId (no silent revert).
  it('emits foreignBaseId on a cross-base create and it survives resolve (no silent revert)', async () => {
    const listBasesFn = vi.fn().mockResolvedValue([{ id: 'base_other', name: 'Other base' }])
    const listForeignSheetsFn = vi.fn().mockResolvedValue([{ id: 'sheet_far', baseId: 'base_other', name: 'Far table' }])
    const createSpy = vi.fn()
    const { container, app } = mountManager({ listBasesFn, listForeignSheetsFn, onCreateField: createSpy })

    await openNewLinkConfig(container)
    const toggle = container.querySelector('[data-test="link-cross-base-toggle"]') as HTMLInputElement
    setValue(toggle, '')
    toggle.checked = true
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(listBasesFn).toHaveBeenCalledTimes(1)

    const baseSelect = container.querySelector('[data-test="link-cross-base-select"]') as HTMLSelectElement
    setValue(baseSelect, 'base_other')
    await flush()
    expect(listForeignSheetsFn).toHaveBeenCalledWith('base_other')

    const sheetSelect = container.querySelector('[data-test="link-cross-base-sheet-select"]') as HTMLSelectElement
    setValue(sheetSelect, 'sheet_far')
    await flush()

    clickAdd(container)
    await flush()

    expect(createSpy).toHaveBeenCalledTimes(1)
    const payload = createSpy.mock.calls[0][0] as { property: Record<string, unknown> }
    expect(payload.property.foreignBaseId).toBe('base_other')
    expect(payload.property.foreignSheetId).toBe('sheet_far')

    // Feed the ACTUAL emitted property back through the FE normalizer.
    const resolved = resolveLinkFieldProperty(payload.property)
    expect(resolved.foreignBaseId).toBe('base_other')
    expect(resolved.foreignSheetId).toBe('sheet_far')

    app.unmount()
  })

  // Row #2 — same-base default: toggle off => no foreignBaseId key at all.
  it('does NOT emit foreignBaseId for a same-base link (toggle off)', async () => {
    const listBasesFn = vi.fn().mockResolvedValue([{ id: 'base_other', name: 'Other' }])
    const listForeignSheetsFn = vi.fn().mockResolvedValue([])
    const createSpy = vi.fn()
    const { container, app } = mountManager({ listBasesFn, listForeignSheetsFn, onCreateField: createSpy })

    await openNewLinkConfig(container)
    // Toggle stays off; pick a same-base sheet via the default <select>.
    const sameBaseSelect = container.querySelector('.meta-field-mgr__config select.meta-field-mgr__select') as HTMLSelectElement
    setValue(sameBaseSelect, 'sheet_2')
    await flush()

    clickAdd(container)
    await flush()

    expect(createSpy).toHaveBeenCalledTimes(1)
    const payload = createSpy.mock.calls[0][0] as { property: Record<string, unknown> }
    expect(payload.property.foreignSheetId).toBe('sheet_2')
    expect(payload.property).not.toHaveProperty('foreignBaseId')
    expect(listForeignSheetsFn).not.toHaveBeenCalled()

    app.unmount()
  })

  // Row #3 — base list source: toggle calls listBasesFn; base pick calls
  // listForeignSheetsFn(baseId) and the sheet select shows only those sheets.
  it('sources bases from listBasesFn and foreign sheets from listForeignSheetsFn(baseId)', async () => {
    const listBasesFn = vi.fn().mockResolvedValue([{ id: 'base_a', name: 'A' }, { id: 'base_b', name: 'B' }])
    const listForeignSheetsFn = vi.fn().mockResolvedValue([
      { id: 'sheet_x', baseId: 'base_b', name: 'X' },
      { id: 'sheet_y', baseId: 'base_b', name: 'Y' },
    ])
    const { container, app } = mountManager({ listBasesFn, listForeignSheetsFn, onCreateField: vi.fn() })

    await openNewLinkConfig(container)
    const toggle = container.querySelector('[data-test="link-cross-base-toggle"]') as HTMLInputElement
    toggle.checked = true
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()

    const baseSelect = container.querySelector('[data-test="link-cross-base-select"]') as HTMLSelectElement
    const baseOptionValues = Array.from(baseSelect.querySelectorAll('option')).map((o) => o.value)
    expect(baseOptionValues).toEqual(['', 'base_a', 'base_b'])

    setValue(baseSelect, 'base_b')
    await flush()
    expect(listForeignSheetsFn).toHaveBeenCalledWith('base_b')

    const sheetSelect = container.querySelector('[data-test="link-cross-base-sheet-select"]') as HTMLSelectElement
    const sheetOptionValues = Array.from(sheetSelect.querySelectorAll('option')).map((o) => o.value)
    expect(sheetOptionValues).toEqual(['', 'sheet_x', 'sheet_y'])

    app.unmount()
  })

  // Row #4 — cross-base save-guard: a foreignSheetId valid in the FOREIGN base
  // (not in same-base targetSheets) is accepted with no fieldConfigError.
  it('accepts a cross-base foreign sheet that is not a same-base target sheet', async () => {
    const listBasesFn = vi.fn().mockResolvedValue([{ id: 'base_other', name: 'Other' }])
    // sheet_far is NOT in props.sheets (the same-base list) — proves the guard
    // validates against the fetched foreign list, not same-base targetSheets.
    const listForeignSheetsFn = vi.fn().mockResolvedValue([{ id: 'sheet_far', baseId: 'base_other', name: 'Far' }])
    const createSpy = vi.fn()
    const { container, app } = mountManager({ listBasesFn, listForeignSheetsFn, onCreateField: createSpy })

    await openNewLinkConfig(container)
    const toggle = container.querySelector('[data-test="link-cross-base-toggle"]') as HTMLInputElement
    toggle.checked = true
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    setValue(container.querySelector('[data-test="link-cross-base-select"]') as HTMLSelectElement, 'base_other')
    await flush()
    setValue(container.querySelector('[data-test="link-cross-base-sheet-select"]') as HTMLSelectElement, 'sheet_far')
    await flush()

    clickAdd(container)
    await flush()

    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.meta-field-mgr__error')).toBeNull()

    app.unmount()
  })

  // Row #5 — edit immutability: open an existing cross-base field → toggle on,
  // toggle + base select DISABLED, stored names shown.
  it('locks the base axis (toggle + base select disabled) when editing an existing cross-base field', async () => {
    const listBasesFn = vi.fn().mockResolvedValue([{ id: 'base_other', name: 'Other base' }])
    const listForeignSheetsFn = vi.fn().mockResolvedValue([{ id: 'sheet_far', baseId: 'base_other', name: 'Far table' }])
    const { container, app } = mountManager({
      listBasesFn,
      listForeignSheetsFn,
      onUpdateField: vi.fn(),
      fields: [
        {
          id: 'fld_x',
          name: 'X-link',
          type: 'link',
          property: { foreignSheetId: 'sheet_far', foreignBaseId: 'base_other', limitSingleRecord: false },
        },
      ],
    })
    await flush()

    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await flush()

    const toggle = container.querySelector('[data-test="link-cross-base-toggle"]') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    expect(toggle.disabled).toBe(true)

    const baseSelect = container.querySelector('[data-test="link-cross-base-select"]') as HTMLSelectElement
    expect(baseSelect.disabled).toBe(true)
    expect(baseSelect.value).toBe('base_other')
    // Locked option resolves the stored base name from listBasesFn.
    expect(baseSelect.textContent).toContain('Other base')
    expect(container.querySelector('[data-test="link-cross-base-locked"]')).not.toBeNull()

    app.unmount()
  })

  // Row #6 — unreadable foreign base: listForeignSheetsFn rejects (403) →
  // gated state, no crash, and the save is blocked (no silent same-base save).
  it('renders a gated state and blocks save when the foreign base is unreadable (403)', async () => {
    const listBasesFn = vi.fn().mockResolvedValue([{ id: 'base_other', name: 'Other' }])
    const listForeignSheetsFn = vi.fn().mockRejectedValue(new Error('forbidden'))
    const createSpy = vi.fn()
    const { container, app } = mountManager({ listBasesFn, listForeignSheetsFn, onCreateField: createSpy })

    await openNewLinkConfig(container)
    const toggle = container.querySelector('[data-test="link-cross-base-toggle"]') as HTMLInputElement
    toggle.checked = true
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    setValue(container.querySelector('[data-test="link-cross-base-select"]') as HTMLSelectElement, 'base_other')
    await flush()

    // Gated notice shown, no sheet select rendered.
    expect(container.querySelector('[data-test="link-cross-base-unreadable"]')).not.toBeNull()
    expect(container.querySelector('[data-test="link-cross-base-sheet-select"]')).toBeNull()

    // Attempting to add must NOT emit a (same-base or otherwise) property.
    clickAdd(container)
    await flush()
    expect(createSpy).not.toHaveBeenCalled()

    app.unmount()
  })

  // Edit immutability (data-safety): an existing SAME-BASE link must not be
  // re-targetable to a cross-base — that is deferred (design §7) and would break
  // the field's existing values (record IDs in the current base). The toggle is
  // present but DISABLED, and a synthetic change cannot flip it on / emit
  // foreignBaseId.
  it('locks (disables) the cross-base toggle when editing an existing same-base link and never emits foreignBaseId', async () => {
    const listBasesFn = vi.fn().mockResolvedValue([{ id: 'base_other', name: 'Other' }])
    const listForeignSheetsFn = vi.fn().mockResolvedValue([{ id: 'sheet_far', baseId: 'base_other', name: 'Far' }])
    const updateSpy = vi.fn()
    const { container, app } = mountManager({
      listBasesFn,
      listForeignSheetsFn,
      onUpdateField: updateSpy,
      fields: [
        // Same-base link: foreignSheetId in the current base, NO foreignBaseId.
        { id: 'fld_same', name: 'Same', type: 'link', property: { foreignSheetId: 'sheet_2', limitSingleRecord: false } },
      ],
    })
    await flush()

    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await flush()

    const toggle = container.querySelector('[data-test="link-cross-base-toggle"]') as HTMLInputElement
    expect(toggle).not.toBeNull()
    expect(toggle.checked).toBe(false)
    expect(toggle.disabled).toBe(true)

    // Even a synthetic change cannot turn it cross-base. (Like the hierarchy
    // single-record lock test, the contract is the EMITTED property + that the
    // cross-base UI never activates — not the disabled checkbox's DOM `.checked`,
    // which jsdom won't re-sync when the bound ref stays false.)
    toggle.checked = true
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(listBasesFn).not.toHaveBeenCalled()
    // The cross-base block (base <select>) never renders → toggle stayed off.
    expect(container.querySelector('[data-test="link-cross-base-select"]')).toBeNull()

    // Saving still emits a SAME-BASE property — no foreignBaseId leaks in.
    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save field settings'))
      ?.click()
    await flush()
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy.mock.calls[0][1].property).not.toHaveProperty('foreignBaseId')

    app.unmount()
  })

  // Edit-time 403 (the PRIMARY row-#6 scenario): open an existing CROSS-BASE
  // field whose foreign base is now unreadable → gated notice + stored ids, no
  // crash, and a save is blocked (never a silent same-base save).
  it('renders a gated state and blocks save when an existing cross-base field’s foreign base became unreadable', async () => {
    const listBasesFn = vi.fn().mockResolvedValue([])
    const listForeignSheetsFn = vi.fn().mockRejectedValue(new Error('forbidden'))
    const updateSpy = vi.fn()
    const { container, app } = mountManager({
      listBasesFn,
      listForeignSheetsFn,
      onUpdateField: updateSpy,
      fields: [
        { id: 'fld_x', name: 'X-link', type: 'link', property: { foreignSheetId: 'sheet_far', foreignBaseId: 'base_gone', limitSingleRecord: false } },
      ],
    })
    await flush()

    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await flush()

    // Toggle on (stored cross-base), base axis locked, gated notice shown, no crash.
    const toggle = container.querySelector('[data-test="link-cross-base-toggle"]') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    expect(toggle.disabled).toBe(true)
    expect(container.querySelector('[data-test="link-cross-base-unreadable"]')).not.toBeNull()
    // Stored base id still shown in the locked select (raw-id fallback, list empty).
    const baseSelect = container.querySelector('[data-test="link-cross-base-select"]') as HTMLSelectElement
    expect(baseSelect.value).toBe('base_gone')
    expect(container.querySelector('[data-test="link-cross-base-sheet-select"]')).toBeNull()

    // Save is blocked — no silent same-base downgrade.
    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save field settings'))
      ?.click()
    await flush()
    expect(updateSpy).not.toHaveBeenCalled()

    app.unmount()
  })

  // Row #7 — reset on close/reopen: linkDraft (incl. foreignBaseId) resets so a
  // new field does not inherit a stale foreign base from a prior edit.
  it('resets cross-base draft when reopening for a new field after editing a cross-base field', async () => {
    const listBasesFn = vi.fn().mockResolvedValue([{ id: 'base_other', name: 'Other' }])
    const listForeignSheetsFn = vi.fn().mockResolvedValue([{ id: 'sheet_far', baseId: 'base_other', name: 'Far' }])
    const { container, app } = mountManager({
      listBasesFn,
      listForeignSheetsFn,
      onUpdateField: vi.fn(),
      onCreateField: vi.fn(),
      fields: [
        {
          id: 'fld_x',
          name: 'X-link',
          type: 'link',
          property: { foreignSheetId: 'sheet_far', foreignBaseId: 'base_other', limitSingleRecord: false },
        },
      ],
    })
    await flush()

    // Edit the existing cross-base field (loads foreignBaseId into the draft).
    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await flush()
    expect((container.querySelector('[data-test="link-cross-base-toggle"]') as HTMLInputElement).checked).toBe(true)

    // Now start a brand-new link field via the add-row.
    await openNewLinkConfig(container, 'Fresh')
    const toggle = container.querySelector('[data-test="link-cross-base-toggle"]') as HTMLInputElement
    // Fresh field defaults to same-base (toggle off), no inherited foreign base.
    expect(toggle.checked).toBe(false)
    expect(container.querySelector('[data-test="link-cross-base-select"]')).toBeNull()

    app.unmount()
  })
})
