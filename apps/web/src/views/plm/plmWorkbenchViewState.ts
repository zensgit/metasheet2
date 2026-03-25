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

const PLM_WORKBENCH_QUERY_KEY_SET = new Set<string>(PLM_WORKBENCH_QUERY_KEYS)

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

export function matchPlmWorkbenchQuerySnapshot(left: unknown, right: unknown): boolean {
  const normalizedLeft = stripPlmWorkbenchTeamViewIdentity(normalizePlmWorkbenchQuerySnapshot(left))
  const normalizedRight = stripPlmWorkbenchTeamViewIdentity(normalizePlmWorkbenchQuerySnapshot(right))

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

  for (const [key, value] of Object.entries(normalizePlmWorkbenchQuerySnapshot(snapshot))) {
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
    const query = normalizePlmWorkbenchQuerySnapshot(workbenchView.state.query)
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
  appendIfPresent(params, 'approvalComment', approvalsView.state.comment)
  appendIfPresent(params, 'approvalSort', approvalsView.state.sortKey !== 'created' ? approvalsView.state.sortKey : '')
  appendIfPresent(params, 'approvalSortDir', approvalsView.state.sortDir !== 'desc' ? approvalsView.state.sortDir : '')
  appendIfPresent(params, 'approvalColumns', serializeEnabledColumns(approvalsView.state.columns))
  return `${origin}${basePath}?${params.toString()}`
}
