import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaKanbanView from '../src/multitable/components/MetaKanbanView.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c batch6: MetaKanbanView's header "clear grouping" control migrated from bespoke <button> to
// the shared MtButton primitive (ghost, token-styled); the class `meta-kanban__change-btn` is unique, so
// its bespoke hex CSS was removed. Behavior-preservation proof: "clear" stays a native,
// keyboard-operable <button>; clicking it still emits `update-view-config` with the SAME
// groupFieldId: null payload (unchanged onClearGroupField handler).
//
// UI-P2-1c T2 (multitable-ui-p2-1c-tail-lock #3866 §2-T2, RATIFIED): both header-add instances (the
// no-group-field empty state AND the grouped header — same class, same soft-tinted #ecf5ff/#2563eb/
// #c7ddff pattern) migrate onto the new MtButton `plain` variant. The per-column add-btn is
// deliberately EXCLUDED — its bespoke CSS (`border: 1px dashed #ccc; background: transparent; color:
// #999`) is NOT the soft-tinted create pattern named in the T2 lock, so it is left untouched
// (conservative exclusion, per owner instruction). Byte-equivalence proof: same v-if="canCreate" gate,
// same @click="emit('create-record', {})" handler/payload on both header-add instances, same class
// name kept on the elements (selector stability).

const fields: MetaField[] = [
  { id: 'fld_title', name: 'Title', type: 'string' },
  { id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'Doing' }, { value: 'Done' }] },
]

const rows: MetaRecord[] = [
  { id: 'rec_1', version: 1, data: { fld_title: 'Card 1', fld_status: 'Doing' } },
]

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-kanban').length).toBe(0) // residue guard
  useLocale().setLocale('en')
})

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({
    render: () => h(MetaKanbanView, {
      rows,
      fields,
      loading: false,
      viewConfig: { groupFieldId: 'fld_status', cardFieldIds: [] },
      ...props,
    }),
  })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

const changeBtn = (r: HTMLElement) => r.querySelector('.meta-kanban__change-btn') as HTMLButtonElement | null

describe('MetaKanbanView — MtButton migration (UI-P2-1c batch6)', () => {
  it('renders "clear" as a native <button> once a group field is set', () => {
    const root = mount({})
    const btn = changeBtn(root)!
    expect(btn).toBeTruthy()
    expect(btn.tagName).toBe('BUTTON') // keyboard-operable, not a bare div
  })

  it('clicking "clear" emits `update-view-config` with groupFieldId: null (unchanged onClearGroupField)', () => {
    const onUpdateViewConfig = vi.fn()
    const root = mount({ onUpdateViewConfig })
    changeBtn(root)!.click()
    expect(onUpdateViewConfig).toHaveBeenCalledTimes(1)
    expect(onUpdateViewConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ groupFieldId: null }),
      }),
    )
  })

  it('renders header-add (grouped-header instance) as a native <button> via MtButton plain (T2 migration)', () => {
    const root = mount({ canCreate: true })
    const headerAdd = root.querySelectorAll('.meta-kanban__header-add')
    expect(headerAdd.length).toBe(1)
    const btn = headerAdd[0] as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('mt-button--plain')).toBe(true)
  })

  it('renders header-add (empty-state instance, no groupField) as a native <button> via MtButton plain', () => {
    const root = mount({ canCreate: true, viewConfig: { groupFieldId: null, cardFieldIds: [] } })
    const headerAdd = root.querySelectorAll('.meta-kanban__header-add')
    expect(headerAdd.length).toBe(1)
    const btn = headerAdd[0] as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('mt-button--plain')).toBe(true)
  })

  it('header-add only renders when canCreate is true (v-if preserved, both instances)', () => {
    expect(mount({ canCreate: false }).querySelectorAll('.meta-kanban__header-add').length).toBe(0)
    expect(
      mount({ canCreate: false, viewConfig: { groupFieldId: null, cardFieldIds: [] } }).querySelectorAll('.meta-kanban__header-add').length,
    ).toBe(0)
  })

  it('clicking header-add emits `create-record` with the SAME payload (unchanged handler, both instances)', () => {
    const onCreateRecordGrouped = vi.fn()
    const grouped = mount({ canCreate: true, onCreateRecord: onCreateRecordGrouped })
    ;(grouped.querySelector('.meta-kanban__header-add') as HTMLButtonElement).click()
    expect(onCreateRecordGrouped).toHaveBeenCalledTimes(1)
    expect(onCreateRecordGrouped).toHaveBeenCalledWith({})

    const onCreateRecordEmpty = vi.fn()
    const empty = mount({
      canCreate: true,
      viewConfig: { groupFieldId: null, cardFieldIds: [] },
      onCreateRecord: onCreateRecordEmpty,
    })
    ;(empty.querySelector('.meta-kanban__header-add') as HTMLButtonElement).click()
    expect(onCreateRecordEmpty).toHaveBeenCalledTimes(1)
    expect(onCreateRecordEmpty).toHaveBeenCalledWith({})
  })

  it('leaves add-btn bespoke (NOT migrated — its CSS is a dashed transparent grey control, not the T2 soft-tinted pattern)', () => {
    const root = mount({ canCreate: true })
    const addBtn = root.querySelectorAll('.meta-kanban__add-btn')
    expect(addBtn.length).toBeGreaterThan(0)
    // Bespoke control keeps its own hardcoded CSS class (no MtButton wrapper attributes).
    for (const el of Array.from(addBtn)) expect(el.className.trim()).toBe('meta-kanban__add-btn')
  })
})
