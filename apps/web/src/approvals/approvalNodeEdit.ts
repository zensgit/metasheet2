import type {
  ApprovalAssigneeSource,
  ApprovalGraph,
  ApprovalMode,
  ApprovalNode,
  ApprovalNodeConfig,
  AutoApprovalPolicy,
  EmptyAssigneeFallback,
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
  NODE_FIELD_ACCESS_VALUES,
  NODE_TIMEOUT_MAX_AFTER_MINUTES,
  NODE_TIMEOUT_SUPPORTED_EFFECTS,
  SAME_PERSON_POLICIES,
} from '../types/approval'
import type { SamePersonPolicy } from '../types/approval'
import { runtimeSuccessorTargets } from './parallelEdit'

const NODE_TIMEOUT_SUPPORTED_EFFECT_SET = new Set<string>(NODE_TIMEOUT_SUPPORTED_EFFECTS)

const HANDLER_ASSIGNEE_SOURCE_KIND_SET = new Set<string>(HANDLER_ASSIGNEE_SOURCE_KINDS)

// Approval-node editing inside a preserved graph. The editor owns the fields already available in
// the linear authoring surface: approver source, approval/empty-assignee modes (incl. the W1-1a
// 'designated' fallback targets), the four-value same-person control (which owns
// `mergeWithRequester` + `samePersonPolicy` together), and field permissions. Any other
// allowlisted config stays preserved verbatim. The node's edges are TOPOLOGY — preserved
// byte-for-byte (G-1 anti-flatten floor). Every OTHER node/edge — condition (G-2), parallel (G-3),
// cc (G-4), start/end — is preserved verbatim. No .vue / Element Plus import, so this runs under
// the approval-web-guard vitest gate.
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
  /**
   * W1-1a (Lock-4 §3 F4-B) — the `'designated'` target set, authored by the typed user/role
   * pickers. Seeded VERBATIM from a persisted config (identity: an untouched edit reproduces the
   * persisted object byte-for-byte). Same absent/`null` grammar as `autoApprovalPolicy`: absent ≡
   * untouched, `null` ≡ the author cleared every target (key REMOVED). Emitted ONLY while the
   * effective `emptyAssigneePolicy` is `'designated'` (`applyApprovalNodeEditsToGraph`).
   */
  emptyAssigneeFallback?: EmptyAssigneeFallback | null
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

// ── W1-1a (Lock-4 §2 F4-C) — the four-value 审批人与发起人为同一人时 control, shared by BOTH editors ──
//
// Lock text (approval-lock4-flow-policies-20260817.md F4-C): "Enum `samePersonPolicy?:
// 'self_approve' | 'auto_skip' | 'transfer_direct_manager' | 'transfer_dept_head'`, absent ≡
// `'self_approve'` ≡ today's behavior when `mergeWithRequester` is off." and "`mergeWithRequester:true`
// … IS the 自动跳过 family … retained as the *implementation* of `'auto_skip'` and stays the persisted
// carrier for that value, so no existing graph changes shape."
//
// Implementer defaults (owner-visible, recorded in reviews/approval-w1-1a-impl-20261010.md):
//   (a) this control REPLACES the shipped 自审合并 checkbox and owns BOTH keys: picking 'auto_skip'
//       writes `samePersonPolicy:'auto_skip'` AND `mergeWithRequester:true` (exactly the shape the
//       backend `normalizeAutoApprovalPolicy` persists anyway); every other pick DELETES
//       `mergeWithRequester`, so the UI can never say 自审/转交 while the merge cascade auto-skips.
//   (b) the 'default' choice (默认) OMITS `samePersonPolicy` (and `mergeWithRequester`). An explicit
//       'self_approve' is written ONLY when the author picks it: in code (not in the lock) an
//       explicit value creates a node-level `autoApprovalPolicy`, and a node key PRESENT overrides
//       the template-level `policy.autoApproval` there (Lock-4 §0 precedence row — "an all-false node
//       policy DISABLES the template policy there"; `getEffectiveAutoApprovalPolicy` +
//       `hasEnabledAutoApprovalRule`, which excludes 'self_approve'), so explicit and absent are
//       NOT interchangeable once a template-level policy exists.
//   (c) an untouched node is never rewritten: the setter is a no-op when the pick equals the current
//       projection, so a bare legacy `{ mergeWithRequester: true }` (projected 'auto_skip') keeps its
//       shape unless the author actually changes the choice.

/**
 * `'default'` = 默认: the control writes NO `samePersonPolicy` and NO `mergeWithRequester` key. A
 * non-empty sentinel on purpose — Element Plus `el-select` treats `''` as an EMPTY value (its default
 * `empty-values`) and would render the placeholder instead of the 默认 option's label. It is never
 * written to a config (`applySamePersonChoice` / `setStepSamePersonChoice` translate it to absence).
 */
export type SamePersonChoice = 'default' | SamePersonPolicy

/**
 * `editable` carries the RUNTIME-faithful projection; `unknown` is a persisted `samePersonPolicy`
 * outside the frontend enum (gate X-3) — rendered read-only, never projected onto a known choice.
 */
export type SamePersonControlState =
  | { kind: 'editable'; choice: SamePersonChoice }
  | { kind: 'unknown' }

const SAME_PERSON_POLICY_SET = new Set<string>(SAME_PERSON_POLICIES)

export function isKnownSamePersonPolicy(value: unknown): value is SamePersonPolicy {
  return typeof value === 'string' && SAME_PERSON_POLICY_SET.has(value)
}

/**
 * Projection order follows what the backend actually RUNS, not the literal key:
 *   1. transfer_* — the resolver substitutes the requester's seat BEFORE the auto-approval cascade
 *      (ApprovalAssigneeResolver.ts `pushResolved`), so a co-present `mergeWithRequester:true` can
 *      never fire on that seat;
 *   2. `mergeWithRequester:true` (or an explicit 'auto_skip') → 'auto_skip' — the shipped carrier;
 *      an API-only `{ samePersonPolicy:'self_approve', mergeWithRequester:true }` therefore shows
 *      自动通过, which is what the merge cascade does at runtime;
 *   3. explicit 'self_approve';
 *   4. otherwise 'default' (默认).
 */
export function samePersonControlState(policy: AutoApprovalPolicy | null | undefined): SamePersonControlState {
  // Read as `unknown`: a persisted value may lie OUTSIDE the typed union (gate X-3).
  const raw: unknown = policy?.samePersonPolicy
  if (raw !== undefined && !isKnownSamePersonPolicy(raw)) return { kind: 'unknown' }
  if (raw === 'transfer_direct_manager' || raw === 'transfer_dept_head') return { kind: 'editable', choice: raw }
  if (raw === 'auto_skip' || policy?.mergeWithRequester === true) return { kind: 'editable', choice: 'auto_skip' }
  if (raw === 'self_approve') return { kind: 'editable', choice: 'self_approve' }
  return { kind: 'editable', choice: 'default' }
}

/**
 * Applies a pick, deleting BOTH owned keys first and keeping every sibling
 * (`mergeAdjacentApprover` / `dedupeHistoricalApprover` / `actorMode`) — the delete-key-keep-siblings
 * pattern Lock-4 OD-L4-6 names. Returns `null` when nothing is left (the canvas grammar for "remove
 * the `autoApprovalPolicy` key"). Fail-closed no-ops (returns the input unchanged): an `unknown`
 * persisted value (X-3), or a pick equal to the current projection (default (c) above).
 */
export function applySamePersonChoice(
  policy: AutoApprovalPolicy | null | undefined,
  choice: SamePersonChoice,
): AutoApprovalPolicy | null | undefined {
  const current = samePersonControlState(policy)
  if (current.kind !== 'editable' || current.choice === choice) return policy
  if (choice !== 'default' && !isKnownSamePersonPolicy(choice)) return policy
  const next: AutoApprovalPolicy = { ...(policy ?? {}) }
  delete next.samePersonPolicy
  delete next.mergeWithRequester
  if (choice === 'auto_skip') {
    next.mergeWithRequester = true
    next.samePersonPolicy = 'auto_skip'
  } else if (choice !== 'default') {
    next.samePersonPolicy = choice
  }
  return Object.keys(next).length > 0 ? next : null
}

/**
 * True when the node policy carries a key OTHER than the two the same-person control owns. Then the
 * node already overrides the template-level policy no matter what this control shows, so the 默认
 * label must not claim 跟随模板 (M8 honesty).
 */
export function autoApprovalPolicyHasNonSamePersonKeys(policy: AutoApprovalPolicy | null | undefined): boolean {
  if (!policy) return false
  return Object.keys(policy).some((key) => key !== 'samePersonPolicy' && key !== 'mergeWithRequester')
}

/**
 * Business labels for the four-value control, shared VERBATIM by both editors (one vocabulary).
 * Never the raw enum (M8). The 默认 label is computed by `samePersonDefaultChoiceLabel`.
 */
export const SAME_PERSON_EXPLICIT_CHOICE_LABELS: Record<SamePersonPolicy, string> = {
  self_approve: '由发起人本人审批（本节点单独设置）',
  auto_skip: '自动通过（自审合并）',
  transfer_direct_manager: '转交发起人的直属上级审批',
  transfer_dept_head: '转交发起人的部门负责人审批',
}

/**
 * 默认 label, M8-honest about precedence: it only "跟随模板" when the node carries NO other
 * node-level auto-approval key — otherwise the node already overrides the template-level policy
 * (Lock-4 §0 precedence row) and the label must not claim it follows the template.
 */
export function samePersonDefaultChoiceLabel(policy: AutoApprovalPolicy | null | undefined): string {
  return autoApprovalPolicyHasNonSamePersonKeys(policy) ? '默认（本节点不单独设置）' : '默认（跟随模板设置）'
}

/**
 * Select value for an `unknown` persisted `samePersonPolicy` (gate X-3). Rendered with its own
 * honest option label so the control never shows the raw off-enum string (M8) — Element Plus falls
 * back to displaying the raw model value when no option matches.
 */
export const SAME_PERSON_UNKNOWN_SELECT_VALUE = '__unknown__'
export const SAME_PERSON_UNKNOWN_LABEL = '未识别的设置（只读，保存时保留原值）'

/** The control's model value: the projected choice, or the unknown sentinel. */
export function samePersonSelectValue(policy: AutoApprovalPolicy | null | undefined): string {
  const state = samePersonControlState(policy)
  return state.kind === 'editable' ? state.choice : SAME_PERSON_UNKNOWN_SELECT_VALUE
}

/** The options in display order: 默认 first, then the four ratified values (Lock-4 F4-C order);
 *  an `unknown` persisted value gets one extra, leading, read-only option. */
export function samePersonChoiceOptions(policy: AutoApprovalPolicy | null | undefined): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [
    { value: 'default', label: samePersonDefaultChoiceLabel(policy) },
    ...SAME_PERSON_POLICIES.map((value) => ({ value, label: SAME_PERSON_EXPLICIT_CHOICE_LABELS[value] })),
  ]
  if (samePersonControlState(policy).kind === 'unknown') {
    options.unshift({ value: SAME_PERSON_UNKNOWN_SELECT_VALUE, label: SAME_PERSON_UNKNOWN_LABEL })
  }
  return options
}

/** Narrows a raw select value to a writable choice (`null` for the unknown sentinel / garbage). */
export function samePersonChoiceFromSelectValue(value: unknown): SamePersonChoice | null {
  if (value === 'default') return 'default'
  return isKnownSamePersonPolicy(value) ? value : null
}

/** Business label for the 'designated' empty-assignee option (both editors). */
export const EMPTY_ASSIGNEE_DESIGNATED_LABEL = '转交指定人员'

/**
 * M8 honesty copy (both editors), each sentence traceable to a ratified clause or shipped code:
 * - designated: "Fallback is exactly ONE non-recursive step (locked)" — zero usable targets ends at
 *   the shipped APPROVAL_ASSIGNEE_EMPTY error, never auto-approve (gate B-2); eligibility (active
 *   users / roles with ≥1 active member) is resolved once at create
 *   (`loadApprovalDesignatedFallbackEligibility`); OD-L4-3(a): 转审批管理员 = designate that ROLE.
 */
export const EMPTY_ASSIGNEE_DESIGNATED_HINT =
  '仅转交一次：若指定的用户均已停用、指定的角色没有可用成员，该节点按「报错」处理，不会自动通过。可用人员在发起审批时确定。如需转交给审批管理员，请指定审批管理员所在的角色。'
/**
 * - override: Lock-4 §0 precedence row — a node-level `autoApprovalPolicy` key PRESENT is a
 *   whole-object override, so any non-默认 pick stops the template-level 审批人去重 tier at this node.
 */
export const SAME_PERSON_OVERRIDE_HINT =
  '选择「默认」以外的选项会为本节点单独设置自动审批规则，模板级「审批人去重」将不再作用于本节点。'
/**
 * - transfer: OD-L4-5(a) — an absent transfer target means the seat is not produced and
 *   `emptyAssigneePolicy` governs; it must NEVER fall back to self_approve (gate C-3).
 */
export const SAME_PERSON_TRANSFER_HINT =
  '若发起人没有直属上级/部门负责人（或该负责人就是发起人本人），本节点不会生成这位审批人，改按「空审批人策略」处理，不会退回由发起人本人审批。'

// ── W1-1a (Lock-4 §3 F4-B) — 'designated' fallback targets, shared by BOTH editors ──────────────

/** True when the fallback names at least one non-blank user or role id (mirrors the backend B-s10
 *  emptiness check in `validateEmptyAssigneeFallbackConfigs`, where an empty array ≡ absent). */
export function emptyAssigneeFallbackHasTarget(fallback: EmptyAssigneeFallback | null | undefined): boolean {
  if (!fallback) return false
  const hasAny = (ids: unknown) => Array.isArray(ids) && ids.some((id) => typeof id === 'string' && id.trim().length > 0)
  return hasAny(fallback.userIds) || hasAny(fallback.roleIds)
}

/**
 * Replaces ONE side (users or roles) of a fallback from a typed picker, keeping the other side.
 * Trims, drops blanks and duplicates, omits an empty side, and returns `undefined` when both sides
 * end up empty — the same normalization the backend `normalizeEmptyAssigneeFallback` applies, so the
 * FE never sends a shape the server would rewrite. Always a fresh object (never aliases the input).
 */
export function withEmptyAssigneeFallbackIds(
  fallback: EmptyAssigneeFallback | null | undefined,
  side: 'user' | 'role',
  ids: string[],
): EmptyAssigneeFallback | undefined {
  const clean = (values: readonly string[] | undefined) => {
    const out: string[] = []
    for (const value of values ?? []) {
      const trimmed = typeof value === 'string' ? value.trim() : ''
      if (trimmed && !out.includes(trimmed)) out.push(trimmed)
    }
    return out
  }
  const userIds = clean(side === 'user' ? ids : fallback?.userIds)
  const roleIds = clean(side === 'role' ? ids : fallback?.roleIds)
  if (userIds.length === 0 && roleIds.length === 0) return undefined
  return {
    ...(userIds.length > 0 ? { userIds } : {}),
    ...(roleIds.length > 0 ? { roleIds } : {}),
  }
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
        // W1-1a: identity seed — present only when persisted, so a node without the key seeds
        // exactly as before this slice (no round-trip churn).
        ...(node.config.emptyAssigneeFallback !== undefined
          ? { emptyAssigneeFallback: cloneJson(node.config.emptyAssigneeFallback) }
          : {}),
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
    // Fix-round advisor catch (post-P1-1): `emptyAssigneeFallback` rides ONLY with an effective
    // policy of 'designated' — mirrors `approvalThreshold`'s own conditional-emission arm
    // immediately above. An author switching a designated node's 空审批人策略 control away must not
    // leave an orphaned key behind — the backend B-s10 validator would 400 the save
    // (APPROVAL_EMPTY_ASSIGNEE_FALLBACK_NOT_ALLOWED). W1-1a: the key is now IN the edit model (typed
    // user/role pickers); absent ≡ untouched (the `{...originalConfig}` spread keeps the persisted
    // value), `null` ≡ every target cleared (key removed — `validateApprovalNodeEdits` then flags
    // the designated-without-target state before save, mirroring APPROVAL_EMPTY_ASSIGNEE_FALLBACK_REQUIRED).
    if (config.emptyAssigneePolicy !== 'designated') delete config.emptyAssigneeFallback
    else if (edit.emptyAssigneeFallback === null) delete config.emptyAssigneeFallback
    else if (edit.emptyAssigneeFallback !== undefined) config.emptyAssigneeFallback = cloneJson(edit.emptyAssigneeFallback)
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
    // Lock-2 §L2-C PREVIEW: a non-empty fieldId referencing a TOP-LEVEL `user` field (the shipped
    // form_field_user posture) plus a level integer ≥ 1 (backend normalizeApprovalAssigneeSources
    // stays the arbiter on the ceiling; the required/visibility/selection pins are the backend
    // publish validator's job — the FE field picker only OFFERS eligible fields).
    case 'form_field_user_manager':
    case 'form_field_user_dept_head':
      if (source.fieldId.trim().length === 0) return false
      if (!Number.isInteger(source.level) || source.level < 1) return false
      return topLevelUserFieldIds ? topLevelUserFieldIds.has(source.fieldId.trim()) : true
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
    // Lock-1 §K1 PREVIEW (backend normalizeApprovalAssigneeSources stays the arbiter): a
    // non-empty groupIds array. Whether each referenced id is a REAL group bound to the
    // publishing org is the backend PUBLISH gate's job (`assertUserGroupSourcesBoundToOrg`); the
    // FE picker only OFFERS bound candidates, so this shape check plus the picker keep authoring
    // honest without relaxing the backend arbiter (same posture as prior_node_approver above).
    case 'user_group':
      return source.groupIds.some((id) => id.trim().length > 0)
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
 * P1-C + Lock-1 K6: `parallelRegionNodeKeys` (from `collectParallelRegionNodeKeys` in
 * templateAuthoring.ts) is the linear-only fail-closed gate for threshold, sequential, and timeout.
 * Each is backend-rejected inside a parallel region. Optional so existing callers/tests that don't
 * touch these controls are unaffected; omitting it treats every node as outside a parallel region
 * (the caller — `validateTemplateApprovalFlow` — always supplies the real set for the live app).
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
      if (edit.approvalMode !== undefined && !(['single', 'all', 'any', 'threshold', 'sequential'] as const).includes(edit.approvalMode)) {
        errors.push(`审批节点 ${edit.nodeKey} 的审批模式无效`)
      }
      // Fix-round P1-1 / P3-2 (gate P3A-F4B-20260819) — widened to admit `'designated'`, seeded
      // verbatim by `approvalNodeEditsFromGraph` from a persisted value. Without this, a canvas
      // node carrying `emptyAssigneePolicy: 'designated'` would fail THIS preview the moment its
      // edit is seeded — even for an author who never touched the node — blocking save on an
      // untouched, valid, persisted value (the same class of defect gate X-2 targets, on a
      // different code path than `unsupportedTemplateAuthoringReason`).
      if (edit.emptyAssigneePolicy !== undefined && !(['error', 'auto-approve', 'designated'] as const).includes(edit.emptyAssigneePolicy)) {
        errors.push(`审批节点 ${edit.nodeKey} 的空审批人策略无效`)
      }
      // W1-1a — FE mirror of the backend B-s10 authoring gate (`validateEmptyAssigneeFallbackConfigs`,
      // APPROVAL_EMPTY_ASSIGNEE_FALLBACK_REQUIRED), which runs on create/update as well as publish, so
      // this is a SAVE-blocking preview, not a publish-only one. Values-free: node key + policy only.
      if (edit.emptyAssigneePolicy === 'designated' && !emptyAssigneeFallbackHasTarget(edit.emptyAssigneeFallback)) {
        errors.push(`审批节点 ${edit.nodeKey} 的空审批人策略为「转交指定人员」，需要至少指定一位用户或一个角色`)
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
      if (edit.approvalMode === 'sequential' && inParallelRegion) {
        errors.push(`审批节点 ${edit.nodeKey} 位于并行分支内，不支持依次审批（v1 仅支持线性路径）`)
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
      // MECHANISM FIX v5 (census C-6 conversion): reads the ONE canonical FE
      // `NODE_FIELD_ACCESS_VALUES` array (apps/web/src/types/approval.ts) instead of hand-copying the
      // member list a second time here — a member added to/removed from the canonical array is picked
      // up here for free, and there is no longer a literal list for the census to have to catch.
      if (!NODE_FIELD_ACCESS_VALUES.includes(permission.access)) {
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
