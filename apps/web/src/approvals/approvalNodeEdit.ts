import type {
  ApprovalAssigneeSource,
  ApprovalGraph,
  ApprovalMode,
  ApprovalNode,
  ApprovalNodeConfig,
  AutoApprovalPolicy,
  EmptyAssigneePolicy,
  NodeFieldPermission,
} from '../types/approval'
import { APPROVAL_ROLE_CONFIGURE_SENTINEL } from '../types/approval'

// Approval-node editing inside a preserved graph. The editor owns the fields already available in
// the linear authoring surface: approver source, approval/empty-assignee modes, requester-merge,
// and field permissions. Any other allowlisted config stays preserved verbatim. The node's edges
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

/** Optional fields preserve absence; `null` explicitly removes autoApprovalPolicy. */
export interface ApprovalNodeSourceEdit {
  nodeKey: string
  assigneeSources: ApprovalAssigneeSource[]
  approvalMode?: ApprovalMode
  emptyAssigneePolicy?: EmptyAssigneePolicy
  autoApprovalPolicy?: AutoApprovalPolicy | null
  fieldPermissions?: NodeFieldPermission[]
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
    edits[node.key] = {
      nodeKey: node.key,
      assigneeSources: cloneJson(node.config.assigneeSources),
      ...(node.config.approvalMode !== undefined ? { approvalMode: node.config.approvalMode } : {}),
      ...(node.config.emptyAssigneePolicy !== undefined ? { emptyAssigneePolicy: node.config.emptyAssigneePolicy } : {}),
      ...(node.config.autoApprovalPolicy !== undefined ? { autoApprovalPolicy: cloneJson(node.config.autoApprovalPolicy) } : {}),
      ...(node.config.fieldPermissions !== undefined ? { fieldPermissions: cloneJson(node.config.fieldPermissions) } : {}),
    }
  }
  return edits
}

/**
 * Apply the graph editor's owned fields while leaving every other node, edge, and config field
 * byte-identical. Optional fields only overwrite when present, preserving untouched absence.
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
    if (edit.approvalMode !== undefined) config.approvalMode = edit.approvalMode
    if (edit.emptyAssigneePolicy !== undefined) config.emptyAssigneePolicy = edit.emptyAssigneePolicy
    if (edit.autoApprovalPolicy === null) delete config.autoApprovalPolicy
    else if (edit.autoApprovalPolicy !== undefined) config.autoApprovalPolicy = cloneJson(edit.autoApprovalPolicy)
    if (edit.fieldPermissions !== undefined) {
      if (edit.fieldPermissions.length > 0) config.fieldPermissions = cloneJson(edit.fieldPermissions)
      else delete config.fieldPermissions
    }
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
    // PREVIEW only: integer ≥ 1. The backend additionally enforces a manager-chain level CAP
    // (MAX_MANAGER_CHAIN_LEVELS) which is NOT mirrored here — the UI input caps at 10 and the
    // backend `normalizeApprovalGraph` is the final arbiter on the ceiling.
    case 'continuous_managers':
      return Number.isInteger(source.levels) && source.levels >= 1
    case 'manager_at_level':
      return Number.isInteger(source.level) && source.level >= 1
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
    if (edit.approvalMode !== undefined && !(['single', 'all', 'any'] as const).includes(edit.approvalMode)) {
      errors.push(`审批节点 ${edit.nodeKey} 的审批模式无效`)
    }
    if (edit.emptyAssigneePolicy !== undefined && !(['error', 'auto-approve'] as const).includes(edit.emptyAssigneePolicy)) {
      errors.push(`审批节点 ${edit.nodeKey} 的空审批人策略无效`)
    }
    for (const permission of edit.fieldPermissions ?? []) {
      const fieldId = permission.fieldId.trim()
      if (!fieldId || (fields && !fields.some((field) => field.id.trim() === fieldId))) {
        errors.push(`审批节点 ${edit.nodeKey} 的字段权限引用了不存在的字段`)
      }
      if (!(['editable', 'readonly', 'hidden'] as const).includes(permission.access)) {
        errors.push(`审批节点 ${edit.nodeKey} 的字段权限类型无效`)
      }
    }
  }
  return errors
}

/**
 * B2-03 publish pre-flight: node keys whose FIRST assignee source is still the starter-preset
 * placeholder role (`APPROVAL_ROLE_CONFIGURE_SENTINEL`). The backend fail-fasts on this at PUBLISH
 * (`assertNoUnconfiguredPlaceholderRoles`, ApprovalProductService.ts) — this mirrors that check so
 * the publish-checklist can warn BEFORE the confirm instead of after a rejected request. Non-fatal
 * for save (mirrors the in-editor sentinel hint, which is also non-blocking).
 */
export function placeholderRoleNodeKeys(edits: ApprovalNodeEdits): string[] {
  return Object.values(edits)
    .filter((edit) => {
      const source = edit.assigneeSources[0]
      return source?.kind === 'static_role' && source.roleIds.includes(APPROVAL_ROLE_CONFIGURE_SENTINEL)
    })
    .map((edit) => edit.nodeKey)
}
