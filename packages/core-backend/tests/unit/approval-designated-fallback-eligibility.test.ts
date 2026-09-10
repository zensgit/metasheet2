import { describe, expect, it, vi } from 'vitest'
import type { RuntimeGraph } from '../../src/types/approval-product'
import { resolveApprovalAssignees } from '../../src/services/ApprovalAssigneeResolver'
import {
  buildApprovalDesignatedFallbackResolver,
  collectApprovalDesignatedFallbackTargets,
  loadApprovalDesignatedFallbackEligibility,
  readApprovalDesignatedFallbackEligibilitySnapshot,
  serializeApprovalDesignatedFallbackEligibility,
} from '../../src/services/approval-designated-fallback-eligibility'

function graph(): RuntimeGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'designated',
        type: 'approval',
        config: {
          assigneeSources: [{ kind: 'static_user', userIds: [] }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'designated',
          emptyAssigneeFallback: {
            userIds: [' active-user ', 'inactive-user', 'active-user'],
            roleIds: ['active-role', 'empty-role', 'active-role'],
          },
        },
      },
      {
        key: 'ordinary-static',
        type: 'approval',
        config: {
          assigneeSources: [
            { kind: 'static_user', userIds: ['ordinary-user'] },
            { kind: 'static_role', roleIds: ['ordinary-role'] },
          ],
          approvalMode: 'single',
        },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [],
    policy: { allowRevoke: false },
  }
}

describe('Lock-4 F4-B designated fallback eligibility', () => {
  it('collects only designated fallback targets and normalizes duplicates', () => {
    const targets = collectApprovalDesignatedFallbackTargets(graph())
    expect([...targets.userIds]).toEqual(['active-user', 'inactive-user'])
    expect([...targets.roleIds]).toEqual(['active-role', 'empty-role'])
  })

  it('loads active users and roles that have at least one active member', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM users')) {
        expect(params).toEqual([['active-user', 'inactive-user']])
        return { rows: [{ id: 'active-user' }] }
      }
      expect(sql).toContain('JOIN users u ON u.id = ur.user_id')
      expect(params).toEqual([['active-role', 'empty-role']])
      return { rows: [{ role_id: 'active-role' }] }
    })

    const eligibility = await loadApprovalDesignatedFallbackEligibility({ query }, graph())

    expect(query).toHaveBeenCalledTimes(2)
    expect([...(eligibility?.userIds ?? [])]).toEqual(['active-user'])
    expect([...(eligibility?.roleIds ?? [])]).toEqual(['active-role'])
  })

  it('does no database work when the graph has no designated fallback', async () => {
    const runtimeGraph = graph()
    const designated = runtimeGraph.nodes.find((node) => node.key === 'designated')
    if (!designated || designated.type !== 'approval') throw new Error('fixture missing designated node')
    delete designated.config.emptyAssigneePolicy
    delete designated.config.emptyAssigneeFallback
    const query = vi.fn()

    await expect(loadApprovalDesignatedFallbackEligibility({ query }, runtimeGraph)).resolves.toBeUndefined()
    expect(query).not.toHaveBeenCalled()
  })

  it('serializes a deterministic create-time snapshot and restores only graph-declared ids', () => {
    const snapshot = serializeApprovalDesignatedFallbackEligibility({
      userIds: new Set(['inactive-user', 'active-user']),
      roleIds: new Set(['empty-role', 'active-role']),
    })
    expect(snapshot).toEqual({
      userIds: ['active-user', 'inactive-user'],
      roleIds: ['active-role', 'empty-role'],
    })

    const restored = readApprovalDesignatedFallbackEligibilitySnapshot(graph(), {
      designatedFallbackEligibility: snapshot,
    })
    expect([...(restored?.userIds ?? [])]).toEqual(['active-user', 'inactive-user'])
    expect([...(restored?.roleIds ?? [])]).toEqual(['active-role', 'empty-role'])
  })

  it.each([
    ['missing', {}],
    ['malformed', { designatedFallbackEligibility: { userIds: true, roleIds: [] } }],
    ['graph-inconsistent', {
      designatedFallbackEligibility: { userIds: ['ordinary-user'], roleIds: [] },
    }],
  ])('fails %s persisted eligibility closed to an empty set', (_label, metadata) => {
    const restored = readApprovalDesignatedFallbackEligibilitySnapshot(graph(), metadata)
    expect([...(restored?.userIds ?? [])]).toEqual([])
    expect([...(restored?.roleIds ?? [])]).toEqual([])
  })

  it('does not require or read a snapshot when the graph has no designated fallback', () => {
    const runtimeGraph = graph()
    const designated = runtimeGraph.nodes.find((node) => node.key === 'designated')
    if (!designated || designated.type !== 'approval') throw new Error('fixture missing designated node')
    delete designated.config.emptyAssigneePolicy
    delete designated.config.emptyAssigneeFallback

    expect(readApprovalDesignatedFallbackEligibilitySnapshot(runtimeGraph, {})).toBeUndefined()
  })

  it('filters only the synthetic designated sources before the ordinary resolver runs', () => {
    const baseResolver = vi.fn((input) => resolveApprovalAssignees({
      ...input,
      formSnapshot: {},
      requesterSnapshot: null,
    }))
    const resolver = buildApprovalDesignatedFallbackResolver(baseResolver, {
      userIds: new Set(['active-user']),
      roleIds: new Set(['active-role']),
    })

    const assignments = resolver?.({
      nodeKey: 'designated',
      sourceStep: 2,
      config: {
        assigneeSources: [
          { kind: 'static_user', userIds: ['active-user', 'inactive-user'] },
          { kind: 'static_role', roleIds: ['active-role', 'empty-role'] },
        ],
      },
    })

    expect(assignments?.map(({ assignmentType, assigneeId }) => ({ assignmentType, assigneeId }))).toEqual([
      { assignmentType: 'user', assigneeId: 'active-user' },
      { assignmentType: 'role', assigneeId: 'active-role' },
    ])
    expect(assignments?.map((assignment) => assignment.metadata?.resolvedFrom?.kind)).toEqual([
      'static_user',
      'static_role',
    ])
  })
})
