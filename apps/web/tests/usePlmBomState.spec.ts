import { computed, nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { usePlmBomState } from '../src/views/plm/usePlmBomState'

function createBomState() {
  return usePlmBomState({
    defaultBomDepth: 2,
    bomDepthQuickOptions: [1, 2, 3],
    filterFieldOptions: [
      { value: 'all', label: '全部', placeholder: '编号/名称/行 ID' },
      { value: 'path', label: '路径 ID', placeholder: '路径 ID' },
    ],
    productId: ref('ROOT'),
    productView: computed(() => ({
      id: 'ROOT',
      name: 'Root Product',
      partNumber: 'ROOT-PN',
      revision: 'A',
      status: 'released',
      itemType: 'Part',
      description: '',
      createdAt: '',
      updatedAt: '',
    })),
    searchResultOptions: computed(() => []),
    resolveBomLineId: (item) => String(item?.id || ''),
    resolveBomChildId: (item) => String(item?.component_id || ''),
    resolveBomChildNumber: (item) => String(item?.component_code || ''),
    formatBomFindNum: (item) => String(item?.find_num || '-'),
    formatBomRefdes: (item) => String(item?.refdes || '-'),
    formatBomPathIds: (row) => row.pathIds.join(' / '),
    formatBomTablePathIds: (item) => {
      const childId = String(item?.component_id || item?.component_code || '')
      return childId ? `ROOT / ${childId}` : ''
    },
  })
}

describe('usePlmBomState', () => {
  it('filters by bom path and preserves table path export values', () => {
    const state = createBomState()
    state.bomItems.value = [
      { id: 'LINE-1', component_id: 'CHILD-A', component_code: 'PN-A', component_name: 'A' },
      { id: 'LINE-2', component_id: 'CHILD-B', component_code: 'PN-B', component_name: 'B' },
    ]

    state.bomFilterField.value = 'path'
    state.bomFilter.value = 'child-a'

    expect(state.bomFilteredItems.value).toHaveLength(1)
    expect(state.bomFilteredItems.value[0]?.id).toBe('LINE-1')
    expect(state.bomTablePathIdsList.value).toEqual(['ROOT / CHILD-A'])
  })

  it('resets selection when bom items change', async () => {
    const state = createBomState()
    state.bomItems.value = [{ id: 'LINE-1', component_id: 'CHILD-A' }]
    state.selectBomTableRow(state.bomItems.value[0]!)

    expect(state.bomSelectedCount.value).toBe(1)

    state.bomItems.value = [{ id: 'LINE-2', component_id: 'CHILD-B' }]
    await nextTick()

    expect(state.bomSelectedCount.value).toBe(0)
  })
})
