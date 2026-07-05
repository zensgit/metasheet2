import { describe, expect, it } from 'vitest'
import type { ApprovalGraph } from '../src/types/approval'
import { buildUpcomingNodes } from '../src/approvals/upcomingNodes'

// UX B2-08 — pure graph-walk contract for the approval detail view's "upcoming nodes" preview.
// Mirrors the fixture style already used by `approval-graph-layout.test.ts`.

const LINEAR: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'approval_1', type: 'approval', name: '部门主管审批', config: { assigneeSources: [{ kind: 'direct_manager' }] } },
    { key: 'approval_2', type: 'approval', name: '财务审批', config: { assigneeSources: [{ kind: 'static_user' as const, userIds: ['user_finance'] }] } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e1', source: 'start', target: 'approval_1' },
    { key: 'e2', source: 'approval_1', target: 'approval_2' },
    { key: 'e3', source: 'approval_2', target: 'end' },
  ],
}

// start → cond → {high, low} → join → end (a rejoin — same topology style as
// `approval-graph-layout.test.ts`'s REJOIN fixture).
const REJOIN: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', config: {} },
    { key: 'approval_1', type: 'approval', name: '部门主管审批', config: { assigneeSources: [{ kind: 'direct_manager' }] } },
    { key: 'cond', type: 'condition', name: '金额分支', config: { branches: [{ edgeKey: 'e-high', rules: [] }], defaultEdgeKey: 'e-low' } },
    { key: 'high', type: 'approval', name: '高额审批', config: { assigneeSources: [{ kind: 'dept_head' }] } },
    { key: 'low', type: 'approval', name: '低额审批', config: { assigneeSources: [{ kind: 'requester' }] } },
    { key: 'join', type: 'approval', name: '汇总审批', config: { assigneeSources: [{ kind: 'requester' }] } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e-s', source: 'start', target: 'approval_1' },
    { key: 'e-a-c', source: 'approval_1', target: 'cond' },
    { key: 'e-high', source: 'cond', target: 'high' },
    { key: 'e-low', source: 'cond', target: 'low' },
    { key: 'e-h-j', source: 'high', target: 'join' },
    { key: 'e-l-j', source: 'low', target: 'join' },
    { key: 'e-j-e', source: 'join', target: 'end' },
  ],
}

// start → a1 → par (fans into b1/b2) → join → end.
const PARALLEL: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', config: {} },
    { key: 'approval_1', type: 'approval', name: '前置审批', config: { assigneeSources: [{ kind: 'direct_manager' }] } },
    { key: 'par', type: 'parallel', name: '并行网关', config: { branches: ['b1', 'b2'], joinMode: 'all', joinNodeKey: 'join' } },
    { key: 'b1', type: 'approval', name: '法务审批', config: { assigneeSources: [{ kind: 'dept_head' }] } },
    { key: 'b2', type: 'approval', name: '合规审批', config: { assigneeSources: [{ kind: 'dept_head' }] } },
    { key: 'join', type: 'approval', name: '汇总审批', config: { assigneeSources: [{ kind: 'requester' }] } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e-s', source: 'start', target: 'approval_1' },
    { key: 'e-a-p', source: 'approval_1', target: 'par' },
    { key: 'e-p-b1', source: 'par', target: 'b1' },
    { key: 'e-p-b2', source: 'par', target: 'b2' },
    { key: 'e-b1-j', source: 'b1', target: 'join' },
    { key: 'e-b2-j', source: 'b2', target: 'join' },
    { key: 'e-j-e', source: 'join', target: 'end' },
  ],
}

describe('buildUpcomingNodes', () => {
  it('linear chain: returns every node after current, in order, ending at `end`', () => {
    const upcoming = buildUpcomingNodes(LINEAR, 'approval_1')
    expect(upcoming.map((n) => n.key)).toEqual(['approval_2', 'end'])
    expect(upcoming[0]).toEqual({
      key: 'approval_2',
      name: '财务审批',
      assigneeSummary: '指定用户：user_finance',
      isConditional: false,
    })
    expect(upcoming[1]).toEqual({
      key: 'end',
      name: '结束',
      assigneeSummary: '流程结束',
      isConditional: false,
    })
  })

  it('current at the last approval node before end: walk still resolves through to `end`', () => {
    const upcoming = buildUpcomingNodes(LINEAR, 'approval_2')
    expect(upcoming.map((n) => n.key)).toEqual(['end'])
  })

  it('current AT end: nothing further (empty)', () => {
    expect(buildUpcomingNodes(LINEAR, 'end')).toEqual([])
  })

  it('current key not present in the graph at all: empty, no throw', () => {
    expect(buildUpcomingNodes(LINEAR, 'does_not_exist')).toEqual([])
  })

  it('condition node ahead: includes ONE honest entry, isConditional true, no fabricated branch', () => {
    const upcoming = buildUpcomingNodes(REJOIN, 'approval_1')
    expect(upcoming.map((n) => n.key)).toEqual(['cond'])
    expect(upcoming[0]).toEqual({
      key: 'cond',
      name: '金额分支',
      assigneeSummary: '按条件进入后续分支',
      isConditional: true,
    })
    // Neither branch (`high`/`low`) — nor the rejoin (`join`) — is fabricated past the condition.
    expect(upcoming.some((n) => n.key === 'high' || n.key === 'low' || n.key === 'join')).toBe(false)
  })

  it('current key IS the condition node itself: no single honest "next" to report (empty)', () => {
    expect(buildUpcomingNodes(REJOIN, 'cond')).toEqual([])
  })

  it('parallel fan-out ahead: includes ONE honest entry, isConditional false, no fabricated branch', () => {
    const upcoming = buildUpcomingNodes(PARALLEL, 'approval_1')
    expect(upcoming.map((n) => n.key)).toEqual(['par'])
    expect(upcoming[0]).toEqual({
      key: 'par',
      name: '并行网关',
      assigneeSummary: '进入并行分支',
      isConditional: false,
    })
    expect(upcoming.some((n) => n.key === 'b1' || n.key === 'b2' || n.key === 'join')).toBe(false)
  })

  it('a dangling edge (target not in graph.nodes) stops the walk without throwing', () => {
    const dangling: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_1', type: 'approval', name: '审批', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'missing_node' },
      ],
    }
    expect(buildUpcomingNodes(dangling, 'approval_1')).toEqual([])
  })

  it('a cycle does not infinite-loop (defensive visited guard)', () => {
    const cyclic: ApprovalGraph = {
      nodes: [
        { key: 'a', type: 'approval', name: 'A', config: {} },
        { key: 'b', type: 'approval', name: 'B', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'a', target: 'b' },
        { key: 'e2', source: 'b', target: 'a' },
      ],
    }
    const upcoming = buildUpcomingNodes(cyclic, 'a')
    expect(upcoming.map((n) => n.key)).toEqual(['b'])
  })

  it('falls back to the node key when a node has no name', () => {
    const noName: ApprovalGraph = {
      nodes: [
        { key: 'a1', type: 'approval', config: {} },
        { key: 'a2', type: 'approval', config: {} },
      ],
      edges: [{ key: 'e1', source: 'a1', target: 'a2' }],
    }
    expect(buildUpcomingNodes(noName, 'a1')[0].name).toBe('a2')
  })
})
