import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import MetaToolbar from '../src/multitable/components/MetaToolbar.vue'
import type { SortRule } from '../src/multitable/composables/useMultitableGrid'
import type { MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c slice-4: MetaToolbar's sort ("排序") dropdown was migrated from a hand-rolled
// `showSortPanel` ref + `.meta-toolbar__dropdown`/`.meta-toolbar__panel` sort-rule BUILDER to the
// shared MtPopover primitive (NOT MtMenu, NOT MtMenuItem rows — this is a complex builder with
// add/remove/update sort-rule rows + apply, and its panel markup is preserved verbatim). This is an
// interaction-preservation proof: the trigger must open the popover, the builder rows must still
// render as native <select>/<button> controls, every add/remove/update/apply interaction must still
// emit the exact same event name + payload it emitted before migration, the popover must stay OPEN
// through builder interactions (a builder must not close mid-edit, unlike MtMenu's select-and-close
// row semantics), and Escape / click-outside must still close it.

// Track EVERY mount (see meta-toolbar-hide-fields-mtpopover-migration.spec.ts): a shared global app
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
  { id: 'status', name: 'Status', type: 'select', options: [{ value: 'a' }] },
  { id: 'owner', name: 'Owner', type: 'string' },
]

function mountToolbar(initial: { sortRules?: SortRule[] } & Record<string, unknown> = {}) {
  const state = reactive<{ sortRules: SortRule[] }>({
    sortRules: initial.sortRules ?? [],
  })
  const { sortRules: _ignored, ...rest } = initial

  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(MetaToolbar, {
    fields: FIELDS, hiddenFieldIds: [], filterRules: [], filterConjunction: 'and',
    canCreateRecord: true, canExport: true, canUndo: true, canRedo: true, sortFilterDirty: false,
    sortRules: state.sortRules,
    onAddSort: (rule: SortRule) => { state.sortRules.push(rule) },
    onRemoveSort: (fieldId: string) => { state.sortRules = state.sortRules.filter((r) => r.fieldId !== fieldId) },
    onUpdateSort: (index: number, rule: SortRule) => { state.sortRules[index] = rule },
    ...rest,
  }) })
  app.mount(container)
  mounts.push({ app, container })
  return { container, state }
}

function sortTrigger(root: HTMLElement): HTMLButtonElement {
  const btn = root.querySelector('button[title="Sort"]') as HTMLButtonElement | null
  expect(btn, 'expected a <button title="Sort"> trigger').toBeTruthy()
  return btn as HTMLButtonElement
}

function sortRuleRows(): HTMLDivElement[] {
  return Array.from(document.querySelectorAll('.meta-toolbar__sort-rule')) as HTMLDivElement[]
}

describe('MetaToolbar sort builder — MtPopover migration (UI-P2-1c slice-4)', () => {
  it('is closed until the trigger is clicked; clicking it opens the popover with the builder content', async () => {
    const { container: root } = mountToolbar({ sortRules: [{ fieldId: 'status', direction: 'asc' }] })
    expect(document.querySelector('.mt-popover')).toBeNull()

    const trigger = sortTrigger(root)
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.getAttribute('aria-label')).toBe('Sort')
    trigger.click()
    await nextTick()

    expect(document.querySelector('.mt-popover')).not.toBeNull()
    const rows = sortRuleRows()
    expect(rows.length).toBe(1)
    expect(rows[0].querySelectorAll('select').length).toBe(2) // field select + direction select
    expect(document.querySelector('.meta-toolbar__add')).not.toBeNull() // "Add sort" button
  })

  it('shows the sort-rule-count badge on the trigger, same as before migration', async () => {
    const { container: root } = mountToolbar({
      sortRules: [{ fieldId: 'status', direction: 'asc' }, { fieldId: 'owner', direction: 'desc' }],
    })
    const trigger = sortTrigger(root)
    const badge = trigger.querySelector('.meta-toolbar__badge')
    expect(badge, 'expected the sort-rule-count badge inside the trigger button').toBeTruthy()
    expect(badge?.textContent?.trim()).toBe('2')
  })

  it('"Add sort" emits add-sort(rule) — same event + payload as before migration — AND keeps the popover OPEN', async () => {
    const { container: root, state } = mountToolbar({ sortRules: [] })
    const trigger = sortTrigger(root)
    trigger.click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()

    const addBtn = document.querySelector('.meta-toolbar__add') as HTMLButtonElement
    expect(addBtn).toBeTruthy()
    addBtn.click()
    await nextTick()

    expect(state.sortRules).toEqual([{ fieldId: 'status', direction: 'asc' }])
    // Key builder behavior (unlike MtMenu's select-and-close row): the popover must still be open
    // after adding a rule, so the newly added row can be edited without reopening the panel.
    expect(document.querySelector('.mt-popover')).not.toBeNull()
    expect(sortRuleRows().length).toBe(1)
  })

  it('changing the field select emits update-sort(index, rule) and keeps the popover open (inner control does not close it)', async () => {
    const { container: root, state } = mountToolbar({ sortRules: [{ fieldId: 'status', direction: 'asc' }] })
    sortTrigger(root).click()
    await nextTick()

    const fieldSelect = sortRuleRows()[0].querySelectorAll('select')[0] as HTMLSelectElement
    fieldSelect.value = 'owner'
    fieldSelect.dispatchEvent(new Event('change'))
    await nextTick()

    expect(state.sortRules[0]).toEqual({ fieldId: 'owner', direction: 'asc' })
    // Verifies the NESTED-OVERLAY risk called out in the migration brief: a click/change on an inner
    // <select> inside the teleported panel must not be treated as an "outside click" that closes it.
    expect(document.querySelector('.mt-popover')).not.toBeNull()
  })

  it('changing the direction select emits update-sort(index, rule) and keeps the popover open', async () => {
    const { container: root, state } = mountToolbar({ sortRules: [{ fieldId: 'status', direction: 'asc' }] })
    sortTrigger(root).click()
    await nextTick()

    const dirSelect = sortRuleRows()[0].querySelectorAll('select')[1] as HTMLSelectElement
    dirSelect.value = 'desc'
    dirSelect.dispatchEvent(new Event('change'))
    await nextTick()

    expect(state.sortRules[0]).toEqual({ fieldId: 'status', direction: 'desc' })
    expect(document.querySelector('.mt-popover')).not.toBeNull()
  })

  it('the remove (×) button emits remove-sort(fieldId) and keeps the popover open', async () => {
    const { container: root, state } = mountToolbar({
      sortRules: [{ fieldId: 'status', direction: 'asc' }, { fieldId: 'owner', direction: 'desc' }],
    })
    sortTrigger(root).click()
    await nextTick()
    expect(sortRuleRows().length).toBe(2)

    const removeBtn = sortRuleRows()[0].querySelector('.meta-toolbar__remove') as HTMLButtonElement
    removeBtn.click()
    await nextTick()

    expect(state.sortRules).toEqual([{ fieldId: 'owner', direction: 'desc' }])
    expect(document.querySelector('.mt-popover')).not.toBeNull()
    expect(sortRuleRows().length).toBe(1)
  })

  it('"Apply" emits apply-sort-filter (no payload) — same as before migration — and clicking it does not close the popover', async () => {
    const onApplySortFilter = vi.fn()
    const { container: root } = mountToolbar({
      sortRules: [{ fieldId: 'status', direction: 'asc' }],
      onApplySortFilter,
    })
    sortTrigger(root).click()
    await nextTick()

    const applyBtn = document.querySelector('.meta-toolbar__apply') as HTMLButtonElement
    expect(applyBtn).toBeTruthy()
    applyBtn.click()
    await nextTick()

    expect(onApplySortFilter).toHaveBeenCalledTimes(1)
    expect(onApplySortFilter).toHaveBeenCalledWith() // no payload
    expect(document.querySelector('.mt-popover')).not.toBeNull()
  })

  it('pressing Escape closes the popover', async () => {
    const { container: root } = mountToolbar({ sortRules: [{ fieldId: 'status', direction: 'asc' }] })
    sortTrigger(root).click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(document.querySelector('.mt-popover')).toBeNull()
  })

  it('a click outside the trigger and panel closes the popover', async () => {
    const { container: root } = mountToolbar({ sortRules: [{ fieldId: 'status', direction: 'asc' }] })
    sortTrigger(root).click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    expect(document.querySelector('.mt-popover')).toBeNull()
    expect(root).toBeTruthy() // root/toolbar itself is untouched by the close
  })

  it('a second click on the trigger closes the popover again (no sort mutation, no emit)', async () => {
    const onAddSort = vi.fn()
    const { container: root } = mountToolbar({ sortRules: [], onAddSort })
    const trigger = sortTrigger(root)
    trigger.click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).not.toBeNull()

    trigger.click()
    await nextTick()
    expect(document.querySelector('.mt-popover')).toBeNull()
    expect(onAddSort).not.toHaveBeenCalled()
  })
})
