import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import MetaFilterGroup from '../src/multitable/components/MetaFilterGroup.vue'
import { MAX_FILTER_DEPTH, isFilterGroup, type FilterGroup } from '../src/multitable/composables/useMultitableGrid'
import type { MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

const FIELDS: MetaField[] = [
  { id: 'status', name: 'Status', type: 'select', options: [{ value: 'todo' }, { value: 'done' }] },
  { id: 'amount', name: 'Amount', type: 'number' },
]

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount(); app = null
  container?.remove(); container = null
  useLocale().setLocale('en')
})

function mountGroup(group: FilterGroup, depth = 1) {
  const state = reactive<{ emitted: FilterGroup | null; removed: boolean }>({ emitted: null, removed: false })
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      return () => h(MetaFilterGroup, {
        modelValue: group,
        fields: FIELDS,
        depth,
        removable: true,
        'onUpdate:modelValue': (g: FilterGroup) => { state.emitted = g },
        onRemove: () => { state.removed = true },
      })
    },
  })
  app.mount(container)
  return { state, root: container }
}

describe('MetaFilterGroup (recursive nested-group editor)', () => {
  it('renders the conjunction, a condition row, and add-condition/add-group actions', () => {
    const { root } = mountGroup({ conjunction: 'and', conditions: [{ fieldId: 'amount', operator: 'is', value: 1 }] })
    expect(root.querySelector('select[data-filter-group-conjunction="true"]')).toBeTruthy()
    expect(root.querySelector('.meta-toolbar__filter-rule')).toBeTruthy() // the leaf row (MetaFilterConditionRow)
    expect(root.querySelector('[data-filter-group-add-condition="true"]')).toBeTruthy()
    expect(root.querySelector('[data-filter-group-add-group="true"]')).toBeTruthy()
  })

  it('add-condition appends a seeded leaf and emits the updated group', async () => {
    const { state, root } = mountGroup({ conjunction: 'and', conditions: [{ fieldId: 'amount', operator: 'is', value: 1 }] })
    ;(root.querySelector('[data-filter-group-add-condition="true"]') as HTMLButtonElement).click()
    await nextTick()
    expect(state.emitted?.conditions.length).toBe(2)
    expect(isFilterGroup(state.emitted!.conditions[1])).toBe(false) // a leaf
  })

  it('add-group appends a nested group (with one seeded condition) and emits', async () => {
    const { state, root } = mountGroup({ conjunction: 'and', conditions: [{ fieldId: 'amount', operator: 'is', value: 1 }] })
    ;(root.querySelector('[data-filter-group-add-group="true"]') as HTMLButtonElement).click()
    await nextTick()
    expect(state.emitted?.conditions.length).toBe(2)
    const added = state.emitted!.conditions[1]
    expect(isFilterGroup(added)).toBe(true)
    expect((added as FilterGroup).conditions.length).toBe(1)
  })

  it('changing the conjunction emits the new conjunction, preserving conditions', async () => {
    const { state, root } = mountGroup({ conjunction: 'and', conditions: [{ fieldId: 'amount', operator: 'is', value: 1 }] })
    const sel = root.querySelector('select[data-filter-group-conjunction="true"]') as HTMLSelectElement
    sel.value = 'or'; sel.dispatchEvent(new Event('change')); await nextTick()
    expect(state.emitted).toEqual({ conjunction: 'or', conditions: [{ fieldId: 'amount', operator: 'is', value: 1 }] })
  })

  it('removing a child emits the group without it', async () => {
    const { state, root } = mountGroup({ conjunction: 'and', conditions: [{ fieldId: 'amount', operator: 'is', value: 1 }, { fieldId: 'status', operator: 'is', value: 'todo' }] })
    ;(root.querySelector('.meta-toolbar__filter-rule .meta-toolbar__remove') as HTMLButtonElement).click()
    await nextTick()
    expect(state.emitted?.conditions.map((c) => (isFilterGroup(c) ? 'g' : c.fieldId))).toEqual(['status'])
  })

  it('renders nested subgroups recursively', () => {
    const { root } = mountGroup({
      conjunction: 'and',
      conditions: [
        { fieldId: 'amount', operator: 'is', value: 1 },
        { conjunction: 'or', conditions: [{ fieldId: 'status', operator: 'is', value: 'todo' }] },
      ],
    })
    // outer group + one nested group = two .meta-filter-group elements
    expect(root.querySelectorAll('.meta-filter-group').length).toBe(2)
  })

  it('hides add-group at the backend depth cap (no UI authoring of a filter the server would reject)', () => {
    const deep = mountGroup({ conjunction: 'and', conditions: [{ fieldId: 'amount', operator: 'is', value: 1 }] }, MAX_FILTER_DEPTH - 1)
    expect(deep.root.querySelector('[data-filter-group-add-group="true"]')).toBeNull() // depth+1 === MAX → capped
    expect(deep.root.querySelector('[data-filter-group-add-condition="true"]')).toBeTruthy() // conditions still allowed
  })
})
