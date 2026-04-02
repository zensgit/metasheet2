import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { usePlmComparePanel } from '../src/views/plm/usePlmComparePanel'

describe('usePlmComparePanel', () => {
  function createPanel() {
    const scheduleQuerySync = vi.fn()
    const setDeepLinkMessage = vi.fn()

    return {
      ...usePlmComparePanel({
        defaultCompareMaxLevels: 10,
        defaultCompareLineKey: 'child_config',
        defaultCompareRelationshipProps: 'quantity,uom',
        defaultCompareLineKeys: ['child_config', 'child_id'],
        compareLeftId: ref(''),
        compareRightId: ref(''),
        productId: ref('PROD-1'),
        productLoading: ref(false),
        whereUsedLoading: ref(false),
        substitutesLoading: ref(false),
        copyToClipboard: vi.fn().mockResolvedValue(true),
        setDeepLinkMessage,
        scheduleQuerySync,
        compareQuickOptions: computed(() => [
          { key: 'search:A', value: 'ITEM-A', label: '搜索 / A / ITEM-A' },
        ]),
        filterCompareEntries: (entries) => entries,
        compareFieldLabels: { quantity: '数量' },
        defaultCompareFieldCatalog: [
          {
            key: 'quantity',
            label: '数量',
            source: 'relationship.properties.quantity',
            severity: 'minor',
            normalized: 'decimal',
          },
        ],
        resolveCompareFieldValue: () => '-',
        resolveCompareNormalizedValue: () => '',
        copyDeepLink: vi.fn().mockResolvedValue(undefined),
        applyCompareFromProduct: vi.fn(),
        loadBomCompare: vi.fn().mockResolvedValue(undefined),
        selectCompareEntry: vi.fn(),
        clearCompareSelection: vi.fn(),
        isCompareEntrySelected: vi.fn().mockReturnValue(false),
        resolveCompareChildKey: (entry) => String(entry.child_id || ''),
        resolveCompareLineId: (entry) => String(entry.line_key || ''),
        resolveCompareParentKey: (entry) => String(entry.parent_id || ''),
        getCompareParent: () => ({ id: 'PARENT-1', item_number: 'P-1' }),
        getCompareChild: () => ({ id: 'CHILD-1', item_number: 'C-1' }),
        getCompareProp: () => '-',
        applyProductFromCompareParent: vi.fn(),
        applyWhereUsedFromCompare: vi.fn(),
        applySubstitutesFromCompare: vi.fn(),
        copyCompareLineId: vi.fn().mockResolvedValue(undefined),
        formatEffectivity: () => '-',
        formatSubstituteCount: () => '0',
        getCompareEntrySeverity: () => 'info',
        getCompareChangeRows: () => [],
        formatDiffValue: (value) => String(value || '-'),
        severityClass: (value) => `severity-${value || 'info'}`,
        compareRowClass: () => 'compare-row',
        copyCompareDetailRows: vi.fn().mockResolvedValue(undefined),
        exportCompareDetailCsv: vi.fn(),
        exportBomCompareCsv: vi.fn(),
        getItemNumber: (item) => String(item?.item_number || item?.component_code || item?.id || '-'),
        getItemName: (item) => String(item?.name || item?.component_name || '-'),
        formatJson: (payload) => JSON.stringify(payload),
      }),
      scheduleQuerySync,
      setDeepLinkMessage,
    }
  }

  it('applies compare quick picks and syncs compare ids', () => {
    const panel = createPanel()

    panel.compareLeftQuickPick.value = 'ITEM-A'
    panel.compareError.value = 'stale'
    panel.comparePanel.applyCompareQuickPick('left')

    expect(panel.compareLeftId.value).toBe('ITEM-A')
    expect(panel.compareLeftQuickPick.value).toBe('')
    expect(panel.compareError.value).toBe('')
    expect(panel.scheduleQuerySync).toHaveBeenCalledWith({
      compareLeftId: 'ITEM-A',
      compareRightId: undefined,
    })
    expect(panel.setDeepLinkMessage).toHaveBeenCalledWith('已填入对比左侧 ID：ITEM-A')
  })

  it('swaps compare sides and schedules query sync', () => {
    const panel = createPanel()
    panel.compareLeftId.value = 'LEFT-1'
    panel.compareRightId.value = 'RIGHT-2'

    panel.comparePanel.swapCompareSides()

    expect(panel.compareLeftId.value).toBe('RIGHT-2')
    expect(panel.compareRightId.value).toBe('LEFT-1')
    expect(panel.scheduleQuerySync).toHaveBeenCalledWith({
      compareLeftId: 'RIGHT-2',
      compareRightId: 'LEFT-1',
    })
  })
})
