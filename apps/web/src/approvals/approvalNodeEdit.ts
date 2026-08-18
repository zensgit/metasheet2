import type {
  ApprovalAssigneeSource,
  ApprovalGraph,
  ApprovalMode,
  ApprovalNode,
  ApprovalNodeConfig,
  AutoApprovalPolicy,
  EmptyAssigneePolicy,
  HandlerMode,
  HandlerNodeConfig,
  NodeFieldPermission,
  NodeTimeoutConfig,
  NodeOperationPolicy,
} from '../types/approval'
import {
  APPROVAL_ROLE_CONFIGURE_SENTINEL,
  HANDLER_ASSIGNEE_SOURCE_KINDS,
  NODE_TIMEOUT_MAX_AFTER_MINUTES,
  NODE_TIMEOUT_SUPPORTED_EFFECTS,
} from '../types/approval'
import { runtimeSuccessorTargets } from './parallelEdit'

const NODE_TIMEOUT_SUPPORTED_EFFECT_SET = new Set<string>(NODE_TIMEOUT_SUPPORTED_EFFECTS)

const HANDLER_ASSIGNEE_SOURCE_KIND_SET = new Set<string>(HANDLER_ASSIGNEE_SOURCE_KINDS)

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

/**
 * Optional fields preserve absence; `null` explicitly removes autoApprovalPolicy.
 *
 * Lock-3: the SAME edit model carries `handler` nodes (`nodeType: 'handler'`) — they share
 * `assigneeSources` + `fieldPermissions` with approval nodes and reuse the exact same source helpers.
 * A handler NEVER carries `approvalMode`/`emptyAssigneePolicy`/`autoApprovalPolicy` (§1.2 rejects them);
 * it carries `handlerMode`/`opinionRequired` instead. `nodeType` (absent ≡ 'approval', back-compat)
 * lets validate() + the rebuild apply the right per-type rules.
 */
export interface ApprovalNodeSourceEdit {
  nodeKey: string
  nodeType?: 'approval' | 'handler'
  assigneeSources: ApprovalAssigneeSource[]
  approvalMode?: ApprovalMode
  // P1-C (T2-4 N-of-M). Meaningful only when `approvalMode === 'threshold'` — `applyApprovalNodeEditsToGraph`
  // emits it ONLY in that case (mirrors the backend's own conditional emission), so an author switching
  // mode away can never leave an orphaned threshold on the saved graph. approval-node-only (never on a
  // handler edit — §1.2 forbids the key there).
  approvalThreshold?: number
  emptyAssigneePolicy?: EmptyAssigneePolicy
  autoApprovalPolicy?: AutoApprovalPolicy | null
  fieldPermissions?: NodeFieldPermission[]
  // Lock-3 §1.1 — handler-only. `handlerMode` absent ≡ 'all'; `opinionRequired` absent ≡ false.
  handlerMode?: HandlerMode
  opinionRequired?: boolean
  // P1-C (T1-1) node-level SLA timeout — approval-node-only (§1.2 forbids `timeout` on a handler).
  // `undefined` = untouched (the seeded/preserved value, if any); `null` = explicitly cleared by the
  // author (mirrors the `autoApprovalPolicy` null-clears-it convention); a `NodeTimeoutConfig` value =
  // author-set/edited.
  timeout?: NodeTimeoutConfig | null
  /**
   * Lock-5 §1.1 L5-A — the per-node 操作权限 object, authored by the inspector's third tab.
   * Carried for BOTH node types (a handler admits the narrowed `allowTransfer`/`commentRequired`
   * set, §1.6). Absent ≡ untouched (the config's own value survives); `null` ≡ the author turned
   * every switch back to its default, so the key is REMOVED — the same absent/`null` grammar
   * `autoApprovalPolicy` already uses here, and what makes gate A-6's "authoring all-default
   * switches leaves the persisted config byte-identical" hold end to end.
   */
  nodeOperationPolicy?: NodeOperationPolicy | null
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
    if (!hasAssigneeSources(node.config)) continue
    if (node.type === 'approval') {
      // `nodeType` is deliberately OMITTED for approval edits — absent ≡ 'approval', keeping the
      // approval seed byte-identical to before this slice (no round-trip churn). Only handler edits
      // carry the discriminator (validate() reads it; the rebuild keys on the graph node's own type).
      edits[node.key] = {
        nodeKey: node.key,
        assigneeSources: cloneJson(node.config.assigneeSources),
        ...(node.config.approvalMode !== undefined ? { approvalMode: node.config.approvalMode } : {}),
        ...(node.config.approvalThreshold !== undefined ? { approvalThreshold: node.config.approvalThreshold } : {}),
        ...(node.config.emptyAssigneePolicy !== undefined ? { emptyAssigneePolicy: node.config.emptyAssigneePolicy } : {}),
        ...(node.config.autoApprovalPolicy !== undefined ? { autoApprovalPolicy: cloneJson(node.config.autoApprovalPolicy) } : {}),
        ...(node.config.fieldPermissions !== undefined ? { fieldPermissions: cloneJson(node.config.fieldPermissions) } : {}),
        ...(node.config.timeout !== undefined ? { timeout: cloneJson(node.config.timeout) } : {}),
        // Lock-5 §1.1: seeding is IDENTITY — an untouched edit reproduces the persisted object
        // byte-for-byte (including a mixed add/reduce pair the tab renders read-only, A-7).
        ...(node.config.nodeOperationPolicy !== undefined
          ? { nodeOperationPolicy: cloneJson(node.config.nodeOperationPolicy) }
          : {}),
      }
    } else if (node.type === 'handler') {
      // Lock-3 §1.1 — seed the handler edit with its own fields only (never approval-node keys).
      const handlerConfig = node.config as unknown as HandlerNodeConfig
      edits[node.key] = {
        nodeKey: node.key,
        nodeType: 'handler',
        assigneeSources: cloneJson(handlerConfig.assigneeSources),
        ...(handlerConfig.handlerMode !== undefined ? { handlerMode: handlerConfig.handlerMode } : {}),
        ...(handlerConfig.opinionRequired !== undefined ? { opinionRequired: handlerConfig.opinionRequired } : {}),
        ...(handlerConfig.fieldPermissions !== undefined ? { fieldPermissions: cloneJson(handlerConfig.fieldPermissions) } : {}),
        // Lock-5 §1.6: a handler carries the narrowed policy; seeding is identity here too.
        ...(handlerConfig.nodeOperationPolicy !== undefined
          ? { nodeOperationPolicy: cloneJson(handlerConfig.nodeOperationPolicy) as NodeOperationPolicy }
          : {}),
      }
    }
  }
  return edits
}

/**
 * P1-B: append one new assignee-source card to a node's edit, in place. `defaultSource` is
 * caller-supplied (the config editor derives it from the L0-2 capability registry roster for the
 * node's TYPE, never a hand-picked kind — a `handler` node's roster differs from `approval`'s). No
 * dedup, no reorder: the runtime resolver owns the union + identity dedup (master §P1-B item 4 /
 * M5) — this only appends to the array. No-op when the node is not in `edits`.
 */
export function addAssigneeSourceCard(
  edits: ApprovalNodeEdits,
  nodeKey: string,
  defaultSource: ApprovalAssigneeSource,
): void {
  const edit = edits[nodeKey]
  if (!edit) return
  edit.assigneeSources = [...edit.assigneeSources, cloneJson(defaultSource)]
}

/**
 * P1-B fail-closed: a node must always keep ≥1 assignee source. Refuses (no-op) when the node has
 * exactly one source, REGARDLESS of any caller-side disabled-button UX — a native `disabled`
 * button element cannot even dispatch a click event, so the browser-level guard alone is
 * untestable/unenforceable independent of this function; THIS is the actual invariant enforcement
 * point (master §P1-B). Also a no-op for a missing node or an out-of-range index.
 */
export function removeAssigneeSourceCard(
  edits: ApprovalNodeEdits,
  nodeKey: string,
  sourceIndex: number,
): void {
  const edit = edits[nodeKey]
  if (!edit) return
  if (edit.assigneeSources.length <= 1) return
  if (sourceIndex < 0 || sourceIndex >= edit.assigneeSources.length) return
  edit.assigneeSources = edit.assigneeSources.filter((_, index) => index !== sourceIndex)
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
    if (!hasAssigneeSources(node.config)) return cloneJson(node)
    const edit = edits[node.key]
    if (!edit) return cloneJson(node)
    if (node.type === 'handler') {
      // Lock-3 §1.1 — rebuild a handler with its OWN keys ONLY. Preserve any other (allowlisted)
      // config verbatim, but NEVER emit approval-node keys (§1.2 rejects them). Empty fieldPermissions
      // are dropped (byte-stable absence).
      const originalConfig = cloneJson(node.config) as unknown as Record<string, unknown>
      const config: Record<string, unknown> = { ...originalConfig, assigneeSources: cloneJson(edit.assigneeSources) }
      if (edit.handlerMode !== undefined) config.handlerMode = edit.handlerMode
      else delete config.handlerMode
      if (edit.opinionRequired !== undefined) config.opinionRequired = edit.opinionRequired
      else delete config.opinionRequired
      if (edit.fieldPermissions !== undefined && edit.fieldPermissions.length > 0) config.fieldPermissions = cloneJson(edit.fieldPermissions)
      else delete config.fieldPermissions
      // Lock-5 §1.1/§1.6 — `null` removes the key (every switch back to default), absent leaves the
      // persisted value untouched.
      if (edit.nodeOperationPolicy === null) delete config.nodeOperationPolicy
      else if (edit.nodeOperationPolicy !== undefined) config.nodeOperationPolicy = cloneJson(edit.nodeOperationPolicy)
      return { ...cloneJson(node), config } as ApprovalNode
    }
    if (node.type !== 'approval') return cloneJson(node)
    const originalConfig = cloneJson(node.config)
    const config: ApprovalNodeConfig = { ...originalConfig, assigneeSources: cloneJson(edit.assigneeSources) }
    if (edit.approvalMode !== undefined) config.approvalMode = edit.approvalMode
    // P1-C: `approvalThreshold` rides ONLY with an effective mode of 'threshold' — mirrors the
    // backend's own conditional emission. An author switching mode away (or a stale edit carrying a
    // threshold under a different mode) must not leave an orphaned key on the saved graph; switching
    // TO 'threshold' without yet entering N stays incomplete here (caught by
    // `validateApprovalNodeEdits`/publish), never silently defaulted.
    if (config.approvalMode === 'threshold') {
      if (edit.approvalThreshold !== undefined) config.approvalThreshold = edit.approvalThreshold
    } else {
      delete config.approvalThreshold
    }
    if (edit.emptyAssigneePolicy !== undefined) config.emptyAssigneePolicy = edit.emptyAssigneePolicy
    if (edit.autoApprovalPolicy === null) delete config.autoApprovalPolicy
    else if (edit.autoApprovalPolicy !== undefined) config.autoApprovalPolicy = cloneJson(edit.autoApprovalPolicy)
    if (edit.fieldPermissions !== undefined) {
      if (edit.fieldPermissions.length > 0) config.fieldPermissions = cloneJson(edit.fieldPermissions)
      else delete config.fieldPermissions
    }
    // P1-C: `null` explicitly clears a preserved timeout (mirrors the `autoApprovalPolicy` convention);
    // `undefined` leaves whatever `originalConfig` carried (already spread in) untouched.
    if (edit.timeout === null) delete config.timeout
    else if (edit.timeout !== undefined) config.timeout = cloneJson(edit.timeout)
    // Lock-5 §1.1 — see the handler arm above for the absent/`null` grammar.
    if (edit.nodeOperationPolicy === null) delete config.nodeOperationPolicy
    else if (edit.nodeOperationPolicy !== undefined) config.nodeOperationPolicy = cloneJson(edit.nodeOperationPolicy)
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
    // Lock-1 §K4 PREVIEW: same shape/cap posture as continuous_managers (backend
    // normalizeApprovalAssigneeSources stays the arbiter on the ceiling).
    case 'continuous_dept_heads':
      return Number.isInteger(source.levels) && source.levels >= 1
    // Lock-1 §K5-b PREVIEW: same shape/cap posture as manager_at_level (backend
    // normalizeApprovalAssigneeSources stays the arbiter on the ceiling).
    case 'dept_head_at_level':
      return Number.isInteger(source.level) && source.level >= 1
    // Lock-1 §K3 PREVIEW: a non-empty referenced node key. Whether the reference is legal
    // (an approval node strictly upstream on every runtime-reachable path) is the backend
    // PUBLISH gate's job (`assertPriorNodeApproverReferencesUpstream`); the FE picker only
    // OFFERS legal candidates (`legalPriorApproverNodeKeys` below), so this shape check plus
    // the picker keep authoring honest without relaxing the backend arbiter.
    case 'prior_node_approver':
      return source.nodeKey.trim().length > 0
    case 'requester_choice':
      // Lock-1 §K2 PREVIEW (backend normalizeApprovalAssigneeSources stays the arbiter):
      // mode + scope discriminator, and a members/role scope needs ≥1 configured id.
      if (source.mode !== 'single' && source.mode !== 'multi') return false
      if (source.scope.type === 'company') return true
      if (source.scope.type === 'members') return source.scope.userIds.some((id) => id.trim().length > 0)
      if (source.scope.type === 'role') return source.scope.roleIds.some((id) => id.trim().length > 0)
      return false
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
 *
 * P1-C: `parallelRegionNodeKeys` (from `collectParallelRegionNodeKeys` in templateAuthoring.ts) is the
 * linear-only fail-closed gate for `approvalMode: 'threshold'` and `timeout` — both are backend-
 * rejected inside a parallel region (`APPROVAL_THRESHOLD_IN_PARALLEL` /
 * `APPROVAL_NODE_TIMEOUT_PARALLEL_UNSUPPORTED`). Optional so existing callers/tests that don't touch
 * threshold/timeout are unaffected; omitting it treats every node as outside a parallel region (the
 * caller — `validateTemplateApprovalFlow` — always supplies the real set for the live app).
 *
 * `approvalNodeKeys` (fix-round follow-up, gate P2-1): the set of the preserved graph's `approval`-
 * type node keys, mirroring backend `timeout.jumpToNodeKey references unknown node` /
 * `must target an approval node` (ApprovalProductService.ts :1809-1813) — a SINGLE membership test
 * covers both since only `approval`-typed keys are in the set. Without this a jump target that a
 * complex-graph edit (e.g. `removeLinearNode` deleting the target node) leaves dangling passed FE
 * validation and reached the backend as a raw 400 instead of the linear editor's inline preview
 * error. Optional for the same backward-compat reason as `parallelRegionNodeKeys`; the real caller
 * always supplies it.
 */
export function validateApprovalNodeEdits(
  edits: ApprovalNodeEdits,
  fields?: Array<{ id: string; type: string }>,
  parallelRegionNodeKeys?: Set<string>,
  approvalNodeKeys?: Set<string>,
): string[] {
  const errors: string[] = []
  const topLevelUserFieldIds = fields
    ? new Set(fields.filter((f) => f.type === 'user').map((f) => f.id.trim()))
    : null
  for (const edit of Object.values(edits)) {
    const isHandler = edit.nodeType === 'handler'
    const nodeLabel = isHandler ? '办理节点' : '审批节点'
    const sourceLabel = isHandler ? '办理人来源' : '审批人来源'
    if (edit.assigneeSources.length === 0) {
      errors.push(`${nodeLabel} ${edit.nodeKey} 至少需要一个${sourceLabel}`)
      continue
    }
    for (const source of edit.assigneeSources) {
      // Lock-3 §1.5 / G-13: a handler admits ONLY the seven-member registry kinds (backend
      // APPROVAL_HANDLER_SOURCE_KIND_UNSUPPORTED). Mirror it in the FE preview.
      if (isHandler && !HANDLER_ASSIGNEE_SOURCE_KIND_SET.has(source.kind)) {
        errors.push(`${nodeLabel} ${edit.nodeKey} 的办理人来源（${source.kind}）不支持`)
        continue
      }
      if (!isAssigneeSourceValid(source, topLevelUserFieldIds)) {
        if (source.kind === 'form_field_user') {
          errors.push(`${nodeLabel} ${edit.nodeKey} 的表单字段${isHandler ? '办理人' : '审批人'}必须引用顶层用户字段`)
        } else {
          errors.push(`${nodeLabel} ${edit.nodeKey} 的${sourceLabel}（${source.kind}）配置无效`)
        }
      }
    }
    if (isHandler) {
      // Lock-3 §1.1: handlerMode ∈ {'all','any'}; handler edits never carry approval-node keys.
      if (edit.handlerMode !== undefined && !(['all', 'any'] as const).includes(edit.handlerMode)) {
        errors.push(`办理节点 ${edit.nodeKey} 的办理模式无效`)
      }
      // Fix-round follow-up (gate P2-2's handler/nodeType note): mirrors backend
      // `APPROVAL_HANDLER_CONFIG_INVALID` (ApprovalProductService.ts :2449) — `timeout`/
      // `approvalThreshold` are approval-node-only and REJECTED outright on a handler config.
      // `applyApprovalNodeEditsToGraph`'s handler branch never reads either field for a handler node
      // today, so a stray value here cannot yet reach a real save payload — but nothing on the EDIT
      // MODEL itself enforced the invariant `ApprovalNodeSourceEdit`'s own doc comment claims, so a
      // stray value (e.g. a future setter call without a nodeType check) would silently pass this
      // preview rather than failing it. Belt on the door this function owns, not a new setter guard.
      if (edit.timeout !== undefined && edit.timeout !== null) {
        errors.push(`办理节点 ${edit.nodeKey} 不支持节点超时`)
      }
      if (edit.approvalThreshold !== undefined) {
        errors.push(`办理节点 ${edit.nodeKey} 不支持门槛会签人数`)
      }
    } else {
      if (edit.approvalMode !== undefined && !(['single', 'all', 'any', 'threshold'] as const).includes(edit.approvalMode)) {
        errors.push(`审批节点 ${edit.nodeKey} 的审批模式无效`)
      }
      if (edit.emptyAssigneePolicy !== undefined && !(['error', 'auto-approve'] as const).includes(edit.emptyAssigneePolicy)) {
        errors.push(`审批节点 ${edit.nodeKey} 的空审批人策略无效`)
      }
      const inParallelRegion = parallelRegionNodeKeys?.has(edit.nodeKey) ?? false
      // P1-C (T2-4): linear-only fail-closed — mirrors `APPROVAL_THRESHOLD_IN_PARALLEL`. The mode
      // picker must not OFFER 'threshold' inside a parallel region (rendering layer); this is the
      // defense-in-depth floor for a caller that bypassed that (e.g. a programmatic edit).
      if (edit.approvalMode === 'threshold' && inParallelRegion) {
        errors.push(`审批节点 ${edit.nodeKey} 位于并行分支内，不支持门槛会签（v1 仅支持线性路径）`)
      } else if (edit.approvalMode === 'threshold') {
        if (!Number.isInteger(edit.approvalThreshold) || (edit.approvalThreshold as number) < 1) {
          errors.push(`审批节点 ${edit.nodeKey} 的门槛会签人数必须是不小于 1 的整数`)
        }
        // No static N<=M bound here for the SAME reason as the linear preview: this editor always
        // emits `assigneeSources` (never the legacy shape the backend's static bound is scoped to),
        // so M is always resolved at runtime — do not invent a stricter client check (M8).
      }
      if (edit.timeout !== undefined && edit.timeout !== null) {
        const timeout = edit.timeout
        if (inParallelRegion) {
          errors.push(`审批节点 ${edit.nodeKey} 位于并行分支内，不支持节点超时（v1 仅支持线性路径）`)
        } else {
          if (
            !Number.isInteger(timeout.afterMinutes)
            || timeout.afterMinutes <= 0
            || timeout.afterMinutes > NODE_TIMEOUT_MAX_AFTER_MINUTES
          ) {
            errors.push(`审批节点 ${edit.nodeKey} 的超时时长需为 1–${NODE_TIMEOUT_MAX_AFTER_MINUTES} 分钟之间的整数`)
          }
          if (!NODE_TIMEOUT_SUPPORTED_EFFECT_SET.has(timeout.effect)) {
            errors.push(`审批节点 ${edit.nodeKey} 的超时处理方式暂不支持`)
          } else if (timeout.effect === 'transfer' && !timeout.transferToUserId?.trim()) {
            errors.push(`审批节点 ${edit.nodeKey} 的超时转交需要选择接收人`)
          } else if (timeout.effect === 'jump') {
            const jumpTarget = timeout.jumpToNodeKey?.trim()
            if (!jumpTarget) {
              errors.push(`审批节点 ${edit.nodeKey} 的超时跳转需要选择目标审批节点`)
            } else if (jumpTarget === edit.nodeKey) {
              errors.push(`审批节点 ${edit.nodeKey} 的超时跳转不能指向自身`)
            } else if (approvalNodeKeys && !approvalNodeKeys.has(jumpTarget)) {
              // Mirrors the linear editor's `…的超时跳转目标节点不存在` (templateAuthoring.ts) — one
              // message for both "no such node" and "exists but isn't an approval node", same as the
              // linear path (whose candidates are always approval steps, so it never needed to
              // distinguish the two).
              errors.push(`审批节点 ${edit.nodeKey} 的超时跳转目标节点不存在`)
            } else if (parallelRegionNodeKeys?.has(jumpTarget)) {
              errors.push(`审批节点 ${edit.nodeKey} 的超时跳转目标节点位于并行分支内，不受支持`)
            }
          }
        }
      }
    }
    for (const permission of edit.fieldPermissions ?? []) {
      const fieldId = permission.fieldId.trim()
      if (!fieldId || (fields && !fields.some((field) => field.id.trim() === fieldId))) {
        errors.push(`${nodeLabel} ${edit.nodeKey} 的字段权限引用了不存在的字段`)
      }
      if (!(['editable', 'readonly', 'hidden'] as const).includes(permission.access)) {
        errors.push(`${nodeLabel} ${edit.nodeKey} 的字段权限类型无效`)
      }
    }
  }
  return errors
}

/**
 * Lock-1 §K3 — the node keys a `prior_node_approver` source on `nodeKey`'s card may legally
 * reference: `approval` nodes STRICTLY UPSTREAM on EVERY runtime-reachable path from the start
 * node to the carrying node. FE mirror of the backend publish gate
 * (`assertPriorNodeApproverReferencesUpstream`, ApprovalProductService.ts — the sole arbiter;
 * this never relaxes it): T is offered ⟺ T is an approval node, T ≠ carrier, and removing T
 * makes the carrier unreachable from start over `runtimeSuccessorTargets` (strict dominance by
 * removal-reachability — the same conservative parallel posture: a node inside one parallel
 * branch is never offered past the join or to a sibling branch, and a node reachable only
 * through one condition branch is never offered after the merge). Drives the typed node PICKER
 * (D0 §10.2 — never a free-text key input); order follows the graph's node-declaration order.
 */
export function legalPriorApproverNodeKeys(graph: ApprovalGraph, nodeKey: string): string[] {
  const edgeByKey = new Map(graph.edges.map((edge) => [edge.key, edge]))
  const outgoingBySource = new Map<string, ApprovalGraph['edges']>()
  for (const edge of graph.edges) {
    const existing = outgoingBySource.get(edge.source)
    if (existing) existing.push(edge)
    else outgoingBySource.set(edge.source, [edge])
  }
  const nodeByKey = new Map(graph.nodes.map((node) => [node.key, node]))
  const startKey = graph.nodes.find((node) => node.type === 'start')?.key ?? null
  if (startKey === null) return []

  const reachableWithout = (skipKey: string | null): Set<string> => {
    const visited = new Set<string>()
    if (startKey === skipKey) return visited
    const queue: string[] = [startKey]
    for (let head = 0; head < queue.length; head += 1) {
      const currentKey = queue[head]
      if (currentKey === skipKey || visited.has(currentKey)) continue
      visited.add(currentKey)
      const current = nodeByKey.get(currentKey)
      if (!current) continue
      for (const target of runtimeSuccessorTargets(current, edgeByKey, outgoingBySource)) {
        queue.push(target)
      }
    }
    return visited
  }

  // An unreachable carrier has no runtime-reachable paths at all — offer nothing (the backend
  // gate passes such references vacuously, but a picker offering candidates for a dead node
  // would be authoring theater).
  if (!reachableWithout(null).has(nodeKey)) return []
  return graph.nodes
    .filter((candidate) =>
      candidate.type === 'approval'
      && candidate.key !== nodeKey
      && !reachableWithout(candidate.key).has(nodeKey))
    .map((candidate) => candidate.key)
}

/**
 * True when a single assignee source is the starter-preset placeholder role
 * (`APPROVAL_ROLE_CONFIGURE_SENTINEL`). SINGLE shared predicate for both the aggregate publish
 * checklist (`placeholderRoleNodeKeys`, below) and the per-card in-editor hint
 * (`ApprovalGraphNodeConfigEditor.vue`'s `approvalSourceIsPlaceholder`) — the two surfaces must
 * agree on exactly which source counts as a placeholder, so this is the one place that decides.
 */
export function isPlaceholderRoleSource(source: ApprovalAssigneeSource): boolean {
  return source.kind === 'static_role' && source.roleIds.includes(APPROVAL_ROLE_CONFIGURE_SENTINEL)
}

/**
 * B2-03 publish pre-flight: node keys carrying a static_role placeholder role
 * (`APPROVAL_ROLE_CONFIGURE_SENTINEL`) on ANY assignee source, not only the first. The backend
 * fail-fasts on this at PUBLISH (`assertNoUnconfiguredPlaceholderRoles`, ApprovalProductService.ts)
 * by looping every source on the node — this mirrors that check exactly so the publish-checklist
 * can warn BEFORE the confirm instead of after a rejected request. P1-B widened this from
 * `assigneeSources[0]`-only once the editor exposes N source cards (before that slice, index 0 was
 * the only authorable source, so the two checks were equivalent). Non-fatal for save (mirrors the
 * in-editor sentinel hint, which is also non-blocking).
 */
export function placeholderRoleNodeKeys(edits: ApprovalNodeEdits): string[] {
  return Object.values(edits)
    .filter((edit) => edit.assigneeSources.some(isPlaceholderRoleSource))
    .map((edit) => edit.nodeKey)
}
