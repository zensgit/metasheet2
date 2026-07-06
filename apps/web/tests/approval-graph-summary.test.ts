import { describe, expect, it } from 'vitest'
import type { ApprovalGraph } from '../src/types/approval'
import { summarizeApprovalFlow } from '../src/approvals/graphSummary'

// UX B2-07 — pure graph-walk contract for ApprovalNewView's submit-time flow preview.
// `summarizeApprovalFlow` is a thin, start-seeded wrapper over the SAME walk
// `buildUpcomingNodes` (UX B2-08) already implements — see `approval-upcoming-nodes.test.ts` for
// that walk's own exhaustive coverage (dangling edges, cycles, no-name fallback, ...). Fixture
// style mirrors that file; these tests focus on what's specific to seeding at `start`.

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

// start → a1 → cond → {high, low} → join → end (a rejoin — same topology as
// `approval-upcoming-nodes.test.ts`'s REJOIN fixture).
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

describe('summarizeApprovalFlow', () => {
  it('linear graph: walks start -> end in order, excluding the start node itself', () => {
    const steps = summarizeApprovalFlow(LINEAR)
    expect(steps.map((s) => s.key)).toEqual(['approval_1', 'approval_2', 'end'])
    expect(steps[0]).toEqual({
      key: 'approval_1',
      name: '部门主管审批',
      assigneeSummary: '直属上级',
      isConditional: false,
    })
    expect(steps[2]).toEqual({
      key: 'end',
      name: '结束',
      assigneeSummary: '流程结束',
      isConditional: false,
    })
    expect(steps.some((s) => s.key === 'start')).toBe(false)
  })

  it('a condition node ahead: one honest entry, isConditional true, no fabricated branch', () => {
    const steps = summarizeApprovalFlow(REJOIN)
    expect(steps.map((s) => s.key)).toEqual(['approval_1', 'cond'])
    expect(steps[1]).toEqual({
      key: 'cond',
      name: '金额分支',
      assigneeSummary: '按条件进入后续分支',
      isConditional: true,
    })
    // Neither branch (`high`/`low`) nor the rejoin (`join`) is fabricated past the condition.
    expect(steps.some((s) => s.key === 'high' || s.key === 'low' || s.key === 'join')).toBe(false)
  })

  it('a single-node graph (start only, no edges) is safe: empty, no throw', () => {
    const single: ApprovalGraph = { nodes: [{ key: 'start', type: 'start', config: {} }], edges: [] }
    expect(summarizeApprovalFlow(single)).toEqual([])
  })

  it('an empty graph (no nodes at all) is safe: empty, no throw', () => {
    expect(summarizeApprovalFlow({ nodes: [], edges: [] })).toEqual([])
  })

  it('a graph with no `start`-type node is safe: empty, no throw', () => {
    const noStart: ApprovalGraph = {
      nodes: [{ key: 'a', type: 'approval', name: 'A', config: {} }],
      edges: [],
    }
    expect(summarizeApprovalFlow(noStart)).toEqual([])
  })
})
