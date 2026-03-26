import type { LocationQuery, LocationQueryValue } from 'vue-router'
import type {
  PlmWorkbenchTeamView,
  PlmWorkbenchTeamViewKind,
} from './plmPanelModels'
import {
  buildPlmAuditRouteQuery,
  buildPlmAuditRouteStateFromTeamView,
} from '../plmAuditQueryState'

export const PLM_WORKBENCH_QUERY_KEYS = [
  'workbenchTeamView',
  'searchQuery',
  'searchItemType',
  'searchLimit',
  'productId',
  'itemNumber',
  'itemType',
  'documentTeamView',
  'cadTeamView',
  'approvalsTeamView',
  'auditTeamView',
  'auditPage',
  'auditQ',
  'auditActor',
  'auditKind',
  'auditAction',
  'auditType',
  'auditFrom',
  'auditTo',
  'auditWindow',
  'cadFileId',
  'cadOtherFileId',
  'cadReviewState',
  'cadReviewNote',
  'documentRole',
  'documentFilter',
  'documentSort',
  'documentSortDir',
  'documentColumns',
  'approvalsStatus',
  'approvalsFilter',
  'approvalComment',
  'approvalSort',
  'approvalSortDir',
  'approvalColumns',
  'whereUsedItemId',
  'whereUsedRecursive',
  'whereUsedMaxLevels',
  'whereUsedFilterPreset',
  'whereUsedTeamPreset',
  'whereUsedFilter',
  'whereUsedFilterField',
  'bomDepth',
  'bomEffectiveAt',
  'bomFilterPreset',
  'bomTeamPreset',
  'bomFilter',
  'bomFilterField',
  'bomView',
  'bomCollapsed',
  'compareLeftId',
  'compareRightId',
  'compareMode',
  'compareLineKey',
  'compareMaxLevels',
  'compareIncludeChildFields',
  'compareIncludeSubstitutes',
  'compareIncludeEffectivity',
  'compareSync',
  'compareEffectiveAt',
  'compareRelationshipProps',
  'compareFilter',
  'bomLineId',
  'substitutesFilter',
  'panel',
  'autoload',
] as const

export const PLM_WORKBENCH_TEAM_VIEW_OWNER_QUERY_KEYS = [
  'workbenchTeamView',
  'documentTeamView',
  'cadTeamView',
  'approvalsTeamView',
] as const

const PLM_WORKBENCH_QUERY_KEY_SET = new Set<string>(PLM_WORKBENCH_QUERY_KEYS)
const PLM_WORKBENCH_PANEL_SCOPE_KEYS = [
  'search',
  'product',
  'documents',
  'approvals',
  'cad',
  'where-used',
  'compare',
  'substitutes',
] as const
const PLM_WORKBENCH_PANEL_SCOPE_KEY_SET = new Set<string>(PLM_WORKBENCH_PANEL_SCOPE_KEYS)

function normalizeQueryValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const first = value[0]
    return typeof first === 'string' ? first.trim() : ''
  }
  return ''
}

export function normalizePlmWorkbenchQuerySnapshot(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, entry]) => {
    if (!PLM_WORKBENCH_QUERY_KEY_SET.has(key)) return acc
    const normalized = normalizeQueryValue(entry)
    if (!normalized) return acc
    acc[key] = normalized
    return acc
  }, {})
}

function stripPlmWorkbenchTeamViewIdentity(snapshot: Record<string, string>): Record<string, string> {
  const next = { ...snapshot }
  delete next.workbenchTeamView
  return next
}

export function normalizePlmWorkbenchPanelScope(value: unknown): string | undefined {
  const normalized = normalizeQueryValue(value)
  if (!normalized) return undefined

  const selected = new Set(
    normalized
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry && entry !== 'all' && PLM_WORKBENCH_PANEL_SCOPE_KEY_SET.has(entry)),
  )
  if (!selected.size) return undefined

  return PLM_WORKBENCH_PANEL_SCOPE_KEYS
    .filter((entry) => selected.has(entry))
    .join(',')
}

export function normalizePlmWorkbenchCollaborativeQuerySnapshot(value: unknown): Record<string, string> {
  const next = stripPlmWorkbenchTeamViewIdentity(normalizePlmWorkbenchQuerySnapshot(value))
  delete next.bomFilterPreset
  delete next.whereUsedFilterPreset
  delete next.approvalComment
  const normalizedPanel = normalizePlmWorkbenchPanelScope(next.panel)
  if (normalizedPanel) {
    next.panel = normalizedPanel
  } else {
    delete next.panel
  }
  return next
}

export function hasExplicitPlmWorkbenchAutoApplyQueryState(value: unknown): boolean {
  const next = normalizePlmWorkbenchQuerySnapshot(value)
  delete next.approvalComment
  const normalizedPanel = normalizePlmWorkbenchPanelScope(next.panel)
  if (normalizedPanel) {
    next.panel = normalizedPanel
  } else {
    delete next.panel
  }
  return Object.keys(next).length > 0
}

export function hasExplicitPlmApprovalsAutoApplyQueryState(
  value: unknown,
  defaults?: Record<string, boolean>,
): boolean {
  const next = normalizePlmWorkbenchQuerySnapshot(value)
  delete next.approvalComment
  return Boolean(
    next.approvalsTeamView
    || (next.approvalsStatus && next.approvalsStatus !== 'pending')
    || next.approvalsFilter
    || (next.approvalSort && next.approvalSort !== 'created')
    || (next.approvalSortDir && next.approvalSortDir !== 'desc')
    || hasExplicitPlmColumnQueryState(next.approvalColumns, defaults)
  )
}

function hasExplicitPlmColumnQueryState(
  value: string | undefined,
  defaults: Record<string, boolean> | undefined,
): boolean {
  if (!value) return false
  const tokens = Array.from(new Set(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  ))
  if (!tokens.length) return false
  if (!defaults) return true

  const knownTokens = tokens.filter((token) => Object.prototype.hasOwnProperty.call(defaults, token))
  if (!knownTokens.length) return false

  const defaultEnabled = Object.keys(defaults).filter((key) => Boolean(defaults[key]))
  if (knownTokens.length !== defaultEnabled.length) return true
  const enabledTokenSet = new Set(knownTokens)
  return defaultEnabled.some((key) => !enabledTokenSet.has(key))
}

export function hasExplicitPlmDocumentAutoApplyQueryState(
  value: unknown,
  defaults?: Record<string, boolean>,
): boolean {
  const next = normalizePlmWorkbenchQuerySnapshot(value)
  return Boolean(
    next.documentTeamView
    || next.documentRole
    || next.documentFilter
    || (next.documentSort && next.documentSort !== 'updated')
    || (next.documentSortDir && next.documentSortDir !== 'desc')
    || hasExplicitPlmColumnQueryState(next.documentColumns, defaults),
  )
}

function hasExplicitPlmFilterPresetAutoApplyQueryState(
  value: unknown,
  options: {
    teamPresetKey: string
    filterPresetKey: string
    filterKey: string
    filterFieldKey: string
  },
): boolean {
  const next = normalizePlmWorkbenchQuerySnapshot(value)
  return Boolean(
    next[options.teamPresetKey]
    || next[options.filterPresetKey]
    || next[options.filterKey]
    || (next[options.filterFieldKey] && next[options.filterFieldKey] !== 'all')
  )
}

export function hasExplicitPlmBomTeamPresetAutoApplyQueryState(value: unknown): boolean {
  return hasExplicitPlmFilterPresetAutoApplyQueryState(value, {
    teamPresetKey: 'bomTeamPreset',
    filterPresetKey: 'bomFilterPreset',
    filterKey: 'bomFilter',
    filterFieldKey: 'bomFilterField',
  })
}

export function hasExplicitPlmWhereUsedTeamPresetAutoApplyQueryState(value: unknown): boolean {
  return hasExplicitPlmFilterPresetAutoApplyQueryState(value, {
    teamPresetKey: 'whereUsedTeamPreset',
    filterPresetKey: 'whereUsedFilterPreset',
    filterKey: 'whereUsedFilter',
    filterFieldKey: 'whereUsedFilterField',
  })
}

export function buildPlmWorkbenchResetOwnerQueryPatch() {
  return Object.fromEntries(
    PLM_WORKBENCH_TEAM_VIEW_OWNER_QUERY_KEYS.map((key) => [key, '']),
  ) as Record<(typeof PLM_WORKBENCH_TEAM_VIEW_OWNER_QUERY_KEYS)[number], ''>
}

export function buildPlmWorkbenchResetHydratedPanelQueryPatch() {
  return {
    ...buildPlmWorkbenchResetOwnerQueryPatch(),
    documentSort: '',
    documentSortDir: '',
    documentColumns: '',
    cadReviewState: '',
    cadReviewNote: '',
    approvalComment: '',
    approvalSort: '',
    approvalSortDir: '',
    approvalColumns: '',
  }
}

export function matchPlmWorkbenchQuerySnapshot(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizePlmWorkbenchCollaborativeQuerySnapshot(left)
  const normalizedRight = normalizePlmWorkbenchCollaborativeQuerySnapshot(right)

  const leftKeys = Object.keys(normalizedLeft)
  const rightKeys = Object.keys(normalizedRight)
  if (leftKeys.length !== rightKeys.length) return false

  return leftKeys.every((key) => normalizedLeft[key] === normalizedRight[key])
}

export function mergePlmWorkbenchRouteQuery(
  currentQuery: LocationQuery,
  snapshot: Record<string, string>,
): Record<string, LocationQueryValue | LocationQueryValue[] | undefined> {
  const nextQuery: Record<string, LocationQueryValue | LocationQueryValue[] | undefined> = {}

  for (const [key, value] of Object.entries(currentQuery)) {
    if (PLM_WORKBENCH_QUERY_KEY_SET.has(key)) continue
    nextQuery[key] = value
  }

  for (const [key, value] of Object.entries(snapshot)) {
    nextQuery[key] = value
  }

  return nextQuery
}

export function buildPlmWorkbenchRoutePath(
  basePath: string,
  snapshot: Record<string, unknown>,
  options?: {
    hash?: string
    extraQuery?: Record<string, unknown>
  },
) {
  const params = new URLSearchParams()
  const explicitWorkbenchTeamView = normalizeQueryValue(snapshot.workbenchTeamView)

  if (explicitWorkbenchTeamView) {
    params.set('workbenchTeamView', explicitWorkbenchTeamView)
  }

  for (const [key, value] of Object.entries(normalizePlmWorkbenchCollaborativeQuerySnapshot(snapshot))) {
    params.set(key, value)
  }

  for (const [key, value] of Object.entries(options?.extraQuery || {})) {
    const normalized = normalizeQueryValue(value)
    if (!normalized) continue
    params.set(key, normalized)
  }

  const query = params.toString()
  const hash = options?.hash
    ? options.hash.startsWith('#') ? options.hash : `#${options.hash}`
    : ''

  if (!query) {
    return `${basePath}${hash}`
  }

  return `${basePath}?${query}${hash}`
}

function appendIfPresent(params: URLSearchParams, key: string, value: unknown) {
  const normalized = normalizeQueryValue(value)
  if (!normalized) return
  params.set(key, normalized)
}

function serializeEnabledColumns(columns: Record<string, boolean> | undefined) {
  if (!columns) return ''
  return Object.entries(columns)
    .filter(([, enabled]) => Boolean(enabled))
    .map(([key]) => key)
    .join(',')
}

export function buildPlmWorkbenchTeamViewShareUrl<Kind extends PlmWorkbenchTeamViewKind>(
  kind: Kind,
  view: PlmWorkbenchTeamView<Kind>,
  basePath: string,
  origin = 'http://127.0.0.1:8899',
) {
  const params = new URLSearchParams()

  if (kind === 'workbench') {
    const workbenchView = view as PlmWorkbenchTeamView<'workbench'>
    params.set('workbenchTeamView', view.id)
    const query = normalizePlmWorkbenchCollaborativeQuerySnapshot(workbenchView.state.query)
    for (const [key, value] of Object.entries(query)) {
      if (key === 'workbenchTeamView') continue
      appendIfPresent(params, key, value)
    }
    return `${origin}${basePath}?${params.toString()}`
  }

  if (kind === 'documents') {
    const documentView = view as PlmWorkbenchTeamView<'documents'>
    params.set('panel', 'documents')
    params.set('documentTeamView', view.id)
    appendIfPresent(params, 'documentRole', documentView.state.role)
    appendIfPresent(params, 'documentFilter', documentView.state.filter)
    appendIfPresent(params, 'documentSort', documentView.state.sortKey !== 'updated' ? documentView.state.sortKey : '')
    appendIfPresent(params, 'documentSortDir', documentView.state.sortDir !== 'desc' ? documentView.state.sortDir : '')
    appendIfPresent(params, 'documentColumns', serializeEnabledColumns(documentView.state.columns))
    return `${origin}${basePath}?${params.toString()}`
  }

  if (kind === 'cad') {
    const cadView = view as PlmWorkbenchTeamView<'cad'>
    params.set('panel', 'cad')
    params.set('cadTeamView', view.id)
    appendIfPresent(params, 'cadFileId', cadView.state.fileId)
    appendIfPresent(params, 'cadOtherFileId', cadView.state.otherFileId)
    appendIfPresent(params, 'cadReviewState', cadView.state.reviewState)
    appendIfPresent(params, 'cadReviewNote', cadView.state.reviewNote)
    return `${origin}${basePath}?${params.toString()}`
  }

  if (kind === 'audit') {
    const auditView = view as PlmWorkbenchTeamView<'audit'>
    const query = buildPlmAuditRouteQuery(
      buildPlmAuditRouteStateFromTeamView(view.id, auditView.state),
    )
    params.set('auditEntry', 'share')
    for (const [key, value] of Object.entries(query)) {
      appendIfPresent(params, key, value)
    }
    return `${origin}${basePath}?${params.toString()}`
  }

  const approvalsView = view as PlmWorkbenchTeamView<'approvals'>
  params.set('panel', 'approvals')
  params.set('approvalsTeamView', view.id)
  appendIfPresent(params, 'approvalsStatus', approvalsView.state.status !== 'pending' ? approvalsView.state.status : '')
  appendIfPresent(params, 'approvalsFilter', approvalsView.state.filter)
  appendIfPresent(params, 'approvalSort', approvalsView.state.sortKey !== 'created' ? approvalsView.state.sortKey : '')
  appendIfPresent(params, 'approvalSortDir', approvalsView.state.sortDir !== 'desc' ? approvalsView.state.sortDir : '')
  appendIfPresent(params, 'approvalColumns', serializeEnabledColumns(approvalsView.state.columns))
  return `${origin}${basePath}?${params.toString()}`
}
