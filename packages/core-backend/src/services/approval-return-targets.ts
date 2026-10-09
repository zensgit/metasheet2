import { Logger } from '../core/logger'
import { isCancelRoundInstance } from '../attendance/w4c3b-central-approval-hooks'
import { ACTION_POLICY_KEYS } from '../types/approval-product'
import type { ApprovalNode, RuntimeGraph } from '../types/approval-product'
import type { RequesterFormulaContext } from './ApprovalConditionFormula'
import { isOperationAllowedAtNode, type NodeOperationGraphView } from './approval-effective-node-operations'
// Deliberately a VALUE import that is read inside the function body only, never while this module
// loads: `ApprovalGraphExecutor` imports `ServiceError` from `ApprovalBridgeService`, and the bridge
// imports THIS module for its detail-read DTO builder, so the three form an import cycle. Every
// edge of it is late-bound (no module touches another's export at evaluation time), so the cycle is
// inert under the CommonJS build and under vitest's loader whichever module happens to load first.
// A type-only import is impossible here (the class is constructed), and moving `ServiceError` out
// of the bridge is a wider refactor than one DTO field warrants.
import { ApprovalGraphExecutor } from './ApprovalGraphExecutor'
import { readParallelBranchStates } from './approval-seat-authorization'

const logger = new Logger('ApprovalReturnTargets')

/**
 * 退回 (return) targets the server's return gate would accept RIGHT NOW — computed ONCE here, from
 * the instance's FROZEN runtime graph, so both instance-DTO builders (`ApprovalBridgeService`
 * `toUnifiedDTO`, the detail read; `ApprovalProductService` `toUnifiedApprovalDTO`, every action
 * response) ship the same `returnableNodeKeys` carrier and the client renders rather than
 * re-derives.
 *
 * WHY A SERVER LIST. The client-side mirror (ApprovalDetailView.vue `returnableNodes`) can judge
 * only by the template graph it is able to load, and an ordinary member can load only the
 * template's LATEST version (the frozen-version endpoint is admin-gated) — so under drift the
 * client either hides a legal target or keeps an illegal one. The server walks the very graph the
 * gate itself walks.
 *
 * THE FIVE CHECKS — every VIEWER-INDEPENDENT refusal `ApprovalProductService.dispatchAction` applies
 * to a `return` (its seat / authorization checks are per-actor and are NOT mirrored here; the
 * detail read's `nodeOperations` / `canDecideCurrentNode` carriers answer those), in the order
 * `dispatchAction` applies them. Every target this list omits can only ever 409 there:
 *   (a) the instance KIND — `assertCancelRoundActionAllowed`: a cancel-round instance
 *       (`isCancelRoundInstance`, `workflow_key = 'approval.cancel-round'`) refuses `return`
 *       outright, BEFORE the gate reads any graph (CANCEL_ROUND_OUTLET_FORBIDDEN) → `[]`;
 *   (b) the cursor node's type is `handler` — Lock-3 §2.2's verb gate, `currentNodeType` in
 *       `dispatchAction` (APPROVAL_HANDLER_ACTION_NOT_ALLOWED) → `[]`;
 *   (c) the cursor node's NODE-OPERATION POLICY — Lock-5 §2.1's choke: `ACTION_POLICY_KEYS.return`
 *       names the policy key (`allowReturn`) and `isOperationAllowedAtNode` reads it off the SAME
 *       frozen graph; only an explicit `false` denies (absent ≡ allowed, OD-L5-3(a))
 *       (APPROVAL_NODE_OPERATION_DISABLED) → `[]`;
 *   (d) the instance is inside a parallel region — `dispatchAction`'s `isInParallelRegion`: parallel
 *       branch state present (`readParallelBranchStates`, the door's own STRICT parser; malformed
 *       state reads as linear there too) AND the stored cursor is the fork's `parallelNodeKey`
 *       (APPROVAL_RETURN_IN_PARALLEL_UNSUPPORTED) → `[]`;
 *   (e) otherwise exactly `executor.listVisitedApprovalNodeKeysUntil(currentNodeKey).slice(0, -1)`
 *       (APPROVAL_RETURN_TARGET_INVALID for anything else). That walker starts at `start`, follows
 *       the ONE condition branch the form data and the requester context resolve to, passes through
 *       cc and handler nodes without listing them, jumps a parallel fork straight to its
 *       `joinNodeKey`, and stops AT the cursor.
 *
 * CONTRACT. `string[]` = the legal targets in trail order (start → cursor). `[]` = nothing is legal
 * (a client hides 退回). `undefined` = NOT computed: the instance is not pending, has no frozen graph
 * (a bridged / legacy instance), has no cursor, or the walk threw — and a read must never fail
 * because of this field, so EVERY throw is swallowed here (the executor throws on a malformed graph:
 * no start node, a cycle, an edge to an unknown node, a cursor that is not an approval node or is
 * unreachable; a capture-prone stored formula throws a typed ServiceError; a formula runtime error
 * throws too) and reported at debug level at most. Presentation only: the gate's 409s stay the
 * authority, and a client that receives no list keeps its own fallback.
 */
export interface ReturnableNodeKeysInput {
  /**
   * The instance's FROZEN runtime graph — `approval_published_definitions.runtime_graph` for its
   * `published_definition_id` — as the validated `RuntimeGraph` or as the raw JSONB view the detail
   * read already loads for redaction (the same stored blob, `{ nodes, edges, policy }`). `null` or
   * anything that is not a graph ⇒ not computed.
   */
  runtimeGraph: unknown
  /** `approval_instances.form_snapshot` — the RAW stored snapshot, never the redacted echo. */
  formSnapshot: unknown
  /**
   * `approval_instances.requester_snapshot` — the frozen directory department / title / roles a
   * `requester.*` condition formula reads. Threaded exactly as `dispatchAction` threads it, so a
   * condition branch resolves here to the branch the gate resolves to.
   */
  requesterSnapshot?: unknown
  /**
   * `approval_instances.workflow_key` — read ONLY through `isCancelRoundInstance`, the same
   * predicate `assertCancelRoundActionAllowed` applies (check (a)). Absent ⇒ not a cancel round.
   */
  workflowKey?: string | null
  /** `approval_instances.current_node_key` — the STORED cursor (the fork inside a parallel region). */
  currentNodeKey: string | null | undefined
  /** `approval_instances.status` — only a pending instance can be returned. */
  status: string | null | undefined
  /** `approval_instances.metadata` — read for `parallelBranchStates` only. */
  metadata: unknown
}

export function computeReturnableNodeKeys(input: ReturnableNodeKeysInput): string[] | undefined {
  if (input.status !== 'pending') return undefined
  const currentNodeKey = typeof input.currentNodeKey === 'string' && input.currentNodeKey.length > 0
    ? input.currentNodeKey
    : null
  if (!currentNodeKey) return undefined
  // (a) — the instance KIND refuses the verb before `dispatchAction` reads any graph, so the answer
  // needs none either: a cancel round has NO legal target, whatever its graph says.
  if (isCancelRoundInstance({ workflow_key: input.workflowKey ?? null })) return []
  const runtimeGraph = asWalkableRuntimeGraph(input.runtimeGraph)
  if (!runtimeGraph) return undefined

  try {
    // (b) — `dispatchAction` reads the type of the node at its effective cursor; outside a parallel
    // region that cursor IS the stored one, and inside one (d) answers first regardless.
    if (nodeTypeAt(runtimeGraph, currentNodeKey) === 'handler') return []

    // (c) — the Lock-5 choke, verbatim: the policy key comes from the `ACTION_POLICY_KEYS` table the
    // choke iterates (never a hand-named verb), and `isOperationAllowedAtNode` is the ONE predicate
    // both doors share (§2.3). Same effective-cursor remark as (b).
    const returnPolicyKey = ACTION_POLICY_KEYS.return
    if (
      returnPolicyKey !== null
      && !isOperationAllowedAtNode(runtimeGraph as NodeOperationGraphView, currentNodeKey, returnPolicyKey)
    ) return []

    // (d) — the same predicate `dispatchAction` names `isInParallelRegion`.
    const parallelState = readParallelBranchStates(input.metadata)
    if (parallelState && currentNodeKey === parallelState.parallelNodeKey) return []

    // (e) — the executor built as `dispatchAction` builds its `executor`, for the options the walk
    // reads: the form data (rule and formula branches) and the requester context (`requester.*`
    // formula attributes). The assignment and designated-fallback resolvers it also passes are
    // read only by assignment resolution, which `listVisitedApprovalNodeKeysUntil` never performs.
    const formSnapshot = toNullableRecord(input.formSnapshot) || {}
    const requesterSnapshot = toNullableRecord(input.requesterSnapshot)
    const executor = new ApprovalGraphExecutor(runtimeGraph, formSnapshot, {
      requesterContext: requesterFormulaContextFromSnapshot(requesterSnapshot),
    })
    return executor.listVisitedApprovalNodeKeysUntil(currentNodeKey).slice(0, -1)
  } catch (error) {
    logger.debug('returnable node keys not computed', {
      currentNodeKey,
      reason: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

/**
 * The frozen requester attributes a `requester.*` condition formula may read, derived from the
 * stored requester snapshot EXACTLY as `dispatchAction` derives its executor's `requesterContext`
 * (`directoryDepartment` / `directoryTitle` / `directoryRoles`; a missing or non-string value is
 * `null`, roles default to the empty set).
 */
function requesterFormulaContextFromSnapshot(
  requesterSnapshot: Record<string, unknown> | null,
): RequesterFormulaContext {
  const department = requesterSnapshot?.directoryDepartment
  const title = requesterSnapshot?.directoryTitle
  const roles = requesterSnapshot?.directoryRoles
  return {
    department: typeof department === 'string' && department ? department : null,
    title: typeof title === 'string' && title ? title : null,
    roles: Array.isArray(roles) ? roles.filter((role): role is string => typeof role === 'string') : [],
  }
}

/**
 * Structural admission only — the walk reads `nodes` and `edges`; `policy` is never read by
 * `listVisitedApprovalNodeKeysUntil`, so the stored blob is accepted as-is without the publish-time
 * re-validation (`asRuntimeGraph`) the dispatch path performs. Anything the executor then rejects
 * surfaces as a throw and lands in the `undefined` arm above.
 */
function asWalkableRuntimeGraph(value: unknown): RuntimeGraph | null {
  if (!isRecord(value)) return null
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null
  return value as unknown as RuntimeGraph
}

function nodeTypeAt(runtimeGraph: RuntimeGraph, nodeKey: string): string | null {
  for (const node of runtimeGraph.nodes as Array<ApprovalNode | null | undefined>) {
    if (node && node.key === nodeKey) {
      return typeof node.type === 'string' ? node.type : null
    }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toNullableRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}
