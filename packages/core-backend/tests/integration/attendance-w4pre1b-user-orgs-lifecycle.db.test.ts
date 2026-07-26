import { afterAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { query } from '../../src/db/pg'
import { bindDirectoryAccount, unbindDirectoryAccount, __userOrgsMembershipInternalsForTests } from '../../src/directory/directory-sync'
import { createLocalAccount, archiveLocalAccount } from '../../src/directory/local-directory-org'
import { poolManager } from '../../src/integration/db/connection-pool'

/**
 * W4-PRE-1b (owner CHANGES_REQUESTED on the W4 re-ratify PR #4522, 2026-07-21): full
 * `user_orgs` LIFECYCLE — bind/auto-match writers (item A) and org-scoped safe-deactivation
 * writers (item B), exercised against a real Postgres via the ACTUAL service functions
 * (`bindDirectoryAccount` / `unbindDirectoryAccount` / `createLocalAccount` /
 * `archiveLocalAccount`), matching the #4521 precedent of driving production write functions
 * directly rather than reimplementing their SQL in the test.
 *
 * Owner-named test cases covered here:
 *  F1 bind an existing user → membership row present (same transaction; failure-injection
 *     rollback leg proves atomicity)
 *  F2 last unbind → deactivated
 *  F3 double binding, unbind one → the other keeps membership ACTIVE
 *  F4 A→B org migration → old org deactivated + new org established
 *
 * (A same-call "rebind displacement" scenario — one `bindDirectoryAccount` call reassigning an
 * already-DingTalk-linked account from user A straight to user B — was investigated and is NOT
 * exercised here: it is empirically UNREACHABLE for DingTalk accounts, because
 * `applyDirectoryAccountBindInTransaction`'s pre-existing identity-conflict guard throws
 * "DingTalk account is already bound to another local user" before the link write is ever
 * reached — proven by running exactly that call sequence against this DB. The prior-holder
 * capture + deactivate code added for this case is retained as defense-in-depth; see the PR
 * body's deviations section for the full finding.)
 *
 * And local-provider coverage (item A/B's OTHER writer pair, `local-directory-org.ts`):
 * createLocalAccount binds an existing user; archiveLocalAccount deactivates their membership
 * when it was their last local binding in the org.
 *
 * Post-gate fix (PR #4526 review, P2 — cross-org negative regression, added 2026-07-21):
 * `deactivateUserOrgMembershipIfNoOtherActiveBinding`'s tenant-isolation predicate
 * (`AND i.org_id = $2::text`, `directory-sync.ts:4977`) had zero coverage — every existing case
 * above (F1/F2/F4/local-provider = single-org; F3/F3-race = same-org sibling) exercises the
 * "other active binding" NOT EXISTS check with only ONE org in play, so none of them can tell the
 * predicate apart from an unscoped "does this user have ANY other active binding anywhere" check.
 * The "cross-org tenant-isolation regression" case below closes that gap: same user, DingTalk
 * binding in org A + local binding in org B, unbind A, assert org A deactivates (the predicate
 * must NOT be fooled by org B's still-active sibling) AND org B stays active (the predicate must
 * not reach into org B either).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const RUN = crypto.randomBytes(4).toString('hex')
const NS = `w4pre1blife${TS}${RUN}`

describeIfDatabase('W4-PRE-1b — user_orgs lifecycle: bind/unbind/rebind/local (real DB)', () => {
  const integrationIds: string[] = []
  const userIds: string[] = []
  const adminUserId = `${NS}-admin`

  async function seedUser(tag: string): Promise<string> {
    const id = `${NS}-u-${tag}-${crypto.randomBytes(3).toString('hex')}`
    await query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $3, 'Fixture', 'x', 'user', '[]'::jsonb, true, false, NOW(), NOW())`,
      [id, `${id}@example.test`, id],
    )
    userIds.push(id)
    return id
  }

  async function seedIntegration(org: string, tag: string): Promise<string> {
    const id = (
      await query<{ id: string }>(
        `INSERT INTO directory_integrations (org_id, name, corp_id, provider, status)
         VALUES ($1, $2, $3, 'dingtalk', 'active') RETURNING id::text AS id`,
        [org, `${NS}-int-${tag}`, `${NS}-corp-${tag}`],
      )
    ).rows[0].id
    integrationIds.push(id)
    return id
  }

  async function seedAccount(integrationId: string, tag: string): Promise<string> {
    const external = `${NS}-ext-${tag}`
    return (
      await query<{ id: string }>(
        `INSERT INTO directory_accounts (integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key, name, is_active)
         SELECT $1, 'dingtalk', integration.corp_id, $2, $3, $4, $5, 'Fixture', true
           FROM directory_integrations integration
          WHERE integration.id = $1
         RETURNING id::text AS id`,
        [integrationId, external, `${NS}-union-${tag}`, `${NS}-open-${tag}`, external],
      )
    ).rows[0].id
  }

  async function membershipRow(userId: string, orgId: string): Promise<{ is_active: boolean } | undefined> {
    const rows = await query<{ is_active: boolean }>(
      `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
      [userId, orgId],
    )
    return rows.rows[0]
  }

  afterAll(async () => {
    if (userIds.length) {
      await query(`DELETE FROM directory_account_departments WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = ANY($1::uuid[]))`, [integrationIds])
      await query(`DELETE FROM user_external_identities WHERE local_user_id = ANY($1::text[])`, [userIds])
      await query(`DELETE FROM directory_account_links WHERE local_user_id = ANY($1::text[])`, [userIds])
      await query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [userIds])
      await query(`DELETE FROM users WHERE id = ANY($1::text[])`, [userIds])
    }
    if (integrationIds.length) {
      await query(`DELETE FROM directory_accounts WHERE integration_id = ANY($1::uuid[])`, [integrationIds])
      await query(`DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])`, [integrationIds])
    }
  })

  describe('F1 — bind an existing user', () => {
    it('bindDirectoryAccount upserts an ACTIVE user_orgs row in the same transaction', async () => {
      const org = `${NS}_org_f1`
      const userId = await seedUser('f1')
      const integrationId = await seedIntegration(org, 'f1')
      const accountId = await seedAccount(integrationId, 'f1')

      const result = await bindDirectoryAccount(accountId, { localUserRef: userId, adminUserId, enableDingTalkGrant: false })
      expect(result.previousLocalUser).toBeNull()

      const row = await membershipRow(userId, org)
      expect(row).toEqual({ is_active: true })
    })

    it('failure injection: a user_orgs write failure rolls back the whole bind (no link commit)', async () => {
      const org = `${NS}_org_f1fail`
      const userId = await seedUser('f1fail')
      const integrationId = await seedIntegration(org, 'f1fail')
      const accountId = await seedAccount(integrationId, 'f1fail')

      const fnName = `w4pre1b_fail_user_orgs_bind_${RUN}`
      await query(`CREATE OR REPLACE FUNCTION ${fnName}() RETURNS trigger AS $fn$
        BEGIN
          RAISE EXCEPTION 'W4-PRE-1b injected bind user_orgs failure' USING ERRCODE = 'P0001';
        END $fn$ LANGUAGE plpgsql`)
      await query(`CREATE TRIGGER ${fnName}_trg BEFORE INSERT ON user_orgs
        FOR EACH ROW WHEN (NEW.org_id = '${org}') EXECUTE FUNCTION ${fnName}()`)

      try {
        await expect(
          bindDirectoryAccount(accountId, { localUserRef: userId, adminUserId, enableDingTalkGrant: false }),
        ).rejects.toThrow()

        const row = await membershipRow(userId, org)
        expect(row).toBeUndefined()
        const linkRows = await query(`SELECT link_status FROM directory_account_links WHERE directory_account_id = $1`, [accountId])
        expect(linkRows.rows).toEqual([])
      } finally {
        await query(`DROP TRIGGER IF EXISTS ${fnName}_trg ON user_orgs`).catch(() => {})
        await query(`DROP FUNCTION IF EXISTS ${fnName}()`).catch(() => {})
      }
    })
  })

  describe('F2 — last unbind deactivates', () => {
    it('unbindDirectoryAccount flips user_orgs.is_active to false when it was the only binding', async () => {
      const org = `${NS}_org_f2`
      const userId = await seedUser('f2')
      const integrationId = await seedIntegration(org, 'f2')
      const accountId = await seedAccount(integrationId, 'f2')

      await bindDirectoryAccount(accountId, { localUserRef: userId, adminUserId, enableDingTalkGrant: false })
      expect(await membershipRow(userId, org)).toEqual({ is_active: true })

      await unbindDirectoryAccount(accountId, { adminUserId })
      expect(await membershipRow(userId, org)).toEqual({ is_active: false })
    })
  })

  describe('F3 — double binding, unbind one, other stays active', () => {
    it('unbinding the DingTalk account when a LOCAL account is also linked keeps the membership active', async () => {
      const org = `${NS}_org_f3`
      const userId = await seedUser('f3')
      const integrationId = await seedIntegration(org, 'f3')
      const dingtalkAccount = await seedAccount(integrationId, 'f3')

      // Two DIFFERENT directory accounts (different providers) for the SAME user in the SAME
      // org — legal (the "already linked to another account" guard in
      // `applyDirectoryAccountBindInTransaction` is scoped to `a.provider = $1`, i.e. one
      // DingTalk identity per user, not one directory account of ANY kind per user). This is
      // also the realistic shape of "double binding": a DingTalk account from directory sync
      // PLUS a local-provider account from the local-org admin surface.
      await bindDirectoryAccount(dingtalkAccount, { localUserRef: userId, adminUserId, enableDingTalkGrant: false })
      const localAccount = await createLocalAccount({ orgId: org, localUserId: userId, name: 'F3 Local', email: null, mobile: null, title: null })

      expect(await membershipRow(userId, org)).toEqual({ is_active: true })

      await unbindDirectoryAccount(dingtalkAccount, { adminUserId })

      // The local account (still linked+active) keeps the membership ACTIVE — the org-scoped
      // sibling check must see it (it spans BOTH `local` and `dingtalk` directory accounts).
      expect(await membershipRow(userId, org)).toEqual({ is_active: true })
      expect(localAccount.localUserId).toBe(userId)
    })
  })

  describe('F4 — A to B org migration', () => {
    it('unbind in org A (deactivate) + bind a new account in org B (activate) for the same user', async () => {
      const orgA = `${NS}_org_f4a`
      const orgB = `${NS}_org_f4b`
      const userId = await seedUser('f4')
      const intA = await seedIntegration(orgA, 'f4a')
      const intB = await seedIntegration(orgB, 'f4b')
      const accountA = await seedAccount(intA, 'f4a')
      const accountB = await seedAccount(intB, 'f4b')

      await bindDirectoryAccount(accountA, { localUserRef: userId, adminUserId, enableDingTalkGrant: false })
      expect(await membershipRow(userId, orgA)).toEqual({ is_active: true })
      expect(await membershipRow(userId, orgB)).toBeUndefined()

      await unbindDirectoryAccount(accountA, { adminUserId })
      await bindDirectoryAccount(accountB, { localUserRef: userId, adminUserId, enableDingTalkGrant: false })

      expect(await membershipRow(userId, orgA)).toEqual({ is_active: false })
      expect(await membershipRow(userId, orgB)).toEqual({ is_active: true })
    })
  })

  describe('cross-org tenant-isolation regression — unbind in org A must not be gated by org B\'s active binding (#4526 P2)', () => {
    it('unbinding org A\'s DingTalk account deactivates ONLY org A membership; org B\'s local binding for the same user stays untouched and active', async () => {
      const orgA = `${NS}_org_xorga`
      const orgB = `${NS}_org_xorgb`
      const userId = await seedUser('xorg')
      const intA = await seedIntegration(orgA, 'xorga')
      const dingtalkAccount = await seedAccount(intA, 'xorga')

      await bindDirectoryAccount(dingtalkAccount, { localUserRef: userId, adminUserId, enableDingTalkGrant: false })
      const localAccountB = await createLocalAccount({ orgId: orgB, localUserId: userId, name: 'Cross-org Local B', email: null, mobile: null, title: null })

      expect(await membershipRow(userId, orgA)).toEqual({ is_active: true })
      expect(await membershipRow(userId, orgB)).toEqual({ is_active: true })

      await unbindDirectoryAccount(dingtalkAccount, { adminUserId })

      // Tenant-isolation predicate (`AND i.org_id = $2::text`, directory-sync.ts:4977): the "does
      // this user hold another active binding" sibling check inside
      // `deactivateUserOrgMembershipIfNoOtherActiveBinding` must be SCOPED to org A. Without that
      // scoping the NOT EXISTS would find org B's still-linked+active local account as a
      // "sibling", skip org A's deactivation, and leave org A's membership stuck ACTIVE with ZERO
      // org-A bindings — cross-org stale access.
      expect(await membershipRow(userId, orgA)).toEqual({ is_active: false })
      // Dual proof (the predicate must not be so broad it reaches INTO org B either, i.e. this is
      // not just "always deactivate everything"): org B's membership, untouched by an org-A
      // unbind, must remain ACTIVE.
      expect(await membershipRow(userId, orgB)).toEqual({ is_active: true })
      expect(localAccountB.localUserId).toBe(userId)
    })
  })

  describe('same-account rebind displacement — investigated, confirmed unreachable for DingTalk', () => {
    it('bindDirectoryAccount refuses to reassign an already-linked DingTalk account to a different user (pre-existing identity guard fires first)', async () => {
      const org = `${NS}_org_rebind`
      const userA = await seedUser('rebindA')
      const userB = await seedUser('rebindB')
      const integrationId = await seedIntegration(org, 'rebind')
      const accountId = await seedAccount(integrationId, 'rebind')

      await bindDirectoryAccount(accountId, { localUserRef: userA, adminUserId, enableDingTalkGrant: false })
      expect(await membershipRow(userA, org)).toEqual({ is_active: true })

      // This is NOT the displacement path — it documents that the pre-existing
      // `user_external_identities` conflict guard (unrelated to this ticket) makes the
      // "single-call reassignment" scenario unreachable: the throw happens BEFORE the link
      // write, so userA's membership is untouched, exactly as if the second call never happened.
      await expect(
        bindDirectoryAccount(accountId, { localUserRef: userB, adminUserId, enableDingTalkGrant: false }),
      ).rejects.toThrow('DingTalk account is already bound to another local user')

      expect(await membershipRow(userA, org)).toEqual({ is_active: true })
      expect(await membershipRow(userB, org)).toBeUndefined()
    })
  })

  describe('F3-race — concurrent deactivation calls on a double-bound user (constructed race, #4526 P2)', () => {
    // CONSTRUCTED TOCTOU RACE (two raw pg clients + pg_blocking_pids), same technique as
    // `multitable-l4-canonical-fence-realdb.test.ts`'s R1/RXR: `waitUntilBlockedBy` THROWS if B
    // never parks on A's lock, so this can never silently degrade into a non-racing sequential
    // pass. A naive `Promise.all` of two independent deactivate+commit chains was tried first and
    // is NOT reliable proof either way: on localhost, with a tiny dataset, one statement routinely
    // finishes before the other's sibling check even starts (confirmed empirically while building
    // this test — the "race" silently collapsed into safe sequential execution, converging to the
    // correct outcome regardless of whether the fix was present). A fully-sequential construction
    // (A's call awaited to completion WITHOUT committing, then B's call run) DOES reproduce the
    // skew when the fix is absent, but deadlocks against the fixed code (B's `FOR UPDATE` would
    // park on A's still-held lock forever, since nothing ever commits A). This test instead
    // verifies the SERIALIZATION MECHANISM ITSELF: A holds the row lock (uncommitted, 0-row
    // result), B's own call is fired and PROVEN to park on A's lock (not just assumed), THEN A
    // commits, B unblocks and re-evaluates against A's now-committed severance, and the final
    // state is asserted. Mutating away the `FOR UPDATE` makes B never block —
    // `waitUntilBlockedBy` throws, killing the test.
    async function waitUntilBlockedBy(blockerPid: number, timeoutMs = 5000): Promise<void> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const r = await query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND $1 = ANY(pg_blocking_pids(pid))`,
          [blockerPid],
        )
        if ((r.rows[0]?.c ?? 0) >= 1) return
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('the second deactivation call never parked on the first caller\'s row lock — the constructed race did not occur')
    }

    it('B genuinely blocks on A\'s row lock, then unblocks and correctly deactivates after A commits (no write-skew)', async () => {
      const org = `${NS}_org_f3race`
      const userId = await seedUser('f3race')
      const integrationId = await seedIntegration(org, 'f3race')
      const accountX = await seedAccount(integrationId, 'f3racex')
      const accountY = await seedAccount(integrationId, 'f3racey')

      // Seed the pre-race state directly (this test targets the low-level helper, not the
      // higher-level bind orchestration already covered by F1-F4): user linked to TWO accounts
      // in the SAME org, membership ACTIVE.
      await query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at)
         VALUES ($1, $2, 'linked', 'manual', NOW(), NOW()), ($3, $2, 'linked', 'manual', NOW(), NOW())`,
        [accountX, userId, accountY],
      )
      await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`, [userId, org])
      expect(await membershipRow(userId, org)).toEqual({ is_active: true })

      const clientA = await poolManager.get().getInternalPool().connect()
      const clientB = await poolManager.get().getInternalPool().connect()
      let bOutcome: 'blocked' | 'never-blocked' = 'never-blocked'
      let bRun: Promise<void> | undefined
      try {
        await clientA.query('BEGIN')
        await clientB.query('BEGIN')
        const pidA = Number((await clientA.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)

        // A severs its own sibling (X) and runs the deactivate helper — 0 rows (Y still looks
        // active from A's snapshot), but A's `SELECT ... FOR UPDATE` now HOLDS the row lock,
        // uncommitted.
        await clientA.query(`UPDATE directory_account_links SET local_user_id = NULL, link_status = 'unmatched' WHERE directory_account_id = $1`, [accountX])
        const qA = (sql: string, params?: unknown[]) => clientA.query(sql, params) as unknown as Promise<{ rows: Array<Record<string, unknown>> }>
        await __userOrgsMembershipInternalsForTests.deactivateUserOrgMembershipIfNoOtherActiveBinding({ query: qA }, { userId, orgId: org })

        // B severs its own sibling (Y), then fires the SAME deactivate helper WITHOUT awaiting —
        // its `FOR UPDATE` must park behind A's held lock.
        await clientB.query(`UPDATE directory_account_links SET local_user_id = NULL, link_status = 'unmatched' WHERE directory_account_id = $1`, [accountY])
        const qB = (sql: string, params?: unknown[]) => clientB.query(sql, params) as unknown as Promise<{ rows: Array<Record<string, unknown>> }>
        bRun = __userOrgsMembershipInternalsForTests.deactivateUserOrgMembershipIfNoOtherActiveBinding({ query: qB }, { userId, orgId: org })

        await waitUntilBlockedBy(pidA) // throws if B never genuinely parks — non-vacuity proof
        bOutcome = 'blocked'

        await clientA.query('COMMIT') // releases A's lock; A's own 0-row deactivate is final
        await bRun // B unblocks, re-evaluates with a FRESH snapshot that now sees X committed-severed
        await clientB.query('COMMIT')
      } finally {
        // Mutation-testing / failure safety: if `waitUntilBlockedBy` threw (mutation red path),
        // neither transaction was committed and `bRun` may still be settling (or, without the
        // fix, may already have resolved unblocked) — settle it and roll back BOTH before
        // releasing the connections back to the pool, so a failed run never leaves a dangling
        // open transaction (and its locks) on a pooled connection for a LATER test to hang on.
        await Promise.allSettled([bRun, clientA.query('ROLLBACK'), clientB.query('ROLLBACK')])
        clientA.release()
        clientB.release()
      }

      expect(bOutcome).toBe('blocked')
      // Both bindings are now severed; the membership MUST be deactivated — not stuck active
      // with zero bindings (the write-skew failure mode this test targets).
      expect(await membershipRow(userId, org)).toEqual({ is_active: false })
    })
  })

  describe('local-provider bind/deactivate (createLocalAccount / archiveLocalAccount)', () => {
    it('createLocalAccount binds an existing user; archiveLocalAccount deactivates their last local binding', async () => {
      const org = `${NS}_org_local`
      const userId = await seedUser('local')

      const created = await createLocalAccount({ orgId: org, localUserId: userId, name: 'Local Fixture', email: null, mobile: null, title: null })
      expect(await membershipRow(userId, org)).toEqual({ is_active: true })

      await archiveLocalAccount(org, created.id)
      expect(await membershipRow(userId, org)).toEqual({ is_active: false })
    })
  })
})
