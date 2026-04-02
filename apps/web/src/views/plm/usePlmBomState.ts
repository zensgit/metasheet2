import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type {
  BomLineRecord,
  BomTreeRowModel,
  FilterFieldOption,
  FilterPreset,
  PlmProductViewModel,
  QuickPickOption,
} from './plmPanelModels'

type UsePlmBomStateOptions = {
  defaultBomDepth: number
  bomDepthQuickOptions: number[]
  filterFieldOptions: FilterFieldOption[]
  productId: Ref<string>
  productView: ComputedRef<PlmProductViewModel>
  searchResultOptions: ComputedRef<QuickPickOption[]>
  resolveBomLineId: (item: BomLineRecord | null | undefined) => string
  resolveBomChildId: (item: BomLineRecord | null | undefined) => string
  resolveBomChildNumber: (item: BomLineRecord | null | undefined) => string
  formatBomFindNum: (item: BomLineRecord | null | undefined) => string
  formatBomRefdes: (item: BomLineRecord | null | undefined) => string
  formatBomPathIds: (row: BomTreeRowModel) => string
  formatBomTablePathIds: (item: BomLineRecord | null | undefined) => string
}

function normalizeFilterNeedle(value: string): string {
  return value.trim().toLowerCase()
}

function matchesFilter(needle: string, tokens: unknown[]): boolean {
  if (!needle) return true
  return tokens.some((token) => String(token || '').toLowerCase().includes(needle))
}

function buildQuickPickLabel(source: string, main: string, name: string, id: string): string {
  const mainLabel = main && main !== '-' ? main : id
  const nameLabel = name && name !== '-' ? name : ''
  const base = [mainLabel, nameLabel].filter(Boolean).join(' · ')
  const suffix = id && id !== mainLabel ? ` (${id})` : ''
  return `${source}: ${base || id}${suffix}`
}

export function usePlmBomState(options: UsePlmBomStateOptions) {
  const bomItems = ref<BomLineRecord[]>([])
  const bomLoading = ref(false)
  const bomError = ref('')
  const bomDepth = ref(options.defaultBomDepth)
  const bomEffectiveAt = ref('')
  const bomView = ref<'table' | 'tree'>('table')
  const bomCollapsed = ref<Set<string>>(new Set())
  const bomSelectedLineIds = ref<Set<string>>(new Set())
  const bomFilterField = ref('all')
  const bomFilter = ref('')
  const bomFilterPresetKey = ref('')
  const bomFilterPresetName = ref('')
  const bomFilterPresets = ref<FilterPreset[]>([])
  const bomFilterPresetImportText = ref('')
  const bomFilterPresetImportMode = ref<'merge' | 'replace'>('merge')
  const bomFilterPresetGroup = ref('')
  const bomFilterPresetGroupFilter = ref('all')
  const bomFilterPresetFileInput = ref<HTMLInputElement | null>(null)
  const showBomPresetManager = ref(false)
  const bomPresetSelection = ref<string[]>([])
  const bomPresetBatchGroup = ref('')

  const bomFilterPlaceholder = computed(() => {
    const option = options.filterFieldOptions.find((entry) => entry.value === bomFilterField.value)
    return option?.placeholder || '编号/名称/行 ID'
  })
  const canSaveBomFilterPreset = computed(
    () => Boolean(bomFilter.value.trim() && bomFilterPresetName.value.trim()),
  )
  const bomFilterPresetGroups = computed(() => {
    const groups = new Set<string>()
    for (const preset of bomFilterPresets.value) {
      const group = String(preset.group || '').trim()
      if (group) groups.add(group)
    }
    return Array.from(groups).sort((left, right) => left.localeCompare(right))
  })
  const bomFilteredPresets = computed(() => {
    const filter = bomFilterPresetGroupFilter.value
    if (filter === 'all') return bomFilterPresets.value
    if (filter === 'ungrouped') {
      return bomFilterPresets.value.filter((preset) => !String(preset.group || '').trim())
    }
    return bomFilterPresets.value.filter((preset) => String(preset.group || '').trim() === filter)
  })
  const bomPresetSelectionCount = computed(() => bomPresetSelection.value.length)

  function getBomFilterTokens(item: BomLineRecord, field: string): unknown[] {
    const lineId = options.resolveBomLineId(item)
    const tokens = {
      component: [item.component_code, item.component_id],
      name: [item.component_name],
      line_id: [lineId, item.id],
      parent_id: [item.parent_item_id],
      find_num: [options.formatBomFindNum(item)],
      refdes: [options.formatBomRefdes(item)],
      path: [options.formatBomTablePathIds(item)],
      quantity: [item.quantity],
      unit: [item.unit ?? item.uom],
    }
    if (field === 'all') {
      return [
        ...tokens.component,
        ...tokens.name,
        ...tokens.line_id,
        ...tokens.parent_id,
        ...tokens.find_num,
        ...tokens.refdes,
        ...tokens.path,
        ...tokens.quantity,
        ...tokens.unit,
      ]
    }
    return tokens[field as keyof typeof tokens] || []
  }

  const bomFilteredItems = computed(() => {
    const needle = normalizeFilterNeedle(bomFilter.value)
    if (!needle) return bomItems.value
    return bomItems.value.filter((item) => {
      const tokens = getBomFilterTokens(item, bomFilterField.value)
      return matchesFilter(needle, tokens)
    })
  })

  const bomSelectedItems = computed(() => {
    const selected = bomSelectedLineIds.value
    if (!selected.size) return []
    return bomItems.value.filter((item) => {
      const lineId = options.resolveBomLineId(item)
      return lineId && selected.has(lineId)
    })
  })

  const bomSelectedChildIds = computed(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const item of bomSelectedItems.value) {
      const target = options.resolveBomChildId(item) || options.resolveBomChildNumber(item)
      if (!target || seen.has(target)) continue
      seen.add(target)
      list.push(target)
    }
    return list
  })

  const bomChildOptions = computed<QuickPickOption[]>(() => {
    const list: QuickPickOption[] = []
    const seen = new Set<string>()
    const source = bomFilteredItems.value.length ? bomFilteredItems.value : bomItems.value
    for (const item of source) {
      const childId = options.resolveBomChildId(item)
      if (!childId || seen.has(childId)) continue
      seen.add(childId)
      const code = options.resolveBomChildNumber(item) || childId
      const name = String(item?.component_name || '')
      list.push({
        key: `bom-child:${childId}`,
        value: childId,
        label: buildQuickPickLabel('BOM', code, name, childId),
      })
    }
    return list
  })

  const bomLineOptions = computed<QuickPickOption[]>(() => {
    const list: QuickPickOption[] = []
    const seen = new Set<string>()
    const source = bomFilteredItems.value.length ? bomFilteredItems.value : bomItems.value
    for (const item of source) {
      const lineId = options.resolveBomLineId(item)
      if (!lineId || seen.has(lineId)) continue
      seen.add(lineId)
      const childId = options.resolveBomChildId(item)
      const code = options.resolveBomChildNumber(item) || childId || lineId
      const name = String(item?.component_name || '')
      list.push({
        key: `bom-line:${lineId}`,
        value: lineId,
        label: buildQuickPickLabel('BOM 行', code, name, lineId),
      })
    }
    return list
  })

  const bomSelectedCount = computed(() => bomSelectedLineIds.value.size)

  const bomTreeRows = computed<BomTreeRowModel[]>(() => {
    const items = bomItems.value
    if (!items.length) return []

    const parentMap = new Map<string, BomLineRecord[]>()
    for (const line of items) {
      const parentId = String(line?.parent_item_id || '')
      if (!parentMap.has(parentId)) {
        parentMap.set(parentId, [])
      }
      parentMap.get(parentId)?.push(line)
    }

    const rows: BomTreeRowModel[] = []
    const rootId = options.productId.value || options.productView.value.id || ''
    const rootLabel =
      options.productView.value.partNumber && options.productView.value.partNumber !== '-'
        ? options.productView.value.partNumber
        : rootId || 'root'
    const rootName = options.productView.value.name || ''
    const rootKey = rootId || rootLabel || 'root'
    const rootPathLabel = String(rootLabel || rootId || rootKey)
    const rootPathId = String(rootId || rootLabel || rootKey)

    const rootRow: BomTreeRowModel = {
      key: rootKey,
      parentKey: undefined,
      depth: 0,
      line: undefined,
      label: rootLabel,
      name: rootName,
      componentId: rootId,
      lineId: '',
      hasChildren: false,
      pathLabels: [rootPathLabel],
      pathIds: [rootPathId],
    }
    rows.push(rootRow)

    const sortLines = (lines: BomLineRecord[]) =>
      [...lines].sort((a, b) => {
        const aKey = String(a?.find_num ?? a?.component_code ?? a?.component_id ?? a?.id ?? '')
        const bKey = String(b?.find_num ?? b?.component_code ?? b?.component_id ?? b?.id ?? '')
        return aKey.localeCompare(bKey)
      })

    const seen = new Set<string>()
    const rootLines = [...(parentMap.get(rootId) || []), ...(parentMap.get('') || [])].filter((line) => {
      const key = options.resolveBomLineId(line) || `${options.resolveBomChildId(line)}-${options.resolveBomChildNumber(line)}`
      if (!key) return true
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    let autoIndex = 0
    const makeLineKey = (line: BomLineRecord) => {
      const base =
        options.resolveBomLineId(line) || options.resolveBomChildId(line) || options.resolveBomChildNumber(line)
      if (base) return base
      autoIndex += 1
      return `line-${autoIndex}`
    }

    const walk = (
      line: BomLineRecord,
      depth: number,
      parentKey: string,
      path: Set<string>,
      pathLabels: string[],
      pathIds: string[],
    ) => {
      const componentId = options.resolveBomChildId(line)
      const lineKey = makeLineKey(line)
      const key = `${parentKey}/${lineKey}`
      const label = String(line?.component_code || line?.component_id || componentId || options.resolveBomChildNumber(line) || lineKey)
      const name = String(line?.component_name || '')
      const lineId = options.resolveBomLineId(line)
      const nextLabels = [...pathLabels, label]
      const nextIds = [...pathIds, String(componentId || label || lineKey)]
      const nextPath = new Set(path)
      const hasCycle = componentId ? nextPath.has(componentId) : false
      if (componentId && !hasCycle) {
        nextPath.add(componentId)
      }
      const children = componentId && !hasCycle ? parentMap.get(componentId) || [] : []
      rows.push({
        key,
        parentKey,
        depth,
        line,
        label,
        name,
        componentId,
        lineId,
        hasChildren: children.length > 0,
        pathLabels: nextLabels,
        pathIds: nextIds,
      })
      for (const child of sortLines(children)) {
        walk(child, depth + 1, key, nextPath, nextLabels, nextIds)
      }
    }

    for (const line of sortLines(rootLines)) {
      walk(line, 1, rootKey, new Set(rootId ? [rootId] : []), rootRow.pathLabels, rootRow.pathIds)
    }
    rootRow.hasChildren = rows.length > 1
    return rows
  })

  function getBomTreeFilterTokens(row: BomTreeRowModel, field: string): unknown[] {
    const line = row.line || {}
    const lineId = row.lineId || (row.line ? options.resolveBomLineId(row.line) : '')
    const tokens = {
      component: [row.label, row.componentId],
      name: [row.name],
      line_id: [lineId],
      parent_id: [line?.parent_item_id ?? line?.parentItemId],
      find_num: [row.line ? options.formatBomFindNum(row.line) : ''],
      refdes: [row.line ? options.formatBomRefdes(row.line) : ''],
      path: [options.formatBomPathIds(row)],
      quantity: [row.line?.quantity],
      unit: [row.line?.unit ?? row.line?.uom],
    }
    if (field === 'all') {
      return [
        ...tokens.component,
        ...tokens.name,
        ...tokens.line_id,
        ...tokens.parent_id,
        ...tokens.find_num,
        ...tokens.refdes,
        ...tokens.path,
        ...tokens.quantity,
        ...tokens.unit,
      ]
    }
    return tokens[field as keyof typeof tokens] || []
  }

  const bomTreeFilteredKeys = computed(() => {
    const rows = bomTreeRows.value
    if (!rows.length) return new Set<string>()
    const needle = normalizeFilterNeedle(bomFilter.value)
    if (!needle) return new Set(rows.map((row) => row.key))

    const matches = new Set<string>()
    for (const row of rows) {
      const tokens = getBomTreeFilterTokens(row, bomFilterField.value)
      if (matchesFilter(needle, tokens)) {
        matches.add(row.key)
      }
    }

    const parentMap = new Map(rows.map((row) => [row.key, row.parentKey || '']))
    const included = new Set<string>()
    for (const key of matches) {
      let current = key
      while (current) {
        included.add(current)
        current = parentMap.get(current) || ''
      }
    }
    return included
  })

  const bomTreeVisibleRows = computed<BomTreeRowModel[]>(() => {
    const rows = bomTreeRows.value
    if (!rows.length) return []
    const included = bomTreeFilteredKeys.value
    const parentMap = new Map(rows.map((row) => [row.key, row.parentKey || '']))
    const collapsed = bomCollapsed.value
    return rows.filter((row) => {
      if (!included.has(row.key)) return false
      let parentKey = row.parentKey
      while (parentKey) {
        if (collapsed.has(parentKey)) return false
        parentKey = parentMap.get(parentKey) || ''
      }
      return true
    })
  })

  const bomTreeVisibleCount = computed(() => bomTreeVisibleRows.value.filter((row) => row.line).length)
  const bomTablePathIdsList = computed(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const item of bomFilteredItems.value) {
      const pathIds = options.formatBomTablePathIds(item)
      if (!pathIds || seen.has(pathIds)) continue
      seen.add(pathIds)
      list.push(pathIds)
    }
    return list
  })
  const bomTablePathIdsCount = computed(() => bomTablePathIdsList.value.length)
  const bomTreePathIdsList = computed(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const row of bomTreeVisibleRows.value) {
      if (!row.line) continue
      const pathIds = options.formatBomPathIds(row)
      if (!pathIds || seen.has(pathIds)) continue
      seen.add(pathIds)
      list.push(pathIds)
    }
    return list
  })
  const bomTreePathIdsCount = computed(() => bomTreePathIdsList.value.length)
  const bomTreeFilteredCount = computed(() => {
    const included = bomTreeFilteredKeys.value
    return bomTreeRows.value.filter((row) => row.line && included.has(row.key)).length
  })
  const bomHasTree = computed(() => bomTreeRows.value.some((row) => row.hasChildren))
  const bomDisplayCount = computed(() =>
    bomView.value === 'tree' ? bomTreeVisibleCount.value : bomFilteredItems.value.length,
  )
  const bomExportCount = computed(() =>
    bomView.value === 'tree' ? bomTreeFilteredCount.value : bomFilteredItems.value.length,
  )

  function setBomDepthQuick(value: number): void {
    const next = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : options.defaultBomDepth
    bomDepth.value = next
  }

  function setBomSelection(lineIds: string[]) {
    const nextIds = lineIds.filter(Boolean)
    if (!nextIds.length) {
      bomSelectedLineIds.value = new Set()
      return
    }
    const next = new Set(bomSelectedLineIds.value)
    const hasAll = nextIds.every((id) => next.has(id))
    for (const id of nextIds) {
      if (hasAll) next.delete(id)
      else next.add(id)
    }
    bomSelectedLineIds.value = next
  }

  function clearBomSelection() {
    bomSelectedLineIds.value = new Set()
  }

  function isBomItemSelected(item: BomLineRecord): boolean {
    const lineId = options.resolveBomLineId(item)
    return lineId ? bomSelectedLineIds.value.has(lineId) : false
  }

  function isBomTreeSelected(row: BomTreeRowModel): boolean {
    const lineId = row.line ? options.resolveBomLineId(row.line) : ''
    return lineId ? bomSelectedLineIds.value.has(lineId) : false
  }

  function selectBomTreeRow(row: BomTreeRowModel): void {
    const lineId = row.line ? options.resolveBomLineId(row.line) : ''
    setBomSelection(lineId ? [lineId] : [])
  }

  function selectBomTableRow(item: BomLineRecord): void {
    const lineId = options.resolveBomLineId(item)
    setBomSelection(lineId ? [lineId] : [])
  }

  function isBomCollapsed(key: string): boolean {
    return bomCollapsed.value.has(key)
  }

  function toggleBomNode(key: string): void {
    const next = new Set(bomCollapsed.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    bomCollapsed.value = next
  }

  function expandAllBom(): void {
    bomCollapsed.value = new Set()
  }

  function collapseAllBom(): void {
    const next = new Set<string>()
    for (const row of bomTreeRows.value) {
      if (row.hasChildren) next.add(row.key)
    }
    bomCollapsed.value = next
  }

  function expandBomToDepth(depth: number): void {
    const target = Number.isFinite(depth) ? Math.max(1, Math.floor(depth)) : options.defaultBomDepth
    const next = new Set<string>()
    for (const row of bomTreeRows.value) {
      if (row.hasChildren && row.depth >= target) {
        next.add(row.key)
      }
    }
    bomCollapsed.value = next
  }

  watch(
    () => [bomFilterPresetGroupFilter.value, bomFilterPresets.value],
    () => {
      if (!bomFilteredPresets.value.some((preset) => preset.key === bomFilterPresetKey.value)) {
        bomFilterPresetKey.value = ''
      }
      const allowed = new Set(bomFilteredPresets.value.map((preset) => preset.key))
      bomPresetSelection.value = bomPresetSelection.value.filter((key) => allowed.has(key))
    },
  )

  watch(showBomPresetManager, (value) => {
    if (value) return
    bomPresetSelection.value = []
    bomPresetBatchGroup.value = ''
  })

  watch(bomItems, () => {
    bomSelectedLineIds.value = new Set()
  })

  return {
    BOM_DEPTH_QUICK_OPTIONS: options.bomDepthQuickOptions,
    bomItems,
    bomLoading,
    bomError,
    bomDepth,
    bomEffectiveAt,
    bomView,
    bomCollapsed,
    bomSelectedLineIds,
    bomFilterFieldOptions: options.filterFieldOptions,
    bomFilterField,
    bomFilter,
    bomFilterPresetKey,
    bomFilterPresetName,
    bomFilterPresets,
    bomFilterPresetImportText,
    bomFilterPresetImportMode,
    bomFilterPresetGroup,
    bomFilterPresetGroupFilter,
    bomFilterPresetFileInput,
    showBomPresetManager,
    bomPresetSelection,
    bomPresetBatchGroup,
    bomFilterPlaceholder,
    canSaveBomFilterPreset,
    bomFilterPresetGroups,
    bomFilteredPresets,
    bomPresetSelectionCount,
    bomFilteredItems,
    bomSelectedItems,
    bomSelectedChildIds,
    bomChildOptions,
    bomLineOptions,
    bomSelectedCount,
    bomTreeRows,
    bomTreeFilteredKeys,
    bomTreeVisibleRows,
    bomTreeVisibleCount,
    bomTablePathIdsList,
    bomTablePathIdsCount,
    bomTreePathIdsList,
    bomTreePathIdsCount,
    bomTreeFilteredCount,
    bomHasTree,
    bomDisplayCount,
    bomExportCount,
    setBomDepthQuick,
    clearBomSelection,
    isBomItemSelected,
    isBomTreeSelected,
    selectBomTreeRow,
    selectBomTableRow,
    isBomCollapsed,
    toggleBomNode,
    expandAllBom,
    collapseAllBom,
    expandBomToDepth,
  }
}
