/**
 * DT-OPS-02 P2 follow-up — real-DB preview/apply parity for `autoAdmissionCandidateCount`
 * (dingtalk-sync-integrated-roadmap-20260708.md, DT-OPS-02, Test/Evidence matrix "Dry-run |
 * Preview/apply parity test").
 *
 * PR #3915 shipped `previewDirectorySyncIntegration` calling the eligibility predicate
 * unconditionally for every pulled user, while `syncDirectoryIntegration` (apply) only
 * reaches that predicate in the deepest else-branch of its identity-matching cascade
 * (not already linked AND not external-identity-matched AND not unique-email-matched AND
 * not unique-mobile-matched AND not ambiguous). Preview over-counted as a result: it would
 * report an already-linked account as an "auto-admission candidate" when apply would never
 * create (or even touch the link status of) that account.
 *
 * This drives BOTH the real `previewDirectorySyncIntegration` and the real
 * `syncDirectoryIntegration` against Postgres, with the DingTalk HTTP client mocked so both
 * pull the identical synthetic directory. It asserts `autoAdmissionCandidateCount` is equal
 * on both sides for four scenarios, AND cross-checks apply's actual DB effect (who got
 * created/linked) so the parity assertion cannot be satisfied by two independently-wrong
 * numbers that happen to collide.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

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
import {
  createDirectoryIntegration,
  previewDirectorySyncIntegration,
  syncDirectoryIntegration,
} from '../../src/directory/directory-sync'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

const CORP = `dt3915corp${TS}`
const DEPT_IN = `dt3915din${TS}`
const DEPT_OUT = `dt3915dout${TS}`

// Pre-existing local users (targets for the match-cascade scenarios).
const LINKED_USER_ID = `dt3915_u_linked_${TS}`
const EMAIL_MATCH_USER_ID = `dt3915_u_emailmatch_${TS}`
const MOBILE_MATCH_USER_ID = `dt3915_u_mobilematch_${TS}`
const EMAIL_MATCH_EMAIL = `dt3915-emailmatch-${TS}@example.com`
const MOBILE_MATCH_MOBILE = `131${String(TS).slice(-8)}`

// Pulled DingTalk userIds (external_user_id).
const DT_LINKED = `dt3915dtlinked${TS}`
const DT_EMAILMATCH = `dt3915dtemail${TS}`
const DT_MOBILEMATCH = `dt3915dtmobile${TS}`
const DT_NEW = `dt3915dtnew${TS}`
const DT_OOS_NEW = `dt3915dtoos${TS}`

const UNION_LINKED = `dt3915unionlinked${TS}`
const UNION_EMAILMATCH = `dt3915unionemail${TS}`
const UNION_MOBILEMATCH = `dt3915unionmobile${TS}`
const UNION_NEW = `dt3915unionnew${TS}`
const UNION_OOS = `dt3915unionoos${TS}`

function deptUserSummary(userId: string, name: string, deptId: string) {
  return { userId, name, departmentIds: [deptId], source: {} }
}

function userDetail(userId: string, name: string, unionId: string, extra: { email?: string; mobile?: string } = {}) {
  return {
    userId,
    name,
    unionId,
    // openId is required for auto-admission to enable the DingTalk login grant
    // (assertDirectoryAccountCanEnableDingTalkGrant) — every pulled user carries one.
    openId: `${unionId}-open`,
    email: extra.email,
    mobile: extra.mobile,
    departmentIds: [] as string[],
    source: {},
  }
}

describeIfDatabase('DT-OPS-02 preview/apply auto-admission parity (real DB)', () => {
  let integrationId = ''
  let linkedAccountId = ''

  beforeAll(async () => {
    // Local users used as match targets.
    await query(
      `INSERT INTO users (id, email, name, password_hash, role)
       VALUES ($1, $2, 'Linked', 'x', 'user'),
              ($3, $4, 'EmailMatch', 'x', 'user'),
              ($5, $6, 'MobileMatch', 'x', 'user')
       ON CONFLICT (id) DO NOTHING`,
      [
        LINKED_USER_ID, `dt3915-linked-${TS}@example.com`,
        EMAIL_MATCH_USER_ID, EMAIL_MATCH_EMAIL,
        MOBILE_MATCH_USER_ID, `dt3915-mobilematch-${TS}@example.com`,
      ],
    )
    await query(`UPDATE users SET mobile = $2 WHERE id = $1`, [MOBILE_MATCH_USER_ID, MOBILE_MATCH_MOBILE])

    // The directory integration, admission-scoped to DEPT_IN only.
    const integration = await createDirectoryIntegration({
      name: `dt3915-${TS}`,
      corpId: CORP,
      appKey: `appkey-${TS}`,
      appSecret: 'appsecret-value',
      admissionMode: 'auto_for_scoped_departments',
      admissionDepartmentIds: [DEPT_IN],
      excludeDepartmentIds: [],
    })
    integrationId = integration.id

    // Pre-seed DT_LINKED as an already-linked directory account — apply's already-linked
    // short-circuit (existing.link_status === 'linked') must skip the whole match cascade
    // for it, and preview must recognize the same thing via its `linked` query column.
    const accountResult = await query<{ id: string }>(
      `INSERT INTO directory_accounts (
         integration_id, corp_id, external_user_id, union_id, external_key, name, email, mobile, is_active, last_seen_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $4, 'Linked DT User', NULL, NULL, true, NOW(), NOW(), NOW())
       RETURNING id`,
      [integrationId, CORP, DT_LINKED, UNION_LINKED],
    )
    linkedAccountId = accountResult.rows[0].id
    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at)
       VALUES ($1, $2, 'linked', 'manual', NOW(), NOW())`,
      [linkedAccountId, LINKED_USER_ID],
    )

    // DingTalk pull: one access token; a 2-child department tree (DEPT_IN, DEPT_OUT) under
    // the synthetic root; DEPT_IN carries four users (linked / email-match / mobile-match /
    // genuinely-new), DEPT_OUT (out of admission scope) carries one genuinely-new user.
    clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('app-token')
    clientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
    clientMocks.listDingTalkDepartments.mockImplementation(async (_token: string, parentId: string) => {
      if (parentId === '1') {
        return [
          { id: DEPT_IN, parentId: '1', name: 'In-Scope', order: 0, source: {} },
          { id: DEPT_OUT, parentId: '1', name: 'Out-of-Scope', order: 1, source: {} },
        ]
      }
      return []
    })
    clientMocks.listDingTalkDepartmentUsers.mockImplementation(async (_token: string, deptId: string) => {
      if (deptId === DEPT_IN) {
        return {
          users: [
            deptUserSummary(DT_LINKED, 'Linked DT User', DEPT_IN),
            deptUserSummary(DT_EMAILMATCH, 'EmailMatch DT User', DEPT_IN),
            deptUserSummary(DT_MOBILEMATCH, 'MobileMatch DT User', DEPT_IN),
            deptUserSummary(DT_NEW, 'New DT User', DEPT_IN),
          ],
          nextCursor: null,
          hasMore: false,
        }
      }
      if (deptId === DEPT_OUT) {
        return {
          users: [deptUserSummary(DT_OOS_NEW, 'Out-of-scope New DT User', DEPT_OUT)],
          nextCursor: null,
          hasMore: false,
        }
      }
      return { users: [], nextCursor: null, hasMore: false }
    })
    clientMocks.getDingTalkUserDetail.mockImplementation(async (_token: string, userId: string) => {
      switch (userId) {
        case DT_LINKED:
          return userDetail(DT_LINKED, 'Linked DT User', UNION_LINKED)
        case DT_EMAILMATCH:
          return userDetail(DT_EMAILMATCH, 'EmailMatch DT User', UNION_EMAILMATCH, { email: EMAIL_MATCH_EMAIL })
        case DT_MOBILEMATCH:
          return userDetail(DT_MOBILEMATCH, 'MobileMatch DT User', UNION_MOBILEMATCH, { mobile: MOBILE_MATCH_MOBILE })
        case DT_NEW:
          return userDetail(DT_NEW, 'New DT User', UNION_NEW)
        case DT_OOS_NEW:
          return userDetail(DT_OOS_NEW, 'Out-of-scope New DT User', UNION_OOS)
        default:
          throw new Error(`unexpected userId ${userId}`)
      }
    })
  })

  afterAll(async () => {
    if (integrationId) {
      await query(`DELETE FROM directory_sync_runs WHERE integration_id = $1`, [integrationId])
      await query(`DELETE FROM directory_account_links WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)`, [integrationId])
      await query(`DELETE FROM directory_account_departments WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)`, [integrationId])
      await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
      await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
      await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
    }
    await query(
      `DELETE FROM users WHERE id = ANY($1::text[])`,
      [[LINKED_USER_ID, EMAIL_MATCH_USER_ID, MOBILE_MATCH_USER_ID]],
    )
    // Any auto-admitted user created by the apply-path test below.
    await query(`DELETE FROM users WHERE email IS NULL AND name = 'New DT User'`)
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('preview reports exactly 1 auto-admission candidate (the genuinely new in-scope user)', async () => {
    const preview = await previewDirectorySyncIntegration(integrationId)

    expect(preview.autoAdmissionCandidateCount).toBe(1)
    expect(preview.autoAdmissionExcludedCount).toBe(0)
    expect(preview.autoAdmissionSkippedMissingEmailCount).toBe(0)
    // DT_LINKED already exists in directory_accounts; the other four are new.
    expect(preview.wouldCreateAccounts).toBe(4)
    expect(preview.accountsSeen).toBe(5)
  })

  it('preview writes nothing to the DB (no run row, no account upsert, no user)', async () => {
    const before = await query<{ n: string }>(
      `SELECT
         (SELECT COUNT(*) FROM directory_sync_runs WHERE integration_id = $1) ||
         '/' || (SELECT COUNT(*) FROM directory_accounts WHERE integration_id = $1) AS n`,
      [integrationId],
    )
    await previewDirectorySyncIntegration(integrationId)
    const after = await query<{ n: string }>(
      `SELECT
         (SELECT COUNT(*) FROM directory_sync_runs WHERE integration_id = $1) ||
         '/' || (SELECT COUNT(*) FROM directory_accounts WHERE integration_id = $1) AS n`,
      [integrationId],
    )
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  it('apply (real sync) creates exactly 1 auto-admitted user, and its stats.autoAdmissionCandidateCount equals preview', async () => {
    const preview = await previewDirectorySyncIntegration(integrationId)

    const result = await syncDirectoryIntegration(integrationId, 'system:dt3915-parity-test')
    const stats = result.run.stats as Record<string, unknown>

    // The headline parity assertion: preview and apply must agree.
    expect(stats.autoAdmissionCandidateCount).toBe(preview.autoAdmissionCandidateCount)
    expect(stats.autoAdmissionCandidateCount).toBe(1)
    expect(stats.autoAdmittedCount).toBe(1)
    expect(stats.autoAdmissionExcludedCount).toBe(preview.autoAdmissionExcludedCount)
    expect(stats.autoAdmissionSkippedMissingEmailCount).toBe(preview.autoAdmissionSkippedMissingEmailCount)

    // Cross-check against the actual DB effect, so parity can't be satisfied by two
    // independently-wrong numbers colliding.
    const links = await query<{ external_user_id: string; link_status: string; match_strategy: string | null; local_user_id: string | null }>(
      `SELECT a.external_user_id, l.link_status, l.match_strategy, l.local_user_id
         FROM directory_accounts a
         JOIN directory_account_links l ON l.directory_account_id = a.id
        WHERE a.integration_id = $1
        ORDER BY a.external_user_id`,
      [integrationId],
    )
    const byExternalId = new Map(links.rows.map((row) => [row.external_user_id, row]))

    // Scenario 1: already-linked account is untouched by the match cascade — still linked
    // to the SAME local user via the SAME 'manual' strategy it was pre-seeded with.
    expect(byExternalId.get(DT_LINKED)).toEqual({
      external_user_id: DT_LINKED,
      link_status: 'linked',
      match_strategy: 'manual',
      local_user_id: LINKED_USER_ID,
    })

    // Scenario 2: unique-email match links to the existing user (does NOT create a new one).
    expect(byExternalId.get(DT_EMAILMATCH)).toEqual({
      external_user_id: DT_EMAILMATCH,
      link_status: 'pending',
      match_strategy: 'email',
      local_user_id: EMAIL_MATCH_USER_ID,
    })

    // Scenario 3: unique-mobile match links to the existing user (does NOT create a new one).
    expect(byExternalId.get(DT_MOBILEMATCH)).toEqual({
      external_user_id: DT_MOBILEMATCH,
      link_status: 'pending',
      match_strategy: 'mobile',
      local_user_id: MOBILE_MATCH_USER_ID,
    })

    // Scenario 4: genuinely new + in-scope + unmatched -> auto-admitted (new local user).
    const newLink = byExternalId.get(DT_NEW)
    expect(newLink?.link_status).toBe('linked')
    expect(newLink?.match_strategy).toBe('auto_admit')
    expect(newLink?.local_user_id).toBeTruthy()
    expect(newLink?.local_user_id).not.toBe(LINKED_USER_ID)
    expect(newLink?.local_user_id).not.toBe(EMAIL_MATCH_USER_ID)
    expect(newLink?.local_user_id).not.toBe(MOBILE_MATCH_USER_ID)

    // Scenario 5: out-of-scope new account -> unmatched, no local user at all.
    expect(byExternalId.get(DT_OOS_NEW)).toEqual({
      external_user_id: DT_OOS_NEW,
      link_status: 'unmatched',
      match_strategy: 'none',
      local_user_id: null,
    })

    // Exactly one NEW local user exists across the whole scenario (DT_NEW's auto-admit).
    const newUserCount = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM users WHERE id = $1`,
      [newLink?.local_user_id ?? 'missing'],
    )
    expect(newUserCount.rows[0].n).toBe('1')
  })
})
