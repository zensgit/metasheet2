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

/**
 * Residual fix — same-batch preview overcount (dt-preview-integrity FIX 1).
 *
 * The suite above proves preview↔apply parity for accounts matched against PRE-EXISTING
 * local users. It does not cover two BRAND-NEW pulled accounts that share an identity key
 * with EACH OTHER (not with anything already in the DB): both independently resolve
 * `matched:'none'` against the match maps `loadMatchMaps` builds once up front, so both
 * counted as auto-admission candidates — but apply mutates its maps as it admits users
 * within the run, so the second duplicate resolves `matched:'email'`/`'mobile'` against the
 * user apply just created for the first and is LINKED, not created. Preview reported 2
 * candidates for what apply turns into 1 new user.
 *
 * This drives a separate integration (own corp/department/users — no overlap with the
 * scenario above) with two duplicate pairs (shared email, shared mobile) plus one solo new
 * user, and asserts preview's count already accounts for both pairs collapsing to 1 each,
 * matching apply's actual `users` insert count exactly.
 */
describeIfDatabase('DT-OPS-02 preview/apply parity — intra-batch identity duplicates (residual fix)', () => {
  let integrationId = ''

  const DUP_CORP = `dt3915dupcorp${TS}`
  const DUP_DEPT_IN = `dt3915dupdin${TS}`

  const DUP_SHARED_EMAIL = `dt3915dup-shared-${TS}@example.com`
  const DUP_SHARED_MOBILE = `132${String(TS).slice(-8)}`

  const DT_DUP_EMAIL_A = `dt3915dupemailA${TS}`
  const DT_DUP_EMAIL_B = `dt3915dupemailB${TS}`
  const DT_DUP_MOBILE_A = `dt3915dupmobileA${TS}`
  const DT_DUP_MOBILE_B = `dt3915dupmobileB${TS}`
  const DT_DUP_SOLO = `dt3915dupsolo${TS}`

  const UNION_DUP_EMAIL_A = `dt3915dupunionemailA${TS}`
  const UNION_DUP_EMAIL_B = `dt3915dupunionemailB${TS}`
  const UNION_DUP_MOBILE_A = `dt3915dupunionmobileA${TS}`
  const UNION_DUP_MOBILE_B = `dt3915dupunionmobileB${TS}`
  const UNION_DUP_SOLO = `dt3915dupunionsolo${TS}`

  beforeAll(async () => {
    const integration = await createDirectoryIntegration({
      name: `dt3915dup-${TS}`,
      corpId: DUP_CORP,
      appKey: `appkey-dup-${TS}`,
      appSecret: 'appsecret-value',
      admissionMode: 'auto_for_scoped_departments',
      admissionDepartmentIds: [DUP_DEPT_IN],
      excludeDepartmentIds: [],
    })
    integrationId = integration.id

    // DingTalk pull: a single in-scope department carrying five brand-new users — two
    // sharing an email, two sharing a mobile, and one solo (no existing directory_accounts
    // row and no existing local user for ANY of them — this integration is otherwise empty).
    clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('app-token')
    clientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
    clientMocks.listDingTalkDepartments.mockImplementation(async (_token: string, parentId: string) => {
      if (parentId === '1') {
        return [{ id: DUP_DEPT_IN, parentId: '1', name: 'Dup In-Scope', order: 0, source: {} }]
      }
      return []
    })
    clientMocks.listDingTalkDepartmentUsers.mockImplementation(async (_token: string, deptId: string) => {
      if (deptId === DUP_DEPT_IN) {
        return {
          users: [
            deptUserSummary(DT_DUP_EMAIL_A, 'Dup Email A', DUP_DEPT_IN),
            deptUserSummary(DT_DUP_EMAIL_B, 'Dup Email B', DUP_DEPT_IN),
            deptUserSummary(DT_DUP_MOBILE_A, 'Dup Mobile A', DUP_DEPT_IN),
            deptUserSummary(DT_DUP_MOBILE_B, 'Dup Mobile B', DUP_DEPT_IN),
            deptUserSummary(DT_DUP_SOLO, 'Dup Solo', DUP_DEPT_IN),
          ],
          nextCursor: null,
          hasMore: false,
        }
      }
      return { users: [], nextCursor: null, hasMore: false }
    })
    clientMocks.getDingTalkUserDetail.mockImplementation(async (_token: string, userId: string) => {
      switch (userId) {
        case DT_DUP_EMAIL_A:
          return userDetail(DT_DUP_EMAIL_A, 'Dup Email A', UNION_DUP_EMAIL_A, { email: DUP_SHARED_EMAIL })
        case DT_DUP_EMAIL_B:
          return userDetail(DT_DUP_EMAIL_B, 'Dup Email B', UNION_DUP_EMAIL_B, { email: DUP_SHARED_EMAIL })
        case DT_DUP_MOBILE_A:
          return userDetail(DT_DUP_MOBILE_A, 'Dup Mobile A', UNION_DUP_MOBILE_A, { mobile: DUP_SHARED_MOBILE })
        case DT_DUP_MOBILE_B:
          return userDetail(DT_DUP_MOBILE_B, 'Dup Mobile B', UNION_DUP_MOBILE_B, { mobile: DUP_SHARED_MOBILE })
        case DT_DUP_SOLO:
          return userDetail(DT_DUP_SOLO, 'Dup Solo', UNION_DUP_SOLO)
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
    // Auto-admitted users created by the apply-path test below carry these DT names.
    await query(
      `DELETE FROM users WHERE name = ANY($1::text[])`,
      [['Dup Email A', 'Dup Email B', 'Dup Mobile A', 'Dup Mobile B', 'Dup Solo']],
    )
  })

  it('preview counts exactly 3 candidates — one per duplicate pair plus the solo user, not 5', async () => {
    const preview = await previewDirectorySyncIntegration(integrationId)

    expect(preview.wouldCreateAccounts).toBe(5)
    expect(preview.accountsSeen).toBe(5)
    // Without the fix this is 5 (every matched:'none' account counted independently); with
    // it, the second half of each duplicate pair resolves matched:'email'/'mobile' against
    // the sentinel the first half wrote, so only 3 are genuinely new candidates.
    expect(preview.autoAdmissionCandidateCount).toBe(3)
  })

  it('apply creates exactly 3 users for the batch — preview/apply parity holds for intra-batch duplicates', async () => {
    const preview = await previewDirectorySyncIntegration(integrationId)

    const result = await syncDirectoryIntegration(integrationId, 'system:dt3915-dup-parity-test')
    const stats = result.run.stats as Record<string, unknown>

    // The headline parity assertion for this fix: preview and apply must agree, including
    // for intra-batch duplicates apply resolves as it goes.
    expect(stats.autoAdmissionCandidateCount).toBe(preview.autoAdmissionCandidateCount)
    expect(stats.autoAdmissionCandidateCount).toBe(3)
    expect(stats.autoAdmittedCount).toBe(3)

    const links = await query<{ external_user_id: string; link_status: string; match_strategy: string | null; local_user_id: string | null }>(
      `SELECT a.external_user_id, l.link_status, l.match_strategy, l.local_user_id
         FROM directory_accounts a
         JOIN directory_account_links l ON l.directory_account_id = a.id
        WHERE a.integration_id = $1
        ORDER BY a.external_user_id`,
      [integrationId],
    )
    const byExternalId = new Map(links.rows.map((row) => [row.external_user_id, row]))

    // Email pair: exactly one of {A, B} was auto_admit-created; the other resolved as an
    // 'email' match against the SAME newly created user — apply does not care which pulled
    // account "wins", only that exactly one new user results per pair.
    const emailRows = [byExternalId.get(DT_DUP_EMAIL_A), byExternalId.get(DT_DUP_EMAIL_B)]
    const emailCreated = emailRows.filter((row) => row?.match_strategy === 'auto_admit')
    const emailMatched = emailRows.filter((row) => row?.match_strategy === 'email')
    expect(emailCreated).toHaveLength(1)
    expect(emailMatched).toHaveLength(1)
    expect(emailCreated[0]?.link_status).toBe('linked')
    expect(emailMatched[0]?.link_status).toBe('pending')
    expect(emailMatched[0]?.local_user_id).toBe(emailCreated[0]?.local_user_id)

    // Mobile pair: same shape, via the mobile match strategy.
    const mobileRows = [byExternalId.get(DT_DUP_MOBILE_A), byExternalId.get(DT_DUP_MOBILE_B)]
    const mobileCreated = mobileRows.filter((row) => row?.match_strategy === 'auto_admit')
    const mobileMatched = mobileRows.filter((row) => row?.match_strategy === 'mobile')
    expect(mobileCreated).toHaveLength(1)
    expect(mobileMatched).toHaveLength(1)
    expect(mobileCreated[0]?.link_status).toBe('linked')
    expect(mobileMatched[0]?.link_status).toBe('pending')
    expect(mobileMatched[0]?.local_user_id).toBe(mobileCreated[0]?.local_user_id)

    // Solo new user: its own independent auto-admit, never merged with either pair (proves
    // the fix cannot over-dedupe — a genuinely distinct account still counts and gets created).
    const solo = byExternalId.get(DT_DUP_SOLO)
    expect(solo?.match_strategy).toBe('auto_admit')
    expect(solo?.link_status).toBe('linked')
    expect(solo?.local_user_id).not.toBe(emailCreated[0]?.local_user_id)
    expect(solo?.local_user_id).not.toBe(mobileCreated[0]?.local_user_id)

    // Exactly 3 distinct new local users total across the whole batch.
    const distinctNewUserIds = new Set([
      emailCreated[0]?.local_user_id,
      mobileCreated[0]?.local_user_id,
      solo?.local_user_id,
    ])
    expect(distinctNewUserIds.size).toBe(3)

    const newUserCount = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM users WHERE id = ANY($1::text[])`,
      [Array.from(distinctNewUserIds) as string[]],
    )
    expect(newUserCount.rows[0].n).toBe('3')
  })

  // §7.7 Sync Performance — the N+1 `user/get` fan-out must be OPS-VISIBLE: its count has to
  // land in the persisted run `stats` (which `summarizeRun` returns verbatim to the runs API).
  // Non-tautological anchor: the persisted `externalUserDetailCalls` is pinned to the ACTUAL
  // per-run `getDingTalkUserDetail` mock invocation delta AND to `accountsSynced` — a stale or
  // wrong counter can't satisfy all three at once.
  it('persists external directory-pull call telemetry in run stats, with externalUserDetailCalls = one user/get per synced account (the N+1)', async () => {
    const detailCallsBefore = clientMocks.getDingTalkUserDetail.mock.calls.length

    const result = await syncDirectoryIntegration(integrationId, 'system:dt3915-telemetry-test')
    const stats = result.run.stats as Record<string, number>

    const detailCallsThisRun = clientMocks.getDingTalkUserDetail.mock.calls.length - detailCallsBefore

    // The N+1, made measurable: this run issued exactly one user/get per unique account, and
    // that real count is what got written to the run record.
    expect(detailCallsThisRun).toBeGreaterThan(0)
    expect(stats.externalUserDetailCalls).toBe(detailCallsThisRun)
    // CURRENT-N+1 CANARY (expected to break with the §7.7 staging fix): this equality holds
    // only while EVERY user takes a `user/get`. When `user/list` becomes the primary field
    // source (detail only when fields are missing), `externalUserDetailCalls` will drop BELOW
    // `accountsSynced` — that is the fix working, not a regression. Relax this line to
    // `toBeLessThanOrEqual` (and assert the drop) when that flip lands.
    expect(stats.externalUserDetailCalls).toBe(stats.accountsSynced)

    // The other pull categories are present and positive (departments are walked + detailed,
    // users are listed page-by-page).
    expect(stats.externalDepartmentListCalls).toBeGreaterThan(0)
    expect(stats.externalDepartmentDetailCalls).toBeGreaterThan(0)
    expect(stats.externalUserListPageCalls).toBeGreaterThan(0)

    // The aggregate is the honest sum of the four pull categories (not a mislabeled "total").
    expect(stats.externalDirectoryPullCalls).toBe(
      stats.externalDepartmentListCalls +
        stats.externalDepartmentDetailCalls +
        stats.externalUserListPageCalls +
        stats.externalUserDetailCalls,
    )
  })
})

describeIfDatabase('Phase A preview corp-scoped identity sentinel wiring (real DB)', () => {
  let integrationId = ''

  const IDENTITY_CORP = `dtphaseaidentitycorp${TS}`
  const IDENTITY_DEPT = `dtphaseaidentitydept${TS}`
  const DT_IDENTITY_A = `dtphaseaidentityA${TS}`
  const DT_IDENTITY_B = `dtphaseaidentityB${TS}`
  const DT_IDENTITY_SOLO = `dtphaseaidentitySolo${TS}`
  const SHARED_UNION_ID = `dtphaseasharedunion${TS}`
  const SOLO_UNION_ID = `dtphaseasolounion${TS}`

  beforeAll(async () => {
    const integration = await createDirectoryIntegration({
      name: `dt-phase-a-preview-identity-${TS}`,
      corpId: IDENTITY_CORP,
      appKey: `appkey-phase-a-preview-${TS}`,
      appSecret: 'appsecret-value',
      admissionMode: 'auto_for_scoped_departments',
      admissionDepartmentIds: [IDENTITY_DEPT],
      excludeDepartmentIds: [],
    })
    integrationId = integration.id

    clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('app-token')
    clientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
    clientMocks.listDingTalkDepartments.mockImplementation(async (_token: string, parentId: string) => {
      if (parentId === '1') {
        return [{ id: IDENTITY_DEPT, parentId: '1', name: 'Identity In-Scope', order: 0, source: {} }]
      }
      return []
    })
    clientMocks.listDingTalkDepartmentUsers.mockImplementation(async (_token: string, deptId: string) => {
      if (deptId === IDENTITY_DEPT) {
        return {
          users: [
            deptUserSummary(DT_IDENTITY_A, 'Identity A', IDENTITY_DEPT),
            deptUserSummary(DT_IDENTITY_B, 'Identity B', IDENTITY_DEPT),
            deptUserSummary(DT_IDENTITY_SOLO, 'Identity Solo', IDENTITY_DEPT),
          ],
          nextCursor: null,
          hasMore: false,
        }
      }
      return { users: [], nextCursor: null, hasMore: false }
    })
    clientMocks.getDingTalkUserDetail.mockImplementation(async (_token: string, userId: string) => {
      if (userId === DT_IDENTITY_A || userId === DT_IDENTITY_B) {
        return userDetail(userId, userId === DT_IDENTITY_A ? 'Identity A' : 'Identity B', SHARED_UNION_ID)
      }
      if (userId === DT_IDENTITY_SOLO) {
        return userDetail(DT_IDENTITY_SOLO, 'Identity Solo', SOLO_UNION_ID)
      }
      throw new Error(`unexpected userId ${userId}`)
    })
  })

  afterAll(async () => {
    if (integrationId) {
      await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
    }
  })

  it('collapses a same-corp union/open/external identity pair while preserving a distinct account', async () => {
    const preview = await previewDirectorySyncIntegration(integrationId)

    expect(preview.accountsSeen).toBe(3)
    expect(preview.wouldCreateAccounts).toBe(3)
    // The shared pair has no email/mobile, so only the corp-scoped identity sentinel maps
    // can make the second account resolve as an existing identity. The solo account is the
    // positive control that prevents an implementation from collapsing every account.
    expect(preview.autoAdmissionCandidateCount).toBe(2)
  })
})
