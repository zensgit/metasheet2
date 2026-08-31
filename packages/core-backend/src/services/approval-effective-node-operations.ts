import type { NodeOperationPolicy, NodeOperationPolicyActionKey } from '../types/approval-product'

/**
 * Lock-5 §1.3 / §2.3 — the ONE resolver both doors share.
 * Source: `docs/development/approval-lock5-node-operation-policy-20260817.md` §1.1 (absent ≡ today),
 * §1.3 + OD-L5-8(a) (node level with the instance-snapshot fallback), §2.3 (the FE mirror derives
 * from the SAME config the server enforces — **no second predicate**), gates A-2 and CR-1..CR-3.
 *
 * ### Why this is a module and not two inline reads
 *
 * §2.3 requires UI hiding and server refusal to be two doors over ONE predicate. If the FE computed
 * "is transfer allowed" from its own copy of the rule, the doors could drift and the gate's
 * neuter-each-separately discipline would be testing two different contracts. So the SERVER resolves
 * the effective values here, the dispatch choke enforces them, and the detail DTO ships the SAME
 * resolved booleans to the client — which then only has to render, never to decide.
 *
 * ### Absent ≡ ALLOWED, deliberately (OD-L5-3(a))
 *
 * Only an explicit `false` denies. This is the OPPOSITE of the shipped `allowRevoke` idiom (`=== true`,
 * fail-closed) and copying that idiom here would silently deny every one of the four verbs on every
 * pre-Lock-5 graph. The predicate below is the same `!== false` shape the dispatch choke uses.
 *
 * ### Multi-seat is MOST-RESTRICTIVE-WINS
 *
 * A viewer can hold seats at more than one node (a parallel region). `fieldAccess` (Lock-7 OD-L7-10)
 * already established most-restrictive-wins for exactly this case, and the same reasoning applies:
 * over-reporting a capability would render a button whose click the server then refuses, which is
 * the very M7 exposure this carrier closes.
 */

/** The comment requirement, ordered least → most restrictive so a multi-seat max() is well-defined. */
const COMMENT_REQUIRED_ORDER = ['never', 'reject_only', 'always'] as const
export type CommentRequired = typeof COMMENT_REQUIRED_ORDER[number]

/**
 * The resolved, client-shippable policy for a viewer at their claimed seat(s). Every field is a
 * DECIDED value, never a raw config echo — the client renders it and does not re-derive.
 */
export interface EffectiveNodeOperations {
  allowTransfer: boolean
  allowAddSign: boolean
  allowReduceSign: boolean
  allowReturn: boolean
  commentRequired: CommentRequired
}

/** A structural view of the frozen runtime graph — the same shape the redaction reads use. */
export interface NodeOperationGraphView {
  nodes?: Array<{ key?: unknown; config?: unknown } | null> | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Structural read of one node's `nodeOperationPolicy`. Never re-validates (the graph is frozen). */
export function nodeOperationPolicyAt(
  graph: NodeOperationGraphView | null | undefined,
  nodeKey: string | null | undefined,
): NodeOperationPolicy | undefined {
  if (!graph?.nodes || !nodeKey) return undefined
  for (const node of graph.nodes) {
    if (node && node.key === nodeKey) {
      const config = node.config
      if (!isRecord(config)) return undefined
      const policy = (config as { nodeOperationPolicy?: unknown }).nodeOperationPolicy
      return isRecord(policy) ? (policy as NodeOperationPolicy) : undefined
    }
  }
  return undefined
}

function approvalModeAt(
  graph: NodeOperationGraphView | null | undefined,
  nodeKey: string | null | undefined,
): unknown {
  if (!graph?.nodes || !nodeKey) return undefined
  const node = graph.nodes.find((candidate) => candidate?.key === nodeKey)
  return node && isRecord(node.config) ? node.config.approvalMode : undefined
}

/**
 * Lock-5 §1.3 / OD-L5-8(a) — the effective comment requirement at ONE node.
 *
 * Node level first; when the node carries no `commentRequired`, fall back to the INSTANCE's frozen
 * `policy_snapshot.rejectCommentRequired`. The fallback is what makes this byte-stable with no
 * backfill: every instance created before this slice has `rejectCommentRequired: true` and therefore
 * resolves to `'reject_only'` — today's behavior exactly, expressed as ONE rule rather than a literal
 * default racing a fallback (§1.3).
 *
 * The snapshot's own default is `!== false`, matching every shipped reader (the bridge path, the card
 * helper, and all four FE sites), so an absent/legacy/missing snapshot also resolves `'reject_only'`.
 */
export function effectiveCommentRequired(
  nodePolicy: NodeOperationPolicy | undefined,
  policySnapshot: unknown,
): CommentRequired {
  const declared = nodePolicy?.commentRequired
  if (declared === 'never' || declared === 'reject_only' || declared === 'always') {
    return declared
  }
  const snapshotValue = isRecord(policySnapshot)
    ? (policySnapshot as { rejectCommentRequired?: unknown }).rejectCommentRequired
    : undefined
  return snapshotValue === false ? 'never' : 'reject_only'
}

/** Most-restrictive of two comment requirements (never < reject_only < always). */
function stricterCommentRequired(a: CommentRequired, b: CommentRequired): CommentRequired {
  return COMMENT_REQUIRED_ORDER.indexOf(a) >= COMMENT_REQUIRED_ORDER.indexOf(b) ? a : b
}

/** Is `verb` permitted at `nodeKey`? Absent ≡ allowed; only an explicit `false` denies. */
export function isOperationAllowedAtNode(
  graph: NodeOperationGraphView | null | undefined,
  nodeKey: string | null | undefined,
  policyKey: NodeOperationPolicyActionKey,
): boolean {
  if (
    approvalModeAt(graph, nodeKey) === 'sequential'
    && (policyKey === 'allowAddSign' || policyKey === 'allowReduceSign')
  ) return false
  return nodeOperationPolicyAt(graph, nodeKey)?.[policyKey] !== false
}

/** The assignment shape this module needs — a structural subset of `ApprovalAssignmentRow`. */
export interface ViewerSeatAssignment {
  is_active: boolean
  assignment_type: string
  assignee_id: string
  node_key: string | null
}

/**
 * The viewer's ACTIVE seat node keys, matched with EXACTLY the predicate the dispatch choke uses
 * (`assignmentMatchesActor`): a `user` seat matches the viewer's id, a `role` seat matches when the
 * viewer holds that role, and **any other `assignment_type` matches nothing**.
 *
 * That last clause is not incidental. `approval_assignments.assignment_type` admits a third value,
 * `'source_queue'`; an earlier hand-copy of this filter let it fall through to the user-id arm, which
 * claimed to mirror the choke while being strictly wider (gate finding NIT-R1). It is exported and
 * shared precisely so the two DTO builders and the choke cannot drift into three predicates — the
 * failure this slice already hit once with the four hand-copied error handlers.
 */
export function seatNodeKeysForViewer(
  assignments: readonly ViewerSeatAssignment[],
  viewerUserId: string,
  viewerRoles?: readonly string[] | null,
): string[] {
  const roleSet = new Set(
    (viewerRoles ?? []).filter((role): role is string => typeof role === 'string' && role.length > 0),
  )
  const keys: string[] = []
  for (const assignment of assignments) {
    if (!assignment.is_active) continue
    const matches = assignment.assignment_type === 'user'
      ? assignment.assignee_id === viewerUserId
      : assignment.assignment_type === 'role'
        ? roleSet.has(assignment.assignee_id)
        : false
    if (!matches) continue
    if (typeof assignment.node_key === 'string' && assignment.node_key.length > 0) {
      keys.push(assignment.node_key)
    }
  }
  return keys
}

/**
 * Resolve the viewer's effective operations across every node they hold a seat at.
 *
 * `seatNodeKeys` MUST be the viewer's own ACTIVE seat node keys — not the instance's
 * `current_node_key`. Inside a parallel region those differ: `current_node_key` is the fork gateway
 * while the server's dispatch choke resolves policy from the actor's own assignment `node_key`
 * (its `actorBranchNodeKey`). Deriving the client mirror from the gateway would read the WRONG
 * node's policy on every parallel instance — the same class of divergence the lock flags on
 * `returnableNodes`, which it explicitly forbids compounding (§2.3).
 *
 * Returns `null` when the viewer holds no seat: there is nothing to mirror, and a seatless viewer
 * has no member-action affordances to gate in the first place.
 */
export function resolveEffectiveNodeOperations(
  graph: NodeOperationGraphView | null | undefined,
  seatNodeKeys: readonly string[],
  policySnapshot: unknown,
): EffectiveNodeOperations | null {
  if (seatNodeKeys.length === 0) return null
  let allowTransfer = true
  let allowAddSign = true
  let allowReduceSign = true
  let allowReturn = true
  let commentRequired: CommentRequired = 'never'
  let sawAny = false
  for (const nodeKey of seatNodeKeys) {
    const policy = nodeOperationPolicyAt(graph, nodeKey)
    if (approvalModeAt(graph, nodeKey) === 'sequential') {
      allowAddSign = false
      allowReduceSign = false
    }
    if (policy?.allowTransfer === false) allowTransfer = false
    if (policy?.allowAddSign === false) allowAddSign = false
    if (policy?.allowReduceSign === false) allowReduceSign = false
    if (policy?.allowReturn === false) allowReturn = false
    const nodeComment = effectiveCommentRequired(policy, policySnapshot)
    commentRequired = sawAny ? stricterCommentRequired(commentRequired, nodeComment) : nodeComment
    sawAny = true
  }
  return { allowTransfer, allowAddSign, allowReduceSign, allowReturn, commentRequired }
}

// (Gate finding P3-3 on #4983) A `policyKeyForAction` wrapper over `ACTION_POLICY_KEYS` used to live
// here with ZERO call sites. Deleted rather than kept: the dispatch choke reads `ACTION_POLICY_KEYS`
// directly, so the wrapper added an indirection without removing a duplicate — and a dead export is
// exactly what makes a "single predicate" claim unfalsifiable.
