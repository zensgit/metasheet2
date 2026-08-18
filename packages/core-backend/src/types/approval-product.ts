export const APPROVAL_PRODUCT_PERMISSIONS = [
  'approvals:read',
  'approvals:write',
  'approvals:act',
  'approvals:admin',
  'approvals:admin-templates',
  'approvals:admin-data',
  'approval-templates:manage',
] as const

export type ApprovalProductPermission = typeof APPROVAL_PRODUCT_PERMISSIONS[number]

// Lock-3 §1.1 R-1: `handler` (办理节点) is the seventh node type — a NON-approval business
// operation node with its own roster + submit-only completion. Three mirror sites must move
// together (this union, `apps/web/src/types/approval.ts`, and the `APPROVAL_NODE_TYPES` runtime
// admission set in ApprovalProductService.ts) or the type is unpublishable.
export type ApprovalNodeType = 'start' | 'approval' | 'cc' | 'condition' | 'parallel' | 'end' | 'handler'
export type ApprovalAssigneeType = 'user' | 'role'
export type ApprovalAssigneeSourceKind = 'static_user' | 'static_role' | 'requester' | 'form_field_user' | 'direct_manager' | 'dept_head' | 'continuous_managers' | 'manager_at_level' | 'requester_choice' | 'continuous_dept_heads' | 'dept_head_at_level' | 'prior_node_approver'
export type ApprovalMode = 'single' | 'all' | 'any' | 'threshold'

/**
 * Lock-3 §1.5 / OD-L3-6(a) — the RATIFIED handler assignee-source registry: exactly SEVEN of the
 * shipped kinds. `continuous_managers` is excluded (corpus C-2 lists 连续多级上级 for approvers, not
 * handlers), and `requester_choice` — though now shipped (Lock-1 K2) and §1.5 says it ADMITS once
 * Lock-1 lands — is NOT added here: §1.5 says "each row lands in the SAME slice as its kind", and
 * gate G-13 freezes the seven-member set by exact-set equality (adding a kind must FAIL). Widening
 * to requester_choice is a separate follow-up decision, not P4-A. This is the per-node-type M4
 * fail-closed registry: a handler config carrying any kind outside this set is rejected at authoring.
 */
export const HANDLER_ASSIGNEE_SOURCE_KINDS = [
  'static_user',
  'static_role',
  'requester',
  'form_field_user',
  'direct_manager',
  'dept_head',
  'manager_at_level',
] as const
export type HandlerAssigneeSourceKind = typeof HANDLER_ASSIGNEE_SOURCE_KINDS[number]

/**
 * Lock-3 §1.1 — handler aggregation mode. A NEW key (not a reuse of `ApprovalMode`, which drags
 * `single`/`threshold` the corpus evidences none of for handlers, and inherits the fail-OPEN
 * `normalizeApprovalMode`). `'all'` (会签, every handler submits) / `'any'` (或签, first submits).
 * Absent ≡ `'all'` (the stronger guarantee; corpus states no default).
 */
export type HandlerMode = 'all' | 'any'
export type ParallelJoinMode = 'all' | 'any'
export type EmptyAssigneePolicy = 'error' | 'auto-approve'
export const APPROVAL_ACTION_TYPES = [
  'approve',
  'reject',
  'transfer',
  'revoke',
  'comment',
  'return',
  'add_sign',
  'reduce_sign',
  // Lock-3 §2.1 — a handler completes by SUBMITTING; the verb is `handle`. Three sites move together:
  // this const, the route dispatch guard (routes/approvals.ts), and the `approval_records_action_check`
  // DB migration (a `handle` audit INSERT would violate the shipped 14-member CHECK otherwise).
  'handle',
] as const
export type ApprovalActionType = typeof APPROVAL_ACTION_TYPES[number]
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

/**
 * Lock-3 §1.1 — handler / 办理节点 config. `assigneeSources` is the ONLY assignee carrier (no legacy
 * assigneeType/assigneeIds pair). Deliberately carries NO empty-assignee/fallback key in v1 (§1.2 /
 * OD-L3-2(a)): a handler mints no second vocabulary for Lock-4 to supersede and no inert switch reaches
 * the inspector (M4/M7). Empty resolution at dispatch terminates at the shipped APPROVAL_ASSIGNEE_EMPTY
 * 400 (§2.2). `fieldPermissions` share the approval-node shape; ENFORCEMENT is Lock-7 (a handler submit
 * carries no field writes until then — §3, fail-closed 422).
 */
export interface HandlerNodeConfig {
  assigneeSources: ApprovalAssigneeSource[]
  handlerMode?: HandlerMode
  /** 办理意见; absent ≡ false (corpus C-7 default / OD-L3-3(a)). */
  opinionRequired?: boolean
  fieldPermissions?: NodeFieldPermission[]
}

// T1-1 node-level SLA + timeout. The effect enum declares the full set; slice 1 wired `remind`
// (a notification, no state mutation) and slice 2 wires `transfer` + `jump` (state mutations executed
// by the scanner with a system actor). auto_approve/auto_reject remain rejected at publish and
// runtime-inert — a jump whose auto-approval cascade would land TERMINAL is likewise skipped unless
// the APPROVAL_NODE_TIMEOUT_TERMINAL_EFFECTS gate is explicitly enabled (it ships CLOSED).
// `afterMinutes` = whole wall-clock minutes from the node's activation.
export type NodeTimeoutEffect = 'remind' | 'transfer' | 'jump' | 'auto_approve' | 'auto_reject'
export interface NodeTimeoutConfig {
  afterMinutes: number
  effect: NodeTimeoutEffect
  /** effect='transfer': static user the node's active assignments are handed to when the deadline fires. */
  transferToUserId?: string
  /** effect='jump': approval-node key the instance is sent to (re-entry semantics) when the deadline fires. */
  jumpToNodeKey?: string
  /**
   * T3-2 SLA-unit discriminator. Default/absent === 'wall_clock' — `afterMinutes` elapses as UTC
   * wall-clock (byte-identical to T1-1). When 'business', the deadline is computed against a
   * working-day calendar (WorkdayCalendarPort): only minutes on a working day and outside every
   * non-counting window count. Provider-absent → fail-open to wall-clock.
   */
  unit?: 'wall_clock' | 'business'
}

export interface ApprovalNodeConfig {
  assigneeType?: ApprovalAssigneeType
  assigneeIds?: string[]
  assigneeSources?: ApprovalAssigneeSource[]
  approvalMode?: ApprovalMode
  /**
   * T2-4 N-of-M threshold (门槛会签). Only meaningful when `approvalMode === 'threshold'`:
   * the node resolves APPROVED once `approvalThreshold` DISTINCT approver identities have
   * approved (M = the baked assignee count). Validated at publish as a positive integer and,
   * when every approver is a static user id, bounded `1 <= approvalThreshold <= distinct(assigneeIds)`.
   * Threshold mode is linear-only in v1 (rejected inside a parallel region). Lives in node-config
   * JSON — no SQL migration.
   */
  approvalThreshold?: number
  emptyAssigneePolicy?: EmptyAssigneePolicy
  autoApprovalPolicy?: AutoApprovalPolicy
  // P1-C node-level field permissions. Default-absent === editable === current
  // behavior. `hidden` entries are enforced server-side; `readonly`/`editable`
  // are inert (forward-stable contract only). Orthogonal to FormFieldVisibilityRule
  // (data-value-keyed); fieldPermissions is node-keyed.
  fieldPermissions?: NodeFieldPermission[]
  // T1-1 node-level SLA: optional per-node timeout + effect (slice 1: remind only).
  timeout?: NodeTimeoutConfig
  // T3-3 node signature / compliance — slice 1: DECLARED-INERT. Persisted + round-tripped on the node
  // config but NOT enforced at runtime — approve/reject never blocks on a signature until enforcement is
  // separately ratified (mirrors the fieldPermissions readonly/auto_* declared-but-do-not-wire precedent).
  // Default-absent === no signature policy === current behavior (byte-stable).
  signaturePolicy?: SignaturePolicy
}

/**
 * T3-3 slice 1 (declared-inert): a node's signature/attestation requirement. `kind` is contract-OPEN
 * (v1 authoring offers typed/click attestation; handwritten-image capture is a separate later slice — Q1).
 * `appliesTo` defaults to approve-only when absent (Q7). NOT enforced this slice.
 */
export interface SignaturePolicy {
  required: boolean
  kind?: string
  appliesTo?: 'approve' | 'approve_reject'
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
  /**
   * Lock-1 §K2 — 提交人自选 (requester choice). The REQUESTER picks the approver(s) at SUBMIT
   * time: the chosen local user ids travel in the create payload
   * (`CreateApprovalRequest.requesterChoices`, keyed by node key), are validated server-side
   * against THIS configured `scope` at create (fail-closed 422 BEFORE any insert), and are
   * frozen into `ApprovalRequesterSnapshot.requesterChoices`. The resolver reads ONLY that
   * frozen map — never a live directory/role read — so return/admin-jump/timeout re-entry
   * re-resolves the SAME list; changing an in-flight seat is `transfer`, not a re-choice.
   * `mode: 'single'` requires exactly one chosen id; `'multi'` requires at least one.
   * Scope semantics at create: `company` = any active local user; `members` = only ids in the
   * configured list; `role` = only ids holding a configured role in a FRESH `user_roles` read
   * (plain role membership — deliberately NOT the `approval_usable`-curated
   * `resolveApprovalRequesterRoleIds`, which serves the `requester.role` ROUTING predicate).
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
   * Lock-1 §K4 — 连续多级部门负责人 (continuous department heads), levels 1..`levels` (level 1 =
   * the requester's own department head), resolved from the baked `deptHeadChainIds` snapshot.
   * A DIFFERENT pointer from `continuous_managers`/`managerChainIds`: that chain walks the
   * `leader_in_dept` LEADER pointer (`ApprovalDirectoryOrg.resolveManagerChain`); this one walks
   * the DEPARTMENT PARENT tree (`directory_departments.external_parent_department_id`), reading
   * `dept_manager_userid_list` at each level (`ApprovalDirectoryOrg.resolveDeptHeadChain`). The
   * two chains coincide only where every department's leader is also its listed manager.
   * RATIFIED continue-past-empty-level posture: a level whose manager list is empty or resolves
   * to no linked local user contributes NOTHING to the chain, but the walk CONTINUES to that
   * department's parent (the next hop is the department's OWN parent pointer, independent of
   * whether a head resolves at this level) — unlike `managerChainIds`, whose next hop IS the
   * resolved leader and so DOES stop when none is found. `levels` is validated
   * `[1, MAX_MANAGER_CHAIN_LEVELS]` at normalize time, byte-identically to `continuous_managers`.
   */
  | { kind: 'continuous_dept_heads'; levels: number }
  /**
   * Lock-1 §K5-b — 指定层级部门负责人 (dept head at a specific level): `deptHeadChainIds[level-1]`,
   * positionally IDENTICAL to `manager_at_level` but reading the K4 department-head chain instead
   * of `managerChainIds` (a different pointer — see the `continuous_dept_heads` doc comment above).
   * Level 1 = the requester's own department head (byte-identical to the single-level `dept_head`).
   * Strictly downstream of K4: this reads the SAME `deptHeadChainIds` snapshot field K4 builds — it
   * does not add a snapshot field of its own. `level` is validated `[1, MAX_MANAGER_CHAIN_LEVELS]`
   * at normalize time, byte-identically to `manager_at_level`. A `level` valid in contract but past
   * the end of THIS requester's (possibly shorter) chain resolves EMPTY and falls to
   * `emptyAssigneePolicy` — the shipped `manager_at_level` behavior, unchanged (Lock-1 §K5: never a
   * dispatch-time failure).
   */
  | { kind: 'dept_head_at_level'; level: number }
  /**
   * Lock-1 §K3 — 节点审批人 (prior-node approver): resolves to the referenced prior node's ACTUAL
   * decider(s) from INSTANCE state — the audited `action='approve'` actors at that node — never
   * from that node's config and never from a directory read. `nodeKey` MUST reference an
   * `approval` node strictly upstream on EVERY runtime-reachable path to the carrying node
   * (a DOMINANCE check, enforced at publish by `assertPriorNodeApproverReferencesUpstream` —
   * dangling / non-approval / self / not-on-every-path references are a publish-time 400,
   * never a dispatch-time surprise).
   *
   * This is the ONE kind whose resolution is not a pure function of the create-time snapshot
   * (§2.1 "K3 alone"): the deciders are unknowable at create, so the CALLER reads them at node
   * activation from instance-internal `approval_records` rows (LATEST `nodeEntryEpoch` round only
   * — OD-L1-3(a)) and passes them in alongside the snapshots
   * (`ResolveApprovalAssigneesOptions.priorNodeApprovers`); the resolver itself stays pure and
   * adds no database access. System sentinel actors (`system:auto-approval`,
   * `system:approval-timeout` — the `system:` namespace) are DROPPED, never assigned; when
   * dropping leaves nothing (or the referenced node was skipped / not reached), resolution is
   * EMPTY and falls to the node's `emptyAssigneePolicy` (OD-L1-4(a) — under the default 'error'
   * that is a fail-closed APPROVAL_ASSIGNEE_EMPTY, and under an explicit 'auto-approve' an
   * AUDITED auto-approval event, never a silent nobody).
   *
   * Explicit NO-DEDUP across nodes (§K3): the same person approves AGAIN at the referencing node;
   * intra-node identity dedup (the resolver's `seen` set) still collapses one identity to one
   * seat WITHIN this node. NO self-exclusion (deliberate, the §K2 posture): a prior decider who
   * happens to be the requester still gets the seat — self-approval semantics stay owned by
   * `autoApprovalPolicy.mergeWithRequester`. The RULE (which node to reference) is frozen in the
   * instance's pinned published runtime graph, so a re-publish never alters an in-flight
   * instance's reference.
   */
  | { kind: 'prior_node_approver'; nodeKey: string }

export type RequesterChoiceAssigneeSource = Extract<ApprovalAssigneeSource, { kind: 'requester_choice' }>

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
    /**
     * Lock-1 §K3 (`prior_node_approver` only): the referenced prior node's key, so "why is this
     * person an approver" is answerable from the row alone (§2.6 — a template-authored node key,
     * values-free).
     */
    priorNodeKey?: string
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
  /** RA-1a: directory-resolved primary department NAME (via ApprovalDirectoryOrg, NOT the JWT/session
   *  `department` above) — the tamper-resistant source `requester.department` reads; frozen at create,
   *  reloaded at dispatch. */
  directoryDepartment?: string | null
  /** Directory-resolved job title (via ApprovalDirectoryOrg, NOT the JWT/session `title` below) — the
   *  tamper-resistant source `requester.title` reads; frozen at create, reloaded at dispatch. */
  directoryTitle?: string | null
  /** RA-1b: the requester's frozen ROLE-ID SET, resolved by a FRESH `user_roles` SELECT at create (NOT the
   *  login-time token claim `roles` below) — the tamper-resistant source `requester.role in [...]` reads;
   *  frozen at create, reloaded at dispatch. Populated only when the published graph routes on
   *  `requester.role`. */
  directoryRoles?: string[] | null
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
   * Lock-1 §K4 — ordered local user ids of the requester's DEPARTMENT-HEAD chain, level 1 first
   * (the requester's own department head). A DIFFERENT pointer from `managerChainIds` — see the
   * `continuous_dept_heads` union member doc comment for the leader-pointer vs parent-tree
   * distinction. Frozen at create time when the published graph uses `continuous_dept_heads` OR
   * Lock-1 §K5-b `dept_head_at_level` (gated by `runtimeGraphUsesDeptHeadChain`, EXTENDED to both
   * kinds, so it is not baked for every approval).
   * Cycle-guarded (visited set of external DEPARTMENT ids) + capped at MAX_MANAGER_CHAIN_LEVELS;
   * self-excluded on the requester's LOCAL id; absent when unresolvable or unused. A level whose
   * head is unresolved contributes nothing but does NOT truncate the walk (ratified
   * continue-past-empty-level posture). Read by `continuous_dept_heads` (slices it to its own
   * `levels`) and by `dept_head_at_level` (positional single-level pick, `[level-1]`). Purely
   * additive; existing snapshots omit it.
   */
  deptHeadChainIds?: string[]
  /**
   * Delegation (委托) substitution map (delegator localUserId -> delegatee localUserId),
   * frozen at create time from the active `approval_delegations` scoped to this template
   * + the create-time instant. Read by `ApprovalAssigneeResolver` inside `pushResolved`
   * to route a delegator's resolved assignment to the delegatee. Absent when no active
   * delegation applies; purely additive.
   */
  delegations?: Record<string, string>
  /**
   * Lock-1 §K2 (requester_choice) — the requester's submit-time approver choices, FROZEN at
   * create: node key → chosen local user ids, validated against each `requester_choice`
   * source's configured scope BEFORE any insert. OPT-IN: present only when the published
   * runtime graph carries a `requester_choice` source (unrelated approvals pay nothing).
   * The resolver reads ONLY this map (no live read at dispatch/return/admin-jump/timeout),
   * so a re-entered node re-resolves the SAME list; a directory/role change after create
   * never alters it — the sanctioned in-flight mutation is `transfer`.
   */
  requesterChoices?: Record<string, string[]>
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
   * Lock-3 §2.2 — the TYPE of the instance's current node, resolved from the frozen runtime graph.
   * Lets the member 待办 surface tell a handler (办理) task apart from an approval task so it can
   * withhold the approve/reject action affordance (a handler node has no member decision — 同意/拒绝
   * would 409). Absent/`null` for bridged/external instances (no node config) and non-platform rows;
   * consumers treat absent as "not a handler" (the safe default: an ordinary approval task stays
   * actionable). Values-free (a node-type token, never an id/value).
   */
  currentNodeType?: ApprovalNodeType | null
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
  /**
   * Lock-1 §K2 (requester_choice) — submit-time approver choices, keyed by the published
   * `requester_choice` node's key. REQUIRED (per node) when the published route carries a
   * `requester_choice` source: a missing/empty entry is a values-free 422 at create, never an
   * empty resolution. Validated server-side against the node's configured scope + mode
   * cardinality BEFORE any instance/assignment insert, then frozen into the requester
   * snapshot (`requesterChoices`) that the resolver reads.
   */
  requesterChoices?: Record<string, string[]>
}

export interface ApprovalActionRequest {
  action: ApprovalActionType
  comment?: string
  /**
   * A-4 (one-tap lock #3594 §4): INTERNAL-ONLY channel attribution injected by the card-delivery
   * wrapper — never accepted from HTTP bodies (the /actions route constructs its request from an
   * explicit field whitelist). Recorded onto the approve/reject approval_records metadata.
   */
  channelOrigin?: { channel: string; cardDeliveryId: string }
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
  /**
   * Lock-3 §3 / Lock-7 L7-C — the field-write channel for a handler `handle` submission. Lock-7 P4-B
   * lands the write: a plain object `{ fieldId: value }` is applied under the actor's single-node mask
   * (`editable` writes; `readonly`/`hidden`/unknown/detail-sub-column refuse values-free), validated
   * against the FROZEN version schema, then UPDATEs `form_snapshot` in place inside the handle
   * transaction plus append-only revision rows (OD-L7-6). `{}` is an accepted zero-write no-op;
   * `null` / a non-object is a values-free 400 `APPROVAL_FIELD_WRITE_PAYLOAD_INVALID`. Meaningful only
   * on `handle` — present on any other action it is a values-free 400. Detected by key PRESENCE.
   */
  fieldWrites?: unknown
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
  /**
   * L6-P1 carrier fix — the ACTIVE published definition's runtime policy (the same object a
   * publish call would need to preserve on republish), or `null` when the template has never
   * been published. `policy` is a PUBLISH argument, never a template/version column (this DTO
   * has no other source for it) — required so the authoring draft can hydrate `allowRevoke` from
   * the persisted value instead of a hardcoded default, and so a republish can merge onto the
   * full object instead of replacing it and destroying sibling fields (e.g. `autoApproval`) set
   * only through the publish API.
   */
  policy: RuntimePolicy | null
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
  /**
   * B3-09 (模板治理 — 发布说明): optional free-text note captured on THIS publish action and
   * persisted on the version being published (`approval_template_versions.publish_note`). `null`/
   * undefined/whitespace-only clears/omits it — a publish never requires a note. Older,
   * already-published versions predate the column and surface `publishNote: null` (backward
   * compatible).
   */
  note?: string | null
  /**
   * FWB-0 Layer 2: publisher identity for record-link target sheet read authorization.
   * Required when the form schema contains any `record-link` field; fail-closed when missing.
   */
  actorUserId?: string | null
}

export interface RestoreApprovalTemplateVersionRequest {
  /**
   * Optimistic-concurrency anchor captured when the history was loaded. A restore always creates a
   * new draft from the selected snapshot; it never rewrites a historical row in place.
   */
  expectedLatestVersionId: string
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
  /** B3-09 — see PublishApprovalTemplateRequest.note. */
  publishNote: string | null
  /** Source snapshot when this draft was created by restore; null for ordinary edits/publishes. */
  restoredFromVersionId: string | null
  createdAt: string
  updatedAt: string
}

/**
 * B3-09 (模板版本历史) — a lightweight per-version row for the history list. Deliberately omits
 * `formSchema` / `approvalGraph` (a template can accumulate many versions; the full graph/schema
 * for one historical version is only fetched on demand via the existing
 * `GET /:id/versions/:versionId` detail endpoint).
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

/**
 * B3-08 (模板治理 — 停用/启用用量指标): the blast-radius indicator surfaced by the archive confirm
 * dialog. `instanceCount` is every approval_instances row ever created from this template;
 * `activeInstanceCount` is the subset still in flight (status outside APPROVAL_TERMINAL_STATUSES).
 * Archiving never touches these instances — each one already carries its own frozen
 * template_version_id / published_definition_id and keeps running regardless of the parent
 * template's status. The number is purely informational: "these instances started from a template
 * a future request can no longer use," not "these instances are at risk."
 */
export interface ApprovalTemplateUsageDTO {
  templateId: string
  instanceCount: number
  activeInstanceCount: number
}
