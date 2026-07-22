import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { applyDirectoryDeprovisionPolicies } from '../../src/directory/directory-sync'

/**
 * W4-PRE-1d — candidate-set split (owner P1/P2, #4530 review, issuecomment-5043752399,
 * 2026-07-22), replacing the false-negative "双组织测试" from W4-PRE-1c
 * (`attendance-w4pre1c-departure-org-scoped.db.test.ts` case②, whose org-B leg was a BARE
 * `user_orgs` row with NO real directory binding — a shape that never reaches the code path the
 * P1 actually lives in).
 *
 * Owner's confirmed P1, verbatim: "全局 sibling guard（directory-sync.ts:1425）把「A 离职但仍
 * 在 B 任职」的用户整体排除出候选集 ⇒ A/B membership 都保持 active；我方「双组织测试」用裸 B
 * user_orgs 行（无真实 binding）替身构造，恰好避开了点名场景——正门 0/0/0 在此为假阴性（fixture
 * 形状与场景名失配，已固化为教训）。"
 *
 * FIXTURE SHAPE CHECKLIST for the named scenario below (every test that exercises it re-creates
 * this shape from scratch; nothing is a bare `user_orgs` row standing in for a binding):
 *   - TWO real `directory_integrations` rows (org A / org B), each with its OWN distinct,
 *     explicit `org_id` (never the shared `default` sentinel — two integrations created without
 *     an explicit org_id would collapse onto the SAME default org and silently defeat the whole
 *     point of this fixture).
 *   - TWO real `directory_accounts` rows for the SAME local user, one per integration.
 *   - TWO real `directory_account_links` rows (`link_status = 'linked'`), one per account —
 *     this is the exact join `applyDirectoryDeprovisionPolicies`'s candidate/global queries
 *     read; a row in `user_orgs` alone (no link) is invisible to both queries.
 *   - TWO real `user_orgs` rows (org A / org B), both `is_active = true` before the run.
 * "Departs org A" = org A's `directory_accounts.is_active` flips to `false` (the real sweep
 * transition) while org B's account stays `is_active = true` and linked throughout.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const uid = (name: string) => `w4pre1d-${name}-${TS}`

describeIfDatabase('W4-PRE-1d — org-membership vs global candidate-set split (real DB)', () => {
  let integrationA = ''
  let integrationB = ''
  let orgA = ''
  let orgB = ''

  const client = {
    query: (sql: string, params?: unknown[]) =>
      query(sql, params).then((r) => ({ rows: r.rows as Array<Record<string, unknown>> })),
  }

  const membershipIsActive = async (userId: string, orgId: string): Promise<boolean | null> => {
    const result = await query<{ is_active: boolean }>(
      `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
      [userId, orgId],
    )
    return result.rows[0]?.is_active ?? null
  }

  const isUserActive = async (userId: string): Promise<boolean | null> =>
    (await query<{ is_active: boolean }>(`SELECT is_active FROM users WHERE id = $1`, [userId])).rows[0]?.is_active ?? null

  const grantEnabled = async (userId: string): Promise<boolean | undefined> =>
    (await query<{ enabled: boolean }>(
      `SELECT enabled FROM user_external_auth_grants WHERE provider = 'dingtalk' AND local_user_id = $1`,
      [userId],
    )).rows[0]?.enabled

  /** Creates a user (if not already present) plus one linked directory account in `integrationId`,
   * plus an ACTIVE `user_orgs` row in `orgId`. Returns the directory_accounts.id. */
  async function seedRealBinding(opts: {
    userId: string
    integrationId: string
    orgId: string
    accountActive: boolean
  }): Promise<string> {
    await query(
      `INSERT INTO users (id, password_hash, is_active) VALUES ($1, 'x', true) ON CONFLICT (id) DO NOTHING`,
      [opts.userId],
    )
    await query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
      [opts.userId, opts.orgId],
    )
    const external = `${opts.userId}-${opts.integrationId}-acct`
    const account = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active)
       VALUES ($1, $2, $3, 'Fixture', $4) RETURNING id::text AS id`,
      [opts.integrationId, external, `dingtalk:${external}`, opts.accountActive],
    )
    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
       VALUES ($1::uuid, $2, 'linked')`,
      [account.rows[0].id, opts.userId],
    )
    return account.rows[0].id
  }

  async function seedEnabledGrant(userId: string): Promise<void> {
    await query(
      `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by, created_at, updated_at)
       VALUES ('dingtalk', $1, TRUE, 'system:test-fixture', NOW(), NOW())`,
      [userId],
    )
  }

  beforeAll(async () => {
    integrationA = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id, org_id) VALUES ($1, $2, $3) RETURNING id::text AS id`,
      [`w4pre1d-a-${TS}`, `w4pre1d-corp-a-${TS}`, `w4pre1d-org-a-${TS}`],
    )).rows[0].id
    orgA = `w4pre1d-org-a-${TS}`
    integrationB = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id, org_id) VALUES ($1, $2, $3) RETURNING id::text AS id`,
      [`w4pre1d-b-${TS}`, `w4pre1d-corp-b-${TS}`, `w4pre1d-org-b-${TS}`],
    )).rows[0].id
    orgB = `w4pre1d-org-b-${TS}`
  })

  afterEach(async () => {
    await query(`DELETE FROM user_external_auth_grants WHERE local_user_id LIKE $1`, [`w4pre1d-%-${TS}`])
    await query(`DELETE FROM user_orgs WHERE user_id LIKE $1`, [`w4pre1d-%-${TS}`])
    await query(`DELETE FROM directory_accounts WHERE integration_id = ANY($1::uuid[])`, [[integrationA, integrationB]]) // links cascade
    await query(`DELETE FROM users WHERE id LIKE $1`, [`w4pre1d-%-${TS}`])
  })

  afterAll(async () => {
    await query(`DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])`, [[integrationA, integrationB]])
  })

  describe('① owner-named scenario, field-for-field: A departs while B is a REAL, still-active binding', () => {
    it('mark_inactive leg: A membership deactivated, B membership stays active, platform user stays active, grant survives', async () => {
      const user = uid('named-mi')
      await seedRealBinding({ userId: user, integrationId: integrationB, orgId: orgB, accountActive: true })
      const departedA = await seedRealBinding({ userId: user, integrationId: integrationA, orgId: orgA, accountActive: false })
      await seedEnabledGrant(user)

      const outcome = await applyDirectoryDeprovisionPolicies(client, {
        integrationId: integrationA,
        deactivatedAccountIds: [departedA],
        syncedAccountCount: 50,
        integrationDefaultPolicy: 'mark_inactive',
        enabled: true,
      })

      // Org-membership candidate set (item 1): A alone has no OTHER active binding in org A —
      // real, so this person IS a candidate.
      expect(outcome.candidateCount).toBe(1)
      // Global candidate set (item 2): B's REAL active binding means this person is NOT
      // globally clear — the P1 defect's exact axis.
      expect(outcome.globalCandidateCount).toBe(0)
      expect(outcome.affected).toEqual([
        { directoryAccountId: departedA, localUserId: user, policy: 'mark_inactive', globallyClear: false },
      ])

      // THE LOAD-BEARING ASSERTIONS (owner's named scenario, exact fields):
      await expect(membershipIsActive(user, orgA)).resolves.toBe(false) // A membership deactivated
      await expect(membershipIsActive(user, orgB)).resolves.toBe(true) // B membership untouched
      await expect(isUserActive(user)).resolves.toBe(true) // platform user stays active
      await expect(grantEnabled(user)).resolves.toBe(true) // grant survives (was TRUE, still TRUE)
    })

    it('disable_grant_only leg: A membership deactivated, B membership stays active, platform user stays active, grant survives', async () => {
      const user = uid('named-dgo')
      await seedRealBinding({ userId: user, integrationId: integrationB, orgId: orgB, accountActive: true })
      const departedA = await seedRealBinding({ userId: user, integrationId: integrationA, orgId: orgA, accountActive: false })
      await seedEnabledGrant(user)

      const outcome = await applyDirectoryDeprovisionPolicies(client, {
        integrationId: integrationA,
        deactivatedAccountIds: [departedA],
        syncedAccountCount: 50,
        integrationDefaultPolicy: 'disable_grant_only',
        enabled: true,
      })

      expect(outcome.candidateCount).toBe(1)
      expect(outcome.globalCandidateCount).toBe(0)
      expect(outcome.grantsDisabledCount).toBe(0)
      expect(outcome.usersDeactivatedCount).toBe(0)

      await expect(membershipIsActive(user, orgA)).resolves.toBe(false)
      await expect(membershipIsActive(user, orgB)).resolves.toBe(true)
      await expect(isUserActive(user)).resolves.toBe(true)
      await expect(grantEnabled(user)).resolves.toBe(true)
    })
  })

  describe('② last-org departure: once B ALSO departs, the global guard clears and grant/platform-user actions fire', () => {
    it('mark_inactive: second run (B departs too) deactivates the platform user and closes the grant', async () => {
      const user = uid('lastdep-mi')
      const bindingB = await seedRealBinding({ userId: user, integrationId: integrationB, orgId: orgB, accountActive: true })
      const departedA = await seedRealBinding({ userId: user, integrationId: integrationA, orgId: orgA, accountActive: false })
      await seedEnabledGrant(user)

      // Run 1: A departs while B is still active — same as case① above.
      const first = await applyDirectoryDeprovisionPolicies(client, {
        integrationId: integrationA,
        deactivatedAccountIds: [departedA],
        syncedAccountCount: 50,
        integrationDefaultPolicy: 'mark_inactive',
        enabled: true,
      })
      expect(first.globalCandidateCount).toBe(0)
      await expect(isUserActive(user)).resolves.toBe(true)
      await expect(grantEnabled(user)).resolves.toBe(true)

      // Now B ALSO departs — the real sweep transition, then the executor runs for org B.
      await query(`UPDATE directory_accounts SET is_active = false WHERE id = $1`, [bindingB])
      const second = await applyDirectoryDeprovisionPolicies(client, {
        integrationId: integrationB,
        deactivatedAccountIds: [bindingB],
        syncedAccountCount: 50,
        integrationDefaultPolicy: 'mark_inactive',
        enabled: true,
      })

      // Org-membership candidate for org B (no other active binding in org B); NOW globally
      // clear too (org A's account is already inactive from run 1).
      expect(second.candidateCount).toBe(1)
      expect(second.globalCandidateCount).toBe(1)

      await expect(membershipIsActive(user, orgA)).resolves.toBe(false)
      await expect(membershipIsActive(user, orgB)).resolves.toBe(false)
      await expect(isUserActive(user)).resolves.toBe(false) // NOW deactivated
      await expect(grantEnabled(user)).resolves.toBe(false) // NOW closed
    })

    it('disable_grant_only: second run (B departs too) closes the grant but the platform user is NEVER touched', async () => {
      const user = uid('lastdep-dgo')
      const bindingB = await seedRealBinding({ userId: user, integrationId: integrationB, orgId: orgB, accountActive: true })
      const departedA = await seedRealBinding({ userId: user, integrationId: integrationA, orgId: orgA, accountActive: false })
      await seedEnabledGrant(user)

      await applyDirectoryDeprovisionPolicies(client, {
        integrationId: integrationA,
        deactivatedAccountIds: [departedA],
        syncedAccountCount: 50,
        integrationDefaultPolicy: 'disable_grant_only',
        enabled: true,
      })
      await expect(grantEnabled(user)).resolves.toBe(true)
      await expect(isUserActive(user)).resolves.toBe(true)

      await query(`UPDATE directory_accounts SET is_active = false WHERE id = $1`, [bindingB])
      const second = await applyDirectoryDeprovisionPolicies(client, {
        integrationId: integrationB,
        deactivatedAccountIds: [bindingB],
        syncedAccountCount: 50,
        integrationDefaultPolicy: 'disable_grant_only',
        enabled: true,
      })

      expect(second.globalCandidateCount).toBe(1)
      expect(second.usersDeactivatedCount).toBe(0) // disable_grant_only never sets this

      await expect(membershipIsActive(user, orgA)).resolves.toBe(false)
      await expect(membershipIsActive(user, orgB)).resolves.toBe(false)
      await expect(grantEnabled(user)).resolves.toBe(false) // NOW closed — globally clear
      await expect(isUserActive(user)).resolves.toBe(true) // …but the platform user survives, always
    })
  })

  describe('③ breaker uses the org-membership candidate count, not the global-filtered count', () => {
    it('trips batch_exceeds_max on candidateCount even though EVERY candidate is globally protected (globalCandidateCount would be 0)', async () => {
      // Three DIFFERENT users, each with a real departed account in org A and a real ACTIVE
      // account in their OWN separate org (so none of them is globally clear) — a batch that
      // the OLD global-guard-at-selection code would have reported as 0 candidates (silently
      // admitting all three), but which the org-membership count correctly sees as 3.
      const users = [uid('breaker1'), uid('breaker2'), uid('breaker3')]
      const departedIds: string[] = []
      const otherOrgIntegrationIds: string[] = []
      try {
        for (const [i, user] of users.entries()) {
          const otherOrgIntegration = (await query<{ id: string }>(
            `INSERT INTO directory_integrations (name, corp_id, org_id) VALUES ($1, $2, $3) RETURNING id::text AS id`,
            [`w4pre1d-breaker-other-${i}-${TS}`, `w4pre1d-breaker-other-corp-${i}-${TS}`, `w4pre1d-breaker-other-org-${i}-${TS}`],
          )).rows[0].id
          otherOrgIntegrationIds.push(otherOrgIntegration)
          await seedRealBinding({
            userId: user,
            integrationId: otherOrgIntegration,
            orgId: `w4pre1d-breaker-other-org-${i}-${TS}`,
            accountActive: true,
          })
          const departed = await seedRealBinding({ userId: user, integrationId: integrationA, orgId: orgA, accountActive: false })
          departedIds.push(departed)
        }

        const outcome = await applyDirectoryDeprovisionPolicies(client, {
          integrationId: integrationA,
          deactivatedAccountIds: departedIds,
          syncedAccountCount: 50,
          integrationDefaultPolicy: 'mark_inactive',
          maxBatch: 2, // 3 org-membership candidates > 2 ⇒ must abort
          enabled: true,
        })

        expect(outcome.candidateCount).toBe(3)
        expect(outcome.abortedReason).toBe('batch_exceeds_max')
        expect(outcome.applied).toBe(false)
        expect(outcome.globalCandidateCount).toBe(0)

        // Nothing was touched — the abort happened before any write, for all three.
        for (const user of users) {
          await expect(membershipIsActive(user, orgA)).resolves.toBe(true)
          await expect(isUserActive(user)).resolves.toBe(true)
        }
      } finally {
        // Cascades to that integration's own directory_accounts/links (FK ON DELETE CASCADE);
        // the shared afterEach only reaches integrationA/integrationB.
        await query(`DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])`, [otherOrgIntegrationIds])
      }
    })
  })

  describe('④ manual_review regression under the split: unaffected by globallyClear either way', () => {
    it('manual_review: both memberships stay active, no write at all, pending exposure unaffected by cross-org binding', async () => {
      const user = uid('mr')
      await seedRealBinding({ userId: user, integrationId: integrationB, orgId: orgB, accountActive: true })
      const departedA = await seedRealBinding({ userId: user, integrationId: integrationA, orgId: orgA, accountActive: false })

      const outcome = await applyDirectoryDeprovisionPolicies(client, {
        integrationId: integrationA,
        deactivatedAccountIds: [departedA],
        syncedAccountCount: 50,
        integrationDefaultPolicy: 'manual_review',
        enabled: true,
      })

      expect(outcome.candidateCount).toBe(1)
      expect(outcome.manualReviewCount).toBe(1)
      expect(outcome.affected).toEqual([])
      expect(outcome.manualReviewPending).toEqual([{ directoryAccountId: departedA, localUserId: user, orgId: orgA }])

      await expect(membershipIsActive(user, orgA)).resolves.toBe(true)
      await expect(membershipIsActive(user, orgB)).resolves.toBe(true)
      await expect(isUserActive(user)).resolves.toBe(true)
    })
  })

  describe('⑤ switch OFF: zero deactivation even for the owner-named scenario, preview numbers still split correctly', () => {
    it('enabled:false leaves both real memberships, the platform user, and the grant untouched — preview reports the split', async () => {
      const user = uid('off')
      await seedRealBinding({ userId: user, integrationId: integrationB, orgId: orgB, accountActive: true })
      const departedA = await seedRealBinding({ userId: user, integrationId: integrationA, orgId: orgA, accountActive: false })
      await seedEnabledGrant(user)

      const outcome = await applyDirectoryDeprovisionPolicies(client, {
        integrationId: integrationA,
        deactivatedAccountIds: [departedA],
        syncedAccountCount: 50,
        integrationDefaultPolicy: 'mark_inactive',
        enabled: false,
      })

      expect(outcome.applied).toBe(false)
      expect(outcome.candidateCount).toBe(1) // org-membership candidate, preview-counted
      expect(outcome.globalCandidateCount).toBe(0) // not globally clear — B is real+active
      expect(outcome.membershipDeactivationAttemptedCount).toBe(1) // "would have" attempted
      expect(outcome.usersDeactivatedCount).toBe(0) // "would have" — gated on globallyClear, which is false here
      expect(outcome.grantsDisabledCount).toBe(0)

      await expect(membershipIsActive(user, orgA)).resolves.toBe(true)
      await expect(membershipIsActive(user, orgB)).resolves.toBe(true)
      await expect(isUserActive(user)).resolves.toBe(true)
      await expect(grantEnabled(user)).resolves.toBe(true)
    })
  })
})
