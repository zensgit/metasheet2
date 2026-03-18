import { ref, computed, watch, type Ref, type ComputedRef } from 'vue'
import type { MetaField, MetaRecord, MetaPage, PatchResult, LinkedRecordSummary } from '../types'
import { MultitableApiClient, multitableClient } from '../api/client'

// --- Sort / Filter types ---

export interface SortRule {
  fieldId: string
  direction: 'asc' | 'desc'
}

export type FilterOperator =
  | 'is' | 'isNot'
  | 'contains' | 'doesNotContain'
  | 'isEmpty' | 'isNotEmpty'
  | 'greater' | 'greaterEqual' | 'less' | 'lessEqual'

export type FilterConjunction = 'and' | 'or'

export interface FilterRule {
  fieldId: string
  operator: string
  value?: unknown
}

export interface CellEdit {
  recordId: string
  fieldId: string
  oldValue: unknown
  newValue: unknown
  version: number
}

// --- Serialisation helpers ---

export function buildSortInfo(rules: SortRule[]): { rules: Array<{ fieldId: string; desc: boolean }> } | undefined {
  if (!rules.length) return undefined
  return { rules: rules.map((r) => ({ fieldId: r.fieldId, desc: r.direction === 'desc' })) }
}

export function buildFilterInfo(
  rules: FilterRule[],
  conjunction: FilterConjunction = 'and',
): { conjunction: FilterConjunction; conditions: FilterRule[] } | undefined {
  if (!rules.length) return undefined
  return {
    conjunction,
    conditions: rules.map((r) => ({ fieldId: r.fieldId, operator: r.operator, value: r.value })),
  }
}

// --- Operator map by field type ---

export const FILTER_OPERATORS_BY_TYPE: Record<string, Array<{ value: string; label: string }>> = {
  string: [
    { value: 'is', label: 'is' },
    { value: 'isNot', label: 'is not' },
    { value: 'contains', label: 'contains' },
    { value: 'doesNotContain', label: 'does not contain' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  number: [
    { value: 'is', label: '=' },
    { value: 'isNot', label: '\u2260' },
    { value: 'greater', label: '>' },
    { value: 'greaterEqual', label: '\u2265' },
    { value: 'less', label: '<' },
    { value: 'lessEqual', label: '\u2264' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  boolean: [
    { value: 'is', label: 'is' },
    { value: 'isNot', label: 'is not' },
  ],
  select: [
    { value: 'is', label: 'is' },
    { value: 'isNot', label: 'is not' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  date: [
    { value: 'is', label: 'is' },
    { value: 'isNot', label: 'is not' },
    { value: 'greater', label: 'after' },
    { value: 'less', label: 'before' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  link: [
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  formula: [
    { value: 'is', label: 'is' },
    { value: 'isNot', label: 'is not' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  lookup: [
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  rollup: [
    { value: 'is', label: '=' },
    { value: 'greater', label: '>' },
    { value: 'less', label: '<' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
}

// --- Main composable ---

const DEFAULT_PAGE_SIZE = 50

export function useMultitableGrid(opts: {
  sheetId: Ref<string>
  viewId: Ref<string>
  client?: MultitableApiClient
  pageSize?: number
}) {
  const client = opts.client ?? multitableClient
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE

  // Core state
  const fields = ref<MetaField[]>([])
  const rows = ref<MetaRecord[]>([])
  const linkSummaries = ref<Record<string, Record<string, LinkedRecordSummary[]>>>({})
  const loading = ref(false)
  const error = ref<string | null>(null)

  // Pagination
  const page = ref<MetaPage>({ offset: 0, limit: pageSize, total: 0, hasMore: false })
  const currentPage = computed(() => Math.floor(page.value.offset / pageSize) + 1)
  const totalPages = computed(() => Math.max(1, Math.ceil(page.value.total / pageSize)))

  // Field visibility
  const hiddenFieldIds = ref<string[]>([])
  const visibleFields = computed(() =>
    fields.value.filter((f) => !hiddenFieldIds.value.includes(f.id)),
  )

  // Sort
  const sortRules = ref<SortRule[]>([])

  // Filter
  const filterRules = ref<FilterRule[]>([])
  const filterConjunction = ref<FilterConjunction>('and')
  const sortFilterDirty = ref(false)

  // GroupBy
  const groupFieldId = ref<string | null>(null)
  const groupField = computed(() =>
    groupFieldId.value ? fields.value.find((f) => f.id === groupFieldId.value) ?? null : null,
  )

  // Column widths (with localStorage persistence)
  const colWidthKey = computed(() => `mt_col_widths_${opts.sheetId.value}_${opts.viewId.value}`)
  function loadColumnWidths(): Record<string, number> {
    try {
      const raw = localStorage.getItem(colWidthKey.value)
      return raw ? JSON.parse(raw) : {}
    } catch { return {} }
  }
  const columnWidths = ref<Record<string, number>>(loadColumnWidths())

  // Undo/redo
  const editHistory = ref<CellEdit[]>([])
  const historyIndex = ref(-1)
  const canUndo = computed(() => historyIndex.value >= 0)
  const canRedo = computed(() => historyIndex.value < editHistory.value.length - 1)

  // --- Data loading ---

  async function loadViewData(offset = 0) {
    const sid = opts.sheetId.value
    const vid = opts.viewId.value
    if (!sid) return
    loading.value = true
    error.value = null
    try {
      // Persist dirty sort/filter before loading
      if (sortFilterDirty.value && vid) {
        await persistSortFilter(vid)
      }
      const data = await client.loadView({
        sheetId: sid,
        viewId: vid || undefined,
        limit: pageSize,
        offset,
        includeLinkSummaries: true,
      })
      fields.value = data.fields ?? []
      rows.value = data.rows ?? []
      linkSummaries.value = data.linkSummaries ?? {}
      if (data.page) page.value = data.page
      if (data.view) syncFromView(data.view)
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load view data'
    } finally {
      loading.value = false
    }
  }

  function syncFromView(view: { filterInfo?: Record<string, unknown>; sortInfo?: Record<string, unknown>; hiddenFieldIds?: string[] }) {
    // Parse server sort
    if (view.sortInfo && Array.isArray((view.sortInfo as any).rules)) {
      sortRules.value = ((view.sortInfo as any).rules as any[]).map((r: any) => ({
        fieldId: String(r.fieldId ?? ''),
        direction: r.desc ? 'desc' as const : 'asc' as const,
      })).filter((r) => r.fieldId)
    }
    // Parse server filter
    if (view.filterInfo && Array.isArray((view.filterInfo as any).conditions)) {
      filterConjunction.value = (view.filterInfo as any).conjunction === 'or' ? 'or' : 'and'
      filterRules.value = ((view.filterInfo as any).conditions as any[]).map((c: any) => ({
        fieldId: String(c.fieldId ?? ''),
        operator: String(c.operator ?? 'is'),
        value: c.value,
      })).filter((r) => r.fieldId)
    }
    if (view.hiddenFieldIds) hiddenFieldIds.value = [...view.hiddenFieldIds]
    if ((view as any).groupInfo?.fieldId) groupFieldId.value = (view as any).groupInfo.fieldId
    else groupFieldId.value = null
    sortFilterDirty.value = false
  }

  async function persistSortFilter(viewId: string) {
    try {
      await client.updateView(viewId, {
        sortInfo: buildSortInfo(sortRules.value) as Record<string, unknown> | undefined,
        filterInfo: buildFilterInfo(filterRules.value, filterConjunction.value) as Record<string, unknown> | undefined,
      })
      sortFilterDirty.value = false
    } catch {
      // silent — will retry on next load
    }
  }

  function applySortFilter() {
    sortFilterDirty.value = true
    page.value = { ...page.value, offset: 0 }
    loadViewData(0)
  }

  // --- Pagination ---

  function goToPage(p: number) {
    const offset = Math.max(0, (p - 1) * pageSize)
    loadViewData(offset)
  }

  // --- Field visibility ---

  function toggleFieldVisibility(fieldId: string) {
    const idx = hiddenFieldIds.value.indexOf(fieldId)
    if (idx >= 0) hiddenFieldIds.value.splice(idx, 1)
    else hiddenFieldIds.value.push(fieldId)
    persistHiddenFields()
  }

  async function setGroupField(fieldId: string | null) {
    groupFieldId.value = fieldId
    const vid = opts.viewId.value
    if (!vid) return
    try {
      await client.updateView(vid, { groupInfo: fieldId ? { fieldId } as Record<string, unknown> : undefined })
    } catch { /* silent */ }
  }

  async function persistHiddenFields() {
    const vid = opts.viewId.value
    if (!vid) return
    try {
      await client.updateView(vid, { hiddenFieldIds: [...hiddenFieldIds.value] })
    } catch { /* silent — will retry on next toggle */ }
  }

  // --- Sort ---

  function addSortRule(rule: SortRule) {
    const idx = sortRules.value.findIndex((r) => r.fieldId === rule.fieldId)
    if (idx >= 0) sortRules.value[idx] = rule
    else sortRules.value.push(rule)
    sortFilterDirty.value = true
  }

  function removeSortRule(fieldId: string) {
    sortRules.value = sortRules.value.filter((r) => r.fieldId !== fieldId)
    sortFilterDirty.value = true
  }

  // --- Filter ---

  function addFilterRule(rule: FilterRule) {
    filterRules.value.push(rule)
    sortFilterDirty.value = true
  }

  function updateFilterRule(index: number, rule: FilterRule) {
    if (index >= 0 && index < filterRules.value.length) {
      filterRules.value[index] = rule
      sortFilterDirty.value = true
    }
  }

  function removeFilterRule(index: number) {
    filterRules.value.splice(index, 1)
    sortFilterDirty.value = true
  }

  function clearFilters() {
    filterRules.value = []
    filterConjunction.value = 'and'
    sortFilterDirty.value = true
  }

  // --- Record CRUD ---

  async function createRecord(data?: Record<string, unknown>) {
    error.value = null
    try {
      await client.createRecord({
        sheetId: opts.sheetId.value || undefined,
        viewId: opts.viewId.value || undefined,
        data,
      })
      await loadViewData(page.value.offset)
    } catch (e: any) {
      error.value = e.message ?? 'Failed to create record'
    }
  }

  async function deleteRecord(recordId: string): Promise<boolean> {
    error.value = null
    try {
      const row = rows.value.find((r) => r.id === recordId)
      await client.deleteRecord(recordId, row?.version)
      await loadViewData(page.value.offset)
      return true
    } catch (e: any) {
      error.value = e.message ?? 'Failed to delete record'
      return false
    }
  }

  async function patchCell(recordId: string, fieldId: string, value: unknown, version: number) {
    error.value = null
    const row = rows.value.find((r) => r.id === recordId)
    const oldValue = row?.data[fieldId]

    // Optimistic update
    if (row) row.data[fieldId] = value

    try {
      const result = await client.patchRecords({
        sheetId: opts.sheetId.value || undefined,
        viewId: opts.viewId.value || undefined,
        changes: [{ recordId, fieldId, value, expectedVersion: version }],
      })
      applyPatchResult(result)
      // Push to undo history
      editHistory.value = editHistory.value.slice(0, historyIndex.value + 1)
      editHistory.value.push({ recordId, fieldId, oldValue, newValue: value, version })
      historyIndex.value = editHistory.value.length - 1
    } catch (e: any) {
      // Revert optimistic update
      if (row) row.data[fieldId] = oldValue
      error.value = e.message ?? 'Failed to patch cell'
    }
  }

  // --- Undo / Redo ---

  async function undo() {
    if (!canUndo.value) return
    const edit = editHistory.value[historyIndex.value]
    historyIndex.value--
    const row = rows.value.find((r) => r.id === edit.recordId)
    if (row) row.data[edit.fieldId] = edit.oldValue
    try {
      const result = await client.patchRecords({
        sheetId: opts.sheetId.value || undefined,
        changes: [{ recordId: edit.recordId, fieldId: edit.fieldId, value: edit.oldValue, expectedVersion: row?.version }],
      })
      applyPatchResult(result)
    } catch {
      // silent
    }
  }

  async function redo() {
    if (!canRedo.value) return
    historyIndex.value++
    const edit = editHistory.value[historyIndex.value]
    const row = rows.value.find((r) => r.id === edit.recordId)
    if (row) row.data[edit.fieldId] = edit.newValue
    try {
      const result = await client.patchRecords({
        sheetId: opts.sheetId.value || undefined,
        changes: [{ recordId: edit.recordId, fieldId: edit.fieldId, value: edit.newValue, expectedVersion: row?.version }],
      })
      applyPatchResult(result)
    } catch {
      // silent
    }
  }

  function applyPatchResult(result?: PatchResult) {
    if (!result) return
    for (const update of result.updated ?? []) {
      const row = rows.value.find((record) => record.id === update.recordId)
      if (row) row.version = update.version
    }
    for (const record of result.records ?? []) {
      const row = rows.value.find((item) => item.id === record.recordId)
      if (row) row.data = { ...row.data, ...record.data }
    }
  }

  function clearEditHistory() {
    editHistory.value = []
    historyIndex.value = -1
  }

  // --- Column width ---

  function setColumnWidth(fieldId: string, width: number) {
    columnWidths.value = { ...columnWidths.value, [fieldId]: width }
    try { localStorage.setItem(colWidthKey.value, JSON.stringify(columnWidths.value)) } catch { /* quota */ }
  }

  // --- Watch sheet/view changes ---

  watch(
    [opts.sheetId, opts.viewId],
    () => {
      sortFilterDirty.value = false
      clearEditHistory()
      if (opts.sheetId.value) loadViewData(0)
    },
    { immediate: true },
  )

  return {
    // State
    fields, rows, linkSummaries, loading, error, page, hiddenFieldIds, visibleFields,
    sortRules, filterRules, filterConjunction, sortFilterDirty,
    columnWidths, groupFieldId, groupField,
    editHistory, historyIndex, canUndo, canRedo,
    // Computed
    currentPage, totalPages,
    // Methods
    loadViewData, goToPage,
    toggleFieldVisibility,
    addSortRule, removeSortRule,
    addFilterRule, updateFilterRule, removeFilterRule, clearFilters,
    applySortFilter,
    createRecord, deleteRecord, patchCell,
    undo, redo, clearEditHistory,
    setColumnWidth, setGroupField,
  }
}
