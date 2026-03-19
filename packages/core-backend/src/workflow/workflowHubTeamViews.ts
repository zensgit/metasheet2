export interface WorkflowHubTeamViewState {
  workflowSearch: string
  workflowStatus: '' | 'draft' | 'published' | 'archived'
  workflowSortBy: 'updated_at' | 'created_at' | 'name'
  workflowOffset: number
  templateSearch: string
  templateSource: 'all' | 'builtin' | 'database'
  templateSortBy: 'usage_count' | 'name' | 'updated_at'
  templateOffset: number
}

export interface WorkflowHubTeamViewRowLike {
  id: string
  tenant_id: string
  owner_user_id: string
  scope: string
  name: string
  name_key: string
  state: unknown
  created_at: Date | string
  updated_at: Date | string
}

export const DEFAULT_WORKFLOW_HUB_TEAM_VIEW_STATE: WorkflowHubTeamViewState = {
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
  return typeof value === 'string' ? value : ''
}

function normalizeOffset(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

export function normalizeWorkflowHubTeamViewName(value: string) {
  return value.trim()
}

export function normalizeWorkflowHubTeamViewNameKey(value: string) {
  return normalizeWorkflowHubTeamViewName(value).toLocaleLowerCase()
}

export function normalizeWorkflowHubTeamViewState(value: unknown): WorkflowHubTeamViewState {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const workflowStatus = readString(record.workflowStatus)
  const workflowSortBy = readString(record.workflowSortBy)
  const templateSource = readString(record.templateSource)
  const templateSortBy = readString(record.templateSortBy)

  return {
    workflowSearch: readString(record.workflowSearch),
    workflowStatus:
      workflowStatus === 'draft' || workflowStatus === 'published' || workflowStatus === 'archived'
        ? workflowStatus
        : '',
    workflowSortBy:
      workflowSortBy === 'created_at' || workflowSortBy === 'name'
        ? workflowSortBy
        : 'updated_at',
    workflowOffset: normalizeOffset(record.workflowOffset),
    templateSearch: readString(record.templateSearch),
    templateSource:
      templateSource === 'builtin' || templateSource === 'database'
        ? templateSource
        : 'all',
    templateSortBy:
      templateSortBy === 'name' || templateSortBy === 'updated_at'
        ? templateSortBy
        : 'usage_count',
    templateOffset: normalizeOffset(record.templateOffset),
  }
}

function parseStoredState(value: unknown) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return {}
    }
  }
  return value
}

export function buildWorkflowHubTeamViewValues(input: {
  tenantId: string
  ownerUserId: string
  name: string
  state: unknown
}) {
  const normalizedName = normalizeWorkflowHubTeamViewName(input.name)
  const normalizedState = normalizeWorkflowHubTeamViewState(input.state)

  return {
    tenant_id: input.tenantId,
    owner_user_id: input.ownerUserId,
    scope: 'team',
    name: normalizedName,
    name_key: normalizeWorkflowHubTeamViewNameKey(normalizedName),
    state: JSON.stringify(normalizedState),
  }
}

export function mapWorkflowHubTeamViewRow(row: WorkflowHubTeamViewRowLike, currentUserId?: string | null) {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope === 'team' ? 'team' : 'team',
    ownerUserId: row.owner_user_id,
    canManage: Boolean(currentUserId) && row.owner_user_id === currentUserId,
    state: normalizeWorkflowHubTeamViewState(parseStoredState(row.state)),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }
}
