import { describe, expect, it } from 'vitest'
import { ApprovalGraphExecutor } from '../../src/services/ApprovalGraphExecutor'
import { resolveApprovalAssignees } from '../../src/services/ApprovalAssigneeResolver'
import type { ApprovalGraphAssignmentResolver } from '../../src/services/ApprovalGraphExecutor'
import type { RuntimeGraph } from '../../src/types/approval-product'

// P3-A F4-B — Lock-4 §3 designated empty-assignee fallback
// (docs/development/approval-lock4-flow-policies-20260817.md). `emptyAssigneePolicy: 'designated'`
// carries its target set on the ONE new key `emptyAssigneeFallback`. OD-L4-3(a): 'designated' ONLY —
// 转审批管理员 is expressed by DESIGNATING the admin (as a static_user/static_role target); there is
// NO reverse admin-role lookup, and none is built here.
//
// "Fallback is exactly ONE non-recursive step (locked)." — never chains to 'auto-approve', never
// falls back to a manager, never retries (Gate B-2).
//
// C-1 correction (scout brief §1): `resolveAfterApprove` TAIL-CALLS `resolveFromNode` — they are the
// SAME executor site (site 1). The genuinely SECOND site is `resolveBranchAdvance`, reachable ONLY
// through a parallel branch's second node via `resolveAfterApproveInParallel`. Gate B-1's "BOTH
// executor sites" and gate B-3's two mutation arms are anchored on that structural fact below.

function linearGraph(policyOverrides: {
  emptyAssigneePolicy?: 'error' | 'auto-approve' | 'designated'
  emptyAssigneeFallback?: { userIds?: string[]; roleIds?: string[] }
} = {}): RuntimeGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'empty-node',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: [],
          ...policyOverrides,
        },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-empty', source: 'start', target: 'empty-node' },
      { key: 'edge-empty-end', source: 'empty-node', target: 'end' },
    ],
    policy: { allowRevoke: true },
  }
}

/** A linear predecessor-then-empty-node graph, for exercising `resolveAfterApprove` re-entry. */
function afterApproveGraph(policyOverrides: {
  emptyAssigneePolicy?: 'error' | 'auto-approve' | 'designated'
  emptyAssigneeFallback?: { userIds?: string[]; roleIds?: string[] }
} = {}): RuntimeGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'manager-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['mgr-1'] } },
      {
        key: 'empty-node',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: [],
          ...policyOverrides,
        },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-manager', source: 'start', target: 'manager-review' },
      { key: 'edge-manager-empty', source: 'manager-review', target: 'empty-node' },
      { key: 'edge-empty-end', source: 'empty-node', target: 'end' },
    ],
    policy: { allowRevoke: true },
  }
}

/**
 * Parallel branch fixture: `legal-review` (real assignee) → `legal-review-2` (empty primary source,
 * the fixture's variable policy) → join `finance-review`. `legal-review-2` is reachable ONLY via
 * `resolveAfterApproveInParallel` → `resolveBranchAdvance` (site 2) — never via `resolveFromNode`
 * (site 1), which only ever activates `legal-review` and `compliance-review` for THIS graph. Verified
 * live by the pre-implementation reachability probe (temporary marker at site 2, reverted before any
 * feature code was written).
 */
function parallelBranchSecondNodeGraph(policyOverrides: {
  emptyAssigneePolicy?: 'error' | 'auto-approve' | 'designated'
  emptyAssigneeFallback?: { userIds?: string[]; roleIds?: string[] }
} = {}): RuntimeGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'parallel_fork',
        type: 'parallel',
        config: { branches: ['edge-fork-a', 'edge-fork-b'], joinMode: 'all', joinNodeKey: 'finance-review' },
      },
      { key: 'legal-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['legal-1'] } },
      {
        key: 'legal-review-2',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: [],
          ...policyOverrides,
        },
      },
      { key: 'compliance-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['compliance-1'] } },
      { key: 'finance-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['finance-1'] } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-fork', source: 'start', target: 'parallel_fork' },
      { key: 'edge-fork-a', source: 'parallel_fork', target: 'legal-review' },
      { key: 'edge-fork-b', source: 'parallel_fork', target: 'compliance-review' },
      { key: 'edge-legal-legal2', source: 'legal-review', target: 'legal-review-2' },
      { key: 'edge-legal2-join', source: 'legal-review-2', target: 'finance-review' },
      { key: 'edge-b-join', source: 'compliance-review', target: 'finance-review' },
      { key: 'edge-finance-end', source: 'finance-review', target: 'end' },
    ],
    policy: { allowRevoke: true },
  }
}

describe('P3-A F4-B: designated empty-assignee fallback (Lock-4 §3)', () => {
  it('legacy behavior byte-identical: no emptyAssigneePolicy and no emptyAssigneeFallback (absent) still throws APPROVAL_ASSIGNEE_EMPTY on an empty node', () => {
    const executor = new ApprovalGraphExecutor(linearGraph(), {})
    expect(() => executor.resolveInitialState()).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_ASSIGNEE_EMPTY' }),
    )
  })

  it("gate B-1 \"an empty primary source with 'designated' dispatches to the designated set at BOTH executor sites (initial resolution and resolveAfterApprove)\" — SITE 1 initial resolution (resolveFromNode)", () => {
    const executor = new ApprovalGraphExecutor(
      linearGraph({ emptyAssigneePolicy: 'designated', emptyAssigneeFallback: { userIds: ['admin-1'] } }),
      {},
    )
    const initial = executor.resolveInitialState()
    expect(initial.status).toBe('pending')
    expect(initial.currentNodeKey).toBe('empty-node')
    expect(initial.assignments).toEqual([
      { assignmentType: 'user', assigneeId: 'admin-1', nodeKey: 'empty-node', sourceStep: 1 },
    ])
  })

  it("gate B-1, SITE 1 re-entry via resolveAfterApprove (C-1: resolveAfterApprove tail-calls resolveFromNode, so this is the SAME site as initial resolution, exercised through the after-approve entry point named explicitly by the gate)", () => {
    const executor = new ApprovalGraphExecutor(
      afterApproveGraph({ emptyAssigneePolicy: 'designated', emptyAssigneeFallback: { roleIds: ['approval-admin'] } }),
      {},
    )
    const next = executor.resolveAfterApprove('manager-review')
    expect(next.status).toBe('pending')
    expect(next.currentNodeKey).toBe('empty-node')
    expect(next.assignments).toEqual([
      { assignmentType: 'role', assigneeId: 'approval-admin', nodeKey: 'empty-node', sourceStep: 2 },
    ])
  })

  it("gate B-1 / B-3 — SITE 2 (resolveBranchAdvance, reachable ONLY via a parallel branch's second node) dispatches the designated set", () => {
    const executor = new ApprovalGraphExecutor(
      parallelBranchSecondNodeGraph({ emptyAssigneePolicy: 'designated', emptyAssigneeFallback: { userIds: ['admin-1'] } }),
      {},
    )
    const initial = executor.resolveInitialState()
    const afterLegal = executor.resolveAfterApproveInParallel('legal-review', initial.parallelState!)
    expect(afterLegal.status).toBe('pending')
    // compliance-review is the sibling branch, still untouched and still pending — only
    // legal-review-2's own resolution (the designated fallback) is asserted below.
    expect([...afterLegal.currentNodeKeys!].sort()).toEqual(['compliance-review', 'legal-review-2'])
    expect(afterLegal.assignments).toEqual([
      { assignmentType: 'user', assigneeId: 'admin-1', nodeKey: 'legal-review-2', sourceStep: 2 },
    ])
  })

  it("negative control — \"'error' on the identical fixture still throws APPROVAL_ASSIGNEE_EMPTY\" (linear / SITE 1)", () => {
    const executor = new ApprovalGraphExecutor(linearGraph({ emptyAssigneePolicy: 'error' }), {})
    expect(() => executor.resolveInitialState()).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_ASSIGNEE_EMPTY' }),
    )
  })

  it("negative control — \"'error' on the identical fixture still throws APPROVAL_ASSIGNEE_EMPTY\" (parallel branch / SITE 2)", () => {
    const executor = new ApprovalGraphExecutor(
      parallelBranchSecondNodeGraph({ emptyAssigneePolicy: 'error' }),
      {},
    )
    const initial = executor.resolveInitialState()
    expect(() => executor.resolveAfterApproveInParallel('legal-review', initial.parallelState!)).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_ASSIGNEE_EMPTY' }),
    )
  })

  // Gate B-2 empty-list defense-in-depth: authoring rejects this shape, but a persisted/tampered
  // runtime graph must still fail closed. Production callers separately inject the eligibility
  // resolver for the other two B-2 cases (deactivated user and role with no active members).
  it("gate B-2: \"'designated' resolving to an EMPTY fallback list terminates at APPROVAL_ASSIGNEE_EMPTY with { nodeKey } only; it never becomes auto-approve\" (X-4: values-free payload, no fallback ids)", () => {
    const executor = new ApprovalGraphExecutor(
      linearGraph({ emptyAssigneePolicy: 'designated', emptyAssigneeFallback: { userIds: [], roleIds: [] } }),
      {},
    )
    let caught: unknown
    try {
      executor.resolveInitialState()
    } catch (error) {
      caught = error
    }
    expect(caught).toEqual(
      expect.objectContaining({
        code: 'APPROVAL_ASSIGNEE_EMPTY',
        details: { nodeKey: 'empty-node' },
      }),
    )
    // "never becomes auto-approve": had it wrongly chained, resolution would not throw at all — it
    // would advance past the node. The throw itself is the discriminator.
  })

  it('gate B-2: the designated-only eligibility resolver can reject a non-empty authored fallback', () => {
    const executor = new ApprovalGraphExecutor(
      linearGraph({ emptyAssigneePolicy: 'designated', emptyAssigneeFallback: { userIds: ['inactive-user'] } }),
      {},
      {
        assignmentResolver: ({ nodeKey, sourceStep, config }) => config.assigneeSources ? [{
          assignmentType: 'user',
          assigneeId: 'inactive-user',
          nodeKey,
          sourceStep,
        }] : [],
        designatedFallbackResolver: () => [],
      },
    )

    expect(() => executor.resolveInitialState()).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_ASSIGNEE_EMPTY' }),
    )
  })

  it("gate B-2 negative control — \"a non-empty designated set dispatches - the failure is emptiness-selected\"", () => {
    const executor = new ApprovalGraphExecutor(
      linearGraph({ emptyAssigneePolicy: 'designated', emptyAssigneeFallback: { userIds: ['admin-1'] } }),
      {},
    )
    const initial = executor.resolveInitialState()
    expect(initial.status).toBe('pending')
    expect(initial.assignments).toHaveLength(1)
  })

  it('emptyAssigneePolicy: auto-approve is unaffected — co-located arm, unchanged reason and behavior', () => {
    const executor = new ApprovalGraphExecutor(linearGraph({ emptyAssigneePolicy: 'auto-approve' }), {})
    const initial = executor.resolveInitialState()
    expect(initial.status).toBe('approved')
    expect(initial.autoApprovalEvents).toEqual([
      { nodeKey: 'empty-node', sourceStep: 1, approvalMode: 'single', reason: 'empty-assignee' },
    ])
  })

  it('routes the designated set through the SAME resolveApprovalAssignees path as static_user/static_role — delegation substitution and the seen collapse apply, never hand-built', () => {
    const assignmentResolver: ApprovalGraphAssignmentResolver = ({ nodeKey, sourceStep, config }) =>
      resolveApprovalAssignees({
        nodeKey,
        sourceStep,
        config,
        formSnapshot: {},
        requesterSnapshot: { id: 'requester-1', delegations: { 'admin-1': 'admin-2' } },
      })
    const executor = new ApprovalGraphExecutor(
      linearGraph({
        emptyAssigneePolicy: 'designated',
        emptyAssigneeFallback: { userIds: ['admin-1', 'admin-2'] },
      }),
      {},
      { assignmentResolver },
    )
    const initial = executor.resolveInitialState()
    expect(initial.status).toBe('pending')
    // A delegated to B, and B was already a fallback target: pushResolved's `seen` collapse (applied
    // BEFORE the dedup key) means this resolves to exactly ONE assignment for admin-2, carrying
    // `delegatedFrom` — not two, and not admin-1 undelegated.
    expect(initial.assignments).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'admin-2',
        nodeKey: 'empty-node',
        sourceStep: 1,
        metadata: { resolvedFrom: { kind: 'static_user', sourceIndex: 0 }, delegatedFrom: 'admin-1' },
      },
    ])
  })

  // T2-4 threshold reachability: `resolveDesignatedFallbackAssignments` bypasses
  // `resolveAssignmentsForApprovalNode` (the primary-source path where `assertThresholdReachable`
  // normally runs), so it must re-run that check on its OWN result — otherwise a threshold node whose
  // fallback resolves to FEWER than N distinct approvers dispatches a permanently-unreachable node
  // (the "3-of-2" failure mode assertThresholdReachable's own doc comment describes).
  function thresholdGraph(fallbackUserIds: string[]): RuntimeGraph {
    return {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'empty-node',
          type: 'approval',
          config: {
            assigneeType: 'user',
            assigneeIds: [],
            approvalMode: 'threshold',
            approvalThreshold: 3,
            emptyAssigneePolicy: 'designated',
            emptyAssigneeFallback: { userIds: fallbackUserIds },
          } as never,
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-empty', source: 'start', target: 'empty-node' },
        { key: 'edge-empty-end', source: 'empty-node', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }
  }

  it('threshold reachability is enforced on the DESIGNATED FALLBACK set — a fallback smaller than the node threshold throws APPROVAL_THRESHOLD_UNREACHABLE rather than dispatching an unreachable node', () => {
    const executor = new ApprovalGraphExecutor(thresholdGraph(['admin-1']), {})
    expect(() => executor.resolveInitialState()).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_THRESHOLD_UNREACHABLE' }),
    )
  })

  it('threshold reachability negative control — a fallback with enough distinct approvers to meet the threshold dispatches normally', () => {
    const executor = new ApprovalGraphExecutor(thresholdGraph(['admin-1', 'admin-2', 'admin-3']), {})
    const initial = executor.resolveInitialState()
    expect(initial.status).toBe('pending')
    expect(initial.assignments).toHaveLength(3)
  })
})
