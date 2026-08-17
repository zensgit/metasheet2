import { describe, expect, it } from 'vitest'
import { resolveApprovalRequesterOrgRelations } from '../../src/services/ApprovalDirectoryOrg'
import { runtimeGraphUsesDeptHeadChain, runtimeGraphUsesOrgAssigneeSource } from '../../src/services/ApprovalProductService'
import type { RuntimeGraph } from '../../src/types/approval-product'

/**
 * Lock-1 §K4 `continuous_dept_heads` — department-head chain walk unit test. Drives
 * `resolveDeptHeadChain` through the public `resolveApprovalRequesterOrgRelations` seam
 * (`includeDeptHeadChain`) against an in-memory org graph (no DB). The fake models the org as
 * departments keyed by external id, each with its own `dept_manager_userid_list` and
 * `external_parent_department_id` — a DIFFERENT pointer from the shipped
 * `resolveManagerChain`/`leader_in_dept` walk that `approval-manager-chain.test.ts` covers.
 *
 * The load-bearing proof here is the RATIFIED continue-past-empty-level posture (Lock-1 §K4,
 * confirmed BINDING by Lock-2): a level whose manager list is empty, or whose ids all resolve to
 * no linked local user, contributes NOTHING to the chain but does NOT terminate the walk — the
 * next hop is read from the department's OWN parent pointer, never from a resolved manager. Both
 * causes are covered separately, each with an `onDeptHop` trace proving the level BEYOND the empty
 * one really was queried (not just present in the expected array by coincidence).
 */

interface DeptModel {
  managerExternalIds: string[]
  parentExternalId: string | null
}

interface DeptOrgModel {
  integrationId: string
  requesterLocalId: string
  requesterExternalId: string
  requesterDeptExternalId: string | null
  departments: Record<string, DeptModel>
  localByExternalId: Record<string, string | null>
  onDeptHop?: (deptExternalId: string) => void
}

function makeDeptOrgQuery(org: DeptOrgModel) {
  return async <Row>(text: string, params?: unknown[]): Promise<{ rows: Row[] }> => {
    // 0) B5-b routing-policy probe — empty rows = no policy = legacy fixture path.
    if (text.includes('FROM directory_account_links l') && text.includes('org_directory_routing_policy')) {
      return { rows: [] }
    }
    // 1) requester lookup by local user id.
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
    // 1b) B3 normalized-manager gate — empty here, so direct-manager resolution (unrelated to
    //     this chain) falls through to the legacy leader_in_dept scan (branch 3, also empty).
    if (text.includes('ad.is_manager = true')) return { rows: [] }
    // 2) K4 department-hop query — recognized by `external_parent_department_id`, a projection
    //    ONLY this query selects (distinct from `findDeptLeaderHop`'s `primary_dept_external_id`).
    if (text.includes('FROM directory_departments') && text.includes('external_parent_department_id')) {
      const deptId = String(params?.[1])
      org.onDeptHop?.(deptId)
      const dept = org.departments[deptId]
      if (!dept) return { rows: [] }
      return {
        rows: [{
          raw: { dept_manager_userid_list: dept.managerExternalIds },
          external_parent_department_id: dept.parentExternalId,
        }] as Row[],
      }
    }
    // 3) legacy single-hop direct-manager scan — empty (unrelated to this chain).
    if (text.includes('JOIN directory_account_departments ad') && text.includes('d.external_department_id = $2')) {
      return { rows: [] }
    }
    // 4) local user id BY ACCOUNT id — empty (unrelated to this chain; the direct-manager path).
    if (text.includes('FROM directory_account_links') && text.includes('WHERE directory_account_id = $1::uuid')) {
      return { rows: [{ local_user_id: null }] as Row[] }
    }
    // 5) local user id BY EXTERNAL id — the "primary head" resolution both the single-level
    //    dept_head computation and resolveDeptHeadChain use.
    if (text.includes('JOIN directory_account_links l') && text.includes('a.external_user_id = $2')) {
      const external = String(params?.[1])
      const localId = org.localByExternalId[external] ?? null
      return { rows: (localId !== null ? [{ local_user_id: localId }] : []) as Row[] }
    }
    throw new Error(`unexpected query: ${text.slice(0, 80)}`)
  }
}

const BASE = {
  integrationId: 'int-1',
  requesterLocalId: 'u-r',
  requesterExternalId: 'e-r',
  requesterDeptExternalId: 'd1',
}

describe('dept-head chain walk (resolveApprovalRequesterOrgRelations + includeDeptHeadChain)', () => {
  it('walks multiple levels in order, stopping at the top of the tree (positive control: every level resolvable)', async () => {
    const query = makeDeptOrgQuery({
      ...BASE,
      departments: {
        d1: { managerExternalIds: ['e-h1'], parentExternalId: 'd2' },
        d2: { managerExternalIds: ['e-h2'], parentExternalId: 'd3' },
        d3: { managerExternalIds: ['e-h3'], parentExternalId: null },
      },
      localByExternalId: { 'e-h1': 'u-h1', 'e-h2': 'u-h2', 'e-h3': 'u-h3' },
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query, { includeDeptHeadChain: true })
    expect(rel.deptHeadChainIds).toEqual(['u-h1', 'u-h2', 'u-h3'])
  })

  it('CONTINUES past a level whose manager list is EMPTY (ratified Lock-1 §K4 posture) — the level beyond it is proven queried, not merely present', async () => {
    const hopped: string[] = []
    const query = makeDeptOrgQuery({
      ...BASE,
      departments: {
        d1: { managerExternalIds: ['e-h1'], parentExternalId: 'd2' },
        d2: { managerExternalIds: [], parentExternalId: 'd3' }, // EMPTY list — contributes nothing
        d3: { managerExternalIds: ['e-h3'], parentExternalId: null },
      },
      localByExternalId: { 'e-h1': 'u-h1', 'e-h3': 'u-h3' },
      onDeptHop: (deptId) => hopped.push(deptId),
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query, { includeDeptHeadChain: true })
    expect(rel.deptHeadChainIds).toEqual(['u-h1', 'u-h3']) // d2 contributes nothing but does not truncate
    expect(hopped).toEqual(['d1', 'd2', 'd3']) // d3 WAS queried — the walk actually continued past d2
  })

  it('CONTINUES past a level whose manager list resolves to NO LINKED user (the other empty-level cause)', async () => {
    const hopped: string[] = []
    const query = makeDeptOrgQuery({
      ...BASE,
      departments: {
        d1: { managerExternalIds: ['e-h1'], parentExternalId: 'd2' },
        d2: { managerExternalIds: ['e-unlinked'], parentExternalId: 'd3' }, // present but UNLINKED
        d3: { managerExternalIds: ['e-h3'], parentExternalId: null },
      },
      localByExternalId: { 'e-h1': 'u-h1', 'e-h3': 'u-h3' }, // e-unlinked deliberately absent
      onDeptHop: (deptId) => hopped.push(deptId),
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query, { includeDeptHeadChain: true })
    expect(rel.deptHeadChainIds).toEqual(['u-h1', 'u-h3'])
    expect(hopped).toEqual(['d1', 'd2', 'd3'])
  })

  it('stops on a department-parent cycle (visited-set guard) without looping', async () => {
    const query = makeDeptOrgQuery({
      ...BASE,
      departments: {
        d1: { managerExternalIds: ['e-h1'], parentExternalId: 'd2' },
        d2: { managerExternalIds: ['e-h2'], parentExternalId: 'd1' }, // points back to d1
      },
      localByExternalId: { 'e-h1': 'u-h1', 'e-h2': 'u-h2' },
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query, { includeDeptHeadChain: true })
    expect(rel.deptHeadChainIds).toEqual(['u-h1', 'u-h2'])
  })

  it('caps the walk at the requested maxLevels', async () => {
    const query = makeDeptOrgQuery({
      ...BASE,
      departments: {
        d1: { managerExternalIds: ['e-h1'], parentExternalId: 'd2' },
        d2: { managerExternalIds: ['e-h2'], parentExternalId: 'd3' },
        d3: { managerExternalIds: ['e-h3'], parentExternalId: 'd4' },
        d4: { managerExternalIds: ['e-h4'], parentExternalId: null },
      },
      localByExternalId: { 'e-h1': 'u-h1', 'e-h2': 'u-h2', 'e-h3': 'u-h3', 'e-h4': 'u-h4' },
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query, { includeDeptHeadChain: true, maxLevels: 2 })
    expect(rel.deptHeadChainIds).toEqual(['u-h1', 'u-h2'])
  })

  it('excludes the requester themselves via the EXTERNAL-id filter (pre-resolution) — the level is consumed (walk continues) but nothing is pushed', async () => {
    // Correction (P2 fix round, 20260817): this test's earlier title claimed to cover the
    // LOCAL-id guard (the `localId !== requesterLocalId` conjunct in `resolveDeptHeadChain`),
    // but its fixture uses `e-r` — the requester's own EXTERNAL id — which is removed by the
    // pre-resolution `.filter((external) => external !== requesterExternalId)` BEFORE the
    // local-id check ever runs. It genuinely proves the external-id filter and the
    // continue-past-empty posture; it does NOT exercise the local-id guard. See the next test
    // for that.
    const hopped: string[] = []
    const query = makeDeptOrgQuery({
      ...BASE,
      departments: {
        d1: { managerExternalIds: ['e-r'], parentExternalId: 'd2' }, // requester listed as their own dept's head
        d2: { managerExternalIds: ['e-h2'], parentExternalId: null },
      },
      // NOTE: e-r is the requester's OWN external id, filtered out by the per-level exclusion
      // before resolution is even attempted (byte-identical to the single-level dept_head rule).
      localByExternalId: { 'e-h2': 'u-h2' },
      onDeptHop: (deptId) => hopped.push(deptId),
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query, { includeDeptHeadChain: true })
    expect(rel.deptHeadChainIds).toEqual(['u-h2'])
    expect(hopped).toEqual(['d1', 'd2'])
  })

  it('excludes the requester\'s OWN local id when reached via a DIFFERENT (alt-account) external id — the `localId !== requesterLocalId` guard, not the external-id filter above', async () => {
    // Reachability (multi-account org, e.g. DingTalk): the requester has TWO directory accounts
    // linked to the SAME local user — their normal external id (`e-r`, excluded above by the
    // filter) and an alt-account external id (`e-r-alt`) that is unrelated to `e-r` but resolves
    // to the SAME local user. `e-r-alt` is listed FIRST in an ancestor dept's manager list, ahead
    // of the department's real (different-person) head `e-h1`. The inner loop resolves `e-r-alt`
    // to a local id on its first iteration and `break`s immediately — `e-h1` is never even
    // queried — so the `localId !== requesterLocalId` self-exclusion is the ONLY thing standing
    // between the requester's own alt-account local id and the chain. Mutating away that conjunct
    // makes this level push `u-r` (the requester) instead of contributing nothing, and the walk
    // still continues to d2 either way — proving the guard, not merely the continue-past-empty
    // posture.
    const hopped: string[] = []
    const query = makeDeptOrgQuery({
      ...BASE,
      departments: {
        d1: { managerExternalIds: ['e-r-alt', 'e-h1'], parentExternalId: 'd2' },
        d2: { managerExternalIds: ['e-h2'], parentExternalId: null },
      },
      // e-r-alt is a DIFFERENT external id from the requester's own (e-r) — it survives the
      // pre-resolution external-id filter — but resolves to the SAME local user as the requester.
      localByExternalId: { 'e-r-alt': BASE.requesterLocalId, 'e-h1': 'u-h1', 'e-h2': 'u-h2' },
      onDeptHop: (deptId) => hopped.push(deptId),
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query, { includeDeptHeadChain: true })
    expect(rel.deptHeadChainIds).toEqual(['u-h2'])
    expect(hopped).toEqual(['d1', 'd2'])
  })

  it('requester with no primary department resolves an empty chain without querying', async () => {
    const hopped: string[] = []
    const query = makeDeptOrgQuery({
      ...BASE,
      requesterDeptExternalId: null,
      departments: {},
      localByExternalId: {},
      onDeptHop: (deptId) => hopped.push(deptId),
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query, { includeDeptHeadChain: true })
    expect(rel.deptHeadChainIds).toBeUndefined()
    expect(hopped).toEqual([])
  })

  it('does NOT walk the chain when includeDeptHeadChain is not set (gating — same opt-in posture as includeManagerChain)', async () => {
    let hopped = false
    const query = makeDeptOrgQuery({
      ...BASE,
      departments: { d1: { managerExternalIds: ['e-h1'], parentExternalId: null } },
      localByExternalId: { 'e-h1': 'u-h1' },
      onDeptHop: () => { hopped = true },
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query)
    expect(rel.deptHeadChainIds).toBeUndefined()
    expect(hopped).toBe(false)
  })

  it('is a SEPARATE opt-in from includeManagerChain — requesting only the manager chain does not walk the dept-head chain', async () => {
    let hopped = false
    const query = makeDeptOrgQuery({
      ...BASE,
      departments: { d1: { managerExternalIds: ['e-h1'], parentExternalId: null } },
      localByExternalId: { 'e-h1': 'u-h1' },
      onDeptHop: () => { hopped = true },
    })
    const rel = await resolveApprovalRequesterOrgRelations('u-r', query, { includeManagerChain: true })
    expect(rel.deptHeadChainIds).toBeUndefined()
    expect(hopped).toBe(false)
  })
})

describe('runtimeGraphUsesDeptHeadChain (K4 conditional-bake scanner)', () => {
  const graph = (sources: unknown): RuntimeGraph =>
    ({ nodes: [{ key: 'n1', type: 'approval', config: { assigneeSources: sources } }] }) as unknown as RuntimeGraph

  it('detects a continuous_dept_heads source on an approval node', () => {
    expect(runtimeGraphUsesDeptHeadChain(graph([{ kind: 'continuous_dept_heads', levels: 3 }]))).toBe(true)
  })

  it('detects continuous_dept_heads mixed with non-chain sources', () => {
    expect(runtimeGraphUsesDeptHeadChain(graph([{ kind: 'requester' }, { kind: 'continuous_dept_heads', levels: 1 }]))).toBe(true)
  })

  it('returns false for continuous_managers / manager_at_level — a SEPARATE gate from runtimeGraphUsesManagerChain, not a relabeling', () => {
    expect(runtimeGraphUsesDeptHeadChain(graph([{ kind: 'continuous_managers', levels: 2 }]))).toBe(false)
    expect(runtimeGraphUsesDeptHeadChain(graph([{ kind: 'manager_at_level', level: 1 }]))).toBe(false)
  })

  it('returns false when only other source kinds are present, and for non-approval / sourceless nodes', () => {
    expect(runtimeGraphUsesDeptHeadChain(graph([{ kind: 'direct_manager' }, { kind: 'static_user', userIds: ['x'] }]))).toBe(false)
    expect(runtimeGraphUsesDeptHeadChain({ nodes: [{ key: 'c', type: 'condition', config: {} }] } as unknown as RuntimeGraph)).toBe(false)
    expect(runtimeGraphUsesDeptHeadChain({ nodes: [] } as unknown as RuntimeGraph)).toBe(false)
  })
})

// G-20: the org-read fail-closed detector (§2.1) MUST be extended to continuous_dept_heads — this
// is the mechanical proof the extension is load-bearing (mutate by deleting the union member from
// ApprovalProductService.ts's runtimeGraphUsesOrgAssigneeSource and this test reds).
describe('runtimeGraphUsesOrgAssigneeSource — K4 extension (Lock-1 §2.1, G-20 detector)', () => {
  const graph = (sources: unknown): RuntimeGraph =>
    ({ nodes: [{ key: 'n1', type: 'approval', config: { assigneeSources: sources } }] }) as unknown as RuntimeGraph

  it('treats continuous_dept_heads as an org-derived source (extends the B5-b fail-closed guard)', () => {
    expect(runtimeGraphUsesOrgAssigneeSource(graph([{ kind: 'continuous_dept_heads', levels: 2 }]))).toBe(true)
  })

  it('still detects the four shipped org-derived kinds (no narrowing regression)', () => {
    expect(runtimeGraphUsesOrgAssigneeSource(graph([{ kind: 'direct_manager' }]))).toBe(true)
    expect(runtimeGraphUsesOrgAssigneeSource(graph([{ kind: 'dept_head' }]))).toBe(true)
    expect(runtimeGraphUsesOrgAssigneeSource(graph([{ kind: 'continuous_managers', levels: 2 }]))).toBe(true)
    expect(runtimeGraphUsesOrgAssigneeSource(graph([{ kind: 'manager_at_level', level: 1 }]))).toBe(true)
  })

  it('does not flag a graph with no org-derived source at all (positive control — the detector is source-selected)', () => {
    expect(runtimeGraphUsesOrgAssigneeSource(graph([{ kind: 'static_user', userIds: ['x'] }]))).toBe(false)
    expect(runtimeGraphUsesOrgAssigneeSource(graph([{ kind: 'requester_choice', mode: 'single', scope: { type: 'company' } }]))).toBe(false)
  })
})
