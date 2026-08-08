import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { query } from '../../src/db/pg'
import { activatePendingUser } from '../../src/auth/user-activate'
import { supersedeDeprovisionEvidenceForAccessGraphWrite } from '../../src/directory/access-graph-mutex'
import { restoreDeprovisionEvent } from '../../src/directory/deprovision-evidence-api'

/**
 * The DingTalk grant lives in `user_external_auth_grants`; `user_orgs` is
 * (user_id, org_id, is_active, created_at). Three merged paths wrote neither shape —
 * `user_external_identities.grant_enabled` (a column no migration creates) and a
 * `user_orgs.updated_at` that does not exist — each behind `.catch(() => {})`.
 *
 * Every one of those failures was invisible in unit tests, because a stub client answers any SQL
 * you hand it. They are only observable against real Postgres, and only because of what a
 * swallowed error does INSIDE a transaction: the failed statement poisons the connection, so the
 * next innocent statement dies with `25P02` and the whole restore rolls back. The admin is shown
 * an opaque error, or — worse, on the read path — a drift gate that was satisfied by its own
 * query failing, and therefore could never fire.
 *
 * These tests assert the observable end state (is the person actually granted / actually a member
 * again), never the SQL text, so they keep their meaning if the statements are rewritten.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const ORG = 'org-grant-fix-test'
const USER = 'u-grant-fix-test'
const USER_A = 'u-grant-fix-owner'
const USER_B = 'u-grant-fix-pending'

async function cleanup() {
  // Fail-honest: schema/env breakage must red the suite, not be swallowed.
  for (const uid of [USER, USER_A, USER_B]) {
    await query(`DELETE FROM directory_deprovision_effects WHERE local_user_id = $1`, [uid])
    await query(`DELETE FROM directory_deprovision_events WHERE local_user_id = $1`, [uid])
    await query(`DELETE FROM directory_account_links WHERE local_user_id = $1`, [uid])
    await query(`DELETE FROM user_external_auth_grants WHERE local_user_id = $1`, [uid])
    await query(`DELETE FROM user_login_aliases WHERE user_id = $1`, [uid])
    await query(`DELETE FROM user_orgs WHERE user_id = $1`, [uid])
    await query(`DELETE FROM users WHERE id = $1`, [uid])
  }
  await query(`DELETE FROM directory_sync_runs WHERE integration_id IN
                 (SELECT id FROM directory_integrations WHERE org_id = $1)`, [ORG])
  await query(`DELETE FROM directory_accounts WHERE integration_id IN
                 (SELECT id FROM directory_integrations WHERE org_id = $1)`, [ORG])
  await query(`DELETE FROM directory_integrations WHERE org_id = $1`, [ORG])
}

async function seedDirectory(opts: { sourceActive: boolean }) {
  const integ = await query<{ id: string }>(
    `INSERT INTO directory_integrations (name, corp_id, org_id, status, default_deprovision_policy)
     VALUES ('grant-fix-test', $1, $2, 'active', 'mark_inactive')
     RETURNING id::text AS id`,
    [`corp-${ORG}`, ORG],
  )
  const integrationId = integ.rows[0].id
  const acct = await query<{ id: string }>(
    `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, is_active)
     VALUES ($1::uuid, 'dingtalk', 'ext-grant-fix', 'dingtalk:grant-fix:ext', 'Grant Fix', $2)
     RETURNING id::text AS id`,
    [integrationId, opts.sourceActive],
  )
  const accountId = acct.rows[0].id
  await query(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
     VALUES ($1::uuid, $2, 'linked')`,
    [accountId, USER],
  )
  const run = await query<{ id: string }>(
    `INSERT INTO directory_sync_runs (integration_id, status, triggered_by)
     VALUES ($1::uuid, 'success', 'test') RETURNING id::text AS id`,
    [integrationId],
  )
  return { integrationId, accountId, runId: run.rows[0].id }
}

async function seedActivationSource(options: {
  linkedUserId?: string
  linkStatus?: string
  accountActive?: boolean
  accountProvider?: string
  integrationProvider?: string
  accountCorpId?: string
  integrationCorpId?: string
  integrationStatus?: string
}) {
  const integrationCorpId = options.integrationCorpId ?? `corp-${ORG}`
  const integration = await query<{ id: string }>(
    `INSERT INTO directory_integrations
       (name, corp_id, org_id, provider, status, default_deprovision_policy)
     VALUES ('activation-source-test', $1, $2, $3, $4, 'manual_review')
     RETURNING id::text AS id`,
    [
      integrationCorpId,
      ORG,
      options.integrationProvider ?? 'dingtalk',
      options.integrationStatus ?? 'active',
    ],
  )
  const account = await query<{ id: string }>(
    `INSERT INTO directory_accounts
       (integration_id, provider, corp_id, external_user_id, external_key, name, is_active)
     VALUES ($1::uuid, $2, $3, 'ext-activation-source',
             'dingtalk:activation-source:ext', 'Activation Source', $4)
     RETURNING id::text AS id`,
    [
      integration.rows[0].id,
      options.accountProvider ?? 'dingtalk',
      options.accountCorpId ?? integrationCorpId,
      options.accountActive ?? true,
    ],
  )
  if (options.linkedUserId !== undefined) {
    await query(
      `INSERT INTO directory_account_links
         (directory_account_id, local_user_id, link_status)
       VALUES ($1::uuid, $2, $3)`,
      [account.rows[0].id, options.linkedUserId, options.linkStatus ?? 'linked'],
    )
  }
  return {
    integrationId: integration.rows[0].id,
    accountId: account.rows[0].id,
  }
}

async function seedEvent(
  seeded: { integrationId: string; accountId: string; runId: string },
  effects: Array<{ type: string; orgId: string | null }>,
  generation: number,
) {
  const ev = await query<{ id: string }>(
    `INSERT INTO directory_deprovision_events
       (org_id, integration_id, directory_account_id, local_user_id, run_id, triggered_by,
        event_origin, link_witness_account_id, link_witness_local_user_id,
        policy, globally_clear, access_generation_at_apply, status)
     VALUES ($1, $2, $3, $4, $5, 'test', 'sync', $3, $4,
             'mark_inactive', TRUE, $6, 'applied')
     RETURNING id::text AS id`,
    [ORG, seeded.integrationId, seeded.accountId, USER, seeded.runId, generation],
  )
  for (const effect of effects) {
    await query(
      `INSERT INTO directory_deprovision_effects
         (event_id, local_user_id, org_id, effect_type, before_active, after_active,
          access_generation_at_apply, status)
       VALUES ($1::uuid, $2, $3, $4, TRUE, FALSE, $5, 'applied')`,
      [ev.rows[0].id, USER, effect.orgId, effect.type, generation],
    )
  }
  return ev.rows[0].id
}

const grantRow = async (): Promise<{ enabled: boolean; granted_by: string | null } | undefined> => (
  await query<{ enabled: boolean; granted_by: string | null }>(
    `SELECT enabled, granted_by FROM user_external_auth_grants
      WHERE local_user_id = $1 AND provider = 'dingtalk'`,
    [USER],
  )
).rows[0]

const grantEnabled = async (): Promise<boolean | undefined> => (await grantRow())?.enabled

async function waitForRestoreWaiters(
  holderPid: number,
  expected: number,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const waiting = await query<{ blocked: number; rooted: number }>(
      `SELECT
         count(*) FILTER (
           WHERE wait_event_type = 'Lock'
             AND query ILIKE '%activation_status%'
             AND query ILIKE '%FROM users%'
             AND query ILIKE '%FOR UPDATE%'
         )::int AS blocked,
         count(*) FILTER (
           WHERE $1 = ANY(pg_blocking_pids(pid))
             AND query ILIKE '%activation_status%'
             AND query ILIKE '%FROM users%'
             AND query ILIKE '%FOR UPDATE%'
         )::int AS rooted
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND state = 'active'
         AND pid <> pg_backend_pid()`,
      [holderPid],
    )
    if (
      (waiting.rows[0]?.blocked ?? 0) >= expected
      && (waiting.rows[0]?.rooted ?? 0) >= 1
    ) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(
    `timed out waiting for ${expected} restore transaction(s) queued behind holder ${holderPid}`,
  )
}

async function waitForQueryBlockedOnHolder(
  holderPid: number,
  queryPattern: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const waiting = await query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND $1 = ANY(pg_blocking_pids(pid))
          AND query ILIKE $2`,
      [holderPid, queryPattern],
    )
    if ((waiting.rows[0]?.n ?? 0) >= 1) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(
    `timed out waiting for query ${queryPattern} blocked by holder ${holderPid}`,
  )
}

async function withLockedUser<T>(
  callback: (holder: Client, holderPid: number) => Promise<T>,
): Promise<T> {
  const holder = new Client({ connectionString: process.env.DATABASE_URL })
  await holder.connect()
  try {
    await holder.query('BEGIN')
    const pid = await holder.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    )
    await holder.query(
      `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
      [USER],
    )
    return await callback(holder, pid.rows[0].pid)
  } finally {
    try {
      await holder.query('ROLLBACK')
    } catch {
      // The callback may already have committed the holder.
    }
    await holder.end()
  }
}

describeIfDatabase('DingTalk grant/membership writes target the real tables (real DB)', () => {
  beforeEach(cleanup)
  afterAll(cleanup)

  it('T3 activate with enableDingTalkGrant actually grants DingTalk login and claims alias', async () => {
    await query(
      `INSERT INTO users (id, email, name, password_hash, is_active, activation_status, local_password_set)
       VALUES ($1, 'grant-fix@example.com', 'Grant Fix', 'x', FALSE, 'pending_activation', FALSE)`,
      [USER],
    )

    // Positive control: nothing has granted anything yet.
    expect(await grantEnabled()).toBeUndefined()

    // Production path: no claimAliases opt-out — must claim email inside the same txn.
    await activatePendingUser({
      userId: USER,
      mode: 'admin_no_password',
      adminUserId: 'admin-test',
      orgId: ORG,
      enableDingTalkGrant: true,
    })

    // The observable claim: the person can now be admitted by the OAuth path, which reads
    // `user_external_auth_grants`. Before the fix this was `undefined` — activation reported
    // success and granted nothing.
    expect(await grantEnabled()).toBe(true)
    const aliases = await query<{ normalized_value: string }>(
      `SELECT normalized_value FROM user_login_aliases WHERE user_id = $1`,
      [USER],
    )
    expect(aliases.rows.map((r) => r.normalized_value)).toContain('grant-fix@example.com')
  })

  it('T3 SSO activate commits only with an active exact DingTalk source link', async () => {
    await query(
      `INSERT INTO users
         (id, username, name, password_hash, is_active, activation_status, local_password_set)
       VALUES ($1, 'sso-source-user', 'SSO Source', 'x', FALSE, 'pending_activation', FALSE)`,
      [USER],
    )
    const source = await seedActivationSource({ linkedUserId: USER })

    await activatePendingUser({
      userId: USER,
      mode: 'sso',
      adminUserId: 'admin-test',
      orgId: ORG,
      enableDingTalkGrant: true,
      directoryAccountId: source.accountId,
    })

    const committed = await query<{
      activation_status: string
      is_active: boolean
      membership_active: boolean | null
      grant_enabled: boolean | null
    }>(
      `SELECT u.activation_status,
              u.is_active,
              membership.is_active AS membership_active,
              auth_grant.enabled AS grant_enabled
         FROM users u
         LEFT JOIN user_orgs membership
           ON membership.user_id = u.id AND membership.org_id = $2
         LEFT JOIN user_external_auth_grants auth_grant
           ON auth_grant.local_user_id = u.id AND auth_grant.provider = 'dingtalk'
        WHERE u.id = $1`,
      [USER, ORG],
    )
    expect(committed.rows[0]).toMatchObject({
      activation_status: 'activated',
      is_active: true,
      membership_active: true,
      grant_enabled: true,
    })
  })

  it('T3 SSO rejects an account with no linked witness and leaves zero activation residue', async () => {
    await query(
      `INSERT INTO users
         (id, username, name, password_hash, is_active, activation_status, local_password_set)
       VALUES ($1, 'missing-source-user', 'Missing Source', 'x', FALSE, 'pending_activation', FALSE)`,
      [USER],
    )
    const source = await seedActivationSource({})

    await expect(
      activatePendingUser({
        userId: USER,
        mode: 'sso',
        adminUserId: 'admin-test',
        orgId: ORG,
        enableDingTalkGrant: true,
        directoryAccountId: source.accountId,
      }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_SOURCE_MISSING' })

    const residue = await query<{
      activation_status: string
      is_active: boolean
      memberships: number
      grants: number
      aliases: number
    }>(
      `SELECT u.activation_status,
              u.is_active,
              (SELECT count(*)::int FROM user_orgs WHERE user_id = u.id) AS memberships,
              (SELECT count(*)::int FROM user_external_auth_grants WHERE local_user_id = u.id) AS grants,
              (SELECT count(*)::int FROM user_login_aliases WHERE user_id = u.id) AS aliases
         FROM users u
        WHERE u.id = $1`,
      [USER],
    )
    expect(residue.rows[0]).toMatchObject({
      activation_status: 'pending_activation',
      is_active: false,
      memberships: 0,
      grants: 0,
      aliases: 0,
    })
  })

  it('T3 SSO requires link_status=linked even when local_user_id matches', async () => {
    await query(
      `INSERT INTO users
         (id, username, name, password_hash, is_active, activation_status, local_password_set)
       VALUES ($1, 'unlinked-source-user', 'Unlinked Source', 'x', FALSE, 'pending_activation', FALSE)`,
      [USER],
    )
    const source = await seedActivationSource({
      linkedUserId: USER,
      linkStatus: 'unlinked',
    })

    await expect(
      activatePendingUser({
        userId: USER,
        mode: 'sso',
        adminUserId: 'admin-test',
        directoryAccountId: source.accountId,
      }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_SOURCE_MISSING' })

    const target = await query<{ activation_status: string; is_active: boolean }>(
      `SELECT activation_status, is_active FROM users WHERE id = $1`,
      [USER],
    )
    expect(target.rows[0]).toEqual({
      activation_status: 'pending_activation',
      is_active: false,
    })
  })

  it('T3 SSO rejects a linked account that belongs to another user', async () => {
    await query(
      `INSERT INTO users
         (id, username, name, password_hash, is_active, activation_status, local_password_set)
       VALUES
         ($1, 'source-owner', 'Source Owner', 'x', TRUE, 'activated', TRUE),
         ($2, 'source-target', 'Source Target', 'x', FALSE, 'pending_activation', FALSE)`,
      [USER_A, USER_B],
    )
    const source = await seedActivationSource({ linkedUserId: USER_A })

    await expect(
      activatePendingUser({
        userId: USER_B,
        mode: 'sso',
        adminUserId: 'admin-test',
        directoryAccountId: source.accountId,
      }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_LINK_MISMATCH' })

    const target = await query<{ activation_status: string; is_active: boolean }>(
      `SELECT activation_status, is_active FROM users WHERE id = $1`,
      [USER_B],
    )
    expect(target.rows[0]).toEqual({
      activation_status: 'pending_activation',
      is_active: false,
    })
  })

  it('T3 SSO rejects provider/corp-ineligible source rows without activating', async () => {
    await query(
      `INSERT INTO users
         (id, username, name, password_hash, is_active, activation_status, local_password_set)
       VALUES ($1, 'ineligible-source', 'Ineligible Source', 'x', FALSE, 'pending_activation', FALSE)`,
      [USER],
    )
    const source = await seedActivationSource({
      linkedUserId: USER,
      accountCorpId: `other-corp-${ORG}`,
    })

    await expect(
      activatePendingUser({
        userId: USER,
        mode: 'sso',
        adminUserId: 'admin-test',
        directoryAccountId: source.accountId,
      }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_SOURCE_INELIGIBLE' })

    const target = await query<{ activation_status: string; is_active: boolean }>(
      `SELECT activation_status, is_active FROM users WHERE id = $1`,
      [USER],
    )
    expect(target.rows[0]).toEqual({
      activation_status: 'pending_activation',
      is_active: false,
    })
  })

  it('restoring a membership effect actually re-activates the membership', async () => {
    await query(
      `INSERT INTO users (id, email, name, password_hash, is_active, activation_status, access_generation)
       VALUES ($1, 'grant-fix@example.com', 'Grant Fix', 'x', TRUE, 'activated', 3)`,
      [USER],
    )
    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, FALSE)`, [USER, ORG])
    const seeded = await seedDirectory({ sourceActive: true })
    const eventId = await seedEvent(seeded, [{ type: 'membership_changed', orgId: ORG }], 3)

    const result = await restoreDeprovisionEvent({
      eventId, mode: 'rehire', adminUserId: 'admin-test',
    })
    expect(result.restoredEffectCount).toBe(1)
    expect(result).toMatchObject({
      restoreMode: 'rehire',
      effectsReversed: ['membership_changed'],
      passwordUnchanged: true,
      localUser: {
        id: USER,
        isActive: true,
        activationStatus: 'activated',
      },
    })

    // Before the fix this whole call aborted with 25P02 (`user_orgs.updated_at` does not exist),
    // so the membership stayed FALSE — for EVERY real deprovision event, since every candidate
    // carries a membership effect.
    const membership = await query<{ is_active: boolean }>(
      `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`, [USER, ORG])
    expect(membership.rows[0]?.is_active).toBe(true)

    const effects = await query<{ status: string }>(
      `SELECT status FROM directory_deprovision_effects WHERE local_user_id = $1`, [USER])
    expect(effects.rows.map((r) => r.status)).toEqual(['reversed'])
  })

  it('restoring a grant effect actually re-enables the grant', async () => {
    await query(
      `INSERT INTO users (id, email, name, password_hash, is_active, activation_status, access_generation)
       VALUES ($1, 'grant-fix@example.com', 'Grant Fix', 'x', TRUE, 'activated', 3)`,
      [USER],
    )
    // Deprovision left a disabled grant row behind, which is what the writer's upsert produces.
    await query(
      `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by)
       VALUES ('dingtalk', $1, FALSE, 'system:directory-deprovision')`, [USER])
    const seeded = await seedDirectory({ sourceActive: true })
    const eventId = await seedEvent(seeded, [{ type: 'grant_changed', orgId: null }], 3)

    await restoreDeprovisionEvent({ eventId, mode: 'rehire', adminUserId: 'admin-test' })

    expect(await grantEnabled()).toBe(true)
    // P2 pin: provenance must be restore:<admin>, not the old deprovision actor
    expect((await grantRow())?.granted_by).toBe('restore:admin-test')
  })

  it('membership row missing fails restore with DRIFT_CONFLICT (not false success)', async () => {
    await query(
      `INSERT INTO users (id, email, name, password_hash, is_active, activation_status, access_generation)
       VALUES ($1, 'grant-fix@example.com', 'Grant Fix', 'x', TRUE, 'activated', 3)`,
      [USER],
    )
    // Deliberately NO user_orgs row — effect says membership was cleared, but the row is gone.
    const seeded = await seedDirectory({ sourceActive: true })
    const eventId = await seedEvent(seeded, [{ type: 'membership_changed', orgId: ORG }], 3)

    await expect(
      restoreDeprovisionEvent({ eventId, mode: 'rehire', adminUserId: 'admin-test' }),
    ).rejects.toMatchObject({ code: 'DRIFT_CONFLICT' })

    const effects = await query<{ status: string }>(
      `SELECT status FROM directory_deprovision_effects WHERE local_user_id = $1`, [USER])
    expect(effects.rows.map((r) => r.status)).toEqual(['applied'])
  })

  it('a grant that is still enabled is real drift, and the gate refuses the restore', async () => {
    await query(
      `INSERT INTO users (id, email, name, password_hash, is_active, activation_status, access_generation)
       VALUES ($1, 'grant-fix@example.com', 'Grant Fix', 'x', TRUE, 'activated', 3)`,
      [USER],
    )
    // The event says the grant was revoked (after_active=false); reality says it is ON. That is
    // exactly the drift DRIFT_CONFLICT exists for. The pre-fix read could not see it: its query
    // errored, the `.catch` reported "no grant", and "no grant" matched after_active=false — the
    // gate was satisfied BY ITS OWN FAILURE and let the restore through.
    await query(
      `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by)
       VALUES ('dingtalk', $1, TRUE, 'someone-re-granted-it')`, [USER])
    const seeded = await seedDirectory({ sourceActive: true })
    const eventId = await seedEvent(seeded, [{ type: 'grant_changed', orgId: null }], 3)

    await expect(
      restoreDeprovisionEvent({ eventId, mode: 'rehire', adminUserId: 'admin-test' }),
    ).rejects.toMatchObject({ code: 'DRIFT_CONFLICT' })

    // And the refusal must be inert: the grant is left exactly as the other writer set it.
    expect(await grantEnabled()).toBe(true)
    const effects = await query<{ status: string }>(
      `SELECT status FROM directory_deprovision_effects WHERE local_user_id = $1`, [USER])
    expect(effects.rows.map((r) => r.status)).toEqual(['applied'])
  })

  it('a grant writer racing after eligibility is preserved by the write-point drift guard', async () => {
    await query(
      `INSERT INTO users (id, email, name, password_hash, is_active, activation_status, access_generation)
       VALUES ($1, 'grant-fix@example.com', 'Grant Fix', 'x', TRUE, 'activated', 3)`,
      [USER],
    )
    await query(
      `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by)
       VALUES ('dingtalk', $1, FALSE, 'system:directory-deprovision')`,
      [USER],
    )
    const seeded = await seedDirectory({ sourceActive: true })
    const eventId = await seedEvent(
      seeded,
      [{ type: 'grant_changed', orgId: null }],
      3,
    )
    const holder = new Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    try {
      await holder.query('BEGIN')
      const pid = await holder.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      )
      await holder.query(
        `UPDATE user_external_auth_grants
            SET enabled = TRUE, granted_by = 'concurrent-writer'
          WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [USER],
      )

      const restore = restoreDeprovisionEvent({
        eventId,
        mode: 'rehire',
        adminUserId: 'admin-test',
      })
      await waitForQueryBlockedOnHolder(
        pid.rows[0].pid,
        '%INSERT INTO user_external_auth_grants%',
      )
      await holder.query('COMMIT')

      await expect(restore).rejects.toMatchObject({ code: 'DRIFT_CONFLICT' })
    } finally {
      try {
        await holder.query('ROLLBACK')
      } catch {
        // The holder may already be committed.
      }
      await holder.end()
    }

    expect(await grantRow()).toMatchObject({
      enabled: true,
      granted_by: 'concurrent-writer',
    })
    const state = await query<{
      access_generation: string
      effect_status: string
      event_status: string
    }>(
      `SELECT users.access_generation::text,
              event.status AS event_status,
              effect.status AS effect_status
         FROM users
         JOIN directory_deprovision_events event
           ON event.local_user_id = users.id
         JOIN directory_deprovision_effects effect
           ON effect.event_id = event.id
        WHERE users.id = $1`,
      [USER],
    )
    expect(state.rows[0]).toMatchObject({
      access_generation: '3',
      event_status: 'applied',
      effect_status: 'applied',
    })
  })

  it('rehire requires the exact source account to remain actively linked to the same user', async () => {
    await query(
      `INSERT INTO users (id, email, name, password_hash, is_active, activation_status, access_generation)
       VALUES ($1, 'grant-fix@example.com', 'Grant Fix', 'x', TRUE, 'activated', 3)`,
      [USER],
    )
    await query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, FALSE)`,
      [USER, ORG],
    )
    const seeded = await seedDirectory({ sourceActive: true })
    const eventId = await seedEvent(
      seeded,
      [{ type: 'membership_changed', orgId: ORG }],
      3,
    )
    await query(
      `UPDATE directory_account_links
          SET link_status = 'unlinked'
        WHERE directory_account_id = $1::uuid
          AND local_user_id = $2`,
      [seeded.accountId, USER],
    )

    await expect(
      restoreDeprovisionEvent({
        eventId,
        mode: 'rehire',
        adminUserId: 'admin-test',
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_INACTIVE' })

    const membership = await query<{ is_active: boolean }>(
      `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
      [USER, ORG],
    )
    expect(membership.rows[0]?.is_active).toBe(false)
    const event = await query<{ status: string }>(
      `SELECT status FROM directory_deprovision_events WHERE id = $1::uuid`,
      [eventId],
    )
    expect(event.rows[0]?.status).toBe('applied')
  })

  it('admin force may restore an inactive source only with explicit confirmation and provenance', async () => {
    await query(
      `INSERT INTO users (id, email, name, password_hash, is_active, activation_status, access_generation)
       VALUES ($1, 'grant-fix@example.com', 'Grant Fix', 'x', TRUE, 'activated', 3)`,
      [USER],
    )
    await query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, FALSE)`,
      [USER, ORG],
    )
    const seeded = await seedDirectory({ sourceActive: false })
    const eventId = await seedEvent(
      seeded,
      [{ type: 'membership_changed', orgId: ORG }],
      3,
    )

    await expect(
      restoreDeprovisionEvent({
        eventId,
        mode: 'admin_force',
        adminUserId: 'admin-test',
        confirm: false,
        note: 'confirmed source remains inactive',
      }),
    ).rejects.toMatchObject({ code: 'FORCE_CONFIRM_REQUIRED' })

    const result = await restoreDeprovisionEvent({
      eventId,
      mode: 'admin_force',
      adminUserId: 'admin-test',
      confirm: true,
      note: 'confirmed source remains inactive',
    })
    expect(result.restoreMode).toBe('admin_force')

    const event = await query<{
      resolve_note: string
      resolved_by: string
      restore_mode: string
      status: string
    }>(
      `SELECT status, resolved_by, resolve_note, restore_mode
         FROM directory_deprovision_events
        WHERE id = $1::uuid`,
      [eventId],
    )
    expect(event.rows[0]).toMatchObject({
      status: 'fully_resolved',
      resolved_by: 'admin-test',
      resolve_note: 'confirmed source remains inactive',
      restore_mode: 'admin_force',
    })
  })

  it('a concurrent access-graph writer supersedes evidence before a blocked restore can act', async () => {
    await query(
      `INSERT INTO users (id, email, name, password_hash, is_active, activation_status, access_generation)
       VALUES ($1, 'grant-fix@example.com', 'Grant Fix', 'x', TRUE, 'activated', 3)`,
      [USER],
    )
    await query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, FALSE)`,
      [USER, ORG],
    )
    const seeded = await seedDirectory({ sourceActive: true })
    const eventId = await seedEvent(
      seeded,
      [{ type: 'membership_changed', orgId: ORG }],
      3,
    )

    await withLockedUser(async (holder, holderPid) => {
      const restore = restoreDeprovisionEvent({
        eventId,
        mode: 'rehire',
        adminUserId: 'admin-test',
      })
      await waitForRestoreWaiters(holderPid, 1)

      await supersedeDeprovisionEvidenceForAccessGraphWrite(holder, {
        userIds: [USER],
        actorId: 'concurrent-admin',
        reason: 'concurrent admin access update',
      })
      await holder.query('COMMIT')

      await expect(restore).rejects.toMatchObject({
        code: 'EVENT_NOT_APPLIED',
      })
    })

    const state = await query<{
      access_generation: string
      event_status: string
      effect_status: string
      membership_active: boolean
    }>(
      `SELECT u.access_generation::text,
              event.status AS event_status,
              effect.status AS effect_status,
              membership.is_active AS membership_active
         FROM users u
         JOIN directory_deprovision_events event
           ON event.local_user_id = u.id
         JOIN directory_deprovision_effects effect
           ON effect.event_id = event.id
         JOIN user_orgs membership
           ON membership.user_id = u.id
          AND membership.org_id = $2
        WHERE u.id = $1`,
      [USER, ORG],
    )
    expect(state.rows[0]).toMatchObject({
      access_generation: '4',
      event_status: 'superseded',
      effect_status: 'superseded',
      membership_active: false,
    })
  })

  it('two blocked restores linearize to exactly one reversal with complete resolution provenance', async () => {
    await query(
      `INSERT INTO users (id, email, name, password_hash, is_active, activation_status, access_generation)
       VALUES ($1, 'grant-fix@example.com', 'Grant Fix', 'x', TRUE, 'activated', 3)`,
      [USER],
    )
    await query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, FALSE)`,
      [USER, ORG],
    )
    const seeded = await seedDirectory({ sourceActive: true })
    const eventId = await seedEvent(
      seeded,
      [{ type: 'membership_changed', orgId: ORG }],
      3,
    )

    const outcomes = await withLockedUser(async (holder, holderPid) => {
      const calls = Array.from({ length: 2 }, () =>
        restoreDeprovisionEvent({
          eventId,
          mode: 'rehire',
          adminUserId: 'admin-test',
        }),
      )
      await waitForRestoreWaiters(holderPid, 2)
      await holder.query('COMMIT')
      return Promise.allSettled(calls)
    })

    const successes = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled',
    )
    const failures = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected',
    )
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0].reason).toMatchObject({ code: 'EVENT_NOT_APPLIED' })

    const state = await query<{
      access_generation: string
      effect_status: string
      event_status: string
      resolved_by: string
      restore_mode: string
      reversed_by: string
    }>(
      `SELECT users.access_generation::text,
              event.status AS event_status,
              event.resolved_by,
              event.restore_mode,
              effect.status AS effect_status,
              effect.reversed_by
         FROM users
         JOIN directory_deprovision_events event
           ON event.local_user_id = users.id
         JOIN directory_deprovision_effects effect
           ON effect.event_id = event.id
        WHERE users.id = $1`,
      [USER],
    )
    expect(state.rows[0]).toMatchObject({
      access_generation: '4',
      event_status: 'fully_resolved',
      resolved_by: 'admin-test',
      restore_mode: 'rehire',
      effect_status: 'reversed',
      reversed_by: 'admin-test',
    })
  })

  it('alias conflict rolls back users/membership/grant (real Postgres transaction)', async () => {
    // A owns the global alias key "shared_login" (not necessarily their users.username —
    // users.username is UNIQUE lower, so B uses a distinct username column only after we
    // collide on the *alias table*, not the users unique index).
    await query(
      `INSERT INTO users (id, email, name, username, password_hash, is_active, activation_status, local_password_set)
       VALUES ($1, 'owner-a@example.com', 'Owner A', 'owner_a_user', 'hash-a', TRUE, 'activated', TRUE)`,
      [USER_A],
    )
    await query(
      `INSERT INTO user_login_aliases (user_id, kind, normalized_value, source)
       VALUES ($1, 'username', 'shared_login', 'seed')`,
      [USER_A],
    )

    // B is pending; username normalizes to the alias A already holds (global UNIQUE).
    await query(
      `INSERT INTO users (id, email, name, username, password_hash, is_active, activation_status, local_password_set)
       VALUES ($1, 'pending-b@example.com', 'Pending B', 'Shared_Login', 'hash-b', FALSE, 'pending_activation', FALSE)`,
      [USER_B],
    )

    await expect(
      activatePendingUser({
        userId: USER_B,
        mode: 'temp_password',
        temporaryPassword: 'TempPass9A!',
        adminUserId: 'admin-test',
        orgId: ORG,
        enableDingTalkGrant: true,
      }),
    ).rejects.toMatchObject({ code: 'ACTIVATE_ALIAS_CONFLICT' })

    // Full transaction rolled back: activation, membership, grant never committed.
    const b = await query<{
      activation_status: string
      is_active: boolean
    }>(
      `SELECT activation_status, is_active FROM users WHERE id = $1`,
      [USER_B],
    )
    expect(b.rows[0]?.activation_status).toBe('pending_activation')
    expect(b.rows[0]?.is_active).toBe(false)

    const membership = await query(
      `SELECT 1 FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active = TRUE`,
      [USER_B, ORG],
    )
    expect(membership.rows).toHaveLength(0)

    const grant = await query(
      `SELECT 1 FROM user_external_auth_grants WHERE local_user_id = $1 AND provider = 'dingtalk'`,
      [USER_B],
    )
    expect(grant.rows).toHaveLength(0)

    // Alias still exclusively owned by A; B never kept a claimed email alias either.
    const aliasShared = await query<{ user_id: string }>(
      `SELECT user_id FROM user_login_aliases WHERE normalized_value = 'shared_login'`,
    )
    expect(aliasShared.rows).toHaveLength(1)
    expect(aliasShared.rows[0]?.user_id).toBe(USER_A)
    const aliasB = await query(
      `SELECT 1 FROM user_login_aliases WHERE user_id = $1`,
      [USER_B],
    )
    expect(aliasB.rows).toHaveLength(0)
  })
})
