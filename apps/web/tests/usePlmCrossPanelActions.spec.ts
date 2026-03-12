import { describe, expect, it, vi } from 'vitest'
import { usePlmCrossPanelActions } from '../src/views/plm/usePlmCrossPanelActions'

describe('usePlmCrossPanelActions', () => {
  function createActions() {
    let productTarget = { id: '', itemNumber: '' }
    let whereUsedItemId = ''
    let bomLineId = ''
    let whereUsedLoading = false
    let substitutesLoading = false

    const setDeepLinkMessage = vi.fn()
    const scheduleQuerySync = vi.fn()
    const copyToClipboard = vi.fn().mockResolvedValue(true)
    const loadProduct = vi.fn().mockResolvedValue(undefined)
    const loadWhereUsed = vi.fn().mockResolvedValue(undefined)
    const loadSubstitutes = vi.fn().mockResolvedValue(undefined)

    return {
      actions: usePlmCrossPanelActions({
        setDeepLinkMessage,
        scheduleQuerySync,
        copyToClipboard,
        resolveBomChildId: (item) => String(item.component_id || ''),
        resolveBomChildNumber: (item) => String(item.component_code || ''),
        resolveBomLineId: (item) => String(item.id || ''),
        resolveCompareLineId: (entry) => String(entry.relationship_id || ''),
        resolveWhereUsedParentId: (entry) => String(entry.parent?.id || ''),
        resolveItemKey: (item) => ({
          id: String(item?.id || ''),
          itemNumber: String(item?.item_number || item?.code || ''),
        }),
        getCompareParent: (entry) => entry.parent || null,
        getCompareChild: (entry) => entry.child || null,
        resolveSubstituteTarget: (entry, target) => (target === 'substitute' ? entry.substitute_part : entry.part) || null,
        setProductTarget: (target) => {
          productTarget = target
        },
        clearProductError: vi.fn(),
        loadProduct,
        setWhereUsedItemId: (value) => {
          whereUsedItemId = value
        },
        clearWhereUsedError: vi.fn(),
        isWhereUsedLoading: () => whereUsedLoading,
        loadWhereUsed,
        setBomLineId: (value) => {
          bomLineId = value
        },
        clearSubstitutesState: vi.fn(),
        isSubstitutesLoading: () => substitutesLoading,
        loadSubstitutes,
      }),
      setDeepLinkMessage,
      scheduleQuerySync,
      copyToClipboard,
      loadProduct,
      loadWhereUsed,
      loadSubstitutes,
      getProductTarget: () => productTarget,
      getWhereUsedItemId: () => whereUsedItemId,
      getBomLineId: () => bomLineId,
      setWhereUsedLoading: (value: boolean) => {
        whereUsedLoading = value
      },
      setSubstitutesLoading: (value: boolean) => {
        substitutesLoading = value
      },
    }
  }

  it('applies BOM child into where-used target and auto-loads when idle', () => {
    const panel = createActions()

    panel.actions.applyWhereUsedFromBom({ component_id: 'CHILD-1' })

    expect(panel.getWhereUsedItemId()).toBe('CHILD-1')
    expect(panel.scheduleQuerySync).toHaveBeenCalledWith({ whereUsedItemId: 'CHILD-1' })
    expect(panel.loadWhereUsed).toHaveBeenCalled()
  })

  it('routes compare and substitute actions through shared product/bom targets', async () => {
    const panel = createActions()

    panel.actions.applyProductFromCompareParent({ parent: { id: 'PARENT-1' } })
    panel.actions.applySubstitutesFromCompare({ relationship_id: 'LINE-1' })
    await panel.actions.copyCompareLineId({ relationship_id: 'LINE-1' })

    expect(panel.getProductTarget()).toEqual({ id: 'PARENT-1', itemNumber: '' })
    expect(panel.loadProduct).toHaveBeenCalled()
    expect(panel.getBomLineId()).toBe('LINE-1')
    expect(panel.loadSubstitutes).toHaveBeenCalled()
    expect(panel.copyToClipboard).toHaveBeenCalledWith('LINE-1')
  })
})
