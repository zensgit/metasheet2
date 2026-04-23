export const APPROVAL_PRODUCT_PERMISSIONS = [
  'approvals:read',
  'approvals:write',
  'approvals:act',
  'approval-templates:manage',
] as const

export type ApprovalProductPermission = typeof APPROVAL_PRODUCT_PERMISSIONS[number]

export type ApprovalNodeType = 'start' | 'approval' | 'cc' | 'condition' | 'parallel' | 'end'
export type ApprovalAssigneeType = 'user' | 'role'
export type ApprovalMode = 'single' | 'all' | 'any'
export type ParallelJoinMode = 'all' | 'any'
export type EmptyAssigneePolicy = 'error' | 'auto-approve'
export type ApprovalActionType = 'approve' | 'reject' | 'transfer' | 'revoke' | 'comment' | 'return'
export type ApprovalStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'revoked' | 'cancelled'
export type ApprovalTemplateStatus = 'draft' | 'published' | 'archived'
export type ApprovalTemplateVisibilityType = 'all' | 'dept' | 'role' | 'user'
export type FormFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'datetime'
  | 'select'
  | 'multi-select'
  | 'user'
  | 'attachment'

export interface ApprovalNode {
  key: string
  type: ApprovalNodeType
  name?: string
  config:
    | ApprovalNodeConfig
    | ConditionNodeConfig
    | CcNodeConfig
    | ParallelNodeConfig
    | Record<string, never>
}

export interface ApprovalNodeConfig {
  assigneeType: ApprovalAssigneeType
  assigneeIds: string[]
  approvalMode?: ApprovalMode
  emptyAssigneePolicy?: EmptyAssigneePolicy
}

export interface ConditionNodeConfig {
  branches: ConditionBranch[]
  defaultEdgeKey?: string
}

export interface ConditionBranch {
  edgeKey: string
  rules: ConditionRule[]
  conjunction?: 'and' | 'or'
}

export interface ConditionRule {
  fieldId: string
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'isEmpty'
  value?: unknown
}

export interface CcNodeConfig {
  targetType: ApprovalAssigneeType
  targetIds: string[]
}

/**
 * Parallel gateway (并行分支) — fans into N branches from `branches` (edgeKeys)
 * and re-joins at `joinNodeKey`. `joinMode === 'all'` ("和") waits for every
 * branch to reach the join node before advancing. `'any'` is reserved for
 * a future wave and is not wired into the executor in v1.
 */
export interface ParallelNodeConfig {
  branches: string[]
  joinMode: ParallelJoinMode
  joinNodeKey: string
}

export interface ApprovalEdge {
  key: string
  source: string
  target: string
}

export interface ApprovalGraph {
  nodes: ApprovalNode[]
  edges: ApprovalEdge[]
}

export interface RuntimePolicy {
  allowRevoke: boolean
  revokeBeforeNodeKeys?: string[]
}

export interface RuntimeGraph extends ApprovalGraph {
  policy: RuntimePolicy
}

export interface FormOption {
  label: string
  value: string
}

export interface FormField {
  id: string
  type: FormFieldType
  label: string
  required?: boolean
  placeholder?: string
  defaultValue?: unknown
  options?: FormOption[]
  props?: Record<string, unknown>
}

export interface FormSchema {
  fields: FormField[]
}

export interface ApprovalRequesterSnapshot {
  id?: string
  name?: string
  department?: string
  title?: string
  [key: string]: unknown
}

export interface ApprovalSubjectSnapshot {
  [key: string]: unknown
}

export interface ApprovalPolicySnapshot {
  rejectCommentRequired?: boolean
  sourceOfTruth?: string
  [key: string]: unknown
}

export interface ApprovalAssignmentDTO {
  id: string
  type: string
  assigneeId: string
  sourceStep: number
  nodeKey?: string | null
  isActive: boolean
  metadata: Record<string, unknown>
}

export interface UnifiedApprovalDTO {
  id: string
  sourceSystem: string
  externalApprovalId: string | null
  workflowKey: string | null
  businessKey: string | null
  title: string | null
  status: string
  requester: ApprovalRequesterSnapshot | null
  subject: ApprovalSubjectSnapshot | null
  policy: ApprovalPolicySnapshot | null
  currentStep: number | null
  totalSteps: number | null
  templateId?: string | null
  templateVersionId?: string | null
  publishedDefinitionId?: string | null
  requestNo?: string | null
  formSnapshot?: Record<string, unknown> | null
  currentNodeKey?: string | null
  /**
   * Parallel gateway (并行分支) — populated only when the instance is in
   * parallel state (length ≥ 2). For non-parallel state this equals
   * `[currentNodeKey]` or is omitted. Callers that don't care about
   * parallelism can keep using `currentNodeKey` unchanged.
   */
  currentNodeKeys?: string[] | null
  assignments: ApprovalAssignmentDTO[]
  createdAt: string
  updatedAt: string
}

export interface UnifiedApprovalHistoryDTO {
  id: string
  action: string
  actorId: string | null
  actorName: string | null
  comment: string | null
  fromStatus: string | null
  toStatus: string
  occurredAt: string | null
  metadata: Record<string, unknown>
}

export interface CreateApprovalRequest {
  templateId: string
  formData: Record<string, unknown>
}

export interface ApprovalActionRequest {
  action: ApprovalActionType
  comment?: string
  targetUserId?: string
  targetNodeKey?: string
}

export interface ApprovalTemplateListItemDTO {
  id: string
  key: string
  name: string
  description: string | null
  /**
   * Wave 2 WP4 slice 1 — business category (eg 请假 / 采购). Trimmed string,
   * <= 64 chars, or `null` for uncategorized templates. Lives on the parent
   * `approval_templates` row (not on the version) so editing category alone
   * does not spawn a new version.
   */
  category: string | null
  /**
   * Wave 2 WP4 slice 2 — template visibility ACL. Older templates default to
   * `{ type: 'all', ids: [] }` and remain globally visible.
   */
  visibilityScope: ApprovalTemplateVisibilityScope
  status: ApprovalTemplateStatus
  activeVersionId: string | null
  latestVersionId: string | null
  createdAt: string
  updatedAt: string
}

export interface ApprovalTemplateDetailDTO extends ApprovalTemplateListItemDTO {
  formSchema: FormSchema
  approvalGraph: ApprovalGraph
}

export interface ApprovalTemplateVisibilityScope {
  type: ApprovalTemplateVisibilityType
  ids: string[]
}

export interface CreateApprovalTemplateRequest {
  key: string
  name: string
  description?: string | null
  /**
   * Wave 2 WP4 slice 1 — optional category. Empty string or whitespace is
   * normalized to `null`; values longer than 64 chars trigger 400.
   */
  category?: string | null
  visibilityScope?: ApprovalTemplateVisibilityScope | null
  formSchema: FormSchema
  approvalGraph: ApprovalGraph
}

export interface UpdateApprovalTemplateRequest {
  key?: string
  name?: string
  description?: string | null
  /**
   * Wave 2 WP4 slice 1 — when provided, updates `approval_templates.category`
   * directly without creating a new template version.
   */
  category?: string | null
  visibilityScope?: ApprovalTemplateVisibilityScope | null
  formSchema?: FormSchema
  approvalGraph?: ApprovalGraph
}

export interface PublishApprovalTemplateRequest {
  policy: RuntimePolicy
}

export interface ApprovalTemplateVersionDetailDTO {
  id: string
  templateId: string
  version: number
  status: ApprovalTemplateStatus
  formSchema: FormSchema
  approvalGraph: ApprovalGraph
  runtimeGraph: RuntimeGraph | null
  publishedDefinitionId: string | null
  createdAt: string
  updatedAt: string
}
