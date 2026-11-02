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

describe('usePlmBomState shared subassembly edges', () => {
  it('keeps one shared inner edge on each displayed path', () => {
    const state = createBomState()
    state.bomItems.value = [
      { id: 'RA', parent_item_id: 'ROOT', component_id: 'A', component_code: 'A', component_name: 'Branch A' },
      { id: 'AS', parent_item_id: 'A', component_id: 'S', component_code: 'S', component_name: 'Shared' },
      { id: 'L', parent_item_id: 'S', component_id: 'leaf', component_code: 'LEAF', component_name: 'Leaf', quantity: 7 },
      { id: 'RB', parent_item_id: 'ROOT', component_id: 'B', component_code: 'B', component_name: 'Branch B' },
      { id: 'BS', parent_item_id: 'B', component_id: 'S', component_code: 'S', component_name: 'Shared' },
      { id: 'L', parent_item_id: 'S', component_id: 'leaf', component_code: 'LEAF', component_name: 'Leaf', quantity: 7 },
    ]

    const rows = state.bomTreeRows.value
    const leafRows = rows.filter((row) => row.lineId === 'L')

    expect(state.bomItems.value.map((item) => item.id)).toEqual(['RA', 'AS', 'L', 'RB', 'BS', 'L'])
    expect(state.bomItems.value.map((item) => item.quantity ?? null)).toEqual([null, null, 7, null, null, 7])
    expect(rows).toHaveLength(7)
    expect(rows.map((row) => row.lineId)).toEqual(['', 'RA', 'AS', 'L', 'RB', 'BS', 'L'])
    expect(leafRows).toHaveLength(2)
    expect(rows.filter((row) => row.componentId === 'S')).toHaveLength(2)
    expect(rows.map((row) => row.key)).toEqual([
      'ROOT',
      'ROOT/RA',
      'ROOT/RA/AS',
      'ROOT/RA/AS/L',
      'ROOT/RB',
      'ROOT/RB/BS',
      'ROOT/RB/BS/L',
    ])
    expect(new Set(rows.map((row) => row.key)).size).toBe(7)
    expect(leafRows.map((row) => row.pathIds)).toEqual([
      ['ROOT', 'A', 'S', 'leaf'],
      ['ROOT', 'B', 'S', 'leaf'],
    ])
    expect(leafRows.map((row) => row.line?.quantity)).toEqual([7, 7])
  })

  it('keeps distinct real relationship ids for the same child on each path', () => {
    const state = createBomState()
    state.bomItems.value = [
      { id: 'RA', parent_item_id: 'ROOT', component_id: 'A', component_code: 'A' },
      { id: 'AS', parent_item_id: 'A', component_id: 'S', component_code: 'S' },
      { id: 'L1', parent_item_id: 'S', component_id: 'leaf', component_code: 'LEAF', find_num: '10', quantity: 1 },
      { id: 'L2', parent_item_id: 'S', component_id: 'leaf', component_code: 'LEAF', find_num: '20', quantity: 2 },
      { id: 'RB', parent_item_id: 'ROOT', component_id: 'B', component_code: 'B' },
      { id: 'BS', parent_item_id: 'B', component_id: 'S', component_code: 'S' },
      { id: 'L1', parent_item_id: 'S', component_id: 'leaf', component_code: 'LEAF', find_num: '10', quantity: 1 },
      { id: 'L2', parent_item_id: 'S', component_id: 'leaf', component_code: 'LEAF', find_num: '20', quantity: 2 },
    ]

    const leafRows = state.bomTreeRows.value.filter((row) => row.componentId === 'leaf')

    expect(leafRows).toHaveLength(4)
    expect(leafRows.map((row) => row.lineId)).toEqual(['L1', 'L2', 'L1', 'L2'])
    expect(new Set(leafRows.map((row) => row.key)).size).toBe(4)
    expect(leafRows.map((row) => row.pathIds)).toEqual([
      ['ROOT', 'A', 'S', 'leaf'],
      ['ROOT', 'A', 'S', 'leaf'],
      ['ROOT', 'B', 'S', 'leaf'],
      ['ROOT', 'B', 'S', 'leaf'],
    ])
  })

  it('does not collapse missing or empty real line ids by child id', () => {
    const state = createBomState()
    state.bomItems.value = [
      { id: 'RS', parent_item_id: 'ROOT', component_id: 'S', component_code: 'S' },
      { id: '', parent_item_id: 'S', component_id: 'leaf', component_code: 'LEAF', find_num: '10', quantity: 1 },
      { parent_item_id: 'S', component_id: 'leaf', component_code: 'LEAF', find_num: '20', quantity: 2 },
      { id: '', parent_item_id: 'S', component_id: 'leaf', component_code: 'LEAF', find_num: '30', quantity: 3 },
    ]

    const rows = state.bomTreeRows.value
    const leafRows = rows.filter((row) => row.componentId === 'leaf')

    expect(rows).toHaveLength(5)
    expect(leafRows).toHaveLength(3)
    expect(leafRows.map((row) => row.lineId)).toEqual(['', '', ''])
    expect(leafRows.map((row) => row.line?.quantity)).toEqual([1, 2, 3])
  })

  it('keeps the same real line id under different parents', () => {
    const state = createBomState()
    state.bomItems.value = [
      { id: 'RA', parent_item_id: 'ROOT', component_id: 'A', component_code: 'A', find_num: '1' },
      { id: 'RB', parent_item_id: 'ROOT', component_id: 'B', component_code: 'B', find_num: '2' },
      { id: 'SAME', parent_item_id: 'A', component_id: 'leaf', component_code: 'LEAF', quantity: 7 },
      { id: 'SAME', parent_item_id: 'B', component_id: 'leaf', component_code: 'LEAF', quantity: 7 },
    ]

    const leafRows = state.bomTreeRows.value.filter((row) => row.lineId === 'SAME')

    expect(leafRows).toHaveLength(2)
    expect(leafRows.map((row) => row.pathIds)).toEqual([
      ['ROOT', 'A', 'leaf'],
      ['ROOT', 'B', 'leaf'],
    ])
    expect(leafRows.map((row) => row.line?.quantity)).toEqual([7, 7])
  })

  it('does not collapse real ids that only collide as a joined parent key', () => {
    const state = createBomState()
    state.bomItems.value = [
      { id: 'EDGE-S', parent_item_id: 'ROOT', component_id: 'S', component_code: 'S', find_num: '1' },
      { id: 'L|x', parent_item_id: 'S', component_id: 'child-b', component_code: 'CB', quantity: 2 },
      { id: 'EDGE-SL', parent_item_id: 'ROOT', component_id: 'S|L', component_code: 'SL', find_num: '2' },
      { id: 'x', parent_item_id: 'S|L', component_id: 'child-a', component_code: 'CA', quantity: 1 },
    ]

    const lineRows = state.bomTreeRows.value.filter((row) => row.line)

    expect(lineRows.map((row) => row.lineId)).toEqual(['EDGE-S', 'L|x', 'EDGE-SL', 'x'])
    expect(lineRows[1]?.line?.quantity).toBe(2)
    expect(lineRows[3]?.line?.quantity).toBe(1)
  })
})

describe('usePlmBomState applied depth snapshot', () => {
  it('starts with null applied depth and keeps callers unbounded', () => {
    const state = createBomState()
    const lines = [
      { id: 'RS', parent_item_id: 'ROOT', component_id: 'S', component_code: 'S', component_name: 'Shared', quantity: 2 },
      { id: 'L', parent_item_id: 'S', component_id: 'leaf', component_code: 'LEAF', component_name: 'Leaf', quantity: 7 },
      { id: 'RA', parent_item_id: 'ROOT', component_id: 'A', component_code: 'A', component_name: 'Branch A', quantity: 3 },
      { id: 'AB', parent_item_id: 'A', component_id: 'B', component_code: 'B', component_name: 'Branch B', quantity: 4 },
      { id: 'BS', parent_item_id: 'B', component_id: 'S', component_code: 'S', component_name: 'Shared', quantity: 5 },
    ]

    expect(state.bomAppliedDepth.value).toBe(null)
    expect(state.bomDepth.value).toBe(2)

    state.bomItems.value = lines
    const rows = state.bomTreeRows.value
    const leafRows = rows.filter((row) => row.lineId === 'L')

    expect(state.bomAppliedDepth.value).toBe(null)
    expect(state.bomItems.value).toHaveLength(5)
    expect(rows).toHaveLength(7)
    expect(rows.filter((row) => row.line)).toHaveLength(6)
    expect(rows.filter((row) => row.depth === 4)).toHaveLength(1)
    expect(rows.find((row) => row.depth === 4)?.key).toBe('ROOT/RA/AB/BS/L')
    expect(leafRows).toHaveLength(2)
    expect(leafRows.map((row) => row.depth)).toEqual([4, 2])
    expect(leafRows.map((row) => row.pathIds)).toEqual([
      ['ROOT', 'A', 'B', 'S', 'leaf'],
      ['ROOT', 'S', 'leaf'],
    ])
    expect(leafRows.map((row) => row.line?.quantity)).toEqual([7, 7])
    expect(rows.map((row) => row.line?.quantity ?? null)).toEqual([null, 3, 4, 5, 7, 2, 7])
    expect(rows.map((row) => row.key)).toEqual([
      'ROOT',
      'ROOT/RA',
      'ROOT/RA/AB',
      'ROOT/RA/AB/BS',
      'ROOT/RA/AB/BS/L',
      'ROOT/RS',
      'ROOT/RS/L',
    ])
    expect(new Set(rows.map((row) => row.key)).size).toBe(7)
  })

  it('keeps applied depth 3 at six rows without a depth-4 phantom', () => {
    const state = createBomState()
    state.bomAppliedDepth.value = 3
    state.bomItems.value = [
      { id: 'RS', parent_item_id: 'ROOT', component_id: 'S', component_code: 'S', component_name: 'Shared', quantity: 2 },
      { id: 'L', parent_item_id: 'S', component_id: 'leaf', component_code: 'LEAF', component_name: 'Leaf', quantity: 7 },
      { id: 'RA', parent_item_id: 'ROOT', component_id: 'A', component_code: 'A', component_name: 'Branch A', quantity: 3 },
      { id: 'AB', parent_item_id: 'A', component_id: 'B', component_code: 'B', component_name: 'Branch B', quantity: 4 },
      { id: 'BS', parent_item_id: 'B', component_id: 'S', component_code: 'S', component_name: 'Shared', quantity: 5 },
    ]

    const rows = state.bomTreeRows.value
    const leafRows = rows.filter((row) => row.lineId === 'L')
    const sharedRows = rows.filter((row) => row.componentId === 'S')

    expect(state.bomItems.value).toHaveLength(5)
    expect(rows).toHaveLength(6)
    expect(rows.filter((row) => row.line)).toHaveLength(5)
    expect(rows.filter((row) => row.depth === 4)).toHaveLength(0)
    expect(rows.some((row) => row.pathIds.join('/') === 'ROOT/A/B/S/leaf')).toBe(false)
    expect(leafRows).toHaveLength(1)
    expect(leafRows[0]?.depth).toBe(2)
    expect(leafRows[0]?.pathIds).toEqual(['ROOT', 'S', 'leaf'])
    expect(leafRows[0]?.line?.quantity).toBe(7)
    expect(sharedRows.map((row) => row.lineId)).toEqual(['BS', 'RS'])
    expect(sharedRows.map((row) => row.line?.quantity)).toEqual([5, 2])
    expect(sharedRows.map((row) => row.depth)).toEqual([3, 1])
    expect(sharedRows[0]?.hasChildren).toBe(false)
    expect(rows.map((row) => row.lineId)).toEqual(['', 'RA', 'AB', 'BS', 'RS', 'L'])
    expect(rows.map((row) => row.line?.quantity ?? null)).toEqual([null, 3, 4, 5, 2, 7])
    expect(rows.map((row) => row.pathIds)).toEqual([
      ['ROOT'],
      ['ROOT', 'A'],
      ['ROOT', 'A', 'B'],
      ['ROOT', 'A', 'B', 'S'],
      ['ROOT', 'S'],
      ['ROOT', 'S', 'leaf'],
    ])
    expect(rows.map((row) => row.key)).toEqual([
      'ROOT',
      'ROOT/RA',
      'ROOT/RA/AB',
      'ROOT/RA/AB/BS',
      'ROOT/RS',
      'ROOT/RS/L',
    ])
    expect(new Set(rows.map((row) => row.key)).size).toBe(6)
  })

  it('keeps applied depth 2 on ROOT-S-L and ROOT-A-S at five rows', () => {
    const state = createBomState()
    state.bomItems.value = [
      { id: 'RS', parent_item_id: 'ROOT', component_id: 'S', component_code: 'S', component_name: 'Shared', quantity: 2 },
      { id: 'L', parent_item_id: 'S', component_id: 'leaf', component_code: 'LEAF', component_name: 'Leaf', quantity: 7 },
      { id: 'RA', parent_item_id: 'ROOT', component_id: 'A', component_code: 'A', component_name: 'Branch A', quantity: 3 },
      { id: 'AS', parent_item_id: 'A', component_id: 'S', component_code: 'S', component_name: 'Shared', quantity: 5 },
    ]

    expect(state.bomAppliedDepth.value).toBe(null)
    const openRows = state.bomTreeRows.value
    expect(openRows).toHaveLength(6)
    expect(openRows.map((row) => row.key)).toEqual([
      'ROOT',
      'ROOT/RA',
      'ROOT/RA/AS',
      'ROOT/RA/AS/L',
      'ROOT/RS',
      'ROOT/RS/L',
    ])

    state.bomAppliedDepth.value = 2
    const rows = state.bomTreeRows.value
    const leafRows = rows.filter((row) => row.lineId === 'L')

    expect(rows).toHaveLength(5)
    expect(rows.map((row) => row.lineId)).toEqual(['', 'RA', 'AS', 'RS', 'L'])
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 1, 2])
    expect(rows.some((row) => row.depth > 2)).toBe(false)
    expect(leafRows).toHaveLength(1)
    expect(leafRows[0]?.pathIds).toEqual(['ROOT', 'S', 'leaf'])
    expect(leafRows[0]?.line?.quantity).toBe(7)
    expect(rows.find((row) => row.lineId === 'AS')?.hasChildren).toBe(false)
    expect(rows.find((row) => row.lineId === 'RS')?.hasChildren).toBe(true)
    expect(rows.filter((row) => row.componentId === 'S').map((row) => row.line?.quantity)).toEqual([5, 2])
    expect(rows.map((row) => row.line?.quantity ?? null)).toEqual([null, 3, 5, 2, 7])
    expect(rows.map((row) => row.pathIds)).toEqual([
      ['ROOT'],
      ['ROOT', 'A'],
      ['ROOT', 'A', 'S'],
      ['ROOT', 'S'],
      ['ROOT', 'S', 'leaf'],
    ])
    expect(rows.map((row) => row.key)).toEqual([
      'ROOT',
      'ROOT/RA',
      'ROOT/RA/AS',
      'ROOT/RS',
      'ROOT/RS/L',
    ])
    expect(new Set(rows.map((row) => row.key)).size).toBe(5)
    expect(rows.some((row) => row.key === 'ROOT/RA/AS/L')).toBe(false)
  })

  it('keeps the accepted cap when draft depth changes without a new payload', () => {
    const state = createBomState()
    state.bomItems.value = [
      { id: 'RS', parent_item_id: 'ROOT', component_id: 'S', component_code: 'S', component_name: 'Shared', quantity: 2 },
      { id: 'L', parent_item_id: 'S', component_id: 'leaf', component_code: 'LEAF', component_name: 'Leaf', quantity: 7 },
      { id: 'RA', parent_item_id: 'ROOT', component_id: 'A', component_code: 'A', component_name: 'Branch A', quantity: 3 },
      { id: 'AB', parent_item_id: 'A', component_id: 'B', component_code: 'B', component_name: 'Branch B', quantity: 4 },
      { id: 'BS', parent_item_id: 'B', component_id: 'S', component_code: 'S', component_name: 'Shared', quantity: 5 },
    ]
    state.bomAppliedDepth.value = 3
    state.bomDepth.value = 3

    expect(state.bomTreeRows.value).toHaveLength(6)

    state.bomDepth.value = 4
    const rows = state.bomTreeRows.value

    expect(state.bomDepth.value).toBe(4)
    expect(state.bomAppliedDepth.value).toBe(3)
    expect(state.bomItems.value).toHaveLength(5)
    expect(rows).toHaveLength(6)
    expect(rows.filter((row) => row.depth >= 4)).toHaveLength(0)
    expect(rows.map((row) => row.lineId)).toEqual(['', 'RA', 'AB', 'BS', 'RS', 'L'])
    expect(rows.find((row) => row.lineId === 'BS')?.depth).toBe(3)
    expect(rows.find((row) => row.lineId === 'BS')?.hasChildren).toBe(false)
    expect(rows.find((row) => row.lineId === 'L')?.pathIds).toEqual(['ROOT', 'S', 'leaf'])
    expect(rows.find((row) => row.lineId === 'RS')?.line?.quantity).toBe(2)
    expect(rows.find((row) => row.lineId === 'BS')?.line?.quantity).toBe(5)
  })

  it('shows each accepted depth-4 leaf once per path and keeps real-id dedup', () => {
    const state = createBomState()
    const baseLines = [
      { id: 'RS', parent_item_id: 'ROOT', component_id: 'S', component_code: 'S', component_name: 'Shared', quantity: 2 },
      { id: 'L', parent_item_id: 'S', component_id: 'leaf', component_code: 'LEAF', component_name: 'Leaf', quantity: 7 },
      { id: 'RA', parent_item_id: 'ROOT', component_id: 'A', component_code: 'A', component_name: 'Branch A', quantity: 3 },
      { id: 'AB', parent_item_id: 'A', component_id: 'B', component_code: 'B', component_name: 'Branch B', quantity: 4 },
      { id: 'BS', parent_item_id: 'B', component_id: 'S', component_code: 'S', component_name: 'Shared', quantity: 5 },
    ]
    const bothOccurrences = [
      ...baseLines,
      { id: 'L', parent_item_id: 'S', component_id: 'leaf', component_code: 'LEAF', component_name: 'Leaf', quantity: 9 },
    ]

    state.bomAppliedDepth.value = 3
    state.bomItems.value = baseLines
    expect(state.bomTreeRows.value.filter((row) => row.lineId === 'L')).toHaveLength(1)

    state.bomItems.value = bothOccurrences
    expect(state.bomAppliedDepth.value).toBe(3)
    expect(state.bomItems.value.map((item) => item.id)).toEqual(['RS', 'L', 'RA', 'AB', 'BS', 'L'])
    expect(state.bomTreeRows.value.filter((row) => row.lineId === 'L')).toHaveLength(1)

    state.bomAppliedDepth.value = 4
    const rows = state.bomTreeRows.value
    const leafRows = rows.filter((row) => row.lineId === 'L')

    expect(rows).toHaveLength(7)
    expect(leafRows).toHaveLength(2)
    expect(leafRows.map((row) => row.depth)).toEqual([4, 2])
    expect(leafRows.map((row) => row.pathIds)).toEqual([
      ['ROOT', 'A', 'B', 'S', 'leaf'],
      ['ROOT', 'S', 'leaf'],
    ])
    expect(leafRows.map((row) => row.key)).toEqual([
      'ROOT/RA/AB/BS/L',
      'ROOT/RS/L',
    ])
    expect(leafRows.map((row) => row.line?.quantity)).toEqual([7, 7])
    expect(state.bomItems.value.map((item) => item.quantity ?? null)).toEqual([2, 7, 3, 4, 5, 9])
    expect(new Set(leafRows.map((row) => row.pathIds.join('/'))).size).toBe(2)
    expect(new Set(rows.map((row) => row.key)).size).toBe(7)
    expect(rows.find((row) => row.lineId === 'BS')?.hasChildren).toBe(true)
    expect(rows.find((row) => row.lineId === 'BS')?.line?.quantity).toBe(5)
    expect(rows.find((row) => row.lineId === 'RS')?.line?.quantity).toBe(2)
    expect(rows.find((row) => row.lineId === 'RA')?.line?.quantity).toBe(3)
    expect(rows.find((row) => row.lineId === 'AB')?.line?.quantity).toBe(4)
  })

  it('distinguishes branch quantities, paths, keys, and cycle cuts', () => {
    const state = createBomState()
    state.bomAppliedDepth.value = null
    state.bomItems.value = [
      { id: 'RS', parent_item_id: 'ROOT', component_id: 'S', component_code: 'S', quantity: 2 },
      { id: 'SA', parent_item_id: 'S', component_id: 'A', component_code: 'A', quantity: 4 },
      { id: 'AS', parent_item_id: 'A', component_id: 'S', component_code: 'S', quantity: 5 },
      { id: 'L', parent_item_id: 'S', component_id: 'leaf', component_code: 'LEAF', quantity: 7 },
    ]

    const rows = state.bomTreeRows.value
    const cycleRow = rows.find((row) => row.lineId === 'AS')

    expect(rows).toHaveLength(5)
    expect(rows.map((row) => row.lineId)).toEqual(['', 'RS', 'SA', 'AS', 'L'])
    expect(rows.map((row) => row.line?.quantity ?? null)).toEqual([null, 2, 4, 5, 7])
    expect(rows.filter((row) => row.componentId === 'S').map((row) => row.line?.quantity)).toEqual([2, 5])
    expect(rows.map((row) => row.pathIds)).toEqual([
      ['ROOT'],
      ['ROOT', 'S'],
      ['ROOT', 'S', 'A'],
      ['ROOT', 'S', 'A', 'S'],
      ['ROOT', 'S', 'leaf'],
    ])
    expect(rows.map((row) => row.key)).toEqual([
      'ROOT',
      'ROOT/RS',
      'ROOT/RS/SA',
      'ROOT/RS/SA/AS',
      'ROOT/RS/L',
    ])
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
    expect(cycleRow?.depth).toBe(3)
    expect(cycleRow?.hasChildren).toBe(false)
    expect(cycleRow?.pathIds).toEqual(['ROOT', 'S', 'A', 'S'])
    expect(rows.filter((row) => row.lineId === 'L')).toHaveLength(1)
    expect(rows.filter((row) => row.pathIds.filter((id) => id === 'S').length > 1)).toHaveLength(1)

    state.bomAppliedDepth.value = 2
    const capped = state.bomTreeRows.value

    expect(capped.map((row) => row.lineId)).toEqual(['', 'RS', 'SA', 'L'])
    expect(capped.map((row) => row.key)).toEqual([
      'ROOT',
      'ROOT/RS',
      'ROOT/RS/SA',
      'ROOT/RS/L',
    ])
    expect(capped.map((row) => row.pathIds)).toEqual([
      ['ROOT'],
      ['ROOT', 'S'],
      ['ROOT', 'S', 'A'],
      ['ROOT', 'S', 'leaf'],
    ])
    expect(capped.some((row) => row.lineId === 'AS')).toBe(false)
    expect(capped.find((row) => row.lineId === 'SA')?.hasChildren).toBe(false)
    expect(capped.find((row) => row.lineId === 'RS')?.line?.quantity).toBe(2)
    expect(capped.find((row) => row.lineId === 'SA')?.line?.quantity).toBe(4)
    expect(capped.find((row) => row.lineId === 'L')?.line?.quantity).toBe(7)
    expect(new Set(capped.map((row) => row.key)).size).toBe(capped.length)
  })
})
