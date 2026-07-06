import type { ApprovalGraph } from '../types/approval'
import { buildUpcomingNodes, type UpcomingApprovalNode } from './upcomingNodes'

/**
 * UX B2-07 — one step in the submit-time flow preview (see `summarizeApprovalFlow` below).
 * Structurally identical to `UpcomingApprovalNode` (UX B2-08) — an alias, not a new shape, so the
 * two features stay byte-compatible for free and any future shared rendering needs no adapter.
 */
export type ApprovalFlowStep = UpcomingApprovalNode

/**
 * UX B2-07 — submit-time flow preview for the requester filling out `ApprovalNewView` ("会到谁
 * 手上、几步" — before submitting, a requester has no way to see who will handle the request or
 * how many steps it takes). Walks the WHOLE approval graph from its `start` node through to `end`,
 * in order.
 *
 * DRY: `buildUpcomingNodes(graph, seedKey)` (UX B2-08, `upcomingNodes.ts`) already walks forward
 * from a seed node — excluding the seed itself from the result, one hop at a time — honestly
 * stopping (never fabricating a path) the instant a node has anything other than exactly one
 * outgoing edge (a `condition` branch or a `parallel` fan-out), plus dangling-edge/cycle guards.
 * That is *exactly* the walk this needs too, just seeded at the graph's `start` node instead of an
 * in-flight instance's current node — so this is a thin wrapper reusing that walk verbatim, not a
 * parallel implementation. `nodeAssigneeSourceSummary` (the per-node label, `assigneeSource.ts`) is
 * therefore also reused transitively through `buildUpcomingNodes`, not re-imported here.
 *
 * The requester-facing "发起人" chip is rendered by the VIEW, not included in this list — the
 * graph's `start` node carries no assignee summary of its own (`nodeAssigneeSourceSummary` returns
 * `''` for a `start` node, which is exactly why `buildUpcomingNodes` never emits the seed itself).
 *
 * Returns `[]` (view renders nothing) when the graph has no `start` node, or the walk stops
 * immediately (e.g. a single-node graph with no outgoing edge, or an empty graph) — never throws
 * on a malformed/empty graph.
 */
export function summarizeApprovalFlow(graph: ApprovalGraph): ApprovalFlowStep[] {
  const startKey = graph.nodes.find((node) => node.type === 'start')?.key
  if (!startKey) return []
  return buildUpcomingNodes(graph, startKey)
}
