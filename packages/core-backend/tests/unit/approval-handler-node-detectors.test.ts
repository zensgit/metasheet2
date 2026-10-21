import { describe, expect, it } from 'vitest'
import {
  assertUserGroupSourcesBoundToOrg,
  collectApprovalGraphMemberGroupIds,
  collectRuntimeGraphRequesterChoiceSources,
  runtimeGraphUsesDeptHeadChain,
  runtimeGraphUsesOrgAssigneeSource,
  runtimeGraphUsesManagerChain,
} from '../../src/services/ApprovalProductService'
import { ServiceError } from '../../src/services/ApprovalBridgeService'
import type { RuntimeGraph } from '../../src/types/approval-product'

/**
 * Lock-3 R-13/R-14 — the create-time org-read fail-closed detectors must include HANDLER nodes.
 *
 * R-14 is the P1 hazard: `runtimeGraphUsesOrgAssigneeSource` drives the create-time guard that
 * fails closed (422/503, zero rows) when the org read FAILED and the graph carries an org-derived
 * source. Leaving the detector approval-only reproduces the B5-b fail-open for a handler. This is
 * the mechanical arm of G-3: the create-side wiring
 * (`if (orgReadFailed && runtimeGraphUsesOrgAssigneeSource(...))`) is shipped and unchanged — only
 * the DETECTOR now recognizes a handler's org source.
 *
 * MUTATION (the guard's load-bearing proof): reverting either detector's arm to `node.type !==
 * 'approval'` REDs the handler cases below while the approval positive controls stay green.
 *
 * W1-1d (Lock-3 §1.5 forward rows, RATIFIED: "`user_group` (K1), `requester_choice` (K2) and
 * `dept_head_at_level` (K5-b) ADMIT") — the SAME silent-skip class for the three forward kinds.
 * Each kind's create/publish collector was approval-only when its own slice landed; admitting the
 * kind on a handler without the collector arm would leave a handler-ONLY carrier unbaked (group
 * members not frozen / choice rejected as UNKNOWN_NODE or never required / dept-head chain not
 * baked), so the handler resolves EMPTY and fails `APPROVAL_ASSIGNEE_EMPTY` at dispatch. The
 * fixtures below put the kind ONLY on the handler node (an approval node carrying the same kind
 * would mask a missing handler arm). MUTATION: reverting any one collector to `node.type !==
 * 'approval'` REDs exactly its handler cases; the approval positive controls stay green.
 */
const POLICY = { allowRevoke: false }

function graph(nodes: RuntimeGraph['nodes']): RuntimeGraph {
  return { nodes, edges: [], policy: POLICY }
}

const START = { key: 'start', type: 'start' as const, config: {} }
const END = { key: 'end', type: 'end' as const, config: {} }

describe('Lock-3 R-14 — runtimeGraphUsesOrgAssigneeSource includes handler nodes', () => {
  it('returns TRUE for a handler node carrying an org-derived source (direct_manager)', () => {
    const g = graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'direct_manager' }] } },
      END,
    ])
    expect(runtimeGraphUsesOrgAssigneeSource(g)).toBe(true)
  })

  it('returns TRUE for a handler using dept_head and manager_at_level', () => {
    expect(runtimeGraphUsesOrgAssigneeSource(graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'dept_head' }] } },
      END,
    ]))).toBe(true)
    expect(runtimeGraphUsesOrgAssigneeSource(graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'manager_at_level', level: 1 }] } },
      END,
    ]))).toBe(true)
  })

  it('positive control: an APPROVAL node with an org source still returns TRUE (guard is not vacuous)', () => {
    const g = graph([
      START,
      { key: 'a', type: 'approval', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single' } },
      END,
    ])
    expect(runtimeGraphUsesOrgAssigneeSource(g)).toBe(true)
  })

  it('negative control: a handler with only a NON-org source (static_user) returns FALSE', () => {
    const g = graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'static_user', userIds: ['u1'] }] } },
      END,
    ])
    expect(runtimeGraphUsesOrgAssigneeSource(g)).toBe(false)
  })
})

describe('Lock-3 R-13 — runtimeGraphUsesManagerChain includes handler nodes', () => {
  it('returns TRUE for a handler using manager_at_level', () => {
    const g = graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'manager_at_level', level: 2 }] } },
      END,
    ])
    expect(runtimeGraphUsesManagerChain(g)).toBe(true)
  })

  it('negative control: a handler with static_user returns FALSE', () => {
    const g = graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'static_user', userIds: ['u1'] }] } },
      END,
    ])
    expect(runtimeGraphUsesManagerChain(g)).toBe(false)
  })
})

// ── W1-1d: Lock-3 §1.5 forward rows — the three create/publish collectors include handler nodes ──

describe('W1-1d / Lock-3 §1.5 — runtimeGraphUsesDeptHeadChain includes handler nodes (K5-b bake)', () => {
  it('returns TRUE for a graph whose ONLY dept_head_at_level carrier is a handler node', () => {
    const g = graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'dept_head_at_level', level: 2 }] } },
      END,
    ])
    expect(runtimeGraphUsesDeptHeadChain(g)).toBe(true)
  })

  it('positive control: an APPROVAL node carrying dept_head_at_level still returns TRUE', () => {
    expect(runtimeGraphUsesDeptHeadChain(graph([
      START,
      { key: 'a', type: 'approval', config: { assigneeSources: [{ kind: 'dept_head_at_level', level: 1 }], approvalMode: 'single' } },
      END,
    ]))).toBe(true)
  })

  it('negative controls: a handler with static_user / manager_at_level (a DIFFERENT chain) returns FALSE', () => {
    expect(runtimeGraphUsesDeptHeadChain(graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'static_user', userIds: ['u1'] }] } },
      END,
    ]))).toBe(false)
    expect(runtimeGraphUsesDeptHeadChain(graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'manager_at_level', level: 1 }] } },
      END,
    ]))).toBe(false)
  })
})

describe('W1-1d / Lock-3 §1.5 — collectApprovalGraphMemberGroupIds includes handler nodes (K1 freeze)', () => {
  it('collects a group id referenced ONLY by a handler node', () => {
    const g = graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'user_group', groupIds: ['grp-handler-only'] }] } },
      END,
    ])
    expect([...collectApprovalGraphMemberGroupIds(g)]).toEqual(['grp-handler-only'])
  })

  it('positive control: an APPROVAL node group id is still collected; handler + approval ids union (trimmed, deduped)', () => {
    const g = graph([
      START,
      { key: 'a', type: 'approval', config: { assigneeSources: [{ kind: 'user_group', groupIds: ['grp-a', ' grp-shared '] }], approvalMode: 'single' } },
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'user_group', groupIds: ['grp-shared', 'grp-h'] }] } },
      END,
    ])
    expect([...collectApprovalGraphMemberGroupIds(g)].sort()).toEqual(['grp-a', 'grp-h', 'grp-shared'])
  })

  it('negative control: a handler with only non-group sources contributes nothing', () => {
    const g = graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'requester' }, { kind: 'direct_manager' }] } },
      END,
    ])
    expect(collectApprovalGraphMemberGroupIds(g).size).toBe(0)
  })
})

describe('W1-1d / Lock-3 §1.5 — assertUserGroupSourcesBoundToOrg checks handler nodes (K1 publish gate)', () => {
  function groupNotBoundCode(fn: () => void): { code: string; nodeKey: unknown } | null {
    try {
      fn()
      return null
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError)
      const typed = error as ServiceError
      return { code: typed.code, nodeKey: (typed.details as { nodeKey?: unknown } | undefined)?.nodeKey }
    }
  }

  it('a handler-ONLY reference to an UNBOUND group fails publish (APPROVAL_ASSIGNEE_GROUP_NOT_BOUND, nodeKey = the handler)', () => {
    const g = graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'user_group', groupIds: ['grp-dangling'] }] } },
      END,
    ])
    expect(groupNotBoundCode(() => assertUserGroupSourcesBoundToOrg(g, new Set(['grp-other'])))).toEqual({
      code: 'APPROVAL_ASSIGNEE_GROUP_NOT_BOUND',
      nodeKey: 'h',
    })
  })

  it('the same handler reference passes once the group is bound (membership-selected, not blanket)', () => {
    const g = graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'user_group', groupIds: ['grp-bound'] }] } },
      END,
    ])
    expect(groupNotBoundCode(() => assertUserGroupSourcesBoundToOrg(g, new Set(['grp-bound'])))).toBeNull()
  })

  it('positive control: an APPROVAL node unbound reference still fails (the gate is not newly invented)', () => {
    const g = graph([
      START,
      { key: 'a', type: 'approval', config: { assigneeSources: [{ kind: 'user_group', groupIds: ['grp-dangling'] }], approvalMode: 'single' } },
      END,
    ])
    expect(groupNotBoundCode(() => assertUserGroupSourcesBoundToOrg(g, new Set()))?.code).toBe('APPROVAL_ASSIGNEE_GROUP_NOT_BOUND')
  })
})

describe('W1-1d / Lock-3 §1.5 — collectRuntimeGraphRequesterChoiceSources includes handler nodes (K2 collector)', () => {
  const choice = { kind: 'requester_choice', mode: 'single', scope: { type: 'company' } }

  it('keys a requester_choice source carried ONLY by a handler node under the handler key', () => {
    const g = graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [choice] } },
      END,
    ])
    const byNode = collectRuntimeGraphRequesterChoiceSources(g)
    expect([...byNode.keys()]).toEqual(['h'])
    expect(byNode.get('h')).toHaveLength(1)
  })

  it('positive control: handler + approval carriers are BOTH keyed, each under its own node key', () => {
    const g = graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [choice] } },
      { key: 'a', type: 'approval', config: { assigneeSources: [choice, choice], approvalMode: 'single' } },
      END,
    ])
    const byNode = collectRuntimeGraphRequesterChoiceSources(g)
    expect([...byNode.keys()].sort()).toEqual(['a', 'h'])
    expect(byNode.get('a')).toHaveLength(2)
    expect(byNode.get('h')).toHaveLength(1)
  })

  it('negative control: a handler without a requester_choice source yields an empty map (opt-in stays opt-in)', () => {
    const g = graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'static_user', userIds: ['u1'] }] } },
      END,
    ])
    expect(collectRuntimeGraphRequesterChoiceSources(g).size).toBe(0)
  })
})
