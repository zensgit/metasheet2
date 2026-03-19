import type { LocationQuery, LocationQueryRaw } from 'vue-router'

type WorkflowHubWorkflowStatus = '' | 'draft' | 'published' | 'archived'
type WorkflowHubWorkflowSort = 'updated_at' | 'created_at' | 'name'
type WorkflowHubTemplateSource = 'all' | 'builtin' | 'database'
type WorkflowHubTemplateSort = 'usage_count' | 'name' | 'updated_at'

export interface WorkflowHubRouteState {
  workflowSearch: string
  workflowStatus: WorkflowHubWorkflowStatus
  workflowSortBy: WorkflowHubWorkflowSort
  workflowOffset: number
  templateSearch: string
  templateSource: WorkflowHubTemplateSource
  templateSortBy: WorkflowHubTemplateSort
  templateOffset: number
}

export const DEFAULT_WORKFLOW_HUB_ROUTE_STATE: WorkflowHubRouteState = {
  workflowSearch: '',
  workflowStatus: '',
  workflowSortBy: 'updated_at',
  workflowOffset: 0,
  templateSearch: '',
  templateSource: 'all',
  templateSortBy: 'usage_count',
  templateOffset: 0,
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : Array.isArray(value) ? String(value[0] ?? '') : ''
}

function normalizeOffset(value: unknown) {
  const numeric = Number.parseInt(readString(value), 10)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0
}

export function parseWorkflowHubRouteState(query: LocationQuery): WorkflowHubRouteState {
  const workflowStatus = readString(query.wfStatus)
  const workflowSortBy = readString(query.wfSort)
  const templateSource = readString(query.tplSource)
  const templateSortBy = readString(query.tplSort)

  return {
    workflowSearch: readString(query.wfSearch),
    workflowStatus:
      workflowStatus === 'draft' || workflowStatus === 'published' || workflowStatus === 'archived'
        ? workflowStatus
        : '',
    workflowSortBy:
      workflowSortBy === 'created_at' || workflowSortBy === 'name'
        ? workflowSortBy
        : 'updated_at',
    workflowOffset: normalizeOffset(query.wfOffset),
    templateSearch: readString(query.tplSearch),
    templateSource:
      templateSource === 'builtin' || templateSource === 'database'
        ? templateSource
        : 'all',
    templateSortBy:
      templateSortBy === 'name' || templateSortBy === 'updated_at'
        ? templateSortBy
        : 'usage_count',
    templateOffset: normalizeOffset(query.tplOffset),
  }
}

export function buildWorkflowHubRouteQuery(state: WorkflowHubRouteState): LocationQueryRaw {
  const query: LocationQueryRaw = {}

  if (state.workflowSearch) query.wfSearch = state.workflowSearch
  if (state.workflowStatus) query.wfStatus = state.workflowStatus
  if (state.workflowSortBy !== DEFAULT_WORKFLOW_HUB_ROUTE_STATE.workflowSortBy) query.wfSort = state.workflowSortBy
  if (state.workflowOffset > 0) query.wfOffset = String(state.workflowOffset)

  if (state.templateSearch) query.tplSearch = state.templateSearch
  if (state.templateSource !== DEFAULT_WORKFLOW_HUB_ROUTE_STATE.templateSource) query.tplSource = state.templateSource
  if (state.templateSortBy !== DEFAULT_WORKFLOW_HUB_ROUTE_STATE.templateSortBy) query.tplSort = state.templateSortBy
  if (state.templateOffset > 0) query.tplOffset = String(state.templateOffset)

  return query
}

export function isWorkflowHubRouteStateEqual(left: WorkflowHubRouteState, right: WorkflowHubRouteState) {
  return left.workflowSearch === right.workflowSearch
    && left.workflowStatus === right.workflowStatus
    && left.workflowSortBy === right.workflowSortBy
    && left.workflowOffset === right.workflowOffset
    && left.templateSearch === right.templateSearch
    && left.templateSource === right.templateSource
    && left.templateSortBy === right.templateSortBy
    && left.templateOffset === right.templateOffset
}

export function getNextWorkflowHubOffset(total: number, returned: number, currentOffset: number, limit: number) {
  if (!total || returned <= 0) return null
  const nextOffset = currentOffset + limit
  return nextOffset < total ? nextOffset : null
}
