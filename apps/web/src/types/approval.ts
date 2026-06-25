export const APPROVAL_PRODUCT_PERMISSIONS = [
  'approvals:read',
  'approvals:write',
  'approvals:act',
  'approval-templates:manage',
] as const

export type ApprovalProductPermission = typeof APPROVAL_PRODUCT_PERMISSIONS[number]

// Sentinel role id for a starter preset's "configure before publish" placeholder static_role. The
// backend FAIL-FASTS at publish on this exact value (assertNoUnconfiguredPlaceholderRoles), so an
// untouched preset cannot be published. MUST byte-match backend ApprovalProductService.ts
// `APPROVAL_ROLE_CONFIGURE_SENTINEL` (the match is locked end-to-end by the preset publish test).
export const APPROVAL_ROLE_CONFIGURE_SENTINEL = '__APPROVAL_ROLE_PLACEHOLDER__'

export type ApprovalNodeType = 'start' | 'approval' | 'cc' | 'condition' | 'parallel' | 'end'
export type ApprovalAssigneeType = 'user' | 'role'
export type ApprovalAssigneeSourceKind = 'static_user' | 'static_role' | 'requester' | 'form_field_user' | 'direct_manager' | 'dept_head' | 'continuous_managers' | 'manager_at_level'
export type ApprovalMode = 'single' | 'all' | 'any'
export type ParallelJoinMode = 'all' | 'any'
export type EmptyAssigneePolicy = 'error' | 'auto-approve'
export type ApprovalActionType =
  | 'approve'
  | 'reject'
  | 'transfer'
  | 'revoke'
  | 'comment'
  | 'return'
  | 'add_sign'
  | 'reduce_sign'
export type ApprovalStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'revoked' | 'cancelled'
export type ApprovalTemplateStatus = 'draft' | 'published' | 'archived'
export type ApprovalTemplateVisibilityType = 'all' | 'dept' | 'role' | 'user'
export type FormFieldVisibilityOperator = 'eq' | 'neq' | 'in' | 'isEmpty' | 'notEmpty'
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
  | 'detail'

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
  assigneeType?: ApprovalAssigneeType
  assigneeIds?: string[]
  assigneeSources?: ApprovalAssigneeSource[]
  approvalMode?: ApprovalMode
  emptyAssigneePolicy?: EmptyAssigneePolicy
  autoApprovalPolicy?: AutoApprovalPolicy
}

// Byte-mirrors backend packages/core-backend/src/types/approval-product.ts:121-128.
// The authoring UI only owns `mergeWithRequester` (self-approver / merge-with-requester);
// the other three fields are carried for round-trip preservation (no silent flatten).
export interface AutoApprovalPolicy {
  mergeWithRequester?: boolean
  mergeAdjacentApprover?: boolean
  dedupeHistoricalApprover?: boolean
  actorMode?: AutoApprovalActorMode
}

export type AutoApprovalActorMode = 'system' | 'original_approver'

export type ApprovalAssigneeSource =
  | { kind: 'static_user'; userIds: string[] }
  | { kind: 'static_role'; roleIds: string[] }
  | { kind: 'requester' }
  | { kind: 'form_field_user'; fieldId: string }
  | { kind: 'direct_manager' }
  | { kind: 'dept_head' }
  | { kind: 'continuous_managers'; levels: number }
  | { kind: 'manager_at_level'; level: number }

export interface ConditionNodeConfig {
  branches: ConditionBranch[]
  defaultEdgeKey?: string
}

export interface ConditionBranch {
  edgeKey: string
  rules: ConditionRule[]
  conjunction?: 'and' | 'or'
  formula?: ConditionFormulaPredicate
}

export interface ConditionFormulaPredicate {
  expression: string
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

export interface FormFieldVisibilityRule {
  fieldId: string
  operator: FormFieldVisibilityOperator
  value?: unknown
  values?: unknown[]
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
  visibilityRule?: FormFieldVisibilityRule
  // detail / sub-form (明细/子表单) — present only when type === 'detail'. `columns` is the
  // ordered row schema of LEAF sub-fields (no nested `detail`); a `detail` value is an array
  // of row objects keyed by sub-field id.
  columns?: FormField[]
  minRows?: number
  maxRows?: number
}

export interface AmountConsistencyMapping {
  totalFieldId: string
  detailFieldId: string
  amountColumnId: string
}

export interface FormSchema {
  fields: FormField[]
  // Server-side amount total-check (design-lock #3161): when present, the backend rejects a create
  // whose top-level total ≠ the sum of the detail-row amounts. Authored here / preserved by the backend
  // assertFormSchema; the FE just carries it verbatim (the backend is the sole arbiter).
  amountConsistencyCheck?: AmountConsistencyMapping
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
  // Frozen form schema from the instance's pinned template version (detail `columns` included),
  // so the detail view renders rows from the FROZEN schema, not the live template.
  formSchema?: FormSchema | null
  currentNodeKey?: string | null
  /**
   * Parallel gateway (并行分支) — surfaced only when the instance is inside
   * a parallel region (length ≥ 2). Absent on linear state.
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
  /** P1-B add_sign — approver user IDs to pull into the current node as co-signers. */
  targetUserIds?: string[]
  /** P1-B add_sign — `parallel` (default) or `before`. */
  addSignMode?: 'before' | 'parallel'
  /** P1-B reduce_sign — assignee_id of the add-signed row to remove. */
  targetAssignmentUserId?: string
}

export interface ApprovalTemplateListItemDTO {
  id: string
  key: string
  name: string
  description: string | null
  /**
   * Wave 2 WP4 slice 1 — business category label (eg 请假 / 采购). `null`
   * means the template is uncategorized. Mirrors the backend column.
   */
  category: string | null
  visibilityScope: ApprovalTemplateVisibilityScope
  /**
   * Wave 2 WP5 slice 1 — optional SLA in hours. `null` disables tracking.
   */
  slaHours: number | null
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

export interface CreateApprovalTemplateRequest {
  key: string
  name: string
  description?: string | null
  category?: string | null
  visibilityScope?: ApprovalTemplateVisibilityScope
  slaHours?: number | null
  formSchema: FormSchema
  approvalGraph: ApprovalGraph
}

export interface UpdateApprovalTemplateRequest {
  key?: string
  name?: string
  description?: string | null
  category?: string | null
  visibilityScope?: ApprovalTemplateVisibilityScope
  slaHours?: number | null
  formSchema?: FormSchema
  approvalGraph?: ApprovalGraph
}

export interface PublishApprovalTemplateRequest {
  policy: RuntimePolicy
}
