import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaKanbanView from '../src/multitable/components/MetaKanbanView.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c batch6: MetaKanbanView's header "clear grouping" control migrated from bespoke <button> to
// the shared MtButton primitive (ghost, token-styled); the class `meta-kanban__change-btn` is unique, so
// its bespoke hex CSS was removed. header-add (x2) and the per-column add-btn are explicitly NOT touched
// here — all three are the soft-tinted (#ecf5ff bg / #2563eb text, or equivalent create-adjacent) pattern
// named in the T2 tail lock, gated on an owner variant decision. Behavior-preservation proof: "clear"
// stays a native, keyboard-operable <button>; clicking it still emits `update-view-config` with the SAME
// groupFieldId: null payload (unchanged onClearGroupField handler).

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

  it('leaves header-add/add-btn bespoke (not migrated — T2 soft-tinted-adjacent create, owner-gated)', () => {
    const root = mount({ canCreate: true })
    const headerAdd = root.querySelectorAll('.meta-kanban__header-add')
    const addBtn = root.querySelectorAll('.meta-kanban__add-btn')
    expect(headerAdd.length).toBeGreaterThan(0)
    expect(addBtn.length).toBeGreaterThan(0)
    // Bespoke controls keep their own hardcoded-hex CSS class (no MtButton wrapper attributes).
    for (const el of Array.from(headerAdd)) expect(el.className.trim()).toBe('meta-kanban__header-add')
    for (const el of Array.from(addBtn)) expect(el.className.trim()).toBe('meta-kanban__add-btn')
  })
})
