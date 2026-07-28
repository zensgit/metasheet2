import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { query, transaction } from '../../src/db/pg'
import {
  batchAdmitDirectoryAccountUsers,
  __directorySyncInternalsForTests,
} from '../../src/directory/directory-sync'

/**
 * P2-1 (post-#3972 review) — proved on real Postgres by the review.
 *
 * Directory admission's create-time uniqueness backstop was CASE-SENSITIVE
 * (`WHERE email = $1`, in `createDirectoryAdmittedUserInTransaction`), but directory sync's own
 * account<->user matching is CASE-INSENSITIVE (`LOWER(email)`, see
 * loadDirectoryReviewRecommendations), and AuthService.register stores raw-case emails. A stored
 * `Alice@x.com` + an admission of `alice@x.com` therefore slipped past the existence check and
 * created a SECOND `users` row for the same person — the review drove
 * `batchAdmitDirectoryAccountUsers` on real PG and watched the user count go 1->2. The DB's own
 * `idx_users_email` unique index is ALSO case-sensitive, so it does not backstop this either —
 * only an app-level case-insensitive check closes it (see users_email_lower_idx).
 *
 * Additionally, the "only admit accounts with no local user and no recommendation candidate"
 * eligibility gate lived ONLY in the Vue computed (`selectedReviewAdmissionIds` in
 * DirectoryManagementView.vue) — never enforced server-side — so a direct POST to
 * /api/admin/directory/accounts/batch-admit-users could bypass it.
 *
 * These tests exercise the real admission path against real Postgres and prove both fixes,
 * isolated from each other so a regression in either one is independently detectable:
 *  1. The create-time email check is now case-insensitive. Proved via
 *     `batchAdmitDirectoryAccountUsers` with an account that has NO existing directory_account_links
 *     row (so the batch-admit eligibility gate's "already linked" branch cannot be what rejects
 *     it) but whose email case-insensitively collides with an existing user — the email/mobile
 *     branch of the eligibility gate and the create-time check both key off the SAME
 *     lower(email) semantics, so this also exercises the create-time backstop's own fix
 *     directly via the unit-style real-DB call below.
 *  2. batchAdmitDirectoryAccountUsers now rejects an ineligible account server-side BEFORE it
 *     would ever reach the create-time check — proved via a scenario the create-time check
 *     alone would not catch (an account already linked to a local user, no email/mobile at
 *     all).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const { createDirectoryAdmittedUserInTransaction } = __directorySyncInternalsForTests

const TS = Date.now()

describeIfDatabase('P2-1 directory admission case-insensitive uniqueness + batch-admit eligibility (real DB)', () => {
  let integrationId = ''

  async function seedIntegrationAccount(opts: {
    email: string | null
    mobile: string | null
    unionId: string | null
    tag: string
  }) {
    const external = `oa-p21-${opts.tag}-${TS}`
    const externalKey = opts.unionId || external
    const row = (await query<{ id: string; corp_id: string }>(
      `INSERT INTO directory_accounts (integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key, name, email, mobile, is_active)
       SELECT $1::uuid, 'dingtalk', corp_id, $2, $3, NULL, $4, 'Fixture P2-1', $5, $6, true
       FROM directory_integrations
       WHERE id = $1::uuid
       RETURNING id::text AS id, corp_id`,
      [integrationId, external, opts.unionId, externalKey, opts.email, opts.mobile],
    )).rows[0]
    return {
      id: row.id,
      integration_id: integrationId,
      provider: 'dingtalk',
      corp_id: row.corp_id,
      external_user_id: external,
      union_id: opts.unionId,
      open_id: null as string | null,
      external_key: externalKey,
      name: 'Fixture P2-1',
      email: opts.email,
      mobile: opts.mobile,
    }
  }

  const userCountByEmailCI = async (email: string) =>
    (await query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE lower(email) = lower($1)`, [email])).rows[0].n

  const userCountByUsername = async (username: string) =>
    (await query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE username = $1`, [username])).rows[0].n

  beforeAll(async () => {
    integrationId = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id::text AS id`,
      [`p21-uniq-${TS}`, `p21-corp-${TS}`],
    )).rows[0].id
  })

  // The control test admits via the email path, which leaves username NULL (see
  // batchAdmitDirectoryAccountUsers: username is only synthesized when the account has no
  // email) — so cleanup must also match by this suite's TS-tagged email, not just username.
  const testUserMatchClause = `(username LIKE $1 OR lower(email) LIKE $2)`
  const testUserMatchParams = [`p21-%-${TS}`, `%-${TS}@x.com`]

  afterEach(async () => {
    // Each test owns its usernames/emails; clean any admitted/orphaned rows between tests.
    await query(`DELETE FROM directory_account_links WHERE local_user_id IN (SELECT id FROM users WHERE ${testUserMatchClause})`, testUserMatchParams)
    await query(`DELETE FROM user_external_identities WHERE local_user_id IN (SELECT id FROM users WHERE ${testUserMatchClause})`, testUserMatchParams)
    await query(`DELETE FROM users WHERE ${testUserMatchClause}`, testUserMatchParams)
  })

  afterAll(async () => {
    if (!integrationId) return
    await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
    await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
  })

  // Part 1, isolated: createDirectoryAdmittedUserInTransaction's create-time existence check
  // must reject a differently-cased email match, not just an exact one — the review's exact
  // finding (user count 1 -> 2). Driven directly (not through batchAdmitDirectoryAccountUsers)
  // so a regression here is detectable even if the batch-admit eligibility gate (Part 2) is
  // independently broken or bypassed via the single-admit route.
  it('createDirectoryAdmittedUserInTransaction rejects a case-differently-cased email match (no duplicate)', async () => {
    const email = `Alice-${TS}@x.com`
    const username = `p21-alice-${TS}`
    await query(
      `INSERT INTO users (id, email, username, name, password_hash, is_active) VALUES ($1, $2, $1, 'Alice', 'x', true)`,
      [username, email],
    )
    await expect(userCountByEmailCI(email)).resolves.toBe(1)

    const account = await seedIntegrationAccount({
      email: email.toLowerCase(),
      mobile: null,
      unionId: `union-p21-a-${TS}`,
      tag: 'a',
    })

    let threw = false
    let message = ''
    await transaction(async (client) => {
      try {
        await createDirectoryAdmittedUserInTransaction(client, {
          account,
          adminUserId: 'system:test',
          name: 'Alice Admitted',
          email: email.toLowerCase(),
          username: null,
          mobile: null,
          passwordHash: 'hashed',
          mustChangePassword: true,
          enableDingTalkGrant: false,
        })
      } catch (error) {
        threw = true
        message = error instanceof Error ? error.message : String(error)
      }
    })

    expect(threw).toBe(true)
    expect(message).toMatch(/already exists/i)
    // The review's exact finding was count going 1 -> 2. It must stay 1.
    await expect(userCountByEmailCI(email)).resolves.toBe(1)
  })

  // Primary scenario, end to end: drive the actual vulnerable route's service function
  // (batchAdmitDirectoryAccountUsers) with the review's exact case-mismatch setup and assert no
  // second user is created.
  it('batchAdmitDirectoryAccountUsers rejects an account whose email case-insensitively matches an existing user', async () => {
    const email = `Bob-${TS}@x.com`
    const username = `p21-bob-${TS}`
    await query(
      `INSERT INTO users (id, email, username, name, password_hash, is_active) VALUES ($1, $2, $1, 'Bob', 'x', true)`,
      [username, email],
    )

    const account = await seedIntegrationAccount({
      email: email.toLowerCase(),
      mobile: null,
      unionId: `union-p21-b-${TS}`,
      tag: 'b',
    })

    const outcome = await batchAdmitDirectoryAccountUsers([account.id], { adminUserId: 'system:test' })

    expect(outcome.succeeded).toEqual([])
    expect(outcome.failed).toEqual([
      { accountId: account.id, error: expect.stringMatching(/already exists/i) },
    ])
    await expect(userCountByEmailCI(email)).resolves.toBe(1) // NOT 2
  })

  // Part 2, isolated: an account already linked to a local user, with NO email/mobile at all,
  // so Part 1's email check could never be what rejects it. Only the batch-admit eligibility
  // gate's "already linked" branch protects this vector — re-admitting would otherwise create a
  // brand new `users` row and silently repoint (orphan) the existing link.
  it('batchAdmitDirectoryAccountUsers rejects an account already linked to a local user', async () => {
    const boundUsername = `p21-bound-${TS}`
    const boundUserId = (await query<{ id: string }>(
      `INSERT INTO users (id, username, name, password_hash, is_active) VALUES ($1, $1, 'Bound Owner', 'x', true) RETURNING id`,
      [boundUsername],
    )).rows[0].id

    const account = await seedIntegrationAccount({
      email: null,
      mobile: null,
      unionId: `union-p21-c-${TS}`,
      tag: 'c',
    })
    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at)
       VALUES ($1::uuid, $2, 'linked', 'manual_admin', NOW(), NOW())`,
      [account.id, boundUserId],
    )

    const outcome = await batchAdmitDirectoryAccountUsers([account.id], { adminUserId: 'system:test' })

    expect(outcome.succeeded).toEqual([])
    expect(outcome.failed).toEqual([
      { accountId: account.id, error: expect.stringMatching(/already linked/i) },
    ])
    // No second user was created for this account, and the original link is untouched.
    await expect(userCountByUsername(boundUsername)).resolves.toBe(1)
    const link = await query<{ local_user_id: string }>(
      `SELECT local_user_id FROM directory_account_links WHERE directory_account_id = $1::uuid`,
      [account.id],
    )
    expect(link.rows[0]?.local_user_id).toBe(boundUserId)
  })

  // Control: a genuinely fresh account (no email/mobile collision, not linked) is still
  // admitted normally — the new gate must not be overly broad.
  it('admits a fresh, non-colliding account (control)', async () => {
    const email = `Carol-${TS}@x.com`
    const account = await seedIntegrationAccount({
      email: email.toLowerCase(),
      mobile: null,
      unionId: `union-p21-d-${TS}`,
      tag: 'd',
    })

    const outcome = await batchAdmitDirectoryAccountUsers([account.id], { adminUserId: 'system:test' })

    expect(outcome.failed).toEqual([])
    expect(outcome.succeeded).toHaveLength(1)
    await expect(userCountByEmailCI(email)).resolves.toBe(1)
  })
})
