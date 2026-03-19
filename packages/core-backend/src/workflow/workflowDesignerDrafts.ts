import type { WorkflowDefinition } from './WorkflowDesigner'

export interface StoredWorkflowDefinitionEnvelope {
  visual?: WorkflowDefinition | null
  bpmn?: string | null
  description?: string
  category?: string
  tags?: string[]
  shares?: WorkflowDraftShare[]
  executions?: WorkflowDraftExecution[]
  format?: 'visual+bpmn' | 'bpmn-only'
}

export interface WorkflowDraftShare {
  userId: string
  role: 'viewer' | 'editor'
  canEdit: boolean
  canDeploy: boolean
  canShare: boolean
  sharedBy?: string
  sharedAt?: string
}

export interface WorkflowDraftExecution {
  id: string
  executionType: string
  triggeredBy: string
  triggerContext: Record<string, unknown>
  status: string
  startTime: string
  endTime?: string | null
  resultData?: Record<string, unknown> | null
  errorData?: Record<string, unknown> | null
}

export interface WorkflowDefinitionRowLike {
  id: string
  name: string
  description: string | null
  version: number
  status: string
  created_by: string
  created_at: Date
  updated_at: Date
  definition: unknown
}

export interface WorkflowDraftRecord {
  id: string
  name: string
  description: string
  version: number
  status: string
  createdBy: string
  createdAt: Date
  updatedAt: Date
  category?: string
  tags: string[]
  bpmnXml?: string
  visual?: WorkflowDefinition | null
  shares: WorkflowDraftShare[]
  executions: WorkflowDraftExecution[]
}

function parseShares(value: unknown): WorkflowDraftShare[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    if (typeof record.userId !== 'string') return []
    return [{
      userId: record.userId,
      role: record.role === 'editor' ? 'editor' : 'viewer',
      canEdit: Boolean(record.canEdit),
      canDeploy: Boolean(record.canDeploy),
      canShare: Boolean(record.canShare),
      sharedBy: typeof record.sharedBy === 'string' ? record.sharedBy : undefined,
      sharedAt: typeof record.sharedAt === 'string' ? record.sharedAt : undefined,
    }]
  })
}

function parseExecutions(value: unknown): WorkflowDraftExecution[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.executionType !== 'string' || typeof record.triggeredBy !== 'string' || typeof record.status !== 'string' || typeof record.startTime !== 'string') {
      return []
    }
    return [{
      id: record.id,
      executionType: record.executionType,
      triggeredBy: record.triggeredBy,
      triggerContext: record.triggerContext && typeof record.triggerContext === 'object'
        ? record.triggerContext as Record<string, unknown>
        : {},
      status: record.status,
      startTime: record.startTime,
      endTime: typeof record.endTime === 'string' ? record.endTime : null,
      resultData: record.resultData && typeof record.resultData === 'object'
        ? record.resultData as Record<string, unknown>
        : null,
      errorData: record.errorData && typeof record.errorData === 'object'
        ? record.errorData as Record<string, unknown>
        : null,
    }]
  })
}

export function parseStoredWorkflowDefinition(definition: unknown): StoredWorkflowDefinitionEnvelope {
  if (!definition) return {}

  const parsed = typeof definition === 'string'
    ? JSON.parse(definition) as Record<string, unknown>
    : definition as Record<string, unknown>

  const visual = parsed.visual && typeof parsed.visual === 'object'
    ? parsed.visual as WorkflowDefinition
    : null

  return {
    visual,
    bpmn: typeof parsed.bpmn === 'string' ? parsed.bpmn : null,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    category: typeof parsed.category === 'string' ? parsed.category : undefined,
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    shares: parseShares(parsed.shares),
    executions: parseExecutions(parsed.executions),
    format: parsed.format === 'bpmn-only' ? 'bpmn-only' : 'visual+bpmn',
  }
}

export function buildStoredWorkflowDefinition(input: {
  visual?: WorkflowDefinition | null
  bpmnXml: string
  description?: string
  category?: string
  tags?: string[]
  shares?: WorkflowDraftShare[]
  executions?: WorkflowDraftExecution[]
}): StoredWorkflowDefinitionEnvelope {
  return {
    visual: input.visual ?? null,
    bpmn: input.bpmnXml,
    description: input.description,
    category: input.category,
    tags: input.tags ?? [],
    shares: input.shares ?? [],
    executions: input.executions ?? [],
    format: input.visual ? 'visual+bpmn' : 'bpmn-only',
  }
}

export function toWorkflowDraftRecord(row: WorkflowDefinitionRowLike): WorkflowDraftRecord {
  const stored = parseStoredWorkflowDefinition(row.definition)

  return {
    id: row.id,
    name: row.name,
    description: row.description ?? stored.description ?? '',
    version: row.version,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    category: stored.category,
    tags: stored.tags ?? [],
    bpmnXml: stored.bpmn ?? undefined,
    visual: stored.visual ?? null,
    shares: stored.shares ?? [],
    executions: stored.executions ?? [],
  }
}

export function getWorkflowDraftRole(workflow: WorkflowDraftRecord, userId?: string | null): 'owner' | 'editor' | 'viewer' | null {
  if (!userId) return null
  if (workflow.createdBy === userId) return 'owner'
  const share = workflow.shares.find((entry) => entry.userId === userId)
  if (!share) return null
  return share.role
}

export function hasWorkflowDraftAccess(workflow: WorkflowDraftRecord, userId?: string | null): boolean {
  return getWorkflowDraftRole(workflow, userId) !== null
}

export function canEditWorkflowDraft(workflow: WorkflowDraftRecord, userId?: string | null): boolean {
  if (!userId) return false
  if (workflow.createdBy === userId) return true
  return workflow.shares.some((entry) => entry.userId === userId && entry.canEdit)
}

export function canDeployWorkflowDraft(workflow: WorkflowDraftRecord, userId?: string | null): boolean {
  if (!userId) return false
  if (workflow.createdBy === userId) return true
  return workflow.shares.some((entry) => entry.userId === userId && entry.canDeploy)
}

export function canShareWorkflowDraft(workflow: WorkflowDraftRecord, userId?: string | null): boolean {
  if (!userId) return false
  if (workflow.createdBy === userId) return true
  return workflow.shares.some((entry) => entry.userId === userId && entry.canShare)
}

export function upsertWorkflowDraftShare(
  shares: readonly WorkflowDraftShare[],
  nextShare: WorkflowDraftShare,
): WorkflowDraftShare[] {
  const existing = shares.find((entry) => entry.userId === nextShare.userId)
  if (!existing) return [...shares, nextShare]
  return shares.map((entry) => (entry.userId === nextShare.userId ? nextShare : entry))
}

export function appendWorkflowDraftExecution(
  executions: readonly WorkflowDraftExecution[],
  execution: WorkflowDraftExecution,
): WorkflowDraftExecution[] {
  return [execution, ...executions]
}
