import type {
  ApprovalEdge,
  ApprovalGraph,
  ApprovalNode,
  ConditionNodeConfig,
  ParallelNodeConfig,
} from '../types/approval'
import { collectParallelRegionNodeKeys, hasEmptyParallelBranch } from './graphTopologyEdit'

// Canvas V2 D2-b — pure move / reorder / undo command algebra.
// ApprovalGraph remains the sole persisted model (no coordinates). Mutations reuse the D2-a
// topology invariants (linear single-in/out, parallel-region nesting, condition default edge)
// and never invent runtime semantics beyond what graphTopologyEdit already encodes.

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function outEdges(graph: ApprovalGraph, nodeKey: string): ApprovalEdge[] {
  return graph.edges.filter((edge) => edge.source === nodeKey)
}

function inEdges(graph: ApprovalGraph, nodeKey: string): ApprovalEdge[] {
  return graph.edges.filter((edge) => edge.target === nodeKey)
}

function findNode(graph: ApprovalGraph, nodeKey: string): ApprovalNode | undefined {
  return graph.nodes.find((node) => node.key === nodeKey)
}

function findEdge(graph: ApprovalGraph, edgeKey: string): ApprovalEdge | undefined {
  return graph.edges.find((edge) => edge.key === edgeKey)
}

function edgeKeyCounts(graph: ApprovalGraph): Map<string, number> {
  const counts = new Map<string, number>()
  for (const edge of graph.edges) {
    counts.set(edge.key, (counts.get(edge.key) ?? 0) + 1)
  }
  return counts
}

/** True when following directed edges from `startKey` can reach `targetKey`. */
function canReach(graph: ApprovalGraph, startKey: string, targetKey: string): boolean {
  if (startKey === targetKey) return true
  const seen = new Set<string>()
  const queue = [startKey]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (seen.has(current)) continue
    seen.add(current)
    for (const edge of outEdges(graph, current)) {
      if (edge.target === targetKey) return true
      if (!seen.has(edge.target)) queue.push(edge.target)
    }
  }
  return false
}

function graphHasCycle(graph: ApprovalGraph): boolean {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const dfs = (key: string): boolean => {
    if (visiting.has(key)) return true
    if (visited.has(key)) return false
    visiting.add(key)
    for (const edge of outEdges(graph, key)) {
      if (dfs(edge.target)) return true
    }
    visiting.delete(key)
    visited.add(key)
    return false
  }
  for (const node of graph.nodes) {
    if (dfs(node.key)) return true
  }
  return false
}

/** A parallel node key appears strictly inside another parallel's branch region. */
function hasNestedParallel(graph: ApprovalGraph): boolean {
  const region = collectParallelRegionNodeKeys(graph)
  return graph.nodes.some((node) => node.type === 'parallel' && region.has(node.key))
}

function isEdgeInsideParallelRegion(graph: ApprovalGraph, edge: ApprovalEdge): boolean {
  const region = collectParallelRegionNodeKeys(graph)
  // Fork edges leave the parallel gateway (not in region); join edges enter the join (not in region).
  // An edge is "inside" when its source is a region member (branch body / deeper path).
  return region.has(edge.source)
}

// ── Selection / command / result types ─────────────────────────────────────────

export type ApprovalCanvasSelection =
  | { kind: 'none' }
  | { kind: 'node'; nodeKey: string }
  | { kind: 'edge'; edgeKey: string }
  | { kind: 'condition-branch'; conditionNodeKey: string; edgeKey: string }
  | { kind: 'parallel-branch'; parallelNodeKey: string; edgeKey: string }

export type ApprovalCanvasCommand =
  | { type: 'move-node-into-edge'; nodeKey: string; intoEdgeKey: string }
  | {
      type: 'reorder-condition-branches'
      conditionNodeKey: string
      /** Full permutation of the condition's non-default branch edge keys (priority order). */
      orderedEdgeKeys: string[]
    }
  | {
      type: 'reorder-parallel-branches'
      parallelNodeKey: string
      /** Full permutation of the parallel's fork edge keys. */
      orderedEdgeKeys: string[]
    }

export type ApprovalCanvasCommandErrorCode =
  | 'node-not-found'
  | 'edge-not-found'
  | 'unsupported-node-type'
  | 'not-linear'
  | 'self-slot'
  | 'adjacent-slot'
  | 'ambiguous-slot'
  | 'cycle'
  | 'nested-parallel-invalid'
  | 'empty-parallel-branch'
  | 'invalid-branch-order'
  | 'default-edge-immutable'
  | 'unknown-command'
  | 'empty-history'

export interface ApprovalCanvasCommandError {
  code: ApprovalCanvasCommandErrorCode
  message: string
}

export type ApprovalCanvasCommandSuccess = {
  ok: true
  graph: ApprovalGraph
  inverse: ApprovalCanvasCommand
  selectionBefore: ApprovalCanvasSelection
  selectionAfter: ApprovalCanvasSelection
}

export type ApprovalCanvasCommandFailure = {
  ok: false
  error: ApprovalCanvasCommandError
}

export type ApprovalCanvasCommandResult = ApprovalCanvasCommandSuccess | ApprovalCanvasCommandFailure

export interface ApprovalCanvasHistoryEntry {
  command: ApprovalCanvasCommand
  inverse: ApprovalCanvasCommand
  selectionBefore: ApprovalCanvasSelection
  selectionAfter: ApprovalCanvasSelection
}

export interface ApprovalCanvasHistory {
  graph: ApprovalGraph
  selection: ApprovalCanvasSelection
  undoStack: ApprovalCanvasHistoryEntry[]
  redoStack: ApprovalCanvasHistoryEntry[]
}

function fail(code: ApprovalCanvasCommandErrorCode, message: string): ApprovalCanvasCommandFailure {
  return { ok: false, error: { code, message } }
}

/** True when `b` is an exact multiset permutation of `a` (same keys, same multiplicities). */
function isPermutation(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const counts = new Map<string, number>()
  for (const key of a) counts.set(key, (counts.get(key) ?? 0) + 1)
  for (const key of b) {
    const next = (counts.get(key) ?? 0) - 1
    if (next < 0) return false
    counts.set(key, next)
  }
  return true
}

// ── Move: approval/cc linear node → edge slot ──────────────────────────────────

/**
 * Semantic move of a single-in/single-out approval/cc node into a linear edge slot.
 * Edge identities: the node's original out-edge key is reused as the new M→target edge;
 * the into-edge keeps its key and becomes source→M. Inverse is always
 * `move-node-into-edge` onto the original in-edge key (the bridged pred→succ edge).
 */
function executeMoveNodeIntoEdge(
  graph: ApprovalGraph,
  nodeKey: string,
  intoEdgeKey: string,
  selectionBefore: ApprovalCanvasSelection,
): ApprovalCanvasCommandResult {
  const node = findNode(graph, nodeKey)
  if (!node) return fail('node-not-found', `move: node ${nodeKey} not found`)

  if (node.type === 'start' || node.type === 'end' || node.type === 'condition') {
    return fail('unsupported-node-type', `move: ${node.type} nodes cannot be moved`)
  }
  if (node.type === 'parallel') {
    // Parallel gateways never move; a destination inside a parallel region is the nested-parallel
    // placement the engine would reject for nested forks (mirrors insertParallelGateway F4).
    const intoEdge = findEdge(graph, intoEdgeKey)
    if (intoEdge && isEdgeInsideParallelRegion(graph, intoEdge)) {
      return fail(
        'nested-parallel-invalid',
        `move: cannot place parallel ${nodeKey} inside a parallel branch`,
      )
    }
    return fail('unsupported-node-type', `move: parallel nodes cannot be moved`)
  }
  if (node.type !== 'approval' && node.type !== 'cc') {
    return fail('unsupported-node-type', `move: ${String(node.type)} nodes cannot be moved`)
  }

  const ins = inEdges(graph, nodeKey)
  const outs = outEdges(graph, nodeKey)
  if (ins.length !== 1 || outs.length !== 1) {
    return fail(
      'not-linear',
      `move: ${nodeKey} must be single-in/single-out (in=${ins.length} out=${outs.length})`,
    )
  }

  const inEdge = ins[0]
  const outEdge = outs[0]
  // Fail-closed: move rewires/drops edges by key. A non-unique origin in-key, origin out-key,
  // or destination key would remove/retarget every edge sharing that key — reject all three.
  const counts = edgeKeyCounts(graph)
  const ambiguousKey = [inEdge.key, outEdge.key, intoEdgeKey].find((key) => (counts.get(key) ?? 0) > 1)
  if (ambiguousKey !== undefined) {
    return fail('ambiguous-slot', `move: edge key ${ambiguousKey} is ambiguous (duplicate keys)`)
  }

  const intoEdge = findEdge(graph, intoEdgeKey)
  if (!intoEdge) return fail('edge-not-found', `move: edge ${intoEdgeKey} not found`)

  // Self: either incident edge of the moved node.
  if (intoEdgeKey === outEdge.key) {
    return fail('self-slot', `move: ${intoEdgeKey} is the out-edge of ${nodeKey}`)
  }
  if (intoEdgeKey === inEdge.key) {
    return fail('self-slot', `move: ${intoEdgeKey} is the in-edge of ${nodeKey}`)
  }

  // Adjacent: into-edge is currently pred→succ of a neighbor that is already the other endpoint
  // of M (i.e. the edge we would create by bridging — but that edge is `in` after remove, not yet).
  // Also treat the direct edge between M's successor and … when into is out's "next" with no other
  // node — the structural no-op after detach+attach on the bridge is rejected via post-equality,
  // but the classic adjacent case is: intoEdge connects pred→succ already as a *different* edge
  // (multi-edge). For the linear spine, the only no-op restore is moving onto the bridge which
  // does not exist as a separate edge until detach. Reject when intoEdge is outEdge.target's only
  // structural identity with inEdge — covered by self on in/out.
  //
  // Adjacent in product terms: dropping on the slot immediately before/after the node on the same
  // linear segment (the two incident edges) — already self-slot. Also: intoEdge.source === nodeKey
  // or intoEdge.target === nodeKey (any residual multi-edge incident).
  if (intoEdge.source === nodeKey || intoEdge.target === nodeKey) {
    return fail('adjacent-slot', `move: ${intoEdgeKey} is adjacent to ${nodeKey}`)
  }

  // Build the next graph without mutating the input.
  const nextNodes = graph.nodes.map(clone)
  const succ = outEdge.target
  const nextEdges: ApprovalEdge[] = []
  for (const edge of graph.edges) {
    if (edge.key === outEdge.key) continue // drop; reused after into-edge
    if (edge.key === inEdge.key) {
      nextEdges.push({ ...clone(edge), target: succ }) // bridge pred → succ
      continue
    }
    if (edge.key === intoEdge.key) {
      // Split: into becomes source → M; reuse outEdge key for M → original target.
      nextEdges.push({ ...clone(edge), target: nodeKey })
      nextEdges.push({ key: outEdge.key, source: nodeKey, target: intoEdge.target })
      continue
    }
    nextEdges.push(clone(edge))
  }

  const nextGraph: ApprovalGraph = { nodes: nextNodes, edges: nextEdges }

  if (graphHasCycle(nextGraph)) {
    return fail('cycle', `move: placing ${nodeKey} on ${intoEdgeKey} would create a cycle`)
  }
  if (hasNestedParallel(nextGraph)) {
    return fail(
      'nested-parallel-invalid',
      `move: placing ${nodeKey} on ${intoEdgeKey} would nest a parallel gateway`,
    )
  }
  if (hasEmptyParallelBranch(nextGraph)) {
    return fail(
      'empty-parallel-branch',
      'move: a parallel branch must keep at least one body node',
    )
  }

  // Reachability sanity: after insert, M must be reachable from the into-edge source and able to
  // reach the original into target (structural integrity of the slot).
  if (!canReach(nextGraph, intoEdge.source, nodeKey) || !canReach(nextGraph, nodeKey, intoEdge.target)) {
    return fail('ambiguous-slot', `move: ${intoEdgeKey} is not a valid linear insertion slot for ${nodeKey}`)
  }

  const inverse: ApprovalCanvasCommand = {
    type: 'move-node-into-edge',
    nodeKey,
    intoEdgeKey: inEdge.key,
  }

  return {
    ok: true,
    graph: nextGraph,
    inverse,
    selectionBefore,
    selectionAfter: { kind: 'node', nodeKey },
  }
}

// ── Branch reorder ─────────────────────────────────────────────────────────────

function executeReorderConditionBranches(
  graph: ApprovalGraph,
  conditionNodeKey: string,
  orderedEdgeKeys: string[],
  selectionBefore: ApprovalCanvasSelection,
): ApprovalCanvasCommandResult {
  const node = findNode(graph, conditionNodeKey)
  if (!node) return fail('node-not-found', `reorder-condition: node ${conditionNodeKey} not found`)
  if (node.type !== 'condition') {
    return fail('unsupported-node-type', `reorder-condition: ${conditionNodeKey} is not a condition node`)
  }

  const config = clone(node.config) as ConditionNodeConfig
  const currentKeys = config.branches.map((branch) => branch.edgeKey)
  // Fail-closed before Map: duplicate edgeKey values would collapse distinct branch objects
  // (last-write-wins) and silently drop rules that share a corrupt key.
  if (new Set(currentKeys).size !== currentKeys.length) {
    return fail(
      'invalid-branch-order',
      `reorder-condition: condition ${conditionNodeKey} has duplicate branch edge keys`,
    )
  }
  if (config.defaultEdgeKey && orderedEdgeKeys.includes(config.defaultEdgeKey)) {
    return fail(
      'default-edge-immutable',
      `reorder-condition: default edge ${config.defaultEdgeKey} cannot be reordered as a branch`,
    )
  }
  if (!isPermutation(currentKeys, orderedEdgeKeys)) {
    return fail(
      'invalid-branch-order',
      `reorder-condition: orderedEdgeKeys must be a permutation of existing branch edge keys`,
    )
  }
  // No-op order still succeeds with an inverse that restores the same order (explicit algebra).
  const byKey = new Map(config.branches.map((branch) => [branch.edgeKey, branch]))
  const reordered = orderedEdgeKeys.map((key) => clone(byKey.get(key)!))

  const nextGraph: ApprovalGraph = {
    nodes: graph.nodes.map((candidate) => {
      if (candidate.key !== conditionNodeKey) return clone(candidate)
      return {
        ...clone(candidate),
        config: { ...config, branches: reordered },
      }
    }),
    edges: graph.edges.map(clone),
  }

  const inverse: ApprovalCanvasCommand = {
    type: 'reorder-condition-branches',
    conditionNodeKey,
    orderedEdgeKeys: currentKeys,
  }

  return {
    ok: true,
    graph: nextGraph,
    inverse,
    selectionBefore,
    selectionAfter: {
      kind: 'condition-branch',
      conditionNodeKey,
      edgeKey: orderedEdgeKeys[0] ?? currentKeys[0]!,
    },
  }
}

function executeReorderParallelBranches(
  graph: ApprovalGraph,
  parallelNodeKey: string,
  orderedEdgeKeys: string[],
  selectionBefore: ApprovalCanvasSelection,
): ApprovalCanvasCommandResult {
  const node = findNode(graph, parallelNodeKey)
  if (!node) return fail('node-not-found', `reorder-parallel: node ${parallelNodeKey} not found`)
  if (node.type !== 'parallel') {
    return fail('unsupported-node-type', `reorder-parallel: ${parallelNodeKey} is not a parallel node`)
  }

  const config = clone(node.config) as ParallelNodeConfig
  const currentKeys = [...config.branches]
  if (!isPermutation(currentKeys, orderedEdgeKeys)) {
    return fail(
      'invalid-branch-order',
      `reorder-parallel: orderedEdgeKeys must be a permutation of existing branch edge keys`,
    )
  }

  // Preserve edge objects byte-for-byte; only the branches[] order (display / authoring order) changes.
  const nextGraph: ApprovalGraph = {
    nodes: graph.nodes.map((candidate) => {
      if (candidate.key !== parallelNodeKey) return clone(candidate)
      return {
        ...clone(candidate),
        config: { ...config, branches: [...orderedEdgeKeys] },
      }
    }),
    edges: graph.edges.map(clone),
  }

  const inverse: ApprovalCanvasCommand = {
    type: 'reorder-parallel-branches',
    parallelNodeKey,
    orderedEdgeKeys: currentKeys,
  }

  return {
    ok: true,
    graph: nextGraph,
    inverse,
    selectionBefore,
    selectionAfter: {
      kind: 'parallel-branch',
      parallelNodeKey,
      edgeKey: orderedEdgeKeys[0] ?? currentKeys[0]!,
    },
  }
}

/**
 * Apply one typed canvas command to a graph. Pure: never mutates `graph`.
 * On failure the caller must treat the input graph as unchanged (this function
 * does not return a graph on failure).
 */
export function executeApprovalCanvasCommand(
  graph: ApprovalGraph,
  command: ApprovalCanvasCommand,
  selectionBefore: ApprovalCanvasSelection = { kind: 'none' },
): ApprovalCanvasCommandResult {
  switch (command.type) {
    case 'move-node-into-edge':
      return executeMoveNodeIntoEdge(graph, command.nodeKey, command.intoEdgeKey, selectionBefore)
    case 'reorder-condition-branches':
      return executeReorderConditionBranches(
        graph,
        command.conditionNodeKey,
        command.orderedEdgeKeys,
        selectionBefore,
      )
    case 'reorder-parallel-branches':
      return executeReorderParallelBranches(
        graph,
        command.parallelNodeKey,
        command.orderedEdgeKeys,
        selectionBefore,
      )
    default: {
      const _exhaustive: never = command
      return fail('unknown-command', `unknown command: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

// ── History: apply / undo / redo ───────────────────────────────────────────────

export function createApprovalCanvasHistory(
  graph: ApprovalGraph,
  selection: ApprovalCanvasSelection = { kind: 'none' },
): ApprovalCanvasHistory {
  return {
    graph: clone(graph),
    selection: clone(selection),
    undoStack: [],
    redoStack: [],
  }
}

export type ApprovalCanvasHistoryResult =
  | { ok: true; history: ApprovalCanvasHistory }
  | { ok: false; error: ApprovalCanvasCommandError; history: ApprovalCanvasHistory }

/**
 * Apply a command onto the history. Success pushes an undo entry and clears redo.
 * Failure returns the same history object reference (byte-identical graph + stacks).
 */
export function applyApprovalCanvasCommand(
  history: ApprovalCanvasHistory,
  command: ApprovalCanvasCommand,
  selectionBefore: ApprovalCanvasSelection = history.selection,
): ApprovalCanvasHistoryResult {
  const result = executeApprovalCanvasCommand(history.graph, command, selectionBefore)
  if (!result.ok) {
    return { ok: false, error: result.error, history }
  }
  const entry: ApprovalCanvasHistoryEntry = {
    command: clone(command),
    inverse: clone(result.inverse),
    selectionBefore: clone(result.selectionBefore),
    selectionAfter: clone(result.selectionAfter),
  }
  return {
    ok: true,
    history: {
      graph: result.graph,
      selection: result.selectionAfter,
      undoStack: [...history.undoStack, entry],
      redoStack: [],
    },
  }
}

/** Undo the last command; restores graph and selectionBefore. Failure leaves history identical. */
export function undoApprovalCanvasCommand(history: ApprovalCanvasHistory): ApprovalCanvasHistoryResult {
  if (history.undoStack.length === 0) {
    return {
      ok: false,
      error: { code: 'empty-history', message: 'undo: nothing to undo' },
      history,
    }
  }
  const entry = history.undoStack[history.undoStack.length - 1]!
  const result = executeApprovalCanvasCommand(history.graph, entry.inverse, history.selection)
  if (!result.ok) {
    // Inverse should always apply; surface as failure without mutating history.
    return { ok: false, error: result.error, history }
  }
  return {
    ok: true,
    history: {
      graph: result.graph,
      selection: entry.selectionBefore,
      undoStack: history.undoStack.slice(0, -1),
      redoStack: [entry, ...history.redoStack],
    },
  }
}

/** Redo the last undone command. Failure leaves history identical. */
export function redoApprovalCanvasCommand(history: ApprovalCanvasHistory): ApprovalCanvasHistoryResult {
  if (history.redoStack.length === 0) {
    return {
      ok: false,
      error: { code: 'empty-history', message: 'redo: nothing to redo' },
      history,
    }
  }
  const entry = history.redoStack[0]!
  const result = executeApprovalCanvasCommand(history.graph, entry.command, entry.selectionBefore)
  if (!result.ok) {
    return { ok: false, error: result.error, history }
  }
  return {
    ok: true,
    history: {
      graph: result.graph,
      selection: entry.selectionAfter,
      undoStack: [...history.undoStack, entry],
      redoStack: history.redoStack.slice(1),
    },
  }
}
