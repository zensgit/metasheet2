import { describe, expect, it } from 'vitest'
import type { ApprovalGraph } from '../src/types/approval'
import {
  applyApprovalCanvasCommand,
  createApprovalCanvasHistory,
  executeApprovalCanvasCommand,
  redoApprovalCanvasCommand,
  undoApprovalCanvasCommand,
  type ApprovalCanvasSelection,
} from '../src/approvals/approvalCanvasCommands'
import { appendApprovalNode, collectParallelRegionNodeKeys } from '../src/approvals/graphTopologyEdit'

const snap = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const node = (graph: ApprovalGraph, key: string) => graph.nodes.find((candidate) => candidate.key === key)

const edgeBetween = (graph: ApprovalGraph, source: string, target: string) =>
  graph.edges.find((edge) => edge.source === source && edge.target === target)

/** Three-step linear spine: start → a1 → a2 → end */
const LINEAR3: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    {
      key: 'a1',
      type: 'approval',
      name: '一级',
      config: {
        assigneeSources: [{ kind: 'direct_manager' }],
        approvalMode: 'single',
        emptyAssigneePolicy: 'error',
      },
    },
    {
      key: 'a2',
      type: 'approval',
      name: '二级',
      config: {
        assigneeSources: [{ kind: 'dept_head' }],
        approvalMode: 'single',
        emptyAssigneePolicy: 'error',
      },
    },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e-start-a1', source: 'start', target: 'a1' },
    { key: 'e-a1-a2', source: 'a1', target: 'a2' },
    { key: 'e-a2-end', source: 'a2', target: 'end' },
  ],
}

/** Rich non-default config on the moved node (M1-style flatten catcher). */
const RICH_A1_CONFIG = {
  assigneeSources: [{ kind: 'direct_manager' as const }],
  approvalMode: 'all' as const,
  emptyAssigneePolicy: 'auto-approve' as const,
  autoApprovalPolicy: {
    mergeWithRequester: true,
    mergeAdjacentApprover: true,
    dedupeHistoricalApprover: true,
    actorMode: 'original_approver' as const,
  },
  fieldPermissions: [{ fieldId: 'amount', access: 'readonly' as const }],
}

const RICH_LINEAR3: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'a1', type: 'approval', name: '一级', config: RICH_A1_CONFIG },
    {
      key: 'a2',
      type: 'approval',
      name: '二级',
      config: {
        assigneeSources: [{ kind: 'dept_head' }],
        approvalMode: 'single',
        emptyAssigneePolicy: 'error',
      },
    },
    {
      key: 'cc1',
      type: 'cc',
      name: '抄送',
      config: { targetType: 'user', targetIds: ['u-9'] },
    },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e-start-a1', source: 'start', target: 'a1' },
    { key: 'e-a1-a2', source: 'a1', target: 'a2' },
    { key: 'e-a2-cc1', source: 'a2', target: 'cc1' },
    { key: 'e-cc1-end', source: 'cc1', target: 'end' },
  ],
}

const CONDITION: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    {
      key: 'cond_1',
      type: 'condition',
      name: '判断',
      config: {
        branches: [
          {
            edgeKey: 'e-high',
            conjunction: 'and',
            rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }],
          },
          {
            edgeKey: 'e-mid',
            conjunction: 'or',
            rules: [{ fieldId: 'amount', operator: 'gte', value: 100 }],
          },
        ],
        defaultEdgeKey: 'e-low',
      },
    },
    {
      key: 'app_high',
      type: 'approval',
      name: '高',
      config: {
        assigneeSources: [{ kind: 'dept_head' }],
        approvalMode: 'single',
        emptyAssigneePolicy: 'error',
      },
    },
    {
      key: 'app_mid',
      type: 'approval',
      name: '中',
      config: {
        assigneeSources: [{ kind: 'direct_manager' }],
        approvalMode: 'single',
        emptyAssigneePolicy: 'error',
      },
    },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e-start-c', source: 'start', target: 'cond_1' },
    { key: 'e-high', source: 'cond_1', target: 'app_high' },
    { key: 'e-mid', source: 'cond_1', target: 'app_mid' },
    { key: 'e-low', source: 'cond_1', target: 'end' },
    { key: 'e-high-end', source: 'app_high', target: 'end' },
    { key: 'e-mid-end', source: 'app_mid', target: 'end' },
  ],
}

const PARALLEL: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    {
      key: 'parallel_1',
      type: 'parallel',
      name: '并行',
      config: {
        branches: ['e-fork-a', 'e-fork-b', 'e-fork-c'],
        joinMode: 'all',
        joinNodeKey: 'end',
      },
    },
    {
      key: 'app_a',
      type: 'approval',
      name: 'A',
      config: {
        assigneeSources: [{ kind: 'dept_head' }],
        approvalMode: 'single',
        emptyAssigneePolicy: 'error',
      },
    },
    {
      key: 'app_b',
      type: 'approval',
      name: 'B',
      config: {
        assigneeSources: [{ kind: 'static_role', roleIds: ['r'] }],
        approvalMode: 'single',
        emptyAssigneePolicy: 'error',
      },
    },
    {
      key: 'app_c',
      type: 'approval',
      name: 'C',
      config: {
        assigneeSources: [{ kind: 'requester' }],
        approvalMode: 'single',
        emptyAssigneePolicy: 'error',
      },
    },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e-start-p', source: 'start', target: 'parallel_1' },
    { key: 'e-fork-a', source: 'parallel_1', target: 'app_a' },
    { key: 'e-fork-b', source: 'parallel_1', target: 'app_b' },
    { key: 'e-fork-c', source: 'parallel_1', target: 'app_c' },
    { key: 'e-a-end', source: 'app_a', target: 'end' },
    { key: 'e-b-end', source: 'app_b', target: 'end' },
    { key: 'e-c-end', source: 'app_c', target: 'end' },
  ],
}

describe('executeApprovalCanvasCommand — move-node-into-edge', () => {
  it('moves a linear approval into a later edge slot, preserving config and untouched nodes', () => {
    const before = snap(RICH_LINEAR3)
    const selectionBefore: ApprovalCanvasSelection = { kind: 'node', nodeKey: 'a1' }
    const result = executeApprovalCanvasCommand(
      RICH_LINEAR3,
      { type: 'move-node-into-edge', nodeKey: 'a1', intoEdgeKey: 'e-a2-cc1' },
      selectionBefore,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Input never mutated.
    expect(RICH_LINEAR3).toEqual(before)

    // Discriminating mutation: a1 is no longer between start and a2.
    expect(edgeBetween(result.graph, 'start', 'a2')).toBeTruthy()
    expect(edgeBetween(result.graph, 'start', 'a1')).toBeFalsy()
    expect(edgeBetween(result.graph, 'a2', 'a1')).toBeTruthy()
    expect(edgeBetween(result.graph, 'a1', 'cc1')).toBeTruthy()
    expect(edgeBetween(result.graph, 'a2', 'cc1')).toBeFalsy()

    // Rich non-default config preserved byte-equal on the moved node.
    expect(node(result.graph, 'a1')).toEqual(node(RICH_LINEAR3, 'a1'))
    // Untouched node byte-identical.
    expect(node(result.graph, 'cc1')).toEqual(node(RICH_LINEAR3, 'cc1'))
    expect(node(result.graph, 'a2')).toEqual(node(RICH_LINEAR3, 'a2'))

    // Selection metadata.
    expect(result.selectionBefore).toEqual(selectionBefore)
    expect(result.selectionAfter).toEqual({ kind: 'node', nodeKey: 'a1' })

    // Explicit inverse restores the graph exactly.
    const back = executeApprovalCanvasCommand(result.graph, result.inverse, result.selectionAfter)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.graph).toEqual(RICH_LINEAR3)
  })

  it('moves a cc node the same way as approval (single-in/single-out)', () => {
    const result = executeApprovalCanvasCommand(RICH_LINEAR3, {
      type: 'move-node-into-edge',
      nodeKey: 'cc1',
      intoEdgeKey: 'e-start-a1',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(edgeBetween(result.graph, 'start', 'cc1')).toBeTruthy()
    expect(edgeBetween(result.graph, 'cc1', 'a1')).toBeTruthy()
    expect(node(result.graph, 'cc1')).toEqual(node(RICH_LINEAR3, 'cc1'))
    const back = executeApprovalCanvasCommand(result.graph, result.inverse)
    expect(back.ok && back.graph).toEqual(RICH_LINEAR3)
  })

  it('rejects start/end/condition/parallel moves', () => {
    expect(
      executeApprovalCanvasCommand(LINEAR3, {
        type: 'move-node-into-edge',
        nodeKey: 'start',
        intoEdgeKey: 'e-a2-end',
      }),
    ).toMatchObject({ ok: false, error: { code: 'unsupported-node-type' } })
    expect(
      executeApprovalCanvasCommand(LINEAR3, {
        type: 'move-node-into-edge',
        nodeKey: 'end',
        intoEdgeKey: 'e-start-a1',
      }),
    ).toMatchObject({ ok: false, error: { code: 'unsupported-node-type' } })
    expect(
      executeApprovalCanvasCommand(CONDITION, {
        type: 'move-node-into-edge',
        nodeKey: 'cond_1',
        intoEdgeKey: 'e-high-end',
      }),
    ).toMatchObject({ ok: false, error: { code: 'unsupported-node-type' } })
    // Destination outside any parallel region → plain unsupported type (not nested-parallel).
    expect(
      executeApprovalCanvasCommand(PARALLEL, {
        type: 'move-node-into-edge',
        nodeKey: 'parallel_1',
        intoEdgeKey: 'e-start-p',
      }),
    ).toMatchObject({ ok: false, error: { code: 'unsupported-node-type' } })
  })

  it('rejects self/adjacent slots and missing nodes/edges', () => {
    expect(
      executeApprovalCanvasCommand(LINEAR3, {
        type: 'move-node-into-edge',
        nodeKey: 'a1',
        intoEdgeKey: 'e-a1-a2',
      }),
    ).toMatchObject({ ok: false, error: { code: 'self-slot' } })
    expect(
      executeApprovalCanvasCommand(LINEAR3, {
        type: 'move-node-into-edge',
        nodeKey: 'a1',
        intoEdgeKey: 'e-start-a1',
      }),
    ).toMatchObject({ ok: false, error: { code: 'self-slot' } })
    expect(
      executeApprovalCanvasCommand(LINEAR3, {
        type: 'move-node-into-edge',
        nodeKey: 'missing',
        intoEdgeKey: 'e-a2-end',
      }),
    ).toMatchObject({ ok: false, error: { code: 'node-not-found' } })
    expect(
      executeApprovalCanvasCommand(LINEAR3, {
        type: 'move-node-into-edge',
        nodeKey: 'a1',
        intoEdgeKey: 'no-such-edge',
      }),
    ).toMatchObject({ ok: false, error: { code: 'edge-not-found' } })
  })

  it('rejects non-linear (ambiguous origin) nodes', () => {
    // parallel branch join target `end` has multiple ins — not a move source.
    // app_a is linear; condition gateway is multi-out (already unsupported type).
    // Build a multi-out approval by hand (illegal shape) to pin not-linear.
    const multiOut: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        {
          key: 'a',
          type: 'approval',
          name: 'a',
          config: {
            assigneeSources: [{ kind: 'requester' }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
          },
        },
        { key: 'end', type: 'end', name: 'e', config: {} },
        { key: 'end2', type: 'end', name: 'e2', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'a' },
        { key: 'e2', source: 'a', target: 'end' },
        { key: 'e3', source: 'a', target: 'end2' },
      ],
    }
    expect(
      executeApprovalCanvasCommand(multiOut, {
        type: 'move-node-into-edge',
        nodeKey: 'a',
        intoEdgeKey: 'e1',
      }),
    ).toMatchObject({ ok: false, error: { code: 'not-linear' } })
  })

  it('rejects move when origin in-edge, origin out-edge, or destination edge key is non-unique', () => {
    // Discriminating fixture: a1 is still single-in/single-out by endpoint filter, but an
    // unrelated edge reuses the in-key / out-key. Without origin uniqueness checks, rewire/drop
    // by key would also retarget/remove the unrelated twin.
    const baseNodes: ApprovalGraph['nodes'] = [
      { key: 'start', type: 'start', name: 's', config: {} },
      {
        key: 'a1',
        type: 'approval',
        name: 'a1',
        config: {
          assigneeSources: [{ kind: 'requester' }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      {
        key: 'a2',
        type: 'approval',
        name: 'a2',
        config: {
          assigneeSources: [{ kind: 'requester' }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      {
        key: 'x',
        type: 'approval',
        name: 'x',
        config: {
          assigneeSources: [{ kind: 'requester' }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ]

    // Duplicate origin IN-edge key: start→a1 shares key with x→end (unrelated).
    const dupIn: ApprovalGraph = {
      nodes: baseNodes,
      edges: [
        { key: 'dup-in', source: 'start', target: 'a1' },
        { key: 'e-a1-a2', source: 'a1', target: 'a2' },
        { key: 'e-a2-end', source: 'a2', target: 'end' },
        { key: 'dup-in', source: 'x', target: 'end' },
        { key: 'e-start-x', source: 'start', target: 'x' },
      ],
    }
    const beforeDupIn = snap(dupIn)
    expect(
      executeApprovalCanvasCommand(dupIn, {
        type: 'move-node-into-edge',
        nodeKey: 'a1',
        intoEdgeKey: 'e-a2-end',
      }),
    ).toMatchObject({ ok: false, error: { code: 'ambiguous-slot' } })
    expect(dupIn).toEqual(beforeDupIn)
    // Twin still present — proving we did not partially rewire by key.
    expect(dupIn.edges.filter((edge) => edge.key === 'dup-in')).toHaveLength(2)

    // Duplicate origin OUT-edge key: a1→a2 shares key with x→end.
    const dupOut: ApprovalGraph = {
      nodes: baseNodes,
      edges: [
        { key: 'e-start-a1', source: 'start', target: 'a1' },
        { key: 'dup-out', source: 'a1', target: 'a2' },
        { key: 'e-a2-end', source: 'a2', target: 'end' },
        { key: 'dup-out', source: 'x', target: 'end' },
        { key: 'e-start-x', source: 'start', target: 'x' },
      ],
    }
    const beforeDupOut = snap(dupOut)
    expect(
      executeApprovalCanvasCommand(dupOut, {
        type: 'move-node-into-edge',
        nodeKey: 'a1',
        intoEdgeKey: 'e-a2-end',
      }),
    ).toMatchObject({ ok: false, error: { code: 'ambiguous-slot' } })
    expect(dupOut).toEqual(beforeDupOut)
    expect(dupOut.edges.filter((edge) => edge.key === 'dup-out')).toHaveLength(2)

    // Duplicate destination key (already required; kept as the third leg of the gate).
    const dupDest: ApprovalGraph = {
      nodes: baseNodes,
      edges: [
        { key: 'e-start-a1', source: 'start', target: 'a1' },
        { key: 'e-a1-a2', source: 'a1', target: 'a2' },
        { key: 'dup-dest', source: 'a2', target: 'end' },
        { key: 'dup-dest', source: 'x', target: 'end' },
        { key: 'e-start-x', source: 'start', target: 'x' },
      ],
    }
    const beforeDupDest = snap(dupDest)
    expect(
      executeApprovalCanvasCommand(dupDest, {
        type: 'move-node-into-edge',
        nodeKey: 'a1',
        intoEdgeKey: 'dup-dest',
      }),
    ).toMatchObject({ ok: false, error: { code: 'ambiguous-slot' } })
    expect(dupDest).toEqual(beforeDupDest)
  })

  it('rejects nested-parallel-invalid placement of a parallel node inside a parallel branch', () => {
    // Destination edge whose source is a parallel-region member (app_a → end).
    expect(collectParallelRegionNodeKeys(PARALLEL).has('app_a')).toBe(true)
    expect(
      executeApprovalCanvasCommand(PARALLEL, {
        type: 'move-node-into-edge',
        nodeKey: 'parallel_1',
        intoEdgeKey: 'e-a-end',
      }),
    ).toMatchObject({ ok: false, error: { code: 'nested-parallel-invalid' } })
  })

  it('allows moving an approval within a parallel branch (region members stay legal)', () => {
    // Extend branch A: parallel → app_a → extra → end, then move extra onto the fork edge… no,
    // move app_a onto a spine edge outside? Keep it simple: append on app_a then move.
    const withExtra = appendApprovalNode(PARALLEL, 'app_a', 'A2')
    const extra = withExtra.nodes.find((candidate) => candidate.name === 'A2')!
    const intoOutside = 'e-start-p'
    const result = executeApprovalCanvasCommand(withExtra, {
      type: 'move-node-into-edge',
      nodeKey: extra.key,
      intoEdgeKey: intoOutside,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(edgeBetween(result.graph, 'start', extra.key)).toBeTruthy()
    // Parallel join/branches invariants on the gateway config are untouched.
    expect(node(result.graph, 'parallel_1')).toEqual(node(withExtra, 'parallel_1'))
  })
})

describe('executeApprovalCanvasCommand — reorder branches', () => {
  it('reorders condition branches by edge identity, leaves default edge immutable, preserves rules', () => {
    const before = snap(CONDITION)
    const result = executeApprovalCanvasCommand(CONDITION, {
      type: 'reorder-condition-branches',
      conditionNodeKey: 'cond_1',
      orderedEdgeKeys: ['e-mid', 'e-high'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(CONDITION).toEqual(before)

    const config = node(result.graph, 'cond_1')!.config as {
      branches: Array<{ edgeKey: string; rules: unknown[]; conjunction?: string }>
      defaultEdgeKey: string
    }
    expect(config.branches.map((branch) => branch.edgeKey)).toEqual(['e-mid', 'e-high'])
    // Rules/identity preserved (not rebuilt).
    expect(config.branches[0]).toEqual({
      edgeKey: 'e-mid',
      conjunction: 'or',
      rules: [{ fieldId: 'amount', operator: 'gte', value: 100 }],
    })
    expect(config.branches[1]).toEqual({
      edgeKey: 'e-high',
      conjunction: 'and',
      rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }],
    })
    // Default edge immutable (still the fall-through, same key, same edge object path).
    expect(config.defaultEdgeKey).toBe('e-low')
    expect(result.graph.edges.find((edge) => edge.key === 'e-low')).toEqual(
      CONDITION.edges.find((edge) => edge.key === 'e-low'),
    )
    // Edge list identities for branch edges unchanged.
    expect(result.graph.edges.find((edge) => edge.key === 'e-high')).toEqual(
      CONDITION.edges.find((edge) => edge.key === 'e-high'),
    )

    const back = executeApprovalCanvasCommand(result.graph, result.inverse)
    expect(back.ok && back.graph).toEqual(CONDITION)
  })

  it('refuses to put the default edge into the branch order list', () => {
    expect(
      executeApprovalCanvasCommand(CONDITION, {
        type: 'reorder-condition-branches',
        conditionNodeKey: 'cond_1',
        orderedEdgeKeys: ['e-high', 'e-low'],
      }),
    ).toMatchObject({ ok: false, error: { code: 'default-edge-immutable' } })
  })

  it('rejects condition reorder when current branches share a corrupt duplicate edgeKey (no Map collapse)', () => {
    // Two distinct rules under the same edgeKey — a Map keyed by edgeKey would last-write-wins
    // and drop one branch object. Fail closed before building that Map; leave input byte-identical.
    const corrupt: ApprovalGraph = {
      ...CONDITION,
      nodes: CONDITION.nodes.map((candidate) => {
        if (candidate.key !== 'cond_1') return candidate
        return {
          ...candidate,
          config: {
            branches: [
              {
                edgeKey: 'e-dup',
                conjunction: 'and' as const,
                rules: [{ fieldId: 'amount', operator: 'gte' as const, value: 1000 }],
              },
              {
                edgeKey: 'e-dup',
                conjunction: 'or' as const,
                rules: [{ fieldId: 'dept', operator: 'eq' as const, value: 'finance' }],
              },
            ],
            defaultEdgeKey: 'e-low',
          },
        }
      }),
    }
    const before = snap(corrupt)
    const result = executeApprovalCanvasCommand(corrupt, {
      type: 'reorder-condition-branches',
      conditionNodeKey: 'cond_1',
      orderedEdgeKeys: ['e-dup', 'e-dup'],
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-branch-order' } })
    expect(corrupt).toEqual(before)
    // Both distinct rule objects still present (would be 1 if Map collapse had mutated).
    const branches = (node(corrupt, 'cond_1')!.config as { branches: unknown[] }).branches
    expect(branches).toHaveLength(2)
    expect(branches[0]).toMatchObject({ edgeKey: 'e-dup', conjunction: 'and' })
    expect(branches[1]).toMatchObject({ edgeKey: 'e-dup', conjunction: 'or' })
  })

  it('reorders parallel branch edge keys while preserving join + edge identities', () => {
    const before = snap(PARALLEL)
    const result = executeApprovalCanvasCommand(PARALLEL, {
      type: 'reorder-parallel-branches',
      parallelNodeKey: 'parallel_1',
      orderedEdgeKeys: ['e-fork-c', 'e-fork-a', 'e-fork-b'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(PARALLEL).toEqual(before)

    const config = node(result.graph, 'parallel_1')!.config as {
      branches: string[]
      joinMode: string
      joinNodeKey: string
    }
    expect(config.branches).toEqual(['e-fork-c', 'e-fork-a', 'e-fork-b'])
    expect(config.joinMode).toBe('all')
    expect(config.joinNodeKey).toBe('end')
    // Every fork/join edge identity preserved.
    for (const key of ['e-fork-a', 'e-fork-b', 'e-fork-c', 'e-a-end', 'e-b-end', 'e-c-end']) {
      expect(result.graph.edges.find((edge) => edge.key === key)).toEqual(
        PARALLEL.edges.find((edge) => edge.key === key),
      )
    }
    // Branch target nodes untouched.
    expect(node(result.graph, 'app_a')).toEqual(node(PARALLEL, 'app_a'))

    const back = executeApprovalCanvasCommand(result.graph, result.inverse)
    expect(back.ok && back.graph).toEqual(PARALLEL)
  })

  it('rejects non-permutation branch orders', () => {
    expect(
      executeApprovalCanvasCommand(PARALLEL, {
        type: 'reorder-parallel-branches',
        parallelNodeKey: 'parallel_1',
        orderedEdgeKeys: ['e-fork-a', 'e-fork-b'],
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-branch-order' } })
    expect(
      executeApprovalCanvasCommand(CONDITION, {
        type: 'reorder-condition-branches',
        conditionNodeKey: 'cond_1',
        orderedEdgeKeys: ['e-high', 'e-high'],
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-branch-order' } })
  })
})

describe('history apply / undo / redo', () => {
  it('apply → undo restores graph and selection exactly; invalid ops leave history byte-identical', () => {
    const selection: ApprovalCanvasSelection = { kind: 'node', nodeKey: 'a1' }
    const history = createApprovalCanvasHistory(RICH_LINEAR3, selection)
    const historySnap = snap(history)

    // Invalid command: no mutation, same history reference.
    const bad = applyApprovalCanvasCommand(history, {
      type: 'move-node-into-edge',
      nodeKey: 'a1',
      intoEdgeKey: 'e-a1-a2',
    })
    expect(bad.ok).toBe(false)
    expect(bad.history).toBe(history)
    expect(bad.history).toEqual(historySnap)

    const applied = applyApprovalCanvasCommand(
      history,
      { type: 'move-node-into-edge', nodeKey: 'a1', intoEdgeKey: 'e-a2-cc1' },
      selection,
    )
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(applied.history.graph).not.toEqual(RICH_LINEAR3)
    expect(applied.history.selection).toEqual({ kind: 'node', nodeKey: 'a1' })
    expect(applied.history.undoStack).toHaveLength(1)
    expect(applied.history.redoStack).toHaveLength(0)
    // History entry stores command/inverse/selection only — no full graphAfter snapshot.
    expect(applied.history.undoStack[0]).toEqual({
      command: { type: 'move-node-into-edge', nodeKey: 'a1', intoEdgeKey: 'e-a2-cc1' },
      inverse: { type: 'move-node-into-edge', nodeKey: 'a1', intoEdgeKey: 'e-start-a1' },
      selectionBefore: selection,
      selectionAfter: { kind: 'node', nodeKey: 'a1' },
    })
    expect(applied.history.undoStack[0]).not.toHaveProperty('graphAfter')

    // Discriminating mutation still present after history apply.
    expect(edgeBetween(applied.history.graph, 'a2', 'a1')).toBeTruthy()

    const undone = undoApprovalCanvasCommand(applied.history)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(undone.history.graph).toEqual(RICH_LINEAR3)
    expect(undone.history.selection).toEqual(selection)
    expect(undone.history.undoStack).toHaveLength(0)
    expect(undone.history.redoStack).toHaveLength(1)

    // Redo is deterministic (same graph as post-apply).
    const redone = redoApprovalCanvasCommand(undone.history)
    expect(redone.ok).toBe(true)
    if (!redone.ok) return
    expect(redone.history.graph).toEqual(applied.history.graph)
    expect(redone.history.selection).toEqual(applied.history.selection)

    // Redo again at bound: failure, history byte-identical.
    const redoSnap = snap(redone.history)
    const emptyRedo = redoApprovalCanvasCommand(redone.history)
    expect(emptyRedo.ok).toBe(false)
    expect(emptyRedo.history).toBe(redone.history)
    expect(emptyRedo.history).toEqual(redoSnap)
  })

  it('stacks multiple commands; undo walks back; failed undo/redo at bounds leave state identical', () => {
    let history = createApprovalCanvasHistory(LINEAR3, { kind: 'none' })

    const m1 = applyApprovalCanvasCommand(history, {
      type: 'move-node-into-edge',
      nodeKey: 'a1',
      intoEdgeKey: 'e-a2-end',
    })
    expect(m1.ok).toBe(true)
    if (!m1.ok) return
    history = m1.history

    // After first move: start→a2→a1→end. Reorder is N/A; second move of a2 into e-a1-end path.
    const m2 = applyApprovalCanvasCommand(history, {
      type: 'move-node-into-edge',
      nodeKey: 'a2',
      intoEdgeKey: history.graph.edges.find((edge) => edge.source === 'a1')!.key,
    })
    expect(m2.ok).toBe(true)
    if (!m2.ok) return
    history = m2.history
    expect(history.undoStack).toHaveLength(2)

    const u1 = undoApprovalCanvasCommand(history)
    expect(u1.ok).toBe(true)
    if (!u1.ok) return
    history = u1.history
    expect(history.undoStack).toHaveLength(1)

    const u2 = undoApprovalCanvasCommand(history)
    expect(u2.ok).toBe(true)
    if (!u2.ok) return
    history = u2.history
    expect(history.graph).toEqual(LINEAR3)

    const emptyUndoSnap = snap(history)
    const emptyUndo = undoApprovalCanvasCommand(history)
    expect(emptyUndo.ok).toBe(false)
    expect(emptyUndo.history).toBe(history)
    expect(emptyUndo.history).toEqual(emptyUndoSnap)
  })

  it('condition/parallel reorders integrate with undo and restore selection metadata', () => {
    const selection: ApprovalCanvasSelection = {
      kind: 'condition-branch',
      conditionNodeKey: 'cond_1',
      edgeKey: 'e-high',
    }
    let history = createApprovalCanvasHistory(CONDITION, selection)
    const applied = applyApprovalCanvasCommand(
      history,
      {
        type: 'reorder-condition-branches',
        conditionNodeKey: 'cond_1',
        orderedEdgeKeys: ['e-mid', 'e-high'],
      },
      selection,
    )
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    history = applied.history
    expect(history.selection.kind).toBe('condition-branch')

    const undone = undoApprovalCanvasCommand(history)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(undone.history.graph).toEqual(CONDITION)
    expect(undone.history.selection).toEqual(selection)

    // Parallel reorder through history.
    history = createApprovalCanvasHistory(PARALLEL, { kind: 'node', nodeKey: 'parallel_1' })
    const p = applyApprovalCanvasCommand(history, {
      type: 'reorder-parallel-branches',
      parallelNodeKey: 'parallel_1',
      orderedEdgeKeys: ['e-fork-b', 'e-fork-c', 'e-fork-a'],
    })
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const pu = undoApprovalCanvasCommand(p.history)
    expect(pu.ok && pu.history.graph).toEqual(PARALLEL)
    expect(pu.ok && pu.history.selection).toEqual({ kind: 'node', nodeKey: 'parallel_1' })
  })
})

describe('invalid-drop rollback (C5)', () => {
  it('failed execute returns no graph mutation surface; caller graph stays byte-identical', () => {
    const graph = snap(LINEAR3)
    const result = executeApprovalCanvasCommand(graph, {
      type: 'move-node-into-edge',
      nodeKey: 'a1',
      intoEdgeKey: 'e-a1-a2',
    })
    expect(result.ok).toBe(false)
    expect(graph).toEqual(LINEAR3)
    // Failure shape has no graph field.
    expect('graph' in result).toBe(false)
  })
})
