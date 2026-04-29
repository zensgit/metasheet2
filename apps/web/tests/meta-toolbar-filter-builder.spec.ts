import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import MetaToolbar from '../src/multitable/components/MetaToolbar.vue'
import type { FilterConjunction, FilterRule, SortRule } from '../src/multitable/composables/useMultitableGrid'
import type { MetaField } from '../src/multitable/types'

type ToolbarState = {
  fields: MetaField[]
  hiddenFieldIds: string[]
  sortRules: SortRule[]
  filterRules: FilterRule[]
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
})
