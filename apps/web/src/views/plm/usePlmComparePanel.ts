import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type {
  CompareChangeRow,
  CompareDetailRow,
  CompareEntry,
  CompareFieldCatalogEntry,
  ComparePayload,
  CompareSchemaPayload,
  CompareSelectionMeta,
  CompareSummary,
  PlmComparePanelModel,
  QuickPickOption,
  UnknownRecord,
} from './plmPanelModels'

type CompareSelectionKind = 'added' | 'removed' | 'changed'

type CompareSelection = {
  kind: CompareSelectionKind
  key: string
  entry: CompareEntry
}

type UsePlmComparePanelOptions = {
  defaultCompareMaxLevels: number
  defaultCompareLineKey: string
  defaultCompareRelationshipProps: string
  defaultCompareLineKeys: string[]
  compareLeftId: Ref<string>
  compareRightId: Ref<string>
  productId: Ref<string>
  productLoading: Ref<boolean>
  whereUsedLoading: Ref<boolean>
  substitutesLoading: Ref<boolean>
  copyToClipboard: (value: string) => Promise<boolean>
  setDeepLinkMessage: (message: string, isError?: boolean) => void
  scheduleQuerySync: (payload: { compareLeftId?: string; compareRightId?: string }) => void
  compareQuickOptions: ComputedRef<QuickPickOption[]>
  filterCompareEntries: (entries: CompareEntry[]) => CompareEntry[]
  compareFieldLabels: Record<string, string>
  defaultCompareFieldCatalog: CompareFieldCatalogEntry[]
  resolveCompareFieldValue: (
    entry: CompareEntry,
    kind: CompareSelectionKind,
    side: 'left' | 'right',
    key: string,
  ) => string
  resolveCompareNormalizedValue: (
    entry: CompareEntry,
    kind: CompareSelectionKind,
    side: 'left' | 'right',
    key: string,
    change?: UnknownRecord,
  ) => string
  copyDeepLink: (panel?: string) => Promise<void>
  applyCompareFromProduct: (side: 'left' | 'right') => void
  loadBomCompare: () => Promise<void>
  selectCompareEntry: (entry: CompareEntry, kind: CompareSelectionKind) => void
  clearCompareSelection: () => void
  isCompareEntrySelected: (entry: CompareEntry, kind: CompareSelectionKind) => boolean
  resolveCompareChildKey: (entry: CompareEntry) => string
  resolveCompareLineId: (entry: CompareEntry) => string
  resolveCompareParentKey: (entry: CompareEntry) => string
  getCompareParent: (entry: CompareEntry) => UnknownRecord | null | undefined
  getCompareChild: (entry: CompareEntry) => UnknownRecord | null | undefined
  getCompareProp: (entry: CompareEntry, key: string) => string
  applyProductFromCompareParent: (entry: CompareEntry) => void
  applyWhereUsedFromCompare: (entry: CompareEntry) => void
  applySubstitutesFromCompare: (entry: CompareEntry) => void
  copyCompareLineId: (entry: CompareEntry) => Promise<void>
  formatEffectivity: (entry: CompareEntry) => string
  formatSubstituteCount: (entry: CompareEntry) => string
  getCompareEntrySeverity: (entry: CompareEntry) => string
  getCompareChangeRows: (entry: CompareEntry) => CompareChangeRow[]
  formatDiffValue: (value: unknown) => string
  severityClass: (value?: string) => string
  compareRowClass: (entry: CompareEntry) => string
  copyCompareDetailRows: () => Promise<void>
  exportCompareDetailCsv: () => void
  exportBomCompareCsv: () => void
  getItemNumber: (item: UnknownRecord | null | undefined) => string
  getItemName: (item: UnknownRecord | null | undefined) => string
  formatJson: (payload: unknown) => string
}

export function usePlmComparePanel(options: UsePlmComparePanelOptions) {
  const compareLeftQuickPick = ref('')
  const compareRightQuickPick = ref('')
  const compareMode = ref('')
  const compareMaxLevels = ref(options.defaultCompareMaxLevels)
  const compareLineKey = ref(options.defaultCompareLineKey)
  const compareIncludeChildFields = ref(true)
  const compareIncludeSubstitutes = ref(false)
  const compareIncludeEffectivity = ref(false)
  const compareSyncEnabled = ref(true)
  const compareEffectiveAt = ref('')
  const compareFilter = ref('')
  const compareRelationshipProps = ref(options.defaultCompareRelationshipProps)
  const bomCompare = ref<ComparePayload | null>(null)
  const compareLoading = ref(false)
  const compareError = ref('')
  const compareSchema = ref<CompareSchemaPayload | null>(null)
  const compareSchemaLoading = ref(false)
  const compareSchemaError = ref('')
  const compareSelected = ref<CompareSelection | null>(null)

  const compareLineKeyOptions = computed(() => {
    const list = compareSchema.value?.line_key_options
    return list && list.length ? list : options.defaultCompareLineKeys
  })
  const compareModeOptions = computed(() => compareSchema.value?.compare_modes || [])
  const compareFieldCatalog = computed(() => {
    const fields = compareSchema.value?.line_fields || []
    if (!fields.length) return options.defaultCompareFieldCatalog
    return fields.map((entry) => ({
      key: String(entry.field || ''),
      label: options.compareFieldLabels[String(entry.field || '')] || String(entry.field || ''),
      source: String(entry.description || '-'),
      severity: String(entry.severity || 'info'),
      normalized: String(entry.normalized || '-'),
    }))
  })
  const compareFieldLabelMap = computed(
    () => new Map(compareFieldCatalog.value.map((entry) => [entry.key, entry.label])),
  )
  const compareSelectedEntry = computed(() => compareSelected.value?.entry || null)
  const compareSelectedMeta = computed<CompareSelectionMeta | null>(() => {
    const selection = compareSelected.value
    if (!selection) return null
    const { entry, kind } = selection
    const parent = options.getCompareParent(entry)
    const child = options.getCompareChild(entry)
    const parentNumber = options.getItemNumber(parent)
    const parentName = options.getItemName(parent)
    const parentLabel = parentNumber !== '-' ? parentNumber : parentName !== '-' ? parentName : ''
    const childNumber = options.getItemNumber(child)
    const childName = options.getItemName(child)
    const childLabel = childNumber !== '-' ? childNumber : childName !== '-' ? childName : ''
    const pathLabel = [parentLabel, childLabel].filter(Boolean).join(' → ')
    return {
      kindLabel: kind === 'added' ? '新增' : kind === 'removed' ? '删除' : '变更',
      tagClass: `compare-kind-${kind}`,
      lineKey: String(entry.line_key || ''),
      relationshipId: String(entry.relationship_id || ''),
      pathLabel,
    }
  })
  const compareSummary = computed<CompareSummary>(() => bomCompare.value?.summary || {})
  const compareAdded = computed<CompareEntry[]>(() => bomCompare.value?.added || [])
  const compareRemoved = computed<CompareEntry[]>(() => bomCompare.value?.removed || [])
  const compareChanged = computed<CompareEntry[]>(() => bomCompare.value?.changed || [])
  const compareAddedFiltered = computed(() => options.filterCompareEntries(compareAdded.value))
  const compareRemovedFiltered = computed(() => options.filterCompareEntries(compareRemoved.value))
  const compareChangedFiltered = computed(() => options.filterCompareEntries(compareChanged.value))
  const compareTotalFiltered = computed(
    () => compareAddedFiltered.value.length + compareRemovedFiltered.value.length + compareChangedFiltered.value.length,
  )
  const compareDetailRows = computed<CompareDetailRow[]>(() => {
    const selection = compareSelected.value
    if (!selection) return []
    const { entry, kind } = selection
    const changeMap = new Map<string, UnknownRecord>()
    const changes = Array.isArray(entry.changes) ? entry.changes : []
    for (const change of changes) {
      if (change?.field) {
        changeMap.set(String(change.field), change)
      }
    }
    return compareFieldCatalog.value.map((field) => {
      const change = changeMap.get(field.key)
      const left = options.resolveCompareFieldValue(entry, kind, 'left', field.key)
      const right = options.resolveCompareFieldValue(entry, kind, 'right', field.key)
      const normalizedLeft = options.resolveCompareNormalizedValue(entry, kind, 'left', field.key, change)
      const normalizedRight = options.resolveCompareNormalizedValue(entry, kind, 'right', field.key, change)
      return {
        key: field.key,
        label: field.label,
        description: field.source && field.source !== '-' ? field.source : '',
        left,
        right,
        normalizedLeft,
        normalizedRight,
        severity: String(change?.severity || ''),
        changed: Boolean(change),
      }
    })
  })

  function applyCompareQuickPick(side: 'left' | 'right') {
    const value = side === 'left' ? compareLeftQuickPick.value : compareRightQuickPick.value
    if (!value) return
    if (side === 'left') {
      options.compareLeftId.value = value
      compareLeftQuickPick.value = ''
    } else {
      options.compareRightId.value = value
      compareRightQuickPick.value = ''
    }
    compareError.value = ''
    options.scheduleQuerySync({
      compareLeftId: options.compareLeftId.value || undefined,
      compareRightId: options.compareRightId.value || undefined,
    })
    options.setDeepLinkMessage(`已填入对比${side === 'left' ? '左' : '右'}侧 ID：${value}`)
  }

  function swapCompareSides() {
    if (!options.compareLeftId.value || !options.compareRightId.value) return
    const left = options.compareLeftId.value
    options.compareLeftId.value = options.compareRightId.value
    options.compareRightId.value = left
    options.scheduleQuerySync({
      compareLeftId: options.compareLeftId.value || undefined,
      compareRightId: options.compareRightId.value || undefined,
    })
    options.setDeepLinkMessage('已交换对比左右')
  }

  const comparePanel: PlmComparePanelModel = {
    copyDeepLink: options.copyDeepLink,
    applyCompareFromProduct: options.applyCompareFromProduct,
    applyCompareQuickPick,
    swapCompareSides,
    loadBomCompare: options.loadBomCompare,
    selectCompareEntry: options.selectCompareEntry,
    clearCompareSelection: options.clearCompareSelection,
    isCompareEntrySelected: options.isCompareEntrySelected,
    resolveCompareChildKey: options.resolveCompareChildKey,
    resolveCompareLineId: options.resolveCompareLineId,
    resolveCompareParentKey: options.resolveCompareParentKey,
    getCompareParent: options.getCompareParent,
    getCompareChild: options.getCompareChild,
    getCompareProp: options.getCompareProp,
    applyProductFromCompareParent: options.applyProductFromCompareParent,
    applyWhereUsedFromCompare: options.applyWhereUsedFromCompare,
    applySubstitutesFromCompare: options.applySubstitutesFromCompare,
    copyCompareLineId: options.copyCompareLineId,
    formatEffectivity: options.formatEffectivity,
    formatSubstituteCount: options.formatSubstituteCount,
    getCompareEntrySeverity: options.getCompareEntrySeverity,
    getCompareChangeRows: options.getCompareChangeRows,
    formatDiffValue: options.formatDiffValue,
    severityClass: options.severityClass,
    compareRowClass: options.compareRowClass,
    copyCompareDetailRows: options.copyCompareDetailRows,
    exportCompareDetailCsv: options.exportCompareDetailCsv,
    exportBomCompareCsv: options.exportBomCompareCsv,
    getItemNumber: options.getItemNumber,
    getItemName: options.getItemName,
    formatJson: options.formatJson,
    productId: options.productId,
    productLoading: options.productLoading,
    whereUsedLoading: options.whereUsedLoading,
    substitutesLoading: options.substitutesLoading,
    compareLeftId: options.compareLeftId,
    compareRightId: options.compareRightId,
    compareLeftQuickPick,
    compareRightQuickPick,
    compareMode,
    compareMaxLevels,
    compareLineKey,
    compareIncludeChildFields,
    compareIncludeSubstitutes,
    compareIncludeEffectivity,
    compareSyncEnabled,
    compareEffectiveAt,
    compareFilter,
    compareRelationshipProps,
    bomCompare,
    compareLoading,
    compareError,
    compareSchemaLoading,
    compareSchemaError,
    compareQuickOptions: options.compareQuickOptions,
    compareLineKeyOptions,
    compareModeOptions,
    compareSummary,
    compareAdded,
    compareRemoved,
    compareChanged,
    compareAddedFiltered,
    compareRemovedFiltered,
    compareChangedFiltered,
    compareTotalFiltered,
    compareSelectedEntry,
    compareSelectedMeta,
    compareDetailRows,
    compareFieldCatalog,
    compareFieldLabelMap,
  }

  return {
    compareLeftId: options.compareLeftId,
    compareRightId: options.compareRightId,
    compareLeftQuickPick,
    compareRightQuickPick,
    compareMode,
    compareMaxLevels,
    compareLineKey,
    compareIncludeChildFields,
    compareIncludeSubstitutes,
    compareIncludeEffectivity,
    compareSyncEnabled,
    compareEffectiveAt,
    compareFilter,
    compareRelationshipProps,
    bomCompare,
    compareLoading,
    compareError,
    compareSchema,
    compareSchemaLoading,
    compareSchemaError,
    compareSelected,
    compareSelectedEntry,
    compareSelectedMeta,
    compareDetailRows,
    compareFieldCatalog,
    compareFieldLabelMap,
    compareLineKeyOptions,
    compareModeOptions,
    compareSummary,
    compareAdded,
    compareRemoved,
    compareChanged,
    compareAddedFiltered,
    compareRemovedFiltered,
    compareChangedFiltered,
    compareTotalFiltered,
    comparePanel,
  }
}
