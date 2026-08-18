import type {
  ApprovalAssigneeSourceKind,
  ApprovalNodeType,
  RenderedNodeOperationPolicyKey,
} from '../types/approval'
import { HANDLER_ASSIGNEE_SOURCE_KINDS } from '../types/approval'

/**
 * Lock-0 L0-2 — capability-registry-driven assignee roster + L0-1's `操作权限` tab-membership gate.
 * Source: docs/development/approval-lock0-d0-interaction-delta-20260817.md §1 L0-1/L0-2, §4 D1.
 *
 * The node inspector renders a new source, mode, policy, or action ONLY when its capability is
 * ratified, implemented end to end, and present in this registry for that node type (master M4,
 * quoted verbatim in the delta). The registry enumerates the COMPLETE currently shipped
 * `ApprovalAssigneeSourceKind` union so a persisted shipped source is never hidden as
 * "unratified" — it does not invent new kinds, and it does not omit shipped ones.
 *
 * Lock-5 §1.1/§2.5 (RATIFIED 2026-08-17) landed the first server-enforced per-node operation
 * policies, so `operationPoliciesByNodeType` is now populated for `approval` and `handler` and the
 * `操作权限` tab renders. That table is the L0-1 gate's data, and only capabilities whose server
 * enforcement has landed appear in it (master M7/M8, Lock-5 gate E-2).
 *
 * Labels use the RATIFIED parent-lock §10.3 wording (D1), which supersedes the incidental shipped
 * `APPROVAL_NODE_SOURCE_KINDS` el-select strings that used to live in
 * `ApprovalGraphNodeConfigEditor.vue` (e.g. shipped "指定用户"/"发起人"/"部门主管"/"表单用户字段" →
 * ratified "指定成员"/"发起人本人"/"部门负责人"/"表单中的成员字段"). This is a one-sided repair
 * toward the ratified contract, not a new label invention.
 */

/** §10.3 plain-label wording, keyed by the shipped `ApprovalAssigneeSourceKind` union. A `Record`
 *  over the full union (not a hand-maintained array) means dropping a shipped kind or adding an
 *  unshipped one is a TypeScript error at this declaration — the completeness/no-excess check the
 *  L0-2 "pinning test" acceptance gate (A-3) exists to also prove at runtime. */
export const APPROVAL_ASSIGNEE_SOURCE_LABELS: Record<ApprovalAssigneeSourceKind, string> = {
  static_user: '指定成员',
  static_role: '指定角色',
  requester: '发起人本人',
  form_field_user: '表单中的成员字段',
  direct_manager: '直属上级',
  dept_head: '部门负责人',
  continuous_managers: '连续多级上级',
  manager_at_level: '指定层级上级',
  // Lock-1 §K2 (RATIFIED 2026-08-17) — admitted in the SAME slice that lands the scope
  // validation + submit-time chooser end to end (registry table row: 提交人自选 / approval).
  requester_choice: '提交人自选',
  // Lock-1 §K4 (RATIFIED 2026-08-17) — admitted in the SAME slice that lands the
  // deptHeadChainIds snapshot + resolver arm end to end (registry table row:
  // 连续多级部门负责人 / approval).
  continuous_dept_heads: '连续多级部门负责人',
  // Lock-1 §K5-b (RATIFIED 2026-08-17) — admitted in the SAME slice that lands the resolver arm
  // end to end (registry table row: 指定层级部门负责人 / approval; "Admitted when: K4 landed").
  // NOT admitted on `handler` — Lock-3 §1.5's forward ADMIT row is a separate follow-up (see
  // HANDLER_ASSIGNEE_SOURCE_KINDS below, which deliberately does not include this kind).
  dept_head_at_level: '指定层级部门负责人',
  // Lock-1 §K3 (RATIFIED 2026-08-17) — admitted in the SAME slice that lands the dominance
  // validator + caller-supplied decider resolution end to end (registry table row: 节点审批人 /
  // approval; "Admitted when: OD-L1-3 + OD-L1-4 decided; dominance validator landed" — both ODs
  // are recorded (a) in the §4 ratification block). NOT admitted on `handler` (Lock-3 §1.5 lists
  // no forward row for this kind at all).
  prior_node_approver: '节点审批人',
  // Lock-1 §K1 (RATIFIED 2026-08-17) — admitted in the SAME slice that lands the resolver arm +
  // org binding + picker end to end (registry table row: 用户组 / approval; "Admitted when:
  // OD-L1-1 + OD-L1-2 decided; resolver, org binding, and picker landed" — both ODs are recorded
  // (a) in the §4 ratification block). NOT admitted on `handler` (see HANDLER_ASSIGNEE_SOURCE_KINDS
  // below). The cc-as-recipient row (OD-L1-7, §2.3 "a SEPARATE row — the approver row does not
  // admit it") is deferred to its own slice and is NOT added here.
  user_group: '用户组',
}

/** Display order matches parent §10.3's listed order. Kept as an explicit array (rather than
 *  `Object.keys(APPROVAL_ASSIGNEE_SOURCE_LABELS)`) so order is a deliberate, reviewable choice
 *  independent of object key insertion order. */
const SHIPPED_ASSIGNEE_SOURCE_KIND_ORDER: readonly ApprovalAssigneeSourceKind[] = [
  'static_user',
  'static_role',
  'requester',
  'form_field_user',
  'direct_manager',
  'dept_head',
  'continuous_managers',
  'manager_at_level',
  // Lock-1 §K2: ratified kinds append after the original eight-member §10.3 order.
  'requester_choice',
  // Lock-1 §K4: appended after K2.
  'continuous_dept_heads',
  // Lock-1 §K5-b: appended after K4 (strictly downstream of it).
  'dept_head_at_level',
  // Lock-1 §K3: appended after K5-b (ratified-kind append order).
  'prior_node_approver',
  // Lock-1 §K1: appended after K3 (ratified-kind append order).
  'user_group',
]

export interface ApprovalAssigneeSourceCapability {
  kind: ApprovalAssigneeSourceKind
  label: string
}

/** A ratified, server-enforced per-node operation policy (transfer / add-sign / reduce-sign /
 *  return).
 *
 *  Lock-5 §1.1 L5-A landed the first four (the §2.1 dispatch choke refuses a disabled operation
 *  409 `APPROVAL_NODE_OPERATION_DISABLED`), so `operationPoliciesByNodeType` below is no longer
 *  empty and the `操作权限` tab renders — this registry is what un-gates it (Lock-0 L0-1's table
 *  row, Lock-3 G-14's deferral, Lock-5 §2.5).
 *
 *  `policyKeys` is what makes the tab MECHANICALLY honest (master M7/M8, Lock-5 gate E-2): a
 *  control renders only because a registry entry names the `nodeOperationPolicy` key(s) it writes,
 *  and only keys whose server enforcement has landed appear in
 *  `RENDERED_NODE_OPERATION_POLICY_KEYS`. `returnReviewMode` and `commentRequired` are part of the
 *  persisted schema (publish validates them) but are NOT enforced yet, so no entry names them and
 *  no control can render for them — §1.2 ("no `returnReviewMode` control renders before OD-L4-10 is
 *  implemented or disclosed in copy") and §1.3 respectively.
 *
 *  A single entry may write MORE THAN ONE key: OD-L5-2(a) ratifies ONE 允许加/减签 checkbox writing
 *  BOTH `allowAddSign` and `allowReduceSign` (corpus C-2's single admin switch). */
export interface ApprovalOperationPolicyCapability {
  id: string
  label: string
  /** The `nodeOperationPolicy` keys this one control authors. Non-empty. */
  policyKeys: readonly RenderedNodeOperationPolicyKey[]
}

export interface ApprovalCapabilityRegistry {
  assigneeSourcesByNodeType: Partial<Record<ApprovalNodeType, ApprovalAssigneeSourceCapability[]>>
  operationPoliciesByNodeType: Partial<Record<ApprovalNodeType, ApprovalOperationPolicyCapability[]>>
}

/** Lock-5 §1.1 L5-A — the ratified, server-enforced `approval`-node operation policies, in the
 *  corpus §4.3 order (允许转交 1786-1789, 允许加/减签 1792-1797, 允许回退 1799-1803). Labels are the
 *  corpus's own admin wording, which is also the vocabulary the shipped member bar uses. */
const APPROVAL_OPERATION_POLICY_CAPABILITIES: ApprovalOperationPolicyCapability[] = [
  { id: 'transfer', label: '允许转交', policyKeys: ['allowTransfer'] },
  // OD-L5-2(a): ONE checkbox, TWO keys (corpus C-2 — one admin switch hiding BOTH member buttons).
  { id: 'add_reduce_sign', label: '允许加签/减签', policyKeys: ['allowAddSign', 'allowReduceSign'] },
  { id: 'return', label: '允许回退', policyKeys: ['allowReturn'] },
]

/** Lock-5 §1.6 L5-F / OD-L5-11(a) — a handler node admits `allowTransfer` only among the RENDERED
 *  keys (its other admitted key, `commentRequired`, has no landed enforcement so it renders
 *  nothing). Lock-3 §2.2 already 409s add_sign/reduce_sign/return at a handler node, so a switch
 *  over those verbs would be M8 theater; the backend rejects them at the authoring choke. */
const HANDLER_OPERATION_POLICY_CAPABILITIES: ApprovalOperationPolicyCapability[] = [
  { id: 'transfer', label: '允许转交', policyKeys: ['allowTransfer'] },
]

/** The shipped registry. Only `approval` and `handler` nodes have an assignee-source roster and an
 *  operation-policy roster; every other node type gets neither, and the backend rejects
 *  `nodeOperationPolicy` on them at the authoring choke (Lock-5 gate A-5). */
export const DEFAULT_APPROVAL_CAPABILITY_REGISTRY: ApprovalCapabilityRegistry = {
  assigneeSourcesByNodeType: {
    approval: SHIPPED_ASSIGNEE_SOURCE_KIND_ORDER.map((kind) => ({
      kind,
      label: APPROVAL_ASSIGNEE_SOURCE_LABELS[kind],
    })),
    // Lock-3 §1.5 / OD-L3-6(a) — the handler node's SEVEN-member roster (M4 per-node-type registry).
    // Reuses the ratified §10.3 labels; `continuous_managers`/`requester_choice`/etc. are absent (G-13
    // pins this exact set). Order follows HANDLER_ASSIGNEE_SOURCE_KINDS.
    handler: HANDLER_ASSIGNEE_SOURCE_KINDS.map((kind) => ({
      kind,
      label: APPROVAL_ASSIGNEE_SOURCE_LABELS[kind],
    })),
  },
  operationPoliciesByNodeType: {
    approval: APPROVAL_OPERATION_POLICY_CAPABILITIES,
    handler: HANDLER_OPERATION_POLICY_CAPABILITIES,
  },
}

/** The complete shipped `ApprovalAssigneeSourceKind` set, as a lookup — used to detect a persisted
 *  source kind that falls OUTSIDE the registry (A-4: unknown persisted value stays read-only and
 *  round-trips unchanged, never flattened to a registry default). */
export function assigneeSourceRoster(
  registry: ApprovalCapabilityRegistry,
  nodeType: ApprovalNodeType,
): ApprovalAssigneeSourceCapability[] {
  return registry.assigneeSourcesByNodeType[nodeType] ?? []
}

export function isRegisteredAssigneeSourceKind(
  registry: ApprovalCapabilityRegistry,
  nodeType: ApprovalNodeType,
  kind: string,
): kind is ApprovalAssigneeSourceKind {
  return assigneeSourceRoster(registry, nodeType).some((capability) => capability.kind === kind)
}

/** Drives the L0-1 `操作权限` tab-membership gate: the tab exists in the DOM only when the
 *  registry declares ≥1 ratified operation policy for the node type — mechanically, not by a
 *  hand-maintained flag. Since Lock-5 §1.1 landed, this is TRUE for `approval` and `handler` and
 *  false for every other node type; a test fixture with an empty
 *  `operationPoliciesByNodeType` still renders no third tab, which is the positive control both
 *  Lock-0 A-2 and Lock-5 E-1 require. */
export function hasRatifiedOperationPolicy(
  registry: ApprovalCapabilityRegistry,
  nodeType: ApprovalNodeType,
): boolean {
  return (registry.operationPoliciesByNodeType[nodeType]?.length ?? 0) > 0
}
