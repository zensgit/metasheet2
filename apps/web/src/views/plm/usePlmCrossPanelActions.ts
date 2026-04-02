import type {
  BomLineRecord,
  CompareEntry,
  SubstituteEntry,
  UnknownRecord,
  WhereUsedEntry,
  WhereUsedTreeRowModel,
} from './plmPanelModels'

type ItemKey = {
  id: string
  itemNumber: string
}

type ProductTarget = {
  id: string
  itemNumber: string
}

type UsePlmCrossPanelActionsOptions = {
  setDeepLinkMessage: (message: string, isError?: boolean) => void
  scheduleQuerySync: (payload: { whereUsedItemId?: string; bomLineId?: string }) => void
  copyToClipboard: (value: string) => Promise<boolean>
  resolveBomChildId: (item: BomLineRecord) => string
  resolveBomChildNumber: (item: BomLineRecord) => string
  resolveBomLineId: (item: BomLineRecord) => string
  resolveCompareLineId: (entry: CompareEntry) => string
  resolveWhereUsedParentId: (entry: WhereUsedEntry) => string
  resolveItemKey: (item: UnknownRecord | null | undefined) => ItemKey
  getCompareParent: (entry: CompareEntry) => UnknownRecord | null | undefined
  getCompareChild: (entry: CompareEntry) => UnknownRecord | null | undefined
  resolveSubstituteTarget: (entry: SubstituteEntry, target: 'substitute' | 'part') => UnknownRecord | null | undefined
  setProductTarget: (target: ProductTarget) => void
  clearProductError: () => void
  loadProduct: () => Promise<void>
  setWhereUsedItemId: (value: string) => void
  clearWhereUsedError: () => void
  isWhereUsedLoading: () => boolean
  loadWhereUsed: () => Promise<void>
  setBomLineId: (value: string) => void
  clearSubstitutesState: () => void
  isSubstitutesLoading: () => boolean
  loadSubstitutes: () => Promise<void>
}

export function usePlmCrossPanelActions(options: UsePlmCrossPanelActionsOptions) {
  function updateProduct(target: ProductTarget, message: string) {
    options.setProductTarget(target)
    options.clearProductError()
    options.setDeepLinkMessage(message)
    void options.loadProduct()
  }

  function updateWhereUsed(target: string, message: string) {
    options.setWhereUsedItemId(target)
    options.clearWhereUsedError()
    options.scheduleQuerySync({ whereUsedItemId: target })
    options.setDeepLinkMessage(message)
    if (!options.isWhereUsedLoading()) {
      void options.loadWhereUsed()
    }
  }

  function updateSubstitutes(lineId: string, message: string) {
    options.setBomLineId(lineId)
    options.clearSubstitutesState()
    options.scheduleQuerySync({ bomLineId: lineId })
    options.setDeepLinkMessage(message)
    if (!options.isSubstitutesLoading()) {
      void options.loadSubstitutes()
    }
  }

  function applyWhereUsedFromBom(item: BomLineRecord) {
    const childId = options.resolveBomChildId(item)
    if (!childId) {
      options.setDeepLinkMessage('BOM 行缺少子件 ID', true)
      return
    }
    updateWhereUsed(childId, `已填入 Where-Used 子件 ID：${childId}`)
  }

  function applySubstitutesFromBom(item: BomLineRecord) {
    const lineId = options.resolveBomLineId(item)
    if (!lineId) {
      options.setDeepLinkMessage('BOM 行缺少行 ID', true)
      return
    }
    updateSubstitutes(lineId, `已填入替代件 BOM 行 ID：${lineId}`)
  }

  function applyProductFromBom(item: BomLineRecord) {
    const childId = options.resolveBomChildId(item)
    const childNumber = options.resolveBomChildNumber(item)
    const target = childId || childNumber
    if (!target) {
      options.setDeepLinkMessage('BOM 行缺少子件标识', true)
      return
    }
    updateProduct(
      { id: childId || '', itemNumber: childId ? '' : childNumber },
      `已切换到子件产品：${target}`,
    )
  }

  function applySubstitutesFromCompare(entry: CompareEntry) {
    const lineId = options.resolveCompareLineId(entry)
    if (!lineId) {
      options.setDeepLinkMessage('对比行缺少关系 ID', true)
      return
    }
    updateSubstitutes(lineId, `已填入替代件 BOM 行 ID：${lineId}`)
  }

  function applyProductFromWhereUsed(entry: WhereUsedEntry) {
    const parentId = options.resolveWhereUsedParentId(entry)
    if (!parentId) {
      options.setDeepLinkMessage('缺少父件 ID', true)
      return
    }
    updateProduct({ id: parentId, itemNumber: '' }, `已切换到产品：${parentId}`)
  }

  function applyProductFromWhereUsedRow(row: WhereUsedTreeRowModel) {
    const parentId = row?.id
    if (!parentId) {
      options.setDeepLinkMessage('缺少父件 ID', true)
      return
    }
    applyProductFromWhereUsed({ parent: { id: parentId } })
  }

  function applyProductFromCompareParent(entry: CompareEntry) {
    const { id, itemNumber } = options.resolveItemKey(options.getCompareParent(entry))
    if (!id && !itemNumber) {
      options.setDeepLinkMessage('缺少父件 ID', true)
      return
    }
    updateProduct(
      { id: id || '', itemNumber: id ? '' : itemNumber },
      `已切换到产品：${id || itemNumber}`,
    )
  }

  function applyWhereUsedFromCompare(entry: CompareEntry) {
    const { id, itemNumber } = options.resolveItemKey(options.getCompareChild(entry))
    const target = id || itemNumber
    if (!target) {
      options.setDeepLinkMessage('缺少子件 ID', true)
      return
    }
    updateWhereUsed(target, `已切换 Where-Used 子件：${target}`)
  }

  async function copyCompareLineId(entry: CompareEntry) {
    const lineId = options.resolveCompareLineId(entry)
    if (!lineId) {
      options.setDeepLinkMessage('缺少 Line ID', true)
      return
    }
    const ok = await options.copyToClipboard(lineId)
    if (!ok) {
      options.setDeepLinkMessage('复制失败，请手动复制', true)
      return
    }
    options.setDeepLinkMessage(`已复制 Line ID：${lineId}`)
  }

  function applyProductFromSubstitute(entry: SubstituteEntry, target: 'substitute' | 'part') {
    const { id, itemNumber } = options.resolveItemKey(options.resolveSubstituteTarget(entry, target))
    if (!id && !itemNumber) {
      options.setDeepLinkMessage('缺少产品标识', true)
      return
    }
    const label = target === 'substitute' ? '替代件' : '原件'
    updateProduct(
      { id: id || '', itemNumber: id ? '' : itemNumber },
      `已切换到${label}产品：${id || itemNumber}`,
    )
  }

  return {
    applyWhereUsedFromBom,
    applySubstitutesFromBom,
    applyProductFromBom,
    applySubstitutesFromCompare,
    applyProductFromWhereUsed,
    applyProductFromWhereUsedRow,
    applyProductFromCompareParent,
    applyWhereUsedFromCompare,
    copyCompareLineId,
    applyProductFromSubstitute,
  }
}
