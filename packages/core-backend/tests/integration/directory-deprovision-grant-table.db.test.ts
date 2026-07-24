import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { activatePendingUser } from '../../src/auth/user-activate'
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

async function cleanup() {
  await query(`DELETE FROM directory_deprovision_effects WHERE local_user_id = $1`, [USER]).catch(() => {})
  await query(
    `DELETE FROM directory_deprovision_events WHERE local_user_id = $1`, [USER]).catch(() => {})
  await query(
    `DELETE FROM directory_account_links WHERE local_user_id = $1`, [USER]).catch(() => {})
  await query(`DELETE FROM directory_sync_runs WHERE integration_id IN
                 (SELECT id FROM directory_integrations WHERE org_id = $1)`, [ORG]).catch(() => {})
  await query(`DELETE FROM directory_accounts WHERE integration_id IN
                 (SELECT id FROM directory_integrations WHERE org_id = $1)`, [ORG]).catch(() => {})
  await query(`DELETE FROM directory_integrations WHERE org_id = $1`, [ORG]).catch(() => {})
  await query(`DELETE FROM user_external_auth_grants WHERE local_user_id = $1`, [USER]).catch(() => {})
  await query(`DELETE FROM user_login_aliases WHERE user_id = $1`, [USER]).catch(() => {})
  await query(`DELETE FROM user_orgs WHERE user_id = $1`, [USER]).catch(() => {})
  await query(`DELETE FROM users WHERE id = $1`, [USER]).catch(() => {})
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

async function seedEvent(
  seeded: { integrationId: string; accountId: string; runId: string },
  effects: Array<{ type: string; orgId: string | null }>,
  generation: number,
) {
  const ev = await query<{ id: string }>(
    `INSERT INTO directory_deprovision_events
       (org_id, integration_id, directory_account_id, local_user_id, run_id, triggered_by,
        event_origin, access_generation_at_apply, status)
     VALUES ($1, $2, $3, $4, $5, 'test', 'sync', $6, 'open')
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

  it('restoring a membership effect actually re-activates the membership', async () => {
    await query(
      `INSERT INTO users (id, email, name, password_hash, is_active, activation_status, access_generation)
       VALUES ($1, 'grant-fix@example.com', 'Grant Fix', 'x', TRUE, 'activated', 3)`,
      [USER],
    )
    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, FALSE)`, [USER, ORG])
    const seeded = await seedDirectory({ sourceActive: true })
    const eventId = await seedEvent(seeded, [{ type: 'clear_user_orgs', orgId: ORG }], 3)

    const result = await restoreDeprovisionEvent({
      eventId, mode: 'rehire', adminUserId: 'admin-test',
    })
    expect(result.restoredEffectCount).toBe(1)

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
    const eventId = await seedEvent(seeded, [{ type: 'disable_dingtalk_grant', orgId: null }], 3)

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
    const eventId = await seedEvent(seeded, [{ type: 'clear_user_orgs', orgId: ORG }], 3)

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
    const eventId = await seedEvent(seeded, [{ type: 'disable_dingtalk_grant', orgId: null }], 3)

    await expect(
      restoreDeprovisionEvent({ eventId, mode: 'rehire', adminUserId: 'admin-test' }),
    ).rejects.toMatchObject({ code: 'DRIFT_CONFLICT' })

    // And the refusal must be inert: the grant is left exactly as the other writer set it.
    expect(await grantEnabled()).toBe(true)
    const effects = await query<{ status: string }>(
      `SELECT status FROM directory_deprovision_effects WHERE local_user_id = $1`, [USER])
    expect(effects.rows.map((r) => r.status)).toEqual(['applied'])
  })
})
