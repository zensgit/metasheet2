import { ref, computed, watch, type Ref, type ComputedRef, type WatchStopHandle } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type {
  MetaCapabilityOrigin,
  LinkedRecordSummary,
  MetaAttachment,
  MetaField,
  MetaFieldPermission,
  MetaPage,
  MetaRecord,
  MetaRowActions,
  MetaViewPermission,
  PatchResult,
  PersonSummary,
} from '../types'
import { MultitableApiClient, multitableClient } from '../api/client'
import { isPropertyHiddenField } from '../utils/field-permissions'
import { metaCoreLabel } from '../utils/meta-core-labels'
import { resolveRollupFieldProperty, rollupResultType } from '../utils/field-config'

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

// 2a nested filter groups (mirrors the backend recursive AND/OR tree). A node is EITHER a leaf condition
// OR a (sub)group with its own conjunction. A flat filter is the degenerate case (root group of leaves).
export interface FilterGroup {
  conjunction: FilterConjunction
  conditions: FilterNode[]
}
export type FilterNode = FilterRule | FilterGroup
export function isFilterGroup(node: FilterNode): node is FilterGroup {
  return Array.isArray((node as FilterGroup).conditions)
}
// Authoring depth cap — mirror the backend MAX_FILTER_DEPTH so the UI never builds a filter the server 400s.
export const MAX_FILTER_DEPTH = 5

export interface CellEdit {
  recordId: string
  fieldId: string
  oldValue: unknown
  newValue: unknown
  version: number
  oldLinkSummaries?: LinkedRecordSummary[]
  newLinkSummaries?: LinkedRecordSummary[]
}

export interface GridConflictState {
  recordId: string
  fieldId: string
  attemptedValue: unknown
  message: string
  serverVersion?: number
  previousLinkSummaries?: LinkedRecordSummary[]
  nextLinkSummaries?: LinkedRecordSummary[]
}

type RemoteRecordMergeOptions = {
  linkSummaries?: Record<string, LinkedRecordSummary[]>
  personSummaries?: Record<string, PersonSummary[]>
  attachmentSummaries?: Record<string, MetaAttachment[]>
}

type RemoteRecordPatchOptions = {
  version?: number
  patch: Record<string, unknown>
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

// Recursively serialize one filter node (faithful + ORDER-preserving — the round-trip relies on it).
function serializeFilterNode(node: FilterNode): Record<string, unknown> {
  if (isFilterGroup(node)) {
    return { conjunction: node.conjunction, conditions: node.conditions.map(serializeFilterNode) }
  }
  return { fieldId: node.fieldId, operator: node.operator, value: node.value }
}

// Serialize a (possibly nested) root child list into a filterInfo payload. The nesting-aware counterpart
// of buildFilterInfo; when `nodes` are all leaves the output is byte-identical to buildFilterInfo.
export function buildFilterInfoFromNodes(
  nodes: FilterNode[],
  conjunction: FilterConjunction = 'and',
): { conjunction: FilterConjunction; conditions: Record<string, unknown>[] } | undefined {
  if (!nodes.length) return undefined
  return { conjunction, conditions: nodes.map(serializeFilterNode) }
}

// Recursively parse one raw filter node from a stored filterInfo. Depth-bounded (mirrors the backend cap);
// drops malformed leaves, empty groups, ambiguous (group+leaf) nodes, and groups nested past the cap.
function parseFilterNode(raw: unknown, depth: number): FilterNode | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (Array.isArray(obj.conditions)) {
    if (typeof obj.fieldId === 'string' || typeof obj.operator === 'string') return null // ambiguous shape
    if (depth >= MAX_FILTER_DEPTH) return null // too deep → drop (matches server cap)
    const children = (obj.conditions as unknown[])
      .map((c) => parseFilterNode(c, depth + 1))
      .filter((c): c is FilterNode => c !== null)
    if (!children.length) return null
    return { conjunction: obj.conjunction === 'or' ? 'or' : 'and', conditions: children }
  }
  const fieldId = String(obj.fieldId ?? '')
  if (!fieldId) return null
  return { fieldId, operator: String(obj.operator ?? 'is'), value: obj.value }
}

// Parse a stored filterInfo into the root conjunction + ordered child nodes (leaves and/or groups).
// Returns null when there is no usable filter. Symmetric with buildFilterInfoFromNodes (round-trips).
export function parseFilterTree(filterInfo: unknown): { conjunction: FilterConjunction; nodes: FilterNode[] } | null {
  if (!filterInfo || typeof filterInfo !== 'object') return null
  const obj = filterInfo as Record<string, unknown>
  if (!Array.isArray(obj.conditions)) return null
  const nodes = (obj.conditions as unknown[])
    .map((c) => parseFilterNode(c, 1))
    .filter((c): c is FilterNode => c !== null)
  if (!nodes.length) return null
  return { conjunction: obj.conjunction === 'or' ? 'or' : 'and', nodes }
}

// --- Operator map by field type ---

// Numeric field types (number/currency/percent/rating) share one operator set so
// the menu can't drift. Mirrors the backend isNumericQueryFieldType predicate
// (univer-meta.ts). See docs/development/multitable-typed-query-polish-design-20260603.md.
const NUMERIC_FILTER_OPERATORS: Array<{ value: string; label: string }> = [
  { value: 'is', label: '=' },
  { value: 'isNot', label: '≠' },
  { value: 'greater', label: '>' },
  { value: 'greaterEqual', label: '≥' },
  { value: 'less', label: '<' },
  { value: 'lessEqual', label: '≤' },
  { value: 'between', label: 'between' },
  { value: 'isEmpty', label: 'is empty' },
  { value: 'isNotEmpty', label: 'is not empty' },
]

export const FILTER_OPERATORS_BY_TYPE: Record<string, Array<{ value: string; label: string }>> = {
  string: [
    { value: 'is', label: 'is' },
    { value: 'isNot', label: 'is not' },
    { value: 'contains', label: 'contains' },
    { value: 'doesNotContain', label: 'does not contain' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  longText: [
    { value: 'is', label: 'is' },
    { value: 'isNot', label: 'is not' },
    { value: 'contains', label: 'contains' },
    { value: 'doesNotContain', label: 'does not contain' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  barcode: [
    { value: 'is', label: 'is' },
    { value: 'isNot', label: 'is not' },
    { value: 'contains', label: 'contains' },
    { value: 'doesNotContain', label: 'does not contain' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  qrcode: [
    { value: 'is', label: 'is' },
    { value: 'isNot', label: 'is not' },
    { value: 'contains', label: 'contains' },
    { value: 'doesNotContain', label: 'does not contain' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  location: [
    { value: 'is', label: 'is' },
    { value: 'isNot', label: 'is not' },
    { value: 'contains', label: 'contains' },
    { value: 'doesNotContain', label: 'does not contain' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  number: NUMERIC_FILTER_OPERATORS,
  currency: NUMERIC_FILTER_OPERATORS,
  percent: NUMERIC_FILTER_OPERATORS,
  rating: NUMERIC_FILTER_OPERATORS,
  boolean: [
    { value: 'is', label: 'is' },
    { value: 'isNot', label: 'is not' },
  ],
  select: [
    { value: 'is', label: 'is' },
    { value: 'isNot', label: 'is not' },
    { value: 'isAnyOf', label: 'is any of' },
    { value: 'isNoneOf', label: 'is none of' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  multiSelect: [
    { value: 'contains', label: 'contains' },
    { value: 'doesNotContain', label: 'does not contain' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  date: [
    { value: 'is', label: 'is' },
    { value: 'isNot', label: 'is not' },
    { value: 'greater', label: 'after' },
    { value: 'less', label: 'before' },
    { value: 'between', label: 'between' },
    // 2a relative-date operators (date fields only — mirrors backend evaluateRelativeDateOp,
    // gated on effectiveType === 'date'). Valueless ops + two N-window ops (last/next N days).
    { value: 'isToday', label: 'is today' },
    { value: 'isYesterday', label: 'is yesterday' },
    { value: 'isTomorrow', label: 'is tomorrow' },
    { value: 'isThisWeek', label: 'is this week' },
    { value: 'isThisMonth', label: 'is this month' },
    { value: 'isOverdue', label: 'is overdue' },
    { value: 'isLastNDays', label: 'in the last N days' },
    { value: 'isNextNDays', label: 'in the next N days' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  dateTime: [
    { value: 'is', label: 'is' },
    { value: 'isNot', label: 'is not' },
    { value: 'greater', label: 'after' },
    { value: 'less', label: 'before' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  // 2a filter-by-link (first cut): `is`/`contains` compare against the linked records' permission-filtered
  // DISPLAY strings (backend evaluateLinkFilterCondition); `isEmpty`/`isNotEmpty` test raw link presence.
  // Free-text value (no linked-record picker yet — deferred per design-lock D4). The row renders the
  // default free-text input for is/contains since link is not select-like (MetaFilterConditionRow).
  link: [
    { value: 'is', label: 'is' },
    { value: 'contains', label: 'contains' },
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
  // Default rollup entry = numeric ops (a count/sum/avg/... rollup). For concatenate/and/or/xor rollups,
  // effectiveFilterTypeKey resolves to string/boolean so the right ops are offered (slice 2b).
  rollup: [
    { value: 'is', label: '=' },
    { value: 'greater', label: '>' },
    { value: 'less', label: '<' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
}

// Slice 2b — the map key to use for a field's filter operators. A rollup's operators depend on its
// aggregation's result kind (concatenate → string, and/or/xor → boolean, else number), mirroring the
// backend resolveEffectiveFieldType. Non-rollup fields key by their own type.
export function effectiveFilterTypeKey(field: { type: string; property?: unknown } | null | undefined): string {
  if (!field) return 'string'
  if (field.type === 'rollup') return rollupResultType(resolveRollupFieldProperty(field.property).aggregation)
  return field.type
}

// --- Main composable ---

const DEFAULT_PAGE_SIZE = 50
const SEARCH_DEBOUNCE_MS = 150

// A1 infinite-scroll accumulation safety ceiling. Each loadMore() fetches only one page (pageSize rows)
// via offset pagination, so we never approach the server view-load `limit` clamp (max 5000) per fetch —
// this cap bounds total in-memory ROWS only (the DOM is already bounded by the grid windowing). Aligned
// with the server's 5000 view ceiling so the two limits don't silently diverge. On hit we STOP appending
// and log once (NO silent truncation): the user has scrolled past 5000 accumulated rows; narrow via
// filter/search to see further. Generous headroom for any realistic single-view scroll session.
const MAX_ACCUMULATED_ROWS = 5000

function normalizeRecordContextId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function decodeRoutePart(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const decoded = decodeURIComponent(value)
    return normalizeRecordContextId(decoded)
  } catch {
    return normalizeRecordContextId(value)
  }
}

type RecordCreateLocationSnapshot = {
  pathname?: string
  search?: string
  hash?: string
  href?: string
}

type RecordCreateRouteContext = {
  sheetId?: string
  viewId?: string
  isPublicFormRoute?: boolean
}

function readCurrentLocationSnapshot(): RecordCreateLocationSnapshot {
  try {
    const location = globalThis.location
    return {
      pathname: location?.pathname ?? '',
      search: location?.search ?? '',
      hash: location?.hash ?? '',
      href: location?.href ?? '',
    }
  } catch {
    return {}
  }
}

function parseCreateRecordRouteContext(value: string | undefined): RecordCreateRouteContext {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return {}

  const candidates = [raw]
  try {
    const url = new URL(raw, 'http://metasheet.local')
    candidates.push(url.pathname)
    if (url.hash) candidates.push(url.hash.slice(1))
  } catch {
    const hashIndex = raw.indexOf('#')
    if (hashIndex >= 0) candidates.push(raw.slice(hashIndex + 1))
  }

  for (const candidate of candidates) {
    const normalized = candidate.replace(/^#/, '').split(/[?#]/)[0]
    const segments = normalized.split('/').filter(Boolean)
    const multitableIndex = segments.lastIndexOf('multitable')
    if (multitableIndex < 0) continue
    if (segments[multitableIndex + 1] === 'public-form') {
      return { isPublicFormRoute: true }
    }
    return {
      sheetId: decodeRoutePart(segments[multitableIndex + 1]),
      viewId: decodeRoutePart(segments[multitableIndex + 2]),
    }
  }

  return {}
}

function parseCreateRecordQueryContext(value: string | undefined): { sheetId?: string; viewId?: string } {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return {}
  try {
    const url = raw.includes('?')
      ? new URL(raw, 'http://metasheet.local')
      : null
    const search = url?.search ?? (raw.startsWith('?') ? raw : `?${raw}`)
    const params = new URLSearchParams(search)
    return {
      sheetId: decodeRoutePart(params.get('sheetId') ?? undefined),
      viewId: decodeRoutePart(params.get('viewId') ?? undefined),
    }
  } catch {
    return {}
  }
}

export function resolveCreateRecordContext(args: {
  sheetId?: string | null
  viewId?: string | null
  href?: string
  hash?: string
  pathname?: string
  search?: string
}): { sheetId?: string; viewId?: string } {
  const sheetId = normalizeRecordContextId(args.sheetId)
  const viewId = normalizeRecordContextId(args.viewId)
  if (sheetId && viewId) return { sheetId, viewId }

  const location = readCurrentLocationSnapshot()
  const routeCandidates = [
    args.href,
    args.pathname,
    args.hash,
    location.href,
    location.pathname,
    location.hash,
  ]
  let routeSheetId: string | undefined
  let routeViewId: string | undefined
  for (const candidate of routeCandidates) {
    const routeContext = parseCreateRecordRouteContext(candidate)
    if (routeContext.isPublicFormRoute) return { sheetId, viewId }
    routeSheetId = routeSheetId ?? routeContext.sheetId
    routeViewId = routeViewId ?? routeContext.viewId
    if (routeSheetId && routeViewId) break
  }

  const queryCandidates = [
    args.search,
    args.href,
    args.hash,
    location.search,
    location.href,
    location.hash,
  ]
  let querySheetId: string | undefined
  let queryViewId: string | undefined
  for (const candidate of queryCandidates) {
    const queryContext = parseCreateRecordQueryContext(candidate)
    querySheetId = querySheetId ?? queryContext.sheetId
    queryViewId = queryViewId ?? queryContext.viewId
    if (querySheetId && queryViewId) break
  }

  return {
    sheetId: sheetId ?? routeSheetId ?? querySheetId,
    viewId: viewId ?? routeViewId ?? queryViewId,
  }
}

export function useMultitableGrid(opts: {
  sheetId: Ref<string>
  viewId: Ref<string>
  client?: MultitableApiClient
  pageSize?: number
}) {
  const client = opts.client ?? multitableClient
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE
  const { isZh } = useLocale()
  const fallback = (key: Parameters<typeof metaCoreLabel>[0]) => metaCoreLabel(key, isZh.value)

  // Core state
  const fields = ref<MetaField[]>([])
  const rows = ref<MetaRecord[]>([])
  const linkSummaries = ref<Record<string, Record<string, LinkedRecordSummary[]>>>({})
  // Native person (人员) display source (userId → {id,display}). Read-only here: refreshed on
  // each loadViewData (a person write echoes the userId[] value; display re-hydrates on refetch).
  const personSummaries = ref<Record<string, Record<string, PersonSummary[]>>>({})
  const attachmentSummaries = ref<Record<string, Record<string, MetaAttachment[]>>>({})
  const fieldPermissions = ref<Record<string, MetaFieldPermission>>({})
  const viewPermission = ref<MetaViewPermission | null>(null)
  const capabilityOrigin = ref<MetaCapabilityOrigin | null>(null)
  const rowActions = ref<MetaRowActions | null>(null)
  const rowActionOverrides = ref<Record<string, MetaRowActions>>({})
  const loading = ref(false)
  // A1 infinite-scroll: a SEPARATE in-flight flag for append fetches (loadMore). It must NOT reuse
  // `loading` — `loading` drives the full-screen grid spinner and is set by every full reload, while an
  // append is a quiet background fetch that should not blank the grid. Used to dedup rapid scroll events.
  const loadingMore = ref(false)
  // A1: latched true once accumulation hits MAX_ACCUMULATED_ROWS — surfaced (logged) so truncation is
  // never silent. Cleared on every reset (a reset starts a fresh accumulation from page 1).
  const accumulationCapped = ref(false)
  const error = ref<string | null>(null)
  const conflict = ref<GridConflictState | null>(null)
  // Monotonic request id shared by loadViewData (reset/replace) AND loadMore (append). A reset bumps it,
  // so any in-flight append re-checking it AFTER its await bails instead of appending stale, cross-filter
  // rows onto the freshly-reset set. This is the single guard that keeps the masked/filtered/sorted
  // per-fetch contract intact under interleaving (scroll-append racing a filter/sort/search/view change).
  let latestLoadRequestId = 0

  // Pagination
  const page = ref<MetaPage>({ offset: 0, limit: pageSize, total: 0, hasMore: false })
  const currentPage = computed(() => Math.floor(page.value.offset / pageSize) + 1)
  const totalPages = computed(() => Math.max(1, Math.ceil(page.value.total / pageSize)))

  // Field visibility
  const hiddenFieldIds = ref<string[]>([])
  const visibleFields = computed(() =>
    fields.value.filter((f) =>
      !hiddenFieldIds.value.includes(f.id)
      && !isPropertyHiddenField(f)
      && fieldPermissions.value[f.id]?.visible !== false,
    ),
  )
  const readOnlyFieldIds = computed(() =>
    fields.value
      .filter((field) => fieldPermissions.value[field.id]?.readOnly === true)
      .map((field) => field.id),
  )

  // Sort
  const sortRules = ref<SortRule[]>([])

  // Filter
  const filterRules = ref<FilterRule[]>([])
  const filterConjunction = ref<FilterConjunction>('and')
  // 2a nested groups: when a loaded view carries nested subgroups, the flat `filterRules` (top-level leaves)
  // cannot represent them, so the FULL ordered tree is preserved here and serialized faithfully on save —
  // a view authored via API/import round-trips without silent flattening. null = pure-flat mode. Any flat
  // edit (add/update/remove/clear) clears this: editing via the flat toolbar commits to the flat shape.
  // The recursive authoring UI (PR-2b) will make this the editable source of truth.
  const nestedFilterNodes = ref<FilterNode[] | null>(null)
  // 2b: editable root subgroups (the nested condition groups authored in the toolbar, recursively). The
  // flat `filterRules` are the root's leaf conditions; `filterGroups` are the root's group children. On save
  // the two are concatenated (leaves then groups) — `nestedFilterNodes` still serves the untouched-view
  // faithful passthrough, and ANY edit clears it so the editable filterRules+filterGroups become the truth.
  const filterGroups = ref<FilterGroup[]>([])
  const sortFilterDirty = ref(false)

  // GroupBy — ordered 1..MAX_GROUP_LEVELS group fields (nested / multi-level grouping). The array is the
  // source of truth; `groupFieldId` (level-1, legacy single-field reader) and `groupField` are derived.
  const MAX_GROUP_LEVELS = 3
  const groupFieldIds = ref<string[]>([])
  const groupFieldId = computed<string | null>(() => groupFieldIds.value[0] ?? null)
  // Ordered, de-referenced group fields (drops ids that no longer resolve to a loaded field).
  const groupFields = computed(() =>
    groupFieldIds.value
      .map((id) => fields.value.find((f) => f.id === id))
      .filter((f): f is MetaField => !!f),
  )
  const groupField = computed(() => groupFields.value[0] ?? null)

  // Server-side search
  const searchQuery = ref('')
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null

  function setSearchQuery(q: string) {
    if (q === searchQuery.value) return
    searchQuery.value = q
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
    searchDebounceTimer = setTimeout(() => {
      page.value = { ...page.value, offset: 0 }
      loadViewData(0)
    }, SEARCH_DEBOUNCE_MS)
  }

  // Column widths: now owned + persisted by the workbench in `view.config.columnWidths`
  // (persist-display-prefs arc 2026-06-16). The composable no longer holds a localStorage-backed
  // ref — the active widths flow down from the workbench as a prop, so this seam is gone here.

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
    const requestId = ++latestLoadRequestId
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
        search: searchQuery.value || undefined,
      })
      if (requestId !== latestLoadRequestId) return
      const serverPage = data.page
      const serverRows = data.rows ?? []
      if (serverPage && !serverRows.length && offset > 0 && offset >= serverPage.total) {
        const fallbackOffset = Math.max(0, Math.floor(Math.max(serverPage.total - 1, 0) / pageSize) * pageSize)
        if (fallbackOffset !== offset) {
          await loadViewData(fallbackOffset)
          return
        }
      }
      fields.value = data.fields ?? []
      rows.value = serverRows
      // A1: this is the RESET/REPLACE path (filter/sort/search/view/sheet change, pagination, mutation
      // reload). It bumped latestLoadRequestId above, so any in-flight append is already superseded; here
      // we also clear the accumulation latches so a fresh page-1 set starts a clean accumulation.
      accumulationCapped.value = false
      loadingMore.value = false
      linkSummaries.value = data.linkSummaries ?? {}
      personSummaries.value = data.personSummaries ?? {}
      attachmentSummaries.value = data.attachmentSummaries ?? {}
      fieldPermissions.value = data.meta?.permissions?.fieldPermissions ?? {}
      const nextViewPermission = data.view?.id
        ? (data.meta?.permissions?.viewPermissions?.[data.view.id] ?? null)
        : null
      viewPermission.value = nextViewPermission
      capabilityOrigin.value = data.meta?.capabilityOrigin ?? null
      rowActions.value = data.meta?.permissions?.rowActions ?? null
      rowActionOverrides.value = data.meta?.permissions?.rowActionOverrides ?? {}
      if (serverPage) page.value = serverPage
      if (data.view) syncFromView(data.view)
    } catch (e: any) {
      if (requestId !== latestLoadRequestId) return
      error.value = e.message ?? fallback('grid.errorLoadViewData')
    } finally {
      if (requestId === latestLoadRequestId) loading.value = false
    }
  }

  // A1 infinite-scroll: can we fetch + APPEND another page? True only when the last load reported more
  // rows server-side and we haven't hit the in-memory ceiling. The grid (MetaGridTable) additionally
  // gates the scroll trigger on the FLAT path (not grouped / not expanded / not printing) — those modes
  // keep the classic footer pager — so this stays a pure "is there a next page" predicate.
  const canLoadMore = computed(() => page.value.hasMore && !accumulationCapped.value)

  // A1: shallow-merge a per-record summary map (recordId → fieldMap) onto the accumulated one. APPEND
  // must MERGE, never replace: a replace would drop every earlier page's link/person/attachment chips
  // (the field-drop / wire-drift class). New keys win for the just-fetched records; existing records are
  // untouched (the fetched page only ever contains NEW record ids on the append path).
  function mergeSummaryMap<T>(
    target: Record<string, Record<string, T[]>>,
    incoming: Record<string, Record<string, T[]>> | undefined,
  ): Record<string, Record<string, T[]>> {
    if (!incoming || Object.keys(incoming).length === 0) return target
    return { ...target, ...incoming }
  }

  // A1 infinite-scroll APPEND. Fetches the NEXT page (offset = current accumulated row count) using the
  // EXISTING offset pagination + the server-side filter/sort/search already persisted on the view, then
  // APPENDS to `rows` so the grid can hold thousands of rows while the windowing keeps the DOM bounded.
  // Deliberately a SEPARATE function from loadViewData (which replaces rows, re-syncs the view, and
  // reassigns fields — all wrong for an append). Offset is PINNED at page.offset = 0 on the infinite path
  // so row numbers + the ~15 "reload after mutation" callers (loadViewData(page.offset)) degrade to a
  // clean reset-to-page-1 rather than a broken middle-window — no per-call-site change needed.
  async function loadMore() {
    const sid = opts.sheetId.value
    if (!sid) return
    // Dedup rapid scroll (already appending) + don't race a full reset (loading) + nothing more to fetch.
    if (loadingMore.value || loading.value || !canLoadMore.value) return

    const requestId = ++latestLoadRequestId
    loadingMore.value = true
    const startCount = rows.value.length
    try {
      const data = await client.loadView({
        sheetId: sid,
        viewId: opts.viewId.value || undefined,
        limit: pageSize,
        offset: startCount,
        includeLinkSummaries: true,
        search: searchQuery.value || undefined,
      })
      // A reset (filter/sort/search/view/sheet change, or a mutation reload) bumped the id while we were
      // in flight → DROP this page. Appending it would mix stale, cross-filter rows onto the fresh set,
      // breaking the "masked/filtered/sorted per fetch" contract. The reset already replaced rows.
      if (requestId !== latestLoadRequestId) return
      const serverPage = data.page
      const serverRows = data.rows ?? []

      // Append (preserve realtime correctness: patch/merge/remove operate by id over the whole array, so
      // a longer accumulated array is fine). New rows only — the offset guarantees no overlap with held
      // rows; a defensive de-dup by id guards a server that returns a boundary row twice.
      if (serverRows.length) {
        const held = new Set(rows.value.map((r) => r.id))
        const fresh = serverRows.filter((r) => !held.has(r.id))
        if (fresh.length) rows.value = [...rows.value, ...fresh]
      }
      // MERGE the three display-summary maps by recordId (never replace — see mergeSummaryMap).
      linkSummaries.value = mergeSummaryMap(linkSummaries.value, data.linkSummaries)
      personSummaries.value = mergeSummaryMap(personSummaries.value, data.personSummaries)
      attachmentSummaries.value = mergeSummaryMap(attachmentSummaries.value, data.attachmentSummaries)
      // Per-record row-action overrides are additive too (a denied/locked row in a later page).
      const incomingOverrides = data.meta?.permissions?.rowActionOverrides
      if (incomingOverrides && Object.keys(incomingOverrides).length) {
        rowActionOverrides.value = { ...rowActionOverrides.value, ...incomingOverrides }
      }

      // Pin offset at 0 (infinite path) so row numbers + mutation reloads behave; carry the server total
      // and hasMore forward. End-of-data backstop: a short page (< pageSize) means no more rows even if
      // the server's hasMore lagged.
      const nextHasMore = serverPage ? serverPage.hasMore && serverRows.length >= pageSize : false
      page.value = {
        offset: 0,
        limit: pageSize,
        total: serverPage?.total ?? rows.value.length,
        hasMore: nextHasMore,
      }

      // Memory ceiling: stop accumulating past MAX_ACCUMULATED_ROWS and surface it (NO silent truncation).
      if (rows.value.length >= MAX_ACCUMULATED_ROWS && page.value.hasMore) {
        accumulationCapped.value = true
        page.value = { ...page.value, hasMore: false }
        console.warn(
          `[multitable] grid accumulation reached the ${MAX_ACCUMULATED_ROWS}-row ceiling; ` +
          'further rows are not loaded — narrow the view with a filter or search to see beyond this point.',
        )
      }
    } catch {
      // Silent: an append failure leaves the already-held rows intact; the user can scroll to retry.
      // (loadViewData owns the user-facing error surface for the reset path.)
    } finally {
      // Only clear the flag if THIS request is still the latest — a superseding reset manages its own.
      if (requestId === latestLoadRequestId) loadingMore.value = false
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
    // Parse server filter (nesting-aware). The flat `filterRules` mirror the top-level LEAF conditions for
    // the current flat toolbar; if the stored filter has any subgroup, the full ordered tree is kept in
    // `nestedFilterNodes` so save round-trips faithfully (the old flat parse silently dropped group nodes —
    // a group has no fieldId, so `.filter(r => r.fieldId)` discarded it and the next save lost it).
    if (view.filterInfo && Array.isArray((view.filterInfo as any).conditions)) {
      const tree = parseFilterTree(view.filterInfo)
      filterConjunction.value = tree?.conjunction ?? 'and'
      filterRules.value = tree ? tree.nodes.filter((n): n is FilterRule => !isFilterGroup(n)) : []
      filterGroups.value = tree ? tree.nodes.filter((n): n is FilterGroup => isFilterGroup(n)) : []
      nestedFilterNodes.value = tree && tree.nodes.some(isFilterGroup) ? tree.nodes : null
    }
    if (view.hiddenFieldIds) hiddenFieldIds.value = [...view.hiddenFieldIds]
    // Dual-read for back-compat: prefer the NEW ordered groupInfo.fieldIds; fall back to the legacy
    // single groupInfo.fieldId so views persisted before nested grouping keep their (one) group level.
    const gi = (view as any).groupInfo as { fieldId?: unknown; fieldIds?: unknown } | undefined
    const rawIds: unknown[] = Array.isArray(gi?.fieldIds)
      ? gi!.fieldIds
      : typeof gi?.fieldId === 'string'
        ? [gi.fieldId]
        : []
    groupFieldIds.value = normalizeGroupFieldIds(rawIds)
    sortFilterDirty.value = false
  }

  async function persistSortFilter(viewId: string) {
    try {
      await client.updateView(viewId, {
        sortInfo: buildSortInfo(sortRules.value) as Record<string, unknown> | undefined,
        filterInfo: (nestedFilterNodes.value
          ? buildFilterInfoFromNodes(nestedFilterNodes.value, filterConjunction.value)
          : buildFilterInfoFromNodes([...filterRules.value, ...filterGroups.value], filterConjunction.value)) as Record<string, unknown> | undefined,
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
    const safePage = Math.min(Math.max(1, p), totalPages.value)
    const offset = Math.max(0, (safePage - 1) * pageSize)
    if (offset === page.value.offset) return
    loadViewData(offset)
  }

  // --- Field visibility ---

  function toggleFieldVisibility(fieldId: string) {
    const idx = hiddenFieldIds.value.indexOf(fieldId)
    if (idx >= 0) hiddenFieldIds.value.splice(idx, 1)
    else hiddenFieldIds.value.push(fieldId)
    persistHiddenFields()
  }

  // Normalize a raw id list to ordered, blank-free, de-duped, capped at MAX_GROUP_LEVELS. Used by both
  // syncFromView (parse) and setGroupFields (persist) so the in-memory + stored shapes can't diverge.
  function normalizeGroupFieldIds(raw: unknown[]): string[] {
    const out: string[] = []
    for (const id of raw) {
      if (typeof id !== 'string') continue
      const trimmed = id.trim()
      if (trimmed && !out.includes(trimmed)) out.push(trimmed)
      if (out.length >= MAX_GROUP_LEVELS) break
    }
    return out
  }

  // Set the ordered group fields (1..MAX_GROUP_LEVELS). Persists groupInfo.fieldIds (NEW shape) and the
  // legacy groupInfo.fieldId = level-1 so other views (Kanban/Gantt) reading the single-field shape and
  // any older reader keep working. Empty list clears grouping (groupInfo: undefined).
  async function setGroupFields(fieldIds: string[]) {
    const next = normalizeGroupFieldIds(fieldIds)
    groupFieldIds.value = next
    const vid = opts.viewId.value
    if (!vid) return
    try {
      await client.updateView(vid, {
        groupInfo: next.length ? ({ fieldIds: next, fieldId: next[0] } as Record<string, unknown>) : undefined,
      })
    } catch { /* silent */ }
  }

  // Back-compat single-field setter (level-1 only) kept for callers that still group by one field.
  async function setGroupField(fieldId: string | null) {
    await setGroupFields(fieldId ? [fieldId] : [])
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

  // Editing via the flat toolbar commits to the flat shape: drop any preserved nested tree so the flat
  // `filterRules` become the single source of truth on the next save (no stale nested/flat divergence).
  // PR-2b's recursive authoring UI will replace these flat ops with tree-aware edits.
  function addFilterRule(rule: FilterRule) {
    filterRules.value.push(rule)
    nestedFilterNodes.value = null
    sortFilterDirty.value = true
  }

  function updateFilterRule(index: number, rule: FilterRule) {
    if (index >= 0 && index < filterRules.value.length) {
      filterRules.value[index] = rule
      nestedFilterNodes.value = null
      sortFilterDirty.value = true
    }
  }

  function removeFilterRule(index: number) {
    filterRules.value.splice(index, 1)
    nestedFilterNodes.value = null
    sortFilterDirty.value = true
  }

  function clearFilters() {
    filterRules.value = []
    filterGroups.value = []
    filterConjunction.value = 'and'
    nestedFilterNodes.value = null
    sortFilterDirty.value = true
  }

  // 2b: nested condition-group edits. The recursive MetaFilterGroup emits the whole updated subtree, so an
  // update replaces the group at `index` wholesale. Like the flat ops, any edit drops the untouched-faithful
  // `nestedFilterNodes` cache so filterRules+filterGroups become the single source of truth on save.
  function addFilterGroup(group: FilterGroup) {
    filterGroups.value.push(group)
    nestedFilterNodes.value = null
    sortFilterDirty.value = true
  }
  function updateFilterGroup(index: number, group: FilterGroup) {
    if (index >= 0 && index < filterGroups.value.length) {
      filterGroups.value[index] = group
      nestedFilterNodes.value = null
      sortFilterDirty.value = true
    }
  }
  function removeFilterGroup(index: number) {
    filterGroups.value.splice(index, 1)
    nestedFilterNodes.value = null
    sortFilterDirty.value = true
  }

  // --- Record CRUD ---

  function rejectRowEdit(): false {
    error.value = fallback('grid.errorEditRowBlocked')
    return false
  }

  function rejectRowDelete(): false {
    error.value = fallback('grid.errorDeleteRowBlocked')
    return false
  }

  function resolveRowActions(recordId?: string | null): MetaRowActions | null {
    if (recordId && rowActionOverrides.value[recordId]) {
      return rowActionOverrides.value[recordId]
    }
    return rowActions.value
  }

  async function createRecord(data?: Record<string, unknown>) {
    error.value = null
    const context = resolveCreateRecordContext({
      sheetId: opts.sheetId.value,
      viewId: opts.viewId.value,
    })
    if (!context.sheetId && !context.viewId) {
      error.value = fallback('grid.errorContextRequired')
      return
    }
    if (!opts.sheetId.value && context.sheetId) opts.sheetId.value = context.sheetId
    if (!opts.viewId.value && context.viewId) opts.viewId.value = context.viewId
    try {
      await client.createRecord({
        sheetId: context.sheetId,
        viewId: context.viewId,
        data,
      })
      await loadViewData(page.value.offset)
    } catch (e: any) {
      error.value = e.message ?? fallback('grid.errorCreateRecord')
    }
  }

  // Duplicate / clone a record (design 2026-06-16). The server owns the value-copy + field-mask (a field is
  // copied iff the actor can read AND write it) — there is intentionally NO front-end permission mirror.
  // Returns the NEW record id on success (so the caller can open/select the clone), or null on failure with
  // `error` set; mirrors the create/delete catch shape.
  async function duplicateRecord(recordId: string): Promise<string | null> {
    error.value = null
    const context = resolveCreateRecordContext({
      sheetId: opts.sheetId.value,
      viewId: opts.viewId.value,
    })
    try {
      const { record } = await client.duplicateRecord(recordId, {
        sheetId: context.sheetId,
        viewId: context.viewId,
      })
      await loadViewData(page.value.offset)
      return record?.id ?? null
    } catch (e: any) {
      error.value = e.message ?? fallback('grid.errorDuplicateRecord')
      return null
    }
  }

  async function deleteRecord(recordId: string): Promise<boolean> {
    error.value = null
    if (resolveRowActions(recordId)?.canDelete === false) return rejectRowDelete()
    try {
      const row = rows.value.find((r) => r.id === recordId)
      await client.deleteRecord(recordId, row?.version)
      await loadViewData(page.value.offset)
      return true
    } catch (e: any) {
      error.value = e.message ?? fallback('grid.errorDeleteRecord')
      return false
    }
  }

  async function reloadCurrentPage() {
    await loadViewData(page.value.offset)
  }

  async function patchCell(
    recordId: string,
    fieldId: string,
    value: unknown,
    version: number,
    options?: {
      previousLinkSummaries?: LinkedRecordSummary[]
      nextLinkSummaries?: LinkedRecordSummary[]
    },
  ) {
    error.value = null
    conflict.value = null
    if (resolveRowActions(recordId)?.canEdit === false) return rejectRowEdit()
    const row = rows.value.find((r) => r.id === recordId)
    const oldValue = row?.data[fieldId]
    const oldLinkSummaries = options?.previousLinkSummaries ?? linkSummaries.value[recordId]?.[fieldId]
    let nextLinkSummaries: LinkedRecordSummary[] | undefined

    // Optimistic update
    if (row) row.data[fieldId] = value
    if (Array.isArray(value) && fields.value.find((field) => field.id === fieldId)?.type === 'link') {
      nextLinkSummaries = options?.nextLinkSummaries ?? oldLinkSummaries?.filter((item) => value.map(String).includes(item.id))
      setLinkSummaries(recordId, fieldId, nextLinkSummaries)
    }

    try {
      const result = await client.patchRecords({
        sheetId: opts.sheetId.value || undefined,
        viewId: opts.viewId.value || undefined,
        changes: [{ recordId, fieldId, value, expectedVersion: version }],
      })
      applyPatchResult(result)
      // Push to undo history
      editHistory.value = editHistory.value.slice(0, historyIndex.value + 1)
      editHistory.value.push({ recordId, fieldId, oldValue, newValue: value, version, oldLinkSummaries, newLinkSummaries: nextLinkSummaries })
      historyIndex.value = editHistory.value.length - 1
    } catch (e: any) {
      // Revert optimistic update
      if (row) row.data[fieldId] = oldValue
      setLinkSummaries(recordId, fieldId, oldLinkSummaries)
      if (e?.code === 'VERSION_CONFLICT') {
        conflict.value = {
          recordId,
          fieldId,
          attemptedValue: value,
          message: e.message ?? fallback('grid.errorCellUpdatedElsewhere'),
          serverVersion: typeof e.serverVersion === 'number' ? e.serverVersion : undefined,
          previousLinkSummaries: oldLinkSummaries,
          nextLinkSummaries,
        }
      }
      error.value = e.message ?? fallback('grid.errorPatchCell')
    }
  }

  // --- Undo / Redo ---

  async function undo() {
    if (!canUndo.value) return
    const edit = editHistory.value[historyIndex.value]
    if (resolveRowActions(edit.recordId)?.canEdit === false) return void rejectRowEdit()
    historyIndex.value--
    const row = rows.value.find((r) => r.id === edit.recordId)
    if (row) row.data[edit.fieldId] = edit.oldValue
    setLinkSummaries(edit.recordId, edit.fieldId, edit.oldLinkSummaries)
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
    const nextHistoryIndex = historyIndex.value + 1
    const edit = editHistory.value[nextHistoryIndex]
    if (resolveRowActions(edit.recordId)?.canEdit === false) return void rejectRowEdit()
    historyIndex.value = nextHistoryIndex
    const row = rows.value.find((r) => r.id === edit.recordId)
    if (row) row.data[edit.fieldId] = edit.newValue
    setLinkSummaries(edit.recordId, edit.fieldId, edit.newLinkSummaries)
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

  async function bulkPatch(args: {
    fieldId: string
    value: unknown
    recordIds: string[]
  }): Promise<{ updated: string[]; failed: Array<{ recordId: string; reason: string }> }> {
    const changes = args.recordIds
      .map((recordId) => {
        const row = rows.value.find((r) => r.id === recordId)
        if (!row) return null
        return {
          recordId,
          fieldId: args.fieldId,
          value: args.value,
          expectedVersion: row.version,
        }
      })
      .filter((change): change is { recordId: string; fieldId: string; value: unknown; expectedVersion: number } => change !== null)

    if (changes.length === 0) return { updated: [], failed: [] }

    const result = await client.patchRecords({
      sheetId: opts.sheetId.value || undefined,
      viewId: opts.viewId.value || undefined,
      partialSuccess: true,
      changes,
    })
    applyPatchResult(result)
    const updated = (result.updated ?? []).map((u) => u.recordId)
    const failed = (result.failed ?? []).map((failure) => ({
      recordId: failure.recordId,
      reason: failure.message || failure.code || fallback('grid.errorPatchFailed'),
    }))
    return { updated, failed }
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
    if (result.linkSummaries) {
      for (const [recordId, fieldMap] of Object.entries(result.linkSummaries)) {
        for (const [fieldId, summaries] of Object.entries(fieldMap)) {
          setLinkSummaries(recordId, fieldId, summaries)
        }
      }
    }
    if (result.attachmentSummaries) {
      for (const [recordId, fieldMap] of Object.entries(result.attachmentSummaries)) {
        for (const [fieldId, summaries] of Object.entries(fieldMap)) {
          setAttachmentSummaries(recordId, fieldId, summaries)
        }
      }
    }
  }

  function clearEditHistory() {
    editHistory.value = []
    historyIndex.value = -1
  }

  function dismissConflict() {
    conflict.value = null
  }

  async function retryConflict(): Promise<boolean> {
    const pending = conflict.value
    if (!pending) return false

    let row = rows.value.find((record) => record.id === pending.recordId)
    const needsReload = !row || (typeof pending.serverVersion === 'number' && row.version !== pending.serverVersion)
    if (needsReload) {
      await reloadCurrentPage()
      row = rows.value.find((record) => record.id === pending.recordId)
    }
    if (!row) {
      error.value = fallback('grid.errorRecordVersionUnavailable')
      return false
    }

    const pendingConflict = pending
    conflict.value = null
    await patchCell(row.id, pending.fieldId, pending.attemptedValue, row.version, {
      previousLinkSummaries: pendingConflict.previousLinkSummaries,
      nextLinkSummaries: pendingConflict.nextLinkSummaries,
    })
    return !conflict.value && !error.value
  }

  function setLinkSummaries(recordId: string, fieldId: string, summaries?: LinkedRecordSummary[]) {
    const currentRecordMap = linkSummaries.value[recordId] ?? {}
    const nextRecordMap = { ...currentRecordMap }
    if (summaries && summaries.length > 0) nextRecordMap[fieldId] = summaries
    else delete nextRecordMap[fieldId]

    if (Object.keys(nextRecordMap).length === 0) {
      const next = { ...linkSummaries.value }
      delete next[recordId]
      linkSummaries.value = next
      return
    }

    linkSummaries.value = {
      ...linkSummaries.value,
      [recordId]: nextRecordMap,
    }
  }

  function setAttachmentSummaries(recordId: string, fieldId: string, summaries?: MetaAttachment[]) {
    const currentRecordMap = attachmentSummaries.value[recordId] ?? {}
    const nextRecordMap = { ...currentRecordMap }
    if (summaries && summaries.length > 0) nextRecordMap[fieldId] = summaries
    else delete nextRecordMap[fieldId]

    if (Object.keys(nextRecordMap).length === 0) {
      const next = { ...attachmentSummaries.value }
      delete next[recordId]
      attachmentSummaries.value = next
      return
    }

    attachmentSummaries.value = {
      ...attachmentSummaries.value,
      [recordId]: nextRecordMap,
    }
  }

  function replaceRecordLinkSummaries(recordId: string, summaries?: Record<string, LinkedRecordSummary[]>) {
    const normalized = summaries && Object.keys(summaries).length > 0 ? summaries : null
    if (!normalized) {
      const next = { ...linkSummaries.value }
      delete next[recordId]
      linkSummaries.value = next
      return
    }
    linkSummaries.value = {
      ...linkSummaries.value,
      [recordId]: normalized,
    }
  }

  function replaceRecordPersonSummaries(recordId: string, summaries?: Record<string, PersonSummary[]>) {
    const normalized = summaries && Object.keys(summaries).length > 0 ? summaries : null
    if (!normalized) {
      const next = { ...personSummaries.value }
      delete next[recordId]
      personSummaries.value = next
      return
    }
    personSummaries.value = {
      ...personSummaries.value,
      [recordId]: normalized,
    }
  }

  function replaceRecordAttachmentSummaries(recordId: string, summaries?: Record<string, MetaAttachment[]>) {
    const normalized = summaries && Object.keys(summaries).length > 0 ? summaries : null
    if (!normalized) {
      const next = { ...attachmentSummaries.value }
      delete next[recordId]
      attachmentSummaries.value = next
      return
    }
    attachmentSummaries.value = {
      ...attachmentSummaries.value,
      [recordId]: normalized,
    }
  }

  function mergeRemoteRecord(record: MetaRecord, options?: RemoteRecordMergeOptions): boolean {
    const index = rows.value.findIndex((row) => row.id === record.id)
    if (index < 0) return false
    const nextRows = [...rows.value]
    nextRows[index] = {
      ...nextRows[index],
      version: record.version,
      data: { ...record.data },
    }
    rows.value = nextRows
    replaceRecordLinkSummaries(record.id, options?.linkSummaries)
    replaceRecordPersonSummaries(record.id, options?.personSummaries)
    replaceRecordAttachmentSummaries(record.id, options?.attachmentSummaries)
    return true
  }

  function applyRemoteRecordPatch(recordId: string, options: RemoteRecordPatchOptions): boolean {
    const index = rows.value.findIndex((row) => row.id === recordId)
    if (index < 0) return false
    const nextRows = [...rows.value]
    const current = nextRows[index]
    nextRows[index] = {
      ...current,
      version: typeof options.version === 'number' ? options.version : current.version,
      data: {
        ...current.data,
        ...options.patch,
      },
    }
    rows.value = nextRows
    return true
  }

  function removeRemoteRecord(recordId: string): boolean {
    const nextRows = rows.value.filter((row) => row.id !== recordId)
    if (nextRows.length === rows.value.length) return false
    rows.value = nextRows

    const nextLinkSummaries = { ...linkSummaries.value }
    delete nextLinkSummaries[recordId]
    linkSummaries.value = nextLinkSummaries

    const nextAttachmentSummaries = { ...attachmentSummaries.value }
    delete nextAttachmentSummaries[recordId]
    attachmentSummaries.value = nextAttachmentSummaries

    const nextTotal = Math.max(0, Number(page.value.total ?? nextRows.length) - 1)
    page.value = {
      ...page.value,
      total: nextTotal,
      hasMore: page.value.offset + nextRows.length < nextTotal,
    }
    return true
  }

  // --- Watch sheet/view changes ---

  watch(
    [opts.sheetId, opts.viewId],
    () => {
      sortFilterDirty.value = false
      clearEditHistory()
      dismissConflict()
      if (opts.sheetId.value) loadViewData(0)
    },
    { immediate: true },
  )

  return {
    // State
    fields, rows, linkSummaries, personSummaries, attachmentSummaries, fieldPermissions, viewPermission, capabilityOrigin, rowActions, rowActionOverrides, loading, error, conflict, page, hiddenFieldIds, visibleFields, readOnlyFieldIds,
    // A1 infinite-scroll accumulation state
    loadingMore, accumulationCapped,
    sortRules, filterRules, filterConjunction, nestedFilterNodes, filterGroups, sortFilterDirty,
    groupFieldId, groupFieldIds, groupField, groupFields,
    editHistory, historyIndex, canUndo, canRedo,
    searchQuery,
    // Computed
    currentPage, totalPages, canLoadMore,
    // Methods
    loadViewData, loadMore, syncFromView, reloadCurrentPage, goToPage,
    toggleFieldVisibility,
    addSortRule, removeSortRule,
    addFilterRule, updateFilterRule, removeFilterRule, clearFilters,
    addFilterGroup, updateFilterGroup, removeFilterGroup,
    applySortFilter,
    createRecord, duplicateRecord, deleteRecord, patchCell, bulkPatch,
    // A3: exposed as the single echo-application seam for the AI shortcut
    // run adapter (useAiShortcut synthesizes a PatchResult and feeds it here).
    applyPatchResult,
    mergeRemoteRecord, applyRemoteRecordPatch, removeRemoteRecord,
    undo, redo, clearEditHistory, dismissConflict, retryConflict,
    setGroupField, setGroupFields,
    setSearchQuery, resolveRowActions,
  }
}
