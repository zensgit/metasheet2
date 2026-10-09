import { Logger } from '../core/logger'
import type { ApprovalNode, RuntimeGraph } from '../types/approval-product'
import type { RequesterFormulaContext } from './ApprovalConditionFormula'
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
 * THE THREE CHECKS — the `return` arm of `ApprovalProductService.dispatchAction`, in the order that
 * arm applies them (every target it refuses can only ever 409 there):
 *   (a) the cursor node's type is `handler` — Lock-3 §2.2's verb gate, `currentNodeType` in
 *       `dispatchAction` (APPROVAL_HANDLER_ACTION_NOT_ALLOWED) → `[]`;
 *   (b) the instance is inside a parallel region — `dispatchAction`'s `isInParallelRegion`: parallel
 *       branch state present (`readParallelBranchStates`, the door's own STRICT parser; malformed
 *       state reads as linear there too) AND the stored cursor is the fork's `parallelNodeKey`
 *       (APPROVAL_RETURN_IN_PARALLEL_UNSUPPORTED) → `[]`;
 *   (c) otherwise exactly `executor.listVisitedApprovalNodeKeysUntil(currentNodeKey).slice(0, -1)`
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
  const runtimeGraph = asWalkableRuntimeGraph(input.runtimeGraph)
  if (!runtimeGraph) return undefined

  try {
    // (a) — `dispatchAction` reads the type of the node at its effective cursor; outside a parallel
    // region that cursor IS the stored one, and inside one (b) answers first regardless.
    if (nodeTypeAt(runtimeGraph, currentNodeKey) === 'handler') return []

    // (b) — the same predicate `dispatchAction` names `isInParallelRegion`.
    const parallelState = readParallelBranchStates(input.metadata)
    if (parallelState && currentNodeKey === parallelState.parallelNodeKey) return []

    // (c) — the executor built as `dispatchAction` builds its `executor`, for the options the walk
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
