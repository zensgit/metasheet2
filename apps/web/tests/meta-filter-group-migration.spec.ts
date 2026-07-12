import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import MetaFilterGroup from '../src/multitable/components/MetaFilterGroup.vue'
import type { FilterGroup } from '../src/multitable/composables/useMultitableGrid'
import type { MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c T3 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T3, RATIFIED):
// MetaFilterGroup's add-condition / add-group inline links — both sharers of the old
// `.meta-filter-group__add` class — are now <MtLink>. Both were migrated together, so the bespoke
// #409eff CSS was removed (no double-styling). Behavior-preservation proof: both stay native,
// keyboard-operable <button>s (now class `mt-link`, `data-filter-group-add-*` attrs still fall
// through); clicking each still emits `update:modelValue` with the SAME appended payload as the
// pre-migration bespoke <button>s (mirrors meta-filter-group.spec.ts's own add-condition/add-group
// assertions, scoped here to prove the swap didn't change behavior).

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

function mountGroup(group: FilterGroup) {
  const state = reactive<{ emitted: FilterGroup | null }>({ emitted: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      return () => h(MetaFilterGroup, {
        modelValue: group,
        fields: FIELDS,
        depth: 1,
        removable: true,
        'onUpdate:modelValue': (g: FilterGroup) => { state.emitted = g },
      })
    },
  })
  app.mount(container)
  return { state, root: container }
}

const addConditionBtn = (root: HTMLElement) => root.querySelector('[data-filter-group-add-condition="true"]') as HTMLButtonElement
const addGroupBtn = (root: HTMLElement) => root.querySelector('[data-filter-group-add-group="true"]') as HTMLButtonElement

describe('MetaFilterGroup — MtLink migration (UI-P2-1c T3)', () => {
  it('renders add-condition and add-group as native <button class="mt-link">s; bespoke class fully removed', () => {
    const { root } = mountGroup({ conjunction: 'and', conditions: [{ fieldId: 'amount', operator: 'is', value: 1 }] })
    expect(addConditionBtn(root).tagName).toBe('BUTTON')
    expect(addGroupBtn(root).tagName).toBe('BUTTON')
    expect(addConditionBtn(root).classList.contains('mt-link')).toBe(true)
    expect(addGroupBtn(root).classList.contains('mt-link')).toBe(true)
    expect(root.querySelector('.meta-filter-group__add')).toBeNull() // bespoke class gone, not just unused
  })

  it('add-condition click still appends a seeded leaf and emits the same shape as before migration', async () => {
    const { state, root } = mountGroup({ conjunction: 'and', conditions: [{ fieldId: 'amount', operator: 'is', value: 1 }] })
    addConditionBtn(root).click()
    await nextTick()
    expect(state.emitted?.conditions.length).toBe(2)
    expect(state.emitted?.conditions[0]).toEqual({ fieldId: 'amount', operator: 'is', value: 1 }) // original untouched
  })

  it('add-group click still appends a nested group and emits the same shape as before migration', async () => {
    const { state, root } = mountGroup({ conjunction: 'and', conditions: [{ fieldId: 'amount', operator: 'is', value: 1 }] })
    addGroupBtn(root).click()
    await nextTick()
    expect(state.emitted?.conditions.length).toBe(2)
    expect(state.emitted?.conditions[1]).toEqual({ conjunction: 'and', conditions: [{ fieldId: 'status', operator: 'is', value: 'todo' }] })
  })
})
