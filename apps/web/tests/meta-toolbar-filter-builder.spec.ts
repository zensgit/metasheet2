import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import MetaToolbar from '../src/multitable/components/MetaToolbar.vue'
import type { FilterConjunction, FilterRule, FilterGroup, SortRule } from '../src/multitable/composables/useMultitableGrid'
import { isFilterGroup } from '../src/multitable/composables/useMultitableGrid'
import type { MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

type ToolbarState = {
  fields: MetaField[]
  hiddenFieldIds: string[]
  sortRules: SortRule[]
  filterRules: FilterRule[]
  filterGroups: FilterGroup[]
  filterConjunction: FilterConjunction
  sortFilterDirty: boolean
}

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  // localeState is a module-level ref; the #1671 localStorage reinstall does
  // not reset it, so an explicit reset keeps the en-asserting tests above
  // independent of locale-mutating tests below.
  useLocale().setLocale('en')
})

function mountToolbar(initial: Partial<ToolbarState> = {}) {
  const state = reactive<ToolbarState>({
    fields: [
      {
        id: 'status',
        name: 'Status',
        type: 'select',
        options: [{ value: 'todo' }, { value: 'done' }],
      },
      { id: 'amount', name: 'Amount', type: 'number' },
      { id: 'approved', name: 'Approved', type: 'boolean' },
    ],
    hiddenFieldIds: [],
    sortRules: [],
    filterRules: [],
    filterGroups: [],
    filterConjunction: 'and',
    sortFilterDirty: false,
    ...initial,
  })

  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      return () => h(MetaToolbar, {
        ...state,
        canCreateRecord: true,
        canExport: true,
        canUndo: false,
        canRedo: false,
        onAddFilter: (rule: FilterRule) => { state.filterRules.push(rule) },
        onUpdateFilter: (index: number, rule: FilterRule) => { state.filterRules[index] = rule },
        onRemoveFilter: (index: number) => { state.filterRules.splice(index, 1) },
        onClearFilters: () => {
          state.filterRules = []
          state.filterConjunction = 'and'
        },
        onSetConjunction: (conjunction: FilterConjunction) => { state.filterConjunction = conjunction },
        onAddFilterGroup: (group: FilterGroup) => { state.filterGroups.push(group) },
        onUpdateFilterGroup: (index: number, group: FilterGroup) => { state.filterGroups[index] = group },
        onRemoveFilterGroup: (index: number) => { state.filterGroups.splice(index, 1) },
      })
    },
  })
  app.mount(container)
  return { state, container }
}

async function openFilterPanel(root: HTMLElement): Promise<HTMLElement> {
  const button = Array.from(root.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.includes('Filter')) as HTMLButtonElement | undefined
  expect(button).toBeTruthy()
  button?.click()
  await nextTick()
  const panel = root.querySelector('.meta-toolbar__panel--filter') as HTMLElement | null
  expect(panel).toBeTruthy()
  return panel!
}

async function setSelectValue(select: HTMLSelectElement, value: string): Promise<void> {
  select.value = value
  select.dispatchEvent(new Event('change'))
  await nextTick()
}

describe('MetaToolbar filter builder', () => {
  it('uses a select option dropdown and dirty apply copy for select filters', async () => {
    const { state, container: root } = mountToolbar({
      filterRules: [{ fieldId: 'status', operator: 'is', value: 'todo' }],
      sortFilterDirty: true,
    })

    const panel = await openFilterPanel(root)
    const valueSelect = panel.querySelector('select[aria-label="Filter value"]') as HTMLSelectElement | null

    expect(valueSelect).toBeTruthy()
    expect(Array.from(valueSelect!.options).map((option) => option.value)).toEqual(['', 'todo', 'done'])
    expect(panel.textContent).toContain('select')
    expect(panel.textContent).toContain('Apply filter changes')
    expect(panel.textContent).toContain('Filter changes are staged until applied.')

    await setSelectValue(valueSelect!, 'done')

    expect(state.filterRules[0]).toEqual({ fieldId: 'status', operator: 'is', value: 'done' })
  })

  it('hides value input for empty operators and restores a typed value control when needed', async () => {
    const { state, container: root } = mountToolbar({
      filterRules: [{ fieldId: 'amount', operator: 'greater', value: 5 }],
    })

    const panel = await openFilterPanel(root)
    const operatorSelect = panel.querySelector('select[aria-label="Filter operator"]') as HTMLSelectElement | null
    expect(panel.querySelector('input[aria-label="Filter value"]')?.getAttribute('type')).toBe('number')

    await setSelectValue(operatorSelect!, 'isEmpty')

    expect(state.filterRules[0]).toEqual({ fieldId: 'amount', operator: 'isEmpty', value: undefined })
    expect(panel.querySelector('[aria-label="Filter value"]')).toBeNull()
    expect(panel.textContent).toContain('no value needed')

    await setSelectValue(operatorSelect!, 'less')

    expect(state.filterRules[0]).toEqual({ fieldId: 'amount', operator: 'less', value: '' })
    expect(panel.querySelector('input[aria-label="Filter value"]')?.getAttribute('type')).toBe('number')
  })

  it('adds select and boolean filters with typed default values', async () => {
    const { state, container: root } = mountToolbar()

    const panel = await openFilterPanel(root)
    const addButton = Array.from(panel.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.includes('+ Add filter')) as HTMLButtonElement | undefined
    expect(addButton).toBeTruthy()

    addButton?.click()
    await nextTick()

    expect(state.filterRules[0]).toEqual({ fieldId: 'status', operator: 'is', value: 'todo' })

    const fieldSelect = panel.querySelector('select[aria-label="Filter field"]') as HTMLSelectElement | null
    await setSelectValue(fieldSelect!, 'approved')

    expect(state.filterRules[0]).toEqual({ fieldId: 'approved', operator: 'is', value: true })
    expect(panel.textContent).toContain('checkbox')
  })

  it('treats future multiSelect fields as option-backed filters', async () => {
    const { state, container: root } = mountToolbar({
      fields: [
        {
          id: 'tags',
          name: 'Tags',
          type: 'multiSelect' as MetaField['type'],
          options: [{ value: 'urgent' }, { value: 'vip' }],
        },
      ],
      filterRules: [],
    })

    const panel = await openFilterPanel(root)
    const addButton = Array.from(panel.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.includes('+ Add filter')) as HTMLButtonElement | undefined
    expect(addButton).toBeTruthy()

    addButton?.click()
    await nextTick()

    expect(state.filterRules[0]).toEqual({ fieldId: 'tags', operator: 'contains', value: 'urgent' })
    expect(panel.textContent).toContain('multi-select')

    const valueSelect = panel.querySelector('select[aria-label="Filter value"]') as HTMLSelectElement | null
    expect(valueSelect).toBeTruthy()
    expect(Array.from(valueSelect!.options).map((option) => option.value)).toEqual(['', 'urgent', 'vip'])
  })

  // 2b: nested condition groups — "+ Add condition group" + rendering a hydrated group
  it('emits add-filter-group with a seeded one-condition group when "Add condition group" is clicked', async () => {
    const { state, container: root } = mountToolbar()
    const panel = await openFilterPanel(root)
    const addGroup = panel.querySelector('[data-add-filter-group="true"]') as HTMLButtonElement | null
    expect(addGroup).toBeTruthy()
    addGroup!.click()
    await nextTick()
    expect(state.filterGroups.length).toBe(1)
    expect(state.filterGroups[0].conjunction).toBe('and')
    expect(state.filterGroups[0].conditions.length).toBe(1)
    expect(isFilterGroup(state.filterGroups[0].conditions[0])).toBe(false) // seeded leaf
  })

  it('renders a hydrated root subgroup as a recursive MetaFilterGroup', async () => {
    const { container: root } = mountToolbar({
      filterGroups: [{ conjunction: 'or', conditions: [{ fieldId: 'status', operator: 'is', value: 'todo' }] }],
    })
    const panel = await openFilterPanel(root)
    expect(panel.querySelector('.meta-filter-group')).toBeTruthy()
    expect(panel.querySelector('select[data-filter-group-conjunction="true"]')).toBeTruthy()
  })
})

async function openFilterPanelI18n(root: HTMLElement): Promise<HTMLElement> {
  const button = Array.from(root.querySelectorAll('.meta-toolbar__left button'))
    .find((b) => /Filter|筛选/.test(b.textContent ?? '')) as HTMLButtonElement | undefined
  expect(button).toBeTruthy()
  button?.click()
  await nextTick()
  const panel = root.querySelector('.meta-toolbar__panel--filter') as HTMLElement | null
  expect(panel).toBeTruthy()
  return panel!
}

describe('MetaToolbar i18n', () => {
  // mountToolbar() passes canCreateRecord:true + canExport:true, so the
  // capability-gated Import / Export / New Record controls render — this is
  // why the zh assertions for `导出 CSV` / `+ 新建记录` are reachable
  // (MD §7.2 capability-gating note).
  it('renders zh-CN toolbar chrome when locale is zh-CN', () => {
    useLocale().setLocale('zh-CN')
    const { container: root } = mountToolbar()
    const text = root.textContent ?? ''
    for (const zh of ['字段', '排序', '筛选', '分组', '导出 CSV', '+ 新建记录']) {
      expect(text).toContain(zh)
    }
    expect(text).not.toContain('Fields')
    expect(text).not.toContain('+ New Record')
    expect(root.querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe('表格工具栏')
    // search copy lives in attributes, not textContent — assert on the node.
    const search = root.querySelector('.meta-toolbar__search-input') as HTMLInputElement
    expect(search.getAttribute('placeholder')).toBe('搜索记录...')
    expect(search.getAttribute('aria-label')).toBe('搜索记录')
  })

  it('renders English toolbar chrome when locale is en', () => {
    useLocale().setLocale('en')
    const { container: root } = mountToolbar()
    const text = root.textContent ?? ''
    for (const en of ['Fields', 'Sort', 'Filter', 'Group', 'Export CSV', '+ New Record']) {
      expect(text).toContain(en)
    }
    expect(text).not.toContain('字段')
    const search = root.querySelector('.meta-toolbar__search-input') as HTMLInputElement
    expect(search.getAttribute('placeholder')).toBe('Search records...')
  })

  it('localizes the filter panel conjunction / options / type labels in zh-CN', async () => {
    useLocale().setLocale('zh-CN')
    const { container: root } = mountToolbar({
      filterRules: [
        { fieldId: 'status', operator: 'is', value: 'todo' },
        { fieldId: 'approved', operator: 'is', value: true },
      ],
      filterConjunction: 'and',
    })
    const panel = await openFilterPanelI18n(root)
    const text = panel.textContent ?? ''
    expect(text).toContain('当')             // Where (filterRules.length > 1)
    expect(text).toContain('全部')           // all (conjunction option)
    expect(text).toContain('条件匹配')       // conditions match
    expect(text).toContain('已勾选 / true')  // boolean option keeps literal token
    expect(text).toContain('未勾选 / false')
    expect(text).toContain('+ 添加筛选')     // + Add filter
    expect(text).toContain('全部清除')       // Clear all
    expect(text).toContain('单选')           // F2: select field-type label localized
    expect(text).toContain('复选框')         // F2: boolean field-type label localized
    // F4: filter-control aria labels localized
    expect(panel.querySelector('select[aria-label="筛选字段"]')).toBeTruthy()
    expect(panel.querySelector('select[aria-label="筛选运算符"]')).toBeTruthy()
    expect(text).not.toContain('conditions match')
  })

  it('localizes dirty apply copy in zh-CN', async () => {
    useLocale().setLocale('zh-CN')
    const { container: root } = mountToolbar({
      filterRules: [{ fieldId: 'status', operator: 'is', value: 'todo' }],
      sortFilterDirty: true,
    })
    const panel = await openFilterPanelI18n(root)
    expect(panel.textContent).toContain('应用筛选更改')
    expect(panel.textContent).toContain('筛选更改将在应用后生效。')
    expect(panel.textContent).not.toContain('Apply filter changes')
  })

  // 2a: isAnyOf/isNoneOf user-usable via a multi-select value control
  it('offers isAnyOf/isNoneOf for select fields', async () => {
    const { container: root } = mountToolbar({
      filterRules: [{ fieldId: 'status', operator: 'is', value: 'todo' }],
    })
    const panel = await openFilterPanel(root)
    const operatorSelect = panel.querySelector('select[aria-label="Filter operator"]') as HTMLSelectElement
    const ops = Array.from(operatorSelect.options).map((o) => o.value)
    expect(ops).toContain('isAnyOf')
    expect(ops).toContain('isNoneOf')
  })

  it('renders a multi-select for isAnyOf and emits an ARRAY value', async () => {
    const { state, container: root } = mountToolbar({
      filterRules: [{ fieldId: 'status', operator: 'isAnyOf', value: [] }],
    })
    const panel = await openFilterPanel(root)
    const multi = panel.querySelector('select[data-filter-multi-value="true"]') as HTMLSelectElement | null
    expect(multi).toBeTruthy()
    expect(multi!.multiple).toBe(true)
    expect(Array.from(multi!.options).map((o) => o.value)).toEqual(['todo', 'done'])
    multi!.options[0].selected = true
    multi!.options[1].selected = true
    multi!.dispatchEvent(new Event('change'))
    await nextTick()
    expect(state.filterRules[0]).toEqual({ fieldId: 'status', operator: 'isAnyOf', value: ['todo', 'done'] })
  })

  it('switching to isAnyOf seeds an empty ARRAY value (not a scalar)', async () => {
    const { state, container: root } = mountToolbar({
      filterRules: [{ fieldId: 'status', operator: 'is', value: 'todo' }],
    })
    const panel = await openFilterPanel(root)
    const operatorSelect = panel.querySelector('select[aria-label="Filter operator"]') as HTMLSelectElement
    await setSelectValue(operatorSelect, 'isAnyOf')
    expect(state.filterRules[0]).toEqual({ fieldId: 'status', operator: 'isAnyOf', value: [] })
  })

  // 2a: between — two-bound value control on numeric fields
  it('offers between for numeric fields and renders two-bound inputs emitting a [min,max] array', async () => {
    const { state, container: root } = mountToolbar({
      filterRules: [{ fieldId: 'amount', operator: 'between', value: [] }],
    })
    const panel = await openFilterPanel(root)
    const operatorSelect = panel.querySelector('select[aria-label="Filter operator"]') as HTMLSelectElement
    expect(Array.from(operatorSelect.options).map((o) => o.value)).toContain('between')
    const minInput = panel.querySelector('input[data-filter-between-min="true"]') as HTMLInputElement | null
    const maxInput = panel.querySelector('input[data-filter-between-max="true"]') as HTMLInputElement | null
    expect(minInput).toBeTruthy()
    expect(maxInput).toBeTruthy()
    minInput!.value = '10'
    minInput!.dispatchEvent(new Event('change'))
    await nextTick()
    maxInput!.value = '20'
    maxInput!.dispatchEvent(new Event('change'))
    await nextTick()
    expect(state.filterRules[0]).toEqual({ fieldId: 'amount', operator: 'between', value: ['10', '20'] })
  })

  it('switching to between seeds an empty array (two-bound, not scalar)', async () => {
    const { state, container: root } = mountToolbar({
      filterRules: [{ fieldId: 'amount', operator: 'greater', value: 5 }],
    })
    const panel = await openFilterPanel(root)
    const operatorSelect = panel.querySelector('select[aria-label="Filter operator"]') as HTMLSelectElement
    await setSelectValue(operatorSelect, 'between')
    expect(state.filterRules[0]).toEqual({ fieldId: 'amount', operator: 'between', value: [] })
  })

  // 2a: relative-date operators — date fields only (mirrors backend evaluateRelativeDateOp).
  const DATE_FIELD: MetaField[] = [{ id: 'due', name: 'Due', type: 'date' }]

  it('offers relative-date operators for date fields (valueless + N-window)', async () => {
    const { container: root } = mountToolbar({
      fields: DATE_FIELD,
      filterRules: [{ fieldId: 'due', operator: 'is', value: '' }],
    })
    const panel = await openFilterPanel(root)
    const operatorSelect = panel.querySelector('select[aria-label="Filter operator"]') as HTMLSelectElement
    const ops = Array.from(operatorSelect.options).map((o) => o.value)
    for (const op of ['isToday', 'isYesterday', 'isTomorrow', 'isThisWeek', 'isThisMonth', 'isOverdue', 'isLastNDays', 'isNextNDays']) {
      expect(ops).toContain(op)
    }
  })

  it('hides the value control for valueless relative-date operators (isToday)', async () => {
    const { container: root } = mountToolbar({
      fields: DATE_FIELD,
      filterRules: [{ fieldId: 'due', operator: 'isToday', value: undefined }],
    })
    const panel = await openFilterPanel(root)
    expect(panel.querySelector('.meta-toolbar__filter-empty-hint')).toBeTruthy()
    expect(panel.querySelector('input[data-filter-ndays="true"]')).toBeNull()
    expect(panel.querySelector('input.meta-toolbar__filter-value')).toBeNull()
  })

  it('switching to a valueless relative-date op clears the value (no control)', async () => {
    const { state, container: root } = mountToolbar({
      fields: DATE_FIELD,
      filterRules: [{ fieldId: 'due', operator: 'is', value: '2026-01-01' }],
    })
    const panel = await openFilterPanel(root)
    const operatorSelect = panel.querySelector('select[aria-label="Filter operator"]') as HTMLSelectElement
    await setSelectValue(operatorSelect, 'isThisWeek')
    expect(state.filterRules[0]).toEqual({ fieldId: 'due', operator: 'isThisWeek', value: undefined })
  })

  it('renders a positive-integer input for isLastNDays and emits a NUMERIC N', async () => {
    const { state, container: root } = mountToolbar({
      fields: DATE_FIELD,
      filterRules: [{ fieldId: 'due', operator: 'isLastNDays', value: 7 }],
    })
    const panel = await openFilterPanel(root)
    const nDaysInput = panel.querySelector('input[data-filter-ndays="true"]') as HTMLInputElement | null
    expect(nDaysInput).toBeTruthy()
    expect(nDaysInput!.type).toBe('number')
    expect(nDaysInput!.value).toBe('7')
    nDaysInput!.value = '14'
    nDaysInput!.dispatchEvent(new Event('change'))
    await nextTick()
    expect(state.filterRules[0]).toEqual({ fieldId: 'due', operator: 'isLastNDays', value: 14 })
  })

  it('switching to isNextNDays seeds a usable default window (N=7, not empty)', async () => {
    const { state, container: root } = mountToolbar({
      fields: DATE_FIELD,
      filterRules: [{ fieldId: 'due', operator: 'is', value: '2026-01-01' }],
    })
    const panel = await openFilterPanel(root)
    const operatorSelect = panel.querySelector('select[aria-label="Filter operator"]') as HTMLSelectElement
    await setSelectValue(operatorSelect, 'isNextNDays')
    expect(state.filterRules[0]).toEqual({ fieldId: 'due', operator: 'isNextNDays', value: 7 })
  })

  it('clearing the N-window input emits an empty (incomplete) window', async () => {
    const { state, container: root } = mountToolbar({
      fields: DATE_FIELD,
      filterRules: [{ fieldId: 'due', operator: 'isLastNDays', value: 7 }],
    })
    const panel = await openFilterPanel(root)
    const nDaysInput = panel.querySelector('input[data-filter-ndays="true"]') as HTMLInputElement
    nDaysInput.value = ''
    nDaysInput.dispatchEvent(new Event('change'))
    await nextTick()
    expect(state.filterRules[0]).toEqual({ fieldId: 'due', operator: 'isLastNDays', value: '' })
  })
})
