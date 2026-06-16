import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaToolbar from '../src/multitable/components/MetaToolbar.vue'
import type { MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// Nested / multi-level grouping picker: ordered 1-3 levels, GROUPABLE_TYPES gating, no dup fields.

let app: App<Element> | null = null
let container: HTMLDivElement | null = null
afterEach(() => { app?.unmount(); app = null; container?.remove(); container = null; useLocale().setLocale('en') })

const FIELDS: MetaField[] = [
  { id: 'status', name: 'Status', type: 'select', options: [{ value: 'a' }] },
  { id: 'amount', name: 'Amount', type: 'number' },
  { id: 'city', name: 'City', type: 'string' },
  { id: 'notes', name: 'Notes', type: 'longText' }, // NOT groupable (excluded)
]

function mountToolbar(props: Record<string, unknown>) {
  container = document.createElement('div'); document.body.appendChild(container)
  app = createApp({ setup: () => () => h(MetaToolbar, {
    fields: FIELDS, hiddenFieldIds: [], sortRules: [], filterRules: [], filterConjunction: 'and',
    canCreateRecord: true, canExport: true, canUndo: false, canRedo: false, sortFilterDirty: false,
    ...props,
  }) })
  app.mount(container)
  return container
}

async function openGroupPanel(root: HTMLElement): Promise<HTMLElement> {
  const button = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.includes('Group')) as HTMLButtonElement
  button.click()
  await nextTick()
  const panel = root.querySelector('.meta-toolbar__panel--group') as HTMLElement
  expect(panel).toBeTruthy()
  return panel
}

describe('MetaToolbar nested group picker', () => {
  it('GROUPABLE_TYPES gates options — longText is excluded, select/number/string included', async () => {
    const root = mountToolbar({ groupFieldIds: [] })
    const panel = await openGroupPanel(root)
    const select = panel.querySelector('.meta-toolbar__group-select') as HTMLSelectElement
    const opts = Array.from(select.options).map((o) => o.value)
    expect(opts).toEqual(['', 'status', 'amount', 'city']) // '' = None; notes(longText) excluded
  })

  it('badge shows the active level count', async () => {
    const root = mountToolbar({ groupFieldIds: ['status', 'city'] })
    const badge = root.querySelector('.meta-toolbar__badge') as HTMLElement
    expect(badge.textContent?.trim()).toBe('2')
  })

  it('picking a field at level 0 emits set-group-fields with a 1-element array', async () => {
    const onSetGroupFields = vi.fn()
    const root = mountToolbar({ groupFieldIds: [], onSetGroupFields })
    const panel = await openGroupPanel(root)
    const select = panel.querySelector('.meta-toolbar__group-select') as HTMLSelectElement
    select.value = 'status'
    select.dispatchEvent(new Event('change'))
    expect(onSetGroupFields).toHaveBeenCalledWith(['status'])
  })

  it('Add level appends the next available field; lower levels EXCLUDE already-selected fields', async () => {
    const onSetGroupFields = vi.fn()
    const root = mountToolbar({ groupFieldIds: ['status'], onSetGroupFields })
    const panel = await openGroupPanel(root)
    // two rows? No — only the one active level renders; the "Add level" button adds another.
    const addBtn = panel.querySelector('.meta-toolbar__group-add') as HTMLButtonElement
    expect(addBtn).toBeTruthy()
    addBtn.click()
    // first available field NOT already selected is 'amount'
    expect(onSetGroupFields).toHaveBeenCalledWith(['status', 'amount'])
  })

  it('a field already used at a higher level is NOT offered at a lower level', async () => {
    const root = mountToolbar({ groupFieldIds: ['status', 'city'] })
    const panel = await openGroupPanel(root)
    const selects = Array.from(panel.querySelectorAll('.meta-toolbar__group-select')) as HTMLSelectElement[]
    expect(selects.length).toBe(2)
    // level-2 select must offer 'city' (its own value) + amount, but NOT 'status' (used at level 0)
    const level2Opts = Array.from(selects[1].options).map((o) => o.value)
    expect(level2Opts).toContain('city')
    expect(level2Opts).toContain('amount')
    expect(level2Opts).not.toContain('status')
  })

  it('setting a level to None drops that level AND every deeper level', async () => {
    const onSetGroupFields = vi.fn()
    const root = mountToolbar({ groupFieldIds: ['status', 'city', 'amount'], onSetGroupFields })
    const panel = await openGroupPanel(root)
    const selects = Array.from(panel.querySelectorAll('.meta-toolbar__group-select')) as HTMLSelectElement[]
    // clear level 0 (status) → everything below it is removed too
    selects[0].value = ''
    selects[0].dispatchEvent(new Event('change'))
    expect(onSetGroupFields).toHaveBeenCalledWith([])
  })

  it('caps at 3 levels — no Add button when 3 are selected', async () => {
    const root = mountToolbar({ groupFieldIds: ['status', 'city', 'amount'] })
    const panel = await openGroupPanel(root)
    expect(panel.querySelector('.meta-toolbar__group-add')).toBeNull()
  })

  it('removing a middle level shifts deeper levels up', async () => {
    const onSetGroupFields = vi.fn()
    const root = mountToolbar({ groupFieldIds: ['status', 'city', 'amount'], onSetGroupFields })
    const panel = await openGroupPanel(root)
    const removeBtns = Array.from(panel.querySelectorAll('.meta-toolbar__group-remove')) as HTMLButtonElement[]
    expect(removeBtns.length).toBe(3)
    removeBtns[1].click() // remove 'city' (level 1)
    expect(onSetGroupFields).toHaveBeenCalledWith(['status', 'amount'])
  })
})
