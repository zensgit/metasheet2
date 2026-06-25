export const APPROVAL_PRODUCT_PERMISSIONS = [
  'approvals:read',
  'approvals:write',
  'approvals:act',
  'approval-templates:manage',
] as const

export type ApprovalProductPermission = typeof APPROVAL_PRODUCT_PERMISSIONS[number]

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
export const APPROVAL_TERMINAL_STATUSES = ['approved', 'rejected', 'revoked', 'cancelled'] as const
export type ApprovalTerminalStatus = typeof APPROVAL_TERMINAL_STATUSES[number]
export type ApprovalTemplateStatus = 'draft' | 'published' | 'archived'
export type ApprovalTemplateVisibilityType = 'all' | 'dept' | 'role' | 'user'
export type FormFieldVisibilityOperator = 'eq' | 'neq' | 'in' | 'isEmpty' | 'notEmpty'

/**
 * P1-C node-level field permissions (HIDDEN subset).
 *
 * `editable` (the absent default) === current behavior — a node without
 * `fieldPermissions` leaves every form field fully visible/editable, so every
 * pre-existing template and instance is byte-for-byte unchanged.
 *
 * Only `hidden` is enforced at runtime (server-side echo-redaction: a hidden
 * field is stripped from the `formSnapshot` echoed in read DTOs while the
 * instance is AT the hiding node). `readonly`/`editable` are part of the
 * contract enum (default-preserving, normalized-through) but have NO runtime
 * effect yet — they are blocked on the edit-form-at-node prerequisite (form
 * snapshots are written once at create and no dispatch branch edits them, so
 * `readonly` is indistinguishable from plain display today). The enum members
 * are declared now so the contract is forward-stable; do not wire them.
 */
export type NodeFieldAccess = 'editable' | 'readonly' | 'hidden'

export interface NodeFieldPermission {
  fieldId: string
  access: NodeFieldAccess
}
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
  // P1-C node-level field permissions. Default-absent === editable === current
  // behavior. `hidden` entries are enforced server-side; `readonly`/`editable`
  // are inert (forward-stable contract only). Orthogonal to FormFieldVisibilityRule
  // (data-value-keyed); fieldPermissions is node-keyed.
  fieldPermissions?: NodeFieldPermission[]
}

export type ApprovalAssigneeSource =
  | { kind: 'static_user'; userIds: string[] }
  | { kind: 'static_role'; roleIds: string[] }
  | { kind: 'requester' }
  | { kind: 'form_field_user'; fieldId: string }
  | { kind: 'direct_manager' }
  | { kind: 'dept_head' }
  /**
   * Requester's management chain, levels 1..`levels` (level 1 = direct manager),
   * resolved into this node's approver set from the baked `managerChainIds`
   * snapshot. The node's `approvalMode` (会签 all / 或签 any) governs aggregation.
   * `levels` is validated `[1, MAX_MANAGER_CHAIN_LEVELS]` at normalize time.
   */
  | { kind: 'continuous_managers'; levels: number }
  /**
   * The requester's manager at a SINGLE chain level (`level` = 1 → direct manager,
   * 2 → manager's manager, …), resolved from the baked `managerChainIds` snapshot.
   * Authoring N approval nodes at levels 1..N composes sequential 逐级 approval
   * (Reading B / B1) — no publish-time auto-expansion. `level` is validated
   * `[1, MAX_MANAGER_CHAIN_LEVELS]` at normalize time.
   */
  | { kind: 'manager_at_level'; level: number }

export interface ApprovalAssigneeResolutionMetadata {
  /**
   * Present for assignees resolved from an `assigneeSources` entry (the dynamic-source
   * discriminator downstream keys on its presence). Absent for legacy `assigneeIds`
   * assignments — including a legacy assignment that a delegation substituted, which
   * then carries only `delegatedFrom`.
   */
  resolvedFrom?: {
    kind: ApprovalAssigneeSourceKind
    sourceIndex: number
    fieldId?: string
  }
  /**
   * Set when a delegation (委托) substituted this assignee: the original delegator's
   * id. The resolved `assigneeId` is already the delegatee; this is audit-trail only.
   */
  delegatedFrom?: string
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
 * branch to reach the join node before advancing. `'any'` advances as soon as
 * the first branch reaches the join node — wired in the executor
 * (`resolveFromNode` fan-out + `resolveAfterApproveInParallel`).
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
  autoApproval?: AutoApprovalPolicy
}

export interface AutoApprovalPolicy {
  mergeWithRequester?: boolean
  mergeAdjacentApprover?: boolean
  dedupeHistoricalApprover?: boolean
  actorMode?: AutoApprovalActorMode
}

export type AutoApprovalActorMode = 'system' | 'original_approver'
export type AutoApprovalPolicySource = 'node' | 'template'
export type AutoApprovalMergeReason =
  | 'auto-merge-requester'
  | 'auto-merge-adjacent'
  | 'auto-dedupe-historical'
export type ApprovalAutoApprovalReason = 'empty-assignee' | AutoApprovalMergeReason

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
  // ordered row schema of LEAF sub-fields (no nested `detail`, enforced at author-time);
  // a `detail` value is submitted as an array of row objects keyed by sub-field id.
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
  // Server-side amount total-check (design-lock #3161): when present, createApproval validates that
  // formData[totalFieldId] equals the money-safe sum of formData[detailFieldId][*][amountColumnId],
  // fail-closed, before the graph is built. Validated + preserved at template-save (assertFormSchema),
  // so it round-trips with form_schema (no migration / no separate config column).
  amountConsistencyCheck?: AmountConsistencyMapping
}

export interface ApprovalRequesterSnapshot {
  id?: string
  name?: string
  department?: string
  title?: string
  /**
   * Lane G (P1-A) org-relation plumbing — local user id of the requester's
   * direct manager, frozen at create time from the directory `raw` payload.
   * Absent when unresolvable (no linked directory account, top-of-tree, or
   * pre-extraction legacy rows). The `direct_manager` assignee-source kind reads
   * this; it is purely additive and existing snapshots omit it.
   */
  managerId?: string
  /**
   * Lane G (P1-A) org-relation plumbing — local user id of the head of the
   * requester's primary department, frozen at create time. Absent when
   * unresolvable. Read by the `dept_head` assignee-source kind.
   */
  deptHeadId?: string
  /**
   * Org-relation plumbing — ordered local user ids of the requester's management
   * chain, level 1 first (`[0]` equals `managerId`). Frozen at create time only
   * when the published graph uses a manager-chain source — `continuous_managers`
   * OR `manager_at_level` (gated by runtimeGraphUsesManagerChain, so it is not
   * baked for every approval). Cycle-guarded + capped; absent when unresolvable or
   * unused. Read by `continuous_managers` (slices it to its own `levels`) and by
   * `manager_at_level` (picks `chain[level - 1]`, dense). Purely additive; existing
   * snapshots omit it.
   */
  managerChainIds?: string[]
  /**
   * Delegation (委托) substitution map (delegator localUserId -> delegatee localUserId),
   * frozen at create time from the active `approval_delegations` scoped to this template
   * + the create-time instant. Read by `ApprovalAssigneeResolver` inside `pushResolved`
   * to route a delegator's resolved assignment to the delegatee. Absent when no active
   * delegation applies; purely additive.
   */
  delegations?: Record<string, string>
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
  // so the read renders detail rows from the FROZEN schema, not the live template.
  formSchema?: FormSchema | null
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
  /**
   * P1-B add_sign — approver user IDs to pull into the current approval node
   * as co-signers (`assignment_type='user'`). Required (non-empty) for add_sign.
   */
  targetUserIds?: string[]
  /**
   * P1-B add_sign — `parallel` (并加签, default) adds co-signers at the current
   * node; `before` (前加签) is rejected inside a parallel region in v1
   * (no node-internal ordered queue yet — see design §7).
   */
  addSignMode?: 'before' | 'parallel'
  /**
   * P1-B reduce_sign — assignee_id of the previously add-signed row to remove.
   * Only rows stamped `metadata.addSign === true` are removable.
   */
  targetAssignmentUserId?: string
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
  /**
   * Wave 2 WP5 slice 1 — SLA deadline for new instances in whole hours.
   * `null` disables SLA tracking for the template.
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
  /**
   * Wave 2 WP5 slice 1 — optional SLA in hours. `null`/undefined disables
   * SLA tracking; positive integers are required, 0 and negatives reject.
   */
  slaHours?: number | null
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
  /**
   * Wave 2 WP5 slice 1 — when provided, updates `approval_templates.sla_hours`.
   * Pass `null` to clear the SLA.
   */
  slaHours?: number | null
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
