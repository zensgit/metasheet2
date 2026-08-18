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

// Lock-3 R-1 (FE mirror site 2 of 3): `handler` (办理节点) — mirrors backend
// packages/core-backend/src/types/approval-product.ts. Keep in sync with that union and the runtime
// `APPROVAL_NODE_TYPES` admission set.
export type ApprovalNodeType = 'start' | 'approval' | 'cc' | 'condition' | 'parallel' | 'end' | 'handler'
export type ApprovalAssigneeType = 'user' | 'role'
export type ApprovalAssigneeSourceKind = 'static_user' | 'static_role' | 'requester' | 'form_field_user' | 'direct_manager' | 'dept_head' | 'continuous_managers' | 'manager_at_level' | 'requester_choice' | 'continuous_dept_heads' | 'dept_head_at_level' | 'prior_node_approver' | 'user_group' | 'form_field_user_manager' | 'form_field_user_dept_head'
// P1-C (approval-parity-master-design-lock-20260817.md §P1-C / M6): 'threshold' is the shipped
// ENGINE 4th mode (N-of-M / 门槛会签, ApprovalGraphExecutor.ts `normalizeApprovalMode`) — this type
// was FE-unexposed until this slice. Byte-mirrors backend packages/core-backend/src/types/
// approval-product.ts `ApprovalMode`. Linear-only in v1: the backend rejects a 'threshold' node
// INSIDE a parallel region (`APPROVAL_THRESHOLD_IN_PARALLEL`, ApprovalProductService.ts
// :2706-2712 / :2757-2763) — see `collectParallelRegionNodeKeys` in templateAuthoring.ts for the FE
// mirror of that exact region definition.
export type ApprovalMode = 'single' | 'all' | 'any' | 'threshold'
export type ParallelJoinMode = 'all' | 'any'
export type EmptyAssigneePolicy = 'error' | 'auto-approve'

// P1-C: byte-mirrors backend packages/core-backend/src/types/approval-product.ts `NodeTimeoutEffect`
// — the FULL declared enum, so a persisted/loaded graph round-trips any value without narrowing. Only
// a SUBSET is actually wired end-to-end (`NODE_TIMEOUT_SUPPORTED_EFFECTS` below) — `auto_approve` /
// `auto_reject` are reserved (ApprovalProductService.ts `NODE_TIMEOUT_SUPPORTED_EFFECTS`,
// `APPROVAL_NODE_TIMEOUT_EFFECT_UNSUPPORTED` at publish) and must NOT be offered by any picker.
export type NodeTimeoutEffect = 'remind' | 'transfer' | 'jump' | 'auto_approve' | 'auto_reject'

// P1-C: the effects `ApprovalSlaScheduler.fireNodeTimeouts` actually acts on AND publish accepts
// (ApprovalProductService.ts `NODE_TIMEOUT_SUPPORTED_EFFECTS`). The ONLY set any authoring picker may
// offer — do not widen without a corresponding backend scheduler + publish-validator change.
export const NODE_TIMEOUT_SUPPORTED_EFFECTS = ['remind', 'transfer', 'jump'] as const
export type SupportedNodeTimeoutEffect = typeof NODE_TIMEOUT_SUPPORTED_EFFECTS[number]

// P1-C: byte-mirrors backend `NODE_TIMEOUT_MAX_AFTER_MINUTES` (ApprovalProductService.ts :550) — the
// inclusive upper bound `validateNodeTimeoutConfigs` enforces on `timeout.afterMinutes`.
export const NODE_TIMEOUT_MAX_AFTER_MINUTES = 100000

/**
 * P1-C: byte-mirrors the SHAPE backend `normalizeNodeTimeout` re-emits (ApprovalProductService.ts
 * :1468-1493) — the exact carrier a save round-trips. `unit` is OMITTED for the 'wall_clock' default
 * (normalize only ever emits `unit: 'business'`, never `unit: 'wall_clock'` — a byte-identical
 * round-trip must mirror that omission, not merely accept both). `transferToUserId`/`jumpToNodeKey`
 * are per-effect target fields (`validateNodeTimeoutConfigs` §T1-1 slice-2): required+exclusive to
 * their matching effect, never present together, never present on 'remind'.
 */
export interface NodeTimeoutConfig {
  afterMinutes: number
  effect: NodeTimeoutEffect
  transferToUserId?: string
  jumpToNodeKey?: string
  unit?: 'business'
}

// Lock-3 §1.5 / OD-L3-6(a) — the RATIFIED seven-member handler assignee-source registry. Byte-mirrors
// backend HANDLER_ASSIGNEE_SOURCE_KINDS. The inspector renders ONLY these source kinds for a handler
// node (M4 per-node-type fail-closed registry); `continuous_managers` and every forward Lock-1 kind
// (requester_choice, …) are absent until their own slice admits them. G-13 pins this exact set.
export const HANDLER_ASSIGNEE_SOURCE_KINDS = [
  'static_user',
  'static_role',
  'requester',
  'form_field_user',
  'direct_manager',
  'dept_head',
  'manager_at_level',
  // Lock-2 §2.4 (RATIFIED 2026-08-17): the two contact-derived rows are ratified for node types
  // `approval` AND `handler` (corpus C-6; Lock-2 resolves the between-locks gap Lock-3 §1.5 left —
  // its forward-row sentence names only 表单内部门 while its roster lists 表单内联系人). Grows the
  // exact set 7→9 in the SAME slice as the kinds, with the G-13 exact-set tests updated together.
  'form_field_user_manager',
  'form_field_user_dept_head',
] as const
export type HandlerAssigneeSourceKind = typeof HANDLER_ASSIGNEE_SOURCE_KINDS[number]
// Lock-3 §1.1 — handler aggregation mode. `'all'` 会签 / `'any'` 或签; absent ≡ 'all'.
export type HandlerMode = 'all' | 'any'

export type ApprovalActionType =
  | 'approve'
  | 'reject'
  | 'transfer'
  | 'revoke'
  | 'comment'
  | 'return'
  | 'add_sign'
  | 'reduce_sign'
  // Lock-3 §2.1 — handler-node submit verb.
  | 'handle'
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
  /** FWB-0 Layer 2: single linked multitable record (server-pinned baseId/sheetId in props). */
  | 'record-link'
  /**
   * Lock-8 L8-B (approval-lock8-field-vocabulary-20260817.md §1.2, OD-L8-4/OD-L8-5/OD-L8-8): a
   * start+end date pair. Value is `{ start: string; end: string }`; props carry a REQUIRED
   * `dateType` granularity (no absent-default) plus `startLabel`/`endLabel` and an optional
   * `durationLabel`. Excluded from detail columns (OD-L8-4) and never selectable as a whole-value
   * visibility/condition dependency (OD-L8-5) — only its `${fieldId}.start`/`${fieldId}.end`
   * endpoints are.
   */
  | 'date_range'
  /**
   * Lock-8 L8-A (approval-lock8-field-vocabulary-20260817.md §1.1, OD-L8-2/OD-L8-3): a
   * DISPLAY-ONLY field (说明) — renders authored `props.text` to the requester/approver. No
   * submitted value: `required`/`defaultValue`/`options`/`placeholder` are all refused at
   * publish (A-1), the field never enters `formSnapshot` or FWB source candidates, is excluded
   * from detail columns (MS-4/MS-5), and is never a whole-value visibility/condition dependency
   * (MS-8/MS-9/MS-10) — it has no value to compare. `label` stays authoring-list-only (BE
   * requires a non-blank label for every field, `:786`); the rendered body is `props.text`.
   */
  | 'explanation'

export interface ApprovalNode {
  key: string
  type: ApprovalNodeType
  name?: string
  config:
    | ApprovalNodeConfig
    | ConditionNodeConfig
    | CcNodeConfig
    | ParallelNodeConfig
    | HandlerNodeConfig
    | Record<string, never>
}

// Lock-3 §1.1 — handler / 办理节点 config (mirrors backend HandlerNodeConfig). `assigneeSources` is the
// ONLY assignee carrier; NO empty/fallback key exists (§1.2). `fieldPermissions` ENFORCEMENT is Lock-7.
export interface HandlerNodeConfig {
  assigneeSources: ApprovalAssigneeSource[]
  handlerMode?: HandlerMode
  opinionRequired?: boolean
  fieldPermissions?: NodeFieldPermission[]
  // Lock-5 §1.6 L5-F / OD-L5-11(a) — a handler admits `allowTransfer` + `commentRequired` only.
  nodeOperationPolicy?: Pick<NodeOperationPolicy, 'allowTransfer' | 'commentRequired'>
}

// Byte-mirrors backend packages/core-backend/src/types/approval-product.ts NodeFieldAccess (P1-C
// node-level field permissions). `editable` (the absent default) === current behavior. `hidden` and
// `readonly` are BOTH enforced server-side (Lock-7 P4-B): `hidden` redacts the read echo + refuses a
// write; `readonly` refuses a write at that node. The authoring editor sets `hidden`/`readonly`; both
// round-trip and are enforced.
export type NodeFieldAccess = 'editable' | 'readonly' | 'hidden'
export interface NodeFieldPermission {
  fieldId: string
  access: NodeFieldAccess
}

export interface ApprovalNodeConfig {
  assigneeType?: ApprovalAssigneeType
  assigneeIds?: string[]
  assigneeSources?: ApprovalAssigneeSource[]
  approvalMode?: ApprovalMode
  // P1-C (T2-4 N-of-M / 门槛会签): the number of DISTINCT approver identities required. Present
  // ONLY when `approvalMode === 'threshold'` — backend `normalizeApprovalGraph` assigns it exclusively
  // inside that branch (ApprovalProductService.ts :2281-2305) and never emits it otherwise, so a
  // node carrying it under a different mode is a backend-drop shape, never a valid persisted state.
  approvalThreshold?: number
  emptyAssigneePolicy?: EmptyAssigneePolicy
  autoApprovalPolicy?: AutoApprovalPolicy
  // Node-level field permissions. Default-absent === editable === current behavior. `hidden`
  // entries are enforced server-side (echo-redaction); `readonly`/`editable` are runtime-inert.
  fieldPermissions?: NodeFieldPermission[]
  // P1-C (T1-1): node-level SLA timeout. Byte-mirrors what backend `normalizeNodeTimeout` re-emits;
  // see `NodeTimeoutConfig`. Never present on a `handler` node config (§1.2 forbidden-key list,
  // ApprovalProductService.ts :2449) — timeout is `approval`-node-only.
  timeout?: NodeTimeoutConfig
  // Lock-5 §1.1 L5-A (OD-L5-1(a)) — per-node 操作权限. Byte-mirrors the backend
  // `NodeOperationPolicy`. Absent ≡ today's behavior for every field.
  nodeOperationPolicy?: NodeOperationPolicy
}

/**
 * Lock-5 §1.1 L5-A — byte-mirrors backend
 * `packages/core-backend/src/types/approval-product.ts` `NodeOperationPolicy`.
 *
 * Only the four boolean switches have LANDED server enforcement (the §2.1 dispatch choke, 409
 * `APPROVAL_NODE_OPERATION_DISABLED`) and therefore only they may render a control (master M7/M8,
 * Lock-5 gate E-2). `returnReviewMode` (OD-L5-6(a) ships `'resume_forward'` only; §1.2: "no
 * `returnReviewMode` control renders") and `commentRequired` (§1.3, its own slice) are carried for
 * round-trip preservation and publish-time validation ONLY — do not add controls for them here.
 */
export interface NodeOperationPolicy {
  allowTransfer?: boolean
  allowAddSign?: boolean
  allowReduceSign?: boolean
  allowReturn?: boolean
  returnReviewMode?: 'resume_forward' | 'jump_back_to_current'
  commentRequired?: 'never' | 'reject_only' | 'always'
}

/** The `NodeOperationPolicy` keys whose enforcement has landed and which therefore render. */
export const RENDERED_NODE_OPERATION_POLICY_KEYS = [
  'allowTransfer',
  'allowAddSign',
  'allowReduceSign',
  'allowReturn',
] as const
export type RenderedNodeOperationPolicyKey = typeof RENDERED_NODE_OPERATION_POLICY_KEYS[number]

/**
 * Lock-5 §2.3 / gate A-2 — the ACTOR-SCOPED effective policy the SERVER resolved for this viewer at
 * their claimed seat(s), shipped on the DETAIL read only. Byte-mirrors the backend
 * `EffectiveNodeOperations`.
 *
 * Every field is a DECIDED value. The client renders it and MUST NOT re-derive: §2.3 requires the
 * FE mirror to come from the SAME config the server enforces, with no second predicate. Absent
 * (a seatless viewer, a bridged instance with no graph) ⇒ no member-action gating to apply.
 */
export interface EffectiveNodeOperations {
  allowTransfer: boolean
  allowAddSign: boolean
  allowReduceSign: boolean
  allowReturn: boolean
  commentRequired: 'never' | 'reject_only' | 'always'
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
  /**
   * Lock-1 §K2 — 提交人自选. Byte-mirrors the backend union member: the requester picks the
   * approver(s) at SUBMIT time (chooser in ApprovalNewView); choices travel in the create
   * payload keyed by node key, are scope-validated server-side, and freeze at create.
   */
  | {
      kind: 'requester_choice'
      mode: 'single' | 'multi'
      scope:
        | { type: 'company' }
        | { type: 'members'; userIds: string[] }
        | { type: 'role'; roleIds: string[] }
    }
  /**
   * Lock-1 §K4 — 连续多级部门负责人. Byte-mirrors the backend union member: levels 1..`levels`
   * (level 1 = the requester's own department head), resolved from the baked `deptHeadChainIds`
   * snapshot — a DIFFERENT pointer from `continuous_managers` (leader_in_dept vs the department
   * parent tree). No authoring shape beyond `levels`; the picker is a plain level-count input,
   * same as `continuous_managers`.
   */
  | { kind: 'continuous_dept_heads'; levels: number }
  /**
   * Lock-1 §K5-b — 指定层级部门负责人. Byte-mirrors the backend union member: `deptHeadChainIds[level-1]`,
   * positionally identical to `manager_at_level` but over the K4 department-head chain instead of
   * `managerChainIds`. Level 1 = the requester's own department head. No authoring shape beyond
   * `level`; the picker is the SAME plain level input as `manager_at_level` (single level, not a
   * level count).
   */
  | { kind: 'dept_head_at_level'; level: number }
  /**
   * Lock-1 §K3 — 节点审批人 (prior-node approver). Byte-mirrors the backend union member:
   * `nodeKey` references an `approval` node strictly upstream on EVERY runtime-reachable path
   * (a publish-time dominance check — dangling / downstream / self / branch-only references fail
   * publish). Resolution happens at dispatch from the INSTANCE's own audit rows (the referenced
   * node's actual deciders, latest round, system sentinels dropped) — never a directory read.
   * The authoring picker is a TYPED node select restricted to the legal upstream set
   * (`legalPriorApproverNodeKeys`), never a free-text key input.
   */
  | { kind: 'prior_node_approver'; nodeKey: string }
  /**
   * Lock-1 §K1 — 用户组 (user group). Byte-mirrors the backend union member: `groupIds` is a
   * non-empty array of `platform_member_groups` ids, EAGER_EXPANSION-frozen into the requester
   * snapshot at create (membership changes after create do NOT reach an in-flight instance). The
   * authoring picker is a TYPED multi-select restricted to groups bound to the template's org
   * (`/api/approval-templates/directory/member-groups?orgId=`) — never a free-text/raw-id input; a
   * group outside the binding fails publish (values-free 400), never at dispatch. Cc-as-recipient
   * (OD-L1-7) is a SEPARATE contract/registry row, not part of this shape.
   */
  | { kind: 'user_group'; groupIds: string[] }
  /**
   * Lock-2 §L2-C — 表单内联系人上级 (C-3 联系人上级). Byte-mirrors the backend union member: the
   * person chosen in the referenced TOP-LEVEL `user` field is the ANCHOR, and the source resolves
   * that person's manager at chain position `level` (level 1 = the anchor's own direct manager)
   * via the `leader_in_dept` LEADER pointer, resolved AND FROZEN at create (submit IS create) into
   * the instance snapshot — never re-read at dispatch. Publish pins: the field must exist
   * top-level, be `type: 'user'`, `required: true`, carry NO `visibilityRule`, and not declare
   * `selection: 'multi'`. Authoring shape = field picker + a single level input (upward only in
   * v1; downward stays blocked on Lock-1 OD-L1-6).
   */
  | { kind: 'form_field_user_manager'; fieldId: string; level: number }
  /**
   * Lock-2 §L2-C — 表单内联系人部门负责人 (C-3 联系人部门负责人). Same anchor and freeze semantics
   * as `form_field_user_manager` above, but a DIFFERENT pointer: the chosen contact's PRIMARY
   * department, then the department PARENT tree reading `dept_manager_userid_list` per level
   * (K4's walker re-anchored; the ratified continue-past-empty-level posture binds it — the chain
   * is DENSE, so `level` addresses the level-th *resolved* head walking up). Same publish pins,
   * same field-picker + level-input authoring shape.
   */
  | { kind: 'form_field_user_dept_head'; fieldId: string; level: number }

export type RequesterChoiceAssigneeSource = Extract<ApprovalAssigneeSource, { kind: 'requester_choice' }>

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
  /**
   * L6-P1 carrier fix landed this as an opaque pass-through (`unknown`) — the authoring editor did
   * not yet render a template-level control. P3-B / Lock-6 L6-A (docs/development/approval-lock6-
   * requester-global-policy-20260817.md §1) is that slice: the template-level dedup tier projects
   * onto the SAME `AutoApprovalPolicy` shape node-level `autoApprovalPolicy` already uses (byte-
   * mirrors backend `RuntimePolicy.autoApproval?: AutoApprovalPolicy`), so it is typed here rather
   * than left opaque. Any FIELD this editor does not author (e.g. a future `actorMode`) still
   * survives round-trip verbatim — `buildTemplateAutoApprovalPolicy` (templateAuthoring.ts) merges
   * onto the hydrated object rather than reconstructing it from scratch.
   */
  autoApproval?: AutoApprovalPolicy
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
   * Lock-3 §2.2 — the current node's TYPE (mirrors backend). The member 待办 center reads this to
   * withhold the approve/reject action surface on a 办理 (handler) task (it is not an approval task;
   * the member 办理 UI is P5). Absent ≡ not-a-handler (safe default keeps ordinary tasks actionable).
   */
  currentNodeType?: ApprovalNodeType | null
  /**
   * Parallel gateway (并行分支) — surfaced only when the instance is inside
   * a parallel region (length ≥ 2). Absent on linear state.
   */
  currentNodeKeys?: string[] | null
  /** Lock-5 §2.3 / A-2 — server-resolved effective operations for THIS viewer. Detail read only. */
  nodeOperations?: EffectiveNodeOperations | null
  assignments: ApprovalAssignmentDTO[]
  /**
   * B3-02 (行级未读): per-viewer read state, populated ONLY on the 待我处理 (pending) tab — `true`
   * once the actor has opened this row, `false` when they have not. `undefined` on every other
   * tab; callers must treat that as "no dot", never guess a value.
   */
  isRead?: boolean
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
  /**
   * Lock-1 §K2 — submit-time approver choices, keyed by the published requester_choice
   * node's key. Required per node when the route carries a requester_choice source (the
   * server 422s values-free on a missing entry); validated + frozen server-side at create.
   */
  requesterChoices?: Record<string, string[]>
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
  /**
   * L6-P1 carrier fix — the active published definition's runtime policy, or `null`/absent
   * pre-publish. Optional here (unlike the backend DTO, where it's required) so existing test
   * fixtures that predate this field keep compiling; the backend always sends the key. Hydrated
   * into the draft verbatim by `draftFromTemplate` / `originalPolicy` and merged back onto the
   * publish payload by `buildPublishPolicy` — never read directly for rendering.
   */
  policy?: RuntimePolicy | null
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
  /** B3-09 — optional note captured at publish time; null for drafts, note-less publishes, and pre-column versions. */
  publishNote: string | null
  restoredFromVersionId: string | null
  createdAt: string
  updatedAt: string
}

/**
 * B3-09 (模板治理 — 版本历史): lightweight per-version row for the history list. Mirrors the backend
 * `ApprovalTemplateVersionSummaryDTO` — deliberately no formSchema/approvalGraph (fetched on demand
 * via getTemplateVersion when a specific version is opened).
 */
export interface ApprovalTemplateVersionSummaryDTO {
  id: string
  templateId: string
  version: number
  status: ApprovalTemplateStatus
  publishNote: string | null
  publishedDefinitionId: string | null
  restoredFromVersionId: string | null
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
  /**
   * B3-09 (模板治理 — 发布说明): optional free-text note for THIS publish action. The server
   * normalizes (trim, empty→null, 2000-char cap → 400) — see backend
   * PublishApprovalTemplateRequest.note. Never required.
   */
  note?: string | null
}

export interface RestoreApprovalTemplateVersionRequest {
  expectedLatestVersionId: string
}

/**
 * B3-08 (模板治理 — 停用/启用用量指标): the archive confirm dialog's blast-radius indicator. See the
 * backend `ApprovalTemplateUsageDTO` doc comment (packages/core-backend/src/types/approval-product.ts)
 * for the exact semantics — archiving never touches these instances, the count is purely
 * informational.
 */
export interface ApprovalTemplateUsageDTO {
  templateId: string
  instanceCount: number
  activeInstanceCount: number
}
