import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * W4-PRE-1b item A — the THIRD bind-shaped writer in this line's own inventory (manual bind
 * route, sync-loop auto-match, same-account rebind — this PR's grouping, not owner verbatim
 * text): the directory-sync SYNC LOOP's `external_identity` re-match write
 * (`syncDirectoryIntegration`, directory-sync.ts ~L3759-3767). Unlike `bindDirectoryAccount`
 * (manual bind) and `admitDirectoryAccountUser`/auto-admit (new user), this write confirms an
 * ALREADY-linked identity on every resync without going through
 * `applyDirectoryAccountBindInTransaction` — it needed its OWN upsert call.
 *
 * Harness follows the established `directory-sync-orchestration.db.test.ts` R1-L4 pattern
 * (DingTalk HTTP client mocked; the REAL `syncDirectoryIntegration` runs against real Postgres).
 * Kept intentionally minimal (no heartbeat/pull-gate machinery — sequential awaited syncs only).
 *
 * Scenario: sync once (auto-admits the user — this ALSO exercises item A's other writer and
 * incidentally creates a user_orgs row, which would make a second identical assertion
 * meaningless). `resolveDirectoryIdentityMatch` short-circuits to `'already_linked'` (NOT
 * `'external_identity'`) whenever the existing `directory_account_links` row is already
 * `link_status='linked'` — so to force a GENUINE `external_identity` re-match on pass 2 (not
 * just the `'already_linked'` steady-state, which the write site's `linkStatus === 'linked'`
 * gate also correctly covers, but that is not this test's target), the link row itself (not
 * just user_orgs) is deleted between syncs while `user_external_identities` — the actual
 * source `resolveDirectoryIdentityMatch` re-derives the match from — is left intact. This
 * reproduces the exact pre-W4-PRE-1b state the owner described (an already-identity-linked
 * user with no membership row) via the specific `external_identity` branch.
 */
const clientMocks = vi.hoisted(() => ({
  fetchDingTalkAppAccessToken: vi.fn(),
  listDingTalkDepartments: vi.fn(),
  getDingTalkDepartmentDetail: vi.fn(),
  listDingTalkDepartmentUsers: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
}))

vi.mock('../../src/integrations/dingtalk/client', () => ({
  fetchDingTalkAppAccessToken: clientMocks.fetchDingTalkAppAccessToken,
  listDingTalkDepartments: clientMocks.listDingTalkDepartments,
  getDingTalkDepartmentDetail: clientMocks.getDingTalkDepartmentDetail,
  listDingTalkDepartmentUsers: clientMocks.listDingTalkDepartmentUsers,
  getDingTalkUserDetail: clientMocks.getDingTalkUserDetail,
}))

import { query } from '../../src/db/pg'
import { createDirectoryIntegration, syncDirectoryIntegration } from '../../src/directory/directory-sync'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const DEPT = `w4pre1bam-dept-${TS}`
const USER_EXT_ID = `w4pre1bam-u1-${TS}`

beforeAll(() => {
  clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('w4pre1bam-token')
  clientMocks.listDingTalkDepartments.mockImplementation(async (_token: string, parentId: string) =>
    parentId === '1' ? [{ id: DEPT, parentId: '1', name: 'W4PRE1B Automatch', order: 0, source: {} }] : [],
  )
  clientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
  clientMocks.listDingTalkDepartmentUsers.mockImplementation(async (_token: string, deptId: string) =>
    deptId === DEPT
      ? { users: [{ userId: USER_EXT_ID, name: 'AutoMatch One', departmentIds: [DEPT], source: {} }], nextCursor: null, hasMore: false }
      : { users: [], nextCursor: null, hasMore: false },
  )
  clientMocks.getDingTalkUserDetail.mockImplementation(async (_token: string, userId: string) => ({
    userId,
    name: 'AutoMatch One',
    unionId: `w4pre1bam-union-${TS}`,
    openId: `w4pre1bam-open-${TS}`,
    email: `w4pre1bam-${TS}@example.test`,
    mobile: undefined,
    departmentIds: [DEPT],
    source: {},
  }))
})

describeIfDatabase('W4-PRE-1b item A — sync-loop external_identity auto-match writes user_orgs (real DB)', () => {
  let integrationId = ''
  let orgId = ''
  let userId = ''

  afterAll(async () => {
    if (userId) {
      await query(`DELETE FROM user_invites WHERE user_id = $1`, [userId])
      await query(`DELETE FROM user_external_auth_grants WHERE local_user_id = $1`, [userId])
      await query(`DELETE FROM user_external_identities WHERE local_user_id = $1`, [userId])
      await query(`DELETE FROM user_orgs WHERE user_id = $1`, [userId])
    }
    if (integrationId) {
      await query(
        `DELETE FROM directory_account_departments WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)`,
        [integrationId],
      )
      await query(
        `DELETE FROM directory_account_links WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)`,
        [integrationId],
      )
      await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
      await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
      await query(`DELETE FROM directory_sync_runs WHERE integration_id = $1`, [integrationId])
      await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
    }
    if (userId) await query(`DELETE FROM users WHERE id = $1`, [userId])
  })

  it('pass 1 (auto-admit) creates the membership; deleting it and re-syncing (external_identity match) re-creates it', async () => {
    const integration = await createDirectoryIntegration({
      name: `w4pre1bam-${TS}`,
      corpId: `w4pre1bam-corp-${TS}`,
      appKey: `w4pre1bam-appkey-${TS}`,
      appSecret: 'w4pre1bam-secret',
      admissionMode: 'auto_for_scoped_departments',
      admissionDepartmentIds: [DEPT],
    })
    integrationId = integration.id
    orgId = integration.orgId

    await syncDirectoryIntegration(integrationId, 'system:w4pre1b-am', 'manual')

    const linked = await query<{ local_user_id: string; match_strategy: string; link_status: string }>(
      `SELECT l.local_user_id, l.match_strategy, l.link_status
       FROM directory_account_links l
       JOIN directory_accounts a ON a.id = l.directory_account_id
       WHERE a.integration_id = $1 AND a.external_user_id = $2`,
      [integrationId, USER_EXT_ID],
    )
    expect(linked.rows).toHaveLength(1)
    expect(linked.rows[0].link_status).toBe('linked')
    expect(linked.rows[0].match_strategy).toBe('auto_admit')
    userId = linked.rows[0].local_user_id
    expect(userId).toBeTruthy()

    const afterPass1 = await query<{ is_active: boolean }>(`SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`, [userId, orgId])
    expect(afterPass1.rows).toEqual([{ is_active: true }])

    // Simulate the pre-W4-PRE-1b state: an already-identity-linked user with NO membership row
    // AND no link row (forces `resolveDirectoryIdentityMatch` past the `'already_linked'`
    // short-circuit into a genuine `external_identity` re-match — see file doc-comment).
    // `user_external_identities` is left untouched — that is the re-match's actual source.
    await query(`DELETE FROM user_orgs WHERE user_id = $1 AND org_id = $2`, [userId, orgId])
    await query(
      `DELETE FROM directory_account_links WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)`,
      [integrationId],
    )
    expect((await query(`SELECT 1 FROM user_orgs WHERE user_id = $1 AND org_id = $2`, [userId, orgId])).rows).toEqual([])

    await syncDirectoryIntegration(integrationId, 'system:w4pre1b-am', 'manual')

    const linkedAfterResync = await query<{ match_strategy: string }>(
      `SELECT l.match_strategy
       FROM directory_account_links l
       JOIN directory_accounts a ON a.id = l.directory_account_id
       WHERE a.integration_id = $1 AND a.external_user_id = $2`,
      [integrationId, USER_EXT_ID],
    )
    // Confirms pass 2 took the auto-match branch under test, not a second auto_admit.
    expect(linkedAfterResync.rows[0].match_strategy).toBe('external_identity')

    const afterPass2 = await query<{ is_active: boolean }>(`SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`, [userId, orgId])
    expect(afterPass2.rows).toEqual([{ is_active: true }])
  }, 30_000)
})

/**
 * #4526 review finding (P1) — regression for the SAME write site tested above
 * (`linkStatus === 'linked' && localUserId`, directory-sync.ts ~L3773). This loop iterates ALL
 * accounts ever seen for the integration, not just this run's directory batch — including an
 * account the DT-OPS-01 sweep (same transaction, runs first) just marked departed
 * (`directory_accounts.is_active = false`). `resolveDirectoryIdentityMatch` short-circuits to
 * `'already_linked'` for ANY existing `link_status='linked'` row regardless of the account's own
 * `is_active`, so — before this fix — a departed-but-still-`linked` account's steady-state
 * re-confirm would silently flip a deliberately-inactive `user_orgs` row back to ACTIVE on every
 * subsequent resync, reopening the exact stale-access half of the owner's original P1 finding via
 * this line's own new writer. The fix additionally gates the write on `account.is_active`.
 */
describeIfDatabase('W4-PRE-1b item A regression (#4526 P1) — a swept (inactive) linked account must not resurrect user_orgs', () => {
  const DEPT2 = `w4pre1bam2-dept-${TS}`
  const USER_EXT_ID2 = `w4pre1bam2-u1-${TS}`
  let integrationId2 = ''
  let orgId2 = ''
  let userId2 = ''
  let userPresentInDirectory = true

  beforeAll(() => {
    // Reconfigures the SAME shared client mocks the block above installed, scoped to THIS test's
    // department/user id so the two blocks never collide (tests in one file run sequentially).
    // `userPresentInDirectory` lets a later pass simulate the user disappearing from the
    // directory (the real-world trigger for the DT-OPS-01 sweep) without a second live call.
    clientMocks.listDingTalkDepartments.mockImplementation(async (_token: string, parentId: string) =>
      parentId === '1' ? [{ id: DEPT2, parentId: '1', name: 'W4PRE1B Automatch Regression', order: 0, source: {} }] : [],
    )
    clientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
    clientMocks.listDingTalkDepartmentUsers.mockImplementation(async (_token: string, deptId: string) =>
      deptId === DEPT2 && userPresentInDirectory
        ? { users: [{ userId: USER_EXT_ID2, name: 'Regression One', departmentIds: [DEPT2], source: {} }], nextCursor: null, hasMore: false }
        : { users: [], nextCursor: null, hasMore: false },
    )
    clientMocks.getDingTalkUserDetail.mockImplementation(async (_token: string, userId: string) => ({
      userId,
      name: 'Regression One',
      unionId: `w4pre1bam2-union-${TS}`,
      openId: `w4pre1bam2-open-${TS}`,
      email: `w4pre1bam2-${TS}@example.test`,
      mobile: undefined,
      departmentIds: [DEPT2],
      source: {},
    }))
  })

  afterAll(async () => {
    if (userId2) {
      await query(`DELETE FROM user_invites WHERE user_id = $1`, [userId2])
      await query(`DELETE FROM user_external_auth_grants WHERE local_user_id = $1`, [userId2])
      await query(`DELETE FROM user_external_identities WHERE local_user_id = $1`, [userId2])
      await query(`DELETE FROM user_orgs WHERE user_id = $1`, [userId2])
    }
    if (integrationId2) {
      await query(
        `DELETE FROM directory_account_departments WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)`,
        [integrationId2],
      )
      await query(
        `DELETE FROM directory_account_links WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)`,
        [integrationId2],
      )
      await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId2])
      await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId2])
      await query(`DELETE FROM directory_sync_runs WHERE integration_id = $1`, [integrationId2])
      await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId2])
    }
    if (userId2) await query(`DELETE FROM users WHERE id = $1`, [userId2])
  })

  it('account swept inactive (missing from the directory) does not reactivate an already-deactivated user_orgs row on the SAME sync run', async () => {
    const integration = await createDirectoryIntegration({
      name: `w4pre1bam2-${TS}`,
      corpId: `w4pre1bam2-corp-${TS}`,
      appKey: `w4pre1bam2-appkey-${TS}`,
      appSecret: 'w4pre1bam2-secret',
      admissionMode: 'auto_for_scoped_departments',
      admissionDepartmentIds: [DEPT2],
    })
    integrationId2 = integration.id
    orgId2 = integration.orgId

    // Pass 1: user present → auto-admitted with an ACTIVE membership (same as the block above).
    await syncDirectoryIntegration(integrationId2, 'system:w4pre1b-am2', 'manual')
    const linked = await query<{ local_user_id: string; link_status: string }>(
      `SELECT l.local_user_id, l.link_status
       FROM directory_account_links l
       JOIN directory_accounts a ON a.id = l.directory_account_id
       WHERE a.integration_id = $1 AND a.external_user_id = $2`,
      [integrationId2, USER_EXT_ID2],
    )
    userId2 = linked.rows[0].local_user_id
    expect(userId2).toBeTruthy()
    expect(linked.rows[0].link_status).toBe('linked')
    expect((await query<{ is_active: boolean }>(`SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`, [userId2, orgId2])).rows).toEqual([{ is_active: true }])

    // Deactivate the membership directly (stands in for whatever admin/system action already
    // closed it — the LINK ROW STAYS 'linked', matching exactly the state the DT-OPS-01 sweep
    // itself leaves behind; see this file's item-B open-gap note in directory-sync.ts).
    await query(`UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2`, [userId2, orgId2])

    // Pass 2: the user no longer appears in the mocked directory response — the account's
    // `last_seen_at` from pass 1 is now stale, so THIS sync's DT-OPS-01 sweep marks
    // `directory_accounts.is_active = false` in the SAME transaction as the identity-match loop
    // below it. The link row is untouched by the sweep and remains 'linked'.
    userPresentInDirectory = false
    await syncDirectoryIntegration(integrationId2, 'system:w4pre1b-am2', 'manual')

    const acctAfterSweep = await query<{ is_active: boolean }>(
      `SELECT is_active FROM directory_accounts WHERE integration_id = $1 AND external_user_id = $2`,
      [integrationId2, USER_EXT_ID2],
    )
    expect(acctAfterSweep.rows).toEqual([{ is_active: false }])
    const linkAfterSweep = await query<{ link_status: string }>(
      `SELECT l.link_status
       FROM directory_account_links l
       JOIN directory_accounts a ON a.id = l.directory_account_id
       WHERE a.integration_id = $1 AND a.external_user_id = $2`,
      [integrationId2, USER_EXT_ID2],
    )
    expect(linkAfterSweep.rows[0].link_status).toBe('linked')

    // THE FIX under test: the `already_linked` steady-state re-confirm must NOT resurrect
    // `user_orgs` for an account that is `linked` but no longer `is_active`.
    const membershipAfterSweep = await query<{ is_active: boolean }>(
      `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
      [userId2, orgId2],
    )
    expect(membershipAfterSweep.rows).toEqual([{ is_active: false }])
  }, 30_000)

  it('positive control: the user returning to the directory (account re-activated) DOES get the steady-state re-confirm', async () => {
    // Continues from the prior test's end state (same integration/user, still `is_active=false`
    // on both the account and the membership) — the user reappears in the mocked directory.
    userPresentInDirectory = true
    await syncDirectoryIntegration(integrationId2, 'system:w4pre1b-am2', 'manual')

    const acctAfterReturn = await query<{ is_active: boolean }>(
      `SELECT is_active FROM directory_accounts WHERE integration_id = $1 AND external_user_id = $2`,
      [integrationId2, USER_EXT_ID2],
    )
    expect(acctAfterReturn.rows).toEqual([{ is_active: true }])

    const membershipAfterReturn = await query<{ is_active: boolean }>(
      `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
      [userId2, orgId2],
    )
    expect(membershipAfterReturn.rows).toEqual([{ is_active: true }])
  }, 30_000)
})
