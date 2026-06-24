import type { ApprovalGraph, ApprovalNode, ApprovalEdge, ConditionNodeConfig, ParallelNodeConfig } from '../types/approval'

// D-2/D-3 topology-authoring engine (visual canvas design-lock). Distinct from the G-2..G-5 edit
// modules (which edit a node's CONFIG): these PURE functions change graph STRUCTURE — add/remove
// nodes, bridge edges, add/remove condition+parallel branches — always emitting a well-formed
// `{ nodes, edges }` the backend `normalizeApprovalGraph` remains the sole arbiter of. No .vue import
// (runs under approval-web-guard). Anti-flatten: every untouched node/edge is deep-cloned verbatim, so
// an unrelated part of the graph is byte-identical after any op (proven in the test suite).

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Deterministic-ish unique key from a prefix + the existing keys (no Date.now/random — keeps tests stable). */
function uniqueKey(prefix: string, existing: Set<string>): string {
  let i = 1
  while (existing.has(`${prefix}_${i}`)) i += 1
  return `${prefix}_${i}`
}
function nodeKeys(graph: ApprovalGraph): Set<string> {
  return new Set(graph.nodes.map((n) => n.key))
}
function edgeKeys(graph: ApprovalGraph): Set<string> {
  return new Set(graph.edges.map((e) => e.key))
}

/** A default approval node config — a self-contained, backend-valid starter (requester approves). */
function defaultApprovalConfig() {
  return { assigneeSources: [{ kind: 'requester' as const }], approvalMode: 'single' as const, emptyAssigneePolicy: 'error' as const }
}

function outEdges(graph: ApprovalGraph, nodeKey: string): ApprovalEdge[] {
  return graph.edges.filter((e) => e.source === nodeKey)
}
function inEdges(graph: ApprovalGraph, nodeKey: string): ApprovalEdge[] {
  return graph.edges.filter((e) => e.target === nodeKey)
}

/**
 * Insert a new `approval` node immediately AFTER `afterNodeKey` on a LINEAR segment (the node must
 * have exactly one outgoing edge). The existing edge `after → target` becomes `after → new → target`.
 * Throws if `afterNodeKey` is missing or not a single-out linear point (the backend would reject an
 * ambiguous insert; we refuse it up front).
 */
export function appendApprovalNode(graph: ApprovalGraph, afterNodeKey: string, name = '审批'): ApprovalGraph {
  const after = graph.nodes.find((n) => n.key === afterNodeKey)
  if (!after) throw new Error(`appendApprovalNode: node ${afterNodeKey} not found`)
  const outs = outEdges(graph, afterNodeKey)
  if (outs.length !== 1) throw new Error(`appendApprovalNode: ${afterNodeKey} must have exactly one outgoing edge (has ${outs.length})`)
  const out = outs[0]
  const newKey = uniqueKey('approval', nodeKeys(graph))
  const eKeys = edgeKeys(graph)
  const e1 = uniqueKey('edge', eKeys); eKeys.add(e1)
  const newNode: ApprovalNode = { key: newKey, type: 'approval', name, config: defaultApprovalConfig() }
  return {
    nodes: [...graph.nodes.map(clone), newNode],
    edges: graph.edges.map((edge) => {
      if (edge.key !== out.key) return clone(edge)
      return { ...clone(edge), source: newKey } // out: new → target
    }).concat([{ key: e1, source: afterNodeKey, target: newKey }]), // after → new
  }
}

/**
 * Remove an `approval` or `cc` node that sits on a LINEAR segment (exactly one in-edge + one
 * out-edge), bridging `pred → succ`. Refuses to remove start/end/condition/parallel or a branching
 * node (ambiguous rewire) — those go through branch ops or are structural anchors.
 */
export function removeLinearNode(graph: ApprovalGraph, nodeKey: string): ApprovalGraph {
  const node = graph.nodes.find((n) => n.key === nodeKey)
  if (!node) throw new Error(`removeLinearNode: node ${nodeKey} not found`)
  if (node.type !== 'approval' && node.type !== 'cc') throw new Error(`removeLinearNode: ${nodeKey} is ${node.type}, only approval/cc removable here`)
  const ins = inEdges(graph, nodeKey)
  const outs = outEdges(graph, nodeKey)
  if (ins.length !== 1 || outs.length !== 1) throw new Error(`removeLinearNode: ${nodeKey} must be single-in/single-out (in=${ins.length} out=${outs.length})`)
  const pred = ins[0].source
  const succ = outs[0].target
  const removedEdgeKeys = new Set([ins[0].key, outs[0].key])
  const eKeys = new Set(graph.edges.filter((e) => !removedEdgeKeys.has(e.key)).map((e) => e.key))
  const bridge = uniqueKey('edge', eKeys)
  return {
    nodes: graph.nodes.filter((n) => n.key !== nodeKey).map(clone),
    edges: graph.edges.filter((e) => !removedEdgeKeys.has(e.key)).map(clone).concat([{ key: bridge, source: pred, target: succ }]),
  }
}

/**
 * Add a parallel branch: a fresh approval node forked from `parallelNodeKey` and joined at the
 * parallel's `joinNodeKey`, appending the new fork edge to the parallel node's `branches`.
 */
export function addParallelBranch(graph: ApprovalGraph, parallelNodeKey: string, name = '并行审批'): ApprovalGraph {
  const node = graph.nodes.find((n) => n.key === parallelNodeKey)
  if (!node || node.type !== 'parallel') throw new Error(`addParallelBranch: ${parallelNodeKey} is not a parallel node`)
  const config = clone(node.config) as ParallelNodeConfig
  const newNodeKey = uniqueKey('approval', nodeKeys(graph))
  const eKeys = edgeKeys(graph)
  const forkEdge = uniqueKey('edge', eKeys); eKeys.add(forkEdge)
  const joinEdge = uniqueKey('edge', eKeys)
  const newNode: ApprovalNode = { key: newNodeKey, type: 'approval', name, config: defaultApprovalConfig() }
  return {
    nodes: graph.nodes.map((n) => (n.key === parallelNodeKey ? { ...clone(n), config: { ...config, branches: [...config.branches, forkEdge] } } : clone(n))).concat([newNode]),
    edges: [
      ...graph.edges.map(clone),
      { key: forkEdge, source: parallelNodeKey, target: newNodeKey },
      { key: joinEdge, source: newNodeKey, target: config.joinNodeKey },
    ],
  }
}

/**
 * Remove a parallel branch by its fork-edge key: drops the fork edge, its target node, and that
 * node's edge to the join. Refuses to drop below 2 branches (a parallel needs ≥2 to be meaningful;
 * the backend would otherwise want it collapsed — kept as an explicit FE guard).
 */
export function removeParallelBranch(graph: ApprovalGraph, parallelNodeKey: string, forkEdgeKey: string): ApprovalGraph {
  const node = graph.nodes.find((n) => n.key === parallelNodeKey)
  if (!node || node.type !== 'parallel') throw new Error(`removeParallelBranch: ${parallelNodeKey} is not a parallel node`)
  const config = clone(node.config) as ParallelNodeConfig
  if (!config.branches.includes(forkEdgeKey)) throw new Error(`removeParallelBranch: ${forkEdgeKey} not a branch of ${parallelNodeKey}`)
  if (config.branches.length <= 2) throw new Error('removeParallelBranch: a parallel node must keep at least 2 branches')
  const forkEdge = graph.edges.find((e) => e.key === forkEdgeKey)!
  const branchNodeKey = forkEdge.target
  const branchOutEdges = new Set(outEdges(graph, branchNodeKey).map((e) => e.key))
  const dropEdges = new Set([forkEdgeKey, ...branchOutEdges])
  return {
    nodes: graph.nodes.filter((n) => n.key !== branchNodeKey).map((n) => (n.key === parallelNodeKey ? { ...clone(n), config: { ...config, branches: config.branches.filter((b) => b !== forkEdgeKey) } } : clone(n))),
    edges: graph.edges.filter((e) => !dropEdges.has(e.key)).map(clone),
  }
}

/**
 * Add a condition branch: a fresh edge from `conditionNodeKey` to a new approval target, plus a new
 * `branches[]` entry (empty rules — the admin fills the rule via the G-2 editor). The new target then
 * flows to the same node the condition's default edge targets (so the branch is reachable + joins back).
 */
export function addConditionBranch(graph: ApprovalGraph, conditionNodeKey: string, name = '条件分支'): ApprovalGraph {
  const node = graph.nodes.find((n) => n.key === conditionNodeKey)
  if (!node || node.type !== 'condition') throw new Error(`addConditionBranch: ${conditionNodeKey} is not a condition node`)
  const config = clone(node.config) as ConditionNodeConfig
  // the new branch target rejoins wherever the default edge goes (a safe, reachable default)
  const defaultEdge = graph.edges.find((e) => e.key === config.defaultEdgeKey)
  const rejoinTarget = defaultEdge?.target ?? graph.nodes.find((n) => n.type === 'end')?.key
  if (!rejoinTarget) throw new Error('addConditionBranch: no default edge / end node to rejoin')
  const newNodeKey = uniqueKey('approval', nodeKeys(graph))
  const eKeys = edgeKeys(graph)
  const branchEdge = uniqueKey('edge', eKeys); eKeys.add(branchEdge)
  const rejoinEdge = uniqueKey('edge', eKeys)
  const newNode: ApprovalNode = { key: newNodeKey, type: 'approval', name, config: defaultApprovalConfig() }
  return {
    nodes: graph.nodes.map((n) => (n.key === conditionNodeKey ? { ...clone(n), config: { ...config, branches: [...config.branches, { edgeKey: branchEdge, rules: [] }] } } : clone(n))).concat([newNode]),
    edges: [
      ...graph.edges.map(clone),
      { key: branchEdge, source: conditionNodeKey, target: newNodeKey },
      { key: rejoinEdge, source: newNodeKey, target: rejoinTarget },
    ],
  }
}

/** Remove a condition branch by edgeKey: drops the branch entry, its edge, the target node + the target's out-edges. Keeps the default edge intact. */
export function removeConditionBranch(graph: ApprovalGraph, conditionNodeKey: string, edgeKey: string): ApprovalGraph {
  const node = graph.nodes.find((n) => n.key === conditionNodeKey)
  if (!node || node.type !== 'condition') throw new Error(`removeConditionBranch: ${conditionNodeKey} is not a condition node`)
  const config = clone(node.config) as ConditionNodeConfig
  if (config.defaultEdgeKey === edgeKey) throw new Error('removeConditionBranch: cannot remove the default (fall-through) edge')
  if (!config.branches.some((b) => b.edgeKey === edgeKey)) throw new Error(`removeConditionBranch: ${edgeKey} not a branch of ${conditionNodeKey}`)
  const branchEdge = graph.edges.find((e) => e.key === edgeKey)!
  const targetKey = branchEdge.target
  const targetOut = new Set(outEdges(graph, targetKey).map((e) => e.key))
  const dropEdges = new Set([edgeKey, ...targetOut])
  return {
    nodes: graph.nodes.filter((n) => n.key !== targetKey).map((n) => (n.key === conditionNodeKey ? { ...clone(n), config: { ...config, branches: config.branches.filter((b) => b.edgeKey !== edgeKey) } } : clone(n))),
    edges: graph.edges.filter((e) => !dropEdges.has(e.key)).map(clone),
  }
}
