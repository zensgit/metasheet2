import { describe, expect, it } from 'vitest'
import type { ApprovalGraph } from '../src/types/approval'
import { computeLayout, graphValidityIssues } from '../src/approvals/graphLayout'

// D-1/D-5 canvas foundation — pure layout + validity, unit-tested (the canvas component renders these
// coordinates; the FE preview surfaces these issues; the backend stays the final arbiter on save).

const LINEAR: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', config: {} },
    { key: 'a1', type: 'approval', config: { assigneeSources: [{ kind: 'direct_manager' }] } },
    { key: 'end', type: 'end', config: {} },
  ],
  edges: [
    { key: 'e1', source: 'start', target: 'a1' },
    { key: 'e2', source: 'a1', target: 'end' },
  ],
}

// a rejoin: start → cond → {high → join, low → join} → end. `join` must sit AFTER both branches.
const REJOIN: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', config: {} },
    { key: 'cond', type: 'condition', config: { branches: [{ edgeKey: 'e-high', rules: [] }], defaultEdgeKey: 'e-low' } },
    { key: 'high', type: 'approval', config: { assigneeSources: [{ kind: 'dept_head' }] } },
    { key: 'low', type: 'approval', config: { assigneeSources: [{ kind: 'direct_manager' }] } },
    { key: 'join', type: 'approval', config: { assigneeSources: [{ kind: 'requester' }] } },
    { key: 'end', type: 'end', config: {} },
  ],
  edges: [
    { key: 'e-s', source: 'start', target: 'cond' },
    { key: 'e-high', source: 'cond', target: 'high' },
    { key: 'e-low', source: 'cond', target: 'low' },
    { key: 'e-h-j', source: 'high', target: 'join' },
    { key: 'e-l-j', source: 'low', target: 'join' },
    { key: 'e-j-e', source: 'join', target: 'end' },
  ],
}

describe('computeLayout (longest-path layered)', () => {
  it('places a linear graph in increasing layers/x with stable coordinates', () => {
    const layout = computeLayout(LINEAR)
    const byKey = new Map(layout.nodes.map((n) => [n.key, n]))
    expect(byKey.get('start')!.layer).toBe(0)
    expect(byKey.get('a1')!.layer).toBe(1)
    expect(byKey.get('end')!.layer).toBe(2)
    expect(byKey.get('a1')!.x).toBeGreaterThan(byKey.get('start')!.x)
    expect(layout.nodes).toHaveLength(3)
  })
  it('puts a rejoin node AFTER both of its branches (longest-path, not shortest)', () => {
    const byKey = new Map(computeLayout(REJOIN).nodes.map((n) => [n.key, n]))
    // join is reachable via start→cond→high→join (3 hops) and start→cond→low→join (3 hops) → layer 3
    expect(byKey.get('join')!.layer).toBe(3)
    expect(byKey.get('join')!.layer).toBeGreaterThan(byKey.get('high')!.layer)
    expect(byKey.get('join')!.layer).toBeGreaterThan(byKey.get('low')!.layer)
    expect(byKey.get('end')!.layer).toBe(4)
  })
})

describe('graphValidityIssues (D-5 preview)', () => {
  it('is empty for a clean graph', () => {
    expect(graphValidityIssues(LINEAR)).toEqual([])
    expect(graphValidityIssues(REJOIN)).toEqual([])
  })
  it('flags a dangling edge (target not a node)', () => {
    const broken: ApprovalGraph = { nodes: LINEAR.nodes, edges: [...LINEAR.edges, { key: 'bad', source: 'a1', target: 'ghost' }] }
    expect(graphValidityIssues(broken).some((i) => /不存在的节点/.test(i))).toBe(true)
  })
  it('flags an unreachable node', () => {
    const orphan: ApprovalGraph = {
      nodes: [...LINEAR.nodes, { key: 'floating', type: 'approval', config: { assigneeSources: [{ kind: 'requester' }] } }],
      edges: LINEAR.edges,
    }
    expect(graphValidityIssues(orphan).some((i) => /无法从发起节点到达/.test(i))).toBe(true)
  })
  it('flags a non-end node with no outgoing edge (stuck flow)', () => {
    const stuck: ApprovalGraph = {
      nodes: [...LINEAR.nodes, { key: 'deadend', type: 'approval', config: { assigneeSources: [{ kind: 'requester' }] } }],
      edges: [...LINEAR.edges, { key: 'e3', source: 'a1', target: 'deadend' }],
    }
    expect(graphValidityIssues(stuck).some((i) => /没有后继连线/.test(i))).toBe(true)
  })

  it('D-5: flags duplicate node keys and duplicate edge keys (a canvas key collision)', () => {
    const dupNode: ApprovalGraph = {
      nodes: [...LINEAR.nodes, { key: 'a1', type: 'approval', config: {} }], // 'a1' duplicated
      edges: LINEAR.edges,
    }
    expect(graphValidityIssues(dupNode).some((i) => /节点 key 重复：a1/.test(i))).toBe(true)
    const dupEdge: ApprovalGraph = {
      nodes: LINEAR.nodes,
      edges: [...LINEAR.edges, { key: 'e1', source: 'a1', target: 'end' }], // 'e1' duplicated
    }
    expect(graphValidityIssues(dupEdge).some((i) => /连线 key 重复：e1/.test(i))).toBe(true)
  })

  it('D-5: flags a cycle AND the nodes trapped in it (cannot reach end, but not "no-successor")', () => {
    const cycle: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'a', type: 'approval', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'b', type: 'approval', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e-s-a', source: 'start', target: 'a' },
        { key: 'e-s-e', source: 'start', target: 'end' }, // start can still reach end
        { key: 'e-a-b', source: 'a', target: 'b' },
        { key: 'e-b-a', source: 'b', target: 'a' }, // a ↔ b cycle
      ],
    }
    const issues = graphValidityIssues(cycle)
    expect(issues.some((i) => /存在环/.test(i))).toBe(true) // cycle detected
    expect(issues.some((i) => /无法到达结束节点/.test(i))).toBe(true) // a, b trapped (can't reach end)
    expect(issues.some((i) => /没有后继连线/.test(i))).toBe(false) // a/b have out-edges → NOT flagged as stuck
  })
})
