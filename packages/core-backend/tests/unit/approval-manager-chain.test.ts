import { describe, expect, it, vi } from 'vitest'
import {
  resolveApprovalRequesterOrgRelations,
  resolveMaxManagerChainLevels,
  DEFAULT_MAX_MANAGER_CHAIN_LEVELS,
  MANAGER_CHAIN_LEVELS_HARD_CEILING,
} from '../../src/services/ApprovalDirectoryOrg'
import { runtimeGraphUsesManagerChain } from '../../src/services/ApprovalProductService'
import type { RuntimeGraph } from '../../src/types/approval-product'

/**
 * PR-1 (continuous_managers snapshot plumbing) unit test. Drives the management-
 * chain walk through the public `resolveApprovalRequesterOrgRelations` seam with
 * `includeManagerChain`, against an in-memory org graph (no DB). The fake serves
 * the five SELECT shapes the resolver issues — recognizing the new hop query by
 * its `primary_dept_external_id` projection BEFORE the legacy single-hop manager
 * scan so the two don't collide — and models the org as {leader-of-dept,
 * primary-dept-of-person, local-id-of-account} so termination (cycle / top /
 * cap), self-exclusion, unlinked-passthrough, and dedup are all exercised on the
 * real walk, not a stub.
 */

interface OrgModel {
  integrationId: string
  requesterLocalId: string
  requesterExternalId: string
  requesterDeptExternalId: string | null
  leaderOfDept: Record<string, string | undefined>
  primaryDeptOf: Record<string, string | null>
  localByAccountId: Record<string, string | null>
  onHop?: (deptId: string) => void
}

function makeOrgQuery(org: OrgModel) {
  return async <Row>(text: string, params?: unknown[]): Promise<{ rows: Row[] }> => {
    // 1) requester lookup by local user id
    if (text.includes('FROM directory_account_links l') && text.includes('LEFT JOIN directory_account_departments')) {
      if (String(params?.[0]) !== org.requesterLocalId) return { rows: [] }
      return {
        rows: [{
          integration_id: org.integrationId,
          account_id: `acc-${org.requesterExternalId}`,
          external_user_id: org.requesterExternalId,
          raw: {},
          primary_external_department_id: org.requesterDeptExternalId,
          primary_department_raw: {},
        }] as Row[],
      }
    }
    // 2) chain hop query (find dept leader + their primary dept) — recognized by
    //    `primary_dept_external_id`; MUST precede the legacy scan below.
    if (text.includes('primary_dept_external_id') && text.includes('d.external_department_id = $2')) {
      const deptId = String(params?.[1])
      const excludeExternal = String(params?.[2])
      org.onHop?.(deptId)
      const leaderExt = org.leaderOfDept[deptId]
      if (!leaderExt || leaderExt === excludeExternal) return { rows: [] }
      return {
        rows: [{
          account_id: `acc-${leaderExt}`,
          external_user_id: leaderExt,
          raw: { leader_in_dept: [{ dept_id: deptId, leader: true }] },
          primary_dept_external_id: org.primaryDeptOf[leaderExt] ?? null,
        }] as Row[],
      }
    }
    // 3) legacy single-hop manager scan (no primary-dept projection) — empty here;
    //    the direct-manager path is covered by approval-directory-org.test.ts.
    if (text.includes('JOIN directory_account_departments ad') && text.includes('d.external_department_id = $2')) {
      return { rows: [] }
    }
    // 4) local user id by account id
    if (text.includes('FROM directory_account_links') && text.includes('WHERE directory_account_id = $1::uuid')) {
      return { rows: [{ local_user_id: org.localByAccountId[String(params?.[0])] ?? null }] as Row[] }
    }
    // 5) dept-head by-external — empty here (covered elsewhere)
    if (text.includes('JOIN directory_account_links l') && text.includes('a.external_user_id = $2')) {
      return { rows: [] }
    }
    throw new Error(`unexpected query: ${text.slice(0, 80)}`)
  }
}

const BASE = {
  integrationId: 'int-1',
  requesterLocalId: 'u-r',
  requesterExternalId: 'e-r',
  requesterDeptExternalId: 'd-r',
}

describe('manager-chain walk (resolveApprovalRequesterOrgRelations + includeManagerChain)', () => {
  it('walks multiple levels in order, stopping at the top of the tree', async () => {
    const query = makeOrgQuery({
      ...BASE,
      leaderOfDept: { 'd-r': 'e-m1', 'd-m1': 'e-m2', 'd-m2': 'e-m3', 'd-m3': undefined },
      primaryDeptOf: { 'e-m1': 'd-m1', 'e-m2': 'd-m2', 'e-m3': 'd-m3' },
      localByAccountId: { 'acc-e-m1': 'u-m1', 'acc-e-m2': 'u-m2', 'acc-e-m3': 'u-m3' },
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query, { includeManagerChain: true })
    expect(rel.managerChainIds).toEqual(['u-m1', 'u-m2', 'u-m3'])
  })

  it('stops on a cycle (visited-set guard) without looping', async () => {
    const query = makeOrgQuery({
      ...BASE,
      leaderOfDept: { 'd-r': 'e-a', 'd-a': 'e-b', 'd-b': 'e-a' }, // b's dept points back to a
      primaryDeptOf: { 'e-a': 'd-a', 'e-b': 'd-b' },
      localByAccountId: { 'acc-e-a': 'u-a', 'acc-e-b': 'u-b' },
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query, { includeManagerChain: true })
    expect(rel.managerChainIds).toEqual(['u-a', 'u-b'])
  })

  it('excludes the requester themselves (self-led department → empty chain)', async () => {
    const query = makeOrgQuery({
      ...BASE,
      leaderOfDept: { 'd-r': 'e-r' }, // requester leads their own department
      primaryDeptOf: {},
      localByAccountId: {},
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query, { includeManagerChain: true })
    expect(rel.managerChainIds).toBeUndefined()
  })

  it('walks THROUGH an unlinked manager but does not include it', async () => {
    const query = makeOrgQuery({
      ...BASE,
      leaderOfDept: { 'd-r': 'e-m1', 'd-m1': 'e-m2', 'd-m2': undefined },
      primaryDeptOf: { 'e-m1': 'd-m1', 'e-m2': 'd-m2' },
      localByAccountId: { 'acc-e-m1': null, 'acc-e-m2': 'u-m2' }, // m1 unlinked
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query, { includeManagerChain: true })
    expect(rel.managerChainIds).toEqual(['u-m2'])
  })

  it('caps the walk at the requested maxLevels', async () => {
    const query = makeOrgQuery({
      ...BASE,
      leaderOfDept: { 'd-r': 'e-m1', 'd-m1': 'e-m2', 'd-m2': 'e-m3', 'd-m3': 'e-m4' },
      primaryDeptOf: { 'e-m1': 'd-m1', 'e-m2': 'd-m2', 'e-m3': 'd-m3', 'e-m4': 'd-m4' },
      localByAccountId: { 'acc-e-m1': 'u-m1', 'acc-e-m2': 'u-m2', 'acc-e-m3': 'u-m3', 'acc-e-m4': 'u-m4' },
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query, { includeManagerChain: true, maxLevels: 2 })
    expect(rel.managerChainIds).toEqual(['u-m1', 'u-m2'])
  })

  it('dedups a person who appears at two levels', async () => {
    const query = makeOrgQuery({
      ...BASE,
      leaderOfDept: { 'd-r': 'e-a', 'd-a': 'e-b', 'd-b': undefined },
      primaryDeptOf: { 'e-a': 'd-a', 'e-b': 'd-b' },
      localByAccountId: { 'acc-e-a': 'u-x', 'acc-e-b': 'u-x' }, // both map to same local id
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query, { includeManagerChain: true })
    expect(rel.managerChainIds).toEqual(['u-x'])
  })

  it('excludes the requester via an ALT directory account linking to the same local id (self-exclusion on local id, not just external id)', async () => {
    const query = makeOrgQuery({
      ...BASE,
      // d-r's leader is an ALTERNATE account of the requester: a different external id
      // (e-r-alt) that links back to the requester's OWN local id (u-r). Excluding only
      // the starting external id e-r would let this resolve u-r into the chain. The walk
      // must climb THROUGH it to the real next manager (u-m2) and never include u-r.
      leaderOfDept: { 'd-r': 'e-r-alt', 'd-r-alt': 'e-m2', 'd-m2': undefined },
      primaryDeptOf: { 'e-r-alt': 'd-r-alt', 'e-m2': 'd-m2' },
      localByAccountId: { 'acc-e-r-alt': 'u-r', 'acc-e-m2': 'u-m2' },
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query, { includeManagerChain: true })
    expect(rel.managerChainIds).toEqual(['u-m2'])
  })

  it('does NOT walk the chain when includeManagerChain is not set (gating)', async () => {
    let hopIssued = false
    const query = makeOrgQuery({
      ...BASE,
      leaderOfDept: { 'd-r': 'e-m1' },
      primaryDeptOf: { 'e-m1': 'd-m1' },
      localByAccountId: { 'acc-e-m1': 'u-m1' },
      onHop: () => { hopIssued = true },
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query)
    expect(rel.managerChainIds).toBeUndefined()
    expect(hopIssued).toBe(false)
  })
})

describe('runtimeGraphUsesManagerChain (conditional-bake scanner)', () => {
  const graph = (sources: unknown): RuntimeGraph =>
    ({ nodes: [{ key: 'n1', type: 'approval', config: { assigneeSources: sources } }] }) as unknown as RuntimeGraph

  it('detects a continuous_managers source on an approval node', () => {
    expect(runtimeGraphUsesManagerChain(graph([{ kind: 'continuous_managers', levels: 2 }]))).toBe(true)
  })

  // Regression (the bug this rename fixes): a manager_at_level-only template MUST
  // trigger the chain bake. Before the fix the scanner only saw continuous_managers,
  // so createApproval skipped includeManagerChain, the resolver saw an empty chain,
  // and every B1 node fell to emptyAssigneePolicy — breaking B1's happy path.
  it('detects a manager_at_level source on an approval node (B1 bake gate)', () => {
    expect(runtimeGraphUsesManagerChain(graph([{ kind: 'manager_at_level', level: 1 }]))).toBe(true)
    expect(runtimeGraphUsesManagerChain(graph([{ kind: 'manager_at_level', level: 3 }]))).toBe(true)
  })

  it('detects manager_at_level mixed with non-chain sources', () => {
    expect(runtimeGraphUsesManagerChain(graph([{ kind: 'requester' }, { kind: 'manager_at_level', level: 2 }]))).toBe(true)
  })

  it('returns false when only other source kinds are present', () => {
    expect(runtimeGraphUsesManagerChain(graph([{ kind: 'direct_manager' }, { kind: 'static_user', userIds: ['x'] }]))).toBe(false)
  })

  it('returns false for nodes without assignee sources or non-approval nodes', () => {
    expect(runtimeGraphUsesManagerChain({ nodes: [{ key: 'c', type: 'condition', config: {} }] } as unknown as RuntimeGraph)).toBe(false)
    expect(runtimeGraphUsesManagerChain({ nodes: [] } as unknown as RuntimeGraph)).toBe(false)
  })
})

describe('resolveMaxManagerChainLevels (configurable cap, env APPROVAL_MANAGER_CHAIN_MAX_LEVELS)', () => {
  it('defaults to 10 when unconfigured / blank', () => {
    expect(resolveMaxManagerChainLevels(undefined)).toBe(DEFAULT_MAX_MANAGER_CHAIN_LEVELS)
    expect(resolveMaxManagerChainLevels('')).toBe(DEFAULT_MAX_MANAGER_CHAIN_LEVELS)
    expect(resolveMaxManagerChainLevels('   ')).toBe(DEFAULT_MAX_MANAGER_CHAIN_LEVELS)
  })

  it('honors a valid positive integer', () => {
    expect(resolveMaxManagerChainLevels('1')).toBe(1)
    expect(resolveMaxManagerChainLevels('5')).toBe(5)
    expect(resolveMaxManagerChainLevels(String(MANAGER_CHAIN_LEVELS_HARD_CEILING))).toBe(MANAGER_CHAIN_LEVELS_HARD_CEILING)
  })

  it('clamps above the hard ceiling (a misconfig can never make the walk unbounded)', () => {
    expect(resolveMaxManagerChainLevels('100')).toBe(MANAGER_CHAIN_LEVELS_HARD_CEILING)
    expect(resolveMaxManagerChainLevels('99999')).toBe(MANAGER_CHAIN_LEVELS_HARD_CEILING)
  })

  it('fails SAFE to the default on any invalid value (never throws, never 0/negative/fractional)', () => {
    for (const bad of ['0', '-3', '3.5', 'abc', 'NaN', '1e3', '0x10']) {
      expect(resolveMaxManagerChainLevels(bad)).toBe(DEFAULT_MAX_MANAGER_CHAIN_LEVELS)
    }
  })

  // Module-level smoke: the EXPORTED `MAX_MANAGER_CHAIN_LEVELS` is resolved from the env at module
  // LOAD (a deploy-time read), so the pure-resolver tests above don't by themselves prove the exported
  // const honors the env. A fresh import under env=3 must actually yield 3 — `resetModules` + re-import
  // is required because the const is captured once at load. (Restores env + resets in `finally` so the
  // env-loaded instance never leaks into another test.)
  it('module-level MAX_MANAGER_CHAIN_LEVELS reflects the env at load (env=3 → 3, env=invalid → default)', async () => {
    const prev = process.env.APPROVAL_MANAGER_CHAIN_MAX_LEVELS
    try {
      process.env.APPROVAL_MANAGER_CHAIN_MAX_LEVELS = '3'
      vi.resetModules()
      const underEnv3 = await import('../../src/services/ApprovalDirectoryOrg')
      expect(underEnv3.MAX_MANAGER_CHAIN_LEVELS).toBe(3)

      process.env.APPROVAL_MANAGER_CHAIN_MAX_LEVELS = 'not-a-number'
      vi.resetModules()
      const underBadEnv = await import('../../src/services/ApprovalDirectoryOrg')
      expect(underBadEnv.MAX_MANAGER_CHAIN_LEVELS).toBe(underBadEnv.DEFAULT_MAX_MANAGER_CHAIN_LEVELS)
    } finally {
      if (prev === undefined) delete process.env.APPROVAL_MANAGER_CHAIN_MAX_LEVELS
      else process.env.APPROVAL_MANAGER_CHAIN_MAX_LEVELS = prev
      vi.resetModules()
    }
  })
})
