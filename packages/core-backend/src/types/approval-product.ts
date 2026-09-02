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
export type ApprovalAssigneeSourceKind = 'static_user' | 'static_role' | 'requester' | 'form_field_user' | 'direct_manager' | 'dept_head' | 'continuous_managers' | 'manager_at_level' | 'requester_choice' | 'continuous_dept_heads' | 'dept_head_at_level' | 'prior_node_approver' | 'user_group' | 'form_field_user_manager' | 'form_field_user_dept_head'
export type ApprovalMode = 'single' | 'all' | 'any' | 'threshold' | 'sequential'

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
  // Lock-2 §2.4 (RATIFIED 2026-08-17) — the two contact-derived rows are ratified for node types
  // `approval` AND `handler` ("The handler rows are corpus-evidenced, not an M11 widening (C-6);
  // Lock-3 §1.5's forward-row sentence names only 表单内部门 although its own roster lists
  // 表单内联系人, so the two contact-derived rows supply what fell between the locks"). Each row
  // lands in the SAME slice as its kind, so the exact-set roster grows 7→9 here — deliberately,
  // with the G-13 exact-set tests updated in the same commit (they exist to make this growth a
  // reviewed decision, not to forbid ratified rows).
  'form_field_user_manager',
  'form_field_user_dept_head',
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
// Lock-4 §3 (F4-B, docs/development/approval-lock4-flow-policies-20260817.md) — 'designated' is the
// P3-A slice landed here. Quoting the ratified text: "`EmptyAssigneePolicy` grows from `'error' |
// 'auto-approve'` to add `'designated'`, whose targets ride ONE new top-level key
// `emptyAssigneeFallback` ... `'error'` stays the absent default." OD-L4-3(a): 'designated' ONLY —
// 转审批管理员 is expressed by DESIGNATING the admin (as a static_user/static_role fallback target);
// there is NO reverse admin-role lookup, and none is built here.
export type EmptyAssigneePolicy = 'error' | 'auto-approve' | 'designated'
/**
 * Lock-4 §3 F4-B — the ONLY carrier for `emptyAssigneePolicy: 'designated'` targets (one key, not
 * two, "because every added key must move four allowlists at once"). Filled through typed pickers
 * only (D0 §10.2); shape deliberately mirrors `static_user`/`static_role` (`ApprovalAssigneeSource`)
 * so the SAME resolver path (`resolveApprovalAssignees`) can consume it without a hand-built path.
 * "Fallback is exactly ONE non-recursive step (locked)" — this type carries NO nested fallback of
 * its own, by construction.
 */
export interface EmptyAssigneeFallback {
  userIds?: string[]
  roleIds?: string[]
}
/**
 * Lock-4 §2 F4-A (OD-L4-1(a)) — node-level 审批类型 (automatic decision). A CONFIG field on
 * `type:'approval'`, NOT a new node type. Absent ≡ `'manual'` ≡ today's behavior (byte-stable for
 * every existing graph).
 *
 * OD-L4-2(a) — RATIFIED verbatim: "auto_approve only, auto_reject deferred (parity residual
 * tracked: the 审批类型 radio ships 人工/自动通过 only — no inert third option)". Unlike
 * `NodeFieldAccess`'s declared-but-inert `readonly`/`editable` members (which the doc comment above
 * that union explicitly says exist so the contract is forward-stable), §4 explicitly declines to
 * repeat that pattern here: `'auto_reject'` is not a member of this union, so it cannot round-trip
 * as an accepted value at all — `normalizeApprovalType` (ApprovalProductService.ts) rejects it (and
 * every other off-enum string) at the publish/authoring choke, satisfying "must NOT be reachable —
 * publish rejects it" without ever declaring a third, dormant option.
 */
export type ApprovalType = 'manual' | 'auto_approve'
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
 * P1-C node-level field permissions, widened by Lock-7B (docs/development/
 * approval-lock7b-required-at-node-20260820.md OD-L7B-1) with a FOURTH member, `required` (必填).
 *
 * `editable` (the absent default) === current behavior — a node without
 * `fieldPermissions` leaves every form field fully visible/editable, so every
 * pre-existing template and instance is byte-for-byte unchanged.
 *
 * `hidden` is enforced at runtime (server-side echo-redaction: a hidden field is stripped from the
 * `formSnapshot` echoed in read DTOs while the instance is AT the hiding node) and refuses a write
 * (Lock-7 P4-B). `readonly` also refuses a write at that node (Lock-7 P4-B). `required` is `editable`
 * PLUS a submit-time obligation (Lock-7B OD-L7B-1/§1.1): it is WRITABLE, never hides or redacts
 * anything, and a node marking a field `required` must see it non-empty in the effective snapshot by
 * the time the handler at that node submits (`APPROVAL_HANDLER_REQUIRED_FIELD_EMPTY`, Lock-7B §1.3).
 * A node's `fieldPermissions` assigns exactly ONE access per field (the `seen.has(fieldId)` dedup
 * guard below), so `required` × `hidden` at the SAME node is unrepresentable by construction
 * (OD-L7B-1) — masks are per node and independent, so `hidden` at one node and `required` at another
 * is legal (OD-L7B-2). `required` is satisfiable on HANDLER nodes only in v1 (OD-L7B-3): publish
 * rejects it on an approval node, on a routing-driver field, and on `explanation` / `record-link` /
 * `attachment` (OD-L7B-4/OD-L7B-9).
 *
 * MECHANISM FIX v5 (census C-1/C-2 conversion): `NodeFieldAccess` and `NODE_FIELD_ACCESS_VALUES`
 * used to be TWO independent hand-written literal lists — a type-level union here and a runtime Set a
 * few lines down — which the compiler checked in only ONE direction (every Set element is a valid
 * `NodeFieldAccess`) and never the other (every `NodeFieldAccess` member is present IN the Set); a
 * fifth member added to the type without updating the Set literal compiled cleanly. They are now BOTH
 * derived from the ONE tuple below, so that specific hand-sync risk is closed by construction, not
 * just by a test: there is exactly one place to add a fifth member, and the type and the Set follow
 * for free.
 */
const NODE_FIELD_ACCESS_MEMBERS = ['editable', 'readonly', 'hidden', 'required'] as const
export type NodeFieldAccess = (typeof NODE_FIELD_ACCESS_MEMBERS)[number]

/**
 * Lock-7B OD-L7B-10 — the ONE canonical enumeration of `NodeFieldAccess` members. Every consumer that
 * needs to test membership (publish admission, the `resolveFieldAccessAtNodes` read-axis filter, the
 * author-facing publish-rejection message) reads THIS Set rather than hand-copying the literal list —
 * a mechanical enumeration, never an appended `|| candidate === 'required'` arm (which reproduces the
 * identical silent-drop defect for a future fifth member). Exported from the same module as the type
 * (the source of truth) so `approval-form-redaction.ts` can import it without a circular dependency on
 * `ApprovalProductService.ts` (which imports FROM approval-form-redaction.ts, not the reverse).
 * DERIVED from `NODE_FIELD_ACCESS_MEMBERS` above (MECHANISM FIX v5), not an independent literal.
 */
export const NODE_FIELD_ACCESS_VALUES = new Set<NodeFieldAccess>(NODE_FIELD_ACCESS_MEMBERS)

/**
 * Lock-7B §2.2 — the WRITABLE subset of `NodeFieldAccess`: a field marked `editable` OR `required` at
 * its node accepts a handler write; `readonly`/`hidden` refuse one. DERIVED from
 * `NODE_FIELD_ACCESS_VALUES` (never an independent literal) so that removing a member from the
 * canonical enumeration also removes it from here — the write mask (`applyHandlerFieldWrites`) and the
 * publish driver pin (`validateFieldEditEnforcementPins` pin 1) both consume this ONE named set rather
 * than a second hand-maintained list (G-2's third arm: deleting `'required'` from
 * `NODE_FIELD_ACCESS_VALUES` must also close the write mask, not just the publish admission and the
 * read-axis resolver).
 */
export const NODE_FIELD_ACCESS_WRITABLE_VALUES = new Set<NodeFieldAccess>(
  (['editable', 'required'] as const).filter((value) => NODE_FIELD_ACCESS_VALUES.has(value)),
)

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
  /**
   * Lock-5 §1.6 L5-F / OD-L5-11(a) — a handler node admits a NARROWED `nodeOperationPolicy`:
   * `allowTransfer` and `commentRequired` only. `allowAddSign` / `allowReduceSign` / `allowReturn`
   * are rejected at the authoring choke with `APPROVAL_HANDLER_CONFIG_INVALID`, because Lock-3 §2.2
   * already 409s those verbs at a handler node — a switch over an impossible verb is M8 theater.
   * `allowTransfer` absent ≡ true replaces Lock-3's hardcoded transfer-allowed with NO behavior change.
   */
  nodeOperationPolicy?: Pick<NodeOperationPolicy, 'allowTransfer' | 'commentRequired'>
}

/** Lock-5 §1.6 — the `NodeOperationPolicy` sub-keys a `handler` node may carry (OD-L5-11(a)). */
export const HANDLER_NODE_OPERATION_POLICY_KEYS = ['allowTransfer', 'commentRequired'] as const

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
  // Lock-4 F4-A (OD-L4-1(a)) — 审批类型. Absent ≡ 'manual' ≡ today's behavior. Admitted ONLY on
  // `type:'approval'` (publish-time 400 elsewhere, ApprovalProductService.ts normalizeApprovalGraph)
  // and rejected inside a parallel region in v1 (APPROVAL_NODE_AUTO_TYPE_PARALLEL_UNSUPPORTED) — a
  // non-'manual' node MAY still be a condition-branch TARGET.
  approvalType?: ApprovalType
  emptyAssigneePolicy?: EmptyAssigneePolicy
  // Lock-4 §3 F4-B — ONLY meaningful when emptyAssigneePolicy === 'designated'; absent under any
  // other policy value (including absent policy, which stays byte-identical to today). See
  // EmptyAssigneeFallback's own doc comment for the "one key" / "one non-recursive step" quotes.
  emptyAssigneeFallback?: EmptyAssigneeFallback
  autoApprovalPolicy?: AutoApprovalPolicy
  // P1-C node-level field permissions. Default-absent === editable === current
  // behavior. `hidden`/`readonly` are enforced server-side (Lock-7 P4-B); `required`
  // is `editable` plus a submit-time obligation, enforced at handler submit
  // (Lock-7B). Orthogonal to FormFieldVisibilityRule (data-value-keyed);
  // fieldPermissions is node-keyed.
  fieldPermissions?: NodeFieldPermission[]
  // T1-1 node-level SLA: optional per-node timeout + effect (slice 1: remind only).
  timeout?: NodeTimeoutConfig
  // T3-3 node signature / compliance — slice 1: DECLARED-INERT. Persisted + round-tripped on the node
  // config but NOT enforced at runtime — approve/reject never blocks on a signature until enforcement is
  // separately ratified (mirrors the fieldPermissions readonly/auto_* declared-but-do-not-wire precedent).
  // Default-absent === no signature policy === current behavior (byte-stable).
  signaturePolicy?: SignaturePolicy
  // Lock-5 §1.1 L5-A (OD-L5-1(a)) — per-node 操作权限. ONE object, not six flat keys (§1.1's
  // four-allowlist arithmetic). Every field is absent-≡-today, so existing graphs are byte-stable
  // and no migration touches stored JSON; an all-absent object is OMITTED rather than persisted
  // as `{}`. Enforced server-side at the single dispatch choke (§2.1), never by the UI alone.
  nodeOperationPolicy?: NodeOperationPolicy
}

/**
 * Lock-5 §1.1 L5-A — the per-node member-action switches (`操作权限`), structurally modelled on
 * `SignaturePolicy`. Every field is ABSENT ≡ TODAY'S BEHAVIOR (OD-L5-3(a)): absent ≡ allowed for
 * the four verb switches, absent ≡ `'resume_forward'` for the return mode, absent ≡ the instance's
 * `policy_snapshot.rejectCommentRequired` for the comment requirement (OD-L5-8(a)).
 *
 * Enforcement status per field (M7/M8 — a switch whose runtime never refuses must NOT render):
 *   - `allowTransfer` / `allowAddSign` / `allowReduceSign` / `allowReturn`: ENFORCED at the §2.1
 *     dispatch choke in this slice; rendered in the `操作权限` tab.
 *   - `returnReviewMode`: schema-validated only. OD-L5-6(a) ships `'resume_forward'` (today's
 *     behavior) in v1 and defers `'jump_back_to_current'`; §1.2 states flatly that no
 *     `returnReviewMode` control renders. Declared here so an out-of-enum value FAILS publish
 *     (gate A-6) rather than round-tripping as an unknown key.
 *   - `commentRequired`: schema-validated only in this slice. Its enforcement moves BOTH shipped
 *     hardcodings at once (§1.3) and lands in its own slice; until then it renders no control.
 */
export interface NodeOperationPolicy {
  /** C-1 允许转交. Absent ≡ true. */
  allowTransfer?: boolean
  /** C-2 允许加签. Absent ≡ true. One authoring checkbox writes this AND `allowReduceSign` (OD-L5-2(a)). */
  allowAddSign?: boolean
  /** C-2 允许减签. Absent ≡ true. See `allowAddSign`. */
  allowReduceSign?: boolean
  /** C-7 允许回退. Absent ≡ true. */
  allowReturn?: boolean
  /** §1.2 / OD-L5-6(a). Absent ≡ 'resume_forward' (today's behavior). Declared-inert this slice. */
  returnReviewMode?: 'resume_forward' | 'jump_back_to_current'
  /** §1.3 / OD-L5-7(a). Absent ≡ the instance snapshot (≡ 'reject_only' today). Declared-inert this slice. */
  commentRequired?: 'never' | 'reject_only' | 'always'
}

/** The `NodeOperationPolicy` keys that gate a member ACTION VERB at the §2.1 dispatch choke. */
export type NodeOperationPolicyActionKey =
  | 'allowTransfer'
  | 'allowAddSign'
  | 'allowReduceSign'
  | 'allowReturn'

/**
 * Lock-5 §2.1 / gate A-1 — the single exported verb→policy-key table the dispatch choke iterates.
 * A `Record` over the FULL `ApprovalActionType` union (not a hand-written array of the gated four)
 * so adding a verb to `APPROVAL_ACTION_TYPES` without deciding its policy disposition is a
 * TypeScript error HERE, at the declaration — the convergent "table plus exhaustiveness" form,
 * not per-verb hand-written negatives.
 *
 * `null` = ungated BY DECISION, with the reason:
 *   - `approve` / `reject` / `comment`: never switchable — "a node whose approver may not decide is
 *     not an approval node" (§1.1 Scope).
 *   - `revoke`: keeps its TEMPLATE-level carrier `RuntimePolicy.allowRevoke` (409
 *     `APPROVAL_REVOKE_DISABLED`); moving it per-node would create a second precedence rule for one
 *     semantic (§1.1, the shape Lock-4 OD-L4-4 rejected).
 *   - `handle`: Lock-3's handler submit verb — a handler's completion action, not a member
 *     operation over someone else's seat; Lock-3 §2.2 already governs handler verb legality and
 *     §1.6 admits only `allowTransfer` (+ `commentRequired`) on a handler node.
 */
export const ACTION_POLICY_KEYS: Record<ApprovalActionType, NodeOperationPolicyActionKey | null> = {
  approve: null,
  reject: null,
  comment: null,
  revoke: null,
  handle: null,
  transfer: 'allowTransfer',
  add_sign: 'allowAddSign',
  reduce_sign: 'allowReduceSign',
  return: 'allowReturn',
}

/**
 * Lock-5 §1.4 / OD-L5-9(a) — the audit action written for a refused member operation. Deliberately
 * NOT a member of `APPROVAL_ACTION_TYPES`: it is never a dispatchable request action, and adding it
 * there would break gate A-1's exact-set partition and the attendance P26 pinned union. The
 * `approval_records.action` CHECK is already a strict SUPERSET of the dispatch union (it also
 * carries `created`/`sign`/`cc`/`remind`/`jump`/`reassign`), which is where this value lives.
 */
export const APPROVAL_POLICY_DENIED_ACTION = 'policy_denied' as const

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
  /**
   * Lock-1 §K1 — 用户组 (user group) approver, over `platform_member_groups`
   * (`zzzz20260409154000_create_platform_member_groups_and_delegated_group_scopes.ts:11-26`),
   * members in `platform_member_group_members` (`:31-37`). RATIFIED OD-L1-1(a) EAGER_EXPANSION:
   * every referenced group's member list is read ONCE at create and frozen into
   * `ApprovalRequesterSnapshot.groupMemberIds` (group id → ordered local user ids) — the resolver
   * expands purely from that frozen map, exactly like `managerChainIds`. A membership change
   * AFTER create does NOT reach an in-flight instance (the owner's actual trade vs. the shipped
   * `static_role` precedent — see the design lock's honesty note). `groupIds` is a non-empty
   * array; an EMPTY group resolves to EMPTY assignment and falls to `emptyAssigneePolicy` like an
   * unresolvable manager. A group id that does not exist, or is not bound to the publishing org
   * (RATIFIED OD-L1-2(a) curated per-org binding table, `approval_usable_member_groups`), is a
   * DIFFERENT case — rejected at PUBLISH (`assertUserGroupSourcesBoundToOrg`), never at dispatch.
   * Fingerprint: `user_group:<sorted groupIds joined by ','>` (§2.4). Cc-as-recipient (OD-L1-7,
   * widening `CcNodeConfig.targetType`) is a SEPARATE contract/registry row and is NOT part of
   * this shape — deferred to its own slice (§K1 "cc is a second contract, not a rider").
   */
  | { kind: 'user_group'; groupIds: string[] }
  /**
   * Lock-2 §L2-C — 表单内联系人上级 (C-3 联系人上级): the person chosen in a `user` form field is
   * the ANCHOR, and the source resolves that person's manager at chain position `level` (level 1 =
   * the chosen anchor's own direct manager) via the `leader_in_dept` LEADER pointer — the SAME
   * walk `resolveManagerChain` performs for the requester-anchored kinds, re-anchored on the
   * chosen contact. FIELD-anchored, not requester-anchored: mutating the REQUESTER's own org
   * relations never changes the resolution; mutating the CHOSEN contact's relations changes only
   * NEWLY created approvals (freeze-at-create).
   *
   * Freeze semantics (Lock-2 §0 Correction 2 — submit IS create): the chosen contact travels in
   * the create payload, so the create path resolves the extension AT CREATE from the directory and
   * freezes the resolved ids into `ApprovalRequesterSnapshot.fieldDerivedAssigneeIds`, keyed by
   * this source's fingerprint (`form_field_user_manager:<fieldId>:<level>`). The resolver reads
   * ONLY that frozen map — no live directory read at dispatch/return/admin-jump/timeout (§2.1).
   * `level` is validated `[1, MAX_MANAGER_CHAIN_LEVELS]` at normalize time; UPWARD only in v1
   * (the downward variant stays blocked on Lock-1 OD-L1-6, inherited not re-owned).
   * Publish pins (§L2-C): the referenced field must exist TOP-LEVEL, be `type: 'user'`,
   * `required: true`, carry NO `visibilityRule`, and not declare `selection: 'multi'` (OD-L2-7).
   * A value present but resolving to nobody (contact without a directory account, chain shorter
   * than `level`) is EMPTY resolution → `emptyAssigneePolicy` (§2.6); an empty referenced field is
   * the independent create-time 422 `APPROVAL_FORM_ROUTING_FIELD_EMPTY` (§2.2 door 2); a failed
   * directory read/misconfigured routing policy is the fail-closed create wedge (§2.3) — three
   * different things, never conflated. NO requester self-exclusion (deliberate, §L2-C: shipped
   * `dept_head`'s requester-exclusion is a requester-anchored artifact; same-person composes
   * through `autoApprovalPolicy.mergeWithRequester`).
   */
  | { kind: 'form_field_user_manager'; fieldId: string; level: number }
  /**
   * Lock-2 §L2-C — 表单内联系人部门负责人 (C-3 联系人部门负责人): the chosen contact's PRIMARY
   * department, then the department PARENT tree (`external_parent_department_id`), reading
   * `dept_manager_userid_list` per level — the SAME walk K4's `resolveDeptHeadChain` performs for
   * the requester, re-anchored on the chosen contact; level 1 = the chosen anchor's own listed
   * department head. Lock-1 §K4's RATIFIED continue-past-empty-level posture BINDS this walk (a
   * level whose manager list is empty or resolves to no linked local user contributes nothing and
   * the walk CONTINUES upward — the chain is DENSE, so `level` addresses the level-th *resolved*
   * head walking up, exactly as `dept_head_at_level` does over the requester's chain). A DIFFERENT
   * pointer from `form_field_user_manager` (leader pointer vs parent tree — the two coincide only
   * where every department's leader is also its listed manager). Everything else — freeze into
   * `fieldDerivedAssigneeIds` at create keyed by `form_field_user_dept_head:<fieldId>:<level>`,
   * publish pins, door-2 empty-field 422, fail-closed wedge, no requester self-exclusion, upward
   * only — is identical to the `form_field_user_manager` doc comment above.
   */
  | { kind: 'form_field_user_dept_head'; fieldId: string; level: number }

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
     * Lock-2 §2.6 (`form_field_user_manager` / `form_field_user_dept_head`): the configured chain
     * level this seat was resolved at, so "why is this person an approver" is answerable from the
     * row alone. Template-authored (values-free); rides beside the existing optional `fieldId`.
     */
    level?: number
    /**
     * Lock-1 §K3 (`prior_node_approver` only): the referenced prior node's key, so "why is this
     * person an approver" is answerable from the row alone (§2.6 — a template-authored node key,
     * values-free).
     */
    priorNodeKey?: string
    /**
     * Lock-1 §K1 (`user_group` only): the SPECIFIC group id this member was resolved from — a
     * `user_group` source may carry multiple `groupIds`, so the sourceIndex alone cannot answer
     * "which group". Template-authored id, values-free per §2.6 (never the group's membership).
     */
    groupId?: string
  }
  /**
   * Set when a delegation (委托) substituted this assignee: the original delegator's
   * id. The resolved `assigneeId` is already the delegatee; this is audit-trail only.
   */
  delegatedFrom?: string
  /**
   * Lock-4 F4-C — set when a same-person transfer (`autoApprovalPolicy.samePersonPolicy`)
   * substituted this assignee. `resolvedFrom.kind` (above) keeps the ORIGINATING source kind
   * unchanged (RATIFIED: "the transferred seat keeps the originating resolvedFrom.kind"); `from` is
   * the requester id the seat was transferred away from (audit-trail only — the resolved
   * `assigneeId` is already the manager/dept-head). Computed POST-delegation (after any
   * `delegatedFrom` substitution above), matching the shipped `mergeWithRequester` cascade's own
   * post-delegation comparison.
   */
  samePersonTransfer?: { from: string; policy: 'transfer_direct_manager' | 'transfer_dept_head' }
  /**
   * Lock-1 K6 — deterministic within-node queue position. All seats are persisted at activation,
   * but only `state: 'active'` is actionable; queued rows are promoted one at a time in the same
   * node-entry epoch. A fresh activation rebuilds the queue from position 1.
   */
  sequentialQueue?: {
    position: number
    length: number
    state: 'active' | 'queued' | 'completed'
  }
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
  /**
   * Lock-4 §2 F4-C (OD-L4-4(a)) — 审批人=提交人 (same-person) policy, a NODE-level enum INSIDE this
   * existing object (not a second vocabulary). Absent ≡ `'self_approve'` ≡ today's behavior when
   * `mergeWithRequester` is off.
   *
   * `'auto_skip'` mapping to the shipped flag (RATIFIED, verbatim): "`mergeWithRequester:true` IS
   * the 自动跳过 family… retained as the *implementation* of `'auto_skip'` and stays the persisted
   * carrier for that value, so no existing graph changes shape." `normalizeAutoApprovalPolicy`
   * (ApprovalProductService.ts) synthesizes `mergeWithRequester: true` whenever `samePersonPolicy ===
   * 'auto_skip'` is normalized, so `evaluateAutoApprovalAssignment`'s `mergeWithRequester` arm stays
   * UNCHANGED and produces byte-identical events (gate C-1) for either authored shape.
   *
   * `'transfer_direct_manager'` / `'transfer_dept_head'` resolve from the REQUESTER's frozen
   * `managerId` / `deptHeadId` snapshot (`ApprovalDirectoryOrg.ts`) — no live directory read at
   * dispatch (gate C-2). OD-L4-5(a): an absent transfer target means the seat is simply NOT
   * produced — `emptyAssigneePolicy` then governs, and it must NEVER fall back to `'self_approve'`
   * (gate C-3).
   */
  samePersonPolicy?: SamePersonPolicy
}

export type AutoApprovalActorMode = 'system' | 'original_approver'
export type AutoApprovalPolicySource = 'node' | 'template'
export type SamePersonPolicy = 'self_approve' | 'auto_skip' | 'transfer_direct_manager' | 'transfer_dept_head'
export type AutoApprovalMergeReason =
  | 'auto-merge-requester'
  | 'auto-merge-adjacent'
  | 'auto-dedupe-historical'
// Lock-4 F4-A — 'auto-node-approve' is a NEW reason added HERE (the wider reason union), not to
// `AutoApprovalMergeReason` (the narrower type `buildAutoApprovalEvent` is typed on, which drives
// the requester/adjacent/historical MERGE cascade only): the F4-A executor short-circuit pushes its
// event directly, bypassing that cascade entirely (it never runs `evaluateAutoApprovalAssignment`).
export type ApprovalAutoApprovalReason = 'empty-assignee' | 'auto-node-approve' | AutoApprovalMergeReason

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
  /**
   * Lock-1 §K1 (user_group, RATIFIED OD-L1-1(a) EAGER_EXPANSION) — the FROZEN member list of every
   * `user_group` group id the published runtime graph references, keyed by group id (ordered local
   * user ids, as read from `platform_member_group_members` at create). OPT-IN: populated only when
   * the graph actually uses a `user_group` source (`collectApprovalGraphMemberGroupIds`, mirroring
   * `includeManagerChain`'s posture — unrelated approvals pay nothing). The resolver reads ONLY
   * this map — no live `platform_member_group_members` read at dispatch/return/admin-jump/timeout —
   * so a membership change after create never reaches an in-flight instance; a group deleted after
   * publish simply freezes `[]` for that id (falls to `emptyAssigneePolicy`, never a dispatch-time
   * failure — the org/existence boundary is enforced only at publish). Purely additive; existing
   * snapshots omit it.
   */
  groupMemberIds?: Record<string, string[]>
  /**
   * Lock-2 §L2-C (form-field contact extensions) — the FROZEN field-derived resolution map:
   * source fingerprint (`form_field_user_manager:<fieldId>:<level>` /
   * `form_field_user_dept_head:<fieldId>:<level>`, see `fieldDerivedAssigneeSourceKey`) → resolved
   * local user ids, resolved AT CREATE from the person chosen in the referenced `user` form field
   * (submit IS create — Lock-2 §0 Correction 2) and never re-read afterwards. Keyed by fingerprint
   * so identical sources share ONE entry and the resolver stays a pure map lookup (§2.1 — no
   * resolver-internal database access; dispatch/return/admin-jump/timeout never touch the
   * directory). OPT-IN: present only when the published runtime graph carries such a source
   * (unrelated approvals pay nothing). An entry that is an EMPTY array means the create-time read
   * ran and resolved nobody (contact without a directory account, chain shorter than the
   * configured level) — EMPTY resolution falling to `emptyAssigneePolicy` (§2.6); a FAILED read
   * never reaches this map (the create wedge fails closed 422/503 before any insert, §2.3).
   */
  fieldDerivedAssigneeIds?: Record<string, string[]>
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
   * (`editable`/`required` write, Lock-7B §2.2; `readonly`/`hidden`/unknown/detail-sub-column refuse
   * values-free), validated
   * against the FROZEN version schema, then UPDATEs `form_snapshot` in place inside the handle
   * transaction plus append-only revision rows (OD-L7-6). `{}` is an accepted zero-write no-op;
   * `null` / a non-object is a values-free 400 `APPROVAL_FIELD_WRITE_PAYLOAD_INVALID`. Meaningful only
   * on `handle` — present on any other action it is a values-free 400. Detected by key PRESENCE.
   */
  fieldWrites?: unknown
  /**
   * Lock-9 OD-L9-10(a) — an OPTIONAL rider, not a verb: staged process-attachment ids to bind at
   * this action's commit (§5.4). Detected by key PRESENCE, same discipline as `fieldWrites`. v1
   * ships the `comment` rider only (the `handle`/`approve` riders are DEFERRED, not built here);
   * `dispatchAction` ignores this key entirely while `APPROVAL_ATTACHMENTS_ENABLED` is OFF (G-12).
   * NIT-1 (residual sweep): flag ON, a present value that is not an array of usable identifiers is
   * a values-free 400 `APPROVAL_ATTACHMENT_IDS_INVALID`, not a silent accept-and-drop; `[]` (or
   * `undefined`) stays a 200 no-op.
   */
  attachmentIds?: string[]
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
  /**
   * Lock-1 §K1 / OD-L1-2(a) — the curated NAMESPACE the publish request is validated against for
   * `approval_usable_member_groups`. NOT a tenant boundary and not identity-resolved: this
   * codebase has no `orgs` table and the kernel create path never resolves an actor's org, so the
   * caller states the namespace explicitly, exactly like every other `org_id`-scoped table here —
   * a caller MAY name any namespace (fix-round P2-b/ii correction: an earlier comment overclaimed
   * this as a per-caller boundary; it is not). The gate it scopes still guarantees every
   * referenced group has been explicitly curated — via `ensurePlatformAdmin`-gated bind — into AT
   * LEAST the named namespace; a group with zero curation anywhere can never be referenced.
   * Optional, mirroring the S7 §3.3 `orgId` idiom ("existing kernel callers that omit it keep
   * today's [default] behavior" — bracketed because S7's own callers default to UNSCOPED, not a
   * bucket; this slice is stricter: blank/absent normalizes to the repo-wide
   * `DEFAULT_ORG_ID = 'default'` bucket, matching `directory_integrations.org_id` /
   * `attendance_groups.org_id`'s own default, rather than an org-agnostic match). Ignored when the
   * graph carries no `user_group` source (no read, no gate).
   */
  orgId?: string | null
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
