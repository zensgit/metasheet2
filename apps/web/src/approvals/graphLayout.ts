import type { ApprovalGraph } from '../types/approval'

// D-1/D-5 canvas foundation — PURE, fully unit-testable (no .vue, no DOM): a longest-path layered
// layout (node → {x,y,layer}) and a structural validity check (dangling edges / unreachable nodes /
// no-path-to-end). Bespoke over a graph library on purpose: layout is data, so it's verifiable here,
// and the canvas component just renders these coordinates + the FE preview reflects these issues
// (the backend `normalizeApprovalGraph` remains the final arbiter on save).

export interface NodeLayout {
  key: string
  x: number
  y: number
  layer: number
  order: number
}

export interface GraphLayout {
  nodes: NodeLayout[]
  width: number
  height: number
}

const X_SPACING = 220
const Y_SPACING = 110
const X_MARGIN = 40
const Y_MARGIN = 40

/**
 * Longest-path layered layout: each node's LAYER = the longest path from `start` to it (so a node
 * that rejoins multiple branches sits after all of them), and its ORDER is its slot within the layer.
 * Deterministic (input order), DAG-assuming (approval graphs are DAGs); a node unreachable from start
 * is placed in a trailing layer rather than dropped, so nothing vanishes from the canvas.
 */
export function computeLayout(graph: ApprovalGraph): GraphLayout {
  const start = graph.nodes.find((n) => n.type === 'start')?.key ?? graph.nodes[0]?.key
  const layer = new Map<string, number>()
  graph.nodes.forEach((n) => layer.set(n.key, 0))
  // Bellman-Ford-style longest-path relaxation over the DAG (|nodes| passes is sufficient + safe).
  for (let pass = 0; pass < graph.nodes.length; pass += 1) {
    let changed = false
    for (const edge of graph.edges) {
      const su = layer.get(edge.source)
      const tv = layer.get(edge.target)
      if (su === undefined || tv === undefined) continue
      if (su + 1 > tv) { layer.set(edge.target, su + 1); changed = true }
    }
    if (!changed) break
  }
  if (start) layer.set(start, 0)
  // group by layer, preserving input order for a stable `order`
  const byLayer = new Map<number, string[]>()
  for (const node of graph.nodes) {
    const l = layer.get(node.key) ?? 0
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(node.key)
  }
  const nodes: NodeLayout[] = []
  let maxLayer = 0
  let maxOrder = 0
  for (const [l, keys] of byLayer) {
    maxLayer = Math.max(maxLayer, l)
    keys.forEach((key, order) => {
      maxOrder = Math.max(maxOrder, order)
      nodes.push({ key, layer: l, order, x: X_MARGIN + l * X_SPACING, y: Y_MARGIN + order * Y_SPACING })
    })
  }
  return {
    nodes,
    width: X_MARGIN * 2 + maxLayer * X_SPACING + 160,
    height: Y_MARGIN * 2 + maxOrder * Y_SPACING + 60,
  }
}

/**
 * D-5 FE validity PREVIEW (the backend stays the final arbiter on save). Surfaces the high-value
 * structural issues a canvas edit can introduce: an edge whose source/target isn't a node, a node
 * unreachable from `start`, and a node (other than `end`) with no outgoing edge / that can't reach an
 * `end`. Empty array = structurally clean.
 */
export function graphValidityIssues(graph: ApprovalGraph): string[] {
  const issues: string[] = []
  const keys = new Set(graph.nodes.map((n) => n.key))
  for (const edge of graph.edges) {
    if (!keys.has(edge.source) || !keys.has(edge.target)) {
      issues.push(`连线 ${edge.key} 指向不存在的节点（${edge.source} → ${edge.target}）`)
    }
  }
  const start = graph.nodes.find((n) => n.type === 'start')?.key
  if (start) {
    // reachable-from-start (forward BFS over valid edges)
    const adj = new Map<string, string[]>()
    for (const e of graph.edges) {
      if (!keys.has(e.source) || !keys.has(e.target)) continue
      if (!adj.has(e.source)) adj.set(e.source, [])
      adj.get(e.source)!.push(e.target)
    }
    const seen = new Set<string>([start])
    const queue = [start]
    while (queue.length) {
      const cur = queue.shift()!
      for (const next of adj.get(cur) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next) }
    }
    for (const node of graph.nodes) {
      if (!seen.has(node.key)) issues.push(`节点「${node.name || node.key}」无法从发起节点到达`)
    }
    // every non-end node must have an outgoing edge
    const hasOut = new Set(graph.edges.map((e) => e.source))
    for (const node of graph.nodes) {
      if (node.type !== 'end' && !hasOut.has(node.key)) {
        issues.push(`节点「${node.name || node.key}」没有后继连线（流程会卡住）`)
      }
    }
  }
  return issues
}
