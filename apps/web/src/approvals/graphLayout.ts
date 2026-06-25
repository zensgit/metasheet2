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

  // D-5: duplicate node / edge keys (a canvas add could collide a key; the backend rejects it on save).
  if (keys.size !== graph.nodes.length) {
    const seenKeys = new Set<string>()
    for (const node of graph.nodes) {
      if (seenKeys.has(node.key)) issues.push(`节点 key 重复：${node.key}`)
      seenKeys.add(node.key)
    }
  }
  const edgeKeySet = new Set(graph.edges.map((e) => e.key))
  if (edgeKeySet.size !== graph.edges.length) {
    const seenEdge = new Set<string>()
    for (const edge of graph.edges) {
      if (seenEdge.has(edge.key)) issues.push(`连线 key 重复：${edge.key}`)
      seenEdge.add(edge.key)
    }
  }

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
    // D-5: every reachable node must be able to REACH an end node (backward reachability). A node that
    // can't (trapped in a cycle, or a dead-end sub-graph) means the flow can stall before finishing.
    const endKeys = graph.nodes.filter((n) => n.type === 'end').map((n) => n.key)
    if (endKeys.length) {
      const radj = new Map<string, string[]>()
      for (const e of graph.edges) {
        if (!keys.has(e.source) || !keys.has(e.target)) continue
        if (!radj.has(e.target)) radj.set(e.target, [])
        radj.get(e.target)!.push(e.source)
      }
      const canReachEnd = new Set<string>(endKeys)
      const rq = [...endKeys]
      while (rq.length) {
        const cur = rq.shift()!
        for (const pred of radj.get(cur) ?? []) if (!canReachEnd.has(pred)) { canReachEnd.add(pred); rq.push(pred) }
      }
      for (const node of graph.nodes) {
        if (node.type !== 'end' && seen.has(node.key) && !canReachEnd.has(node.key)) {
          issues.push(`节点「${node.name || node.key}」无法到达结束节点（流程不会结束）`)
        }
      }
    }
  }

  // D-5: cycle detection (an approval graph must be a DAG; a back-edge means the flow can loop forever).
  if (graphHasCycle(graph)) issues.push('审批流程存在环（节点回路），流程可能无法结束')

  return issues
}

/** Iterative DFS back-edge detection (no recursion → safe on any graph size). */
function graphHasCycle(graph: ApprovalGraph): boolean {
  const adj = new Map<string, string[]>()
  for (const e of graph.edges) {
    if (!adj.has(e.source)) adj.set(e.source, [])
    adj.get(e.source)!.push(e.target)
  }
  const state = new Map<string, 0 | 1 | 2>() // 0/undefined = unvisited, 1 = on-stack, 2 = done
  for (const root of graph.nodes.map((n) => n.key)) {
    if (state.get(root)) continue
    const stack: Array<{ node: string; idx: number }> = [{ node: root, idx: 0 }]
    state.set(root, 1)
    while (stack.length) {
      const top = stack[stack.length - 1]
      const neighbors = adj.get(top.node) ?? []
      if (top.idx < neighbors.length) {
        const next = neighbors[top.idx]
        top.idx += 1
        const s = state.get(next) ?? 0
        if (s === 1) return true // back-edge into a node still on the stack → cycle
        if (s === 0) { state.set(next, 1); stack.push({ node: next, idx: 0 }) }
      } else {
        state.set(top.node, 2)
        stack.pop()
      }
    }
  }
  return false
}
