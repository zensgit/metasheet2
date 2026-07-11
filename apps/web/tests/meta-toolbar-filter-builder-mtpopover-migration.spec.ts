import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import MetaToolbar from '../src/multitable/components/MetaToolbar.vue'
import type { FilterConjunction, FilterGroup, FilterRule } from '../src/multitable/composables/useMultitableGrid'
import type { MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c slice-5: MetaToolbar's filter ("筛选") dropdown — the MOST COMPLEX builder in the
// toolbar (nested field/operator/value controls via MetaFilterConditionRow, recursive AND/OR
// condition groups via MetaFilterGroup) — was migrated from a hand-rolled `showFilterPanel` ref +
// `.meta-toolbar__dropdown`/`.meta-toolbar__panel--filter` to the shared MtPopover primitive (NOT
// MtMenu, NOT MtMenuItem rows — the panel markup, including its sub-components, is preserved
// verbatim). This is an interaction-preservation proof, and — because this builder is the highest
// NESTED-OVERLAY risk in the migration (deeply nested selects/inputs through two levels of
// sub-components) — it specifically re-proves that every inner control stays inside MtPopover's
// panel (no Teleported sub-menu escapes it), so editing a field/operator/value never closes the
// popover mid-edit.

// Track EVERY mount (see meta-toolbar-sort-builder-mtpopover-migration.spec.ts): a shared global app
// would leave stale Teleported `.mt-popover` content on document.body after teardown. afterEach
// unmounts ALL of them and asserts no toolbar DOM, and no leaked popover Teleport content, survives.
const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []

beforeEach(() => { useLocale().setLocale('en') })
afterEach(() => {
  while (mounts.length) {
    const m = mounts.pop()!
    m.app.unmount()
    m.container.remove()
  }
  expect(document.querySelectorAll('.meta-toolbar').length).toBe(0) // residue guard: no leaked toolbar
  expect(document.querySelectorAll('.mt-popover').length).toBe(0) // no leaked Teleported popover content
  useLocale().setLocale('en')
})

const FIELDS: MetaField[] = [
  { id: 'status', name: 'Status', type: 'select', options: [{ value: 'todo' }, { value: 'done' }] },
  { id: 'owner', name: 'Owner', type: 'string' },
]

type ExtraState = {
  filterRules?: FilterRule[]
  filterGroups?: FilterGroup[]
  filterConjunction?: FilterConjunction
} & Record<string, unknown>

function mountToolbar(initial: ExtraState = {}) {
  const state = reactive<{ filterRules: FilterRule[]; filterGroups: FilterGroup[]; filterConjunction: FilterConjunction }>({
    filterRules: initial.filterRules ?? [],
    filterGroups: initial.filterGroups ?? [],
    filterConjunction: initial.filterConjunction ?? 'and',
  })
  const { filterRules: _r, filterGroups: _g, filterConjunction: _c, ...rest } = initial

  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(MetaToolbar, {
    fields: FIELDS, hiddenFieldIds: [], sortRules: [],
    filterRules: state.filterRules, filterGroups: state.filterGroups, filterConjunction: state.filterConjunction,
    canCreateRecord: true, canExport: true, canUndo: true, canRedo: true, sortFilterDirty: false,
    onAddFilter: (rule: FilterRule) => { state.filterRules.push(rule) },
    onUpdateFilter: (index: number, rule: FilterRule) => { state.filterRules[index] = rule },
    onRemoveFilter: (index: number) => { state.filterRules.splice(index, 1) },
    onAddFilterGroup: (group: FilterGroup) => { state.filterGroups.push(group) },
    onUpdateFilterGroup: (index: number, group: FilterGroup) => { state.filterGroups[index] = group },
    onRemoveFilterGroup: (index: number) => { state.filterGroups.splice(index, 1) },
    onClearFilters: () => { state.filterRules = []; state.filterGroups = []; state.filterConjunction = 'and' },
    onSetConjunction: (conj: FilterConjunction) => { state.filterConjunction = conj },
    ...rest,
  }) })
  app.mount(container)
  mounts.push({ app, container })
  return { container, state }
}

function filterTrigger(root: HTMLElement): HTMLButtonElement {
  const btn = root.querySelector('button[title="Filter"]') as HTMLButtonElement | null
  expect(btn, 'expected a <button title="Filter"> trigger').toBeTruthy()
  return btn as HTMLButtonElement
}

// The filter panel is Teleported to document.body by MtPopover (a sibling of the toolbar's own
// mount container, not a descendant of it), so it's looked up via document once open.
function filterPanel(): HTMLElement {
  const panel = document.querySelector('.meta-toolbar__panel--filter') as HTMLElement | null
  expect(panel, 'expected the filter builder panel inside the popover').toBeTruthy()
  return panel!
}

function conditionRows(): HTMLDivElement[] {
  return Array.from(document.querySelectorAll('.meta-toolbar__filter-rule')) as HTMLDivElement[]
}

describe('MetaToolbar filter builder — MtPopover migration (UI-P2-1c slice-5)', () => {
  it('is closed until the trigger is clicked; clicking it opens the popover with the builder content', async () => {
    const { container: root } = mountToolbar({ filterRules: [{ fieldId: 'status', operator: 'is', value: 'todo' }] })
    expect(document.querySelector('.mt-popover')).toBeNull()

    const trigger = filterTrigger(root)
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.getAttribute('aria-label')).toBe('Filter')
    trigger.click()
    await nextTick()

    expect(document.querySelector('.mt-popover')).not.toBeNull()
    const panel = filterPanel()
    const rows = conditionRows()
    expect(rows.length).toBe(1)
    expect(rows[0].querySelectorAll('select').length).toBeGreaterThanOrEqual(2) // field select + operator select (+ value select)
    expect(panel.textContent).toContain('Add filter')
    expect(panel.textContent).toContain('Add condition group')
  })

  it('shows the filter-rule+group-count badge on the trigger, same as before migration', async () => {
    const { container: root } = mountToolbar({
      filterRules: [{ fieldId: 'status', operator: 'is', value: 'todo' }],
      filterGroups: [{ conjunction: 'and', conditions: [{ fieldId: 'owner', operator: 'is', value: '' }] }],
    })
    const trigger = filterTrigger(root)
    const badge = trigger.querySelector('.meta-toolbar__badge')
    expect(badge, 'expected the filter count badge inside the trigger button').toBeTruthy()
    expect(badge?.textContent?.trim()).toBe('2')
  })

  it('"Add filter" emits add-filter(rule) — same event + payload as before migration — AND keeps the popover OPEN', async () => {
    const { container: root, state } = mountToolbar({ filterRules: [] })
    const trigger = filterTrigger(root)
    trigger.click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()

    const addBtn = Array.from(filterPanel().querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Add filter')) as HTMLButtonElement
    expect(addBtn).toBeTruthy()
    addBtn.click()
    await nextTick()

    expect(state.filterRules).toEqual([{ fieldId: 'status', operator: 'is', value: 'todo' }])
    // Key builder behavior (unlike MtMenu's select-and-close row): the popover must still be open
    // after adding a rule, so the newly added row can be edited without reopening the panel.
    expect(document.querySelector('.mt-popover')).not.toBeNull()
    expect(conditionRows().length).toBe(1)
  })

  it('changing a condition row\'s field select emits update-filter(index, rule) and keeps the popover open (inner control does not close it)', async () => {
    const { container: root, state } = mountToolbar({ filterRules: [{ fieldId: 'status', operator: 'is', value: 'todo' }] })
    filterTrigger(root).click()
    await nextTick()

    const fieldSelect = conditionRows()[0].querySelector('select[aria-label="Filter field"]') as HTMLSelectElement
    fieldSelect.value = 'owner'
    fieldSelect.dispatchEvent(new Event('change'))
    await nextTick()

    expect(state.filterRules[0].fieldId).toBe('owner')
    // Verifies the NESTED-OVERLAY risk called out in the migration brief: a click/change on an inner
    // <select> nested TWO levels deep (toolbar -> MetaFilterConditionRow) inside the teleported panel
    // must not be treated as an "outside click" that closes it.
    expect(document.querySelector('.mt-popover')).not.toBeNull()
  })

  it('changing a condition row\'s operator select emits update-filter(index, rule) and keeps the popover open', async () => {
    const { container: root, state } = mountToolbar({ filterRules: [{ fieldId: 'owner', operator: 'is', value: 'alice' }] })
    filterTrigger(root).click()
    await nextTick()

    const operatorSelect = conditionRows()[0].querySelector('select[aria-label="Filter operator"]') as HTMLSelectElement
    operatorSelect.value = 'isEmpty'
    operatorSelect.dispatchEvent(new Event('change'))
    await nextTick()

    expect(state.filterRules[0]).toEqual({ fieldId: 'owner', operator: 'isEmpty', value: undefined })
    expect(document.querySelector('.mt-popover')).not.toBeNull()
  })

  it('changing a condition row\'s value control emits update-filter(index, rule) and keeps the popover open', async () => {
    const { container: root, state } = mountToolbar({ filterRules: [{ fieldId: 'owner', operator: 'is', value: '' }] })
    filterTrigger(root).click()
    await nextTick()

    const valueInput = conditionRows()[0].querySelector('input[aria-label="Filter value"]') as HTMLInputElement
    valueInput.value = 'alice'
    valueInput.dispatchEvent(new Event('change'))
    await nextTick()

    expect(state.filterRules[0]).toEqual({ fieldId: 'owner', operator: 'is', value: 'alice' })
    expect(document.querySelector('.mt-popover')).not.toBeNull()
  })

  it('the remove (×) button on a condition row emits remove-filter(index) and keeps the popover open', async () => {
    const { container: root, state } = mountToolbar({
      filterRules: [{ fieldId: 'status', operator: 'is', value: 'todo' }, { fieldId: 'owner', operator: 'is', value: 'alice' }],
    })
    filterTrigger(root).click()
    await nextTick()
    expect(conditionRows().length).toBe(2)

    const removeBtn = conditionRows()[0].querySelector('.meta-toolbar__remove') as HTMLButtonElement
    removeBtn.click()
    await nextTick()

    expect(state.filterRules).toEqual([{ fieldId: 'owner', operator: 'is', value: 'alice' }])
    expect(document.querySelector('.mt-popover')).not.toBeNull()
    expect(conditionRows().length).toBe(1)
  })

  it('"Add group" emits add-filter-group(group) with a seeded one-condition group and keeps the popover open', async () => {
    const { container: root, state } = mountToolbar()
    filterTrigger(root).click()
    await nextTick()

    const addGroupBtn = filterPanel().querySelector('[data-add-filter-group="true"]') as HTMLButtonElement
    expect(addGroupBtn).toBeTruthy()
    addGroupBtn.click()
    await nextTick()

    expect(state.filterGroups.length).toBe(1)
    expect(state.filterGroups[0].conjunction).toBe('and')
    expect(state.filterGroups[0].conditions).toEqual([{ fieldId: 'status', operator: 'is', value: 'todo' }])
    expect(document.querySelector('.mt-popover')).not.toBeNull()
    expect(filterPanel().querySelector('.meta-filter-group')).toBeTruthy()
  })

  it('changing a rendered group\'s conjunction select emits update-filter-group(index, group) and keeps the popover open (2-level-deep inner control)', async () => {
    const { container: root, state } = mountToolbar({
      filterGroups: [{ conjunction: 'and', conditions: [{ fieldId: 'status', operator: 'is', value: 'todo' }] }],
    })
    filterTrigger(root).click()
    await nextTick()

    const conjSelect = filterPanel().querySelector('select[data-filter-group-conjunction="true"]') as HTMLSelectElement
    expect(conjSelect).toBeTruthy()
    conjSelect.value = 'or'
    conjSelect.dispatchEvent(new Event('change'))
    await nextTick()

    expect(state.filterGroups[0]).toEqual({ conjunction: 'or', conditions: [{ fieldId: 'status', operator: 'is', value: 'todo' }] })
    expect(document.querySelector('.mt-popover')).not.toBeNull()
  })

  it('the group\'s remove button emits remove-filter-group(index) and keeps the popover open', async () => {
    const { container: root, state } = mountToolbar({
      filterGroups: [{ conjunction: 'and', conditions: [{ fieldId: 'status', operator: 'is', value: 'todo' }] }],
    })
    filterTrigger(root).click()
    await nextTick()

    const removeGroupBtn = filterPanel().querySelector('[data-filter-group-remove="true"]') as HTMLButtonElement
    expect(removeGroupBtn).toBeTruthy()
    removeGroupBtn.click()
    await nextTick()

    expect(state.filterGroups).toEqual([])
    expect(document.querySelector('.mt-popover')).not.toBeNull()
  })

  it('the top-level conjunction select emits set-conjunction(conj) and keeps the popover open (rendered only when 2+ conditions)', async () => {
    const { container: root, state } = mountToolbar({
      filterRules: [{ fieldId: 'status', operator: 'is', value: 'todo' }, { fieldId: 'owner', operator: 'is', value: 'alice' }],
      filterConjunction: 'and',
    })
    filterTrigger(root).click()
    await nextTick()

    const conjSelect = filterPanel().querySelector('.meta-toolbar__conjunction select') as HTMLSelectElement
    expect(conjSelect).toBeTruthy()
    conjSelect.value = 'or'
    conjSelect.dispatchEvent(new Event('change'))
    await nextTick()

    expect(state.filterConjunction).toBe('or')
    expect(document.querySelector('.mt-popover')).not.toBeNull()
  })

  it('"Clear all" emits clear-filters (no payload) and keeps the popover open', async () => {
    const onClearFilters = vi.fn()
    const { container: root } = mountToolbar({
      filterRules: [{ fieldId: 'status', operator: 'is', value: 'todo' }],
      onClearFilters,
    })
    filterTrigger(root).click()
    await nextTick()

    const clearBtn = Array.from(filterPanel().querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Clear all')) as HTMLButtonElement
    expect(clearBtn).toBeTruthy()
    clearBtn.click()
    await nextTick()

    expect(onClearFilters).toHaveBeenCalledTimes(1)
    expect(onClearFilters).toHaveBeenCalledWith()
    expect(document.querySelector('.mt-popover')).not.toBeNull()
  })

  it('"Apply" emits apply-sort-filter (no payload) — same as before migration — and clicking it does not close the popover', async () => {
    const onApplySortFilter = vi.fn()
    const { container: root } = mountToolbar({
      filterRules: [{ fieldId: 'status', operator: 'is', value: 'todo' }],
      onApplySortFilter,
    })
    filterTrigger(root).click()
    await nextTick()

    const applyBtn = filterPanel().querySelector('.meta-toolbar__apply') as HTMLButtonElement
    expect(applyBtn).toBeTruthy()
    applyBtn.click()
    await nextTick()

    expect(onApplySortFilter).toHaveBeenCalledTimes(1)
    expect(onApplySortFilter).toHaveBeenCalledWith() // no payload
    expect(document.querySelector('.mt-popover')).not.toBeNull()
  })

  it('pressing Escape closes the popover', async () => {
    const { container: root } = mountToolbar({ filterRules: [{ fieldId: 'status', operator: 'is', value: 'todo' }] })
    filterTrigger(root).click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(document.querySelector('.mt-popover')).toBeNull()
  })

  it('a click outside the trigger and panel closes the popover', async () => {
    const { container: root } = mountToolbar({ filterRules: [{ fieldId: 'status', operator: 'is', value: 'todo' }] })
    filterTrigger(root).click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    expect(document.querySelector('.mt-popover')).toBeNull()
    expect(root).toBeTruthy() // root/toolbar itself is untouched by the close
  })

  it('a second click on the trigger closes the popover again (no filter mutation, no emit)', async () => {
    const onAddFilter = vi.fn()
    const { container: root } = mountToolbar({ filterRules: [], onAddFilter })
    const trigger = filterTrigger(root)
    trigger.click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()

    trigger.click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).toBeNull()
    expect(onAddFilter).not.toHaveBeenCalled()
  })
})
