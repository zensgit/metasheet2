import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { applyDirectoryDeprovisionPolicies } from '../../src/directory/directory-sync'

/**
 * DT-OPS-01 — who loses access, proved against the REAL migrated tables.
 *
 * The unit suite drove this executor through a fake client that regex-matched the SQL text
 * and returned canned rows whatever the `WHERE` said. Review demonstrated the consequence:
 * inverting the selection so it deprovisioned *every active employee* left 4354/4354 green.
 * Every clause deciding who keeps their account was shadowed by the fixture.
 *
 * So these goldens run the real SQL against real Postgres, and against the real schema
 * rather than a hand-rolled replica of it — a replica would re-introduce exactly the drift
 * being killed here. The schema is the load-bearing fact:
 *
 *   idx_directory_account_links_account  UNIQUE btree (directory_account_id)
 *   idx_directory_account_links_user            btree (local_user_id)   <-- NOT unique
 *
 * N directory accounts map to 1 local user. A rehire, or a second corp, therefore points a
 * departed account at a person who is actively employed. `UPDATE users SET is_active=FALSE`
 * is the only place in the backend that writes that column false, and nothing anywhere
 * writes it back true: a wrong deactivation is not recoverable through the product.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const uid = (name: string) => `dtdep-${name}-${TS}`

describeIfDatabase('DT-OPS-01 deprovision selection (real DB)', () => {
  let integrationA = ''
  let integrationB = ''

  const client = {
    query: (sql: string, params?: unknown[]) =>
      query(sql, params).then((r) => ({ rows: r.rows as Array<Record<string, unknown>> })),
  }

  const baseOptions = {
    integrationDefaultPolicy: 'mark_inactive',
    syncedAccountCount: 100,
    enabled: true,
  }

  /** Creates a user (if new) plus one linked directory account. Returns the account id. */
  async function seedAccount(opts: {
    integrationId?: string
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
      [opts.integrationId ?? integrationA, external, `dingtalk:${external}`, opts.accountActive, opts.override ?? null],
    )
    const accountId = account.rows[0].id
    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
       VALUES ($1::uuid, $2, 'linked')`,
      [accountId, opts.userId],
    )
    return accountId
  }

  const isUserActive = async (id: string) =>
    (await query<{ is_active: boolean }>(`SELECT is_active FROM users WHERE id = $1`, [id])).rows[0]?.is_active

  const grantEnabled = async (id: string) =>
    (await query<{ enabled: boolean }>(
      `SELECT enabled FROM user_external_auth_grants WHERE provider = 'dingtalk' AND local_user_id = $1`,
      [id],
    )).rows[0]?.enabled

  beforeAll(async () => {
    integrationA = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id::text AS id`,
      [`dtdep-a-${TS}`, `dtdep-corp-a-${TS}`],
    )).rows[0].id
    integrationB = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id::text AS id`,
      [`dtdep-b-${TS}`, `dtdep-corp-b-${TS}`],
    )).rows[0].id
  })

  // Every scenario owns its people; wipe between tests so a leaked write cannot pass the next one.
  afterEach(async () => {
    await query(`DELETE FROM user_external_auth_grants WHERE local_user_id LIKE $1`, [`dtdep-%-${TS}`])
    await query(
      `DELETE FROM directory_accounts WHERE integration_id = ANY($1::uuid[])`,
      [[integrationA, integrationB]],
    ) // links cascade
    await query(`DELETE FROM users WHERE id LIKE $1`, [`dtdep-%-${TS}`])
  })

  afterAll(async () => {
    await query(`DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])`, [[integrationA, integrationB]])
  })

  it('deactivates a departed person who has no other active binding', async () => {
    const user = uid('departed')
    const departed = await seedAccount({ userId: user, accountActive: false })

    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationId: integrationA,
      deactivatedAccountIds: [departed],
    })

    expect(outcome.abortedReason).toBeNull()
    expect(outcome.candidateCount).toBe(1)
    expect(outcome.usersDeactivatedCount).toBe(1)
    await expect(isUserActive(user)).resolves.toBe(false)
    await expect(grantEnabled(user)).resolves.toBe(false)
  })

  // P1-1. The rehire. `directory_account_links` is unique on the ACCOUNT, not the person.
  it('REFUSES to deactivate a rehired person whose new account is still active', async () => {
    const user = uid('rehired')
    const oldAccount = await seedAccount({ userId: user, accountActive: false })
    await seedAccount({ userId: user, accountActive: true }) // the new badge, same person

    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationId: integrationA,
      deactivatedAccountIds: [oldAccount],
    })

    expect(outcome.candidateCount).toBe(0)
    expect(outcome.usersDeactivatedCount).toBe(0)
    await expect(isUserActive(user)).resolves.toBe(true)
    await expect(grantEnabled(user)).resolves.toBeUndefined()
  })

  // P1-1, second face: the sibling guard must see across integrations, or a person employed
  // by corp B is deactivated because corp A's directory dropped them.
  it('REFUSES to deactivate a person still active in ANOTHER integration', async () => {
    const user = uid('twocorps')
    const departedFromA = await seedAccount({ integrationId: integrationA, userId: user, accountActive: false })
    await seedAccount({ integrationId: integrationB, userId: user, accountActive: true })

    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationId: integrationA,
      deactivatedAccountIds: [departedFromA],
    })

    expect(outcome.candidateCount).toBe(0)
    await expect(isUserActive(user)).resolves.toBe(true)
  })

  // P2-1. Candidates are this run's transitions, never the lifetime backlog of inactive rows.
  it('ignores the backlog: an account deactivated by an earlier run is not re-processed', async () => {
    const backlogUser = uid('backlog')
    const freshUser = uid('thisrun')
    await seedAccount({ userId: backlogUser, accountActive: false }) // inactive since some past run
    const transitioned = await seedAccount({ userId: freshUser, accountActive: false })

    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationId: integrationA,
      deactivatedAccountIds: [transitioned], // the sweep only RETURNs what it flipped
    })

    expect(outcome.candidateCount).toBe(1)
    expect(outcome.affected.map((a) => a.localUserId)).toEqual([freshUser])
    await expect(isUserActive(backlogUser)).resolves.toBe(true)
    await expect(isUserActive(freshUser)).resolves.toBe(false)
  })

  it('decides once per person, and the least destructive policy wins', async () => {
    const user = uid('twoaccts')
    const harsh = await seedAccount({ userId: user, accountActive: false, override: 'mark_inactive' })
    const gentle = await seedAccount({ userId: user, accountActive: false, override: 'manual_review' })

    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationId: integrationA,
      deactivatedAccountIds: [harsh, gentle],
    })

    expect(outcome.candidateCount).toBe(1) // one person, not two accounts
    expect(outcome.manualReviewCount).toBe(1)
    expect(outcome.usersDeactivatedCount).toBe(0)
    await expect(isUserActive(user)).resolves.toBe(true)
  })

  // P1-2. A fetch that returned nobody is a broken fetch, not an evacuated company.
  it('ABORTS, touching nobody, when the directory fetch returned zero accounts', async () => {
    const user = uid('wouldie')
    const departed = await seedAccount({ userId: user, accountActive: false })

    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationId: integrationA,
      deactivatedAccountIds: [departed],
      syncedAccountCount: 0,
    })

    expect(outcome.abortedReason).toBe('empty_directory_fetch')
    expect(outcome.applied).toBe(false)
    expect(outcome.usersDeactivatedCount).toBe(0)
    await expect(isUserActive(user)).resolves.toBe(true)
    await expect(grantEnabled(user)).resolves.toBeUndefined()
  })

  // P1-2. A mass departure is a narrowed contact scope far more often than a layoff.
  it('ABORTS when the batch exceeds the maximum, deactivating nobody', async () => {
    const users = [uid('mass1'), uid('mass2'), uid('mass3')]
    const ids: string[] = []
    for (const u of users) ids.push(await seedAccount({ userId: u, accountActive: false }))

    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationId: integrationA,
      deactivatedAccountIds: ids,
      maxBatch: 2,
    })

    expect(outcome.abortedReason).toBe('batch_exceeds_max')
    expect(outcome.applied).toBe(false)
    for (const u of users) await expect(isUserActive(u)).resolves.toBe(true)
  })

  it('default-off reports what it would do and writes nothing', async () => {
    const user = uid('preview')
    const departed = await seedAccount({ userId: user, accountActive: false })

    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationId: integrationA,
      deactivatedAccountIds: [departed],
      enabled: false,
    })

    expect(outcome.candidateCount).toBe(1)
    expect(outcome.usersDeactivatedCount).toBe(1) // it *would* have
    await expect(isUserActive(user)).resolves.toBe(true) // …and did not
    await expect(grantEnabled(user)).resolves.toBeUndefined()
  })

  it('disable_grant_only revokes DingTalk login and leaves the local account alive', async () => {
    const user = uid('grantonly')
    const departed = await seedAccount({ userId: user, accountActive: false })

    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationId: integrationA,
      integrationDefaultPolicy: 'disable_grant_only',
      deactivatedAccountIds: [departed],
    })

    expect(outcome.usersDeactivatedCount).toBe(0)
    expect(outcome.grantsDisabledCount).toBe(1)
    await expect(isUserActive(user)).resolves.toBe(true)
    await expect(grantEnabled(user)).resolves.toBe(false)
  })

  it('leaves an unlinked departed account alone: there is no person to deprovision', async () => {
    const account = (await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active)
       VALUES ($1, $2, $3, 'Unlinked', false) RETURNING id::text AS id`,
      [integrationA, `dtdep-unlinked-${TS}`, `dingtalk:dtdep-unlinked-${TS}`],
    )).rows[0].id

    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      ...baseOptions,
      integrationId: integrationA,
      deactivatedAccountIds: [account],
    })

    expect(outcome.candidateCount).toBe(0)
    expect(outcome.affected).toEqual([])
  })
})
