import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { applyDirectoryDeprovisionPolicies } from '../../src/directory/directory-sync'

/**
 * W4-PRE-1c items A/B, owner cases ② ("双组织") and ③ ("活跃 sibling") — proved against real
 * Postgres via a DIRECT call to `applyDirectoryDeprovisionPolicies` (same harness style as the
 * pre-existing `directory-deprovision-selection.db.test.ts`; case ①'s own file drives the full
 * `syncDirectoryIntegration` orchestration, which owner named specifically for that case only).
 *
 * DOC-COMMENT CORRECTED post-hoc by W4-PRE-1d (owner P1/P2, #4530 review, issuecomment-
 * 5043752399) — the file's assertions and fixtures are UNCHANGED and still pass (both cases'
 * outcomes happen to coincide under the new org-scoped guard, for the reasons below); only the
 * stale "GLOBAL guard" framing below has been corrected so it does not misdescribe the current
 * candidate-selection predicate as GLOBAL when it is now ORG-SCOPED.
 *
 * Case ② construction note (see PR body's combination-semantics section for the full reasoning):
 * `applyDirectoryDeprovisionPolicies`'s OWN candidate-selection sibling guard was GLOBAL when
 * this file was written (any OTHER active *directory-linked* account, in ANY org, disqualified a
 * person from being a candidate at all — pre-existing #4526 "rehire protection" behaviour). As of
 * W4-PRE-1d it is ORG-SCOPED (same org as the departing account only) — case ②'s org-B sibling
 * being a BARE `user_orgs` row (no `directory_account_links` row at all) means it was, and still
 * is, invisible to this guard EITHER way, so this case's outcome is unaffected by the split; it
 * was never actually exercising the GLOBAL-vs-org-scoped distinction (that gap is exactly what
 * the owner's P1 finding named, and what `attendance-w4pre1d-departure-candidate-split.db.test.ts`
 * now covers with a REAL org-B binding instead of this bare stand-in). Org B's membership here is
 * seeded directly as a `user_orgs` row, exactly the shape a `POST /api/admin/users` explicit-
 * `attendanceOrgId` admission (#4526 item D) would leave behind.
 *
 * Case ③ framing (owner asked for this explicitly; see PR body): the sibling here is in THIS
 * SAME org (same integration), so both the pre-W4-PRE-1d GLOBAL guard and the current ORG-SCOPED
 * guard exclude this person from candidacy for the same underlying reason (an active, linked
 * sibling in org A itself) — this case does not distinguish the two guards either. Whenever
 * either guard admits a candidate, the org-scoped "no other active binding" check INSIDE
 * `deactivateUserOrgMembershipIfNoOtherActiveBinding` (#4526) is provably always satisfied too,
 * so this call path can only reach case ③ via the candidate-selection pre-filter (candidateCount:
 * 0, the new user_orgs write is never reached at all).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const uid = (name: string) => `w4pre1cos-${name}-${TS}`

describeIfDatabase('W4-PRE-1c cases ②③ — org-scoped user_orgs deactivation on policy execution (real DB)', () => {
  let integrationA = ''
  let integrationB = ''
  let orgA = ''
  let orgB = ''

  const client = {
    query: (sql: string, params?: unknown[]) =>
      query(sql, params).then((r) => ({ rows: r.rows as Array<Record<string, unknown>> })),
  }

  const baseOptions = {
    integrationDefaultPolicy: 'mark_inactive',
    syncedAccountCount: 100,
    enabled: true,
  }

  async function seedAccount(opts: {
    integrationId: string
    userId: string
    accountActive: boolean
    override?: string | null
  }): Promise<string> {
    await query(
      `INSERT INTO users (id, password_hash, is_active) VALUES ($1, 'x', true) ON CONFLICT (id) DO NOTHING`,
      [opts.userId],
    )
    const external = `${opts.userId}-acct-${Math.random().toString(36).slice(2, 10)}`
    const account = await query<{ id: string }>(
      `INSERT INTO directory_accounts
         (integration_id, external_user_id, external_key, name, is_active, deprovision_policy_override)
       VALUES ($1, $2, $3, 'Fixture', $4, $5)
       RETURNING id::text AS id`,
      [opts.integrationId, external, `dingtalk:${external}`, opts.accountActive, opts.override ?? null],
    )
    const accountId = account.rows[0].id
    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
       VALUES ($1::uuid, $2, 'linked')`,
      [accountId, opts.userId],
    )
    return accountId
  }

  const membershipIsActive = async (userId: string, orgId: string): Promise<boolean | null> => {
    const result = await query<{ is_active: boolean }>(`SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`, [userId, orgId])
    return result.rows[0]?.is_active ?? null
  }

  beforeAll(async () => {
    integrationA = (await query<{ id: string; org_id: string }>(
      `INSERT INTO directory_integrations (name, corp_id, org_id) VALUES ($1, $2, $3) RETURNING id::text AS id, org_id`,
      [`w4pre1cos-a-${TS}`, `w4pre1cos-corp-a-${TS}`, `w4pre1cos-org-a-${TS}`],
    )).rows[0].id
    orgA = `w4pre1cos-org-a-${TS}`
    integrationB = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id, org_id) VALUES ($1, $2, $3) RETURNING id::text AS id`,
      [`w4pre1cos-b-${TS}`, `w4pre1cos-corp-b-${TS}`, `w4pre1cos-org-b-${TS}`],
    )).rows[0].id
    orgB = `w4pre1cos-org-b-${TS}`
  })

  afterEach(async () => {
    await query(`DELETE FROM user_external_auth_grants WHERE local_user_id LIKE $1`, [`w4pre1cos-%-${TS}`])
    await query(`DELETE FROM user_orgs WHERE user_id LIKE $1`, [`w4pre1cos-%-${TS}`])
    await query(`DELETE FROM directory_accounts WHERE integration_id = ANY($1::uuid[])`, [[integrationA, integrationB]]) // links cascade
    await query(`DELETE FROM users WHERE id LIKE $1`, [`w4pre1cos-%-${TS}`])
  })

  afterAll(async () => {
    await query(`DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])`, [[integrationA, integrationB]])
  })

  it('case ② dual-org: org A policy execution deactivates ONLY org A membership; org B (non-directory-linked) membership is untouched', async () => {
    const user = uid('dualorg')
    const departedA = await seedAccount({ integrationId: integrationA, userId: user, accountActive: false })

    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [user, orgA])
    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [user, orgB])

    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationId: integrationA,
      deactivatedAccountIds: [departedA],
    })

    expect(outcome.candidateCount).toBe(1)
    expect(outcome.usersDeactivatedCount).toBe(1)
    await expect(membershipIsActive(user, orgA)).resolves.toBe(false)
    await expect(membershipIsActive(user, orgB)).resolves.toBe(true)
  })

  it('case ③ active sibling (same org): a person with another linked+active account is not even a candidate, so the pre-seeded active user_orgs row stays untouched', async () => {
    const user = uid('sibling')
    const departed = await seedAccount({ integrationId: integrationA, userId: user, accountActive: false })
    await seedAccount({ integrationId: integrationA, userId: user, accountActive: true }) // active sibling, SAME org/integration

    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [user, orgA])

    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationId: integrationA,
      deactivatedAccountIds: [departed],
    })

    // The (as of W4-PRE-1d, ORG-SCOPED) sibling guard excludes this person from candidacy
    // entirely — the sibling is active+linked in this SAME org, so both the pre-existing GLOBAL
    // guard and the current org-scoped one agree here; the new user_orgs write is never reached.
    // See file doc-comment.
    expect(outcome.candidateCount).toBe(0)
    expect(outcome.affected).toEqual([])
    await expect(membershipIsActive(user, orgA)).resolves.toBe(true)
  })

  it('positive control: a genuinely single-binding departure in org A DOES deactivate org A membership (sanity check for the two tests above)', async () => {
    const user = uid('control')
    const departed = await seedAccount({ integrationId: integrationA, userId: user, accountActive: false })
    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [user, orgA])

    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationId: integrationA,
      deactivatedAccountIds: [departed],
    })

    expect(outcome.candidateCount).toBe(1)
    await expect(membershipIsActive(user, orgA)).resolves.toBe(false)
  })

  it('disable_grant_only ALSO attempts the user_orgs deactivation (owner 裁决②: "策略实际执行" excludes only manual_review)', async () => {
    const user = uid('grantonly')
    const departed = await seedAccount({ integrationId: integrationA, userId: user, accountActive: false })
    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [user, orgA])

    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationId: integrationA,
      integrationDefaultPolicy: 'disable_grant_only',
      deactivatedAccountIds: [departed],
    })

    expect(outcome.usersDeactivatedCount).toBe(0) // users.is_active untouched, as before
    expect(outcome.grantsDisabledCount).toBe(1)
    const user_active = await query<{ is_active: boolean }>(`SELECT is_active FROM users WHERE id = $1`, [user])
    expect(user_active.rows[0].is_active).toBe(true)
    // …but org membership IS deactivated — a genuinely new consequence flagged for owner review.
    await expect(membershipIsActive(user, orgA)).resolves.toBe(false)
  })
})
