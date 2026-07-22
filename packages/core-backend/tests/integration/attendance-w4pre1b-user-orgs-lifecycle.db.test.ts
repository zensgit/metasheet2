import { afterAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { query } from '../../src/db/pg'
import { bindDirectoryAccount, unbindDirectoryAccount } from '../../src/directory/directory-sync'
import { createLocalAccount, archiveLocalAccount } from '../../src/directory/local-directory-org'

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
         VALUES ($1, 'dingtalk', 'corp', $2, $3, $4, $5, 'Fixture', true) RETURNING id::text AS id`,
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
