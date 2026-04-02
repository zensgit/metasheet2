import { computed, ref, watch } from 'vue'
import type {
  FilterFieldOption,
  FilterPreset,
  UnknownRecord,
  WhereUsedEntry,
  WhereUsedPathNode,
  WhereUsedPayload,
  WhereUsedTreeRowModel,
} from './plmPanelModels'

type UsePlmWhereUsedStateOptions = {
  defaultWhereUsedMaxLevels: number
  filterFieldOptions: FilterFieldOption[]
  getItemNumber: (item: UnknownRecord | null | undefined) => string
  getItemName: (item: UnknownRecord | null | undefined) => string
  getWhereUsedLineValue: (entry: WhereUsedEntry, key: string) => string
  getWhereUsedRefdes: (entry: WhereUsedEntry) => string
  resolveWhereUsedParentId: (entry: WhereUsedEntry) => string
  formatWhereUsedEntryPathIds: (entry: WhereUsedEntry) => string
}

type WhereUsedTreeNode = {
  id: string
  label: string
  name: string
  children: WhereUsedTreeNode[]
  entries: WhereUsedEntry[]
}

function normalizeFilterNeedle(value: string): string {
  return value.trim().toLowerCase()
}

function matchesFilter(needle: string, tokens: unknown[]): boolean {
  if (!needle) return true
  return tokens.some((token) => String(token || '').toLowerCase().includes(needle))
}

export function usePlmWhereUsedState(options: UsePlmWhereUsedStateOptions) {
  const whereUsedItemId = ref('')
  const whereUsedQuickPick = ref('')
  const whereUsedRecursive = ref(true)
  const whereUsedMaxLevels = ref(options.defaultWhereUsedMaxLevels)
  const whereUsedView = ref<'table' | 'tree'>('table')
  const whereUsedFilterField = ref('all')
  const whereUsedFilter = ref('')
  const whereUsedFilterPresetKey = ref('')
  const whereUsedFilterPresetName = ref('')
  const whereUsedFilterPresets = ref<FilterPreset[]>([])
  const whereUsedFilterPresetImportText = ref('')
  const whereUsedFilterPresetImportMode = ref<'merge' | 'replace'>('merge')
  const whereUsedFilterPresetGroup = ref('')
  const whereUsedFilterPresetGroupFilter = ref('all')
  const whereUsedFilterPresetFileInput = ref<HTMLInputElement | null>(null)
  const showWhereUsedPresetManager = ref(false)
  const whereUsedPresetSelection = ref<string[]>([])
  const whereUsedPresetBatchGroup = ref('')
  const whereUsed = ref<WhereUsedPayload | null>(null)
  const whereUsedLoading = ref(false)
  const whereUsedError = ref('')
  const whereUsedCollapsed = ref<Set<string>>(new Set())
  const whereUsedSelectedEntryKeys = ref<Set<string>>(new Set())

  const whereUsedFilterPlaceholder = computed(() => {
    const option = options.filterFieldOptions.find((entry) => entry.value === whereUsedFilterField.value)
    return option?.placeholder || '父件/路径/关系 ID'
  })
  const canSaveWhereUsedFilterPreset = computed(
    () => Boolean(whereUsedFilter.value.trim() && whereUsedFilterPresetName.value.trim()),
  )
  const whereUsedFilterPresetGroups = computed(() => {
    const groups = new Set<string>()
    for (const preset of whereUsedFilterPresets.value) {
      const group = String(preset.group || '').trim()
      if (group) groups.add(group)
    }
    return Array.from(groups).sort((left, right) => left.localeCompare(right))
  })
  const whereUsedFilteredPresets = computed(() => {
    const filter = whereUsedFilterPresetGroupFilter.value
    if (filter === 'all') return whereUsedFilterPresets.value
    if (filter === 'ungrouped') {
      return whereUsedFilterPresets.value.filter((preset) => !String(preset.group || '').trim())
    }
    return whereUsedFilterPresets.value.filter((preset) => String(preset.group || '').trim() === filter)
  })
  const whereUsedPresetSelectionCount = computed(() => whereUsedPresetSelection.value.length)

  function getWhereUsedFilterTokens(entry: WhereUsedEntry, field: string): unknown[] {
    const tokens = {
      parent_number: [options.getItemNumber(entry.parent)],
      parent_name: [options.getItemName(entry.parent)],
      relationship_id: [entry?.relationship?.id],
      path: [entry?.pathLabel, options.formatWhereUsedEntryPathIds(entry)],
      find_num: [options.getWhereUsedLineValue(entry, 'find_num')],
      refdes: [options.getWhereUsedRefdes(entry)],
      quantity: [options.getWhereUsedLineValue(entry, 'quantity')],
      uom: [options.getWhereUsedLineValue(entry, 'uom')],
    }
    if (field === 'all') {
      return [
        ...tokens.parent_number,
        ...tokens.parent_name,
        ...tokens.relationship_id,
        ...tokens.path,
        ...tokens.find_num,
        ...tokens.refdes,
        ...tokens.quantity,
        ...tokens.uom,
      ]
    }
    return tokens[field as keyof typeof tokens] || []
  }

  const whereUsedRows = computed<WhereUsedEntry[]>(() => {
    const payload = whereUsed.value
    const parents = payload?.parents || []
    const rootId = payload?.item_id || ''
    if (!parents.length) return []

    const levelIndex = new Map<number, Map<string, WhereUsedEntry>>()
    for (const entry of parents) {
      const level = Number(entry?.level || 1)
      const parentId = String(entry?.parent?.id || entry?.relationship?.source_id || '')
      if (!parentId) continue
      if (!levelIndex.has(level)) {
        levelIndex.set(level, new Map())
      }
      levelIndex.get(level)?.set(parentId, entry)
    }

    const buildNode = (item: UnknownRecord | null | undefined, fallbackId?: string): WhereUsedPathNode => {
      const id = String(item?.id || fallbackId || '')
      const label = String(item?.item_number || item?.itemNumber || item?.code || item?.name || id)
      return { id, label, name: String(item?.name || '') }
    }

    const buildPath = (entry: WhereUsedEntry): WhereUsedPathNode[] => {
      const nodes: WhereUsedPathNode[] = []
      const parentNode = buildNode(entry.parent, entry?.relationship?.source_id)
      if (parentNode.id) nodes.unshift(parentNode)

      let currentLevel = Number(entry?.level || 1)
      let childId = entry?.relationship?.related_id
      while (currentLevel > 1 && childId) {
        const prevEntry = levelIndex.get(currentLevel - 1)?.get(String(childId))
        if (!prevEntry) break
        const node = buildNode(prevEntry.parent, prevEntry?.relationship?.source_id)
        if (node.id) nodes.unshift(node)
        childId = prevEntry?.relationship?.related_id
        currentLevel = Number(prevEntry?.level || currentLevel - 1)
      }

      if (rootId) {
        nodes.unshift({ id: rootId, label: rootId, name: '' })
      }
      return nodes
    }

    return parents.map((entry, idx) => {
      const pathNodes = buildPath(entry)
      const pathLabel = pathNodes.map((node) => node.label).filter(Boolean).join(' → ')
      const key = entry?.relationship?.id || `${entry?.parent?.id || 'row'}-${idx}`
      return { ...entry, _key: key, pathNodes, pathLabel }
    })
  })

  const whereUsedFilteredRows = computed<WhereUsedEntry[]>(() => {
    const needle = normalizeFilterNeedle(whereUsedFilter.value)
    if (!needle) return whereUsedRows.value
    return whereUsedRows.value.filter((entry) => {
      const tokens = getWhereUsedFilterTokens(entry, whereUsedFilterField.value)
      return matchesFilter(needle, tokens)
    })
  })

  const whereUsedPathIdsList = computed(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const entry of whereUsedFilteredRows.value) {
      const pathIds = options.formatWhereUsedEntryPathIds(entry)
      if (!pathIds || seen.has(pathIds)) continue
      seen.add(pathIds)
      list.push(pathIds)
    }
    return list
  })
  const whereUsedPathIdsCount = computed(() => whereUsedPathIdsList.value.length)

  function resolveWhereUsedEntryKey(entry: WhereUsedEntry): string {
    return String(entry?._key || entry?.relationship?.id || '')
  }

  const whereUsedSelectedEntries = computed(() => {
    const selected = whereUsedSelectedEntryKeys.value
    if (!selected.size) return []
    return whereUsedRows.value.filter((entry) => {
      const key = resolveWhereUsedEntryKey(entry)
      return key && selected.has(key)
    })
  })
  const whereUsedSelectedParents = computed(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const entry of whereUsedSelectedEntries.value) {
      const parentId = options.resolveWhereUsedParentId(entry)
      const fallback = parentId || options.getItemNumber(entry.parent)
      if (!fallback || seen.has(fallback)) continue
      seen.add(fallback)
      list.push(fallback)
    }
    return list
  })
  const whereUsedSelectedCount = computed(() => whereUsedSelectedEntryKeys.value.size)

  const whereUsedTree = computed(() => {
    const rows = whereUsedFilteredRows.value
    if (!rows.length) return null
    const firstPathNode = rows[0]?.pathNodes?.[0]
    const fallbackRootId = String(whereUsed.value?.item_id || whereUsedItemId.value || '')
    const rootId = String(firstPathNode?.id || fallbackRootId || firstPathNode?.label || 'root')
    const rootLabel = String(firstPathNode?.label || rootId)
    const rootName = String(firstPathNode?.name || '')
    const root: WhereUsedTreeNode = {
      id: rootId,
      label: rootLabel,
      name: rootName,
      children: [],
      entries: [],
    }

    const isRootNode = (node: WhereUsedPathNode | undefined) => {
      const nodeId = node?.id || ''
      const nodeLabel = node?.label || ''
      return (nodeId && nodeId === root.id) || (nodeLabel && nodeLabel === root.label)
    }

    for (const entry of rows) {
      const pathNodes = Array.isArray(entry.pathNodes) ? entry.pathNodes : []
      if (!pathNodes.length) {
        root.entries.push(entry)
        continue
      }
      let current: WhereUsedTreeNode = root
      const startIndex = isRootNode(pathNodes[0]) ? 1 : 0
      for (let i = startIndex; i < pathNodes.length; i += 1) {
        const info = pathNodes[i]
        const nodeId = String(info?.id || info?.label || 'unknown')
        const nodeLabel = String(info?.label || info?.id || nodeId)
        const nodeName = String(info?.name || '')
        let child = current.children.find((item) => item.id === nodeId && item.label === nodeLabel)
        if (!child) {
          child = { id: nodeId, label: nodeLabel, name: nodeName, children: [], entries: [] }
          current.children.push(child)
        }
        current = child
      }
      current.entries.push(entry)
    }

    return root
  })

  const whereUsedTreeRows = computed<WhereUsedTreeRowModel[]>(() => {
    const root = whereUsedTree.value
    if (!root) return []
    const rows: WhereUsedTreeRowModel[] = []
    const walk = (
      node: WhereUsedTreeNode,
      depth: number,
      path: string,
      parentKey: string | undefined,
      pathLabels: string[],
      pathIds: string[],
    ) => {
      const key = path ? `${path}/${node.id}` : node.id
      const labelToken = String(node.label || node.id || key)
      const idToken = String(node.id || node.label || key)
      const nextLabels = [...pathLabels, labelToken]
      const nextIds = [...pathIds, idToken]
      rows.push({
        key,
        parentKey,
        id: String(node.id || ''),
        label: String(node.label || ''),
        name: String(node.name || ''),
        depth,
        hasChildren: Array.isArray(node.children) && node.children.length > 0,
        entries: node.entries || [],
        entryCount: Array.isArray(node.entries) ? node.entries.length : 0,
        pathLabels: nextLabels,
        pathIds: nextIds,
      })
      for (const child of node.children || []) {
        walk(child, depth + 1, key, key, nextLabels, nextIds)
      }
    }
    walk(root, 0, '', undefined, [], [])
    return rows
  })

  const whereUsedTreeVisibleRows = computed<WhereUsedTreeRowModel[]>(() => {
    const rows = whereUsedTreeRows.value
    if (!rows.length) return []
    const parentMap = new Map(rows.map((row) => [row.key, row.parentKey || '']))
    const collapsed = whereUsedCollapsed.value
    return rows.filter((row) => {
      let parentKey = row.parentKey
      while (parentKey) {
        if (collapsed.has(parentKey)) return false
        parentKey = parentMap.get(parentKey) || ''
      }
      return true
    })
  })

  const whereUsedHasTree = computed(() => whereUsedTreeRows.value.some((row) => row.hasChildren))
  const whereUsedTreePathIdsList = computed(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const row of whereUsedTreeVisibleRows.value) {
      const pathIds = row.pathIds.filter((token) => String(token || '').length > 0).join(' / ')
      if (!pathIds || seen.has(pathIds)) continue
      seen.add(pathIds)
      list.push(pathIds)
    }
    return list
  })
  const whereUsedTreePathIdsCount = computed(() => whereUsedTreePathIdsList.value.length)

  function clearWhereUsedSelection() {
    whereUsedSelectedEntryKeys.value = new Set()
  }

  function setWhereUsedSelection(keys: string[]) {
    const nextKeys = keys.filter(Boolean)
    if (!nextKeys.length) {
      whereUsedSelectedEntryKeys.value = new Set()
      return
    }
    const next = new Set(whereUsedSelectedEntryKeys.value)
    const hasAll = nextKeys.every((key) => next.has(key))
    for (const key of nextKeys) {
      if (hasAll) next.delete(key)
      else next.add(key)
    }
    whereUsedSelectedEntryKeys.value = next
  }

  function isWhereUsedEntrySelected(entry: WhereUsedEntry): boolean {
    const key = resolveWhereUsedEntryKey(entry)
    return key ? whereUsedSelectedEntryKeys.value.has(key) : false
  }

  function isWhereUsedTreeSelected(row: WhereUsedTreeRowModel): boolean {
    if (!row.entries.length) return false
    const selected = whereUsedSelectedEntryKeys.value
    for (const entry of row.entries) {
      const key = resolveWhereUsedEntryKey(entry)
      if (key && selected.has(key)) return true
    }
    return false
  }

  function selectWhereUsedTreeRow(row: WhereUsedTreeRowModel): void {
    const keys = row.entries.map((entry) => resolveWhereUsedEntryKey(entry)).filter(Boolean)
    setWhereUsedSelection(keys)
  }

  function selectWhereUsedTableRow(entry: WhereUsedEntry): void {
    const key = resolveWhereUsedEntryKey(entry)
    setWhereUsedSelection(key ? [key] : [])
  }

  function isWhereUsedCollapsed(key: string): boolean {
    return whereUsedCollapsed.value.has(key)
  }

  function toggleWhereUsedNode(key: string): void {
    const next = new Set(whereUsedCollapsed.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    whereUsedCollapsed.value = next
  }

  function expandAllWhereUsed(): void {
    whereUsedCollapsed.value = new Set()
  }

  function collapseAllWhereUsed(): void {
    const next = new Set<string>()
    for (const row of whereUsedTreeRows.value) {
      if (row.hasChildren) next.add(row.key)
    }
    whereUsedCollapsed.value = next
  }

  watch(
    () => [whereUsedFilterPresetGroupFilter.value, whereUsedFilterPresets.value],
    () => {
      if (!whereUsedFilteredPresets.value.some((preset) => preset.key === whereUsedFilterPresetKey.value)) {
        whereUsedFilterPresetKey.value = ''
      }
      const allowed = new Set(whereUsedFilteredPresets.value.map((preset) => preset.key))
      whereUsedPresetSelection.value = whereUsedPresetSelection.value.filter((key) => allowed.has(key))
    },
  )

  watch(showWhereUsedPresetManager, (value) => {
    if (value) return
    whereUsedPresetSelection.value = []
    whereUsedPresetBatchGroup.value = ''
  })

  watch(whereUsed, () => {
    whereUsedCollapsed.value = new Set()
    whereUsedSelectedEntryKeys.value = new Set()
  })

  return {
    whereUsedItemId,
    whereUsedQuickPick,
    whereUsedRecursive,
    whereUsedMaxLevels,
    whereUsedView,
    whereUsedFilterFieldOptions: options.filterFieldOptions,
    whereUsedFilterField,
    whereUsedFilter,
    whereUsedFilterPresetKey,
    whereUsedFilterPresetName,
    whereUsedFilterPresets,
    whereUsedFilterPresetImportText,
    whereUsedFilterPresetImportMode,
    whereUsedFilterPresetGroup,
    whereUsedFilterPresetGroupFilter,
    whereUsedFilterPresetFileInput,
    showWhereUsedPresetManager,
    whereUsedPresetSelection,
    whereUsedPresetBatchGroup,
    whereUsed,
    whereUsedLoading,
    whereUsedError,
    whereUsedCollapsed,
    whereUsedSelectedEntryKeys,
    whereUsedFilterPlaceholder,
    canSaveWhereUsedFilterPreset,
    whereUsedFilterPresetGroups,
    whereUsedFilteredPresets,
    whereUsedPresetSelectionCount,
    whereUsedRows,
    whereUsedFilteredRows,
    whereUsedPathIdsList,
    whereUsedPathIdsCount,
    whereUsedSelectedEntries,
    whereUsedSelectedParents,
    whereUsedSelectedCount,
    whereUsedTreeRows,
    whereUsedTreeVisibleRows,
    whereUsedHasTree,
    whereUsedTreePathIdsList,
    whereUsedTreePathIdsCount,
    clearWhereUsedSelection,
    isWhereUsedEntrySelected,
    isWhereUsedTreeSelected,
    selectWhereUsedTreeRow,
    selectWhereUsedTableRow,
    isWhereUsedCollapsed,
    toggleWhereUsedNode,
    expandAllWhereUsed,
    collapseAllWhereUsed,
  }
}
