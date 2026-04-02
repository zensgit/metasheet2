import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type {
  BomLineRecord,
  BomLineContext,
  PlmSubstitutesPanelModel,
  QuickPickOption,
  SubstituteEntry,
  SubstitutesPayload,
  UnknownRecord,
} from './plmPanelModels'

type UsePlmSubstitutesPanelOptions = {
  productLoading: Ref<boolean>
  whereUsedLoading: Ref<boolean>
  copyToClipboard: (value: string) => Promise<boolean>
  setDeepLinkMessage: (message: string, isError?: boolean) => void
  scheduleQuerySync: (payload: { bomLineId?: string }) => void
  bomLineOptions: ComputedRef<QuickPickOption[]>
  substituteQuickOptions: ComputedRef<QuickPickOption[]>
  bomItems: Ref<BomLineRecord[]>
  getSubstituteNumber: (entry: SubstituteEntry) => string
  getSubstituteName: (entry: SubstituteEntry) => string
  getSubstituteStatus: (entry: SubstituteEntry) => string
  formatSubstituteRank: (entry: SubstituteEntry) => string
  formatSubstituteNote: (entry: SubstituteEntry) => string
  copyDeepLink: (panel?: string) => Promise<void>
  loadSubstitutes: () => Promise<void>
  addSubstitute: () => Promise<void>
  removeSubstitute: (entry: SubstituteEntry) => Promise<void>
  applyWhereUsedFromBom: (entry: BomLineRecord) => void
  resolveSubstituteTargetKey: (entry: SubstituteEntry, target: 'substitute' | 'part') => string
  applyProductFromSubstitute: (entry: SubstituteEntry, target: 'substitute' | 'part') => void
  getSubstituteId: (entry: SubstituteEntry) => string
  getItemNumber: (item: UnknownRecord | null | undefined) => string
  getItemName: (item: UnknownRecord | null | undefined) => string
  itemStatusClass: (value?: string) => string
  exportSubstitutesCsv: () => void
  formatJson: (payload: unknown) => string
}

export function usePlmSubstitutesPanel(options: UsePlmSubstitutesPanelOptions) {
  const bomLineId = ref('')
  const bomLineQuickPick = ref('')
  const substitutes = ref<SubstitutesPayload | null>(null)
  const substitutesLoading = ref(false)
  const substitutesError = ref('')
  const substitutesFilter = ref('')
  const substituteItemId = ref('')
  const substituteQuickPick = ref('')
  const substituteRank = ref('')
  const substituteNote = ref('')
  const substitutesActionStatus = ref('')
  const substitutesActionError = ref('')
  const substitutesMutating = ref(false)
  const substitutesDeletingId = ref<string | null>(null)

  const substitutesRows = computed<SubstituteEntry[]>(() => {
    const list = substitutes.value?.substitutes || []
    const needle = substitutesFilter.value.trim().toLowerCase()
    if (!needle) return list
    return list.filter((entry) => {
      const tokens = [
        options.getSubstituteNumber(entry),
        options.getSubstituteName(entry),
        options.getSubstituteStatus(entry),
        options.getItemNumber(entry.part || null),
        options.getItemName(entry.part || null),
        options.formatSubstituteRank(entry),
        options.formatSubstituteNote(entry),
        entry.id,
        entry.relationship?.id,
      ]
      return tokens.some((token) => String(token || '').toLowerCase().includes(needle))
    })
  })

  const bomLineContext = computed<BomLineContext | null>(() => {
    const lineId = bomLineId.value.trim()
    if (!lineId) return null
    const entry = options.bomItems.value.find((item) => String(item.id || '') === lineId)
    return (entry as BomLineContext | undefined) || null
  })

  function applyBomLineQuickPick() {
    const value = bomLineQuickPick.value
    if (!value) return
    bomLineId.value = value
    substitutesError.value = ''
    substitutesActionStatus.value = ''
    substitutesActionError.value = ''
    options.scheduleQuerySync({ bomLineId: value })
    options.setDeepLinkMessage(`已填入替代件 BOM 行 ID：${value}`)
    bomLineQuickPick.value = ''
  }

  function applySubstituteQuickPick() {
    const value = substituteQuickPick.value
    if (!value) return
    substituteItemId.value = value
    substitutesActionStatus.value = ''
    substitutesActionError.value = ''
    options.setDeepLinkMessage(`已填入替代件 ID：${value}`)
    substituteQuickPick.value = ''
  }

  async function copyBomLineId() {
    if (!bomLineId.value) {
      options.setDeepLinkMessage('缺少 BOM 行 ID', true)
      return
    }
    const ok = await options.copyToClipboard(bomLineId.value)
    if (!ok) {
      options.setDeepLinkMessage('复制失败，请手动复制', true)
      return
    }
    options.setDeepLinkMessage(`已复制 BOM 行 ID：${bomLineId.value}`)
  }

  const substitutesPanel: PlmSubstitutesPanelModel = {
    copyDeepLink: options.copyDeepLink,
    loadSubstitutes: options.loadSubstitutes,
    applyBomLineQuickPick,
    applySubstituteQuickPick,
    addSubstitute: options.addSubstitute,
    removeSubstitute: options.removeSubstitute,
    copyBomLineId,
    applyWhereUsedFromBom: options.applyWhereUsedFromBom,
    getSubstituteNumber: options.getSubstituteNumber,
    getSubstituteId: options.getSubstituteId,
    getSubstituteName: options.getSubstituteName,
    getSubstituteStatus: options.getSubstituteStatus,
    formatSubstituteRank: options.formatSubstituteRank,
    formatSubstituteNote: options.formatSubstituteNote,
    resolveSubstituteTargetKey: options.resolveSubstituteTargetKey,
    applyProductFromSubstitute: options.applyProductFromSubstitute,
    getItemNumber: options.getItemNumber,
    getItemName: options.getItemName,
    itemStatusClass: options.itemStatusClass,
    exportSubstitutesCsv: options.exportSubstitutesCsv,
    formatJson: options.formatJson,
    bomLineId,
    bomLineQuickPick,
    bomLineOptions: options.bomLineOptions,
    bomLineContext,
    substitutes,
    substitutesLoading,
    substitutesError,
    substitutesFilter,
    substituteItemId,
    substituteQuickOptions: options.substituteQuickOptions,
    substituteQuickPick,
    substituteRank,
    substituteNote,
    substitutesActionStatus,
    substitutesActionError,
    substitutesMutating,
    substitutesDeletingId,
    substitutesRows,
    productLoading: options.productLoading,
    whereUsedLoading: options.whereUsedLoading,
  }

  return {
    bomLineId,
    bomLineQuickPick,
    substitutes,
    substitutesLoading,
    substitutesError,
    substitutesFilter,
    substituteItemId,
    substituteQuickPick,
    substituteRank,
    substituteNote,
    substitutesActionStatus,
    substitutesActionError,
    substitutesMutating,
    substitutesDeletingId,
    substitutesRows,
    bomLineContext,
    substitutesPanel,
  }
}
