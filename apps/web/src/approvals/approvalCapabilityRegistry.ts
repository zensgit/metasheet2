import type { ApprovalAssigneeSourceKind, ApprovalNodeType } from '../types/approval'
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
]

export interface ApprovalAssigneeSourceCapability {
  kind: ApprovalAssigneeSourceKind
  label: string
}

/** A ratified, server-enforced per-node operation policy (transfer / add-sign / reduce-sign /
 *  return). NONE are shipped at this baseline — Lock-5 has not landed ≥1 functional
 *  server-enforced per-node policy (L0-1 table gate). This type exists so a FUTURE registry
 *  entry — and today's A-1/A-2 positive-control test fixture — has a real shape to declare
 *  against, without this slice authorizing any runtime capability. */
export interface ApprovalOperationPolicyCapability {
  id: string
  label: string
}

export interface ApprovalCapabilityRegistry {
  assigneeSourcesByNodeType: Partial<Record<ApprovalNodeType, ApprovalAssigneeSourceCapability[]>>
  operationPoliciesByNodeType: Partial<Record<ApprovalNodeType, ApprovalOperationPolicyCapability[]>>
}

/** The shipped registry. Only `approval` nodes have an assignee-source roster (no other node type
 *  has assignee sources at all). `operationPoliciesByNodeType` is intentionally empty everywhere —
 *  changing that is a Lock-5 runtime authorization, never a presentation-slice edit. */
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
  operationPoliciesByNodeType: {},
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
 *  registry declares ≥1 ratified operation policy for the node type. At the shipped baseline this
 *  is always false, so the tab never renders — mechanically, not by a hand-maintained flag. */
export function hasRatifiedOperationPolicy(
  registry: ApprovalCapabilityRegistry,
  nodeType: ApprovalNodeType,
): boolean {
  return (registry.operationPoliciesByNodeType[nodeType]?.length ?? 0) > 0
}
