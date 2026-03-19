import {
  DEFAULT_WORKFLOW_HUB_ROUTE_STATE,
  isWorkflowHubRouteStateEqual,
  type WorkflowHubRouteState,
} from './workflowHubQueryState'

const WORKFLOW_HUB_SESSION_STATE_KEY = 'metasheet_workflow_hub_session_state'

export interface WorkflowHubSessionState {
  state: WorkflowHubRouteState
  updatedAt: string
}

function getStorage(storage?: Storage | null) {
  if (storage !== undefined) return storage
  return typeof localStorage !== 'undefined' ? localStorage : null
}

function isWorkflowHubRouteState(value: unknown): value is WorkflowHubRouteState {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.workflowSearch === 'string'
    && (record.workflowStatus === '' || record.workflowStatus === 'draft' || record.workflowStatus === 'published' || record.workflowStatus === 'archived')
    && (record.workflowSortBy === 'updated_at' || record.workflowSortBy === 'created_at' || record.workflowSortBy === 'name')
    && typeof record.workflowOffset === 'number'
    && typeof record.templateSearch === 'string'
    && (record.templateSource === 'all' || record.templateSource === 'builtin' || record.templateSource === 'database')
    && (record.templateSortBy === 'usage_count' || record.templateSortBy === 'name' || record.templateSortBy === 'updated_at')
    && typeof record.templateOffset === 'number'
}

function isWorkflowHubSessionState(value: unknown): value is WorkflowHubSessionState {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.updatedAt === 'string' && isWorkflowHubRouteState(record.state)
}

export function readWorkflowHubSessionState(storage?: Storage | null): WorkflowHubSessionState | null {
  const target = getStorage(storage)
  if (!target) return null

  try {
    const raw = target.getItem(WORKFLOW_HUB_SESSION_STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    return isWorkflowHubSessionState(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function writeWorkflowHubSessionState(
  state: WorkflowHubRouteState,
  storage?: Storage | null,
): WorkflowHubSessionState | null {
  const target = getStorage(storage)
  if (!target) return null

  const next: WorkflowHubSessionState = {
    state,
    updatedAt: new Date().toISOString(),
  }
  target.setItem(WORKFLOW_HUB_SESSION_STATE_KEY, JSON.stringify(next))
  return next
}

export function clearWorkflowHubSessionState(storage?: Storage | null) {
  const target = getStorage(storage)
  if (!target) return
  target.removeItem(WORKFLOW_HUB_SESSION_STATE_KEY)
}

export function shouldRestoreWorkflowHubSessionState(
  currentRouteState: WorkflowHubRouteState,
  storedSession: WorkflowHubSessionState | null,
) {
  if (!storedSession) return false
  if (!isWorkflowHubRouteStateEqual(currentRouteState, DEFAULT_WORKFLOW_HUB_ROUTE_STATE)) {
    return false
  }

  return !isWorkflowHubRouteStateEqual(storedSession.state, DEFAULT_WORKFLOW_HUB_ROUTE_STATE)
}
