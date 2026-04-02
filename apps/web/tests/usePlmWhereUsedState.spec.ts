import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import { usePlmWhereUsedState } from '../src/views/plm/usePlmWhereUsedState'

function createWhereUsedState() {
  return usePlmWhereUsedState({
    defaultWhereUsedMaxLevels: 5,
    filterFieldOptions: [
      { value: 'all', label: '全部', placeholder: '父件/路径/关系 ID' },
      { value: 'path', label: '路径 ID', placeholder: '路径 ID' },
    ],
    getItemNumber: (item) => String(item?.item_number || item?.id || ''),
    getItemName: (item) => String(item?.name || ''),
    getWhereUsedLineValue: (entry, key) => String(entry?.relationship?.properties?.[key] || '-'),
    getWhereUsedRefdes: (entry) => String(entry?.relationship?.properties?.refdes || '-'),
    resolveWhereUsedParentId: (entry) =>
      String(entry?.parent?.id || entry?.relationship?.source_id || ''),
    formatWhereUsedEntryPathIds: (entry) =>
      Array.isArray(entry?.pathNodes)
        ? entry.pathNodes.map((node) => node.id || node.label).filter(Boolean).join(' / ')
        : '',
  })
}

describe('usePlmWhereUsedState', () => {
  it('filters by path and resolves selected parent ids', async () => {
    const state = createWhereUsedState()
    state.whereUsed.value = {
      item_id: 'ROOT',
      parents: [
        {
          level: 1,
          parent: { id: 'PARENT-1', item_number: 'PN-1', name: 'Parent 1' },
          relationship: {
            id: 'REL-1',
            source_id: 'PARENT-1',
            related_id: 'ROOT',
            properties: { quantity: 1, uom: 'EA', find_num: '10' },
          },
        },
      ],
    }
    await nextTick()

    state.whereUsedFilterField.value = 'path'
    state.whereUsedFilter.value = 'parent-1'

    expect(state.whereUsedFilteredRows.value).toHaveLength(1)

    state.selectWhereUsedTableRow(state.whereUsedFilteredRows.value[0]!)

    expect(state.whereUsedSelectedCount.value).toBe(1)
    expect(state.whereUsedSelectedParents.value).toEqual(['PARENT-1'])
  })

  it('clears collapsed and selected state when payload changes', async () => {
    const state = createWhereUsedState()
    state.whereUsed.value = {
      item_id: 'ROOT',
      parents: [
        {
          level: 1,
          parent: { id: 'PARENT-1', item_number: 'PN-1', name: 'Parent 1' },
          relationship: { id: 'REL-1', source_id: 'PARENT-1', related_id: 'ROOT' },
        },
      ],
    }
    await nextTick()

    state.whereUsedCollapsed.value = new Set(['ROOT'])
    state.whereUsedSelectedEntryKeys.value = new Set(['REL-1'])
    state.whereUsed.value = {
      item_id: 'ROOT',
      parents: [
        {
          level: 1,
          parent: { id: 'PARENT-2', item_number: 'PN-2', name: 'Parent 2' },
          relationship: { id: 'REL-2', source_id: 'PARENT-2', related_id: 'ROOT' },
        },
      ],
    }
    await nextTick()

    expect(state.whereUsedCollapsed.value.size).toBe(0)
    expect(state.whereUsedSelectedCount.value).toBe(0)
  })
})
