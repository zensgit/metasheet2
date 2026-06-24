import { describe, expect, it } from 'vitest'
import type { ApprovalGraph, ApprovalTemplateDetailDTO } from '../src/types/approval'
import {
  appendApprovalNode,
  removeLinearNode,
  addParallelBranch,
  removeParallelBranch,
  addConditionBranch,
  removeConditionBranch,
} from '../src/approvals/graphTopologyEdit'
import { applyTopologyToComplexDraft, buildApprovalGraph, draftFromTemplate, moveItemToIndex } from '../src/approvals/templateAuthoring'

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

describe('removeLinearNode', () => {
  it('removes a single-in/out approval node and bridges pred→succ', () => {
    const out = removeLinearNode(LINEAR, 'approval_1')
    expect(node(out, 'approval_1')).toBeUndefined()
    expect(edgeBetween(out, 'start', 'end')).toBeTruthy() // bridged
    expect(out.edges).toHaveLength(1)
  })
  it('refuses to remove start/end/condition/parallel', () => {
    expect(() => removeLinearNode(CONDITION, 'cond_1')).toThrow(/only approval\/cc/)
    expect(() => removeLinearNode(LINEAR, 'start')).toThrow(/only approval\/cc/)
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
})

describe('addConditionBranch / removeConditionBranch', () => {
  it('adds a branch (empty rules) rejoining at the default target, growing branches to 2', () => {
    const out = addConditionBranch(CONDITION, 'cond_1', '中额')
    const config = node(out, 'cond_1')!.config as { branches: Array<{ edgeKey: string; rules: unknown[] }>; defaultEdgeKey: string }
    expect(config.branches).toHaveLength(2)
    expect(config.branches[1].rules).toEqual([]) // admin fills the rule via the G-2 editor
    const newEdge = out.edges.find((e) => e.key === config.branches[1].edgeKey)!
    expect(newEdge.source).toBe('cond_1')
    expect(edgeBetween(out, newEdge.target, 'end')).toBeTruthy() // rejoins where the default edge went
  })
  it('removes a non-default branch; refuses to remove the default fall-through edge', () => {
    const two = addConditionBranch(CONDITION, 'cond_1')
    const cfg = two.nodes.find((n) => n.key === 'cond_1')!.config as { branches: Array<{ edgeKey: string }> }
    const back = removeConditionBranch(two, 'cond_1', cfg.branches[1].edgeKey)
    expect((back.nodes.find((n) => n.key === 'cond_1')!.config as { branches: unknown[] }).branches).toHaveLength(1)
    expect(() => removeConditionBranch(CONDITION, 'cond_1', 'e-low')).toThrow(/default/)
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
})
