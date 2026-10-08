import { describe, expect, it } from 'vitest'
import type { ApprovalGraph, ApprovalNode, ApprovalTemplateDetailDTO, ApprovalAssigneeSource } from '../src/types/approval'
import { APPROVAL_ROLE_CONFIGURE_SENTINEL } from '../src/types/approval'
import { parallelDynamicAssigneeConflicts } from '../src/approvals/parallelEdit'
import { placeholderRoleNodeKeys } from '../src/approvals/approvalNodeEdit'
import { graphValidityIssues } from '../src/approvals/graphLayout'
import {
  appendApprovalNode,
  appendCcNode,
  collectParallelRegionNodeKeys,
  insertConditionGateway,
  insertParallelGateway,
  removeLinearNode,
  addParallelBranch,
  removeParallelBranch,
  addConditionBranch,
  removeConditionBranch,
  planConditionBranchRemoval,
  conditionBranchRemovalBlocker,
  ConditionBranchRemovalRefusal,
  appendHandlerNode,
  hasEmptyParallelBranch,
  adjacentLinearNodeMoveTarget,
  linearNodeMoveTargets,
  moveLinearNode,
} from '../src/approvals/graphTopologyEdit'
import {
  applyTopologyToComplexDraft,
  applyTopologyToDraft,
  buildApprovalGraph,
  draftFromTemplate,
  moveItemToIndex,
  validateTemplateApprovalFlow,
} from '../src/approvals/templateAuthoring'

describe('moveItemToIndex (D-4 field drag-reorder logic)', () => {
  it('moves an item to an arbitrary index (pure, returns a new array)', () => {
    const arr = ['a', 'b', 'c', 'd']
    expect(moveItemToIndex(arr, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItemToIndex(arr, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(arr).toEqual(['a', 'b', 'c', 'd']) // input untouched
  })
  it('no-ops / clamps out-of-range or same-index moves', () => {
    const arr = ['a', 'b', 'c']
    expect(moveItemToIndex(arr, 1, 1)).toEqual(['a', 'b', 'c'])
    expect(moveItemToIndex(arr, -1, 2)).toEqual(['a', 'b', 'c'])
    expect(moveItemToIndex(arr, 0, 9)).toEqual(['a', 'b', 'c'])
  })
})

// D-2/D-3 topology engine: pure structure edits emitting a well-formed {nodes,edges} the backend
// validates. The GATE mirrors the rest of the track: each op yields the expected structure, leaves
// UNTOUCHED nodes/edges byte-identical (anti-flatten), and refuses ambiguous/invalid ops up front.

const LINEAR: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'approval_1', type: 'approval', name: '主管', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e-start-a1', source: 'start', target: 'approval_1' },
    { key: 'e-a1-end', source: 'approval_1', target: 'end' },
  ],
}

const PARALLEL: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'parallel_1', type: 'parallel', name: '并行', config: { branches: ['e-fork-a', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'end' } },
    { key: 'app_a', type: 'approval', name: 'A', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'app_b', type: 'approval', name: 'B', config: { assigneeSources: [{ kind: 'static_role', roleIds: ['r'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e-start-p', source: 'start', target: 'parallel_1' },
    { key: 'e-fork-a', source: 'parallel_1', target: 'app_a' },
    { key: 'e-fork-b', source: 'parallel_1', target: 'app_b' },
    { key: 'e-a-end', source: 'app_a', target: 'end' },
    { key: 'e-b-end', source: 'app_b', target: 'end' },
  ],
}

const CONDITION: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'cond_1', type: 'condition', name: '判断', config: { branches: [{ edgeKey: 'e-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }] }], defaultEdgeKey: 'e-low' } },
    { key: 'app_high', type: 'approval', name: '高', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e-start-c', source: 'start', target: 'cond_1' },
    { key: 'e-high', source: 'cond_1', target: 'app_high' },
    { key: 'e-low', source: 'cond_1', target: 'end' },
    { key: 'e-high-end', source: 'app_high', target: 'end' },
  ],
}

const LINEAR_LONG: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'app_a', type: 'approval', name: 'A', config: { approvalMode: 'all', assigneeSources: [{ kind: 'dept_head' }] } },
    { key: 'cc_b', type: 'cc', name: 'B', config: { targetType: 'user', targetIds: ['user-1'] } },
    { key: 'app_c', type: 'approval', name: 'C', config: { approvalMode: 'single', assigneeSources: [{ kind: 'requester' }] } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e-start-a', source: 'start', target: 'app_a' },
    { key: 'e-a-b', source: 'app_a', target: 'cc_b' },
    { key: 'e-b-c', source: 'cc_b', target: 'app_c' },
    { key: 'e-c-end', source: 'app_c', target: 'end' },
  ],
}

const PARALLEL_LONG: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'parallel', type: 'parallel', name: '并行', config: { branches: ['e-fork-a', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'end' } },
    { key: 'a1', type: 'approval', name: 'A1', config: { assigneeSources: [{ kind: 'dept_head' }] } },
    { key: 'a2', type: 'cc', name: 'A2', config: { targetType: 'user', targetIds: ['user-2'] } },
    { key: 'a3', type: 'approval', name: 'A3', config: { assigneeSources: [{ kind: 'requester' }] } },
    { key: 'b1', type: 'approval', name: 'B1', config: { assigneeSources: [{ kind: 'static_role', roleIds: ['finance'] }] } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e-start-p', source: 'start', target: 'parallel' },
    { key: 'e-fork-a', source: 'parallel', target: 'a1' },
    { key: 'e-a1-a2', source: 'a1', target: 'a2' },
    { key: 'e-a2-a3', source: 'a2', target: 'a3' },
    { key: 'e-a3-end', source: 'a3', target: 'end' },
    { key: 'e-fork-b', source: 'parallel', target: 'b1' },
    { key: 'e-b1-end', source: 'b1', target: 'end' },
  ],
}

const snap = (g: ApprovalGraph) => JSON.parse(JSON.stringify(g))
const node = (g: ApprovalGraph, k: string) => g.nodes.find((n) => n.key === k)
const edgeBetween = (g: ApprovalGraph, s: string, t: string) => g.edges.find((e) => e.source === s && e.target === t)

describe('appendApprovalNode', () => {
  it('inserts a new approval node on a linear segment (after → new → target) and does not mutate input', () => {
    const before = snap(LINEAR)
    const out = appendApprovalNode(LINEAR, 'approval_1', '复核')
    expect(LINEAR).toEqual(before) // pure
    const newNode = out.nodes.find((n) => n.type === 'approval' && n.key !== 'approval_1')!
    expect(newNode.name).toBe('复核')
    expect(edgeBetween(out, 'approval_1', newNode.key)).toBeTruthy()
    expect(edgeBetween(out, newNode.key, 'end')).toBeTruthy()
    expect(edgeBetween(out, 'approval_1', 'end')).toBeFalsy() // the old direct edge is gone
    expect(node(out, 'start')).toEqual(node(LINEAR, 'start')) // untouched node byte-identical
  })
  it('refuses to insert after a node with ≠1 outgoing edge', () => {
    expect(() => appendApprovalNode(PARALLEL, 'parallel_1')).toThrow(/exactly one outgoing/)
  })
})

describe('appendCcNode', () => {
  it('inserts a shipped cc node on a linear segment without mutating input', () => {
    const before = snap(LINEAR)
    const out = appendCcNode(LINEAR, 'approval_1', '抄送财务')
    expect(LINEAR).toEqual(before)
    const newNode = out.nodes.find((n) => n.type === 'cc')!
    expect(newNode.name).toBe('抄送财务')
    expect(newNode.config).toEqual({ targetType: 'user', targetIds: [] })
    expect(edgeBetween(out, 'approval_1', newNode.key)).toBeTruthy()
    expect(edgeBetween(out, newNode.key, 'end')).toBeTruthy()
    expect(edgeBetween(out, 'approval_1', 'end')).toBeFalsy()
    expect(node(out, 'start')).toEqual(node(LINEAR, 'start'))
  })
  it('refuses to insert after a node with ≠1 outgoing edge', () => {
    expect(() => appendCcNode(PARALLEL, 'parallel_1')).toThrow(/exactly one outgoing/)
  })
})

describe('insertConditionGateway', () => {
  it('turns a linear edge into a configurable branch plus a default path that rejoin', () => {
    const before = snap(LINEAR)
    const out = insertConditionGateway(LINEAR, 'approval_1')
    expect(LINEAR).toEqual(before)
    const condition = out.nodes.find((candidate) => candidate.type === 'condition')!
    const config = condition.config as { branches: Array<{ edgeKey: string; rules: Array<{ fieldId: string }> }>; defaultEdgeKey: string }
    const branchEdge = out.edges.find((edge) => edge.key === config.branches[0].edgeKey)!
    const defaultEdge = out.edges.find((edge) => edge.key === config.defaultEdgeKey)!
    const branchNode = node(out, branchEdge.target)!
    const defaultNode = node(out, defaultEdge.target)!
    expect(config.branches[0].rules[0].fieldId).toBe('')
    expect(branchNode.type).toBe('approval')
    expect(edgeBetween(out, 'approval_1', condition.key)).toBeTruthy()
    expect(defaultNode.type).toBe('approval')
    expect(edgeBetween(out, branchNode.key, 'end')).toBeTruthy()
    expect(edgeBetween(out, defaultNode.key, 'end')).toBeTruthy()
    expect(edgeBetween(out, 'approval_1', 'end')).toBeFalsy()
  })

  it('refuses an ambiguous branching insertion point', () => {
    expect(() => insertConditionGateway(PARALLEL, 'parallel_1')).toThrow(/exactly one outgoing/)
  })
})

describe('insertParallelGateway', () => {
  it('turns a linear edge into a two-branch fork rejoining at the original target', () => {
    const before = snap(LINEAR)
    const out = insertParallelGateway(LINEAR, 'approval_1')
    expect(LINEAR).toEqual(before)
    const parallel = out.nodes.find((candidate) => candidate.type === 'parallel')!
    const config = parallel.config as { branches: string[]; joinMode: string; joinNodeKey: string }
    expect(config).toMatchObject({ joinMode: 'all', joinNodeKey: 'end' })
    expect(config.branches).toHaveLength(2)
    const branchTargets = config.branches.map((edgeKey) => out.edges.find((edge) => edge.key === edgeKey)!.target)
    expect(new Set(branchTargets).size).toBe(2)
    expect(branchTargets.every((target) => node(out, target)?.type === 'approval')).toBe(true)
    expect(branchTargets.every((target) => Boolean(edgeBetween(out, target, 'end')))).toBe(true)
    expect(edgeBetween(out, 'approval_1', parallel.key)).toBeTruthy()
    expect(edgeBetween(out, 'approval_1', 'end')).toBeFalsy()
  })

  // P2 regression (adversarial review F2): both starter branches used to seed `requester`, so the
  // UNTOUCHED default output resolved both branches to the same user — publish was green, then the
  // fan-out 409'd (APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT) on EVERY request. The second branch
  // now uses the configure-before-publish placeholder role: the draft saves, the publish checklist
  // + backend sentinel gate force the admin to pick a real approver first.
  it('starter branches do NOT self-conflict: branch 2 is the configure-before-publish placeholder, not a duplicate requester', () => {
    const out = insertParallelGateway(LINEAR, 'approval_1')
    const parallel = out.nodes.find((candidate) => candidate.type === 'parallel')!
    const config = parallel.config as { branches: string[] }
    const [oneKey, twoKey] = config.branches.map((edgeKey) => out.edges.find((edge) => edge.key === edgeKey)!.target)
    const sourcesOf = (key: string) => (node(out, key)!.config as { assigneeSources: ApprovalAssigneeSource[] }).assigneeSources
    expect(sourcesOf(oneKey)).toEqual([{ kind: 'requester' }])
    expect(sourcesOf(twoKey)).toEqual([{ kind: 'static_role', roleIds: [APPROVAL_ROLE_CONFIGURE_SENTINEL] }])
    // No provably-identical dynamic sources across the starter branches…
    expect(parallelDynamicAssigneeConflicts(out)).toEqual([])
    // …and the placeholder is visible to the publish checklist once the draft is promoted (the
    // "forces selection" half of the fix).
    const draft = draftFromTemplate({
      id: 't', key: 'k', name: 'n', description: null, category: null,
      visibilityScope: { type: 'all', ids: [] }, slaHours: null, status: 'draft',
      activeVersionId: null, latestVersionId: 'v',
      createdAt: '2026-06-24T00:00:00Z', updatedAt: '2026-06-24T00:00:00Z',
      formSchema: { fields: [{ id: 'amount', type: 'number', label: '金额', required: true }] },
      approvalGraph: LINEAR,
    })
    const next = applyTopologyToDraft(draft, (graph) => insertParallelGateway(graph, 'approval_1'))
    expect(placeholderRoleNodeKeys(next.approvalNodeEdits ?? {})).toEqual([twoKey])
  })

  it('addParallelBranch seeds the placeholder too (a concrete dynamic default could duplicate an existing branch)', () => {
    const out = addParallelBranch(PARALLEL, 'parallel_1', 'C')
    const config = node(out, 'parallel_1')!.config as { branches: string[] }
    const newTarget = out.edges.find((e) => e.key === config.branches[2])!.target
    expect((node(out, newTarget)!.config as { assigneeSources: ApprovalAssigneeSource[] }).assigneeSources)
      .toEqual([{ kind: 'static_role', roleIds: [APPROVAL_ROLE_CONFIGURE_SENTINEL] }])
    expect(parallelDynamicAssigneeConflicts(out)).toEqual([])
  })
})

describe('collectParallelRegionNodeKeys + nested-parallel prevention (F4)', () => {
  it('collects exactly the branch nodes between fork and join (join and fork excluded)', () => {
    expect(collectParallelRegionNodeKeys(PARALLEL)).toEqual(new Set(['app_a', 'app_b']))
    expect(collectParallelRegionNodeKeys(LINEAR)).toEqual(new Set())
    expect(collectParallelRegionNodeKeys(CONDITION)).toEqual(new Set())
  })

  it('insertParallelGateway REFUSES a node inside a parallel branch (backend rejects nested parallel at save)', () => {
    expect(() => insertParallelGateway(PARALLEL, 'app_a')).toThrow(/nested parallel/)
  })

  it('insertConditionGateway inside a parallel branch stays ALLOWED (condition-in-parallel is legal)', () => {
    const out = insertConditionGateway(PARALLEL, 'app_a')
    expect(out.nodes.some((n) => n.type === 'condition')).toBe(true)
  })
})

describe('removeLinearNode', () => {
  it('removes a single-in/out approval node and bridges pred→succ', () => {
    const out = removeLinearNode(LINEAR, 'approval_1')
    expect(node(out, 'approval_1')).toBeUndefined()
    expect(edgeBetween(out, 'start', 'end')).toBeTruthy() // bridged
    expect(out.edges).toHaveLength(1)
  })
  it('preserves a condition branch edge key when removing its first approval node', () => {
    const graph = insertConditionGateway(LINEAR, 'approval_1')
    const condition = graph.nodes.find((candidate) => candidate.type === 'condition')!
    const branchEdgeKey = (condition.config as { branches: Array<{ edgeKey: string }> }).branches[0].edgeKey
    const branchTarget = graph.edges.find((edge) => edge.key === branchEdgeKey)!.target
    const out = removeLinearNode(graph, branchTarget)
    expect(out.edges.find((edge) => edge.key === branchEdgeKey)).toMatchObject({
      source: condition.key,
      target: 'end',
    })
  })
  it('refuses to remove start/end/condition/parallel', () => {
    expect(() => removeLinearNode(CONDITION, 'cond_1')).toThrow(/only approval\/cc/)
    expect(() => removeLinearNode(LINEAR, 'start')).toThrow(/only approval\/cc/)
  })
  it('refuses to remove the sole body node of a parallel branch', () => {
    const before = snap(PARALLEL)
    expect(() => removeLinearNode(PARALLEL, 'app_a')).toThrow(/must keep at least one body node/)
    expect(PARALLEL).toEqual(before)
    expect(hasEmptyParallelBranch(PARALLEL)).toBe(false)
  })
})

describe('semantic linear-node reorder', () => {
  it('moves an approval/cc node onto a plain edge while preserving every identity and input byte-for-byte', () => {
    const before = snap(LINEAR_LONG)
    const out = moveLinearNode(LINEAR_LONG, 'cc_b', 'e-start-a')
    expect(LINEAR_LONG).toEqual(before)
    expect(out.nodes).toEqual(LINEAR_LONG.nodes)
    expect(out.edges.map((edge) => edge.key)).toEqual(LINEAR_LONG.edges.map((edge) => edge.key))
    expect(edgeBetween(out, 'start', 'cc_b')).toMatchObject({ key: 'e-start-a' })
    expect(edgeBetween(out, 'cc_b', 'app_a')).toMatchObject({ key: 'e-b-c' })
    expect(edgeBetween(out, 'app_a', 'app_c')).toMatchObject({ key: 'e-a-b' })
    expect(edgeBetween(out, 'app_c', 'end')).toEqual(edgeBetween(LINEAR_LONG, 'app_c', 'end'))
    expect(graphValidityIssues(out)).toEqual([])
  })

  it('supports reordering inside one branch without crossing its fork or rejoin boundary', () => {
    expect(linearNodeMoveTargets(PARALLEL_LONG, 'a3').map((target) => target.edgeKey))
      .toEqual(['e-a1-a2'])
    const out = moveLinearNode(PARALLEL_LONG, 'a3', 'e-a1-a2')
    expect(edgeBetween(out, 'parallel', 'a1')).toMatchObject({ key: 'e-fork-a' })
    expect(edgeBetween(out, 'a1', 'a3')).toMatchObject({ key: 'e-a1-a2' })
    expect(edgeBetween(out, 'a3', 'a2')).toMatchObject({ key: 'e-a3-end' })
    expect(edgeBetween(out, 'a2', 'end')).toMatchObject({ key: 'e-a2-a3' })
    expect(node(out, 'b1')).toEqual(node(PARALLEL_LONG, 'b1'))
    expect(graphValidityIssues(out)).toEqual([])
  })

  it('refuses cross-region, condition-branch, parallel-fork, and current-position targets', () => {
    expect(linearNodeMoveTargets(PARALLEL_LONG, 'a2').map((target) => target.edgeKey))
      .toEqual(['e-a3-end'])
    expect(() => moveLinearNode(PARALLEL_LONG, 'a2', 'e-b1-end')).toThrow(/outside/)
    expect(() => moveLinearNode(PARALLEL_LONG, 'a2', 'e-fork-a')).toThrow(/outside/)
    expect(() => moveLinearNode(PARALLEL_LONG, 'a2', 'e-a1-a2')).toThrow(/outside/)
    expect(() => moveLinearNode(CONDITION, 'app_high', 'e-high')).toThrow(/outside/)
  })

  it('never offers structural nodes and returns only legal one-step keyboard targets', () => {
    expect(linearNodeMoveTargets(PARALLEL_LONG, 'parallel')).toEqual([])
    expect(() => moveLinearNode(PARALLEL_LONG, 'parallel', 'e-a1-a2')).toThrow(/only approval\/cc movable/)
    expect(adjacentLinearNodeMoveTarget(LINEAR_LONG, 'cc_b', 'up')).toBe('e-start-a')
    expect(adjacentLinearNodeMoveTarget(LINEAR_LONG, 'cc_b', 'down')).toBe('e-c-end')
    expect(adjacentLinearNodeMoveTarget(PARALLEL_LONG, 'a2', 'up')).toBeUndefined()
    expect(adjacentLinearNodeMoveTarget(PARALLEL_LONG, 'a2', 'down')).toBe('e-a3-end')
  })
})

describe('addParallelBranch / removeParallelBranch', () => {
  it('adds a forked approval node joined at the parallel join node, growing branches to 3', () => {
    const out = addParallelBranch(PARALLEL, 'parallel_1', 'C')
    const config = node(out, 'parallel_1')!.config as { branches: string[]; joinNodeKey: string }
    expect(config.branches).toHaveLength(3)
    const newForkKey = config.branches[2]
    const fork = out.edges.find((e) => e.key === newForkKey)!
    expect(fork.source).toBe('parallel_1')
    expect(edgeBetween(out, fork.target, 'end')).toBeTruthy() // joins at the join node
    expect(node(out, 'app_a')).toEqual(node(PARALLEL, 'app_a')) // untouched branch byte-identical
  })
  it('removes a branch (node + fork + join edges) back to 2; refuses below 2', () => {
    const three = addParallelBranch(PARALLEL, 'parallel_1', 'C')
    const cfg = node(three, 'parallel_1')!.config as { branches: string[] }
    const back = removeParallelBranch(three, 'parallel_1', cfg.branches[2])
    expect((node(back, 'parallel_1')!.config as { branches: string[] }).branches).toHaveLength(2)
    expect(() => removeParallelBranch(back, 'parallel_1', 'e-fork-a')).toThrow(/at least 2/)
  })
  it('refuses complex or shared branch removal instead of orphaning its tail', () => {
    const three = addParallelBranch(PARALLEL, 'parallel_1', 'C')
    const cfg = node(three, 'parallel_1')!.config as { branches: string[] }
    const forkKey = cfg.branches[2]
    const branchTarget = three.edges.find((edge) => edge.key === forkKey)!.target
    const multiNode = appendApprovalNode(three, branchTarget, 'C2')
    const before = snap(multiNode)
    expect(() => removeParallelBranch(multiNode, 'parallel_1', forkKey)).toThrow(/complex or shared/)
    expect(multiNode).toEqual(before)
  })
})

describe('addConditionBranch / removeConditionBranch', () => {
  it('adds a branch seeded with the SAME incomplete starter rule as insertConditionGateway (NEVER empty rules), rejoining at the default target', () => {
    const out = addConditionBranch(CONDITION, 'cond_1', '中额')
    const config = node(out, 'cond_1')!.config as { branches: Array<{ edgeKey: string; rules: unknown[] }>; defaultEdgeKey: string }
    expect(config.branches).toHaveLength(2)
    // A `rules: []` seed would be a P1: the runtime evaluates a rules-mode branch as
    // `rules.every(...)` — vacuously TRUE over [] — so an empty branch silently captures ALL
    // traffic (first-match-wins) and dead-codes the default edge. The starter mirrors
    // insertConditionGateway exactly: an incomplete rule the validator blocks (需要选择字段).
    expect(config.branches[1]).toEqual({
      edgeKey: config.branches[1].edgeKey,
      conjunction: 'and',
      rules: [{ fieldId: '', operator: 'eq', value: '' }],
    })
    const newEdge = out.edges.find((e) => e.key === config.branches[1].edgeKey)!
    expect(newEdge.source).toBe('cond_1')
    expect(edgeBetween(out, newEdge.target, 'end')).toBeTruthy() // rejoins where the default edge went
  })
  it('adds a sibling at the true convergence point when the default path has its own approval node', () => {
    const graph = insertConditionGateway(LINEAR, 'approval_1')
    const condition = graph.nodes.find((candidate) => candidate.type === 'condition')!
    const before = condition.config as { branches: Array<{ edgeKey: string }>; defaultEdgeKey: string }
    const defaultTarget = graph.edges.find((edge) => edge.key === before.defaultEdgeKey)!.target
    const out = addConditionBranch(graph, condition.key, '第三分支')
    const config = node(out, condition.key)!.config as { branches: Array<{ edgeKey: string }> }
    const addedTarget = out.edges.find((edge) => edge.key === config.branches.at(-1)!.edgeKey)!.target
    expect(edgeBetween(out, addedTarget, 'end')).toBeTruthy()
    expect(edgeBetween(out, addedTarget, defaultTarget)).toBeFalsy()
  })
  it('removes a non-default branch; refuses to remove the default fall-through edge', () => {
    const two = addConditionBranch(CONDITION, 'cond_1')
    const cfg = two.nodes.find((n) => n.key === 'cond_1')!.config as { branches: Array<{ edgeKey: string }> }
    const back = removeConditionBranch(two, 'cond_1', cfg.branches[1].edgeKey)
    expect((back.nodes.find((n) => n.key === 'cond_1')!.config as { branches: unknown[] }).branches).toHaveLength(1)
    expect(() => removeConditionBranch(CONDITION, 'cond_1', 'e-low')).toThrow(/default/)
  })
  // T5a (test report 2026-10-08): a LINEAR multi-node branch body is now removed whole (the
  // previous single-node-only guard made every real branch undeletable). Exclusivity is still
  // proven node-by-node, so no orphan tail can survive — see the shared/nested refusals below.
  it('removes a linear multi-node condition branch body whole, leaving every other node/edge byte-identical', () => {
    const two = addConditionBranch(CONDITION, 'cond_1')
    const cfg = node(two, 'cond_1')!.config as { branches: Array<{ edgeKey: string }> }
    const edgeKey = cfg.branches[1].edgeKey
    const branchTarget = two.edges.find((edge) => edge.key === edgeKey)!.target
    const multiNode = appendApprovalNode(two, branchTarget, '第二级审批')
    const second = multiNode.nodes.find((candidate) => candidate.name === '第二级审批')!.key
    const before = snap(multiNode)
    const out = removeConditionBranch(multiNode, 'cond_1', edgeKey)
    expect(multiNode).toEqual(before) // pure
    expect(node(out, branchTarget)).toBeUndefined()
    expect(node(out, second)).toBeUndefined()
    expect(out.edges.some((edge) => [edgeKey].includes(edge.key) || edge.source === branchTarget || edge.source === second)).toBe(false)
    expect((node(out, 'cond_1')!.config as { branches: Array<{ edgeKey: string }> }).branches.map((b) => b.edgeKey)).toEqual(['e-high'])
    // Anti-flatten: the result equals the ORIGINAL graph exactly (add-then-delete round trip).
    expect(out).toEqual(CONDITION)
    expect(graphValidityIssues(out)).toEqual([])
  })
})

// ── T5a (test report 2026-10-08): delete a condition branch / the whole block ─────────────────────
describe('T5a — condition-branch delete (planConditionBranchRemoval)', () => {
  /** start → cond_1 → {e-a → app_a → cc_1, e-b → app_b → cc_1, default e-low → cc_1} → cc_1 → end */
  const TWO_BRANCH: ApprovalGraph = {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      {
        key: 'cond_1',
        type: 'condition',
        name: '金额判断',
        config: {
          branches: [
            { edgeKey: 'e-a', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }] },
            { edgeKey: 'e-b', rules: [{ fieldId: 'amount', operator: 'gte', value: 100 }] },
          ],
          defaultEdgeKey: 'e-low',
        },
      },
      { key: 'app_a', type: 'approval', name: 'A', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'app_b', type: 'approval', name: 'B', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'cc_1', type: 'cc', name: '抄送', config: { targetType: 'user', targetIds: ['user-1'] } },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'e-start-c', source: 'start', target: 'cond_1' },
      { key: 'e-a', source: 'cond_1', target: 'app_a' },
      { key: 'e-b', source: 'cond_1', target: 'app_b' },
      { key: 'e-low', source: 'cond_1', target: 'cc_1' },
      { key: 'e-a-cc', source: 'app_a', target: 'cc_1' },
      { key: 'e-b-cc', source: 'app_b', target: 'cc_1' },
      { key: 'e-cc-end', source: 'cc_1', target: 'end' },
    ],
  }
  const withoutDefault = (graph: ApprovalGraph): ApprovalGraph => ({
    nodes: graph.nodes.map((candidate) => (candidate.type === 'condition'
      ? { ...candidate, config: { branches: (candidate.config as { branches: unknown[] }).branches } } as ApprovalNode
      : candidate)),
    edges: graph.edges.filter((edge) => edge.key !== 'e-low'),
  })
  const refusalCode = (fn: () => unknown): string | undefined => {
    try {
      fn()
      return undefined
    } catch (error) {
      return error instanceof ConditionBranchRemovalRefusal ? error.code : `unexpected:${String(error)}`
    }
  }

  it('deletes one of several branches: the default, the other branch and every untouched node stay byte-identical', () => {
    const before = snap(TWO_BRANCH)
    const result = planConditionBranchRemoval(TWO_BRANCH, 'cond_1', 'e-b')
    expect(TWO_BRANCH).toEqual(before)
    expect(result.removedGateway).toBe(false)
    const out = result.graph
    expect(node(out, 'app_b')).toBeUndefined()
    expect(out.edges.map((edge) => edge.key)).toEqual(['e-start-c', 'e-a', 'e-low', 'e-a-cc', 'e-cc-end'])
    expect(node(out, 'cond_1')!.config).toEqual({
      branches: [{ edgeKey: 'e-a', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }] }],
      defaultEdgeKey: 'e-low', // never silently changed (D0 §4.1)
    })
    for (const key of ['start', 'app_a', 'cc_1', 'end']) expect(node(out, key)).toEqual(node(TWO_BRANCH, key))
    expect(graphValidityIssues(out)).toEqual([])
  })

  it('deletes an EMPTY branch (fork edge straight into the join)', () => {
    const emptyBranch: ApprovalGraph = {
      nodes: TWO_BRANCH.nodes.filter((candidate) => candidate.key !== 'app_b'),
      edges: [
        ...TWO_BRANCH.edges.filter((edge) => edge.key !== 'e-b' && edge.key !== 'e-b-cc'),
        { key: 'e-b', source: 'cond_1', target: 'cc_1' },
      ],
    }
    const out = removeConditionBranch(emptyBranch, 'cond_1', 'e-b')
    expect(out.edges.some((edge) => edge.key === 'e-b')).toBe(false)
    expect(out.nodes).toHaveLength(emptyBranch.nodes.length)
    expect((node(out, 'cond_1')!.config as { branches: unknown[] }).branches).toHaveLength(1)
  })

  it('never deletes the default branch, and the predicate states why', () => {
    expect(refusalCode(() => removeConditionBranch(TWO_BRANCH, 'cond_1', 'e-low'))).toBe('default-branch')
    expect(conditionBranchRemovalBlocker(TWO_BRANCH, 'cond_1', 'e-low')).toBe('默认分支不能删除')
    expect(conditionBranchRemovalBlocker(TWO_BRANCH, 'cond_1', 'e-a')).toBeNull()
  })

  it('deleting the LAST non-default branch removes the gateway and keeps the default path in its place (incoming edge key preserved)', () => {
    // The tester's exact shape: insertConditionGateway's output (1 incomplete rule branch + default).
    const inserted = insertConditionGateway(LINEAR, 'approval_1')
    const condition = inserted.nodes.find((candidate) => candidate.type === 'condition')!
    const cfg = condition.config as { branches: Array<{ edgeKey: string }>; defaultEdgeKey: string }
    const defaultHead = inserted.edges.find((edge) => edge.key === cfg.defaultEdgeKey)!.target
    const result = planConditionBranchRemoval(inserted, condition.key, cfg.branches[0].edgeKey)
    expect(result.removedGateway).toBe(true)
    expect(result.replacementNodeKey).toBe(defaultHead)
    const out = result.graph
    expect(out.nodes.some((candidate) => candidate.type === 'condition')).toBe(false)
    expect(out.nodes.map((candidate) => candidate.key)).toEqual(['start', 'approval_1', 'end', defaultHead])
    // approval_1's ORIGINAL out-edge keeps its key and now points at the default-path head.
    expect(out.edges.find((edge) => edge.key === 'e-a1-end')).toEqual({ key: 'e-a1-end', source: 'approval_1', target: defaultHead })
    expect(edgeBetween(out, defaultHead, 'end')).toBeTruthy()
    expect(node(out, 'approval_1')).toEqual(node(LINEAR, 'approval_1'))
    expect(graphValidityIssues(out)).toEqual([])
  })

  it('collapsing onto an EMPTY default path wires the predecessor straight to the join', () => {
    const one = removeConditionBranch(TWO_BRANCH, 'cond_1', 'e-b')
    const result = planConditionBranchRemoval(one, 'cond_1', 'e-a')
    expect(result.removedGateway).toBe(true)
    expect(result.graph.edges).toEqual([
      { key: 'e-start-c', source: 'start', target: 'cc_1' },
      { key: 'e-cc-end', source: 'cc_1', target: 'end' },
    ])
  })

  it('is robust when NO default edge is designated (verify C1 — previously "ambiguous" for every branch)', () => {
    const noDefault = withoutDefault(TWO_BRANCH)
    const out = removeConditionBranch(noDefault, 'cond_1', 'e-b')
    expect(node(out, 'app_b')).toBeUndefined()
    expect(edgeBetween(out, 'app_a', 'cc_1')).toBeTruthy()
    // …but the LAST branch cannot be removed without a default to keep: refused with a reason.
    const last = removeConditionBranch(noDefault, 'cond_1', 'e-b')
    const before = snap(last)
    expect(refusalCode(() => removeConditionBranch(last, 'cond_1', 'e-a'))).toBe('last-branch-without-default')
    expect(conditionBranchRemovalBlocker(last, 'cond_1', 'e-a')).toBe('未指定默认分支，不能删除最后一个条件分支')
    expect(last).toEqual(before)
  })

  it('refuses a SHARED branch body (another path merges into it before the join) and leaves the input untouched', () => {
    const shared: ApprovalGraph = {
      nodes: [...TWO_BRANCH.nodes, { key: 'app_b2', type: 'approval', name: 'B2', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } }],
      edges: [
        ...TWO_BRANCH.edges.filter((edge) => edge.key !== 'e-b-cc' && edge.key !== 'e-a-cc'),
        { key: 'e-b-b2', source: 'app_b', target: 'app_b2' },
        { key: 'e-a-b2', source: 'app_a', target: 'app_b2' },
        { key: 'e-b2-cc', source: 'app_b2', target: 'cc_1' },
      ],
    }
    const before = snap(shared)
    expect(refusalCode(() => removeConditionBranch(shared, 'cond_1', 'e-b'))).toBe('complex-branch')
    expect(conditionBranchRemovalBlocker(shared, 'cond_1', 'e-b')).toMatch(/暂不支持删除/)
    expect(shared).toEqual(before)
  })

  it('refuses a branch carrying a NESTED gateway', () => {
    const nested = insertConditionGateway(TWO_BRANCH, 'app_b')
    expect(refusalCode(() => removeConditionBranch(nested, 'cond_1', 'e-b'))).toBe('complex-branch')
  })

  it('refuses a branch carrying a handler node (handler delete is a separate, unauthorized capability)', () => {
    const withHandler = appendHandlerNode(TWO_BRANCH, 'app_b')
    expect(refusalCode(() => removeConditionBranch(withHandler, 'cond_1', 'e-b'))).toBe('handler-in-branch')
    expect(conditionBranchRemovalBlocker(withHandler, 'cond_1', 'e-b')).toBe('该分支含办理节点，暂不支持删除')
  })

  it('refuses to collapse a gateway that has more than one incoming edge', () => {
    const one = removeConditionBranch(TWO_BRANCH, 'cond_1', 'e-b')
    const twoIn: ApprovalGraph = {
      nodes: [...one.nodes, { key: 'side', type: 'cc', name: '旁路', config: { targetType: 'user', targetIds: ['u'] } }],
      edges: [...one.edges, { key: 'e-side-c', source: 'side', target: 'cond_1' }],
    }
    expect(refusalCode(() => removeConditionBranch(twoIn, 'cond_1', 'e-a'))).toBe('gateway-not-linear')
  })

  it('refuses a collapse that would leave a parallel lane empty (D0 §4.2), and one whose gateway is a multi-input parallel join', () => {
    // A condition that is the ONLY content of a parallel lane, with an EMPTY default path.
    const lane: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'p', type: 'parallel', name: '并行', config: { branches: ['e-p-c', 'e-p-x'], joinMode: 'all', joinNodeKey: 'join' } },
        { key: 'c', type: 'condition', name: '判断', config: { branches: [{ edgeKey: 'e-c-a', rules: [{ fieldId: 'amount', operator: 'gte', value: 1 }] }], defaultEdgeKey: 'e-c-join' } },
        { key: 'a', type: 'approval', name: 'A', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'x', type: 'approval', name: 'X', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'join', type: 'cc', name: '汇合', config: { targetType: 'user', targetIds: ['u'] } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e-s-p', source: 'start', target: 'p' },
        { key: 'e-p-c', source: 'p', target: 'c' },
        { key: 'e-p-x', source: 'p', target: 'x' },
        { key: 'e-c-a', source: 'c', target: 'a' },
        { key: 'e-c-join', source: 'c', target: 'join' },
        { key: 'e-a-join', source: 'a', target: 'join' },
        { key: 'e-x-join', source: 'x', target: 'join' },
        { key: 'e-join-end', source: 'join', target: 'end' },
      ],
    }
    expect(hasEmptyParallelBranch(lane)).toBe(false)
    expect(refusalCode(() => removeConditionBranch(lane, 'c', 'e-c-a'))).toBe('empty-parallel-lane')

    const conditionAsJoin: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'p', type: 'parallel', name: '并行', config: { branches: ['e-p-a', 'e-p-b'], joinMode: 'all', joinNodeKey: 'c' } },
        { key: 'a', type: 'approval', name: 'A', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'b', type: 'approval', name: 'B', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'c', type: 'condition', name: '判断', config: { branches: [{ edgeKey: 'e-c-x', rules: [{ fieldId: 'amount', operator: 'gte', value: 1 }] }], defaultEdgeKey: 'e-c-end' } },
        { key: 'x', type: 'approval', name: 'X', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e-s-p', source: 'start', target: 'p' },
        { key: 'e-p-a', source: 'p', target: 'a' },
        { key: 'e-p-b', source: 'p', target: 'b' },
        { key: 'e-a-c', source: 'a', target: 'c' },
        { key: 'e-b-c', source: 'b', target: 'c' },
        { key: 'e-c-x', source: 'c', target: 'x' },
        { key: 'e-c-end', source: 'c', target: 'end' },
        { key: 'e-x-end', source: 'x', target: 'end' },
      ],
    }
    expect(refusalCode(() => removeConditionBranch(conditionAsJoin, 'c', 'e-c-x'))).toBe('gateway-not-linear')
  })
})

// T5a verify X2: with NO designated default, `+条件分支` used to rejoin at `end` (skipping every
// downstream node) because the absent default edge counted as an unresolvable path.
describe('addConditionBranch without a designated default (verify X2)', () => {
  it('rejoins at the real convergence point, not at end', () => {
    const inserted = insertConditionGateway(LINEAR_LONG, 'app_a')
    const condition = inserted.nodes.find((candidate) => candidate.type === 'condition')!
    const noDefault: ApprovalGraph = {
      nodes: inserted.nodes.map((candidate) => (candidate.key === condition.key
        ? { ...candidate, config: { branches: (candidate.config as { branches: unknown[] }).branches } } as ApprovalNode
        : candidate)),
      edges: inserted.edges,
    }
    const out = addConditionBranch(noDefault, condition.key, '第三分支')
    const added = (node(out, condition.key)!.config as { branches: Array<{ edgeKey: string }> }).branches.at(-1)!
    const addedTarget = out.edges.find((edge) => edge.key === added.edgeKey)!.target
    expect(edgeBetween(out, addedTarget, 'cc_b')).toBeTruthy() // the real join (cc_b), not end
    expect(edgeBetween(out, addedTarget, 'end')).toBeFalsy()
  })
})

describe('applyTopologyToComplexDraft — engine ↔ complex draft bridge (one source of truth)', () => {
  const tpl = (graph: ApprovalGraph): ApprovalTemplateDetailDTO => ({
    id: 't', key: 'k', name: 'n', description: null, category: null,
    visibilityScope: { type: 'all', ids: [] }, slaHours: null, status: 'draft',
    activeVersionId: null, latestVersionId: 'v',
    createdAt: '2026-06-24T00:00:00Z', updatedAt: '2026-06-24T00:00:00Z',
    formSchema: { fields: [{ id: 'amount', type: 'number', label: '金额', required: true }] }, approvalGraph: graph,
  })
  it('applies a topology op and re-seeds config edits; buildApprovalGraph reflects the new structure', () => {
    const draft = draftFromTemplate(tpl(CONDITION))
    const next = applyTopologyToComplexDraft(draft, (g) => addConditionBranch(g, 'cond_1', '中额'))
    const built = buildApprovalGraph(next)
    expect((node(built, 'cond_1')!.config as { branches: unknown[] }).branches).toHaveLength(2)
    const newApproval = next.preservedGraph!.nodes.find((n) => n.type === 'approval' && n.key !== 'app_high')!
    expect(next.approvalNodeEdits![newApproval.key]).toBeTruthy() // seeded G-5-editable, no reload needed
  })
  it('a config edit AFTER a topology op still lands (configs survive structure changes)', () => {
    const draft = draftFromTemplate(tpl(PARALLEL))
    const next = applyTopologyToComplexDraft(draft, (g) => addParallelBranch(g, 'parallel_1', 'C'))
    const newApproval = next.preservedGraph!.nodes.find((n) => n.type === 'approval' && !['app_a', 'app_b'].includes(n.key))!
    next.approvalNodeEdits![newApproval.key].assigneeSources = [{ kind: 'dept_head' }]
    const built = buildApprovalGraph(next)
    expect((node(built, newApproval.key)!.config as { assigneeSources: unknown }).assigneeSources).toEqual([{ kind: 'dept_head' }])
    expect(node(built, 'app_a')).toEqual(node(PARALLEL, 'app_a')) // original branch untouched
  })

  it('promotes a linear draft before inserting a gateway, preserving existing approval config', () => {
    const draft = draftFromTemplate(tpl(LINEAR))
    const next = applyTopologyToDraft(draft, (graph) => insertParallelGateway(graph, 'approval_1'))
    const built = buildApprovalGraph(next)
    expect(next.steps).toEqual([])
    expect(next.preservedGraph).toBeTruthy()
    expect(node(built, 'approval_1')).toEqual(node(LINEAR, 'approval_1'))
    expect(built.nodes.some((candidate) => candidate.type === 'parallel')).toBe(true)
    expect(Object.keys(next.parallelEdits ?? {})).toHaveLength(1)
  })

  // F3 (adversarial review #4433): the LINEAR fixture above carries the flatten-to-default values
  // (approvalMode 'single' / emptyAssigneePolicy 'error'), so a buildStepConfig that silently
  // flattened them still passed (mutation M1 survived every suite). This fixture makes every
  // authorable dimension NON-default so any flatten REDs the byte-equal round-trip.
  const RICH_LINEAR: ApprovalGraph = {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      {
        key: 'approval_1',
        type: 'approval',
        name: '主管',
        config: {
          assigneeSources: [{ kind: 'direct_manager' }],
          approvalMode: 'all',
          emptyAssigneePolicy: 'auto-approve',
          autoApprovalPolicy: {
            mergeWithRequester: true,
            mergeAdjacentApprover: true,
            dedupeHistoricalApprover: true,
            actorMode: 'original_approver',
          },
          fieldPermissions: [{ fieldId: 'amount', access: 'readonly' }],
        },
      },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'e-start-a1', source: 'start', target: 'approval_1' },
      { key: 'e-a1-end', source: 'approval_1', target: 'end' },
    ],
  }

  it('promote preserves NON-DEFAULT approval config byte-equal (mode/policy/auto-approval/permissions — M1 flatten catcher)', () => {
    const draft = draftFromTemplate(tpl(RICH_LINEAR))
    const next = applyTopologyToDraft(draft, (graph) => insertParallelGateway(graph, 'approval_1'))
    const built = buildApprovalGraph(next)
    // Full-config equality — approvalMode 'all', emptyAssigneePolicy 'auto-approve', the complete
    // 4-field autoApprovalPolicy AND fieldPermissions must all survive hydrate → promote → rebuild.
    expect(node(built, 'approval_1')).toEqual(node(RICH_LINEAR, 'approval_1'))
    // The same non-defaults ALSO survive a second rebuild from the promoted draft (steady state).
    expect(node(buildApprovalGraph(next), 'approval_1')).toEqual(node(RICH_LINEAR, 'approval_1'))
  })

  it('a topology op on a COMPLEX draft preserves an untouched node timeout byte-equal (pure-layer anti-flatten floor)', () => {
    // `timeout` is not linear-authorable, so it can only exist on the complex path; the pure
    // apply/rebuild layer must still pass it through verbatim (applyApprovalNodeEditsToGraph's
    // original-config spread). NB: the VIEW additionally locks timeout-carrying complex templates
    // read-only via the backend-drop allowlist — this pins the engine-level floor beneath that.
    const TIMEOUT_CONDITION: ApprovalGraph = {
      ...CONDITION,
      nodes: CONDITION.nodes.map((n) => (n.key === 'app_high'
        ? {
            ...n,
            config: {
              assigneeSources: [{ kind: 'dept_head' }],
              approvalMode: 'single',
              emptyAssigneePolicy: 'error',
              timeout: { afterMinutes: 30, effect: 'remind' },
            } as ApprovalNode['config'],
          }
        : n)),
    }
    const draft = draftFromTemplate(tpl(TIMEOUT_CONDITION))
    const next = applyTopologyToComplexDraft(draft, (g) => addConditionBranch(g, 'cond_1', '中额'))
    const built = buildApprovalGraph(next)
    expect(node(built, 'app_high')).toEqual(node(TIMEOUT_CONDITION, 'app_high'))
  })

  it('blocks save after inserting a condition until its starter rule is configured', () => {
    const draft = draftFromTemplate(tpl(LINEAR))
    const next = applyTopologyToDraft(draft, (graph) => insertConditionGateway(graph, 'approval_1'))
    expect(validateTemplateApprovalFlow(next).some((error) => error.includes('需要选择字段'))).toBe(true)
    const conditionKey = next.preservedGraph!.nodes.find((candidate) => candidate.type === 'condition')!.key
    next.conditionEdits![conditionKey].branches[0].rules[0].fieldId = 'amount'
    expect(validateTemplateApprovalFlow(next).some((error) => error.includes('需要选择字段'))).toBe(false)
  })

  // P1 regression (adversarial review F1): +条件分支 via addConditionBranch previously seeded
  // `rules: []`, which validated CLEAN and published — then the runtime's `[].every(...)` matched
  // EVERY request, silently capturing all traffic and dead-coding the default edge. The added
  // branch must be save-blocked exactly like insertConditionGateway's starter branch.
  // (Mutation catcher: neutralize the addConditionBranch seed back to `rules: []` → this REDs.)
  it('blocks save after ADDING a condition branch until its starter rule is configured (never a clean empty branch)', () => {
    const draft = draftFromTemplate(tpl(CONDITION))
    const next = applyTopologyToComplexDraft(draft, (g) => addConditionBranch(g, 'cond_1', '中额'))
    expect(validateTemplateApprovalFlow(next).some((error) => error.includes('需要选择字段'))).toBe(true)
    next.conditionEdits!.cond_1.branches[1].rules[0].fieldId = 'amount'
    expect(validateTemplateApprovalFlow(next)).toEqual([])
  })

  // Layer (b) of the same fix: even a graph that ALREADY carries a rules-mode branch with zero
  // rules (legacy stored / hand-built — no starter rule to be incomplete) must be save-blocked.
  it('flags a rules-mode condition branch with ZERO rules as a validation error (empty branch would match everything)', () => {
    const draft = draftFromTemplate(tpl(CONDITION))
    draft.conditionEdits!.cond_1.branches[0].rules = []
    expect(validateTemplateApprovalFlow(draft).some((error) => error.includes('需要至少一条规则'))).toBe(true)
  })
})
