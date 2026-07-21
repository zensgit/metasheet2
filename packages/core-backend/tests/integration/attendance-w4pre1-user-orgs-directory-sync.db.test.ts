import { afterAll, afterEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { query, transaction } from '../../src/db/pg'
import { __directorySyncInternalsForTests } from '../../src/directory/directory-sync'

/**
 * W4-PRE-1 (§3.3): the directory-sync admission write site
 * (`createDirectoryAdmittedUserInTransaction`, packages/core-backend/src/directory/
 * directory-sync.ts:4976) is the ticket's second write site. It admits users through TWO
 * callers — the auto-admission sync loop (syncDirectoryIntegration) and the manual
 * admitDirectoryAccountUser API — both of which already run inside an outer `transaction()` and
 * wrap this call in its own SAVEPOINT (DT-HARDEN-02). The org here is resolved from the
 * account's own `directory_integrations.org_id` row — never a client-supplied value, never a
 * silent 'default' guess (fail-closed if the integration row is missing).
 *
 * This file drives the shared internals directly (matching the existing
 * directory-sync-admission-orphan-guard.db.test.ts precedent) rather than the full sync loop,
 * so each scenario is isolated and fast.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const { createDirectoryAdmittedUserInTransaction } = __directorySyncInternalsForTests

const TS = Date.now()
const RUN = crypto.randomBytes(4).toString('hex')
const NS = `w4pre1dsync${TS}${RUN}`

type FixtureAccount = {
  id: string
  integration_id: string
  provider: string
  corp_id: string | null
  external_user_id: string
  union_id: string | null
  open_id: string | null
  external_key: string
  name: string
  email: string | null
  mobile: string | null
}

describeIfDatabase('W4-PRE-1 — user_orgs admission write site: directory-sync admission (real DB)', () => {
  const integrationIds: string[] = []
  let pendingUsernames: string[] = []

  async function seedIntegration(org: string, tag: string): Promise<string> {
    const id = (
      await query<{ id: string }>(
        `INSERT INTO directory_integrations (org_id, name, corp_id) VALUES ($1, $2, $3) RETURNING id::text AS id`,
        [org, `${NS}-int-${tag}`, `${NS}-corp-${tag}`],
      )
    ).rows[0].id
    integrationIds.push(id)
    return id
  }

  async function seedAccount(integrationId: string, tag: string): Promise<FixtureAccount> {
    const external = `${NS}-ext-${tag}`
    const unionId = `${NS}-union-${tag}`
    const openId = `${NS}-open-${tag}`
    const id = (
      await query<{ id: string }>(
        `INSERT INTO directory_accounts (integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key, name, is_active)
         VALUES ($1, 'dingtalk', 'corp', $2, $3, $4, $5, 'Fixture', true) RETURNING id::text AS id`,
        [integrationId, external, unionId, openId, external],
      )
    ).rows[0].id
    return {
      id,
      integration_id: integrationId,
      provider: 'dingtalk',
      corp_id: 'corp',
      external_user_id: external,
      union_id: unionId,
      open_id: openId,
      external_key: external,
      name: 'Fixture',
      email: null,
      mobile: null,
    }
  }

  function admitOptions(account: FixtureAccount, username: string) {
    return {
      account,
      adminUserId: 'system:w4pre1-test',
      name: 'Fixture',
      email: null,
      username,
      mobile: null,
      passwordHash: 'hashed',
      mustChangePassword: true,
      enableDingTalkGrant: false,
    }
  }

  afterEach(async () => {
    if (pendingUsernames.length) {
      await query(
        `DELETE FROM user_external_identities WHERE local_user_id IN (SELECT id FROM users WHERE username = ANY($1::text[]))`,
        [pendingUsernames],
      )
      await query(
        `DELETE FROM directory_account_links WHERE local_user_id IN (SELECT id FROM users WHERE username = ANY($1::text[]))`,
        [pendingUsernames],
      )
      await query(`DELETE FROM user_orgs WHERE user_id IN (SELECT id FROM users WHERE username = ANY($1::text[]))`, [
        pendingUsernames,
      ])
      await query(`DELETE FROM users WHERE username = ANY($1::text[])`, [pendingUsernames])
      pendingUsernames = []
    }
  })

  afterAll(async () => {
    if (integrationIds.length) {
      await query(`DELETE FROM directory_accounts WHERE integration_id = ANY($1::uuid[])`, [integrationIds])
      await query(`DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])`, [integrationIds])
    }
  })

  describe('fresh-DB', () => {
    it('admission resolves org from directory_integrations and writes user_orgs in the same savepoint', async () => {
      const org = `${NS}_org_fresh`
      const integrationId = await seedIntegration(org, 'fresh')
      const account = await seedAccount(integrationId, 'fresh')
      const username = `${NS}fresh`
      pendingUsernames.push(username)

      let userId = ''
      await transaction(async (client) => {
        const created = await createDirectoryAdmittedUserInTransaction(client, admitOptions(account, username))
        userId = created.userId
      })

      const row = await query<{ user_id: string; org_id: string; is_active: boolean }>(
        `SELECT user_id, org_id, is_active FROM user_orgs WHERE user_id = $1`,
        [userId],
      )
      expect(row.rows).toEqual([{ user_id: userId, org_id: org, is_active: true }])
    })

    it('atomicity: a user_orgs write failure rolls back the savepoint (no orphan users row), tx stays usable', async () => {
      const org = `${NS}_org_atomicfail`
      const integrationId = await seedIntegration(org, 'atomicfail')
      const badAccount = await seedAccount(integrationId, 'atomicfailbad')
      const badUsername = `${NS}atomicfailbad`
      pendingUsernames.push(badUsername)

      const fnName = `w4pre1_fail_user_orgs_ds_${RUN}`
      await query(`CREATE OR REPLACE FUNCTION ${fnName}() RETURNS trigger AS $fn$
        BEGIN
          RAISE EXCEPTION 'W4-PRE-1 injected directory-sync user_orgs failure' USING ERRCODE = 'P0001';
        END $fn$ LANGUAGE plpgsql`)
      await query(`CREATE TRIGGER ${fnName}_trg BEFORE INSERT ON user_orgs
        FOR EACH ROW WHEN (NEW.org_id = '${org}') EXECUTE FUNCTION ${fnName}()`)

      try {
        let threw = false
        await transaction(async (client) => {
          try {
            await createDirectoryAdmittedUserInTransaction(client, admitOptions(badAccount, badUsername))
          } catch {
            threw = true // mirrors the sync loop's own swallow-and-continue behavior
          }
          // Prove the SAVEPOINT recovered the outer transaction (DT-HARDEN-02 invariant, extended
          // to the user_orgs write): a plain statement must still succeed on the same client.
          const stillUsable = await client.query('SELECT 1 AS ok')
          expect((stillUsable.rows[0] as { ok: number }).ok).toBe(1)
        }) // ← COMMIT: with the SAVEPOINT, the rolled-back INSERT is not here to commit

        expect(threw).toBe(true)
        const usersRow = await query(`SELECT id FROM users WHERE username = $1`, [badUsername])
        expect(usersRow.rows).toEqual([])
        const orgRows = await query(`SELECT user_id FROM user_orgs WHERE org_id = $1`, [org])
        expect(orgRows.rows).toEqual([])
      } finally {
        await query(`DROP TRIGGER IF EXISTS ${fnName}_trg ON user_orgs`).catch(() => {})
        await query(`DROP FUNCTION IF EXISTS ${fnName}()`).catch(() => {})
      }
    })
  })

  describe('fail-closed org resolution', () => {
    it('an integration_id with no directory_integrations row throws before any write (never guesses an org)', async () => {
      const ghostIntegrationId = crypto.randomUUID() // deliberately never inserted
      const account: FixtureAccount = {
        id: crypto.randomUUID(),
        integration_id: ghostIntegrationId,
        provider: 'dingtalk',
        corp_id: 'corp',
        external_user_id: `${NS}-ghost`,
        union_id: `${NS}-ghost-union`,
        open_id: `${NS}-ghost-open`,
        external_key: `${NS}-ghost`,
        name: 'Ghost',
        email: null,
        mobile: null,
      }
      const username = `${NS}ghost`
      pendingUsernames.push(username)

      let caught: Error | null = null
      await transaction(async (client) => {
        try {
          await createDirectoryAdmittedUserInTransaction(client, admitOptions(account, username))
        } catch (error) {
          caught = error as Error
        }
      })

      expect(caught).not.toBeNull()
      expect((caught as unknown as Error).message).toBe('Directory integration not found for admitted account org resolution')
      const userRow = await query(`SELECT id FROM users WHERE username = $1`, [username])
      expect(userRow.rows).toEqual([])
    })
  })

  describe('two-org', () => {
    it('admissions via two different directory_integrations do not cross-count', async () => {
      const orgA = `${NS}_org_dsA`
      const orgB = `${NS}_org_dsB`
      const intA = await seedIntegration(orgA, 'dsA')
      const intB = await seedIntegration(orgB, 'dsB')
      const accountA = await seedAccount(intA, 'dsA')
      const accountB = await seedAccount(intB, 'dsB')
      const userAName = `${NS}dsa`
      const userBName = `${NS}dsb`
      pendingUsernames.push(userAName, userBName)

      let userIdA = ''
      let userIdB = ''
      await transaction(async (client) => {
        userIdA = (await createDirectoryAdmittedUserInTransaction(client, admitOptions(accountA, userAName))).userId
      })
      await transaction(async (client) => {
        userIdB = (await createDirectoryAdmittedUserInTransaction(client, admitOptions(accountB, userBName))).userId
      })

      const rowsA = await query<{ user_id: string }>(`SELECT user_id FROM user_orgs WHERE org_id = $1`, [orgA])
      expect(rowsA.rows.map((r) => r.user_id)).toEqual([userIdA])
      const rowsB = await query<{ user_id: string }>(`SELECT user_id FROM user_orgs WHERE org_id = $1`, [orgB])
      expect(rowsB.rows.map((r) => r.user_id)).toEqual([userIdB])
    })
  })
})
