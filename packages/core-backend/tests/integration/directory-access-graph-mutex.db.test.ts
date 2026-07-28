import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { query, transaction } from '../../src/db/pg'
import {
  lockUsersForAccessGraphWrite,
  supersedeDeprovisionEvidenceForAccessGraphWrite,
} from '../../src/directory/access-graph-mutex'
import { applyDirectoryDeprovisionCandidate } from '../../src/directory/deprovision-ledger'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const PREFIX = `d5a-mutex-${Date.now()}`

type SeededEvidence = {
  eventId: string
  integrationId: string
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

async function seedAppliedEvidence(): Promise<SeededEvidence> {
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
     ) VALUES ($1::uuid, 'success', 'test:d5a-mutex', 'manual')
     RETURNING id::text AS id`,
    [integrationId],
  )
  await query(
    `INSERT INTO users (
       id, password_hash, is_active, activation_status, access_generation
     ) VALUES ($1, 'x', TRUE, 'activated', 4)`,
    [userId],
  )
  await query(
    `INSERT INTO user_orgs (user_id, org_id, is_active)
     VALUES ($1, $2, TRUE)`,
    [userId, orgId],
  )
  await query(
    `INSERT INTO user_external_auth_grants (
       provider, local_user_id, enabled, granted_by, created_at, updated_at
     ) VALUES ('dingtalk', $1, TRUE, 'test:d5a-mutex', NOW(), NOW())`,
    [userId],
  )
  const account = await query<{ id: string }>(
    `INSERT INTO directory_accounts (
       integration_id, provider, external_user_id, external_key, name, is_active
     ) VALUES ($1::uuid, 'dingtalk', $2, $3, 'D5A Mutex', FALSE)
     RETURNING id::text AS id`,
    [
      integrationId,
      `${PREFIX}-external-${randomUUID()}`,
      `dingtalk:${PREFIX}:${randomUUID()}`,
    ],
  )
  await query(
    `INSERT INTO directory_account_links (
       directory_account_id, local_user_id, link_status
     ) VALUES ($1::uuid, $2, 'linked')`,
    [account.rows[0].id, userId],
  )

  const applied = await transaction((client) =>
    applyDirectoryDeprovisionCandidate(client, {
      localUserId: userId,
      orgId,
      integrationId,
      directoryAccountId: account.rows[0].id,
      runId: run.rows[0].id,
      triggeredBy: 'test:d5a-mutex',
      policy: 'mark_inactive',
      write: true,
    }),
  )
  if (!applied.eventId) throw new Error('failed to seed deprovision evidence')
  return { eventId: applied.eventId, integrationId, userId }
}

async function readEvidence(userId: string) {
  const result = await query<{
    access_generation: string
    event_status: string
    effect_statuses: string[]
    resolved_by: string | null
  }>(
    `SELECT
       u.access_generation::text,
       event.status AS event_status,
       event.resolved_by,
       array_agg(effect.status ORDER BY effect.effect_type)::text[] AS effect_statuses
     FROM users u
     JOIN directory_deprovision_events event ON event.local_user_id = u.id
     JOIN directory_deprovision_effects effect ON effect.event_id = event.id
     WHERE u.id = $1
     GROUP BY u.access_generation, event.status, event.resolved_by`,
    [userId],
  )
  return result.rows[0]
}

async function waitUntilBlockedOnHolder(
  inspector: Pool,
  waiterPid: number,
  holderPid: number,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await inspector.query<{ blocked: boolean }>(
      `SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked`,
      [waiterPid, holderPid],
    )
    if (result.rows[0]?.blocked === true) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for pid ${waiterPid} to block on ${holderPid}`)
}

describeIfDatabase('directory access-graph mutex (real DB)', () => {
  beforeEach(cleanup)
  afterAll(cleanup)

  it('supersedes both event and effects while advancing generation', async () => {
    const seeded = await seedAppliedEvidence()
    const before = await readEvidence(seeded.userId)
    expect(before.event_status).toBe('applied')

    await transaction(async (client) => {
      const locked = await lockUsersForAccessGraphWrite(client, [seeded.userId])
      expect(locked.has(seeded.userId)).toBe(true)
      await client.query(
        `UPDATE user_external_auth_grants
            SET enabled = TRUE, granted_by = 'admin:test', updated_at = NOW()
          WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [seeded.userId],
      )
      await supersedeDeprovisionEvidenceForAccessGraphWrite(client, {
        userIds: [seeded.userId],
        actorId: 'admin:test',
        reason: 'superseded by real-DB access override',
      })
    })

    const after = await readEvidence(seeded.userId)
    expect(Number(after.access_generation)).toBe(
      Number(before.access_generation) + 1,
    )
    expect(after.event_status).toBe('superseded')
    expect(new Set(after.effect_statuses)).toEqual(new Set(['superseded']))
    expect(after.resolved_by).toBe('admin:test')
  })

  it('rolls generation and both evidence layers back with the access write', async () => {
    const seeded = await seedAppliedEvidence()
    const before = await readEvidence(seeded.userId)

    await expect(
      transaction(async (client) => {
        await lockUsersForAccessGraphWrite(client, [seeded.userId])
        await supersedeDeprovisionEvidenceForAccessGraphWrite(client, {
          userIds: [seeded.userId],
          actorId: 'admin:test',
          reason: 'must roll back',
        })
        throw new Error('fail after evidence override')
      }),
    ).rejects.toThrow('fail after evidence override')

    expect(await readEvidence(seeded.userId)).toEqual(before)
  })

  it('parks a competing writer on the canonical users row lock', async () => {
    const seeded = await seedAppliedEvidence()
    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    const holder = await pool.connect()
    const waiter = await pool.connect()
    try {
      await holder.query('BEGIN')
      await waiter.query('BEGIN')
      const holderPid = Number(
        (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid,
      )
      const waiterPid = Number(
        (await waiter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid,
      )
      await holder.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [
        seeded.userId,
      ])

      const lockPromise = lockUsersForAccessGraphWrite(waiter, [seeded.userId])
      await waitUntilBlockedOnHolder(pool, waiterPid, holderPid)
      await holder.query('ROLLBACK')

      const locked = await lockPromise
      expect(locked.has(seeded.userId)).toBe(true)
      await supersedeDeprovisionEvidenceForAccessGraphWrite(waiter, {
        userIds: [seeded.userId],
        actorId: 'admin:waiter',
        reason: 'serialized override',
      })
      await waiter.query('COMMIT')

      const after = await readEvidence(seeded.userId)
      expect(after.event_status).toBe('superseded')
      expect(after.resolved_by).toBe('admin:waiter')
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await waiter.query('ROLLBACK').catch(() => undefined)
      holder.release()
      waiter.release()
      await pool.end()
    }
  })
})

