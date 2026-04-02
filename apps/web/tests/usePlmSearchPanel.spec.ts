import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { searchProductsMock } = vi.hoisted(() => ({
  searchProductsMock: vi.fn(),
}))

vi.mock('../src/services/PlmService', () => ({
  plmService: {
    searchProducts: searchProductsMock,
  },
}))

import { usePlmSearchPanel } from '../src/views/plm/usePlmSearchPanel'

describe('usePlmSearchPanel', () => {
  beforeEach(() => {
    searchProductsMock.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  function createPanel() {
    const productId = ref('')
    const productItemNumber = ref('')
    const itemType = ref('Part')
    const compareLeftId = ref('')
    const compareRightId = ref('')
    const loadProduct = vi.fn().mockResolvedValue(undefined)
    const scheduleQuerySync = vi.fn()
    const setDeepLinkMessage = vi.fn()
    const copyToClipboard = vi.fn().mockResolvedValue(true)
    const handleAuthError = vi.fn()

    const panel = usePlmSearchPanel({
      defaultItemType: 'Part',
      defaultSearchLimit: 10,
      productId,
      productItemNumber,
      itemType,
      compareLeftId,
      compareRightId,
      loadProduct,
      scheduleQuerySync,
      setDeepLinkMessage,
      copyToClipboard,
      handleAuthError,
    })

    return {
      ...panel,
      productId,
      productItemNumber,
      itemType,
      compareLeftId,
      compareRightId,
      loadProduct,
      scheduleQuerySync,
      setDeepLinkMessage,
      copyToClipboard,
      handleAuthError,
    }
  }

  it('loads search results into panel state', async () => {
    searchProductsMock.mockResolvedValue({
      total: 1,
      items: [{ id: 'P-100', partNumber: 'PN-100', name: 'Widget' }],
    })
    const panel = createPanel()
    panel.searchQuery.value = 'Widget'

    await panel.searchProducts()

    expect(searchProductsMock).toHaveBeenCalledWith({
      query: 'Widget',
      itemType: 'Part',
      limit: 10,
      offset: 0,
    })
    expect(panel.searchResults.value).toHaveLength(1)
    expect(panel.searchTotal.value).toBe(1)
    expect(panel.searchError.value).toBe('')
  })

  it('applies a search item into product state and loads product', async () => {
    const panel = createPanel()

    await panel.applySearchItem({
      id: 'ITEM-1',
      partNumber: 'PN-1',
      itemType: 'Assembly',
    })

    expect(panel.productId.value).toBe('ITEM-1')
    expect(panel.productItemNumber.value).toBe('PN-1')
    expect(panel.itemType.value).toBe('Assembly')
    expect(panel.loadProduct).toHaveBeenCalledTimes(1)
  })

  it('applies search item into compare context and syncs query', () => {
    const panel = createPanel()

    panel.applyCompareFromSearch(
      {
        id: 'ITEM-LEFT',
        partNumber: 'PN-LEFT',
      },
      'left',
    )

    expect(panel.compareLeftId.value).toBe('ITEM-LEFT')
    expect(panel.scheduleQuerySync).toHaveBeenCalledWith({
      compareLeftId: 'ITEM-LEFT',
      compareRightId: undefined,
    })
    expect(panel.setDeepLinkMessage).toHaveBeenCalledWith('已设为对比左侧：ITEM-LEFT')
  })

  it('copies search number and reports success', async () => {
    const panel = createPanel()

    await panel.copySearchValue(
      {
        partNumber: 'PN-200',
      },
      'number',
    )

    expect(panel.copyToClipboard).toHaveBeenCalledWith('PN-200')
    expect(panel.setDeepLinkMessage).toHaveBeenCalledWith('已复制料号：PN-200')
  })
})
