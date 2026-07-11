import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { query, transaction } from '../../src/db/pg'
import { __directorySyncInternalsForTests } from '../../src/directory/directory-sync'

/**
 * DT-HARDEN-02 — orphan prevention proved against REAL Postgres.
 *
 * The unit guard (directory-sync-admission-orphan-guard.test.ts) drives a fake client that only
 * records SQL, so it can prove "throws before INSERT" for the grant-feasibility case but CANNOT
 * prove that a bind throw AFTER the INSERT is actually rolled back — a fake client does not
 * execute a SAVEPOINT/ROLLBACK.
 *
 * Adversarial review found exactly that gap: the pre-INSERT grant assertion covers only one
 * throw point. `applyDirectoryAccountBindInTransaction` (called after `INSERT INTO users`) still
 * throws when the account has NO openId AND NO unionId at all — even with the grant withheld —
 * and when its identity is already bound to another local user. The sync loop swallows the throw,
 * and without the SAVEPOINT the outer transaction commits an active orphan `users` row.
 *
 * These tests run the real admission inside a real transaction, swallow the throw the way the
 * sync loop does, COMMIT, and assert no orphan persisted — and that the transaction stayed usable
 * so the loop can admit the next account.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const { createDirectoryAdmittedUserInTransaction } = __directorySyncInternalsForTests

const TS = Date.now()

describeIfDatabase('DT-HARDEN-02 auto-admission orphan guard (real DB)', () => {
  let integrationId = ''

  const baseOptions = {
    adminUserId: 'system:test',
    passwordHash: 'hashed',
    mustChangePassword: true,
  }

  /** Seed a real directory_accounts row (the link INSERT has an FK to it) and return the account object. */
  async function seedAccount(opts: { openId: string | null; unionId: string | null; tag: string }) {
    const external = `oa-${opts.tag}-${TS}`
    const externalKey = opts.unionId || opts.openId || external
    const id = (await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key, name, is_active)
       VALUES ($1, 'dingtalk', 'corpA', $2, $3, $4, $5, 'Fixture', true) RETURNING id::text AS id`,
      [integrationId, external, opts.unionId, opts.openId, externalKey],
    )).rows[0].id
    return {
      id,
      integration_id: integrationId,
      provider: 'dingtalk',
      corp_id: 'corpA',
      external_user_id: external,
      union_id: opts.unionId,
      open_id: opts.openId,
      external_key: externalKey,
      name: 'Fixture',
      email: null as string | null,
      mobile: null as string | null,
    }
  }

  const admitOptions = (account: Awaited<ReturnType<typeof seedAccount>>, username: string, enableDingTalkGrant: boolean) => ({
    ...baseOptions,
    account,
    name: 'Fixture',
    email: null,
    username,
    mobile: null,
    enableDingTalkGrant,
  })

  const userCountByUsername = async (username: string) =>
    (await query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE username = $1`, [username])).rows[0].n

  beforeAll(async () => {
    integrationId = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id::text AS id`,
      [`orphan-guard-${TS}`, `orphan-corp-${TS}`],
    )).rows[0].id
  })

  afterEach(async () => {
    // Each test owns its usernames; clean any admitted/orphaned rows between tests.
    await query(`DELETE FROM user_external_identities WHERE local_user_id IN (SELECT id FROM users WHERE username LIKE $1)`, [`ogd-%-${TS}`])
    await query(`DELETE FROM directory_account_links WHERE local_user_id IN (SELECT id FROM users WHERE username LIKE $1)`, [`ogd-%-${TS}`])
    await query(`DELETE FROM users WHERE username LIKE $1`, [`ogd-%-${TS}`])
  })

  afterAll(async () => {
    if (!integrationId) return
    await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
    await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
  })

  // Scenario B (the review's real-PG finding): no openId AND no unionId → the bind throws AFTER
  // the users INSERT, even with the grant withheld. The SAVEPOINT must roll the INSERT back.
  it('commits NO orphan when a no-openId/no-unionId account throws in bind (grant withheld)', async () => {
    const account = await seedAccount({ openId: null, unionId: null, tag: 'b' })
    const username = `ogd-scenarioB-${TS}`
    let threw = false

    await transaction(async (client) => {
      try {
        await createDirectoryAdmittedUserInTransaction(client, admitOptions(account, username, false))
      } catch {
        threw = true // the sync loop swallows and moves on
      }
    }) // ← COMMIT: with the SAVEPOINT, the rolled-back INSERT is not here to commit

    expect(threw).toBe(true)
    await expect(userCountByUsername(username)).resolves.toBe(0)
  })

  // The savepoint must also leave the transaction usable, so the loop can admit the next account
  // after one fails — otherwise a single bad account would poison the whole run.
  it('keeps the transaction usable: a valid account admits after a failed one in the same tx', async () => {
    const bad = await seedAccount({ openId: null, unionId: null, tag: 'bad' })
    const good = await seedAccount({ openId: `open-good-${TS}`, unionId: null, tag: 'good' })
    const badName = `ogd-bad-${TS}`
    const goodName = `ogd-good-${TS}`

    await transaction(async (client) => {
      try {
        await createDirectoryAdmittedUserInTransaction(client, admitOptions(bad, badName, false))
      } catch { /* swallowed, as the sync loop does */ }
      await createDirectoryAdmittedUserInTransaction(client, admitOptions(good, goodName, false))
    })

    await expect(userCountByUsername(badName)).resolves.toBe(0) // no orphan
    await expect(userCountByUsername(goodName)).resolves.toBe(1) // the run continued
    // …and the good account is fully bound.
    const linked = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM directory_account_links WHERE directory_account_id = $1::uuid AND link_status = 'linked'`,
      [good.id],
    )
    expect(linked.rows[0].n).toBe(1)
  })

  // Second orphan vector: the account's identity is already bound to a DIFFERENT local user, so
  // the bind's conflict check throws after the INSERT.
  it('commits NO orphan when the identity is already bound to another local user', async () => {
    const openId = `open-shared-${TS}`
    const account = await seedAccount({ openId, unionId: null, tag: 'conflict' })

    // Pre-existing user who already owns this DingTalk identity.
    const otherUser = `ogd-owner-${TS}`
    await query(`INSERT INTO users (id, username, name, password_hash, is_active) VALUES ($1, $1, 'Owner', 'x', true)`, [otherUser])
    await query(
      `INSERT INTO user_external_identities (provider, external_key, provider_open_id, corp_id, local_user_id, profile)
       VALUES ('dingtalk', $1, $2, 'corpA', $3, '{}'::jsonb)`,
      [openId, openId, otherUser],
    )

    const username = `ogd-conflict-${TS}`
    let threw = false
    await transaction(async (client) => {
      try {
        await createDirectoryAdmittedUserInTransaction(client, admitOptions(account, username, false))
      } catch {
        threw = true
      }
    })

    expect(threw).toBe(true)
    await expect(userCountByUsername(username)).resolves.toBe(0) // no orphan created

    await query(`DELETE FROM user_external_identities WHERE local_user_id = $1`, [otherUser])
    await query(`DELETE FROM users WHERE id = $1`, [otherUser])
  })

  // Control: a well-formed account is admitted and fully bound.
  it('admits and binds a valid account (control)', async () => {
    const account = await seedAccount({ openId: `open-ok-${TS}`, unionId: null, tag: 'ok' })
    const username = `ogd-ok-${TS}`

    await transaction(async (client) => {
      await createDirectoryAdmittedUserInTransaction(client, admitOptions(account, username, false))
    })

    await expect(userCountByUsername(username)).resolves.toBe(1)
    const identity = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM user_external_identities i
         JOIN users u ON u.id = i.local_user_id
        WHERE u.username = $1 AND i.corp_id = 'corpA'`,
      [username],
    )
    expect(identity.rows[0].n).toBe(1) // login identity pre-seeded at bind
  })
})
