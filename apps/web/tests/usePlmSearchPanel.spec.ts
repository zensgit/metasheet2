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

describe('usePlmSearchPanel overlapping search ownership', () => {
  beforeEach(() => {
    searchProductsMock.mockReset()
  })

  type SearchPayload = {
    total: number
    items: Array<{
      id: string
      partNumber: string
      name: string
      itemType: string
    }>
  }

  const payloadA: SearchPayload = {
    total: 1,
    items: [
      {
        id: 'part-a',
        partNumber: 'A-100',
        name: 'Part A',
        itemType: 'Part',
      },
    ],
  }

  const payloadB: SearchPayload = {
    total: 2,
    items: [
      {
        id: 'part-b',
        partNumber: 'B-200',
        name: 'Part B',
        itemType: 'Part',
      },
      {
        id: 'part-b2',
        partNumber: 'B-200-2',
        name: 'Part B Two',
        itemType: 'Part',
      },
    ],
  }

  function deferredPromise<T>() {
    let resolvePromise!: (value: T) => void
    let rejectPromise!: (error: unknown) => void
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    return {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    }
  }

  function createSearchPanelFixture() {
    const handleAuthError = vi.fn()
    const panel = usePlmSearchPanel({
      defaultItemType: 'Part',
      defaultSearchLimit: 10,
      productId: ref(''),
      productItemNumber: ref(''),
      itemType: ref('Part'),
      compareLeftId: ref(''),
      compareRightId: ref(''),
      loadProduct: vi.fn().mockResolvedValue(undefined),
      scheduleQuerySync: vi.fn(),
      setDeepLinkMessage: vi.fn(),
      copyToClipboard: vi.fn().mockResolvedValue(true),
      handleAuthError,
    })

    return {
      ...panel,
      handleAuthError,
    }
  }

  it('keeps newer results when an older search succeeds later', async () => {
    const pendingSearchA = deferredPromise<SearchPayload>()
    const pendingSearchB = deferredPromise<SearchPayload>()
    searchProductsMock
      .mockImplementationOnce(() => pendingSearchA.promise)
      .mockImplementationOnce(() => pendingSearchB.promise)
    const panel = createSearchPanelFixture()

    panel.searchQuery.value = 'A-100'
    panel.searchItemType.value = 'Part'
    panel.searchLimit.value = 10
    const pendingA = panel.searchProducts()
    panel.searchQuery.value = 'B-200'
    panel.searchItemType.value = 'Part'
    panel.searchLimit.value = 10
    const pendingB = panel.searchProducts()

    expect(searchProductsMock).toHaveBeenCalledTimes(2)
    expect(searchProductsMock).toHaveBeenNthCalledWith(1, {
      query: 'A-100',
      itemType: 'Part',
      limit: 10,
      offset: 0,
    })
    expect(searchProductsMock).toHaveBeenNthCalledWith(2, {
      query: 'B-200',
      itemType: 'Part',
      limit: 10,
      offset: 0,
    })
    expect(panel.searchResults.value).toEqual([])
    expect(panel.searchTotal.value).toBe(0)
    expect(panel.searchLoading.value).toBe(true)
    expect(panel.searchError.value).toBe('')
    expect(panel.handleAuthError).not.toHaveBeenCalled()

    pendingSearchB.resolve(payloadB)
    await pendingB

    expect(panel.searchResults.value).toEqual(payloadB.items)
    expect(panel.searchTotal.value).toBe(payloadB.total)
    expect(panel.searchLoading.value).toBe(false)
    expect(panel.searchError.value).toBe('')
    expect(panel.handleAuthError).not.toHaveBeenCalled()

    pendingSearchA.resolve(payloadA)
    await pendingA

    expect(panel.searchQuery.value).toBe('B-200')
    expect(panel.searchResults.value).toEqual(payloadB.items)
    expect(panel.searchTotal.value).toBe(payloadB.total)
    expect(panel.searchLoading.value).toBe(false)
    expect(panel.searchError.value).toBe('')
    expect(panel.handleAuthError).not.toHaveBeenCalled()
  })

  it('ignores older completion while the newest search is pending', async () => {
    const priorItems = [
      {
        id: 'prior-row',
        partNumber: 'P-000',
        name: 'Prior',
        itemType: 'Part',
      },
    ]
    const pendingSearchA = deferredPromise<SearchPayload>()
    const pendingSearchB = deferredPromise<SearchPayload>()
    searchProductsMock
      .mockImplementationOnce(() => pendingSearchA.promise)
      .mockImplementationOnce(() => pendingSearchB.promise)
    const panel = createSearchPanelFixture()
    panel.searchResults.value = priorItems
    panel.searchTotal.value = 7

    panel.searchQuery.value = 'A-100'
    panel.searchItemType.value = 'Part'
    panel.searchLimit.value = 10
    const pendingA = panel.searchProducts()
    panel.searchQuery.value = 'B-200'
    panel.searchItemType.value = 'Part'
    panel.searchLimit.value = 10
    const pendingB = panel.searchProducts()

    expect(panel.searchResults.value).toEqual(priorItems)
    expect(panel.searchTotal.value).toBe(7)
    expect(panel.searchLoading.value).toBe(true)
    expect(panel.searchError.value).toBe('')
    expect(panel.handleAuthError).not.toHaveBeenCalled()

    pendingSearchA.resolve(payloadA)
    await pendingA

    expect(panel.searchResults.value).toEqual(priorItems)
    expect(panel.searchTotal.value).toBe(7)
    expect(panel.searchLoading.value).toBe(true)
    expect(panel.searchError.value).toBe('')
    expect(panel.handleAuthError).not.toHaveBeenCalled()

    pendingSearchB.resolve(payloadB)
    await pendingB

    expect(panel.searchResults.value).toEqual(payloadB.items)
    expect(panel.searchTotal.value).toBe(payloadB.total)
    expect(panel.searchLoading.value).toBe(false)
    expect(panel.searchError.value).toBe('')
    expect(panel.handleAuthError).not.toHaveBeenCalled()
  })

  it('ignores a stale rejection after the newest search succeeds', async () => {
    const pendingSearchA = deferredPromise<SearchPayload>()
    const pendingSearchB = deferredPromise<SearchPayload>()
    searchProductsMock
      .mockImplementationOnce(() => pendingSearchA.promise)
      .mockImplementationOnce(() => pendingSearchB.promise)
    const panel = createSearchPanelFixture()

    panel.searchQuery.value = 'A-100'
    panel.searchItemType.value = 'Part'
    panel.searchLimit.value = 10
    const pendingA = panel.searchProducts()
    panel.searchQuery.value = 'B-200'
    panel.searchItemType.value = 'Part'
    panel.searchLimit.value = 10
    const pendingB = panel.searchProducts()

    pendingSearchB.resolve(payloadB)
    await pendingB

    expect(panel.searchResults.value).toEqual(payloadB.items)
    expect(panel.searchTotal.value).toBe(payloadB.total)
    expect(panel.searchLoading.value).toBe(false)
    expect(panel.searchError.value).toBe('')
    expect(panel.handleAuthError).not.toHaveBeenCalled()

    pendingSearchA.reject(new Error('older search failed'))
    await pendingA

    expect(panel.searchResults.value).toEqual(payloadB.items)
    expect(panel.searchTotal.value).toBe(payloadB.total)
    expect(panel.searchLoading.value).toBe(false)
    expect(panel.searchError.value).toBe('')
    expect(panel.handleAuthError).not.toHaveBeenCalled()
  })

  it('keeps prior rows and the newest error when that search fails first', async () => {
    const priorItems = [
      {
        id: 'prior-row',
        partNumber: 'P-000',
        name: 'Prior',
        itemType: 'Part',
      },
    ]
    const latestError = new Error('latest search failed')
    const pendingSearchA = deferredPromise<SearchPayload>()
    const pendingSearchB = deferredPromise<SearchPayload>()
    searchProductsMock
      .mockImplementationOnce(() => pendingSearchA.promise)
      .mockImplementationOnce(() => pendingSearchB.promise)
    const panel = createSearchPanelFixture()
    panel.searchResults.value = priorItems
    panel.searchTotal.value = 7

    panel.searchQuery.value = 'A-100'
    panel.searchItemType.value = 'Part'
    panel.searchLimit.value = 10
    const pendingA = panel.searchProducts()
    panel.searchQuery.value = 'B-200'
    panel.searchItemType.value = 'Part'
    panel.searchLimit.value = 10
    const pendingB = panel.searchProducts()

    pendingSearchB.reject(latestError)
    await pendingB

    expect(panel.searchResults.value).toEqual(priorItems)
    expect(panel.searchTotal.value).toBe(7)
    expect(panel.searchLoading.value).toBe(false)
    expect(panel.searchError.value).toBe('latest search failed')
    expect(panel.handleAuthError).toHaveBeenCalledTimes(1)
    expect(panel.handleAuthError).toHaveBeenCalledWith(latestError)

    pendingSearchA.resolve(payloadA)
    await pendingA

    expect(panel.searchResults.value).toEqual(priorItems)
    expect(panel.searchTotal.value).toBe(7)
    expect(panel.searchLoading.value).toBe(false)
    expect(panel.searchError.value).toBe('latest search failed')
    expect(panel.handleAuthError).toHaveBeenCalledTimes(1)
    expect(panel.handleAuthError).toHaveBeenCalledWith(latestError)
  })
})
