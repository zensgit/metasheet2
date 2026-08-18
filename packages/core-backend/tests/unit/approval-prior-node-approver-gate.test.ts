import { describe, expect, it } from 'vitest'
import {
  assertPriorNodeApproverReferencesUpstream,
  collectRuntimeGraphPriorNodeApproverTargets,
} from '../../src/services/ApprovalProductService'
import type { ApprovalGraph, RuntimeGraph } from '../../src/types/approval-product'

/**
 * Lock-1 §K3 publish gate (`assertPriorNodeApproverReferencesUpstream`) — the DOMINANCE predicate:
 * a `prior_node_approver` reference must name an `approval` node STRICTLY UPSTREAM on EVERY
 * runtime-reachable path from start to the carrying node (G-10). Pure graph-shape oracle over the
 * exported gate; the real-DB acceptance suite proves the publish-choke WIRING of the same gate
 * over HTTP. Every rejection case is paired with a passing shape so the gate is shown to be
 * shape-selected, not blanket.
 */

function approvalNode(key: string, sources: Array<Record<string, unknown>>): ApprovalGraph['nodes'][number] {
  return { key, type: 'approval', config: { assigneeSources: sources } as never }
}
function staticSource(userId: string): Record<string, unknown> {
  return { kind: 'static_user', userIds: [userId] }
}
function priorSource(nodeKey: string): Record<string, unknown> {
  return { kind: 'prior_node_approver', nodeKey }
}
function linearGraph(nodes: ApprovalGraph['nodes']): ApprovalGraph {
  const keys = ['start', ...nodes.map((node) => node.key), 'end']
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      ...nodes,
      { key: 'end', type: 'end', config: {} },
    ],
    edges: keys.slice(0, -1).map((source, index) => ({
      key: `edge-${source}-${keys[index + 1]}`,
      source,
      target: keys[index + 1],
    })),
  }
}

function gateError(graph: ApprovalGraph): { code?: string; details?: Record<string, unknown> } | null {
  try {
    assertPriorNodeApproverReferencesUpstream(graph)
    return null
  } catch (error) {
    const serviceError = error as { code?: string; details?: Record<string, unknown>; message?: string }
    return { code: serviceError.code, details: serviceError.details }
  }
}

describe('Lock-1 §K3 assertPriorNodeApproverReferencesUpstream (G-10 dominance)', () => {
  it('passes a legal strictly-upstream linear reference (positive control), and a graph with no prior_node_approver at all', () => {
    expect(gateError(linearGraph([
      approvalNode('gate', [staticSource('u1')]),
      approvalNode('again', [priorSource('gate')]),
    ]))).toBeNull()
    expect(gateError(linearGraph([
      approvalNode('gate', [staticSource('u1')]),
      approvalNode('next', [staticSource('u2')]),
    ]))).toBeNull()
  })

  it('rejects a dangling reference (no such node), values-free with node key + source index + reason', () => {
    const error = gateError(linearGraph([
      approvalNode('gate', [staticSource('u1')]),
      approvalNode('again', [staticSource('u2'), priorSource('nope')]),
    ]))
    expect(error?.code).toBe('APPROVAL_ASSIGNEE_PRIOR_NODE_REFERENCE_INVALID')
    expect(error?.details).toEqual({ nodeKey: 'again', sourceIndex: 1, targetNodeKey: 'nope', reason: 'dangling' })
  })

  it('rejects a self-reference', () => {
    const error = gateError(linearGraph([
      approvalNode('gate', [staticSource('u1')]),
      approvalNode('again', [priorSource('again')]),
    ]))
    expect(error?.code).toBe('APPROVAL_ASSIGNEE_PRIOR_NODE_REFERENCE_INVALID')
    expect(error?.details?.reason).toBe('self')
  })

  it('rejects a reference to a NON-approval node (start / cc), even when it is upstream on every path', () => {
    const graph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'notify', type: 'cc', config: { targetType: 'user', targetIds: ['u9'] } as never },
        approvalNode('again', [priorSource('notify')]),
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'notify' },
        { key: 'e2', source: 'notify', target: 'again' },
        { key: 'e3', source: 'again', target: 'end' },
      ],
    }
    expect(gateError(graph)?.details?.reason).toBe('not-approval')
    const startRef = gateError(linearGraph([approvalNode('again', [priorSource('start')])]))
    expect(startRef?.details?.reason).toBe('not-approval')
  })

  it('rejects a DOWNSTREAM reference (the target has not decided when the carrier activates)', () => {
    const error = gateError(linearGraph([
      approvalNode('first', [priorSource('later')]),
      approvalNode('later', [staticSource('u2')]),
    ]))
    expect(error?.code).toBe('APPROVAL_ASSIGNEE_PRIOR_NODE_REFERENCE_INVALID')
    expect(error?.details?.reason).toBe('not-upstream-on-every-path')
  })

  it('condition case (G-10): a target reachable only through ONE condition branch is rejected after the merge; a pre-condition target passes (the rejection is path-selected)', () => {
    const conditionGraph = (targetKey: string): ApprovalGraph => ({
      nodes: [
        { key: 'start', type: 'start', config: {} },
        approvalNode('pre', [staticSource('u0')]),
        {
          key: 'route',
          type: 'condition',
          config: {
            branches: [{ edgeKey: 'edge-b1', rules: [{ fieldId: 'amount', operator: 'gt', value: 1 }] }],
            defaultEdgeKey: 'edge-b2',
          } as never,
        },
        approvalNode('branch-a', [staticSource('u1')]),
        approvalNode('branch-b', [staticSource('u2')]),
        approvalNode('merge', [priorSource(targetKey)]),
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e-start-pre', source: 'start', target: 'pre' },
        { key: 'e-pre-route', source: 'pre', target: 'route' },
        { key: 'edge-b1', source: 'route', target: 'branch-a' },
        { key: 'edge-b2', source: 'route', target: 'branch-b' },
        { key: 'e-a-merge', source: 'branch-a', target: 'merge' },
        { key: 'e-b-merge', source: 'branch-b', target: 'merge' },
        { key: 'e-merge-end', source: 'merge', target: 'end' },
      ],
    })
    // branch-a decides only on the edge-b1 path — the default path reaches `merge` without it.
    expect(gateError(conditionGraph('branch-a'))?.details?.reason).toBe('not-upstream-on-every-path')
    // The pre-condition node is on EVERY path — legal (positive control: same graph, different target).
    expect(gateError(conditionGraph('pre'))).toBeNull()
  })

  it('parallel case (G-10): a target inside one parallel branch is rejected from a sibling branch AND from past the join (conservative even for joinMode all); a same-branch upstream target and a pre-fork target pass', () => {
    const parallelGraph = (carrierKey: 'sibling' | 'after-join' | 'same-branch', targetKey: string): ApprovalGraph => {
      const withPrior = (key: string, base: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
        key === carrierKey ? [...base, priorSource(targetKey)] : base
      return {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          approvalNode('pre', [staticSource('u0')]),
          {
            key: 'fork',
            type: 'parallel',
            config: { branches: ['edge-p1', 'edge-p2'], joinMode: 'all', joinNodeKey: 'join' } as never,
          },
          approvalNode('inside-a', [staticSource('u1')]),
          approvalNode('same-branch', withPrior('same-branch', [staticSource('u3')])),
          approvalNode('sibling', withPrior('sibling', [staticSource('u2')])),
          approvalNode('join', [staticSource('u4')]),
          approvalNode('after-join', withPrior('after-join', [staticSource('u5')])),
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-start-pre', source: 'start', target: 'pre' },
          { key: 'e-pre-fork', source: 'pre', target: 'fork' },
          { key: 'edge-p1', source: 'fork', target: 'inside-a' },
          { key: 'e-a-same', source: 'inside-a', target: 'same-branch' },
          { key: 'e-same-join', source: 'same-branch', target: 'join' },
          { key: 'edge-p2', source: 'fork', target: 'sibling' },
          { key: 'e-sib-join', source: 'sibling', target: 'join' },
          { key: 'e-join-after', source: 'join', target: 'after-join' },
          { key: 'e-after-end', source: 'after-join', target: 'end' },
        ],
      }
    }
    // Sibling branch: `sibling` references `inside-a` — active simultaneously, never dominant.
    expect(gateError(parallelGraph('sibling', 'inside-a'))?.details?.reason).toBe('not-upstream-on-every-path')
    // Past the join: still rejected (a sibling-branch path reaches the join without inside-a) —
    // the lock's conservative "may not have decided" posture, even under joinMode 'all'.
    expect(gateError(parallelGraph('after-join', 'inside-a'))?.details?.reason).toBe('not-upstream-on-every-path')
    // SAME-branch upstream: `same-branch` references `inside-a` — every path to it passes
    // inside-a (a sibling path cannot re-enter this branch before the join) — legal.
    expect(gateError(parallelGraph('same-branch', 'inside-a'))).toBeNull()
    // Pre-fork target from past the join — on every path — legal (positive control).
    expect(gateError(parallelGraph('after-join', 'pre'))).toBeNull()
  })
})

describe('Lock-1 §K3 collectRuntimeGraphPriorNodeApproverTargets (OPT-IN detector)', () => {
  const asRuntime = (graph: ApprovalGraph): RuntimeGraph => ({ ...graph, policy: { allowRevoke: true } })

  it('returns the referenced node-key set for approval nodes, and an EMPTY set for a graph with no prior_node_approver (unrelated approvals pay nothing)', () => {
    expect([...collectRuntimeGraphPriorNodeApproverTargets(asRuntime(linearGraph([
      approvalNode('gate', [staticSource('u1')]),
      approvalNode('again', [priorSource('gate')]),
      approvalNode('again2', [priorSource('gate'), priorSource('again')]),
    ])))].sort()).toEqual(['again', 'gate'])
    expect(collectRuntimeGraphPriorNodeApproverTargets(asRuntime(linearGraph([
      approvalNode('gate', [staticSource('u1')]),
    ]))).size).toBe(0)
  })
})
