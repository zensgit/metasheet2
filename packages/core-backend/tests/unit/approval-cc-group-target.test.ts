import { describe, expect, it } from 'vitest'
import {
  assertApprovalGraph,
  assertUserGroupSourcesBoundToOrg,
  collectApprovalGraphMemberGroupIds,
} from '../../src/services/ApprovalProductService'
import { readGroupMemberIdsSnapshot } from '../../src/services/ApprovalGraphExecutor'
import { APPROVAL_CC_TARGET_TYPES, isApprovalCcTargetType } from '../../src/types/approval-product'
import type { ApprovalGraph } from '../../src/types/approval-product'

/**
 * Lock-1 §K1 / OD-L1-7(a) (RATIFIED, docs/development/approval-lock1-enterprise-assignees-20260817.md)
 * — the cc half's OWN normalize path + the K1 publish gate applied to cc group targets.
 *
 *  - "Cc is a second contract, not a rider … The cc half needs its own normalize path, registry
 *    treatment, and acceptance row (§3 G-4)" — the authoring choke accepts EXACTLY
 *    APPROVAL_CC_TARGET_TYPES ('user' | 'role' | 'group'); anything else is rejected
 *    (G-4 positive control: "the widening is enumerated, not permissive").
 *  - "a group id that does not exist or is outside the org binding is a DIFFERENT case, fail-closed
 *    at publish (§2.2), never at dispatch" — the cc arm of `assertUserGroupSourcesBoundToOrg`
 *    reuses the approver gate (same curated set, same code); its details name the node key and
 *    the offending `targetIndex` (G-18 positive control: never a member id).
 *  - `collectApprovalGraphMemberGroupIds` now scans cc nodes too, so a cc group is FROZEN into
 *    `groupMemberIds` at create (the only membership source the executor's cc arm reads).
 *
 * Executor expansion (per-member user events) is covered in approval-graph-executor.test.ts.
 */

function ccGraph(ccConfig: Record<string, unknown>): ApprovalGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'cc_1', type: 'cc', config: ccConfig as never },
      {
        key: 'approval_1',
        type: 'approval',
        config: { assigneeSources: [{ kind: 'static_user', userIds: ['u-1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-start-cc', source: 'start', target: 'cc_1' },
      { key: 'e-cc-approval', source: 'cc_1', target: 'approval_1' },
      { key: 'e-approval-end', source: 'approval_1', target: 'end' },
    ],
  }
}

describe('OD-L1-7(a) — the enumerated cc target set', () => {
  it('is exactly user / role / group (set equality, not a subset)', () => {
    expect([...APPROVAL_CC_TARGET_TYPES]).toEqual(['user', 'role', 'group'])
    expect(isApprovalCcTargetType('group')).toBe(true)
    expect(isApprovalCcTargetType('user')).toBe(true)
    expect(isApprovalCcTargetType('role')).toBe(true)
    expect(isApprovalCcTargetType('dept')).toBe(false)
    expect(isApprovalCcTargetType('')).toBe(false)
    expect(isApprovalCcTargetType(undefined)).toBe(false)
    expect(isApprovalCcTargetType(['group'])).toBe(false)
  })
})

describe('OD-L1-7(a) — the cc normalize path (assertApprovalGraph → normalizeApprovalGraph case cc)', () => {
  it('accepts targetType group and re-emits it trimmed (the template keeps the group reference)', () => {
    const graph = assertApprovalGraph(ccGraph({ targetType: 'group', targetIds: [' grp-1 ', 'grp-2'] }))
    expect(graph.nodes.find((node) => node.key === 'cc_1')!.config).toEqual({
      targetType: 'group',
      targetIds: ['grp-1', 'grp-2'],
    })
  })

  it('positive control: user and role still normalize exactly as before', () => {
    expect(assertApprovalGraph(ccGraph({ targetType: 'user', targetIds: ['u-2'] })).nodes[1].config)
      .toEqual({ targetType: 'user', targetIds: ['u-2'] })
    expect(assertApprovalGraph(ccGraph({ targetType: 'role', targetIds: ['ops'] })).nodes[1].config)
      .toEqual({ targetType: 'role', targetIds: ['ops'] })
  })

  it('G-4 positive control: a NON-ratified targetType is still rejected at the choke (enumerated, not permissive)', () => {
    expect(() => assertApprovalGraph(ccGraph({ targetType: 'dept', targetIds: ['d-1'] })))
      .toThrow(/approvalGraph\.nodes\[1\]\.config must define targetType and targetIds/)
    expect(() => assertApprovalGraph(ccGraph({ targetType: 'Group', targetIds: ['grp-1'] })))
      .toThrow(/must define targetType and targetIds/)
    // Group ids are strings — the same non-empty-string rule user/role targets obey.
    expect(() => assertApprovalGraph(ccGraph({ targetType: 'group', targetIds: ['grp-1', ''] })))
      .toThrow(/must define targetType and targetIds/)
  })
})

describe('OD-L1-7(a) — collectApprovalGraphMemberGroupIds scans cc group targets', () => {
  const graph: ApprovalGraph = {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'cc_group', type: 'cc', config: { targetType: 'group', targetIds: [' grp-b ', 'grp-c'] } },
      { key: 'cc_role', type: 'cc', config: { targetType: 'role', targetIds: ['grp-role-lookalike'] } },
      { key: 'cc_user', type: 'cc', config: { targetType: 'user', targetIds: ['grp-user-lookalike'] } },
      {
        key: 'approval_1',
        type: 'approval',
        config: { assigneeSources: [{ kind: 'user_group', groupIds: ['grp-a'] }], approvalMode: 'all', emptyAssigneePolicy: 'error' },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'cc_group' },
      { key: 'e2', source: 'cc_group', target: 'cc_role' },
      { key: 'e3', source: 'cc_role', target: 'cc_user' },
      { key: 'e4', source: 'cc_user', target: 'approval_1' },
      { key: 'e5', source: 'approval_1', target: 'end' },
    ],
  }

  it('collects approver user_group ids AND cc group target ids (trimmed), and nothing from user/role cc nodes', () => {
    const ids = collectApprovalGraphMemberGroupIds(graph)
    expect([...ids].sort()).toEqual(['grp-a', 'grp-b', 'grp-c'])
    // Kind-selected: a user/role cc target id never enters the freeze set.
    expect(ids.has('grp-role-lookalike')).toBe(false)
    expect(ids.has('grp-user-lookalike')).toBe(false)
  })

  it('a graph whose cc nodes are all user/role contributes nothing (opt-in posture preserved)', () => {
    const ids = collectApprovalGraphMemberGroupIds(ccGraph({ targetType: 'role', targetIds: ['ops'] }))
    expect(ids.size).toBe(0)
  })
})

describe('OD-L1-7(a) — assertUserGroupSourcesBoundToOrg applies the K1 binding gate to cc group targets', () => {
  const graph = ccGraph({ targetType: 'group', targetIds: ['grp-bound', 'grp-dangling'] })

  it('fails closed at publish for a cc group outside the curated set — values-free, naming node key + targetIndex', () => {
    let caught: unknown
    try {
      assertUserGroupSourcesBoundToOrg(graph, new Set(['grp-bound']))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    const err = caught as Error & { statusCode?: number; code?: string; details?: Record<string, unknown> }
    expect(err.statusCode).toBe(400)
    expect(err.code).toBe('APPROVAL_ASSIGNEE_GROUP_NOT_BOUND')
    expect(err.details).toEqual({ nodeKey: 'cc_1', targetIndex: 1, groupId: 'grp-dangling', reason: 'not-bound' })
    expect(err.message).toContain('cc_1')
    expect(err.message).toContain('targetIds[1]')
    // G-18: the gate reads only template-authored ids — no member id can appear because none is read.
    expect(err.message).not.toMatch(/u-1/)
    expect(JSON.stringify(err.details)).not.toMatch(/u-1/)
  })

  it('positive control: the same cc group INSIDE the curated set publishes (membership-selected)', () => {
    expect(() => assertUserGroupSourcesBoundToOrg(graph, new Set(['grp-bound', 'grp-dangling']))).not.toThrow()
  })

  it('kind-selected: a user/role cc target whose id is not a curated group is NOT gated', () => {
    expect(() => assertUserGroupSourcesBoundToOrg(ccGraph({ targetType: 'role', targetIds: ['grp-dangling'] }), new Set())).not.toThrow()
    expect(() => assertUserGroupSourcesBoundToOrg(ccGraph({ targetType: 'user', targetIds: ['grp-dangling'] }), new Set())).not.toThrow()
  })

  it('the approver arm is untouched: an unbound user_group source still reports sourceIndex (not targetIndex)', () => {
    const approverGraph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          config: { assigneeSources: [{ kind: 'user_group', groupIds: ['grp-dangling'] }], approvalMode: 'all', emptyAssigneePolicy: 'error' },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'end' },
      ],
    }
    let caught: unknown
    try {
      assertUserGroupSourcesBoundToOrg(approverGraph, new Set())
    } catch (error) {
      caught = error
    }
    const err = caught as Error & { details?: Record<string, unknown> }
    expect(err.details).toEqual({ nodeKey: 'approval_1', sourceIndex: 0, groupId: 'grp-dangling', reason: 'not-bound' })
  })
})

describe('OD-L1-7(a) — readGroupMemberIdsSnapshot (dispatch-side snapshot reader)', () => {
  it('reads only string-keyed arrays of non-empty strings, trimmed; everything else is {} / dropped', () => {
    expect(readGroupMemberIdsSnapshot(null)).toEqual({})
    expect(readGroupMemberIdsSnapshot(undefined)).toEqual({})
    expect(readGroupMemberIdsSnapshot({ id: 'u-1' })).toEqual({})
    expect(readGroupMemberIdsSnapshot({ groupMemberIds: 'nope' })).toEqual({})
    expect(readGroupMemberIdsSnapshot({ groupMemberIds: { g1: ['u-1', ' u-2 ', '', 3, null], g2: 'nope', g3: [] } }))
      .toEqual({ g1: ['u-1', 'u-2'], g3: [] })
  })
})
