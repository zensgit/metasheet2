import { describe, expect, it } from 'vitest'
import { resolveApprovalRequesterOrgRelations } from '../../src/services/ApprovalDirectoryOrg'

/**
 * Lane G (P1-A) plumbing unit test — drives the read-only org resolver against an
 * in-memory fake `query` (no database). The fake recognizes the three SELECT
 * shapes the resolver issues by stable fragments and serves fixture rows, so the
 * extraction logic (leader_in_dept → manager, dept_manager_userid_list → head,
 * reverse-link → local user id) is locked without a PG dependency.
 */

interface FakeDb {
  // requester local id -> linked directory row (account + primary dept raw)
  requester?: {
    integration_id: string
    account_id: string
    external_user_id: string
    raw: unknown
    primary_external_department_id: string | null
    primary_department_raw: unknown
    primary_department_name?: string | null
  } | null
  // B3 normalized relation: memberships of the requester's primary dept flagged is_manager=true
  // (requester-inclusive existence gate; the resolver excludes the requester on the pick).
  normalizedDeptManagers?: Array<{ account_id: string; external_user_id: string }>
  // candidate accounts in the requester's primary department (for the legacy leader_in_dept scan)
  deptCandidates?: Array<{ account_id: string; raw: unknown; external_user_id?: string }>
  // directory_account_id -> linked local user id
  localByAccountId?: Record<string, string | null>
  // external_user_id -> linked local user id
  localByExternalId?: Record<string, string | null>
}

function makeQuery(db: FakeDb & {
  // When the org-anchored path is used, the fake can assert the orgId param and optionally return
  // a different requester (or empty) so the two-org / one-local-user contract is unit-provable.
  orgAnchoredRequester?: FakeDb['requester'] | null
  lastOrgIdParam?: string | null
  lastRequesterSql?: string
}) {
  return async <Row>(text: string, params?: unknown[]): Promise<{ rows: Row[] }> => {
    if (text.includes('FROM directory_account_links l') && text.includes('LEFT JOIN directory_account_departments')) {
      db.lastRequesterSql = text
      // Org-anchored SELECT joins directory_integrations and binds org_id as $2.
      if (text.includes('JOIN directory_integrations di') && text.includes('di.org_id = $2')) {
        db.lastOrgIdParam = params?.[1] != null ? String(params[1]) : null
        const row = db.orgAnchoredRequester !== undefined ? db.orgAnchoredRequester : db.requester
        return { rows: (row ? [row] : []) as Row[] }
      }
      db.lastOrgIdParam = null
      return { rows: (db.requester ? [db.requester] : []) as Row[] }
    }
    // B3 normalized-manager gate query (`ad.is_manager = true`). Default-empty means the dept has
    // no normalized manager, so the resolver falls through to the legacy leader_in_dept scan below
    // (this is why every pre-B3 fixture keeps its expectations unchanged). Requester-inclusive
    // existence, requester-exclusive pick — the fake mirrors production self-exclusion via $3.
    if (text.includes('ad.is_manager = true')) {
      return { rows: (db.normalizedDeptManagers ?? []) as Row[] }
    }
    if (text.includes('JOIN directory_account_departments ad') && text.includes('d.external_department_id = $2')) {
      // Mirror the production self-exclusion `AND a.external_user_id <> $3` so a
      // leader-requester is never a candidate for their own manager.
      const selfExternal = params?.[2]
      const candidates = (db.deptCandidates ?? []).filter(
        (c) => c.external_user_id === undefined || c.external_user_id !== selfExternal,
      )
      return { rows: candidates as Row[] }
    }
    if (text.includes('FROM directory_account_links') && text.includes('WHERE directory_account_id = $1::uuid')) {
      const accountId = String(params?.[0])
      const localId = db.localByAccountId?.[accountId] ?? null
      return { rows: [{ local_user_id: localId }] as Row[] }
    }
    if (text.includes('JOIN directory_account_links l') && text.includes('a.external_user_id = $2')) {
      const external = String(params?.[1])
      const localId = db.localByExternalId?.[external] ?? null
      return { rows: (localId !== null ? [{ local_user_id: localId }] : []) as Row[] }
    }
    throw new Error(`unexpected query: ${text.slice(0, 60)}`)
  }
}

describe('resolveApprovalRequesterOrgRelations', () => {
  it('resolves direct manager (leader_in_dept) and dept head (dept_manager_userid_list) to local ids', async () => {
    const db: FakeDb = {
      requester: {
        integration_id: 'int-1',
        account_id: 'acc-req',
        external_user_id: 'ext-req',
        raw: { leader_in_dept: [{ dept_id: 'D1', leader: false }] },
        primary_external_department_id: 'D1',
        primary_department_raw: { dept_manager_userid_list: ['ext-head'] },
      },
      deptCandidates: [
        { account_id: 'acc-req', raw: { leader_in_dept: [{ dept_id: 'D1', leader: false }] } },
        { account_id: 'acc-mgr', raw: { leader_in_dept: [{ dept_id: 'D1', leader: true }] } },
      ],
      localByAccountId: { 'acc-mgr': 'local-mgr' },
      localByExternalId: { 'ext-head': 'local-head' },
    }
    const result = await resolveApprovalRequesterOrgRelations('local-req', makeQuery(db))
    expect(result).toEqual({ managerId: 'local-mgr', deptHeadId: 'local-head' })
  })

  it('B3 precedence: the normalized is_manager relation wins over a legacy leader_in_dept leader in the same dept', async () => {
    const db: FakeDb = {
      requester: {
        integration_id: 'int-1',
        account_id: 'acc-req',
        external_user_id: 'ext-req',
        raw: {},
        primary_external_department_id: 'D1',
        primary_department_raw: {},
      },
      // Normalized relation present for D1 → authoritative; the legacy scan must be ignored.
      normalizedDeptManagers: [{ account_id: 'acc-norm', external_user_id: 'ext-norm' }],
      deptCandidates: [{ account_id: 'acc-legacy', raw: { leader_in_dept: [{ dept_id: 'D1', leader: true }] } }],
      localByAccountId: { 'acc-norm': 'local-norm', 'acc-legacy': 'local-legacy' },
    }
    const result = await resolveApprovalRequesterOrgRelations('local-req', makeQuery(db))
    expect(result).toEqual({ managerId: 'local-norm' }) // not 'local-legacy'
  })

  it('B3 authoritative-when-present: a normalized-managed dept whose flagged manager is unlinked omits managerId and does NOT fall back to legacy', async () => {
    const db: FakeDb = {
      requester: {
        integration_id: 'int-1',
        account_id: 'acc-req',
        external_user_id: 'ext-req',
        raw: {},
        primary_external_department_id: 'D1',
        primary_department_raw: {},
      },
      normalizedDeptManagers: [{ account_id: 'acc-norm', external_user_id: 'ext-norm' }],
      localByAccountId: { 'acc-norm': null }, // the normalized manager is not linked to a local user
      // A legacy leader that WOULD resolve — proving the resolver does not blend back into raw.
      deptCandidates: [{ account_id: 'acc-legacy', raw: { leader_in_dept: [{ dept_id: 'D1', leader: true }] } }],
    }
    const result = await resolveApprovalRequesterOrgRelations('local-req', makeQuery(db))
    expect(result).toEqual({}) // managerId omitted; legacy 'acc-legacy' intentionally NOT used
  })

  it('B3 requester-exclusive pick: a normalized dept whose ONLY is_manager row is the requester omits managerId', async () => {
    const db: FakeDb = {
      requester: {
        integration_id: 'int-1',
        account_id: 'acc-req',
        external_user_id: 'ext-req',
        raw: {},
        primary_external_department_id: 'D1',
        primary_department_raw: {},
      },
      // Gate fires (a normalized row exists) but it is the requester's own → no other manager.
      normalizedDeptManagers: [{ account_id: 'acc-req', external_user_id: 'ext-req' }],
      deptCandidates: [{ account_id: 'acc-legacy', raw: { leader_in_dept: [{ dept_id: 'D1', leader: true }] } }],
      localByAccountId: { 'acc-req': 'local-req', 'acc-legacy': 'local-legacy' },
    }
    const result = await resolveApprovalRequesterOrgRelations('local-req', makeQuery(db))
    expect(result).toEqual({}) // self excluded on pick; still no fallback to legacy
  })

  it('RA-1a: resolves the primary department NAME into primaryDepartmentName (server-resolved source)', async () => {
    const db: FakeDb = {
      requester: {
        integration_id: 'int-1', account_id: 'acc-req', external_user_id: 'ext-req', raw: {},
        primary_external_department_id: 'D1', primary_department_raw: {}, primary_department_name: '财务',
      },
    }
    const result = await resolveApprovalRequesterOrgRelations('local-req', makeQuery(db))
    expect(result.primaryDepartmentName).toBe('财务')
  })

  it('RA-1a: omits primaryDepartmentName when the directory has no department name (→ requester.department fails closed at runtime)', async () => {
    const db: FakeDb = {
      requester: {
        integration_id: 'int-1', account_id: 'acc-req', external_user_id: 'ext-req', raw: {},
        primary_external_department_id: 'D1', primary_department_raw: {}, primary_department_name: null,
      },
    }
    const result = await resolveApprovalRequesterOrgRelations('local-req', makeQuery(db))
    expect(result.primaryDepartmentName).toBeUndefined()
  })

  it('excludes the requester from their own dept leaders (self-exclusion <> $3): a leader requester is not their own manager', async () => {
    const db: FakeDb = {
      requester: {
        integration_id: 'int-1',
        account_id: 'acc-req',
        external_user_id: 'ext-req',
        raw: { leader_in_dept: [{ dept_id: 'D1', leader: true }] }, // the requester IS a leader of D1
        primary_external_department_id: 'D1',
        primary_department_raw: {},
      },
      // Production SQL excludes ext-req via $3; the fake mirrors it. The requester is the
      // only leader, so after self-exclusion there is no other leader to resolve.
      deptCandidates: [
        { account_id: 'acc-req', external_user_id: 'ext-req', raw: { leader_in_dept: [{ dept_id: 'D1', leader: true }] } },
      ],
      localByAccountId: { 'acc-req': 'local-req' },
    }
    const result = await resolveApprovalRequesterOrgRelations('local-req', makeQuery(db))
    expect(result.managerId).toBeUndefined() // not 'local-req' — self is excluded
  })

  it('omits managerId when the dept leader is unlinked, but still resolves deptHead', async () => {
    const db: FakeDb = {
      requester: {
        integration_id: 'int-1',
        account_id: 'acc-req',
        external_user_id: 'ext-req',
        raw: {},
        primary_external_department_id: 'D1',
        primary_department_raw: { dept_manager_userid_list: ['ext-head'] },
      },
      deptCandidates: [{ account_id: 'acc-mgr', raw: { leader_in_dept: [{ dept_id: 'D1', leader: true }] } }],
      localByAccountId: { 'acc-mgr': null },
      localByExternalId: { 'ext-head': 'local-head' },
    }
    const result = await resolveApprovalRequesterOrgRelations('local-req', makeQuery(db))
    expect(result).toEqual({ deptHeadId: 'local-head' })
  })

  it('returns {} when the requester has no linked directory account', async () => {
    const result = await resolveApprovalRequesterOrgRelations('local-req', makeQuery({ requester: null }))
    expect(result).toEqual({})
  })

  it('returns {} for a blank user id without touching the db', async () => {
    let called = false
    const result = await resolveApprovalRequesterOrgRelations('   ', async () => {
      called = true
      return { rows: [] }
    })
    expect(result).toEqual({})
    expect(called).toBe(false)
  })

  it('never picks the requester as their own dept head (self excluded)', async () => {
    const db: FakeDb = {
      requester: {
        integration_id: 'int-1',
        account_id: 'acc-req',
        external_user_id: 'ext-req',
        raw: {},
        primary_external_department_id: 'D1',
        primary_department_raw: { dept_manager_userid_list: ['ext-req', 'ext-head'] },
      },
      deptCandidates: [],
      localByExternalId: { 'ext-head': 'local-head' },
    }
    const result = await resolveApprovalRequesterOrgRelations('local-req', makeQuery(db))
    expect(result).toEqual({ deptHeadId: 'local-head' })
  })

  it('tolerates legacy raw without leader/manager keys (no throw, empty result)', async () => {
    const db: FakeDb = {
      requester: {
        integration_id: 'int-1',
        account_id: 'acc-req',
        external_user_id: 'ext-req',
        raw: { name: 'Requester' },
        primary_external_department_id: 'D1',
        primary_department_raw: { name: 'Dept One' },
      },
      deptCandidates: [{ account_id: 'acc-x', raw: { name: 'Someone' } }],
    }
    const result = await resolveApprovalRequesterOrgRelations('local-req', makeQuery(db))
    expect(result).toEqual({})
  })

  it('skips the manager scan entirely when the requester has no primary department', async () => {
    const db: FakeDb = {
      requester: {
        integration_id: 'int-1',
        account_id: 'acc-req',
        external_user_id: 'ext-req',
        raw: {},
        primary_external_department_id: null,
        primary_department_raw: null,
      },
    }
    const result = await resolveApprovalRequesterOrgRelations('local-req', makeQuery(db))
    expect(result).toEqual({})
  })

  // ── S7 §3.3 org anchor (optional / backward compatible) ──
  it('S7 §3.3: omitting orgId keeps the unscoped requester SELECT (no directory_integrations join)', async () => {
    const db: FakeDb & { lastOrgIdParam?: string | null; lastRequesterSql?: string } = {
      requester: {
        integration_id: 'int-unscoped',
        account_id: 'acc-req',
        external_user_id: 'ext-req',
        raw: {},
        primary_external_department_id: 'D1',
        primary_department_raw: {},
      },
      normalizedDeptManagers: [{ account_id: 'acc-mgr', external_user_id: 'ext-mgr' }],
      localByAccountId: { 'acc-mgr': 'local-mgr' },
    }
    const result = await resolveApprovalRequesterOrgRelations('local-req', makeQuery(db))
    expect(result.managerId).toBe('local-mgr')
    expect(db.lastOrgIdParam).toBeNull()
    expect(db.lastRequesterSql).toBeTruthy()
    expect(db.lastRequesterSql).not.toContain('directory_integrations')
  })

  it('S7 §3.3: orgId anchors the requester-account pick BEFORE ORDER BY/LIMIT (join + $2)', async () => {
    const db: FakeDb & { lastOrgIdParam?: string | null; lastRequesterSql?: string; orgAnchoredRequester?: FakeDb['requester'] } = {
      // Unscoped would pick this (more recent) foreign-org account...
      requester: {
        integration_id: 'int-foreign',
        account_id: 'acc-foreign',
        external_user_id: 'ext-foreign',
        raw: {},
        primary_external_department_id: 'D-foreign',
        primary_department_raw: {},
      },
      // ...but with orgId the anchored path returns the calling-org account only.
      orgAnchoredRequester: {
        integration_id: 'int-home',
        account_id: 'acc-home',
        external_user_id: 'ext-home',
        raw: {},
        primary_external_department_id: 'D-home',
        primary_department_raw: {},
      },
      normalizedDeptManagers: [{ account_id: 'acc-home-mgr', external_user_id: 'ext-home-mgr' }],
      localByAccountId: { 'acc-home-mgr': 'local-home-mgr' },
    }
    const result = await resolveApprovalRequesterOrgRelations('local-req', makeQuery(db), { orgId: 'org-home' })
    expect(db.lastOrgIdParam).toBe('org-home')
    expect(db.lastRequesterSql).toContain('directory_integrations')
    expect(db.lastRequesterSql).toContain('di.org_id = $2')
    expect(result.managerId).toBe('local-home-mgr')
  })

  it('S7 §3.3: orgId with no matching integration account returns {} (does not fall back to unscoped)', async () => {
    const db: FakeDb & { orgAnchoredRequester?: null } = {
      requester: {
        integration_id: 'int-other',
        account_id: 'acc-other',
        external_user_id: 'ext-other',
        raw: {},
        primary_external_department_id: 'D1',
        primary_department_raw: {},
      },
      orgAnchoredRequester: null, // anchored pick finds nothing
      normalizedDeptManagers: [{ account_id: 'acc-mgr', external_user_id: 'ext-mgr' }],
      localByAccountId: { 'acc-mgr': 'local-mgr' },
    }
    const result = await resolveApprovalRequesterOrgRelations('local-req', makeQuery(db), { orgId: 'org-empty' })
    expect(result).toEqual({}) // never the unscoped foreign manager
  })

  it('S7 §3.3: blank orgId is treated as omitted (backward-compatible unscoped path)', async () => {
    const db: FakeDb & { lastOrgIdParam?: string | null; lastRequesterSql?: string } = {
      requester: {
        integration_id: 'int-1',
        account_id: 'acc-req',
        external_user_id: 'ext-req',
        raw: {},
        primary_external_department_id: 'D1',
        primary_department_raw: {},
      },
      normalizedDeptManagers: [{ account_id: 'acc-mgr', external_user_id: 'ext-mgr' }],
      localByAccountId: { 'acc-mgr': 'local-mgr' },
    }
    const result = await resolveApprovalRequesterOrgRelations('local-req', makeQuery(db), { orgId: '   ' })
    expect(result.managerId).toBe('local-mgr')
    expect(db.lastOrgIdParam).toBeNull()
    expect(db.lastRequesterSql).not.toContain('directory_integrations')
  })
})
