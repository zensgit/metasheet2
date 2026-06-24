import type {
  ApprovalAssigneeSource,
  ApprovalGraph,
  ApprovalNode,
  ApprovalNodeConfig,
} from '../types/approval'

// G-5 — approval-node editing inside a preserved complex graph. SCOPE: the approver SOURCE only
// (`assigneeSources`). `approvalMode` / `emptyAssigneePolicy` / `autoApprovalPolicy` / any other
// config key are PRESERVED verbatim, NOT yet editable (a later slice). The node's edges/position
// are TOPOLOGY — preserved byte-for-byte (G-1 anti-flatten floor). Every OTHER node/edge —
// condition (G-2), parallel (G-3), cc (G-4), start/end — is preserved verbatim. No .vue / Element
// Plus import, so this runs under the approval-web-guard vitest gate.
//
// PRE-CHECK FINDING (backend approval-node assignee rule, ApprovalProductService.ts):
//   - `validateApprovalAssigneeSourcesAgainstFormSchema` (:457-480): a `form_field_user` source's
//     `fieldId` MUST reference a TOP-LEVEL field of `type: 'user'` — detail sub-fields are
//     intentionally unresolvable (a sub-field has N row-values, ambiguous as a single approver).
//   - assignee source kinds: ApprovalAssigneeSource union (approval.ts:74-82).
// The editor + `validateApprovalNodeEdits` mirror this (backend `normalizeApprovalGraph` stays the
// sole arbiter; the preview never relaxes it).

/**
 * Editable model for one approval node — the approver `assigneeSources` array ONLY, keyed by node
 * `key`, seeded 1:1 from the preserved approval nodes' existing config. The node's place in the
 * graph (edges), its `approvalMode`, `emptyAssigneePolicy`, and `autoApprovalPolicy` are NOT carried
 * here (preserved verbatim by `applyApprovalNodeEditsToGraph`).
 */
export interface ApprovalNodeSourceEdit {
  nodeKey: string
  assigneeSources: ApprovalAssigneeSource[]
}

/** Map of approval-node source edits keyed by node key, seeded from a preserved graph. */
export type ApprovalNodeEdits = Record<string, ApprovalNodeSourceEdit>

// Deep clone for the preserved-graph pass-through — same rationale as ccEdit/parallelEdit/
// conditionEdit: pure JSON data, and a JSON round-trip works on the Vue reactive Proxy the draft
// is wrapped in.
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * True only for an approval node whose config carries an `assigneeSources` ARRAY. A legacy node
 * (`assigneeType`/`assigneeIds`, no `assigneeSources`) returns false, so it is never seeded and
 * `applyApprovalNodeEditsToGraph` clones it byte-identical (read-only-preserved, never flattened).
 */
function hasAssigneeSources(config: ApprovalNode['config']): config is ApprovalNodeConfig & { assigneeSources: ApprovalAssigneeSource[] } {
  return Boolean(config) && Array.isArray((config as ApprovalNodeConfig).assigneeSources)
}

/**
 * Seed the editable model from a (preserved) graph — one entry per `approval` node THAT HAS an
 * `assigneeSources` array, carrying a clone of it. Non-approval and legacy (no-`assigneeSources`)
 * nodes are skipped (preserved verbatim). Seeding is identity: an untouched edit reproduces the
 * original `assigneeSources`, so a round-trip is byte-identical (no spurious diff).
 */
export function approvalNodeEditsFromGraph(graph: ApprovalGraph | undefined): ApprovalNodeEdits {
  const edits: ApprovalNodeEdits = {}
  if (!graph) return edits
  for (const node of graph.nodes) {
    if (node.type !== 'approval' || !hasAssigneeSources(node.config)) continue
    edits[node.key] = { nodeKey: node.key, assigneeSources: cloneJson(node.config.assigneeSources) }
  }
  return edits
}

/**
 * Replace ONLY the `assigneeSources` of each edited approval node, leaving EVERY other node and ALL
 * edges byte-identical (deep-cloned so the input is never mutated). Spread-original-first keeps the
 * other config keys (`approvalMode` / `emptyAssigneePolicy` / `autoApprovalPolicy`) and byte-stable
 * key order, so an UNTOUCHED node reproduces its config exactly (the guard requires `assigneeSources`
 * already present, so the spread never adds a key). A legacy node (no `assigneeSources`) has no edit
 * and is cloned verbatim.
 *
 * Composition with G-2/G-3/G-4: approval / condition / parallel / cc are DISJOINT node types and
 * each pass deep-clones everything else, so composing the four lands all edits while every
 * non-targeted node/edge stays byte-identical.
 */
export function applyApprovalNodeEditsToGraph(graph: ApprovalGraph, edits: ApprovalNodeEdits): ApprovalGraph {
  const nodes: ApprovalNode[] = graph.nodes.map((node) => {
    if (node.type !== 'approval' || !hasAssigneeSources(node.config)) return cloneJson(node)
    const edit = edits[node.key]
    if (!edit) return cloneJson(node)
    const originalConfig = cloneJson(node.config)
    const config: ApprovalNodeConfig = { ...originalConfig, assigneeSources: cloneJson(edit.assigneeSources) }
    return { ...cloneJson(node), config }
  })
  return {
    nodes,
    edges: graph.edges.map((edge) => cloneJson(edge)),
  }
}

/** True when an assignee source is well-formed for its kind (mirrors what the backend accepts). */
function isAssigneeSourceValid(source: ApprovalAssigneeSource, topLevelUserFieldIds: Set<string> | null): boolean {
  switch (source.kind) {
    case 'static_user':
      return source.userIds.some((id) => id.trim().length > 0)
    case 'static_role':
      return source.roleIds.some((id) => id.trim().length > 0)
    case 'form_field_user':
      // backend: fieldId must reference a TOP-LEVEL `user` field (sub-fields unresolvable).
      if (source.fieldId.trim().length === 0) return false
      return topLevelUserFieldIds ? topLevelUserFieldIds.has(source.fieldId.trim()) : true
    case 'continuous_managers':
      return source.levels >= 1
    case 'manager_at_level':
      return source.level >= 1
    case 'requester':
    case 'direct_manager':
    case 'dept_head':
      return true
    default:
      return false
  }
}

/**
 * FE validation PREVIEW for approval-node source edits (UX only — the backend
 * `normalizeApprovalGraph` + `validateApprovalAssigneeSourcesAgainstFormSchema` stay the sole
 * arbiter). Each edited node needs at least one assignee source, every source must be well-formed,
 * and a `form_field_user` source must reference a top-level `user` field (when `fields` is given).
 */
export function validateApprovalNodeEdits(
  edits: ApprovalNodeEdits,
  fields?: Array<{ id: string; type: string }>,
): string[] {
  const errors: string[] = []
  const topLevelUserFieldIds = fields
    ? new Set(fields.filter((f) => f.type === 'user').map((f) => f.id.trim()))
    : null
  for (const edit of Object.values(edits)) {
    if (edit.assigneeSources.length === 0) {
      errors.push(`审批节点 ${edit.nodeKey} 至少需要一个审批人来源`)
      continue
    }
    for (const source of edit.assigneeSources) {
      if (!isAssigneeSourceValid(source, topLevelUserFieldIds)) {
        if (source.kind === 'form_field_user') {
          errors.push(`审批节点 ${edit.nodeKey} 的表单字段审批人必须引用顶层用户字段`)
        } else {
          errors.push(`审批节点 ${edit.nodeKey} 的审批人来源（${source.kind}）配置无效`)
        }
      }
    }
  }
  return errors
}
