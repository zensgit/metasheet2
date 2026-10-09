import { describe, expect, it } from 'vitest'
import { computeReturnableNodeKeys } from '../../src/services/approval-return-targets'
import type { ApprovalEdge, ApprovalNode, RuntimeGraph } from '../../src/types/approval-product'

/**
 * `computeReturnableNodeKeys` — the server-computed 退回 target list (`returnableNodeKeys`), pinned
 * against the three checks `ApprovalProductService.dispatchAction`'s `return` arm applies:
 *   (a) handler cursor → `[]`;
 *   (b) parallel region (branch state present AND the stored cursor is the fork) → `[]`;
 *   (c) otherwise `ApprovalGraphExecutor.listVisitedApprovalNodeKeysUntil(cursor).slice(0, -1)`.
 * Plus the contract's `undefined` arm: not pending, no cursor, no graph, or the walk threw.
 *
 * Pure: graphs are built inline, no database, no module mocks. Fixtures are generic and values-free.
 */

const START: ApprovalNode = { key: 'start', type: 'start', config: {} }
const END: ApprovalNode = { key: 'end', type: 'end', config: {} }
const POLICY = { allowRevoke: true }

function approval(key: string): ApprovalNode {
  return { key, type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user_1'] } }
}

function edge(key: string, source: string, target: string): ApprovalEdge {
  return { key, source, target }
}

/** start → approval_1 → approval_2 → approval_3 → end */
function linearGraph(): RuntimeGraph {
  return {
    nodes: [START, approval('approval_1'), approval('approval_2'), approval('approval_3'), END],
    edges: [
      edge('e1', 'start', 'approval_1'),
      edge('e2', 'approval_1', 'approval_2'),
      edge('e3', 'approval_2', 'approval_3'),
      edge('e4', 'approval_3', 'end'),
    ],
    policy: POLICY,
  }
}

/** start → approval_1 → cc_1 → handler_1 → approval_2 → end */
function ccHandlerGraph(): RuntimeGraph {
  return {
    nodes: [
      START,
      approval('approval_1'),
      { key: 'cc_1', type: 'cc', config: { targetType: 'user', targetIds: ['user_5'] } },
      { key: 'handler_1', type: 'handler', config: { assigneeSources: [{ type: 'user', userIds: ['user_7'] }] } },
      approval('approval_2'),
      END,
    ],
    edges: [
      edge('e1', 'start', 'approval_1'),
      edge('e2', 'approval_1', 'cc_1'),
      edge('e3', 'cc_1', 'handler_1'),
      edge('e4', 'handler_1', 'approval_2'),
      edge('e5', 'approval_2', 'end'),
    ],
    policy: POLICY,
  }
}

/**
 * start → approval_1 → parallel_1 ⇉ {approval_p1, approval_p2} ⇉ approval_2 → approval_3 → end
 * (the canvas joins a region at the next real node, so `joinNodeKey` is approval_2).
 */
function parallelGraph(): RuntimeGraph {
  return {
    nodes: [
      START,
      approval('approval_1'),
      {
        key: 'parallel_1',
        type: 'parallel',
        config: { branches: ['edge_p1', 'edge_p2'], joinMode: 'all', joinNodeKey: 'approval_2' },
      },
      approval('approval_p1'),
      approval('approval_p2'),
      approval('approval_2'),
      approval('approval_3'),
      END,
    ],
    edges: [
      edge('e1', 'start', 'approval_1'),
      edge('e2', 'approval_1', 'parallel_1'),
      edge('edge_p1', 'parallel_1', 'approval_p1'),
      edge('edge_p2', 'parallel_1', 'approval_p2'),
      edge('edge_j1', 'approval_p1', 'approval_2'),
      edge('edge_j2', 'approval_p2', 'approval_2'),
      edge('e3', 'approval_2', 'approval_3'),
      edge('e4', 'approval_3', 'end'),
    ],
    policy: POLICY,
  }
}

/** The parallel branch state `dispatchAction` reads while the instance is inside the region. */
function parallelBranchStates(pending: { p1: boolean; p2: boolean }) {
  return {
    parallelBranchStates: {
      parallelNodeKey: 'parallel_1',
      joinNodeKey: 'approval_2',
      joinMode: 'all',
      branches: {
        edge_p1: { edgeKey: 'edge_p1', currentNodeKey: pending.p1 ? 'approval_p1' : null, complete: !pending.p1 },
        edge_p2: { edgeKey: 'edge_p2', currentNodeKey: pending.p2 ? 'approval_p2' : null, complete: !pending.p2 },
      },
    },
  }
}

/**
 * start → route ⇒ {edge_high: approval_high | default edge_low: approval_low} → approval_final → end
 * The high branch is a RULE (amount ≥ 1000) unless `formula` is given.
 */
function conditionGraph(formula?: string): RuntimeGraph {
  return {
    nodes: [
      START,
      {
        key: 'route',
        type: 'condition',
        config: {
          branches: [
            formula
              ? { edgeKey: 'edge_high', rules: [], formula: { expression: formula } }
              : { edgeKey: 'edge_high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }] },
          ],
          defaultEdgeKey: 'edge_low',
        },
      },
      approval('approval_high'),
      approval('approval_low'),
      approval('approval_final'),
      END,
    ],
    edges: [
      edge('e1', 'start', 'route'),
      edge('edge_high', 'route', 'approval_high'),
      edge('edge_low', 'route', 'approval_low'),
      edge('e2', 'approval_high', 'approval_final'),
      edge('e3', 'approval_low', 'approval_final'),
      edge('e4', 'approval_final', 'end'),
    ],
    policy: POLICY,
  }
}

function compute(
  runtimeGraph: unknown,
  currentNodeKey: string | null,
  overrides: Partial<{ status: string | null; formSnapshot: unknown; requesterSnapshot: unknown; metadata: unknown }> = {},
) {
  return computeReturnableNodeKeys({
    runtimeGraph,
    currentNodeKey,
    status: 'pending',
    formSnapshot: {},
    metadata: {},
    ...overrides,
  })
}

describe('computeReturnableNodeKeys — (c) the executor trail before the cursor', () => {
  it('linear graph, cursor at the third approval: the two upstream approval keys, in trail order', () => {
    expect(compute(linearGraph(), 'approval_3')).toEqual(['approval_1', 'approval_2'])
  })

  it('linear graph, cursor at the first approval: nothing before the cursor → []', () => {
    expect(compute(linearGraph(), 'approval_1')).toEqual([])
  })

  it('the cursor itself and everything after it are never listed', () => {
    const keys = compute(linearGraph(), 'approval_2')
    expect(keys).toEqual(['approval_1'])
    expect(keys).not.toContain('approval_2')
    expect(keys).not.toContain('approval_3')
  })

  it('cc and handler nodes on the trail are passed through, never listed', () => {
    expect(compute(ccHandlerGraph(), 'approval_2')).toEqual(['approval_1'])
  })

  it('nodes inside a parallel region are never listed once the region has joined (fork skipped to join)', () => {
    // After the join the stored cursor has moved on; `dispatchAction` reads this as linear whether
    // the stale branch state is still in the metadata (every branch complete) or already gone.
    expect(compute(parallelGraph(), 'approval_3')).toEqual(['approval_1', 'approval_2'])
    expect(compute(parallelGraph(), 'approval_3', { metadata: parallelBranchStates({ p1: false, p2: false }) }))
      .toEqual(['approval_1', 'approval_2'])
    expect(compute(parallelGraph(), 'approval_2')).toEqual(['approval_1'])
  })

  it('a condition node contributes only the branch the form data resolves to', () => {
    expect(compute(conditionGraph(), 'approval_final', { formSnapshot: { amount: 5000 } })).toEqual(['approval_high'])
    expect(compute(conditionGraph(), 'approval_final', { formSnapshot: { amount: 10 } })).toEqual(['approval_low'])
    // A missing snapshot walks as an empty form, exactly as `dispatchAction` does (`|| {}`).
    expect(compute(conditionGraph(), 'approval_final', { formSnapshot: null })).toEqual(['approval_low'])
  })

  it('a formula branch reading `requester.*` resolves with the frozen requester snapshot, as the gate does', () => {
    const graph = conditionGraph('{amount} >= 1000 AND requester.department == "finance"')
    const form = { amount: 5000 }
    expect(compute(graph, 'approval_final', { formSnapshot: form, requesterSnapshot: { directoryDepartment: 'finance' } }))
      .toEqual(['approval_high'])
    expect(compute(graph, 'approval_final', { formSnapshot: form, requesterSnapshot: { directoryDepartment: 'sales' } }))
      .toEqual(['approval_low'])
  })
})

describe('computeReturnableNodeKeys — (a) handler cursor and (b) parallel region → []', () => {
  it('handler cursor → [] (APPROVAL_HANDLER_ACTION_NOT_ALLOWED), even with an approval before it', () => {
    expect(compute(ccHandlerGraph(), 'handler_1')).toEqual([])
  })

  it('parallel state present with the cursor at the fork → [] (APPROVAL_RETURN_IN_PARALLEL_UNSUPPORTED)', () => {
    expect(compute(parallelGraph(), 'parallel_1', { metadata: parallelBranchStates({ p1: true, p2: true }) })).toEqual([])
    // ONE pending branch left (a joinMode-all sibling finished) is still the region: the cursor is still the fork.
    expect(compute(parallelGraph(), 'parallel_1', { metadata: parallelBranchStates({ p1: false, p2: true }) })).toEqual([])
  })

  it('parallel state whose fork is not the stored cursor does not block (the door reads that as linear)', () => {
    expect(compute(linearGraph(), 'approval_2', { metadata: parallelBranchStates({ p1: true, p2: true }) })).toEqual(['approval_1'])
  })
})

describe('computeReturnableNodeKeys — the undefined arm (not computed)', () => {
  it('a non-pending instance is never computed, even with legal targets on the trail', () => {
    expect(compute(linearGraph(), 'approval_3', { status: 'approved' })).toBeUndefined()
    expect(compute(linearGraph(), 'approval_3', { status: 'rejected' })).toBeUndefined()
    expect(compute(linearGraph(), 'approval_3', { status: null })).toBeUndefined()
  })

  it('no cursor → undefined', () => {
    expect(compute(linearGraph(), null)).toBeUndefined()
    expect(compute(linearGraph(), '')).toBeUndefined()
  })

  it('no graph, or a blob that is not a graph (a bridged / legacy instance) → undefined', () => {
    expect(compute(null, 'approval_3')).toBeUndefined()
    expect(compute(undefined, 'approval_3')).toBeUndefined()
    expect(compute({}, 'approval_3')).toBeUndefined()
    expect(compute({ nodes: 'x', edges: [] }, 'approval_3')).toBeUndefined()
  })

  it('a malformed graph (no start node) → undefined, never a throw', () => {
    const graph = linearGraph()
    graph.nodes = graph.nodes.filter((node) => node.type !== 'start')
    expect(() => compute(graph, 'approval_3')).not.toThrow()
    expect(compute(graph, 'approval_3')).toBeUndefined()
  })

  it('a cursor the graph does not carry, or that is not an approval node → undefined', () => {
    expect(compute(linearGraph(), 'approval_ghost')).toBeUndefined()
    expect(compute(ccHandlerGraph(), 'cc_1')).toBeUndefined()
    // The fork with NO parallel state is inconsistent data: the walker refuses it, the field is absent.
    expect(compute(parallelGraph(), 'parallel_1')).toBeUndefined()
  })

  it('a cursor unreachable from start, or a cycle, → undefined', () => {
    const graph = linearGraph()
    graph.edges = graph.edges.filter((entry) => entry.key !== 'e2') // approval_2 / approval_3 detached
    expect(compute(graph, 'approval_3')).toBeUndefined()

    const looping = linearGraph()
    looping.edges = [edge('e1', 'start', 'approval_1'), edge('e2', 'approval_1', 'start'), edge('e3', 'approval_2', 'approval_3')]
    expect(compute(looping, 'approval_3')).toBeUndefined()
  })

  it('a formula runtime error (fail-closed in the executor) → undefined, never a throw', () => {
    const graph = conditionGraph('10 / {amount} > 1')
    expect(() => compute(graph, 'approval_final', { formSnapshot: { amount: 0 } })).not.toThrow()
    expect(compute(graph, 'approval_final', { formSnapshot: { amount: 0 } })).toBeUndefined()
  })
})
