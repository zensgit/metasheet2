import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { query, transaction } from '../../src/db/pg'
import {
  lockUsersForAccessGraphWrite,
  supersedeDeprovisionEvidenceForAccessGraphWrite,
} from '../../src/directory/access-graph-mutex'
import { applyDirectoryDeprovisionCandidate } from '../../src/directory/deprovision-ledger'
import {
  bindDirectoryAccount,
  unbindDirectoryAccount,
} from '../../src/directory/directory-sync'
import {
  archiveLocalAccount,
  createLocalAccount,
} from '../../src/directory/local-directory-org'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const PREFIX = `d5a-mutex-${Date.now()}`

type SeededEvidence = {
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
       integration_id, provider, corp_id, external_user_id, union_id, open_id,
       external_key, name, is_active
     )
     SELECT integration.id,
            'dingtalk',
            integration.corp_id,
            $2,
            $3,
            $4,
            $2,
            'D5A Mutex',
            FALSE
       FROM directory_integrations integration
      WHERE integration.id = $1::uuid
     RETURNING id::text AS id`,
    [
      integrationId,
      `${PREFIX}-external-${randomUUID()}`,
      `${PREFIX}-union-${randomUUID()}`,
      `${PREFIX}-open-${randomUUID()}`,
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
  return {
    accountId: account.rows[0].id,
    eventId: applied.eventId,
    integrationId,
    orgId,
    userId,
  }
}

async function resetSeededForAccessOverride(
  seeded: SeededEvidence,
): Promise<void> {
  await query(
    `UPDATE users
        SET is_active = TRUE, activation_status = 'activated'
      WHERE id = $1`,
    [seeded.userId],
  )
  await query(
    `UPDATE directory_accounts SET is_active = TRUE WHERE id = $1::uuid`,
    [seeded.accountId],
  )
  await query(
    `UPDATE directory_account_links
        SET local_user_id = $2, link_status = 'linked'
      WHERE directory_account_id = $1::uuid`,
    [seeded.accountId, seeded.userId],
  )
  await query(
    `INSERT INTO user_orgs (user_id, org_id, is_active)
     VALUES ($1, $2, TRUE)
     ON CONFLICT (user_id, org_id)
     DO UPDATE SET is_active = TRUE`,
    [seeded.userId, seeded.orgId],
  )
}

async function reopenEvidence(eventId: string): Promise<void> {
  await query(
    `UPDATE directory_deprovision_effects
        SET status = 'applied', reversed_at = NULL, reversed_by = NULL
      WHERE event_id = $1::uuid`,
    [eventId],
  )
  await query(
    `UPDATE directory_deprovision_events
        SET status = 'applied',
            resolved_at = NULL,
            resolved_by = NULL,
            resolve_note = NULL
      WHERE id = $1::uuid`,
    [eventId],
  )
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

async function waitForAnyUserLockWaiter(
  inspector: Pool,
  holderPid: number,
  timeoutMs = 8000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await inspector.query<{ pid: number }>(
      `SELECT activity.pid
         FROM pg_stat_activity activity
        WHERE activity.pid <> $1::int
          AND activity.wait_event_type = 'Lock'
          AND $1::int = ANY(pg_blocking_pids(activity.pid))
          AND activity.query LIKE '%FROM users%'
        ORDER BY activity.pid
        LIMIT 1`,
      [holderPid],
    )
    if (result.rows[0]?.pid) return Number(result.rows[0].pid)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for a production writer to block on user holder ${holderPid}`)
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

  it('manual bind supersedes open evidence and advances generation in the bind transaction', async () => {
    const seeded = await seedAppliedEvidence()
    await resetSeededForAccessOverride(seeded)
    const before = await readEvidence(seeded.userId)

    await bindDirectoryAccount(seeded.accountId, {
      localUserRef: seeded.userId,
      adminUserId: 'admin:d5b-bind',
      enableDingTalkGrant: false,
    })

    const after = await readEvidence(seeded.userId)
    expect(Number(after.access_generation)).toBe(Number(before.access_generation) + 1)
    expect(after.event_status).toBe('superseded')
    expect(new Set(after.effect_statuses)).toEqual(new Set(['superseded']))
    expect(after.resolved_by).toBe('admin:d5b-bind')
  })

  it('manual unbind supersedes open evidence and advances generation in the unbind transaction', async () => {
    const seeded = await seedAppliedEvidence()
    await resetSeededForAccessOverride(seeded)
    const before = await readEvidence(seeded.userId)

    await unbindDirectoryAccount(seeded.accountId, {
      adminUserId: 'admin:d5b-unbind',
      disableDingTalkGrant: true,
    })

    const after = await readEvidence(seeded.userId)
    expect(Number(after.access_generation)).toBe(Number(before.access_generation) + 1)
    expect(after.event_status).toBe('superseded')
    expect(new Set(after.effect_statuses)).toEqual(new Set(['superseded']))
    expect(after.resolved_by).toBe('admin:d5b-unbind')
  })

  it('local account create and archive both invalidate open evidence', async () => {
    const seeded = await seedAppliedEvidence()
    await resetSeededForAccessOverride(seeded)
    const beforeCreate = await readEvidence(seeded.userId)

    const localAccount = await createLocalAccount({
      orgId: seeded.orgId,
      localUserId: seeded.userId,
      actorId: 'admin:d5b-local-create',
    })
    const afterCreate = await readEvidence(seeded.userId)
    expect(Number(afterCreate.access_generation)).toBe(
      Number(beforeCreate.access_generation) + 1,
    )
    expect(afterCreate.event_status).toBe('superseded')
    expect(afterCreate.resolved_by).toBe('admin:d5b-local-create')

    await reopenEvidence(seeded.eventId)
    const beforeArchive = await readEvidence(seeded.userId)
    await archiveLocalAccount(
      seeded.orgId,
      localAccount.id,
      'admin:d5b-local-archive',
    )
    const afterArchive = await readEvidence(seeded.userId)
    expect(Number(afterArchive.access_generation)).toBe(
      Number(beforeArchive.access_generation) + 1,
    )
    expect(afterArchive.event_status).toBe('superseded')
    expect(afterArchive.resolved_by).toBe('admin:d5b-local-archive')
  })

  it('the production bind parks on the canonical user mutex before it locks the account', async () => {
    const seeded = await seedAppliedEvidence()
    await resetSeededForAccessOverride(seeded)
    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    const holder = await pool.connect()
    try {
      await holder.query('BEGIN')
      const holderPid = Number(
        (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid,
      )
      await holder.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [
        seeded.userId,
      ])

      const bindPromise = bindDirectoryAccount(seeded.accountId, {
        localUserRef: seeded.userId,
        adminUserId: 'admin:d5b-barrier',
        enableDingTalkGrant: false,
      })
      const waiterPid = await waitForAnyUserLockWaiter(pool, holderPid)
      const waiter = await pool.query<{ account_locked: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM pg_locks account_lock
             JOIN pg_class relation ON relation.oid = account_lock.relation
            WHERE account_lock.pid = $1::int
              AND relation.relname = 'directory_accounts'
              AND account_lock.granted
         ) AS account_locked`,
        [waiterPid],
      )
      expect(waiter.rows[0]?.account_locked).toBe(false)

      await holder.query('ROLLBACK')
      await bindPromise
      expect((await readEvidence(seeded.userId)).event_status).toBe('superseded')
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      holder.release()
      await pool.end()
    }
  })

  it("a 'pending' email-match hint never trips the bind CAS: witness and re-read share the linked-only predicate (D5 review P1)", async () => {
    // The sync loop writes local_user_id onto 'pending' rows as a match HINT (the top-ranked
    // bind target in the review workbench). Before the fix, the prior-holder witness read that
    // hint (status-agnostic) while the in-transaction CAS re-read was linked-scoped: witness
    // non-null, CAS null, and EVERY manual bind of such an account failed forever with
    // "binding changed; retry" — a retry that could never succeed.
    const orgId = `${PREFIX}-org-${randomUUID()}`
    const hintUserId = `${PREFIX}-hint-${randomUUID()}`
    const targetUserId = `${PREFIX}-target-${randomUUID()}`
    const integration = await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id, org_id, provider, status, default_deprovision_policy)
       VALUES ($1, $2, $3, 'dingtalk', 'active', 'manual_review') RETURNING id::text AS id`,
      [`${PREFIX}-integration-${randomUUID()}`, `${PREFIX}-corp-${randomUUID()}`, orgId],
    )
    for (const [uid, email] of [
      [hintUserId, `${PREFIX}-hint@example.com`],
      [targetUserId, `${PREFIX}-target@example.com`],
    ]) {
      await query(
        `INSERT INTO users (id, email, password_hash, is_active, activation_status, access_generation)
         VALUES ($1, $2, 'x', TRUE, 'activated', 0)`,
        [uid, email],
      )
    }
    const account = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key, name, email, is_active)
       SELECT integration.id, 'dingtalk', integration.corp_id, $2, $3, $4, $2, 'Pending Hint', $5, TRUE
         FROM directory_integrations integration WHERE integration.id = $1::uuid
       RETURNING id::text AS id`,
      [
        integration.rows[0].id,
        `${PREFIX}-external-${randomUUID()}`,
        `${PREFIX}-union-${randomUUID()}`,
        `${PREFIX}-open-${randomUUID()}`,
        `${PREFIX}-hint@example.com`,
      ],
    )
    // The sync loop's own shape: a PENDING row carrying the match hint.
    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1::uuid, $2, 'pending', 'email')`,
      [account.rows[0].id, hintUserId],
    )

    // Binding to a DIFFERENT user must succeed — the pending hint is not a holder.
    const bound = await bindDirectoryAccount(account.rows[0].id, {
      localUserRef: targetUserId,
      adminUserId: 'admin:d5-pending-hint',
      enableDingTalkGrant: false,
    })
    expect(bound.account.linkStatus).toBe('linked')
    expect(bound.account.localUser?.id).toBe(targetUserId)
    // And the hint user is NOT presented as a previous holder — they never held anything.
    expect(bound.previousLocalUser).toBeNull()

    const link = await query<{ local_user_id: string; link_status: string }>(
      `SELECT local_user_id, link_status FROM directory_account_links WHERE directory_account_id = $1::uuid`,
      [account.rows[0].id],
    )
    expect(link.rows).toHaveLength(1)
    expect(link.rows[0]).toMatchObject({ local_user_id: targetUserId, link_status: 'linked' })
  })
})
