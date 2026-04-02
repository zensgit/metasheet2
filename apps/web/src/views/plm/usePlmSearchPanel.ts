import { ref, type Ref } from 'vue'
import { plmService } from '../../services/PlmService'
import type { PlmSearchPanelModel, SearchItem } from './plmPanelModels'

type UsePlmSearchPanelOptions = {
  defaultItemType: string
  defaultSearchLimit: number
  productId: Ref<string>
  productItemNumber: Ref<string>
  itemType: Ref<string>
  compareLeftId: Ref<string>
  compareRightId: Ref<string>
  loadProduct: () => Promise<void>
  scheduleQuerySync: (payload: { compareLeftId?: string; compareRightId?: string }) => void
  setDeepLinkMessage: (message: string, isError?: boolean) => void
  copyToClipboard: (value: string) => Promise<boolean>
  handleAuthError: (error: unknown) => void
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return fallback
}

function getSearchItemId(item: SearchItem): string {
  const value = item.id ?? item.item_id ?? item.itemId
  return value === undefined || value === null ? '' : String(value)
}

function getSearchItemNumber(item: SearchItem): string {
  const value = item.partNumber ?? item.item_number ?? item.itemNumber ?? item.code
  return value === undefined || value === null ? '' : String(value)
}

export function usePlmSearchPanel(options: UsePlmSearchPanelOptions) {
  const {
    defaultItemType,
    defaultSearchLimit,
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
  } = options

  const searchQuery = ref('')
  const searchItemType = ref(defaultItemType)
  const searchLimit = ref(defaultSearchLimit)
  const searchResults = ref<SearchItem[]>([])
  const searchTotal = ref(0)
  const searchLoading = ref(false)
  const searchError = ref('')

  async function searchProducts() {
    searchLoading.value = true
    searchError.value = ''
    try {
      const result = await plmService.searchProducts<SearchItem>({
        query: searchQuery.value || undefined,
        itemType: searchItemType.value || undefined,
        limit: searchLimit.value || 10,
        offset: 0,
      })
      searchResults.value = result.items || []
      searchTotal.value = result.total ?? searchResults.value.length
    } catch (error) {
      handleAuthError(error)
      searchError.value = getErrorMessage(error, '搜索失败')
    } finally {
      searchLoading.value = false
    }
  }

  async function applySearchItem(item: SearchItem) {
    const targetId = getSearchItemId(item)
    if (!targetId) return
    productId.value = targetId
    productItemNumber.value = getSearchItemNumber(item)
    if (item.itemType) {
      itemType.value = item.itemType
    }
    await loadProduct()
  }

  function applyCompareFromSearch(item: SearchItem, side: 'left' | 'right') {
    const targetId = getSearchItemId(item)
    const targetNumber = getSearchItemNumber(item)
    if (!targetId && !targetNumber) {
      setDeepLinkMessage('搜索结果缺少 ID', true)
      return
    }
    if (side === 'left') {
      compareLeftId.value = targetId ? String(targetId) : String(targetNumber)
    } else {
      compareRightId.value = targetId ? String(targetId) : String(targetNumber)
    }
    scheduleQuerySync({
      compareLeftId: compareLeftId.value || undefined,
      compareRightId: compareRightId.value || undefined,
    })
    setDeepLinkMessage(`已设为对比${side === 'left' ? '左' : '右'}侧：${targetId || targetNumber}`)
  }

  async function copySearchValue(item: SearchItem, kind: 'id' | 'number') {
    const idValue = getSearchItemId(item)
    const numberValue = getSearchItemNumber(item)
    const value = kind === 'id' ? idValue : numberValue
    if (!value) {
      setDeepLinkMessage(kind === 'id' ? '缺少 ID' : '缺少料号', true)
      return
    }
    const ok = await copyToClipboard(String(value))
    if (!ok) {
      setDeepLinkMessage('复制失败，请手动复制', true)
      return
    }
    setDeepLinkMessage(`已复制${kind === 'id' ? ' ID' : '料号'}：${value}`)
  }

  const searchPanel: PlmSearchPanelModel = {
    searchLoading,
    searchQuery,
    searchItemType,
    searchLimit,
    searchError,
    searchResults,
    searchTotal,
    searchProducts,
    applySearchItem,
    applyCompareFromSearch,
    copySearchValue,
  }

  return {
    searchQuery,
    searchItemType,
    searchLimit,
    searchResults,
    searchTotal,
    searchLoading,
    searchError,
    searchProducts,
    applySearchItem,
    applyCompareFromSearch,
    copySearchValue,
    searchPanel,
  }
}
