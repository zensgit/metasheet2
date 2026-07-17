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

  const originalOut = outs[0]
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

  const originalOut = outs[0]
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
  const branchEdge = graph.edges.find((e) => e.key === edgeKey)!
  const targetKey = branchEdge.target
  const targetOut = new Set(outEdges(graph, targetKey).map((e) => e.key))
  const dropEdges = new Set([edgeKey, ...targetOut])
  return {
    nodes: graph.nodes.filter((n) => n.key !== targetKey).map((n) => (n.key === conditionNodeKey ? { ...clone(n), config: { ...config, branches: config.branches.filter((b) => b.edgeKey !== edgeKey) } } : clone(n))),
    edges: graph.edges.filter((e) => !dropEdges.has(e.key)).map(clone),
  }
}
