import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { applyDirectoryDeprovisionCandidate } from '../../src/directory/deprovision-ledger'

/**
 * §11 two-connection goldens for the D4 writer — the tests whose absence let the
 * adversarial-review P1 through.
 *
 * That P1, proved with this exact race: candidacy used to be read by the SAME statement that
 * acquired the `users FOR UPDATE` lock. Under READ COMMITTED the statement's subqueries evaluate
 * on the pre-wait snapshot (EPQ refreshes only the locked row itself), so a cross-org rehire
 * committing while the writer waited was invisible — the person was platform-deactivated, the
 * grant revoked, and the event recorded `globally_clear=true`: false evidence.
 *
 * Test 1 reconstructs that interleaving deterministically (a second connection holds the lock,
 * the writer is proven BLOCKED via pg_locks, the rehire commits, the lock releases) and pins the
 * post-fix behaviour. It kills BOTH mutations the review ran: remove the mutex (the writer no
 * longer blocks, reads the pre-rehire world, revokes the grant → red) and re-fuse lock+read into
 * one statement (stale snapshot → same red).
 *
 * Test 2 pins §5.4's two legs — a newer event must supersede open effects AND bump the
 * generation; deleting either leg alone reds it.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const PREFIX = `d4-race-${Date.now()}`

async function cleanup(): Promise<void> {
  await query(`DELETE FROM directory_deprovision_events WHERE local_user_id LIKE $1`, [`${PREFIX}-%`])
  await query(`DELETE FROM user_external_auth_grants WHERE local_user_id LIKE $1`, [`${PREFIX}-%`])
  await query(`DELETE FROM user_orgs WHERE user_id LIKE $1`, [`${PREFIX}-%`])
  await query(`DELETE FROM directory_integrations WHERE org_id LIKE $1`, [`${PREFIX}-%`])
  await query(`DELETE FROM users WHERE id LIKE $1`, [`${PREFIX}-%`])
}

type Seeded = {
  userId: string
  orgId: string
  integrationId: string
  accountId: string
  runId: string
}

async function seed(tag: string): Promise<Seeded> {
  const userId = `${PREFIX}-${tag}-user`
  const orgId = `${PREFIX}-${tag}-org`
  await query(
    `INSERT INTO users (id, email, name, password_hash, is_active, activation_status, access_generation)
     VALUES ($1, $2, 'Race', 'x', TRUE, 'activated', 0)`,
    [userId, `${tag}-${randomUUID()}@example.com`],
  )
  await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [userId, orgId])
  await query(
    `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by)
     VALUES ('dingtalk', $1, TRUE, 'seed')`,
    [userId],
  )
  const integ = await query<{ id: string }>(
    `INSERT INTO directory_integrations (name, corp_id, org_id, status, default_deprovision_policy)
     VALUES ($1, $2, $3, 'active', 'mark_inactive') RETURNING id::text AS id`,
    [`${PREFIX}-${tag}`, `corp-${tag}`, orgId],
  )
  const acct = await query<{ id: string }>(
    `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, is_active)
     VALUES ($1::uuid, 'dingtalk', $2, $3, 'Race', FALSE) RETURNING id::text AS id`,
    [integ.rows[0].id, `ext-${tag}`, `dingtalk:${tag}:${randomUUID()}`],
  )
  await query(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
     VALUES ($1::uuid, $2, 'linked')`,
    [acct.rows[0].id, userId],
  )
  const run = await query<{ id: string }>(
    `INSERT INTO directory_sync_runs (integration_id, status, triggered_by)
     VALUES ($1::uuid, 'running', 'test') RETURNING id::text AS id`,
    [integ.rows[0].id],
  )
  return {
    userId,
    orgId,
    integrationId: integ.rows[0].id,
    accountId: acct.rows[0].id,
    runId: run.rows[0].id,
  }
}

const applyInput = (seeded: Seeded, write: boolean) => ({
  localUserId: seeded.userId,
  orgId: seeded.orgId,
  integrationId: seeded.integrationId,
  directoryAccountId: seeded.accountId,
  runId: seeded.runId,
  triggeredBy: 'test',
  policy: 'mark_inactive' as const,
  write,
})

describeIfDatabase('D4 writer two-connection goldens (race + supersede, real DB)', () => {
  beforeEach(cleanup)
  afterAll(cleanup)

  it('a cross-org rehire committing while the writer waits on the mutex flips globally-clear OFF before any grant/user write', async () => {
    const seeded = await seed('rehire')

    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    const writer = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    await writer.connect()
    try {
      // Connection 1 takes the canonical per-user mutex and holds it.
      await holder.query('BEGIN')
      await holder.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [seeded.userId])

      // Connection 2 starts the real writer; it must BLOCK on that lock. Its backend pid is
      // captured BEFORE the writer starts (a blocked connection cannot answer), so the barrier
      // below waits on THIS writer specifically, not on any waiter in the cluster.
      const writerPid = Number(
        (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid,
      )
      await writer.query('BEGIN')
      const writerRun = (async () => {
        const result = await applyDirectoryDeprovisionCandidate(
          { query: (sql, params) => writer.query(sql, params as unknown[]) },
          applyInput(seeded, true),
        )
        await writer.query('COMMIT')
        return result
      })()

      // Deterministic barrier: wait until the writer's lock wait is VISIBLE in pg_locks —
      // never a sleep-and-hope (async-settle discipline).
      let waiters = 0
      for (let attempt = 0; attempt < 100 && waiters === 0; attempt += 1) {
        const waiting = await holder.query(
          `SELECT count(*)::int AS n
             FROM pg_locks blocked
            WHERE NOT blocked.granted
              AND blocked.pid = $1`,
          [writerPid],
        )
        waiters = Number(waiting.rows[0]?.n ?? 0)
        if (waiters === 0) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(waiters).toBeGreaterThan(0)

      // While the writer is provably blocked: a cross-org rehire commits — a NEW active linked
      // account in a DIFFERENT integration. After this, the person is NOT globally clear.
      const integB = await holder.query(
        `INSERT INTO directory_integrations (name, corp_id, org_id, status, default_deprovision_policy)
         VALUES ($1, $2, $3, 'active', 'manual_review') RETURNING id`,
        [`${PREFIX}-rehire-b`, 'corp-rehire-b', `${PREFIX}-rehire-org-b`],
      )
      const acctB = await holder.query(
        `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, is_active)
         VALUES ($1, 'dingtalk', 'ext-b', $2, 'Race', TRUE) RETURNING id`,
        [integB.rows[0].id, `dingtalk:rehire-b:${randomUUID()}`],
      )
      await holder.query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
         VALUES ($1, $2, 'linked')`,
        [acctB.rows[0].id, seeded.userId],
      )
      await holder.query('COMMIT') // releases the mutex; the writer proceeds

      const result = await writerRun

      // The writer's post-lock re-read MUST see the rehire: org-A membership still deactivates
      // (org-scoped), but the grant and the platform account survive, and the evidence says so.
      expect(result.applied).toBe(true)
      expect(result.globallyClear).toBe(false)
      expect(result.plan.effects.map((effect) => effect.type)).toEqual(['membership_changed'])

      const user = await query<{ is_active: boolean }>(
        `SELECT is_active FROM users WHERE id = $1`, [seeded.userId])
      expect(user.rows[0]?.is_active).toBe(true)
      const grant = await query<{ enabled: boolean }>(
        `SELECT enabled FROM user_external_auth_grants WHERE local_user_id = $1`, [seeded.userId])
      expect(grant.rows[0]?.enabled).toBe(true)
      const membership = await query<{ is_active: boolean }>(
        `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
        [seeded.userId, seeded.orgId])
      expect(membership.rows[0]?.is_active).toBe(false)

      const event = await query<{ globally_clear: boolean }>(
        `SELECT globally_clear FROM directory_deprovision_events WHERE local_user_id = $1`,
        [seeded.userId])
      expect(event.rows).toHaveLength(1)
      expect(event.rows[0]?.globally_clear).toBe(false)
      const effects = await query<{ effect_type: string }>(
        `SELECT effect_type FROM directory_deprovision_effects WHERE local_user_id = $1`,
        [seeded.userId])
      expect(effects.rows.map((row) => row.effect_type)).toEqual(['membership_changed'])
    } finally {
      await holder.end()
      await writer.end()
    }
  })

  it('a newer event supersedes open effects AND bumps the generation (§5.4 — both legs, not one)', async () => {
    const seeded = await seed('supersede')

    // First deprovision: full mark_inactive → 3 effects at generation 1.
    const runCandidate = async (runId: string) => {
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
      await client.connect()
      try {
        await client.query('BEGIN')
        const result = await applyDirectoryDeprovisionCandidate(
          { query: (sql, params) => client.query(sql, params as unknown[]) },
          { ...applyInput(seeded, true), runId },
        )
        await client.query('COMMIT')
        return result
      } finally {
        await client.end()
      }
    }

    const first = await runCandidate(seeded.runId)
    expect(first.applied).toBe(true)
    const firstGeneration = first.accessGeneration

    // Rehire in the SAME org: reactivate user/account/membership/grant, new run.
    await query(`UPDATE users SET is_active = TRUE WHERE id = $1`, [seeded.userId])
    await query(`UPDATE user_orgs SET is_active = TRUE WHERE user_id = $1`, [seeded.userId])
    await query(`UPDATE user_external_auth_grants SET enabled = TRUE WHERE local_user_id = $1`, [seeded.userId])
    await query(`UPDATE directory_accounts SET is_active = FALSE WHERE id = $1::uuid`, [seeded.accountId])
    // `uq_directory_sync_runs_one_running_per_integration`: only one 'running' run per
    // integration, so the second run enters as a finished one (the event trigger checks the run
    // exists and matches the integration, not its status).
    const runB = await query<{ id: string }>(
      `INSERT INTO directory_sync_runs (integration_id, status, triggered_by)
       VALUES ($1::uuid, 'success', 'test') RETURNING id::text AS id`,
      [seeded.integrationId],
    )

    // Second deprovision for the same person.
    const second = await runCandidate(runB.rows[0].id)
    expect(second.applied).toBe(true)

    // Leg 1: the first event's rows are superseded — replaying their `before` would overwrite
    // the newer decision, so they must stop being restore targets.
    const firstEvent = await query<{ status: string }>(
      `SELECT status FROM directory_deprovision_events WHERE id = $1::uuid`,
      [first.eventId])
    expect(firstEvent.rows[0]?.status).toBe('superseded')
    const firstEffects = await query<{ status: string }>(
      `SELECT DISTINCT status FROM directory_deprovision_effects WHERE event_id = $1::uuid`,
      [first.eventId])
    expect(firstEffects.rows.map((row) => row.status)).toEqual(['superseded'])

    // Leg 2: the generation moved strictly forward — equal generations would let a stale
    // restore pass the §5.4 eligibility check.
    expect(second.accessGeneration).toBeGreaterThan(firstGeneration)
    const userGeneration = await query<{ g: number }>(
      `SELECT access_generation::int AS g FROM users WHERE id = $1`, [seeded.userId])
    expect(userGeneration.rows[0]?.g).toBe(second.accessGeneration)
  })
})
