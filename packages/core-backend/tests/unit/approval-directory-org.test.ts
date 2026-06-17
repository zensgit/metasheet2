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
  } | null
  // candidate accounts in the requester's primary department (for manager scan)
  deptCandidates?: Array<{ account_id: string; raw: unknown }>
  // directory_account_id -> linked local user id
  localByAccountId?: Record<string, string | null>
  // external_user_id -> linked local user id
  localByExternalId?: Record<string, string | null>
}

function makeQuery(db: FakeDb) {
  return async <Row>(text: string, params?: unknown[]): Promise<{ rows: Row[] }> => {
    if (text.includes('FROM directory_account_links l') && text.includes('LEFT JOIN directory_account_departments')) {
      return { rows: (db.requester ? [db.requester] : []) as Row[] }
    }
    if (text.includes('JOIN directory_account_departments ad') && text.includes('d.external_department_id = $2')) {
      return { rows: (db.deptCandidates ?? []) as Row[] }
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
})
