import type { ApprovalGraph, ApprovalNode, ApprovalEdge, ConditionNodeConfig, ParallelNodeConfig } from '../types/approval'
import { APPROVAL_ROLE_CONFIGURE_SENTINEL } from '../types/approval'

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

export const EDGE_INSERTABLE_NODE_TYPES = ['approval', 'cc', 'condition', 'parallel'] as const
export type EdgeInsertableNodeType = typeof EDGE_INSERTABLE_NODE_TYPES[number]

export interface ApprovalEdgeInsertionTarget {
  edgeKey: string
  source: string
  target: string
  nodeTypes: EdgeInsertableNodeType[]
}

/** A default approval node config — a self-contained, backend-valid starter (requester approves). */
function defaultApprovalConfig() {
  return { assigneeSources: [{ kind: 'requester' as const }], approvalMode: 'single' as const, emptyAssigneePolicy: 'error' as const }
}

/**
 * Starter config for an ADDITIONAL parallel-branch approval node. Parallel branches must not share
 * an approver: two branches that resolve to the same user 409 EVERY request at fan-out
 * (`APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT`), so seeding every branch with the same
 * `requester` default would make the feature's untouched output fail 100% of the time — a
 * false-green (saves + publishes clean, dies at runtime). Instead the extra branch uses the
 * existing configure-before-publish machinery: the `static_role` placeholder sentinel that the
 * publish checklist surfaces and the backend fail-fasts on (`assertNoUnconfiguredPlaceholderRoles`)
 * — the draft saves, but the admin MUST pick a real approver before it can publish.
 */
function placeholderBranchApprovalConfig() {
  return {
    assigneeSources: [{ kind: 'static_role' as const, roleIds: [APPROVAL_ROLE_CONFIGURE_SENTINEL] }],
    approvalMode: 'single' as const,
    emptyAssigneePolicy: 'error' as const,
  }
}

function outEdges(graph: ApprovalGraph, nodeKey: string): ApprovalEdge[] {
  return graph.edges.filter((e) => e.source === nodeKey)
}
function inEdges(graph: ApprovalGraph, nodeKey: string): ApprovalEdge[] {
  return graph.edges.filter((e) => e.target === nodeKey)
}

function gatewayOwnedEdgeKeys(graph: ApprovalGraph): Set<string> {
  const keys = new Set<string>()
  for (const node of graph.nodes) {
    if (node.type === 'condition') {
      const config = node.config as ConditionNodeConfig
      for (const branch of config.branches ?? []) keys.add(branch.edgeKey)
      if (typeof config.defaultEdgeKey === 'string') keys.add(config.defaultEdgeKey)
    }
    if (node.type === 'parallel') {
      const config = node.config as ParallelNodeConfig
      for (const edgeKey of config.branches ?? []) keys.add(edgeKey)
    }
  }
  return keys
}

/**
 * Stable anchor for one maximal linear region. Walking upstream stops at either a gateway-owned
 * branch edge or the first node that is not single-in/single-out. Edges sharing this anchor belong
 * to the same path segment without crossing a condition/parallel fork or rejoin boundary.
 */
function linearRegionAnchorEdgeKey(graph: ApprovalGraph, edgeKey: string): string | undefined {
  const edgesByKey = new Map(graph.edges.map((edge) => [edge.key, edge]))
  const nodesByKey = new Map(graph.nodes.map((node) => [node.key, node]))
  const gatewayEdges = gatewayOwnedEdgeKeys(graph)
  let current = edgesByKey.get(edgeKey)
  const visited = new Set<string>()
  while (current && !visited.has(current.key)) {
    visited.add(current.key)
    const source = nodesByKey.get(current.source)
    if (!source) return undefined
    const ins = inEdges(graph, source.key)
    const outs = outEdges(graph, source.key)
    if (ins.length !== 1 || outs.length !== 1) return current.key
    const predecessor = ins[0]
    if (gatewayEdges.has(predecessor.key)) return predecessor.key
    current = predecessor
  }
  return undefined
}

export interface LinearNodeMoveTarget {
  edgeKey: string
  source: string
  target: string
}

/** Legal semantic drop slots for an approval/cc node, restricted to its current linear region. */
export function linearNodeMoveTargets(graph: ApprovalGraph, nodeKey: string): LinearNodeMoveTarget[] {
  const node = graph.nodes.find((candidate) => candidate.key === nodeKey)
  if (!node || (node.type !== 'approval' && node.type !== 'cc')) return []
  const ins = inEdges(graph, nodeKey)
  const outs = outEdges(graph, nodeKey)
  if (ins.length !== 1 || outs.length !== 1) return []
  const anchor = linearRegionAnchorEdgeKey(graph, ins[0].key)
  if (!anchor) return []
  const gatewayEdges = gatewayOwnedEdgeKeys(graph)
  return graph.edges
    .filter((edge) => edge.key !== ins[0].key && edge.key !== outs[0].key)
    .filter((edge) => !gatewayEdges.has(edge.key))
    .filter((edge) => linearRegionAnchorEdgeKey(graph, edge.key) === anchor)
    .map((edge) => ({ edgeKey: edge.key, source: edge.source, target: edge.target }))
}

/**
 * Move one single-in/single-out approval/cc node onto a legal edge in the same linear region.
 * Rewires exactly three existing edges and preserves every node/edge key:
 * `pred→node→succ` + `before→after` becomes `pred→succ` + `before→node→after`.
 */
export function moveLinearNode(graph: ApprovalGraph, nodeKey: string, targetEdgeKey: string): ApprovalGraph {
  const node = graph.nodes.find((candidate) => candidate.key === nodeKey)
  if (!node) throw new Error(`moveLinearNode: node ${nodeKey} not found`)
  if (node.type !== 'approval' && node.type !== 'cc') {
    throw new Error(`moveLinearNode: ${nodeKey} is ${node.type}, only approval/cc movable`)
  }
  const ins = inEdges(graph, nodeKey)
  const outs = outEdges(graph, nodeKey)
  if (ins.length !== 1 || outs.length !== 1) {
    throw new Error(`moveLinearNode: ${nodeKey} must be single-in/single-out (in=${ins.length} out=${outs.length})`)
  }
  const target = graph.edges.find((edge) => edge.key === targetEdgeKey)
  if (!target) throw new Error(`moveLinearNode: target edge ${targetEdgeKey} not found`)
  if (!linearNodeMoveTargets(graph, nodeKey).some((candidate) => candidate.edgeKey === targetEdgeKey)) {
    throw new Error(`moveLinearNode: target edge ${targetEdgeKey} is outside ${nodeKey}'s linear region`)
  }

  return {
    nodes: graph.nodes.map(clone),
    edges: graph.edges.map((edge) => {
      if (edge.key === ins[0].key) return { ...clone(edge), target: outs[0].target }
      if (edge.key === outs[0].key) return { ...clone(edge), target: target.target }
      if (edge.key === target.key) return { ...clone(edge), target: nodeKey }
      return clone(edge)
    }),
  }
}

/** Target edge for a one-step keyboard move, or undefined at a region boundary. */
export function adjacentLinearNodeMoveTarget(
  graph: ApprovalGraph,
  nodeKey: string,
  direction: 'up' | 'down',
): string | undefined {
  const ins = inEdges(graph, nodeKey)
  const outs = outEdges(graph, nodeKey)
  if (ins.length !== 1 || outs.length !== 1) return undefined
  const adjacentKey = direction === 'up' ? ins[0].source : outs[0].target
  const adjacent = graph.nodes.find((node) => node.key === adjacentKey)
  if (!adjacent || (adjacent.type !== 'approval' && adjacent.type !== 'cc')) return undefined
  const target = direction === 'up' ? inEdges(graph, adjacentKey)[0] : outEdges(graph, adjacentKey)[0]
  if (!target) return undefined
  return linearNodeMoveTargets(graph, nodeKey).some((candidate) => candidate.edgeKey === target.key)
    ? target.key
    : undefined
}

/**
 * Node keys strictly INSIDE any parallel region — every node on a branch path between a parallel
 * gateway and its `joinNodeKey` (join and gateway excluded). Mirrors the backend
 * `collectParallelRegionNodeKeys` (ApprovalProductService.ts). Used to prevent authoring a NESTED
 * parallel: the backend rejects it at save ("cannot contain nested parallel node"), and the canvas
 * lock says the canvas must not offer a shape the engine rejects. Condition-in-parallel stays legal.
 */
export function collectParallelRegionNodeKeys(graph: ApprovalGraph): Set<string> {
  const regionNodeKeys = new Set<string>()
  for (const node of graph.nodes) {
    if (node.type !== 'parallel') continue
    const config = node.config as ParallelNodeConfig
    const joinNodeKey = typeof config.joinNodeKey === 'string' ? config.joinNodeKey : null
    const branchEdgeKeys = Array.isArray(config.branches)
      ? config.branches.filter((entry): entry is string => typeof entry === 'string')
      : []
    for (const branchEdgeKey of branchEdgeKeys) {
      const edge = graph.edges.find((candidate) => candidate.key === branchEdgeKey)
      if (!edge) continue
      const queue = [edge.target]
      const visited = new Set<string>()
      while (queue.length > 0) {
        const nodeKey = queue.shift()!
        if (nodeKey === joinNodeKey || visited.has(nodeKey)) continue
        visited.add(nodeKey)
        regionNodeKeys.add(nodeKey)
        for (const out of outEdges(graph, nodeKey)) queue.push(out.target)
      }
    }
  }
  return regionNodeKeys
}

function graphHasUniqueKeysAndBoundEdges(graph: ApprovalGraph): boolean {
  const nodeKeySet = nodeKeys(graph)
  const edgeKeySet = edgeKeys(graph)
  if (nodeKeySet.size !== graph.nodes.length || edgeKeySet.size !== graph.edges.length) return false
  return graph.edges.every((edge) =>
    edge.key.trim().length > 0
    && nodeKeySet.has(edge.source)
    && nodeKeySet.has(edge.target)
    && edge.source !== edge.target)
}

function everyParallelBranchPathReachesJoin(
  graph: ApprovalGraph,
  branchStartKey: string,
  joinNodeKey: string,
): boolean {
  const nodeByKey = new Map(graph.nodes.map((node) => [node.key, node]))
  const successors = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const targets = successors.get(edge.source) ?? []
    targets.push(edge.target)
    successors.set(edge.source, targets)
  }
  const memo = new Map<string, boolean>()
  const visiting = new Set<string>()
  const reachesJoin = (nodeKey: string): boolean => {
    if (nodeKey === joinNodeKey) return true
    const cached = memo.get(nodeKey)
    if (cached !== undefined) return cached
    const node = nodeByKey.get(nodeKey)
    if (!node || node.type === 'end' || node.type === 'parallel' || visiting.has(nodeKey)) {
      return false
    }
    const targets = successors.get(nodeKey) ?? []
    if (targets.length === 0) return false
    visiting.add(nodeKey)
    const result = targets.every(reachesJoin)
    visiting.delete(nodeKey)
    memo.set(nodeKey, result)
    return result
  }
  return reachesJoin(branchStartKey)
}

/**
 * Edge insertion is only safe when the existing graph is one closed DAG. This belongs in the pure
 * topology engine: renderers receive an already-filtered target list and never infer graph legality
 * themselves.
 */
function graphCanAcceptEdgeInsertion(graph: ApprovalGraph): boolean {
  if (!graphHasUniqueKeysAndBoundEdges(graph) || hasEmptyParallelBranch(graph)) return false
  const starts = graph.nodes.filter((node) => node.type === 'start')
  const ends = graph.nodes.filter((node) => node.type === 'end')
  if (starts.length !== 1 || ends.length !== 1) return false

  const incoming = new Map(graph.nodes.map((node) => [node.key, 0]))
  const outgoing = new Map(graph.nodes.map((node) => [node.key, 0]))
  const successors = new Map<string, string[]>()
  for (const edge of graph.edges) {
    incoming.set(edge.target, incoming.get(edge.target)! + 1)
    outgoing.set(edge.source, outgoing.get(edge.source)! + 1)
    const targets = successors.get(edge.source) ?? []
    targets.push(edge.target)
    successors.set(edge.source, targets)
  }
  for (const node of graph.nodes) {
    if ((node.type === 'start') !== (incoming.get(node.key) === 0)) return false
    if ((node.type === 'end') !== (outgoing.get(node.key) === 0)) return false
  }

  // With one zero-indegree start, Kahn visiting every node proves both acyclicity and reachability
  // from that start. The degree rule above makes the sole sink the end node.
  const remainingIncoming = new Map(incoming)
  const queue = [starts[0].key]
  let visited = 0
  while (queue.length > 0) {
    const current = queue.shift()!
    visited += 1
    for (const target of successors.get(current) ?? []) {
      const nextCount = remainingIncoming.get(target)! - 1
      remainingIncoming.set(target, nextCount)
      if (nextCount === 0) queue.push(target)
    }
  }
  if (visited !== graph.nodes.length) return false

  for (const node of graph.nodes) {
    if (node.type === 'condition') {
      const config = node.config && typeof node.config === 'object'
        ? node.config as ConditionNodeConfig
        : null
      const branchKeys = Array.isArray(config?.branches)
        ? config.branches
            .filter((branch) => (
              branch
              && typeof branch.edgeKey === 'string'
              && branch.edgeKey.trim().length > 0
              && Array.isArray(branch.rules)
            ))
            .map((branch) => branch.edgeKey)
        : []
      const defaultEdgeKey = config?.defaultEdgeKey
      const hasDefaultEdge = defaultEdgeKey !== undefined
      if (
        !config
        || !Array.isArray(config.branches)
        || branchKeys.length !== config.branches.length
        || (hasDefaultEdge && (typeof defaultEdgeKey !== 'string' || defaultEdgeKey.trim().length === 0))
        || ![...branchKeys, ...(typeof defaultEdgeKey === 'string' ? [defaultEdgeKey] : [])].every((edgeKey) =>
          graph.edges.some((edge) => edge.key === edgeKey && edge.source === node.key))
      ) return false
    }
    if (node.type === 'parallel') {
      const config = node.config && typeof node.config === 'object'
        ? node.config as ParallelNodeConfig
        : null
      if (
        !config
        || !Array.isArray(config.branches)
        || config.branches.length < 2
        || !config.branches.every((edgeKey) => typeof edgeKey === 'string' && edgeKey.trim().length > 0)
        || new Set(config.branches).size !== config.branches.length
        || (config.joinMode !== 'all' && config.joinMode !== 'any')
        || typeof config.joinNodeKey !== 'string'
        || config.joinNodeKey.trim().length === 0
        || !graph.nodes.some((candidate) => candidate.key === config.joinNodeKey)
        || !config.branches.every((edgeKey) =>
          graph.edges.some((edge) => edge.key === edgeKey && edge.source === node.key))
        || !config.branches.every((edgeKey) => {
          const branchEdge = graph.edges.find((edge) => edge.key === edgeKey && edge.source === node.key)
          return Boolean(branchEdge && everyParallelBranchPathReachesJoin(
            graph,
            branchEdge.target,
            config.joinNodeKey,
          ))
        })
      ) return false
    }
  }
  return true
}

/**
 * A branch insertion starts at the configured fork edge and ends at the edge entering the join.
 * `collectParallelRegionNodeKeys` intentionally excludes the fork itself, so both cases matter.
 */
function edgeIsInsideParallelBranch(graph: ApprovalGraph, edge: ApprovalEdge): boolean {
  if (collectParallelRegionNodeKeys(graph).has(edge.source)) return true
  return graph.nodes.some((node) =>
    node.type === 'parallel'
    && Array.isArray((node.config as ParallelNodeConfig).branches)
    && (node.config as ParallelNodeConfig).branches.includes(edge.key))
}

/**
 * Sole legality predicate for the edge insertion menu and the eventual write.
 *
 * Malformed, ambiguous and stale graph state produces no options. Nested parallel is excluded on
 * both fork and branch-body edges; approval, cc and condition remain legal there.
 */
export function edgeInsertionNodeTypes(
  graph: ApprovalGraph,
  edgeKey: string,
): EdgeInsertableNodeType[] {
  if (!graphCanAcceptEdgeInsertion(graph)) return []
  const matches = graph.edges.filter((edge) => edge.key === edgeKey)
  if (matches.length !== 1) return []
  const edge = matches[0]
  const source = graph.nodes.find((node) => node.key === edge.source)
  const target = graph.nodes.find((node) => node.key === edge.target)
  if (!source || !target || source.type === 'end' || target.type === 'start') return []
  return edgeIsInsideParallelBranch(graph, edge)
    ? ['approval', 'cc', 'condition']
    : [...EDGE_INSERTABLE_NODE_TYPES]
}

/** Every currently legal insertion slot, in stable graph edge order. */
export function approvalEdgeInsertionTargets(graph: ApprovalGraph): ApprovalEdgeInsertionTarget[] {
  return graph.edges.flatMap((edge) => {
    const nodeTypes = edgeInsertionNodeTypes(graph, edge.key)
    return nodeTypes.length > 0
      ? [{ edgeKey: edge.key, source: edge.source, target: edge.target, nodeTypes }]
      : []
  })
}

/**
 * True when a configured parallel fork edge enters its join directly. Such an empty branch has no
 * approval body and, under joinMode=any, can win immediately before sibling assignments exist.
 */
export function hasEmptyParallelBranch(graph: ApprovalGraph): boolean {
  for (const node of graph.nodes) {
    if (node.type !== 'parallel') continue
    const config = node.config && typeof node.config === 'object'
      ? node.config as ParallelNodeConfig
      : null
    if (!config) return true
    if (typeof config.joinNodeKey !== 'string' || !Array.isArray(config.branches)) return true
    for (const branchEdgeKey of config.branches) {
      if (typeof branchEdgeKey !== 'string') return true
      const edge = graph.edges.find((candidate) => candidate.key === branchEdgeKey)
      if (!edge || edge.source !== node.key || edge.target === config.joinNodeKey) return true
    }
  }
  return false
}

function removableSingleNodeBranch(
  graph: ApprovalGraph,
  gatewayNodeKey: string,
  branchEdgeKey: string,
  rejoinNodeKey: string,
  operation: string,
): { branchNodeKey: string; dropEdges: Set<string> } {
  const forkEdge = graph.edges.find((edge) => edge.key === branchEdgeKey)
  if (!forkEdge || forkEdge.source !== gatewayNodeKey || forkEdge.target === rejoinNodeKey) {
    throw new Error(`${operation}: branch must have one exclusive body node`)
  }
  const incoming = inEdges(graph, forkEdge.target)
  const outgoing = outEdges(graph, forkEdge.target)
  if (
    incoming.length !== 1
    || incoming[0].key !== branchEdgeKey
    || outgoing.length !== 1
    || outgoing[0].target !== rejoinNodeKey
  ) {
    throw new Error(`${operation}: complex or shared branch removal is not supported`)
  }
  return {
    branchNodeKey: forkEdge.target,
    dropEdges: new Set([branchEdgeKey, outgoing[0].key]),
  }
}

function reachableDistances(graph: ApprovalGraph, startKey: string): Map<string, number> {
  const distances = new Map<string, number>([[startKey, 0]])
  const queue = [startKey]
  while (queue.length > 0) {
    const current = queue.shift()!
    const distance = distances.get(current)!
    for (const edge of outEdges(graph, current)) {
      if (distances.has(edge.target)) continue
      distances.set(edge.target, distance + 1)
      queue.push(edge.target)
    }
  }
  return distances
}

/** Find the nearest node reachable from every current condition path. */
function conditionRejoinTarget(graph: ApprovalGraph, config: ConditionNodeConfig): string | undefined {
  const pathEdgeKeys = [...config.branches.map((branch) => branch.edgeKey), config.defaultEdgeKey]
  const pathTargets = pathEdgeKeys
    .map((edgeKey) => graph.edges.find((edge) => edge.key === edgeKey)?.target)
    .filter((target): target is string => Boolean(target))
  if (pathTargets.length !== pathEdgeKeys.length) return undefined
  const distances = pathTargets.map((target) => reachableDistances(graph, target))
  return graph.nodes
    .filter((node) => distances.every((path) => path.has(node.key)))
    .map((node) => ({
      key: node.key,
      maxDistance: Math.max(...distances.map((path) => path.get(node.key)!)),
      totalDistance: distances.reduce((sum, path) => sum + path.get(node.key)!, 0),
    }))
    .sort((a, b) => a.maxDistance - b.maxDistance || a.totalDistance - b.totalDistance)[0]?.key
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
 * Insert a condition gateway on a linear segment. The original `after → target` edge keeps its
 * identity and becomes `after → condition`; the gateway then owns one configurable branch and
 * one direct default branch, both rejoining at the original target.
 *
 * The starter rule is deliberately incomplete. The authoring validator blocks save until the
 * author selects a real form field, avoiding an empty AND branch that evaluates as always true.
 */
function insertConditionGatewayOnEdge(
  graph: ApprovalGraph,
  edgeKey: string,
  name: string,
): ApprovalGraph {
  if (!edgeInsertionNodeTypes(graph, edgeKey).includes('condition')) {
    throw new Error(`insertConditionGateway: edge ${edgeKey} is not a legal insertion slot`)
  }
  const originalOut = graph.edges.find((edge) => edge.key === edgeKey)!
  const nKeys = nodeKeys(graph)
  const conditionKey = uniqueKey('condition', nKeys)
  nKeys.add(conditionKey)
  const branchNodeKey = uniqueKey('approval', nKeys)
  nKeys.add(branchNodeKey)
  const defaultNodeKey = uniqueKey('approval', nKeys)
  const eKeys = edgeKeys(graph)
  const branchEdgeKey = uniqueKey('edge', eKeys)
  eKeys.add(branchEdgeKey)
  const defaultEdgeKey = uniqueKey('edge', eKeys)
  eKeys.add(defaultEdgeKey)
  const branchJoinEdgeKey = uniqueKey('edge', eKeys)
  eKeys.add(branchJoinEdgeKey)
  const defaultJoinEdgeKey = uniqueKey('edge', eKeys)

  const conditionNode: ApprovalNode = {
    key: conditionKey,
    type: 'condition',
    name,
    config: {
      branches: [{
        edgeKey: branchEdgeKey,
        conjunction: 'and',
        rules: [{ fieldId: '', operator: 'eq', value: '' }],
      }],
      defaultEdgeKey,
    },
  }
  const branchNode: ApprovalNode = {
    key: branchNodeKey,
    type: 'approval',
    name: '条件审批',
    config: defaultApprovalConfig(),
  }
  const defaultNode: ApprovalNode = {
    key: defaultNodeKey,
    type: 'approval',
    name: '默认审批',
    config: defaultApprovalConfig(),
  }

  return {
    nodes: [...graph.nodes.map(clone), conditionNode, branchNode, defaultNode],
    edges: graph.edges
      .map((edge) => edge.key === originalOut.key
        ? { ...clone(edge), target: conditionKey }
        : clone(edge))
      .concat([
        { key: branchEdgeKey, source: conditionKey, target: branchNodeKey },
        { key: defaultEdgeKey, source: conditionKey, target: defaultNodeKey },
        { key: branchJoinEdgeKey, source: branchNodeKey, target: originalOut.target },
        { key: defaultJoinEdgeKey, source: defaultNodeKey, target: originalOut.target },
      ]),
  }
}

export function insertConditionGateway(
  graph: ApprovalGraph,
  afterNodeKey: string,
  name = '条件分支',
): ApprovalGraph {
  const after = graph.nodes.find((node) => node.key === afterNodeKey)
  if (!after) throw new Error(`insertConditionGateway: node ${afterNodeKey} not found`)
  const outs = outEdges(graph, afterNodeKey)
  if (outs.length !== 1) {
    throw new Error(`insertConditionGateway: ${afterNodeKey} must have exactly one outgoing edge (has ${outs.length})`)
  }
  return insertConditionGatewayOnEdge(graph, outs[0].key, name)
}

function insertParallelGatewayOnEdge(
  graph: ApprovalGraph,
  edgeKey: string,
  name: string,
): ApprovalGraph {
  if (!edgeInsertionNodeTypes(graph, edgeKey).includes('parallel')) {
    throw new Error(`insertParallelGateway: edge ${edgeKey} is not a legal insertion slot`)
  }
  const originalOut = graph.edges.find((edge) => edge.key === edgeKey)!
  const nKeys = nodeKeys(graph)
  const parallelKey = uniqueKey('parallel', nKeys)
  nKeys.add(parallelKey)
  const branchOneKey = uniqueKey('approval', nKeys)
  nKeys.add(branchOneKey)
  const branchTwoKey = uniqueKey('approval', nKeys)
  const eKeys = edgeKeys(graph)
  const forkOneKey = uniqueKey('edge', eKeys)
  eKeys.add(forkOneKey)
  const forkTwoKey = uniqueKey('edge', eKeys)
  eKeys.add(forkTwoKey)
  const joinOneKey = uniqueKey('edge', eKeys)
  eKeys.add(joinOneKey)
  const joinTwoKey = uniqueKey('edge', eKeys)

  const parallelNode: ApprovalNode = {
    key: parallelKey,
    type: 'parallel',
    name,
    config: {
      branches: [forkOneKey, forkTwoKey],
      joinMode: 'all',
      joinNodeKey: originalOut.target,
    },
  }
  const branchOne: ApprovalNode = {
    key: branchOneKey,
    type: 'approval',
    name: '并行审批 1',
    config: defaultApprovalConfig(),
  }
  const branchTwo: ApprovalNode = {
    key: branchTwoKey,
    type: 'approval',
    name: '并行审批 2',
    // NOT defaultApprovalConfig(): requester×requester across the two starter branches would 409
    // every request at runtime — see placeholderBranchApprovalConfig.
    config: placeholderBranchApprovalConfig(),
  }

  return {
    nodes: [...graph.nodes.map(clone), parallelNode, branchOne, branchTwo],
    edges: graph.edges
      .map((edge) => edge.key === originalOut.key
        ? { ...clone(edge), target: parallelKey }
        : clone(edge))
      .concat([
        { key: forkOneKey, source: parallelKey, target: branchOneKey },
        { key: forkTwoKey, source: parallelKey, target: branchTwoKey },
        { key: joinOneKey, source: branchOneKey, target: originalOut.target },
        { key: joinTwoKey, source: branchTwoKey, target: originalOut.target },
      ]),
  }
}

/** Insert a two-branch parallel gateway on a linear segment, rejoining at the old target. */
export function insertParallelGateway(
  graph: ApprovalGraph,
  afterNodeKey: string,
  name = '并行分支',
): ApprovalGraph {
  const after = graph.nodes.find((node) => node.key === afterNodeKey)
  if (!after) throw new Error(`insertParallelGateway: node ${afterNodeKey} not found`)
  const outs = outEdges(graph, afterNodeKey)
  if (outs.length !== 1) {
    throw new Error(`insertParallelGateway: ${afterNodeKey} must have exactly one outgoing edge (has ${outs.length})`)
  }
  if (edgeIsInsideParallelBranch(graph, outs[0])) {
    throw new Error(`insertParallelGateway: ${afterNodeKey} is inside a parallel branch — nested parallel is not supported`)
  }
  return insertParallelGatewayOnEdge(graph, outs[0].key, name)
}

function insertLinearNodeOnEdge(
  graph: ApprovalGraph,
  edgeKey: string,
  node: ApprovalNode,
): ApprovalGraph {
  const originalEdge = graph.edges.find((edge) => edge.key === edgeKey)!
  const nextEdgeKey = uniqueKey('edge', edgeKeys(graph))
  return {
    nodes: [...graph.nodes.map(clone), node],
    edges: graph.edges
      .map((edge) => edge.key === edgeKey
        ? { ...clone(edge), target: node.key }
        : clone(edge))
      .concat([{ key: nextEdgeKey, source: node.key, target: originalEdge.target }]),
  }
}

/**
 * Insert one supported node type into an exact edge slot.
 *
 * The existing edge keeps its key/source and now targets the inserted node, preserving condition
 * and parallel branch references. The legality predicate is re-run here, so a menu intent that
 * became stale before activation cannot mutate the graph.
 */
export function insertNodeIntoEdge(
  graph: ApprovalGraph,
  edgeKey: string,
  nodeType: EdgeInsertableNodeType,
): ApprovalGraph {
  if (!edgeInsertionNodeTypes(graph, edgeKey).includes(nodeType)) {
    throw new Error(`insertNodeIntoEdge: ${nodeType} is not legal on edge ${edgeKey}`)
  }
  if (nodeType === 'condition') return insertConditionGatewayOnEdge(graph, edgeKey, '条件分支')
  if (nodeType === 'parallel') return insertParallelGatewayOnEdge(graph, edgeKey, '并行分支')

  const key = uniqueKey(nodeType, nodeKeys(graph))
  const node: ApprovalNode = nodeType === 'approval'
    ? { key, type: 'approval', name: '审批', config: defaultApprovalConfig() }
    : { key, type: 'cc', name: '抄送', config: { targetType: 'user', targetIds: [] } }
  return insertLinearNodeOnEdge(graph, edgeKey, node)
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
  const succ = outs[0].target
  for (const gateway of graph.nodes) {
    if (gateway.type !== 'parallel') continue
    const config = gateway.config as ParallelNodeConfig
    if (
      Array.isArray(config.branches)
      && config.branches.includes(ins[0].key)
      && succ === config.joinNodeKey
    ) {
      throw new Error('removeLinearNode: a parallel branch must keep at least one body node')
    }
  }
  return {
    nodes: graph.nodes.filter((n) => n.key !== nodeKey).map(clone),
    edges: graph.edges
      .filter((edge) => edge.key !== outs[0].key)
      .map((edge) => edge.key === ins[0].key ? { ...clone(edge), target: succ } : clone(edge)),
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
  // Placeholder starter, not requester: a concrete dynamic default could silently duplicate an
  // existing branch's approver (100% runtime 409) — see placeholderBranchApprovalConfig.
  const newNode: ApprovalNode = { key: newNodeKey, type: 'approval', name, config: placeholderBranchApprovalConfig() }
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
  const { branchNodeKey, dropEdges } = removableSingleNodeBranch(
    graph,
    parallelNodeKey,
    forkEdgeKey,
    config.joinNodeKey,
    'removeParallelBranch',
  )
  return {
    nodes: graph.nodes.filter((n) => n.key !== branchNodeKey).map((n) => (n.key === parallelNodeKey ? { ...clone(n), config: { ...config, branches: config.branches.filter((b) => b !== forkEdgeKey) } } : clone(n))),
    edges: graph.edges.filter((e) => !dropEdges.has(e.key)).map(clone),
  }
}

/**
 * Add a condition branch: a fresh edge from `conditionNodeKey` to a new approval target, plus a new
 * `branches[]` entry seeded with the SAME deliberately-incomplete starter rule as
 * `insertConditionGateway` — the authoring validator blocks save until the admin selects a real form
 * field. An EMPTY rules array would be far worse than incomplete: the runtime evaluates a rules-mode
 * branch as `rules.every(...)`, which is vacuously TRUE over `[]`, so an empty branch would silently
 * capture ALL traffic (first-match-wins) and dead-code the default edge. The new target then flows
 * to the nearest node reachable from every existing condition path.
 */
export function addConditionBranch(graph: ApprovalGraph, conditionNodeKey: string, name = '条件分支'): ApprovalGraph {
  const node = graph.nodes.find((n) => n.key === conditionNodeKey)
  if (!node || node.type !== 'condition') throw new Error(`addConditionBranch: ${conditionNodeKey} is not a condition node`)
  const config = clone(node.config) as ConditionNodeConfig
  // Prefer the real convergence point. The default edge may point to its own approval node rather
  // than directly to the join, so blindly targeting defaultEdge.target can serialize both paths.
  const defaultEdge = graph.edges.find((e) => e.key === config.defaultEdgeKey)
  const rejoinTarget = conditionRejoinTarget(graph, config)
    ?? defaultEdge?.target
    ?? graph.nodes.find((n) => n.type === 'end')?.key
  if (!rejoinTarget) throw new Error('addConditionBranch: no default edge / end node to rejoin')
  const newNodeKey = uniqueKey('approval', nodeKeys(graph))
  const eKeys = edgeKeys(graph)
  const branchEdge = uniqueKey('edge', eKeys); eKeys.add(branchEdge)
  const rejoinEdge = uniqueKey('edge', eKeys)
  const newNode: ApprovalNode = { key: newNodeKey, type: 'approval', name, config: defaultApprovalConfig() }
  return {
    nodes: graph.nodes.map((n) => (n.key === conditionNodeKey
      ? {
          ...clone(n),
          config: {
            ...config,
            branches: [
              ...config.branches,
              // Mirrors insertConditionGateway's starter EXACTLY: an incomplete rule the validator
              // rejects (需要选择字段) — never `rules: []`, which the runtime would match-all.
              { edgeKey: branchEdge, conjunction: 'and' as const, rules: [{ fieldId: '', operator: 'eq' as const, value: '' }] },
            ],
          },
        }
      : clone(n))).concat([newNode]),
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
  const defaultEdge = graph.edges.find((edge) => edge.key === config.defaultEdgeKey)
  const rejoinTarget = conditionRejoinTarget(graph, config) ?? defaultEdge?.target
  if (!rejoinTarget) throw new Error('removeConditionBranch: branch convergence is ambiguous')
  const { branchNodeKey: targetKey, dropEdges } = removableSingleNodeBranch(
    graph,
    conditionNodeKey,
    edgeKey,
    rejoinTarget,
    'removeConditionBranch',
  )
  return {
    nodes: graph.nodes.filter((n) => n.key !== targetKey).map((n) => (n.key === conditionNodeKey ? { ...clone(n), config: { ...config, branches: config.branches.filter((b) => b.edgeKey !== edgeKey) } } : clone(n))),
    edges: graph.edges.filter((e) => !dropEdges.has(e.key)).map(clone),
  }
}
