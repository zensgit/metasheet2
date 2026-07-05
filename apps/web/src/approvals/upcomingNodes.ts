import type { ApprovalGraph, ApprovalNode } from '../types/approval'
import { nodeAssigneeSourceSummary } from './assigneeSource'

export interface UpcomingApprovalNode {
  key: string
  name: string
  assigneeSummary: string
  isConditional: boolean
}

/**
 * UX B2-08 — walks the approval graph FORWARD from `currentNodeKey`, one hop at a time, to
 * synthesize the "what's next" section of the detail view's timeline. The real history only ever
 * has PAST actions — there is no history row for the currently-open step — so a requester can't
 * otherwise tell what comes after it. Ordered nearest-first (current node's immediate successor
 * first).
 *
 * Stops the instant the path becomes ambiguous — any node with anything other than exactly one
 * outgoing edge. That covers a `condition` node (branches depend on unevaluated form data) AND a
 * `parallel` fan-out (concurrent branches) with the SAME rule: don't fabricate a single guessed
 * path. The fan-out node itself is still included as the last entry (for `condition`,
 * `isConditional: true` + the honest "按条件进入后续分支" summary — see
 * `nodeAssigneeSourceSummary`) — only what comes AFTER it is left out. A dangling edge (target not
 * in `graph.nodes`) or a dead end (no outgoing edge, short of reaching `end`) also stops the walk
 * without throwing. A defensive `visited` guard additionally stops a cycle — approval graphs are
 * authored/validated as DAGs (see `graphLayout.graphHasCycle`) — so this walk stays safe even
 * against a malformed one.
 */
export function buildUpcomingNodes(graph: ApprovalGraph, currentNodeKey: string): UpcomingApprovalNode[] {
  const nodesByKey = new Map(graph.nodes.map((node) => [node.key, node]))
  const outgoingByNode = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (!outgoingByNode.has(edge.source)) outgoingByNode.set(edge.source, [])
    outgoingByNode.get(edge.source)!.push(edge.target)
  }

  const result: UpcomingApprovalNode[] = []
  const visited = new Set<string>([currentNodeKey])
  let cursor = currentNodeKey
  // Bounded by node count (a walk can't visit more distinct nodes than exist) instead of an
  // unconditional loop — mirrors the defensive bounded-pass style already used by `graphLayout.ts`.
  for (let hop = 0; hop < graph.nodes.length; hop += 1) {
    const targets = outgoingByNode.get(cursor) ?? []
    if (targets.length !== 1) break // dead end, or a fan-out we won't guess through
    const next = targets[0]
    if (visited.has(next)) break // cycle guard (graphs are authored as DAGs; defensive only)
    visited.add(next)
    const node: ApprovalNode | undefined = nodesByKey.get(next)
    if (!node) break // dangling edge guard
    result.push({
      key: node.key,
      name: node.name?.trim() || node.key,
      assigneeSummary: nodeAssigneeSourceSummary(node),
      isConditional: node.type === 'condition',
    })
    if (node.type === 'end') break
    cursor = next
  }
  return result
}
