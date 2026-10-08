import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { __dingtalkOAuthInternalsForTests } from '../../src/auth/dingtalk-oauth'
import { query, transaction } from '../../src/db/pg'
import {
  lockUsersForAccessGraphWrite,
  supersedeDeprovisionEvidenceForAccessGraphWrite,
} from '../../src/directory/access-graph-mutex'
import {
  compensateSupersededDenyGrant,
} from '../../src/directory/deprovision-evidence-api'
import { applyDirectoryDeprovisionCandidate } from '../../src/directory/deprovision-ledger'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const PREFIX = `ops01-compensation-${Date.now()}`

type Seeded = {
  accountId: string
  eventId: string
  integrationId: string
  orgId: string
  userId: string
}

async function cleanup(): Promise<void> {
  await query(
    `DELETE FROM directory_deprovision_events WHERE local_user_id LIKE $1`,
    [`${PREFIX}-%`],
  )
  await query(
    `DELETE FROM user_external_auth_grants WHERE local_user_id LIKE $1`,
    [`${PREFIX}-%`],
  )
  await query(`DELETE FROM user_orgs WHERE user_id LIKE $1`, [`${PREFIX}-%`])
  await query(`DELETE FROM directory_integrations WHERE org_id LIKE $1`, [
    `${PREFIX}-%`,
  ])
  await query(`DELETE FROM users WHERE id LIKE $1`, [`${PREFIX}-%`])
}

async function seedAppliedCreationEvent(): Promise<Seeded> {
  const orgId = `${PREFIX}-org-${randomUUID()}`
  const userId = `${PREFIX}-user-${randomUUID()}`
  const integration = await query<{ id: string }>(
    `INSERT INTO directory_integrations (
       name, corp_id, org_id, provider, status, default_deprovision_policy
     ) VALUES ($1, $2, $3, 'dingtalk', 'active', 'mark_inactive')
     RETURNING id::text AS id`,
    [
      `${PREFIX}-integration-${randomUUID()}`,
      `${PREFIX}-corp-${randomUUID()}`,
      orgId,
    ],
  )
  const integrationId = integration.rows[0].id
  const run = await query<{ id: string }>(
    `INSERT INTO directory_sync_runs (
       integration_id, status, triggered_by, trigger_source
     ) VALUES ($1::uuid, 'success', 'test:ops01-compensation', 'manual')
     RETURNING id::text AS id`,
    [integrationId],
  )
  await query(
    `INSERT INTO users (
       id, password_hash, is_active, activation_status, access_generation
     ) VALUES ($1, 'x', TRUE, 'activated', 7)`,
    [userId],
  )
  await query(
    `INSERT INTO user_orgs (user_id, org_id, is_active)
     VALUES ($1, $2, TRUE)`,
    [userId, orgId],
  )
  const account = await query<{ id: string }>(
    `INSERT INTO directory_accounts (
       integration_id, provider, external_user_id, external_key, name, is_active
     ) VALUES ($1::uuid, 'dingtalk', $2, $3, 'OPS-01 Compensation', FALSE)
     RETURNING id::text AS id`,
    [
      integrationId,
      `${PREFIX}-external-${randomUUID()}`,
      `dingtalk:${PREFIX}:${randomUUID()}`,
    ],
  )
  const accountId = account.rows[0].id
  await query(
    `INSERT INTO directory_account_links (
       directory_account_id, local_user_id, link_status
     ) VALUES ($1::uuid, $2, 'linked')`,
    [accountId, userId],
  )

  const applied = await transaction(async (client) =>
    applyDirectoryDeprovisionCandidate(
      {
        query: async (statement, params) => {
          const result = await client.query(statement, params)
          return { rows: result.rows as Array<Record<string, unknown>> }
        },
      },
      {
        localUserId: userId,
        orgId,
        integrationId,
        directoryAccountId: accountId,
        runId: run.rows[0].id,
        triggeredBy: 'test:ops01-compensation',
        policy: 'mark_inactive',
        write: true,
      },
    ),
  )
  if (!applied.eventId) throw new Error('deprovision event was not created')
  return { accountId, eventId: applied.eventId, integrationId, orgId, userId }
}

async function reactivateAndSupersede(
  seeded: Seeded,
  options: { sourceActive?: boolean } = {},
): Promise<void> {
  await transaction(async (client) => {
    const locked = await lockUsersForAccessGraphWrite(client, [seeded.userId])
    if (!locked.has(seeded.userId)) throw new Error('test user vanished')
    await client.query(
      `UPDATE users
          SET is_active = TRUE, activation_status = 'activated', updated_at = NOW()
        WHERE id = $1::text`,
      [seeded.userId],
    )
    await client.query(
      `UPDATE user_orgs SET is_active = TRUE
        WHERE user_id = $1::text AND org_id = $2::text`,
      [seeded.userId, seeded.orgId],
    )
    if (options.sourceActive !== false) {
      await client.query(
        `UPDATE directory_accounts SET is_active = TRUE
          WHERE id = $1::uuid`,
        [seeded.accountId],
      )
    }
    await supersedeDeprovisionEvidenceForAccessGraphWrite(client, {
      userIds: [seeded.userId],
      actorId: 'test:manual-rehire',
      reason: 'test access graph reactivation superseded deprovision evidence',
    })
  })
}

async function waitForCompensationWaiters(
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
    `timed out waiting for ${expected} compensation transaction(s) behind holder ${holderPid}`,
  )
}

describeIfDatabase('OPS-01 superseded deny-row compensation (real DB)', () => {
  beforeEach(cleanup)
  afterAll(cleanup)

  it('rejects an empty compensation actor before opening a transaction', async () => {
    await expect(
      compensateSupersededDenyGrant({
        eventId: randomUUID(),
        adminUserId: '   ',
        confirm: true,
        note: 'owner verified safe cleanup',
      }),
    ).rejects.toMatchObject({ code: 'COMPENSATION_ACTOR_REQUIRED' })
  })

  it('closes the deprovision -> supersede -> compensate -> OAuth chain without a full restore', async () => {
    const seeded = await seedAppliedCreationEvent()
    await reactivateAndSupersede(seeded)

    const before = await query<{
      access_generation: string
      effect_status: string
      event_status: string
      grant_enabled: boolean
      grant_row_created: boolean
    }>(
      `SELECT users.access_generation::text,
              event.status AS event_status,
              effect.status AS effect_status,
              effect.grant_row_created,
              grant_row.enabled AS grant_enabled
         FROM users
         JOIN directory_deprovision_events event ON event.local_user_id = users.id
         JOIN directory_deprovision_effects effect ON effect.event_id = event.id
         JOIN user_external_auth_grants grant_row
           ON grant_row.local_user_id = users.id
          AND grant_row.provider = 'dingtalk'
        WHERE event.id = $1::uuid AND effect.effect_type = 'grant_changed'`,
      [seeded.eventId],
    )
    expect(before.rows[0]).toEqual({
      access_generation: '9',
      event_status: 'superseded',
      effect_status: 'superseded',
      grant_row_created: true,
      grant_enabled: false,
    })

    const result = await compensateSupersededDenyGrant({
      eventId: seeded.eventId,
      adminUserId: 'admin-test',
      confirm: true,
      note: 'owner verified safe cleanup',
    })
    expect(result).toMatchObject({
      alreadyCompensated: false,
      grantRow: 'deleted',
      effectStatus: 'compensated',
      accessGeneration: 10,
    })
    const ledger = await query<{
      access_generation: string
      compensation_note: string
      effect_status: string
      event_status: string
      reversed_by: string
    }>(
      `SELECT users.access_generation::text,
              event.status AS event_status,
              effect.status AS effect_status,
              effect.compensation_note,
              effect.reversed_by
         FROM users
         JOIN directory_deprovision_events event ON event.local_user_id = users.id
         JOIN directory_deprovision_effects effect ON effect.event_id = event.id
        WHERE event.id = $1::uuid AND effect.effect_type = 'grant_changed'`,
      [seeded.eventId],
    )
    expect(ledger.rows[0]).toEqual({
      access_generation: '10',
      compensation_note: 'owner verified safe cleanup',
      event_status: 'superseded',
      effect_status: 'compensated',
      reversed_by: 'admin-test',
    })
    expect(
      (
        await query(
          `SELECT 1 FROM user_external_auth_grants
            WHERE provider = 'dingtalk' AND local_user_id = $1`,
          [seeded.userId],
        )
      ).rows,
    ).toHaveLength(0)

    await __dingtalkOAuthInternalsForTests.ensureGrant(seeded.userId)
    const oauthGrant = await query<{ enabled: boolean }>(
      `SELECT enabled FROM user_external_auth_grants
        WHERE provider = 'dingtalk' AND local_user_id = $1`,
      [seeded.userId],
    )
    expect(oauthGrant.rows).toEqual([{ enabled: true }])
  })

  it('is idempotent after a committed compensation and does not advance generation twice', async () => {
    const seeded = await seedAppliedCreationEvent()
    await reactivateAndSupersede(seeded)
    await compensateSupersededDenyGrant({
      eventId: seeded.eventId,
      adminUserId: 'admin-test',
      confirm: true,
      note: 'first owner compensation',
    })

    const retry = await compensateSupersededDenyGrant({
      eventId: seeded.eventId,
      adminUserId: 'admin-test',
      confirm: true,
      note: 'retry after response loss',
    })
    expect(retry).toMatchObject({
      alreadyCompensated: true,
      grantRow: 'already_absent',
      accessGeneration: 10,
    })
  })

  it('rejects an enabled grant without changing the ledger', async () => {
    const seeded = await seedAppliedCreationEvent()
    await reactivateAndSupersede(seeded)
    await query(
      `UPDATE user_external_auth_grants
          SET enabled = TRUE
        WHERE provider = 'dingtalk' AND local_user_id = $1`,
      [seeded.userId],
    )

    await expect(
      compensateSupersededDenyGrant({
        eventId: seeded.eventId,
        adminUserId: 'admin-test',
        confirm: true,
        note: 'owner verified safe cleanup',
      }),
    ).rejects.toMatchObject({ code: 'DRIFT_CONFLICT' })
    const state = await query<{
      access_generation: string
      effect_status: string
      enabled: boolean
      granted_by: string
    }>(
      `SELECT users.access_generation::text,
              effect.status AS effect_status,
              grant_row.enabled,
              grant_row.granted_by
         FROM users
         JOIN directory_deprovision_effects effect ON effect.local_user_id = users.id
         JOIN user_external_auth_grants grant_row
           ON grant_row.local_user_id = users.id
          AND grant_row.provider = 'dingtalk'
        WHERE users.id = $1 AND effect.effect_type = 'grant_changed'`,
      [seeded.userId],
    )
    expect(state.rows[0]).toEqual({
      access_generation: '9',
      effect_status: 'superseded',
      enabled: true,
      granted_by: 'system:directory-deprovision',
    })
  })

  it('rejects a disabled grant with different provenance without changing the ledger', async () => {
    const seeded = await seedAppliedCreationEvent()
    await reactivateAndSupersede(seeded)
    await query(
      `UPDATE user_external_auth_grants
          SET granted_by = 'admin:later-write'
        WHERE provider = 'dingtalk' AND local_user_id = $1`,
      [seeded.userId],
    )

    await expect(
      compensateSupersededDenyGrant({
        eventId: seeded.eventId,
        adminUserId: 'admin-test',
        confirm: true,
        note: 'owner verified safe cleanup',
      }),
    ).rejects.toMatchObject({ code: 'DRIFT_CONFLICT' })
    const state = await query<{
      access_generation: string
      effect_status: string
      enabled: boolean
      granted_by: string
    }>(
      `SELECT users.access_generation::text,
              effect.status AS effect_status,
              grant_row.enabled,
              grant_row.granted_by
         FROM users
         JOIN directory_deprovision_effects effect ON effect.local_user_id = users.id
         JOIN user_external_auth_grants grant_row
           ON grant_row.local_user_id = users.id
          AND grant_row.provider = 'dingtalk'
        WHERE users.id = $1 AND effect.effect_type = 'grant_changed'`,
      [seeded.userId],
    )
    expect(state.rows[0]).toEqual({
      access_generation: '9',
      effect_status: 'superseded',
      enabled: false,
      granted_by: 'admin:later-write',
    })
  })

  it('requires the exact evidenced directory source to be active and linked', async () => {
    const seeded = await seedAppliedCreationEvent()
    await reactivateAndSupersede(seeded, { sourceActive: false })

    await expect(
      compensateSupersededDenyGrant({
        eventId: seeded.eventId,
        adminUserId: 'admin-test',
        confirm: true,
        note: 'owner verified safe cleanup',
      }),
    ).rejects.toMatchObject({ code: 'COMPENSATION_SOURCE_INACTIVE' })
    expect(
      (
        await query(
          `SELECT enabled FROM user_external_auth_grants
            WHERE provider = 'dingtalk' AND local_user_id = $1`,
          [seeded.userId],
        )
      ).rows,
    ).toEqual([{ enabled: false }])
  })

  it('fails fast when directory sync holds the source row instead of inverting the user/source lock order', async () => {
    const seeded = await seedAppliedCreationEvent()
    await reactivateAndSupersede(seeded)
    const holder = new Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    let holderReleased = false
    try {
      await holder.query('BEGIN')
      await holder.query(
        `SELECT id FROM directory_accounts WHERE id = $1::uuid FOR UPDATE`,
        [seeded.accountId],
      )

      const startedAt = Date.now()
      const release = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          holder
            .query('ROLLBACK')
            .then(() => {
              holderReleased = true
              resolve()
            })
            .catch(reject)
        }, 500)
      })
      const outcome = await compensateSupersededDenyGrant({
        eventId: seeded.eventId,
        adminUserId: 'admin-test',
        confirm: true,
        note: 'owner verified safe cleanup',
      }).then(
        (value) => ({ value, error: undefined, elapsedMs: Date.now() - startedAt }),
        (error: unknown) => ({ value: undefined, error, elapsedMs: Date.now() - startedAt }),
      )
      await release

      expect(outcome.error).toMatchObject({ code: 'COMPENSATION_SOURCE_BUSY' })
      expect(outcome.value).toBeUndefined()
      expect(outcome.elapsedMs).toBeLessThan(400)
      const state = await query<{
        access_generation: string
        effect_status: string
        enabled: boolean
      }>(
        `SELECT users.access_generation::text,
                effect.status AS effect_status,
                grant_row.enabled
           FROM users
           JOIN directory_deprovision_effects effect
             ON effect.local_user_id = users.id
            AND effect.effect_type = 'grant_changed'
           JOIN user_external_auth_grants grant_row
             ON grant_row.local_user_id = users.id
            AND grant_row.provider = 'dingtalk'
          WHERE users.id = $1`,
        [seeded.userId],
      )
      expect(state.rows[0]).toEqual({
        access_generation: '9',
        effect_status: 'superseded',
        enabled: false,
      })
    } finally {
      if (!holderReleased) {
        await holder.query('ROLLBACK')
      }
      await holder.end()
    }
  })

  it('requires an active membership in the evidenced organization', async () => {
    const seeded = await seedAppliedCreationEvent()
    await reactivateAndSupersede(seeded)
    await query(
      `UPDATE user_orgs SET is_active = FALSE
        WHERE user_id = $1 AND org_id = $2`,
      [seeded.userId, seeded.orgId],
    )

    await expect(
      compensateSupersededDenyGrant({
        eventId: seeded.eventId,
        adminUserId: 'admin-test',
        confirm: true,
        note: 'owner verified safe cleanup',
      }),
    ).rejects.toMatchObject({ code: 'COMPENSATION_MEMBERSHIP_INACTIVE' })
    const effect = await query<{ status: string }>(
      `SELECT status FROM directory_deprovision_effects
        WHERE event_id = $1::uuid AND effect_type = 'grant_changed'`,
      [seeded.eventId],
    )
    expect(effect.rows).toEqual([{ status: 'superseded' }])
  })

  it('refuses cleanup while another applied deprovision event protects the user', async () => {
    const seeded = await seedAppliedCreationEvent()
    await reactivateAndSupersede(seeded)
    const liveEvent = await query<{ id: string }>(
      `INSERT INTO directory_deprovision_events (
         org_id, integration_id, directory_account_id, local_user_id,
         run_id, triggered_by, event_origin, link_witness_account_id,
         link_witness_local_user_id, policy, globally_clear,
         access_generation_at_apply, status
       )
       SELECT org_id, integration_id, directory_account_id, local_user_id,
              run_id, 'test:live-veto', event_origin, link_witness_account_id,
              link_witness_local_user_id, policy, globally_clear,
              9, 'applied'
         FROM directory_deprovision_events
        WHERE id = $1::uuid
       RETURNING id::text AS id`,
      [seeded.eventId],
    )
    await query(
      `INSERT INTO directory_deprovision_effects (
         event_id, local_user_id, effect_type, org_id,
         before_active, after_active, grant_row_created,
         access_generation_at_apply, status
       ) VALUES ($1::uuid, $2, 'user_changed', NULL,
                 TRUE, FALSE, FALSE, 9, 'applied')`,
      [liveEvent.rows[0].id, seeded.userId],
    )

    await expect(
      compensateSupersededDenyGrant({
        eventId: seeded.eventId,
        adminUserId: 'admin-test',
        confirm: true,
        note: 'owner verified safe cleanup',
      }),
    ).rejects.toMatchObject({ code: 'COMPENSATION_LIVE_EVIDENCE' })
    expect(
      (
        await query(
          `SELECT enabled FROM user_external_auth_grants
            WHERE provider = 'dingtalk' AND local_user_id = $1`,
          [seeded.userId],
        )
      ).rows,
    ).toEqual([{ enabled: false }])
  })

  it('queues both concurrent calls behind the user mutex and applies one generation change', async () => {
    const seeded = await seedAppliedCreationEvent()
    await reactivateAndSupersede(seeded)
    const holder = new Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    try {
      await holder.query('BEGIN')
      const pid = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await holder.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [seeded.userId])

      const calls = Array.from({ length: 2 }, (_, index) =>
        compensateSupersededDenyGrant({
          eventId: seeded.eventId,
          adminUserId: `admin-${index + 1}`,
          confirm: true,
          note: `concurrent owner compensation ${index + 1}`,
        }),
      )
      await waitForCompensationWaiters(pid.rows[0].pid, 2)
      await holder.query('COMMIT')
      const results = await Promise.all(calls)

      expect(results.filter((result) => !result.alreadyCompensated)).toHaveLength(1)
      expect(results.filter((result) => result.alreadyCompensated)).toHaveLength(1)
      expect(new Set(results.map((result) => result.accessGeneration))).toEqual(
        new Set([10]),
      )
    } finally {
      try {
        await holder.query('ROLLBACK')
      } catch {
        // The holder may already be committed.
      }
      await holder.end()
    }
  })
})
